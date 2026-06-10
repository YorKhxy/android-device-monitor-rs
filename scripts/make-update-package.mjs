// 热更打包脚本（T6.3，对应原 make-update-package.bat + gen-release-notes.js）：
// 把 `tauri build` 产出的 Tauri updater 制品整理成服务端可分发的 latest.json + 安装包。
//
// 前置：先 `npm run tauri build`（带 TAURI_SIGNING_PRIVATE_KEY + _PASSWORD 环境变量，createUpdaterArtifacts=true），
//       在 src-tauri/target/release/bundle/nsis/ 生成 `*-setup.exe` 与同名 `.exe.sig` 签名
//       （Tauri v2 NSIS updater 直接下载并运行 setup.exe，签名即 setup.exe.sig）。
//
// 产出：release-updates/ 下
//   - latest.json（Tauri updater 清单：version / notes / pub_date / platforms.windows-x86_64.{signature,url}）
//   - <安装包>-setup.exe（拷贝过来供下载）
//
// 用法：node scripts/make-update-package.mjs [--notes="本次更新说明"] [--base=http://内网IP:8788/updates]
//   - 版本号读自 src-tauri/tauri.conf.json
//   - notes 优先 --notes，其次仓库根 RELEASE_NOTES.md 首段，最后回退「版本 x.y.z 更新」
//   - url 基址默认 env UPDATE_BASE_URL 或 http://127.0.0.1:8788/updates（部署时替换为内网地址）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NSIS_DIR = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const OUT_DIR = path.join(ROOT, 'release-updates');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function readVersion() {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  if (!conf.version) fail('tauri.conf.json 缺 version 字段');
  return conf.version;
}

function readNotes(version) {
  const fromArg = arg('notes');
  if (fromArg) return fromArg;
  const notesFile = path.join(ROOT, 'RELEASE_NOTES.md');
  if (fs.existsSync(notesFile)) {
    // 取首个非空段落作为本次说明。
    const text = fs.readFileSync(notesFile, 'utf8').trim();
    const firstBlock = text.split(/\n\s*\n/)[0]?.trim();
    if (firstBlock) return firstBlock;
  }
  return `版本 ${version} 更新`;
}

// 在 nsis 目录里找 updater 制品：*-setup.exe 及其 .exe.sig。
function findArtifacts() {
  if (!fs.existsSync(NSIS_DIR)) {
    fail(`未找到打包产物目录：${NSIS_DIR}\n请先运行 npm run tauri build（带签名环境变量）`);
  }
  const files = fs.readdirSync(NSIS_DIR);
  const pkg = files.find((f) => f.endsWith('-setup.exe'));
  if (!pkg) fail(`${NSIS_DIR} 下未找到 *-setup.exe`);
  const sig = `${pkg}.sig`;
  if (!files.includes(sig)) fail(`未找到签名文件 ${sig}（确认构建带 TAURI_SIGNING_PRIVATE_KEY 与 _PASSWORD）`);
  return { pkg, sig };
}

function main() {
  const version = readVersion();
  const notes = readNotes(version);
  const base = (arg('base') || process.env.UPDATE_BASE_URL || 'http://127.0.0.1:8788/updates').replace(/\/+$/, '');
  const { pkg, sig } = findArtifacts();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 拷安装包到分发目录。
  fs.copyFileSync(path.join(NSIS_DIR, pkg), path.join(OUT_DIR, pkg));
  const signature = fs.readFileSync(path.join(NSIS_DIR, sig), 'utf8').trim();

  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature,
        url: `${base}/${encodeURIComponent(pkg)}`,
      },
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'latest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('✅ 热更包已生成：');
  console.log(`   版本：${version}`);
  console.log(`   说明：${notes.split('\n')[0]}`);
  console.log(`   清单：${path.join(OUT_DIR, 'latest.json')}`);
  console.log(`   安装包：${path.join(OUT_DIR, pkg)}`);
  console.log(`   下载基址：${base}（部署时改为内网地址）`);
}

main();
