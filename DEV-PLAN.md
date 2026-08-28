# Development Plan — Android Device Monitor (Tauri + Rust 重构版)

> 本文件记录把已上线的 Electron 版工具（原工程 `android-device-monitor`，功能完整含弱网）**1:1 迁移**到 Tauri 2.x + Rust 后端 + 保留 React18 前端的分阶段开发计划。
> 新 session 启动时先读本文件 + `Product-Spec.md` 了解状态再继续。
>
> **核心原则**：原 Electron 版即「标准答案」。每个 Phase 完成后拿原版逐项对拍，做到功能 1:1。重写的是 **Rust 后端 + IPC 层 + 打包热更**；**React 前端组件层整体保留**，主要改 IPC 调用封装与构建工具。
>
> **铁律**（贯穿所有 Phase，Code Review 必查）：
> - 路径全部从运行时锚点动态推导，**禁硬编码绝对路径/盘符**。
> - 可写数据（完整日志/录制/快照/journal）**不落 C 盘 userData**，落 exe 同目录 `device-logs/` 等，用运行时根目录推导。
> - bundled `adb` / `scrcpy` / 助手 APK 作为 Tauri `resources` 随包分发，运行时用 `resource_dir`（生产）+ 开发期相对回退两路解析。
> - 体积目标 312MB → **~45MB**（platform-tools 17MB + scrcpy 17MB = 34MB 是地板，不可省）。

---

## 项目结构（目标）

```
android-device-monitor-rs/
├── src/                          # 前端（React 18 + Tailwind，从原 src/renderer 整体搬入）
│   ├── SimpleApp.tsx             # 根组件（沿用）
│   ├── components/               # 各面板（沿用：PerformancePanel/FilesPanel/MirrorPanel/WeakNetPanel/CaptureChart...；网络模块已删）
│   ├── lib/tauriApi.ts           # 【新】取代 electronApi.ts：对 @tauri-apps/api 的 invoke/listen 封装
│   └── styles/                   # Tailwind 与组件样式（沿用）
├── src-tauri/                    # 后端（Rust）
│   ├── Cargo.toml
│   ├── tauri.conf.json           # 窗口/打包/插件配置
│   ├── build.rs
│   ├── capabilities/             # Tauri 权限能力声明
│   ├── resources/                # platform-tools / scrcpy / 助手 APK（gitignore 大二进制，由脚本准备）
│   └── src/
│       ├── main.rs               # 入口，注册所有 #[tauri::command] 与 event
│       ├── lib.rs
│       ├── runtime_root.rs       # 运行时根目录推导（对应原 runtimeAppRoot.ts）
│       ├── commands/             # IPC 命令层（按模块分文件，对应原 index.ts handlers）
│       ├── adb/                  # adb 引擎（manager/binary/error/runtime_inspector/pico_metrics/screenshot/capture_recorder）
│       ├── performance/          # 采集控制/存储/导出/媒体协议
│       ├── transfer/             # 文件传输 runner + journal
│       ├── weaknet/              # 弱网控制
│       ├── logging/              # 完整日志录制 + logger
│       └── updater/              # 热更集成
├── scripts/
│   ├── prepare-platform-tools.js # 沿用/移植：下载 platform-tools 到 resources
│   ├── prepare-scrcpy.js         # 沿用/移植
│   └── serve-updates.js          # 【从原工程移植】热更服务端，仅适配 Tauri 清单格式
├── vite.config.ts                # 【新】前端构建（取代 webpack）
├── package.json
├── Product-Spec.md / CONTEXT.md / docs/adr/
└── DEV-PLAN.md
```

> **构建工具决策**：前端从 webpack 切到 **Vite**（Tauri 默认且集成最顺，`beforeDevCommand`/`beforeBuildCommand` 直接挂 Vite）。渲染层是纯 React+Tailwind，迁移成本低；收益是 dev 启动快、配置简单。

---

## Phase 0: Tauri 工程骨架 + 前端搬入 + IPC 桥接层

**目标**：跑通空壳——Tauri 窗口用系统 WebView2 打开，原 React 前端整体显示出来，IPC 调用层切到 Tauri（后端命令暂为桩），点不同标签页 UI 正常切换。

**依赖**：无（地基）。

