//! 运行情况采样的纯解析函数（对应原 runtimeInspector.ts 的各 parse*）。
//! 与采集编排分离：这里只做「文本 → 数值/结构」的转换，无 IO、可独立测试。
//! 正则按需编译一次（OnceLock 缓存），避免每秒一拍重复编译。

use std::sync::OnceLock;

use regex::Regex;

use super::runtime_types::{
    ActivityStackEntry, ForegroundAppContext, FrameTimingStats, MemoryBreakdown, ProcessInfo,
};

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("内置正则应当合法"))
}

fn clamp_pct(v: f64) -> f64 {
    v.max(0.0).min(100.0)
}

/// 解析 CPU 使用率（对齐原 parseCpuUsage：三级回退）。
pub fn parse_cpu_usage(output: &str) -> f64 {
    // 1) "<total>% cpu ... <idle>% idle" → (total-idle)/total*100
    static CPU_LINE: OnceLock<Regex> = OnceLock::new();
    let cpu_line = re(
        &CPU_LINE,
        r"(?i)(\d+(?:\.\d+)?)%\s*cpu[^\n]*?(\d+(?:\.\d+)?)%\s*idle",
    );
    if let Some(c) = cpu_line.captures(output) {
        let total: f64 = c[1].parse().unwrap_or(0.0);
        let idle: f64 = c[2].parse().unwrap_or(0.0);
        if total > 0.0 {
            return clamp_pct((total - idle) / total * 100.0);
        }
    }

    // 2) "<x>% TOTAL:"
    static TOTAL_LINE: OnceLock<Regex> = OnceLock::new();
    let total_line = re(&TOTAL_LINE, r"(?i)(\d+(?:\.\d+)?)%\s+TOTAL:");
    if let Some(c) = total_line.captures(output) {
        return clamp_pct(c[1].parse().unwrap_or(0.0));
    }

    // 3) legacy "<x>% cpu"
    static LEGACY_CPU: OnceLock<Regex> = OnceLock::new();
    let legacy = re(&LEGACY_CPU, r"(?i)(\d+(?:\.\d+)?)%?\s+cpu");
    legacy
        .captures(output)
        .and_then(|c| c.get(1))
        .map(|m| clamp_pct(m.as_str().parse().unwrap_or(0.0)))
        .unwrap_or(0.0)
}

/// 解析已用内存（KB）。优先 /proc/meminfo：Used = MemTotal - MemAvailable（无则退回 MemFree）；
/// 兼容旧 dumpsys meminfo 的 "Used RAM"。对齐原 parseMemoryUsage。
pub fn parse_memory_usage(output: &str) -> f64 {
    fn read_kb(output: &str, cell: &'static OnceLock<Regex>, pattern: &str) -> Option<f64> {
        re(cell, pattern)
            .captures(output)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().replace(',', "").parse::<f64>().ok())
    }

    static MEM_TOTAL: OnceLock<Regex> = OnceLock::new();
    static MEM_AVAIL: OnceLock<Regex> = OnceLock::new();
    static MEM_FREE: OnceLock<Regex> = OnceLock::new();
    static USED_RAM: OnceLock<Regex> = OnceLock::new();

    let total = read_kb(output, &MEM_TOTAL, r"(?i)MemTotal:\s+(\d+)\s*kB");
    let available = read_kb(output, &MEM_AVAIL, r"(?i)MemAvailable:\s+(\d+)\s*kB");
    let free = read_kb(output, &MEM_FREE, r"(?i)MemFree:\s+(\d+)\s*kB");

    if let (Some(t), Some(a)) = (total, available) {
        return (t - a).max(0.0);
    }
    if let (Some(t), Some(f)) = (total, free) {
        return (t - f).max(0.0);
    }
    read_kb(output, &USED_RAM, r"(?i)Used RAM:\s+([\d,]+)K").unwrap_or(0.0)
}

