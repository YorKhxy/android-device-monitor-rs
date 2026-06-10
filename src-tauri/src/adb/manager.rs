//! adb 执行核心与设备操作（对应原 ADBManager.ts 的设备相关方法）。
//! 命令执行走 tokio::process + 超时；解析逻辑对齐原版。

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::Command;
use tokio::time::{sleep, timeout};

use super::error::{classify_adb_error, AdbError};

/// 设备信息（字段与渲染层 shared/types 的 DeviceInfo 对齐，序列化为 camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub serial_no: String,
    pub model: String,
    pub manufacturer: String,
    pub android_version: String,
    pub api_level: i64,
    pub connection_type: String, // "usb" | "wifi"
    pub status: String,          // "connected" | "offline" | "unauthorized"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery_level: Option<i64>,
    // 屏幕状态（息屏/唤醒）：dumpsys power 解析，"on" | "off"。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_state: Option<String>,
    // WiFi 延迟（仅 wifi 设备）：get-state 往返耗时 ms + 状态 "ok" | "unknown"。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_status: Option<String>,
}

#[derive(Debug, Clone)]
struct DeviceSummary {
    id: String,
    connection_type: String,
    status: String,
}

pub struct AdbOutput {
    pub stdout: String,
    pub stderr: String,
}