**Task 拆分**：
- **T0.1 Tauri 工程初始化**：`npm create tauri-app` 风格初始化 `src-tauri/`，配置 `tauri.conf.json`（窗口标题/尺寸/最小尺寸对齐原 Electron 窗口），Cargo 依赖加 `tauri 2`、`tokio`、`serde`/`serde_json`、`tauri-plugin-shell`。`build:main`/`dev` 脚本改为 Tauri CLI。
- **T0.2 前端构建切 Vite**：新建 `vite.config.ts`，`@/*` 别名映射到 `src/*`（对齐原 tsconfig），接入 TailwindCSS（沿用原 `tailwind.config`/PostCSS），产物输出目录对接 `tauri.conf.json` 的 `frontendDist`。
- **T0.3 渲染层整体搬入**：把原 `src/renderer` 的 `SimpleApp.tsx`、`components/`、`styles/`、`index.tsx` 复制到新 `src/`，修正导入路径，删除 Electron 专属引用。先让前端能在浏览器/`tauri dev` 里渲染（数据为空）。
- **T0.4 IPC 桥接层 tauriApi.ts**：新建 `src/lib/tauriApi.ts`，逐方法对应原 `electronApi.ts` 的接口签名（保持函数名与入参/返回类型不变），实现改为 `@tauri-apps/api` 的 `invoke`（请求/响应）与 `listen`（事件订阅，返回 unsubscribe）。组件层 import 路径从 `electronApi` 改为 `tauriApi`，**组件内部逻辑不动**。
- **T0.5 后端命令桩 + 事件骨架**：`src-tauri/src/commands/` 按原 IPC 通道清单建对应 `#[tauri::command]` 桩函数（返回空/默认值），`main.rs` 用 `invoke_handler` 全部注册；建立 event 发射工具（对应原 `webContents.send` 的日志批量/采集样本/设备变更等流式通道）。
- **T0.6 共享类型迁移**：原 `src/shared/types/index.ts` 的 IPC payload 类型，前端侧保留 TS 版；Rust 侧用 `serde` 定义对应 struct（`#[serde(rename_all=...)]` 对齐 JSON 字段名），确保前后端序列化一致。
- **T0.7 运行时根目录推导**：`runtime_root.rs` 实现 exe 同目录根推导（对应原 `runtimeAppRoot.ts` 的 `resolveRuntimeAppRoot`），生产/开发两路覆盖。

**关键文件**：
- `src-tauri/tauri.conf.json` — 窗口/插件/前端产物对接
- `src-tauri/Cargo.toml` — Rust 依赖
- `src-tauri/src/main.rs` — 命令与事件注册中枢（对应原 `index.ts`）
- `src-tauri/src/commands/mod.rs` + 各模块桩 — IPC 命令层
- `src-tauri/src/runtime_root.rs` — 运行时根目录推导
- `src/lib/tauriApi.ts` — 【核心】IPC 桥接层（取代 `electronApi.ts`）
- `vite.config.ts` — 前端构建
- `src/SimpleApp.tsx` + `src/components/**` — 搬入的前端

**验收标准**：
- `cargo build` 与前端 `vite build` 均无错误。
- `tauri dev` 能启动窗口，显示原版完整 UI 外观（标签页/布局/样式一致）。
- 各标签页可切换、不报错；所有 IPC 调用走到 Rust 桩函数不崩溃。
- 安装包雏形能打出（体积已应显著小于 Electron，作为体积红利的首个验证点）。

**风险**：WebView2 与 Chromium 渲染差异（个别 CSS/滚动行为）；webpack→Vite 的别名/资源引入差异。早暴露早修。

---

## Phase 1: adb 引擎 + 设备连接

**目标**：Rust 重写 adb 核心，设备连接模块（2.1）全功能可用——USB/WiFi 连接、设备列表、实时连接状态、设备信息、历史设备保存与快速重连/失败改 IP 重连/移除。

**依赖**：Phase 0。

**Task 拆分**：
- **T1.1 bundled adb 定位**：`adb/binary.rs` 对应原 `adbBinary.ts`，用 `resource_dir`（生产）+ 开发相对回退解析 bundled adb 路径；`scripts/prepare-platform-tools.js` 移植，把 platform-tools 下到 `src-tauri/resources/platform-tools/<os>/`，配进 `tauri.conf.json` `resources`。
- **T1.2 adb 命令执行核心**：`adb/manager.rs` 用 `tokio::process::Command` 实现命令执行、shell、超时；流式输出用 `BufReader` 逐行读（为 logcat/采集铺路）。对应原 `ADBManager` 的命令执行骨架。
- **T1.3 错误分类**：`adb/error.rs` 对应原 `adbError.ts`：定义 `AdbCommandError` + `classify_adb_error`，命令层把错误转成结构化 IPC 错误返回（前端拿到 `code/message`）。
- **T1.4 设备监控轮询**：后台 tokio 任务定时 `adb devices -l`，对比上次快照算出连接/断开 diff，经 event 推前端（对应原设备监控 + `webContents.send`）。
- **T1.5 连接命令**：`commands/device.rs` 实现 USB 识别、`adb connect <ip:port>`（WiFi）、`adb disconnect`、设备信息（型号/系统版本/SN，走 `getprop`）。
- **T1.6 历史设备持久化**：仅 WiFi 成功连接写入历史，落盘到运行时根目录下的本地文件（**非 userData**）。实现快速重连、失败就地改 IP 重连（成功覆盖记录）、移除（二次确认在前端）。「仅展示当前未连接的历史设备」「连接中…」状态逻辑前端已有，后端提供数据与命令。
- **T1.7 局域网发现漏扫修复**：保留 `adb mdns services` 三拍流式发现，并行补扫本机主局域网 `/24` 的经典 ADB `5555` 端口；用 ADB `CNXN/AUTH` 握手排除普通端口服务，按 IP 与 mDNS 结果合并且不自动连接设备。前端允许显示无 SN 的主动补扫项，以 IP 兜底命名。
- **T1.8 PICO 大空间快捷关闭**：`commands/device.rs` 增加 `close_pico_large_space`；通过“请求关闭 → 停止 `com.picoxr.blspace` 与 `com.pvr.seethrough.setting` 两层找回界面 → 再次请求关闭”的顺序，中止找回流程并锁定 Guardian 的关闭状态。IPC 桥接补齐对应方法。设备卡片仅在 PICO 设备显示「关闭大空间」，非在线设备禁用，并复用设备控制的忙碌态与错误提示。

