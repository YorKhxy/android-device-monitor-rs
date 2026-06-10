//! SurfaceFlinger 合成帧率采样（对照探针）。
//!
//! 背景：`dumpsys gfxinfo <pkg> framestats` 只统计 Android **HWUI 视图树**渲染帧，内嵌 Unity / 游戏 / 视频
//! 画在自己的 **SurfaceView + GL/Vulkan** 上，绕过 HWUI——gfxinfo 看不到（实测 Unity 启动后 gfxinfo 掉到 ~2fps）。
//!
//! 取数口径：`dumpsys SurfaceFlinger --timestats`（Android 12+ BLAST 兼容；旧的 `--latency` 对 BLAST 层失效）。
//! 它按 layer 直接给 `averageFPS`，含 `SurfaceView[...]@N(BLAST)` 这类 Unity 的合成层。
//! 流程：首拍 `-enable -clear` 启用；其后每拍 `-dump` 读目标 SurfaceView 层 averageFPS → `-clear` 重置窗口
//! （每拍得 ~1 个采样间隔的窗口均值）。best-effort：只要有前台包名就总返回 Some（成功带真实 fps，失败带 0 + 诊断）。

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use super::manager::exec_adb;

/// 一次 SurfaceFlinger 帧率采样结果。
#[derive(Debug, Clone)]
pub struct SurfaceFps {
    pub fps: f64,
    pub layer: String,
}

/// 已启用 timestats 的设备集合（首拍 enable+clear 后登记，避免每拍重复 enable）。
fn primed() -> &'static Mutex<HashSet<String>> {
    static P: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_primed(device_id: &str) -> bool {
    primed().lock().map(|s| s.contains(device_id)).unwrap_or(false)
}

fn mark_primed(device_id: &str) {
    if let Ok(mut s) = primed().lock() {
        s.insert(device_id.to_string());
    }
}

/// 从 `--timestats -dump` 输出解析目标包 SurfaceView 层的 averageFPS。
///
/// 输出按 `layerName = <名字>` 分段，每段含 `averageFPS = <值>`。优先选「含包名 + 含 SurfaceView + 非
/// `Background for`（那是占位背景层、不出帧）」的层（= Unity 的合成面）；没有则回退含包名的活动层。
/// 返回 (fps, layerName)。
pub fn parse_timestats_fps(output: &str, package: &str) -> Option<(f64, String)> {
    // 收集 (layerName, averageFPS)。
    let mut layers: Vec<(String, f64)> = Vec::new();
    for section in output.split("layerName = ").skip(1) {
        let name = section.lines().next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        if let Some(fps) = find_average_fps(section) {
            layers.push((name, fps));
        }
    }

    let belongs = |name: &str| name.contains(package);
    let is_real_surface = |name: &str| name.contains("SurfaceView") && !name.contains("Background for");

    // 优先：包名 + 真正的 SurfaceView 内容层（Unity）。
    if let Some((name, fps)) = layers.iter().find(|(n, _)| belongs(n) && is_real_surface(n)) {
        return Some((*fps, name.clone()));
    }
    // 回退：含包名的任意层（活动主窗口，等价 gfxinfo 口径）。
    layers
        .iter()
        .find(|(n, _)| belongs(n))
        .map(|(n, f)| (*f, n.clone()))
}

/// 从一段 timestats 文本里取 `averageFPS = <数>`。
fn find_average_fps(section: &str) -> Option<f64> {
    for line in section.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("averageFPS") {
            // 形如 "averageFPS = 71.95"
            let v = rest.trim_start_matches([' ', '=', '\t']);
            if let Ok(f) = v.trim().parse::<f64>() {
                return Some(f);
            }
        }
    }
    None
}

async fn timestats(adb: &Path, device_id: &str, flags: &[&str]) -> Option<String> {
    let mut args = vec!["-s", device_id, "shell", "dumpsys", "SurfaceFlinger", "--timestats"];
    args.extend_from_slice(flags);
    exec_adb(adb, &args, 5000).await.ok().map(|o| o.stdout)
}

