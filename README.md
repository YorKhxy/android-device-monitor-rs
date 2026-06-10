# Android Device Monitor （Tauri + Rust 版）

安卓 / Pico 设备监控桌面工具的 **Tauri + Rust 重构版**。独立项目。

## 这是什么 / 与原工程的关系

- 本仓库是一次**重构**：把原 Electron 版工具（另一个独立工程 `android-device-monitor`，TypeScript 主进程 + React 渲染层）迁移到 **Tauri 2 + Rust 后端 + 保留 React 前端**。
- 重构动机：**体积**。原 Electron 版安装目录约 312MB；本版目标 ~45MB（已验证 Tauri 壳 exe 8.7M / NSIS 安装包 1.9M，platform-tools + scrcpy 共 34MB 是不可省的体积地板）。
- **与原工程的边界**：原 Electron 版仅作为**功能 1:1 对照基准**（"标准答案"），本仓库**完全独立**——独立 git 仓库、独立依赖、独立打包与热更。除了 `Product-Spec.md` / `CONTEXT.md` / `docs/adr/`（从原工程复制来的功能与领域基准）外，不共享代码。功能行为对齐原版，工程实现全部重写。

## 技术栈

| 层 | 技术 |
|----|------|
| 应用框架 | Tauri 2.x（系统 WebView2，非捆绑 Chromium） |
| 后端 | Rust (edition 2021) + tokio |
| 前端 | React 18 + TypeScript + TailwindCSS（从原 renderer 整体搬入，仅改 IPC 层） |
| 构建 | Vite 7（前端） + Cargo（后端） |
| IPC | `src/renderer/lib/electronApiShim.ts` 注入 `window.electronAPI`，用 `@tauri-apps/api` 的 invoke/listen 实现；命令名 snake_case，Rust `#[tauri::command(rename_all="camelCase")]` 接收，统一返回 `ElectronResult` JSON |

## 进度

- ✅ **P0 工程骨架**：Tauri+WebView2、前端搬入、IPC 桥接 shim、命令桩、运行时根目录推导。
- ✅ **P1 adb 引擎 + 设备连接**：Rust 重写 ADBManager 核心（`src-tauri/src/adb/`），设备列表/信息/连接/断开/状态/监控轮询，真机验证通过。
- ✅ 移除整个「网络」模块（应用网络请求抓取），标签由 6→5（设备/日志/性能/投屏/弱网）。
- ✅ **P2 性能采集（应用运行情况模块）**：9 个 Task 全部完成（应用管理 T2.1 / 性能采样 T2.3 / Pico 官方指标 T2.4 / APK 安装 T2.2 / 持续分段录制 T2.5 / 采集会话存储+控制 T2.6 / 回看媒体协议 T2.7 / xlsx+zip 导出导入 T2.8 / 时间轴数据支撑 T2.9）。每 Task 过 code-reviewer 两阶段审查，`cargo test` 7/7。
  - **真机验收（Windows + Pico/Android）已过大半**：设备连接（USB+WiFi）、电量、Pico 官方指标（FPS/MTP/FrmCpu/FrmGpu/ATWGPU/GPU）、性能曲线、采集报告、回看视频播放、导出时间均正常。
  - **真机修过 2 个坑**：① 回看视频黑屏 → 前端媒体 URL 改用 `convertFileSrc`（Windows WebView2 自定义协议须 `http://<scheme>.localhost/`，见 feedback）；② 导出 xlsx 时间改用系统本地时区（chrono Local）。
  - **待补真机验收**：应用启停/卸载/安装、采集开始→停止全流程录制、zip 导入导出、视频快捷截图、时间轴过滤打标记。
  - **T2.10 采集录制设备声音（代码完成，待真机验收）**：采集设置加「录制设备声音」开关（默认关，A13- 置灰）；开启且设备 A13+ 时录制后端从设备端 `screenrecord`（无声）切到 PC 端 scrcpy `--record`（视频+音频同一 MP4，`--audio-dup` 设备与电脑同时出声不静音），否则降级回无声 screenrecord 兜底；回看 `<video>` 加音量/静音控件（`audioRecorded` 驱动显隐）。4 个 Task 各过两阶段 review，`cargo test` 16/16 + build 通过。**关键坑**：scrcpy 在 Windows 强杀进程会致 mp4 损坏（moov 缺失），故停采集走「杀设备端 scrcpy-server 让 PC client 优雅 finalize」+ 15s 超时强杀兜底；**含音分段接缝音频可能断续、优雅停 finalize 完整性、Pico 含音录制均待真机验收**。
