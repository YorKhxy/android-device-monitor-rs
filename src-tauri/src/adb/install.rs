//! APK 安装执行 + 失败分类（对应原 ADBManager.installApk / shouldRetryInstallWithoutStreaming /
//! classifyInstallFailure）。单次安装一台设备一个 APK；多 APK×多设备并行/限流/队列在前端编排。

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use super::error::AdbError;
use super::manager::{exec_adb_capture, Captured};

const INSTALL_TIMEOUT_MS: u64 = 10 * 60 * 1000;

/// 安装中止的特定错误码：命令层据此把结果标成「已中断」而非「失败」。
pub const INSTALL_CANCELLED_CODE: &str = "ADB_INSTALL_CANCELLED";

// —— 安装中止注册表（与 transfer::cancel 同范式）：按 install_id 注册 Notify + cancelled 标志。
// cancel_install 命令请求取消；install_apk 在 push 轮询 / pm install 的 select 中 await Notify 即时中断，
// 配合 exec_adb_capture 的 kill_on_drop 真正杀掉 adb 子进程。注册表只在安装进行期间有条目。
struct CancelEntry {
    notify: Arc<Notify>,
    cancelled: bool,
}

fn cancel_registry() -> &'static Mutex<HashMap<String, CancelEntry>> {
    static R: OnceLock<Mutex<HashMap<String, CancelEntry>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancel_register(id: &str) -> Arc<Notify> {
    let n = Arc::new(Notify::new());
    cancel_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.to_string(), CancelEntry { notify: n.clone(), cancelled: false });
    n
}

