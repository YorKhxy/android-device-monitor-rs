//! 采集会话数据结构（对齐 shared/types 的 PerformanceCaptureSession）。
//! 时间戳用 epoch 毫秒（i64）——前端各处 `new Date(x)` 兜底，故 millis/ISO 皆可，millis 免 chrono。

use serde::{Deserialize, Serialize};

use crate::adb::capture_segment::CaptureSegmentMeta;

/// 一次采集会话的元数据（落盘 manifest.json，并返回渲染层）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSession {
    pub id: String,
    pub device_id: String,
    /// 设备序列号，用于回看列表展示与缺省命名。
    pub device_sn: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// PerformanceCaptureProvider: "android-screenrecord" | "pico-screenrecord" | "pico-sdk"
    pub provider: String,
    /// "recording" | "completed" | "failed"
    pub status: String,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    pub duration_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub single_eye_video: Option<bool>,
    pub video_segments: Vec<CaptureSegmentMeta>,
    pub data_relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 创建会话入参（对齐原 CreateCaptureSessionInput）。
pub struct CreateSessionInput {
    pub device_id: String,
    pub device_sn: String,
    pub provider: String,
    pub single_eye_video: Option<bool>,
    pub package_name: Option<String>,
    pub activity_name: Option<String>,
}

/// finalize 会话入参（对齐原 FinalizeCaptureSessionInput）。
pub struct FinalizeSessionInput {
    pub ended_at: i64,
    pub duration_ms: i64,
    pub status: String, // "completed" | "failed"
    pub error: Option<String>,
}
