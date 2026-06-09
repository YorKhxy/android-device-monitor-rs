//! bundled scrcpy 定位（T3.2，仿 adb/binary.rs）。
//! 解析顺序：生产 resource_dir → 开发期 exe 上级的 src-tauri/scrcpy。
//! 路径全从锚点推导，不硬编码盘符。
//!
//! 资源接入三环节（见 .claude/feedback/feature-must-work-out-of-box-after-packaging.md）：
//!   1. 准备：scripts/prepare-scrcpy.mjs 把 scrcpy 下到 src-tauri/scrcpy/<os>/（不入库）
//!   2. 打包清单：tauri.conf.json bundle.resources 列 "scrcpy/**/*"
//!   3. 运行时解析：本文件 resolve_scrcpy_path（生产 resource_dir + 开发相对回退）

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
const SCRCPY_EXE: &str = "scrcpy.exe";
#[cfg(not(target_os = "windows"))]
const SCRCPY_EXE: &str = "scrcpy";

fn platform_target() -> &'static str {
    if cfg!(target_os = "windows") {
        "win"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// scrcpy 可执行的相对路径：scrcpy/<os>/scrcpy(.exe)（解压包内容平铺在 <os>/ 下）。
fn relative_scrcpy() -> PathBuf {
    Path::new("scrcpy").join(platform_target()).join(SCRCPY_EXE)
}

/// 解析 bundled scrcpy 的绝对路径；找不到返回 None。
/// scrcpy.exe 同目录须含 scrcpy-server 与配套 dll（prepare 脚本整包平铺，不拆分）。
pub fn resolve_scrcpy_path(app: &AppHandle) -> Option<PathBuf> {
    let rel = relative_scrcpy();
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 生产：资源目录（tauri bundle resources → resource_dir/scrcpy/...）
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join(&rel));
    }

    // 开发：exe 在 src-tauri/target/{debug,release}/，向上两级即 src-tauri，下面有 scrcpy
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("..").join("..").join(&rel));
            candidates.push(dir.join("..").join("..").join("..").join(&rel));
        }
    }

    candidates.into_iter().find(|p| p.is_file())
}

/// 启动投屏的可选参数（对齐前端 shared/types 的 MirrorStartOptions）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStartOptions {
    pub window_title: Option<String>,
    pub is_pico: Option<bool>,
    pub max_size: Option<u32>,
    pub bit_rate: Option<String>,
    /// 启动时是否直接把声音转电脑（T3.5：投屏成功后据此起音频进程）。
    pub forward_audio: Option<bool>,
}

/// 构建视频主进程 scrcpy 参数：恒 --no-audio（声音由独立音频进程承载，见 T3.5），
/// 附加分辨率上限 / 码率 / 窗口标题 / Pico 单眼裁切（crop 由 T3.4 计算后传入）。
pub fn build_video_args(
    device_id: &str,
    options: &MirrorStartOptions,
    crop: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-s".to_string(),
        device_id.to_string(),
        "--no-audio".to_string(),
    ];
    if let Some(max) = options.max_size {
        args.push(format!("--max-size={max}"));
    }
    if let Some(rate) = options.bit_rate.as_deref().filter(|r| !r.is_empty()) {
        args.push(format!("--video-bit-rate={rate}"));
    }
    if let Some(c) = crop.filter(|c| !c.is_empty()) {
        args.push(format!("--crop={c}"));
    }
    let title = options
        .window_title
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| format!("投屏 - {device_id}"));
    args.push(format!("--window-title={title}"));
    args
}

/// 构建独立「纯音频」scrcpy 进程参数（无视频/无操控/无窗口，仅把设备声音转电脑）。
/// 返回 (参数, 音频模式)：
/// - Android 13+（API≥33）：--audio-dup（隐含 --audio-source=playback），设备与电脑同时出声 → "both"
/// - 低版本：--audio-source=output，设备静音、仅电脑出声 → "pc-only"
pub fn build_audio_args(device_id: &str, api_level: Option<u32>) -> (Vec<String>, &'static str) {
    let mut args = vec![
        "-s".to_string(),
        device_id.to_string(),
        "--no-video".to_string(),
        "--no-control".to_string(),
        "--no-window".to_string(),
    ];
    if api_level.is_some_and(|v| v >= 33) {
        args.push("--audio-dup".to_string());
        (args, "both")
    } else {
        args.push("--audio-source=output".to_string());
        (args, "pc-only")
    }
}

/// 构建 scrcpy 录制（含音）单段参数（T2.10）：PC 端 `--record` 直接录到本地文件（视频+音频同一 MP4），
/// `--no-window --no-control` 纯录制不显示/不操控；`--audio-dup` 设备与电脑同时出声（仅 A13+ 走此路径）；
/// `--time-limit` 到点自动 finalize（中间段正常收尾，规避 Windows 强杀损坏 mp4 的问题）。
pub fn build_record_args(
    device_id: &str,
    record_path: &str,
    time_limit_secs: u32,
    bit_rate_mbps: u32,
) -> Vec<String> {
    vec![
        "-s".to_string(),
        device_id.to_string(),
        "--no-window".to_string(),
        "--no-control".to_string(),
        format!("--video-bit-rate={bit_rate_mbps}M"),
        "--audio-dup".to_string(),
        format!("--time-limit={time_limit_secs}"),
        format!("--record={record_path}"),
    ]
}

