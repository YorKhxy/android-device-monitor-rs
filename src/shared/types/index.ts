export interface DeviceInfo {
  id: string;
  name: string;
  serialNo: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  apiLevel: number;
  connectionType: 'usb' | 'wifi';
  status: 'connected' | 'disconnected' | 'offline' | 'unauthorized';
  latencyMs?: number;
  latencyStatus?: 'ok' | 'timeout' | 'unknown';
  batteryLevel?: number;
  // 屏幕电源状态：on=唤醒亮屏，off=息屏，unknown=识别不出/查询失败（不臆测）。
  screenState?: 'on' | 'off' | 'unknown';
}

// 仅保存通过 WiFi 成功连过的设备，用于「快速重连」历史卡片。
// 以 serialNo 为唯一键去重：设备 IP 变了仍认得出是同一台，覆盖更新而非新增。
// 在线状态不进持久化结构，由当前设备列表按 serialNo 实时匹配计算。
// 持久化沿用渲染层 localStorage（物理上落在 Electron userData 目录下），不暴露宿主绝对路径。
export interface HistoryDevice {
  serialNo: string; // 设备序列号 SN，唯一标识
  name: string; // 设备显示名（自定义名优先，回退设备名/型号），卡片标题展示
  model: string; // 设备型号，显示名缺失时的兜底
  lastAddress: string; // 最近一次连接的 IP:端口，快速重连默认值
  lastConnectedAt: number; // 最近连接时间戳（毫秒），列表倒序排序用
}

export interface PairResult {
  message: string;
  device: DeviceInfo | null;
  alreadyPaired?: boolean;
}

export interface DeviceFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtime: string;
}

export interface DeviceFileList {
  path: string;
  entries: DeviceFileEntry[];
}

