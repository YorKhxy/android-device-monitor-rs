//! 性能采样分流（对应原 runtimeInspector.ts 的 getPerformanceMetrics 编排 +
//! buildPicoFallbackMetrics + hasNativePicoMetrics 的上层组合）。
//! Pico 设备走 Pico 官方指标 + Android 旁路，否则走纯 Android 采样。
//!
//! 失败语义遵守 gap-not-zero：Pico 无数据 → 回退 Android；回退采样若命令级失败则整拍 Err（断点）。

use std::path::Path;

use super::error::AdbError;
use super::pico_metrics::{self, PicoAppSupportResult};
use super::runtime_inspector::{get_android_performance_metrics, PerformanceMetrics};
use super::runtime_types::{ForegroundAppContext, PicoMetricsPayload};

/// 性能采样总入口：在分流采样的同时并发取一次电量（dumpsys battery），统一回填到结果——
/// android/pico 所有路径通用，并发故不增加每拍延迟；取不到电量为 None，不影响整拍成败。
pub async fn get_performance_metrics(
    adb: &Path,
    device_id: &str,
    foreground: &ForegroundAppContext,
    prefer_pico: bool,
) -> Result<PerformanceMetrics, AdbError> {
    let (metrics, battery) = tokio::join!(
        dispatch_performance_metrics(adb, device_id, foreground, prefer_pico),
        super::manager::get_battery_level(adb, device_id),
    );
    let mut metrics = metrics?;
    metrics.battery_level = battery;
    Ok(metrics)
}

/// 分流采样：Pico 设备走 Pico 官方指标 + Android 旁路，否则纯 Android。`prefer_pico` 显式指定时跳过探测。
async fn dispatch_performance_metrics(
    adb: &Path,
    device_id: &str,
    foreground: &ForegroundAppContext,
    prefer_pico: bool,
) -> Result<PerformanceMetrics, AdbError> {
    let is_pico = prefer_pico || pico_metrics::is_pico_device(adb, device_id).await;
    if !is_pico {
        return get_android_performance_metrics(adb, device_id, foreground).await;
    }

    let app_support = pico_metrics::detect_foreground_app_support(adb, device_id, foreground).await;
    match pico_metrics::get_pico_performance_metrics(adb, device_id, foreground).await {
        Ok(pico) => {
            let has_native = pico
                .pico_metrics
                .as_ref()
                .map(pico_metrics::has_native_pico_metrics)
                .unwrap_or(false);
            if has_native {
                // CPU/内存走 Android 采样旁路。旁路命令级失败时不 ?? 0 兜底（那会让真实 Pico FPS 配假
                // 0 CPU/内存），而是回退到 Pico fallback；fallback 的 Android 采样若也失败则整拍 Err。
                match get_android_performance_metrics(adb, device_id, foreground).await {
                    Ok(android) => Ok(combine_native_pico(pico, android, app_support)),
                    Err(_) => {
                        build_pico_fallback(
                            adb,
                            device_id,
                            foreground,
                            app_support,
                            "Pico 官方 Metrics 服务未返回可解析数据，当前先显示通用 Android 采样。",
                        )
                        .await
                    }
                }
            } else {
                build_pico_fallback(
                    adb,
                    device_id,
                    foreground,
                    app_support,
                    "当前固件未返回 Pico 官方实时指标，已回退为通用 Android 采样。",
                )
                .await
            }
        }
        Err(_) => {
            build_pico_fallback(
                adb,
                device_id,
                foreground,
                app_support,
                "Pico 官方 Metrics 服务未返回可解析数据，当前先显示通用 Android 采样。",
            )
            .await
        }
    }
}

/// 原生 Pico 指标 + Android 旁路（CPU/内存）合并（对齐原 native 分支）。
/// FPS 统一口径：优先 Pico native fps，缺失退回 Android fps（不分流）。
fn combine_native_pico(
    pico: PerformanceMetrics,
    android: PerformanceMetrics,
    app_support: PicoAppSupportResult,
) -> PerformanceMetrics {
    let native_fps = pico
        .pico_metrics
        .as_ref()
        .and_then(|p| p.fps.as_ref())
        .map(|r| r.value)
        .unwrap_or(android.fps);
    PerformanceMetrics {
        provider: "pico".to_string(),
        cpu_usage: android.cpu_usage,
        memory_usage: android.memory_usage,
        fps: native_fps,
        battery_level: None, // dispatch 层并发回填
        memory_breakdown: android.memory_breakdown, // 复用 Android 旁路采到的分类内存
        package_name: pico.package_name,
        activity_name: pico.activity_name,
        android_metrics: android.android_metrics,
        pico_metrics: pico.pico_metrics,
        pico_metrics_state: Some("native".to_string()),
        pico_metrics_message: None,
        pico_app_support: Some(app_support.status),
        pico_support_message: Some(app_support.message),
    }
}

/// Pico 回退：用 Android 采样填充，标记 provider=pico + 回退态。Android 采样命令级失败则整拍 Err。
async fn build_pico_fallback(
    adb: &Path,
    device_id: &str,
    foreground: &ForegroundAppContext,
    app_support: PicoAppSupportResult,
    message: &str,
) -> Result<PerformanceMetrics, AdbError> {
    let android = get_android_performance_metrics(adb, device_id, foreground).await?;
    let useful = android.cpu_usage > 0.0 || android.memory_usage > 0.0 || android.fps > 0.0;
    Ok(PerformanceMetrics {
        provider: "pico".to_string(),
        cpu_usage: android.cpu_usage,
        memory_usage: android.memory_usage,
        fps: android.fps,
        battery_level: None, // dispatch 层并发回填
        memory_breakdown: android.memory_breakdown, // 复用 Android 旁路采到的分类内存
        package_name: android.package_name,
        activity_name: android.activity_name,
        android_metrics: android.android_metrics,
        pico_metrics: Some(PicoMetricsPayload::default()),
        pico_metrics_state: Some(if useful { "fallback" } else { "unavailable" }.to_string()),
        pico_metrics_message: Some(message.to_string()),
        pico_app_support: Some(app_support.status),
        pico_support_message: Some(app_support.message),
    })
}
