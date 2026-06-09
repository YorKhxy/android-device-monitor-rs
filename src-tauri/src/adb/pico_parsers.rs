//! PxrMetric 日志行的纯解析（对应原 picoMetrics.ts 的 parseEntryMap / parseSingleMetric /
//! parseRatioMetric）。无 IO，可独立测试；与 reader 编排（pico_metrics）分离。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;

use super::runtime_types::MetricReading;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("内置正则应当合法"))
}

/// 解析一行 PxrMetric 日志为 key=value 表（BTreeMap 保证序列化顺序稳定）。
pub fn parse_entry_map(line: &str) -> BTreeMap<String, String> {
    static HEAD: OnceLock<Regex> = OnceLock::new();
    let head = re(&HEAD, r"PxrMetric(?:\(\s*\d+\s*\))?:\s*(.*)$");
    let data = head
        .captures(line)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| line.to_string());

    let mut map = BTreeMap::new();
    for entry in data.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if let Some(idx) = entry.find('=') {
            let key = entry[..idx].trim();
            let value = entry[idx + 1..].trim();
            if !key.is_empty() {
                map.insert(key.to_string(), value.to_string());
            }
        }
    }
    map
}

/// 单值指标（如 MTP/FrmCpu）：`<数值><单位?>`。
pub fn parse_single_metric(raw: Option<&String>) -> Option<MetricReading> {
    let raw = raw?;
    static RE: OnceLock<Regex> = OnceLock::new();
    let m = re(&RE, r"(-?\d+(?:\.\d+)?)([a-zA-Z%]+)?").captures(raw)?;
    Some(MetricReading {
        value: m.get(1)?.as_str().parse().ok()?,
        unit: m.get(2).map(|u| u.as_str().to_string()),
        max_value: None,
        max_value_unit: None,
        raw: Some(raw.clone()),
    })
}

/// 比值指标（如 FPS/GPU）：取首个数值为 value、次个为 maxValue，单位同理。
pub fn parse_ratio_metric(raw: Option<&String>) -> Option<MetricReading> {
    let raw = raw?;
    static NUM: OnceLock<Regex> = OnceLock::new();
    static UNIT: OnceLock<Regex> = OnceLock::new();
    let numbers: Vec<f64> = re(&NUM, r"-?\d+(?:\.\d+)?")
        .find_iter(raw)
        .filter_map(|m| m.as_str().parse().ok())
        .collect();
    if numbers.is_empty() {
        return None;
    }
    let units: Vec<String> = re(&UNIT, r"[a-zA-Z%]+")
        .find_iter(raw)
        .map(|m| m.as_str().to_string())
        .collect();
    Some(MetricReading {
        value: numbers[0],
        unit: units.first().cloned(),
        max_value: numbers.get(1).copied(),
        max_value_unit: units.get(1).cloned().or_else(|| units.first().cloned()),
        raw: Some(raw.clone()),
    })
}