/// 解析 `dumpsys meminfo <pkg>` 的 App Summary 段，得到分类内存（KB）。
/// 只在「App Summary」标题之后的区段里匹配，避免命中上方主表的同名行 / 多个 TOTAL 行；
/// 至少要解析到 Java/Native/Graphics 三者之一才算成功，否则 None（解析不到不展示，不编造）。
pub fn parse_meminfo_breakdown(output: &str) -> Option<MemoryBreakdown> {
    let region = match output.find("App Summary") {
        Some(i) => &output[i..],
        None => output,
    };
    fn kb(region: &str, cell: &'static OnceLock<Regex>, pat: &str) -> Option<f64> {
        re(cell, pat)
            .captures(region)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().replace(',', "").parse::<f64>().ok())
    }
    static JAVA: OnceLock<Regex> = OnceLock::new();
    static NATIVE: OnceLock<Regex> = OnceLock::new();
    static GFX: OnceLock<Regex> = OnceLock::new();
    static CODE: OnceLock<Regex> = OnceLock::new();
    static STACK: OnceLock<Regex> = OnceLock::new();
    static TOTAL: OnceLock<Regex> = OnceLock::new();

    let java = kb(region, &JAVA, r"(?im)^\s*Java Heap:\s+([\d,]+)");
    let native = kb(region, &NATIVE, r"(?im)^\s*Native Heap:\s+([\d,]+)");
    let graphics = kb(region, &GFX, r"(?im)^\s*Graphics:\s+([\d,]+)");
    if java.is_none() && native.is_none() && graphics.is_none() {
        return None;
    }
    let code = kb(region, &CODE, r"(?im)^\s*Code:\s+([\d,]+)");
    let stack = kb(region, &STACK, r"(?im)^\s*Stack:\s+([\d,]+)");
    let (j, n, g, c, s) = (
        java.unwrap_or(0.0),
        native.unwrap_or(0.0),
        graphics.unwrap_or(0.0),
        code.unwrap_or(0.0),
        stack.unwrap_or(0.0),
    );
    let total = kb(region, &TOTAL, r"(?im)^\s*TOTAL(?:\s+PSS)?:\s+([\d,]+)").unwrap_or(j + n + g + c + s);
    Some(MemoryBreakdown {
        java_kb: j,
        native_kb: n,
        graphics_kb: g,
        code_kb: c,
        stack_kb: s,
        total_kb: total,
    })
}

/// 解析 FPS：优先 framestats 计算，回退 legacy "<x> fps"。对齐原 parseGfxInfo。
pub fn parse_gfx_info(output: &str) -> f64 {
    let frame = parse_frame_stats_fps(output);
    if frame != 0.0 {
        frame
    } else {
        parse_legacy_fps(output)
    }
}

fn parse_frame_stats_fps(output: &str) -> f64 {
    // 跳过第一段（split 后首元素是分隔符前内容），逐 PROFILEDATA 段计算。
    for section in output.split("---PROFILEDATA---").skip(1) {
        let lines: Vec<&str> = section
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();

        let header_index = match lines.iter().position(|l| l.starts_with("Flags,")) {
            Some(i) => i,
            None => continue,
        };

        let header: Vec<&str> = lines[header_index].split(',').collect();
        let intended_idx = header.iter().position(|h| *h == "IntendedVsync");
        let completed_idx = header.iter().position(|h| *h == "FrameCompleted");
        let (intended_idx, completed_idx) = match (intended_idx, completed_idx) {
            (Some(a), Some(b)) => (a, b),
            _ => continue,
        };

        let frame_rows: Vec<Vec<&str>> = lines[header_index + 1..]
            .iter()
            .map(|l| l.split(',').collect::<Vec<&str>>())
            .filter(|cols| cols.len() > completed_idx)
            .collect();

        // 最近 60 帧
        let recent = if frame_rows.len() > 60 {
            &frame_rows[frame_rows.len() - 60..]
        } else {
            &frame_rows[..]
        };

        let durations: Vec<(i64, i64)> = recent
            .iter()
            .map(|cols| {
                let iv = cols.get(intended_idx).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
                let fc = cols.get(completed_idx).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
                (iv, fc)
            })
            .filter(|(iv, fc)| *iv > 0 && *fc > *iv)
            .collect();

        if durations.len() < 2 {
            continue;
        }

        let first = durations[0];
        let last = durations[durations.len() - 1];
        let duration_ns = last.1 - first.0;
        if duration_ns <= 0 {
            continue;
        }

        let fps = durations.len() as f64 / (duration_ns as f64 / 1_000_000_000.0);
        if fps.is_finite() && fps > 0.0 {
            return (fps * 10.0).round() / 10.0;
        }
    }

    0.0
}

