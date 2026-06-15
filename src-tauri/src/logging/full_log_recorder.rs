//! 完整日志录制器（T4-5，对应原 fullLogRecorder.ts）：logcat 开流起，把**每条原始行**（过滤前、全等级）
//! tee 落 **exe 同目录 `device-logs/`**（铁律，`runtime_root::device_logs_dir`）。
//!
//! 「从监控第一行到当前」语义：每次 `begin`（= logcat 开流）truncate 重建该设备日志文件。
//! id 比对：stop→restart 时旧 reader 任务的收尾（`end`）可能晚于新 `begin`，用 entry_id 比对避免误关新会话写入
//! （与 `adb/logcat_stream` 同一防竞态范式）。同步 std 文件 IO，锁不跨 await。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::runtime_root::device_logs_dir;

struct Recorder {
    id: u64, // 本次录制会话身份；append/flush/end 比对，防 stop/restart 竞态误写。
    writer: BufWriter<File>,
}

fn recorders() -> &'static Mutex<HashMap<String, Recorder>> {
    static R: OnceLock<Mutex<HashMap<String, Recorder>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// deviceId 净化为合法文件名：WiFi 设备 id 含 `:`（如 `192.168.1.5:5555`）等在 Windows 非法，统一替换。
fn sanitize(device_id: &str) -> String {
    device_id
        .chars()
        .map(|c| if matches!(c, ':' | '/' | '\\' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect()
}

/// 某设备完整日志的落盘路径：device-logs/{sanitized}.log。
pub fn log_path(device_id: &str) -> PathBuf {
    device_logs_dir().join(format!("{}.log", sanitize(device_id)))
}

/// 开始录制：建 device-logs/ 目录，登记 writer。失败返回 Err（调用方记录但不阻断抓取）。
/// `append=false`（用户主动开抓）→ truncate 重建文件「从监控第一行」；
/// `append=true`（断流自动重连续抓）→ 追加写，保留断流前已落盘内容、不丢。
pub fn begin(device_id: &str, id: u64, append: bool) -> std::io::Result<()> {
    let dir = device_logs_dir();
    std::fs::create_dir_all(&dir)?;
    let path = log_path(device_id);
    let file = if append {
        std::fs::OpenOptions::new().create(true).append(true).open(&path)?
    } else {
        File::create(&path)? // create = truncate 已存在。
    };
    if let Ok(mut map) = recorders().lock() {
        map.insert(device_id.to_string(), Recorder { id, writer: BufWriter::new(file) });
    }
    Ok(())
}

/// 追加一条原始行（自动补换行）。仅当登记的会话仍是本 id 时写入。
pub fn append(device_id: &str, id: u64, line: &str) {
    if let Ok(mut map) = recorders().lock() {
        if let Some(r) = map.get_mut(device_id) {
            if r.id == id {
                let _ = writeln!(r.writer, "{line}");
            }
        }
    }
}

/// 刷盘（定时调用，保证「导出完整日志」拿到最新内容）。
pub fn flush(device_id: &str, id: u64) {
    if let Ok(mut map) = recorders().lock() {
        if let Some(r) = map.get_mut(device_id) {
            if r.id == id {
                let _ = r.writer.flush();
            }
        }
    }
}

/// 刷当前登记的 writer（导出命令用，无需知道 entry_id；每设备至多一个 writer）。
pub fn flush_device(device_id: &str) {
    if let Ok(mut map) = recorders().lock() {
        if let Some(r) = map.get_mut(device_id) {
            let _ = r.writer.flush();
        }
    }
}

/// 结束录制（EOF / stop）：仅当登记的仍是本 id 时移除（BufWriter drop 时自动 flush）。
pub fn end(device_id: &str, id: u64) {
    if let Ok(mut map) = recorders().lock() {
        if map.get(device_id).map(|r| r.id) == Some(id) {
            map.remove(device_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_illegal_filename_chars() {
        assert_eq!(sanitize("3409746658000W2"), "3409746658000W2"); // USB 串号原样
        assert_eq!(sanitize("192.168.1.5:5555"), "192.168.1.5_5555"); // WiFi 冒号替换
        assert_eq!(sanitize("a/b\\c"), "a_b_c");
    }

    #[test]
    fn log_path_under_device_logs_dir() {
        let p = log_path("dev1");
        assert!(p.ends_with("dev1.log"));
        assert!(p.parent().unwrap().ends_with("device-logs"));
    }
}
