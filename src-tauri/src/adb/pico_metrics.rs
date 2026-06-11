//! Pico 官方指标读取（对应原 picoMetrics.ts 的 PicoMetricsReader）。
//! 仅支持已集成 XR Profiling Toolkit 的 Pico 应用；通过常驻 PxrMetric 流读最新行并解析
//! FPS/MTP/FrmCpu/FrmGpu/ATWGPU/GPU。设备检测、hub 启动、应用支持检测均带缓存/节流。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use super::error::AdbError;
use super::manager::exec_adb;
use super::pico_metrics_stream;
use super::pico_parsers::{parse_entry_map, parse_ratio_metric, parse_single_metric};
use super::runtime_inspector::PerformanceMetrics;
use super::runtime_types::{ForegroundAppContext, PicoMetricsPayload};

// 设备端先按 tag 过滤再 tail，仅把这几行传回 PC——绝不全量 dump（游戏每帧一条，长会话可达数十 MB）。
// 整条管道作为单个参数交给 adb shell，由设备端解释管道。
const PICO_METRICS_LOG_ARG: &str = "logcat -d -v time -s PxrMetric | tail -n 20";
const PICO_HUB_START_THROTTLE_MS: u128 = 15000;
const PICO_METRICS_FRESH_MS: u128 = 3000; // 流缓存最新行有效期（Pico ~1 行/秒，留 3s 容忍）。
const PICO_METRICS_WARMUP_MS: u128 = 2500; // 流刚启动预热窗口：用一次性 tail 兜底，避免开头闪烁回退。
const XR_PROFILING_TOOLKIT_MARKERS: [&str; 4] = [
    "XRProfilingToolkitLogger",
    "XR_ProfilingToolkit",
    "CommandRunner",
    "CommandQueue",
];

/// 前台应用是否集成 XR Profiling Toolkit（对齐 shared/types 的 PicoAppSupport*）。
#[derive(Debug, Clone)]
pub struct PicoAppSupportResult {
    pub status: String, // "supported" | "unsupported" | "unknown"
    pub message: String,
}

fn device_cache() -> &'static Mutex<HashMap<String, bool>> {
    static C: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hub_started_at() -> &'static Mutex<HashMap<String, Instant>> {
    static C: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn app_support_cache() -> &'static Mutex<HashMap<String, PicoAppSupportResult>> {
    static C: OnceLock<Mutex<HashMap<String, PicoAppSupportResult>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn get_device_prop(adb: &Path, device_id: &str, prop: &str) -> String {
    match exec_adb(adb, &["-s", device_id, "shell", "getprop", prop], 4000).await {
        Ok(out) => out.stdout.trim().to_string(),
        Err(_) => String::new(),
    }
}

/// 是否 Pico 设备：fingerprint（manufacturer/brand/model/device）含 "pico"。带缓存。
pub async fn is_pico_device(adb: &Path, device_id: &str) -> bool {
    if let Ok(c) = device_cache().lock() {
        if let Some(v) = c.get(device_id) {
            return *v;
        }
    }
    let parts = [
        get_device_prop(adb, device_id, "ro.product.manufacturer").await,
        get_device_prop(adb, device_id, "ro.product.brand").await,
        get_device_prop(adb, device_id, "ro.product.model").await,
        get_device_prop(adb, device_id, "ro.product.device").await,
    ];
    let identity = parts
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let is_pico = identity.contains("pico");
    if let Ok(mut c) = device_cache().lock() {
        c.insert(device_id.to_string(), is_pico);
    }
    is_pico
}

