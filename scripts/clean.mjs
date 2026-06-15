// 工程瘦身脚本：清理可再生的构建缓存与旧发布产物，腾出磁盘。
//
// 默认（不带参数）：cargo clean —— 清掉 src-tauri/target（debug+release 构建缓存，常占十几~几十 GB）。
//   代价：下次 tauri dev / build 会全量重编一次（之后恢复增量）。
//
// 可选开关：
//   --releases       额外清理旧发布产物：
//                      · update-releases/   仅保留 latest/ 与最新 N 个版本目录（热更服务器只用 latest）
//                      · src/release/       仅保留最新 N 个绿色包目录
//   --keep=N         上面「保留最新 N 个」的 N，默认 3
//   --dry            预演：只打印将删除什么、能省多少，不真正删除
//
// 用法：
//   node scripts/clean.mjs                 # 只 cargo clean
//   node scripts/clean.mjs --releases      # cargo clean + 清旧发布产物（保留最新 3 个）
//   node scripts/clean.mjs --releases --keep=5 --dry   # 预演，保留最新 5 个
//
// 安全边界：只碰 target / update-releases / src/release；绝不动 node_modules、platform-tools、
// scrcpy、src 源码、.git，以及 update-releases/latest 与 .last-release-commit 标记。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const DO_RELEASES = argv.includes('--releases');
const KEEP = (() => {
  const a = argv.find((x) => x.startsWith('--keep='));
  const n = a ? parseInt(a.split('=')[1], 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// 递归算目录大小（字节）。不存在返回 0。
function dirSize(p) {
  if (!fs.existsSync(p)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    try {
      if (e.isDirectory()) total += dirSize(fp);
      else total += fs.statSync(fp).size;
    } catch {
      /* 文件可能在遍历中消失，忽略 */
    }
  }
  return total;
}

// cargo bin 注入 PATH（与 tauri.mjs / build-portable.mjs 同款，换机器/换用户均成立）。
function envWithCargo() {
  const cargoBin = process.env.CARGO_HOME
    ? path.join(process.env.CARGO_HOME, 'bin')
    : path.join(os.homedir(), '.cargo', 'bin');
  const env = { ...process.env };
  if (fs.existsSync(cargoBin)) {
    // Windows 环境变量名是 'Path'：必须找现有键改原值，否则大写 PATH 取 undefined 会覆盖丢 node。
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    if (!(env[key] || '').toLowerCase().includes(cargoBin.toLowerCase())) {
      env[key] = cargoBin + path.delimiter + (env[key] || '');
    }
  }
  return env;
}

// 清 src-tauri/target：优先 cargo clean（规范、会打印回收量）；cargo 不可用则回退手删整个 target。
function cleanTarget() {
  const target = path.join(SRC_TAURI, 'target');
  const before = dirSize(target);
  if (before === 0) {
    console.log('• target：已是空的，跳过。');
    return 0;
  }
  console.log(`• target：当前 ${mb(before)} MB`);
  if (DRY) {
    console.log(`  [dry] 将执行 cargo clean，预计回收 ~${mb(before)} MB`);
    return before;
  }
  const r = spawnSync('cargo', ['clean'], { cwd: SRC_TAURI, stdio: 'inherit', shell: true, env: envWithCargo() });
  if (r.status === 0) {
    console.log(`  ✓ cargo clean 完成，回收 ~${mb(before)} MB`);
    return before;
  }
  // 回退：cargo 缺失或失败 → 直接删目录（target 可能被运行中的 tauri dev 占用，此时会报错，提示用户先停）。
  console.warn('  ⚠️ cargo clean 失败，回退为直接删除 target/…');
  try {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`  ✓ 已删除 target/，回收 ~${mb(before)} MB`);
    return before;
  } catch (e) {
    console.error(`  ❌ 删除 target 失败（可能有 tauri dev / 编译进程占用，请先停掉再重试）：${e.message}`);
    return 0;
  }
}

// 按 mtime 倒序留最新 keep 个，其余删除；返回回收字节。protect 里的名字永不删。
function pruneDirs(parent, keep, protect = []) {
  if (!fs.existsSync(parent)) return 0;
  const entries = fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !protect.includes(e.name))
    .map((e) => {
      const fp = path.join(parent, e.name);
      return { name: e.name, fp, mtime: fs.statSync(fp).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // 新 → 旧

  const toDelete = entries.slice(keep);
  let freed = 0;
  for (const d of toDelete) {
    const sz = dirSize(d.fp);
    freed += sz;
    if (DRY) {
      console.log(`  [dry] 将删除 ${path.relative(ROOT, d.fp)}  (${mb(sz)} MB)`);
    } else {
      try {
        fs.rmSync(d.fp, { recursive: true, force: true });
        console.log(`  ✓ 删除 ${path.relative(ROOT, d.fp)}  (${mb(sz)} MB)`);
      } catch (e) {
        freed -= sz;
        console.error(`  ❌ 删除失败 ${d.name}：${e.message}`);
      }
    }
  }
  if (entries.length <= keep) console.log(`  （共 ${entries.length} 个，≤保留数 ${keep}，无需删除）`);
  return freed;
}

function main() {
  console.log(`=== 工程瘦身${DRY ? '（预演 dry-run，不删）' : ''} ===\n`);
  let freed = 0;

  freed += cleanTarget();

  if (DO_RELEASES) {
    console.log(`\n• update-releases：保留 latest + 最新 ${KEEP} 个版本目录`);
    // 保护 latest 目录与发版标记文件；标记文件不是目录，pruneDirs 只看目录，天然不动它。
    freed += pruneDirs(path.join(ROOT, 'update-releases'), KEEP, ['latest']);

    console.log(`\n• src/release：每个月份目录下保留最新 ${KEEP} 个绿色包`);
    const releaseRoot = path.join(ROOT, 'src', 'release');
    if (fs.existsSync(releaseRoot)) {
      for (const month of fs.readdirSync(releaseRoot, { withFileTypes: true })) {
        if (!month.isDirectory()) continue;
        const monthDir = path.join(releaseRoot, month.name);
        console.log(`  [${month.name}]`);
        freed += pruneDirs(monthDir, KEEP);
        // 月份目录若被清空则一并移除（dry 模式不动）。
        if (!DRY && fs.existsSync(monthDir) && fs.readdirSync(monthDir).length === 0) {
          fs.rmSync(monthDir, { recursive: true, force: true });
          console.log(`  ✓ 移除空月份目录 ${month.name}`);
        }
      }
    } else {
      console.log('  （无 src/release，跳过）');
    }
  } else {
    console.log('\n（未带 --releases，旧发布产物未清；需要时加 --releases）');
  }

  console.log(`\n=== ${DRY ? '预计可' : '本次共'}回收 ~${mb(freed)} MB (${(freed / 1024 / 1024 / 1024).toFixed(2)} GB) ===`);
  if (!DRY && freed > 0) console.log('提醒：target 清空后，下次 tauri dev / build 会全量重编一次，正常。');
}

main();
