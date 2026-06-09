//! 投屏镜像进程管理（T3.3）：起停 scrcpy 视频主进程，维护按 deviceId 的会话注册表，
//! 监听子进程退出自动广播 mirror_status，应用退出时回收常驻进程。
//!
//! 设计要点：
//! - scrcpy 是长驻 GUI 进程。spawn 后用探测窗口判定「是否瞬间失败」（设备离线/参数错会很快退出）。
//! - 视频主进程恒 --no-audio；声音由独立音频进程承载（T3.5），二者同属一个会话。
//! - 通过 ADB 环境变量让 scrcpy 复用 bundled platform-tools 的 adb，避免两套 adb server 版本互踢。
//! - generation 防竞态：快速 stop→start 时，旧进程退出回调只在注册表仍是自己这一代时才广播 stopped。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout};

use crate::adb::binary;
use crate::adb::error::AdbError;
use crate::adb::manager::exec_adb;
use crate::adb::scrcpy::{self, MirrorStartOptions};

/// scrcpy 启动后判定「是否瞬间失败」的探测窗口（设备离线/参数错会在此窗口内退出）。
const PROBE_MS: u64 = 1200;
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
    fn stopped(device_id: &str) -> Self {
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

struct ActiveMirror {
    generation: u64,
    /// 触发视频主进程停止（task 收到后 kill child）。
    stop_video: Option<oneshot::Sender<()>>,
    /// 当前会话快照（T3.5 set_mirror_audio 据此切换音频后回写并重新广播）。
    #[allow(dead_code)]
    session: MirrorSession,
}

fn registry() -> &'static Mutex<HashMap<String, ActiveMirror>> {
    static R: OnceLock<Mutex<HashMap<String, ActiveMirror>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_generation() -> u64 {
    static GEN: AtomicU64 = AtomicU64::new(1);
    GEN.fetch_add(1, Ordering::SeqCst)
}

fn emit_status(app: &AppHandle, session: &MirrorSession) {
    let _ = app.emit(MIRROR_STATUS_EVENT, session);
}

/// spawn scrcpy 子进程：stderr 后台收集（供探测失败文案 + 防管道写满阻塞）。
fn spawn_scrcpy(
    scrcpy_path: &std::path::Path,
    adb_path: Option<&std::path::Path>,
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
fn describe_mirror_failure(stderr: &str) -> String {
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
async fn resolve_pico_crop(adb: &std::path::Path, device_id: &str) -> Option<String> {
    let out = exec_adb(adb, &["-s", device_id, "shell", "wm", "size"], 8000).await.ok()?;
    let (w, h) = scrcpy::parse_screen_size(&out.stdout)?;
    scrcpy::single_eye_crop(w, h)
}

/// 进程退出后收尾：仅当注册表仍是本代会话时移除并广播 stopped（防快速重启竞态误广播）。
fn finalize_stopped(app: &AppHandle, device_id: &str, generation: u64) {
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

/// 开始投屏：spawn 视频主进程并探测存活，注册会话 + 启动退出监听。
/// 已在投屏的设备先停掉旧会话再起新的。Pico 设备自动查分辨率裁单眼（T3.4）。
pub async fn start(
    app: &AppHandle,
    device_id: &str,
    options: MirrorStartOptions,
) -> Result<MirrorSession, AdbError> {
    let scrcpy_path = scrcpy::resolve_scrcpy_path(app).ok_or_else(|| {
        AdbError::custom(
            "MIRROR_SCRCPY_NOT_FOUND",
            "未找到内置 scrcpy。".to_string(),
            "请重新安装应用，或运行 npm run prepare:scrcpy 准备投屏组件。",
            "scrcpy binary not found".to_string(),
        )
    })?;
    let adb_path = binary::resolve_adb_path(app);

    // Pico 设备：查屏幕分辨率裁左眼（--crop 宽/2:高:0:0）。查不到则降级为不裁切（投全屏双眼）。
    let crop = match (options.is_pico, adb_path.as_deref()) {
        (Some(true), Some(adb)) => resolve_pico_crop(adb, device_id).await,
        _ => None,
    };

    // 已在投屏 → 先停旧会话（kill 旧进程并清注册表），再起新的。
    stop(app, device_id).await;

    let args = scrcpy::build_video_args(device_id, &options, crop.as_deref());
    let (mut child, stderr_buf) = spawn_scrcpy(&scrcpy_path, adb_path.as_deref(), &args)?;

    // 探测窗口内退出 = 瞬间失败：读 stderr 文案，广播 failed 并返回错误。
    if timeout(Duration::from_millis(PROBE_MS), child.wait()).await.is_ok() {
        sleep(Duration::from_millis(50)).await;
        let err = stderr_buf.lock().map(|g| g.clone()).unwrap_or_default();
        let message = describe_mirror_failure(&err);
        let failed = MirrorSession {
            status: "failed".to_string(),
            error: Some(message.clone()),
            ..MirrorSession::stopped(device_id)
        };
        emit_status(app, &failed);
        return Err(AdbError::custom(
            "MIRROR_START_FAILED",
            message,
            "确认设备在线并授权后重试。",
            err.trim().to_string(),
        ));
    }

    let generation = next_generation();
    let session = MirrorSession {
        device_id: device_id.to_string(),
        status: "running".to_string(),
        error: None,
        is_pico: options.is_pico.unwrap_or(false),
        crop,
        max_size: options.max_size,
        bit_rate: options.bit_rate.clone(),
        audio_forwarded: false,
        audio_mode: None,
    };

    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    {
        let app = app.clone();
        let device_id = device_id.to_string();
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}                    // 用户关窗 / 进程自退
                _ = stop_rx => { let _ = child.kill().await; let _ = child.wait().await; }
            }
            finalize_stopped(&app, &device_id, generation);
        });
    }

    if let Ok(mut map) = registry().lock() {
        map.insert(
            device_id.to_string(),
            ActiveMirror {
                generation,
                stop_video: Some(stop_tx),
                session: session.clone(),
            },
        );
    }

    emit_status(app, &session);
    Ok(session)
}

/// 停止投屏：移除会话、触发视频主进程退出、广播 stopped。无会话则幂等返回。
pub async fn stop(app: &AppHandle, device_id: &str) {
    let active = registry().lock().ok().and_then(|mut m| m.remove(device_id));
    let active = match active {
        Some(a) => a,
        None => return,
    };
    if let Some(tx) = active.stop_video {
        let _ = tx.send(()); // 监听 task 收到后 kill child
    }
    emit_status(app, &MirrorSession::stopped(device_id));
}

/// 应用退出时回收所有投屏进程（不广播事件，窗口即将关闭）。
pub async fn stop_all() {
    let all: Vec<ActiveMirror> = registry()
        .lock()
        .map(|mut m| m.drain().map(|(_, v)| v).collect())
        .unwrap_or_default();
    for active in all {
        if let Some(tx) = active.stop_video {
            let _ = tx.send(());
        }
    }
    // 给 kill 一点时间落地（kill_on_drop 也会兜底）。
    sleep(Duration::from_millis(100)).await;
}
