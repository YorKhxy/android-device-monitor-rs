# ADR 0003: Pico 弱网助手 TUN 传输采用 hev-socks5-tunnel 预编译 .so

- 状态: Accepted
- 日期: 2026-06-02
- 关联: ADR 0002（弱网助手 APK 与 TCP/UDP 覆盖）

## 背景

ADR 0002 确定了 Pico 弱网助手用 `VpnService` 建立 TUN，对目标 APP 的 TCP/UDP 施加弱网整形。
但 TUN 层的 IP 包解析与 TCP/UDP 重组（tun2socks）此前是一个占位 TODO
（`TcpUdpShapingEngine` 里只有一个空转循环）。手写一套 TUN 协议栈既脆弱又难维护，尤其 UDP
重组与 Fullcone NAT 极易出错，而 ADR 0002 第 30-33 条明确要求 UDP 必须可靠支持。

需要一个成熟、经过生产验证的 tun2socks 内核来承载 TUN 传输。

## 决策

### 内核选型：heiher/hev-socks5-tunnel

采用 C 实现的 [hev-socks5-tunnel](https://github.com/heiher/hev-socks5-tunnel)（行业标准 tun2socks，
TCP+UDP 全功能，IPv4/IPv6，Fullcone NAT）。Android 集成参考官方示例
[heiher/sockstun](https://github.com/heiher/sockstun)。

数据流：

```
TUN fd → hev(libhev-socks5-tunnel.so) → 本地 SOCKS5(127.0.0.1) → 真实网络
```

弱网整形（延迟/抖动/丢包/上下行限速）仍由 Java 侧的 `WeakSocks5Proxy` 在 SOCKS5 层完成；
hev 只负责把 TUN 里的 TCP/UDP 流量可靠转换并转发进这个本地代理。`socks5.udp` 配置为 `'udp'`，
即标准 SOCKS5 UDP ASSOCIATE，因此 `WeakSocks5Proxy` 补齐了 UDP ASSOCIATE 转发（解封装 SOCKS5
UDP 头 → 转发真实目标 → 回包按相同格式封装回送，按目标分流的 NAT 表支持 Fullcone）。

UDP 回包寻址的前提假设：标准 SOCKS5 UDP ASSOCIATE 下，hev 在一条关联内使用**单个固定本地 UDP
端点**与中继收发，因此 `WeakSocks5Proxy` 用「最近一次上行包的来源地址」作为该关联所有回包的目的地
（`UdpAssociation.clientAddress`）。这与 hev 的 SOCKS5 客户端实现一致；若未来更换为「每流一个本地
端口」的客户端，需改为按上行流绑定回包地址。回包的 ATYP/ADDR/PORT 按 RFC 1928 原样回显客户端请求
的目标地址（含域名形态），不替换为解析后的 IP。

### 集成方式：预编译 .so 入库（不依赖 NDK 构建）

在「.so 入库」与「NDK 每次源码编译」之间选择**前者**，理由是**可移植 / 开箱即用**：

- `libhev-socks5-tunnel.so`（仅 `arm64-v8a`，Pico = 高通 XR2）提交到版本库
  `app/src/main/jniLibs/arm64-v8a/`。
- 任何机器 clone 后 `gradlew assembleDebug` 直接出带 tun2socks 的 APK，**无需安装 NDK**
  （NDK 是 Android 工具链里最重的一块，免掉它才是实际意义上的开箱即用）。
- 只在升级 hev 版本或新增 ABI 时，才在装有 NDK 的开发机上用
  `scripts/build-native.ps1` 重新生成 .so。

### JNI 绑定

hev 的 `hev-jni.c` 在 `JNI_OnLoad` 里用 `FindClass(PKGNAME "/" CLSNAME)` + `RegisterNatives`
动态注册 native 方法（不依赖符号名 mangling）。编译时通过
`-DPKGNAME=com/androidtool/piconetworkhelper/vpn -DCLSNAME=HevSocks5Tunnel`
把注册目标指向本项目的 `HevSocks5Tunnel` 类，因此无需迁就 sockstun 的 `hev.sockstun` 包名。

Java 侧 `HevSocks5Tunnel` 声明三个 native 方法并 `System.loadLibrary("hev-socks5-tunnel")`：
- `TProxyStartService(String configPath, int fd)` → `hev_socks5_tunnel_main`（native 线程）
- `TProxyStopService()` → `hev_socks5_tunnel_quit` + join
- `TProxyGetStats()` → `[tx_packets, tx_bytes, rx_packets, rx_bytes]`

## 复现信息（.so 来源版本）

通过 `scripts/build-native.ps1` 复现。本次入库的 .so 对应：

| 组件 | 仓库 | 提交 |
|------|------|------|
| sockstun（jni 构建脚本） | heiher/sockstun | `2e5a08920e65c5b72a70e57324902d25c021534a` |
| hev-socks5-tunnel | heiher/hev-socks5-tunnel | `da33382c7282b4e764408535704f3cd96fea9a14` |
| hev-socks5-core | heiher/hev-socks5-core | `4be2e621813ba0315cfacd995bf501bde91d6996` |
| hev-task-system | heiher/hev-task-system | `8d83bbbf79557138726c8ee5a5fae99cbb978d61` |
| lwip | heiher/lwip | `07dbf162c718cc78ddedb9e67c6ebd17065eaf13` |
| yaml | heiher/yaml | `efa36117a8646d26d12b58e05bac472d7854a70d` |

- 构建工具链：Android NDK `27.2.12479018`，`APP_PLATFORM=android-29`，`APP_OPTIM=release`。
- 产物带 `-Wl,-z,max-page-size=16384`（16KB 页，兼容 Android 15+ 设备）。

### Windows 构建注意

hev 各子模块的 `include/` 大量使用符号链接指向 `../src/...`。Windows 上若 git
`core.symlinks=false`，会把链接目标当作纯文本写进 `.h` 文件，导致编译报
`expected identifier`。`build-native.ps1` 内置 `Repair-GitSymlinks`，按 git mode `120000`
枚举并就地替换为真实文件内容。

## 后果

正向影响：
- TUN 传输由生产级内核承载，TCP/UDP（含 Fullcone NAT）可靠，满足 ADR 0002 的 UDP 硬要求。
- 别的机器零 NDK 即可构建出可装的 APK，符合「项目层必须开箱即用」的约束。
- 弱网整形逻辑仍留在 Java SOCKS5 层，便于调参与维护。

负向影响 / 风险：
- 仓库引入一个预编译二进制（342 KB）。通过 ADR 钉死来源/版本 + build 脚本可复现，规避黑盒。
- 目前仅 `arm64-v8a`。其他 ABI 设备需重跑 build 脚本补 .so。
- hev 升级需手动重跑脚本并更新本 ADR 的版本表。

## 备选方案（未采用）

- **NDK 每次构建参与编译**：换机器首次需联网下 ~1GB NDK，不满足开箱即用，否决。
- **手写 TUN 协议栈**：脆弱、UDP/NAT 易错，维护成本高，否决。
- **hev 私有 UDP-in-TCP（`udp: 'tcp'`）**：可免去 UDP ASSOCIATE，但需 SOCKS5 服务端支持
  hev 私有扩展，我们的 Java 代理无法实现，否决。
