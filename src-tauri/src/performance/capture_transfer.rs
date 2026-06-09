//! 采集会话导出/导入打包（对应原 performanceCaptureTransfer.ts）。
//! 导出：把整个会话目录打成 zip，zip 内顶层目录名 = sessionId，解压后即可还原成会话文件夹。
//! 导入：解压到临时目录后定位含 manifest.json 的会话目录交给 store 落地（store 负责 id 去重与改写）。
//! 同步实现（zip crate 同步）；命令侧用 spawn_blocking 调用，避免阻塞异步运行时。

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::adb::error::AdbError;

use super::capture_store;
use super::types::CaptureSession;

fn err(message: impl Into<String>, details: impl Into<String>) -> AdbError {
    AdbError::custom("CAPTURE_IMPORT_ERROR", message.into(), "请确认所选为有效的采集会话压缩包或文件夹。", details.into())
}

/// `[^\w.-]+ → _`，去首尾 `_`，空则 "device"（与 capture_store 一致，用于导入 id）。
fn sanitize(value: &str) -> String {
    let mut out = String::new();
    let mut prev = false;
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            out.push(c);
            prev = false;
        } else if !prev {
            out.push('_');
            prev = true;
        }
    }
    let t = out.trim_matches('_');
    if t.is_empty() { "device".to_string() } else { t.to_string() }
}

fn unique_temp_dir() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("adm-capture-import-{ms}-{n}"))
}

/// 把会话目录打包成 zip（顶层目录为 sessionId）。
pub fn zip_session_dir(session_dir: &Path, dest_zip: &Path) -> Result<(), String> {
    let base = session_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("session")
        .to_string();
    let file = File::create(dest_zip).map_err(|e| format!("创建 zip 失败：{e}"))?;
    let mut zip = ZipWriter::new(file);
    add_dir_to_zip(&mut zip, session_dir, &base)?;
    zip.finish().map_err(|e| format!("写入 zip 失败：{e}"))?;
    Ok(())
}

fn add_dir_to_zip(
    zip: &mut ZipWriter<File>,
    dir: &Path,
    prefix: &str,
) -> Result<(), String> {
    let opts = SimpleFileOptions::default();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取目录失败：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let zip_name = format!("{prefix}/{name}");
        if path.is_dir() {
            zip.add_directory(&zip_name, opts).map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, &path, &zip_name)?;
        } else {
            zip.start_file(&zip_name, opts).map_err(|e| e.to_string())?;
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 在 root 自身或其一层子目录中定位含 manifest.json 的会话目录。
fn locate_manifest_dir(root: &Path) -> Option<PathBuf> {
    if root.join("manifest.json").is_file() {
        return Some(root.to_path_buf());
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("manifest.json").is_file() {
            return Some(path);
        }
    }
    None
}

/// 临时目录守卫：drop 时递归删除（确保导入后临时解压目录被清理）。
pub struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 解压 zip 到临时目录并定位会话目录；返回 (临时目录守卫, 会话目录)。守卫 drop 时清理临时目录。
pub fn extract_and_locate(zip_path: &Path) -> Result<(TempDir, PathBuf), String> {
    let temp = unique_temp_dir();
    std::fs::create_dir_all(&temp).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let guard = TempDir(temp.clone());

    let file = File::open(zip_path).map_err(|e| format!("打开 zip 失败：{e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("zip 解析失败：{e}"))?;
    archive
        .extract(&temp)
        .map_err(|e| format!("zip 解压失败：{e}"))?;

    match locate_manifest_dir(&temp) {
        Some(session_dir) => Ok((guard, session_dir)),
        None => Err("zip 内未找到采集会话（缺少 manifest.json）".to_string()),
    }
}

/// 异步递归拷贝目录。
async fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), AdbError> {
    tokio::fs::create_dir_all(dst).await.map_err(|e| err("创建目标目录失败", e.to_string()))?;
    let mut entries = tokio::fs::read_dir(src)
        .await
        .map_err(|e| err("读取源目录失败", e.to_string()))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| err("遍历目录失败", e.to_string()))?
    {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            Box::pin(copy_dir_all(&from, &to)).await?;
        } else {
            tokio::fs::copy(&from, &to)
                .await
                .map_err(|e| err("拷贝文件失败", e.to_string()))?;
        }
    }
    Ok(())
}

/// 从一个会话目录（含 manifest.json）导入：id 冲突则追加 -impN，递归拷入并改写 manifest 的 id 与相对路径。
/// 对应原 store.importFromDirectory（store 负责 id 去重与改写）。
pub async fn import_from_directory(src_dir: &Path) -> Result<CaptureSession, AdbError> {
    let raw = tokio::fs::read_to_string(src_dir.join("manifest.json"))
        .await
        .map_err(|_| err("所选内容不是有效的采集会话（缺少 manifest.json）", "no manifest.json"))?;
    let parsed: CaptureSession =
        serde_json::from_str(&raw).map_err(|e| err("采集会话 manifest.json 解析失败", e.to_string()))?;

    let base = sanitize(if parsed.id.trim().is_empty() {
        "imported"
    } else {
        &parsed.id
    });
    let mut final_id = base.clone();
    let mut n = 1;
    while capture_store::session_dir(&final_id)?.exists() {
        n += 1;
        final_id = format!("{base}-imp{n}");
    }

    let dest = capture_store::session_dir(&final_id)?;
    let _ = tokio::fs::create_dir_all(capture_store::captures_root()).await;
    copy_dir_all(src_dir, &dest).await?;

    let updated = CaptureSession {
        id: final_id.clone(),
        data_relative_path: format!(
            "{}/{}/data/{}",
            capture_store::CAPTURES_DIR,
            final_id,
            capture_store::SAMPLES_FILE
        ),
        screenshot_dir: Some(format!("{}/{}/screenshots", capture_store::CAPTURES_DIR, final_id)),
        ..parsed
    };
    capture_store::write_manifest(&final_id, &updated).await?;
    Ok(updated)
}