fn parse_legacy_fps(output: &str) -> f64 {
    static LEGACY_FPS: OnceLock<Regex> = OnceLock::new();
    re(&LEGACY_FPS, r"(?i)(\d+\.?\d*)\s+fps")
        .captures(output)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// 从 gfxinfo framestats 解析每帧总耗时（ms）= (FrameCompleted - IntendedVsync)/1e6。
/// 取所有 PROFILEDATA 段、所有 Flags=0 的有效帧（Flags!=0 是 AOSP 标记应剔除的帧，如首帧/异常帧）。
/// 与 parse_frame_stats_fps 的列定位口径一致，但这里收集全部帧的耗时（供分位/jank/直方统计），不止最近 60。
pub fn parse_frame_durations_ms(output: &str) -> Vec<f64> {
    let mut durations = Vec::new();
    for section in output.split("---PROFILEDATA---").skip(1) {
        let lines: Vec<&str> = section
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        let header_index = match lines.iter().position(|l| l.starts_with("Flags,")) {
            Some(i) => i,
            None => continue,
        };
        let header: Vec<&str> = lines[header_index].split(',').collect();
        let flags_idx = header.iter().position(|h| *h == "Flags");
        let intended_idx = header.iter().position(|h| *h == "IntendedVsync");
        let completed_idx = header.iter().position(|h| *h == "FrameCompleted");
        let (intended_idx, completed_idx) = match (intended_idx, completed_idx) {
            (Some(a), Some(b)) => (a, b),
            _ => continue,
        };
        for line in &lines[header_index + 1..] {
            let cols: Vec<&str> = line.split(',').collect();
            if cols.len() <= completed_idx {
                continue;
            }
            // Flags!=0 的帧按 AOSP 约定剔除（首帧、被丢弃帧等不计入耗时统计）。
            if let Some(fi) = flags_idx {
                if cols.get(fi).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) != 0 {
                    continue;
                }
            }
            let iv = cols.get(intended_idx).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
            let fc = cols.get(completed_idx).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
            if iv > 0 && fc > iv {
                durations.push((fc - iv) as f64 / 1_000_000.0);
            }
        }
    }
    durations
}

/// 把一拍的每帧耗时聚合为统计量（分位 + jank% + 预算）。refresh_hz 来自 dumpsys display 探测，
/// 非法/未知（不在 30..=360）回退 60Hz。无有效帧 → None（不编造）。
/// 分位用最近秩法（nearest-rank）：sorted[ceil(p/100*n)-1]。jank = 耗时 > budget_ms（在自己 vsync 间隔内没做完）。
pub fn compute_frame_timing(durations: Vec<f64>, refresh_hz: f64) -> Option<FrameTimingStats> {
    let mut sorted: Vec<f64> = durations.into_iter().filter(|d| d.is_finite() && *d > 0.0).collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let pct = |p: f64| {
        let rank = ((p / 100.0 * n as f64).ceil() as usize).clamp(1, n);
        sorted[rank - 1]
    };
    let sum: f64 = sorted.iter().sum();
    let avg = sum / n as f64;
    let hz = if refresh_hz.is_finite() && (30.0..=360.0).contains(&refresh_hz) {
        refresh_hz
    } else {
        60.0
    };
    let budget = 1000.0 / hz;
    let jank_count = sorted.iter().filter(|d| **d > budget).count();
    Some(FrameTimingStats {
        frame_count: n as u32,
        avg_ms: round1(avg),
        p50_ms: round1(pct(50.0)),
        p90_ms: round1(pct(90.0)),
        p95_ms: round1(pct(95.0)),
        p99_ms: round1(pct(99.0)),
        max_ms: round1(sorted[n - 1]),
        jank_count: jank_count as u32,
        jank_percent: round1(jank_count as f64 / n as f64 * 100.0),
        budget_ms: round1(budget),
        refresh_hz: round1(hz),
    })
}

