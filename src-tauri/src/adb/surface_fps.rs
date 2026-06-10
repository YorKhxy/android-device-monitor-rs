//! SurfaceFlinger 合成帧率采样（对照探针）。
//!
//! 背景：`dumpsys gfxinfo <pkg> framestats` 只统计 Android **HWUI 视图树**的渲染帧，
//! 内嵌 Unity / 游戏 / 视频画在自己的 **SurfaceView + GL/Vulkan** 上，绕过 HWUI——gfxinfo 看不到。
//! SurfaceFlinger 在**合成器层**按 layer 量真实上屏帧时间戳，谁在出画量谁，能抓到 Unity 的 surface。
//!
//! 用法：`--list` 列 layer → 选目标 App 的 layer（优先 SurfaceView=Unity/游戏面）→ `--latency <layer>`
//! 拿帧时间戳算 fps。best-effort：任一步失败 / 无有效帧 → None，绝不影响主采样。
//! 当前作为「与 gfxinfo 并排对照」的探针，采集曲线口径暂不改。

use std::path::Path;

use super::manager::exec_adb;

/// 一次 SurfaceFlinger 帧率采样结果。
#[derive(Debug, Clone)]
pub struct SurfaceFps {
    pub fps: f64,
    pub layer: String,
}

/// `--latency` 输出中表示「该帧尚未呈现」的哨兵值（i64::MAX），需跳过。
const PENDING_TS: i64 = i64::MAX;

/// 从 `dumpsys SurfaceFlinger --list` 输出中挑目标 layer：
/// 取含包名的行，优先含 `SurfaceView`（Unity/游戏/视频的独立 surface），否则取首个含包名的（App 主 surface）。
pub fn pick_layer(list_output: &str, package: &str) -> Option<String> {
    let candidates: Vec<&str> = list_output
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && l.contains(package))
        .collect();
    candidates
        .iter()
        .find(|l| l.contains("SurfaceView"))
        .or_else(|| candidates.first())
        .map(|s| s.to_string())
}

/// 解析 `dumpsys SurfaceFlinger --latency <layer>` 输出算 fps。
/// 格式：首行 = 刷新周期(ns)；其后每行 3 个时间戳（desiredPresent / actualPresent / frameReady）。
/// 按 actualPresent（第 2 列）相邻帧间隔算帧率；跳过 0 与 pending(i64::MAX) 帧；取最近 60 帧。
pub fn parse_surface_latency_fps(output: &str) -> f64 {
    let mut actual: Vec<i64> = Vec::new();
    for line in output.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        if let Ok(ts) = cols[1].parse::<i64>() {
            if ts > 0 && ts != PENDING_TS {
                actual.push(ts);
            }
        }
    }
    if actual.len() < 2 {
        return 0.0;
    }
    let recent = if actual.len() > 60 {
        &actual[actual.len() - 60..]
    } else {
        &actual[..]
    };
    let span_ns = recent[recent.len() - 1] - recent[0];
    if span_ns <= 0 {
        return 0.0;
    }
    // n 个时间戳 = n-1 个帧间隔。
    let fps = (recent.len() - 1) as f64 / (span_ns as f64 / 1_000_000_000.0);
    if fps.is_finite() && fps > 0.0 {
        (fps * 10.0).round() / 10.0
    } else {
        0.0
    }
}

/// layer 名含 `[]#()` 等，作 `adb shell` 参数时单引号包裹避免设备 shell 二次解析破裂。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 采样目标包当前上屏 surface 的合成帧率。无包名 / 任一步失败 / 无有效帧 → None（best-effort）。
pub async fn sample_surface_fps(adb: &Path, device_id: &str, package: Option<&str>) -> Option<SurfaceFps> {
    let pkg = package?;

    let list = exec_adb(
        adb,
        &["-s", device_id, "shell", "dumpsys", "SurfaceFlinger", "--list"],
        4000,
    )
    .await
    .ok()?;
    let layer = pick_layer(&list.stdout, pkg)?;

    let quoted = shell_quote(&layer);
    let latency = exec_adb(
        adb,
        &["-s", device_id, "shell", "dumpsys", "SurfaceFlinger", "--latency", &quoted],
        4000,
    )
    .await
    .ok()?;

    let fps = parse_surface_latency_fps(&latency.stdout);
    if fps > 0.0 {
        Some(SurfaceFps { fps, layer })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_layer_prefers_surfaceview() {
        let list = "\
com.demo.app/com.demo.app.MainActivity#0
SurfaceView[com.demo.app/com.demo.app.MainActivity]#1(BLAST)
Background for -task
NavigationBar0#0";
        // 含包名且含 SurfaceView 的优先（= 内嵌 Unity 的 surface）。
        assert_eq!(
            pick_layer(list, "com.demo.app").as_deref(),
            Some("SurfaceView[com.demo.app/com.demo.app.MainActivity]#1(BLAST)")
        );
    }

    #[test]
    fn pick_layer_falls_back_to_activity_layer() {
        let list = "com.demo.app/com.demo.app.MainActivity#0\nNavigationBar0#0";
        assert_eq!(
            pick_layer(list, "com.demo.app").as_deref(),
            Some("com.demo.app/com.demo.app.MainActivity#0")
        );
    }

    #[test]
    fn pick_layer_none_when_package_absent() {
        let list = "SystemUI#0\nNavigationBar0#0";
        assert_eq!(pick_layer(list, "com.demo.app"), None);
    }

    #[test]
    fn parse_latency_computes_fps_from_actual_present() {
        // 刷新周期 + 5 帧，actualPresent（第 2 列）间隔 ~16.6ms ≈ 60fps。
        let out = "\
16666666
1000000000 1000000000 1000500000
1000000000 1016666666 1017000000
1000000000 1033333332 1033500000
1000000000 1049999998 1050200000
1000000000 1066666664 1067000000";
        let fps = parse_surface_latency_fps(out);
        // 5 帧 4 间隔，跨度 66.66ms → ~60fps。
        assert!((fps - 60.0).abs() < 1.5, "fps={fps}");
    }

    #[test]
    fn parse_latency_skips_pending_and_zero() {
        let pending = i64::MAX;
        let out = format!(
            "16666666\n0 0 0\n1000000000 1000000000 1000500000\n1000000000 1016666666 1017000000\n1000000000 {pending} {pending}"
        );
        // 只有 2 个有效 actualPresent（间隔 16.66ms → 60fps），pending/0 跳过。
        let fps = parse_surface_latency_fps(&out);
        assert!((fps - 60.0).abs() < 2.0, "fps={fps}");
    }

    #[test]
    fn parse_latency_empty_or_single_frame_is_zero() {
        assert_eq!(parse_surface_latency_fps("16666666"), 0.0);
        assert_eq!(parse_surface_latency_fps("16666666\n1000 1000 1000"), 0.0);
    }
}