fn cancel_unregister(id: &str) {
    cancel_registry().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

/// 请求中止某次安装（命令层 cancel_install 调用）。置 cancelled 标志 + 唤醒 select 中的 notified()。
pub fn cancel_request(id: &str) {
    if let Some(e) = cancel_registry().lock().unwrap_or_else(|e| e.into_inner()).get_mut(id) {
        e.cancelled = true;
        e.notify.notify_waiters();
    }
}

/// 已被请求取消？（轮询兜底：Notify 的边沿唤醒若错过窗口，由本标志在下一拍补上。）
fn is_cancelled(id: &str) -> bool {
    cancel_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .map(|e| e.cancelled)
        .unwrap_or(false)
}

/// 永不完成的 future：notify 为 None（未注册取消）时占位，使 select 的取消分支静默失效。
async fn never() {
    std::future::pending::<()>().await
}

/// 流式算文件 SHA-256（64KiB 缓冲，避免大 APK 一次性读入内存）。返回十六进制小写串。
fn sha256_file(path: &str) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 「设备上已存在与待装 APK 内容完全相同的应用」的命中项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApkIdentityMatch {
    pub apk_path: String, // 待装的本地 APK 路径（回填前端用）
    pub package: String,  // 设备上内容相同的那个应用包名
}

/// 设备端某第三方应用的 base.apk 摘要（包名 / 字节大小 / 路径）。
struct DeviceApk {
    pkg: String,
    size: u64,
    path: String,
}

/// 判定「设备里是否已装有与这些 APK 内容一模一样的应用」。
///
/// 原理：Android 把单 APK 安装的**原始字节原样**存为 `/data/app/.../base.apk`，故设备上 base.apk 的
/// sha256 == 源 APK 的 sha256。做法（不依赖 aapt、不解析包名）：
///   ① 一次设备扫描列出第三方 base.apk 的 (包名,大小,路径)；
///   ② **先按大小过滤**（秒级，通常只剩 0~1 个候选），只对大小相同者跑 `sha256sum`；
///   ③ 与本地 APK 的 sha256 比对，命中即「内容完全相同」。
/// best-effort：设备无 sha256sum/路径不可读等一律视作「无命中」，不阻断安装。
pub async fn check_apks_identical(
    adb: &Path,
    device_id: &str,
    apk_paths: &[String],
) -> Vec<ApkIdentityMatch> {
    // 本地每个 APK 的字节大小（拿不到的跳过）。
    let local_sizes: Vec<(usize, u64)> = apk_paths
        .iter()
        .enumerate()
        .filter_map(|(i, p)| std::fs::metadata(p.trim()).ok().map(|m| (i, m.len())))
        .collect();
    if local_sizes.is_empty() {
        return Vec::new();
    }

    // ① 设备扫描：第三方应用的 base.apk → "包名|大小|路径"。
    let script = r#"for p in $(pm list packages -3 | sed 's/package://'); do ap=$(pm path "$p" 2>/dev/null | grep base.apk | head -1 | sed 's/package://'); [ -n "$ap" ] && echo "$p|$(stat -c %s "$ap" 2>/dev/null)|$ap"; done"#;
    let listed = match exec_adb_capture(adb, &["-s", device_id, "shell", script], 60_000).await {
        Ok(o) if o.success => o.stdout,
        _ => return Vec::new(),
    };
    let devices: Vec<DeviceApk> = listed
        .lines()
        .filter_map(|l| {
            let parts: Vec<&str> = l.trim().splitn(3, '|').collect();
            if parts.len() == 3 {
                let size = parts[1].trim().parse::<u64>().ok()?;
                Some(DeviceApk { pkg: parts[0].trim().to_string(), size, path: parts[2].trim().to_string() })
            } else {
                None
            }
        })
        .collect();
    if devices.is_empty() {
        return Vec::new();
    }

    // ② 收集「大小命中」的设备候选路径，一次性 sha256sum（仅对少数候选算哈希）。
    let mut cand_paths: Vec<String> = Vec::new();
    for (_, size) in &local_sizes {
        for d in &devices {
            if d.size == *size && !cand_paths.contains(&d.path) {
                cand_paths.push(d.path.clone());
            }
        }
    }
    if cand_paths.is_empty() {
        return Vec::new();
    }
    let mut sha_args: Vec<&str> = vec!["-s", device_id, "shell", "sha256sum"];
    for p in &cand_paths {
        sha_args.push(p.as_str());
    }
    let sha_out = match exec_adb_capture(adb, &sha_args, 180_000).await {
        Ok(o) => o.stdout,
        Err(_) => return Vec::new(),
    };
    // sha256sum 输出每行 "<hash>  <path>"。
    let mut dev_hash: HashMap<String, String> = HashMap::new();
    for line in sha_out.lines() {
        let line = line.trim();
        if let Some((h, p)) = line.split_once(char::is_whitespace) {
            dev_hash.insert(p.trim().to_string(), h.trim().to_string());
        }
    }

    // ③ 仅对「有大小候选」的本地 APK 算其 sha256（放阻塞线程池），与设备候选哈希比对。
    let mut matches: Vec<ApkIdentityMatch> = Vec::new();
    for (i, size) in &local_sizes {
        let cands: Vec<&DeviceApk> = devices.iter().filter(|d| d.size == *size).collect();
        if cands.is_empty() {
            continue;
        }
        let path = apk_paths[*i].trim().to_string();
        let local_hash = match tokio::task::spawn_blocking(move || sha256_file(&path)).await {
            Ok(Ok(h)) => h,
            _ => continue,
        };
        for d in cands {
            if dev_hash.get(&d.path).map(|h| h.eq_ignore_ascii_case(&local_hash)).unwrap_or(false) {
                matches.push(ApkIdentityMatch { apk_path: apk_paths[*i].clone(), package: d.pkg.clone() });
                break;
            }
        }
    }
    matches
}

/// 安装实时进度（推送占 0-85%、pm install 占 85-100%）。经 install_progress event 推前端进度条。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    install_id: String,
    percent: u32,
    phase: String, // "pushing" | "installing"
}

fn emit_progress(app: &AppHandle, install_id: &str, percent: u32, phase: &str) {
    let _ = app.emit(
        "install_progress",
        InstallProgress { install_id: install_id.to_string(), percent, phase: phase.to_string() },
    );
}