export interface PushProgress {
  uploadId: string;
  fileName: string;
  index: number;       // 当前是第几个文件（从 0 起）
  total: number;       // 本批共多少个文件
  percent: number;     // 当前文件 0-100
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

export interface PullProgress {
  pullId: string;
  fileName: string;
  index: number;       // 当前是第几个文件（从 0 起）
  total: number;       // 本批共多少个文件
  status: 'downloading' | 'done' | 'error';
  error?: string;
}

export interface PullFilesResult {
  savedDir: string;    // 保存到的 PC 文件夹
  succeeded: number;   // 成功下载的文件数
  failed: number;      // 失败的文件数
}

/** 文件传输方向：上传到设备 / 从设备下载。 */
export type TransferDirection = 'upload' | 'download';

/** 单个传输任务的状态。pending=未开始，transferring=进行中，done=已完成，failed=失败。 */
export type TransferTaskStatus = 'pending' | 'transferring' | 'done' | 'failed';

/**
 * 一次文件传输任务（批量中的单个文件）。持久化到 userData/transfer-journal.json，
 * 用于进程崩溃 / 被强杀后识别未完成任务并文件级续传。只有停留在 pending/transferring
 * 的任务才算「需恢复的残留」；用户主动取消或失败的任务在了结时即移除，不进恢复队列。
 */
export interface TransferTask {
  id: string;                  // 任务唯一 id
  batchId: string;             // 所属批次 id（一次批量上传/下载共享同一 batchId）
  direction: TransferDirection;
  deviceId: string;            // 任务绑定的设备，恢复以原设备为前提
  sourcePath: string;          // 上传=本地文件路径；下载=设备文件路径
  targetPath: string;          // 上传=设备目标目录；下载=PC 保存目录
  fileName: string;            // 文件名
  size: number;                // 文件大小（字节），未知填 0
  status: TransferTaskStatus;
  createdAt: number;           // 创建时间戳
  updatedAt: number;           // 最后更新时间戳
}

/** 启动时推送给渲染层的「可恢复批次」摘要，用于弹窗提示。 */
export interface TransferResumeBatch {
  batchId: string;
  direction: TransferDirection;
  deviceId: string;
  remaining: number;           // 该批次未完成文件数
  sampleNames: string[];       // 文件名样例（最多几个，供提示展示）
}

/** 一批传输（新建或恢复）执行完毕的结果统计。 */
export interface TransferBatchResult {
  succeeded: number;
  failed: number;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  packageName: string;
  cpuUsage: number;
  memoryUsage: number;
  status: 'running' | 'sleeping' | 'zombie';
}

export interface LogEntry {
  id: string;
  deviceId: string;
  timestamp: Date;
  processId: number;
  threadId: number;
  level: 'V' | 'D' | 'I' | 'W' | 'E' | 'F';
  tag: string;
  message: string;
  packageName?: string;
}

export interface NetworkRequest {
  id: string;
  timestamp: Date;
  packageName: string;
  method: string;
  url: string;
  statusCode: number;
  statusText?: string;
  path?: string;
  host?: string;
  requestBody?: string;
  responseBody?: string;
  headers: Record<string, string>;
  responseHeaders?: Record<string, string>;
  rawRequest?: string;
  rawResponse?: string;
  duration: number;
}

export interface ApkInstallResult {
  apkPath: string;
  output: string;
}

export interface ActivityStackEntry {
  id: string;
  packageName: string;
  activityName: string;
  state: string;
  taskId?: string;
  raw: string;
}

export interface MetricReading {
  value: number;
  unit?: string;
  maxValue?: number;
  maxValueUnit?: string;
  raw?: string;
}

export interface PicoMetricsPayload {
  rawLine?: string;
  rawFields?: Record<string, string>;
  fps?: MetricReading;
  mtp?: MetricReading;
  frameCpu?: MetricReading;
  frameGpu?: MetricReading;
  atwGpu?: MetricReading;
  gpuUtil?: MetricReading;
}

export interface AndroidPerformancePayload {
  source: 'android';
  cpuSource?: string;
  memorySource?: string;
  fpsSource?: string;
}

export type PicoMetricsState = 'native' | 'fallback' | 'unavailable';
export type PicoAppSupportStatus = 'supported' | 'unsupported' | 'unknown';

export interface PerformanceMetrics {
  provider: 'android' | 'pico';
  cpuUsage: number;
  memoryUsage: number;
  fps: number;
  packageName?: string;
  activityName?: string;
  androidMetrics?: AndroidPerformancePayload;
  picoMetrics?: PicoMetricsPayload;
  picoMetricsState?: PicoMetricsState;
  picoMetricsMessage?: string;
  picoAppSupport?: PicoAppSupportStatus;
  picoSupportMessage?: string;
}

export interface PerformanceSample {
  id: string;
  deviceId: string;
  capturedAt: Date;
  metrics: PerformanceMetrics;
}

export interface PerformanceSessionExportPayload {
  device: DeviceInfo;
  startedAt: Date;
  endedAt?: Date;
  samples: PerformanceSample[];
}

// —— 性能采集会话（Phase 14：一次「开始采集 → 关闭采集」= 一个会话）——

export type PerformanceCaptureProvider = 'android-screenrecord' | 'pico-screenrecord' | 'pico-sdk';

export type PerformanceCaptureStatus = 'recording' | 'completed' | 'failed';

/** 一段录制视频（≤180s）。多段按 index 顺序缝合为一条连续时间轴。 */
export interface PerformanceCaptureSegment {
  index: number;
  /** 相对会话 video/ 目录的文件名，如 seg-0.mp4 */
  fileName: string;
  /** 相对采集起点的毫秒数（本段开始） */
  startMs: number;
  /** 相对采集起点的毫秒数（本段结束） */
  endMs: number;
  /** 本段视频体积（字节） */
  sizeBytes: number;
}

/** 参数过滤标记：某指标按阈值命中的时间点集合，可持久化复用。 */
export interface PerformanceCaptureMarker {
  id: string;
  metricKey: 'fps' | 'cpu' | 'mem' | 'gpu';
  op: '>' | '=' | '<';
  threshold: number;
  /** 命中的时间点（相对会话起点毫秒） */
  atMs: number[];
}

export interface PerformanceCaptureSession {
  id: string;
  deviceId: string;
  /** 设备序列号，用于回看列表展示与缺省命名 */
  deviceSn: string;
  /** 用户自定义名称，缺省用「SN + 时间 + 时长」 */
  title?: string;
  provider: PerformanceCaptureProvider;
  status: PerformanceCaptureStatus;
  startedAt: Date;
  endedAt?: Date;
  durationMs: number;
  /** Pico：播放时按单眼区域裁切显示 */
  singleEyeVideo?: boolean;
  /** 分段视频（按时序），缝合为连续轴 */
  videoSegments: PerformanceCaptureSegment[];
  /** 样本数据文件相对路径（performance-captures/<id>/data/samples.jsonl） */
  dataRelativePath: string;
  /** 快捷截图归档子目录相对路径 */
  screenshotDir?: string;
  packageName?: string;
  activityName?: string;
  /** 视频 + 数据总体积，用于软上限提醒 */
  sizeBytes?: number;
  error?: string;
}

/** 进行中的采集会话快照：渲染层重载/崩溃后据此对齐采集状态。 */
export interface ActiveCaptureSession {
  deviceId: string;
  session: PerformanceCaptureSession;
  /** 已采集时长（毫秒） */
  elapsedMs: number;
}

/** 导入会话结果：成功导入的会话 + 每个失败来源的错误说明。 */
export interface CaptureImportResult {
  imported: PerformanceCaptureSession[];
  errors: string[];
}

/** loadSession 返回：会话元数据 + 完整样本序列 + 已存过滤标记。 */
export interface PerformanceCaptureSessionDetail {
  session: PerformanceCaptureSession;
  samples: PerformanceSample[];
  markers: PerformanceCaptureMarker[];
}

/** 采集进行中实时推送给渲染层的单条样本（供实时曲线）。 */
export interface CaptureSamplePayload {
  deviceId: string;
  sessionId: string;
  sample: PerformanceSample;
  /** 相对采集起点的毫秒数 */
  elapsedMs: number;
}

/** 软上限提醒：录制时长或体积先到阈值时触发一次。 */
export interface CaptureSizeLimitPayload {
  deviceId: string;
  sessionId: string;
  reason: 'duration' | 'size';
  durationMs: number;
  sizeBytes: number;
}

export interface AdbStatus {
  available: boolean;
  version: string | null;
  path: string | null;
  source?: 'bundled' | 'system';
  message: string;
  checkedAt: number;
  code?: string;
  hint?: string;
}

export interface LogcatFilters {
  packageName?: string;
  tag?: string;
  level?: LogEntry['level'];
  keyword?: string;
}

export type MirrorSessionStatus = 'starting' | 'running' | 'stopped' | 'failed';

/** 投屏会话状态，含 Pico 单眼裁切与画质配置。 */
export interface MirrorSession {
  deviceId: string;
  status: MirrorSessionStatus;
  startedAt?: string;
  error?: string;
  isPico?: boolean;
  crop?: string; // scrcpy --crop 参数，Pico 单眼裁切，如 "1920:1920:0:0"
  maxSize?: number; // scrcpy --max-size 分辨率上限
  bitRate?: string; // scrcpy --video-bit-rate 码率，如 "8M"
  audioForwarded?: boolean; // 当前是否把设备声音转到电脑（由独立音频进程承载，可投屏中实时切换）
  // 转到电脑时的实际音频模式：'both'=设备与电脑同时出声（audio-dup，Android 13+）；
  // 'pc-only'=仅电脑出声、设备静音（设备不支持 audio-dup 时自动降级）。未转发时为 undefined。
  audioMode?: 'both' | 'pc-only';
}

/** 启动投屏的可选参数。 */
export interface MirrorStartOptions {
  windowTitle?: string;
  isPico?: boolean; // Pico 设备自动附加单眼裁切
  maxSize?: number; // --max-size
  bitRate?: string; // --video-bit-rate，如 "8M"
  // 投屏启动时是否就把设备声音转到电脑。默认 false：声音留在设备本机输出。
  // 音频由独立的「纯音频」scrcpy 进程承载，投屏过程中可随时起停切换（见 setMirrorAudio）。
  forwardAudio?: boolean;
}

/** 自动更新状态机。checking=检查中，available=发现新版本，not-available=已最新，
 *  downloading=下载中（带 percent），downloaded=下好待重启安装，error=出错。 */
export type UpdateState = 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string; // available / downloaded 时的新版本号
  percent?: number; // downloading 时的进度百分比（0-100，整数）
  error?: string;   // error 时的错误信息
  releaseNotes?: string; // available / downloaded 时的本次更新说明（来自 latest.yml）
}