/// 续开 Pico developer hub（streaming）。15s 节流；某些固件无此 action，忽略错误继续。
pub async fn ensure_metrics_hub_started(adb: &Path, device_id: &str) {
    if let Ok(m) = hub_started_at().lock() {
        if let Some(at) = m.get(device_id) {
            if at.elapsed().as_millis() < PICO_HUB_START_THROTTLE_MS {
                return;
            }
        }
    }
    for action in [
        "com.pico.developer.hub.streaming.on",
        "com.pico.developer.hub.on",
    ] {
        let _ = exec_adb(
            adb,
            &[
                "-s",
                device_id,
                "shell",
                "am",
                "startservice",
                "-a",
                action,
                "com.pico.developerhubservice/.HubService",
            ],
            4000,
        )
        .await;
    }
    if let Ok(mut m) = hub_started_at().lock() {
        m.insert(device_id.to_string(), Instant::now());
    }
}

fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 检测前台应用是否集成 XR Profiling Toolkit（读 APK grep 运行时标识）。带 dev:pkg 缓存。
pub async fn detect_foreground_app_support(
    adb: &Path,
    device_id: &str,
    foreground: &ForegroundAppContext,
) -> PicoAppSupportResult {
    let package_name = foreground
        .package_name
        .as_ref()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let package_name = match package_name {
        Some(p) => p,
        None => {
            return PicoAppSupportResult {
                status: "unknown".into(),
                message: "未解析到前台应用包名，无法确认是否集成 XR Profiling Toolkit。".into(),
            }
        }
    };

    let cache_key = format!("{device_id}:{package_name}");
    if let Ok(c) = app_support_cache().lock() {
        if let Some(v) = c.get(&cache_key) {
            return v.clone();
        }
    }

    let result = detect_app_support_from_apk(adb, device_id, &package_name).await;
    if let Ok(mut c) = app_support_cache().lock() {
        c.insert(cache_key, result.clone());
    }
    result
}

async fn detect_app_support_from_apk(
    adb: &Path,
    device_id: &str,
    package_name: &str,
) -> PicoAppSupportResult {
    // 标记均为普通标识符（无正则元字符），直接以 | 连接。
    let marker_pattern = XR_PROFILING_TOOLKIT_MARKERS.join("|");
    let quoted = quote_shell_arg(package_name);
    let script = format!(
        r#"apk_paths=$(pm path {quoted} 2>/dev/null | sed 's/^package://')
if [ -z "$apk_paths" ]; then
  echo ADM_PICO_SUPPORT_UNKNOWN_NO_APK
  exit 0
fi
while IFS= read -r apk_path; do
  if [ -n "$apk_path" ] && grep -a -m 1 -E '{marker_pattern}' "$apk_path" >/dev/null 2>&1; then
    echo ADM_PICO_SUPPORT_SUPPORTED
    exit 0
  fi
done <<EOF
$apk_paths
EOF
echo ADM_PICO_SUPPORT_UNSUPPORTED"#
    );

    let output = match exec_adb(adb, &["-s", device_id, "shell", "sh", "-c", &script], 6000).await {
        Ok(out) => out.stdout.trim().to_string(),
        Err(_) => {
            return PicoAppSupportResult {
                status: "unknown".into(),
                message: "无法读取前台应用 APK，需应用侧确认是否集成 XR Profiling Toolkit。".into(),
            }
        }
    };

    if output.contains("ADM_PICO_SUPPORT_SUPPORTED") {
        PicoAppSupportResult {
            status: "supported".into(),
            message: "已在前台应用 APK 中检测到 XR Profiling Toolkit 运行时标识。".into(),
        }
    } else if output.contains("ADM_PICO_SUPPORT_UNSUPPORTED") {
        PicoAppSupportResult {
            status: "unsupported".into(),
            message: "前台应用 APK 未检测到 XR Profiling Toolkit 运行时标识，Pico 官方指标不可用。"
                .into(),
        }
    } else {
        PicoAppSupportResult {
            status: "unknown".into(),
            message: "未找到前台应用 APK，无法确认是否集成 XR Profiling Toolkit。".into(),
        }
    }
}