/// 从 `dumpsys display` 解析当前生效刷新率（Hz）。优先用 mActiveModeId 精确匹配该 mode 的 fps，
/// 回退 refreshRate/mRefreshRate 字段。解析不到 → None（上层回退 60Hz）。
pub fn parse_display_refresh_rate(output: &str) -> Option<f64> {
    let in_range = |v: f64| (30.0..=360.0).contains(&v);

    // 1) active mode 精确匹配：mActiveModeId=<id> → 同 id 的 mode 行里的 fps。
    static ACTIVE: OnceLock<Regex> = OnceLock::new();
    if let Some(c) = re(&ACTIVE, r"(?i)mActiveModeId=(\d+)").captures(output) {
        let id = &c[1];
        if let Ok(mode_re) = Regex::new(&format!(
            r"(?i)\bid={}\b[^}}\n]*?fps=(\d+(?:\.\d+)?)",
            regex::escape(id)
        )) {
            if let Some(mc) = mode_re.captures(output) {
                if let Ok(v) = mc[1].parse::<f64>() {
                    if in_range(v) {
                        return Some(v);
                    }
                }
            }
        }
    }

    // 2) 回退：refreshRate= / mRefreshRate= 字段。
    static RR: OnceLock<Regex> = OnceLock::new();
    if let Some(c) =
        re(&RR, r"(?i)(?:refreshRate|mRefreshRate)[=:\s]+(\d+(?:\.\d+)?)").captures(output)
    {
        if let Ok(v) = c[1].parse::<f64>() {
            if in_range(v) {
                return Some(v);
            }
        }
    }
    None
}

/// 从 dumpsys window 输出解析前台应用（mCurrentFocus / mFocusedApp）。
pub fn parse_foreground_app_from_window(output: &str) -> ForegroundAppContext {
    static CURRENT_FOCUS: OnceLock<Regex> = OnceLock::new();
    static FOCUSED_APP: OnceLock<Regex> = OnceLock::new();
    let patterns = [
        re(
            &CURRENT_FOCUS,
            r"mCurrentFocus=.*? ([A-Za-z0-9_.]+)/([A-Za-z0-9_.$]+)",
        ),
        re(
            &FOCUSED_APP,
            r"mFocusedApp=.*? ([A-Za-z0-9_.]+)/([A-Za-z0-9_.$]+)",
        ),
    ];
    for p in patterns {
        if let Some(c) = p.captures(output) {
            return ForegroundAppContext {
                package_name: Some(c[1].to_string()),
                activity_name: Some(c[2].to_string()),
            };
        }
    }
    ForegroundAppContext::default()
}