/// 仅保留字母数字与连字符，作设备端临时文件名片段——install_id 来自前端，防混入空格/元字符破坏 shell 命令。
fn safe_id(install_id: &str) -> String {
    let s: String = install_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    if s.is_empty() { "x".to_string() } else { s }
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("内置正则应当合法"))
}

fn combine(out: &Captured) -> String {
    format!("{}\n{}", out.stdout.trim(), out.stderr.trim())
        .trim()
        .to_string()
}

fn is_success(output: &str) -> bool {
    output.to_lowercase().contains("success")
}

/// APK 路径的文件名（basename），失败时回退原串。
fn basename(apk_path: &str) -> String {
    Path::new(apk_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| apk_path.to_string())
}

/// 安装一个 APK 到一台设备，**带真实进度**。成功返回 pm 输出；失败返回分类后的 AdbError。
///
/// 做法（超过老工具的「adb install 一把跑完无进度」）：
///   ① adb push 到设备临时目录 `/data/local/tmp/adm-install-<id>.apk`，期间每 400ms 轮询设备端已写字节算实时
///      百分比（占 0-85%，大 APK 的耗时主要在这一段，与文件上传同款轮询）；
///   ② `adb shell pm install -r [-d] <临时路径>` 真正安装（占 85-100%）；③ 删临时文件。
/// 不再走流式 `adb install`，自然规避原 `--no-streaming` 退避要处理的流式中断问题。
/// `-r` 重装保留数据；`allow_downgrade` 时叠加 `-d` 允许版本降级覆盖。
pub async fn install_apk(
    app: &AppHandle,
    adb: &Path,
    device_id: &str,
    apk_path: &str,
    allow_downgrade: bool,
    install_id: &str,
) -> Result<String, AdbError> {
    // install_id 非空才注册取消句柄（前端队列安装一定传唯一 id；缺省则退化为不可中断）。
    let notify = if install_id.is_empty() { None } else { Some(cancel_register(install_id)) };
    let result =
        install_apk_inner(app, adb, device_id, apk_path, allow_downgrade, install_id, notify.as_deref()).await;
    if !install_id.is_empty() {
        cancel_unregister(install_id);
    }
    result
}

/// 「已中断」错误：命令层据 code 标成中断态而非失败。
fn cancelled_error(name: &str) -> AdbError {
    AdbError::custom(
        INSTALL_CANCELLED_CODE,
        format!("已中断安装（{name}）"),
        "你手动中断了本次安装。",
        "Install cancelled by user.".to_string(),
    )
}

