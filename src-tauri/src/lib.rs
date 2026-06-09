//! 安卓设备监控 — Tauri + Rust 后端入口（P0 骨架）。
//!
//! P0 阶段：注册全部 IPC 命令桩 + 运行时根目录推导。
//! 后续 Phase 按 DEV-PLAN 将各模块（adb/performance/transfer/weaknet/logging/updater）接入真实实现。

mod adb;
mod commands;
mod mirror;
mod performance;
mod runtime_root;
mod transfer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 采集媒体协议 adm-media://<相对路径> → 运行时根目录磁盘文件（视频/截图，支持 Range + CORS）。
        .register_uri_scheme_protocol(performance::media::SCHEME, |_ctx, request| {
            performance::media::handle(&request)
        })
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
            // 采集会话（T2.6 真实现）
            commands::performance::start_capture_session,
            commands::performance::stop_capture_session,
            commands::performance::get_active_capture_sessions,
            commands::performance::list_capture_sessions,
            commands::performance::load_capture_session,
            commands::performance::delete_capture_session,
            commands::performance::rename_capture_session,
            commands::performance::save_capture_markers,
            commands::performance::save_capture_frame,
            // 采集导入导出（T2.8 真实现）
            commands::capture_io::export_capture_session,
            commands::capture_io::select_import_files,
            commands::capture_io::import_capture_sessions,
            commands::capture_io::export_performance_session,
            // 投屏（start/stop T3.3、set_mirror_audio T3.5 真实现）
            commands::mirror::start_mirror,
            commands::mirror::stop_mirror,
            commands::mirror::set_mirror_audio,
            // 更新
            commands::check_for_update,
            commands::get_update_status,
            commands::download_update,
            commands::quit_and_install_update,
            // 应用安装（T2.2 真实现）
            commands::apps::select_apk_files,
            commands::apps::install_apk,
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
            // 文件管理/传输（list/delete/create/select_upload T4-1 真实现）
            commands::files::list_device_files,
            commands::files::delete_device_file,
            commands::files::create_device_folder,
            commands::files::select_upload_files,
            commands::transfer::pull_device_file,
            commands::transfer::pull_device_files,
            commands::transfer::push_device_file,
            commands::transfer::resume_transfers,
            commands::transfer::discard_transfers,
            commands::transfer::get_resume_batches,
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // 应用退出清理：停掉进行中的采集（含设备端 screenrecord）+ 回收常驻 PxrMetric 流子进程。
            if let tauri::RunEvent::Exit = event {
                let app = app.clone();
                tauri::async_runtime::block_on(async move {
                    performance::capture_controller::stop_all(&app).await;
                    adb::pico_metrics_stream::stop_all().await;
                    mirror::stop_all().await;
                });
            }
        });
}
