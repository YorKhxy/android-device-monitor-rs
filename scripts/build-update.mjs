// 打热更包：版本自增 → 签名打包 → 生成 latest.json（对应原 make-update-package.bat + gen-release-notes.js）。
//
// 步骤：① 抬版本（默认 patch 自增，或 --version=x.y.z 指定）写入 tauri.conf.json / package.json / Cargo.toml →
//       ② 注入签名私钥+密码环境变量后 npm run tauri build（出 setup.exe + .sig）→
//       ③ node make-update-package.mjs 生成 release-updates/latest.json + 拷包。
//
// 签名机密：私钥读 src-tauri/.tauri-keys/adm-updater.key，密码读 src-tauri/.tauri-keys/password.txt
//   （整个 .tauri-keys/ 已 gitignore；也可用环境变量 ADM_SIGN_PASSWORD 覆盖密码）。
//   ⚠️ 私钥+密码丢了就再也签不了更新包，务必单独备份。
//
// 用法：node scripts/build-update.mjs [--bump=patch|minor|major] [--version=x.y.z] [--notes="本次说明"] [--base=URL]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');
const KEYS_DIR = path.join(SRC_TAURI, '.tauri-keys');

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

// 计算新版本：--version 优先，否则按 --bump（默认 patch）自增当前版本。
function nextVersion(current) {
  const explicit = arg('version');
  if (explicit) {
    if (!/^\d+\.\d+\.\d+$/.test(explicit)) fail(`--version 需形如 x.y.z，收到：${explicit}`);
    return explicit;
  }
  const bump = arg('bump') || 'patch';
  const [maj, min, pat] = current.split('.').map((n) => parseInt(n, 10));
  if ([maj, min, pat].some(Number.isNaN)) fail(`当前版本非法：${current}`);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  fail(`--bump 取值 patch|minor|major，收到：${bump}`);
}

// 本机非内部 IPv4（局域网地址）——客户端更新源要指到这里，127.0.0.1 在别的机器指向它自己。
function lanIPv4s() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

// 写 src-tauri/update-config.json（随包打进 resource，客户端首次安装/热更后自动落地，无需手动配）。
// 地址优先用 --feed-url=，否则取本机局域网 IP + 默认端口 8384。返回写入的 base url。
function writeUpdateConfig() {
  const explicit = arg('feed-url');
  let base;
  if (explicit) {
    base = explicit.trim().replace(/\/+$/, '');
  } else {
    const ips = lanIPv4s();
    if (!ips.length) {
      console.warn('   ⚠️ 未探测到局域网 IP，update-config.json 沿用现有内容（别的机器可能仍找不到服务器）。');
      return null;
    }
    base = `http://${ips[0]}:8384`;
  }
  const p = path.join(SRC_TAURI, 'update-config.json');
  fs.writeFileSync(p, JSON.stringify({ url: base }, null, 2) + '\n', 'utf8');
  console.log(`   更新源已写入 update-config.json：${base}（随包打进客户端）`);
  return base;
}