/// 解析 Activity 栈（对齐原 parseActivityStack）。id 用 `pkg-index-nowMs`。
pub fn parse_activity_stack(
    output: &str,
    package_filter: Option<&str>,
    now_ms: u64,
) -> Vec<ActivityStackEntry> {
    static TASK: OnceLock<Regex> = OnceLock::new();
    static COMPONENT: OnceLock<Regex> = OnceLock::new();
    static STATE_KV: OnceLock<Regex> = OnceLock::new();
    static STATE_WORD: OnceLock<Regex> = OnceLock::new();

    let task_re = re(&TASK, r"(?i)(?:TASK|TaskRecord|Task)\s*#?(\d+)");
    let component_re = re(&COMPONENT, r"([a-zA-Z0-9_.]+)/([a-zA-Z0-9_.$]+)");
    let state_kv_re = re(&STATE_KV, r"(?i)\b(?:state|mState)=([A-Z_]+)");
    let state_word_re = re(&STATE_WORD, r"\b(RESUMED|PAUSED|STOPPED|STARTED|DESTROYED)\b");

    let mut entries: Vec<ActivityStackEntry> = Vec::new();
    let mut current_task_id: Option<String> = None;
    let filter_lower = package_filter.map(|f| f.to_lowercase());

    for raw_line in output.lines() {
        let line = raw_line.trim();
        if let Some(c) = task_re.captures(line) {
            current_task_id = Some(c[1].to_string());
        }

        if !line.contains("ActivityRecord") && !line.contains("Hist #") {
            continue;
        }

        let component = match component_re.captures(line) {
            Some(c) => c,
            None => continue,
        };
        let pkg = component[1].to_string();
        if let Some(f) = &filter_lower {
            if !pkg.to_lowercase().contains(f.as_str()) {
                continue;
            }
        }

        let state = state_kv_re
            .captures(line)
            .and_then(|c| c.get(1))
            .or_else(|| state_word_re.captures(line).and_then(|c| c.get(1)))
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| "UNKNOWN".to_string());

        entries.push(ActivityStackEntry {
            id: format!("{}-{}-{}", pkg, entries.len(), now_ms),
            package_name: pkg,
            activity_name: component[2].to_string(),
            state,
            task_id: current_task_id.clone(),
            raw: line.to_string(),
        });
    }

    entries
}

/// 解析 `ps` 输出为进程列表（对齐原 getProcesses 的解析部分）。
pub fn parse_processes(stdout: &str) -> Vec<ProcessInfo> {
    let lines: Vec<&str> = stdout.trim().split('\n').collect();
    let mut processes = Vec::new();
    for line in lines.iter().skip(1) {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.len() < 9 {
            continue;
        }
        let name = parts[parts.len() - 1].to_string();
        processes.push(ProcessInfo {
            pid: parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
            ppid: parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
            name: name.clone(),
            package_name: name,
            cpu_usage: parts.get(8).and_then(|s| s.parse().ok()).unwrap_or(0.0),
            memory_usage: parts.get(9).and_then(|s| s.parse().ok()).unwrap_or(0.0),
            status: "running".to_string(),
        });
    }
    processes
}

/// 规范化 Android 包名（对齐原 normalizeAndroidPackageName）：含 `.`、去 `:进程后缀`、匹配包名正则。
pub fn normalize_android_package_name(process_name: &str) -> Option<String> {
    if process_name.is_empty() || !process_name.contains('.') {
        return None;
    }
    let base = process_name.split(':').next().unwrap_or(process_name);
    static PKG: OnceLock<Regex> = OnceLock::new();
    let pkg_re = re(&PKG, r"^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$");
    if pkg_re.is_match(base) {
        Some(base.to_string())
    } else {
        None
    }
}