**关键文件**：
- `src-tauri/src/adb/binary.rs` — bundled adb 定位
- `src-tauri/src/adb/manager.rs` — 命令执行/shell/流式核心（对应 `ADBManager.ts`）
- `src-tauri/src/adb/error.rs` — 错误分类
- `src-tauri/src/commands/device.rs` — 连接/断开/设备信息命令
- `src-tauri/src/adb/device_monitor.rs` — 轮询 + diff + 事件推送
- `src-tauri/src/adb/history.rs` — 历史设备持久化（运行时根目录）
- `scripts/prepare-platform-tools.js` — 准备 bundled adb

**验收标准**：
- USB 插入/拔出、WiFi connect/disconnect，设备列表与连接状态实时更新，行为与原版一致。
- 设备信息（型号/系统/SN）正确显示。
- 历史设备：WiFi 连过自动入历史、快速重连、失败改 IP 重连、移除均与原版一致；已连接设备不在历史列表重复出现。
- 局域网扫描可发现正常 mDNS 广播设备，也能补回同一 `/24` 内未广播 mDNS、但经典 ADB `5555` 可达的设备；普通 5555 服务不得误报，扫描过程不得自动建立 ADB 连接。
- PICO 在线设备卡片显示「关闭大空间」；正常状态和正在找回大空间时点击，`com.picoxr.blspace`、`com.pvr.seethrough.setting` 两层找回进程均会退出，ToBService 状态切换为 `close`；普通 Android 不显示，失败有明确提示且不会强杀 Guardian/Tracking 等系统服务。
- adb 命令失败时前端收到结构化错误并正确提示。
- 对拍：与原 Electron 版同一台设备操作结果一致。

**风险**：跨平台 adb 进程信号/编码差异；设备监控轮询频率与原版节流口径对齐。

---

## Phase 2: 性能采集（长尾风险最高）

**目标**：应用运行情况模块（2.2）后端全量 Rust 化——已安装应用列表/启动/关闭/卸载/安装（单多设备并行）、CPU/内存/FPS/GPU 指标、Pico 官方指标、持续录制（≤180s 分段+实时落盘）、采集报告时间轴联动、参数过滤打标记、采集回看管理、视频快捷截图、xlsx 导出。

**依赖**：Phase 1（adb 引擎、设备）。

