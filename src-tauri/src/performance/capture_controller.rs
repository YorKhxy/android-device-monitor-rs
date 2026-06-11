//! 采集编排（对应原 performanceCaptureController.ts）。点「开始采集」即同时启动性能采样循环与持续分段录制：
//!   - 采样每秒一次 get_performance_metrics → 流式 append_sample 落盘 → emit capture_sample（实时曲线）；
//!   - 录制由 capture_recorder 负责，分段经 mpsc 上报 → append_segment + 累计体积；
//!   - 软上限：录制达 30 分钟或视频累计 2GB（先到先触发）emit 一次 capture_size_limit，不强制停止；
//!   - 点「关闭采集」停采样 + 停录制 + finalize 会话。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::unbounded_channel;
use tokio::task::JoinHandle;

use crate::adb::binary::resolve_adb_path;
use crate::adb::capture_recorder::{self, RecordBackend, StartCaptureInput};
use crate::adb::capture_segment::RecorderEvent;
use crate::adb::error::{classify_adb_error, AdbError};
use crate::adb::manager::exec_adb;
use crate::adb::scrcpy;
use crate::adb::{performance_dispatch, pico_metrics, runtime_inspector};

/// 含音录制要求的最低 API level（Android 13）：scrcpy --audio-dup「设备与电脑同时出声」需此版本。
const MIN_AUDIO_API_LEVEL: u32 = 33;

/// 查设备 API level（ro.build.version.sdk）；失败返回 None（→ 视为不支持含音录制，降级无声）。
async fn query_api_level(adb: &std::path::Path, device_id: &str) -> Option<u32> {
    let out = exec_adb(adb, &["-s", device_id, "shell", "getprop", "ro.build.version.sdk"], 8000)
        .await
        .ok()?;
    out.stdout.trim().parse().ok()
}

use super::capture_store;
use super::types::{CaptureSession, CreateSessionInput, FinalizeSessionInput};

const SAMPLE_INTERVAL_MS: u64 = 1000;
const SOFT_LIMIT_DURATION_MS: i64 = 30 * 60 * 1000;
const SOFT_LIMIT_SIZE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

struct ActiveSession {
    session_id: String,
    device_id: String,
    session: CaptureSession,
    started_at_ms: i64,
    stop_flag: Arc<AtomicBool>,
    tick_handle: JoinHandle<()>,
    consumer_handle: JoinHandle<()>,
}

fn active() -> &'static Mutex<HashMap<String, ActiveSession>> {
    static A: OnceLock<Mutex<HashMap<String, ActiveSession>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn err(message: impl Into<String>, hint: &str) -> AdbError {
    AdbError::custom("CAPTURE_CONTROLLER_ERROR", message.into(), hint, "capture controller".into())
}

pub fn is_active(device_id: &str) -> bool {
    active().lock().map(|m| m.contains_key(device_id)).unwrap_or(false)
}

