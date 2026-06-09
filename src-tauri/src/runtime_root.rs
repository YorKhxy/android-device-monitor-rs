//! 运行时根目录推导（对应原 Electron 版 runtimeAppRoot.ts 的 resolveRuntimeAppRoot）。
//!
//! 铁律：可写数据（完整日志 device-logs/、录制、传输 journal 等）一律落 exe 同目录，
//! 绝不进 C 盘 userData；路径从锚点动态推导，禁硬编码盘符。

use std::path::PathBuf;

/// 运行时根目录：
/// - 生产：exe 所在目录（安装目录）
/// - 开发：cargo 产物在 target/{debug,release}，回退到仓库根目录便于本地落盘
pub fn resolve_runtime_app_root() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // 开发期 exe 位于 src-tauri/target/{debug,release}/，向上三级即仓库根
            if dir.ends_with("debug") || dir.ends_with("release") {
                if let Some(root) = dir.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                    return root.to_path_buf();
                }
            }
            return dir.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// 完整日志落盘目录：exe 同目录的 device-logs/（铁律）。
pub fn device_logs_dir() -> PathBuf {
    resolve_runtime_app_root().join("device-logs")
}