// 同步写三处版本号，保持一致。
function writeVersion(version) {
  const confPath = path.join(SRC_TAURI, 'tauri.conf.json');
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  conf.version = version;
  fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n', 'utf8');

  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  // Cargo.toml 仅改 [package] 段首个 version 行。
  const cargoPath = path.join(SRC_TAURI, 'Cargo.toml');
  let cargo = fs.readFileSync(cargoPath, 'utf8');
  cargo = cargo.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`);
  fs.writeFileSync(cargoPath, cargo, 'utf8');
}

function readSigning() {
  const keyPath = path.join(KEYS_DIR, 'adm-updater.key');
  if (!fs.existsSync(keyPath)) {
    fail(`未找到签名私钥：${keyPath}\n（用 npx @tauri-apps/cli signer generate 生成，私钥放此处）`);
  }
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  const pwdPath = path.join(KEYS_DIR, 'password.txt');
  const password =
    process.env.ADM_SIGN_PASSWORD ?? (fs.existsSync(pwdPath) ? fs.readFileSync(pwdPath, 'utf8').trim() : '');
  return { key, password };
}

function envWithCargo(extra) {
  const cargoBin = process.env.CARGO_HOME
    ? path.join(process.env.CARGO_HOME, 'bin')
    : path.join(os.homedir(), '.cargo', 'bin');
  const env = { ...process.env, ...extra };
  if (fs.existsSync(cargoBin)) {
    // Windows 环境变量名是 'Path'：找现有 path 键改其原值，避免 env.PATH(大写) 覆盖整条 PATH 丢了 node/npm。
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    const cur = env[pathKey] || '';
    if (!cur.toLowerCase().includes(cargoBin.toLowerCase())) {
      env[pathKey] = cargoBin + path.delimiter + cur;
    }
  }
  return env;
}

// 跑 shell 命令（单字符串，无 args 数组——避免 DEP0190；npm/cmd 解析需 shell）。仅用于无动态参数的固定命令。
function sh(commandString, env) {
  console.log(`\n▶ ${commandString}`);
  const r = spawnSync(commandString, { stdio: 'inherit', shell: true, cwd: ROOT, env });
  if (r.status !== 0) fail(`命令失败（exit ${r.status}）：${commandString}`);
}

// 跑本仓库的 node 脚本：用当前 node 绝对路径 + shell:false + 数组参数（不依赖 npm/PATH，正确处理含空格的 --notes）。
function runNode(args, env) {
  console.log(`\n▶ node ${args.join(' ')}`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', shell: false, cwd: ROOT, env });
  if (r.status !== 0) fail(`命令失败（exit ${r.status}）：node ${args.join(' ')}`);
}

// —— 步骤进度 ——
// 整体进度 = 已完成步数/总步数，体现在每步开始的「[n/N] ▶ 步骤名」与结束的「[n/N] ███░░ pct% ✓ 步骤名 · 耗时」。
// 长任务（编译打包）用 runLive 显示「原地刷新的单行实时状态」（spinner + 已用时 + 当前动作），避免上千行编译
// 输出把进度条冲烂；其余快步骤直接一行起一行收。这样既不刷屏乱，长步骤也有持续反馈，不再「卡着到完成才 0→100」。
const PROGRESS = { total: 0, no: 0, label: '', stepStart: 0, t0: Date.now() };

function setTotalSteps(n) { PROGRESS.total = n; }

function bar(frac, width = 20) {
  const fill = Math.max(0, Math.min(width, Math.round(frac * width)));
  return '█'.repeat(fill) + '░'.repeat(width - fill);
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// 收尾上一步：打满到「本步完成」的整体进度 + 耗时。首步之前 no=0，无操作。
function endStep() {
  if (PROGRESS.no === 0) return;
  const frac = PROGRESS.no / PROGRESS.total;
  const pct = String(Math.round(frac * 100)).padStart(3);
  console.log(`[${PROGRESS.no}/${PROGRESS.total}] ${bar(frac)} ${pct}%  ✓ ${PROGRESS.label} · ${fmtDur(Date.now() - PROGRESS.stepStart)}`);
}

// 开新一步：先收尾上一步，再打印本步起始行（不带 bar，避免与上一行同 % 重复看着乱）。
function beginStep(label) {
  endStep();
  PROGRESS.no += 1;
  PROGRESS.label = label;
  PROGRESS.stepStart = Date.now();
  console.log(`\n[${PROGRESS.no}/${PROGRESS.total}] ▶ ${label}`);
}

// 全部完成：收尾最后一步 + 总耗时。
function finishSteps() {
  endStep();
  console.log(`\n✅ 全部完成 · 总耗时 ${fmtDur(Date.now() - PROGRESS.t0)}`);
}

// 跑长命令并显示实时进度。终端（cmd）里 \r 原地刷新不可靠，故不用 spinner 逐帧刷——改为
// 「仅当动作变化（换了正在编译的 crate / 构建阶段）时才打一行」+ 每 8s 一次心跳（防长链接阶段看着卡死），
// 并节流避免一堆小 crate 瞬间刷屏。详细输出默认隐藏，失败时吐尾部若干行定位。仅用于编译打包这类长任务。
function runLive(commandString, env, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let action = '启动中…';
    let lastPrinted = '';
    let lastPrintAt = 0;
    const tail = [];
    const child = spawn(commandString, { shell: true, cwd: ROOT, env });

    const printLine = () => {
      const now = Date.now();
      const changed = action !== lastPrinted;
      // 动作没变 → 仅到 8s 心跳才打；动作变了 → 至少隔 800ms 才打（小 crate 秒过时合并，不刷屏）。
      if (!changed && now - lastPrintAt < 8000) return;
      if (changed && now - lastPrintAt < 800) return;
      console.log(`   ${label} · ${fmtDur(now - t0)} · ${action}`);
      lastPrinted = action;
      lastPrintAt = now;
    };

    const onData = (buf) => {
      for (const ln of buf.toString().split(/\r?\n/)) {
        const s = ln.trim();
        if (!s) continue;
        tail.push(s);
        if (tail.length > 60) tail.shift();
        const c = s.match(/Compiling\s+(\S+)/);
        if (c) action = `编译 ${c[1]}`;
        else if (/transforming|building for production|vite v/i.test(s)) action = '前端构建（vite）…';
        else if (/Bundling|NSIS|Built application|Running bundling/i.test(s)) action = '打包安装器（NSIS）…';
        else if (/Finished\s+`?release/i.test(s)) action = 'Rust 编译完成，收尾中…';
      }
      printLine();
    };
    // 心跳：即使没有新输出（如长时间 LTO 链接），每 8s 也报一次「还在干 + 已用时」。
    const hb = setInterval(printLine, 8000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData); // cargo 进度多打到 stderr

    child.on('error', (e) => { clearInterval(hb); reject(e); });
    child.on('close', (code) => {
      clearInterval(hb);
      if (code !== 0) {
        console.error(`\n—— 失败输出（尾部 ${tail.length} 行）——`);
        console.error(tail.join('\n'));
        reject(new Error(`命令失败（exit ${code}）：${commandString}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const current = JSON.parse(fs.readFileSync(path.join(SRC_TAURI, 'tauri.conf.json'), 'utf8')).version;
  const version = nextVersion(current);
  console.log(`=== 打热更包：${current} → ${version} ===`);

  // 自动生成更新说明这一步是否执行 → 决定总步数，进度百分比才准确。
  const autoNotes =
    !process.argv.includes('--no-auto-notes') && !process.argv.some((a) => a.startsWith('--notes='));
  // 固定步骤：读密钥 → 写版本 → 写更新源配置 → [生成说明] → 编译打包 → 整理产物 → 提交打 tag。
  setTotalSteps(autoNotes ? 7 : 6);

  beginStep('读取签名私钥');
  const { key, password } = readSigning();
  if (!password) {
    console.warn('⚠️ 未取到签名密码（password.txt / ADM_SIGN_PASSWORD 均空）——若密钥有密码会卡在解密提示。');
  }

  beginStep('写入版本号 → tauri.conf.json / package.json / Cargo.toml');
  writeVersion(version);

  // 写更新源配置（随包打进客户端，首次安装/热更后自动落地）——必须在 build 之前，才能被打进 resource。
  beginStep('写入更新源配置 update-config.json（随包打进客户端）');
  writeUpdateConfig();

  // 自动从 git 提交生成本次更新说明 → release-notes.md（make-update-package 会读它写进 latest.json）。
  // 指定 --notes 或 --no-auto-notes 时跳过；--notes 在 make-update-package 里优先级更高。
  if (autoNotes) {
    beginStep('生成更新说明（汇总 git 提交）');
    runNode(['scripts/gen-release-notes.mjs'], process.env);
  }

  beginStep('编译打包（npm run tauri build，最耗时）');
  const buildEnv = envWithCargo({
    TAURI_SIGNING_PRIVATE_KEY: key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  });
  await runLive('npm run tauri build', buildEnv, '编译打包');

  // 整理产物到 update-releases/（透传 --notes / --base）。
  beginStep('整理热更产物 + 生成 latest.json');
  const passThrough = process.argv.filter((a) => a.startsWith('--notes=') || a.startsWith('--base='));
  runNode(['scripts/make-update-package.mjs', ...passThrough], process.env);

  // 发版锚点（对齐老工具）：提交版本号变更并打 tag v<版本>，作为下次自动 release notes 的起点。
  // 仅在确有版本号变更时提交；打包已成功，打 tag 出岔子不致命，吞掉即可。
  beginStep('Git 提交版本号变更 + 打 tag');
  tagRelease(version);

  finishSteps();
  console.log(`\n✅ 热更包 v${version} 完成。起服务：「启动热更服务器.bat」（npm run serve:updates）`);
}

// git 提交版本号文件 + 打 tag（非致命，失败仅提示）。
function tagRelease(version) {
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  try {
    if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) {
      console.log('（非 git 仓库，跳过打 tag）');
      return;
    }
    git(['add', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']);
    if (git(['diff', '--cached', '--quiet']).status !== 0) {
      git(['commit', '-m', `chore: 发布 v${version}`]);
    }
    if (!git(['tag', '--list', `v${version}`]).stdout.trim()) {
      git(['tag', '-a', `v${version}`, '-m', `release v${version}`]);
      console.log(`✓ 已打 tag v${version}（推送共享：git push origin v${version}）`);
    } else {
      console.log(`（tag v${version} 已存在，跳过）`);
    }
  } catch (e) {
    console.log(`（打 tag 跳过，非致命）：${e.message}`);
  }
}

main().catch((e) => fail(e.message));
