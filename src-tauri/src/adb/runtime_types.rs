//! 运行情况采样的数据结构（对齐 shared/types 的 ProcessInfo / ActivityStackEntry /
//! MetricReading / PicoMetricsPayload）。
//! 与解析逻辑（runtime_parsers）、采集编排（runtime_inspector）分离，集中类型定义。

use std::collections::BTreeMap;

use serde::Serialize;

/// 进程信息（对齐 shared/types 的 ProcessInfo）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: i64,
    pub ppid: i64,
    pub name: String,
    pub package_name: String,
    pub cpu_usage: f64,
    pub memory_usage: f64,
    pub status: String, // 原版恒为 "running"
}

/// Activity 栈条目（对齐 shared/types 的 ActivityStackEntry）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStackEntry {
    pub id: String,
    pub package_name: String,
    pub activity_name: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub raw: String,
}

/// 前台应用上下文（包名 + Activity 名）。
#[derive(Debug, Clone, Default)]
pub struct ForegroundAppContext {
    pub package_name: Option<String>,
    pub activity_name: Option<String>,
}

/// 单项指标读数（对齐 shared/types 的 MetricReading）。
/// App 分类内存（dumpsys meminfo <pkg> 的 App Summary 段，单位 KB）：
/// Java 托管堆 / Native 原生堆 / Graphics 图形(显存相关) / Code 代码 so / Stack 线程栈 / total 合计 PSS。
/// 用于「内存涨在哪一类」的定位（前端堆叠面积图 + 各类 hover 分析提示）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBreakdown {
    pub java_kb: f64,
    pub native_kb: f64,
    pub graphics_kb: f64,
    pub code_kb: f64,
    pub stack_kb: f64,
    pub total_kb: f64,
}

/// 单拍帧耗时统计（gfxinfo framestats 每帧 FrameCompleted-IntendedVsync 聚合，单位 ms）。
/// 比单一平均 FPS 更能看清「卡不卡、多狠」：分位看长尾（p99 抓偶发大卡顿）、jank% 看掉帧密度。
/// 每帧耗时 = 该帧从计划上屏(IntendedVsync)到渲染完成(FrameCompleted)的总耗时；
/// 超过一帧预算(budget_ms = 1000/刷新率)即判定为 jank（这一帧没能在它的 vsync 间隔内做完，会掉帧）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameTimingStats {
    pub frame_count: u32,   // 本拍纳入统计的有效帧数（Flags=0 的正常帧）
    pub avg_ms: f64,
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub jank_count: u32,    // 耗时 > budget_ms 的帧数
    pub jank_percent: f64,  // jank_count / frame_count * 100
    pub budget_ms: f64,     // 判定 jank 的帧预算 = 1000/refresh_hz
    pub refresh_hz: f64,    // 采用的设备刷新率（dumpsys display 探测，未知回退 60）
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricReading {
    pub value: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

/// Pico 官方指标载荷（对齐 shared/types 的 PicoMetricsPayload）。
/// 用 BTreeMap 保证 rawFields 序列化顺序稳定（便于对拍/导出复现）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PicoMetricsPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_fields: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<MetricReading>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtp: Option<MetricReading>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_cpu: Option<MetricReading>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_gpu: Option<MetricReading>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub atw_gpu: Option<MetricReading>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_util: Option<MetricReading>,
}