**Task 拆分**：
- **T2.1 应用管理命令**：`commands/apps.rs` 实现 `pm list packages -3`（带搜索）、`monkey` 启动、`am force-stop` 关闭、`adb uninstall` 卸载。
- **T2.2 统一安装面板后端**：多 APK × 多设备并行安装，`tokio` 并发限流（默认 4，可调 2/4/8/不限），单台失败不影响其他、可单独重试，每台设备各自队列/进度经 event 推送；安装模式 `-r`（保留数据）与 `-r -d`（允许降级）。
- **T2.3 性能指标采样**：`adb/runtime_inspector.rs` 对应原 `runtimeInspector.ts`——进程列表、Activity 栈、CPU（`top`）、内存（`dumpsys meminfo`）、FPS（`dumpsys gfxinfo` 等）。**FPS 字段统一口径：`sample.metrics.fps` 同时含 Android 与 Pico 帧率，不按 provider 分流**（把 Pico native fps 写进同一字段）。
- **T2.4 Pico 官方指标**：`adb/pico_metrics.rs` + `pico_metrics_stream.rs` 对应原文件，解析 XR Profiling Toolkit 的 `FPS/MTP/FrmCpu/FrmGpu/ATWGPU/GPU`，仅对已集成的 Pico 应用提供。
- **T2.5 持续录制 + 分段缝合**：`adb/capture_recorder.rs` 对应原 `captureRecorder.ts`/`PerformanceRecordingManager`——设备端 `screenrecord` 录制，单段 ≤180s 自动分段、实时 pull 落盘（运行时根目录，**非 userData**），多段在回看时缝合为连续时间轴；Pico 走录制 provider 分流。软上限提醒（默认 30 分钟或 2GB）。
- **T2.6 采集会话存储**：`performance/capture_store.rs` + `capture_controller.rs` 对应原 `performanceCaptureStore.ts`/`performanceCaptureController.ts`——采集开始即同时启动采样与录制；样本与分段实时落盘（中途崩溃已落盘部分可加载）；每次采集存为一条记录（设备 SN + 时间 + 时长 + 可自定义命名）。会话目录名前缀必须优先使用设备真实 SN（`ro.serialno` / `ro.boot.serialno`），WiFi 设备不得使用 `ip:port`，SN 取不到才回退设备 id。
- **T2.7 采集回看 + 媒体协议**：`performance/media.rs` 对应原 `performanceMedia.ts`——自定义协议把 `performance-recordings/...` 相对路径映射到磁盘文件供前端播放（Tauri 用 `asset:` 协议或自定义 protocol；UI 不暴露宿主绝对路径）。回看加载曲线+视频、删除（二次确认连数据带视频）、视频快捷截图归档到该次采集截图子目录。
- **T2.8 会话导出**：`performance/session_export.rs` 对应原 `performanceSessionExport.ts`，用 **rust_xlsxwriter** 导出 xlsx 工作簿（统一取 `metrics.fps`）。
- **T2.9 时间轴联动 + 过滤打标记（后端数据支撑）**：报告曲线多选/隔离逻辑前端已有；后端提供采样数据与按指标阈值（`>`/`=`/`<`，多条件、各自按指标标记不做 AND 交集）所需数据接口。
- **T2.10 采集录制音频（可选，Spec v2.2 增补；P3 之后做）**：让采集录像可选带设备声音，回看可听。
  - 开关：采集设置面板加「录制设备声音」开关（默认关），不支持设备（Android<13）置灰并提示「该设备不支持录音」。`commands/performance.rs` 的 `start_capture_session` 增 `recordAudio: bool` 入参；`electronApiShim` 透传。
  - 后端选路：`performance/capture_controller.rs` 采集启动时按 `recordAudio` 开关 + 设备能力选录制后端——查 API level（复用 P3 `adb/scrcpy.rs` 的 `build_audio_args` dup/output 口径），满足「Android 13+ 且音频可捕获」→ scrcpy `--record`（视频+音频录进同一 MP4，`--audio-dup` 设备与电脑同时出声、设备不静音）；否则降级回 `screenrecord` 无声路径兜底。Pico 已真机验证可行（A13+），同走含音路径。
  - 单段录制：`adb/capture_segment.rs` 新增 scrcpy `--record --time-limit=180` 单段 spawn 路径，与现有 `screenrecord` 单段并存（按 provider/录音开关分流，统一返回 `SpawnedSegment` 供多段编排复用）；scrcpy 到 `--time-limit` 会整进程停止（不像 screenrecord 自动续），故 `adb/capture_recorder.rs` 多段循环对该路径走「当前段结束 → spawn 下一段」，接缝处音频可能短暂断续，留真机调。
  - 存储与回放：`performance/capture_store.rs` 会话 manifest 落 `audioRecorded: bool`；`shared/types` 的 `PerformanceCaptureSession` 加 `audioRecorded?: boolean`；回看 `CaptureReport` 的 `<video>` 加音量/静音控制（含音轨 MP4 直接播放，默认不静音）。
  - 复用 P3 已落地的 `scrcpy::resolve_scrcpy_path` 与 `build_audio_args`，不重复造。

**关键文件**：
- `src-tauri/src/commands/apps.rs` — 应用列表/启停/卸载/安装
- `src-tauri/src/adb/runtime_inspector.rs` — 进程/Activity/性能指标（FPS 统一口径）
- `src-tauri/src/adb/pico_metrics.rs` + `pico_metrics_stream.rs` — Pico 官方指标
- `src-tauri/src/adb/capture_recorder.rs` — screenrecord 分段录制 + 实时落盘
- `src-tauri/src/performance/capture_controller.rs` + `capture_store.rs` — 采集控制与存储
- `src-tauri/src/performance/media.rs` — 录制媒体协议（不暴露绝对路径）
- `src-tauri/src/performance/session_export.rs` — xlsx 导出（rust_xlsxwriter）
- `src-tauri/src/commands/performance.rs` — 性能模块命令汇总（T2.10：start_capture_session 增 recordAudio）
- `src-tauri/src/adb/scrcpy.rs` — 【T2.10 复用 P3】scrcpy 定位 + build_audio_args 音频参数
- `src-tauri/src/adb/capture_segment.rs` — 【T2.10】scrcpy `--record` 单段路径（与 screenrecord 并存）
- `src/renderer/components/CaptureReport.tsx` — 【T2.10】回看 video 加音量/静音控制
- `src/renderer/components/PerformancePanel.tsx`（采集设置）— 【T2.10】「录制设备声音」开关

