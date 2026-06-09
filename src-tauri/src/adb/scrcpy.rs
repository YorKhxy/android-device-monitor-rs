//! bundled scrcpy 定位（T3.2，仿 adb/binary.rs）。
//! 解析顺序：生产 resource_dir → 开发期 exe 上级的 src-tauri/scrcpy。
//! 路径全从锚点推导，不硬编码盘符。
//!
//! 资源接入三环节（见 .claude/feedback/feature-must-work-out-of-box-after-packaging.md）：
//!   1. 准备：scripts/prepare-scrcpy.mjs 把 scrcpy 下到 src-tauri/scrcpy/<os>/（不入库）
//!   2. 打包清单：tauri.conf.json bundle.resources 列 "scrcpy/**/*"
//!   3. 运行时解析：本文件 resolve_scrcpy_path（生产 resource_dir + 开发相对回退）

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
const SCRCPY_EXE: &str = "scrcpy.exe";
#[cfg(not(target_os = "windows"))]
const SCRCPY_EXE: &str = "scrcpy";

fn platform_target() -> &'static str {
    if cfg!(target_os = "windows") {
        "win"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// scrcpy 可执行的相对路径：scrcpy/<os>/scrcpy(.exe)（解压包内容平铺在 <os>/ 下）。
fn relative_scrcpy() -> PathBuf {
    Path::new("scrcpy").join(platform_target()).join(SCRCPY_EXE)
}

/// 解析 bundled scrcpy 的绝对路径；找不到返回 None。
/// scrcpy.exe 同目录须含 scrcpy-server 与配套 dll（prepare 脚本整包平铺，不拆分）。
pub fn resolve_scrcpy_path(app: &AppHandle) -> Option<PathBuf> {
    let rel = relative_scrcpy();
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 生产：资源目录（tauri bundle resources → resource_dir/scrcpy/...）
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join(&rel));
    }

    // 开发：exe 在 src-tauri/target/{debug,release}/，向上两级即 src-tauri，下面有 scrcpy
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("..").join("..").join(&rel));
            candidates.push(dir.join("..").join("..").join("..").join(&rel));
        }
    }

    candidates.into_iter().find(|p| p.is_file())
}
