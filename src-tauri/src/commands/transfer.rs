//! 文件传输命令层（T4-2 push/pull；T4-3 journal 接线 + 中断恢复）。命令名 = 渲染层方法名 snake_case。
//! pull 目标目录由后端取系统「下载」目录并经 savedDir 回传前端（用于「打开所在文件夹」）。
//!
//! journal 生命周期：push/pull 命令前 `begin_batch`（落 pending），传完后 `remove_batch`（了结即清理）；
//! 仅崩溃 / 被强杀残留的 pending/transferring 才会在重启后经 `get_resume_batches` 提示续传。
//! batch_id 复用 uploadId/pullId（新建传输），恢复时进度通道用新的 transferId、batch_id 仍是原批次。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::adb::binary;
use crate::adb::error::{classify_adb_error, AdbError};
use crate::adb::manager::exec_adb_capture;
use crate::transfer::journal::{self, NewTask};
use crate::transfer::runner::{self, remote_join, shell_quote, PullItem};

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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 设备端临时名（`.<name>.part`）——与 runner 落地口径一致，丢弃时清理残留。
fn part_name(name: &str) -> String {
    format!(".{name}.part")
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
    // 落 journal：上传任务 source=本地路径、target=设备目录、size=本地文件大小。
    let items: Vec<NewTask> = local_paths
        .iter()
        .map(|local| {
            let name = PathBuf::from(local)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| local.clone());
            let size = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
            NewTask { source_path: local.clone(), file_name: name, size }
        })
        .collect();
    journal::begin_batch(&upload_id, "upload", &device_id, &remote_dir, &items);

    let n = runner::push_files(&app, &adb, &device_id, &remote_dir, &local_paths, &upload_id, &upload_id).await;

    journal::remove_batch(&upload_id); // 了结即清理：正常跑完整批移除，不进恢复队列。
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
    let save_dir = dir.to_string_lossy().to_string();
    let tasks: Vec<NewTask> = items
        .iter()
        .map(|it| NewTask { source_path: it.path.clone(), file_name: it.name.clone(), size: 0 })
        .collect();
    journal::begin_batch(&pull_id, "download", &device_id, &save_dir, &tasks);

    let result = runner::pull_files(&app, &adb, &device_id, &items, &pull_id, &dir, &pull_id).await;

    journal::remove_batch(&pull_id);
    match result {
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
    // 单文件也落 journal（独立批次），中断后同样可恢复。
    let batch_id = format!("single-{}-{name}", now_ms());
    let save_dir = dir.to_string_lossy().to_string();
    journal::begin_batch(
        &batch_id,
        "download",
        &device_id,
        &save_dir,
        &[NewTask { source_path: remote_path.clone(), file_name: name.clone(), size: 0 }],
    );
    let items = vec![PullItem { path: remote_path, name: name.clone() }];
    let result = runner::pull_files(&app, &adb, &device_id, &items, &batch_id, &dir, &batch_id).await;
    journal::remove_batch(&batch_id);
    match result {
        Ok(o) if o.succeeded > 0 => {
            let saved = dir.join(&name).to_string_lossy().to_string();
            json!({ "success": true, "data": saved })
        }
        Ok(_) => json!({ "success": false, "error": "下载失败" }),
        Err(e) => e.to_result(),
    }
}

/// 列出所有可恢复批次（pending/transferring 残留）。渲染层按 deviceId 过滤。
#[tauri::command]
pub fn get_resume_batches() -> Value {
    json!({ "success": true, "data": journal::list_resume_batches() })
}

/// 恢复一批未完成传输：读 journal 取该批剩余文件（已 done 不在其中→天然跳过），按原方向重传。
/// `transfer_id` 仅作进度通道，journal 仍记在原 `batch_id`；传完整批清理。
#[tauri::command(rename_all = "camelCase")]
pub async fn resume_transfers(app: AppHandle, batch_id: String, transfer_id: String) -> Value {
    let tasks = journal::resumable_tasks(&batch_id);
    if tasks.is_empty() {
        return json!({ "success": true, "data": { "succeeded": 0, "failed": 0 } });
    }
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let direction = tasks[0].direction.clone();
    let device_id = tasks[0].device_id.clone();
    let target = tasks[0].target_path.clone();
    let remaining = tasks.len() as u32;

    let result = if direction == "upload" {
        let local_paths: Vec<String> = tasks.iter().map(|t| t.source_path.clone()).collect();
        let succeeded = runner::push_files(
            &app, &adb, &device_id, &target, &local_paths, &transfer_id, &batch_id,
        )
        .await;
        (succeeded, remaining.saturating_sub(succeeded))
    } else {
        let items: Vec<PullItem> = tasks
            .iter()
            .map(|t| PullItem { path: t.source_path.clone(), name: t.file_name.clone() })
            .collect();
        let save_dir = PathBuf::from(&target);
        match runner::pull_files(&app, &adb, &device_id, &items, &transfer_id, &save_dir, &batch_id).await {
            Ok(o) => (o.succeeded, o.failed),
            Err(e) => return e.to_result(),
        }
    };

    journal::remove_batch(&batch_id); // 恢复跑完整批了结清理。
    json!({ "success": true, "data": { "succeeded": result.0, "failed": result.1 } })
}

/// 丢弃一批未完成传输：清残留 `.part`（上传=设备端 rm，下载=本地删文件）+ 移出 journal，下次不再提示。
#[tauri::command(rename_all = "camelCase")]
pub async fn discard_transfers(app: AppHandle, batch_id: String) -> Value {
    let tasks = journal::resumable_tasks(&batch_id);
    let adb = binary::resolve_adb_path(&app); // 缺 adb 也要清本地 + 移 journal，故不提前 return。

    for t in &tasks {
        if t.direction == "upload" {
            if let Some(adb) = &adb {
                let remote_part = remote_join(&t.target_path, &part_name(&t.file_name));
                let _ = exec_adb_capture(
                    adb,
                    &["-s", &t.device_id, "shell", "rm", "-f", &shell_quote(&remote_part)],
                    15_000,
                )
                .await;
            }
        } else {
            let local_part = PathBuf::from(&t.target_path).join(part_name(&t.file_name));
            let _ = tokio::fs::remove_file(&local_part).await;
        }
    }

    journal::remove_batch(&batch_id);
    json!({ "success": true })
}