/// 进行中的采集快照（供渲染层重载/崩溃后对齐采集状态）。对齐 shared/types 的 ActiveCaptureSession[]。
pub fn get_active_sessions() -> Vec<Value> {
    let now = now_ms();
    active()
        .lock()
        .map(|m| {
            m.values()
                .map(|s| {
                    json!({
                        "deviceId": s.device_id,
                        "session": s.session,
                        "elapsedMs": now - s.started_at_ms,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 软上限检查：未提醒过且（时长≥30min 或 体积≥2GB）则 emit 一次 capture_size_limit。
fn check_soft_limit(
    app: &AppHandle,
    device_id: &str,
    session_id: &str,
    started_at_ms: i64,
    total: &AtomicU64,
    notified: &AtomicBool,
) {
    if notified.load(Ordering::SeqCst) {
        return;
    }
    let duration_ms = now_ms() - started_at_ms;
    let size_bytes = total.load(Ordering::SeqCst);
    let reason = if duration_ms >= SOFT_LIMIT_DURATION_MS {
        "duration"
    } else if size_bytes >= SOFT_LIMIT_SIZE_BYTES {
        "size"
    } else {
        return;
    };
    // compare_exchange 保证只 emit 一次（tick 与录制消费者两处都会调用）。
    if notified
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let _ = app.emit(
            "capture_size_limit",
            json!({
                "deviceId": device_id,
                "sessionId": session_id,
                "reason": reason,
                "durationMs": duration_ms,
                "sizeBytes": size_bytes,
            }),
        );
    }
}

/// 开始采集：建会话 → 启动录制（失败则 finalize failed 并返回）→ 启动每秒采样 tick → 登记 active。
/// record_audio：用户开「录制设备声音」时为 true，且设备 A13+ 时走 scrcpy 含音录制，否则降级无声 screenrecord。
pub async fn start(app: &AppHandle, device_id: &str, record_audio: bool, bit_rate_mbps: Option<u32>) -> Result<CaptureSession, AdbError> {
    if is_active(device_id) {
        return Err(err("当前设备已在采集中。", "请先关闭当前采集，再开始新的采集。"));
    }
    let adb = match resolve_adb_path(app) {
        Some(p) => p,
        None => return Err(classify_adb_error("enoent", &[])),
    };

    // 录制后端选路：开「录制设备声音」且设备 A13+ 且内置 scrcpy 可用 → scrcpy 含音录制，否则降级无声。
    let (backend, audio_recorded) = if record_audio {
        let api = query_api_level(&adb, device_id).await;
        match (api, scrcpy::resolve_scrcpy_path(app)) {
            (Some(v), Some(scrcpy_path)) if v >= MIN_AUDIO_API_LEVEL => {
                (RecordBackend::ScrcpyAudio { scrcpy: scrcpy_path }, true)
            }
            _ => (RecordBackend::Screenrecord, false),
        }
    } else {
        (RecordBackend::Screenrecord, false)
    };

    // 先取一次指标拿前台应用写进会话元数据（失败不阻塞开始）。
    let foreground = runtime_inspector::get_foreground_app_context_cached(&adb, device_id).await;
    let initial = performance_dispatch::get_performance_metrics(&adb, device_id, &foreground, false)
        .await
        .ok();
    let (package_name, activity_name) = match &initial {
        Some(m) => (m.package_name.clone(), m.activity_name.clone()),
        None => (foreground.package_name.clone(), foreground.activity_name.clone()),
    };
    let provider = if pico_metrics::is_pico_device(&adb, device_id).await {
        "pico-screenrecord"
    } else {
        "android-screenrecord"
    };

    let session = capture_store::create_session(CreateSessionInput {
        device_id: device_id.to_string(),
        device_sn: device_id.to_string(),
        provider: provider.to_string(),
        // Pico screenrecord 录的是双眼原图，单眼靠播放时裁切——录制端从不产出单眼文件，恒 false。
        single_eye_video: Some(false),
        audio_recorded,
        package_name,
        activity_name,
    })
    .await?;
    let session_id = session.id.clone();
    let started_at_ms = now_ms();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let total_video_bytes = Arc::new(AtomicU64::new(0));
    let soft_limit_notified = Arc::new(AtomicBool::new(false));

    // 录制事件消费者：分段落盘进 manifest，体积更新 + 软上限检查，错误记录。
    let (tx, mut rx) = unbounded_channel::<RecorderEvent>();
    let consumer_handle = {
        let app = app.clone();
        let sid = session_id.clone();
        let dev = device_id.to_string();
        let total = total_video_bytes.clone();
        let notified = soft_limit_notified.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                match ev {
                    RecorderEvent::Segment(seg) => {
                        if let Err(e) = capture_store::append_segment(&sid, seg).await {
                            eprintln!("capture: append_segment failed: {}", e.message);
                        }
                    }
                    RecorderEvent::SizeBytes(bytes) => {
                        total.store(bytes, Ordering::SeqCst);
                        check_soft_limit(&app, &dev, &sid, started_at_ms, &total, &notified);
                    }
                    RecorderEvent::Error(msg) => eprintln!("capture: recording error: {msg}"),
                }
            }
        })
    };

    // 启动录制：失败则把会话标记 failed 并返回（让上层提示用户）。
    let video = capture_store::video_dir(&session_id)?;
    if let Err(e) = capture_recorder::start(
        &adb,
        StartCaptureInput {
            device_id: device_id.to_string(),
            video_dir: video,
            bit_rate_mbps,
            events: tx,
            backend,
        },
    )
    .await
    {
        let _ = capture_store::finalize_session(
            &session_id,
            FinalizeSessionInput {
                ended_at: now_ms(),
                duration_ms: 0,
                status: "failed".to_string(),
                error: Some(e.message.clone()),
            },
        )
        .await;
        consumer_handle.abort();
        return Err(e);
    }

    // 每秒采样 tick。
    let tick_handle = {
        let app = app.clone();
        let adb = adb.clone();
        let sid = session_id.clone();
        let dev = device_id.to_string();
        let stop = stop_flag.clone();
        let total = total_video_bytes.clone();
        let notified = soft_limit_notified.clone();
        tokio::spawn(async move {
            let mut seq: u64 = 0;
            loop {
                tokio::time::sleep(Duration::from_millis(SAMPLE_INTERVAL_MS)).await;
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let fg = runtime_inspector::get_foreground_app_context_cached(&adb, &dev).await;
                // 单次采样失败（设备瞬时无响应）不终止整次采集，也不写假 0（gap-not-zero）。
                if let Ok(metrics) =
                    performance_dispatch::get_performance_metrics(&adb, &dev, &fg, false).await
                {
                    let captured_at = now_ms();
                    let elapsed = captured_at - started_at_ms;
                    let sample = json!({
                        "id": format!("{sid}-{seq}"),
                        "deviceId": dev,
                        "capturedAt": captured_at,
                        "metrics": metrics,
                    });
                    seq += 1;
                    let _ = capture_store::append_sample(&sid, &sample).await;
                    let _ = app.emit(
                        "capture_sample",
                        json!({
                            "deviceId": dev,
                            "sessionId": sid,
                            "sample": sample,
                            "elapsedMs": elapsed,
                        }),
                    );
                    check_soft_limit(&app, &dev, &sid, started_at_ms, &total, &notified);
                }
            }
        })
    };

    if let Ok(mut map) = active().lock() {
        map.insert(
            device_id.to_string(),
            ActiveSession {
                session_id: session_id.clone(),
                device_id: device_id.to_string(),
                session: session.clone(),
                started_at_ms,
                stop_flag,
                tick_handle,
                consumer_handle,
            },
        );
    }
    Ok(session)
}

/// 关闭采集：停采样 tick + 停录制（finalize 设备端当前段）+ 排空分段事件 + finalize 会话 completed。
pub async fn stop(_app: &AppHandle, device_id: &str) -> Result<CaptureSession, AdbError> {
    let state = active().lock().ok().and_then(|mut m| m.remove(device_id));
    let state = match state {
        Some(s) => s,
        None => return Err(err("当前设备没有进行中的采集。", "请先开始采集。")),
    };

    state.stop_flag.store(true, Ordering::SeqCst);
    state.tick_handle.abort();
    // 停录制：等设备端 finalize 当前段 + 全部 pull 完成 → tx 全部 drop → 消费者 rx 关闭。
    capture_recorder::stop(device_id).await;
    let _ = state.consumer_handle.await; // 排空剩余分段事件后退出

    let ended_at = now_ms();
    let duration_ms = ended_at - state.started_at_ms;
    capture_store::finalize_session(
        &state.session_id,
        FinalizeSessionInput {
            ended_at,
            duration_ms,
            status: "completed".to_string(),
            error: None,
        },
    )
    .await
}

/// 应用退出时停掉所有进行中的采集，避免残留定时器与设备端 screenrecord。
pub async fn stop_all(app: &AppHandle) {
    let ids: Vec<String> = active()
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        let _ = stop(app, &id).await;
    }
}
