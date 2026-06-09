//! 运行情况采样编排（对应原 runtimeInspector.ts 的采集部分，Android 路径）。
//! Pico 官方指标在 T2.4 接入：getPerformanceMetrics 目前走 Android 采样，
//! 预留 provider 字段与 pico 相关字段（None 时不序列化），T2.4 在此之上包一层 Pico 检测。
//!
//! 铁律（见 .claude/feedback/monitoring-failed-sample-must-be-gap-not-zero）：
//! 取数「命令级失败/超时」绝不编造 0——三项采样命令任一失败即整拍抛出（Err），
//! 由上层（实时 IPC / 采集控制）跳过本拍画断点。命令成功但解析为真实 0（如未用 HWUI 时 FPS 0）照常记录。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::error::AdbError;
use super::manager::exec_adb;
use super::runtime_parsers::{
    parse_activity_stack, parse_cpu_usage, parse_foreground_app_from_window, parse_gfx_info,
    parse_memory_usage, parse_processes, parse_running_packages,
};
use super::runtime_types::{
    ActivityStackEntry, ForegroundAppContext, PicoMetricsPayload, ProcessInfo,
};

/// 前台应用解析重而慢（dumpsys window/activity），但前台在一次采集里几乎不变。
/// 按设备缓存，TTL 内复用，把重型 dumpsys 从「每拍」降到「每 5 秒」——省电、少超时。
const FOREGROUND_APP_TTL_MS: u128 = 5000;

/// Android 采样来源标注（对齐 shared/types 的 AndroidPerformancePayload）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidPerformancePayload {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps_source: Option<String>,
}

/// 性能指标（对齐 shared/types 的 PerformanceMetrics）。
/// FPS 统一口径：`fps` 字段同时承载 Android 与 Pico native fps，不按 provider 分流（DEV-PLAN T2.3 铁律）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceMetrics {
    pub provider: String, // "android" | "pico"
    pub cpu_usage: f64,
    pub memory_usage: f64,
    pub fps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub android_metrics: Option<AndroidPerformancePayload>,
    // —— Pico 官方指标（T2.4）；非 Pico 路径全为 None 不序列化 ——
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pico_metrics: Option<PicoMetricsPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pico_metrics_state: Option<String>, // "native" | "fallback" | "unavailable"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pico_metrics_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pico_app_support: Option<String>, // "supported" | "unsupported" | "unknown"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pico_support_message: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn foreground_cache() -> &'static Mutex<HashMap<String, (ForegroundAppContext, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (ForegroundAppContext, Instant)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 一次 Android 性能采样：三项命令并发，任一失败 → 整拍 Err（不编造 0）。
pub async fn get_android_performance_metrics(
    adb: &Path,
    device_id: &str,
    foreground: &ForegroundAppContext,
) -> Result<PerformanceMetrics, AdbError> {
    let pkg = foreground.package_name.clone();

    // gfxinfo 带前台包名（有的话）取该应用 framestats，否则取全局。
    let gfx_args: Vec<String> = match &pkg {
        Some(p) => vec![
            "-s".into(),
            device_id.into(),
            "shell".into(),
            "dumpsys".into(),
            "gfxinfo".into(),
            p.clone(),
            "framestats".into(),
        ],
        None => vec![
            "-s".into(),
            device_id.into(),
            "shell".into(),
            "dumpsys".into(),
            "gfxinfo".into(),
            "framestats".into(),
        ],
    };
    let gfx_ref: Vec<&str> = gfx_args.iter().map(|s| s.as_str()).collect();

    // 参数数组先绑定到 let，避免在 tokio::join! 跨 await 持有期内被当作临时值提前 drop。
    let mem_args = ["-s", device_id, "shell", "cat", "/proc/meminfo"];
    let cpu_args = ["-s", device_id, "shell", "top", "-n", "1"];

    // 内存走 /proc/meminfo（瞬时、格式固定、永不超时）；CPU 走 top -n 1；FPS 走 gfxinfo framestats。
    let (mem, cpu, gfx) = tokio::join!(
        exec_adb(adb, &mem_args, 4000),
        exec_adb(adb, &cpu_args, 5000),
        exec_adb(adb, &gfx_ref, 4000),
    );

    // 任一命令级失败（含超时）即整拍跳过——抛出而非填 0。
    let mem = mem?;
    let cpu = cpu?;
    let gfx = gfx?;

    let fps_source = match &pkg {
        Some(p) => format!("adb shell dumpsys gfxinfo {p} framestats"),
        None => "adb shell dumpsys gfxinfo framestats".to_string(),
    };

    Ok(PerformanceMetrics {
        provider: "android".to_string(),
        cpu_usage: parse_cpu_usage(&cpu.stdout),
        memory_usage: parse_memory_usage(&mem.stdout),
        fps: parse_gfx_info(&gfx.stdout),
        package_name: foreground.package_name.clone(),
        activity_name: foreground.activity_name.clone(),
        android_metrics: Some(AndroidPerformancePayload {
            source: "android".to_string(),
            cpu_source: Some("adb shell top -n 1".to_string()),
            memory_source: Some("adb shell cat /proc/meminfo".to_string()),
            fps_source: Some(fps_source),
        }),
        pico_metrics: None,
        pico_metrics_state: None,
        pico_metrics_message: None,
        pico_app_support: None,
        pico_support_message: None,
    })
}

