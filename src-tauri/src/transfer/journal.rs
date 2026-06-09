//! 传输 journal 持久化（T4-3）：任务清单落 **运行时根目录** `transfer-journal.json`（非 C 盘 userData），
//! 用于进程崩溃 / 被强杀后识别未完成传输并文件级续传。
//!
//! 语义（对齐 shared/types `TransferTask` 注释 + DEV-PLAN T4.4）：
//! - 开传输前 `begin_batch` 把本批每个文件落为 `pending`；
//! - runner 传单文件时 `mark` 流转 `transferring` → `done`/`failed`；
//! - 一批传完（正常返回）由命令层 `remove_batch` 整批清理——「了结即清理」；
//! - **仅崩溃 / 被强杀残留** 的 `pending`/`transferring` 会在重启后被 `list_resume_batches` 识别为可恢复；
//!   `done`（已传完）/`failed`（报错）不进恢复队列。
//!
//! 落盘原子性：写临时文件 `.tmp` 后 rename，避免写一半被杀导致 journal 损坏（恢复机制本身要抗崩溃）。
//! 并发：全局 `Mutex` 串行化「读取→改→写回」，多路传输（上传+下载并行）安全。journal 体量小（数个~数十条），
//! 同步文件 IO 开销可忽略；所有公开函数全程同步、锁不跨 await。

use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::runtime_root::resolve_runtime_app_root;

/// 单个传输任务（批量中的一个文件）。序列化为 camelCase，对齐 shared/types `TransferTask`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTask {
    pub id: String,
    pub batch_id: String,
    pub direction: String, // "upload" | "download"
    pub device_id: String,
    pub source_path: String, // 上传=本地文件路径；下载=设备文件路径
    pub target_path: String, // 上传=设备目标目录；下载=PC 保存目录
    pub file_name: String,
    pub size: u64, // 字节，未知填 0
    pub status: String, // "pending" | "transferring" | "done" | "failed"
    pub created_at: u64,
    pub updated_at: u64,
}

/// 启动时推送给渲染层的「可恢复批次」摘要，对齐 shared/types `TransferResumeBatch`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeBatch {
    pub batch_id: String,
    pub direction: String,
    pub device_id: String,
    pub remaining: u32,
    pub sample_names: Vec<String>,
}

/// 新建批次时单个文件的描述（source/name/size）。
pub struct NewTask {
    pub source_path: String,
    pub file_name: String,
    pub size: u64,
}

const SAMPLE_LIMIT: usize = 4;