**验收标准**：
- 应用列表/启停/卸载、多设备并行安装（含限流、单独重试、各自进度）与原版一致。
- CPU/内存/FPS/GPU 实时曲线刷新；Pico 应用显示官方指标。
- 持续采集：开始即录制、曲线刷新、停止后报告内可播放；分段缝合为连续时间轴对用户透明；中途强杀后已落盘部分可加载。
- 时间轴拖动曲线游标与视频同步；过滤打标记按指标着色/显隐、单击标记跳转并暂停。
- 回看列表加载/删除/命名、视频快捷截图、xlsx 导出均正确；采集会话目录与导出 zip 默认文件名均优先使用设备真实 SN，不使用 WiFi `ip:port`。
- 对拍：同一设备同一采集，曲线数值、视频时长、导出内容与原版一致。
- **（T2.10）**「录制设备声音」开关默认关；开启且设备支持（A13+）时采集录像含音轨，回看可听到设备声音且设备同时出声不静音；Android<13/不支持设备开关置灰、录制走无声路径不报错；`audioRecorded` 字段正确落 manifest 并驱动回看音量控件；含音分段接缝处音频无明显异常（真机验收）。Pico 真机验证含音录制可用。

**风险（最高）**：`screenrecord` 分段缝合的时间轴对齐；各机型/Pico 的 `dumpsys` 输出解析边角 case；媒体协议在 WebView2 下的播放兼容。预留充分对拍时间，复用原工程踩坑结论（FPS 统一口径、内存掉 0 等历史问题）。
**风险（T2.10）**：scrcpy `--record` 分段自停自起的接缝处音频断续（需真机调，最坏接受接缝处极短静音）；含音录制 + 音频编码对被测应用性能数据的额外开销（监控分辨率/码率，必要时提示录音会增加开销）；scrcpy `--record` 中途异常退出的落盘完整性（复用探测 + 实时落盘机制兜底）。

---

## Phase 3: 截图 + 投屏镜像

**目标**：实时预览截图 + 投屏镜像与操控模块（2.5）可用——一键投屏调起 scrcpy 窗口、触屏/文字/物理键操控、Pico 单眼裁切、启动参数配置、声音去向实时切换、快捷键速查。

**依赖**：Phase 1（adb）、Phase 2（性能模块内的实时预览）。

**Task 拆分**：
- **T3.1 截图快路 + 回退**：`adb/screenshot.rs` 对应原 `screenshotCapture.ts`——raw framebuffer 快路；**失败回退 `screencap` PNG 慢路兜底**（framebuffer 协议迁移是风险点，先保证 PNG 路可用，快路作为优化）。供性能模块「实时预览设备画面」用。
- **T3.2 scrcpy 资源准备**：`scripts/prepare-scrcpy.js` 移植，scrcpy 二进制下到 `src-tauri/resources/scrcpy/<os>/`，配进 `resources`；运行时用 `resource_dir` 解析。
- **T3.3 scrcpy 进程管理**：`commands/mirror.rs` 用 Rust 起 scrcpy 子进程，参数拼装（目标 SN、码率、分辨率上限、`--crop` 单眼裁切），生命周期管理（启动/停止/异常退出回收，对应原 MirrorPanel 后端）。
- **T3.4 Pico 单眼 + 参数配置**：Pico/XR 启动时 `--crop` 裁单眼，操控按单眼坐标映射；前端参数配置面板已有，后端接收并拼装。
- **T3.5 声音去向实时切换**：主视频窗口恒 `--no-audio`；音频用独立「纯音频」scrcpy 进程（`--no-video --no-control --no-window`）承载；勾选优先 `--audio-source=playback --audio-dup`（Android 13+ 两边出声），低于 13 降级为 `output` 源（设备静音）；取消即停该进程。切换不影响主画面。

**关键文件**：
- `src-tauri/src/adb/screenshot.rs` — framebuffer 快路 + screencap 回退
- `src-tauri/src/commands/mirror.rs` — scrcpy 进程管理/参数/生命周期
- `src-tauri/src/adb/scrcpy.rs` — scrcpy 二进制定位与参数构建
- `scripts/prepare-scrcpy.js` — 准备 scrcpy 资源

**验收标准**：
- 一键投屏调起 scrcpy 窗口，触屏/文字/物理键操控正常；关闭窗口即停止；进程无残留。
- Pico 单眼裁切正确，单眼坐标操控可用。
- 启动参数（码率/分辨率/裁切）生效；快捷键速查表显示。
- 声音去向实时切换：默认设备出声、勾选两边出声（Android 13+）/低版本降级、取消回到设备，主画面不闪。
- 实时预览截图在性能模块正常显示（PNG 路至少可用）。
- 对拍：与原版投屏行为一致。

