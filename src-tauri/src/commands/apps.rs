//! 应用管理命令（T2.1）：已安装应用列表 / 启动 / 强制停止 / 卸载。
//! 对应原 ADBManager.ts 的 listInstalledPackages / launchApp / forceStopApp / uninstallApp。
//! 命令名 = 渲染层方法名 snake_case；参数 rename_all="camelCase" 接收前端 camelCase。

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::adb::binary;
use crate::adb::error::{classify_adb_error, AdbError};
use crate::adb::{install, manager};

fn adb_not_found() -> Value {
    classify_adb_error("enoent", &[]).to_result()
}

/// 校验包名（对齐原 assertValidPackageName 的 `^[A-Za-z][\w.]*$`：首字符字母，其余字母数字/下划线/点）。
fn validate_package(package: &str) -> Result<String, AdbError> {
    let cleaned = package.trim();
    let head_ok = cleaned
        .chars()
        .next()
        .map_or(false, |c| c.is_ascii_alphabetic());
    let body_ok = cleaned
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    if cleaned.is_empty() || !head_ok || !body_ok {
        return Err(AdbError::custom(
            "ADB_COMMAND_FAILED",
            format!("非法包名：{package}"),
            "请从进程/应用列表中选择一个有效的应用包名。",
            format!("Invalid package name: {package}"),
        ));
    }
    Ok(cleaned.to_string())
}

/// 合并 stdout/stderr 为单段文本（对齐原 `[stdout, stderr].filter(Boolean).join('\n').trim()`）。
fn combine(out: &manager::Captured) -> String {
    format!("{}\n{}", out.stdout.trim(), out.stderr.trim())
        .trim()
        .to_string()
}

/// 列出第三方（用户安装）应用包名。`pm list packages -3`，去重 + 排序。
#[tauri::command(rename_all = "camelCase")]
pub async fn list_installed_packages(app: AppHandle, device_id: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    match manager::exec_adb(
        &adb,
        &["-s", &device_id, "shell", "pm", "list", "packages", "-3"],
        30_000,
    )
    .await
    {
        Err(e) => e.to_result(),
        Ok(out) => {
            let mut packages: Vec<String> = out
                .stdout
                .lines()
                .map(|l| l.trim())
                .filter(|l| l.starts_with("package:"))
                .map(|l| l["package:".len()..].trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            packages.sort();
            packages.dedup();
            json!({ "success": true, "data": packages })
        }
    }
}

/// 启动应用：`monkey -p <pkg> -c android.intent.category.LAUNCHER 1`，判据 "Events injected: 1"。
#[tauri::command(rename_all = "camelCase")]
pub async fn launch_app(app: AppHandle, device_id: String, package_name: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let pkg = match validate_package(&package_name) {
        Err(e) => return e.to_result(),
        Ok(p) => p,
    };
    match manager::exec_adb_capture(
        &adb,
        &[
            "-s",
            &device_id,
            "shell",
            "monkey",
            "-p",
            &pkg,
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        ],
        15_000,
    )
    .await
    {
        Err(e) => e.to_result(),
        Ok(out) => {
            let output = combine(&out);
            // 折叠空白后判定，兼容 "Events injected:  1" 这类多空格输出。
            let collapsed = output
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            if collapsed.contains("events injected: 1") {
                json!({ "success": true, "data": output })
            } else {
                AdbError::custom(
                    "ADB_COMMAND_FAILED",
                    format!("启动应用失败：{pkg}"),
                    "该应用可能没有可启动的入口 Activity（如纯后台/服务类应用），或包名不存在。",
                    if output.is_empty() {
                        "monkey did not report an injected launcher event.".to_string()
                    } else {
                        output
                    },
                )
                .to_result()
            }
        }
    }
}

/// 强制停止应用：`am force-stop <pkg>`。
#[tauri::command(rename_all = "camelCase")]
pub async fn force_stop_app(app: AppHandle, device_id: String, package_name: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let pkg = match validate_package(&package_name) {
        Err(e) => return e.to_result(),
        Ok(p) => p,
    };
    match manager::exec_adb(
        &adb,
        &["-s", &device_id, "shell", "am", "force-stop", &pkg],
        10_000,
    )
    .await
    {
        Err(e) => e.to_result(),
        Ok(_) => json!({ "success": true }),
    }
}

/// 卸载应用：`adb uninstall <pkg>`，判据输出含 "Success"。
#[tauri::command(rename_all = "camelCase")]
pub async fn uninstall_app(app: AppHandle, device_id: String, package_name: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    // 卸载的非法包名文案沿用原版 uninstallApp（与 launch/force-stop 的通用文案略异）。
    let pkg = match validate_package(&package_name) {
        Err(_) => {
            return AdbError::custom(
                "ADB_COMMAND_FAILED",
                format!("卸载失败：非法包名 {package_name}"),
                "请从进程/应用列表中选择一个有效的应用包名。",
                format!("Invalid package name: {package_name}"),
            )
            .to_result()
        }
        Ok(p) => p,
    };
    match manager::exec_adb_capture(&adb, &["-s", &device_id, "uninstall", &pkg], 60_000).await {
        Err(e) => e.to_result(),
        Ok(out) => {
            let output = combine(&out);
            if output.to_lowercase().contains("success") {
                json!({ "success": true, "data": output })
            } else {
                AdbError::custom(
                    "ADB_COMMAND_FAILED",
                    format!("卸载应用失败：{pkg}"),
                    "请确认该应用存在且非受保护的系统应用，部分预装应用无法卸载。",
                    if output.is_empty() {
                        "adb uninstall did not report success.".to_string()
                    } else {
                        output
                    },
                )
                .to_result()
            }
        }
    }
}

/// install_apk 的选项（前端传 { allowDowngrade }）。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    #[serde(default)]
    allow_downgrade: bool,
}

