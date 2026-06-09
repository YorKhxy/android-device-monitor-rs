//! 采集会话归档（对应原 performanceCaptureStore.ts）。一次「开始→关闭」= 一个会话，落盘到运行时根目录：
//!   performance-captures/<id>/{manifest.json, video/seg-N.mp4, data/samples.jsonl, data/markers.json, screenshots/}
//! 根目录用 resolve_runtime_app_root（不落 C 盘 userData），UI 只见相对路径（正斜杠）。
//! samples/markers 以 JSON 透传（serde_json::Value），不强解析 metrics 树；manifest 为 typed 结构。

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::adb::capture_segment::CaptureSegmentMeta;
use crate::adb::error::AdbError;
use crate::runtime_root::resolve_runtime_app_root;

use super::types::{CaptureSession, CreateSessionInput, FinalizeSessionInput};

pub const CAPTURES_DIR: &str = "performance-captures";
pub const SAMPLES_FILE: &str = "samples.jsonl";
const MARKERS_FILE: &str = "markers.json";
const MANIFEST_FILE: &str = "manifest.json";

/// loadSession 返回：会话元数据 + 完整样本序列 + 已存标记（samples/markers 原样透传）。
#[derive(Serialize)]
pub struct CaptureSessionDetail {
    pub session: CaptureSession,
    pub samples: Vec<Value>,
    pub markers: Vec<Value>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 串行化 manifest 的读-改-写，避免 append_segment 与 finalize 并发丢更新（全局锁，跨会话亦安全）。
fn manifest_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn err(message: impl Into<String>, hint: &str, details: impl Into<String>) -> AdbError {
    AdbError::custom("CAPTURE_STORE_ERROR", message.into(), hint, details.into())
}

/// `[^\w.-]+ → _`，去首尾 `_`，空则 "device"（对齐原 sanitizeSegment，用于会话 id）。
fn sanitize(value: &str) -> String {
    let mut out = String::new();
    let mut prev = false;
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            out.push(c);
            prev = false;
        } else if !prev {
            out.push('_');
            prev = true;
        }
    }
    let t = out.trim_matches('_');
    if t.is_empty() { "device".to_string() } else { t.to_string() }
}

pub fn captures_root() -> PathBuf {
    resolve_runtime_app_root().join(CAPTURES_DIR)
}

/// 会话目录，并对外部可控的 sessionId 做穿越防护（拒绝空 / 含分隔符 / `..`）。
/// 公开供导出命令（getSessionDir）与导入（capture_transfer）复用。
pub fn session_dir(session_id: &str) -> Result<PathBuf, AdbError> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return Err(err(
            format!("非法的采集会话 ID：{session_id}"),
            "请从回看列表中选择有效的采集记录。",
            format!("invalid session id: {session_id}"),
        ));
    }
    Ok(captures_root().join(session_id))
}

pub fn video_dir(session_id: &str) -> Result<PathBuf, AdbError> {
    Ok(session_dir(session_id)?.join("video"))
}

fn data_dir(session_id: &str) -> Result<PathBuf, AdbError> {
    Ok(session_dir(session_id)?.join("data"))
}

fn screenshot_dir(session_id: &str) -> Result<PathBuf, AdbError> {
    Ok(session_dir(session_id)?.join("screenshots"))
}

pub async fn write_manifest(session_id: &str, session: &CaptureSession) -> Result<(), AdbError> {
    let path = session_dir(session_id)?.join(MANIFEST_FILE);
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(session).map_err(|e| err(
            "序列化会话清单失败",
            "请重试。",
            e.to_string()
        ))?
    );
    tokio::fs::write(&path, body)
        .await
        .map_err(|e| err("写入会话清单失败", "检查运行时目录写权限。", e.to_string()))
}

async fn read_manifest(session_id: &str) -> Result<CaptureSession, AdbError> {
    let path = session_dir(session_id)?.join(MANIFEST_FILE);
    let raw = tokio::fs::read_to_string(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            err("采集会话不存在或已被删除。", "刷新回看列表后重试。", "manifest not found")
        } else {
            err("读取会话清单失败", "请重试。", e.to_string())
        }
    })?;
    serde_json::from_str(&raw).map_err(|e| err("解析会话清单失败", "该会话数据可能已损坏。", e.to_string()))
}

/// 串行化的 manifest 读-改-写。
async fn mutate_manifest<F>(session_id: &str, update: F) -> Result<CaptureSession, AdbError>
where
    F: FnOnce(CaptureSession) -> CaptureSession,
{
    let _guard = manifest_lock().lock().await;
    let session = read_manifest(session_id).await?;
    let updated = update(session);
    write_manifest(session_id, &updated).await?;
    Ok(updated)
}