**风险**：framebuffer 协议 Rust 实现复杂，可能长期停在 PNG 慢路；scrcpy 多进程（视频+纯音频）生命周期回收。

---

## Phase 4: 文件管理与传输 + 完整日志录制

**目标**：文件管理与传输模块（2.6）全功能——设备文件浏览/排序、批量上传下载（实时进度）、新建/删除文件夹、批量删除、关界面续显进度、传输中断恢复；日志抓取模块（2.3）后端；完整日志落 exe 同目录。

**依赖**：Phase 1（adb）。

**Task 拆分**：
- **T4.1 设备文件浏览**：`commands/files.rs` 列目录（`adb shell ls`/`stat`），逐级进入，名称/大小/类型，按 名称/大小/修改时间 排序；**UI 不暴露宿主绝对路径**。
- **T4.2 批量传输 runner**：`transfer/runner.rs` 对应原 `transferRunner.ts`——`adb push/pull` 批量，实时进度（轮询设备端/本地已写字节算百分比）经 event 推送；临时名 + 原子落地（写 `.part`/临时目录，校验大小后 rename）。
- **T4.3 传输日志持久化**：`transfer/journal.rs` 对应原 `transferJournal.ts`——任务清单落盘 `transfer-journal.json`（**运行时根目录，非 userData**），记录 `{方向,源,目标,文件名,大小,deviceId,状态}`，状态 `pending/transferring/done/failed` 流转，每文件传完即更新。
- **T4.4 中断恢复**：文件级续传（已 done 跳过，被打断的连同剩余重传）；恢复触发 = 进入该设备文件管理时读 journal 提示「N 个未完成，继续/丢弃」；恢复绑定原 deviceId；仅崩溃/被杀残留进恢复队列（主动取消/报错失败不进，了结即清理）；`before-quit`/退出钩子 flush journal + 向 adb 子进程发终止信号兜底。
- **T4.5 新建/删除/批量删除**：新建文件夹、删除文件/文件夹（二次确认）、批量删除（确认态→确认 N 项→执行→汇总成功/失败数）。
- **T4.6 关界面续显**：传输在后端持续跑，前端重开订阅回正在进行的进度（Tauri event + 后端状态查询）。
- **T4.7 Logcat 抓取 + 解析**：`commands/logcat.rs` 流式 `adb logcat -v long`，按「[头]+消息行+空行」条目边界切分，解析 PID/TID/TAG/级别；多行合并（异常堆栈成一条 message 多行）；按整条匹配过滤/搜索。**日志批量推送**（对应原 LOG_BATCH：≤200/批、250ms、队列上限 1000）经 event 发前端。
- **T4.8 日志过滤/搜索/导出**：包名「相关日志」口径（全量抓取后保留应用自身 + 系统侧提到该包名的行，关联过滤前置于限流）；级别仅作显示筛选（抓取恒 `*:V`）；Crash/ANR、TAG 过滤、关键词搜索、搜索历史（去重/最近优先/上限 20/持久化）；日志导出文件。
- **T4.9 完整日志录制**：`logging/full_log_recorder.rs` 对应原 `fullLogRecorder.ts`——完整日志落 **exe 同目录 `device-logs/`**（铁律，运行时锚点推导）；`logging/logger.rs` 对应原 `logger.ts`。
- **T4.10 解压依赖替换**：原 adm-zip 用途用 Rust `zip` crate 替代。

**关键文件**：
- `src-tauri/src/commands/files.rs` — 文件浏览/排序/增删
- `src-tauri/src/transfer/runner.rs` — 批量传输 + 进度 + 原子落地
- `src-tauri/src/transfer/journal.rs` — 传输日志持久化 + 恢复
- `src-tauri/src/commands/logcat.rs` — logcat 流式抓取/解析/批量推送
- `src-tauri/src/logging/full_log_recorder.rs` — 完整日志落 device-logs/
- `src-tauri/src/logging/logger.rs` — 内部日志

**验收标准**：
- 文件浏览/排序、批量上传下载（实时进度）、新建/删除/批量删除均与原版一致，UI 无宿主绝对路径。
- 传输中强杀进程后重启，进入该设备文件管理提示未完成任务，文件级续传成功；半截文件带临时标记可辨识；主动取消/失败任务不进恢复队列。
- 关界面传输继续、重开续显进度。
- Logcat 全局/相关日志/Crash-ANR/TAG/级别/搜索/搜索历史/导出与原版一致；多行堆栈整条保留；批量推送不卡 UI。
- 完整日志正确落到 exe 同目录 `device-logs/`，不进 C 盘。
- 对拍：传输中断恢复、日志条目切分与原版一致。

**风险**：传输进度百分比口径（轮询字节）与原版对齐；logcat 编码/条目边界跨设备差异。

---

## Phase 5: 弱网整形桌面集成

