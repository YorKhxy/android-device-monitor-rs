//! 持续分段录制编排（对应原 captureRecorder.ts 的 PerformanceCaptureRecorder 多段循环 + 生命周期）。
//!
//! 设备端 `screenrecord` 单段最长 180s（AOSP 硬编码），到点自动结束。为支持「点开始 → 点关闭」
//! 的不限时长录制，把一次采集拆成多段 ≤180s 的 mp4：任一时刻设备端只一个 screenrecord 在录，
//! 当前段退出后才 spawn 下一段；重叠的是「已完成段的 adb pull」与「下一段录制」。每段 pull 落盘后
//! 经 mpsc 上报（实时落盘，运行时根目录，非 userData）；中途崩溃最多丢「正在录、未 pull 回」的一段。
//! 单段的 spawn/探测/pull/停止信号见 capture_segment。
//!
//! 注：start/stop/is_recording 的消费方是 T2.6 采集控制器；在其落地前本模块整体未被调用。
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use tokio::task::JoinHandle;

use super::capture_segment::{
    assert_segment_alive, pull_segment, remote_path, signal_screenrecord_stop, spawn_segment,
    RecorderEvent, RecorderSender, SpawnedSegment, FIRST_SEGMENT_PROBE_MS,
};
use super::error::AdbError;

const DEFAULT_BIT_RATE_MBPS: u32 = 8;

pub struct StartCaptureInput {
    pub device_id: String,
    /// 分段视频落盘目录（绝对路径，由会话存储提供）。
    pub video_dir: PathBuf,
    pub bit_rate_mbps: Option<u32>,
    pub events: RecorderSender,
}

struct ActiveCapture {
    adb: PathBuf,
    stop_requested: Arc<AtomicBool>,
    pull_jobs: Arc<Mutex<Vec<JoinHandle<()>>>>,
    loop_handle: JoinHandle<()>,
}

fn active() -> &'static Mutex<HashMap<String, ActiveCapture>> {
    static A: OnceLock<Mutex<HashMap<String, ActiveCapture>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn is_recording(device_id: &str) -> bool {
    active()
        .lock()
        .map(|m| m.contains_key(device_id))
        .unwrap_or(false)
}

fn normalize_bit_rate(mbps: Option<u32>) -> u32 {
    mbps.unwrap_or(DEFAULT_BIT_RATE_MBPS).clamp(2, 20)
}

#[allow(clippy::too_many_arguments)]
async fn run_loop(
    adb: PathBuf,
    device_id: String,
    video_dir: PathBuf,
    bit_rate: u32,
    first: SpawnedSegment,
    events: RecorderSender,
    stop_requested: Arc<AtomicBool>,
    started_at: Instant,
    total_bytes: Arc<AtomicU64>,
    pull_jobs: Arc<Mutex<Vec<JoinHandle<()>>>>,
) {
    let mut index: u32 = 0;
    let mut segment = Some(first);
    let mut segment_start_ms: u64 = 0;

    while let Some(mut seg) = segment {
        let _ = seg.child.wait().await; // 等当前段录完（到点或被 stop SIGINT finalize）
        let segment_end_ms = started_at.elapsed().as_millis() as u64;
        let finished_index = index;
        let finished_remote = remote_path(&device_id, finished_index);

        // 先把下一段录起来（与已完成段 pull 重叠，缩短接缝）；已请求 stop 则不再开新段。
        index += 1;
        let mut next: Option<SpawnedSegment> = None;
        if !stop_requested.load(Ordering::SeqCst) {
            match spawn_segment(&adb, &device_id, &remote_path(&device_id, index), bit_rate).await {
                Ok(s) => {
                    // 二次检查：spawn 期间若 stop 触发，pkill 已广播，这段已被终结，补发一次 finalize。
                    if stop_requested.load(Ordering::SeqCst) {
                        signal_screenrecord_stop(&adb, &device_id).await;
                    }
                    next = Some(s);
                }
                Err(e) => {
                    let _ = events.send(RecorderEvent::Error(e.message));
                }
            }
        }

        let job = tokio::spawn(pull_segment(
            adb.clone(),
            device_id.clone(),
            finished_index,
            finished_remote,
            segment_start_ms,
            segment_end_ms,
            video_dir.clone(),
            total_bytes.clone(),
            events.clone(),
        ));
        if let Ok(mut jobs) = pull_jobs.lock() {
            jobs.push(job);
        }

        segment = next;
        segment_start_ms = segment_end_ms;
    }
}

/// 启动持续分段录制。等首段确认能录后返回；录制循环后台运行直到 stop。
/// 设备已在录制 → Err；首段瞬间失败 → Err（不留残状态）。
pub async fn start(adb: &Path, input: StartCaptureInput) -> Result<(), AdbError> {
    if is_recording(&input.device_id) {
        return Err(AdbError::custom(
            "ADB_COMMAND_FAILED",
            "当前设备已有采集录制正在进行。".to_string(),
            "请先停止当前采集，再开始新的采集。",
            "already recording".to_string(),
        ));
    }

    tokio::fs::create_dir_all(&input.video_dir).await.map_err(|e| {
        AdbError::custom(
            "ADB_COMMAND_FAILED",
            format!("创建录制目录失败：{e}"),
            "检查运行时根目录的写权限。",
            e.to_string(),
        )
    })?;

    let bit_rate = normalize_bit_rate(input.bit_rate_mbps);
    let started_at = Instant::now();

    // 首段 + 探测：瞬间失败则直接 Err，不写入 active（净行为同原版「插入后失败再删除」）。
    let mut first =
        spawn_segment(adb, &input.device_id, &remote_path(&input.device_id, 0), bit_rate).await?;
    assert_segment_alive(&mut first, FIRST_SEGMENT_PROBE_MS).await?;

    let stop_requested = Arc::new(AtomicBool::new(false));
    let total_bytes = Arc::new(AtomicU64::new(0));
    let pull_jobs: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));

    let loop_handle = tokio::spawn(run_loop(
        adb.to_path_buf(),
        input.device_id.clone(),
        input.video_dir.clone(),
        bit_rate,
        first,
        input.events,
        stop_requested.clone(),
        started_at,
        total_bytes.clone(),
        pull_jobs.clone(),
    ));

    if let Ok(mut map) = active().lock() {
        map.insert(
            input.device_id.clone(),
            ActiveCapture {
                adb: adb.to_path_buf(),
                stop_requested,
                pull_jobs,
                loop_handle,
            },
        );
    }
    Ok(())
}

/// 停止录制：SIGINT 让设备端 finalize 当前段，等循环收尾与所有 pull 完成。已移除注册表项即幂等返回。
pub async fn stop(device_id: &str) {
    let state = active().lock().ok().and_then(|mut m| m.remove(device_id));
    let state = match state {
        Some(s) => s,
        None => return,
    };
    state.stop_requested.store(true, Ordering::SeqCst);
    signal_screenrecord_stop(&state.adb, device_id).await;
    let _ = state.loop_handle.await;
    let jobs = state
        .pull_jobs
        .lock()
        .map(|mut j| std::mem::take(&mut *j))
        .unwrap_or_default();
    for j in jobs {
        let _ = j.await;
    }
}

/// 停止全部录制（应用退出清理）。
pub async fn stop_all() {
    let ids: Vec<String> = active()
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        stop(&id).await;
    }
}
