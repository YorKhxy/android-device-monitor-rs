//! adb 引擎模块（P1）：bundled adb 定位、命令执行、设备操作、监控、错误分类。

pub mod binary;
pub mod commands;
pub mod error;
pub mod install;
pub mod manager;
pub mod monitor;
pub mod performance_dispatch;
pub mod pico_metrics;
pub mod pico_metrics_stream;
pub mod pico_parsers;
pub mod runtime_inspector;
pub mod runtime_parsers;
pub mod runtime_types;
