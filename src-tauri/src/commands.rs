//! P0 命令桩层。
//!
//! 这里为渲染层 window.electronAPI 调用的全部 IPC 通道提供 Rust 命令占位，
//! 统一返回 ElectronResult 形状的 JSON（{ success, data, error, ... }）。
//! 真实实现按 DEV-PLAN 的 P1–P6 逐步替换；P0 只保证命令存在、可被 invoke、不报“命令未注册”。
//!
//! 约定：命令名 = 渲染层方法名的 snake_case（见 electronApiShim.ts）。
//! 桩函数不声明参数（忽略前端传入的 args），避免 P0 阶段为每个命令对齐参数签名。

use serde_json::{json, Value};

use crate::runtime_root::resolve_runtime_app_root;

/// 列表类占位：返回空数组，让前端走“空状态”而非崩溃。
fn ok_list() -> Value {
    json!({ "success": true, "data": [] })
}

/// 标量/对象类占位：返回未实现错误，前端按 ElectronResult.success=false 处理。
fn stub() -> Value {
    json!({ "success": false, "error": "P0 占位：该能力将在后续 Phase 实现" })
}

// ——— 设备连接 ———
#[tauri::command] pub fn get_adb_status() -> Value { json!({ "success": true, "data": { "available": false, "version": null } }) }
#[tauri::command] pub fn get_devices() -> Value { ok_list() }
#[tauri::command] pub fn connect_wifi() -> Value { stub() }
#[tauri::command] pub fn pair_wifi() -> Value { stub() }
#[tauri::command] pub fn disconnect() -> Value { stub() }
#[tauri::command] pub fn connect_usb() -> Value { ok_list() }

// ——— 日志 ———
#[tauri::command] pub fn start_logcat() -> Value { stub() }
#[tauri::command] pub fn stop_logcat() -> Value { stub() }

// ——— 性能/采集 ———
#[tauri::command] pub fn get_performance() -> Value { stub() }
#[tauri::command] pub fn start_capture_session() -> Value { stub() }
#[tauri::command] pub fn stop_capture_session() -> Value { stub() }
#[tauri::command] pub fn get_active_capture_sessions() -> Value { ok_list() }
#[tauri::command] pub fn list_capture_sessions() -> Value { ok_list() }
#[tauri::command] pub fn load_capture_session() -> Value { stub() }
#[tauri::command] pub fn delete_capture_session() -> Value { stub() }
#[tauri::command] pub fn rename_capture_session() -> Value { stub() }
#[tauri::command] pub fn save_capture_markers() -> Value { stub() }
#[tauri::command] pub fn save_capture_frame() -> Value { stub() }
#[tauri::command] pub fn export_capture_session() -> Value { stub() }
#[tauri::command] pub fn select_import_files() -> Value { ok_list() }
#[tauri::command] pub fn import_capture_sessions() -> Value { stub() }
#[tauri::command] pub fn export_performance_session() -> Value { stub() }

// ——— 运行情况 ———
#[tauri::command] pub fn get_processes() -> Value { ok_list() }
#[tauri::command] pub fn get_running_packages() -> Value { ok_list() }
#[tauri::command] pub fn get_activity_stack() -> Value { ok_list() }
#[tauri::command] pub fn get_network_requests() -> Value { ok_list() }

// ——— 投屏 ———
#[tauri::command] pub fn start_mirror() -> Value { stub() }
#[tauri::command] pub fn stop_mirror() -> Value { stub() }
#[tauri::command] pub fn set_mirror_audio() -> Value { stub() }

// ——— 更新 ———
#[tauri::command] pub fn check_for_update() -> Value { stub() }
#[tauri::command] pub fn get_update_status() -> Value { json!({ "success": true, "data": null }) }
#[tauri::command] pub fn download_update() -> Value { stub() }
#[tauri::command] pub fn quit_and_install_update() -> Value { stub() }

// ——— 应用安装/管理 ———
#[tauri::command] pub fn select_apk_files() -> Value { ok_list() }
#[tauri::command] pub fn install_apk() -> Value { stub() }
#[tauri::command] pub fn uninstall_app() -> Value { stub() }
#[tauri::command] pub fn list_installed_packages() -> Value { ok_list() }
#[tauri::command] pub fn launch_app() -> Value { stub() }
#[tauri::command] pub fn force_stop_app() -> Value { stub() }

// ——— 弱网 ———
#[tauri::command] pub fn install_weaknet_helper() -> Value { stub() }
#[tauri::command] pub fn start_weaknet() -> Value { stub() }
#[tauri::command] pub fn stop_weaknet() -> Value { stub() }
#[tauri::command] pub fn query_weaknet_status() -> Value { stub() }
#[tauri::command] pub fn query_weaknet_traffic() -> Value { json!({ "success": true, "data": null }) }
#[tauri::command] pub fn export_weaknet_traffic() -> Value { stub() }
#[tauri::command] pub fn query_weaknet_shaper_stats() -> Value { json!({ "success": true, "data": null }) }

// ——— 文件管理/传输 ———
#[tauri::command] pub fn list_device_files() -> Value { stub() }
#[tauri::command] pub fn pull_device_file() -> Value { stub() }
#[tauri::command] pub fn pull_device_files() -> Value { stub() }
#[tauri::command] pub fn delete_device_file() -> Value { stub() }
#[tauri::command] pub fn create_device_folder() -> Value { stub() }
#[tauri::command] pub fn select_upload_files() -> Value { ok_list() }
#[tauri::command] pub fn push_device_file() -> Value { stub() }
#[tauri::command] pub fn resume_transfers() -> Value { stub() }
#[tauri::command] pub fn discard_transfers() -> Value { stub() }
#[tauri::command] pub fn get_resume_batches() -> Value { ok_list() }

// ——— 系统/杂项 ———
#[tauri::command] pub fn show_item_in_folder() -> Value { stub() }
#[tauri::command] pub fn open_path() -> Value { stub() }
#[tauri::command] pub fn get_app_version() -> Value { json!({ "success": true, "data": env!("CARGO_PKG_VERSION") }) }
#[tauri::command] pub fn get_release_notes() -> Value { json!({ "success": true, "data": "" }) }
#[tauri::command] pub fn sleep_device() -> Value { stub() }
#[tauri::command] pub fn wake_device() -> Value { stub() }
#[tauri::command] pub fn unlock_device() -> Value { stub() }
#[tauri::command] pub fn reboot_device() -> Value { stub() }
#[tauri::command] pub fn export_logs() -> Value { stub() }
#[tauri::command] pub fn export_full_logs() -> Value { stub() }
#[tauri::command] pub fn export_full_logs_by_package() -> Value { stub() }

// ——— 验证用：暴露运行时根目录，确认落盘锚点正确（不进 C 盘 userData）———
#[tauri::command] pub fn get_runtime_root() -> Value {
    json!({ "success": true, "data": resolve_runtime_app_root().to_string_lossy() })
}
