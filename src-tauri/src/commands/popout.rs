//! 采集回放「视频独立窗口」（真·OS 窗口，方案二）。
//!
//! 从主窗口把录屏分离到一个独立 webview 窗口（label = "capture-popout"），复用主 bundle 的
//! index.html 带 `?popout=capture` 区分入口。
//!
//! 初始化数据走「拉取式」而非事件握手：主窗开窗前 set_popout_session 把 {session, playheadMs} 存进
//! 后端交接箱，弹出窗挂载后 get_popout_session 主动拉——不依赖跨窗口 emit，杜绝「卡在正在连接、没视频」。
//!
//! 命令一律用**同步** fn：Tauri 同步命令在主线程执行，窗口创建/尺寸等操作要求主线程，async 会落到线程池上、部分平台 panic。

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const LABEL: &str = "capture-popout";
/// 窗口关闭通知（与前端 capturePopout.ts 的 POPOUT_EVENTS.closed 同名）：主窗收到后恢复内嵌布局。
const CLOSED_EVENT: &str = "capture-popout-closed";
const DEFAULT_W: f64 = 880.0;
const DEFAULT_H: f64 = 560.0;

/// 弹出窗初始化数据的「交接箱」（拉取式）：主窗开窗前存入 {session, playheadMs}，弹出窗挂载后拉取。
#[derive(Default)]
pub struct PopoutSessionState(pub Mutex<Option<Value>>);

/// 主窗 → 后端：开窗前存入本次要回放的会话 + 当前播放头（PopoutInit 结构）。
#[tauri::command]
pub fn set_popout_session(state: tauri::State<PopoutSessionState>, payload: Value) -> Value {
    if let Ok(mut slot) = state.0.lock() {
        *slot = Some(payload);
    }
    json!({ "success": true, "data": null })
}

/// 弹出窗 → 后端：拉取已存的初始化数据（无则返回 null，弹出窗据此显示「正在连接…」+ 关闭按钮）。
#[tauri::command]
pub fn get_popout_session(state: tauri::State<PopoutSessionState>) -> Value {
    let data = state.0.lock().ok().and_then(|slot| slot.clone());
    json!({ "success": true, "data": data })
}

/// 打开（或聚焦已存在的）视频独立窗口。
#[tauri::command]
pub fn open_capture_popout(app: AppHandle) -> Value {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return json!({ "success": true, "data": null });
    }
    // 用 hash(#popout=capture) 而非 query(?popout=capture)：hash 不参与资源解析，dev/release 都不会因查询串导致 bundle 加载失败/空白窗。
    match WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#popout=capture".into()))
        .title("采集回放 · 视频")
        .inner_size(DEFAULT_W, DEFAULT_H)
        .min_inner_size(320.0, 200.0)
        .build()
    {
        Ok(win) => {
            // 窗口被销毁（用户点 X / 程序关闭）时通知主窗恢复内嵌——比前端 beforeunload 可靠。
            let app2 = app.clone();
            win.on_window_event(move |ev| {
                if matches!(ev, WindowEvent::Destroyed) {
                    let _ = app2.emit(CLOSED_EVENT, ());
                }
            });
            json!({ "success": true, "data": null })
        }
        Err(e) => json!({ "success": false, "error": e.to_string() }),
    }
}

/// 关闭视频独立窗口（恢复回内嵌时调用）。
#[tauri::command]
pub fn close_capture_popout(app: AppHandle) -> Value {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
    json!({ "success": true, "data": null })
}
