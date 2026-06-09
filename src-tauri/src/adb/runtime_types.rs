//! 运行情况采样的数据结构（对齐 shared/types 的 ProcessInfo / ActivityStackEntry）。
//! 与解析逻辑（runtime_parsers）、采集编排（runtime_inspector）分离，集中类型定义。

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
