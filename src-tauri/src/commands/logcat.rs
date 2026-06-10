//! Logcat 命令层（T4-4）：start/stop 薄封装到 adb::logcat_stream。命令名 = 渲染层方法名 snake_case。
//!
//! `min_level` 前端恒传 'V'（抓取恒 `*:V`，等级仅作前端显示筛选），后端忽略——切换等级无需重采集、不漏低级别日志。
//! `package_name`/`pid` 用于「相关日志」预过滤（见 logcat_stream）。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::adb::binary;
use crate::adb::error::{classify_adb_error, AdbError};
use crate::adb::logcat_parser::{format_entry, LogEntry, LogcatParser};
use crate::adb::logcat_stream::{self, filter_entry, resolve_pids};
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
#[tauri::command(rename_all = "camelCase")]
pub async fn start_logcat(
    app: AppHandle,
    device_id: String,
    #[allow(unused_variables)] min_level: Option<String>,
    package_name: Option<String>,
    pid: Option<String>,
) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    // 空串视作未指定（前端未填 package/pid 时可能传空）。
    let package = package_name.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    let pid_num = pid.and_then(|s| s.trim().parse::<i64>().ok());

    match logcat_stream::start(&app, &adb, &device_id, package, pid_num).await {
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
    let path = match save_dialog(&app, "导出日志", &format!("logs-{}.log", now_ms())).await {
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
        return json!({ "success": false, "error": "没有完整日志，请先开启日志抓取" });
    }
    let path = match save_dialog(&app, "导出完整日志", &format!("full-logs-{}.log", now_ms())).await {
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

/// 按包名导出完整日志子集：在落盘完整日志上用「相关日志」口径（pidof 当前 pid + 文本提包名）过滤，
/// 不重新采集。多行堆栈整条保留。
#[tauri::command(rename_all = "camelCase")]
pub async fn export_full_logs_by_package(app: AppHandle, device_id: String, package_name: String) -> Value {
    let pkg = package_name.trim().to_string();
    if pkg.is_empty() {
        return json!({ "success": false, "error": "请先填写要导出的包名" });
    }
    full_log_recorder::flush_device(&device_id);
    let src = full_log_recorder::log_path(&device_id);
    if !src.exists() {
        return json!({ "success": false, "error": "没有完整日志，请先开启日志抓取" });
    }
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    // 导出时一次性解析目标包当前 pid（不重启 logcat）；与实时相关过滤同口径。
    let pids = resolve_pids(&adb, &device_id, &pkg).await;

    let path = match save_dialog(&app, "按包名导出完整日志", &format!("full-logs-{pkg}-{}.log", now_ms())).await {
        Some(p) => p,
        None => return json!({ "success": true, "data": null }),
    };

    let device = device_id.clone();
    let filtered = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        let content = std::fs::read_to_string(&src)?;
        let mut parser = LogcatParser::new(&device);
        let mut out = String::new();
        let mut keep = |entry: Option<LogEntry>| {
            if let Some(e) = entry.and_then(|e| filter_entry(e, Some(pkg.as_str()), &pids)) {
                out.push_str(&format_entry(&e));
                out.push('\n');
            }
        };
        for line in content.lines() {
            keep(parser.push_line(line));
        }
        keep(parser.flush());
        Ok(out)
    })
    .await;

    let text = match filtered {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return export_err("读取完整日志失败", e.to_string()),
        Err(e) => return export_err("过滤任务执行失败", e.to_string()),
    };
    match tokio::fs::write(&path, text).await {
        Ok(()) => json!({ "success": true, "data": path }),
        Err(e) => export_err("写入日志文件失败", e.to_string()),
    }
}
