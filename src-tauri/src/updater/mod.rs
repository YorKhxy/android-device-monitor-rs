//! 热更客户端（T6.2，对应原 autoUpdate.ts）：基于 tauri-plugin-updater 2.x。
//!
//! 行为对齐原版：**手动触发**（用户点「检查更新」）、**静默装**（NSIS passive，见 tauri.conf updater.windows.installMode）、
//! **应用内更新日志**（latest.json 的 notes → UpdateStatus.releaseNotes）。
//! 状态经 `update_status` event 推前端（UpdateStatus 形状），`get_update_status` 返回最近一次缓存。
//!
//! 流程：check_for_update → download_update → quit_and_install_update 三步手动推进；
//! check 拿到的 Update 与下载的字节缓存在模块内，供后续 download/install 复用。

use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// check 拿到的待处理更新（download/install 复用）。
fn pending_update() -> &'static Mutex<Option<Update>> {
    static U: OnceLock<Mutex<Option<Update>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(None))
}

/// 已下载的安装包字节（download 后缓存，install 时消费）。
fn downloaded_bytes() -> &'static Mutex<Option<Vec<u8>>> {
    static B: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(None))
}

/// 最近一次 UpdateStatus（get_update_status 返回）。
fn cached_status() -> &'static Mutex<Option<Value>> {
    static S: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// 从 update-config.json 读取 {"url":"..."}（文件不存在/损坏/url 空 → None）。
fn read_config_url(p: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(str::to_string))
        .filter(|s| !s.trim().is_empty())
}

/// 规范化为 latest.json 地址：填完整 latest.json URL 原样用，填基址（如 http://192.168.1.60:8384）自动补 /latest.json。
fn normalize_endpoint(raw: &str) -> String {
    let base = raw.trim().trim_end_matches('/');
    if base.to_lowercase().ends_with(".json") {
        base.to_string()
    } else {
        format!("{base}/latest.json")
    }
}

/// 解析更新服务器地址（对齐老工具可配置 feed：避免写死 127.0.0.1 在别的机器上找不到服务器）。优先级：
/// ① 环境变量 ADM_UPDATE_FEED_URL ② exe 同目录 update-config.json（运维手动覆盖，不重打包就能改服务器）
/// ③ 资源目录 update-config.json（随安装包/热更落地的内置默认）④ None → 用 tauri.conf 内置 endpoint（127.0.0.1，仅本机）。
fn resolve_endpoint(app: &AppHandle) -> Option<String> {
    if let Ok(v) = std::env::var("ADM_UPDATE_FEED_URL") {
        if !v.trim().is_empty() {
            return Some(normalize_endpoint(&v));
        }
    }
    let runtime_cfg = crate::runtime_root::resolve_runtime_app_root().join("update-config.json");
    if let Some(u) = read_config_url(&runtime_cfg) {
        return Some(normalize_endpoint(&u));
    }
    if let Ok(dir) = app.path().resource_dir() {
        if let Some(u) = read_config_url(&dir.join("update-config.json")) {
            return Some(normalize_endpoint(&u));
        }
    }
    None
}

/// 构造 updater：有可配置 endpoint（环境变量 / exe 同目录 / 资源目录的 update-config.json）就用它，
/// 否则用打包内置 endpoint（tauri.conf 的 127.0.0.1，仅本机测试用）。
fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    match resolve_endpoint(app) {
        Some(ep) => {
            let url = url::Url::parse(&ep).map_err(|e| format!("更新地址非法（{ep}）：{e}"))?;
            app.updater_builder()
                .endpoints(vec![url])
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())
        }
        None => app.updater().map_err(|e| e.to_string()),
    }
}

