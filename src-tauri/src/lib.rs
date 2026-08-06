//! 安卓设备监控 — Tauri + Rust 后端入口（P0 骨架）。
//!
//! P0 阶段：注册全部 IPC 命令桩 + 运行时根目录推导。
//! 后续 Phase 按 DEV-PLAN 将各模块（adb/performance/transfer/weaknet/logging/updater）接入真实实现。

mod adb;
mod commands;
mod logging;
mod mirror;
mod performance;
mod runtime_root;
mod transfer;
mod updater;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 采集回放弹出窗的初始化数据交接箱（拉取式，见 commands::popout）。
        .manage(commands::popout::PopoutSessionState::default())
        // 采集媒体协议 adm-media://<相对路径> → 运行时根目录磁盘文件（视频/截图，支持 Range + CORS）。
        .register_uri_scheme_protocol(performance::media::SCHEME, |_ctx, request| {
            performance::media::handle(&request)
        })
        .setup(|app| {
            // 启动设备监控轮询，设备列表变化时 emit device_list_changed
            adb::monitor::start(app.handle().clone());
            // 把热更安装位置钉回「当前 exe 所在目录」：NSIS passive 更新没有目录页，装哪全凭注册表值，
            // 而该值可能脱钩到 C 盘。每次启动自愈一次 → 热更必然装回原路径，杜绝「跑到 C 盘装」。
            // dev 期 exe 在 target/debug，写注册表无意义且会误导，仅 release 执行。
            #[cfg(not(debug_assertions))]
            updater::ensure_install_dir_pinned();
            // 启动即静默检查一次更新（对齐老工具 whenReady → checkForUpdates）：结果经 update_status event +
            // get_update_status 缓存推前端，「打开工具就提示有新版本」无需手动点。开发期跳过——无更新端点会报错刷屏。
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = updater::check_for_update(handle).await;
                });
            }
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
            adb::commands::discover_mdns_devices,
            // 日志（T4-4 真实现）
            commands::logcat::start_logcat,
            commands::logcat::stop_logcat,
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
            // 更新（T6.2 真实现）
            updater::check_for_update,
            updater::get_update_status,
            updater::download_update,
            updater::quit_and_install_update,
            // 应用安装（T2.2 真实现）
            commands::apps::select_apk_files,
            commands::apps::install_apk,
            commands::apps::cancel_install,
            commands::apps::check_apks_on_device,
            commands::apps::check_files_exist,
            // 应用管理（T2.1 真实现）
            commands::apps::list_installed_packages,
            commands::apps::list_app_labels,
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
            commands::transfer::cancel_transfer,
            // 系统/杂项（设备控制 + 本机文件定位 真实现）
            commands::device::show_item_in_folder,
            commands::device::open_path,
            commands::device::sleep_device,
            commands::device::wake_device,
            commands::device::unlock_device,
            commands::device::reboot_device,
            commands::device::close_pico_large_space,
            commands::get_app_version,
            // 视频独立窗口（采集回放弹出，方案二）
            commands::popout::open_capture_popout,
            commands::popout::close_capture_popout,
            commands::popout::set_popout_session,
            commands::popout::get_popout_session,
            updater::get_release_notes,
            // 日志导出（T4-5 真实现）
            commands::logcat::export_logs,
            commands::logcat::export_full_logs,
            commands::logcat::export_full_logs_by_package,
            commands::logcat::export_device_log_buffer,
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
                    adb::logcat_stream::stop_all().await;
                    mirror::stop_all().await;
                    // 关掉对照探针在设备上启用的 SurfaceFlinger timestats。
                    if let Some(adb) = adb::binary::resolve_adb_path(&app) {
                        adb::surface_fps::disable_all(&adb).await;
                        // 最后停掉本地 adb server：否则 adb.exe 残留会锁住安装目录里的 AdbWinApi.dll，
                        // 热更覆盖 / 重装时撞 os error 32。须在 disable_all 之后（那步还要用 server 通设备）。
                        adb::manager::kill_server(&adb).await;
                    }
                });
            }
        });
}