async fn install_apk_inner(
    app: &AppHandle,
    adb: &Path,
    device_id: &str,
    apk_path: &str,
    allow_downgrade: bool,
    install_id: &str,
    notify: Option<&Notify>,
) -> Result<String, AdbError> {
    let cleaned = apk_path.trim();
    if !cleaned.to_lowercase().ends_with(".apk") {
        return Err(AdbError::custom(
            "ADB_COMMAND_FAILED",
            "只能安装 APK 文件。".to_string(),
            "请选择 .apk 安装包。",
            format!("Only APK files can be installed: {apk_path}"),
        ));
    }

    let name = basename(cleaned);
    let remote = format!("/data/local/tmp/adm-install-{}.apk", safe_id(install_id));
    let total_bytes = std::fs::metadata(cleaned).map(|m| m.len()).unwrap_or(0);
    emit_progress(app, install_id, 0, "pushing");

    // ① push 到设备临时目录（占 0-85%）。push future 与「字节轮询」「取消通知」三方 select：
    // 取消时丢弃 push_fut → kill_on_drop 杀掉 adb push 子进程，删设备端残留临时文件后返回「已中断」。
    let push_args: [&str; 5] = ["-s", device_id, "push", cleaned, &remote];
    let push_fut = exec_adb_capture(adb, &push_args, INSTALL_TIMEOUT_MS);
    tokio::pin!(push_fut);
    let pushed = loop {
        tokio::select! {
            res = &mut push_fut => break res,
            _ = async { match notify { Some(n) => n.notified().await, None => never().await } } => {
                let _ = exec_adb_capture(adb, &["-s", device_id, "shell", "rm", "-f", &remote], 15_000).await;
                return Err(cancelled_error(&name));
            }
            _ = tokio::time::sleep(Duration::from_millis(400)), if total_bytes > 0 => {
                // 轮询兜底取消：错过 Notify 边沿（如正在 stat await）时在此补上。
                if is_cancelled(install_id) {
                    let _ = exec_adb_capture(adb, &["-s", device_id, "shell", "rm", "-f", &remote], 15_000).await;
                    return Err(cancelled_error(&name));
                }
                if let Ok(out) = exec_adb_capture(adb, &["-s", device_id, "shell", "stat", "-c", "%s", &remote], 5_000).await {
                    if out.success {
                        if let Ok(written) = out.stdout.trim().parse::<u64>() {
                            if written > 0 {
                                let pct = (written.saturating_mul(85) / total_bytes).min(85) as u32;
                                emit_progress(app, install_id, pct, "pushing");
                            }
                        }
                    }
                }
            }
        }
    };

    let pushed = pushed?;
    if !pushed.success {
        let _ = exec_adb_capture(adb, &["-s", device_id, "shell", "rm", "-f", &remote], 15_000).await;
        return Err(classify_install_failure(&combine(&pushed), cleaned));
    }

    // 推送完成、pm install 之前再查一次取消：堵住「push 结束 ~ pm select 武装 notified()」之间的边沿窗口
    // （此刻 notify_waiters 无等待者会被错过，靠 cancelled 标志兜底）。
    if is_cancelled(install_id) {
        let _ = exec_adb_capture(adb, &["-s", device_id, "shell", "rm", "-f", &remote], 15_000).await;
        return Err(cancelled_error(&name));
    }

    // ② pm install（占 85-100%），与取消通知 select。pm 失败时退出码仍可能为 0 并打印 "Failure [...]"，故按输出文本判据。
    emit_progress(app, install_id, 88, "installing");
    let mut pm_args: Vec<&str> = vec!["-s", device_id, "shell", "pm", "install", "-r"];
    if allow_downgrade {
        pm_args.push("-d");
    }
    pm_args.push(&remote);
    let pm_fut = exec_adb_capture(adb, &pm_args, INSTALL_TIMEOUT_MS);
    tokio::pin!(pm_fut);
    let pm = tokio::select! {
        res = &mut pm_fut => res,
        _ = async { match notify { Some(n) => n.notified().await, None => never().await } } => {
            let _ = exec_adb_capture(adb, &["-s", device_id, "shell", "rm", "-f", &remote], 15_000).await;
            return Err(cancelled_error(&name));
        }
    };

    // ③ 清设备端临时 APK（无论成败）。
    let _ = exec_adb_capture(adb, &["-s", device_id, "shell", "rm", "-f", &remote], 15_000).await;

    let pm = pm?;
    let output = combine(&pm);
    if is_success(&output) {
        emit_progress(app, install_id, 100, "installing");
        Ok(output)
    } else {
        Err(classify_install_failure(&output, cleaned))
    }
}

