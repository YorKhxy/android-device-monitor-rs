//! Logcat 命令层（T4-4）：start/stop 薄封装到 adb::logcat_stream。命令名 = 渲染层方法名 snake_case。
//!
//! `min_level` 前端恒传 'V'（抓取恒 `*:V`，等级仅作前端显示筛选），后端忽略——切换等级无需重采集、不漏低级别日志。
//! `package_name`/`pid` 用于「相关日志」预过滤（见 logcat_stream）。

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::adb::binary;
use crate::adb::error::classify_adb_error;
use crate::adb::logcat_stream;

fn adb_not_found() -> Value {
    classify_adb_error("enoent", &[]).to_result()
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
