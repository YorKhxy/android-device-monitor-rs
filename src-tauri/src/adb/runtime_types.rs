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
