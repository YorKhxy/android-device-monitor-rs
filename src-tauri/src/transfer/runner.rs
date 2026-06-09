//! 批量传输执行（T4-2）：adb push/pull 逐文件传，实时进度经 event 推送，临时名 + 原子落地。
//!
//! 原子落地：先传到隐藏临时名 `.<name>.part`，整文件传完校验成功后 rename 到正式名——
//! 中途崩溃/失败只留 `.part` 半成品（可辨识、不污染正式文件）。文件级进度（index/total + status）
//! 即时上报；文件内细粒度百分比依赖 adb 输出格式，留真机确认后增强（当前 push 报 0/100）。
//!
//! 注：传输 journal 持久化与中断恢复见 T4-3（transfer/journal）。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::adb::error::AdbError;
use crate::adb::manager::exec_adb_capture;

/// 单文件传输超时（大文件留足时间）。
const TRANSFER_TIMEOUT_MS: u64 = 600_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushProgress {
    upload_id: String,
    file_name: String,
    index: u32,
    total: u32,
    percent: u32,
    status: String, // "uploading" | "done" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullProgress {
    pull_id: String,
    file_name: String,
    index: u32,
    total: u32,
    status: String, // "downloading" | "done" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// 待下载项（对齐前端 pullDeviceFiles 的 items：设备端路径 + 名称）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullItem {
    pub path: String,
    pub name: String,
}

fn emit_push(app: &AppHandle, p: PushProgress) {
    let _ = app.emit("push_progress", p);
}

fn emit_pull(app: &AppHandle, p: PullProgress) {
    let _ = app.emit("pull_progress", p);
}

/// 设备端路径拼接（统一用 `/`）。
fn remote_join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// 设备端 shell 命令的路径转义：`adb shell mv/rm` 会把参数拼成字符串交设备 shell 二次解析，
/// 含空格/元字符的文件名需单引号包裹（内部单引号转义为 `'\''`），否则被词拆破裂。
/// 注：`adb push/pull` 是直传不过 shell，无需转义。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 批量上传：逐个 adb push 到设备 remote_dir，临时名 `.part` + `mv` 原子落地。返回成功文件数。
pub async fn push_files(
    app: &AppHandle,
    adb: &Path,
    device_id: &str,
    remote_dir: &str,
    local_paths: &[String],
    upload_id: &str,
) -> u32 {
    let total = local_paths.len() as u32;
    let mut succeeded: u32 = 0;

    for (i, local) in local_paths.iter().enumerate() {
        let index = i as u32;
        let file_name = Path::new(local)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| local.clone());
        emit_push(app, PushProgress {
            upload_id: upload_id.to_string(),
            file_name: file_name.clone(),
            index,
            total,
            percent: 0,
            status: "uploading".to_string(),
            error: None,
        });

        let remote_tmp = remote_join(remote_dir, &format!(".{file_name}.part"));
        let remote_final = remote_join(remote_dir, &file_name);
        // push 直传不过 shell（remote_tmp 原样）；mv/rm 过设备 shell，路径需单引号转义防含空格名破裂。
        let q_tmp = shell_quote(&remote_tmp);
        let q_final = shell_quote(&remote_final);

        let pushed = exec_adb_capture(
            adb,
            &["-s", device_id, "push", local, &remote_tmp],
            TRANSFER_TIMEOUT_MS,
        )
        .await;

        match pushed {
            Ok(out) if out.success => {
                // 原子落地：临时名 → 正式名（同目录 mv -f，覆盖同名正式文件 = 重传覆盖语义）。
                let mv = exec_adb_capture(
                    adb,
                    &["-s", device_id, "shell", "mv", "-f", &q_tmp, &q_final],
                    TRANSFER_TIMEOUT_MS,
                )
                .await;
                if matches!(&mv, Ok(o) if o.success) {
                    succeeded += 1;
                    emit_push(app, PushProgress {
                        upload_id: upload_id.to_string(),
                        file_name,
                        index,
                        total,
                        percent: 100,
                        status: "done".to_string(),
                        error: None,
                    });
                } else {
                    let err = mv.err().map(|e| e.message).unwrap_or_else(|| "落地失败".to_string());
                    let _ = exec_adb_capture(adb, &["-s", device_id, "shell", "rm", "-f", &q_tmp], 15_000).await;
                    emit_push(app, push_error(upload_id, &file_name, index, total, err));
                }
            }
            Ok(out) => {
                let _ = exec_adb_capture(adb, &["-s", device_id, "shell", "rm", "-f", &q_tmp], 15_000).await;
                let msg = out.stderr.trim();
                emit_push(app, push_error(upload_id, &file_name, index, total, if msg.is_empty() { "上传失败".to_string() } else { msg.to_string() }));
            }
            Err(e) => {
                let _ = exec_adb_capture(adb, &["-s", device_id, "shell", "rm", "-f", &q_tmp], 15_000).await;
                emit_push(app, push_error(upload_id, &file_name, index, total, e.message));
            }
        }
    }
    succeeded
}