**目标**：弱网控制模块（2.7）桌面侧全功能——安装助手、选目标应用、参数设置（预设档位+手动）、启停、VPN 授权引导、运行状态、参数热更新、实时流量曲线 + CSV 导出。安卓助手 APK 原样不动。

**依赖**：Phase 1（adb）、Phase 2（复用已安装应用列表与安装能力）。

**Task 拆分**：
- **T5.1 助手 APK 随包 + 安装**：把预编译助手 APK（arm64-v8a）放 `src-tauri/resources/`，运行时 `resource_dir` 解析；复用 T2.2 安装能力一键 `adb install`，已装跳过、支持重装更新。
- **T5.2 选目标应用**：复用 T2.1 已安装应用列表选目标包名。
- **T5.3 弱网参数 + 预设档位**：延迟/抖动/丢包/上下行限速；预设档位（弱 WiFi/3G/高丢包/高延迟）一键填入 + 手动微调（前端面板已有，后端接收）。
- **T5.4 启停命令**：`commands/weaknet.rs` + `weaknet/control.rs`——`am start-foreground-service` 下发 `START`/`STOP` 到助手 `WeakNetworkControlService`，extras：`packageName/latencyMs/jitterMs/packetLossPercent/uploadKbps/downloadKbps`。
- **T5.5 VPN 授权引导 + 状态**：检测未授权/未就绪时引导（一键拉起助手 MainActivity 触发授权弹窗）；通过 `dumpsys`/VPN 隧道地址（`10.88.0.2`）实查状态，显示「未安装/已就绪/待授权/运行中/已停止/异常」。
- **T5.6 参数热更新**：改参数后先 STOP 再 START 重新下发，无需卸载重装。
- **T5.7 实时流量曲线 + CSV**：助手埋点上报真实丢包/RTT/流量，桌面读取展示实时流量曲线，支持导出 CSV（对应原 WeakNetPanel 能力）。

**关键文件**：
- `src-tauri/src/commands/weaknet.rs` — 弱网命令（安装/选包/启停/状态/热更）
- `src-tauri/src/weaknet/control.rs` — `am` 下发 + `dumpsys` 查状态 + 流量读取
- `src-tauri/resources/pico-network-helper.apk` — 助手 APK（随包）

**验收标准**：
- 助手安装/重装、选目标应用、预设档位+手动参数、启停、VPN 授权引导、状态显示、参数热更新、实时流量曲线、CSV 导出均与原版一致。
- 弱网只作用于目标 App，不影响整机网络与 ADB/WiFi 链路。
- 对拍：同参数下目标 App 弱网表现与原版一致。

**风险**：`dumpsys`/隧道地址查状态的口径对齐；助手埋点上报数据格式解析。

---

## Phase 6: 打包 + 热更重建 + 体积验证

**目标**：出 Windows 安装包（可选目录、不默认 C 盘），热更换 tauri-plugin-updater（签名），服务端沿用并适配 Tauri 清单格式，验证体积达标 ~45MB。

**依赖**：Phase 0–5（功能完整才好打包验证）。

**Task 拆分**：
- **T6.1 Tauri 打包配置**：`tauri.conf.json` bundle 配 NSIS，安装模式可选目录（对应原 `oneClick:false`，**不默认 C 盘**）；`resources` 含 platform-tools/scrcpy/助手 APK；图标/产品名/版本对齐。
- **T6.2 热更客户端集成**：接入 `tauri-plugin-updater 2.x`，生成更新签名密钥对，客户端内置公钥校验；更新改手动触发、静默装、应用内更新日志（对应原 autoUpdate.ts 行为）。更新源默认沿用内网（可被运行时配置覆盖，路径锚点推导）。
- **T6.3 服务端适配**：`scripts/serve-updates.js` 从原工程移植，**限流/Range/上报等加固保留**，仅把更新清单/包格式适配成 Tauri updater 所需（`latest.json` 签名清单 + 平台包）。打包脚本（对应原 `make-update-package.bat`/`gen-release-notes.js`）适配 Tauri 产物与版本自增。
- **T6.4 体积验证**：打出安装包，量真实体积，核对 ~45MB 目标（platform-tools 17M + scrcpy 17M + Rust 二进制 + 前端 + WebView 引导）。若超标，排查冗余资源（如 platform-tools 只留 adb/fastboot、scrcpy 去重 adb）。
- **T6.5 WebView2 引导**：打包附带 WebView2 Bootstrapper（下载式/嵌入式），覆盖缺失 WebView2 的老旧 Win10。

**关键文件**：
- `src-tauri/tauri.conf.json` — bundle/updater 配置
- `src-tauri/src/updater/mod.rs` — 热更集成（手动触发/静默装/更新日志）
- `scripts/serve-updates.js` — 热更服务端（移植+适配）
- `scripts/make-update-package.*` — 更新包打包 + 版本自增 + release notes