/// 把安装失败输出分类为带可读消息 + 建议的 AdbError（对齐原 classifyInstallFailure）。
fn classify_install_failure(output: &str, apk_path: &str) -> AdbError {
    let lower = output.to_lowercase();
    let has = |needle: &str| lower.contains(needle);
    let name = basename(apk_path);

    // 抽出冲突包名：优先 "Package com.x.y"，否则找像包名的 token（>=2 个点）。
    static PKG_EXPLICIT: OnceLock<Regex> = OnceLock::new();
    static PKG_TOKEN: OnceLock<Regex> = OnceLock::new();
    let pkg = re(&PKG_EXPLICIT, r"Package\s+([A-Za-z][\w]*(?:\.[A-Za-z_][\w]*)+)")
        .captures(output)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .or_else(|| {
            re(&PKG_TOKEN, r"\b[A-Za-z][\w]*(?:\.[A-Za-z_][\w]*){2,}\b")
                .find(output)
                .map(|m| m.as_str().to_string())
        });
    let pkg_suffix = pkg
        .as_ref()
        .map(|p| format!("（包名 {p}）"))
        .unwrap_or_default();

    let (message, hint): (String, String) = if has("install_failed_update_incompatible")
        || has("install_parse_failed_inconsistent_certificates")
        || has("install_failed_shared_user_incompatible")
        || has("signatures do not match")
    {
        (
            format!("签名不一致：设备上已安装同包名应用{pkg_suffix}，但签名与当前 APK 不同，无法覆盖安装"),
            match &pkg {
                Some(p) => format!("请先在右侧「已安装应用」卸载设备上的「{p}」（会清除该应用数据），再重新安装本 APK。"),
                None => "请先在右侧「已安装应用」卸载设备上的旧版本（会清除该应用数据），再重新安装本 APK。".to_string(),
            },
        )
    } else if has("install_failed_version_downgrade") {
        (
            format!("版本降级被拒绝：当前 APK 的版本号低于设备上已安装的版本{pkg_suffix}"),
            "勾选上方「允许降级覆盖」后重试（降级可能导致应用数据异常）。".to_string(),
        )
    } else if has("install_failed_insufficient_storage") {
        ("设备存储空间不足，无法安装".to_string(), "清理设备存储空间后重试。".to_string())
    } else if has("install_failed_no_matching_abis") {
        (
            "CPU 架构不兼容：APK 内的 so 原生库与设备架构不匹配".to_string(),
            "换用与设备架构匹配的 APK（设备为 arm64 就用 arm64 包）。".to_string(),
        )
    } else if has("install_failed_older_sdk") {
        (
            "设备系统版本过低，低于该 APK 要求的最低系统版本".to_string(),
            "升级设备系统，或换用兼容更低系统的 APK。".to_string(),
        )
    } else if has("install_failed_test_only") {
        (
            "该 APK 被标记为仅供测试（testOnly），常规安装被拒绝".to_string(),
            "换用正式发布的 APK，或用测试模式安装。".to_string(),
        )
    } else if has("install_failed_duplicate_permission") {
        (
            "权限冲突：该 APK 声明的权限与设备上已装的其它应用重复".to_string(),
            "卸载冲突的那个应用后再重试。".to_string(),
        )
    } else if has("install_parse_failed_no_certificates") {
        ("APK 未签名或证书缺失，无法安装".to_string(), "使用已正确签名的 APK。".to_string())
    } else if has("install_parse_failed") || has("install_failed_invalid_apk") {
        ("APK 文件损坏或解析失败".to_string(), "确认安装包完整未损坏，必要时重新获取该 APK。".to_string())
    } else if has("install_failed_user_restricted") {
        (
            "设备拒绝安装：可能未允许 USB 安装 / 未知来源安装".to_string(),
            "在设备「开发者选项」开启「USB 安装」，或在设备弹窗中允许本次安装。".to_string(),
        )
    } else if has("no such file") || has("failed to stat") || has("can't find") || has("cannot stat")
    {
        ("APK 文件未找到或已被移动".to_string(), "确认文件仍在原路径，重新选择安装包后再装。".to_string())
    } else if has("device offline")
        || has("device unauthorized")
        || (lower.contains("device") && lower.contains("not found"))
    {
        ("设备连接异常（离线或未授权）".to_string(), "重新连接设备，并在设备上确认 USB 调试授权。".to_string())
    } else {
        static CODE: OnceLock<Regex> = OnceLock::new();
        match re(&CODE, r"INSTALL_[A-Z_]+").find(output) {
            Some(m) => (
                format!("安装失败：{}", m.as_str()),
                "展开下方详情可见原始报错。".to_string(),
            ),
            None => (
                "安装失败".to_string(),
                "请检查设备连接、调试授权、安装权限、版本签名以及设备剩余空间。".to_string(),
            ),
        }
    };

    let details = if output.trim().is_empty() {
        "adb install did not report success.".to_string()
    } else {
        output.trim().to_string()
    };
    AdbError::custom("ADB_COMMAND_FAILED", format!("{message}（{name}）"), &hint, details)
}
