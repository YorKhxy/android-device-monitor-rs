//! logcat `-v long` 流式解析（T4-4）：把 logcat 文本流切分成 `LogEntry`，多行消息（异常堆栈）合并成一条。
//!
//! `-v long` 单条形如：
//! ```text
//! [ 06-09 22:31:14.123  1234: 5678 I/ActivityManager ]
//! Start proc ...
//!     at xxx        ← 多行（堆栈）属同一条
//!                   ← 空行 = 条目结束
//! ```
//! 条目边界 = `[头]` 行起、空行止；头行解析 PID/TID/级别/TAG，其后非空行并入 message。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use chrono::{Datelike, Local, NaiveDateTime};
use regex::Regex;
use serde::{Deserialize, Serialize};

/// 一条解析后的日志（字段对齐 shared/types `LogEntry`，序列化 camelCase）。
/// `timestamp` 发 ISO 字符串（前端 `new Date(log.timestamp)` 解析）。
/// 实现 Deserialize 以便 `export_logs` 接收前端回传的条目（timestamp 仍按字符串收）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub device_id: String,
    pub timestamp: String,
    pub process_id: i64,
    pub thread_id: i64,
    pub level: String, // "V" | "D" | "I" | "W" | "E" | "F"
    pub tag: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
}

/// `-v long` 头行：`[ MM-DD HH:MM:SS.mmm  PID: TID L/Tag ]`。空格数量不定，TAG 可空。
fn header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\[\s*(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+):\s*(\d+)\s+([A-Z])/(.*?)\s*\]\s*$")
            .expect("logcat header regex")
    })
}

/// 全局自增序号，保证 entry id 唯一（前端用作 React key）。
static SEQ: AtomicU64 = AtomicU64::new(0);

fn next_seq() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed)
}

/// 头行解析出的、尚未收尾的条目（还在累积 message 行）。
struct Pending {
    timestamp: String,
    process_id: i64,
    thread_id: i64,
    level: String,
    tag: String,
    msg_lines: Vec<String>,
}

/// 「导出当前可见日志」的文本行（与老工具逐字节一致）：
/// `本地时间 设备ID pid/tid 级别/TAG: 消息`。多行消息（堆栈）原样保留其换行——整条不拆。
pub fn format_entry(e: &LogEntry) -> String {
    format!(
        "{} {} {}/{} {}/{}: {}",
        local_timestamp(&e.timestamp), e.device_id, e.process_id, e.thread_id, e.level, e.tag, e.message
    )
}

/// 「完整日志落盘 / 按包名导出」的文本行（与老工具 fullLogRecorder.formatLine 一致）：比 format_entry
/// 多一列 PID 反查的归属包名（无则 `-`）：`本地时间 设备ID 归属包名 pid/tid 级别/TAG: 消息`。
/// 事后「按包名导出」靠这一列复刻实时采集的关联匹配口径（应用自身日志正文常不含包名）。
pub fn format_line(e: &LogEntry) -> String {
    let pkg = e
        .package_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("-");
    format!(
        "{} {} {} {}/{} {}/{}: {}",
        local_timestamp(&e.timestamp), e.device_id, pkg, e.process_id, e.thread_id, e.level, e.tag, e.message
    )
}

/// 内部 ISO `YYYY-MM-DDTHH:MM:SS.mmm`（本地时区，见 to_iso）→ 老工具导出/落盘用的
/// `YYYY-MM-DD HH:MM:SS.mmm`（空格分隔，本地时间）。仅替换首个 'T'，message 内的 T 不受影响。
fn local_timestamp(iso: &str) -> String {
    iso.replacen('T', " ", 1)
}

/// 前端 level 联合类型只认 6 级；其余（含 logcat 的 'S' silent）归 'I' 兜底。
fn normalize_level(c: &str) -> String {
    match c {
        "V" | "D" | "I" | "W" | "E" | "F" => c.to_string(),
        _ => "I".to_string(),
    }
}

/// `MM-DD HH:MM:SS.mmm`（logcat 不带年）→ 补当前年的 ISO 字符串；解析失败回退当前时刻。
fn to_iso(md: &str, hms: &str) -> String {
    let year = Local::now().year();
    let composed = format!("{year}-{md} {hms}");
    match NaiveDateTime::parse_from_str(&composed, "%Y-%m-%d %H:%M:%S%.3f") {
        Ok(dt) => dt.format("%Y-%m-%dT%H:%M:%S%.3f").to_string(),
        Err(_) => Local::now().naive_local().format("%Y-%m-%dT%H:%M:%S%.3f").to_string(),
    }
}

/// 流式解析器：逐行喂入，收尾一条时返回 `Some(LogEntry)`。每台设备一个实例。
pub struct LogcatParser {
    device_id: String,
    current: Option<Pending>,
}

impl LogcatParser {
    pub fn new(device_id: &str) -> Self {
        Self { device_id: device_id.to_string(), current: None }
    }

    /// 喂一行。返回 Some 表示「上一条」已收尾（遇到新头行或空行）。
    pub fn push_line(&mut self, raw: &str) -> Option<LogEntry> {
        let line = raw.trim_end_matches(['\r', '\n']);

        if let Some(cap) = header_re().captures(line) {
            // 新头行：先收尾上一条（防御：正常情况上一条已被空行收尾，此处 current 多为 None）。
            let finished = self.current.take().map(|p| self.finalize(p));
            self.current = Some(Pending {
                timestamp: to_iso(&cap[1], &cap[2]),
                process_id: cap[3].parse().unwrap_or(0),
                thread_id: cap[4].parse().unwrap_or(0),
                level: normalize_level(&cap[5]),
                tag: cap[6].to_string(),
                msg_lines: Vec::new(),
            });
            return finished;
        }

        if line.trim().is_empty() {
            // 空行 = 条目分隔符，收尾当前条。
            return self.current.take().map(|p| self.finalize(p));
        }

        // 消息行（含堆栈续行）并入当前条；无当前条（流起始噪声行）则丢弃。
        if let Some(c) = self.current.as_mut() {
            c.msg_lines.push(line.to_string());
        }
        None
    }

