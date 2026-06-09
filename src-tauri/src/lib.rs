//! 安卓设备监控 — Tauri + Rust 后端入口（P0 骨架）。
//!
//! P0 阶段：注册全部 IPC 命令桩 + 运行时根目录推导。
//! 后续 Phase 按 DEV-PLAN 将各模块（adb/performance/transfer/weaknet/logging/updater）接入真实实现。

mod adb;
mod commands;
mod runtime_root;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 启动设备监控轮询，设备列表变化时 emit device_list_changed
            adb::monitor::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 设备连接（P1 真实现）
            adb::commands::get_adb_status,
            adb::commands::get_devices,
            adb::commands::connect_wifi,
            adb::commands::pair_wifi,
            adb::commands::disconnect,
            adb::commands::connect_usb,
            // 日志
            commands::start_logcat,
            commands::stop_logcat,
            // 性能/运行情况（T2.3 真实现）
            commands::performance::get_performance,
            commands::performance::get_processes,
            commands::performance::get_running_packages,
            commands::performance::get_activity_stack,
            // 采集
            commands::start_capture_session,
            commands::stop_capture_session,
            commands::get_active_capture_sessions,
            commands::list_capture_sessions,
            commands::load_capture_session,
            commands::delete_capture_session,
            commands::rename_capture_session,
            commands::save_capture_markers,
            commands::save_capture_frame,
            commands::export_capture_session,
            commands::select_import_files,
            commands::import_capture_sessions,
            commands::export_performance_session,
            // 投屏
            commands::start_mirror,
            commands::stop_mirror,
            commands::set_mirror_audio,
            // 更新
            commands::check_for_update,
            commands::get_update_status,
            commands::download_update,
            commands::quit_and_install_update,
            // 应用安装（T2.2 待实现）
            commands::select_apk_files,
            commands::install_apk,
            // 应用管理（T2.1 真实现）
            commands::apps::list_installed_packages,
            commands::apps::launch_app,
            commands::apps::force_stop_app,
            commands::apps::uninstall_app,
            // 弱网
            commands::install_weaknet_helper,
            commands::start_weaknet,
            commands::stop_weaknet,
            commands::query_weaknet_status,
            commands::query_weaknet_traffic,
            commands::export_weaknet_traffic,
            commands::query_weaknet_shaper_stats,
            // 文件管理/传输
            commands::list_device_files,
            commands::pull_device_file,
            commands::pull_device_files,
            commands::delete_device_file,
            commands::create_device_folder,
            commands::select_upload_files,
            commands::push_device_file,
            commands::resume_transfers,
            commands::discard_transfers,
            commands::get_resume_batches,
            // 系统/杂项
            commands::show_item_in_folder,
            commands::open_path,
            commands::get_app_version,
            commands::get_release_notes,
            commands::sleep_device,
            commands::wake_device,
            commands::unlock_device,
            commands::reboot_device,
            commands::export_logs,
            commands::export_full_logs,
            commands::export_full_logs_by_package,
            commands::get_runtime_root,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