/// 把「当前运行 exe 所在目录」钉进 NSIS 安装位置注册表键,确保热更永远装回**你正在运行的目录**,
/// 杜绝因历史 perMachine/currentUser 安装把注册表值指到别处(C:\LOCALAPPDATA)而「热更跑到 C 盘装」。
///
/// 根因:NSIS passive 静默更新没有目录选择页,安装目标 `$INSTDIR` 完全由
/// `HKCU\Software\androidtool\<产品名>` 的默认值决定(installer.nsi 的 `RestorePreviousInstallLocation`)。
/// 这个值跟你实际启动的 exe 位置可能脱钩 → 看着像「版本回退 / 装到 C 盘」。每次启动用真实 exe 目录覆盖它
/// = 自愈:点更新前注册表已 = 当前实例所在目录,热更必然装回原路径。**不是改 installMode 能解决的,本质是安装状态。**
///
/// 产品名常量须与 tauri.conf.json `productName` / NSIS `PRODUCTNAME` 完全一致(改名时同步)。
#[cfg(windows)]
fn pin_install_dir_to_registry() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const KEY: &str = r"HKCU\Software\androidtool\安卓设备监控rs版";
    let dir = match std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
    {
        Some(d) => d,
        None => return,
    };
    let dir_str = dir.to_string_lossy().to_string();
    // /ve 写默认(未命名)值,/f 免确认;CREATE_NO_WINDOW(0x0800_0000)避免弹黑框。
    // Command 经 CreateProcessW 以宽字符传参,中文产品名键名不受 cmd/GBK 影响(区别于 .bat 内容)。
    let _ = Command::new("reg")
        .args(["add", KEY, "/ve", "/d", &dir_str, "/f"])
        .creation_flags(0x0800_0000)
        .output();
}

#[cfg(not(windows))]
fn pin_install_dir_to_registry() {}

/// 启动时调用:把安装位置钉回当前 exe 目录(详见 [`pin_install_dir_to_registry`])。
/// 仅 release 启动时被调(lib.rs 里 `#[cfg(not(debug_assertions))]`)，debug 构建无调用方 → 允许 dead_code。
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn ensure_install_dir_pinned() {
    pin_install_dir_to_registry();
}

/// 写缓存 + 经 update_status event 推前端。
fn emit_status(app: &AppHandle, status: Value) {
    if let Ok(mut s) = cached_status().lock() {
        *s = Some(status.clone());
    }
    let _ = app.emit("update_status", status);
}

/// dev(debug)构建禁用热更:dev 跑的是 target/debug 产物，既没更新端点、也不该把开发产物当可热更的安装。
/// 命中则推 `disabled` 状态给前端提示并返回 true 让调用方早退;release 构建恒为 false，零开销。
fn updates_disabled_in_dev(app: &AppHandle) -> bool {
    if cfg!(debug_assertions) {
        emit_status(app, json!({ "state": "disabled" }));
        true
    } else {
        false
    }
}

/// 检查更新（手动触发）。有更新缓存 Update 并推 available + 更新日志；无更新推 not-available。
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Value {
    if updates_disabled_in_dev(&app) {
        return json!({ "success": false, "error": "开发(dev)模式下热更已禁用" });
    }
    emit_status(&app, json!({ "state": "checking" }));

    let updater = match build_updater(&app) {
        Ok(u) => u,
        Err(e) => {
            emit_status(&app, json!({ "state": "error", "error": e }));
            return json!({ "success": false, "error": "无法初始化更新检查" });
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone().unwrap_or_default();
            if let Ok(mut p) = pending_update().lock() {
                *p = Some(update);
            }
            emit_status(&app, json!({
                "state": "available",
                "version": version,
                "releaseNotes": notes,
            }));
            json!({ "success": true })
        }
        Ok(None) => {
            emit_status(&app, json!({ "state": "not-available" }));
            json!({ "success": true })
        }
        Err(e) => {
            emit_status(&app, json!({ "state": "error", "error": e.to_string() }));
            json!({ "success": false, "error": e.to_string() })
        }
    }
}

/// 返回最近一次更新状态（无则 null）。
#[tauri::command]
pub fn get_update_status() -> Value {
    let data = cached_status().lock().ok().and_then(|s| s.clone());
    json!({ "success": true, "data": data })
}

