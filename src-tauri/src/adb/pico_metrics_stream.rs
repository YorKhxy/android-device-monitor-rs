//! 常驻 PxrMetric 流（对应原 picoMetricsStream.ts）。
//! 每台 Pico 设备一条 `adb logcat -T 1 -v time -s PxrMetric` 长进程，后台持续吃最新行、
//! 只缓存「最近一行 + 时间戳」。采样时只读缓存（无每拍 spawn——最省电、最稳，且天然不存在
//! 「-d 全量 dump 超 buffer/timeout」的每拍失败面）。空闲看门狗自动回收。

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::pico_metrics::ensure_metrics_hub_started;

const IDLE_TIMEOUT_MS: u128 = 15000; // 超此时长无人读取（采集停止/设备断开）→ 回收常驻进程，省电。
const SWEEP_INTERVAL_MS: u64 = 5000;

/// 单条流缓存的最新行 + 写入时刻（由后台读取任务更新，采样侧只读）。
type LatestSlot = Arc<Mutex<Option<(String, Instant)>>>;

struct StreamEntry {
    id: u64, // 唯一身份：reader EOF 清理时比对，避免误删被重启替换的同设备 live entry。
    latest: LatestSlot,
    last_read_at: Instant,
    started_at: Instant,
    child: Child,
}

fn streams() -> &'static Mutex<HashMap<String, StreamEntry>> {
    static S: OnceLock<Mutex<HashMap<String, StreamEntry>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_stream_id() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// 幂等启动：已在跑直接返回；否则 spawn 常驻 logcat。并发下用「spawn 后再持锁复检」消除重复。
pub async fn ensure_streaming(adb: &Path, device_id: &str) {
    if let Ok(map) = streams().lock() {
        if map.contains_key(device_id) {
            return;
        }
    }
    start_stream(adb, device_id).await;
}

async fn start_stream(adb: &Path, device_id: &str) {
    // hub streaming 必须开着才有数据；失败忽略，继续尝试读流。
    ensure_metrics_hub_started(adb, device_id).await;

    let mut cmd = Command::new(adb);
    cmd.args([
        "-s", device_id, "logcat", "-T", "1", "-v", "time", "-s", "PxrMetric",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .kill_on_drop(true); // 兜底：任何 drop 路径都终止子进程，杜绝孤儿 logcat。
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return,
    };
    let stdout = child.stdout.take();
    let latest: LatestSlot = Arc::new(Mutex::new(None));
    let now = Instant::now();
    let entry_id = next_stream_id();

    // 持锁复检：若并发已插入则把本次 spawn 的子进程传出锁外杀掉，避免双开。
    // 注意：std MutexGuard 不是 Send，绝不能跨 await 持有——故 kill 放在释放锁之后。
    let raced_child = {
        let mut map = match streams().lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        if map.contains_key(device_id) {
            Some(child)
        } else {
            map.insert(
                device_id.to_string(),
                StreamEntry {
                    id: entry_id,
                    latest: latest.clone(),
                    last_read_at: now,
                    started_at: now,
                    child,
                },
            );
            None
        }
    };
    if let Some(mut child) = raced_child {
        let _ = child.kill().await;
        return;
    }
    ensure_sweep();

    // 后台读取任务：逐行吃 stdout，只认 PxrMetric 行，更新缓存。stdout 关闭即进程结束 → 清条目。
    if let Some(stdout) = stdout {
        let dev = device_id.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(raw)) = lines.next_line().await {
                let line = raw.trim_end_matches(['\r', '\n']).to_string();
                if line.contains("PxrMetric") {
                    if let Ok(mut slot) = latest.lock() {
                        *slot = Some((line, Instant::now()));
                    }
                }
            }
            // EOF：进程结束 → 清条目，但仅当注册表里仍是「本条」流（id 比对），
            // 避免误删已被 stop/看门狗回收后又重启的同设备 live entry（M-1 竞态保护）。
            if let Ok(mut map) = streams().lock() {
                if map.get(&dev).map(|e| e.id) == Some(entry_id) {
                    map.remove(&dev);
                }
            }
        });
    }
}

/// 返回 max_age_ms 内的最新行；陈旧或没有则 None。读取即刷新 last_read_at（喂活看门狗）。
pub fn get_fresh_line(device_id: &str, max_age_ms: u128) -> Option<String> {
    let mut map = streams().lock().ok()?;
    let entry = map.get_mut(device_id)?;
    entry.last_read_at = Instant::now();
    let slot = entry.latest.lock().ok()?;
    let (line, at) = slot.as_ref()?;
    if at.elapsed().as_millis() > max_age_ms {
        return None;
    }
    Some(line.clone())
}

/// 预热期：流已起、还没收到任何 PxrMetric 行、且启动未超过 warmup_ms。
pub fn is_warming_up(device_id: &str, warmup_ms: u128) -> bool {
    let map = match streams().lock() {
        Ok(m) => m,
        Err(_) => return false,
    };
    match map.get(device_id) {
        Some(e) => {
            let no_line = e.latest.lock().map(|s| s.is_none()).unwrap_or(true);
            no_line && e.started_at.elapsed().as_millis() < warmup_ms
        }
        None => false,
    }
}

/// 停止某设备的常驻流（断开设备 / 空闲回收时调用）。
pub async fn stop(device_id: &str) {
    let entry = streams().lock().ok().and_then(|mut m| m.remove(device_id));
    if let Some(mut e) = entry {
        let _ = e.child.kill().await;
    }
}

/// 停止全部常驻流（应用退出清理）。
pub async fn stop_all() {
    let ids: Vec<String> = streams()
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        stop(&id).await;
    }
}

/// 启动一次空闲看门狗（首条流建立时触发，单实例常驻）。
fn ensure_sweep() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(SWEEP_INTERVAL_MS)).await;
                let idle: Vec<String> = match streams().lock() {
                    Ok(m) => m
                        .iter()
                        .filter(|(_, e)| e.last_read_at.elapsed().as_millis() > IDLE_TIMEOUT_MS)
                        .map(|(k, _)| k.clone())
                        .collect(),
                    Err(_) => Vec::new(),
                };
                for id in idle {
                    stop(&id).await;
                }
            }
        });
    });
}
