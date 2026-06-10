// 热更服务端（T6.3，对应原工程 serve-updates.js）：分发 Tauri updater 所需的 latest.json + 安装包。
//
// 加固保留（对齐原工程）：
//   - Range 支持：安装包大文件可断点续传（updater/浏览器都能分段拉）。
//   - 限流：单 IP 滑动窗口请求数上限，超出返回 429，防刷。
//   - 访问日志：每次请求落 stdout（方法/路径/状态/IP/耗时），便于上报与排障。
//
// 目录约定：分发根 = release-updates/（由 make-update-package.mjs 生成 latest.json + 拷入 .nsis.zip）。
// 默认端口 8788，与 tauri.conf.json updater.endpoints 对齐。可被环境变量 PORT / UPDATES_DIR 覆盖。
//
// 仅用 Node 内置模块，无第三方依赖。启动：node scripts/serve-updates.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT) || 8788;
const UPDATES_DIR = process.env.UPDATES_DIR
  ? path.resolve(process.env.UPDATES_DIR)
  : path.join(ROOT, 'release-updates');

// 限流：单 IP 在 RATE_WINDOW_MS 内最多 RATE_MAX 次请求。
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const hits = new Map(); // ip -> number[]（时间戳）

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}

// 周期清扫过期 IP 条目，防 hits Map 随不同 IP 单调增长。
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const live = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length === 0) hits.delete(ip);
    else hits.set(ip, live);
  }
}, RATE_WINDOW_MS).unref();

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.sig': 'text/plain; charset=utf-8',
  '.exe': 'application/octet-stream',
};

function log(req, status, ip, startedAt) {
  const ms = Date.now() - startedAt;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${status} ${ip} ${ms}ms`);
}

// 安全解析请求路径到 UPDATES_DIR 内的文件，越界（路径穿越）一律拒绝。
function resolveSafe(urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/updates\/?/, '')) || 'latest.json';
  const target = path.join(UPDATES_DIR, rel);
  const normalized = path.normalize(target);
  // 防 ../ 穿越：必须严格在 UPDATES_DIR 内（加 path.sep，避免 release-updates-xxx 兄弟目录前缀误通过）。
  if (normalized !== UPDATES_DIR && !normalized.startsWith(UPDATES_DIR + path.sep)) return null;
  return normalized;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

// 带 Range 的文件发送（支持单段 bytes=start-end）。
function serveFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
        return send(res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${stat.size}` });
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString();

  const done = (status) => log(req, status, ip, startedAt);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return done(405);
  }
  if (rateLimited(ip)) {
    send(res, 429, 'Too Many Requests', { 'Retry-After': '60' });
    return done(429);
  }

  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/' || urlPath === '/health') {
    send(res, 200, 'ok');
    return done(200);
  }

  const filePath = resolveSafe(urlPath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    send(res, 404, 'Not Found');
    return done(404);
  }

  try {
    res.on('finish', () => done(res.statusCode));
    serveFile(req, res, filePath);
  } catch (e) {
    send(res, 500, 'Internal Error');
    done(500);
  }
});

server.listen(PORT, () => {
  console.log(`热更服务端启动：http://0.0.0.0:${PORT}/updates/latest.json`);
  console.log(`分发目录：${UPDATES_DIR}`);
  if (!fs.existsSync(UPDATES_DIR)) {
    console.warn(`⚠️ 分发目录不存在，请先运行 make-update-package.mjs 生成 latest.json 与安装包。`);
  }
});
