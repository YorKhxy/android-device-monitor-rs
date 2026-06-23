//! 应用管理命令（T2.1）：已安装应用列表 / 启动 / 强制停止 / 卸载。
//! 对应原 ADBManager.ts 的 listInstalledPackages / launchApp / forceStopApp / uninstallApp。
//! 命令名 = 渲染层方法名 snake_case；参数 rename_all="camelCase" 接收前端 camelCase。

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::adb::error::{classify_adb_error, AdbError};
use crate::adb::{binary, install, manager, scrcpy};

/// 已安装应用（带可读名）：scrcpy --list-apps 解析出的一项。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledApp {
    package: String,
    label: String,
    system: bool, // scrcpy 行首 `*`=系统应用，`-`=用户安装
}

/// 解析 scrcpy `--list-apps` 输出（走 stderr）：每行形如 ` * 应用名   com.x.y` / ` - 应用名   com.x.y`。
/// 应用名可含空格，包名是最后一个空白分隔 token；非「*/-」开头的日志行跳过。
fn parse_scrcpy_apps(text: &str) -> Vec<InstalledApp> {
    let mut apps = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let (system, body) = if let Some(b) = trimmed.strip_prefix("* ") {
            (true, b)
        } else if let Some(b) = trimmed.strip_prefix("- ") {
            (false, b)
        } else {
            continue;
        };
        let mut parts: Vec<&str> = body.split_whitespace().collect();
        let package = match parts.pop() {
            Some(p) => p,
            None => continue,
        };
        if !package.contains('.') {
            continue; // 不像包名 → 跳过（防混入噪声行）
        }
        apps.push(InstalledApp { package: package.to_string(), label: parts.join(" "), system });
    }
    apps
}

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

/// 读取设备上应用的可读名（label）：跑内置 `scrcpy --list-apps`（设备侧用 PackageManager 取 label，
/// 不需要 aapt/pull APK/root）。比 `pm list` 慢，前端按设备缓存、不每次刷新都跑。返回 [{package,label,system}]。
/// 钉 `ADB` 环境变量到内置 adb，避免 scrcpy 自带 adb 与本工具 server 互踢。
#[tauri::command(rename_all = "camelCase")]
pub async fn list_app_labels(app: AppHandle, device_id: String) -> Value {
    let scrcpy_path = match scrcpy::resolve_scrcpy_path(&app) {
        None => return json!({ "success": false, "error": "未找到内置 scrcpy，无法读取应用名" }),
        Some(p) => p,
    };
    let adb = binary::resolve_adb_path(&app);

    let mut cmd = Command::new(&scrcpy_path);
    cmd.arg("--list-apps")
        .arg("-s")
        .arg(&device_id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped()) // scrcpy 把应用清单打到 stdout（INFO 日志也在这；stderr 只有 adb push 进度）
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(a) = &adb {
        cmd.env("ADB", a);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW); // 隐藏 scrcpy 控制台黑窗
    }

    // --list-apps 要在设备侧逐个解析 label，较慢；给 90s 超时兜底。
    let out = match timeout(Duration::from_secs(90), cmd.output()).await {
        Err(_) => return json!({ "success": false, "error": "读取应用名超时（scrcpy --list-apps）" }),
        Ok(Err(e)) => return json!({ "success": false, "error": format!("启动 scrcpy 失败：{e}") }),
        Ok(Ok(o)) => o,
    };
    // 应用清单在 stdout；stderr 只有 adb push 进度。合并解析以防不同 scrcpy 版本路由差异。
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let apps = parse_scrcpy_apps(&text);
    if apps.is_empty() {
        // 没解析到应用 → 把 scrcpy 输出尾部带回前端诊断（adb 找不到 / 设备离线 / scrcpy 自身报错等）。
        let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join(" | ");
        return json!({ "success": false, "error": format!("scrcpy 未列出应用 | {tail}") });
    }
    json!({ "success": true, "data": apps })
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

/// 校验一批本地文件路径当前是否仍存在（APK 安装历史失效判定用，与 adb 无关，纯文件系统检查）。
/// 返回仍存在的路径子集；前端据此把缺失项置灰禁用。
#[tauri::command(rename_all = "camelCase")]
pub async fn check_files_exist(paths: Vec<String>) -> Value {
    let existing: Vec<String> = paths
        .into_iter()
        .filter(|p| std::path::Path::new(p).is_file())
        .collect();
    json!({ "success": true, "data": existing })
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
