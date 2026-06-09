//! 投屏命令层（T3.3）：start_mirror / stop_mirror 薄封装到 mirror 模块。
//! 命令名 = 渲染层方法名 snake_case（见 electronApiShim.ts）。
//! set_mirror_audio（声音去向切换）见 T3.5。

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::adb::scrcpy::MirrorStartOptions;
use crate::mirror;

/// 开始投屏：spawn scrcpy 视频窗口，返回会话状态（失败返回结构化错误）。
/// crop（Pico 单眼裁切）T3.4 计算后传入，当前为 None。
#[tauri::command(rename_all = "camelCase")]
pub async fn start_mirror(
    app: AppHandle,
    device_id: String,
    options: Option<MirrorStartOptions>,
) -> Value {
    let options = options.unwrap_or_default();
    match mirror::start(&app, &device_id, options, None).await {
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