    /// 流结束（EOF）时收尾残留的最后一条。
    pub fn flush(&mut self) -> Option<LogEntry> {
        self.current.take().map(|p| self.finalize(p))
    }

    fn finalize(&self, p: Pending) -> LogEntry {
        LogEntry {
            id: format!("{}-{}", self.device_id, next_seq()),
            device_id: self.device_id.clone(),
            timestamp: p.timestamp,
            process_id: p.process_id,
            thread_id: p.thread_id,
            level: p.level,
            tag: p.tag,
            message: p.msg_lines.join("\n").trim_end().to_string(),
            package_name: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 喂多行，收集所有收尾的条目（含 flush 残留）。
    fn parse_all(device: &str, input: &str) -> Vec<LogEntry> {
        let mut p = LogcatParser::new(device);
        let mut out = Vec::new();
        for line in input.lines() {
            if let Some(e) = p.push_line(line) {
                out.push(e);
            }
        }
        if let Some(e) = p.flush() {
            out.push(e);
        }
        out
    }

    #[test]
    fn parses_single_entry_header_fields() {
        let input = "[ 06-09 22:31:14.123  1234: 5678 I/ActivityManager ]\nStart proc com.example\n\n";
        let entries = parse_all("dev1", input);
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.device_id, "dev1");
        assert_eq!(e.process_id, 1234);
        assert_eq!(e.thread_id, 5678);
        assert_eq!(e.level, "I");
        assert_eq!(e.tag, "ActivityManager");
        assert_eq!(e.message, "Start proc com.example");
        assert!(e.timestamp.ends_with("T22:31:14.123"));
    }

    #[test]
    fn merges_multiline_stack_into_one_message() {
        let input = "[ 06-09 10:00:00.000  100: 200 E/AndroidRuntime ]\n\
            FATAL EXCEPTION: main\n\
            java.lang.NullPointerException\n\
            \tat com.example.Foo.bar(Foo.java:42)\n\
            \tat com.example.Baz.qux(Baz.java:7)\n\
            \n";
        let entries = parse_all("dev1", input);
        assert_eq!(entries.len(), 1, "堆栈应合并为一条");
        let msg = &entries[0].message;
        assert!(msg.starts_with("FATAL EXCEPTION: main"));
        assert!(msg.contains("NullPointerException"));
        assert!(msg.contains("Foo.java:42"));
        assert_eq!(msg.lines().count(), 4);
    }

    #[test]
    fn splits_consecutive_entries() {
        let input = "[ 06-09 10:00:00.000  1: 2 D/A ]\nmsg a\n\n\
            [ 06-09 10:00:01.000  3: 4 W/B ]\nmsg b\n\n";
        let entries = parse_all("dev1", input);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].tag, "A");
        assert_eq!(entries[0].message, "msg a");
        assert_eq!(entries[1].tag, "B");
        assert_eq!(entries[1].level, "W");
        assert_ne!(entries[0].id, entries[1].id, "id 必须唯一");
    }

    #[test]
    fn header_without_blank_separator_still_splits() {
        // 防御：两条之间漏了空行，新头行也应收尾上一条。
        let input = "[ 06-09 10:00:00.000  1: 2 D/A ]\nmsg a\n\
            [ 06-09 10:00:01.000  3: 4 I/B ]\nmsg b\n\n";
        let entries = parse_all("dev1", input);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message, "msg a");
        assert_eq!(entries[1].message, "msg b");
    }

    #[test]
    fn unknown_level_falls_back_to_info() {
        let input = "[ 06-09 10:00:00.000  1: 2 S/Silent ]\nx\n\n";
        let entries = parse_all("dev1", input);
        assert_eq!(entries[0].level, "I");
    }

    #[test]
    fn leading_noise_before_first_header_is_dropped() {
        let input = "--------- beginning of main\n[ 06-09 10:00:00.000  1: 2 D/A ]\nmsg\n\n";
        let entries = parse_all("dev1", input);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "msg");
    }

    fn sample(pkg: Option<&str>) -> LogEntry {
        LogEntry {
            id: "x".into(),
            device_id: "dev1".into(),
            timestamp: "2026-06-12T16:06:00.123".into(),
            process_id: 1368,
            thread_id: 15488,
            level: "W".into(),
            tag: "qdgralloc".into(),
            message: "hello".into(),
            package_name: pkg.map(str::to_string),
        }
    }

    /// 「导出当前可见日志」行格式与老工具逐字节一致：`本地时间 设备ID pid/tid 级别/TAG: 消息`（无包名列）。
    #[test]
    fn format_entry_matches_legacy_layout() {
        assert_eq!(
            format_entry(&sample(None)),
            "2026-06-12 16:06:00.123 dev1 1368/15488 W/qdgralloc: hello"
        );
    }

    /// 「完整日志落盘 / 按包名导出」行格式与老工具 formatLine 一致：多一列归属包名，无归属用 `-`。
    #[test]
    fn format_line_has_package_column() {
        assert_eq!(
            format_line(&sample(Some("com.demo"))),
            "2026-06-12 16:06:00.123 dev1 com.demo 1368/15488 W/qdgralloc: hello"
        );
        assert_eq!(
            format_line(&sample(None)),
            "2026-06-12 16:06:00.123 dev1 - 1368/15488 W/qdgralloc: hello"
        );
    }
}