/// 串行化 journal 的读取→改→写回。全程同步，锁不跨 await。
fn lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn journal_path() -> std::path::PathBuf {
    resolve_runtime_app_root().join("transfer-journal.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 读取 journal；文件缺失 / 内容损坏一律当空（容错——损坏不应让传输不可用）。
fn read_tasks() -> Vec<TransferTask> {
    let path = journal_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 原子写回：先写 `.tmp` 再 rename，避免写一半被杀损坏 journal。
fn write_tasks(tasks: &[TransferTask]) {
    let path = journal_path();
    let tmp = path.with_extension("json.tmp");
    let json = match serde_json::to_string_pretty(tasks) {
        Ok(j) => j,
        Err(_) => return,
    };
    if std::fs::write(&tmp, json).is_ok() {
        // Windows rename 目标存在会失败，先删旧文件。
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// 开传输前落本批任务为 pending。batch_id 复用 uploadId/pullId。
pub fn begin_batch(
    batch_id: &str,
    direction: &str,
    device_id: &str,
    target_path: &str,
    items: &[NewTask],
) {
    let _guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut tasks = read_tasks();
    let ts = now_ms();
    for (i, item) in items.iter().enumerate() {
        tasks.push(TransferTask {
            id: format!("{batch_id}-{i}"),
            batch_id: batch_id.to_string(),
            direction: direction.to_string(),
            device_id: device_id.to_string(),
            source_path: item.source_path.clone(),
            target_path: target_path.to_string(),
            file_name: item.file_name.clone(),
            size: item.size,
            status: "pending".to_string(),
            created_at: ts,
            updated_at: ts,
        });
    }
    write_tasks(&tasks);
}

/// 流转某文件状态（transferring/done/failed）。按 (batch_id, file_name) 命中未了结的任务更新。
pub fn mark(batch_id: &str, file_name: &str, status: &str) {
    let _guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut tasks = read_tasks();
    if let Some(t) = tasks
        .iter_mut()
        .find(|t| t.batch_id == batch_id && t.file_name == file_name && t.status != "done")
    {
        t.status = status.to_string();
        t.updated_at = now_ms();
        write_tasks(&tasks);
    }
}

/// 整批移除——一批传完（正常返回）或用户丢弃时调用，「了结即清理」。
pub fn remove_batch(batch_id: &str) {
    let _guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut tasks = read_tasks();
    let before = tasks.len();
    tasks.retain(|t| t.batch_id != batch_id);
    if tasks.len() != before {
        write_tasks(&tasks);
    }
}

/// 某批次中仍待处理（pending/transferring）的任务——续传 / 丢弃清理的依据。
pub fn resumable_tasks(batch_id: &str) -> Vec<TransferTask> {
    let _guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    read_tasks()
        .into_iter()
        .filter(|t| t.batch_id == batch_id && (t.status == "pending" || t.status == "transferring"))
        .collect()
}

/// 汇总所有可恢复批次（pending/transferring）：按 batch_id 分组，给出剩余数与文件名样例。
/// 不限设备——渲染层按 deviceId 过滤（见 FilesPanel.refreshResumeBatches）。
pub fn list_resume_batches() -> Vec<ResumeBatch> {
    let _guard = lock().lock().unwrap_or_else(|e| e.into_inner());
    group_resume_batches(read_tasks())
}

/// 纯分组逻辑（无 IO，便于单测）：保留 pending/transferring，按 batch_id 聚合，保序。
fn group_resume_batches(tasks: Vec<TransferTask>) -> Vec<ResumeBatch> {
    let mut batches: Vec<ResumeBatch> = Vec::new();
    for t in tasks {
        if t.status != "pending" && t.status != "transferring" {
            continue;
        }
        match batches.iter_mut().find(|b| b.batch_id == t.batch_id) {
            Some(b) => {
                b.remaining += 1;
                if b.sample_names.len() < SAMPLE_LIMIT {
                    b.sample_names.push(t.file_name);
                }
            }
            None => batches.push(ResumeBatch {
                batch_id: t.batch_id,
                direction: t.direction,
                device_id: t.device_id,
                remaining: 1,
                sample_names: vec![t.file_name],
            }),
        }
    }
    batches
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(batch: &str, name: &str, status: &str, dir: &str) -> TransferTask {
        TransferTask {
            id: format!("{batch}-{name}"),
            batch_id: batch.to_string(),
            direction: dir.to_string(),
            device_id: "dev1".to_string(),
            source_path: format!("/src/{name}"),
            target_path: "/sdcard/Download".to_string(),
            file_name: name.to_string(),
            size: 0,
            status: status.to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn groups_only_unsettled_by_batch() {
        let tasks = vec![
            task("b1", "a.txt", "done", "upload"),       // 已完成不计
            task("b1", "b.txt", "transferring", "upload"),
            task("b1", "c.txt", "pending", "upload"),
            task("b2", "x.bin", "failed", "download"),   // 失败不计
            task("b2", "y.bin", "pending", "download"),
        ];
        let batches = group_resume_batches(tasks);
        assert_eq!(batches.len(), 2);
        let b1 = batches.iter().find(|b| b.batch_id == "b1").unwrap();
        assert_eq!(b1.remaining, 2);
        assert_eq!(b1.sample_names, vec!["b.txt", "c.txt"]);
        assert_eq!(b1.direction, "upload");
        let b2 = batches.iter().find(|b| b.batch_id == "b2").unwrap();
        assert_eq!(b2.remaining, 1);
        assert_eq!(b2.sample_names, vec!["y.bin"]);
    }

    #[test]
    fn empty_when_all_settled() {
        let tasks = vec![
            task("b1", "a.txt", "done", "upload"),
            task("b1", "b.txt", "failed", "upload"),
        ];
        assert!(group_resume_batches(tasks).is_empty());
    }

    #[test]
    fn sample_names_capped() {
        let tasks: Vec<TransferTask> = (0..10)
            .map(|i| task("b1", &format!("f{i}.txt"), "pending", "download"))
            .collect();
        let batches = group_resume_batches(tasks);
        assert_eq!(batches[0].remaining, 10);
        assert_eq!(batches[0].sample_names.len(), SAMPLE_LIMIT);
    }
}
