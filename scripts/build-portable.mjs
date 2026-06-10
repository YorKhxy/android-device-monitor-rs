// 打绿色包（免安装便携版）——产物规则对齐老工具 build-and-package.ps1：
//   输出目录：src/release/<yyyy-MM>/AndroidDeviceMonitor_<MMdd>_<HHmmss>/
//   主程序名：AndroidDeviceMonitor_<MMdd>_<HHmmss>.exe（与文件夹同名）
//   只产出文件夹（不压 zip），整个文件夹即可拷走运行。
//
// 与老工具的差异：老 Electron 把资源放 resources/ 子目录；本 Tauri 版运行时按 exe 同目录解析
//   platform-tools/scrcpy（adb/binary.rs、scrcpy.rs 用 resource_dir()=exe 同目录），故资源平铺在 exe 同级。
//   前端 dist 编译期已嵌入 exe。
//
// 步骤：① npm run build 出前端 → ② cargo build --release 出 exe → ③ 组装到 src/release/<yyyy-MM>/<带时间戳名>/
// 用法：node scripts/build-portable.mjs [--skip-build]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');
const EXE = path.join(SRC_TAURI, 'target', 'release', 'android-device-monitor.exe');
const RELEASE_DIR = path.join(ROOT, 'src', 'release');

const skipBuild = process.argv.includes('--skip-build');

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

// 老工具同款时间戳：日期文件夹 yyyy-MM、名字段 MMdd / HHmmss。
function stamps() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    monthFolder: `${d.getFullYear()}-${p(d.getMonth() + 1)}`,
    mmdd: `${p(d.getMonth() + 1)}${p(d.getDate())}`,
    hhmmss: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  };
}

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

// 手写递归复制（fs.cpSync 在部分 Node/Windows 下对中文目标路径会静默失败）。
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
  const version = JSON.parse(fs.readFileSync(path.join(SRC_TAURI, 'tauri.conf.json'), 'utf8')).version;
  const { monthFolder, mmdd, hhmmss } = stamps();
  const appName = `AndroidDeviceMonitor_${mmdd}_${hhmmss}`;
  console.log(`=== 打绿色包 v${version} → ${appName} ===`);

  if (!skipBuild) {
    run('npm', ['run', 'build']); // 前端 → dist/
    run('cargo', ['build', '--release'], { cwd: SRC_TAURI, env: envWithCargo() }); // exe 嵌入 dist
  }
  if (!fs.existsSync(EXE)) fail(`未找到 release exe：${EXE}\n请去掉 --skip-build 重新构建。`);
  for (const d of ['platform-tools', 'scrcpy']) {
    if (!fs.existsSync(path.join(SRC_TAURI, d))) fail(`缺少资源 src-tauri/${d}/，先运行 npm run prepare:scrcpy。`);
  }

  // 输出目录：src/release/<yyyy-MM>/AndroidDeviceMonitor_<MMdd>_<HHmmss>/
  const outDir = path.join(RELEASE_DIR, monthFolder);
  fs.mkdirSync(outDir, { recursive: true });
  const appDir = path.join(outDir, appName);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });

  // 主程序与文件夹同名；资源平铺到 exe 同目录（Tauri 运行时解析口径）。
  fs.copyFileSync(EXE, path.join(appDir, `${appName}.exe`));
  copyDir(path.join(SRC_TAURI, 'platform-tools'), path.join(appDir, 'platform-tools'));
  copyDir(path.join(SRC_TAURI, 'scrcpy'), path.join(appDir, 'scrcpy'));
  fs.writeFileSync(
    path.join(appDir, '使用说明.txt'),
    [
      `安卓设备监控 v${version}（绿色便携版）`,
      '',
      `· 双击「${appName}.exe」直接运行，免安装。`,
      '· 整个文件夹一起复制/移动，勿单独拷 exe（需同目录的 platform-tools / scrcpy）。',
      '· 依赖系统 WebView2 运行时（Win10/11 一般自带）；缺失则装一次 NSIS 包或微软 WebView2 运行时。',
      '· 数据（采集/录制/日志/传输记录）默认落在 exe 同目录，不进 C 盘。',
    ].join('\r\n'),
    'utf8',
  );

  const mb = (fs.readdirSync(appDir, { recursive: true }).reduce((s, f) => {
    const fp = path.join(appDir, f);
    return s + (fs.statSync(fp).isFile() ? fs.statSync(fp).size : 0);
  }, 0) / 1024 / 1024).toFixed(1);

  console.log(`\n✅ 绿色包已生成：${appDir}（${mb} MB）`);
  console.log(`   主程序：${appName}.exe`);
  console.log(`   分发：把整个「${appName}」文件夹拷给对方，双击 exe 即用。`);
}

main();
