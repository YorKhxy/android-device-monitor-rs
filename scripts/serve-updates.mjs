// 热更服务器（移植自老工具 scripts/serve-updates.js，适配 Tauri updater 的 latest.json）。
// 把 update-releases/latest 通过 HTTP 暴露，供客户端 tauri-plugin-updater 拉 latest.json 与安装包做自动更新。
//
// 用法：
//   npm run serve:updates                              # 默认服务 update-releases/latest，端口 8384，监听 0.0.0.0
//   PORT=9000 npm run serve:updates                    # 自定义端口
//   node ./scripts/serve-updates.mjs update-releases/latest 8384
//
// 要点（与老工具一致）：
//  - 监听 0.0.0.0；客户端把更新源指到 http://<你的地址>:<端口>/latest.json
//  - HTTP Range（206）支持断点续传
//  - 分桶限流（check/download/report/other）+ 并发连接/下载上限 + 防 slowloris
//  - /__report 客户端上报端点（记录更新成功/失败到控制台）
//  - 只读静态服务、防目录穿越；路径从 __dirname 推导不写死盘符

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 默认服务 update-releases/latest（make-update-package 每次刷新它，只含最新一版干净产物）。
const servedDirArg = process.argv[2] || 'update-releases/latest';
const port = Number(process.env.PORT || process.argv[3] || 8384);
const root = path.resolve(__dirname, '..', servedDirArg);

const CONTENT_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.sig': 'text/plain; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.yml': 'text/yaml; charset=utf-8',
  '.blockmap': 'application/octet-stream',
};

const clientIp = (req) => {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '') || '未知IP';
};
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const actionLabel = (urlPath, code) => {
  if (/latest.*\.json$/i.test(urlPath)) return '   <= 检查更新';
  if (/\.exe$/i.test(urlPath)) return '   <= 下载更新（热更中）';
  return '';
};
const logReq = (req, code, urlPath, extra) => {
  console.log(`[${stamp()}] ${clientIp(req)}  ${code} ${urlPath}${extra || ''}${actionLabel(urlPath, code)}`);
};

// ───── 防滥用（内网信任环境，不鉴权，只防刷爆）。阈值均可被环境变量覆盖 ─────
const RL_WINDOW_MS = Number(process.env.RL_WINDOW_MS || 60_000);
const RL_MAX = {
  check: Number(process.env.RL_CHECK_MAX || 60),
  download: Number(process.env.RL_DOWNLOAD_MAX || 30),
  report: Number(process.env.RL_REPORT_MAX || 120),
  other: Number(process.env.RL_OTHER_MAX || 120),
};
const MAX_CONN = Number(process.env.MAX_CONN || 100);
const MAX_DOWNLOADS = Number(process.env.MAX_DOWNLOADS || 16);
const MAX_DOWNLOADS_PER_IP = Number(process.env.MAX_DOWNLOADS_PER_IP || 3);
const SOCKET_TIMEOUT_MS = Number(process.env.SOCKET_TIMEOUT_MS || 30_000);
const REPORT_MSG_MAX = 200;

const bucketFor = (urlPath) => {
  if (urlPath === '/__report') return 'report';
  if (/\.(json|ya?ml)$/i.test(urlPath)) return 'check';
  if (/\.(exe|zip|sig|blockmap)$/i.test(urlPath)) return 'download';
  return 'other';
};

const hits = new Map();
const sweepWindow = (arr) => {
  const cutoff = Date.now() - RL_WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
  return arr;
};
const rateAllow = (ip, bucket) => {
  let rec = hits.get(ip);
  if (!rec) {
    rec = { check: [], download: [], report: [], other: [] };
    hits.set(ip, rec);
  }
  const arr = sweepWindow(rec[bucket]);
  if (arr.length >= RL_MAX[bucket]) return false;
  arr.push(Date.now());
  return true;
};
setInterval(() => {
  for (const [ip, rec] of hits) {
    let empty = true;
    for (const k of Object.keys(rec)) if (sweepWindow(rec[k]).length) empty = false;
    if (empty) hits.delete(ip);
  }
}, RL_WINDOW_MS).unref();

