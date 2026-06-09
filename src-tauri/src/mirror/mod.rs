//! 投屏镜像进程管理（T3.3 起）：scrcpy 视频主进程 + 独立音频进程（T3.5）的生命周期编排。
//!
//! 按职责拆分：
//! - mod（本文件）：共享核心——会话类型、进程注册表、scrcpy spawn、瞬间失败探测/文案、退出收尾。
//! - lifecycle：起停投屏（start / stop / stop_all）。
//! - audio：声音去向实时切换（set_mirror_audio）。
//!
//! 设计要点：
//! - scrcpy 是长驻进程。spawn 后用探测窗口判定「是否瞬间失败」（设备离线/参数错会很快退出）。
//! - 视频主进程恒 --no-audio；声音由独立「纯音频」进程承载，二者同属一个会话，可投屏中起停切换。
//! - 通过 ADB 环境变量让 scrcpy 复用 bundled platform-tools 的 adb，避免两套 adb server 版本互踢。
//! - generation 防竞态：快速 stop→start 时，旧进程退出回调只在注册表仍是自己这一代时才广播 stopped。

mod audio;
mod lifecycle;

pub use audio::set_audio;
pub use lifecycle::{start, stop, stop_all};

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

use crate::adb::error::AdbError;
use crate::adb::manager::exec_adb;
use crate::adb::scrcpy;

/// scrcpy 启动后判定「是否瞬间失败」的探测窗口（设备离线/参数错会在此窗口内退出）。
pub(super) const PROBE_MS: u64 = 1200;
const MIRROR_STATUS_EVENT: &str = "mirror_status";

/// 投屏会话状态（对齐前端 shared/types 的 MirrorSession，序列化 camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSession {
    pub device_id: String,
    pub status: String, // "starting" | "running" | "stopped" | "failed"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub is_pico: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_rate: Option<String>,
    pub audio_forwarded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_mode: Option<String>, // "both" | "pc-only"
}

impl MirrorSession {
    pub(super) fn stopped(device_id: &str) -> Self {
        MirrorSession {
            device_id: device_id.to_string(),
            status: "stopped".to_string(),
            error: None,
            is_pico: false,
            crop: None,
            max_size: None,
            bit_rate: None,
            audio_forwarded: false,
            audio_mode: None,
        }
    }
}

/// 独立音频进程句柄（投屏中起停切换声音去向用）。
pub(super) struct AudioHandle {
    /// 触发音频进程停止（监听 task 收到后 kill child）。
    pub(super) stop_tx: oneshot::Sender<()>,
}

pub(super) struct ActiveMirror {
    pub(super) generation: u64,
    /// 触发视频主进程停止。
    pub(super) stop_video: Option<oneshot::Sender<()>>,
    /// 当前转音频的独立进程（None=声音留在设备）。
    pub(super) audio: Option<AudioHandle>,
    /// 当前会话快照（切音频后回写并重新广播）。
    pub(super) session: MirrorSession,
}

pub(super) fn registry() -> &'static Mutex<HashMap<String, ActiveMirror>> {
    static R: OnceLock<Mutex<HashMap<String, ActiveMirror>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn next_generation() -> u64 {
    static GEN: AtomicU64 = AtomicU64::new(1);
    GEN.fetch_add(1, Ordering::SeqCst)
}

pub(super) fn emit_status(app: &AppHandle, session: &MirrorSession) {
    let _ = app.emit(MIRROR_STATUS_EVENT, session);
}

/// spawn scrcpy 子进程：stderr 后台收集（供探测失败文案 + 防管道写满阻塞）。
pub(super) fn spawn_scrcpy(
    scrcpy_path: &Path,
    adb_path: Option<&Path>,
    args: &[String],
) -> Result<(Child, Arc<Mutex<String>>), AdbError> {
    let mut cmd = Command::new(scrcpy_path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // 让 scrcpy 复用 bundled adb，避免与 platform-tools 的 adb server 版本互踢。
    if let Some(adb) = adb_path {
        cmd.env("ADB", adb);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW); // 隐藏 scrcpy 控制台黑窗（SDL 视频窗口不受影响）
    }

    let mut child = cmd.spawn().map_err(|e| {
        AdbError::custom(
            "MIRROR_START_FAILED",
            format!("启动投屏失败：{e}"),
            "确认内置 scrcpy 可用、设备已连接并授权。",
            e.to_string(),
        )
    })?;

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
    Ok((child, stderr_buf))
}

/// 把 scrcpy 瞬间失败的 stderr 翻成可操作的中文提示。
pub(super) fn describe_mirror_failure(stderr: &str) -> String {
    let s = stderr.trim();
    let lower = s.to_lowercase();
    if lower.contains("could not find") || lower.contains("no device") || lower.contains("device not found") {
        "未找到目标设备，请确认设备已连接并授权。".to_string()
    } else if lower.contains("unauthorized") {
        "设备未授权，请在设备上允许此电脑的 USB 调试。".to_string()
    } else if s.is_empty() {
        "投屏进程启动后立即退出（无错误输出）。请确认设备在线并重试。".to_string()
    } else {
        // 仅取末尾若干行，避免把整段 scrcpy 日志塞给用户。
        let tail: Vec<&str> = s.lines().rev().take(3).collect();
        tail.into_iter().rev().collect::<Vec<_>>().join("\n")
    }
}

/// 查 Pico 设备屏幕分辨率并算出单眼裁切参数；任一步失败返回 None（降级为不裁切）。
pub(super) async fn resolve_pico_crop(adb: &Path, device_id: &str) -> Option<String> {
    let out = exec_adb(adb, &["-s", device_id, "shell", "wm", "size"], 8000).await.ok()?;
    let (w, h) = scrcpy::parse_screen_size(&out.stdout)?;
    scrcpy::single_eye_crop(w, h)
}

/// 进程退出后收尾：仅当注册表仍是本代会话时移除并广播 stopped（防快速重启竞态误广播）。
pub(super) fn finalize_stopped(app: &AppHandle, device_id: &str, generation: u64) {
    let should_emit = {
        let mut map = match registry().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        match map.get(device_id) {
            Some(active) if active.generation == generation => {
                map.remove(device_id);
                true
            }
            _ => false,
        }
    };
    if should_emit {
        emit_status(app, &MirrorSession::stopped(device_id));
    }
}
