//! 声音去向实时切换（T3.5）：投屏中起停一个独立「纯音频」scrcpy 进程把设备声音转到电脑。
//! Android 13+ 用 --audio-dup（设备与电脑同时出声）；低版本降级 --audio-source=output（设备静音）。
//! 切换不影响视频主画面。

use std::path::Path;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout};

use crate::adb::binary;
use crate::adb::error::AdbError;
use crate::adb::manager::exec_adb;
use crate::adb::scrcpy;

use super::{
    describe_mirror_failure, emit_status, registry, spawn_scrcpy, AudioHandle, MirrorSession,
    PROBE_MS,
};

fn not_running() -> AdbError {
    AdbError::custom(
        "MIRROR_NOT_RUNNING",
        "当前设备未在投屏。".to_string(),
        "请先开始投屏，再切换声音去向。",
        "no active mirror session".to_string(),
    )
}

/// 切换声音去向：forward=true 起音频进程把声音转电脑，false 停音频进程让声音留在设备。
/// 返回更新后的会话（前端据此刷新 audioForwarded / audioMode）。设备未在投屏则报错。
pub async fn set_audio(app: &AppHandle, device_id: &str, forward: bool) -> Result<MirrorSession, AdbError> {
    if forward {
        forward_on(app, device_id).await
    } else {
        forward_off(app, device_id)
    }
}

/// 查设备 API level（ro.build.version.sdk）；失败返回 None（音频参数将保守降级为 output）。
async fn query_api_level(adb: &Path, device_id: &str) -> Option<u32> {
    let out = exec_adb(
        adb,
        &["-s", device_id, "shell", "getprop", "ro.build.version.sdk"],
        8000,
    )
    .await
    .ok()?;
    out.stdout.trim().parse().ok()
}

async fn forward_on(app: &AppHandle, device_id: &str) -> Result<MirrorSession, AdbError> {
    // 先校验在投屏 + 幂等（已在转音频则直接返回当前会话）。短临界区，无 await。
    {
        let map = registry().lock().map_err(|_| not_running())?;
        match map.get(device_id) {
            None => return Err(not_running()),
            Some(active) if active.audio.is_some() => return Ok(active.session.clone()),
            _ => {}
        }
    }

    let scrcpy_path = scrcpy::resolve_scrcpy_path(app).ok_or_else(|| {
        AdbError::custom(
            "MIRROR_SCRCPY_NOT_FOUND",
            "未找到内置 scrcpy。".to_string(),
            "请重新安装应用，或运行 npm run prepare:scrcpy 准备投屏组件。",
            "scrcpy binary not found".to_string(),
        )
    })?;
    let adb_path = binary::resolve_adb_path(app);
    let api_level = match adb_path.as_deref() {
        Some(adb) => query_api_level(adb, device_id).await,
        None => None,
    };

    let (args, mode) = scrcpy::build_audio_args(device_id, api_level);
    let (mut child, stderr_buf) = spawn_scrcpy(&scrcpy_path, adb_path.as_deref(), &args)?;

    // 探测窗口内退出 = 音频启动失败：视频主画面不受影响，仅报错让前端把勾选回弹。
    if timeout(Duration::from_millis(PROBE_MS), child.wait()).await.is_ok() {
        sleep(Duration::from_millis(50)).await;
        let err = stderr_buf.lock().map(|g| g.clone()).unwrap_or_default();
        return Err(AdbError::custom(
            "MIRROR_AUDIO_FAILED",
            format!("把声音转到电脑失败：{}", describe_mirror_failure(&err)),
            "可稍后重试；视频投屏不受影响。",
            err.trim().to_string(),
        ));
    }

    // 音频进程退出监听：崩溃静默（不改会话状态），收到 stop 信号则 kill。
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        tokio::select! {
            _ = child.wait() => {}
            _ = stop_rx => { let _ = child.kill().await; let _ = child.wait().await; }
        }
    });

    // 装载音频句柄 + 回写会话。短临界区，无 await。
    let mut map = registry().lock().map_err(|_| not_running())?;
    match map.get_mut(device_id) {
        Some(active) => {
            if let Some(old) = active.audio.take() {
                let _ = old.stop_tx.send(()); // 替换旧音频进程（理论不该有，防御）
            }
            active.audio = Some(AudioHandle { stop_tx });
            active.session.audio_forwarded = true;
            active.session.audio_mode = Some(mode.to_string());
            let session = active.session.clone();
            drop(map);
            emit_status(app, &session);
            Ok(session)
        }
        None => {
            // 投屏在起音频期间被停掉 → 回收刚起的音频进程，报错。
            let _ = stop_tx.send(());
            Err(not_running())
        }
    }
}

fn forward_off(app: &AppHandle, device_id: &str) -> Result<MirrorSession, AdbError> {
    let mut map = registry().lock().map_err(|_| not_running())?;
    match map.get_mut(device_id) {
        Some(active) => {
            if let Some(audio) = active.audio.take() {
                let _ = audio.stop_tx.send(());
            }
            active.session.audio_forwarded = false;
            active.session.audio_mode = None;
            let session = active.session.clone();
            drop(map);
            emit_status(app, &session);
            Ok(session)
        }
        None => Err(not_running()),
    }
}
