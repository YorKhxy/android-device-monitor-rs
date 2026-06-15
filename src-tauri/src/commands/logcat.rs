//! Logcat 命令层（T4-4）：start/stop 薄封装到 adb::logcat_stream。命令名 = 渲染层方法名 snake_case。
//!
//! `min_level` 前端恒传 'V'（抓取恒 `*:V`，等级仅作前端显示筛选），后端忽略——切换等级无需重采集、不漏低级别日志。
//! `package_name`/`pid` 用于「相关日志」预过滤（见 logcat_stream）。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::adb::binary;
use crate::adb::error::{classify_adb_error, AdbError};
use crate::adb::logcat_parser::{format_entry, format_line, LogEntry, LogcatParser};
use crate::adb::logcat_stream;
use crate::adb::manager::exec_adb_capture;
use crate::logging::full_log_recorder;

fn adb_not_found() -> Value {
    classify_adb_error("enoent", &[]).to_result()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn export_err(message: &str, details: String) -> Value {
    AdbError::custom("EXPORT_ERROR", message.to_string(), "请重试，或更换保存位置。", details).to_result()
}

/// 弹保存对话框（.log/.txt），返回选择的绝对路径（取消 → None）。
async fn save_dialog(app: &AppHandle, title: &str, file_name: &str) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter("日志文件", &["log", "txt"])
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// 启动设备 logcat 流式抓取。成功返回 { success: true }，进度经 `log_batch` event 推送。
///
/// 与老工具逐字节对齐：**采集端全量抓取，绝不按包名丢弃**（`package_name` 仅作前端显示筛选与
/// 「按包名导出」，故此处忽略）——否则 SDK/独立进程日志（tag、正文都不含目标包名）会被降噪，前端搜不到
/// （典型：搜 mvxrsdk 搜不到）。仅显式数字 PID 才走 adb `--pid=` 锁进程（与老工具 sourcePid 同）。
#[tauri::command(rename_all = "camelCase")]
pub async fn start_logcat(
    app: AppHandle,
    device_id: String,
    #[allow(unused_variables)] min_level: Option<String>,
    #[allow(unused_variables)] package_name: Option<String>,
    pid: Option<String>,
    // 是否带设备当前缓冲里的历史（默认 true，捞得到连接瞬间已打的 MVXRSDK 等爆发日志）；
    // 前端「包含历史」开关关掉时传 false → 只收开抓后的新日志。
    include_history: Option<bool>,
) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let pid_num = pid.and_then(|s| s.trim().parse::<i64>().ok());

    match logcat_stream::start(&app, &adb, &device_id, pid_num, include_history.unwrap_or(true), false).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// 停止设备 logcat 流。
#[tauri::command(rename_all = "camelCase")]
pub async fn stop_logcat(device_id: String) -> Value {
    logcat_stream::stop(&device_id).await;
    json!({ "success": true })
}

/// 导出前端传入的（可见/筛选后）日志为文本文件。取消 → data:null；无日志 → 错误。
#[tauri::command(rename_all = "camelCase")]
pub async fn export_logs(app: AppHandle, logs: Vec<LogEntry>) -> Value {
    if logs.is_empty() {
        return json!({ "success": false, "error": "没有可导出的日志" });
    }
    let path = match save_dialog(&app, "导出日志", &format!("android-logs-{}.log", now_ms())).await {
        Some(p) => p,
        None => return json!({ "success": true, "data": null }),
    };
    let text = logs.iter().map(format_entry).collect::<Vec<_>>().join("\n");
    match tokio::fs::write(&path, text).await {
        Ok(()) => json!({ "success": true, "data": path }),
        Err(e) => export_err("写入日志文件失败", e.to_string()),
    }
}

/// 导出完整原始日志：另存该设备 device-logs/ 落盘文件（监控起至今、全等级、不受 2 万上限/筛选）。
#[tauri::command(rename_all = "camelCase")]
pub async fn export_full_logs(app: AppHandle, device_id: String) -> Value {
    full_log_recorder::flush_device(&device_id); // 先刷盘拿最新。
    let src = full_log_recorder::log_path(&device_id);
    if !src.exists() {
        return json!({ "success": false, "error": "没有可导出的完整日志，请先开始日志采集" });
    }
    let path = match save_dialog(&app, "导出完整日志", &format!("android-full-logs-{}.log", now_ms())).await {
        Some(p) => p,
        None => return json!({ "success": true, "data": null }),
    };
    let dest = PathBuf::from(&path);
    match tokio::task::spawn_blocking(move || std::fs::copy(&src, &dest)).await {
        Ok(Ok(_)) => json!({ "success": true, "data": path }),
        Ok(Err(e)) => export_err("导出完整日志失败", e.to_string()),
        Err(e) => export_err("导出任务执行失败", e.to_string()),
    }
}

/// 文件名安全包名：与老工具一致，`[^a-zA-Z0-9._-]` 一律换 `_`。
fn sanitize_package_for_filename(pkg: &str) -> String {
    pkg.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect()
}

/// 在落盘完整日志的**原始行**上做关联匹配（与老工具 `exportByPackage` 同口径）：按头行正则切分记录，
/// 整条记录任意行（小写）含 `needle` 即整条保留，多行堆栈不拆。返回 `(过滤后文本, 命中记录数)`。
/// `needle` 必须已是小写（调用方传入前 `to_lowercase`）。
fn filter_full_log_by_needle(content: &str, needle: &str) -> (String, usize) {
    // 条目头行的时间戳前缀（落盘 formatLine 写出的格式），把多行堆栈续行归并到同一条记录。
    let head_re = Regex::new(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} ").expect("entry head regex");
    let mut out = String::new();
    let mut record: Vec<&str> = Vec::new();
    let mut keep = false;
    let mut matched = 0usize;
    let flush = |record: &mut Vec<&str>, keep: &mut bool, out: &mut String, matched: &mut usize| {
        if !record.is_empty() && *keep {
            out.push_str(&record.join("\n"));
            out.push('\n');
            *matched += 1;
        }
        record.clear();
        *keep = false;
    };
    for line in content.lines() {
        if head_re.is_match(line) {
            flush(&mut record, &mut keep, &mut out, &mut matched); // 新记录开始，先结算上一条。
            record.push(line);
            keep = line.to_lowercase().contains(needle);
        } else {
            // 续行（多行堆栈等）：归并到当前记录，命中也算整条命中。
            record.push(line);
            if !keep && line.to_lowercase().contains(needle) {
                keep = true;
            }
        }
    }
    flush(&mut record, &mut keep, &mut out, &mut matched);
    (out, matched)
}

/// 按包名导出完整日志子集（与老工具 `fullLogRecorder.exportByPackage` 逐字节对齐）：不重新采集，
/// 直接在落盘完整日志的**原始行**上做关联匹配——按头行正则 `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} `
/// 切分记录，整条记录任意行（小写）含包名即整条保留，多行堆栈不拆；0 命中删空文件并提示。
#[tauri::command(rename_all = "camelCase")]
pub async fn export_full_logs_by_package(app: AppHandle, device_id: String, package_name: String) -> Value {
    let pkg = package_name.trim().to_string();
    if pkg.is_empty() {
        return json!({ "success": false, "error": "请先在「应用/包名」里填写要导出的包名" });
    }
    full_log_recorder::flush_device(&device_id);
    let src = full_log_recorder::log_path(&device_id);
    if !src.exists() {
        return json!({ "success": false, "error": "没有可导出的完整日志，请先开始日志采集" });
    }

    let safe_pkg = sanitize_package_for_filename(&pkg);
    let path = match save_dialog(&app, "按包名导出完整日志", &format!("android-full-logs-{safe_pkg}-{}.log", now_ms())).await {
        Some(p) => p,
        None => return json!({ "success": true, "data": null }),
    };

    let needle = pkg.to_lowercase();
    let filtered = tokio::task::spawn_blocking(move || -> std::io::Result<(String, usize)> {
        let content = std::fs::read_to_string(&src)?;
        Ok(filter_full_log_by_needle(&content, &needle))
    })
    .await;

    let (text, matched) = match filtered {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return export_err("读取完整日志失败", e.to_string()),
        Err(e) => return export_err("过滤任务执行失败", e.to_string()),
    };
    if matched == 0 {
        // 0 命中：不落空文件（与老工具「删空文件」终态一致），提示无匹配。
        return json!({ "success": false, "error": format!("「{pkg}」没有匹配到任何完整日志") });
    }
    match tokio::fs::write(&path, text).await {
        Ok(()) => json!({ "success": true, "data": path }),
        Err(e) => export_err("写入日志文件失败", e.to_string()),
    }
}

/// 一次性导出设备**当前 logcat 缓冲（含开抓前的历史）**。与实时抓取互补：实时抓取用 `-T` 只收开抓
/// 那一刻起的新日志（不回灌历史），而此命令用 `logcat -d` 全量 dump 设备 ring buffer 现存的全部行
/// （全等级 `*:V`、含历史），供事后排查「打开监控之前就已发生」的日志（如先崩溃后才开监控）。
/// 输出为原始 `-v long` 文本，不经解析/筛选，与实时面板的格式一致。
#[tauri::command(rename_all = "camelCase")]
pub async fn export_device_log_buffer(app: AppHandle, device_id: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    // 先 dump（捕获「点击那一刻」的缓冲，不受后续保存对话框耗时影响）。-d 立即返回，给足超时即可。
    let captured = exec_adb_capture(&adb, &["-s", &device_id, "logcat", "-d", "-v", "long", "*:V"], 30_000).await;
    let raw = match captured {
        Ok(c) if c.success => c.stdout,
        Ok(c) => {
            let detail = if c.stderr.trim().is_empty() { "adb logcat -d 非零退出".to_string() } else { c.stderr };
            return export_err("读取设备日志缓冲失败", detail);
        }
        Err(e) => return e.to_result(),
    };
    if raw.trim().is_empty() {
        return json!({ "success": false, "error": "设备日志缓冲为空" });
    }

    // 与实时落盘录制同一套口径：解析 `-v long` → LogEntry → 补 PID 归属包名 → `format_line` 输出，
    // 使本文件与「导出完整日志」逐字节同格式（`时间 设备id 包名|- pid/tid 级别/TAG: 正文`，多行堆栈整条续行）。
    // 历史条目的 pid 可能已被回收，包名补全为当前 ps 快照的尽力而为（与录制端同限制）。
    let pid_pkg = logcat_stream::refresh_pid_package_cache(&adb, &device_id).await;
    let device_id_for_parse = device_id.clone();
    let formatted = tokio::task::spawn_blocking(move || {
        let mut parser = LogcatParser::new(&device_id_for_parse);
        let mut entries: Vec<LogEntry> = Vec::new();
        for line in raw.lines() {
            if let Some(e) = parser.push_line(line) {
                entries.push(e);
            }
        }
        if let Some(e) = parser.flush() {
            entries.push(e);
        }
        let mut out = String::new();
        for mut e in entries {
            if let Some(pkg) = pid_pkg.get(&e.process_id) {
                e.package_name = Some(pkg.clone());
            }
            out.push_str(&format_line(&e));
            out.push('\n');
        }
        out
    })
    .await;
    let text = match formatted {
        Ok(t) => t,
        Err(e) => return export_err("解析日志缓冲失败", e.to_string()),
    };
    if text.trim().is_empty() {
        return json!({ "success": false, "error": "设备日志缓冲为空" });
    }

    let path = match save_dialog(&app, "导出设备完整日志缓冲", &format!("android-device-buffer-{}.log", now_ms())).await {
        Some(p) => p,
        None => return json!({ "success": true, "data": null }),
    };
    match tokio::fs::write(&path, text).await {
        Ok(()) => json!({ "success": true, "data": path }),
        Err(e) => export_err("写入日志文件失败", e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_package_matches_legacy_regex() {
        // 与老工具 pkg.replace(/[^a-zA-Z0-9._-]/g, '_') 一致。
        assert_eq!(sanitize_package_for_filename("com.demo.app"), "com.demo.app");
        assert_eq!(sanitize_package_for_filename("com.a_b-c.123"), "com.a_b-c.123");
        assert_eq!(sanitize_package_for_filename("com.x:proc"), "com.x_proc");
        assert_eq!(sanitize_package_for_filename("a b/c\\d"), "a_b_c_d");
    }

    /// 落盘行（formatLine 格式，带归属包名列）。多行堆栈续行不带头时间戳。
    const SAMPLE: &str = "\
2026-06-12 16:06:00.123 dev1 com.mvxrsdk.demo 100/200 I/Foo: hello mvxrsdk
2026-06-12 16:06:00.456 dev1 - 300/400 E/AndroidRuntime: FATAL EXCEPTION: main
\tat com.mvxrsdk.Engine.tick(Engine.java:42)
\tat com.other.Baz.qux(Baz.java:7)
2026-06-12 16:06:01.000 dev1 com.other.app 500/600 D/Bar: unrelated line";

    #[test]
    fn keeps_whole_record_when_any_line_matches() {
        // 第二条记录头行不含包名（归属列为 -、TAG/正文也不含），但堆栈续行含 com.mvxrsdk → 整条保留。
        let (out, matched) = filter_full_log_by_needle(SAMPLE, "com.mvxrsdk");
        assert_eq!(matched, 2, "命中两条（第一条头行命中 + 第二条堆栈续行命中）");
        // 第二条整条保留，多行堆栈不拆。
        assert!(out.contains("FATAL EXCEPTION: main"));
        assert!(out.contains("Engine.java:42"));
        assert!(out.contains("Baz.java:7"));
        // 不相关的第三条不保留。
        assert!(!out.contains("unrelated line"));
        // 每条记录以换行结尾。
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn match_is_case_insensitive() {
        let (_, matched) = filter_full_log_by_needle(SAMPLE, "com.mvxrsdk"); // needle 已小写
        let (_, matched_upper_src) = filter_full_log_by_needle(
            "2026-06-12 16:06:00.123 dev1 COM.MVXRSDK.DEMO 100/200 I/Foo: HELLO",
            "com.mvxrsdk",
        );
        assert_eq!(matched, 2);
        assert_eq!(matched_upper_src, 1, "源行大写也应被小写 needle 命中");
    }

    #[test]
    fn zero_match_yields_empty_output() {
        let (out, matched) = filter_full_log_by_needle(SAMPLE, "com.nonexistent");
        assert_eq!(matched, 0);
        assert!(out.is_empty());
    }
}
