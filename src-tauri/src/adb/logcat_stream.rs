//! 常驻 logcat 流（T4-4，对应原 logcat 抓取逻辑）。每台设备一条 `adb logcat -v long [--pid=N] -T <开抓时刻> *:V`
//! 长进程，后台逐行解析成 `LogEntry`（多行堆栈合并），按「≤200 条/批、120ms、队列上限 1000」批量经 `log_batch`
//! event 推前端——既不漏低级别日志（恒 `*:V`），又不因逐条 emit 卡 UI。
//! `-T` 取设备当前时刻，使每次开抓只收「从现在起」的新日志，不回灌设备 ring buffer 里的历史。
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
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::logcat_parser::{format_line, LogEntry, LogcatParser};
use super::manager::exec_adb_capture;
use crate::logging::full_log_recorder;

const BATCH_MAX: usize = 200; // 单批上限，达到即 flush。
const FLUSH_MS: u64 = 120; // 定时 flush 间隔（不足一批也按节奏推，保证实时性）。120ms 让单行延迟更接近 Android
// Studio 的近实时；前端洪流防假死由前端自己的渲染节流(无过滤 300ms)兜底，后端推得更勤只降延迟不增重渲染率。
const QUEUE_CAP: usize = 1000; // 缓冲安全上限（即时 200 flush 下天然不会触达，超出丢最旧兜底）。
const PID_REFRESH_MS: u128 = 2000; // PID→包名缓存刷新间隔（与老工具 logcatPidPackageRefreshIntervalMs 一致）。
// 抓取的缓冲区（对齐 Android Studio 默认覆盖：主/系统/崩溃三缓冲）。不指定时只读默认主缓冲，会漏 crash
// 缓冲里的崩溃、system 缓冲里的系统服务日志。best-effort：设备不支持某缓冲时整体退回默认（见 start 容错）。
pub(crate) const LOGCAT_BUFFERS: &str = "main,system,crash";

// 注：不再做后端「每秒最多 N 条」的丢行限流。老工具 maxLogCallbacksPerSecond 限的是「回调次数」
// （一次回调带一批行），本实现已用 BATCH_MAX/FLUSH_MS 批量 emit + 前端批处理双重节流等效达成。
// 旧的按「日志行数/秒」丢弃会丢掉最新行：logcat 最旧在前，开流历史回灌或高频设备(>1500 行/秒)时，
// 每秒配额被最旧的积压行吃光，最新实时行永远被丢，UI 卡在 ~1500 条老日志不再滚动（本次修复点）。

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
pub(crate) async fn refresh_pid_package_cache(adb: &Path, device_id: &str) -> HashMap<i64, String> {
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

/// 独立任务：周期性 `ps -A` 刷新共享的 PID→包名表，把这次会阻塞的 adb 往返从 reader 循环里彻底剥离。
/// 自终止：每轮先查注册表，本流已被 stop / 被新流替换（id 不再匹配）就退出（与 reader 的 still_ours 同范式）。
fn spawn_pid_refresh(
    adb: PathBuf,
    device_id: String,
    entry_id: u64,
    shared: Arc<Mutex<HashMap<i64, String>>>,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(PID_REFRESH_MS as u64)).await;
            let still_ours = streams()
                .lock()
                .ok()
                .map(|m| m.get(&device_id).map(|e| e.id) == Some(entry_id))
                .unwrap_or(false);
            if !still_ours {
                break;
            }
            let map = refresh_pid_package_cache(&adb, &device_id).await;
            if let Ok(mut g) = shared.lock() {
                *g = map;
            }
        }
    });
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
    pid_pkg: &Mutex<HashMap<i64, String>>,
    buffer: &mut Vec<LogEntry>,
    app: &AppHandle,
    last_emit: &mut Instant,
) {
    // 共享 PID→包名表由独立刷新任务周期更新（见 spawn_pid_refresh）；这里只做一次极短的无竞争锁读，
    // 不再像旧版那样在 reader 循环里 await `ps -A`（那会每 2s 停读、洪流下卡顿）。
    if let Ok(g) = pid_pkg.lock() {
        if let Some(pkg) = g.get(&entry.process_id) {
            entry.package_name = Some(pkg.clone());
        }
    }
    // 完整日志落盘：解析后单行带归属包名列，与老工具 fullLogRecorder.write 同格式（全量、全等级，**逐行不丢**）。
    full_log_recorder::append(device_id, entry_id, &format_line(&entry));
    // 入 UI 缓冲。内存兜底：超 2×QUEUE_CAP 才批量裁到 QUEUE_CAP（摊销 O(1)/条，避免每条 remove(0) 的 O(n) 搬移），
    // 丢最旧、留最新——完整日志已落盘，UI 不追求全量。
    buffer.push(entry);
    if buffer.len() > QUEUE_CAP * 2 {
        let excess = buffer.len() - QUEUE_CAP;
        buffer.drain(0..excess);
    }
    // UI 推送**限频**：攒够一批且距上次 emit ≥ FLUSH_MS 才推。否则启动重型应用瞬间 4 万行/秒会变成每秒数百次
    // emit，把前端冲垮卡死（看起来就像"抓取被打断"）。限频后洪流下也只 ~每 250ms 推一批 ≤2×QUEUE_CAP 条最新。
    if buffer.len() >= BATCH_MAX && last_emit.elapsed() >= Duration::from_millis(FLUSH_MS) {
        flush(app, buffer);
        *last_emit = Instant::now();
    }
}

