# 变更记录

## [v2.16] - 2026-08-28
### 修正
- **找回大空间期间关闭不生效**：原实现仅调用 ToBService 的 `switch_ls=off`。固件状态虽然已变为关闭，但找回流程包含 `com.picoxr.blspace` 和 `com.pvr.seethrough.setting` 两层界面，用户侧仍会残留找回页面。现在先请求关闭，再停止两层找回界面，最后再次请求关闭以消除界面切换竞态；已在 A9210 实机验证最终状态为 `close`、两层找回进程退出，Guardian/Tracking 服务保持运行。

---

## [v2.15] - 2026-08-06
### 新增
- **设备卡片增加「关闭大空间」快捷按钮**：仅 PICO 设备显示，操作无二次确认，执行中进入设备操作忙碌态，失败时显示明确错误。普通 Android 设备不显示，非在线设备不可执行。

### 修正
- **局域网扫描补回未广播 mDNS 的 ADB 设备**：保留现有 `adb mdns services` 三拍流式发现，同时并行扫描本机主局域网 `/24` 的经典 ADB `5555` 端口；仅将返回 ADB `CNXN/AUTH` 协议头的端点加入结果，避免误报普通 5555 服务。扫描不执行 `adb connect`，不会擅自改变设备连接状态。最终结果按 IP 合并，mDNS 条目优先保留 SN 和广播端口；主动补扫项无 SN 时以前端 IP 作为显示名。
- **关闭大空间改用 PICO 固件 ToBService 接口**：原实现执行 `am force-stop com.picoxr.blspace`，只能结束 LSpace 设置进程，无法清除 Guardian 持有的大空间状态。改为执行 `adb shell am startservice -a com.pvr.tobservice.remoteservice -e act switch_ls -e switch off`；已在 A9210 实机确认 ToBService 返回关闭成功，Guardian 状态切换为 `SetLargeSpaceForB 0`。

---

## [v2.14] - 2026-06-26
### 修改
- **采集会话目录与导出 zip 改用设备真实 SN 命名**：性能采集本地会话目录名前缀、导出 zip 默认文件名均优先使用设备真实 SN（`ro.serialno` / `ro.boot.serialno`），WiFi 设备不再使用 `ip:port` 生成 `192.168.x.x_5555-...` 这类名称；SN 取不到才回退设备 id。

---

## [v2.13] - 2026-06-24
### 新增
- **应用安装支持一键清空已选安装包**：待安装区在已有 APK 时显示「清空已选」入口，点击后清空当前待安装列表；安装进行中禁用，避免影响正在执行的安装批次。
### 修正
- **安装历史 tooltip 顶部显示 APK 文件名**：此前错误显示安装后的应用包名，改为显示该历史项对应的 APK 文件名；安装记录仍列设备 SN、次数和时间。

---

## [v2.12] - 2026-06-24
### 修改
- **局域网 mDNS 发现改为流式、加快出结果**：原本 3 拍 × 800ms 一次性返回（点扫描需干等 ~2s 才出全部），改为每拍扫描后即 `emit("mdns_discovered")` 把累计可连接设备推给前端，**第一拍 ~百毫秒就先显示**，后续拍补齐；拍间隔 800ms→700ms。多拍并集去重逻辑不变（仍覆盖周期广播/冷缓存漏扫）。新增后端 `discover_streaming` + 前端 `onMdnsDiscovered` 订阅。

---

## [v2.11] - 2026-06-23
### 修改
- **安装历史侧栏改为常驻显示（空也显示）**：去掉 `apkHistory.length > 0` 渲染守卫，无记录时展示空态（history 图标 +「暂无安装历史 / 安装成功的 APK 会记在这里」）。
- 历史项「加入」按钮：已在待安装区的置灰禁用，显示「已加入」+ 对勾图标。

---

## [v2.10] - 2026-06-23
### 修改
- **「应用安装」与「安装详情」纵向比例由 6 : 4 调整为 1 : 1**（操作区 flex 6→5，安装详情 flex 4→5）。

---

## [v2.9] - 2026-06-23
### 修改
- **目标设备项改为双行显示「设备名 + SN」**（2.2 + 5.1.2）：竖排列表加宽后，每项第一行设备显示名、第二行 `SN <序列号>`（无 SN 回退显示设备 id），名字/SN 各自超长省略。

