//! 性能/运行情况命令（T2.3）：实时性能采样、进程列表、运行中包名、Activity 栈。
//! 对应原 runtimeInspector.ts / ADBManager 的 getPerformanceMetrics / getProcesses /
//! getRunningPackages / getActivityStack。命令名 = 渲染层方法名 snake_case。
//!
//! 错误语义（对齐原版）：
//! - get_performance 失败 → 结构化错误（success:false），上层据此跳过本拍（不返 0，gap-not-zero）。
//! - get_processes / get_running_packages / get_activity_stack 失败 → 空数组（原版 swallow）。

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::adb::binary;
use crate::adb::error::classify_adb_error;
use crate::adb::runtime_inspector;

fn adb_not_found() -> Value {
    classify_adb_error("enoent", &[]).to_result()
}

/// 实时性能采样（Android 路径；Pico 官方指标在 T2.4 接入）。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_performance(app: AppHandle, device_id: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let foreground = runtime_inspector::get_foreground_app_context_cached(&adb, &device_id).await;
    match runtime_inspector::get_android_performance_metrics(&adb, &device_id, &foreground).await {
        Ok(metrics) => json!({ "success": true, "data": metrics }),
        // 采样命令级失败：如实上报错误，不编造 0（前端/采集层据此跳过本拍）。
        Err(e) => e.to_result(),
    }
}

/// 进程列表。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_processes(app: AppHandle, device_id: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let processes = runtime_inspector::get_processes(&adb, &device_id).await;
    json!({ "success": true, "data": processes })
}

/// 正在运行的应用包名集合。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_running_packages(app: AppHandle, device_id: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let packages = runtime_inspector::get_running_packages(&adb, &device_id).await;
    json!({ "success": true, "data": packages })
}

/// Activity 栈（可按包名过滤）。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_activity_stack(
    app: AppHandle,
    device_id: String,
    package_name: Option<String>,
) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let stack =
        runtime_inspector::get_activity_stack(&adb, &device_id, package_name.as_deref()).await;
    json!({ "success": true, "data": stack })
}
