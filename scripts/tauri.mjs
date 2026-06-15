// Tauri CLI 包装器：运行 tauri 前自动把 Rust 工具链(cargo) 目录注入本进程 PATH，
// 让 `npm run tauri ...` 在任何终端都能直接用，无需先手动改 PATH 或重开终端。
//
// 路径动态推导（不硬编码盘符/盘位，换机器/换用户均成立）：
//   - 优先 CARGO_HOME（用户自定义 Rust 安装位置）
//   - 否则默认 ~/.cargo/bin（rustup 默认）
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// release-notes.md 是 tauri.conf 的必需 resource（缺则构建直接失败）。打热更包(build-update)会先跑
// gen-release-notes 写真实内容；而 dev / 绿色包 / 裸 build 不生成它，故此处兜底确保文件存在：
// 缺失就按当前版本号写个最小占位，绝不让构建因缺资源而失败。
const notesFile = path.join(repoRoot, 'src-tauri', 'release-notes.md');
if (!existsSync(notesFile)) {
  let version = '';
  try {
    version = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version || '';
  } catch {
    /* 读不到版本就留空 */
  }
  writeFileSync(notesFile, `v${version}\n\n- 维护性更新\n`, 'utf8');
}

const cargoBin = process.env.CARGO_HOME
  ? path.join(process.env.CARGO_HOME, 'bin')
  : path.join(os.homedir(), '.cargo', 'bin');

const sep = path.delimiter;
const current = process.env.PATH || '';
const already = current
  .split(sep)
  .some((p) => p && p.toLowerCase() === cargoBin.toLowerCase());
if (!already && existsSync(cargoBin)) {
  process.env.PATH = cargoBin + sep + current;
}

// 直接用当前 node 运行本地 @tauri-apps/cli 的入口，规避 Windows 上 .cmd/shell 的执行限制
const cliBin = path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const child = spawn(process.execPath, [cliBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[tauri wrapper] 启动失败:', err);
  process.exit(1);
});