---

## [v2.8] - 2026-06-23
### 修改
- **安装历史侧栏改为常驻、不再折叠**（2.2 + 5.1.2）：移除折叠/展开机制（删除 `apkHistoryExpanded` 状态与窄条/展开切换），历史侧栏固定宽 280px 常驻操作区右侧。
- **目标设备由 3 列网格改为竖排单列列表**：每台设备占一行、整列可滚动；放大行内间距/勾选框/字号（padding 10×12、勾选框 16px、名字 13px），与工具整体卡片风格一致。

---

## [v2.7] - 2026-06-23
### 修改
- **安装操作区改为左右分栏布局**（2.2 + 5.1.2）：原来拖放区 + 安装历史侧栏在上、目标设备网格在下；改为操作区内左右分栏——**左列**上为缩小后的拖放/选 APK 区（不再占满，仅放提示与已选 chip）、下为目标设备网格（占满剩余、可滚动）；**右列**为安装历史侧栏（跨左列整高）。即「操作区在上、目标设备在下、安装历史在右」。拖放区高度由弹性占满改为 `maxHeight:150 + 自身滚动`，空态图标/文案改单行紧凑排版。

---

## [v2.6] - 2026-06-23
### 修改
- **安装历史 tooltip 精简为只列安装记录**（2.2 + 5.1.2）：去掉 tooltip 里的文件名头行与「点加入再次安装」操作提示，只保留各设备安装记录。
- **历史记录设备改用 SN 表示**：`ApkInstallRecord.label` 写入当时优先取设备 SN（`DeviceInfo.serialNo`），无 SN 回退显示名；tooltip 与列表据此展示 SN。`upsertApkHistory` 调用方改传 `deviceSn`。
- **「应用安装」与「安装详情」纵向比例由 3 : 7 调整为 6 : 4**（操作区 flex 3→6，安装详情 flex 7→4）：放大选包/历史/目标设备的操作区，压缩日志详情区。

---

## [v2.5] - 2026-06-23
### 修改
- **APK 安装历史改为可折叠侧栏**（2.2 功能表 + 5.1.2）：从安装包拖放区下方的竖排列表，改到拖放区**右侧的可折叠侧栏**。默认折叠成 42px 窄条（竖排「安装历史」+ 条数 + 失效红点），点一下展开占安装包区约一半宽（与拖放区各占一半）、内部滚动，标题栏可再折叠。新增 `apkHistoryExpanded` 折叠态（内存态，默认折叠）。
### 新增
- **安装历史记录各设备安装信息**（5.1.2 数据模型）：`ApkHistoryItem` 增 `devices: ApkInstallRecord[]`（`{ id, label, at, count }`，按设备 id 去重）。每台设备安装成功时按 `deviceId` 合并（更新 `at`/`label` 并 `count+1`，无则新增）。hover 历史项弹多行 tooltip：文件名 + 各设备（设备名 ·×次数· 最近时间）+ 状态/操作提示。旧版无 `devices` 数据降级显示「装过 N 次（早期记录无设备信息）」。`upsertApkHistory` 入参增 `deviceId`/`deviceLabel`。

---

## [v2.4] - 2026-06-23
### 新增
- **APK 安装历史列表**（2.2 功能表 + 5.1.2 数据模型）：安装成功的 APK 自动记入本地历史列表，持久化（渲染层 `localStorage`，沿用搜索历史/历史设备范式），重启工具仍在。点历史项「加入」按钮即把该 APK 放回设备页统一安装面板的待安装区再次安装，免去重新翻找文件。（原计划支持拖回，但本应用 `dragDropEnabled=true` + WebView2 会禁用页面内 HTML5 拖放，改按钮实现同等效果。）
  - **入历史时机**：仅「安装成功」才记——多设备并行时任意一台成功即记；装失败、仅加入待安装区未实际安装的不进历史。
  - **去重**：按 APK 绝对路径 `path` 去重；再次成功安装同一文件只更新 `lastInstalledAt` 并 `installCount + 1`，不新增条目。
  - **失效处理**：源文件存在性为运行时态，每次展示由后端实时校验。文件已不在 PC 上的项**置灰禁用**（不可拖、不可装），但保留 `fileName`/`path`/时间等记录供辨认；盘重新挂载/文件移回后自动恢复可用。失效项可单独删除或「清理失效项」一键批量删。（用户在「置灰保留」与「自动删除」间选定置灰，理由：自动删会因临时拔盘/挪文件误删记录。）
  - **维护**：列表任意项均可手动移除，移除仅删历史记忆、不动 PC 上的实际 APK 文件。
