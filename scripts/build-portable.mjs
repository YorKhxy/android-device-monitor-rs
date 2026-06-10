// 打绿色包（免安装便携版）：组装「exe + platform-tools + scrcpy 同目录平铺」的可直接运行文件夹。
//
// 运行时定位（adb/binary.rs、scrcpy.rs）按 resource_dir()=exe 同目录找 platform-tools/scrcpy，
// 与 NSIS 安装布局一致——便携版同样平铺即可跑。前端 dist 在编译期已嵌入 exe。
//
// 步骤：① npm run build 出前端 dist → ② cargo build --release 出 exe（嵌入 dist）→
//       ③ 组装 release-portable/安卓设备监控/（exe + platform-tools + scrcpy + 使用说明）→ ④ 压成 zip。
//
// 前置：scrcpy/platform-tools 已由 prepare 脚本就位（src-tauri/ 下）。
// 注意：便携版依赖系统已装 WebView2（Win10/11 一般自带）；缺失则装一次 NSIS 包或微软 WebView2 运行时。
//
// 用法：node scripts/build-portable.mjs [--skip-build]（已构建过 exe 时跳过编译，仅重新组装）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');
const EXE = path.join(SRC_TAURI, 'target', 'release', 'android-device-monitor.exe');
const PORTABLE_ROOT = path.join(ROOT, 'release-portable');

const skipBuild = process.argv.includes('--skip-build');

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(SRC_TAURI, 'tauri.conf.json'), 'utf8')).version;
}

// 把 cargo bin 注入 PATH（双击 .bat 时终端可能没有），动态推导不硬编码盘符。
function envWithCargo() {
  const cargoBin = process.env.CARGO_HOME
    ? path.join(process.env.CARGO_HOME, 'bin')
    : path.join(os.homedir(), '.cargo', 'bin');
  const env = { ...process.env };
  if (fs.existsSync(cargoBin) && !(env.PATH || '').toLowerCase().includes(cargoBin.toLowerCase())) {
    env.PATH = cargoBin + path.delimiter + (env.PATH || '');
  }
  return env;
}

function run(cmd, args, opts = {}) {
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT, ...opts });
  if (r.status !== 0) fail(`命令失败（exit ${r.status}）：${cmd} ${args.join(' ')}`);
}

// 手写递归复制：基于 copyFileSync/mkdirSync（对中文路径正常）。
// 注：fs.cpSync 在部分 Node/Windows 下对非 ASCII 目标路径会静默失败、不报错也不复制，故不用它。
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  const version = readVersion();
  console.log(`=== 打绿色包 v${version} ===`);

  if (!skipBuild) {
    run('npm', ['run', 'build']); // 前端 → dist/
    run('cargo', ['build', '--release'], { cwd: SRC_TAURI, env: envWithCargo() }); // exe 嵌入 dist
  }
  if (!fs.existsSync(EXE)) {
    fail(`未找到 release exe：${EXE}\n请去掉 --skip-build 重新构建。`);
  }
  for (const d of ['platform-tools', 'scrcpy']) {
    if (!fs.existsSync(path.join(SRC_TAURI, d))) {
      fail(`缺少资源 src-tauri/${d}/，先运行 npm run prepare:scrcpy。`);
    }
  }

  // 组装便携目录（先清旧）。
  const appDir = path.join(PORTABLE_ROOT, '安卓设备监控');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });

  fs.copyFileSync(EXE, path.join(appDir, '安卓设备监控.exe'));
  copyDir(path.join(SRC_TAURI, 'platform-tools'), path.join(appDir, 'platform-tools'));
  copyDir(path.join(SRC_TAURI, 'scrcpy'), path.join(appDir, 'scrcpy'));
  fs.writeFileSync(
    path.join(appDir, '使用说明.txt'),
    [
      `安卓设备监控 v${version}（绿色便携版）`,
      '',
      '· 双击「安卓设备监控.exe」直接运行，免安装。',
      '· 整个文件夹一起复制/移动，勿单独拷 exe（需同目录的 platform-tools / scrcpy）。',
      '· 依赖系统 WebView2 运行时（Win10/11 一般自带）；若启动报缺 WebView2，',
      '  装一次 NSIS 安装包或从微软官网装「Evergreen WebView2 Runtime」即可。',
      '· 数据（采集/录制/日志/传输记录）默认落在 exe 同目录，不进 C 盘 userData。',
    ].join('\r\n'),
    'utf8',
  );

  console.log(`\n✅ 绿色包目录已生成：${appDir}`);

  // 压 zip（Windows 用 Compress-Archive；失败仅提示，不阻断）。
  const zip = path.join(PORTABLE_ROOT, `安卓设备监控-便携版-v${version}.zip`);
  fs.rmSync(zip, { force: true });
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path "${appDir}" -DestinationPath "${zip}" -Force`],
    { stdio: 'inherit', shell: false },
  );
  if (r.status === 0 && fs.existsSync(zip)) {
    const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
    console.log(`✅ 绿色包已压缩：${zip}（${mb} MB）`);
  } else {
    console.log('（zip 压缩跳过，可直接分发上面的文件夹）');
  }
}

main();
