//! 设备文件浏览与增删（T4.1 + T4.5）。命令名 = 渲染层方法名 snake_case。
//! UI 不暴露宿主绝对路径——这里只处理设备端路径；上传文件选择经系统对话框拿本地路径。
//! 列目录用 `ls -al` + 日期锚定解析，跨设备（toybox/busybox）列数差异不敏感。

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::adb::binary;
use crate::adb::error::classify_adb_error;
use crate::adb::manager::exec_adb_capture;
use crate::transfer::runner::shell_quote;

fn adb_not_found() -> Value {
    classify_adb_error("enoent", &[]).to_result()
}

/// 设备文件条目（对齐 shared/types 的 DeviceFileEntry，序列化 camelCase）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceFileEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
    mtime: String,
}

/// `ls -l` 行解析正则：用「日期 时间」(YYYY-MM-DD HH:MM) 锚定，不依赖 owner/group 列数。
/// 捕获 1=日期 2=时间 3=名称(及之后)；size 取日期前最后一个数字字段；类型看行首字符。
fn ls_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$").unwrap())
}

fn join_path(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// 把 dir_path 规整为非空设备路径（空 → 根 `/`，去掉末尾多余 `/`）。
fn normalize_dir(dir_path: &str) -> String {
    let trimmed = dir_path.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `ls` 列目录的目标参数：给目录补尾斜杠，强制解引用「指向目录的软链接」。
/// 否则 `ls -al /sdcard`（/sdcard 是指向 /storage/self/primary 的软链接）只列出软链接本身、不进去列内容。
fn list_target(dir: &str) -> String {
    if dir.ends_with('/') {
        dir.to_string()
    } else {
        format!("{dir}/")
    }
}

fn parse_ls_line(line: &str, dir: &str) -> Option<DeviceFileEntry> {
    let line = line.trim_end();
    if line.is_empty() || line.starts_with("total ") {
        return None;
    }
    let first = line.chars().next()?;
    let is_dir = first == 'd';
    let is_symlink = first == 'l';

    let caps = ls_regex().captures(line)?;
    let date = caps.get(1)?.as_str();
    let time = caps.get(2)?.as_str();
    let rest = caps.get(3)?.as_str().trim();

    // size：日期匹配起点之前的最后一个数字字段（普通文件大小；目录/特殊文件可能非数字 → 0）。
    let date_start = caps.get(1)?.start();
    let size = line[..date_start]
        .split_whitespace()
        .last()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    // 符号链接名形如 `name -> target`，取箭头前的名字。
    let name = if is_symlink {
        rest.split(" -> ").next().unwrap_or(rest).trim()
    } else {
        rest
    };
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }

    Some(DeviceFileEntry {
        name: name.to_string(),
        path: join_path(dir, name),
        is_dir,
        is_symlink,
        size,
        mtime: format!("{date} {time}"),
    })
}

fn describe_or(stderr: &str, fallback: &str) -> String {
    let s = stderr.trim();
    if s.is_empty() {
        fallback.to_string()
    } else {
        s.to_string()
    }
}

/// 列设备目录（`adb shell ls -al`）。目录不存在/受限 → 结构化错误（前端温和内联提示，不弹红）。
#[tauri::command(rename_all = "camelCase")]
pub async fn list_device_files(app: AppHandle, device_id: String, dir_path: String) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let dir = normalize_dir(&dir_path);
    // 列内容用带尾斜杠的目标（解引用软链接目录，如 /sdcard）；过 adb shell 的路径需单引号转义防词拆。
    let q_dir = shell_quote(&list_target(&dir));
    match exec_adb_capture(&adb, &["-s", &device_id, "shell", "ls", "-al", &q_dir], 15_000).await {
        Ok(out) if out.success => {
            let entries: Vec<DeviceFileEntry> =
                out.stdout.lines().filter_map(|l| parse_ls_line(l, &dir)).collect();
            json!({ "success": true, "data": { "path": dir, "entries": entries } })
        }
        Ok(out) => json!({
            "success": false,
            "error": describe_or(&out.stderr, "该目录不存在或无法访问"),
        }),
        Err(e) => e.to_result(),
    }
}

