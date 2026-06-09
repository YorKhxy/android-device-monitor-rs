//! 单段录制的生命周期操作（对应原 captureRecorder.ts 的 spawnSegment / assertSegmentAlive /
//! pullSegment / signalScreenrecordStop / describeSegmentFailure 等）。
//! 与多段编排（capture_recorder）分离：这里只管「一段」的 spawn/探测/pull/停止信号。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::{sleep, timeout};

use super::error::AdbError;
use super::manager::exec_adb;

pub const MAX_SEGMENT_SECONDS: u32 = 180;
/// 首段启动后判定「设备端 screenrecord 是否瞬间失败」的探测窗口。
pub const FIRST_SEGMENT_PROBE_MS: u64 = 700;

/// 一段录制视频的元数据（对齐 shared/types 的 PerformanceCaptureSegment）。
/// Deserialize 供会话 manifest 往返（capture_store 读改写）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSegmentMeta {
    pub index: u32,
    pub file_name: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub size_bytes: u64,
}

/// 录制引擎上报事件（经 mpsc 给上层控制器；对应原版 onSegment/onSizeBytes/onError 回调）。
pub enum RecorderEvent {
    Segment(CaptureSegmentMeta),
    SizeBytes(u64),
    Error(String),
}

pub type RecorderSender = UnboundedSender<RecorderEvent>;

pub struct SpawnedSegment {
    pub child: Child,
    stderr: Arc<Mutex<String>>,
}

/// `[^\w.-]+ → _`，去首尾 `_`，空则 "device"（对齐原 sanitizeSegment）。
fn sanitize_segment(value: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            out.push(c);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "device".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn remote_path(device_id: &str, index: u32) -> String {
    format!("/sdcard/adm-capture-{}-{}.mp4", sanitize_segment(device_id), index)
}

/// 把设备端 screenrecord 瞬间失败的 stderr 翻译成可操作的中文指引（对齐 describeSegmentFailure）。
fn describe_segment_failure(stderr: &str) -> String {
    let s = stderr.trim();
    let lower = s.to_lowercase();
    if lower.contains("encoder failed") || lower.contains("err=-38") || s.is_empty() {
        let mut msg = "设备端录屏启动失败，最常见原因是手机处于锁屏或熄屏状态——请先解锁手机屏幕并保持亮屏，再开始采集。".to_string();
        if !s.is_empty() {
            msg.push_str(&format!("（设备返回：{s}）"));
        }
        msg
    } else if lower.contains("permission") || lower.contains("denied") {
        format!("设备端录屏被拒绝，权限不足：{s}")
    } else {
        format!("{s}（若手机处于锁屏/熄屏状态，请先解锁亮屏再开始采集）")
    }
}

/// spawn 一段设备端 screenrecord（stderr 后台收集，用于首段探测/失败文案）。
pub async fn spawn_segment(
    adb: &Path,
    device_id: &str,
    remote: &str,
    bit_rate_mbps: u32,
) -> Result<SpawnedSegment, AdbError> {
    let time_limit = MAX_SEGMENT_SECONDS.to_string();
    let bit_rate = (bit_rate_mbps as u64 * 1000 * 1000).to_string();
    let mut cmd = Command::new(adb);
    cmd.args([
        "-s",
        device_id,
        "shell",
        "screenrecord",
        "--time-limit",
        &time_limit,
        "--bit-rate",
        &bit_rate,
        remote,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        AdbError::custom(
            "ADB_COMMAND_FAILED",
            format!("启动设备端录屏失败：{e}"),
            "确认 adb 可用、设备已连接并授权。",
            e.to_string(),
        )
    })?;

    // 后台读 stderr 到 EOF（进程退出即结束）：既供首段探测取失败文案，也避免管道写满阻塞子进程。
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s).await;
            if let Ok(mut g) = buf.lock() {
                g.push_str(&s);
            }
        });
    }

    Ok(SpawnedSegment {
        child,
        stderr: stderr_buf,
    })
}

/// 首段探测：probe_ms 内若子进程提前退出（瞬间失败）则 Err；否则视为录制正常进行。
pub async fn assert_segment_alive(seg: &mut SpawnedSegment, probe_ms: u64) -> Result<(), AdbError> {
    match timeout(Duration::from_millis(probe_ms), seg.child.wait()).await {
        // 窗口内退出 = 瞬间失败。给 stderr 读取任务一点时间 flush 再取文案。
        Ok(_) => {
            sleep(Duration::from_millis(50)).await;
            let err = seg.stderr.lock().map(|g| g.clone()).unwrap_or_default();
            Err(AdbError::custom(
                "ADB_COMMAND_FAILED",
                describe_segment_failure(&err),
                "请先解锁手机屏幕并保持亮屏，再开始采集。",
                if err.trim().is_empty() {
                    "screenrecord exited immediately".to_string()
                } else {
                    err.trim().to_string()
                },
            ))
        }
        // 超时 = 仍在录（wait future 被取消，子进程不受影响，后续循环再 wait）。
        Err(_) => Ok(()),
    }
}

/// 向设备端 screenrecord 发 SIGINT（pkill -2 / killall -2），让其 finalize 当前 mp4 而非丢弃。
pub async fn signal_screenrecord_stop(adb: &Path, device_id: &str) {
    let _ = exec_adb(adb, &["-s", device_id, "shell", "pkill", "-2", "screenrecord"], 8000).await;
    let _ = exec_adb(adb, &["-s", device_id, "shell", "killall", "-2", "screenrecord"], 8000).await;
    sleep(Duration::from_millis(400)).await;
}

/// pull 一段已录完的视频到本地，删设备端临时文件；空段清掉不上报；有效段上报分段 + 累计体积。
#[allow(clippy::too_many_arguments)]
pub async fn pull_segment(
    adb: PathBuf,
    device_id: String,
    index: u32,
    remote: String,
    start_ms: u64,
    end_ms: u64,
    video_dir: PathBuf,
    total_bytes: Arc<AtomicU64>,
    events: RecorderSender,
) {
    let file_name = format!("seg-{index}.mp4");
    let local = video_dir.join(&file_name);
    let local_str = local.to_string_lossy().to_string();

    if let Err(e) = exec_adb(&adb, &["-s", &device_id, "pull", &remote, &local_str], 60_000).await {
        let _ = events.send(RecorderEvent::Error(e.message));
        return;
    }
    let _ = exec_adb(&adb, &["-s", &device_id, "shell", "rm", "-f", &remote], 8000).await;

    let size = tokio::fs::metadata(&local).await.map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        // 空段（被打断且未写出有效内容）清掉，不上报，避免时间轴出现无视频空洞。
        let _ = tokio::fs::remove_file(&local).await;
        return;
    }

    let total = total_bytes.fetch_add(size, Ordering::SeqCst) + size;
    let _ = events.send(RecorderEvent::Segment(CaptureSegmentMeta {
        index,
        file_name,
        start_ms,
        end_ms,
        size_bytes: size,
    }));
    let _ = events.send(RecorderEvent::SizeBytes(total));
}
