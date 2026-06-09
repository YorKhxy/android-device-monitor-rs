//! 投屏命令层：start_mirror / stop_mirror（T3.3）+ set_mirror_audio（T3.5）薄封装到 mirror 模块。
//! 命令名 = 渲染层方法名 snake_case（见 electronApiShim.ts）。

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::adb::scrcpy::MirrorStartOptions;
use crate::mirror;

/// 开始投屏：spawn scrcpy 视频窗口，返回会话状态（失败返回结构化错误）。
/// Pico 设备由 mirror::start 内部自动裁单眼（T3.4）。
#[tauri::command(rename_all = "camelCase")]
pub async fn start_mirror(
    app: AppHandle,
    device_id: String,
    options: Option<MirrorStartOptions>,
) -> Value {
    let options = options.unwrap_or_default();
    match mirror::start(&app, &device_id, options).await {
        Ok(session) => json!({ "success": true, "data": session }),
        Err(e) => e.to_result(),
    }
}

/// 停止投屏：kill scrcpy 进程并广播 stopped。无会话则幂等成功。
#[tauri::command(rename_all = "camelCase")]
pub async fn stop_mirror(app: AppHandle, device_id: String) -> Value {
    mirror::stop(&app, &device_id).await;
    json!({ "success": true, "data": null })
}

/// 投屏中切换声音去向：forward=true 把设备声音转电脑，false 留在设备。返回更新后的会话。
#[tauri::command(rename_all = "camelCase")]
pub async fn set_mirror_audio(app: AppHandle, device_id: String, forward: bool) -> Value {
    match mirror::set_audio(&app, &device_id, forward).await {
        Ok(session) => json!({ "success": true, "data": session }),
        Err(e) => e.to_result(),
    }
}
