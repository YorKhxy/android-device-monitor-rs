// 准备 bundled scrcpy（T3.2）：把指定版本的 scrcpy 下载并平铺到 src-tauri/scrcpy/<os>/，
// 供 Tauri bundle.resources 打包 + 运行时 resource_dir 解析（见 adb/scrcpy.rs）。
//
// 幂等：目标 scrcpy(.exe) 已存在则跳过。路径动态推导，不硬编码盘符。
// 当前只覆盖 Windows（工程打包目标 nsis/win64）；其它平台占位提示，不阻塞。
//
// 用法：npm run prepare:scrcpy
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, rmSync, renameSync, readdirSync, createWriteStream } from 'node:fs';

const SCRCPY_VERSION = 'v3.3.3';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 平台目标目录名与下载产物（与 adb/scrcpy.rs 的 platform_target 对齐）。
const PLATFORM = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
const SCRCPY_EXE = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
const destDir = path.join(repoRoot, 'src-tauri', 'scrcpy', PLATFORM);
const destExe = path.join(destDir, SCRCPY_EXE);

// scrcpy 发行包自带一份 adb(+AdbWinApi 两个 dll)。本工具所有 scrcpy 调用都用 `ADB` 环境变量钉到
// platform-tools 的 adb（见 mirror::spawn_scrcpy / commands::apps::list_app_labels 等），故这份从不被用——
// 删掉省体积、并去掉重复的 AdbWinApi.dll（构建/热更撞 os error 32 锁的就是它，少一份少一处隐患）。
function stripScrcpyAdb(dir) {
  for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
    const p = path.join(dir, name);
    if (!existsSync(p)) continue;
    try {
      rmSync(p, { force: true });
      console.log(`[prepare-scrcpy] 删冗余（用 platform-tools 的 adb，不需自带）：${name}`);
    } catch (e) {
      // 多半是有残留 adb/scrcpy 进程占着；提示后跳过，下次重跑会再删。
      console.warn(`[prepare-scrcpy] 删除 ${name} 失败（可能被占用，先关掉相关进程再重跑）：${e.message}`);
    }
  }
}

if (process.platform !== 'win32') {
  console.log(`[prepare-scrcpy] 当前平台 ${process.platform} 暂未自动准备 scrcpy（工程打包目标为 Windows）。`);
  console.log(`[prepare-scrcpy] 如需本机调试，请手动把 scrcpy 平铺到 ${destDir}/`);
  process.exit(0);
}

if (existsSync(destExe)) {
  stripScrcpyAdb(destDir); // 重跑也清理已存在拷贝里那份冗余 adb
  console.log(`[prepare-scrcpy] 已就绪，跳过：${destExe}`);
  process.exit(0);
}

const assetName = `scrcpy-win64-${SCRCPY_VERSION}.zip`;
const downloadUrl = `https://github.com/Genymobile/scrcpy/releases/download/${SCRCPY_VERSION}/${assetName}`;
const tmpZip = path.join(os.tmpdir(), assetName);
// 解压临时目录放在目标同盘（repoRoot 内），避免 C:→G: 跨盘 rename 报 EXDEV。
const tmpExtract = path.join(repoRoot, 'src-tauri', `.scrcpy-extract-${process.pid}`);

// GitHub release 资源会 302 跳到 codeload，手动跟随重定向下载到文件。
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'adm-prepare-scrcpy' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('重定向次数过多'));
        return resolve(download(res.headers.location, dest, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载失败 HTTP ${res.statusCode}：${url}`));
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function main() {
  console.log(`[prepare-scrcpy] 下载 ${assetName} …`);
  await download(downloadUrl, tmpZip);

  console.log('[prepare-scrcpy] 解压 …');
  rmSync(tmpExtract, { recursive: true, force: true });
  const unzip = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${tmpZip}" -DestinationPath "${tmpExtract}" -Force`],
    { stdio: 'inherit' },
  );
  if (unzip.status !== 0) throw new Error('Expand-Archive 解压失败');

  // 解压后通常多套一层 scrcpy-win64-vX.Y.Z/；定位真正含 scrcpy.exe 的目录。
  let inner = tmpExtract;
  if (!existsSync(path.join(inner, SCRCPY_EXE))) {
    const sub = readdirSync(inner, { withFileTypes: true }).find((d) => d.isDirectory());
    if (sub) inner = path.join(inner, sub.name);
  }
  if (!existsSync(path.join(inner, SCRCPY_EXE))) {
    throw new Error(`解压产物未找到 ${SCRCPY_EXE}`);
  }

  // 平铺到目标目录：先清空再整体搬入（含 scrcpy-server 与 dll）。
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(path.dirname(destDir), { recursive: true });
  renameSync(inner, destDir);
  stripScrcpyAdb(destDir); // 删掉 scrcpy 自带的冗余 adb + AdbWinApi dll

  rmSync(tmpZip, { force: true });
  rmSync(tmpExtract, { recursive: true, force: true });
  console.log(`[prepare-scrcpy] 完成：${destExe}`);
}

main().catch((err) => {
  rmSync(tmpZip, { force: true });
  rmSync(tmpExtract, { recursive: true, force: true });
  console.error('[prepare-scrcpy] 失败:', err.message);
  process.exit(1);
});