fn push_error(upload_id: &str, file_name: &str, index: u32, total: u32, error: String) -> PushProgress {
    PushProgress {
        upload_id: upload_id.to_string(),
        file_name: file_name.to_string(),
        index,
        total,
        percent: 0,
        status: "error".to_string(),
        error: Some(error),
    }
}

pub struct PullOutcome {
    pub saved_dir: String,
    pub succeeded: u32,
    pub failed: u32,
}

/// 批量下载到本地 save_dir：逐个 adb pull 到临时名 `.part` + rename 原子落地。
pub async fn pull_files(
    app: &AppHandle,
    adb: &Path,
    device_id: &str,
    items: &[PullItem],
    pull_id: &str,
    save_dir: &Path,
) -> Result<PullOutcome, AdbError> {
    tokio::fs::create_dir_all(save_dir).await.map_err(|e| {
        AdbError::custom("TRANSFER_FAILED", format!("创建下载目录失败：{e}"), "检查下载目录写权限。", e.to_string())
    })?;

    let total = items.len() as u32;
    let mut succeeded: u32 = 0;
    let mut failed: u32 = 0;

    for (i, item) in items.iter().enumerate() {
        let index = i as u32;
        emit_pull(app, PullProgress {
            pull_id: pull_id.to_string(),
            file_name: item.name.clone(),
            index,
            total,
            status: "downloading".to_string(),
            error: None,
        });

        let local_tmp: PathBuf = save_dir.join(format!(".{}.part", item.name));
        let local_final: PathBuf = save_dir.join(&item.name);
        let tmp_str = local_tmp.to_string_lossy().to_string();

        let pulled = exec_adb_capture(
            adb,
            &["-s", device_id, "pull", &item.path, &tmp_str],
            TRANSFER_TIMEOUT_MS,
        )
        .await;

        // 先判 adb pull 本身，再判本地落地，错误信息不互相覆盖。
        let pull_err: Option<String> = match &pulled {
            Ok(o) if o.success => None,
            Ok(o) => {
                let m = o.stderr.trim();
                Some(if m.is_empty() { "下载失败".to_string() } else { m.to_string() })
            }
            Err(e) => Some(e.message.clone()),
        };
        let final_err: Option<String> = match pull_err {
            Some(m) => Some(m),
            None => {
                // 覆盖式落地：Windows fs::rename 目标存在会失败，先删同名正式文件再 rename。
                let _ = tokio::fs::remove_file(&local_final).await;
                match tokio::fs::rename(&local_tmp, &local_final).await {
                    Ok(_) => None,
                    Err(e) => Some(format!("落地失败：{e}")),
                }
            }
        };

        match final_err {
            None => {
                succeeded += 1;
                emit_pull(app, PullProgress {
                    pull_id: pull_id.to_string(),
                    file_name: item.name.clone(),
                    index,
                    total,
                    status: "done".to_string(),
                    error: None,
                });
            }
            Some(err) => {
                let _ = tokio::fs::remove_file(&local_tmp).await; // 清半成品
                failed += 1;
                emit_pull(app, PullProgress {
                    pull_id: pull_id.to_string(),
                    file_name: item.name.clone(),
                    index,
                    total,
                    status: "error".to_string(),
                    error: Some(err),
                });
            }
        }
    }

    Ok(PullOutcome {
        saved_dir: save_dir.to_string_lossy().to_string(),
        succeeded,
        failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_join_handles_trailing_slash() {
        assert_eq!(remote_join("/sdcard", "a.txt"), "/sdcard/a.txt");
        assert_eq!(remote_join("/sdcard/", "a.txt"), "/sdcard/a.txt");
        assert_eq!(remote_join("/", "a.txt"), "/a.txt");
    }

    #[test]
    fn shell_quote_wraps_and_escapes() {
        assert_eq!(shell_quote("a.txt"), "'a.txt'");
        // 含空格：单引号包裹后设备 shell 不再词拆。
        assert_eq!(shell_quote("my photo.jpg"), "'my photo.jpg'");
        // 含单引号：转义为 '\'' 闭合-转义-重开。
        assert_eq!(shell_quote("it's.txt"), "'it'\\''s.txt'");
    }
}
