//! 投屏起停（start / stop / stop_all）。视频主进程恒 --no-audio；启动时若请求转音频则起音频进程。

use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout};

use crate::adb::binary;
use crate::adb::error::AdbError;
use crate::adb::scrcpy::{self, MirrorStartOptions};

use super::{
    audio, describe_mirror_failure, emit_status, finalize_stopped, next_generation, registry,
    resolve_pico_crop, spawn_scrcpy, ActiveMirror, MirrorSession, PROBE_MS,
};

/// 开始投屏：spawn 视频主进程并探测存活，注册会话 + 启动退出监听。
/// 已在投屏的设备先停掉旧会话再起新的。Pico 设备自动查分辨率裁单眼（T3.4）；
/// options.forward_audio 为真时投屏成功后立即把声音转电脑（T3.5）。
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
                audio: None,
                session: session.clone(),
            },
        );
    }

    emit_status(app, &session);

    // 启动即转音频：失败不影响视频投屏，返回带最新音频状态的会话。
    if options.forward_audio == Some(true) {
        if let Ok(updated) = audio::set_audio(app, device_id, true).await {
            return Ok(updated);
        }
    }
    Ok(session)
}

/// 停止投屏：移除会话、触发视频与音频进程退出、广播 stopped。无会话则幂等返回。
pub async fn stop(app: &AppHandle, device_id: &str) {
    let active = registry().lock().ok().and_then(|mut m| m.remove(device_id));
    let active = match active {
        Some(a) => a,
        None => return,
    };
    if let Some(tx) = active.stop_video {
        let _ = tx.send(()); // 监听 task 收到后 kill child
    }
    if let Some(audio) = active.audio {
        let _ = audio.stop_tx.send(());
    }
    emit_status(app, &MirrorSession::stopped(device_id));
}

/// 应用退出时回收所有投屏进程（视频 + 音频，不广播事件，窗口即将关闭）。
pub async fn stop_all() {
    let all: Vec<ActiveMirror> = registry()
        .lock()
        .map(|mut m| m.drain().map(|(_, v)| v).collect())
        .unwrap_or_default();
    for active in all {
        if let Some(tx) = active.stop_video {
            let _ = tx.send(());
        }
        if let Some(audio) = active.audio {
            let _ = audio.stop_tx.send(());
        }
    }
    // 给 kill 一点时间落地（kill_on_drop 也会兜底）。
    sleep(Duration::from_millis(100)).await;
}
