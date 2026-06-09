import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { AdbStatus, DeviceInfo, HistoryDevice, MirrorSession, PerformanceMetrics, PerformanceCaptureSession, PerformanceCaptureSessionDetail, PerformanceCaptureMarker, PerformanceSample, LogEntry, NetworkRequest, WeakNetworkHelperStatus, WeakNetworkProfile, WeakNetworkShaperStats, UpdateStatus } from '../shared/types';
import { NetworkPanel } from './components/NetworkPanel';
import { PerformancePanel } from './components/PerformancePanel';
import { MirrorPanel } from './components/MirrorPanel';
import { FilesPanel } from './components/FilesPanel';
import { WeakNetPanel } from './components/WeakNetPanel';
import { Icon, AppAvatar, Badge } from './components/ui';
import { GlobalTooltip } from './components/GlobalTooltip';
import { ElectronResult, hasElectronAPI } from './lib/electronApi';
import {
  buildHistoryEntryFromDevice,
  formatHistoryTime,
  loadHistoryDevices,
  removeHistoryDevice,
  saveHistoryDevices,
  upsertHistoryDevice,
} from './lib/historyDeviceStore';
import {
  addSearchHistory,
  loadSearchHistory,
  removeSearchHistory,
  saveSearchHistory,
} from './lib/searchHistoryStore';
import { isTransferActive } from './lib/fileTransferManager';
import {
  BATCH_UPDATE_DELAY,
  BATCH_UPDATE_SIZE,
  createDeviceLogState,
  createLogCounts,
  DeviceLogState,
  LOG_LINE_HEIGHT,
  LOG_OVERSCAN_ROWS,
  LOG_ROW_HEIGHT,
  MAX_LOG_ENTRIES,
  MAX_PENDING_LOG_BUFFER,
} from './lib/logStore';

// 多行日志（异常堆栈等）在列表里整条铺开，每条高度 = 文本行数 × LOG_LINE_HEIGHT + 垂直内边距。
// 行数按 message 的换行数确定性计算（WeakMap 缓存，条目不可变，避免重复计算），
// 供变高虚拟滚动用——高度可预测，无需测量 DOM。
const logEntryLineCounts = new WeakMap<LogEntry, number>();
const getLogEntryLineCount = (log: LogEntry): number => {
  const cached = logEntryLineCounts.get(log);
  if (cached !== undefined) return cached;
  let lines = 1;
  const message = log.message;
  for (let i = 0; i < message.length; i++) {
    if (message.charCodeAt(i) === 10) lines++;
  }
  logEntryLineCounts.set(log, lines);
  return lines;
};
const getLogRowHeight = (log: LogEntry): number =>
  getLogEntryLineCount(log) * LOG_LINE_HEIGHT + (LOG_ROW_HEIGHT - LOG_LINE_HEIGHT);

const isLikelyPicoDevice = (device: DeviceInfo | null): boolean => {
  const identity = [device?.manufacturer, device?.name, device?.model, device?.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return identity.includes('pico') || identity.includes('a9210') || identity.includes('sparrow');
};

type TabType = 'devices' | 'logs' | 'performance' | 'network' | 'mirror' | 'weaknet';
type LogLevelFilter = LogEntry['level'] | 'all';
type ApkInstallStatus = 'queued' | 'installing' | 'success' | 'failed';

type ApkInstallQueueItem = {
  id: string;
  path: string;
  fileName: string;
  status: ApkInstallStatus;
  progress: number;
  output?: string;
  error?: string;
};

type DeviceApkInstallState = {
  queue: ApkInstallQueueItem[];
  isInstalling: boolean;
};

const DEVICE_NAME_STORAGE_KEY = 'android-device-monitor.custom-device-names';

const loadStoredDeviceNames = (): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  try {
    const rawValue = window.localStorage.getItem(DEVICE_NAME_STORAGE_KEY);
    if (!rawValue) return {};
    const parsedValue = JSON.parse(rawValue);
    return parsedValue && typeof parsedValue === 'object' ? parsedValue : {};
  } catch {
    return {};
  }
};

const saveStoredDeviceNames = (names: Record<string, string>) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEVICE_NAME_STORAGE_KEY, JSON.stringify(names));
};

const formatOperationError = <T,>(result: ElectronResult<T>, fallbackMessage: string) => {
  const baseMessage = result.error || fallbackMessage;
  return result.hint ? `${baseMessage} ${result.hint}` : baseMessage;
};

const getDeviceStatusMeta = (status: DeviceInfo['status']) => {
  switch (status) {
    case 'connected':
      return { label: '已连接', color: '#22c55e', background: '#22c55e22' };
    case 'offline':
      return { label: '离线', color: '#f59e0b', background: '#f59e0b22' };
    case 'unauthorized':
      return { label: '未授权', color: '#ef4444', background: '#ef444422' };
    default:
      return { label: '已断开', color: '#9ca3af', background: '#9ca3af22' };
  }
};

const getWifiLatencyLabel = (device: DeviceInfo) => {
  if (device.connectionType !== 'wifi') return null;
  if (device.latencyStatus === 'ok' && device.latencyMs !== undefined) {
    return `延迟 ${device.latencyMs}ms`;
  }
  if (device.latencyStatus === 'timeout') {
    return '连接不稳';
  }
  return '延迟 --';
};

const getBatteryColor = (batteryLevel?: number) => {
  if (batteryLevel === undefined) return '#9ca3af';
  if (batteryLevel <= 20) return '#ef4444';
  if (batteryLevel <= 40) return '#f59e0b';
  return '#22c55e';
};

const renderBatteryBadge = (device: DeviceInfo) => {
  const batteryLevel = device.batteryLevel;
  const batteryColor = getBatteryColor(batteryLevel);
  const batteryFill = batteryLevel === undefined ? 0 : batteryLevel;

  return (
    <div data-tip={batteryLevel === undefined ? '电量未知' : `电量 ${batteryLevel}%`} style={{ display: 'flex', alignItems: 'center', gap: '5px', color: batteryColor, fontSize: '12px', lineHeight: 1 }}>
      <div style={{ width: '22px', height: '11px', border: `1px solid ${batteryColor}`, borderRadius: '3px', padding: '1px', position: 'relative', boxSizing: 'border-box' }}>
        <div style={{ width: `${batteryFill}%`, height: '100%', backgroundColor: batteryColor, borderRadius: '1px' }} />
        <div style={{ position: 'absolute', right: '-4px', top: '3px', width: '2px', height: '5px', backgroundColor: batteryColor, borderRadius: '0 2px 2px 0' }} />
      </div>
      <span>{batteryLevel === undefined ? '--%' : `${batteryLevel}%`}</span>
    </div>
  );
};

