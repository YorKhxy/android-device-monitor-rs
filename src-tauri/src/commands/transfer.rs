//! 文件传输命令层（T4-2）：push/pull 薄封装到 transfer::runner。命令名 = 渲染层方法名 snake_case。
//! pull 目标目录由后端取系统「下载」目录并经 savedDir 回传前端（用于「打开所在文件夹」）。

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::adb::binary;
use crate::adb::error::{classify_adb_error, AdbError};
use crate::transfer::runner::{self, PullItem};

fn adb_not_found() -> Value {
    classify_adb_error("enoent", &[]).to_result()
}

fn download_dir(app: &AppHandle) -> Result<PathBuf, AdbError> {
    app.path().download_dir().map_err(|e| {
        AdbError::custom(
            "TRANSFER_FAILED",
            "无法定位系统下载目录。".to_string(),
            "请检查系统下载目录是否可用。",
            e.to_string(),
        )
    })
}

/// 批量上传：本地多文件 → 设备 remote_dir。返回成功文件数。
#[tauri::command(rename_all = "camelCase")]
pub async fn push_device_file(
    app: AppHandle,
    device_id: String,
    remote_dir: String,
    local_paths: Vec<String>,
    upload_id: String,
) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let n = runner::push_files(&app, &adb, &device_id, &remote_dir, &local_paths, &upload_id).await;
    json!({ "success": true, "data": n })
}

/// 批量下载：设备多文件 → 系统下载目录。返回 { savedDir, succeeded, failed }。
#[tauri::command(rename_all = "camelCase")]
pub async fn pull_device_files(
    app: AppHandle,
    device_id: String,
    items: Vec<PullItem>,
    pull_id: String,
) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let dir = match download_dir(&app) {
        Ok(d) => d,
        Err(e) => return e.to_result(),
    };
    match runner::pull_files(&app, &adb, &device_id, &items, &pull_id, &dir).await {
        Ok(o) => json!({
            "success": true,
            "data": { "savedDir": o.saved_dir, "succeeded": o.succeeded, "failed": o.failed }
        }),
        Err(e) => e.to_result(),
    }
}

/// 单文件下载到系统下载目录，返回保存的本地文件路径。
#[tauri::command(rename_all = "camelCase")]
pub async fn pull_device_file(
    app: AppHandle,
    device_id: String,
    remote_path: String,
    name: String,
    _is_dir: bool,
) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let dir = match download_dir(&app) {
        Ok(d) => d,
        Err(e) => return e.to_result(),
    };
    let items = vec![PullItem { path: remote_path, name: name.clone() }];
    match runner::pull_files(&app, &adb, &device_id, &items, "single", &dir).await {
        Ok(o) if o.succeeded > 0 => {
            let saved = dir.join(&name).to_string_lossy().to_string();
            json!({ "success": true, "data": saved })
        }
        Ok(_) => json!({ "success": false, "error": "下载失败" }),
        Err(e) => e.to_result(),
    }
}