/// 关闭所有已启用 timestats 的设备（应用退出清理，避免把 timestats 长期开在设备上徒增开销）。
pub async fn disable_all(adb: &Path) {
    let ids: Vec<String> = primed().lock().map(|s| s.iter().cloned().collect()).unwrap_or_default();
    for id in &ids {
        let _ = timestats(adb, id, &["-disable"]).await;
    }
    if let Ok(mut s) = primed().lock() {
        s.clear();
    }
}

/// 采样目标包当前上屏 surface 的合成帧率（timestats 口径）。
///
/// 诊断口径：只要有前台包名就**总返回 Some**——成功带真实 fps + layer，失败带 fps 0 + 原因，
/// 让前端对照行永远可见、便于真机定位。无包名才 None（如 Pico / 无前台）。
pub async fn sample_surface_fps(adb: &Path, device_id: &str, package: Option<&str>) -> Option<SurfaceFps> {
    let pkg = package?;

    // 首拍：启用并清零，下拍起才有窗口数据。
    if !is_primed(device_id) {
        let _ = timestats(adb, device_id, &["-enable", "-clear"]).await;
        mark_primed(device_id);
        return Some(SurfaceFps { fps: 0.0, layer: "诊断：timestats 已启用，下一拍起出数".to_string() });
    }

    let dump = match timestats(adb, device_id, &["-dump"]).await {
        Some(s) => s,
        None => return Some(SurfaceFps { fps: 0.0, layer: "诊断：timestats -dump 失败".to_string() }),
    };
    // 读完即清零，使下一拍是新窗口（~1 个采样间隔的均值）。
    let _ = timestats(adb, device_id, &["-clear"]).await;

    match parse_timestats_fps(&dump, pkg) {
        Some((fps, layer)) => Some(SurfaceFps { fps: (fps * 10.0).round() / 10.0, layer }),
        None => Some(SurfaceFps {
            fps: 0.0,
            layer: "诊断：timestats 无该包 layer（窗口内无帧 / 未匹配包名）".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 仿 AOSP TimeStats -dump 片段：全局 + 两个 layer（Unity 的 SurfaceView 与活动主窗口）。
    const SAMPLE: &str = "\
SurfaceFlinger TimeStats:
averageFPS = 60.000
**** LayerStats ****
layerName = Background for SurfaceView[com.myverse.meta.myverse/com.myverse.meta.myverse.MainActivity]#817
totalFrames = 0
averageFPS = 0.000
layerName = SurfaceView[com.myverse.meta.myverse/com.myverse.meta.myverse.MainActivity]@0(BLAST)
totalFrames = 144
droppedFrames = 0
averageFPS = 71.95
layerName = com.myverse.meta.myverse/com.myverse.meta.myverse.MainActivity#0
totalFrames = 3
averageFPS = 2.10
";

    #[test]
    fn picks_real_surfaceview_not_background_layer() {
        let (fps, layer) = parse_timestats_fps(SAMPLE, "com.myverse.meta.myverse").unwrap();
        assert!((fps - 71.95).abs() < 0.01, "fps={fps}");
        assert!(layer.contains("SurfaceView") && layer.contains("(BLAST)"));
        assert!(!layer.contains("Background for"), "不能选到背景占位层");
    }

    #[test]
    fn falls_back_to_activity_layer_when_no_surfaceview() {
        let out = "\
**** LayerStats ****
layerName = com.demo.app/com.demo.app.MainActivity#0
averageFPS = 59.5
";
        let (fps, layer) = parse_timestats_fps(out, "com.demo.app").unwrap();
        assert!((fps - 59.5).abs() < 0.01);
        assert!(layer.contains("MainActivity"));
    }

    #[test]
    fn none_when_package_absent() {
        assert!(parse_timestats_fps(SAMPLE, "com.other.app").is_none());
    }

    #[test]
    fn find_average_fps_parses_value() {
        assert_eq!(find_average_fps("totalFrames = 10\naverageFPS = 89.9\n"), Some(89.9));
        assert_eq!(find_average_fps("no fps here"), None);
    }
}
