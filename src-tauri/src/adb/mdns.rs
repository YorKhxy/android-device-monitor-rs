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

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

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

/// 跑一次 `adb mdns services` 并解析。失败（adb 不支持 mDNS 等）返回 Err。
pub async fn discover(adb: &Path) -> Result<Vec<MdnsService>, AdbError> {
    let out = exec_adb(adb, &["mdns", "services"], 6000).await?;
    Ok(parse_mdns_services(&out.stdout))
}

/// 流式多拍发现：mDNS 是**周期性广播 + 守护进程缓存快照**，单次 `adb mdns services` 只拿到这一瞬刚广播过的
/// 子集；刚重启 adb server（app 重新构建/启动）缓存还是冷的，头几次可能为空。故连扫 `passes` 拍、每拍间隔
/// `gap_ms`，按 (服务类型, target) 跨拍并集去重，显著提命中率。**每拍扫描后**把当前累计的「可连接设备」交给
/// `on_pass` 回调——用于即时 emit 给前端，第一拍(~百毫秒)就先显示，后续拍补齐，免去干等全程。
/// best-effort：单拍失败不中断；仅当全部失败且无任何结果时才返回最后一次错误。
/// 返回最终累计的全部服务（未经 connectable 处理，去重交调用方）。
pub async fn discover_streaming(
    adb: &Path,
    passes: u8,
    gap_ms: u64,
    mut on_pass: impl FnMut(Vec<MdnsService>),
) -> Result<Vec<MdnsService>, AdbError> {
    let passes = passes.max(1);
    let mut seen: HashSet<String> = HashSet::new();
    let mut merged: Vec<MdnsService> = Vec::new();
    let mut last_err: Option<AdbError> = None;
    for i in 0..passes {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(gap_ms)).await;
        }
        match discover(adb).await {
            Ok(svcs) => {
                for s in svcs {
                    if seen.insert(format!("{}|{}", s.service_type, s.target)) {
                        merged.push(s);
                    }
                }
            }
            Err(e) => last_err = Some(e),
        }
        on_pass(connectable(merged.clone())); // 每拍把累计可连接设备推出去（先出先显）
    }
    if merged.is_empty() {
        if let Some(e) = last_err {
            return Err(e);
        }
    }
    Ok(merged)
}

/// 去重键：(序列号, 主机IP) 复合。仅当两条记录**序列号与 IP 都相同**才视为同一设备合并。
fn dedup_key(s: &MdnsService) -> (String, String) {
    (s.serial.clone().unwrap_or_default(), s.host.clone())
}

/// 可连接的设备（非配对服务），按 **(序列号, IP) 复合键**去重——同一台设备同时广播的
/// _adb._tcp 与 _adb-tls-connect._tcp 序列号与 IP 都相同会被合并（优先 _adb._tcp 经典 5555，连接最稳）。
///
/// 为何用复合键而非单一键：
/// - 单按序列号：Pico 等常有**重复/非唯一序列号**（同批刷机），会把序列号相同、IP 不同的两台真实设备误并
///   成一台 →「同型号同设置、手动 IP 能连、就是扫不出来」。
/// - 单按 IP：会把同 IP、序列号不同的两条记录误并（极端/未解析占位地址下），可能少显示。
/// 复合键只比"纯序列号去重"**更细**，显示集合是其超集，**不会比原来少显示**（修我之前纯 IP 去重的回归），
/// 同时重复序列号不同 IP 的两台都保留（修最初的 Pico 被吞）。
pub fn connectable(services: Vec<MdnsService>) -> Vec<MdnsService> {
    let mut out: Vec<MdnsService> = Vec::new();
    for s in services.into_iter().filter(|s| !s.pairing) {
        if let Some(existing) = out.iter_mut().find(|e| dedup_key(e) == dedup_key(&s)) {
            // 同一设备的另一条服务记录：若新条目是经典 _adb._tcp 而旧的不是，换成经典的。
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
    fn connectable_merges_same_device_records_prefers_classic() {
        let svcs = parse_mdns_services(SAMPLE);
        let conn = connectable(svcs);
        // 配对服务被排除；同一设备(同序列号同 IP)的两条服务记录合并 → 两台设备（.51、.26）。
        assert_eq!(conn.len(), 2);
        let first = conn.iter().find(|s| s.host == "192.168.1.51").unwrap();
        assert_eq!(first.service_type, "_adb._tcp"); // 同设备多记录优先经典
        assert_eq!(first.port, 5555);
    }

    /// 重复/非唯一序列号（Pico 常见）但 IP 不同的两台设备：复合键去重应**都保留**，不被误并（修最初的 Pico 被吞）。
    #[test]
    fn connectable_keeps_distinct_hosts_with_duplicate_serial() {
        let dup = "List of discovered mdns services\n\
            adb-SAMESERIAL\t_adb._tcp\t192.168.1.10:5555\n\
            adb-SAMESERIAL\t_adb._tcp\t192.168.1.11:5555\n";
        let conn = connectable(parse_mdns_services(dup));
        assert_eq!(conn.len(), 2, "序列号相同但 IP 不同的两台 Pico 都应出现在扫描结果里");
        assert!(conn.iter().any(|s| s.host == "192.168.1.10"));
        assert!(conn.iter().any(|s| s.host == "192.168.1.11"));
    }

    /// 回归守护：同 IP、序列号不同的两条记录（极端/未解析占位地址下）复合键去重应**都保留**——
    /// 防止退回到纯 IP 去重那种「原本能扫的都没了」。
    #[test]
    fn connectable_keeps_same_host_with_distinct_serials() {
        let same_host = "List of discovered mdns services\n\
            adb-AAAA\t_adb._tcp\t0.0.0.0:5555\n\
            adb-BBBB\t_adb._tcp\t0.0.0.0:5555\n";
        let conn = connectable(parse_mdns_services(same_host));
        assert_eq!(conn.len(), 2, "同 IP 但序列号不同的两条记录不应被误并");
    }

    #[test]
    fn skips_garbage_lines() {
        assert!(parse_mdns_services("List of discovered mdns services\n\ngarbage\nfoo bar\n").is_empty());
    }
}