- ✅ **P3 投屏镜像（真机验收通过）**：T3.2 scrcpy 资源准备+二进制定位 / T3.3 进程管理+基础投屏 start/stop / T3.4 Pico 单眼裁切 / T3.5 声音去向实时切换。每 Task 过 code-reviewer 两阶段审查，`cargo test` 15/15，`cargo build` + 前端 `npm run build` 通过。**真机验证：投屏调起+操控正常，声音「设备 + 电脑同时出声」（`--audio-dup`，Android 13+）验证可行。**
  - **T3.1 设备截图（framebuffer 快路/screencap 回退）已剔除**：当前前端无消费方（投屏改为调起独立 scrcpy 窗口看画面），如后续要应用内实时预览再回补 `adb/screenshot.rs`。
  - **关键实现**：scrcpy v3.3.3 经 `scripts/prepare-scrcpy.mjs` 下到 `src-tauri/scrcpy/win/`（三环节：prepare + `tauri.conf.json` resources `scrcpy/**/*` + 运行时 `resolve_scrcpy_path`）；视频主进程恒 `--no-audio`，声音由独立纯音频进程承载（A13+ `--audio-dup` 两边出声 / 低版本 `--audio-source=output` 设备静音）；Pico 查 `wm size` 裁左眼 `--crop 宽/2:高:0:0`；scrcpy 经 `ADB` 环境变量复用 bundled adb 避免 server 版本互踢；进程注册表 generation 防快速重启竞态，退出/关窗自动广播 `mirror_status`。
- ✅ **P4 文件管理与传输 + 日志（完成，已推 origin/dev）**：5 个实现 Task 全做完，后端从桩逐个落地。前后端 15 个 P4 命令 1:1 对齐、0 残留桩；`cargo test 37/37`、`tsc --noEmit` 0 错。四步走过（Code Review×3 两阶段全 PASS / 测试完整 / 编译 0 警告 / 待真机功能验收）。
  - ✅ **T4-1 文件浏览+增删**（`commands/files.rs`）：list_device_files（ls -al 日期锚定解析）/delete/create/select_upload。commit `c4f32d3`，cargo test 通过，两阶段 review 过。
  - ✅ **T4-2 批量传输 runner+进度**（`transfer/runner.rs` + `commands/transfer.rs`）：push/pull 批量、push_progress/pull_progress、`.part` 原子落地、shell_quote 转义、pull 覆盖式落地。commit `ffc026d`，cargo test 21/21，两阶段 review 过。
  - ✅ **T4-3 传输 journal + 中断恢复 + 关界面续显**（`transfer/journal.rs`）：journal 落运行时根目录 transfer-journal.json（原子写 .tmp+rename），状态 pending/transferring/done/failed 流转；push/pull 前 begin_batch、后 remove_batch（了结即清理）；resume_transfers 文件级续传(已 done 跳过)、discard_transfers 清 .part+移 journal、get_resume_batches 汇总残留；仅崩溃/被杀残留进恢复队列；关界面续显由前端 fileTransferManager 单例承担。commit `3c08eb1`，cargo test 24/24，两阶段 review 过。真机待验：强杀后续传 / 丢弃清残留。
  - ✅ **T4-4 Logcat 流式抓取+解析+批量推送**（`adb/logcat_parser.rs` + `adb/logcat_stream.rs` + `commands/logcat.rs`）：流式 adb logcat -v long *:V、[头]起空行止切分+多行堆栈合并(LogEntry)、log_batch 批量推送(≤200/批 250ms 队列1000)、相关日志口径(pidof 周期解析 pid 命中 OR 文本提包名，前置限流)；恒 *:V minLevel 前端显示筛选；复用 pico_metrics_stream 常驻流范式 + kill_on_drop。commit `c042a26`，cargo test 35/35，两阶段 review 全 PASS。真机待验：多行堆栈整条 / 相关日志降噪 / 高频不卡 UI。
  - ✅ **T4-5 日志导出+完整日志录制**（`logging/full_log_recorder.rs` + `commands/logcat.rs`）：完整日志开流起每条原始行(过滤前/全等级)tee 落 exe 同目录 `device-logs/{sanitized}.log`（`runtime_root::device_logs_dir`，铁律），truncate-on-begin=「从监控第一行」，id 比对防 stop/restart 竞态；export_logs(格式化前端条目)/export_full_logs(另存落盘原始)/export_full_logs_by_package(重解析+pidof+相关过滤切子集，多行堆栈整条保留)。commit `c18f36a`，cargo test 37/37，两阶段 review 全 PASS。真机待验：完整日志落盘不进 C 盘 / 三导出文件 / 按包子集。
  - 📌 P4 真机验收清单：① 文件 强杀后续传 / 丢弃清残留 / 关界面续显；② Logcat 多行堆栈整条 / 相关日志降噪 / 高频不卡 UI；③ 完整日志落 device-logs 不进 C 盘 / export_logs / export_full_logs / 按包导出子集。