/// 启动某设备的 logcat 流。已在跑则先停旧（参数可能变），再起新。
/// `pid`：前端显式填的数字 PID → adb `--pid=`（采集端限制，与老工具 sourcePid 同）；不填则全量抓。
/// `include_history`：true=连上回放设备 ring buffer 历史（对齐 Android Studio：不带 `-T`，logcat 先吐当前缓冲
/// 全部、再续接实时）；false=加 `-T <开抓时刻>` 只收新日志、不回灌历史。
/// `history_tail`：仅 include_history=true 生效。None=全量回放（默认，对齐 AS）；Some(n)=`-T n` 只回最近 n 行——
/// 「可配上限」兜底，高频洪流设备(Pico)可调小，避免一次性回放几十万行的首屏灌入过猛。
/// `is_restart`：断流自动重连续抓时为 true → 完整日志追加不清空（保留断流前内容）；用户开抓为 false → truncate。
///
/// 注：返回**显式装箱的 Future** 而非 `async fn`——reader_loop 在异常 EOF 时会回调本函数自动重连，
/// 二者互为 async 递归会让编译器算不出 `async fn` 的 opaque 返回类型(cycle)；显式 `Box<dyn Future>` 打破该环。
#[allow(clippy::type_complexity)]
pub fn start<'a>(
    app: &'a AppHandle,
    adb: &'a Path,
    device_id: &'a str,
    pid: Option<i64>,
    include_history: bool,
    is_restart: bool,
    history_tail: Option<u32>,
    capture_level: char,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
    stop(device_id).await; // 幂等：换参重启。

    // 调大设备 logcat 环形缓冲（默认仅 256KiB，高频设备几分钟就把爆发日志挤没——典型：连接瞬间的
    // MVXRSDK 一会儿就被冲掉、事后捞不到）。16M 让历史留存久得多，按所抓缓冲一并调大。
    // best-effort：失败/不支持不阻断抓取。
    let _ = exec_adb_capture(adb, &["-s", device_id, "logcat", "-b", LOGCAT_BUFFERS, "-G", "16M"], 5_000).await;

    let mut args: Vec<String> = vec![
        "-s".into(),
        device_id.into(),
        "logcat".into(),
        "-b".into(),
        LOGCAT_BUFFERS.into(),
        "-v".into(),
        "long".into(),
    ];
    if let Some(p) = pid {
        args.push(format!("--pid={p}"));
    }
    // 历史回放策略（对齐 Android Studio）：前端「包含历史」开 → 回放设备 ring buffer 再续接实时。
    // 前端环形缓冲(ChunkedLogStore)+ 变高虚拟滚动 + 批量节流已能吸收洪流(渲染成本 O(视口) 非 O(总量))，
    // 故不再像旧版那样硬砍 2000 行。高频设备(Pico)若首屏回放过猛，由 history_tail「可配上限」兜底。
    if include_history {
        match history_tail {
            // 全量回放(默认，对齐 AS)：不加 -T，logcat 先吐当前缓冲全部、再 follow 实时。
            None => {}
            // 可配上限兜底：-T n 只回最近 n 行再续接实时（n=0 退化为全量，避免无效参数）。
            Some(n) if n > 0 => {
                args.push("-T".into());
                args.push(n.to_string());
            }
            Some(_) => {}
        }
    } else {
        // 只收新日志：-T <设备当前时刻>（设备自身时钟，与 logcat 时间戳同源同时区，避免 PC 时钟偏差）；
        // 取时间失败兜底 `-T 1`（只回最近 1 行）。
        let since = exec_adb_capture(adb, &["-s", device_id, "shell", "date '+%m-%d %H:%M:%S.000'"], 5_000)
            .await
            .ok()
            .filter(|o| o.success)
            .map(|o| o.stdout.trim().to_string())
            .filter(|s| !s.is_empty());
        args.push("-T".into());
        args.push(since.unwrap_or_else(|| "1".into()));
    }
    // 抓取级别（默认 V=全抓）：下推到 adb logcat `*:<级别>`，真正减少设备侧发送量（连完整日志落盘也随之变）。
    // 与前端「显示级别」彻底分开：那个只过滤显示、不改抓取/落盘。capture_level 由命令层校验为 V/D/I/W/E/F。
    args.push(format!("*:{capture_level}"));

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
    tokio::spawn(reader_loop(app, adb, dev, entry_id, stdout, pid, is_restart, capture_level));
    Ok(())
    })
}

