// 整理热更产物（被 build-update.mjs 调用，也可单独跑）——目录规则对齐老工具 make-update-package.ps1：
//   存档：update-releases/v<版本>_<yyyy-MM-dd_HHmmss>/   （留存每次发版）
//   服务：update-releases/latest/                        （热更服务器只服务它，每次刷新）
//   两处均含：latest.json（Tauri updater 清单）+ <安装包>-setup.exe + <安装包>-setup.exe.sig
//
// 前置：先 tauri build（带 TAURI_SIGNING_PRIVATE_KEY + _PASSWORD，createUpdaterArtifacts=true），
//       在 src-tauri/target/release/bundle/nsis/ 生成 *-setup.exe 与 *-setup.exe.sig。
//
// 用法：node scripts/make-update-package.mjs [--notes="本次说明"] [--base=http://内网IP:8384]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本机非内部 IPv4（局域网地址）——latest.json 的下载 URL 要指到这里，127.0.0.1 在别的机器上指向它自己下不动。
function lanIPv4s() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_TAURI = path.join(ROOT, 'src-tauri');
const NSIS_DIR = path.join(SRC_TAURI, 'target', 'release', 'bundle', 'nsis');
const REL_ROOT = path.join(ROOT, 'update-releases');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function readVersion() {
  const v = JSON.parse(fs.readFileSync(path.join(SRC_TAURI, 'tauri.conf.json'), 'utf8')).version;
  if (!v) fail('tauri.conf.json 缺 version 字段');
  return v;
}

function readNotes(version) {
  const fromArg = arg('notes');
  if (fromArg) return fromArg;
  // 读 release-notes.md 全文（含版本行 + 条目，由 gen-release-notes 生成），作为 latest.json 的 notes。
  const notesFile = path.join(ROOT, 'src-tauri', 'release-notes.md');
  if (fs.existsSync(notesFile)) {
    const full = fs.readFileSync(notesFile, 'utf8').trim();
    if (full) return full;
  }
  return `版本 ${version} 更新`;
}

// 时间戳 yyyy-MM-dd_HHmmss（老工具同款）。
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function findArtifacts(version) {
  if (!fs.existsSync(NSIS_DIR)) fail(`未找到打包产物目录：${NSIS_DIR}\n请先 tauri build（带签名环境变量）`);
  const files = fs.readdirSync(NSIS_DIR);
  const setups = files.filter((f) => f.endsWith('-setup.exe'));
  // 必须按当前 version 精确选包：nsis 目录不会清理历史产物，会同时残留多版本
  // setup.exe（如 _0.1.0_ 与 _0.1.2_）。用 find 取第一个会按字典序命中旧版，
  // 导致 latest.json 写了新版本号、却拷进了旧安装包——装上去仍是旧代码（曾因此把
  // 缺 dangerousInsecureTransportProtocol 的 0.1.0 当成新版发出去，启动即 panic）。
  const pkg = setups.find((f) => f.includes(`_${version}_`));
  if (!pkg) {
    fail(
      `${NSIS_DIR} 下未找到当前版本 ${version} 的 *-setup.exe\n` +
        `现有安装包：${setups.length ? setups.join(', ') : '无'}\n请先用当前版本号 tauri build`
    );
  }
  const sig = `${pkg}.sig`;
  if (!files.includes(sig)) fail(`未找到签名文件 ${sig}（确认构建带 TAURI_SIGNING_PRIVATE_KEY 与 _PASSWORD）`);
  return { pkg, sig };
}

function main() {
  const version = readVersion();
  const notes = readNotes(version);
  // 下载基址优先级：--base= / 环境变量 → 本机局域网 IP（默认端口 8384）→ 兜底 127.0.0.1（仅本机能下）。
  // 必须与 update-config.json 的检查 endpoint 同源，否则会出现「检查到新版但下载走 127.0.0.1 下不动」。
  const lan = lanIPv4s();
  const base = (arg('base') || process.env.UPDATE_BASE_URL || (lan.length ? `http://${lan[0]}:8384` : 'http://127.0.0.1:8384')).replace(/\/+$/, '');
  const { pkg, sig } = findArtifacts(version);
  const signature = fs.readFileSync(path.join(NSIS_DIR, sig), 'utf8').trim();

  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': { signature, url: `${base}/${encodeURIComponent(pkg)}` },
    },
  };
  const manifestStr = JSON.stringify(manifest, null, 2);

  const archiveDir = path.join(REL_ROOT, `v${version}_${stamp()}`);
  const latestDir = path.join(REL_ROOT, 'latest');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.rmSync(latestDir, { recursive: true, force: true });
  fs.mkdirSync(latestDir, { recursive: true });

  // 两处都写：存档留底 + latest 供服务器。
  for (const dir of [archiveDir, latestDir]) {
    fs.copyFileSync(path.join(NSIS_DIR, pkg), path.join(dir, pkg));
    fs.copyFileSync(path.join(NSIS_DIR, sig), path.join(dir, sig));
    fs.writeFileSync(path.join(dir, 'latest.json'), manifestStr, 'utf8');
  }

  console.log('✅ 热更产物已整理：');
  console.log(`   版本：${version}`);
  console.log(`   存档：${archiveDir}`);
  console.log(`   服务：${latestDir}（热更服务器只服务它）`);
  console.log(`   下载基址：${base}（部署时改为内网地址）`);
}

main();