- ⏭ **P5 弱网整形桌面集成（跳过，后补）**：用户决定先做 P6，P5 暂缓。需用户提供预编译助手 APK `pico-network-helper.apk` 放 `src-tauri/resources/`。详见 DEV-PLAN.md Phase 5（T5.1–T5.7）。
- ✅ **P6 打包 + 热更 + 体积验证（完成，已推 origin/dev）**：commit `8ed957c`。
  - **打包**：NSIS `installMode=both`（可选目录/不默认 C 盘）、`webviewInstallMode=embedBootstrapper`（兜老 Win10）。下载包 **17.5MB**、装后 **53.4MB**，静默安装冒烟过、实测 adb/scrcpy 资源齐全——远优于 ~45MB 目标（体积红利兑现）。
  - **热更**：`tauri-plugin-updater 2` + `updater/mod.rs`（check/download/install/status/notes，手动触发、静默装、进度事件）；minisign 签名（**私钥 `src-tauri/.tauri-keys/adm-updater.key` 已 gitignore，密码 `admUpd2026`；私钥+密码是签名机密，丢了就没法签更新**）；`createUpdaterArtifacts` 产 `setup.exe`+`.sig`。
  - **服务端**：`scripts/serve-updates.mjs`（latest.json+包分发、Range、限流、访问日志、路径穿越防护）+ `scripts/make-update-package.mjs`（签名清单生成）；`npm run serve:updates` / `npm run make:update`。
  - 📌 待验：热更端到端真机（装 0.1.0 → 抬版本打 0.2.0 → 起 serve:updates → 点检查更新 → 签名校验/静默装/更新日志）。endpoint 现为 `127.0.0.1:8788` 占位，部署改内网。P5 助手 APK 待补。
- ⬜ **P7**：真机全功能回归。**详见 [`DEV-PLAN.md`](./DEV-PLAN.md)**。
  - 📌 P6 打包前：收紧 CSP 时需把 `http://adm-media.localhost` 加进 `media-src`（回看视频协议）。

## ⏳ 待真机验收（回头补，验完逐条划掉）

**T2.10 采集录制设备声音**（坑最深，优先验）
- [ ] A13+ 采集勾选录音 → 回看有声音、音量/静音控件可用
- [ ] 停采集后视频**不损坏**能正常播放（验「杀设备端 scrcpy-server 让 PC client 优雅 finalize」是否管用；若损坏 → 退方案 B 短分段容损 + UI 提示）
- [ ] 录超 180s（跨分段）回看在接缝处音频无明显断续/杂音
- [ ] Pico 含音录制（`--record` 路径）可用
- [ ] Android<13 设备开关置灰+「不支持需 A13+」提示；不开录音时 screenrecord 路径与改前一致（零回归）

**P3 投屏**剩余项
- [ ] 关窗即停无残留、分辨率/码率生效、Pico 单眼裁切位置、启动失败中文提示

**P2 采集**待补项
- [ ] 应用启停/卸载/安装、采集开始→停止全流程录制、zip 导入导出、视频快捷截图、时间轴过滤打标记

## 开发

前置：Node、Rust 工具链（rustup，MSVC）、Windows WebView2（Win11 预装）。

```bash
npm install
npm run tauri dev      # 开发（启动窗口）
npm run tauri build    # 打包 NSIS 安装包
```

> `npm run tauri` 经 `scripts/tauri.mjs` 包装，会自动把 cargo（`~/.cargo/bin` 或 `CARGO_HOME`）注入本进程 PATH——任何终端直接可跑，无需先改 PATH 或重开终端。
>
> bundled `adb` / `scrcpy` 由 `src-tauri/platform-tools`、`src-tauri/scrcpy` 提供（不入库，由 prepare 脚本准备），运行时经 `resource_dir`（生产）+ 开发相对回退解析。

## 铁律（贯穿所有 Phase）

- 路径一律从锚点动态推导，**禁硬编码绝对路径/盘符**。
- 可写数据（完整日志 `device-logs/`、录制、传输 journal）落 **exe 同目录**，**绝不进 C 盘 userData**。
- bundled 二进制走 `resource_dir` 解析，不写死位置。

## 文档导航

- [`Product-Spec.md`](./Product-Spec.md) — 产品需求（功能基准，含已做的 Tauri 技术方案）
- [`DEV-PLAN.md`](./DEV-PLAN.md) — 分阶段开发计划 P0–P7
- [`Product-Spec-CHANGELOG.md`](./Product-Spec-CHANGELOG.md) — 需求变更记录
- [`CONTEXT.md`](./CONTEXT.md) — 领域术语 / Pico 语义（动性能/Pico 前必读）
- [`docs/adr/`](./docs/adr/) — 架构决策记录（Pico 性能 provider、弱网 helper、tun2socks 内核）
