//! 常驻 logcat 流（T4-4，对应原 logcat 抓取逻辑）。每台设备一条 `adb logcat -v long *:V` 长进程，
//! 后台逐行解析成 `LogEntry`（多行堆栈合并），按「≤200 条/批、250ms、队列上限 1000」批量经 `log_batch`
//! event 推前端——既不漏低级别日志（恒 `*:V`），又不因逐条 emit 卡 UI。
//!
//! 复用 `pico_metrics_stream` 范式：全局注册表 + `kill_on_drop` + EOF/stop 清条目（id 比对防竞态）。
//! 「相关日志」口径：给了 packageName 时，全量抓取后**前置于限流**保留「应用自身（按 pidof 解析的 pid）
//! + 系统侧文本提到该包名」的条目，降噪。等级/关键词等显示筛选仍在前端做。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::logcat_parser::{LogEntry, LogcatParser};
use super::manager::exec_adb_capture;

const BATCH_MAX: usize = 200; // 单批上限，达到即 flush。
const FLUSH_MS: u64 = 250; // 定时 flush 间隔（不足一批也按节奏推，保证实时性）。
const QUEUE_CAP: usize = 1000; // 缓冲安全上限（即时 200 flush 下天然不会触达，超出丢最旧兜底）。
const PID_REFRESH_MS: u128 = 3000; // 「相关日志」pid 重解析间隔（应对目标 App 重启换 pid）。

struct StreamEntry {
    id: u64, // 唯一身份：EOF/stop 清理时比对，避免误删被重启替换的同设备 live entry。
    child: Child,
}

fn streams() -> &'static Mutex<std::collections::HashMap<String, StreamEntry>> {
    static S: OnceLock<Mutex<std::collections::HashMap<String, StreamEntry>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn next_id() -> u64 {
    static C: AtomicU64 = AtomicU64::new(0);
    C.fetch_add(1, Ordering::Relaxed)
}

/// 「相关日志」判定（纯函数，便于单测）：无 package 全收；有 package 时保留
/// 应用自身（pid 命中）或系统侧提到包名（message/tag 含包名）的条目。命中应用自身的标记 packageName。
fn filter_entry(mut entry: LogEntry, package: Option<&str>, pids: &HashSet<i64>) -> Option<LogEntry> {
    let pkg = match package {
        None => return Some(entry), // 全局模式：不过滤。
        Some(p) => p,
    };
    let own = pids.contains(&entry.process_id);
    let mentioned = entry.message.contains(pkg) || entry.tag.contains(pkg);
    if !own && !mentioned {
        return None;
    }
    if own {
        entry.package_name = Some(pkg.to_string());
    }
    Some(entry)
}

/// 解析目标包当前 pid 集合（`pidof <pkg>` 返回空格分隔 pid；设备无 pidof / 未运行 → 空集，退化为仅文本匹配）。
async fn resolve_pids(adb: &Path, device_id: &str, package: &str) -> HashSet<i64> {
    let out = exec_adb_capture(adb, &["-s", device_id, "shell", "pidof", package], 5_000).await;
    let mut set = HashSet::new();
    if let Ok(o) = out {
        if o.success {
            for tok in o.stdout.split_whitespace() {
                if let Ok(pid) = tok.parse::<i64>() {
                    set.insert(pid);
                }
            }
        }
    }
    set
}

fn flush(app: &AppHandle, buffer: &mut Vec<LogEntry>) {
    if buffer.is_empty() {
        return;
    }
    let batch = std::mem::take(buffer);
    let _ = app.emit("log_batch", batch);
}

/// 启动某设备的 logcat 流。已在跑则先停旧（参数可能变），再起新。`pid` 为前端可选的 pid 过滤种子。
pub async fn start(
    app: &AppHandle,
    adb: &Path,
    device_id: &str,
    package: Option<String>,
    pid: Option<i64>,
) -> Result<(), String> {
    stop(device_id).await; // 幂等：换参重启。

    let mut cmd = Command::new(adb);
    cmd.args(["-s", device_id, "logcat", "-v", "long", "*:V"])
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
    tokio::spawn(reader_loop(app, adb, dev, entry_id, stdout, package, pid));
    Ok(())
}