- 数据结构新增 `ApkHistoryItem { path, fileName, lastInstalledAt, installCount }`。

---

## [v2.3] - 2026-06-10
### 变更
- **Android FPS 口径改用 SurfaceFlinger 合成上屏帧率**（5.x 性能采集 + 数据模型）：原 `dumpsys gfxinfo framestats` 只统计 HWUI 视图树渲染帧，内嵌 Unity/游戏/视频画在自己 SurfaceView+GL 上绕过 HWUI——gfxinfo 抓不到（真机实测内嵌 Unity 时 gfxinfo 仅 0.2fps）。改为主用 `dumpsys SurfaceFlinger --timestats`（Android 12+ BLAST 兼容，按 layer 直给 averageFPS），优先选目标包的 SurfaceView 内容层（排除 `Background for` 背景占位层）、回退主窗口层；SurfaceFlinger 取不到有效值时回退 gfxinfo。timestats 在采集/监控期间启用、退出钩子 disable。
- 数据结构 `AndroidPerformancePayload` 增 `fpsGfxinfo` / `fpsSurfaceFlinger` / `fpsSurfaceFlingerLayer`；`fpsSource` 标注本拍实际采用源。性能面板「当前 FPS 口径」块新增「FPS 口径对照」行并排展示两者原值。
- 影响：采集曲线/报告/均值的 FPS 改记 SurfaceFlinger 值（Pico 路径不受影响，仍走原生 PxrMetric）。
- 背景与决策见会话；Android 13 timestats 方案来源：developer.android.com/games/optimize/framerate。

---

## [v2.2] - 2026-06-09
### 新增
- **性能采集录制设备声音（可选）**（2.2 功能表 + 5.4 采集会话）：采集设置新增「录制设备声音」开关（默认关）。开启且设备满足「Android 13+ 且音频可捕获」时，采集录制后端从设备端 `screenrecord`（无音）切到 scrcpy `--record`（视频+音频录进同一 MP4），音频用 `--audio-dup`（隐含 `--audio-source=playback`，设备与电脑同时出声、设备不静音）；不满足的设备（Android<13 / 音频捕获不通如部分 Pico）开关置灰提示「该设备不支持录音」，回退原无声 `screenrecord` 兜底。回看 `<video>` 直接播放含音轨 MP4（带音量/静音控制）。沿用 ≤180s 分段实时落盘与缝合架构。复用 P3 投屏已落地的 scrcpy 资源与 `build_audio_args` 的 dup/output 口径。
- 数据结构 `PerformanceCaptureSession` 增 `audioRecorded?: boolean`（本次录像是否含音频轨）。
- 风险评估（8）新增「采集录音兼容性」：Pico 音频捕获待真机验证、含音分段接缝音频可能断续，缓解为不支持设备降级无声 + 接缝真机调优。

### 已验证
- Pico 设备音频捕获已真机验证可行：投屏 `--audio-dup` 实测 Pico 声音可转到电脑且两边同时出声（即 Pico 为 Android 13+），Pico 同走含音录制路径；降级仅针对 Android<13 或音频捕获失败的设备。

---

## [v2.1] - 2026-06-09
### 删除
- 移除整个「网络」模块（应用网络请求抓取 / HTTP 抓取 / 请求详情）。具体清理：1.1 产品定位去掉「网络请求」；2.2 删除「网络请求」「请求详情」两个功能点；3.3 关键模块去掉「网络请求：tcpdump/应用层 hook」；性能章节去掉「网络请求与抓包归属网络页签」表述；5.6 数据模型 NetworkRequest 整节删除。理由：用户在 Tauri 重构版确认不再需要该能力。
- 顶部标签由 6 个（设备/日志/性能/网络/投屏/弱网）缩减为 5 个（设备/日志/性能/投屏/弱网）。

---

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