/// 删除设备文件/文件夹（`rm -rf` 文件与目录通吃；二次确认在前端）。
#[tauri::command(rename_all = "camelCase")]
pub async fn delete_device_file(
    app: AppHandle,
    device_id: String,
    remote_path: String,
    _is_dir: bool,
) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let q_path = shell_quote(&remote_path);
    match exec_adb_capture(&adb, &["-s", &device_id, "shell", "rm", "-rf", &q_path], 15_000).await {
        Ok(out) if out.success => json!({ "success": true, "data": null }),
        Ok(out) => json!({ "success": false, "error": describe_or(&out.stderr, "删除失败") }),
        Err(e) => e.to_result(),
    }
}

/// 新建文件夹，返回新目录的设备路径。
#[tauri::command(rename_all = "camelCase")]
pub async fn create_device_folder(
    app: AppHandle,
    device_id: String,
    dir_path: String,
    name: String,
) -> Value {
    let adb = match binary::resolve_adb_path(&app) {
        None => return adb_not_found(),
        Some(p) => p,
    };
    let target = join_path(&normalize_dir(&dir_path), name.trim());
    let q_target = shell_quote(&target);
    match exec_adb_capture(&adb, &["-s", &device_id, "shell", "mkdir", &q_target], 15_000).await {
        Ok(out) if out.success => json!({ "success": true, "data": target }),
        Ok(out) => json!({ "success": false, "error": describe_or(&out.stderr, "新建文件夹失败") }),
        Err(e) => e.to_result(),
    }
}

/// 选择要上传的本地文件（系统对话框，多选任意类型）。
#[tauri::command]
pub async fn select_upload_files(app: AppHandle) -> Value {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("选择要上传的文件").pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    match rx.await {
        Ok(Some(paths)) => {
            let list: Vec<String> = paths
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            json!({ "success": true, "data": list })
        }
        _ => json!({ "success": true, "data": [] }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_file_line_with_size_and_mtime() {
        let e = parse_ls_line("-rw-rw---- 1 u0_a1 u0_a1 12345 2024-01-15 14:30 photo.jpg", "/sdcard").unwrap();
        assert_eq!(e.name, "photo.jpg");
        assert_eq!(e.path, "/sdcard/photo.jpg");
        assert!(!e.is_dir);
        assert!(!e.is_symlink);
        assert_eq!(e.size, 12345);
        assert_eq!(e.mtime, "2024-01-15 14:30");
    }

    #[test]
    fn parses_dir_and_symlink_skips_dot() {
        let d = parse_ls_line("drwxrwx--x 2 root sdcard_rw 4096 2024-02-01 09:00 DCIM", "/sdcard").unwrap();
        assert!(d.is_dir);
        assert_eq!(d.name, "DCIM");

        let l = parse_ls_line("lrwxrwxrwx 1 root root 21 2023-12-01 00:00 sdcard -> /storage/self/primary", "/").unwrap();
        assert!(l.is_symlink);
        assert_eq!(l.name, "sdcard");
        assert_eq!(l.path, "/sdcard");

        assert!(parse_ls_line(".", "/sdcard").is_none());
        assert!(parse_ls_line("total 48", "/sdcard").is_none());
        assert!(parse_ls_line("drwxr-xr-x 2 root root 4096 2024-01-01 00:00 .", "/sdcard").is_none());
    }

    #[test]
    fn normalize_dir_handles_empty_and_trailing_slash() {
        assert_eq!(normalize_dir(""), "/");
        assert_eq!(normalize_dir("/"), "/");
        assert_eq!(normalize_dir("/sdcard/"), "/sdcard");
        assert_eq!(normalize_dir("  /sdcard/DCIM  "), "/sdcard/DCIM");
    }

    #[test]
    fn list_target_appends_trailing_slash_to_deref_symlink() {
        // 软链接目录(/sdcard)需补尾斜杠才列内容；根已带斜杠不重复加。
        assert_eq!(list_target("/sdcard"), "/sdcard/");
        assert_eq!(list_target("/sdcard/DCIM"), "/sdcard/DCIM/");
        assert_eq!(list_target("/"), "/");
    }
}