export type IpcChannel =
  | 'adb:get-status'
  | 'adb:get-devices'
  | 'adb:connect-usb'
  | 'adb:connect-wifi'
  | 'adb:pair-wifi'
  | 'adb:disconnect'
  | 'adb:start-logcat'
  | 'adb:stop-logcat'
  | 'adb:get-performance'
  | 'adb:capture-performance-snapshot'
  | 'adb:start-performance-recording'
  | 'performance:export-session'
  | 'adb:get-processes'
  | 'adb:get-activity-stack'
  | 'adb:get-network-requests'
  | 'adb:select-apk-files'
  | 'adb:install-apk'
  | 'adb:list-device-files'
  | 'adb:pull-device-file'
  | 'adb:pull-device-files'
  | 'adb:pull-device-file-progress'
  | 'adb:delete-device-file'
  | 'app:show-item-in-folder'
  | 'app:get-version'
  | 'app:get-release-notes'
  | 'adb:push-device-file'
  | 'adb:push-device-file-progress'
  | 'adb:select-upload-files'
  | 'adb:resume-transfers'
  | 'adb:discard-transfers'
  | 'adb:get-resume-batches'
  | 'adb:sleep-device'
  | 'adb:wake-device'
  | 'adb:unlock-device'
  | 'adb:reboot-device'
  | 'adb:status-changed'
  | 'device:connected'
  | 'device:disconnected'
  | 'mirror:start'
  | 'mirror:stop'
  | 'mirror:status'
  | 'mirror:set-audio'
  | 'update:status'
  | 'update:check'
  | 'update:download'
  | 'update:quit-and-install'
  | 'log:export'
  | 'log:export-full'
  | 'log:entry'
  | 'log:batch'
  | 'device:list-changed';