let activeDownloads = 0;
const activeByIp = new Map();
const incDownload = (ip) => {
  activeDownloads++;
  activeByIp.set(ip, (activeByIp.get(ip) || 0) + 1);
};
const decDownload = (ip) => {
  activeDownloads = Math.max(0, activeDownloads - 1);
  const n = (activeByIp.get(ip) || 1) - 1;
  if (n <= 0) activeByIp.delete(ip);
  else activeByIp.set(ip, n);
};
const streamFile = (stream, res, ip, isDownload) => {
  if (isDownload) {
    incDownload(ip);
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      decDownload(ip);
    };
    res.on('close', release);
    stream.on('error', release);
  }
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {
      /* noop */
    }
  });
  stream.pipe(res);
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const ip = clientIp(req);
  const bucket = bucketFor(urlPath);

  if (!rateAllow(ip, bucket)) {
    res.writeHead(429, { 'Retry-After': Math.ceil(RL_WINDOW_MS / 1000), 'Content-Type': 'text/plain' });
    res.end('Too Many Requests');
    logReq(req, 429, urlPath, ` [限流:${bucket}]`);
    return;
  }

  // 客户端更新状态上报端点（仅记录到控制台）。
  if (urlPath === '/__report') {
    let q;
    try {
      q = new URL(req.url, 'http://x').searchParams;
    } catch {
      q = new URLSearchParams();
    }
    const clean = (s) => (s == null ? s : String(s).replace(/[\r\n]+/g, ' ').slice(0, REPORT_MSG_MAX));
    const v = clean(q.get('v')) || '?';
    const e = clean(q.get('e')) || '?';
    const to = clean(q.get('to'));
    const msg = clean(q.get('msg'));
    let label;
    if (e === 'startup') label = `运行中 版本=${v}`;
    else if (e === 'downloaded') label = `已下载新版 目标=${to || '?'}（待重启安装）`;
    else if (e === 'error') label = `更新失败：${msg || ''}`;
    else label = `${e} 版本=${v}`;
    console.log(`[${stamp()}] ${clientIp(req)}  * 上报 ${label}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const resolved = path.resolve(root, '.' + urlPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      logReq(req, 404, urlPath);
      return;
    }

    const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    const isDownload = bucket === 'download';

    if (isDownload && (activeDownloads >= MAX_DOWNLOADS || (activeByIp.get(ip) || 0) >= MAX_DOWNLOADS_PER_IP)) {
      res.writeHead(503, { 'Retry-After': 5, 'Content-Type': 'text/plain' });
      res.end('Server Busy');
      logReq(req, 503, urlPath, ' [并发下载上限]');
      return;
    }

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : st.size - 1;
        if (start > end || end >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        streamFile(fs.createReadStream(resolved, { start, end }), res, ip, isDownload);
        logReq(req, 206, urlPath, ` [${start}-${end}]`);
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    streamFile(fs.createReadStream(resolved), res, ip, isDownload);
    logReq(req, 200, urlPath);
  });
});

server.maxConnections = MAX_CONN;
server.requestTimeout = SOCKET_TIMEOUT_MS;
server.headersTimeout = Math.min(SOCKET_TIMEOUT_MS, 15_000);
server.keepAliveTimeout = 5_000;
server.on('connection', (socket) => socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy()));

if (!fs.existsSync(root)) {
  console.warn(`[serve-updates] 警告：服务目录不存在：${root}\n  先运行「打热更包」生成 latest.json 与安装包。`);
}

// listen 失败（如端口被占用）清楚报错，而非闷崩。
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${port} 已被占用——可能服务器已在运行，或换个端口： PORT=8385 启动。`);
  } else {
    console.error(`\n❌ 服务器出错：${e.message}`);
  }
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[serve-updates] 热更服务器已启动`);
  console.log(`  服务目录：${root}`);
  console.log(`  本机访问：http://127.0.0.1:${port}/latest.json`);
  console.log(`  局域网访问：http://<本机局域网IP>:${port}/latest.json（客户端更新源指到此）`);
  console.log(
    `  防滥用：每 IP/${RL_WINDOW_MS / 1000}s 检查≤${RL_MAX.check} 下载≤${RL_MAX.download}；` +
      `并发连接≤${MAX_CONN}，并发下载≤${MAX_DOWNLOADS}(单IP≤${MAX_DOWNLOADS_PER_IP})。`,
  );
});
