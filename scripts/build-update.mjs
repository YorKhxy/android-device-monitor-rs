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
import { spawnSync } from 'node:child_process';
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
  if (fs.existsSync(cargoBin) && !(env.PATH || '').toLowerCase().includes(cargoBin.toLowerCase())) {
    env.PATH = cargoBin + path.delimiter + (env.PATH || '');
  }
  return env;
}

function run(cmd, args, env) {
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT, env });
  if (r.status !== 0) fail(`命令失败（exit ${r.status}）：${cmd} ${args.join(' ')}`);
}

function main() {
  const current = JSON.parse(fs.readFileSync(path.join(SRC_TAURI, 'tauri.conf.json'), 'utf8')).version;
  const version = nextVersion(current);
  console.log(`=== 打热更包：${current} → ${version} ===`);

  const { key, password } = readSigning();
  if (!password) {
    console.warn('⚠️ 未取到签名密码（password.txt / ADM_SIGN_PASSWORD 均空）——若密钥有密码会卡在解密提示。');
  }

  writeVersion(version);
  console.log(`✓ 版本已写入 tauri.conf.json / package.json / Cargo.toml`);

  const buildEnv = envWithCargo({
    TAURI_SIGNING_PRIVATE_KEY: key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  });
  run('npm', ['run', 'tauri', 'build'], buildEnv);

  // 生成 latest.json + 拷包（透传 --notes / --base）。
  const passThrough = process.argv.filter((a) => a.startsWith('--notes=') || a.startsWith('--base='));
  run('node', ['scripts/make-update-package.mjs', ...passThrough], process.env);

  console.log(`\n✅ 热更包 v${version} 完成。起服务：npm run serve:updates（或「启动热更服务器.bat」）`);
  console.log('   记得把版本号变更提交到 git。');
}

main();
