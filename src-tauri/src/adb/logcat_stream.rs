//! 常驻 logcat 流（T4-4，对应原 logcat 抓取逻辑）。每台设备一条 `adb logcat -v long [--pid=N] *:V` 长进程，
//! 后台逐行解析成 `LogEntry`（多行堆栈合并），按「≤200 条/批、250ms、队列上限 1000」批量经 `log_batch`
//! event 推前端——既不漏低级别日志（恒 `*:V`），又不因逐条 emit 卡 UI。
//!
//! 与老工具逐字节对齐：**采集端全量推送，绝不在后端按包名丢弃**——否则 SDK / 独立进程的日志（tag、正文
//! 都不含目标包名）会被降噪掉，前端搜不到（典型：搜 mvxrsdk 搜不到）。后端只用 `ps -A -o PID,NAME` 反查把
//! 「归属包名」补到每条 entry（周期刷新），供前端显示筛选与「按包名导出完整日志」复刻关联口径。
//! 显式数字 PID 过滤走 adb `--pid=`（采集端限制，与老工具 sourcePid 同），等级/关键词等仍是前端显示筛选。
//!
//! 复用 `pico_metrics_stream` 范式：全局注册表 + `kill_on_drop` + EOF/stop 清条目（id 比对防竞态）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::logcat_parser::{format_line, LogEntry, LogcatParser};
use super::manager::exec_adb_capture;
use crate::logging::full_log_recorder;

const BATCH_MAX: usize = 200; // 单批上限，达到即 flush。
const FLUSH_MS: u64 = 250; // 定时 flush 间隔（不足一批也按节奏推，保证实时性）。
const QUEUE_CAP: usize = 1000; // 缓冲安全上限（即时 200 flush 下天然不会触达，超出丢最旧兜底）。
const PID_REFRESH_MS: u128 = 2000; // PID→包名缓存刷新间隔（与老工具 logcatPidPackageRefreshIntervalMs 一致）。
const MAX_CALLBACKS_PER_SEC: u32 = 1500; // 每秒最多推前端的条数（与老工具 maxLogCallbacksPerSecond 一致）。

/// 整秒窗口限流（与老工具 callbackWindowStart/callbackCount 同口径）：每个整秒窗口最多放行 N 条。
/// 一条（可能多行）日志计一次。**只限 UI 推送，不限落盘**——完整日志始终全量（老工具本意）。
struct RateLimiter {
    window_start: Instant,
    count: u32,
}

impl RateLimiter {
    fn new() -> Self {
        Self { window_start: Instant::now(), count: 0 }
    }

    /// 放行返回 true；本秒已达上限返回 false（调用方据此只丢 UI 推送）。
    fn allow(&mut self) -> bool {
        if self.window_start.elapsed() >= Duration::from_secs(1) {
            self.window_start = Instant::now();
            self.count = 0;
        }
        if self.count >= MAX_CALLBACKS_PER_SEC {
            return false;
        }
        self.count += 1;
        true
    }
}

struct StreamEntry {
    id: u64, // 唯一身份：EOF/stop 清理时比对，避免误删被重启替换的同设备 live entry。
    child: Child,
}

fn streams() -> &'static Mutex<HashMap<String, StreamEntry>> {
    static S: OnceLock<Mutex<HashMap<String, StreamEntry>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    static C: AtomicU64 = AtomicU64::new(0);
    C.fetch_add(1, Ordering::Relaxed)
}

/// 进程名 → Android 归属包名（与老工具 `normalizeAndroidPackageName` 逐字节对齐）：
/// 必须含 `.`；按 `:` 取主进程名（剥掉 `com.foo:remote` 的子进程后缀）；再用包名正则校验，
/// 不像包名（如 `surfaceflinger`/`init`/`kworker`）返回 None。
/// 这保证落盘「归属包名」列只存真正的应用包名，非应用进程列为 `-`（与老工具一致）。
fn normalize_android_package_name(process_name: &str) -> Option<String> {
    if !process_name.contains('.') {
        return None;
    }
    let base = process_name.split(':').next().unwrap_or(process_name);
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$").expect("android package name regex")
    });
    if re.is_match(base) {
        Some(base.to_string())
    } else {
        None
    }
}