/// 创建会话：建 video/data/screenshots 目录、写 manifest、预创建空 samples.jsonl（防崩溃 load 报错）。
pub async fn create_session(input: CreateSessionInput) -> Result<CaptureSession, AdbError> {
    let started_at = now_ms();
    let sn = if input.device_sn.trim().is_empty() {
        &input.device_id
    } else {
        &input.device_sn
    };
    let id = format!("{}-{}", sanitize(sn), started_at);

    for dir in [video_dir(&id)?, data_dir(&id)?, screenshot_dir(&id)?] {
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| err("创建会话目录失败", "检查运行时根目录写权限。", e.to_string()))?;
    }

    let session = CaptureSession {
        id: id.clone(),
        device_id: input.device_id,
        device_sn: input.device_sn,
        title: None,
        provider: input.provider,
        status: "recording".to_string(),
        started_at,
        ended_at: None,
        duration_ms: 0,
        single_eye_video: input.single_eye_video,
        audio_recorded: Some(input.audio_recorded),
        video_segments: Vec::new(),
        data_relative_path: format!("{CAPTURES_DIR}/{id}/data/{SAMPLES_FILE}"),
        screenshot_dir: Some(format!("{CAPTURES_DIR}/{id}/screenshots")),
        package_name: input.package_name,
        activity_name: input.activity_name,
        size_bytes: Some(0),
        error: None,
    };
    write_manifest(&id, &session).await?;
    let samples = data_dir(&id)?.join(SAMPLES_FILE);
    let _ = tokio::fs::write(&samples, "").await;
    Ok(session)
}

/// 流式追加一条采样（JSON 一行，落盘即不丢）。
pub async fn append_sample(session_id: &str, sample: &Value) -> Result<(), AdbError> {
    let path = data_dir(session_id)?.join(SAMPLES_FILE);
    let line = format!("{}\n", serde_json::to_string(sample).unwrap_or_default());
    let mut f = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| err("打开采样文件失败", "请重试。", e.to_string()))?;
    f.write_all(line.as_bytes())
        .await
        .map_err(|e| err("写入采样失败", "请重试。", e.to_string()))
}

/// 记录一段已落盘的视频分段（按 index 去重 + 排序），并累加总体积。
pub async fn append_segment(session_id: &str, segment: CaptureSegmentMeta) -> Result<(), AdbError> {
    mutate_manifest(session_id, move |mut s| {
        let idx = segment.index;
        s.video_segments.retain(|x| x.index != idx);
        s.video_segments.push(segment);
        s.video_segments.sort_by_key(|x| x.index);
        s.size_bytes = Some(s.video_segments.iter().map(|x| x.size_bytes).sum());
        s
    })
    .await
    .map(|_| ())
}

pub async fn finalize_session(
    session_id: &str,
    input: FinalizeSessionInput,
) -> Result<CaptureSession, AdbError> {
    mutate_manifest(session_id, move |mut s| {
        s.status = input.status;
        s.ended_at = Some(input.ended_at);
        s.duration_ms = input.duration_ms;
        s.error = input.error;
        s
    })
    .await
}

pub async fn rename_session(session_id: &str, title: &str) -> Result<CaptureSession, AdbError> {
    let trimmed = title.trim().to_string();
    mutate_manifest(session_id, move |mut s| {
        s.title = if trimmed.is_empty() { None } else { Some(trimmed) };
        s
    })
    .await
}

/// 保存参数过滤标记（原样写入 markers.json）。
pub async fn save_markers(session_id: &str, markers: &Value) -> Result<(), AdbError> {
    let path = data_dir(session_id)?.join(MARKERS_FILE);
    let body = format!("{}\n", serde_json::to_string_pretty(markers).unwrap_or_else(|_| "[]".into()));
    tokio::fs::write(&path, body)
        .await
        .map_err(|e| err("保存标记失败", "请重试。", e.to_string()))
}

/// 保存一帧快捷截图到 screenshots/，返回相对路径（供回看展示）。消费方：T2.7 save_capture_frame。
pub async fn save_screenshot(session_id: &str, png: &[u8]) -> Result<String, AdbError> {
    let dir = screenshot_dir(session_id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| err("创建截图目录失败", "请重试。", e.to_string()))?;
    let file_name = format!("shot-{}.png", now_ms());
    tokio::fs::write(dir.join(&file_name), png)
        .await
        .map_err(|e| err("保存截图失败", "请重试。", e.to_string()))?;
    Ok(format!("{CAPTURES_DIR}/{session_id}/screenshots/{file_name}"))
}

/// 删除整个会话目录（video/data/screenshots 一并清除；二次确认在 UI 侧）。
pub async fn delete_session(session_id: &str) -> Result<(), AdbError> {
    let dir = session_dir(session_id)?;
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|e| err("删除采集会话失败", "请重试。", e.to_string()))
}

/// 回看列表：读全部会话 manifest，按开始时间倒序。
pub async fn list_sessions() -> Vec<CaptureSession> {
    let root = captures_root();
    let mut entries = match tokio::fs::read_dir(&root).await {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut sessions = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                if let Ok(session) = read_manifest(name).await {
                    sessions.push(session);
                }
            }
        }
    }
    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    sessions
}

/// 加载会话详情：manifest + 全部样本 + 标记（样本损坏行跳过，不让整次回看失败）。
pub async fn load_session(session_id: &str) -> Result<CaptureSessionDetail, AdbError> {
    let session = read_manifest(session_id).await?;
    let samples = read_samples(session_id).await;
    let markers = read_markers(session_id).await;
    Ok(CaptureSessionDetail {
        session,
        samples,
        markers,
    })
}

async fn read_samples(session_id: &str) -> Vec<Value> {
    let path = match data_dir(session_id) {
        Ok(p) => p.join(SAMPLES_FILE),
        Err(_) => return Vec::new(),
    };
    let raw = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    raw.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

async fn read_markers(session_id: &str) -> Vec<Value> {
    let path = match data_dir(session_id) {
        Ok(p) => p.join(MARKERS_FILE),
        Err(_) => return Vec::new(),
    };
    let raw = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    if raw.trim().is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(arr)) => arr,
        _ => Vec::new(),
    }
}
