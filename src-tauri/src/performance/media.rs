//! 采集媒体协议（对应原 performanceMedia.ts）。注册自定义 scheme `adm-media`，把会话相对路径
//! （performance-captures/... 或旧 performance-recordings/...）映射到运行时根目录下的磁盘文件，
//! 供前端 <video> 播放与离屏截图。UI 只见相对路径，绝不暴露宿主绝对路径。
//!
//! - 支持 HTTP Range（206）：时间轴拖动 seek 与大分段分块加载靠它；单次响应分块上限 4MB，控内存。
//! - 开 CORS（Access-Control-Allow-Origin: *）：让 crossOrigin 离屏 <video> 抓帧绘 canvas 不被污染。
//! - 穿越防护：相对路径必须以白名单根开头且不含 `..`。
//! 路径解析按「白名单根标记」定位，规避 Windows 下自定义 scheme 被改写为 http://scheme.localhost 的差异。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};

use crate::runtime_root::resolve_runtime_app_root;

pub const SCHEME: &str = "adm-media";
const ALLOWED_ROOTS: [&str; 2] = ["performance-recordings", "performance-captures"];
/// 单次 Range 响应的分块上限，避免一次性把大分段读进内存（浏览器会按需再请求后续区间）。
const MAX_CHUNK: u64 = 4 * 1024 * 1024;

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn error(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .unwrap_or_default()
}

/// 从请求 URI 提取会话相对路径：按白名单根标记定位，兼容各平台 host/path 改写差异。
fn relative_path_from_uri(uri: &str) -> Option<String> {
    let norm = percent_decode(uri).replace('\\', "/");
    for root in ALLOWED_ROOTS {
        let marker = format!("{root}/");
        if let Some(idx) = norm.find(&marker) {
            let mut rel = norm[idx..].to_string();
            if let Some(q) = rel.find(['?', '#']) {
                rel.truncate(q);
            }
            return Some(rel);
        }
    }
    None
}

/// 相对路径 → 运行时根目录下的绝对路径（拒绝 `..` 穿越；已由 relative_path_from_uri 保证白名单根前缀）。
fn resolve_under_root(relative: &str) -> Option<PathBuf> {
    if relative.is_empty() || relative.contains("..") {
        return None;
    }
    Some(resolve_runtime_app_root().join(relative))
}

/// 解析 Range 头 `bytes=start-end`，返回 (start, end)（含端点，已对文件长度钳制 + 分块上限）。
fn parse_range(range: &str, len: u64) -> Option<(u64, u64)> {
    let spec = range.trim().strip_prefix("bytes=")?;
    // 只取第一个区间。
    let first = spec.split(',').next()?.trim();
    let (s, e) = first.split_once('-')?;
    let start: u64 = if s.is_empty() { 0 } else { s.trim().parse().ok()? };
    if start >= len {
        return None;
    }
    let requested_end: u64 = if e.trim().is_empty() {
        len - 1
    } else {
        e.trim().parse().ok()?
    };
    // 钳制到文件末尾，并施加单次分块上限。
    let end = requested_end.min(len - 1).min(start + MAX_CHUNK - 1);
    Some((start, end))
}

fn serve_file(path: &Path, range: Option<&str>) -> Response<Vec<u8>> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return error(StatusCode::NOT_FOUND),
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return error(StatusCode::NOT_FOUND),
    };
    let ct = content_type(path);

    match range.and_then(|r| parse_range(r, len)) {
        Some((start, end)) => {
            let count = end - start + 1;
            let mut buf = vec![0u8; count as usize];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
                return error(StatusCode::INTERNAL_SERVER_ERROR);
            }
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, ct)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, count.to_string())
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(buf)
                .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR))
        }
        None => {
            // 无 Range（或非法 Range）→ 整文件 200（截图等小文件；视频浏览器通常会带 Range）。
            let mut buf = Vec::new();
            if file.read_to_end(&mut buf).is_err() {
                return error(StatusCode::INTERNAL_SERVER_ERROR);
            }
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, ct)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_LENGTH, len.to_string())
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(buf)
                .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR))
        }
    }
}

/// adm-media 协议请求处理：URI → 相对路径 → 运行时根目录磁盘文件，支持 Range。
pub fn handle(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let path = match relative_path_from_uri(&uri).as_deref().and_then(resolve_under_root) {
        Some(p) => p,
        None => return error(StatusCode::FORBIDDEN),
    };
    serve_file(&path, range.as_deref())
}
