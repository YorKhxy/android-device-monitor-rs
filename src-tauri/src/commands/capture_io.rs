//! 采集会话导入/导出命令（T2.8）：xlsx 报告导出、会话 zip 导出、导入文件选择、批量导入。
//! 对应原 index.ts 的 EXPORT_PERFORMANCE_SESSION / EXPORT_CAPTURE_SESSION /
//! SELECT_IMPORT_FILES / IMPORT_CAPTURE_SESSIONS。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::adb::error::AdbError;
use crate::performance::{capture_store, capture_transfer, session_export};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn export_err(message: &str, details: String) -> Value {
    AdbError::custom("EXPORT_ERROR", message.to_string(), "请重试，或更换保存位置。", details).to_result()
}

/// 弹保存对话框，返回选择的绝对路径（取消 → None）。
async fn save_dialog(
    app: &AppHandle,
    title: &str,
    file_name: &str,
    filter_name: &str,
    exts: &[&str],
) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(filter_name, exts)
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// 弹多选打开对话框（.zip 过滤），返回路径数组（取消 → 空）。
async fn pick_zip_files(app: &AppHandle) -> Vec<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导入采集会话")
        .add_filter("采集会话压缩包", &["zip"])
        .pick_files(move |p| {
            let _ = tx.send(p);
        });
    rx.await
        .ok()
        .flatten()
        .map(|paths| {
            paths
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// 导出性能采集报告为 xlsx（payload 由前端构造）。取消 → success:false。
#[tauri::command(rename_all = "camelCase")]
pub async fn export_performance_session(app: AppHandle, payload: Value) -> Value {
    let bytes = match session_export::build_workbook_bytes(&payload) {
        Ok(b) => b,
        Err(e) => return e.to_result(),
    };
    let file_name = format!("performance-session-{}.xlsx", now_ms());
    let path = match save_dialog(&app, "导出性能采集报告", &file_name, "Excel 文件", &["xlsx"]).await {
        Some(p) => p,
        None => return json!({ "success": false, "error": "取消导出" }),
    };
    match tokio::fs::write(&path, bytes).await {
        Ok(()) => json!({ "success": true, "data": path }),
        Err(e) => export_err("写入 Excel 文件失败", e.to_string()),
    }
}

/// 导出采集会话为 zip（顶层目录 = sessionId）。取消 → data:null。
#[tauri::command(rename_all = "camelCase")]
pub async fn export_capture_session(app: AppHandle, session_id: String) -> Value {
    let session_dir = match capture_store::session_dir(&session_id) {
        Ok(d) => d,
        Err(e) => return e.to_result(),
    };
    let default_session_id = capture_store::get_session(&session_id)
        .await
        .ok()
        .map(|session| session.id)
        .filter(|id| !id.is_empty() && !id.contains('/') && !id.contains('\\'))
        .unwrap_or_else(|| session_id.clone());
    let path = match save_dialog(&app, "导出采集会话", &format!("{default_session_id}.zip"), "采集会话压缩包", &["zip"]).await {
        Some(p) => p,
        None => return json!({ "success": true, "data": null }),
    };
    let dest = PathBuf::from(&path);
    match tokio::task::spawn_blocking(move || capture_transfer::zip_session_dir(&session_dir, &dest)).await {
        Ok(Ok(())) => json!({ "success": true, "data": path }),
        Ok(Err(msg)) => export_err("导出采集会话失败", msg),
        Err(e) => export_err("导出任务执行失败", e.to_string()),
    }
}

/// 弹文件选择对话框选要导入的 zip。
#[tauri::command]
pub async fn select_import_files(app: AppHandle) -> Value {
    json!({ "success": true, "data": pick_zip_files(&app).await })
}

/// 批量导入：逐个处理 zip / 会话文件夹，单个失败不影响其余，收集结果与错误（对齐原 CaptureImportResult）。
#[tauri::command(rename_all = "camelCase")]
pub async fn import_capture_sessions(paths: Vec<String>) -> Value {
    let mut imported: Vec<Value> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for p in paths {
        let path = PathBuf::from(&p);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&p)
            .to_string();
        match tokio::fs::metadata(&path).await {
            Ok(m) if m.is_dir() => match capture_transfer::import_from_directory(&path).await {
                Ok(s) => imported.push(json!(s)),
                Err(e) => errors.push(format!("{name}：{}", e.message)),
            },
            Ok(_) if p.to_lowercase().ends_with(".zip") => {
                // zip 解压同步 → spawn_blocking；定位到会话目录后异步导入；guard drop 时清理临时目录。
                let zip_path = path.clone();
                match tokio::task::spawn_blocking(move || capture_transfer::extract_and_locate(&zip_path)).await {
                    Ok(Ok((guard, session_dir))) => {
                        match capture_transfer::import_from_directory(&session_dir).await {
                            Ok(s) => imported.push(json!(s)),
                            Err(e) => errors.push(format!("{name}：{}", e.message)),
                        }
                        drop(guard);
                    }
                    Ok(Err(msg)) => errors.push(format!("{name}：{msg}")),
                    Err(e) => errors.push(format!("{name}：{e}")),
                }
            }
            Ok(_) => errors.push(format!("{name}：仅支持 .zip 或采集会话文件夹")),
            Err(e) => errors.push(format!("{name}：{e}")),
        }
    }

    json!({ "success": true, "data": { "imported": imported, "errors": errors } })
}