/// 带 TTL 缓存的前台应用解析。解析失败/无包名时沿用上次有效值，避免 gfxinfo 丢前台目标。
pub async fn get_foreground_app_context_cached(adb: &Path, device_id: &str) -> ForegroundAppContext {
    if let Some((ctx, at)) = foreground_cache().lock().ok().and_then(|m| m.get(device_id).cloned()) {
        if at.elapsed().as_millis() < FOREGROUND_APP_TTL_MS {
            return ctx;
        }
    }

    let resolved = get_foreground_app_context(adb, device_id).await;
    // 只缓存解析出包名的有效结果；否则沿用旧值（若有）。
    if resolved.package_name.is_some() {
        if let Ok(mut map) = foreground_cache().lock() {
            map.insert(device_id.to_string(), (resolved.clone(), Instant::now()));
        }
        return resolved;
    }
    foreground_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(device_id).map(|(c, _)| c.clone()))
        .unwrap_or(resolved)
}

async fn get_foreground_app_context(adb: &Path, device_id: &str) -> ForegroundAppContext {
    // 先试 dumpsys window windows。
    if let Ok(out) = exec_adb(
        adb,
        &["-s", device_id, "shell", "dumpsys", "window", "windows"],
        4000,
    )
    .await
    {
        let from_window = parse_foreground_app_from_window(&out.stdout);
        if from_window.package_name.is_some() {
            return from_window;
        }
    }

    // 回退 dumpsys activity activities，取 RESUMED（或栈首）。
    if let Ok(out) = exec_adb(
        adb,
        &["-s", device_id, "shell", "dumpsys", "activity", "activities"],
        4000,
    )
    .await
    {
        let activities = parse_activity_stack(&out.stdout, None, now_ms());
        let resumed = activities
            .iter()
            .find(|e| e.state.to_uppercase() == "RESUMED")
            .or_else(|| activities.first());
        if let Some(e) = resumed {
            return ForegroundAppContext {
                package_name: Some(e.package_name.clone()),
                activity_name: Some(e.activity_name.clone()),
            };
        }
    }

    ForegroundAppContext::default()
}

/// 进程列表（`ps`）。失败如原版 swallow → 返回空列表。
pub async fn get_processes(adb: &Path, device_id: &str) -> Vec<ProcessInfo> {
    match exec_adb(adb, &["-s", device_id, "shell", "ps"], 8000).await {
        Ok(out) => parse_processes(&out.stdout),
        Err(_) => Vec::new(),
    }
}

/// 正在运行的包名集合。优先 `ps -A`，失败回退 `ps`；整体失败 → 空列表（对齐原 getRunningPackages）。
pub async fn get_running_packages(adb: &Path, device_id: &str) -> Vec<String> {
    let stdout = match exec_adb(adb, &["-s", device_id, "shell", "ps", "-A"], 8000).await {
        Ok(out) => out.stdout,
        Err(_) => match exec_adb(adb, &["-s", device_id, "shell", "ps"], 8000).await {
            Ok(out) => out.stdout,
            Err(_) => return Vec::new(),
        },
    };
    parse_running_packages(&stdout)
}

/// Activity 栈（`dumpsys activity activities`）。失败 → 空列表（对齐 ADBManager 包装层 swallow）。
pub async fn get_activity_stack(
    adb: &Path,
    device_id: &str,
    package_filter: Option<&str>,
) -> Vec<ActivityStackEntry> {
    match exec_adb(
        adb,
        &["-s", device_id, "shell", "dumpsys", "activity", "activities"],
        8000,
    )
    .await
    {
        Ok(out) => parse_activity_stack(&out.stdout, package_filter, now_ms()),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    //! 时间轴联动 + 过滤打标记的后端数据支撑（T2.9）：锁死前端硬依赖的 metrics 序列化键名。
    //! 前端 perfFormat.metricValueOf / getGpuValue 按这些精确 camelCase 键读值——改名即静默断曲线/标记。
    use super::*;
    use crate::adb::runtime_types::{MetricReading, PicoMetricsPayload};

    #[test]
    fn android_metrics_serializes_frontend_keys() {
        let m = PerformanceMetrics {
            provider: "android".into(),
            cpu_usage: 12.5,
            memory_usage: 2048.0,
            fps: 60.0,
            package_name: Some("com.x".into()),
            activity_name: None,
            android_metrics: None,
            pico_metrics: None,
            pico_metrics_state: None,
            pico_metrics_message: None,
            pico_app_support: None,
            pico_support_message: None,
        };
        let v = serde_json::to_value(&m).unwrap();
        // metricValueOf 读 fps / cpuUsage / memoryUsage；shouldCrop 等读 provider。
        assert_eq!(v["provider"], "android");
        assert_eq!(v["fps"], 60.0);
        assert_eq!(v["cpuUsage"], 12.5);
        assert_eq!(v["memoryUsage"], 2048.0);
        assert_eq!(v["packageName"], "com.x");
        // None 字段不序列化，前端按 undefined 处理。
        assert!(v.get("picoMetrics").is_none());
        assert!(v.get("activityName").is_none());
    }

    #[test]
    fn pico_gpu_value_serializes_for_getgpuvalue() {
        let pico = PicoMetricsPayload {
            gpu_util: Some(MetricReading {
                value: 87.0,
                unit: Some("%".into()),
                max_value: None,
                max_value_unit: None,
                raw: None,
            }),
            ..Default::default()
        };
        let m = PerformanceMetrics {
            provider: "pico".into(),
            cpu_usage: 0.0,
            memory_usage: 0.0,
            fps: 90.0,
            package_name: None,
            activity_name: None,
            android_metrics: None,
            pico_metrics: Some(pico),
            pico_metrics_state: Some("native".into()),
            pico_metrics_message: None,
            pico_app_support: None,
            pico_support_message: None,
        };
        let v = serde_json::to_value(&m).unwrap();
        // getGpuValue 读 metrics.picoMetrics.gpuUtil.value；fps 统一口径同字段。
        assert_eq!(v["picoMetrics"]["gpuUtil"]["value"], 87.0);
        assert_eq!(v["fps"], 90.0);
    }
}
