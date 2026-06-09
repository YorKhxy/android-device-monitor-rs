//! 持续分段录制编排（对应原 captureRecorder.ts 的 PerformanceCaptureRecorder 多段循环 + 生命周期）。
//!
//! 两条录制后端（T2.10 起）：
//! - Screenrecord（无声，默认）：设备端 `screenrecord` 录到设备临时文件，段完成后 `adb pull` 落本地。
//! - ScrcpyAudio（含音，A13+ 开「录制设备声音」时）：PC 端 scrcpy `--record` 直接录到本地 seg-N.mp4
//!   （视频+音频同一 MP4，无需 pull）；停止走「杀设备端 server 让 client finalize」+ 超时强杀兜底。
//!
//! 设备端 `screenrecord` / scrcpy `--time-limit` 单段最长 180s，到点自动结束。为支持「点开始 → 点关闭」
//! 的不限时长录制，把一次采集拆成多段 ≤180s 的 mp4：任一时刻只一个录制进程在录，当前段退出后才 spawn
//! 下一段；重叠的是「已完成段的 pull/stat 上报」与「下一段录制」。每段落盘后经 mpsc 上报（实时落盘，
//! 运行时根目录，非 userData）；中途崩溃最多丢「正在录、未收尾」的一段。单段 spawn/探测/停止信号见
//! capture_segment。消费方：T2.6 采集控制器（capture_controller）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::capture_segment::{
    assert_segment_alive, finalize_local_segment, pull_segment, remote_path,
    signal_screenrecord_stop, signal_scrcpy_stop, spawn_scrcpy_segment, spawn_segment,
    RecorderEvent, RecorderSender, SpawnedSegment, FIRST_SEGMENT_PROBE_MS,
};
use super::error::AdbError;

const DEFAULT_BIT_RATE_MBPS: u32 = 8;
/// 停止时等录制循环收尾的上限：scrcpy client 收到 server 断开后 finalize mp4 需要点时间；超时则强杀兜底。
const STOP_TIMEOUT_MS: u64 = 15_000;

/// 录制后端：决定单段如何 spawn、段完成如何收尾、停止如何发信号。
#[derive(Clone)]
pub enum RecordBackend {
    /// 设备端 screenrecord（无声）。
    Screenrecord,
    /// PC 端 scrcpy --record（视频+音频），含 bundled scrcpy 路径。
    ScrcpyAudio { scrcpy: PathBuf },
}

impl RecordBackend {
    /// spawn 第 index 段录制进程。
    async fn spawn(
        &self,
        adb: &Path,
        device_id: &str,
        video_dir: &Path,
        index: u32,
        bit_rate: u32,
    ) -> Result<SpawnedSegment, AdbError> {
        match self {
            RecordBackend::Screenrecord => {
                spawn_segment(adb, device_id, &remote_path(device_id, index), bit_rate).await
            }
            RecordBackend::ScrcpyAudio { scrcpy } => {
                let path = video_dir.join(format!("seg-{index}.mp4"));
                spawn_scrcpy_segment(scrcpy, adb, device_id, &path, bit_rate).await
            }
        }
    }

    /// 已完成段的收尾 job：screenrecord 需 pull 设备端文件，scrcpy 直接 stat 本地文件。
    #[allow(clippy::too_many_arguments)]
    fn finalize_job(
        &self,
        adb: PathBuf,
        device_id: String,
        index: u32,
        start_ms: u64,
        end_ms: u64,
        video_dir: PathBuf,
        total: Arc<AtomicU64>,
        events: RecorderSender,
    ) -> JoinHandle<()> {
        match self {
            RecordBackend::Screenrecord => tokio::spawn(pull_segment(
                adb,
                device_id.clone(),
                index,
                remote_path(&device_id, index),
                start_ms,
                end_ms,
                video_dir,
                total,
                events,
            )),
            RecordBackend::ScrcpyAudio { .. } => {
                tokio::spawn(finalize_local_segment(index, start_ms, end_ms, video_dir, total, events))
            }
        }
    }

