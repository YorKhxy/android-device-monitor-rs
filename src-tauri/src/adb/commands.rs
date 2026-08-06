//! 设备相关 Tauri 命令（取代 P0 占位）：返回渲染层约定的 ElectronResult 形状。

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::error::classify_adb_error;
use super::{binary, manager};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn adb_not_found() -> Value {
    classify_adb_error("enoent", &[]).to_result()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_devices(app: AppHandle) -> Value {
    match binary::resolve_adb_path(&app) {
        None => adb_not_found(),
        Some(adb) => match manager::get_devices(&adb).await {
            Ok(list) => json!({ "success": true, "data": list }),
            Err(e) => e.to_result(),
        },
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn connect_usb(app: AppHandle) -> Value {
    match binary::resolve_adb_path(&app) {
        None => adb_not_found(),
        Some(adb) => match manager::connect_usb(&adb).await {
            Ok(list) => json!({ "success": true, "data": list }),
            Err(e) => e.to_result(),
        },
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn connect_wifi(app: AppHandle, ip: String) -> Value {
    match binary::resolve_adb_path(&app) {
        None => adb_not_found(),
        Some(adb) => match manager::connect_wifi(&adb, &ip).await {
            Ok(device) => json!({ "success": true, "data": device }),
            Err(e) => e.to_result(),
        },
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn pair_wifi(app: AppHandle, target: String, pairing_code: String) -> Value {
    match binary::resolve_adb_path(&app) {
        None => adb_not_found(),
        Some(adb) => match manager::pair(&adb, &target, &pairing_code).await {
            Ok((message, device, already_paired)) => json!({
                "success": true,
                "data": { "message": message, "device": device, "alreadyPaired": already_paired }
            }),
            Err(e) => e.to_result(),
        },
    }
}

/// 局域网 mDNS 自动发现可连接设备（解析 adb 自带 `adb mdns services`，零额外依赖）。
#[tauri::command]
pub async fn discover_mdns_devices(app: AppHandle) -> Value {
    match binary::resolve_adb_path(&app) {
        None => adb_not_found(),
        // mDNS 三拍负责快速首屏；同时主动补扫本机 /24 网段的经典 ADB 5555 端口，
        // 用协议握手补回「IP:端口能连但设备未广播 mDNS」的漏项。
        Some(adb) => {
            let app2 = app.clone();
            let mdns_scan = super::mdns::discover_streaming(&adb, 3, 700, move |snapshot| {
                let _ = app2.emit("mdns_discovered", &snapshot);
            });
            let (mdns_result, active) = tokio::join!(mdns_scan, super::mdns::discover_active_adb());

            match mdns_result {
                Ok(svcs) => {
                    let merged = super::mdns::merge_discoveries(svcs, active);
                    let _ = app.emit("mdns_discovered", &merged);
                    json!({ "success": true, "data": merged })
                }
                Err(_) if !active.is_empty() => {
                    let _ = app.emit("mdns_discovered", &active);
                    json!({ "success": true, "data": active })
                }
                Err(e) => e.to_result(),
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn disconnect(app: AppHandle, device_id: String) -> Value {
    // 断开设备时回收其常驻 PxrMetric 流（否则等空闲看门狗 15s 后才回收）。
    super::pico_metrics_stream::stop(&device_id).await;
    match binary::resolve_adb_path(&app) {
        None => adb_not_found(),
        Some(adb) => match manager::disconnect(&adb, &device_id).await {
            Ok(()) => json!({ "success": true, "data": null }),
            Err(e) => e.to_result(),
        },
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_adb_status(app: AppHandle) -> Value {
    let checked_at = now_ms();
    match binary::resolve_adb_path(&app) {
        None => {
            let e = classify_adb_error("enoent", &["version"]);
            json!({ "success": true, "data": {
                "available": false, "version": Value::Null, "path": Value::Null,
                "source": Value::Null, "message": e.message, "checkedAt": checked_at,
                "code": e.code, "hint": e.hint
            }})
        }
        Some(adb) => match manager::adb_version(&adb).await {
            Ok(version) => {
                let msg = match &version {
                    Some(v) => format!("内置 ADB 已就绪（{v}）"),
                    None => "内置 ADB 已就绪".to_string(),
                };
                json!({ "success": true, "data": {
                    "available": true, "version": version, "path": adb.to_string_lossy(),
                    "source": "bundled", "message": msg, "checkedAt": checked_at
                }})
            }
            Err(e) => json!({ "success": true, "data": {
                "available": false, "version": Value::Null, "path": Value::Null,
                "source": Value::Null, "message": e.message, "checkedAt": checked_at,
                "code": e.code, "hint": e.hint
            }}),
        },
    }
}