/// 从 `ps` 输出提取「正在运行的包名集合」（对齐原 getRunningPackages 的解析部分，去重保序）。
pub fn parse_running_packages(stdout: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut running = Vec::new();
    for line in stdout.split('\n') {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        if let Some(pkg) = normalize_android_package_name(parts[parts.len() - 1]) {
            if seen.insert(pkg.clone()) {
                running.push(pkg);
            }
        }
    }
    running
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meminfo_app_summary() {
        // 截取 dumpsys meminfo <pkg> 的 App Summary 段（含上方主表的同名干扰行，验证只取 App Summary 段）。
        let out = "\
Applications Memory Usage (in Kilobytes):
  TOTAL:   999999   (忽略：主表的 TOTAL 不应被当成 App Summary 合计)
 App Summary
                       Pss(KB)
                        ------
           Java Heap:    12,345
         Native Heap:    23456
                Code:     6789
               Stack:      120
            Graphics:    22334
       Private Other:     4096
              System:     8192
           TOTAL PSS:    77332
";
        let b = parse_meminfo_breakdown(out).expect("应解析出分类内存");
        assert_eq!(b.java_kb, 12345.0); // 逗号被去掉
        assert_eq!(b.native_kb, 23456.0);
        assert_eq!(b.graphics_kb, 22334.0);
        assert_eq!(b.code_kb, 6789.0);
        assert_eq!(b.stack_kb, 120.0);
        assert_eq!(b.total_kb, 77332.0); // 取 App Summary 段的 TOTAL PSS，非主表 TOTAL
    }

    #[test]
    fn meminfo_none_when_no_summary() {
        assert!(parse_meminfo_breakdown("no summary here").is_none());
    }

    #[test]
    fn parses_frame_durations_and_skips_flagged_frames() {
        // 列定位靠表头；Flags!=0 的帧剔除；只有 FrameCompleted>IntendedVsync 才计。
        // 三帧：8ms、20ms（正常计入）、第三帧 Flags=1 应剔除。
        let out = "\
---PROFILEDATA---
Flags,IntendedVsync,Vsync,FrameCompleted
0,1000000,1000000,9000000
0,2000000,2000000,22000000
1,3000000,3000000,99000000
---PROFILEDATA---
";
        let d = parse_frame_durations_ms(out);
        assert_eq!(d.len(), 2, "Flags=1 的帧应被剔除");
        assert!((d[0] - 8.0).abs() < 1e-6);
        assert!((d[1] - 20.0).abs() < 1e-6);
    }

    #[test]
    fn compute_frame_timing_percentiles_and_jank() {
        // 90Hz → budget≈11.1ms。耗时 5,10,12,30 ms 中 12 与 30 超预算 → jank 2/4=50%。
        let stats = compute_frame_timing(vec![5.0, 10.0, 12.0, 30.0], 90.0).expect("应有统计");
        assert_eq!(stats.frame_count, 4);
        assert_eq!(stats.jank_count, 2);
        assert!((stats.jank_percent - 50.0).abs() < 1e-6);
        assert!((stats.budget_ms - 11.1).abs() < 0.05, "budget={}", stats.budget_ms);
        assert!((stats.max_ms - 30.0).abs() < 1e-6);
        assert!((stats.refresh_hz - 90.0).abs() < 1e-6);
        // nearest-rank：p50=ceil(0.5*4)=2 → sorted[1]=10；p99=ceil(0.99*4)=4 → sorted[3]=30。
        assert!((stats.p50_ms - 10.0).abs() < 1e-6);
        assert!((stats.p99_ms - 30.0).abs() < 1e-6);
    }

    #[test]
    fn compute_frame_timing_defaults_60hz_and_handles_empty() {
        assert!(compute_frame_timing(vec![], 90.0).is_none());
        // 刷新率非法 → 回退 60Hz，budget≈16.7ms。
        let s = compute_frame_timing(vec![10.0], 0.0).expect("应有统计");
        assert!((s.refresh_hz - 60.0).abs() < 1e-6);
        assert!((s.budget_ms - 16.7).abs() < 0.05, "budget={}", s.budget_ms);
        assert_eq!(s.jank_count, 0); // 10ms < 16.7ms 不算 jank
    }

    #[test]
    fn parses_display_refresh_rate_active_mode() {
        let out = "\
Display Devices: size=1
  mActiveModeId=2
  DisplayModeRecord{mMode={id=1, width=2160, height=2160, fps=72.000}}
  DisplayModeRecord{mMode={id=2, width=2160, height=2160, fps=90.000}}
";
        assert_eq!(parse_display_refresh_rate(out), Some(90.0));
    }

    #[test]
    fn parses_display_refresh_rate_fallback_and_none() {
        assert_eq!(parse_display_refresh_rate("mRefreshRate=120.0"), Some(120.0));
        assert!(parse_display_refresh_rate("no refresh info").is_none());
    }
}