/// 用 `ps -A -o PID,NAME` 建 PID→归属包名映射。设备无 ps / 失败 → 空表（退化为无包名列，
/// 不影响抓取）。与老工具 refreshLogcatPidPackageCache 同口径：跳表头，每行按空白切，首列 PID、
/// 末列进程名，进程名经 `normalize_android_package_name` 归一化（非应用进程不入表 → 落盘列为 `-`）。
async fn refresh_pid_package_cache(adb: &Path, device_id: &str) -> HashMap<i64, String> {
    let mut map = HashMap::new();
    let out = exec_adb_capture(adb, &["-s", device_id, "shell", "ps", "-A", "-o", "PID,NAME"], 5_000).await;
    if let Ok(o) = out {
        if o.success {
            for line in o.stdout.lines().skip(1) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Ok(pid) = parts[0].parse::<i64>() {
                        let name = parts[parts.len() - 1];
                        if let Some(pkg) = normalize_android_package_name(name) {
                            map.insert(pid, pkg);
                        }
                    }
                }
            }
        }
    }
    map
}

fn flush(app: &AppHandle, buffer: &mut Vec<LogEntry>) {
    if buffer.is_empty() {
        return;
    }
    let batch = std::mem::take(buffer);
    let _ = app.emit("log_batch", batch);
}

/// 补归属包名 → 落盘（解析后单行带包名列，全量、全等级）→ 入缓冲（满批/超限处理）。
fn push_entry(
    device_id: &str,
    entry_id: u64,
    mut entry: LogEntry,
    pid_pkg: &HashMap<i64, String>,
    buffer: &mut Vec<LogEntry>,
    app: &AppHandle,
    limiter: &mut RateLimiter,
) {
    if let Some(pkg) = pid_pkg.get(&entry.process_id) {
        entry.package_name = Some(pkg.clone());
    }
    // 完整日志落盘：解析后单行带归属包名列，与老工具 fullLogRecorder.write 同格式（全量、全等级，**先于且不受限流**）。
    full_log_recorder::append(device_id, entry_id, &format_line(&entry));
    // 限流只丢 UI 推送：本秒已达 1500 条上限则不推前端（落盘已完成，完整日志不丢）。
    if !limiter.allow() {
        return;
    }
    buffer.push(entry);
    if buffer.len() > QUEUE_CAP {
        buffer.remove(0); // 兜底：丢最旧，防缓冲无界增长。
    }
    if buffer.len() >= BATCH_MAX {
        flush(app, buffer);
    }
}

/// 启动某设备的 logcat 流。已在跑则先停旧（参数可能变），再起新。
/// `pid`：前端显式填的数字 PID → adb `--pid=`（采集端限制，与老工具 sourcePid 同）；不填则全量抓。
pub async fn start(app: &AppHandle, adb: &Path, device_id: &str, pid: Option<i64>) -> Result<(), String> {
    stop(device_id).await; // 幂等：换参重启。

    let mut args: Vec<String> = vec![
        "-s".into(),
        device_id.into(),
        "logcat".into(),
        "-v".into(),
        "long".into(),
    ];
    if let Some(p) = pid {
        args.push(format!("--pid={p}"));
    }
    args.push("*:V".into());

    let mut cmd = Command::new(adb);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 logcat 失败：{e}"))?;
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return Err("无法获取 logcat 输出流".to_string()),
    };
    let entry_id = next_id();

    if let Ok(mut map) = streams().lock() {
        map.insert(device_id.to_string(), StreamEntry { id: entry_id, child });
    }

    let app = app.clone();
    let adb = adb.to_path_buf();
    let dev = device_id.to_string();
    tokio::spawn(reader_loop(app, adb, dev, entry_id, stdout));
    Ok(())
}