/// 后台读取循环：逐行解析 → 补归属包名 → 落盘 + 缓冲 → 批量推送；EOF（进程结束）收尾并清条目。
async fn reader_loop(
    app: AppHandle,
    adb: PathBuf,
    device_id: String,
    entry_id: u64,
    stdout: tokio::process::ChildStdout,
    pid: Option<i64>,
    is_restart: bool,
    capture_level: char,
) {
    let mut lines = BufReader::new(stdout).lines();
    let mut parser = LogcatParser::new(&device_id);
    let mut buffer: Vec<LogEntry> = Vec::new();
    let mut last_emit = Instant::now(); // UI emit 限频锚点（push_entry 与 ticker 共用）。
    let mut ticker = tokio::time::interval(Duration::from_millis(FLUSH_MS));

    // 完整日志录制（T4-5）：用户开抓 truncate「从监控第一行」；自动重连(is_restart)追加、保留断流前内容。失败不阻断抓取。
    let _ = full_log_recorder::begin(&device_id, entry_id, is_restart);

    // PID→归属包名缓存：开流先建一次（这一发同步等待可接受），之后由**独立任务**周期刷新——
    // 共享 Arc<Mutex>，reader 只做无竞争锁读，绝不在循环里 await `ps -A`（旧版那样每 2s 停读、洪流下卡顿）。
    let pid_pkg = Arc::new(Mutex::new(refresh_pid_package_cache(&adb, &device_id).await));
    spawn_pid_refresh(adb.clone(), device_id.clone(), entry_id, pid_pkg.clone());
    let mut lines_read: u64 = 0; // 读到的行数：EOF 时据此判断是否自动重连（读 0 行就 EOF 视为设备断开，不重连防死循环）。

    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(raw)) => {
                        lines_read += 1;
                        if let Some(entry) = parser.push_line(&raw) {
                            push_entry(&device_id, entry_id, entry, &pid_pkg, &mut buffer, &app, &mut last_emit);
                        }
                    }
                    _ => {
                        // EOF / 读错误：进程结束。收尾残留条目后推完最后一批。
                        if let Some(entry) = parser.flush() {
                            push_entry(&device_id, entry_id, entry, &pid_pkg, &mut buffer, &app, &mut last_emit);
                        }
                        flush(&app, &mut buffer);
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                flush(&app, &mut buffer);
                last_emit = Instant::now(); // 与 push_entry 限频共用锚点：低频时由 ticker 及时推、不丢实时性。
                full_log_recorder::flush(&device_id, entry_id); // 定时刷盘，保证导出拿到最新。
                // PID→包名刷新已挪到 spawn_pid_refresh 独立任务，这里不再 await `ps -A`。
            }
        }
    }

    // 完整日志录制收尾（id 比对，drop BufWriter 自动 flush）。
    full_log_recorder::end(&device_id, entry_id);

    // 「本条流是否仍在册」：在册 = 非用户 stop、也没被新流替换 → 属于异常 EOF（多半是启动重型应用的洪流背压
    // 或 WiFi 抖动把流压断）。此时若确实抓到过日志，则自动重连续抓——否则采集就这么默默死了、UI 不再增长。
    let still_ours = streams()
        .lock()
        .ok()
        .map(|m| m.get(&device_id).map(|e| e.id) == Some(entry_id))
        .unwrap_or(false);

    if still_ours && lines_read > 0 {
        // 自动重连：延迟一下再起（避让洪流峰值），只收新日志(include_history=false，不重灌历史)、
        // 完整日志追加(is_restart=true，不清空)。重连前复检在册条目，避开「这段时间内用户点了停止」的竞态。
        // 读 0 行就 EOF（设备断开/不可达）不走这里 → 不会无限重连。
        let app2 = app.clone();
        let adb2 = adb.clone();
        let dev2 = device_id.clone();
        let stale_id = entry_id;
        // 注意：本条在册条目暂不移除（其 child 已死），留作竞态复检锚点；重连的 start() 会先 stop() 清掉它再注册新流。
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            let user_stopped = streams()
                .lock()
                .ok()
                .map(|m| m.get(&dev2).map(|e| e.id) != Some(stale_id))
                .unwrap_or(true);
            if !user_stopped {
                // 重连只收新日志(include_history=false)，history_tail 无意义传 None；沿用同一抓取级别。
                let _ = start(&app2, &adb2, &dev2, pid, false, true, None, capture_level).await;
            }
        });
    } else if let Ok(mut map) = streams().lock() {
        // 用户主动停止 / 已被新流替换 / 设备断开 → 清掉在册条目（仅当仍是本条）。
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