/// 解析 `adb shell wm size` 输出的屏幕分辨率，返回 (宽, 高)。
/// 优先 `Override size`（实际生效），否则 `Physical size`。形如 "Physical size: 3840x1920"。
pub fn parse_screen_size(wm_output: &str) -> Option<(u32, u32)> {
    fn parse_wh(s: &str) -> Option<(u32, u32)> {
        let (w, h) = s.trim().split_once('x')?;
        Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
    }
    let pick = |key: &str| {
        wm_output
            .lines()
            .find_map(|l| l.trim().strip_prefix(key).and_then(parse_wh))
    };
    pick("Override size:").or_else(|| pick("Physical size:"))
}

/// Pico 双眼并排画面取左眼：--crop=宽/2:高:0:0（设备自然方向坐标）。
/// 宽不足 2 时返回 None（无法裁出有效单眼）。
pub fn single_eye_crop(width: u32, height: u32) -> Option<String> {
    if width < 2 || height == 0 {
        return None;
    }
    Some(format!("{}:{}:0:0", width / 2, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_args_default_no_audio_and_title() {
        let args = build_video_args("ABC123", &MirrorStartOptions::default(), None);
        assert_eq!(args[0], "-s");
        assert_eq!(args[1], "ABC123");
        assert!(args.contains(&"--no-audio".to_string()));
        assert!(args.contains(&"--window-title=投屏 - ABC123".to_string()));
        // 默认无 max-size / bit-rate / crop。
        assert!(!args.iter().any(|a| a.starts_with("--max-size")));
        assert!(!args.iter().any(|a| a.starts_with("--video-bit-rate")));
        assert!(!args.iter().any(|a| a.starts_with("--crop")));
    }

    #[test]
    fn video_args_full_options_and_crop() {
        let options = MirrorStartOptions {
            window_title: Some("自定义".to_string()),
            is_pico: Some(true),
            max_size: Some(1280),
            bit_rate: Some("4M".to_string()),
            forward_audio: None,
        };
        let args = build_video_args("dev1", &options, Some("960:1920:0:0"));
        assert!(args.contains(&"--max-size=1280".to_string()));
        assert!(args.contains(&"--video-bit-rate=4M".to_string()));
        assert!(args.contains(&"--crop=960:1920:0:0".to_string()));
        assert!(args.contains(&"--window-title=自定义".to_string()));
        assert!(args.contains(&"--no-audio".to_string()));
    }

    #[test]
    fn video_args_skips_empty_bit_rate_and_crop() {
        let options = MirrorStartOptions {
            bit_rate: Some(String::new()),
            ..MirrorStartOptions::default()
        };
        let args = build_video_args("d", &options, Some(""));
        assert!(!args.iter().any(|a| a.starts_with("--video-bit-rate")));
        assert!(!args.iter().any(|a| a.starts_with("--crop")));
    }

    #[test]
    fn record_args_has_record_audio_dup_and_time_limit() {
        let args = build_record_args("dev1", "G:/caps/seg-0.mp4", 180, 8);
        assert_eq!(args[0], "-s");
        assert_eq!(args[1], "dev1");
        assert!(args.contains(&"--record=G:/caps/seg-0.mp4".to_string()));
        assert!(args.contains(&"--audio-dup".to_string()));
        assert!(args.contains(&"--time-limit=180".to_string()));
        assert!(args.contains(&"--video-bit-rate=8M".to_string()));
        assert!(args.contains(&"--no-window".to_string()));
        assert!(args.contains(&"--no-control".to_string()));
    }

    #[test]
    fn parse_screen_size_prefers_override() {
        let out = "Physical size: 3840x1920\nOverride size: 1920x1080\n";
        assert_eq!(parse_screen_size(out), Some((1920, 1080)));
    }

    #[test]
    fn parse_screen_size_falls_back_to_physical() {
        assert_eq!(parse_screen_size("Physical size: 3840x1920"), Some((3840, 1920)));
        assert_eq!(parse_screen_size("garbage"), None);
    }

    #[test]
    fn audio_args_dup_for_android13_plus() {
        let (args, mode) = build_audio_args("d1", Some(33));
        assert_eq!(mode, "both");
        assert!(args.contains(&"--audio-dup".to_string()));
        assert!(args.contains(&"--no-video".to_string()));
        assert!(args.contains(&"--no-control".to_string()));
        assert!(args.contains(&"--no-window".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("--audio-source")));
    }

    #[test]
    fn audio_args_output_fallback_below_13_or_unknown() {
        for api in [Some(30u32), None] {
            let (args, mode) = build_audio_args("d1", api);
            assert_eq!(mode, "pc-only");
            assert!(args.contains(&"--audio-source=output".to_string()));
            assert!(!args.contains(&"--audio-dup".to_string()));
        }
    }

    #[test]
    fn single_eye_crop_takes_left_half() {
        assert_eq!(single_eye_crop(3840, 1920), Some("1920:1920:0:0".to_string()));
        // 奇数宽走整数除，丢弃中缝 1px。
        assert_eq!(single_eye_crop(3841, 1920), Some("1920:1920:0:0".to_string()));
        assert_eq!(single_eye_crop(1, 1080), None);
        assert_eq!(single_eye_crop(1920, 0), None);
    }
}