    /// 停止当前段：让录制进程优雅 finalize 当前 mp4。
    async fn signal_stop(&self, adb: &Path, device_id: &str) {
        match self {
            RecordBackend::Screenrecord => signal_screenrecord_stop(adb, device_id).await,
            RecordBackend::ScrcpyAudio { .. } => signal_scrcpy_stop(adb, device_id).await,
        }
    }
}

pub struct StartCaptureInput {
    pub device_id: String,
    /// 分段视频落盘目录（绝对路径，由会话存储提供）。
    pub video_dir: PathBuf,
    pub bit_rate_mbps: Option<u32>,
    pub events: RecorderSender,
    /// 录制后端：无声 screenrecord 或含音 scrcpy（由采集控制器按开关 + 设备能力决定）。
    pub backend: RecordBackend,
}

struct ActiveCapture {
    adb: PathBuf,
    backend: RecordBackend,
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
    backend: RecordBackend,
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
        let _ = seg.child.wait().await; // 等当前段录完（到点或被 stop finalize）
        let segment_end_ms = started_at.elapsed().as_millis() as u64;
        let finished_index = index;

        // 先把下一段录起来（与已完成段收尾重叠，缩短接缝）；已请求 stop 则不再开新段。
        index += 1;
        let mut next: Option<SpawnedSegment> = None;
        if !stop_requested.load(Ordering::SeqCst) {
            match backend.spawn(&adb, &device_id, &video_dir, index, bit_rate).await {
                Ok(s) => {
                    // 二次检查：spawn 期间若 stop 触发，停止信号已广播，这段已被终结，补发一次。
                    if stop_requested.load(Ordering::SeqCst) {
                        backend.signal_stop(&adb, &device_id).await;
                    }
                    next = Some(s);
                }
                Err(e) => {
                    let _ = events.send(RecorderEvent::Error(e.message));
                }
            }
        }

        let job = backend.finalize_job(
            adb.clone(),
            device_id.clone(),
            finished_index,
            segment_start_ms,
            segment_end_ms,
            video_dir.clone(),
            total_bytes.clone(),
            events.clone(),
        );
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
    let mut first = input
        .backend
        .spawn(adb, &input.device_id, &input.video_dir, 0, bit_rate)
        .await?;
    assert_segment_alive(&mut first, FIRST_SEGMENT_PROBE_MS).await?;

    let stop_requested = Arc::new(AtomicBool::new(false));
    let total_bytes = Arc::new(AtomicU64::new(0));
    let pull_jobs: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));

    let loop_handle = tokio::spawn(run_loop(
        adb.to_path_buf(),
        input.device_id.clone(),
        input.video_dir.clone(),
        bit_rate,
        input.backend.clone(),
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
                backend: input.backend,
                stop_requested,
                pull_jobs,
                loop_handle,
            },
        );
    }
    Ok(())
}

/// 停止录制：发停止信号让当前段 finalize，等循环收尾（带超时强杀兜底）与所有收尾 job 完成。
/// 已移除注册表项即幂等返回。
pub async fn stop(device_id: &str) {
    let state = active().lock().ok().and_then(|mut m| m.remove(device_id));
    let state = match state {
        Some(s) => s,
        None => return,
    };
    state.stop_requested.store(true, Ordering::SeqCst);
    state.backend.signal_stop(&state.adb, device_id).await;

    // 等循环收尾：scrcpy client finalize 可能慢，超时则 abort（kill_on_drop 强杀兜底，最后段可能损坏）。
    let abort = state.loop_handle.abort_handle();
    if timeout(Duration::from_millis(STOP_TIMEOUT_MS), state.loop_handle)
        .await
        .is_err()
    {
        abort.abort();
    }

    let jobs = state
        .pull_jobs
        .lock()
        .map(|mut j| std::mem::take(&mut *j))
        .unwrap_or_default();
    for j in jobs {
        let _ = j.await;
    }
}
