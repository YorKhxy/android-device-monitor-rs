//! 传输中止（用户手动「中止」按钮）：按进度通道 id（uploadId/pullId/transferId）注册取消句柄，
//! 命令层 `cancel_transfer` 请求取消，runner 在文件间检查 `is_cancelled` 跳出、文件内经 `Notify` 即时唤醒
//! select 丢弃 adb 子进程（配合 exec 的 kill_on_drop 真正杀掉传输进程，实现大文件中途也能立刻停）。
//!
//! 生命周期：runner 开传输 `register` → 传输结束（正常/中止）`unregister`。注册表只在传输进行期间有条目。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::Notify;

struct Entry {
    notify: Arc<Notify>,
    cancelled: bool,
}

fn registry() -> &'static Mutex<HashMap<String, Entry>> {
    static R: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 传输开始时注册，返回该 id 的取消通知句柄（runner 在 select 中 await 它实现文件内即时中止）。
pub fn register(id: &str) -> Arc<Notify> {
    let n = Arc::new(Notify::new());
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.to_string(), Entry { notify: n.clone(), cancelled: false });
    n
}

/// 传输结束（正常跑完或中止后）注销，清掉注册表条目。
pub fn unregister(id: &str) {
    registry().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

/// 请求取消：置 cancelled 标志（文件间检查用）并唤醒 select 中的 notified()（文件内即时中止用）。
/// id 不存在（传输已结束）则无操作。
pub fn request(id: &str) {
    if let Some(e) = registry().lock().unwrap_or_else(|e| e.into_inner()).get_mut(id) {
        e.cancelled = true;
        e.notify.notify_waiters();
    }
}

/// 是否已被请求取消——runner 在每个文件开始前检查，已取消则不再起新文件。
pub fn is_cancelled(id: &str) -> bool {
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .map(|e| e.cancelled)
        .unwrap_or(false)
}
