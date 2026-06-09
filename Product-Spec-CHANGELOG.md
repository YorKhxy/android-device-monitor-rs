# 变更记录

## [v2.0] - 2026-06-09
本版为 **Tauri + Rust 重构版**，从原 Electron 版（android-device-monitor，v1.0.21+ 含弱网）派生为独立工程。
功能需求（第 1/2/4/5 章及 6.1）保持 1:1 不变，原 Electron 版作为功能对照基准。仅技术方案与开发计划随技术栈替换而改写。

### 修改
- **技术栈（3.1）**：应用框架 Electron ^28 → Tauri 2.x；新增 Rust（edition 2021）+ tokio 1.x 作为后端；ADB 通信从 adbkit(Node) 改为 Rust `tokio::process` 调用 bundled adb；解压 adm-zip → Rust `zip` crate；自动更新 electron-updater → tauri-plugin-updater 2.x；子进程改用 tauri-plugin-shell。React 18 / TailwindCSS / Lucide 前端整体保留。
- **核心架构（3.2）**：架构图重画为「系统 WebView2（React 前端）→ Tauri IPC（invoke + event/channel）→ Rust Core（adb 引擎/性能采集/截图投屏/文件传输/弱网/日志录制/热更各模块，tokio 异步）→ 外部二进制(adb/scrcpy) → 设备」。新增 IPC 迁移要点：原 ipcMain.handle/contextBridge/electronApi.ts 三处契约迁移为 Tauri `#[tauri::command]` 与 `event`/`Channel`。
- **兼容性（6.2）**：新增 WebView2 运行时依赖说明（Win11 预装，老旧 Win10 需 Bootstrapper）。
- **安全性（6.3）**：热更新改为 tauri-plugin-updater 签名校验；明确可写数据不落 C 盘 userData（落 exe 同目录 device-logs/，运行时锚点推导路径）。
- **开发计划（7）**：原 5 个 Electron Phase 作废，改为 Tauri 迁移分阶段 P0–P7（骨架 / adb 引擎 / 性能采集 / 截图投屏 / 文件传输日志 / 弱网集成 / 打包热更重建 / 真机全功能回归），原则为以 Electron 版为标准答案逐项对拍做到功能 1:1。
- **风险评估（8）**：新增 WebView2 缺失、framebuffer 协议迁移、热更格式不兼容、功能漏迁、Pico 解析回归等迁移特有风险及缓解措施。

### 关键约束
- 体积目标：312MB → ~45MB（platform-tools 17MB + scrcpy 17MB 共 34MB 为体积地板，不可省）。
- 路径一律从锚点动态推导，禁硬编码绝对路径/盘符。
- 安卓侧 pico-network-helper APK 原样保留，桌面端纯 adb 驱动。

---

## [v1.x] - 见原工程
v1.0 及之前的需求变更历史见原 Electron 工程的 `Product-Spec-CHANGELOG.md`。本工程自 v2.0 起独立记录。