// 屏幕状态徽标：唤醒（亮绿点）/息屏（暗灰点）/未知。仅已连接且拿到状态时显示。
const renderScreenStateBadge = (device: DeviceInfo) => {
  if (device.status !== 'connected' || !device.screenState) return null;
  const meta =
    device.screenState === 'on'
      ? { label: '唤醒', color: '#22c55e', dot: '#22c55e', glow: true }
      : device.screenState === 'off'
        ? { label: '息屏', color: '#9ca3af', dot: '#6b7280', glow: false }
        : { label: '未知', color: '#9ca3af', dot: '#6b7280', glow: false };
  return (
    <span data-tip={`屏幕状态：${meta.label}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: meta.color, lineHeight: 1 }}>
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: meta.dot, boxShadow: meta.glow ? '0 0 5px #22c55e' : 'none', flexShrink: 0 }} />
      {meta.label}
    </span>
  );
};

// 复用的空集合：作为「该设备暂无 NEW」的稳定默认值，避免每次渲染新建 Set。
const EMPTY_PACKAGE_SET: Set<string> = new Set();

function SimpleApp() {
  const [adbStatus, setAdbStatus] = useState<AdbStatus | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // 工具是否初始化完成（IPC 就绪 + 初始数据加载 + 事件订阅完毕）。未就绪时全屏「启动中」遮罩挡住所有操作。
  const [appReady, setAppReady] = useState(false);
  // 应用版本号（显示在标题栏，便于确认是否已更新到最新版）。
  const [appVersion, setAppVersion] = useState<string>('');
  // 更新日志弹窗：点版本号查看本版本更新内容（来自打进安装包的 release-notes.md）。
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const [releaseNotesText, setReleaseNotesText] = useState<string>('');
  // 手动「检查更新」：ref 标记本次为手动触发（后台检查静默，手动检查要给「已是最新/失败」反馈）。
  const manualCheckRef = useRef(false);
  const [checkResult, setCheckResult] = useState<string>('');
  const lastCheckAtRef = useRef(0); // 上次点检查更新的时间戳，做 0.5s 冷却防狂点刷爆服务器
  // 自动更新状态（来自主进程 electron-updater 事件），驱动右下角更新提示条。
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  // 点「安装并重启」后显示全屏「正在安装…」遮罩，随后退出安装（文件被锁需退出后由 NSIS 替换）。
  const [installing, setInstalling] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [customDeviceNames, setCustomDeviceNames] = useState<Record<string, string>>(() => loadStoredDeviceNames());
  const [activeTab, setActiveTab] = useState<TabType>('devices');
  // 侧边设备栏折叠：收起后宽度归零，主内容（含性能曲线）自动占满腾出的横向空间。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mirrorSessionsByDeviceId, setMirrorSessionsByDeviceId] = useState<Record<string, MirrorSession>>({});
  const [mirrorStartingDeviceIds, setMirrorStartingDeviceIds] = useState<Set<string>>(new Set());
  const [weakNetStatus, setWeakNetStatus] = useState<WeakNetworkHelperStatus>('not-installed');
  const [weakNetPackages, setWeakNetPackages] = useState<string[]>([]);
  const [weakNetLoadingPackages, setWeakNetLoadingPackages] = useState(false);
  const [weakNetBusy, setWeakNetBusy] = useState(false);
  const [weakNetError, setWeakNetError] = useState<string | null>(null);
  // 实时流量（上下行速率 + 累计字节，由 tun 计数差值算出）；弱网未运行时为 null。
  const [weakNetTraffic, setWeakNetTraffic] = useState<{ rxBytes: number; txBytes: number; rxRate: number; txRate: number } | null>(null);
  // 流量速率历史（最近若干采样，含时间戳），供面板画曲线图 + CSV 导出。
  const [weakNetTrafficHistory, setWeakNetTrafficHistory] = useState<{ rx: number; tx: number; at: number }[]>([]);
  const weakNetTrafficPrevRef = useRef<{ rxBytes: number; txBytes: number; at: number } | null>(null);
  // 助手整形层实测统计（真实丢包率/RTT）。
  const [weakNetShaperStats, setWeakNetShaperStats] = useState<WeakNetworkShaperStats | null>(null);
  // 启动后 tun 未建起来，推断为「未在头显授予 VPN 权限」的 sticky 标志；运行成功即清除。
  const [weakNetNeedsAuth, setWeakNetNeedsAuth] = useState(false);
  const [logVersion, setLogVersion] = useState(0);
  const [logViewport, setLogViewport] = useState({ scrollTop: 0, height: 320 });
  const [performanceByDeviceId, setPerformanceByDeviceId] = useState<Record<string, PerformanceMetrics>>({});
  const [performanceSamplesByDeviceId, setPerformanceSamplesByDeviceId] = useState<Record<string, PerformanceSample[]>>({});
  const [performanceSessionStartedAtByDeviceId, setPerformanceSessionStartedAtByDeviceId] = useState<Record<string, Date>>({});
  // —— Phase 14 采集会话状态（按设备）——
  // 进行中的采集会话（点开始采集时设入，关闭后移除）；start/stop 异步进行中集合。
  const [activeCaptureByDeviceId, setActiveCaptureByDeviceId] = useState<Record<string, PerformanceCaptureSession>>({});
  const [captureBusyDeviceIds, setCaptureBusyDeviceIds] = useState<Set<string>>(() => new Set());
  const [captureElapsedByDeviceId, setCaptureElapsedByDeviceId] = useState<Record<string, number>>({});
  const [softLimitNoticeByDeviceId, setSoftLimitNoticeByDeviceId] = useState<Record<string, string>>({});
  // 采集回看：归档会话列表（倒序）+ 当前在报告区展示的会话明细（停止采集后或点列表加载）。
  const [captureSessions, setCaptureSessions] = useState<PerformanceCaptureSession[]>([]);
  // 报告区展示的会话明细，按设备隔离：切设备只看该设备自己的报告，不串台。
  const [loadedReportByDeviceId, setLoadedReportByDeviceId] = useState<Record<string, PerformanceCaptureSessionDetail | null>>({});
  const setLoadedReportFor = (deviceId: string, detail: PerformanceCaptureSessionDetail | null) =>
    setLoadedReportByDeviceId((prev) => ({ ...prev, [deviceId]: detail }));
  // 跨所有设备槽位更新匹配某会话的报告（改名/删除/标记保存：该会话可能正被某台设备展示）。
  const mutateLoadedReports = (mutate: (detail: PerformanceCaptureSessionDetail | null) => PerformanceCaptureSessionDetail | null) =>
    setLoadedReportByDeviceId((prev) => {
      let changed = false;
      const next: Record<string, PerformanceCaptureSessionDetail | null> = { ...prev };
      for (const key of Object.keys(next)) {
        const updated = mutate(next[key]);
        if (updated !== next[key]) {
          next[key] = updated;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  const [installedPackages, setInstalledPackages] = useState<string[]>([]);
  const [installedPackagesLoading, setInstalledPackagesLoading] = useState(false);
  const [appFilter, setAppFilter] = useState('');
  // 当前设备上在运行的应用包名集合：用于已安装列表标「运行中」并禁止重复启动。轮询刷新，反映真实状态。
  const [runningPackages, setRunningPackages] = useState<Set<string>>(new Set());
  // 刚通过工具新装上的包名，按设备分别存（批量装多台时切设备查看各自的 NEW，互不清除）。
  // 每台设备在自己安装前后各拉一次包列表 diff 得到，与「当前选中设备」无关。
  const [newlyInstalledByDevice, setNewlyInstalledByDevice] = useState<Record<string, Set<string>>>({});
  const [busyPackage, setBusyPackage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'launch' | 'stop' | 'uninstall' | null>(null);
  // 应用内确认弹窗：取代原生 window.confirm —— 后者在 Electron 渲染层关闭后会让网页文档丢键盘焦点，
  // 导致弹窗取消/确认后输入框（如「搜索包名」）点进去敲不了字。用受控 React 弹窗彻底规避。
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    confirmText: string;
    danger: boolean;
    onConfirm: () => void;
  } | null>(null);
  const requestConfirm = useCallback(
    (opts: { message: string; confirmText?: string; danger?: boolean; onConfirm: () => void }) => {
      setConfirmDialog({
        message: opts.message,
        confirmText: opts.confirmText || '确定',
        danger: opts.danger ?? false,
        onConfirm: opts.onConfirm,
      });
    },
    []
  );
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [selectedNetworkRequestId, setSelectedNetworkRequestId] = useState<string | null>(null);
  const [runningLogDeviceIds, setRunningLogDeviceIds] = useState<Set<string>>(() => new Set());
  const [wifiIp, setWifiIp] = useState('');
  // 历史 WiFi 设备（快速重连）。初始从 localStorage 读取，已按最近连接时间倒序。
  const [historyDevices, setHistoryDevices] = useState<HistoryDevice[]>(() => loadHistoryDevices());
  // 正在快速连接的历史卡片 serialNo（连接中按钮禁用 + 即时反馈）。
  const [quickConnectingSerial, setQuickConnectingSerial] = useState<string | null>(null);
  // 快速连接失败（IP 变更）时，就地展开 IP 输入框的卡片 serialNo 及其输入值。
  const [inlineEditSerial, setInlineEditSerial] = useState<string | null>(null);
  const [inlineEditValue, setInlineEditValue] = useState('');
  // 历史卡片的失败提示，按 serialNo 区分，避免污染顶部全局错误条。
  const [historyErrorBySerial, setHistoryErrorBySerial] = useState<Record<string, string>>({});
  // 移除历史的行内二次确认态（与设备卡片断开/重启确认同款交互）。
  const [confirmRemoveSerial, setConfirmRemoveSerial] = useState<string | null>(null);
  const [showPairForm, setShowPairForm] = useState(false);
  const [pairAddress, setPairAddress] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [packageFilter, setPackageFilter] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  // 日志搜索关键字历史：重启工具仍在，可在搜索框下拉直接选。
  const [searchHistory, setSearchHistory] = useState<string[]>(() => loadSearchHistory());
  // 自定义历史下拉的显隐（不用原生 datalist，以统一暗色 UI 风格）。
  const [showSearchHistory, setShowSearchHistory] = useState(false);
  const [filterLevel, setFilterLevel] = useState<LogLevelFilter>('all');
  const [logTagFilter, setLogTagFilter] = useState('');
  const [logPackageFilter, setLogPackageFilter] = useState('');
  // 包名过滤下拉（可主动输入 + 选当前设备已装应用）的显隐。
  const [showLogPackageDropdown, setShowLogPackageDropdown] = useState(false);
  const [logPidFilter, setLogPidFilter] = useState('');
  const [useRegexSearch, setUseRegexSearch] = useState(false);
  const [pausedLogDeviceIds, setPausedLogDeviceIds] = useState<Set<string>>(() => new Set());
  const [selectedLogEntry, setSelectedLogEntry] = useState<LogEntry | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [maxLogEntries, setMaxLogEntries] = useState(MAX_LOG_ENTRIES);
  const [batchUpdateSize, setBatchUpdateSize] = useState(BATCH_UPDATE_SIZE);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [apkInstallStates, setApkInstallStates] = useState<Record<string, DeviceApkInstallState>>({});
  const [pendingApks, setPendingApks] = useState<{ path: string; fileName: string }[]>([]);
  const [isApkDragOver, setIsApkDragOver] = useState(false); // 拖拽 APK 到待安装区时高亮
  // 安装过程日志：每条带时间戳，最新在上。展示在「安装详情」模块里。
  const [installLog, setInstallLog] = useState<{ text: string; level: 'info' | 'success' | 'error' }[]>([]);
  const [installTargets, setInstallTargets] = useState<Set<string>>(new Set());
  const [installConcurrency, setInstallConcurrency] = useState(4);
  const [installAllowDowngrade, setInstallAllowDowngrade] = useState(false);
  const [isUnifiedInstalling, setIsUnifiedInstalling] = useState(false);
  const [busyDeviceAction, setBusyDeviceAction] = useState<{ id: string; action: 'sleep' | 'wake' | 'unlock' | 'reboot' } | null>(null);
  const [fileBrowserDevice, setFileBrowserDevice] = useState<DeviceInfo | null>(null);
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);
  // 重启是高风险操作，点击后进入行内二次确认态（与断开确认互斥，避免同卡片同时弹两个确认）
  const [confirmRebootId, setConfirmRebootId] = useState<string | null>(null);
  // 最近一次导出日志保存到 PC 的路径，用于「打开所在文件夹」快捷按钮
  const [lastExportedLogPath, setLastExportedLogPath] = useState<string | null>(null);
  // 最近一次导出采集会话 zip 到 PC 的路径，用于「打开位置」快捷按钮（导出回看后立即定位）
  const [lastExportedCapturePath, setLastExportedCapturePath] = useState<string | null>(null);
  
  const logStatesRef = useRef(new Map<string, DeviceLogState>());
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const selectedDeviceRef = useRef<DeviceInfo | null>(null);
  const maxLogEntriesRef = useRef(MAX_LOG_ENTRIES);
  const batchUpdateSizeRef = useRef(BATCH_UPDATE_SIZE);
  const apkInstallProgressTimersRef = useRef(new Map<string, number>());

  const resetDeviceRuntimeState = useCallback(() => {
    setSelectedDevice(null);
    logStatesRef.current.forEach(state => {
      state.running = false;
      state.paused = false;
    });
    setRunningLogDeviceIds(new Set());
    setPausedLogDeviceIds(new Set());
    setLogVersion(version => version + 1);
  }, []);

  const getDeviceDisplayName = useCallback((device: DeviceInfo) => {
    const customName = customDeviceNames[device.id]?.trim();
    return customName || device.name || device.model || device.id;
  }, [customDeviceNames]);

  // 列表/日志里用的显示名：基名相同（如两台都改成同一自定义名）时补区分符，避免分不清是哪台。
  // WiFi 用 IP，USB 用 SN 尾号；都取不到就退回设备 id。
  const getDeviceLabel = useCallback((device: DeviceInfo) => {
    const base = getDeviceDisplayName(device);
    const collision = devices.some((d) => d.id !== device.id && getDeviceDisplayName(d) === base);
    if (!collision) return base;
    const snTail = device.serialNo && device.serialNo !== 'Unknown' ? device.serialNo.slice(-4) : '';
    const distinguisher = device.connectionType === 'wifi'
      ? ((device.id || '').split(':')[0] || snTail || device.id)
      : (snTail || device.id);
    return `${base}（${distinguisher}）`;
  }, [getDeviceDisplayName, devices]);

  const updateCustomDeviceName = useCallback((deviceId: string, value: string) => {
    setCustomDeviceNames(prev => {
      const next = { ...prev };
      if (value.trim()) {
        next[deviceId] = value;
      } else {
        delete next[deviceId];
      }
      saveStoredDeviceNames(next);
      return next;
    });
  }, []);

  const getDeviceApkInstallState = useCallback((deviceId: string): DeviceApkInstallState => {
    return apkInstallStates[deviceId] || { queue: [], isInstalling: false };
  }, [apkInstallStates]);

  const updateDeviceApkInstallState = useCallback((deviceId: string, updater: (state: DeviceApkInstallState) => DeviceApkInstallState) => {
    setApkInstallStates(previousStates => ({
      ...previousStates,
      [deviceId]: updater(previousStates[deviceId] || { queue: [], isInstalling: false }),
    }));
  }, []);

  const stopApkInstallProgressTimer = useCallback((itemId: string) => {
    const timerId = apkInstallProgressTimersRef.current.get(itemId);
    if (timerId !== undefined) {
      window.clearInterval(timerId);
      apkInstallProgressTimersRef.current.delete(itemId);
    }
  }, []);

  const startApkInstallProgressTimer = useCallback((deviceId: string, itemId: string) => {
    stopApkInstallProgressTimer(itemId);
    const timerId = window.setInterval(() => {
      updateDeviceApkInstallState(deviceId, previousState => ({
        ...previousState,
        queue: previousState.queue.map(item => {
          if (item.id !== itemId || item.status !== 'installing') return item;
          const nextProgress = item.progress < 70
            ? item.progress + 6
            : item.progress < 90
              ? item.progress + 2
              : item.progress < 96
                ? item.progress + 0.5
                : item.progress;
          return { ...item, progress: Math.min(nextProgress, 96) };
        }),
      }));
    }, 800);
    apkInstallProgressTimersRef.current.set(itemId, timerId);
  }, [stopApkInstallProgressTimer, updateDeviceApkInstallState]);

  const getLogState = useCallback((deviceId: string) => {
    let state = logStatesRef.current.get(deviceId);
    if (!state) {
      state = createDeviceLogState(maxLogEntriesRef.current);
      logStatesRef.current.set(deviceId, state);
    }
    return state;
  }, []);

  const clearDeviceLogs = useCallback((deviceId: string) => {
    const state = getLogState(deviceId);
    if (state.flushTimer !== null) {
      window.clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.store.clear();
    state.buffer = [];
    state.updateScheduled = false;
    setSelectedLogEntry(current => current?.deviceId === deviceId ? null : current);
    setLogVersion(version => version + 1);
  }, [getLogState]);

  const removeDeviceLogState = useCallback((deviceId: string) => {
    const state = logStatesRef.current.get(deviceId);
    if (state?.flushTimer !== null && state?.flushTimer !== undefined) {
      window.clearTimeout(state.flushTimer);
    }
    logStatesRef.current.delete(deviceId);
    setRunningLogDeviceIds(prev => {
      const next = new Set(prev);
      next.delete(deviceId);
      return next;
    });
    setPausedLogDeviceIds(prev => {
      const next = new Set(prev);
      next.delete(deviceId);
      return next;
    });
    setSelectedLogEntry(current => current?.deviceId === deviceId ? null : current);
    setLogVersion(version => version + 1);
  }, []);

  const reconcileLogStatesWithDevices = useCallback((nextDevices: DeviceInfo[]) => {
    const nextDeviceIds = new Set(nextDevices.map(device => device.id));
    for (const deviceId of logStatesRef.current.keys()) {
      if (!nextDeviceIds.has(deviceId)) {
        const state = logStatesRef.current.get(deviceId);
        if (state?.flushTimer !== null && state?.flushTimer !== undefined) {
          window.clearTimeout(state.flushTimer);
        }
        logStatesRef.current.delete(deviceId);
      }
    }

    setRunningLogDeviceIds(prev => {
      const next = new Set<string>();
      prev.forEach(deviceId => {
        if (nextDeviceIds.has(deviceId)) next.add(deviceId);
      });
      return next;
    });
    setPausedLogDeviceIds(prev => {
      const next = new Set<string>();
      prev.forEach(deviceId => {
        if (nextDeviceIds.has(deviceId)) next.add(deviceId);
      });
      return next;
    });
    setSelectedLogEntry(current => current && nextDeviceIds.has(current.deviceId) ? current : null);
    setLogVersion(version => version + 1);
  }, []);

  const applyDeviceList = useCallback((nextDevices: DeviceInfo[]) => {
    // 稳定排序：避免后端数据源（Map values / Promise.all resolve 顺序）变化导致卡片位置跳动。
    // 规则：USB 在前、WiFi 在后，同类按设备 id 字典序。
    const sortedDevices = [...nextDevices].sort((a, b) => {
      if (a.connectionType !== b.connectionType) {
        return a.connectionType === 'usb' ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });
    setDevices(sortedDevices);
    reconcileLogStatesWithDevices(sortedDevices);
    if (nextDevices.length > 0) {
      setSelectedDevice(currentSelectedDevice => {
        if (currentSelectedDevice && nextDevices.find(device => device.id === currentSelectedDevice.id)) {
          return nextDevices.find(device => device.id === currentSelectedDevice.id) || currentSelectedDevice;
        }
        return nextDevices[0];
      });
      return;
    }

    resetDeviceRuntimeState();
  }, [reconcileLogStatesWithDevices, resetDeviceRuntimeState]);

  useEffect(() => {
    selectedDeviceRef.current = selectedDevice;
  }, [selectedDevice]);

  useEffect(() => {
    maxLogEntriesRef.current = maxLogEntries;
    logStatesRef.current.forEach(state => state.store.setLimit(maxLogEntries));
    setLogVersion(version => version + 1);
  }, [maxLogEntries]);

  useEffect(() => {
    batchUpdateSizeRef.current = batchUpdateSize;
  }, [batchUpdateSize]);

  const flushDeviceLogBuffer = useCallback((deviceId: string) => {
    const state = logStatesRef.current.get(deviceId);
    if (!state) return;
    const buffer = state.buffer;
    if (buffer.length === 0) {
      state.updateScheduled = false;
      state.flushTimer = null;
      return;
    }
    
    state.store.append(buffer);
    setLogVersion(version => version + 1);
    
    state.buffer = [];
    state.updateScheduled = false;
    state.flushTimer = null;
  }, []);

  const enqueueLogEntries = useCallback((entries: LogEntry[]) => {
    if (entries.length === 0) {
      return;
    }

    const entriesByDevice = new Map<string, LogEntry[]>();
    for (const entry of entries) {
      if (!entry.deviceId) continue;
      const deviceEntries = entriesByDevice.get(entry.deviceId) || [];
      deviceEntries.push(entry);
      entriesByDevice.set(entry.deviceId, deviceEntries);
    }

    entriesByDevice.forEach((deviceEntries, deviceId) => {
      const state = getLogState(deviceId);
      if (state.paused) return;

      state.buffer = [...state.buffer, ...deviceEntries].slice(-MAX_PENDING_LOG_BUFFER);

      if (state.buffer.length >= batchUpdateSizeRef.current) {
        if (state.flushTimer !== null) {
          window.clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        flushDeviceLogBuffer(deviceId);
        return;
      }

      if (!state.updateScheduled) {
        state.updateScheduled = true;
        state.flushTimer = window.setTimeout(() => flushDeviceLogBuffer(deviceId), BATCH_UPDATE_DELAY);
      }
    });
  }, [flushDeviceLogBuffer, getLogState]);

  useEffect(() => {
    const initApp = async () => {
      await Promise.all([loadAdbStatus(), loadDevices()]);
      
      if (hasElectronAPI()) {
        const unsubscribeAdbStatusChanged = window.electronAPI!.onAdbStatusChanged((status) => {
          setAdbStatus(status);
        });
        const unsubscribeDeviceListChanged = window.electronAPI!.onDeviceListChanged((nextDevices) => {
          applyDeviceList(nextDevices);
        });
        const unsubscribeDeviceConnected = window.electronAPI!.onDeviceConnected((device) => {
          setDevices(prev => {
            if (prev.some(existingDevice => existingDevice.id === device.id)) {
              return prev;
            }
            return [...prev, device];
          });
        });
        
        const unsubscribeDeviceDisconnected = window.electronAPI!.onDeviceDisconnected((deviceId) => {
          setDevices(prev => {
            const nextDevices = prev.filter(d => d.id !== deviceId);
            if (selectedDeviceRef.current?.id === deviceId) {
              setSelectedDevice(nextDevices[0] || null);
            }
            return nextDevices;
          });
          removeDeviceLogState(deviceId);
          // 设备断开：清掉它的「NEW」记录（设备没了，标识也无意义，顺便不留过期数据）。
          setNewlyInstalledByDevice((prev) => {
            if (!(deviceId in prev)) return prev;
            const next = { ...prev };
            delete next[deviceId];
            return next;
          });
        });
        
        const unsubscribeLogEntry = window.electronAPI!.onLogEntry((entry) => {
          enqueueLogEntries([entry]);
        });
        const unsubscribeLogBatch = window.electronAPI!.onLogBatch((entries) => {
          enqueueLogEntries(entries);
        });
        const unsubscribeUpdateStatus = window.electronAPI!.onUpdateStatus((status) => {
          setUpdateStatus(status);
          if (status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded') {
            setUpdateDismissed(false); // 有实质更新动作时重新弹出提示
          }
          // 手动检查时给按钮旁文字反馈（后台检查不反馈，保持静默）。
          if (manualCheckRef.current) {
            if (status.state === 'checking') {
              setCheckResult('检查中…');
            } else if (status.state === 'not-available') {
              manualCheckRef.current = false;
              setCheckResult('已是最新版本');
              window.setTimeout(() => setCheckResult(''), 4000);
            } else if (status.state === 'error') {
              manualCheckRef.current = false;
              setCheckResult('检查失败，请确认更新服务器');
              window.setTimeout(() => setCheckResult(''), 5000);
            } else {
              manualCheckRef.current = false;
              setCheckResult(''); // available/downloading/downloaded → 交给提示框展示
            }
          }
        });
        // 启动即拉取主进程已知的最近更新状态：补回 whenReady 那次自动检查因 push 早于本订阅而丢失的提示，
        // 实现「打开工具就自动提示有新版本」，无需手动点「检查更新」。后台拉取，不走手动反馈（不弹「已是最新」）。
        void window.electronAPI!.getUpdateStatus?.().then((res) => {
          const status = res?.success ? res.data : null;
          if (!status) return;
          setUpdateStatus(status);
          if (status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded') {
            setUpdateDismissed(false);
          }
        }).catch(() => undefined);
        const unsubscribeMirrorStatus = window.electronAPI!.onMirrorStatus((session) => {
          setMirrorSessionsByDeviceId(prev => ({ ...prev, [session.deviceId]: session }));
          setMirrorStartingDeviceIds(prev => {
            if (!prev.has(session.deviceId)) return prev;
            const next = new Set(prev);
            next.delete(session.deviceId);
            return next;
          });
        });
        // 采集中实时样本：主进程每秒推一条，累积到该设备样本缓冲（供实时曲线 + 关闭后报告），
        // 同时刷新指标卡与已用时长。上限 7200 条（约 2 小时）防长采集内存膨胀。
        const unsubscribeCaptureSample = window.electronAPI!.onCaptureSample((payload) => {
          setPerformanceByDeviceId(prev => ({ ...prev, [payload.deviceId]: payload.sample.metrics }));
          setPerformanceSamplesByDeviceId(prev => ({
            ...prev,
            [payload.deviceId]: [
              ...(prev[payload.deviceId] || []),
              { ...payload.sample, capturedAt: new Date(payload.sample.capturedAt) },
            ].slice(-7200),
          }));
          setCaptureElapsedByDeviceId(prev => ({ ...prev, [payload.deviceId]: payload.elapsedMs }));
        });
        const unsubscribeCaptureSizeLimit = window.electronAPI!.onCaptureSizeLimit((payload) => {
          const text = payload.reason === 'duration'
            ? '本次采集已录制 30 分钟，可继续，也可手动关闭采集。'
            : '本次采集录屏已达 2GB，可继续，也可手动关闭采集。';
          setSoftLimitNoticeByDeviceId(prev => ({ ...prev, [payload.deviceId]: text }));
        });

        // 初始数据加载完、所有 IPC 事件订阅就绪 → 标记 app 就绪，撤掉「启动中」遮罩，放开操作。
        setAppReady(true);

        return () => {
          unsubscribeAdbStatusChanged();
          unsubscribeDeviceListChanged();
          unsubscribeDeviceConnected();
          unsubscribeDeviceDisconnected();
          unsubscribeLogEntry();
          unsubscribeLogBatch();
          unsubscribeMirrorStatus();
          unsubscribeCaptureSample();
          unsubscribeCaptureSizeLimit();
          unsubscribeUpdateStatus();
          logStatesRef.current.forEach(state => {
            if (state.flushTimer !== null) {
              window.clearTimeout(state.flushTimer);
            }
          });
          apkInstallProgressTimersRef.current.forEach(timerId => window.clearInterval(timerId));
          apkInstallProgressTimersRef.current.clear();
        };
      }
      setAppReady(true); // 无 Electron（纯网页环境）也放开操作
    };

    const cleanupPromise = initApp();
    return () => {
      cleanupPromise.then((cleanup) => {
        if (cleanup) cleanup();
      });
    };
  }, [applyDeviceList, enqueueLogEntries, removeDeviceLogState]);

  // 启动时取一次应用版本号，显示在标题栏，便于确认是否已更新到最新版。
  useEffect(() => {
    if (!hasElectronAPI() || !window.electronAPI?.getAppVersion) return;
    void window.electronAPI.getAppVersion().then((result) => {
      if (result.success && result.data) setAppVersion(result.data);
    });
  }, []);

  // 全局拖拽守卫：拦掉窗口默认的「拖入文件即导航到 file://」行为——否则把 APK 拖偏到拖放区之外，
  // 整个界面会被替换成该文件，体验崩坏。真正的接收逻辑在待安装拖放区里单独处理。
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // 安全兜底：万一初始化某步卡住，最多 15 秒后也撤掉「启动中」遮罩，避免永久锁死。
  useEffect(() => {
    const timer = window.setTimeout(() => setAppReady(true), 15000);
    return () => window.clearTimeout(timer);
  }, []);

  // 手动检查更新：标记为手动触发并显示「检查中…」，结果由 onUpdateStatus 回调据 manualCheckRef 给反馈。
  const handleCheckUpdate = async () => {
    if (!hasElectronAPI() || !window.electronAPI?.checkForUpdate) return;
    // 0.5s 冷却 + 上次检查未出结果时忽略：防止狂点把更新服务器刷爆。
    const now = Date.now();
    if (now - lastCheckAtRef.current < 500 || manualCheckRef.current) return;
    lastCheckAtRef.current = now;
    manualCheckRef.current = true;
    setCheckResult('检查中…');
    setUpdateDismissed(false);
    try {
      await window.electronAPI.checkForUpdate();
    } catch {
      manualCheckRef.current = false;
      setCheckResult('检查失败');
    }
  };

  // 点版本号：读取本版本更新日志（打进安装包的 release-notes.md）并弹窗展示。
  const openReleaseNotes = async () => {
    if (hasElectronAPI() && window.electronAPI?.getReleaseNotes) {
      const result = await window.electronAPI.getReleaseNotes();
      setReleaseNotesText(result.success && result.data ? result.data : '');
    }
    setShowReleaseNotes(true);
  };



  // 采集中的指标采样由主进程编排（PerformanceCaptureController 每秒一次），经 onCaptureSample
  // 实时推送到渲染层，渲染层不再自行轮询 getPerformance。

  // 采集回看列表加载（进性能页时 + 停止/删除/改名后各自刷新）。
  const refreshCaptureSessions = useCallback(async () => {
    if (!hasElectronAPI()) return;
    const result = await window.electronAPI!.listCaptureSessions();
    if (result.success && result.data) setCaptureSessions(result.data);
  }, []);

  useEffect(() => {
    if (activeTab === 'performance') void refreshCaptureSessions();
  }, [activeTab, refreshCaptureSessions]);

  // 挂载时与主进程对齐进行中的采集：渲染层重载 / 崩溃 / 手动刷新窗口后，主进程的采集会话仍在跑，
  // 而渲染态被重置成「未采集」——会导致点开始撞「已在采集中」死锁。这里恢复采集中状态、起始时间、
  // 已用时长，并回填已累积样本（复用 loadCaptureSession，samples.jsonl 逐行容错可中途读取），
  // 之后实时 CAPTURE_SAMPLE 继续累加。
  useEffect(() => {
    if (!hasElectronAPI()) return;
    void (async () => {
      const result = await window.electronAPI!.getActiveCaptureSessions();
      if (!result.success || !result.data) return;
      for (const { deviceId, session, elapsedMs } of result.data) {
        setActiveCaptureByDeviceId((prev) => (prev[deviceId] ? prev : { ...prev, [deviceId]: session }));
        setPerformanceSessionStartedAtByDeviceId((prev) => ({ ...prev, [deviceId]: new Date(session.startedAt) }));
        setCaptureElapsedByDeviceId((prev) => ({ ...prev, [deviceId]: elapsedMs }));
        const detail = await window.electronAPI!.loadCaptureSession(session.id);
        if (detail.success && detail.data) {
          const restored = detail.data.samples;
          // 仅当磁盘历史比当前内存更全时回填，避免覆盖掉对齐期间已到达的实时样本。
          setPerformanceSamplesByDeviceId((prev) => (restored.length > (prev[deviceId]?.length ?? 0) ? { ...prev, [deviceId]: restored } : prev));
        }
      }
    })();
  }, []);

  // 进入「弱网」标签或切换设备时拉取一次，并定时轮询助手状态 + 隧道流量（每 2.5s）。
  useEffect(() => {
    if (!(selectedDevice && activeTab === 'weaknet')) {
      return;
    }
    setWeakNetError(null);
    setWeakNetNeedsAuth(false);
    weakNetTrafficPrevRef.current = null;
    setWeakNetTraffic(null);
    setWeakNetTrafficHistory([]);
    setWeakNetShaperStats(null);
    void loadWeakNetStatus();
    void loadWeakNetPackages();
    void loadWeakNetTraffic();
    void loadWeakNetShaperStats();
    const timer = setInterval(() => {
      void loadWeakNetStatus();
      void loadWeakNetTraffic();
      void loadWeakNetShaperStats();
    }, 2500);
    return () => clearInterval(timer);
    // 依赖用 selectedDevice?.id 而非 selectedDevice 对象：设备监控每次轮询都会生成新的
    // DeviceInfo 对象（同一台设备、新引用），若依赖对象本身，effect 会被反复重建并清空
    // weakNetTrafficHistory，导致流量折线图频繁消失重建（闪烁）。只在真正切换设备时重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.id, activeTab]);

  // 已安装应用列表只在设备连接（id 变化）时获取一次，避免设备轮询导致的频繁刷新；
  // 卸载 / 安装完成后单独触发刷新，其余情况由用户手动点刷新。
  useEffect(() => {
    // 切设备只是切换显示哪台，NEW 按设备存（newlyInstalledByDevice），不清除——否则批量装多台后切看就丢标识。
    if (selectedDevice?.id) {
      setInstalledPackages([]);
      setAppFilter('');
      loadInstalledPackages();
    } else {
      setInstalledPackages([]);
      setAppFilter('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.id]);

  // 轮询当前设备「运行中」应用：仅设备页 + 设备已连接时，每 4s 刷新，让运行标识反映真实状态
  //（不管谁启动的）。离开设备页 / 切设备 / 断开即清空，避免显示过期运行态。
  useEffect(() => {
    const deviceId = selectedDevice?.id;
    if (!deviceId || selectedDevice?.status !== 'connected' || activeTab !== 'devices') {
      setRunningPackages(new Set());
      return;
    }
    void loadRunningPackages();
    const timer = window.setInterval(() => { void loadRunningPackages(); }, 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.id, selectedDevice?.status, activeTab]);

  useEffect(() => {
    setSelectedNetworkRequestId(null);
    if (!selectedDevice) {
      setNetworkRequests([]);
    }
  }, [selectedDevice]);

  

  const loadAdbStatus = async () => {
    if (!hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.getAdbStatus();
      if (result.success && result.data) {
        setAdbStatus(result.data);
        if (result.data.available && error.includes('ADB')) {
          setError('');
        }
      } else {
        setAdbStatus({
          available: false,
          version: null,
          path: null,
          message: formatOperationError(result, '获取 ADB 状态失败'),
          checkedAt: Date.now(),
          code: result.code,
          hint: result.hint,
        });
      }
    } catch (err) {
      setAdbStatus({
        available: false,
        version: null,
        path: null,
        message: '获取 ADB 状态失败',
        checkedAt: Date.now(),
      });
    }
  };

  const loadDevices = async () => {
    if (!hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.getDevices();
      if (result.success && result.data) {
        applyDeviceList(result.data);
        setError('');
      } else {
        setDevices([]);
        resetDeviceRuntimeState();
        setError(formatOperationError(result, '\u52a0\u8f7d\u8bbe\u5907\u5931\u8d25'));
        await loadAdbStatus();
      }
    } catch (err) {
      setDevices([]);
      resetDeviceRuntimeState();
      setError('\u52a0\u8f7d\u8bbe\u5907\u5931\u8d25');
      await loadAdbStatus();
    }
  };

  const connectUSBDevice = async () => {
    if (!hasElectronAPI()) {
      setError('Electron \u63a5\u53e3\u4e0d\u53ef\u7528');
      return;
    }
    try {
      setError('\u6b63\u5728\u5237\u65b0 USB \u8bbe\u5907...');
      const result = await window.electronAPI!.connectUSB();
      if (result.success && result.data) {
        applyDeviceList(result.data);
        setError('');
        await loadAdbStatus();
      } else {
        setError(formatOperationError(result, 'USB \u8bbe\u5907\u5237\u65b0\u5931\u8d25'));
        await loadAdbStatus();
      }
    } catch (err) {
      setError('USB \u8bbe\u5907\u5237\u65b0\u5931\u8d25\uff1a' + (err as Error).message);
      await loadAdbStatus();
    }
  };

  // \u4ec5 WiFi \u6210\u529f\u8fde\u63a5\u624d\u5199\u5386\u53f2\uff1a\u4ece DeviceInfo \u6784\u9020\u8bb0\u5f55\uff0c\u6309 serialNo \u53bb\u91cd upsert \u5e76\u6301\u4e45\u5316\u3002
  // USB \u8bbe\u5907\uff08buildHistoryEntryFromDevice \u8fd4\u56de null\uff09\u548c\u65e0 serialNo \u7684\u8bbe\u5907\u4e0d\u5199\u5165\u3002
  const persistHistoryFromDevice = useCallback((device: DeviceInfo) => {
    const entry = buildHistoryEntryFromDevice(device, getDeviceDisplayName(device), Date.now());
    if (!entry) return;
    setHistoryDevices(prev => {
      const next = upsertHistoryDevice(prev, entry);
      saveHistoryDevices(next);
      return next;
    });
  }, [getDeviceDisplayName]);

  // WiFi \u8fde\u63a5\u6838\u5fc3\uff0c\u4f9b\u9876\u90e8\u8fde\u63a5\u6846\u4e0e\u5386\u53f2\u5361\u7247\u5feb\u901f\u8fde\u63a5/\u5c31\u5730\u91cd\u8fde\u590d\u7528\u3002
  // \u6210\u529f\u65f6\u5199\u5386\u53f2\u5e76\u5237\u65b0\u8bbe\u5907\u5217\u8868\uff0c\u8fd4\u56de\u7ed3\u6784\u5316\u7ed3\u679c\u8ba9\u8c03\u7528\u65b9\u51b3\u5b9a\u63d0\u793a\u4f4d\u7f6e\uff08\u5168\u5c40\u9519\u8bef\u6761 / \u5361\u7247\u5185\uff09\u3002
  const performWifiConnect = useCallback(
    async (address: string): Promise<{ success: boolean; errorMessage?: string }> => {
      if (!hasElectronAPI()) {
        return { success: false, errorMessage: 'Electron \u63a5\u53e3\u4e0d\u53ef\u7528' };
      }
      try {
        const result = await window.electronAPI!.connectWiFi(address);
        if (result.success) {
          if (result.data) persistHistoryFromDevice(result.data);
          await loadAdbStatus();
          await loadDevices();
          return { success: true };
        }
        await loadAdbStatus();
        return { success: false, errorMessage: formatOperationError(result, 'WiFi \u8fde\u63a5\u5931\u8d25') };
      } catch (err) {
        await loadAdbStatus();
        return { success: false, errorMessage: 'WiFi \u8fde\u63a5\u5931\u8d25\uff1a' + (err as Error).message };
      }
    },
    [persistHistoryFromDevice]
  );

  const connectWiFiDevice = async () => {
    if (!wifiIp.trim()) {
      setError('\u8bf7\u8f93\u5165\u8bbe\u5907 IP \u5730\u5740');
      return;
    }
    setError('\u6b63\u5728\u8fde\u63a5...');
    const res = await performWifiConnect(wifiIp.trim());
    if (res.success) {
      setWifiIp('');
      setError('');
    } else {
      setError(res.errorMessage || 'WiFi \u8fde\u63a5\u5931\u8d25');
    }
  };

  const clearHistoryError = useCallback((serialNo: string) => {
    setHistoryErrorBySerial(prev => {
      if (!(serialNo in prev)) return prev;
      const next = { ...prev };
      delete next[serialNo];
      return next;
    });
  }, []);

  // 记录一次搜索关键字到历史（去重置顶 + 持久化）。在搜索框回车或失焦时调用。
  const recordSearchHistory = useCallback((keyword: string) => {
    if (!keyword.trim()) return;
    setSearchHistory(prev => {
      const next = addSearchHistory(prev, keyword);
      saveSearchHistory(next);
      return next;
    });
  }, []);

  // 关闭文件管理：若该设备有文件传输进行中，先确认（关闭后传输仍在后台继续，重开可看回进度）。
  const closeFileBrowser = useCallback(() => {
    if (fileBrowserDevice && isTransferActive(fileBrowserDevice.id)) {
      requestConfirm({
        message: '正在传输文件，确定关闭文件管理吗？\n关闭后传输会在后台继续，重新打开可看到进度。',
        confirmText: '关闭',
        onConfirm: () => setFileBrowserDevice(null),
      });
      return;
    }
    setFileBrowserDevice(null);
  }, [fileBrowserDevice, requestConfirm]);

  // 从历史移除一条关键字。
  const removeOneSearchHistory = useCallback((keyword: string) => {
    setSearchHistory(prev => {
      const next = removeSearchHistory(prev, keyword);
      saveSearchHistory(next);
      return next;
    });
  }, []);

  // 历史下拉里展示的条目：按当前输入做前缀联想（输入为空则全部），排除与输入完全相同的项。
  const visibleSearchHistory = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return searchHistory;
    return searchHistory.filter(item => {
      const lower = item.toLowerCase();
      return lower.includes(query) && lower !== query;
    });
  }, [searchHistory, searchTerm]);

  // \u5386\u53f2\u5361\u7247\u300c\u5feb\u901f\u8fde\u63a5\u300d\uff1a\u7528\u8bb0\u5f55\u7684 lastAddress \u76f4\u63a5\u8fde\u3002\u5931\u8d25\u591a\u534a\u662f\u8bbe\u5907 IP \u53d8\u4e86\uff0c
  // \u5c31\u5730\u5c55\u5f00\u8f93\u5165\u6846\u5e76\u9884\u586b\u4e0a\u6b21\u5730\u5740\u4f9b\u7528\u6237\u4fee\u6539\u540e\u91cd\u8fde\uff0c\u4e0d\u5220\u9664\u5386\u53f2\u8bb0\u5f55\u3002
  const handleQuickConnectHistory = async (item: HistoryDevice) => {
    setQuickConnectingSerial(item.serialNo);
    clearHistoryError(item.serialNo);
    const res = await performWifiConnect(item.lastAddress.trim());
    setQuickConnectingSerial(null);
    if (res.success) {
      setInlineEditSerial(null);
      setInlineEditValue('');
    } else {
      setInlineEditSerial(item.serialNo);
      setInlineEditValue(item.lastAddress);
      setHistoryErrorBySerial(prev => ({
        ...prev,
        [item.serialNo]: res.errorMessage || '\u5feb\u901f\u8fde\u63a5\u5931\u8d25\uff0c\u8bbe\u5907 IP \u53ef\u80fd\u5df2\u53d8\uff0c\u8bf7\u4fee\u6539\u540e\u91cd\u8fde',
      }));
    }
  };

  // \u5c31\u5730\u8f93\u5165\u65b0 IP \u540e\u786e\u8ba4\u91cd\u8fde\uff1a\u6210\u529f\u7528\u65b0\u5730\u5740\u8986\u76d6\u5386\u53f2\uff08performWifiConnect \u5185\u5df2 upsert\uff09\uff0c
  // \u5931\u8d25\u4fdd\u7559\u8f93\u5165\u6846\u4e0e\u5386\u53f2\u8bb0\u5f55\uff0c\u4ec5\u66f4\u65b0\u5361\u7247\u5185\u5931\u8d25\u63d0\u793a\u3002
  const handleInlineReconnectHistory = async (item: HistoryDevice) => {
    const address = inlineEditValue.trim();
    if (!address) {
      setHistoryErrorBySerial(prev => ({ ...prev, [item.serialNo]: '\u8bf7\u8f93\u5165 IP:\u7aef\u53e3' }));
      return;
    }
    setQuickConnectingSerial(item.serialNo);
    clearHistoryError(item.serialNo);
    const res = await performWifiConnect(address);
    setQuickConnectingSerial(null);
    if (res.success) {
      setInlineEditSerial(null);
      setInlineEditValue('');
    } else {
      setHistoryErrorBySerial(prev => ({
        ...prev,
        [item.serialNo]: res.errorMessage || '\u91cd\u8fde\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 IP:\u7aef\u53e3',
      }));
    }
  };

  // \u79fb\u9664\u5386\u53f2\uff1a\u4ec5\u5220\u672c\u5730\u5386\u53f2\u8bb0\u5fc6\uff0c\u4e0d\u5f71\u54cd\u5f53\u524d\u5df2\u5efa\u7acb\u7684\u8fde\u63a5\u3002
  const handleRemoveHistory = (serialNo: string) => {
    setHistoryDevices(prev => {
      const next = removeHistoryDevice(prev, serialNo);
      saveHistoryDevices(next);
      return next;
    });
    setConfirmRemoveSerial(null);
    clearHistoryError(serialNo);
    if (inlineEditSerial === serialNo) {
      setInlineEditSerial(null);
      setInlineEditValue('');
    }
  };

  // 历史卡片在线状态为运行时态，不持久化：用当前已连接设备列表按 serialNo 实时匹配计算。
  const onlineHistorySerials = useMemo(() => {
    const set = new Set<string>();
    devices.forEach(device => {
      const serialNo = device.serialNo?.trim();
      if (serialNo && device.status === 'connected') set.add(serialNo);
    });
    return set;
  }, [devices]);

  // 历史列表只展示当前未连接的设备：已连接的设备上方实时设备卡已呈现，无需在历史里重复。
  // 连接中（尚未进入 devices 已连接态）仍保留在列表，展示「连接中…」；连上后从历史消失，断开/重启后回来。
  const offlineHistoryDevices = useMemo(
    () => historyDevices.filter(item => !onlineHistorySerials.has(item.serialNo)),
    [historyDevices, onlineHistorySerials]
  );

  const pairWiFiDevice = async () => {
    if (!pairAddress.trim()) {
      setError('\u8bf7\u8f93\u5165\u914d\u5bf9\u5730\u5740 IP:\u7aef\u53e3');
      return;
    }
    if (!pairCode.trim()) {
      setError('\u8bf7\u8f93\u5165 6 \u4f4d\u914d\u5bf9\u7801');
      return;
    }
    if (!hasElectronAPI()) {
      setError('Electron \u63a5\u53e3\u4e0d\u53ef\u7528');
      return;
    }

    setPairing(true);
    try {
      setError('\u6b63\u5728\u914d\u5bf9...');
      const result = await window.electronAPI!.pairWiFi(pairAddress, pairCode);
      if (result.success) {
        setError('');
        setPairCode('');
        if (result.data?.alreadyPaired) {
          // \u5df2\u914d\u5bf9\u8fc7\uff1a\u63d0\u793a\u5e76\u628a\u5df2\u8fde\u63a5\u7684 IP:\u7aef\u53e3\u586b\u5165\u4e0a\u65b9 WiFi \u8fde\u63a5\u6846\uff0c\u65b9\u4fbf\u7528\u6237\u76f4\u63a5\u8fde\u63a5
          setSuccess(result.data.message || '\u8be5\u8bbe\u5907\u5df2\u914d\u5bf9\u8fc7');
          if (result.data.device) {
            setWifiIp(result.data.device.id);
          } else {
            const ipPart = pairAddress.trim().split(':')[0];
            if (ipPart) {
              setWifiIp(ipPart + ':');
            }
          }
          await loadAdbStatus();
          await loadDevices();
        } else if (result.data?.device) {
          // \u914d\u5bf9\u540e\u5df2\u81ea\u52a8\u8fde\u4e0a\uff0c\u76f4\u63a5\u5237\u65b0\u8bbe\u5907\u5217\u8868\uff0c\u65e0\u9700\u7528\u6237\u518d\u586b IP:\u7aef\u53e3
          setSuccess(result.data.message || '\u914d\u5bf9\u5e76\u8fde\u63a5\u6210\u529f');
          setShowPairForm(false);
          setPairAddress('');
          await loadAdbStatus();
          await loadDevices();
        } else {
          // \u81ea\u52a8\u8fde\u63a5\u5931\u8d25\uff08\u5c11\u6570\u73af\u5883\uff09\uff0c\u9000\u56de\u624b\u52a8\uff1a\u628a IP \u586b\u5230\u8fde\u63a5\u6846\u8ba9\u7528\u6237\u8865\u7aef\u53e3
          setSuccess(result.data?.message || '\u914d\u5bf9\u6210\u529f\uff0c\u8bf7\u5728\u4e0a\u65b9\u586b\u5199 IP:\u8fde\u63a5\u7aef\u53e3\u70b9\u300c\u8fde\u63a5\u300d');
          const ipPart = pairAddress.trim().split(':')[0];
          if (ipPart) {
            setWifiIp(ipPart + ':');
          }
        }
      } else {
        setError(formatOperationError(result, 'WiFi \u914d\u5bf9\u5931\u8d25'));
      }
    } catch (err) {
      console.error('pairWiFi error:', err);
      setError('WiFi \u914d\u5bf9\u5931\u8d25\uff1a' + (err as Error).message);
    } finally {
      setPairing(false);
    }
  };

  const disconnectDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI()) return;
    const deviceId = device.id;
    try {
      if (device.connectionType === 'usb') {
        await window.electronAPI!.stopLogcat(deviceId).catch(() => undefined);
        removeDeviceLogState(deviceId);
        setDevices(prev => {
          const nextDevices = prev.filter(item => item.id !== deviceId);
          if (selectedDeviceRef.current?.id === deviceId) {
            setSelectedDevice(nextDevices[0] || null);
          }
          return nextDevices;
        });
        setError('');
        return;
      }

      const result = await window.electronAPI!.disconnect(deviceId);
      if (!result.success) {
        setError(formatOperationError(result, '\u65ad\u5f00\u8bbe\u5907\u5931\u8d25'));
        return;
      }
      removeDeviceLogState(deviceId);
      await loadAdbStatus();
      await loadDevices();
    } catch (err) {
      setError('\u65ad\u5f00\u8bbe\u5907\u5931\u8d25\uff1a' + (err as Error).message);
    }
  };

  const toggleLogcat = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    
    const state = getLogState(selectedDevice.id);
    if (state.running) {
      await window.electronAPI!.stopLogcat(selectedDevice.id);
      state.running = false;
      state.paused = false;
      setRunningLogDeviceIds(prev => {
        const next = new Set(prev);
        next.delete(selectedDevice.id);
        return next;
      });
      setPausedLogDeviceIds(prev => {
        const next = new Set(prev);
        next.delete(selectedDevice.id);
        return next;
      });
    } else {
      const sourcePackage = logPackageFilter.trim() || packageFilter.trim() || undefined;
      const sourcePid = logPidFilter.trim() || undefined;
      // 抓取恒定按 all levels（*:V），不受日志等级下拉框限制——等级只做显示筛选（见 filteredLogs）。
      // 这样切换等级无需重新采集，也不会因选了高等级而漏抓低等级日志。
      const sourceLevel: LogEntry['level'] = 'V';
      const result = await window.electronAPI!.startLogcat(selectedDevice.id, sourceLevel, sourcePackage, sourcePid);
      if (result.success) {
        state.running = true;
        state.paused = false;
        clearDeviceLogs(selectedDevice.id);
        setRunningLogDeviceIds(prev => new Set(prev).add(selectedDevice.id));
        setPausedLogDeviceIds(prev => {
          const next = new Set(prev);
          next.delete(selectedDevice.id);
          return next;
        });
      } else {
        setError(result.error || '\u52a0\u8f7d\u8bbe\u5907\u5931\u8d25');
      }
    }
  };

  const toggleSelectedDevicePause = () => {
    if (!selectedDevice) return;
    const state = getLogState(selectedDevice.id);
    state.paused = !state.paused;
    setPausedLogDeviceIds(prev => {
      const next = new Set(prev);
      if (state.paused) {
        next.add(selectedDevice.id);
      } else {
        next.delete(selectedDevice.id);
      }
      return next;
    });
    setLogVersion(version => version + 1);
  };

  // 执行采集开关：点开始 → startCaptureSession（主进程同启采样循环 + 持续分段录制）；
  // 点关闭 → stopCaptureSession（停采样停录制 + finalize），把 finalize 的会话留作报告渲染。
  const runCaptureToggle = async (deviceId: string, isActive: boolean) => {
    setCaptureBusyDeviceIds((prev) => new Set(prev).add(deviceId));
    try {
      if (isActive) {
        const result = await window.electronAPI!.stopCaptureSession(deviceId);
        if (result.success && result.data) {
          const finalized = result.data;
          setActiveCaptureByDeviceId((prev) => {
            const next = { ...prev };
            delete next[deviceId];
            return next;
          });
          // 用内存里刚累积的样本直接生成报告（无需再从磁盘加载），并刷新回看列表（新会话已归档）。
          setLoadedReportFor(deviceId, { session: finalized, samples: performanceSamplesByDeviceId[deviceId] || [], markers: [] });
          void refreshCaptureSessions();
          setError('');
        } else {
          setError(result.error || '关闭采集失败');
        }
      } else {
        // 开始前清空上次缓冲、报告与提醒，避免新旧会话数据串味。
        setPerformanceSamplesByDeviceId((prev) => ({ ...prev, [deviceId]: [] }));
        setLoadedReportFor(deviceId, null);
        setCaptureElapsedByDeviceId((prev) => ({ ...prev, [deviceId]: 0 }));
        setSoftLimitNoticeByDeviceId((prev) => {
          const next = { ...prev };
          delete next[deviceId];
          return next;
        });
        const result = await window.electronAPI!.startCaptureSession(deviceId);
        if (result.success && result.data) {
          const session = result.data;
          setActiveCaptureByDeviceId((prev) => ({ ...prev, [deviceId]: session }));
          setPerformanceSessionStartedAtByDeviceId((prev) => ({ ...prev, [deviceId]: new Date(session.startedAt) }));
          setError('');
        } else {
          setError(result.error || '开始采集失败');
        }
      }
    } catch (err) {
      setError((isActive ? '关闭采集失败：' : '开始采集失败：') + (err as Error).message);
    } finally {
      setCaptureBusyDeviceIds((prev) => {
        const next = new Set(prev);
        next.delete(deviceId);
        return next;
      });
    }
  };

  // 单一开关：开始采集直接开；关闭采集走统一确认弹窗二次确认，避免误触中断正在进行的录制。
  const toggleCaptureSession = () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    if (captureBusyDeviceIds.has(deviceId)) return;
    const isActive = Boolean(activeCaptureByDeviceId[deviceId]);
    if (isActive) {
      requestConfirm({
        message: '确定关闭采集吗？\n关闭后会结束本次录制并生成采集报告。',
        confirmText: '关闭采集',
        danger: true,
        onConfirm: () => {
          void runCaptureToggle(deviceId, true);
        },
      });
    } else {
      void runCaptureToggle(deviceId, false);
    }
  };

  const dismissSoftLimit = (deviceId: string) =>
    setSoftLimitNoticeByDeviceId((prev) => {
      const next = { ...prev };
      delete next[deviceId];
      return next;
    });

  // 过滤标记持久化到会话（写 data/markers.json），失败给错误提示，不阻塞 UI。
  const saveCaptureMarkers = async (sessionId: string, markers: PerformanceCaptureMarker[]) => {
    if (!hasElectronAPI()) return;
    // 同步到正展示该会话的设备槽位，回看时再加载即一致。
    mutateLoadedReports((detail) => (detail && detail.session.id === sessionId ? { ...detail, markers } : detail));
    try {
      const result = await window.electronAPI!.saveCaptureMarkers(sessionId, markers);
      if (!result.success) setError(result.error || '保存过滤标记失败');
    } catch (err) {
      setError('保存过滤标记失败：' + (err as Error).message);
    }
  };

  // —— Phase 14 采集回看：加载 / 改名 / 删除 / 截图归档 —— //（refreshCaptureSessions 在上方定义）
  const selectCaptureSession = async (sessionId: string) => {
    if (!hasElectronAPI() || !selectedDevice) return;
    const deviceId = selectedDevice.id;
    // 护栏：采集进行中不切回看——实时采集优先占着报告区，加载了也看不到，且会在关闭采集时被新报告覆盖。
    // 直接拦截并提示，避免「点了没反应 + 列表高亮与报告区不一致 + 选择被悄悄丢弃」的困惑。
    if (activeCaptureByDeviceId[deviceId]) {
      setSuccess('采集进行中，关闭采集后即可回看历史采集。');
      return;
    }
    const result = await window.electronAPI!.loadCaptureSession(sessionId);
    if (result.success && result.data) {
      // 加载到「当前查看的设备」槽位：在哪台设备上点回看，就在那台的报告区展示。
      setLoadedReportFor(deviceId, result.data);
      setError('');
    } else {
      setError(result.error || '加载采集会话失败');
    }
  };

  const renameCaptureSession = async (sessionId: string, title: string) => {
    if (!hasElectronAPI()) return;
    const result = await window.electronAPI!.renameCaptureSession(sessionId, title);
    if (result.success) {
      void refreshCaptureSessions();
      const trimmed = title.trim();
      mutateLoadedReports((detail) =>
        detail && detail.session.id === sessionId ? { ...detail, session: { ...detail.session, title: trimmed || undefined } } : detail
      );
    } else {
      setError(result.error || '重命名采集会话失败');
    }
  };

  const deleteCaptureSession = async (sessionId: string) => {
    if (!hasElectronAPI()) return;
    const result = await window.electronAPI!.deleteCaptureSession(sessionId);
    if (result.success) {
      void refreshCaptureSessions();
      mutateLoadedReports((detail) => (detail && detail.session.id === sessionId ? null : detail));
    } else {
      setError(result.error || '删除采集会话失败');
    }
  };

  // 截图归档：成功返回相对路径；失败抛错，由 CaptureReport 就地提示（不双重弹错误条）。
  const saveCaptureFrame = async (sessionId: string, dataUrl: string): Promise<string | undefined> => {
    if (!hasElectronAPI()) throw new Error('Electron 接口不可用');
    const result = await window.electronAPI!.saveCaptureFrame(sessionId, dataUrl);
    if (!result.success) throw new Error(result.error || '保存截图失败');
    return result.data;
  };

  // 导出会话为 zip（弹系统保存框；取消则 data 为空，不提示）。
  const exportCaptureSession = async (sessionId: string) => {
    if (!hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.exportCaptureSession(sessionId);
      if (!result.success) setError(result.error || '导出采集会话失败');
      else if (result.data) {
        setLastExportedCapturePath(result.data);
        setSuccess(`已导出：${result.data}`);
      }
    } catch (err) {
      setError('导出采集会话失败：' + (err as Error).message);
    }
  };

  // 「打开位置」：在资源管理器中定位最近导出的采集 zip（导出回看后立即跳到 PC 对应位置）。
  const revealExportedCapture = async () => {
    if (!hasElectronAPI() || !lastExportedCapturePath) return;
    const r = await window.electronAPI!.showItemInFolder(lastExportedCapturePath);
    if (!r.success && r.error) setError(r.error);
  };

  // 导入会话（zip / 会话文件夹路径，来自选择对话框或拖拽），完成后刷新列表。
  const importCapturePaths = async (paths: string[]) => {
    if (!hasElectronAPI() || paths.length === 0) return;
    try {
      const result = await window.electronAPI!.importCaptureSessions(paths);
      if (result.success && result.data) {
        void refreshCaptureSessions();
        const { imported, errors } = result.data;
        if (errors.length > 0) {
          setError(`导入完成 ${imported.length} 个，${errors.length} 个失败：${errors.join('；')}`);
        } else {
          setSuccess(`已导入 ${imported.length} 个采集会话`);
        }
      } else if (!result.success) {
        setError(result.error || '导入采集会话失败');
      }
    } catch (err) {
      setError('导入采集会话失败：' + (err as Error).message);
    }
  };

  const importCaptureViaDialog = async () => {
    if (!hasElectronAPI()) return;
    const result = await window.electronAPI!.selectImportFiles();
    if (result.success && result.data && result.data.length > 0) {
      await importCapturePaths(result.data);
    } else if (!result.success) {
      setError(result.error || '选择导入文件失败');
    }
  };

  const exportPerformanceSession = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const capturing = Boolean(activeCaptureByDeviceId[selectedDevice.id]);
    const loaded = loadedReportByDeviceId[selectedDevice.id] ?? null;
    // 采集中导出实时缓冲；否则导出报告区当前展示的会话（含加载的历史会话）。
    const samples = capturing
      ? performanceSamplesByDeviceId[selectedDevice.id] || []
      : loaded?.samples ?? performanceSamplesByDeviceId[selectedDevice.id] ?? [];
    if (samples.length === 0) {
      setError('当前没有性能采样数据，请先开始采集或选择一条采集记录。');
      return;
    }

    const result = await window.electronAPI!.exportPerformanceSession({
      device: selectedDevice,
      startedAt: (!capturing && loaded?.session.startedAt) || performanceSessionStartedAtByDeviceId[selectedDevice.id] || samples[0].capturedAt,
      endedAt: new Date(),
      samples,
    });

    if (result.success) {
      setError('');
    } else {
      setError(result.error || '导出性能采集报告失败');
    }
  };

  // 把一批宿主路径加入待安装列表：仅留 .apk、按路径去重。供「选择 APK」与拖拽共用。
  const addApkFilesByPath = (paths: string[]) => {
    setPendingApks((prev) => {
      const existing = new Set(prev.map((a) => a.path));
      const added = paths
        .filter((p) => p.toLowerCase().endsWith('.apk') && !existing.has(p))
        .map((p) => ({ path: p, fileName: p.split(/[\\/]/).pop() || p }));
      return [...prev, ...added];
    });
  };

  const selectApkFiles = async () => {
    if (!hasElectronAPI()) {
      setError('Electron 接口不可用');
      return;
    }
    try {
      const result = await window.electronAPI!.selectApkFiles();
      if (!result.success || !result.data) {
        setError(formatOperationError(result, '选择安装包失败'));
        return;
      }
      if (result.data.length === 0) return;
      addApkFilesByPath(result.data);
      setError('');
    } catch (err) {
      setError('选择安装包失败：' + (err as Error).message);
    }
  };

  // 拖拽 APK 到待安装区：Electron 28 的 drop File 仍带 .path（宿主绝对路径），直接取用。
  const handleApkDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsApkDragOver(false);
    if (isUnifiedInstalling) return;
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files
      .map((f) => (f as File & { path?: string }).path || '')
      .filter(Boolean);
    const apks = paths.filter((p) => p.toLowerCase().endsWith('.apk'));
    if (apks.length === 0) {
      if (files.length > 0) setError('只能拖入 .apk 安装包');
      return;
    }
    addApkFilesByPath(apks);
    setError('');
  };

  const removePendingApk = (path: string) => {
    setPendingApks((prev) => prev.filter((a) => a.path !== path));
  };

  const toggleInstallTarget = (deviceId: string) => {
    if (isUnifiedInstalling) return;
    setInstallTargets((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  // 给指定设备安装一组 items（items 直接传入，避免读取尚未刷新的队列状态）。
  // 往安装日志追加一条（带本地时间戳，最新在最上面，最多留 200 条）。
  const appendInstallLog = (text: string, level: 'info' | 'success' | 'error' = 'info') => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    setInstallLog((prev) => [{ text: `[${ts}] ${text}`, level }, ...prev].slice(0, 200));
  };

  const installItemsOnDevice = async (deviceId: string, items: ApkInstallQueueItem[]) => {
    const deviceLabel = (() => {
      const d = devices.find((x) => x.id === deviceId);
      return d ? getDeviceLabel(d) : deviceId;
    })();
    const installFlags = installAllowDowngrade ? '-r -d' : '-r';
    // 安装前快照本设备的包集合，用于装完后 diff 出新增的包标「NEW」（每台设备各自算，与当前选中无关）。
    const beforeRes = await window.electronAPI!.listInstalledPackages(deviceId).catch(() => null);
    const baseline = new Set(beforeRes && beforeRes.success && beforeRes.data ? beforeRes.data : []);
    for (const item of items) {
      const startedAt = Date.now();
      appendInstallLog(
        `${deviceLabel} ▶ 开始安装 ${item.fileName}\n    命令: adb install ${installFlags}\n    源文件: ${item.path}`
      );
      updateDeviceApkInstallState(deviceId, (previousState) => ({
        ...previousState,
        queue: previousState.queue.map((q) =>
          q.id === item.id ? { ...q, status: 'installing', progress: Math.max(q.progress, 8), error: undefined, output: undefined } : q
        ),
      }));
      startApkInstallProgressTimer(deviceId, item.id);
      try {
        const result = await window.electronAPI!.installApk(deviceId, item.path, { allowDowngrade: installAllowDowngrade });
        stopApkInstallProgressTimer(item.id);
        const failMsg = result.success ? undefined : formatOperationError(result, '安装失败');
        // 进度卡只存「一句话原因」（result.error 的标题，不含建议/adb 原文）；完整详情交给下方安装日志，避免两处重复。
        updateDeviceApkInstallState(deviceId, (previousState) => ({
          ...previousState,
          queue: previousState.queue.map((q) =>
            q.id === item.id
              ? { ...q, status: result.success ? 'success' : 'failed', progress: 100, output: undefined, error: result.success ? undefined : (result.error || '安装失败') }
              : q
          ),
        }));
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const indent = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).map((l) => `    ${l}`).join('\n');
        if (result.success) {
          const out = (result.data?.output || '').trim();
          appendInstallLog(
            `${deviceLabel} ✓ ${item.fileName} 安装成功 · 耗时 ${elapsed}s` + (out ? `\n${indent(out)}` : ''),
            'success'
          );
        } else {
          const details = (result.details || '').trim();
          appendInstallLog(
            `${deviceLabel} ✗ ${item.fileName} 安装失败 · 耗时 ${elapsed}s\n    ${failMsg}` + (details ? `\n    ── adb 原始输出 ──\n${indent(details)}` : ''),
            'error'
          );
        }
      } catch (err) {
        stopApkInstallProgressTimer(item.id);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const msg = (err as Error).message;
        updateDeviceApkInstallState(deviceId, (previousState) => ({
          ...previousState,
          queue: previousState.queue.map((q) => (q.id === item.id ? { ...q, status: 'failed', progress: 100, error: msg } : q)),
        }));
        appendInstallLog(`${deviceLabel} ✗ ${item.fileName} 安装异常 · 耗时 ${elapsed}s\n    ${msg}`, 'error');
      }
    }
    updateDeviceApkInstallState(deviceId, (previousState) => ({ ...previousState, isInstalling: false }));
    // 装完再拉一次本设备包列表：diff 出新增的包记成该设备的「NEW」（累加，按设备存）；顺便刷新可见列表。
    const afterRes = await window.electronAPI!.listInstalledPackages(deviceId).catch(() => null);
    if (afterRes && afterRes.success && afterRes.data) {
      const after = afterRes.data;
      const newly = after.filter((p) => !baseline.has(p));
      if (newly.length > 0) {
        setNewlyInstalledByDevice((prev) => ({
          ...prev,
          [deviceId]: new Set([...(prev[deviceId] || []), ...newly]),
        }));
      }
      if (selectedDeviceRef.current?.id === deviceId) {
        setInstalledPackages(after);
      }
    }
  };

  // 统一安装：把待装 APK 入队到所选在线设备，按并发上限并行安装。
  const startUnifiedInstall = async () => {
    if (isUnifiedInstalling || !hasElectronAPI()) return;
    const targetIds = Array.from(installTargets).filter((id) => devices.find((d) => d.id === id)?.status === 'connected');
    if (pendingApks.length === 0 || targetIds.length === 0) return;

    appendInstallLog(`开始安装 ${pendingApks.length} 个 APK 到 ${targetIds.length} 台设备（并发 ${installConcurrency > 0 ? installConcurrency : '不限'}${installAllowDowngrade ? '，允许降级' : ''}）`);
    // 新批次：重置本次目标设备的「NEW」——只标最新这一批装上的（批次内含重试会继续累加）。
    setNewlyInstalledByDevice((prev) => {
      const next = { ...prev };
      targetIds.forEach((id) => { delete next[id]; });
      return next;
    });

    const perDeviceItems: Record<string, ApkInstallQueueItem[]> = {};
    targetIds.forEach((id) => {
      perDeviceItems[id] = pendingApks.map((a) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${id}`,
        path: a.path,
        fileName: a.fileName,
        status: 'queued' as ApkInstallStatus,
        progress: 0,
      }));
    });
    setApkInstallStates((prev) => {
      const next = { ...prev };
      targetIds.forEach((id) => {
        // 本次要安装的 apk（按本地路径标识）：移除它们在旧队列里的历史结果（成功/失败都清），
        // 避免同一 apk 重复推送时旧的失败/成功记录在「安装详情」里堆积；其它 apk 的记录保留。
        const reinstallingPaths = new Set(perDeviceItems[id].map((it) => it.path));
        const existing = (next[id]?.queue || []).filter(
          (it) => it.status !== 'success' && !reinstallingPaths.has(it.path)
        );
        next[id] = { queue: [...existing, ...perDeviceItems[id]], isInstalling: true };
      });
      return next;
    });
    setError('');
    setIsUnifiedInstalling(true);

    const limit = installConcurrency > 0 ? installConcurrency : targetIds.length;
    let index = 0;
    const worker = async () => {
      while (index < targetIds.length) {
        const deviceId = targetIds[index];
        index += 1;
        await installItemsOnDevice(deviceId, perDeviceItems[deviceId]);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(limit, targetIds.length) || 1 }, () => worker()));
    } finally {
      setIsUnifiedInstalling(false);
    }
  };

  const retryDeviceInstall = async (deviceId: string) => {
    if (isUnifiedInstalling || !hasElectronAPI()) return;
    if (devices.find((d) => d.id === deviceId)?.status !== 'connected') {
      updateDeviceApkInstallState(deviceId, (previousState) => ({
        ...previousState,
        queue: previousState.queue.map((q) => (q.status === 'failed' ? { ...q, error: '设备已离线' } : q)),
      }));
      return;
    }
    const failed = getDeviceApkInstallState(deviceId).queue.filter((it) => it.status === 'failed');
    if (failed.length === 0) return;
    setIsUnifiedInstalling(true);
    updateDeviceApkInstallState(deviceId, (s) => ({ ...s, isInstalling: true }));
    try {
      await installItemsOnDevice(deviceId, failed);
    } finally {
      setIsUnifiedInstalling(false);
    }
  };

  const clearCompletedApkInstalls = (deviceId: string) => {
    updateDeviceApkInstallState(deviceId, (previousState) => ({
      ...previousState,
      queue: previousState.queue.filter((item) => item.status !== 'success'),
    }));
  };

  const removeApkInstallItem = (deviceId: string, itemId: string) => {
    updateDeviceApkInstallState(deviceId, (previousState) => ({
      ...previousState,
      queue: previousState.queue.filter((item) => item.id !== itemId || item.status === 'installing'),
    }));
  };

  // 保证按钮冷却至少 minMs，让点击有可见反馈（即使 adb 指令秒回）。
  const withMinCooldown = async (startedAt: number, minMs: number) => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < minMs) {
      await new Promise((resolve) => setTimeout(resolve, minMs - elapsed));
    }
  };

  const handleSleepDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI() || busyDeviceAction) return;
    setBusyDeviceAction({ id: device.id, action: 'sleep' });
    const startedAt = Date.now();
    try {
      const result = await window.electronAPI!.sleepDevice(device.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备息屏失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备息屏失败: ' + (err as Error).message);
    } finally {
      await withMinCooldown(startedAt, 500);
      setBusyDeviceAction(null);
    }
  };

  const handleWakeDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI() || busyDeviceAction) return;
    setBusyDeviceAction({ id: device.id, action: 'wake' });
    const startedAt = Date.now();
    try {
      const result = await window.electronAPI!.wakeDevice(device.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备唤醒失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备唤醒失败: ' + (err as Error).message);
    } finally {
      await withMinCooldown(startedAt, 500);
      setBusyDeviceAction(null);
    }
  };

  const handleUnlockDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI() || busyDeviceAction) return;
    setBusyDeviceAction({ id: device.id, action: 'unlock' });
    const startedAt = Date.now();
    try {
      const result = await window.electronAPI!.unlockDevice(device.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备解锁失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备解锁失败: ' + (err as Error).message);
    } finally {
      await withMinCooldown(startedAt, 500);
      setBusyDeviceAction(null);
    }
  };

  const handleRebootDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI() || busyDeviceAction) return;
    setBusyDeviceAction({ id: device.id, action: 'reboot' });
    const startedAt = Date.now();
    try {
      const result = await window.electronAPI!.rebootDevice(device.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备重启失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备重启失败: ' + (err as Error).message);
    } finally {
      await withMinCooldown(startedAt, 500);
      setBusyDeviceAction(null);
    }
  };

  const loadNetworkRequests = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    try {
      setError('');
      const result = await window.electronAPI!.getNetworkRequests(selectedDevice.id, packageFilter.trim() || undefined);
      if (result.success && result.data) {
        setNetworkRequests(result.data);
        setSelectedNetworkRequestId(result.data[0]?.id || null);
        setError('');
      } else {
        setNetworkRequests([]);
        setSelectedNetworkRequestId(null);
        setError(result.error || '\u52a0\u8f7d\u8bbe\u5907\u5931\u8d25');
      }
    } catch (err) {
      setNetworkRequests([]);
      setSelectedNetworkRequestId(null);
      setError('\u7f51\u7edc\u6293\u53d6\u5931\u8d25\uff1a' + (err as Error).message);
    }
  };

  const loadWeakNetStatus = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.queryWeakNetStatus(selectedDevice.id);
      if (result.success && result.data) {
        setWeakNetStatus(result.data);
        if (result.data === 'running') {
          setWeakNetNeedsAuth(false); // 已起来，说明授权没问题，清掉「待授权」推断
        }
      }
      // 失败：保留上次状态，避免轮询瞬时失败把 isRunning 翻成 false 导致图表闪烁
    } catch {
      /* 保留上次状态 */
    }
  };

  const loadWeakNetTraffic = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.queryWeakNetTraffic(selectedDevice.id);
      if (result.success && result.data) {
        const now = Date.now();
        const prev = weakNetTrafficPrevRef.current;
        let rxRate = 0;
        let txRate = 0;
        if (prev && now > prev.at) {
          const dt = (now - prev.at) / 1000;
          rxRate = Math.max(0, (result.data.rxBytes - prev.rxBytes) / dt);
          txRate = Math.max(0, (result.data.txBytes - prev.txBytes) / dt);
        }
        const hadPrev = prev !== null;
        weakNetTrafficPrevRef.current = { rxBytes: result.data.rxBytes, txBytes: result.data.txBytes, at: now };
        setWeakNetTraffic({ rxBytes: result.data.rxBytes, txBytes: result.data.txBytes, rxRate, txRate });
        // 首个采样无速率（无 prev），跳过不入图，避免一条假 0；之后每次入历史，最多保留 40 点。
        if (hadPrev) {
          setWeakNetTrafficHistory((history) => [...history, { rx: rxRate, tx: txRate, at: now }].slice(-40));
        }
      }
      // 查询失败/无数据：保留上次流量与历史，避免单次瞬时失败把折线图清空重建（闪烁）。
      // 真正停止/切设备/切 tab 的重置统一由 effect 处理。
    } catch {
      /* 瞬时失败保留上次流量，避免闪烁；真正停止由状态切换/effect 清零 */
    }
  };

  const loadWeakNetShaperStats = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.queryWeakNetShaperStats(selectedDevice.id);
      if (result.success && result.data) {
        setWeakNetShaperStats(result.data);
      }
      // null/失败：保留上次值，避免轮询闪烁；重置由 effect 处理
    } catch {
      /* 保留上次值 */
    }
  };

  const loadWeakNetPackages = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    setWeakNetLoadingPackages(true);
    try {
      const result = await window.electronAPI!.listInstalledPackages(selectedDevice.id);
      setWeakNetPackages(result.success && result.data ? result.data : []);
    } catch {
      setWeakNetPackages([]);
    } finally {
      setWeakNetLoadingPackages(false);
    }
  };

  const runWeakNetAction = async (action: () => Promise<ElectronResult<unknown>>, failureMessage: string) => {
    if (!selectedDevice || !hasElectronAPI()) return;
    setWeakNetBusy(true);
    setWeakNetError(null);
    try {
      const result = await action();
      if (!result.success) {
        setWeakNetError(result.error || failureMessage);
      }
    } catch (err) {
      setWeakNetError(`${failureMessage}：${(err as Error).message}`);
    } finally {
      setWeakNetBusy(false);
      await loadWeakNetStatus();
    }
  };

  const handleInstallWeakNetHelper = () =>
    runWeakNetAction(() => window.electronAPI!.installWeakNetHelper(selectedDevice!.id), '安装弱网助手失败')
      .then(() => loadWeakNetPackages());

  // 启动 / 热更新参数（运行中再次下发 START，助手会先停旧引擎再起，等价热更新）。
  const handleStartWeakNet = async (profile: WeakNetworkProfile) => {
    await runWeakNetAction(() => window.electronAPI!.startWeakNet(selectedDevice!.id, profile), '启动弱网失败');
    if (!selectedDevice || !hasElectronAPI()) return;
    // 启动后稍等再查：tun 未建起来多半是没在头显授予 VPN 权限，置 sticky 标志提示授权。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const result = await window.electronAPI!.queryWeakNetStatus(selectedDevice.id);
      if (result.success && result.data) {
        setWeakNetStatus(result.data);
        setWeakNetNeedsAuth(result.data !== 'running');
      }
    } catch {
      /* 忽略：保留上一次状态 */
    }
  };

  const handleStopWeakNet = async () => {
    setWeakNetNeedsAuth(false); // 停止后不应再提示「待授权」
    await runWeakNetAction(() => window.electronAPI!.stopWeakNet(selectedDevice!.id), '停止弱网失败');
  };

  const handleAuthorizeWeakNet = () =>
    runWeakNetAction(() => window.electronAPI!.launchApp(selectedDevice!.id, 'com.androidtool.piconetworkhelper'), '拉起助手授权页失败');

  const handleExportWeakNetTraffic = () => {
    if (!hasElectronAPI() || weakNetTrafficHistory.length === 0) return;
    void window.electronAPI!.exportWeakNetTraffic(weakNetTrafficHistory);
  };

  const handleStartMirror = async (params: { maxSize?: number; bitRate?: string; forwardAudio?: boolean }) => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    setError('');
    setMirrorStartingDeviceIds(prev => new Set(prev).add(deviceId));
    try {
      const result = await window.electronAPI!.startMirror(deviceId, {
        isPico: isLikelyPicoDevice(selectedDevice),
        maxSize: params.maxSize,
        bitRate: params.bitRate,
        forwardAudio: params.forwardAudio,
      });
      if (!result.success) {
        setMirrorStartingDeviceIds(prev => {
          const next = new Set(prev);
          next.delete(deviceId);
          return next;
        });
        setMirrorSessionsByDeviceId(prev => ({
          ...prev,
          [deviceId]: { deviceId, status: 'failed', error: result.error || '启动投屏失败' },
        }));
        setError(result.error || '启动投屏失败');
      }
    } catch (err) {
      setMirrorStartingDeviceIds(prev => {
        const next = new Set(prev);
        next.delete(deviceId);
        return next;
      });
      setError('启动投屏失败：' + (err as Error).message);
    }
  };

  const handleStopMirror = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    try {
      await window.electronAPI!.stopMirror(selectedDevice.id);
    } catch (err) {
      setError('停止投屏失败：' + (err as Error).message);
    }
  };

  // 点「立即更新」：手动开始下载新版本（autoDownload 已关，需显式触发）。
  const handleDownloadUpdate = async () => {
    if (!hasElectronAPI() || !window.electronAPI?.downloadUpdate) return;
    try {
      await window.electronAPI.downloadUpdate();
    } catch (err) {
      setError('下载更新失败：' + (err as Error).message);
    }
  };

  // 安装并重启：先显示全屏「正在安装」遮罩（留一帧给 UI 渲染），再触发静默安装+自动重启。
  const handleInstallUpdate = async () => {
    if (!hasElectronAPI()) return;
    setInstalling(true);
    window.setTimeout(() => {
      window.electronAPI!.quitAndInstallUpdate().catch((err) => {
        setInstalling(false);
        setError('安装更新失败：' + (err as Error).message);
      });
    }, 300);
  };

  // 投屏中实时切换音频去向（设备本机 / 电脑）。主进程返回更新后的会话，乐观更新本地状态。
  const handleToggleMirrorAudio = async (forward: boolean) => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    try {
      const result = await window.electronAPI!.setMirrorAudio(deviceId, forward);
      if (result.success && result.data) {
        setMirrorSessionsByDeviceId(prev => ({ ...prev, [deviceId]: result.data! }));
      } else if (!result.success) {
        setError(result.error || '切换投屏声音失败');
      }
    } catch (err) {
      setError('切换投屏声音失败：' + (err as Error).message);
    }
  };

  const loadInstalledPackages = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const targetDeviceId = selectedDevice.id;
    setInstalledPackagesLoading(true);
    try {
      const result = await window.electronAPI!.listInstalledPackages(targetDeviceId);
      if (selectedDeviceRef.current?.id !== targetDeviceId) return; // 设备已切换，丢弃过期结果
      if (result.success && result.data) {
        setInstalledPackages(result.data);
        setError('');
      } else {
        setInstalledPackages([]);
        setError(result.error || '获取已安装应用失败');
      }
    } catch (err) {
      if (selectedDeviceRef.current?.id !== targetDeviceId) return;
      setInstalledPackages([]);
      setError('获取已安装应用失败：' + (err as Error).message);
    } finally {
      if (selectedDeviceRef.current?.id === targetDeviceId) {
        setInstalledPackagesLoading(false);
      }
    }
  };

  // 拉取当前设备在运行的应用包名集合（带设备切换防过期）。失败静默，不打扰用户。
  const loadRunningPackages = async () => {
    if (!selectedDevice || !hasElectronAPI() || !window.electronAPI?.getRunningPackages) return;
    const targetDeviceId = selectedDevice.id;
    try {
      const result = await window.electronAPI.getRunningPackages(targetDeviceId);
      if (selectedDeviceRef.current?.id !== targetDeviceId) return; // 设备已切换，丢弃过期结果
      if (result.success && result.data) {
        setRunningPackages(new Set(result.data));
      }
    } catch {
      /* 运行态查询失败不影响主流程，忽略 */
    }
  };

  const handleLaunchApp = async (packageName: string) => {
    if (!selectedDevice || !hasElectronAPI() || busyPackage) return;
    if (runningPackages.has(packageName)) return; // 已在运行，禁止重复启动
    setBusyPackage(packageName);
    setBusyAction('launch');
    try {
      setError('');
      const result = await window.electronAPI!.launchApp(selectedDevice.id, packageName);
      if (!result.success) {
        setError(result.error || '启动应用失败');
      }
    } catch (err) {
      setError('启动应用失败：' + (err as Error).message);
    } finally {
      setBusyPackage(null);
      setBusyAction(null);
      // 进程要一会儿才起来，稍后刷新运行态让「运行中」标识跟上
      window.setTimeout(() => { void loadRunningPackages(); }, 1200);
    }
  };

  const handleForceStopApp = async (packageName: string) => {
    if (!selectedDevice || !hasElectronAPI() || busyPackage) return;
    setBusyPackage(packageName);
    setBusyAction('stop');
    try {
      setError('');
      const result = await window.electronAPI!.forceStopApp(selectedDevice.id, packageName);
      if (!result.success) {
        setError(result.error || '关闭应用失败');
      }
    } catch (err) {
      setError('关闭应用失败：' + (err as Error).message);
    } finally {
      setBusyPackage(null);
      setBusyAction(null);
      window.setTimeout(() => { void loadRunningPackages(); }, 600); // 关闭后进程很快消失，稍后刷新运行态
    }
  };

  const handleUninstallApp = (packageName: string) => {
    const device = selectedDevice; // 捕获当前设备：确认期间若切换设备，仍卸载用户当时看到的那台
    if (!device || !hasElectronAPI() || busyPackage) return;
    requestConfirm({
      message: `确定卸载应用「${packageName}」？此操作不可撤销。`,
      confirmText: '卸载',
      danger: true,
      onConfirm: () => { void doUninstallApp(device, packageName); },
    });
  };

  const doUninstallApp = async (device: DeviceInfo, packageName: string) => {
    if (!hasElectronAPI()) return;
    setBusyPackage(packageName);
    setBusyAction('uninstall');
    try {
      setError('');
      const result = await window.electronAPI!.uninstallApp(device.id, packageName);
      if (result.success) {
        await loadInstalledPackages();
      } else {
        setError(result.error || '卸载失败');
      }
    } catch (err) {
      setError('卸载失败：' + (err as Error).message);
    } finally {
      setBusyPackage(null);
      setBusyAction(null);
    }
  };

  const exportVisibleLogs = async () => {
    if (!hasElectronAPI()) return;
    const logs = hasActiveLogFilter ? filteredLogs : (currentLogState?.store.toArray() || []);
    if (logs.length === 0) {
      setError('\u6ca1\u6709\u53ef\u5bfc\u51fa\u7684\u65e5\u5fd7');
      return;
    }
    const result = await window.electronAPI!.exportLogs(logs);
    if (result.success) {
      setError('');
      setLastExportedLogPath(result.data || null);
    } else if (result.error !== '\u53d6\u6d88\u5bfc\u51fa') {
      setError(result.error || '\u65e5\u5fd7\u5bfc\u51fa\u5931\u8d25');
    }
  };

  // \u5bfc\u51fa\u5b8c\u6574\u539f\u59cb\u65e5\u5fd7\uff1a\u4ece\u76d1\u63a7\u7b2c\u4e00\u884c\u5230\u5f53\u524d\u7684\u5168\u91cf\uff08\u5168\u7b49\u7ea7\u3001\u4e0d\u53d7 2 \u4e07\u6761\u4e0a\u9650/\u7b5b\u9009\u5f71\u54cd\uff09\uff0c\u7531\u4e3b\u8fdb\u7a0b\u843d\u76d8\u6587\u4ef6\u53e6\u5b58\u3002
  const exportFullLogs = async () => {
    if (!hasElectronAPI() || !selectedDevice) return;
    const result = await window.electronAPI!.exportFullLogs(selectedDevice.id);
    if (result.success) {
      setError('');
      setLastExportedLogPath(result.data || null);
    } else if (result.error !== '\u53d6\u6d88\u5bfc\u51fa') {
      setError(result.error || '\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7\u5931\u8d25');
    }
  };

  // \u6309\u5f53\u524d\u5305\u540d\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7\uff1a\u4e0d\u91cd\u65b0\u91c7\u96c6\uff0c\u76f4\u63a5\u7528\u300c\u5e94\u7528/\u5305\u540d\u300d\u91cc\u586b\u7684\u8bcd\u5173\u8054\u8fc7\u6ee4\u6574\u4efd\u843d\u76d8\u6587\u4ef6\uff0c\u5207\u51fa\u4e00\u4efd\u5b8c\u6574\u5b50\u96c6\u3002
  const exportFullLogsByPackage = async () => {
    if (!hasElectronAPI() || !selectedDevice) return;
    const pkg = logPackageFilter.trim() || packageFilter.trim();
    if (!pkg) {
      setError('\u8bf7\u5148\u5728\u300c\u5e94\u7528/\u5305\u540d\u300d\u91cc\u586b\u5199\u8981\u5bfc\u51fa\u7684\u5305\u540d');
      return;
    }
    const result = await window.electronAPI!.exportFullLogsByPackage(selectedDevice.id, pkg);
    if (result.success) {
      setError('');
      setLastExportedLogPath(result.data || null);
    } else if (result.error !== '\u53d6\u6d88\u5bfc\u51fa') {
      setError(result.error || '\u6309\u5305\u540d\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7\u5931\u8d25');
    }
  };

  const showCrashAndAnrLogs = () => {
    setFilterLevel('E');
    setUseRegexSearch(false);
    setSearchTerm('crash anr fatal exception');
  };

  const levelPriority: Record<LogEntry['level'], number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };
  const selectedDeviceId = selectedDevice?.id || '';
  const currentLogState = selectedDeviceId ? getLogState(selectedDeviceId) : null;
  const isSelectedLogcatRunning = Boolean(selectedDeviceId && runningLogDeviceIds.has(selectedDeviceId));
  const isSelectedLogPaused = Boolean(selectedDeviceId && pausedLogDeviceIds.has(selectedDeviceId));
  const selectedPerformance = selectedDeviceId ? performanceByDeviceId[selectedDeviceId] || null : null;
  const selectedPerformanceSamples = selectedDeviceId ? performanceSamplesByDeviceId[selectedDeviceId] || [] : [];
  const isSelectedCapturing = Boolean(selectedDeviceId && activeCaptureByDeviceId[selectedDeviceId]);
  const liveCaptureSession = selectedDeviceId ? activeCaptureByDeviceId[selectedDeviceId] || null : null;
  // 报告区展示：采集中=活动会话+实时样本；否则=该设备自己已加载的回看/刚停止报告（按设备隔离）。
  const selectedLoadedReport = selectedDeviceId ? loadedReportByDeviceId[selectedDeviceId] ?? null : null;
  const shownCaptureSession = isSelectedCapturing ? liveCaptureSession : selectedLoadedReport?.session ?? null;
  const shownCaptureSamples = isSelectedCapturing ? selectedPerformanceSamples : selectedLoadedReport?.samples ?? [];
  const shownCaptureMarkers = isSelectedCapturing ? [] : selectedLoadedReport?.markers ?? [];
  // 采集中报告区显示实时曲线，回看列表不应高亮任何历史会话（与护栏一致，避免高亮和报告区不一致）。
  const loadedSessionId = isSelectedCapturing ? null : (selectedLoadedReport?.session.id ?? null);
  const isSelectedCaptureBusy = Boolean(selectedDeviceId && captureBusyDeviceIds.has(selectedDeviceId));
  const selectedCaptureElapsed = selectedDeviceId ? captureElapsedByDeviceId[selectedDeviceId] || 0 : 0;
  const selectedSoftLimitNotice = selectedDeviceId ? softLimitNoticeByDeviceId[selectedDeviceId] || null : null;
  const getApkInstallStatusMeta = (status: ApkInstallStatus) => {
    switch (status) {
      case 'installing':
        return { label: '安装中', color: '#60a5fa', background: '#1d4ed822' };
      case 'success':
        return { label: '成功', color: '#22c55e', background: '#22c55e22' };
      case 'failed':
        return { label: '失败', color: '#ef4444', background: '#ef444422' };
      default:
        return { label: '等待中', color: '#9ca3af', background: '#4b556322' };
    }
  };

  const renderUnifiedInstallPanel = () => {
    const onlineDevices = devices.filter((d) => d.status === 'connected');
    const selectedOnlineCount = Array.from(installTargets).filter((id) => onlineDevices.some((d) => d.id === id)).length;
    const canStart = pendingApks.length > 0 && selectedOnlineCount > 0 && !isUnifiedInstalling;
    const activeDeviceIds = devices.map((d) => d.id).filter((id) => (apkInstallStates[id]?.queue.length || 0) > 0);
    const hasInstallDetail = activeDeviceIds.length > 0 || installLog.length > 0;

    return (
      <section style={{ backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* 标题行：标题在左，并发数/降级收到右侧，省掉单独一行配置 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', flexShrink: 0 }}>
          <h2 style={{ fontSize: '15px', fontWeight: 600, margin: 0, color: 'var(--fg-primary)' }}>{'应用安装'}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--fg-secondary)' }}>并发数
              <select className="nat" value={installConcurrency} disabled={isUnifiedInstalling} onChange={(e) => setInstallConcurrency(Number(e.target.value))} style={{ cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer' }}>
                <option value={2}>2</option><option value={4}>4</option><option value={8}>8</option><option value={0}>不限</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--fg-secondary)', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer' }}>
              <span
                onClick={(e) => { e.preventDefault(); if (!isUnifiedInstalling) setInstallAllowDowngrade(!installAllowDowngrade); }}
                style={{ width: '16px', height: '16px', flex: 'none', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: installAllowDowngrade ? 'var(--accent)' : 'transparent', border: installAllowDowngrade ? '1.5px solid var(--accent)' : '1.5px solid var(--border-strong)' }}
              >
                {installAllowDowngrade && <Icon name="check" size={12} color="#fff" />}
              </span>
              <input type="checkbox" checked={installAllowDowngrade} disabled={isUnifiedInstalling} onChange={(e) => setInstallAllowDowngrade(e.target.checked)} style={{ display: 'none' }} />允许降级覆盖
            </label>
            <button className="btn primary" onClick={startUnifiedInstall} disabled={!canStart} style={{ flexShrink: 0, gap: '6px' }}>
              <Icon name="download" size={16} />
              {isUnifiedInstalling ? '安装中…' : `安装到 ${selectedOnlineCount} 台设备`}
            </button>
          </div>
        </div>

        {/* 操作区（占比 3）：选 APK + 目标设备 + 安装按钮 */}
        <div style={{ flex: 3, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
        {/* 拖放区：无文件时图标提示，有文件时放 chip */}
        <div
          onClick={() => { if (!isUnifiedInstalling) selectApkFiles(); }}
          onDragOver={(e) => { e.preventDefault(); if (!isUnifiedInstalling) setIsApkDragOver(true); }}
          onDragEnter={(e) => { e.preventDefault(); if (!isUnifiedInstalling) setIsApkDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsApkDragOver(false); }}
          onDrop={handleApkDrop}
          style={{
            flex: 1,
            minHeight: '90px',
            display: 'flex',
            flexDirection: 'column',
            border: `1.5px dashed ${isApkDragOver ? 'var(--accent)' : 'var(--border-strong)'}`,
            backgroundColor: isApkDragOver ? 'var(--accent-soft)' : 'var(--bg-elevated)',
            borderRadius: 'var(--r-md)',
            padding: pendingApks.length > 0 ? '12px 14px' : '24px 18px',
            cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer',
            transition: 'background-color 120ms ease, border-color 120ms ease',
          }}
        >
          {pendingApks.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', color: 'var(--fg-secondary)' }}>{`已选 ${pendingApks.length} 个安装包`}</span>
                <span style={{ fontSize: '12px', color: 'var(--accent)' }}>{'＋ 点击或拖拽继续添加'}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {pendingApks.map((a) => (
                  <span key={a.path} data-tip={a.path} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-pill)', fontSize: '12px', color: 'var(--fg-primary)' }}>
                    {a.fileName}
                    <button onClick={(e) => { e.stopPropagation(); removePendingApk(a.path); }} disabled={isUnifiedInstalling} style={{ background: 'none', border: 'none', color: 'var(--fg-tertiary)', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer', padding: 0, fontSize: '13px', display: 'inline-flex', alignItems: 'center' }}><Icon name="x" size={13} /></button>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', pointerEvents: 'none' }}>
              <span style={{ width: '48px', height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)', border: '1px solid var(--accent-soft-bd)', borderRadius: '12px' }}>
                <Icon name="package-plus" size={24} color="var(--accent)" />
              </span>
              <span style={{ fontSize: '14px', fontWeight: 500, color: isApkDragOver ? 'var(--accent)' : 'var(--fg-secondary)' }}>
                {isApkDragOver ? '松开以添加 APK' : '把 .apk 拖到这里，或点击选择'}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{'支持多选'}</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span className="seclabel" style={{ margin: 0 }}>目标设备</span>
            <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{selectedOnlineCount}/{onlineDevices.length}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span className="link" onClick={() => { if (!isUnifiedInstalling) setInstallTargets(new Set(onlineDevices.map((d) => d.id))); }} style={{ fontSize: '12px', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer', opacity: isUnifiedInstalling ? 0.5 : 1 }}>全选</span>
              <span className="link" onClick={() => { if (!isUnifiedInstalling) setInstallTargets(new Set()); }} style={{ fontSize: '12px', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer', opacity: isUnifiedInstalling ? 0.5 : 1, color: 'var(--fg-tertiary)' }}>全部取消</span>
            </span>
          </div>
          {/* 目标设备：一行 3 个的紧凑网格（去掉占地方的设备 id，名字超长省略号），用 title 兜底看全名/IP。 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' }}>
            {devices.length === 0 ? (
              <div style={{ gridColumn: '1 / -1', padding: '8px', color: 'var(--fg-tertiary)', fontSize: '13px' }}>暂无已连接设备</div>
            ) : devices.map((d) => {
              const online = d.status === 'connected';
              const checked = installTargets.has(d.id);
              return (
                <label key={d.id} data-tip={`${getDeviceLabel(d)} · ${d.id}`} style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, padding: '7px 9px', backgroundColor: checked ? 'var(--accent-soft)' : 'var(--bg-elevated)', border: checked ? '1px solid var(--accent-soft-bd)' : '1px solid var(--border-default)', borderRadius: 'var(--r-sm)', cursor: online && !isUnifiedInstalling ? 'pointer' : 'not-allowed', opacity: online ? 1 : 0.5 }}>
                  <span style={{ width: '15px', height: '15px', flex: 'none', borderRadius: '4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: checked ? 'var(--accent)' : 'transparent', border: checked ? '1.5px solid var(--accent)' : '1.5px solid var(--border-strong)' }}>
                    {checked && <Icon name="check" size={11} color="#fff" />}
                  </span>
                  <input type="checkbox" checked={checked} disabled={!online || isUnifiedInstalling} onChange={() => toggleInstallTarget(d.id)} style={{ display: 'none' }} />
                  <span style={{ fontSize: '12.5px', color: 'var(--fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{getDeviceLabel(d)}</span>
                  <Badge tone={d.connectionType === 'wifi' ? 'success' : 'info'} dot>{d.connectionType === 'wifi' ? 'WiFi' : 'USB'}</Badge>
                  {!online && <span style={{ flex: 'none', fontSize: '11px', color: 'var(--fg-tertiary)' }}>离线</span>}
                </label>
              );
            })}
          </div>
        </div>
        </div>

        {/* 安装详情（占比 7）：进度 + 错误 + 安装日志 */}
        <div style={{ flex: 7, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-primary)' }}>{'安装详情'}</span>
            {installLog.length > 0 && (
              <span className="link" onClick={() => setInstallLog([])} style={{ fontSize: '12px', color: 'var(--fg-tertiary)', cursor: 'pointer' }}>{'清空日志'}</span>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '10px' }}>
            {!hasInstallDetail && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>{'安装进度、结果与日志会显示在这里'}</div>
            )}
        {activeDeviceIds.map((deviceId) => {
          const device = devices.find((d) => d.id === deviceId);
          const queue = apkInstallStates[deviceId]?.queue || [];
          const finished = queue.filter((it) => it.status === 'success' || it.status === 'failed').length;
          const hasFailed = queue.some((it) => it.status === 'failed');
          const hasSuccess = queue.some((it) => it.status === 'success');
          return (
            <div key={deviceId} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--bg-elevated)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-primary)' }}>{device ? getDeviceLabel(device) : deviceId}</span>
                <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{finished}/{queue.length} 完成</span>
                {hasFailed && <button className="btn secondary sm" onClick={() => retryDeviceInstall(deviceId)} disabled={isUnifiedInstalling}>重试失败</button>}
                {hasSuccess && <button className="btn ghost sm" onClick={() => clearCompletedApkInstalls(deviceId)} disabled={isUnifiedInstalling} style={{ marginLeft: 'auto' }}>清空成功项</button>}
              </div>
              {queue.map((item) => {
                const statusMeta = getApkInstallStatusMeta(item.status);
                const canRemove = item.status !== 'installing';
                return (
                  <div key={item.id} style={{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                      <span style={{ color: 'var(--fg-primary)', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-tip={item.fileName}>{item.fileName}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        <span style={{ color: statusMeta.color, backgroundColor: statusMeta.background, borderRadius: 'var(--r-pill)', padding: '2px 8px', fontSize: '12px' }}>{statusMeta.label}</span>
                        <button className="btn outline o-red sm" onClick={() => removeApkInstallItem(deviceId, item.id)} disabled={!canRemove}>删除</button>
                      </div>
                    </div>
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--fg-tertiary)', fontSize: '11px', marginBottom: '4px' }}>
                        <span>{item.status === 'installing' ? '正在推送并安装' : statusMeta.label}</span>
                        <span>{`${Math.round(item.progress)}%`}</span>
                      </div>
                      <div style={{ height: '5px', backgroundColor: 'var(--border-subtle)', borderRadius: 'var(--r-pill)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${item.progress}%`, backgroundColor: item.status === 'failed' ? 'var(--danger)' : item.status === 'success' ? 'var(--success)' : 'var(--accent)', transition: 'width 260ms ease' }} />
                      </div>
                    </div>
                    {item.error && (
                      <div style={{ marginTop: '6px', color: 'var(--danger)', fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.error}</div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
            {installLog.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '12px', color: 'var(--fg-secondary)' }}>{'安装日志'}</span>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: 1.7, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {installLog.map((l, i) => (
                    <div key={i} style={{ color: l.level === 'success' ? 'var(--success)' : l.level === 'error' ? 'var(--danger)' : 'var(--fg-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l.text}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    );
  };

  const hasActiveLogFilter = Boolean(
    searchTerm.trim() ||
    filterLevel !== 'all' ||
    logTagFilter.trim() ||
    logPackageFilter.trim() ||
    logPidFilter.trim()
  );
  const allLogCount = currentLogState?.store.count || 0;

  const logLevelCounts = useMemo(() => {
    void logVersion;
    return currentLogState?.store.getCounts() || createLogCounts();
  }, [logVersion, currentLogState, selectedDeviceId]);

  const filteredLogs = useMemo(() => {
    if (!hasActiveLogFilter || !currentLogState || currentLogState.store.count === 0) return [];

    const logs = currentLogState.store.toArray();
    const searchTokens = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
    const hasSearch = searchTokens.length > 0;
    const hasLevelFilter = filterLevel !== 'all';
    const tagFilter = logTagFilter.trim().toLowerCase();
    const packageFilter = logPackageFilter.trim().toLowerCase();
    const pidFilter = logPidFilter.trim();
    let searchRegex: RegExp | null = null;

    if (useRegexSearch && searchTerm.trim()) {
      try {
        searchRegex = new RegExp(searchTerm.trim(), 'i');
      } catch {
        searchRegex = null;
      }
    }
    
    return logs.filter(log => {
      if (hasLevelFilter) {
        const filterPriority = levelPriority[filterLevel as LogEntry['level']];
        const entryPriority = levelPriority[log.level];
        if (entryPriority < filterPriority) {
          return false;
        }
      }

      if (tagFilter && !log.tag.toLowerCase().includes(tagFilter)) {
        return false;
      }

      // 应用/包名过滤为「关联匹配」：跨 message+tag+包名+PID 命中即保留，与主进程抓取口径一致，
      // 这样系统服务/其它进程里提到该应用的日志也能显示，而不是只剩应用自身进程那几行。
      if (packageFilter) {
        const packageHaystack = `${log.message} ${log.tag} ${log.packageName || ''} ${log.processId}`.toLowerCase();
        if (!packageHaystack.includes(packageFilter)) {
          return false;
        }
      }

      if (pidFilter && String(log.processId) !== pidFilter) {
        return false;
      }

      if (!hasSearch && !searchRegex) {
        return true;
      }
      
      const haystack = `${log.message} ${log.tag} ${log.packageName || ''} ${log.processId}`.toLowerCase();
      return searchRegex ? searchRegex.test(haystack) : searchTokens.some(token => haystack.includes(token));
    });
  }, [logVersion, currentLogState, hasActiveLogFilter, searchTerm, filterLevel, logTagFilter, logPackageFilter, logPidFilter, useRegexSearch]);

  // 变高虚拟滚动：每条日志高度按行数变化，需先把当前可见列表物化成数组以便算累计偏移。
  const activeLogList = useMemo<LogEntry[]>(
    () => (hasActiveLogFilter ? filteredLogs : currentLogState?.store.toArray() ?? []),
    [logVersion, hasActiveLogFilter, filteredLogs, currentLogState]
  );
  const displayedLogCount = activeLogList.length;
  // 前缀和：logRowOffsets[i] = 第 i 条之前所有行的累计高度（即第 i 条的 top）；末项为总高度。
  const logRowOffsets = useMemo<number[]>(() => {
    const offsets = new Array<number>(activeLogList.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < activeLogList.length; i++) {
      offsets[i + 1] = offsets[i] + getLogRowHeight(activeLogList[i]);
    }
    return offsets;
  }, [activeLogList]);
  const totalLogHeight = logRowOffsets[logRowOffsets.length - 1] || 0;
  // 二分查找：返回最大的 i 使 logRowOffsets[i] <= y（即落在偏移 y 处的那一条）。
  const findLogRowIndexAtOffset = (y: number): number => {
    let lo = 0;
    let hi = displayedLogCount;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (logRowOffsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const visibleStartIndex = Math.max(0, findLogRowIndexAtOffset(logViewport.scrollTop) - LOG_OVERSCAN_ROWS);
  const visibleEndIndex = Math.min(
    displayedLogCount,
    findLogRowIndexAtOffset(logViewport.scrollTop + logViewport.height) + 1 + LOG_OVERSCAN_ROWS
  );
  const visibleLogs = useMemo(() => {
    const rows: Array<{ log: LogEntry; index: number }> = [];
    for (let index = visibleStartIndex; index < visibleEndIndex; index++) {
      const log = activeLogList[index];
      if (log) {
        rows.push({ log, index });
      }
    }
    return rows;
  }, [activeLogList, visibleStartIndex, visibleEndIndex]);
  const virtualTopPadding = logRowOffsets[visibleStartIndex] || 0;
  const virtualBottomPadding = Math.max(0, totalLogHeight - (logRowOffsets[visibleEndIndex] ?? totalLogHeight));

  const scrollToBottom = useCallback(() => {
    if (logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
      setIsUserScrolling(false);
    }
  }, []);

  useEffect(() => {
    if (autoScrollEnabled && !isUserScrolling && displayedLogCount > 0) {
      const container = logsContainerRef.current;
      if (container) {
        const scroll = () => {
          container.scrollTop = container.scrollHeight;
          setLogViewport({ scrollTop: container.scrollTop, height: container.clientHeight });
        };
        requestAnimationFrame(() => {
          requestAnimationFrame(scroll);
        });
      }
    }
  }, [logVersion, displayedLogCount, autoScrollEnabled, isUserScrolling]);

  const handleScroll = useCallback(() => {
    const container = logsContainerRef.current;
    if (!container) return;
    setLogViewport({ scrollTop: container.scrollTop, height: container.clientHeight });
    if (!autoScrollEnabled) return;
    
    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    
    if (isAtBottom) {
      setIsUserScrolling(false);
    } else {
      setIsUserScrolling(true);
    }
  }, [autoScrollEnabled]);

  useLayoutEffect(() => {
    if (activeTab !== 'logs' || !logsContainerRef.current) return;
    const container = logsContainerRef.current;
    setLogViewport({ scrollTop: container.scrollTop, height: container.clientHeight });
  }, [activeTab, displayedLogCount]);

  const getLevelLabel = (level: LogEntry['level']) => {
    const labels: Record<LogEntry['level'], string> = {
      V: 'Verbose',
      D: 'Debug',
      I: 'Info',
      W: 'Warn',
      E: 'Error',
      F: 'Fatal',
    };
    return labels[level];
  };

  const getLevelColor = (level: LogEntry['level']) => {
    const colors: Record<LogEntry['level'], string> = {
      V: '#6b7280',
      D: '#3b82f6',
      I: '#22c55e',
      W: '#eab308',
      E: '#ef4444',
      F: '#dc2626',
    };
    return colors[level];
  };

  const renderLogcatPanel = () => {
    // 日志级别 → Design System 级别色 token（与计数 chip、日志行级别字母统一取色）。
    const LOG_LEVEL_TOKEN: Record<LogEntry['level'], string> = {
      V: 'var(--log-verbose)',
      D: 'var(--log-debug)',
      I: 'var(--log-info)',
      W: 'var(--log-warn)',
      E: 'var(--log-error)',
      F: 'var(--log-fatal)',
    };
    return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '10px', background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)' }}>
        <button
          onClick={toggleLogcat}
          className="btn sm"
          style={isSelectedLogcatRunning
            ? { background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }
            : { background: 'var(--success)', color: '#fff', borderColor: 'var(--success)' }}
        >
          {isSelectedLogcatRunning ? '\u505c\u6b62' : '\u5f00\u59cb'}
        </button>
        <button
          onClick={toggleSelectedDevicePause}
          disabled={!isSelectedLogcatRunning}
          className="btn sm secondary"
          style={isSelectedLogPaused ? { background: 'var(--warning)', color: '#fff', borderColor: 'var(--warning)' } : undefined}
        >
          {isSelectedLogPaused ? '\u7ee7\u7eed' : '\u6682\u505c'}
        </button>
        <button
          onClick={() => {
            if (selectedDeviceId) {
              clearDeviceLogs(selectedDeviceId);
            }
          }}
          className="btn sm secondary"
        >{'\u6e05\u7a7a'}</button>
        <button onClick={exportVisibleLogs} data-tip={'导出当前可见 / 筛选后的日志（受等级、搜索与显示上限影响）'} className="btn sm secondary">{'\u5bfc\u51fa'}</button>
        <button onClick={exportFullLogs} data-tip={'从监控第一行到当前的完整原始日志（全等级，不受 2 万条上限与筛选影响）'} className="btn sm secondary">{'\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7'}</button>
        <button onClick={exportFullLogsByPackage} data-tip={'\u5728\u5b8c\u6574\u539f\u59cb\u65e5\u5fd7\u4e0a\uff0c\u7528\u300c\u5e94\u7528/\u5305\u540d\u300d\u91cc\u586b\u7684\u5305\u540d\u5173\u8054\u8fc7\u6ee4\uff0c\u5207\u51fa\u4e00\u4efd\u5b8c\u6574\u5b50\u96c6\uff08\u591a\u884c\u5806\u6808\u6574\u6761\u4fdd\u7559\uff0c\u4e0d\u91cd\u65b0\u91c7\u96c6\uff09'} className="btn sm secondary">{'\u6309\u5305\u540d\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7'}</button>
        {lastExportedLogPath && (
          <button
            onClick={async () => {
              if (!hasElectronAPI() || !lastExportedLogPath) return;
              const r = await window.electronAPI!.showItemInFolder(lastExportedLogPath);
              if (!r.success && r.error) setError(r.error);
            }}
            data-tip={`\u6253\u5f00\u6700\u8fd1\u5bfc\u51fa\u7684\u65e5\u5fd7\u6240\u5728\u6587\u4ef6\u5939\uff1a${lastExportedLogPath}`}
            className="btn sm secondary"
          >{'\ud83d\udcc2 \u6253\u5f00\u4f4d\u7f6e'}</button>
        )}
        <button onClick={showCrashAndAnrLogs} className="btn sm" style={{ background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}>{'\u5d29\u6e83/ANR'}</button>
        <button onClick={scrollToBottom} className="btn sm" style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}>{'\u5230\u5e95\u90e8'}</button>
        <button
          onClick={() => setAutoScrollEnabled(!autoScrollEnabled)}
          className="btn sm secondary"
          style={autoScrollEnabled ? { background: 'var(--success)', color: '#fff', borderColor: 'var(--success)' } : undefined}
        >
          {autoScrollEnabled ? '\u81ea\u52a8\u6eda\u52a8' : '\u624b\u52a8\u6eda\u52a8'}
        </button>
        <div style={{ marginLeft: 'auto', color: 'var(--fg-tertiary)', fontSize: '12px' }}>
          {isSelectedLogcatRunning ? (isSelectedLogPaused ? '\u5df2\u6682\u505c' : '\u91c7\u96c6\u4e2d') : '\u5df2\u505c\u6b62'} · {'\u8fd0\u884c\u8bbe\u5907'} {runningLogDeviceIds.size} · {displayedLogCount}/{allLogCount} {'\u6761\u65e5\u5fd7'}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center', padding: '12px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)' }}>
        <select className="nat" style={{ width: '130px', flexShrink: 0 }} value={filterLevel} onChange={(e) => setFilterLevel(e.target.value as LogLevelFilter)}>
          <option value="all">All levels</option>
          <option value="V">Verbose+</option>
          <option value="D">Debug+</option>
          <option value="I">Info+</option>
          <option value="W">Warn+</option>
          <option value="E">Error+</option>
          <option value="F">Fatal</option>
        </select>
        {(() => {
          // \u53ef\u4e3b\u52a8\u8f93\u5165 + \u4e0b\u62c9\u9009\u5f53\u524d\u8bbe\u5907\u5df2\u88c5\u5e94\u7528\uff08hxy0601 \u529f\u80fd\uff09\uff1a\u8f93\u5165\u5373\u6309\u5b50\u4e32\u8054\u60f3\u8fc7\u6ee4\uff0c\u5217\u8868\u4e0a\u9650 80 \u6761\u9632\u8fc7\u957f\u3002
          // \u6837\u5f0f\u7528\u8bbe\u8ba1\u7cfb\u7edf token\uff08ui-fresh \u53e3\u5f84\uff09\uff1a\u8f93\u5165\u5957 .field\uff0c\u4e0b\u62c9\u7528 bg-elevated/border-default/sh-pop\u3002
          const kw = logPackageFilter.trim().toLowerCase();
          const matched = (kw ? installedPackages.filter((p) => p.toLowerCase().includes(kw)) : installedPackages).slice(0, 80);
          return (
            <div style={{ position: 'relative', width: '230px', flexShrink: 0 }}>
              <div className="field" style={{ width: '100%' }}>
                <input
                  value={logPackageFilter}
                  onChange={(e) => { setLogPackageFilter(e.target.value); setShowLogPackageDropdown(true); }}
                  onFocus={() => setShowLogPackageDropdown(true)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setShowLogPackageDropdown(false); }}
                  onBlur={() => window.setTimeout(() => setShowLogPackageDropdown(false), 150)}
                  placeholder={'\u5e94\u7528/\u5305\u540d'}
                  style={{ width: '100%' }}
                />
              </div>
              {showLogPackageDropdown && (
                <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, maxHeight: '260px', overflowY: 'auto', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-pop)' }}>
                  {installedPackagesLoading && installedPackages.length === 0 ? (
                    <div style={{ padding: '8px 10px', color: 'var(--fg-tertiary)', fontSize: '12px' }}>\u52a0\u8f7d\u5df2\u88c5\u5e94\u7528\u4e2d\u2026</div>
                  ) : matched.length === 0 ? (
                    <div style={{ padding: '8px 10px', color: 'var(--fg-tertiary)', fontSize: '12px' }}>
                      {installedPackages.length === 0 ? '\u672a\u83b7\u53d6\u5230\u5df2\u88c5\u5e94\u7528\uff08\u53ef\u76f4\u63a5\u8f93\u5165\u5305\u540d\uff09' : '\u65e0\u5339\u914d\u7684\u5df2\u88c5\u5e94\u7528'}
                    </div>
                  ) : (
                    matched.map((pkg) => (
                      <div
                        key={pkg}
                        onMouseDown={(e) => { e.preventDefault(); setLogPackageFilter(pkg); setShowLogPackageDropdown(false); }}
                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                        data-tip={pkg}
                        style={{ padding: '7px 10px', cursor: 'pointer', color: 'var(--fg-primary)', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >{pkg}</div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })()}
        <div className="field" style={{ width: '160px', flexShrink: 0 }}><input value={logTagFilter} onChange={(e) => setLogTagFilter(e.target.value)} placeholder={'\u6807\u7b7e'} /></div>
        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: '220px' }}>
          <div className="field" style={{ width: '100%' }}>
          <input
            type="text"
            placeholder={useRegexSearch ? '\u6b63\u5219\u641c\u7d22' : '\u641c\u7d22\u65e5\u5fd7'}
            value={searchTerm}
            // 每次输入变化都重新弹出并刷新匹配的历史（visibleSearchHistory 按输入联想过滤，无匹配则自动隐藏）。
            onChange={(e) => { setSearchTerm(e.target.value); setShowSearchHistory(true); }}
            onFocus={() => setShowSearchHistory(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { recordSearchHistory(searchTerm); setShowSearchHistory(false); }
              else if (e.key === 'Escape') setShowSearchHistory(false);
            }}
            // \u8bb0\u5f55\u5173\u952e\u5b57\u5e76\u5ef6\u8fdf\u6536\u8d77\uff0c\u7559\u51fa\u65f6\u95f4\u8ba9\u4e0b\u62c9\u9879\u7684 mousedown \u5148\u89e6\u53d1\u9009\u62e9\u3002
            onBlur={() => { recordSearchHistory(searchTerm); window.setTimeout(() => setShowSearchHistory(false), 150); }}
            style={{ width: '100%' }}
          />
          </div>
          {showSearchHistory && visibleSearchHistory.length > 0 && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, maxHeight: '260px', overflowY: 'auto', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', boxShadow: 'var(--sh-pop)' }}>
              {visibleSearchHistory.map((keyword) => (
                <div
                  key={keyword}
                  // \u7528 onMouseDown + preventDefault\uff1a\u5728 input \u5931\u7126\u524d\u5b8c\u6210\u9009\u62e9\uff0c\u907f\u514d\u4e0b\u62c9\u5148\u88ab\u5173\u6389\u3002
                  onMouseDown={(e) => { e.preventDefault(); setSearchTerm(keyword); recordSearchHistory(keyword); setShowSearchHistory(false); }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '7px 10px', cursor: 'pointer', color: 'var(--fg-primary)', fontSize: '13px' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{keyword}</span>
                  <span
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removeOneSearchHistory(keyword); }}
                    data-tip={'\u4ece\u5386\u53f2\u79fb\u9664'}
                    style={{ flexShrink: 0, color: 'var(--fg-tertiary)', cursor: 'pointer', padding: '0 4px', fontSize: '14px', lineHeight: 1 }}
                  >{'\u00d7'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="field" style={{ width: '140px', flexShrink: 0 }}><input value={logPidFilter} onChange={(e) => setLogPidFilter(e.target.value.replace(/\D/g, ''))} placeholder={'\u8fdb\u7a0b PID'} /></div>
        <button onClick={() => setUseRegexSearch(!useRegexSearch)} className={useRegexSearch ? 'btn sm outline o-blue' : 'btn sm secondary'} style={{ flexShrink: 0 }}>{'\u6b63\u5219'}</button>
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--fg-tertiary)', fontSize: '12px' }}>
        {(['V', 'D', 'I', 'W', 'E', 'F'] as LogEntry['level'][]).map(level => (
          <span
            key={level}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              height: '24px',
              padding: '0 11px',
              borderRadius: 'var(--r-sm)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span style={{ color: LOG_LEVEL_TOKEN[level], fontWeight: 700 }}>{level}</span>
            <span style={{ color: 'var(--fg-tertiary)' }}>{logLevelCounts[level]}</span>
          </span>
        ))}
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', color: 'var(--fg-tertiary)' }}>{'\u4fdd\u7559'} {maxLogEntries} · {'\u6279\u91cf'} {batchUpdateSize}</span>
      </div>

      <div ref={logsContainerRef} onScroll={handleScroll} style={{ flex: 1, background: 'var(--bg-mirror)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: '12px', minHeight: '260px' }}>
        {allLogCount === 0 && !isSelectedLogcatRunning ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--fg-tertiary)' }}>
            <div style={{ fontSize: '42px', marginBottom: '16px', fontWeight: 700, color: 'var(--border-default)' }}>{'\u65e5\u5fd7'}</div>
            <button onClick={toggleLogcat} className="btn primary">{'\u5f00\u59cb\u65e5\u5fd7'}</button>
          </div>
        ) : displayedLogCount === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>{'\u6ca1\u6709\u5339\u914d\u7684\u65e5\u5fd7'}</div>
        ) : (
          // width:max-content + minWidth:100% 让内容随最长日志行增宽，超出容器时出现横向滚动条；行与表头同宽对齐。
          <div style={{ minHeight: totalLogHeight, width: 'max-content', minWidth: '100%' }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 1, width: '100%', display: 'grid', gridTemplateColumns: '96px 64px 70px 130px 140px minmax(280px, max-content)', background: 'var(--bg-elevated)', color: 'var(--fg-tertiary)', fontWeight: 700, borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ padding: '8px' }}>{'\u65f6\u95f4'}</div>
              <div style={{ padding: '8px' }}>Level</div>
              <div style={{ padding: '8px' }}>PID</div>
              <div style={{ padding: '8px' }}>{'\u5305\u540d'}</div>
              <div style={{ padding: '8px' }}>{'\u6807\u7b7e'}</div>
              <div style={{ padding: '8px' }}>{'\u6d88\u606f'}</div>
            </div>
            <div style={{ height: virtualTopPadding }} />
            {visibleLogs.map(({ log, index }) => (
              <div
                key={`${index}-${log.id}`}
                onClick={() => setSelectedLogEntry(log)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '96px 64px 70px 130px 140px minmax(280px, max-content)',
                  width: '100%',
                  height: `${getLogRowHeight(log)}px`,
                  lineHeight: `${LOG_LINE_HEIGHT}px`,
                  padding: '4px 0',
                  boxSizing: 'border-box',
                  alignItems: 'start',
                  borderBottom: '1px solid var(--border-subtle)',
                  backgroundColor: selectedLogEntry?.id === log.id ? 'var(--bg-active)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ padding: '0 8px', color: 'var(--fg-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden' }}>{new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</div>
                <div style={{ padding: '0 8px', color: LOG_LEVEL_TOKEN[log.level], fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden' }}>{getLevelLabel(log.level)}</div>
                <div style={{ padding: '0 8px', color: 'var(--fg-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden' }}>{log.processId || '--'}</div>
                <div style={{ padding: '0 8px', color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.packageName || '--'}</div>
                <div style={{ padding: '0 8px', color: LOG_LEVEL_TOKEN[log.level], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.tag}</div>
                {/* 整条铺开多行：white-space:pre 保留换行、每个逻辑行不自动换行（高度=行数×LOG_LINE_HEIGHT 可预测）。
                    不裁切，过长单行靠日志窗口横向滚动条拖动查看；完整内容也可点开看底部详情面板。 */}
                <div style={{ padding: '0 8px', color: 'var(--fg-secondary)', whiteSpace: 'pre' }}>{log.message}</div>
              </div>
            ))}
            <div style={{ height: virtualBottomPadding }} />
          </div>
        )}
      </div>

      {selectedLogEntry && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '10px', color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)', fontSize: '12px', maxHeight: '140px', overflow: 'auto' }}>
          <div style={{ marginBottom: '6px', color: LOG_LEVEL_TOKEN[selectedLogEntry.level], fontWeight: 700 }}>
            {getLevelLabel(selectedLogEntry.level)} / {selectedLogEntry.tag} / PID {selectedLogEntry.processId || '--'}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{selectedLogEntry.message}</div>
        </div>
      )}
    </div>
    );
  };

  return (
    <div className="win" style={{ width: '100%', color: 'var(--fg-secondary)' }}>
      {/* 全局悬停提示层：data-tip 气泡挂到 body，绕开 overflow 裁剪，完整显示。 */}
      <GlobalTooltip />
      {/* 全局深色滚动条：index.css 未被入口引入，这里就地注入，和工具深色主题统一。
          仅用 webkit 规则——Electron 是 Chromium 内核，加 scrollbar-width 反而会接管并禁用自定义样式。 */}
      <style>{`
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #3a3a55; border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
        ::-webkit-scrollbar-thumb:hover { background: #50506e; background-clip: content-box; }
        ::-webkit-scrollbar-corner { background: transparent; }
        /* 全局按钮点击反馈：所有按钮按下时轻微缩放+压暗（禁用态不响应）。新按钮自动继承。 */
        button { transition: transform 0.08s ease, filter 0.12s ease; }
        button:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
        /* 瞬时动作按钮"假冷却"期内的图标转圈（配合 useCooldown）。 */
        @keyframes adm-spin { to { transform: rotate(360deg); } }
        .adm-spin { display: inline-block; animation: adm-spin 0.5s linear infinite; }
        /* 数字输入隐藏原生上下箭头，改用应用内自绘 ▲▼ 步进控件。 */
        .adm-number::-webkit-outer-spin-button, .adm-number::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .adm-number { -moz-appearance: textfield; appearance: textfield; }
      `}</style>
      {!appReady && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 3000, backgroundColor: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '320px', textAlign: 'center' }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff', marginBottom: '6px' }}>{'安卓设备监控'}</div>
            <div style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '16px' }}>{'工具启动中，请稍候…'}</div>
            <div style={{ height: '6px', backgroundColor: '#252540', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: '40%', backgroundColor: '#4a90d9', borderRadius: '3px', animation: 'admIndeterminate 1.1s ease-in-out infinite' }} />
            </div>
          </div>
          <style>{'@keyframes admIndeterminate{0%{margin-left:-40%}100%{margin-left:100%}}'}</style>
        </div>
      )}
      {installing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, backgroundColor: 'rgba(10,10,20,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '360px', textAlign: 'center', backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '12px', padding: '28px 24px' }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: '#fff', marginBottom: '10px' }}>
              {`正在安装新版本${updateStatus?.version ? ` v${updateStatus.version}` : ''}…`}
            </div>
            <div style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: 1.7 }}>
              {'工具会自动退出、安装到当前目录，'}<br />{'安装完成后自动重启，请稍候…'}
            </div>
            <div style={{ marginTop: '16px', height: '6px', backgroundColor: '#334155', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: '40%', backgroundColor: '#4a90d9', borderRadius: '3px', animation: 'admIndeterminate 1.1s ease-in-out infinite' }} />
            </div>
          </div>
          <style>{'@keyframes admIndeterminate{0%{margin-left:-40%}100%{margin-left:100%}}'}</style>
        </div>
      )}
      {updateStatus && !updateDismissed && ['available', 'downloading', 'downloaded'].includes(updateStatus.state) && (
        <div style={{ position: 'fixed', right: '16px', bottom: '16px', zIndex: 1100, width: '440px', maxWidth: 'calc(100vw - 32px)', backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '10px', padding: '16px 18px', boxShadow: '0 6px 20px rgba(0,0,0,0.45)' }}>
          {updateStatus.state === 'available' && (
            <div>
              <div style={{ fontSize: '13px', color: '#cbd5e1', fontWeight: 600, marginBottom: '8px' }}>{`发现新版本${updateStatus.version ? ` v${updateStatus.version}` : ''}`}</div>
              {updateStatus.releaseNotes && (
                <div style={{ marginBottom: '10px', maxHeight: '300px', overflowY: 'auto', fontSize: '13px', lineHeight: 1.6, color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-word', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '6px', padding: '10px 12px' }}>
                  <div style={{ color: '#9ca3af', marginBottom: '4px' }}>{'本次更新说明'}</div>
                  {updateStatus.releaseNotes}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setUpdateDismissed(true)} className="btn secondary sm">{'稍后'}</button>
                <button onClick={handleDownloadUpdate} className="btn sm" style={{ background: 'var(--success)', color: '#fff', borderColor: 'var(--success)' }}>{'立即更新'}</button>
              </div>
            </div>
          )}
          {updateStatus.state === 'downloading' && (
            <div>
              <div style={{ fontSize: '13px', color: '#cbd5e1', marginBottom: '6px' }}>{`正在下载新版本${updateStatus.version ? ` v${updateStatus.version}` : ''} … ${updateStatus.percent ?? 0}%`}</div>
              <div style={{ height: '6px', backgroundColor: '#334155', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${updateStatus.percent ?? 0}%`, backgroundColor: '#4a90d9', transition: 'width 240ms ease' }} />
              </div>
            </div>
          )}
          {updateStatus.state === 'downloaded' && (
            <div>
              <div style={{ fontSize: '13px', color: '#86efac', fontWeight: 600, marginBottom: '8px' }}>{`新版本${updateStatus.version ? ` v${updateStatus.version}` : ''} 已就绪`}</div>
              {updateStatus.releaseNotes && (
                <div style={{ marginBottom: '10px', maxHeight: '300px', overflowY: 'auto', fontSize: '13px', lineHeight: 1.6, color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-word', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '6px', padding: '10px 12px' }}>
                  <div style={{ color: '#9ca3af', marginBottom: '4px' }}>{'本次更新说明'}</div>
                  {updateStatus.releaseNotes}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setUpdateDismissed(true)} className="btn secondary sm">{'稍后'}</button>
                <button onClick={handleInstallUpdate} className="btn sm" style={{ background: 'var(--success)', color: '#fff', borderColor: 'var(--success)' }}>{'立即安装并重启'}</button>
              </div>
            </div>
          )}
          {updateStatus.state === 'error' && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <span style={{ flex: 1, fontSize: '12px', color: '#fca5a5', wordBreak: 'break-all' }}>{`检查更新失败：${updateStatus.error ?? ''}`}</span>
              <button onClick={() => setUpdateDismissed(true)} className="btn secondary sm" style={{ flexShrink: 0 }}>{'知道了'}</button>
            </div>
          )}
        </div>
      )}
      <header className="appbar" style={{ justifyContent: 'space-between', paddingLeft: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* \u5207\u6362\u6309\u94ae\u653e\u8fdb 56px \u5bb9\u5668\u5c45\u4e2d\uff1a\u4e0e\u6298\u53e0\u540e\u7684\u8bbe\u5907\u5757\u7ad6\u6761\u5bf9\u9f50\uff0c\u4e14\u6309\u94ae\u5c3a\u5bf8(40\u00d740)\u4e0e\u8bbe\u5907\u5757\u4e00\u81f4 */}
        <div style={{ width: '56px', flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        <button
          onClick={() => setSidebarCollapsed((v) => !v)}
          data-tip={sidebarCollapsed ? '\u5c55\u5f00\u8bbe\u5907\u680f' : '\u6536\u8d77\u8bbe\u5907\u680f'}
          aria-label={sidebarCollapsed ? '\u5c55\u5f00\u8bbe\u5907\u680f' : '\u6536\u8d77\u8bbe\u5907\u680f'}
          className="btn iconbtn"
          style={{ width: '40px', height: '40px', flexShrink: 0, fontSize: '18px', lineHeight: 1 }}
        >{sidebarCollapsed ? '\u00bb' : '\u00ab'}</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
          <h1 className="title" style={{ margin: 0 }}>{'\u5b89\u5353\u8bbe\u5907\u76d1\u63a7'}</h1>
          {appVersion && (
            <button
              onClick={openReleaseNotes}
              data-tip={'\u67e5\u770b\u672c\u7248\u672c\u66f4\u65b0\u65e5\u5fd7'}
              style={{ fontSize: '12px', color: '#93c5fd', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline dotted' }}
            >v{appVersion}</button>
          )}
          <button
            onClick={handleCheckUpdate}
            disabled={checkResult === '\u68c0\u67e5\u4e2d\u2026'}
            data-tip={'\u5411\u66f4\u65b0\u670d\u52a1\u5668\u68c0\u67e5\u662f\u5426\u6709\u65b0\u7248\u672c'}
            style={{ fontSize: '12px', color: '#cbd5e1', background: 'none', border: '1px solid #454560', borderRadius: '6px', cursor: checkResult === '\u68c0\u67e5\u4e2d\u2026' ? 'not-allowed' : 'pointer', padding: '2px 8px', opacity: checkResult === '\u68c0\u67e5\u4e2d\u2026' ? 0.6 : 1 }}
          >{'\u68c0\u67e5\u66f4\u65b0'}</button>
          {/* \u542f\u52a8\u65f6\u9759\u9ed8\u68c0\u67e5\u5230\u65b0\u7248 \u2192 \u5728\u6309\u94ae\u65c1\u5e38\u9a7b\u9192\u76ee\u63d0\u793a\uff08\u4e0d\u81ea\u52a8\u66f4\u65b0\uff0c\u7531\u7528\u6237\u70b9\u66f4\u65b0\uff09 */}
          {updateStatus?.state === 'available' && (
            <button
              onClick={() => setUpdateDismissed(false)}
              data-tip={'\u70b9\u67e5\u770b\u5e76\u66f4\u65b0'}
              style={{ fontSize: '12px', fontWeight: 700, color: '#fff', backgroundColor: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', padding: '2px 8px' }}
            >{`\u6709\u65b0\u7248\u672c${updateStatus.version ? ` v${updateStatus.version}` : ''}`}</button>
          )}
          {updateStatus?.state === 'downloaded' && (
            <button
              onClick={() => setUpdateDismissed(false)}
              data-tip={'\u70b9\u7acb\u5373\u5b89\u88c5\u5e76\u91cd\u542f'}
              style={{ fontSize: '12px', fontWeight: 700, color: '#fff', backgroundColor: '#16a34a', border: 'none', borderRadius: '6px', cursor: 'pointer', padding: '2px 8px' }}
            >{'\u65b0\u7248\u5df2\u5c31\u7eea'}</button>
          )}
          {checkResult && updateStatus?.state !== 'available' && updateStatus?.state !== 'downloaded' && (
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>{checkResult}</span>
          )}
        </div>
        </div>
      </header>
      {showReleaseNotes && (
        <div onClick={() => setShowReleaseNotes(false)} style={{ position: 'fixed', inset: 0, zIndex: 1200, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '460px', maxHeight: '70vh', display: 'flex', flexDirection: 'column', backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '12px', padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <h2 style={{ fontSize: '15px', fontWeight: 700, margin: 0 }}>{'\u66f4\u65b0\u65e5\u5fd7'} {appVersion ? `v${appVersion}` : ''}</h2>
              <button onClick={() => setShowReleaseNotes(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}>{'\u00d7'}</button>
            </div>
            <div style={{ overflowY: 'auto', fontSize: '13px', color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>
              {releaseNotesText.trim() ? releaseNotesText : '\u6682\u65e0\u672c\u7248\u672c\u66f4\u65b0\u8bf4\u660e\u3002'}
            </div>
          </div>
        </div>
      )}
      
      <div className="main" style={{ overflow: 'hidden' }}>
        {/* 折叠后的最小设备轨道：保留快捷切换设备能力，其余横向空间让给主模块。
            每台设备一个小方块（USB=U / WiFi=W + 在线状态点 + 选中高亮），点击即切换，hover 看全名。 */}
        {sidebarCollapsed && (
          <div style={{ width: '56px', flexShrink: 0, background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '56px 0 10px', overflowY: 'auto', overflowX: 'hidden' }}>
            {devices.map((device) => {
              const selected = selectedDevice?.id === device.id;
              const statusMeta = getDeviceStatusMeta(device.status);
              const isWifi = device.connectionType === 'wifi';
              // 方块显示 SN 后 4 位以区分设备；无 SN 时回退连接方式字母。
              const snTail = device.serialNo && device.serialNo !== 'Unknown' ? device.serialNo.slice(-4) : (isWifi ? 'W' : 'U');
              return (
                <button
                  key={device.id}
                  onClick={() => setSelectedDevice(device)}
                  data-tip={`${getDeviceLabel(device)} · ${isWifi ? 'WiFi' : 'USB'} · ${statusMeta.label}${device.serialNo ? ` · SN ${device.serialNo}` : ''}`}
                  style={{
                    position: 'relative',
                    width: '40px',
                    height: '40px',
                    flexShrink: 0,
                    borderRadius: 'var(--r-sm)',
                    border: selected ? '1px solid var(--border-selected)' : '1px solid var(--border-default)',
                    backgroundColor: selected ? 'var(--accent)' : 'var(--bg-elevated)',
                    color: 'var(--fg-primary)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    letterSpacing: '0.3px',
                  }}
                >
                  {snTail}
                  <span style={{ position: 'absolute', top: '2px', right: '2px', width: '8px', height: '8px', borderRadius: '999px', backgroundColor: statusMeta.color, border: '1.5px solid var(--bg-sidebar)' }} />
                </button>
              );
            })}
          </div>
        )}
        {/* 侧栏用 flex 列 + 各区块 order 控制顺序：ADB状态(0) → WiFi连接(1) → 设备列表(2) → 设备信息(3) → 历史设备(4)。
            用 order 而非物理调整 JSX 顺序，避免大段含中文的块搬运出错；ADB 状态保持默认 order 0 居首。
            侧栏可折叠：展开 360px(对齐 Design System)，折叠 0；配色用 token。 */}
        <aside style={{ width: sidebarCollapsed ? 0 : '360px', minWidth: 0, flexShrink: 0, background: 'var(--bg-sidebar)', borderRight: sidebarCollapsed ? 'none' : '1px solid var(--border-subtle)', padding: sidebarCollapsed ? 0 : '16px', overflowY: sidebarCollapsed ? 'hidden' : 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', transition: 'width 0.22s ease, padding 0.22s ease' }}>
          {adbStatus && (
            <div
              style={{
                marginBottom: '16px',
                padding: '11px 13px',
                borderRadius: 'var(--r-md)',
                background: adbStatus.available ? 'var(--success-soft)' : 'var(--danger-soft)',
                border: `1px solid ${adbStatus.available ? '#54C08455' : '#E0746C55'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 600, color: adbStatus.available ? 'var(--success)' : 'var(--danger)', marginBottom: '4px' }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: adbStatus.available ? 'var(--success)' : 'var(--danger)', flexShrink: 0 }} />
                {adbStatus.available
                  ? `${adbStatus.source === 'bundled' ? '内置' : '系统'} ADB 已就绪${adbStatus.version ? ` · ${adbStatus.version}` : ''}`
                  : 'ADB 不可用'}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--fg-secondary)', lineHeight: 1.5 }}>{adbStatus.message}</div>
              {adbStatus.hint && !adbStatus.available && (
                <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--danger)', lineHeight: 1.5 }}>{adbStatus.hint}</div>
              )}
              {adbStatus.path && (
                <div style={{ marginTop: '6px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--fg-tertiary)', wordBreak: 'break-all' }}>{adbStatus.path}</div>
              )}
            </div>
          )}

          <div style={{ order: 2 }}>
          <div className="seclabel">{'\u8bbe\u5907\u5217\u8868'}</div>
          <div style={{ display: 'flex', gap: '8px', margin: '0 0 12px 0' }}>
            <button onClick={loadDevices} className="btn secondary" style={{ flex: 1, justifyContent: 'center' }}>
              <Icon name="refresh-cw" />刷新设备
            </button>
            <button onClick={connectUSBDevice} className="btn secondary" style={{ flex: 1, justifyContent: 'center' }}>
              <Icon name="usb" />连接 USB
            </button>
          </div>
          
          {devices.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--fg-tertiary)' }}>
              <p style={{ fontSize: '14px' }}>
                {adbStatus && !adbStatus.available ? 'ADB 不可用，暂时无法读取设备' : '\u672a\u8fde\u63a5\u8bbe\u5907'}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {devices.map(device => {
                const statusMeta = getDeviceStatusMeta(device.status);
                const wifiLatencyLabel = getWifiLatencyLabel(device);
                return (
                <div
                  key={device.id}
                  style={{
                    padding: '15px',
                    borderRadius: 'var(--r-md)',
                    cursor: 'pointer',
                    background: 'var(--bg-panel)',
                    border: `1px solid ${selectedDevice?.id === device.id ? 'var(--border-selected)' : 'var(--border-default)'}`,
                    boxShadow: selectedDevice?.id === device.id ? '0 0 0 1px var(--border-selected)' : 'none'
                  }}
                  onClick={() => setSelectedDevice(device)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: '15px', color: 'var(--fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getDeviceLabel(device)}</span>
                    {device.connectionType === 'wifi'
                      ? <Badge tone="info" icon="wifi">WiFi</Badge>
                      : <Badge tone="neutral" icon="usb">USB</Badge>}
                    </div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: statusMeta.color, flexShrink: 0 }}>
                      <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: statusMeta.color, flexShrink: 0 }} />
                      {statusMeta.label}
                    </span>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '2px' }}>
                    {'SN'}: {device.serialNo || '--'}
                  </div>
                  {device.connectionType === 'wifi' && (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--fg-tertiary)' }}>{device.id}</div>
                  )}
                  <div style={{ marginTop: '10px', paddingBottom: '10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                      {renderBatteryBadge(device)}
                      {renderScreenStateBadge(device)}
                    </div>
                    {wifiLatencyLabel && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: device.latencyStatus === 'timeout' ? 'var(--warning)' : 'var(--info)' }}>
                        <Icon name="activity" size={12} color={device.latencyStatus === 'timeout' ? 'var(--warning)' : 'var(--info)'} />
                        {wifiLatencyLabel}
                      </span>
                    )}
                  </div>
                  {runningLogDeviceIds.has(device.id) && (
                    <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--success)' }}>
                      {pausedLogDeviceIds.has(device.id) ? '\u65e5\u5fd7\u5df2\u6682\u505c' : '\u65e5\u5fd7\u91c7\u96c6\u4e2d'}
                    </div>
                  )}
                  {confirmRebootId === device.id ? (
                    <div style={{ marginTop: '10px', display: 'flex', gap: '6px' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmRebootId(null); handleRebootDevice(device); }}
                        className="btn sm" style={{ flex: 1, justifyContent: 'center', background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}
                      >确认重启</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmRebootId(null); }}
                        className="btn secondary sm" style={{ flex: 1, justifyContent: 'center' }}
                      >取消</button>
                    </div>
                  ) : (
                    <div style={{ marginTop: '10px', display: 'flex', border: '1px solid var(--border-default)', borderRadius: 'var(--r-sm)', overflow: 'hidden', background: 'var(--bg-elevated)' }}>
                      {([
                        { key: 'sleep', icon: 'moon', label: '息屏', busy: '息屏中…', onClick: () => handleSleepDevice(device) },
                        { key: 'wake', icon: 'sun', label: '唤醒', busy: '唤醒中…', onClick: () => handleWakeDevice(device) },
                        { key: 'unlock', icon: 'unlock', label: '解锁', busy: '解锁中…', onClick: () => handleUnlockDevice(device), title: '唤醒并上滑解锁；有 PIN/密码/手势的设备请在设备上手动输入' },
                        { key: 'reboot', icon: 'rotate-cw', label: '重启', busy: '重启中…', onClick: () => { setConfirmDisconnectId(null); setConfirmRebootId(device.id); } },
                      ] as const).map((act, idx) => (
                        <button
                          key={act.key}
                          onClick={(e) => { e.stopPropagation(); setSelectedDevice(device); act.onClick(); }}
                          disabled={Boolean(busyDeviceAction)}
                          data-tip={'title' in act ? act.title : undefined}
                          style={{
                            flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                            height: '34px', padding: '0 4px', background: 'transparent', border: 'none',
                            borderLeft: idx === 0 ? 'none' : '1px solid var(--border-default)',
                            color: 'var(--fg-secondary)', fontSize: '12px',
                            cursor: busyDeviceAction ? 'not-allowed' : 'pointer', opacity: busyDeviceAction ? 0.6 : 1,
                            transition: 'background var(--dur-fast)'
                          }}
                          onMouseEnter={(e) => { if (!busyDeviceAction) e.currentTarget.style.background = 'var(--bg-active)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <Icon name={act.icon} size={14} />
                          {busyDeviceAction?.id === device.id && busyDeviceAction.action === act.key ? act.busy : act.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div style={{ marginTop: '8px', display: 'flex', gap: '6px' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setFileBrowserDevice(device); }}
                      data-tip="浏览设备文件、下载到电脑、上传文件到设备"
                      className="btn secondary sm" style={{ flex: 1, justifyContent: 'center' }}
                    ><Icon name="folder" color="var(--gold)" />文件管理</button>
                    {confirmDisconnectId === device.id ? (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmDisconnectId(null); disconnectDevice(device); }}
                          className="btn sm" style={{ justifyContent: 'center', background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}
                        >确认断开</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmDisconnectId(null); }}
                          className="btn secondary sm" style={{ justifyContent: 'center' }}
                        >取消</button>
                      </>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmRebootId(null); setConfirmDisconnectId(device.id); }}
                        data-tip="断开设备连接"
                        className="btn sm iconbtn"
                        style={{ color: 'var(--danger)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--danger-soft)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                      ><Icon name="unplug" color="var(--danger)" /></button>
                    )}
                  </div>
                </div>
              )})}
            </div>
          )}
          </div>

          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-subtle)', order: 1 }}>
            <div className="seclabel">{'WiFi \u8fde\u63a5'}</div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <div className="field" style={{ flex: 1 }}>
                <input
                  type="text"
                  placeholder={'\u8bbe\u5907 IP \u5730\u5740:\u7aef\u53e3'}
                  value={wifiIp}
                  onChange={(e) => setWifiIp(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      connectWiFiDevice();
                    }
                  }}
                />
              </div>
              <button
                onClick={connectWiFiDevice}
                className="btn primary"
              >{'\u8fde\u63a5'}</button>
            </div>

            <div style={{ marginTop: '8px' }}>
              <span
                className="link"
                onClick={() => setShowPairForm((v) => !v)}
                style={{ fontSize: '12px' }}
              >{showPairForm ? '\u6536\u8d77\u914d\u5bf9' : 'Android 11+ \u65e0\u7ebf\u8c03\u8bd5\uff1f\u70b9\u6b64\u914d\u5bf9'}</span>
            </div>

            {showPairForm && (
              <div className="subpanel" style={{ marginTop: '8px', padding: '10px' }}>
                <div style={{ fontSize: '11px', color: 'var(--fg-secondary)', lineHeight: '1.6', marginBottom: '8px' }}>
                  {'\u8bbe\u5907\uff1a\u8bbe\u7f6e \u2192 \u5f00\u53d1\u8005\u9009\u9879 \u2192 \u65e0\u7ebf\u8c03\u8bd5 \u2192 \u300c\u4f7f\u7528\u914d\u5bf9\u7801\u914d\u5bf9\u8bbe\u5907\u300d\uff0c\u586b\u4e0b\u65b9\u5f39\u7a97\u91cc\u7684\u914d\u5bf9\u5730\u5740\uff08IP:\u7aef\u53e3\uff09\u548c 6 \u4f4d\u914d\u5bf9\u7801\u3002\u914d\u5bf9\u6210\u529f\u540e\u4f1a\u81ea\u52a8\u8fde\u63a5\u8bbe\u5907\uff0c\u65e0\u9700\u518d\u624b\u52a8\u586b\u7aef\u53e3\u3002'}
                </div>
                <div className="field" style={{ marginBottom: '8px' }}>
                  <input
                    type="text"
                    placeholder={'\u914d\u5bf9\u5730\u5740 IP:\u7aef\u53e3\uff08\u5982 192.168.1.75:37123\uff09'}
                    value={pairAddress}
                    onChange={(e) => setPairAddress(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <div className="field" style={{ flex: 1 }}>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder={'6 \u4f4d\u914d\u5bf9\u7801'}
                      value={pairCode}
                      onChange={(e) => setPairCode(e.target.value)}
                      onKeyPress={(e) => { if (e.key === 'Enter') { pairWiFiDevice(); } }}
                    />
                  </div>
                  <button
                    onClick={pairWiFiDevice}
                    disabled={pairing}
                    className="btn primary"
                  >{pairing ? '\u914d\u5bf9\u4e2d\u2026' : '\u914d\u5bf9'}</button>
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-subtle)', order: 4 }}>
            <div className="seclabel">{'\u5386\u53f2\u8bbe\u5907'}</div>
            {offlineHistoryDevices.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', lineHeight: 1.6 }}>
                {historyDevices.length === 0
                  ? '\u6682\u65e0\u5386\u53f2 WiFi \u8bbe\u5907\uff0c\u6210\u529f\u8fde\u63a5\u4e00\u6b21\u540e\u4f1a\u81ea\u52a8\u51fa\u73b0\u5728\u8fd9\u91cc\uff0c\u4e0b\u6b21\u53ef\u4e00\u952e\u5feb\u901f\u91cd\u8fde\u3002'
                  : '\u5386\u53f2 WiFi \u8bbe\u5907\u5df2\u5168\u90e8\u8fde\u63a5\uff0c\u65ad\u5f00\u6216\u91cd\u542f\u540e\u4f1a\u56de\u5230\u8fd9\u91cc\u3002'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {offlineHistoryDevices.map(item => {
                  const connecting = quickConnectingSerial === item.serialNo;
                  const editing = inlineEditSerial === item.serialNo;
                  const cardError = historyErrorBySerial[item.serialNo];
                  // 卡片标题用设备显示名，不用型号：优先当前自定义名（按上次地址匹配，重命名即时生效），
                  // 回退写入时存的显示名，再回退型号。
                  const displayName = customDeviceNames[item.lastAddress]?.trim() || item.name || item.model;
                  return (
                    <div key={item.serialNo} style={{ padding: '12px 14px', background: 'var(--bg-panel)', borderRadius: 'var(--r-md)', border: '1px solid var(--border-default)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: 'var(--fg-primary)', fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-tip={displayName}>{displayName}</span>
                        <span style={{ flexShrink: 0, fontSize: '11px', color: 'var(--fg-tertiary)', border: '1px solid var(--border-default)', padding: '2px 8px', borderRadius: 'var(--r-pill)' }}>{'\u672a\u8fde\u63a5'}</span>
                      </div>
                      <div style={{ marginTop: '6px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--fg-tertiary)', lineHeight: 1.7 }}>
                        <div style={{ wordBreak: 'break-all' }}>{'SN\uff1a'}{item.serialNo}</div>
                        <div>{'\u4e0a\u6b21\u5730\u5740\uff1a'}{item.lastAddress}</div>
                        <div>{'\u4e0a\u6b21\u8fde\u63a5\uff1a'}{formatHistoryTime(item.lastConnectedAt)}</div>
                      </div>
                      {editing && (
                        <div style={{ marginTop: '8px', display: 'flex', gap: '6px' }}>
                          <div className="field" style={{ flex: 1 }}>
                            <input
                              type="text"
                              placeholder={'\u8bbe\u5907 IP \u5730\u5740:\u7aef\u53e3'}
                              value={inlineEditValue}
                              onChange={(e) => setInlineEditValue(e.target.value)}
                              onKeyPress={(e) => { if (e.key === 'Enter' && !connecting) { handleInlineReconnectHistory(item); } }}
                            />
                          </div>
                          <button
                            onClick={() => handleInlineReconnectHistory(item)}
                            disabled={connecting}
                            className="btn primary sm"
                          >{connecting ? '\u8fde\u63a5\u4e2d\u2026' : '\u91cd\u8fde'}</button>
                        </div>
                      )}
                      {cardError && (
                        <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--danger)', lineHeight: 1.5 }}>{cardError}</div>
                      )}
                      <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {!editing && (
                          <button
                            onClick={() => handleQuickConnectHistory(item)}
                            disabled={connecting}
                            data-tip={'\u4f7f\u7528\u4e0a\u6b21\u7684 IP:\u7aef\u53e3\u5feb\u901f\u8fde\u63a5'}
                            className="btn primary sm"
                          >{connecting ? '\u8fde\u63a5\u4e2d\u2026' : '\u5feb\u901f\u8fde\u63a5'}</button>
                        )}
                        {editing && (
                          <button
                            onClick={() => { setInlineEditSerial(null); setInlineEditValue(''); clearHistoryError(item.serialNo); }}
                            className="btn secondary sm"
                          >{'\u6536\u8d77'}</button>
                        )}
                        {confirmRemoveSerial === item.serialNo ? (
                          <>
                            <button
                              onClick={() => handleRemoveHistory(item.serialNo)}
                              className="btn sm" style={{ background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}
                            >{'\u786e\u8ba4\u79fb\u9664'}</button>
                            <button
                              onClick={() => setConfirmRemoveSerial(null)}
                              className="btn secondary sm"
                            >{'\u53d6\u6d88'}</button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmRemoveSerial(item.serialNo)}
                            data-tip={'\u4ece\u5386\u53f2\u5217\u8868\u79fb\u9664\u8be5\u8bbe\u5907\uff08\u4e0d\u5f71\u54cd\u5f53\u524d\u5df2\u5efa\u7acb\u7684\u8fde\u63a5\uff09'}
                            className="btn outline o-red sm"
                          >{'\u79fb\u9664'}</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {selectedDevice && (
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-subtle)', order: 3 }}>
              <div className="seclabel">{'\u8bbe\u5907\u4fe1\u606f'}</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-secondary)' }}>
                <div style={{ marginBottom: '10px' }}>
                  <div style={{ marginBottom: '6px', color: 'var(--fg-tertiary)' }}>{'\u81ea\u5b9a\u4e49\u540d\u79f0'}</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <div className="field" style={{ flex: 1 }}>
                      <input
                        value={customDeviceNames[selectedDevice.id] || ''}
                        onChange={(e) => updateCustomDeviceName(selectedDevice.id, e.target.value)}
                        placeholder={selectedDevice.name || selectedDevice.model || selectedDevice.id}
                      />
                    </div>
                    <button
                      onClick={() => updateCustomDeviceName(selectedDevice.id, '')}
                      className="btn secondary sm"
                    >{'\u6062\u590d\u9ed8\u8ba4'}</button>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: '12.5px' }}>
                  <span style={{ color: 'var(--fg-tertiary)' }}>{'\u578b\u53f7'}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{selectedDevice.model}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: '12.5px', gap: '12px' }}>
                  <span style={{ flexShrink: 0, color: 'var(--fg-tertiary)' }}>{'\u8bbe\u5907\u5e8f\u5217\u53f7'}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)', wordBreak: 'break-all', textAlign: 'right' }}>{selectedDevice.serialNo || '--'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: '12.5px' }}>
                  <span style={{ color: 'var(--fg-tertiary)' }}>{'\u5382\u5546'}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{selectedDevice.manufacturer}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: '12.5px' }}>
                  <span style={{ color: 'var(--fg-tertiary)' }}>{'Android \u7248\u672c'}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{selectedDevice.androidVersion}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-subtle)', fontSize: '12.5px' }}>
                  <span style={{ color: 'var(--fg-tertiary)' }}>{'API \u7b49\u7ea7'}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-primary)' }}>{selectedDevice.apiLevel}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: '12.5px' }}>
                  <span style={{ color: 'var(--fg-tertiary)' }}>{'\u8fde\u63a5\u65b9\u5f0f'}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: selectedDevice.connectionType === 'wifi' ? 'var(--success)' : 'var(--info)' }}>
                    {selectedDevice.connectionType === 'wifi' ? 'WiFi' : 'USB'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </aside>
        
        <main className="stage">
            <div className="panel">
              <nav className="tabs">
                {[
                  { key: 'devices' as TabType, label: '\u8bbe\u5907', icon: 'smartphone' },
                  { key: 'logs' as TabType, label: '\u65e5\u5fd7', icon: 'scroll-text' },
                  { key: 'performance' as TabType, label: '\u6027\u80fd', icon: 'activity' },
                  { key: 'network' as TabType, label: '\u7f51\u7edc', icon: 'network' },
                  { key: 'mirror' as TabType, label: '\u6295\u5c4f', icon: 'cast' },
                  { key: 'weaknet' as TabType, label: '\u5f31\u7f51', icon: 'wifi-off' },
                ].map(tab => (
                  <button
                    key={tab.key}
                    className={'tab' + (activeTab === tab.key ? ' active' : '')}
                    onClick={() => setActiveTab(tab.key)}
                  >
                    <Icon name={tab.icon} />{tab.label}
                  </button>
                ))}
              </nav>

              <div style={{ flex: 1, overflow: 'auto', padding: '16px', minHeight: 0 }}>
                {/* 无设备时仍可进「性能」页查看采集回看（只读 + 导入）；其余 tab 显示选设备提示。 */}
                {!selectedDevice && activeTab !== 'performance' ? (
                  <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-tertiary)' }}>
                    <div style={{ textAlign: 'center' }}>
                      <h2 style={{ fontSize: '24px', fontWeight: '600', color: 'var(--fg-primary)', margin: '0 0 8px 0' }}>{'请选择设备'}</h2>
                      <p style={{ fontSize: '14px' }}>{'从左侧列表选择已连接的设备；无设备时可在「性能」页查看采集回看'}</p>
                    </div>
                  </div>
                ) : (
                <>
                {activeTab === 'devices' && (
                  <div style={{ display: 'flex', flexDirection: 'row', gap: '16px', height: '100%', alignItems: 'stretch' }}>
                    {/* 应用安装：放右侧（order 2），内部分操作区 + 安装详情两段 */}
                    <div style={{ order: 2, flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      {renderUnifiedInstallPanel()}
                    </div>

                  {/* 已安装应用：放左侧（order 1），占更宽，列表内部滚动 */}
                  <div className="subpanel" style={{ order: 1, flex: '1.4 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', padding: '16px', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', gap: '12px', flexShrink: 0 }}>
                      <h2 style={{ fontSize: '15px', fontWeight: 600, margin: 0, color: 'var(--fg-primary)', whiteSpace: 'nowrap' }}>
                        {'已安装应用'}
                        <span style={{ fontSize: '12.5px', color: 'var(--fg-tertiary)', marginLeft: '8px', fontWeight: 400 }}>
                          {installedPackagesLoading ? '加载中…' : `共 ${installedPackages.length} 个`}
                        </span>
                      </h2>
                      <div style={{ display: 'flex', gap: '8px', flex: 1, maxWidth: '420px' }}>
                        <div className="field" style={{ flex: 1, minWidth: 0 }}>
                          <Icon name="search" />
                          <input
                            type="text"
                            placeholder={'搜索包名'}
                            value={appFilter}
                            onChange={(e) => setAppFilter(e.target.value)}
                          />
                        </div>
                        <button
                          className="btn secondary sm"
                          onClick={loadInstalledPackages}
                          disabled={installedPackagesLoading}
                        ><Icon name="refresh-cw" />{'刷新'}</button>
                      </div>
                    </div>

                    {(() => {
                      const keyword = appFilter.trim().toLowerCase();
                      const matched = keyword ? installedPackages.filter(pkg => pkg.toLowerCase().includes(keyword)) : installedPackages;
                      // 当前选中设备的「NEW」集合（按设备存，切设备不丢）。新装的包浮到列表顶部，稳定排序保留原顺序。
                      const deviceNew = newlyInstalledByDevice[selectedDevice?.id || ''] || EMPTY_PACKAGE_SET;
                      const filtered = deviceNew.size > 0
                        ? [...matched].sort((a, b) => (deviceNew.has(b) ? 1 : 0) - (deviceNew.has(a) ? 1 : 0))
                        : matched;
                      if (installedPackagesLoading && installedPackages.length === 0) {
                        return <div style={{ padding: '24px', textAlign: 'center', color: '#888', fontSize: '13px' }}>{'正在读取已安装应用…'}</div>;
                      }
                      if (installedPackages.length === 0) {
                        return <div style={{ padding: '24px', textAlign: 'center', color: '#666', fontSize: '13px' }}>{'未获取到第三方应用，点击刷新重试'}</div>;
                      }
                      if (filtered.length === 0) {
                        return <div style={{ padding: '24px', textAlign: 'center', color: '#666', fontSize: '13px' }}>{'没有匹配的应用'}</div>;
                      }
                      return (
                        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                          {filtered.map(pkg => {
                            const isBusy = busyPackage === pkg;
                            const isRunning = runningPackages.has(pkg);
                            return (
                              <div
                                key={pkg}
                                className="app-row"
                                style={{ display: 'flex', alignItems: 'center', gap: '11px', padding: '8px 12px', borderTop: '1px solid var(--border-subtle)' }}
                              >
                                <AppAvatar name={pkg} size={32} />
                                <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: '12.5px', color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pkg}</span>
                                {deviceNew.has(pkg) && (
                                  <span data-tip={'本次新安装'} style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 7px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', color: 'var(--info)', background: 'var(--info-soft)', border: '1px solid var(--accent-soft-bd)', borderRadius: 'var(--r-pill)' }}>{'NEW'}</span>
                                )}
                                {isRunning && <Badge tone="success" dot>运行中</Badge>}
                                <div style={{ flexShrink: 0, display: 'flex', gap: '6px' }}>
                                  <button
                                    className="btn sm outline o-green"
                                    onClick={() => handleLaunchApp(pkg)}
                                    disabled={isBusy || isRunning}
                                    data-tip={isRunning ? '应用已在运行，无需重复启动' : undefined}
                                  >
                                    {isBusy && busyAction === 'launch' ? '启动中…' : '启动'}
                                  </button>
                                  <button
                                    className="btn sm outline o-amber"
                                    onClick={() => handleForceStopApp(pkg)}
                                    disabled={isBusy}
                                  >
                                    {isBusy && busyAction === 'stop' ? '关闭中…' : '关闭'}
                                  </button>
                                  <button
                                    className="btn sm outline o-red"
                                    onClick={() => handleUninstallApp(pkg)}
                                    disabled={isBusy}
                                  >
                                    {isBusy && busyAction === 'uninstall' ? '卸载中…' : '卸载'}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>

                  </div>
                )}

                {activeTab === 'logs' && renderLogcatPanel()}
                {activeTab === 'performance' && (
                  <PerformancePanel
                    device={selectedDevice}
                    performance={selectedPerformance}
                    captureSession={shownCaptureSession}
                    captureSamples={shownCaptureSamples}
                    isCapturing={isSelectedCapturing}
                    isCaptureBusy={isSelectedCaptureBusy}
                    isDeviceMirroring={Boolean(selectedDeviceId && mirrorSessionsByDeviceId[selectedDeviceId]?.status === 'running')}
                    elapsedMs={selectedCaptureElapsed}
                    softLimitNotice={selectedSoftLimitNotice}
                    captureMarkers={shownCaptureMarkers}
                    captureSessions={captureSessions}
                    loadedSessionId={loadedSessionId}
                    onToggleCapture={toggleCaptureSession}
                    onDismissSoftLimit={() => selectedDeviceId && dismissSoftLimit(selectedDeviceId)}
                    onSaveCaptureMarkers={saveCaptureMarkers}
                    onSaveCaptureFrame={saveCaptureFrame}
                    onSelectCaptureSession={selectCaptureSession}
                    onRenameCaptureSession={renameCaptureSession}
                    onDeleteCaptureSession={deleteCaptureSession}
                    onExportCaptureSession={exportCaptureSession}
                    onRefreshCaptureSessions={() => void refreshCaptureSessions()}
                    onImportCaptureSessions={importCaptureViaDialog}
                    onImportCapturePaths={importCapturePaths}
                    onExportSession={exportPerformanceSession}
                    lastExportedCapturePath={lastExportedCapturePath}
                    onRevealExportedCapture={revealExportedCapture}
                  />
                )}

                {activeTab === 'network' && (
                  <NetworkPanel
                    packageFilter={packageFilter}
                    onPackageFilterChange={setPackageFilter}
                    networkRequests={networkRequests}
                    selectedNetworkRequestId={selectedNetworkRequestId}
                    onSelectNetworkRequest={setSelectedNetworkRequestId}
                    onCaptureRequests={loadNetworkRequests}
                  />
                )}

                {activeTab === 'mirror' && selectedDevice && (
                  <MirrorPanel
                    deviceName={customDeviceNames[selectedDevice.id] || selectedDevice.name || selectedDevice.id}
                    isPico={isLikelyPicoDevice(selectedDevice)}
                    session={mirrorSessionsByDeviceId[selectedDevice.id] || null}
                    starting={mirrorStartingDeviceIds.has(selectedDevice.id)}
                    onStart={handleStartMirror}
                    onStop={handleStopMirror}
                    onToggleAudio={handleToggleMirrorAudio}
                  />
                )}

                {activeTab === 'weaknet' && (
                  <WeakNetPanel
                    deviceConnected={Boolean(selectedDevice)}
                    status={weakNetNeedsAuth && weakNetStatus === 'idle' ? 'need-vpn-permission' : weakNetStatus}
                    traffic={weakNetTraffic}
                    trafficHistory={weakNetTrafficHistory}
                    shaperStats={weakNetShaperStats}
                    onExportTraffic={handleExportWeakNetTraffic}
                    installedPackages={weakNetPackages}
                    loadingPackages={weakNetLoadingPackages}
                    busy={weakNetBusy}
                    errorMessage={weakNetError}
                    onRefreshPackages={loadWeakNetPackages}
                    onRefreshStatus={loadWeakNetStatus}
                    onInstallHelper={handleInstallWeakNetHelper}
                    onStart={handleStartWeakNet}
                    onStop={handleStopWeakNet}
                    onAuthorize={handleAuthorizeWeakNet}
                  />
                )}
                </>
                )}
              </div>
            </div>
        </main>
      </div>

      {fileBrowserDevice && (
        <div
          onClick={closeFileBrowser}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(900px, 92vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #1f2937' }}>
              <span style={{ fontSize: '15px', fontWeight: 700, color: '#fff' }}>
                {'📁 设备文件 · '}{customDeviceNames[fileBrowserDevice.id] || fileBrowserDevice.name || fileBrowserDevice.id}
              </span>
              <button
                onClick={closeFileBrowser}
                style={{ width: '28px', height: '28px', background: '#1f2937', border: 'none', borderRadius: '6px', color: '#cbd5e1', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}
              >×</button>
            </div>
            <div style={{ overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex' }}>
              <FilesPanel selectedDevice={fileBrowserDevice} onError={setError} />
            </div>
          </div>
        </div>
      )}

      {error && (
        <div style={{
          position: 'fixed',
          bottom: '16px',
          right: '16px',
          padding: '12px 16px',
          backgroundColor: '#ef4444',
          color: 'white', 
          borderRadius: '8px',
          fontSize: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          {error}
          <button onClick={() => setError('')} style={{ cursor: 'pointer' }}>{'\u5173\u95ed'}</button>
        </div>
      )}

      {success && (
        <div style={{
          position: 'fixed',
          bottom: error ? '72px' : '16px',
          right: '16px',
          maxWidth: '420px',
          padding: '12px 16px',
          backgroundColor: '#22c55e',
          color: 'white',
          borderRadius: '8px',
          fontSize: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          {success}
          <button onClick={() => setSuccess('')} style={{ cursor: 'pointer' }}>{'\u5173\u95ed'}</button>
        </div>
      )}

      {confirmDialog && (
        <div
          onClick={() => setConfirmDialog(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 4000, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(420px, 92vw)', backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '12px', padding: '20px 22px', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }}
          >
            <div style={{ fontSize: '14px', color: '#e5e7eb', lineHeight: 1.6, whiteSpace: 'pre-wrap', marginBottom: '18px' }}>
              {confirmDialog.message}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setConfirmDialog(null)}
                style={{ padding: '8px 16px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: '#d1d5db', fontSize: '13px', cursor: 'pointer' }}
              >{'\u53d6\u6d88'}</button>
              <button
                onClick={() => { const cb = confirmDialog.onConfirm; setConfirmDialog(null); cb(); }}
                style={{ padding: '8px 16px', backgroundColor: confirmDialog.danger ? '#dc2626' : '#2563eb', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }}
              >{confirmDialog.confirmText}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default SimpleApp;

