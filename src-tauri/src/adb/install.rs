//! APK 安装执行 + 失败分类（对应原 ADBManager.installApk / shouldRetryInstallWithoutStreaming /
//! classifyInstallFailure）。单次安装一台设备一个 APK；多 APK×多设备并行/限流/队列在前端编排。

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use super::error::AdbError;
use super::manager::{exec_adb_capture, Captured};

const INSTALL_TIMEOUT_MS: u64 = 10 * 60 * 1000;

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

/// 是否值得退回 `--no-streaming` 重试（对齐原 shouldRetryInstallWithoutStreaming）。
/// 退出码 0 视为成功，不重试；否则看输出是否含流式安装相关的失败特征。
fn should_retry_without_streaming(result: &Captured) -> bool {
    if result.success {
        return false;
    }
    let output = format!("{}\n{}", result.stdout, result.stderr).to_lowercase();
    output.contains("streamed install")
        || output.contains("streaming")
        || output.contains("broken pipe")
        || output.contains("connection reset")
        || output.contains("unexpected eof")
        || output.contains("protocol fault")
}

/// 安装一个 APK 到一台设备。成功返回 adb 输出；失败返回分类后的 AdbError。
/// `-r` 重装保留数据；`allow_downgrade` 时叠加 `-d` 允许版本降级覆盖。
pub async fn install_apk(
    adb: &Path,
    device_id: &str,
    apk_path: &str,
    allow_downgrade: bool,
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

    let flags: &[&str] = if allow_downgrade { &["-r", "-d"] } else { &["-r"] };
    let mut primary_args: Vec<&str> = vec!["-s", device_id, "install"];
    primary_args.extend_from_slice(flags);
    primary_args.push(cleaned);

    let primary = exec_adb_capture(adb, &primary_args, INSTALL_TIMEOUT_MS).await?;
    let primary_output = combine(&primary);
    if is_success(&primary_output) {
        return Ok(primary_output);
    }

    // 流式安装失败特征 → 退回 --no-streaming 再试一次。
    if should_retry_without_streaming(&primary) {
        let mut fallback_args: Vec<&str> = vec!["-s", device_id, "install", "--no-streaming"];
        fallback_args.extend_from_slice(flags);
        fallback_args.push(cleaned);

        let fallback = exec_adb_capture(adb, &fallback_args, INSTALL_TIMEOUT_MS).await?;
        let fallback_output = combine(&fallback);
        if is_success(&fallback_output) {
            return Ok(fallback_output);
        }
        let failure = if !fallback_output.is_empty() {
            fallback_output
        } else {
            primary_output
        };
        return Err(classify_install_failure(&failure, cleaned));
    }

    Err(classify_install_failure(&primary_output, cleaned))
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
