//! adb 错误分类（对应原 Electron 版 adbError.ts 的 AdbCommandError + classifyAdbError）。
//! 把底层执行错误/输出归类成结构化错误，命令层转成 ElectronResult { success:false, error, code, hint, details }。

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
pub struct AdbError {
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    pub details: Option<String>,
}

impl AdbError {
    fn new(code: &str, message: &str, hint: &str, details: String) -> Self {
        AdbError {
            code: code.to_string(),
            message: message.to_string(),
            hint: Some(hint.to_string()),
            details: Some(details),
        }
    }

    /// 转为渲染层约定的 ElectronResult 失败形状。
    pub fn to_result(&self) -> Value {
        json!({
            "success": false,
            "error": self.message,
            "code": self.code,
            "hint": self.hint,
            "details": self.details,
        })
    }
}

fn includes_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

/// 依据底层错误文本 + 命令参数归类（逻辑对齐原 classifyAdbError）。
pub fn classify_adb_error(details: &str, args: &[&str]) -> AdbError {
    let normalized = details.to_lowercase();
    let command = format!("adb {}", args.join(" "));

    if includes_any(
        &normalized,
        &[
            "enoent",
            "not recognized as an internal or external command",
            "is not recognized as an internal or external command",
            "cannot find the file specified",
            "command not found",
            "program not found",
            "系统找不到指定的文件",
        ],
    ) {
        return AdbError::new(
            "ADB_NOT_FOUND",
            "未检测到可用的 adb。应用内置的 platform-tools 可能缺失，也可能是系统环境里没有 adb。",
            "优先检查发布包里的 resources/platform-tools 是否完整；如果你是在源码环境运行，再确认终端里 `adb version` 能正常执行。",
            details.to_string(),
        );
    }
    if includes_any(&normalized, &["unauthorized"]) {
        return AdbError::new(
            "DEVICE_UNAUTHORIZED",
            "设备未授权。请在手机上允许 USB 调试授权后重试。",
            "如果授权弹窗没有出现，尝试重新插拔 USB，或关闭后重新开启 USB 调试。",
            details.to_string(),
        );
    }
    if includes_any(&normalized, &["offline"]) {
        return AdbError::new(
            "DEVICE_OFFLINE",
            "设备当前处于离线状态，请检查 USB 调试、数据线或无线调试状态。",
            "可以先执行一次 USB 刷新，必要时重新插拔设备或重新连接 WiFi 调试。",
            details.to_string(),
        );
    }
    if includes_any(&normalized, &["device not found", "no devices/emulators found"]) {
        return AdbError::new(
            "DEVICE_NOT_FOUND",
            "未找到目标设备。请确认设备已连接，并且已经出现在 ADB 设备列表中。",
            "如果是 WiFi 设备，请确认 IP 和端口正确；如果是 USB 设备，请确认调试授权已通过。",
            details.to_string(),
        );
    }
    if includes_any(&normalized, &["more than one device", "more than one emulator"]) {
        return AdbError::new(
            "MULTIPLE_DEVICES",
            "当前存在多个 ADB 设备，操作目标不明确。",
            "请先在设备列表中确认目标设备，再使用带设备 ID 的操作。",
            details.to_string(),
        );
    }
    if includes_any(&normalized, &["timed out", "timeout"]) {
        return AdbError::new(
            "ADB_TIMEOUT",
            "ADB 操作超时，请检查设备连接状态后重试。",
            "如果是 WiFi 连接，优先确认设备和电脑是否仍在同一局域网。",
            details.to_string(),
        );
    }
    if includes_any(&normalized, &["connection refused", "10061", "actively refused"]) {
        return AdbError::new(
            "WIFI_CONNECTION_REFUSED",
            "WiFi 连接被拒绝，请确认目标设备已开启无线调试并监听正确端口。",
            "可以先用 USB 连接设备，再在系统开发者选项里确认无线调试状态。",
            details.to_string(),
        );
    }
    if includes_any(
        &normalized,
        &[
            "no route to host",
            "network is unreachable",
            "cannot assign requested address",
            "name or service not known",
            "unknown host",
        ],
    ) {
        return AdbError::new(
            "NETWORK_UNREACHABLE",
            "无法访问目标设备网络地址，请检查 IP、端口和局域网连通性。",
            "请确认电脑和设备在同一网络，并且目标 IP 可以被访问。",
            details.to_string(),
        );
    }
    if args.contains(&"tcpdump") || includes_any(&normalized, &["tcpdump", "permission denied"]) {
        return AdbError::new(
            "TCPDUMP_UNAVAILABLE",
            "设备侧 tcpdump 不可用，或当前权限不足以抓包。",
            "这通常需要设备存在 tcpdump，并具备相应权限；部分机型默认无法直接抓包。",
            details.to_string(),
        );
    }

    AdbError::new(
        "ADB_COMMAND_FAILED",
        &format!("ADB 命令执行失败：{command}"),
        "请检查设备连接状态、调试授权和命令执行环境后重试。",
        details.to_string(),
    )
}