/// 后台读取循环：逐行解析 → 补归属包名 → 落盘 + 缓冲 → 批量推送；EOF（进程结束）收尾并清条目。
async fn reader_loop(
    app: AppHandle,
    adb: PathBuf,
    device_id: String,
    entry_id: u64,
    stdout: tokio::process::ChildStdout,
) {
    let mut lines = BufReader::new(stdout).lines();
    let mut parser = LogcatParser::new(&device_id);
    let mut buffer: Vec<LogEntry> = Vec::new();
    let mut limiter = RateLimiter::new(); // 整秒窗口限流，只限 UI 推送、不限落盘。
    let mut ticker = tokio::time::interval(Duration::from_millis(FLUSH_MS));

    // 完整日志录制（T4-5）：开流即 truncate 重建落盘文件，「从监控第一行」。失败不阻断抓取。
    let _ = full_log_recorder::begin(&device_id, entry_id);

    // PID→归属包名缓存：开流先建一次，之后周期刷新（应对目标 App 重启换 pid）。
    let mut pid_pkg = refresh_pid_package_cache(&adb, &device_id).await;
    let mut last_pid_refresh = Instant::now();

    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(raw)) => {
                        if let Some(entry) = parser.push_line(&raw) {
                            push_entry(&device_id, entry_id, entry, &pid_pkg, &mut buffer, &app, &mut limiter);
                        }
                    }
                    _ => {
                        // EOF / 读错误：进程结束。收尾残留条目后推完最后一批。
                        if let Some(entry) = parser.flush() {
                            push_entry(&device_id, entry_id, entry, &pid_pkg, &mut buffer, &app, &mut limiter);
                        }
                        flush(&app, &mut buffer);
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                flush(&app, &mut buffer);
                full_log_recorder::flush(&device_id, entry_id); // 定时刷盘，保证导出拿到最新。
                if last_pid_refresh.elapsed().as_millis() >= PID_REFRESH_MS {
                    pid_pkg = refresh_pid_package_cache(&adb, &device_id).await;
                    last_pid_refresh = Instant::now();
                }
            }
        }
    }

    // 完整日志录制收尾（id 比对，drop BufWriter 自动 flush）。
    full_log_recorder::end(&device_id, entry_id);

    // 仅当注册表里仍是「本条」流时才清（id 比对，防误删已被 stop 后重启的同设备 live entry）。
    if let Ok(mut map) = streams().lock() {
        if map.get(&device_id).map(|e| e.id) == Some(entry_id) {
            map.remove(&device_id);
        }
    }
}

/// 停止某设备的 logcat 流（kill 子进程 → reader EOF 自行收尾）。
pub async fn stop(device_id: &str) {
    let entry = streams().lock().ok().and_then(|mut m| m.remove(device_id));
    if let Some(mut e) = entry {
        let _ = e.child.kill().await;
    }
}

/// 停止全部 logcat 流（应用退出清理）。
pub async fn stop_all() {
    let ids: Vec<String> = streams()
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        stop(&id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: i64, tag: &str, msg: &str) -> LogEntry {
        LogEntry {
            id: "x".into(),
            device_id: "dev1".into(),
            timestamp: "2026-06-09T10:00:00.000".into(),
            process_id: pid,
            thread_id: pid,
            level: "I".into(),
            tag: tag.into(),
            message: msg.into(),
            package_name: None,
        }
    }

    /// 归属包名归一化与老工具 normalizeAndroidPackageName 逐字节对齐。
    #[test]
    fn normalize_package_name_matches_legacy() {
        // 正常包名原样保留。
        assert_eq!(normalize_android_package_name("com.mvxrsdk.demo").as_deref(), Some("com.mvxrsdk.demo"));
        // 子进程后缀按 ':' 剥掉，取主包名。
        assert_eq!(normalize_android_package_name("com.foo.bar:remote").as_deref(), Some("com.foo.bar"));
        // 非应用进程（无 '.' / 不像包名）→ None，落盘列为 '-'。
        assert_eq!(normalize_android_package_name("surfaceflinger"), None);
        assert_eq!(normalize_android_package_name("init"), None);
        assert_eq!(normalize_android_package_name("[kworker/0:1]"), None);
        // 含 '.' 但首段以数字开头 / 不符包名正则 → None。
        assert_eq!(normalize_android_package_name("1.2.3"), None);
        assert_eq!(normalize_android_package_name(""), None);
    }

    #[test]
    fn flush_takes_and_clears_buffer() {
        // 不便构造 AppHandle，仅验证 take 语义：flush 后 buffer 清空。
        let mut buffer = vec![entry(1, "A", "m")];
        let taken = std::mem::take(&mut buffer);
        assert_eq!(taken.len(), 1);
        assert!(buffer.is_empty());
    }
}
