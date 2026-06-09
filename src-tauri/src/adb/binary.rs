//! bundled adb 定位（对应原 adbBinary.ts）。
//! 解析顺序：生产 resource_dir → 开发期 exe 上级的 src-tauri/platform-tools。
//! 路径全从锚点推导，不硬编码盘符。

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
const ADB_EXE: &str = "adb.exe";
#[cfg(not(target_os = "windows"))]
const ADB_EXE: &str = "adb";

fn platform_target() -> &'static str {
    if cfg!(target_os = "windows") {
        "win"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// platform-tools 内 adb 的相对路径：platform-tools/<os>/platform-tools/adb(.exe)
fn relative_adb() -> PathBuf {
    Path::new("platform-tools")
        .join(platform_target())
        .join("platform-tools")
        .join(ADB_EXE)
}

/// 解析 bundled adb 的绝对路径；找不到返回 None。
pub fn resolve_adb_path(app: &AppHandle) -> Option<PathBuf> {
    let rel = relative_adb();
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 生产：资源目录（tauri bundle resources → resource_dir/platform-tools/...）
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join(&rel));
    }

    // 开发：exe 在 src-tauri/target/{debug,release}/，向上两级即 src-tauri，下面有 platform-tools
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("..").join("..").join(&rel));
            candidates.push(dir.join("..").join("..").join("..").join(&rel));
        }
    }

    candidates.into_iter().find(|p| p.is_file())
}
