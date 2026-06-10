//! 命令层。各 IPC 通道的 Tauri 命令，按域分文件；尚未实现的保留占位桩。
//!
//! 已接管真实现：
//! - 设备连接 → `adb::commands`（P1）
//! - 应用管理（list/launch/force-stop/uninstall）→ `commands::apps`（P2 / T2.1）
//! - 性能/运行情况（performance/processes/runningPackages/activityStack）→ `commands::performance`（P2 / T2.3）
//!
//! 其余命令仍为 P0 占位，统一返回 ElectronResult 形状（{ success, data, error, ... }），
//! 按 DEV-PLAN 的 P2–P6 逐步替换。约定：命令名 = 渲染层方法名的 snake_case（见 electronApiShim.ts）。

pub mod apps;
pub mod capture_io;
pub mod device;
pub mod files;
pub mod logcat;
pub mod mirror;
pub mod performance;
pub mod transfer;

use serde_json::{json, Value};

use crate::runtime_root::resolve_runtime_app_root;

/// 标量/对象类占位：返回未实现错误，前端按 ElectronResult.success=false 处理。
fn stub() -> Value {
    json!({ "success": false, "error": "占位：该能力将在后续 Phase 实现" })
}

// ——— 日志 ——（start_logcat / stop_logcat 已由 commands::logcat 接管，T4-4）—

// ——— 性能/采集 ——（get_performance + 采集会话生命周期 + save_capture_frame → commands::performance；
//     导出/导入 export/select_import/import/export_performance → commands::capture_io，T2.8）—

// ——— 运行情况 ——（get_processes / get_running_packages / get_activity_stack 已由 commands::performance 接管）—

// ——— 投屏 ——（start_mirror / stop_mirror / set_mirror_audio 已由 commands::mirror 接管，T3.3/T3.5）—

// ——— 更新 ——（check/get_status/download/quit_and_install / get_release_notes 已由 updater 接管，T6.2）—

// ——— 应用安装（select_apk_files / install_apk 已由 commands::apps 接管，T2.2）———

// ——— 弱网 ———
#[tauri::command] pub fn install_weaknet_helper() -> Value { stub() }
#[tauri::command] pub fn start_weaknet() -> Value { stub() }
#[tauri::command] pub fn stop_weaknet() -> Value { stub() }
#[tauri::command] pub fn query_weaknet_status() -> Value { stub() }
#[tauri::command] pub fn query_weaknet_traffic() -> Value { json!({ "success": true, "data": null }) }
#[tauri::command] pub fn export_weaknet_traffic() -> Value { stub() }
#[tauri::command] pub fn query_weaknet_shaper_stats() -> Value { json!({ "success": true, "data": null }) }

// ——— 文件管理/传输 ——（list/delete/create/select_upload → commands::files T4-1；
//     push/pull → commands::transfer T4-2；resume/discard/get_resume_batches → commands::transfer T4-3）—

// ——— 系统/杂项 ——（sleep/wake/unlock/reboot + show_item_in_folder/open_path 已由 commands::device 接管）—
#[tauri::command] pub fn get_app_version() -> Value { json!({ "success": true, "data": env!("CARGO_PKG_VERSION") }) }
// export_logs / export_full_logs / export_full_logs_by_package 已由 commands::logcat 接管（T4-5）。

// ——— 验证用：暴露运行时根目录，确认落盘锚点正确（不进 C 盘 userData）———
#[tauri::command]
pub fn get_runtime_root() -> Value {
    json!({ "success": true, "data": resolve_runtime_app_root().to_string_lossy() })
}
