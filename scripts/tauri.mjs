// Tauri CLI 包装器：运行 tauri 前自动把 Rust 工具链(cargo) 目录注入本进程 PATH，
// 让 `npm run tauri ...` 在任何终端都能直接用，无需先手动改 PATH 或重开终端。
//
// 路径动态推导（不硬编码盘符/盘位，换机器/换用户均成立）：
//   - 优先 CARGO_HOME（用户自定义 Rust 安装位置）
//   - 否则默认 ~/.cargo/bin（rustup 默认）
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
