//! 设备监控轮询（对应原 startDeviceMonitoring + pollDeviceChanges）。
//! 后台 tokio 任务定时 `adb devices -l`，设备列表变化时 emit device_list_changed(DeviceInfo[])。

use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

use super::{binary, manager};

const POLL_INTERVAL_MS: u64 = 3000;

/// 启动监控后台任务（在 setup 中调用）。
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_snapshot = String::new();
        loop {
            if let Some(adb) = binary::resolve_adb_path(&app) {
                if let Ok(devices) = manager::get_devices(&adb).await {
                    let snapshot = manager::devices_snapshot(&devices);
                    if snapshot != last_snapshot {
                        last_snapshot = snapshot;
                        let _ = app.emit("device_list_changed", &devices);
                    }
                }
            }
            sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
        }
    });
}