/// 下载更新包（静默，进度经 update_status percent 推送）。下好缓存字节、推 downloaded 待重启安装。
#[tauri::command]
pub async fn download_update(app: AppHandle) -> Value {
    if updates_disabled_in_dev(&app) {
        return json!({ "success": false, "error": "开发(dev)模式下热更已禁用" });
    }
    // 取出待处理 Update（不跨 await 持锁）。
    let update = match pending_update().lock().ok().and_then(|mut p| p.take()) {
        Some(u) => u,
        None => return json!({ "success": false, "error": "没有可下载的更新，请先检查更新" }),
    };
    let version = update.version.clone();
    emit_status(&app, json!({ "state": "downloading", "version": version, "percent": 0 }));

    // 进度回调：累计已下/总长算百分比，经 event 推送。
    let app_cb = app.clone();
    let ver_cb = version.clone();
    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let downloaded_cb = downloaded.clone();
    let result = update
        .download(
            move |chunk_len: usize, content_len: Option<u64>| {
                let got = downloaded_cb.fetch_add(chunk_len as u64, std::sync::atomic::Ordering::Relaxed)
                    + chunk_len as u64;
                let percent = content_len
                    .filter(|t| *t > 0)
                    .map(|t| ((got * 100) / t).min(100))
                    .unwrap_or(0);
                emit_status(&app_cb, json!({
                    "state": "downloading",
                    "version": ver_cb,
                    "percent": percent,
                }));
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            if let Ok(mut b) = downloaded_bytes().lock() {
                *b = Some(bytes);
            }
            if let Ok(mut p) = pending_update().lock() {
                *p = Some(update); // 放回供 install 复用。
            }
            emit_status(&app, json!({ "state": "downloaded", "version": version }));
            json!({ "success": true })
        }
        Err(e) => {
            if let Ok(mut p) = pending_update().lock() {
                *p = Some(update); // 失败也放回，允许重试。
            }
            emit_status(&app, json!({ "state": "error", "error": e.to_string() }));
            json!({ "success": false, "error": e.to_string() })
        }
    }
}

/// 安装已下载的更新并重启（静默装）。
#[tauri::command]
pub fn quit_and_install_update(app: AppHandle) -> Value {
    if updates_disabled_in_dev(&app) {
        return json!({ "success": false, "error": "开发(dev)模式下热更已禁用" });
    }
    let update = pending_update().lock().ok().and_then(|mut p| p.take());
    let bytes = downloaded_bytes().lock().ok().and_then(|mut b| b.take());
    // 安装前停掉本地 adb server：app 此刻仍在运行，bundled adb.exe 还锁着安装目录里的 AdbWinApi.dll，
    // NSIS 覆盖该 DLL 会撞 os error 32（覆盖失败 / 留旧文件）。先 kill-server 释放占用再装。
    if let Some(adb) = crate::adb::binary::resolve_adb_path(&app) {
        tauri::async_runtime::block_on(crate::adb::manager::kill_server(&adb));
    }
    match (update, bytes) {
        (Some(update), Some(bytes)) => match update.install(bytes) {
            Ok(()) => {
                app.restart(); // 重启进程加载新版（diverges）。
            }
            Err(e) => json!({ "success": false, "error": e.to_string() }),
        },
        _ => json!({ "success": false, "error": "请先下载更新" }),
    }
}

/// 应用内「本版本更新日志」（点版本号查看）：优先读**打进安装包的 release-notes.md**（resource_dir）——
/// 它是**当前已安装版本**的说明，无论是否有新版本都能看；读不到再退回最近一次检查更新缓存的 releaseNotes
/// （即 feed 里「可用新版本」的说明）。修复点：旧实现只读缓存，更新到最新版后没有可用更新 → 缓存为空 → 显示「暂无」。
#[tauri::command]
pub fn get_release_notes(app: AppHandle) -> Value {
    // ① 打进包的本版本说明。
    if let Ok(dir) = app.path().resource_dir() {
        if let Ok(s) = std::fs::read_to_string(dir.join("release-notes.md")) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return json!({ "success": true, "data": trimmed });
            }
        }
    }
    // ② 兜底：最近一次检查到的「可用新版本」说明。
    let notes = cached_status()
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .and_then(|v| v.get("releaseNotes").and_then(|n| n.as_str()).map(str::to_string))
        .unwrap_or_default();
    json!({ "success": true, "data": notes })
}
