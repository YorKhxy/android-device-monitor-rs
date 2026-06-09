# ADR 0001: Pico 性能页采用独立 Provider 与独立指标口径
- 状态: Accepted
- 日期: 2026-05-27

## 背景

项目原本只有一套通用 Android 性能页，主要依赖 `top`、`dumpsys meminfo`、`dumpsys gfxinfo`。当连接设备是 Pico 时，这套口径和 Pico 官方工具展示并不一致，尤其是：

- Pico 官方更强调 `FPS / MTP / FrmCpu / FrmGpu / ATWGPU / GPU`
- 其中 `FrmCpu` 是 CPU frame time，不等于 Android 通用语义里的 CPU 使用率
- 继续复用 Android 卡片会让界面看起来像 Pico，但语义并不像 Pico

进一步调研后确认，PICO 官方公开能力更接近 `XR Profiling Toolkit` 工具链，而不是一个稳定公开、面向任意第三方应用的系统级 Metrics API。因此，“Pico 官方口径”必须先定义支持边界，否则实现会在“任意 Pico 应用都该有官方指标”和“只支持已集成官方工具链的应用”之间反复摇摆。

## 决策

为性能模块引入双 Provider 架构，并明确 Pico 官方指标的支持范围：

1. `android` Provider
   - 服务普通 Android 手机或平板
   - 维持当前 `CPU / MEM / FPS / NET` 主视图

2. `pico` Provider
   - 仅在设备识别为 Pico 时启用
   - 性能页改为 Pico 风格指标展示，不再强行复用 Android 通用卡片语义
   - `pico` Provider 的“官方口径指标”只承诺支持“已集成 `XR Profiling Toolkit` 的 Pico 应用”
   - 不把“任意第三方 Pico 应用都能输出官方指标”作为产品承诺

## 后果

正向影响：
- Pico 设备的性能页语义会更接近官方开发工具
- 产品边界清晰，后续实现可以直接围绕 `XR Profiling Toolkit` 的 schema、解析逻辑和接入方式展开
- 性能快照、实时预览、后续导出报告都能围绕同一套 Pico 指标演进
- Android 通用设备不需要为 Pico 特性承担额外复杂度

代价：
- 共享类型会变成带 `provider` 的联合模型
- 渲染层需要维护 Android / Pico 两套性能视图
- 主进程需要引入 Pico 官方工具链兼容层，而不是只靠通用 ADB 采样
- 对未集成 `XR Profiling Toolkit` 的 Pico 应用，需要明确提示“不在官方指标支持范围内”

## 执行规则

- 识别到 Pico 设备后，性能页优先进入 `pico` 视图
- 只有当前前台应用满足 `XR Profiling Toolkit` 集成前提时，才展示 Pico 官方口径指标
- 对未集成官方工具链的 Pico 应用，UI 必须明确提示“当前应用不支持 Pico 官方指标”
- 性能快照必须保存 `provider` 与指标来源信息，避免后续把 Pico 快照误当成 Android 通用快照解释