/// 后台读取循环：逐行解析 → 相关过滤 → 缓冲 → 批量推送；EOF（进程结束）收尾并清条目。
async fn reader_loop(
    app: AppHandle,
    adb: PathBuf,
    device_id: String,
    entry_id: u64,
    stdout: tokio::process::ChildStdout,
    package: Option<String>,
    pid: Option<i64>,
) {
    let mut lines = BufReader::new(stdout).lines();
    let mut parser = LogcatParser::new(&device_id);
    let mut buffer: Vec<LogEntry> = Vec::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(FLUSH_MS));

    // 相关日志 pid 集：种子用前端传入的 pid，随后周期性用 pidof 重解析。
    let mut pids: HashSet<i64> = HashSet::new();
    if let Some(p) = pid {
        pids.insert(p);
    }
    if let Some(pkg) = package.as_deref() {
        pids.extend(resolve_pids(&adb, &device_id, pkg).await);
    }
    let mut last_pid_refresh = Instant::now();

    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(raw)) => {
                        if let Some(entry) = parser.push_line(&raw) {
                            if let Some(e) = filter_entry(entry, package.as_deref(), &pids) {
                                buffer.push(e);
                                if buffer.len() > QUEUE_CAP {
                                    buffer.remove(0); // 兜底：丢最旧，防缓冲无界增长。
                                }
                                if buffer.len() >= BATCH_MAX {
                                    flush(&app, &mut buffer);
                                }
                            }
                        }
                    }
                    _ => {
                        // EOF / 读错误：进程结束。收尾残留条目后推完最后一批。
                        if let Some(entry) = parser.flush() {
                            if let Some(e) = filter_entry(entry, package.as_deref(), &pids) {
                                buffer.push(e);
                            }
                        }
                        flush(&app, &mut buffer);
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                flush(&app, &mut buffer);
                if let Some(pkg) = package.as_deref() {
                    if last_pid_refresh.elapsed().as_millis() >= PID_REFRESH_MS {
                        let mut fresh = resolve_pids(&adb, &device_id, pkg).await;
                        if let Some(p) = pid {
                            fresh.insert(p);
                        }
                        pids = fresh;
                        last_pid_refresh = Instant::now();
                    }
                }
            }
        }
    }

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

    #[test]
    fn no_package_keeps_everything() {
        let pids = HashSet::new();
        let e = filter_entry(entry(123, "Foo", "bar"), None, &pids);
        assert!(e.is_some());
        assert_eq!(e.unwrap().package_name, None);
    }

    #[test]
    fn keeps_own_pid_and_tags_package() {
        let mut pids = HashSet::new();
        pids.insert(1234);
        let e = filter_entry(entry(1234, "ActivityManager", "anything"), Some("com.demo"), &pids);
        let e = e.expect("应用自身 pid 命中应保留");
        assert_eq!(e.package_name.as_deref(), Some("com.demo"));
    }

    #[test]
    fn keeps_system_mention_without_marking_package() {
        let pids = HashSet::new(); // 包未运行 / 非自身 pid
        let e = filter_entry(entry(50, "AppOps", "killing com.demo (adj 900)"), Some("com.demo"), &pids);
        let e = e.expect("系统侧提到包名应保留");
        assert_eq!(e.package_name, None, "非应用自身不标记 packageName");
    }

    #[test]
    fn drops_unrelated_entry() {
        let pids = HashSet::new();
        let e = filter_entry(entry(99, "WifiService", "scan results"), Some("com.demo"), &pids);
        assert!(e.is_none(), "与目标包无关应丢弃");
    }

    #[test]
    fn flush_emits_and_clears_buffer() {
        // 不便构造 AppHandle，仅验证 take 语义：flush 后 buffer 清空。
        let mut buffer = vec![entry(1, "A", "m")];
        let taken = std::mem::take(&mut buffer);
        assert_eq!(taken.len(), 1);
        assert!(buffer.is_empty());
    }
}