/// 容错执行结果：无论退出码都带回输出 + 退出是否成功（供需按退出码决策的调用方用，如 install 重试）。
pub struct Captured {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// 执行一次 adb，无论退出码都捕获输出（对齐原 execAdbWithExitCode）。
/// 仅在进程无法启动 / 超时 / adb 缺失时返回 Err；非零退出仍返回 Ok，
/// 供调用方按输出文本自定义判据（如 monkey 的 "Events injected: 1"、uninstall 的 "Success"）。
/// 注：app 命令依据输出文本而非退出码（adb uninstall 失败时仍退出 0 并打印 "Failure"）。
pub async fn exec_adb_capture(adb: &Path, args: &[&str], timeout_ms: u64) -> Result<Captured, AdbError> {
    let mut cmd = Command::new(adb);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    // 进程随 future 一起被丢弃时杀掉：传输中止（select 丢弃 push/pull future）或超时（timeout 丢弃 output future）
    // 都能真正终止 adb 子进程，不留孤儿进程继续占用传输。
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = match timeout(Duration::from_millis(timeout_ms), cmd.output()).await {
        Err(_) => return Err(classify_adb_error("timed out", args)),
        Ok(Err(e)) => return Err(classify_adb_error(&e.to_string(), args)),
        Ok(Ok(o)) => o,
    };

    Ok(Captured {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

/// 执行一次 adb 命令；非零退出或底层错误归类为 AdbError（对齐原 execAdb 在非零时抛错的语义）。
pub async fn exec_adb(adb: &Path, args: &[&str], timeout_ms: u64) -> Result<AdbOutput, AdbError> {
    let mut cmd = Command::new(adb);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Windows 下不弹黑窗
    #[cfg(windows)]
    {
        // tokio::process::Command 在 Windows 上自带 creation_flags（无需 std CommandExt）
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = match timeout(Duration::from_millis(timeout_ms), cmd.output()).await {
        Err(_) => return Err(classify_adb_error("timed out", args)),
        Ok(Err(e)) => return Err(classify_adb_error(&e.to_string(), args)),
        Ok(Ok(o)) => o,
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let combined = format!("{stderr}\n{stdout}");
        return Err(classify_adb_error(&combined, args));
    }

    Ok(AdbOutput { stdout, stderr })
}

/// 解析 `adb devices -l` 输出为设备摘要（对齐原 parseDeviceSummaries：跳过表头/特殊条目/mDNS）。
fn parse_device_summaries(stdout: &str) -> Vec<DeviceSummary> {
    let mut summaries = Vec::new();
    for (idx, raw) in stdout.trim().lines().enumerate() {
        if idx == 0 {
            continue; // "List of devices attached" 表头
        }
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        let id = match parts.first() {
            Some(v) => *v,
            None => continue,
        };
        if id.is_empty() || id == "List" {
            continue;
        }
        let raw_status = parts.get(1).copied().unwrap_or("");
        if raw_status != "device" && raw_status != "offline" && raw_status != "unauthorized" {
            continue;
        }
        if id == "adb" || id.starts_with("emulator-") || id == "host" {
            continue;
        }
        if id.contains("._tcp") || id.contains("_adb-tls-") || id.contains("_adb._") {
            continue; // mDNS 服务条目
        }
        let status = if raw_status == "device" { "connected" } else { raw_status };
        summaries.push(DeviceSummary {
            id: id.to_string(),
            connection_type: if id.contains(':') { "wifi".into() } else { "usb".into() },
            status: status.to_string(),
        });
    }
    summaries
}

/// 解析 `getprop` 输出为 key→value。
fn parse_getprop(stdout: &str) -> std::collections::HashMap<String, String> {
    let mut props = std::collections::HashMap::new();
    for line in stdout.trim().lines() {
        // 形如 [ro.product.model]: [Pico 4]
        if let Some(rest) = line.strip_prefix('[') {
            if let Some((key, after)) = rest.split_once("]: [") {
                if let Some(value) = after.strip_suffix(']') {
                    props.insert(key.to_string(), value.to_string());
                }
            }
        }
    }
    props
}

async fn get_device_properties(
    adb: &Path,
    device_id: &str,
) -> Result<std::collections::HashMap<String, String>, AdbError> {
    let out = exec_adb(adb, &["-s", device_id, "shell", "getprop"], 8000).await?;
    Ok(parse_getprop(&out.stdout))
}

async fn get_battery_level(adb: &Path, device_id: &str) -> Option<i64> {
    let out = exec_adb(adb, &["-s", device_id, "shell", "dumpsys", "battery"], 3000)
        .await
        .ok()?;
    for line in out.stdout.lines() {
        let lower = line.to_lowercase();
        if let Some(pos) = lower.find("level:").or_else(|| lower.find("capacity:")) {
            let tail = &line[pos..];
            let digits: String = tail.chars().filter(|c| c.is_ascii_digit()).collect();
            if let Ok(level) = digits.parse::<i64>() {
                return Some(level.clamp(0, 100));
            }
        }
    }
    None
}

/// 解析 `dumpsys power` 的屏幕状态：优先 `mWakefulness=Awake/Asleep/Dozing`，回退 `Display Power: state=ON/OFF`。
/// Awake/ON → "on"，其余 → "off"；都没解析到 → None。
fn parse_screen_state(stdout: &str) -> Option<&'static str> {
    if let Some(rest) = stdout.split("mWakefulness=").nth(1) {
        let word = rest.split_whitespace().next().unwrap_or("");
        return Some(if word == "Awake" { "on" } else { "off" });
    }
    if let Some(rest) = stdout.split("Display Power: state=").nth(1) {
        let word = rest.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
        if word.starts_with("ON") {
            return Some("on");
        }
        if word.starts_with("OFF") {
            return Some("off");
        }
    }
    None
}

/// 取屏幕状态（息屏/唤醒）。失败 → None（不显示徽标）。
async fn get_screen_state(adb: &Path, device_id: &str) -> Option<String> {
    let out = exec_adb(adb, &["-s", device_id, "shell", "dumpsys", "power"], 4000).await.ok()?;
    parse_screen_state(&out.stdout).map(|s| s.to_string())
}

/// 量 WiFi 延迟：`adb get-state` 往返耗时。返回 device → (耗时ms, "ok")；否则 (None, "unknown")。
async fn measure_wifi_latency(adb: &Path, device_id: &str) -> (Option<i64>, Option<String>) {
    let started = Instant::now();
    match exec_adb_capture(adb, &["-s", device_id, "get-state"], 3000).await {
        Ok(o) if o.stdout.trim() == "device" => {
            (Some(started.elapsed().as_millis() as i64), Some("ok".to_string()))
        }
        _ => (None, Some("unknown".to_string())),
    }
}

/// 获取设备列表（对齐原 getDevices：devices -l → 逐设备 getprop + 电量 + 屏幕状态 + WiFi 延迟）。
pub async fn get_devices(adb: &Path) -> Result<Vec<DeviceInfo>, AdbError> {
    let out = exec_adb(adb, &["devices", "-l"], 8000).await?;
    let summaries = parse_device_summaries(&out.stdout);
    let mut devices = Vec::with_capacity(summaries.len());

    for summary in summaries {
        let mut device = DeviceInfo {
            id: summary.id.clone(),
            name: "Unknown".into(),
            serial_no: "Unknown".into(),
            model: "Unknown".into(),
            manufacturer: "Unknown".into(),
            android_version: "Unknown".into(),
            api_level: 0,
            connection_type: summary.connection_type.clone(),
            status: summary.status.clone(),
            battery_level: None,
            screen_state: None,
            latency_ms: None,
            latency_status: None,
        };

        if summary.status == "connected" {
            if let Ok(props) = get_device_properties(adb, &summary.id).await {
                let get = |k: &str| props.get(k).cloned().filter(|s| !s.is_empty());
                if let Some(v) = get("ro.product.name") {
                    device.name = v;
                }
                device.serial_no = get("ro.serialno")
                    .or_else(|| get("ro.boot.serialno"))
                    .unwrap_or_else(|| summary.id.clone());
                if let Some(v) = get("ro.product.model") {
                    device.model = v;
                }
                if let Some(v) = get("ro.product.manufacturer") {
                    device.manufacturer = v;
                }
                if let Some(v) = get("ro.build.version.release") {
                    device.android_version = v;
                }
                if let Some(v) = get("ro.build.version.sdk") {
                    device.api_level = v.parse().unwrap_or(0);
                }
            }
            device.battery_level = get_battery_level(adb, &summary.id).await;
            device.screen_state = get_screen_state(adb, &summary.id).await;
            if device.connection_type == "wifi" {
                let (ms, st) = measure_wifi_latency(adb, &summary.id).await;
                device.latency_ms = ms;
                device.latency_status = st;
            }
        }

        devices.push(device);
    }

    Ok(devices)
}

/// USB 连接刷新（start-server + 列表）。
pub async fn connect_usb(adb: &Path) -> Result<Vec<DeviceInfo>, AdbError> {
    exec_adb(adb, &["start-server"], 8000).await?;
    get_devices(adb).await
}

/// WiFi 连接（对齐原 connectWiFi：规整端口→disconnect→connect→重试确认）。
pub async fn connect_wifi(adb: &Path, target: &str) -> Result<DeviceInfo, AdbError> {
    let target = if target.contains(':') {
        target.to_string()
    } else {
        format!("{target}:5555")
    };

    let _ = exec_adb(adb, &["disconnect", &target], 5000).await;
    sleep(Duration::from_millis(500)).await;

    let out = exec_adb(adb, &["connect", &target], 10000).await?;
    let combined = format!("{} {}", out.stdout, out.stderr).to_lowercase();
    if combined.contains("refused") || combined.contains("failed") {
        return Err(classify_adb_error(&format!("{} {}", out.stdout, out.stderr), &["connect", &target]));
    }
    if !combined.contains("connected") {
        return Err(classify_adb_error(
            &format!("connection failed: {} {}", out.stdout, out.stderr),
            &["connect", &target],
        ));
    }

    for _ in 0..8 {
        sleep(Duration::from_millis(1000)).await;
        let devices = get_devices(adb).await?;
        if let Some(mut d) = devices
            .into_iter()
            .find(|d| d.id == target && d.status == "connected")
        {
            d.connection_type = "wifi".into();
            return Ok(d);
        }
    }

    Err(classify_adb_error(
        "connected but device not found in list",
        &["connect", &target],
    ))
}

/// 断开 WiFi 设备。
pub async fn disconnect(adb: &Path, device_id: &str) -> Result<(), AdbError> {
    exec_adb(adb, &["disconnect", device_id], 5000).await?;
    Ok(())
}

/// 无线调试配对（对齐原 pairDevice 主路径）。返回 (message, device, already_paired)。
pub async fn pair(adb: &Path, target: &str, code: &str) -> Result<(String, Option<DeviceInfo>, bool), AdbError> {
    let target = target.trim();
    let code = code.trim();
    if !target.contains(':') {
        return Err(AdbError {
            code: "ADB_COMMAND_FAILED".into(),
            message: "请填写配对地址 IP:端口（无线调试「使用配对码配对设备」里显示的地址和端口）".into(),
            hint: None,
            details: None,
        });
    }
    // 已存在该 IP 的已连接设备 → 视为已配对
    let ip = target.split(':').next().unwrap_or("");
    if !ip.is_empty() {
        if let Ok(devices) = get_devices(adb).await {
            if let Some(mut d) = devices
                .into_iter()
                .find(|d| d.id.starts_with(&format!("{ip}:")) && d.status == "connected")
            {
                d.connection_type = "wifi".into();
                return Ok(("该设备已配对并连接".into(), Some(d), true));
            }
        }
    }
    if !(code.len() == 6 && code.chars().all(|c| c.is_ascii_digit())) {
        return Err(AdbError {
            code: "ADB_COMMAND_FAILED".into(),
            message: "配对码应为 6 位数字".into(),
            hint: None,
            details: None,
        });
    }

    let out = exec_adb(adb, &["pair", target, code], 15000).await?;
    let combined = format!("{} {}", out.stdout, out.stderr);
    if combined.to_lowercase().contains("successfully") {
        Ok((combined.trim().to_string(), None, false))
    } else {
        Err(classify_adb_error(&combined, &["pair", target]))
    }
}

/// adb 版本/可用状态（对齐原 getAdbStatus）。返回 AdbStatus 形状 JSON 用字段。
pub async fn adb_version(adb: &Path) -> Result<Option<String>, AdbError> {
    let out = exec_adb(adb, &["version"], 3000).await?;
    let version = out
        .stdout
        .lines()
        .find_map(|line| {
            let lower = line.to_lowercase();
            if lower.contains("android debug bridge version") {
                line.split_whitespace().last().map(|s| s.to_string())
            } else {
                None
            }
        });
    Ok(version)
}

/// 设备列表轻量快照（监控轮询 diff 用）：id|status|connType|屏幕状态|延迟状态 串联。
/// 纳入屏幕状态与延迟状态（离散值），使息屏/唤醒切换、WiFi 连接稳定性变化能触发 device_list_changed 刷新前端；
/// 延迟具体 ms 值不入快照（避免每拍抖动刷屏），随每次 emit 一并带出最新值。
pub fn devices_snapshot(devices: &[DeviceInfo]) -> String {
    let mut parts: Vec<String> = devices
        .iter()
        .map(|d| {
            format!(
                "{}|{}|{}|{}|{}",
                d.id,
                d.status,
                d.connection_type,
                d.screen_state.as_deref().unwrap_or(""),
                d.latency_status.as_deref().unwrap_or(""),
            )
        })
        .collect();
    parts.sort();
    parts.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usb_device_summary() {
        // 真机 vivo V2148A 的实际 `adb devices -l` 输出格式
        let stdout = "List of devices attached\n3409746658000W2        device product:PD2148 model:V2148A device:PD2148 transport_id:5\n";
        let summaries = parse_device_summaries(stdout);
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "3409746658000W2");
        assert_eq!(summaries[0].connection_type, "usb");
        assert_eq!(summaries[0].status, "connected");
    }

    #[test]
    fn classifies_wifi_and_skips_noise() {
        let stdout = "List of devices attached\n\
            192.168.1.50:5555      device\n\
            emulator-5554          device\n\
            adb-xxxx._adb-tls-connect._tcp.  device\n\
            ABCD                   offline\n\
            EFGH                   unauthorized\n";
        let summaries = parse_device_summaries(stdout);
        // emulator 与 mDNS 条目被跳过，剩 wifi/offline/unauthorized 各一
        assert_eq!(summaries.len(), 3);
        let wifi = summaries.iter().find(|s| s.id == "192.168.1.50:5555").unwrap();
        assert_eq!(wifi.connection_type, "wifi");
        assert_eq!(wifi.status, "connected");
        assert!(summaries.iter().any(|s| s.id == "ABCD" && s.status == "offline"));
        assert!(summaries.iter().any(|s| s.id == "EFGH" && s.status == "unauthorized"));
    }

    #[test]
    fn parses_getprop() {
        // 真机 getprop 实际格式 [key]: [value]
        let stdout = "[ro.product.model]: [V2148A]\n\
            [ro.product.name]: [PD2148]\n\
            [ro.product.manufacturer]: [vivo]\n\
            [ro.build.version.release]: [13]\n\
            [ro.build.version.sdk]: [33]\n\
            [ro.serialno]: [3409746658000W2]\n";
        let props = parse_getprop(stdout);
        assert_eq!(props.get("ro.product.model").unwrap(), "V2148A");
        assert_eq!(props.get("ro.product.manufacturer").unwrap(), "vivo");
        assert_eq!(props.get("ro.build.version.release").unwrap(), "13");
        assert_eq!(props.get("ro.build.version.sdk").unwrap(), "33");
        assert_eq!(props.get("ro.serialno").unwrap(), "3409746658000W2");
    }

    #[test]
    fn parses_screen_state_from_dumpsys_power() {
        assert_eq!(parse_screen_state("  mWakefulness=Awake\n  ..."), Some("on"));
        assert_eq!(parse_screen_state("mWakefulness=Asleep"), Some("off"));
        assert_eq!(parse_screen_state("mWakefulness=Dozing"), Some("off"));
        // 回退 Display Power。
        assert_eq!(parse_screen_state("Display Power: state=ON"), Some("on"));
        assert_eq!(parse_screen_state("Display Power: state=OFF"), Some("off"));
        assert_eq!(parse_screen_state("no relevant field"), None);
    }

    #[test]
    fn snapshot_is_order_independent() {
        let mk = |id: &str, st: &str| DeviceInfo {
            id: id.into(), name: "x".into(), serial_no: "x".into(), model: "x".into(),
            manufacturer: "x".into(), android_version: "13".into(), api_level: 33,
            connection_type: "usb".into(), status: st.into(), battery_level: None,
            screen_state: None, latency_ms: None, latency_status: None,
        };
        let a = vec![mk("A", "connected"), mk("B", "offline")];
        let b = vec![mk("B", "offline"), mk("A", "connected")];
        assert_eq!(devices_snapshot(&a), devices_snapshot(&b));
    }
}