/// 把一行 PxrMetric 解析为 PerformanceMetrics（provider=pico，cpu/mem 占位 0，由上层旁路填充）。
pub fn parse_metrics_line(line: &str, foreground: &ForegroundAppContext) -> PerformanceMetrics {
    let payload = parse_entry_map(line);

    let fps = parse_ratio_metric(payload.get("FPS"));
    let mtp = parse_single_metric(payload.get("MTP"));
    let frame_cpu = parse_single_metric(payload.get("FrmCpu"));
    let frame_gpu = parse_single_metric(payload.get("FrmGpu"));
    let atw_gpu = parse_single_metric(payload.get("ATWGPU"));
    let gpu_util = parse_ratio_metric(payload.get("GPU"));
    let package_name = payload
        .get("Pkg")
        .cloned()
        .or_else(|| foreground.package_name.clone());

    PerformanceMetrics {
        provider: "pico".to_string(),
        cpu_usage: 0.0,
        memory_usage: 0.0,
        fps: fps.as_ref().map(|r| r.value).unwrap_or(0.0),
        battery_level: None, // dispatch 层并发回填
        memory_breakdown: None, // 纯 Pico 指标行无 Android meminfo，dispatch 旁路时由 android 提供
        frame_timing: None, // 纯 Pico 指标行无 gfxinfo framestats，dispatch 旁路时由 android 提供
        package_name,
        activity_name: foreground.activity_name.clone(),
        android_metrics: None,
        pico_metrics: Some(PicoMetricsPayload {
            raw_line: Some(line.to_string()),
            raw_fields: Some(payload),
            fps,
            mtp,
            frame_cpu,
            frame_gpu,
            atw_gpu,
            gpu_util,
        }),
        pico_metrics_state: None,
        pico_metrics_message: None,
        pico_app_support: None,
        pico_support_message: None,
    }
}

/// 是否含原生 Pico 指标（任一字段有值）。对齐原 hasNativePicoMetrics。
pub fn has_native_pico_metrics(p: &PicoMetricsPayload) -> bool {
    p.fps.is_some()
        || p.mtp.is_some()
        || p.frame_cpu.is_some()
        || p.frame_gpu.is_some()
        || p.atw_gpu.is_some()
        || p.gpu_util.is_some()
}

/// 一次性读取最近一行 PxrMetric（设备端先过滤再 tail）。失败/无数据 → None。
async fn read_latest_line_once(adb: &Path, device_id: &str) -> Option<String> {
    let out = exec_adb(adb, &["-s", device_id, "shell", PICO_METRICS_LOG_ARG], 4000)
        .await
        .ok()?;
    out.stdout
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .rev()
        .find(|l| l.contains("PxrMetric"))
        .map(|l| l.to_string())
}

/// 读取 Pico 实时指标（常驻流优先，冷启动预热用一次性 tail 兜底）。无新鲜数据 → Err。
pub async fn get_pico_performance_metrics(
    adb: &Path,
    device_id: &str,
    foreground: &ForegroundAppContext,
) -> Result<PerformanceMetrics, AdbError> {
    // 幂等续开 hub + 确保常驻流在跑。
    ensure_metrics_hub_started(adb, device_id).await;
    pico_metrics_stream::ensure_streaming(adb, device_id).await;

    if let Some(line) = pico_metrics_stream::get_fresh_line(device_id, PICO_METRICS_FRESH_MS) {
        return Ok(parse_metrics_line(&line, foreground));
    }
    // 冷启动预热期：流刚起还没收到第一行，用一次性 tail 兜底，避免开头闪烁回退。
    if pico_metrics_stream::is_warming_up(device_id, PICO_METRICS_WARMUP_MS) {
        if let Some(line) = read_latest_line_once(adb, device_id).await {
            return Ok(parse_metrics_line(&line, foreground));
        }
    }
    // 预热已过仍无新鲜数据 = 当前确无最近 Pico 指标 → 交上层回退/跳过，绝不显示旧值。
    Err(AdbError::custom(
        "PICO_METRICS_UNAVAILABLE",
        "未读取到 PICO Metrics 实时数据。".into(),
        "请确认设备处于 VR 应用前台、且该应用已集成 XR Profiling Toolkit。",
        "no fresh PxrMetric line".into(),
    ))
}
