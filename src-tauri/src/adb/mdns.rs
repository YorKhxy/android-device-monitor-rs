//! 局域网设备 mDNS 自动发现（Phase 1）+ 扫码配对辅助（Phase 2 复用）。
//!
//! 不自己实现 mDNS：直接用 adb 自带的 `adb mdns services`（platform-tools 31+ 内置 openscreen mdns），
//! 解析其输出拿到局域网里广播的设备/配对服务，再调已有的 connect/pair。零额外依赖、规避原始多播/防火墙坑。
//!
//! `adb mdns services` 输出（制表/空白分隔）：
//!   List of discovered mdns services
//!   adb-PA9410MGK3220149G  _adb._tcp              192.168.1.51:5555
//!   adb-XXXX               _adb-tls-connect._tcp  192.168.1.83:42137   ← 无线调试(已配对)
//!   studio-abcd            _adb-tls-pairing._tcp  192.168.1.20:38911   ← 配对中(扫码后冒出)

use std::path::Path;

use serde::Serialize;

use super::error::AdbError;
use super::manager::exec_adb;

/// 一条 mDNS 发现的服务。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdnsService {
    /// 实例名（如 adb-<序列号> 或扫码配对的 <服务名>）。
    pub name: String,
    /// 从 adb-<serial> 名提取的序列号（取不到为 None）。
    pub serial: Option<String>,
    /// 服务类型：_adb._tcp / _adb-tls-connect._tcp / _adb-tls-pairing._tcp。
    pub service_type: String,
    pub host: String,
    pub port: u16,
    /// host:port，给 adb connect/pair。
    pub target: String,
    /// 是否配对服务（_adb-tls-pairing._tcp）。
    pub pairing: bool,
}

const PAIRING_TYPE: &str = "_adb-tls-pairing._tcp";

/// 解析 `adb mdns services` 输出（纯函数，便于测试）。跳过表头与脏行。
pub fn parse_mdns_services(stdout: &str) -> Vec<MdnsService> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of") {
            continue;
        }
        // 制表或多空白分隔成 3 段：名 / 类型 / host:port。
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let name = fields[0].to_string();
        let service_type = fields[1].trim_end_matches('.').to_string();
        let addr = fields[2];
        let Some((host, port_str)) = addr.rsplit_once(':') else { continue };
        let Ok(port) = port_str.parse::<u16>() else { continue };
        if host.is_empty() || port == 0 {
            continue;
        }
        let serial = name.strip_prefix("adb-").map(|s| s.to_string());
        let pairing = service_type.starts_with(PAIRING_TYPE);
        out.push(MdnsService {
            name,
            serial,
            service_type,
            host: host.to_string(),
            port,
            target: format!("{host}:{port}"),
            pairing,
        });
    }
    out
}

/// 跑 `adb mdns services` 并解析。失败（adb 不支持 mDNS 等）返回 Err。
pub async fn discover(adb: &Path) -> Result<Vec<MdnsService>, AdbError> {
    let out = exec_adb(adb, &["mdns", "services"], 6000).await?;
    Ok(parse_mdns_services(&out.stdout))
}

/// 可连接的设备（非配对服务），按序列号去重——同一设备可能同时广播 _adb._tcp 与 _adb-tls-connect._tcp，
/// 只留一条（优先 _adb._tcp 的经典 5555，其次任意）。
pub fn connectable(services: Vec<MdnsService>) -> Vec<MdnsService> {
    let mut out: Vec<MdnsService> = Vec::new();
    for s in services.into_iter().filter(|s| !s.pairing) {
        let key = s.serial.clone().unwrap_or_else(|| s.host.clone());
        if let Some(existing) = out.iter_mut().find(|e| e.serial.clone().unwrap_or_else(|| e.host.clone()) == key) {
            // 已有同设备：若新条目是经典 _adb._tcp 而旧的不是，换成经典的（连接最稳）。
            if s.service_type == "_adb._tcp" && existing.service_type != "_adb._tcp" {
                *existing = s;
            }
        } else {
            out.push(s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "List of discovered mdns services\n\
        adb-PA9410MGK3220149G\t_adb._tcp\t192.168.1.51:5555\n\
        adb-PA9410MGK3220149G\t_adb-tls-connect._tcp.\t192.168.1.51:42137\n\
        adb-PA9410MGJA180134G\t_adb._tcp\t192.168.1.26:5555\n\
        studio-abcd\t_adb-tls-pairing._tcp\t192.168.1.20:38911\n";

    #[test]
    fn parses_and_extracts() {
        let svcs = parse_mdns_services(SAMPLE);
        assert_eq!(svcs.len(), 4);
        assert_eq!(svcs[0].serial.as_deref(), Some("PA9410MGK3220149G"));
        assert_eq!(svcs[0].target, "192.168.1.51:5555");
        assert!(!svcs[0].pairing);
        assert!(svcs[3].pairing);
        assert_eq!(svcs[3].name, "studio-abcd");
    }

    #[test]
    fn connectable_dedups_by_serial_prefers_classic() {
        let svcs = parse_mdns_services(SAMPLE);
        let conn = connectable(svcs);
        // 配对服务被排除；同序列号去重 → 两台设备。
        assert_eq!(conn.len(), 2);
        let first = conn.iter().find(|s| s.serial.as_deref() == Some("PA9410MGK3220149G")).unwrap();
        assert_eq!(first.service_type, "_adb._tcp"); // 优先经典
        assert_eq!(first.port, 5555);
    }

    #[test]
    fn skips_garbage_lines() {
        assert!(parse_mdns_services("List of discovered mdns services\n\ngarbage\nfoo bar\n").is_empty());
    }
}
