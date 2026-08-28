//! 设备控制（息屏/唤醒/解锁/重启/PICO 大空间）+ 本机文件定位（打开所在文件夹/打开路径）。
//! 对应原 ADBManager 的设备控制能力与本机 opener。
//! 命令名 = 渲染层方法名 snake_case。

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::adb::binary;
use crate::adb::error::classify_adb_error;
use crate::adb::manager::{exec_adb, exec_adb_capture};
use crate::adb::scrcpy::parse_screen_size;

const PICO_TOB_SERVICE_ACTION: &str = "com.pvr.tobservice.remoteservice";
const PICO_LARGE_SPACE_RETRIEVAL_PACKAGES: [&str; 2] =
    ["com.picoxr.blspace", "com.pvr.seethrough.setting"];

fn adb_not_found() -> Value {
    classify_adb_error("enoent", &[]).to_result()
}

fn describe_or(stderr: &str, fallback: &str) -> String {
    let s = stderr.trim();
    if s.is_empty() { fallback.to_string() } else { s.to_string() }
}

/// 发一个 keyevent（息屏/唤醒共用）。
async fn send_keyevent(app: &AppHandle, device_id: &str, keycode: &str, fail_hint: &str) -> Value {
    let adb = match binary::resolve_adb_path(app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    match exec_adb_capture(&adb, &["-s", device_id, "shell", "input", "keyevent", keycode], 8000).await {
        Ok(out) if out.success => json!({ "success": true, "data": null }),
        Ok(out) => json!({ "success": false, "error": describe_or(&out.stderr, fail_hint) }),
        Err(e) => e.to_result(),
    }
}

/// 息屏：KEYCODE_SLEEP（只灭屏，不切换）。
#[tauri::command(rename_all = "camelCase")]
pub async fn sleep_device(app: AppHandle, device_id: String) -> Value {
    send_keyevent(&app, &device_id, "KEYCODE_SLEEP", "息屏失败").await
}

/// 唤醒：KEYCODE_WAKEUP（只亮屏，不切换）。
#[tauri::command(rename_all = "camelCase")]
pub async fn wake_device(app: AppHandle, device_id: String) -> Value {
    send_keyevent(&app, &device_id, "KEYCODE_WAKEUP", "唤醒失败").await
}

/// 解锁：先唤醒 → 读屏幕分辨率 → 从下往上滑动划开锁屏。
/// 无锁/滑动锁直接进桌面；有 PIN/密码/手势的会停在输入界面（需在设备上手动输入）。
#[tauri::command(rename_all = "camelCase")]
pub async fn unlock_device(app: AppHandle, device_id: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    // 1) 唤醒。
    if let Ok(out) = exec_adb_capture(&adb, &["-s", &device_id, "shell", "input", "keyevent", "KEYCODE_WAKEUP"], 8000).await {
        if !out.success {
            return json!({ "success": false, "error": describe_or(&out.stderr, "唤醒失败") });
        }
    }
    // 2) 取分辨率（失败回退 1080x1920）。
    let (w, h) = match exec_adb_capture(&adb, &["-s", &device_id, "shell", "wm", "size"], 8000).await {
        Ok(out) if out.success => parse_screen_size(&out.stdout).unwrap_or((1080, 1920)),
        _ => (1080, 1920),
    };
    // 3) 从下往上滑（x=宽/2，0.8高 → 0.2高，300ms）。
    let x = (w / 2).to_string();
    let start_y = (h * 4 / 5).to_string();
    let end_y = (h / 5).to_string();
    match exec_adb_capture(
        &adb,
        &["-s", &device_id, "shell", "input", "swipe", &x, &start_y, &x, &end_y, "300"],
        8000,
    )
    .await
    {
        Ok(out) if out.success => json!({ "success": true, "data": null }),
        Ok(out) => json!({ "success": false, "error": describe_or(&out.stderr, "解锁失败") }),
        Err(e) => e.to_result(),
    }
}

/// `adb reboot` 后设备会断连，adb 可能返回非零或报「closed/offline」——这类属重启的预期断连，视为成功。
fn is_expected_reboot_disconnect(stdout: &str, stderr: &str) -> bool {
    let combined = format!("{stdout} {stderr}").to_lowercase();
    ["closed", "offline", "device offline", "no devices", "device not found", "connection reset"]
        .iter()
        .any(|m| combined.contains(m))
}

/// 重启设备：`adb reboot`，exit 0 或重启预期断连均算成功。
#[tauri::command(rename_all = "camelCase")]
pub async fn reboot_device(app: AppHandle, device_id: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    match exec_adb_capture(&adb, &["-s", &device_id, "reboot"], 8000).await {
        Ok(out) if out.success || is_expected_reboot_disconnect(&out.stdout, &out.stderr) => {
            json!({ "success": true, "data": null })
        }
        Ok(out) => json!({ "success": false, "error": describe_or(&out.stderr, "重启失败，请确认设备在线且调试授权有效") }),
        // 子进程层面的「设备断连」错误同样视为重启预期内。
        Err(e) if is_expected_reboot_disconnect("", &e.message) => json!({ "success": true, "data": null }),
        Err(e) => e.to_result(),
    }
}

fn pico_large_space_adb_args(device_id: &str) -> [&str; 13] {
    [
        "-s",
        device_id,
        "shell",
        "am",
        "startservice",
        "-a",
        PICO_TOB_SERVICE_ACTION,
        "-e",
        "act",
        "switch_ls",
        "-e",
        "switch",
        "off",
    ]
}

fn pico_force_stop_package_adb_args<'a>(device_id: &'a str, package: &'a str) -> [&'a str; 6] {
    ["-s", device_id, "shell", "am", "force-stop", package]
}

