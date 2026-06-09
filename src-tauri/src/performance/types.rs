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

#[cfg(test)]
mod tests {
    //! 锁死前端回看/时间轴硬依赖的会话序列化键名（T2.9 数据支撑）。
    use super::*;
    use crate::adb::capture_segment::CaptureSegmentMeta;

    #[test]
    fn session_serializes_frontend_keys() {
        let session = CaptureSession {
            id: "sn-123".into(),
            device_id: "sn".into(),
            device_sn: "sn".into(),
            title: None,
            provider: "pico-screenrecord".into(),
            status: "completed".into(),
            started_at: 1_700_000_000_000,
            ended_at: Some(1_700_000_010_000),
            duration_ms: 10_000,
            single_eye_video: Some(false),
            video_segments: vec![CaptureSegmentMeta {
                index: 0,
                file_name: "seg-0.mp4".into(),
                start_ms: 0,
                end_ms: 5_000,
                size_bytes: 1024,
            }],
            data_relative_path: "performance-captures/sn-123/data/samples.jsonl".into(),
            screenshot_dir: Some("performance-captures/sn-123/screenshots".into()),
            package_name: None,
            activity_name: None,
            size_bytes: Some(1024),
            error: None,
        };
        let v = serde_json::to_value(&session).unwrap();
        // captureTotalMs 读 durationMs / videoSegments[].endMs；replay 读 startedAt；shouldCrop 读 provider。
        assert_eq!(v["startedAt"], 1_700_000_000_000_i64);
        assert_eq!(v["durationMs"], 10_000);
        assert_eq!(v["provider"], "pico-screenrecord");
        assert_eq!(v["videoSegments"][0]["endMs"], 5_000);
        assert_eq!(v["videoSegments"][0]["fileName"], "seg-0.mp4");
        assert_eq!(v["dataRelativePath"], "performance-captures/sn-123/data/samples.jsonl");
    }
}