export interface IpcRequest<T = unknown> {
  channel: IpcChannel;
  payload?: T;
}

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  hint?: string;
  details?: string;
}

// ===== Pico 弱网控制（pico-network-helper 助手 APK 的桌面控制台）=====

// 弱网参数，与助手 WeakNetworkControlService 的 extras 一一对应。
export interface WeakNetworkProfile {
  packageName: string;        // 目标应用包名
  latencyMs: number;          // 附加延迟（毫秒，0-60000）
  jitterMs: number;           // 抖动（毫秒，0-60000）
  packetLossPercent: number;  // 丢包率（0-100）
  uploadKbps: number;         // 上行限速（kbps，0=不限）
  downloadKbps: number;       // 下行限速（kbps，0=不限）
}

// 预设档位：一键填入参数，可再手动微调。
export interface WeakNetworkPreset {
  id: string;
  label: string;
  values: Omit<WeakNetworkProfile, 'packageName'>;
}

// 助手在目标设备上的状态（桌面端通过 dumpsys 实查推断）。
export type WeakNetworkHelperStatus =
  | 'not-installed'        // 设备未安装助手 APK
  | 'idle'                 // 已安装、未运行
  | 'need-vpn-permission'  // 已安装但未授予 VPN 权限
  | 'running'              // 弱网生效中
  | 'stopped'              // 已停止
  | 'error';               // 异常（命令失败等）

// 弱网隧道(tun)的累计流量计数，读自设备 /proc/net/dev 的 tun 行。
// 渲染层按相邻两次采样的差值 + 间隔算实时上下行速率。弱网未运行(无 tun)时为 null。
export interface WeakNetworkTraffic {
  rxBytes: number;     // 隧道累计接收字节（设备下行）
  txBytes: number;     // 隧道累计发送字节（设备上行）
  rxPackets: number;   // 累计接收包数
  txPackets: number;   // 累计发送包数
}

// 助手整形层实测统计（读自助手每秒打的 WeakNetStats logcat）。
// 真实丢包率 = 丢弃决策 / 决策总数；实测 RTT = 代理连接真实目标的平均往返耗时。
export interface WeakNetworkShaperStats {
  lossPercent: number;     // 真实丢包率 %（实测，区别于配置值）
  avgRttMs: number;        // 实测到目标的平均往返延迟（ms），无样本为 0
  decidedPackets: number;  // 整形决策总数
  droppedPackets: number;  // 实际丢弃数
}

// 内置预设档位（参考值，最终以实测为准）。
export const WEAK_NETWORK_PRESETS: WeakNetworkPreset[] = [
  { id: 'weak-wifi', label: '弱 WiFi', values: { latencyMs: 150, jitterMs: 40, packetLossPercent: 2, uploadKbps: 2048, downloadKbps: 4096 } },
  { id: '3g', label: '3G', values: { latencyMs: 300, jitterMs: 80, packetLossPercent: 1, uploadKbps: 384, downloadKbps: 1024 } },
  { id: 'high-loss', label: '高丢包', values: { latencyMs: 100, jitterMs: 30, packetLossPercent: 15, uploadKbps: 0, downloadKbps: 0 } },
  { id: 'high-latency', label: '高延迟', values: { latencyMs: 800, jitterMs: 150, packetLossPercent: 0, uploadKbps: 0, downloadKbps: 0 } },
];
