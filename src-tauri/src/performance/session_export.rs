//! 性能采集报告导出（对应原 performanceSessionExport.ts）。用 rust_xlsxwriter 产真 .xlsx
//! （原版产的是 Excel 2003 SpreadsheetML XML，这里升级为标准 xlsx），含 Summary + Raw Data 两表。
//! 统一取 metrics.fps（不按 provider 分流）。payload 由前端从回看详情构造，按 JSON Value 解析。
//!
//! 时间戳为 epoch 毫秒，无 chrono：用 civil-from-days 算法格式化为 UTC "YYYY-MM-DD HH:MM:SS"。

use rust_xlsxwriter::{Color, Format, Workbook};
use serde_json::Value;

use crate::adb::error::AdbError;

/// epoch 毫秒 → UTC "YYYY-MM-DD HH:MM:SS"（Howard Hinnant civil 算法）。<=0 返回空串。
fn format_ms(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400);
    let (hh, mm, ss) = (tod / 3600, (tod % 3600) / 60, tod % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}")
}

fn as_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64()).filter(|n| n.is_finite())
}

fn as_str<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

/// metrics.picoMetrics.<key>.value（缺失返回 None）。
fn pico_value(metrics: &Value, key: &str) -> Option<f64> {
    metrics
        .get("picoMetrics")
        .and_then(|p| p.get(key))
        .and_then(|r| r.get("value"))
        .and_then(|n| n.as_f64())
        .filter(|n| n.is_finite())
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn ms_field(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// 构建性能报告工作簿字节（Summary + Raw Data）。
pub fn build_workbook_bytes(payload: &Value) -> Result<Vec<u8>, AdbError> {
    let to_err = |e: rust_xlsxwriter::XlsxError| {
        AdbError::custom("EXPORT_ERROR", "生成 Excel 失败".into(), "请重试导出。", e.to_string())
    };

    let empty: Vec<Value> = Vec::new();
    let samples = payload.get("samples").and_then(|s| s.as_array()).unwrap_or(&empty);
    let device = payload.get("device").cloned().unwrap_or(Value::Null);

    // 聚合（统一取 metrics.fps）。
    let mut fps: Vec<f64> = Vec::new();
    let mut cpu: Vec<f64> = Vec::new();
    let mut mem_mb: Vec<f64> = Vec::new();
    for s in samples {
        let m = s.get("metrics").cloned().unwrap_or(Value::Null);
        if let Some(v) = as_f64(&m, "fps") {
            fps.push(v);
        }
        if let Some(v) = as_f64(&m, "cpuUsage") {
            cpu.push(v);
        }
        if let Some(v) = as_f64(&m, "memoryUsage") {
            mem_mb.push(v / 1024.0);
        }
    }
    let avg = |xs: &[f64]| if xs.is_empty() { 0.0 } else { xs.iter().sum::<f64>() / xs.len() as f64 };
    let device_name = device
        .get("name")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| device.get("model").and_then(|x| x.as_str()).filter(|s| !s.is_empty()))
        .or_else(|| device.get("id").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string();

    let mut wb = Workbook::new();
    let header = Format::new().set_bold().set_background_color(Color::RGB(0xD9EAF7));

    // —— Summary ——
    {
        let ws = wb.add_worksheet();
        ws.set_name("Summary").map_err(to_err)?;
        ws.write_with_format(0, 0, "Field", &header).map_err(to_err)?;
        ws.write_with_format(0, 1, "Value", &header).map_err(to_err)?;
        let min_fps: Value = if fps.is_empty() {
            Value::from("")
        } else {
            Value::from(round1(fps.iter().cloned().fold(f64::INFINITY, f64::min)))
        };
        let peak_mem: Value = if mem_mb.is_empty() {
            Value::from("")
        } else {
            Value::from(round1(mem_mb.iter().cloned().fold(f64::NEG_INFINITY, f64::max)))
        };
        let rows: [(&str, Value); 9] = [
            ("Device", Value::from(device_name)),
            ("Device ID", Value::from(as_str(&device, "id").to_string())),
            ("Started At", Value::from(format_ms(ms_field(payload, "startedAt")))),
            ("Ended At", Value::from(format_ms(ms_field(payload, "endedAt")))),
            ("Samples", Value::from(samples.len() as f64)),
            ("Average FPS", Value::from(round1(avg(&fps)))),
            ("Min FPS", min_fps),
            ("Average CPU %", Value::from(round1(avg(&cpu)))),
            ("Peak MEM MB", peak_mem),
        ];
        for (i, (field, value)) in rows.iter().enumerate() {
            let r = (i + 1) as u32;
            ws.write(r, 0, *field).map_err(to_err)?;
            write_value(ws, r, 1, value).map_err(to_err)?;
        }
    }

    // —— Raw Data ——
    {
        let ws = wb.add_worksheet();
        ws.set_name("Raw Data").map_err(to_err)?;
        let headers = [
            "Time", "FPS", "CPU %", "MEM MB", "GPU %", "MTP", "FrmCpu", "FrmGpu", "ATWGPU",
            "Provider", "Package", "Activity", "Pico Raw Line",
        ];
        for (c, h) in headers.iter().enumerate() {
            ws.write_with_format(0, c as u16, *h, &header).map_err(to_err)?;
        }
        for (i, s) in samples.iter().enumerate() {
            let r = (i + 1) as u32;
            let m = s.get("metrics").cloned().unwrap_or(Value::Null);
            ws.write(r, 0, format_ms(ms_field(s, "capturedAt"))).map_err(to_err)?;
            write_opt(ws, r, 1, as_f64(&m, "fps")).map_err(to_err)?;
            write_opt(ws, r, 2, as_f64(&m, "cpuUsage").map(round1)).map_err(to_err)?;
            write_opt(ws, r, 3, as_f64(&m, "memoryUsage").map(|v| round1(v / 1024.0))).map_err(to_err)?;
            write_opt(ws, r, 4, pico_value(&m, "gpuUtil")).map_err(to_err)?;
            write_opt(ws, r, 5, pico_value(&m, "mtp")).map_err(to_err)?;
            write_opt(ws, r, 6, pico_value(&m, "frameCpu")).map_err(to_err)?;
            write_opt(ws, r, 7, pico_value(&m, "frameGpu")).map_err(to_err)?;
            write_opt(ws, r, 8, pico_value(&m, "atwGpu")).map_err(to_err)?;
            ws.write(r, 9, as_str(&m, "provider")).map_err(to_err)?;
            ws.write(r, 10, as_str(&m, "packageName")).map_err(to_err)?;
            ws.write(r, 11, as_str(&m, "activityName")).map_err(to_err)?;
            let raw_line = m
                .get("picoMetrics")
                .and_then(|p| p.get("rawLine"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            ws.write(r, 12, raw_line).map_err(to_err)?;
        }
    }

    wb.save_to_buffer().map_err(to_err)
}

/// 写一个数值或字符串的 Value（数值用 Number，否则空串）。
fn write_value(
    ws: &mut rust_xlsxwriter::Worksheet,
    r: u32,
    c: u16,
    v: &Value,
) -> Result<(), rust_xlsxwriter::XlsxError> {
    if let Some(n) = v.as_f64() {
        ws.write(r, c, n)?;
    } else {
        ws.write(r, c, v.as_str().unwrap_or(""))?;
    }
    Ok(())
}

/// 写 Option<f64>：Some→数值，None→空串（对齐原版 picoValue 缺失留空）。
fn write_opt(
    ws: &mut rust_xlsxwriter::Worksheet,
    r: u32,
    c: u16,
    v: Option<f64>,
) -> Result<(), rust_xlsxwriter::XlsxError> {
    match v {
        Some(n) => ws.write(r, c, n)?,
        None => ws.write(r, c, "")?,
    };
    Ok(())
}