**验收标准**：
- 安装包能装、可选安装目录、不默认 C 盘；装完能启动（WebView2 缺失机器经 Bootstrapper 也能起）。
- 热更：客户端检测到新版、签名校验通过、静默装、应用内显示更新日志；服务端正常分发。
- **体积达标 ~45MB**（核心验收点：体积红利兑现）。
- 对拍：安装/更新流程体验与原版一致或更优。

**风险**：electron-updater 与 tauri-plugin-updater 包格式/签名不通用——老用户无法平滑跨产品升级，必要时一次性手动换装；体积若超标需裁剪资源。

---

## Phase 7: 真机全功能回归

**目标**：拿原 Electron 版当标准答案，按 Spec 第 2 章逐模块对拍，确认功能 1:1 与非功能指标达标。

**依赖**：Phase 0–6 全部完成。

**Task 拆分**：
- **T7.1 逐模块对拍**：设备连接（含历史/重连）、应用管理（含多设备并行安装）、性能采集（含 Pico 指标/录制分段/时间轴/打标记/回看/导出）、日志（含相关日志/多行/搜索历史）、投屏（含 Pico 单眼/声音切换）、文件传输（含中断恢复）、弱网（含授权/状态/流量曲线）。普通 Android 手机 + Pico 各跑一遍。
- **T7.2 非功能指标**：日志显示延迟 <100ms、多设备并发、内存占用、采集+录制同时主界面可交互、时间轴跟手、启动体积达标。
- **T7.3 缺陷修复回环**：对拍发现的差异走 bug-fixer 修复，`fix:` commit，重新对拍。
- **T7.4 路径与落盘审计**：全仓库扫硬编码盘符（应为 0）、确认所有可写数据落 exe 同目录而非 C 盘 userData。

**关键文件**：
- 全工程（回归测试，无新增核心文件；可补 `tests/` 结构性断言）

**验收标准**：
- Spec 第 2 章每个 P0/P1 功能点与原版行为一致（逐项打勾）。
- 非功能需求（6.1）达标。
- 无硬编码盘符；可写数据不落 C 盘。
- 体积、内存、启动相比 Electron 版有明确改善且功能无回退。

**风险**：长尾差异集中暴露；Pico 真机相关 case 需设备在手。

---

## 技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 应用框架 | Tauri | 2.x | 系统 WebView2，体积压缩关键 |
| 后端语言 | Rust | edition 2021 | 重写原主进程全部逻辑 |
| 异步运行时 | tokio | 1.x | 设备轮询、子进程流式 IO、并发采集/安装 |
| 前端 | React + TypeScript | 18 / ^5 | 渲染层整体保留，仅改 IPC 层 |
| 样式 | TailwindCSS | ^3 | 沿用原设计系统 |
| 图标 | lucide-react | ^0.290 | 沿用 |
| 前端构建 | Vite | 5.x | 取代 webpack，Tauri 集成顺 |
| 子进程/Shell | tauri-plugin-shell | 2.x | 调 adb/scrcpy |
| 自动更新 | tauri-plugin-updater | 2.x | 签名校验，取代 electron-updater |
| xlsx 导出 | rust_xlsxwriter | 0.92.x | 采集会话导出（只写，够用） |
| 解压 | zip (crate) | latest | 取代 adm-zip |
| 序列化 | serde / serde_json | 1.x | 前后端 IPC payload 一致 |

## 关键数据/落盘（均在运行时根目录，非 C 盘 userData）

| 数据 | 所属 Phase | 位置 | 用途 |
|------|-----------|------|------|
| 历史设备记录 | Phase 1 | 运行时根目录 | WiFi 设备快速重连 |
| 采集会话（样本+分段视频+截图） | Phase 2 | 运行时根目录 `performance-recordings/` | 持续采集回看 |
| 传输 journal | Phase 4 | 运行时根目录 `transfer-journal.json` | 传输中断恢复唯一依据 |
| 完整日志 | Phase 4 | **exe 同目录 `device-logs/`** | 完整日志落盘（铁律） |
| 搜索历史 | Phase 4 | 运行时根目录 | 日志搜索联想 |
| 更新配置 | Phase 6 | 运行时根目录 | 覆盖默认更新源 |

## 开发规则

- 每完成一个 Phase 执行四步走：Code Review → 测试完整性 → 编译验证 → 功能测试（含拿原 Electron 版对拍）。
- 四步走全部通过后才能 commit。
- Commit message 格式：`phase-N: 简要描述`（修复用 `fix:`）。
- 包管理器：npm（沿用原工程习惯）；Rust 侧 cargo。
- 在 `android-device-monitor-rs` 仓库 `rust` 分支开发；与原工程物理隔离，不碰 `G:\Androidtool`。
- 路径铁律、不落 C 盘、bundled 二进制资源解析三条贯穿每个 Phase，Code Review 必查。