/// 安装单个 APK（`-r`，allowDowngrade 时叠 `-d`）。多 APK×多设备并行在前端编排。
#[tauri::command(rename_all = "camelCase")]
pub async fn install_apk(
    app: AppHandle,
    device_id: String,
    apk_path: String,
    options: Option<InstallOptions>,
    install_id: Option<String>,
) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let allow_downgrade = options.unwrap_or_default().allow_downgrade;
    // 进度通道 id：前端传则用（多设备并行各自唯一），缺省退化为空（仍可装，只是无 per-item 进度）。
    let install_id = install_id.unwrap_or_default();
    match install::install_apk(&app, &adb, &device_id, &apk_path, allow_downgrade, &install_id).await {
        // data 形状对齐前端消费 result.data.output 与原版 ApkInstallResult { apkPath, output }。
        Ok(output) => json!({ "success": true, "data": { "apkPath": apk_path, "output": output } }),
        // 用户中断：标 cancelled 让前端显示「已中断」而非红色失败。
        Err(e) if e.code == install::INSTALL_CANCELLED_CODE => {
            json!({ "success": false, "cancelled": true, "error": e.message })
        }
        Err(e) => e.to_result(),
    }
}

/// 中断指定 install_id 的安装（前端「中断」按钮）。id 不存在（已结束）则无操作。
#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_install(install_id: String) -> Value {
    install::cancel_request(&install_id);
    json!({ "success": true })
}

/// 判定「设备里是否已装有与这些待装 APK 内容完全一致的应用」。返回命中项 [{ apkPath, package }]。
/// 用于安装前提示「设备上已存在一模一样的应用」。best-effort：查不动一律返回空，不阻断安装。
#[tauri::command(rename_all = "camelCase")]
pub async fn check_apks_on_device(app: AppHandle, device_id: String, apk_paths: Vec<String>) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let matches = install::check_apks_identical(&adb, &device_id, &apk_paths).await;
    json!({ "success": true, "data": matches })
}

/// 弹原生多选文件对话框选 APK（.apk 过滤）。取消 → 空数组（对齐原版 canceled）。
#[tauri::command]
pub async fn select_apk_files(app: AppHandle) -> Value {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择安装包")
        .add_filter("Android 安装包", &["apk"])
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });
    match rx.await {
        Ok(Some(paths)) => {
            let list: Vec<String> = paths
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            json!({ "success": true, "data": list })
        }
        _ => json!({ "success": true, "data": [] }),
    }
}
