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
use crate::adb::performance_dispatch;
use crate::adb::runtime_inspector;
use crate::performance::{capture_controller, capture_store};

fn adb_not_found() -> Value {
    classify_adb_error("enoent", &[]).to_result()
}

/// 实时性能采样（自动探测 Pico/Android；Pico 走官方指标 + Android 旁路）。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_performance(app: AppHandle, device_id: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let foreground = runtime_inspector::get_foreground_app_context_cached(&adb, &device_id).await;
    // prefer_pico=false：一次性实时采样自动探测设备类型（Pico 走官方指标，否则 Android）。
    match performance_dispatch::get_performance_metrics(&adb, &device_id, &foreground, false).await {
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

// ——— 采集会话（T2.6）———

/// 开始采集（采样 + 录制同时启动）。
#[tauri::command(rename_all = "camelCase")]
pub async fn start_capture_session(app: AppHandle, device_id: String) -> Value {
    match capture_controller::start(&app, &device_id).await {
        Ok(session) => json!({ "success": true, "data": session }),
        Err(e) => e.to_result(),
    }
}

/// 关闭采集，finalize 会话。
#[tauri::command(rename_all = "camelCase")]
pub async fn stop_capture_session(app: AppHandle, device_id: String) -> Value {
    match capture_controller::stop(&app, &device_id).await {
        Ok(session) => json!({ "success": true, "data": session }),
        Err(e) => e.to_result(),
    }
}

/// 进行中的采集快照（渲染层重载/崩溃后对齐状态）。
#[tauri::command]
pub fn get_active_capture_sessions() -> Value {
    json!({ "success": true, "data": capture_controller::get_active_sessions() })
}

/// 回看列表（按开始时间倒序）。
#[tauri::command]
pub async fn list_capture_sessions() -> Value {
    json!({ "success": true, "data": capture_store::list_sessions().await })
}

/// 加载会话详情（manifest + 样本 + 标记）。
#[tauri::command(rename_all = "camelCase")]
pub async fn load_capture_session(session_id: String) -> Value {
    match capture_store::load_session(&session_id).await {
        Ok(detail) => json!({ "success": true, "data": detail }),
        Err(e) => e.to_result(),
    }
}

/// 删除会话（连数据带视频，二次确认在 UI 侧）。
#[tauri::command(rename_all = "camelCase")]
pub async fn delete_capture_session(session_id: String) -> Value {
    match capture_store::delete_session(&session_id).await {
        Ok(()) => json!({ "success": true, "data": null }),
        Err(e) => e.to_result(),
    }
}

/// 重命名会话（自定义标题）。
#[tauri::command(rename_all = "camelCase")]
pub async fn rename_capture_session(session_id: String, title: String) -> Value {
    match capture_store::rename_session(&session_id, &title).await {
        Ok(session) => json!({ "success": true, "data": session }),
        Err(e) => e.to_result(),
    }
}

/// 保存参数过滤标记（原样写入 markers.json，供回看复用）。
#[tauri::command(rename_all = "camelCase")]
pub async fn save_capture_markers(session_id: String, markers: Value) -> Value {
    match capture_store::save_markers(&session_id, &markers).await {
        Ok(()) => json!({ "success": true, "data": null }),
        Err(e) => e.to_result(),
    }
}