/// 通过 PICO ToBService 关闭大空间模式。仅由前端识别为 PICO 的设备卡片暴露入口。
/// 找回期间会依次出现 LSpace 和安全边界设置两层界面：先请求关闭，再停止两层界面，
/// 最后再次请求关闭，以清除界面切换竞态期间可能回写的 Guardian 状态。
#[tauri::command(rename_all = "camelCase")]
pub async fn close_pico_large_space(app: AppHandle, device_id: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };

    if let Err(e) = exec_adb(&adb, &pico_large_space_adb_args(&device_id), 10_000).await {
        return e.to_result();
    }

    for package in PICO_LARGE_SPACE_RETRIEVAL_PACKAGES {
        if let Err(e) = exec_adb(
            &adb,
            &pico_force_stop_package_adb_args(&device_id, package),
            8_000,
        )
        .await
        {
            return e.to_result();
        }
    }

    match exec_adb(&adb, &pico_large_space_adb_args(&device_id), 10_000).await {
        Ok(_) => json!({ "success": true, "data": null }),
        Err(e) => e.to_result(),
    }
}

/// 在系统文件管理器中定位并选中本机文件（导出/下载后「打开所在文件夹」）。
#[tauri::command(rename_all = "camelCase")]
pub async fn show_item_in_folder(app: AppHandle, local_path: String) -> Value {
    match app.opener().reveal_item_in_dir(&local_path) {
        Ok(()) => json!({ "success": true, "data": null }),
        Err(e) => json!({ "success": false, "error": format!("打开所在文件夹失败：{e}") }),
    }
}

/// 用系统默认方式打开本机路径（文件夹用资源管理器，文件用默认程序）。
#[tauri::command(rename_all = "camelCase")]
pub async fn open_path(app: AppHandle, target_path: String) -> Value {
    match app.opener().open_path(&target_path, None::<&str>) {
        Ok(()) => json!({ "success": true, "data": null }),
        Err(e) => json!({ "success": false, "error": format!("打开路径失败：{e}") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reboot_disconnect_recognized() {
        assert!(is_expected_reboot_disconnect("", "error: closed"));
        assert!(is_expected_reboot_disconnect("", "device offline"));
        assert!(is_expected_reboot_disconnect("", "adb: no devices/emulators found"));
        assert!(!is_expected_reboot_disconnect("", "permission denied"));
        assert!(!is_expected_reboot_disconnect("", ""));
    }

    #[test]
    fn pico_large_space_command_stops_both_retrieval_interfaces() {
        assert_eq!(
            PICO_LARGE_SPACE_RETRIEVAL_PACKAGES,
            ["com.picoxr.blspace", "com.pvr.seethrough.setting"]
        );
        assert_eq!(
            pico_force_stop_package_adb_args("pico-serial", "com.picoxr.blspace"),
            [
                "-s",
                "pico-serial",
                "shell",
                "am",
                "force-stop",
                "com.picoxr.blspace",
            ]
        );
        assert_eq!(
            pico_force_stop_package_adb_args("pico-serial", "com.pvr.seethrough.setting"),
            [
                "-s",
                "pico-serial",
                "shell",
                "am",
                "force-stop",
                "com.pvr.seethrough.setting",
            ]
        );
    }

    #[test]
    fn pico_large_space_command_routes_through_tob_service() {
        assert_eq!(
            pico_large_space_adb_args("pico-serial"),
            [
                "-s",
                "pico-serial",
                "shell",
                "am",
                "startservice",
                "-a",
                "com.pvr.tobservice.remoteservice",
                "-e",
                "act",
                "switch_ls",
                "-e",
                "switch",
                "off",
            ]
        );
    }
}
