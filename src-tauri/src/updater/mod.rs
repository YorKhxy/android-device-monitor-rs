//! 热更客户端（T6.2，对应原 autoUpdate.ts）：基于 tauri-plugin-updater 2.x。
//!
//! 行为对齐原版：**手动触发**（用户点「检查更新」）、**静默装**（NSIS passive，见 tauri.conf updater.windows.installMode）、
//! **应用内更新日志**（latest.json 的 notes → UpdateStatus.releaseNotes）。
//! 状态经 `update_status` event 推前端（UpdateStatus 形状），`get_update_status` 返回最近一次缓存。
//!
//! 流程：check_for_update → download_update → quit_and_install_update 三步手动推进；
//! check 拿到的 Update 与下载的字节缓存在模块内，供后续 download/install 复用。

use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

/// check 拿到的待处理更新（download/install 复用）。
fn pending_update() -> &'static Mutex<Option<Update>> {
    static U: OnceLock<Mutex<Option<Update>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(None))
}

/// 已下载的安装包字节（download 后缓存，install 时消费）。
fn downloaded_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    static B: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(None))
}

/// 最近一次 UpdateStatus（get_update_status 返回）。
fn cached_status() -> &'static Mutex<Option<Value>> {
    static S: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// 写缓存 + 经 update_status event 推前端。
fn emit_status(app: &AppHandle, status: Value) {
    if let Ok(mut s) = cached_status().lock() {
        *s = Some(status.clone());
    }
    let _ = app.emit("update_status", status);
}

/// 检查更新（手动触发）。有更新缓存 Update 并推 available + 更新日志；无更新推 not-available。
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Value {
    emit_status(&app, json!({ "state": "checking" }));

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            emit_status(&app, json!({ "state": "error", "error": e.to_string() }));
            return json!({ "success": false, "error": e.to_string() });
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone().unwrap_or_default();
            if let Ok(mut p) = pending_update().lock() {
                *p = Some(update);
            }
            emit_status(&app, json!({
                "state": "available",
                "version": version,
                "releaseNotes": notes,
            }));
            json!({ "success": true })
        }
        Ok(None) => {
            emit_status(&app, json!({ "state": "not-available" }));
            json!({ "success": true })
        }
        Err(e) => {
            emit_status(&app, json!({ "state": "error", "error": e.to_string() }));
            json!({ "success": false, "error": e.to_string() })
        }
    }
}

/// 返回最近一次更新状态（无则 null）。
#[tauri::command]
pub fn get_update_status() -> Value {
    let data = cached_status().lock().ok().and_then(|s| s.clone());
    json!({ "success": true, "data": data })
}

/// 下载更新包（静默，进度经 update_status percent 推送）。下好缓存字节、推 downloaded 待重启安装。
#[tauri::command]
pub async fn download_update(app: AppHandle) -> Value {
    // 取出待处理 Update（不跨 await 持锁）。
    let update = match pending_update().lock().ok().and_then(|mut p| p.take()) {
        Some(u) => u,
        None => return json!({ "success": false, "error": "没有可下载的更新，请先检查更新" }),
    };
    let version = update.version.clone();
    emit_status(&app, json!({ "state": "downloading", "version": version, "percent": 0 }));

    // 进度回调：累计已下/总长算百分比，经 event 推送。
    let app_cb = app.clone();
    let ver_cb = version.clone();
    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let downloaded_cb = downloaded.clone();
    let result = update
        .download(
            move |chunk_len: usize, content_len: Option<u64>| {
                let got = downloaded_cb.fetch_add(chunk_len as u64, std::sync::atomic::Ordering::Relaxed)
                    + chunk_len as u64;
                let percent = content_len
                    .filter(|t| *t > 0)
                    .map(|t| ((got * 100) / t).min(100))
                    .unwrap_or(0);
                emit_status(&app_cb, json!({
                    "state": "downloading",
                    "version": ver_cb,
                    "percent": percent,
                }));
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            if let Ok(mut b) = downloaded_bytes().lock() {
                *b = Some(bytes);
            }
            if let Ok(mut p) = pending_update().lock() {
                *p = Some(update); // 放回供 install 复用。
            }
            emit_status(&app, json!({ "state": "downloaded", "version": version }));
            json!({ "success": true })
        }
        Err(e) => {
            if let Ok(mut p) = pending_update().lock() {
                *p = Some(update); // 失败也放回，允许重试。
            }
            emit_status(&app, json!({ "state": "error", "error": e.to_string() }));
            json!({ "success": false, "error": e.to_string() })
        }
    }
}

/// 安装已下载的更新并重启（静默装）。
#[tauri::command]
pub fn quit_and_install_update(app: AppHandle) -> Value {
    let update = pending_update().lock().ok().and_then(|mut p| p.take());
    let bytes = downloaded_bytes().lock().ok().and_then(|mut b| b.take());
    match (update, bytes) {
        (Some(update), Some(bytes)) => match update.install(bytes) {
            Ok(()) => {
                app.restart(); // 重启进程加载新版（diverges）。
            }
            Err(e) => json!({ "success": false, "error": e.to_string() }),
        },
        _ => json!({ "success": false, "error": "请先下载更新" }),
    }
}

/// 应用内更新日志：返回最近一次状态里的 releaseNotes。
#[tauri::command]
pub fn get_release_notes() -> Value {
    let notes = cached_status()
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .and_then(|v| v.get("releaseNotes").and_then(|n| n.as_str()).map(str::to_string))
        .unwrap_or_default();
    json!({ "success": true, "data": notes })
}
