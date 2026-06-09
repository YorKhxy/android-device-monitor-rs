import type {
  ActivityStackEntry,
  AdbStatus,
  ApkInstallResult,
  DeviceInfo,
  LogEntry,
  MirrorSession,
  MirrorStartOptions,
  NetworkRequest,
  PerformanceMetrics,
  PerformanceSessionExportPayload,
  PerformanceCaptureSession,
  PerformanceCaptureSessionDetail,
  PerformanceCaptureMarker,
  ActiveCaptureSession,
  CaptureImportResult,
  CaptureSamplePayload,
  CaptureSizeLimitPayload,
  PairResult,
  DeviceFileList,
  PushProgress,
  PullProgress,
  PullFilesResult,
  ProcessInfo,
  WeakNetworkProfile,
  WeakNetworkHelperStatus,
  WeakNetworkTraffic,
  WeakNetworkShaperStats,
  TransferResumeBatch,
  TransferBatchResult,
  UpdateStatus,
} from '../../shared/types';

export type ElectronResult<T> = {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  hint?: string;
  details?: string;
};

export interface ElectronAPI {
  getAdbStatus: () => Promise<ElectronResult<AdbStatus>>;
  getDevices: () => Promise<ElectronResult<DeviceInfo[]>>;
  connectWiFi: (ip: string) => Promise<ElectronResult<DeviceInfo>>;
  pairWiFi: (target: string, pairingCode: string) => Promise<ElectronResult<PairResult>>;
  disconnect: (deviceId: string) => Promise<ElectronResult<undefined>>;
  startLogcat: (
    deviceId: string,
    minLevel?: 'V' | 'D' | 'I' | 'W' | 'E' | 'F',
    packageName?: string,
    pid?: string
  ) => Promise<ElectronResult<undefined>>;
  stopLogcat: (deviceId: string) => Promise<ElectronResult<undefined>>;
  getPerformance: (deviceId: string) => Promise<ElectronResult<PerformanceMetrics>>;
  startCaptureSession: (deviceId: string) => Promise<ElectronResult<PerformanceCaptureSession>>;
  stopCaptureSession: (deviceId: string) => Promise<ElectronResult<PerformanceCaptureSession>>;
  getActiveCaptureSessions: () => Promise<ElectronResult<ActiveCaptureSession[]>>;
  listCaptureSessions: () => Promise<ElectronResult<PerformanceCaptureSession[]>>;
  loadCaptureSession: (sessionId: string) => Promise<ElectronResult<PerformanceCaptureSessionDetail>>;
  deleteCaptureSession: (sessionId: string) => Promise<ElectronResult<undefined>>;
  renameCaptureSession: (sessionId: string, title: string) => Promise<ElectronResult<PerformanceCaptureSession>>;
  saveCaptureMarkers: (sessionId: string, markers: PerformanceCaptureMarker[]) => Promise<ElectronResult<undefined>>;
  saveCaptureFrame: (sessionId: string, dataUrl: string) => Promise<ElectronResult<string>>;
  exportCaptureSession: (sessionId: string) => Promise<ElectronResult<string | undefined>>;
  selectImportFiles: () => Promise<ElectronResult<string[]>>;
  importCaptureSessions: (paths: string[]) => Promise<ElectronResult<CaptureImportResult>>;
  onCaptureSample: (callback: (payload: CaptureSamplePayload) => void) => () => void;
  onCaptureSizeLimit: (callback: (payload: CaptureSizeLimitPayload) => void) => () => void;
  getProcesses: (deviceId: string) => Promise<ElectronResult<ProcessInfo[]>>;
  getRunningPackages: (deviceId: string) => Promise<ElectronResult<string[]>>;
  connectUSB: () => Promise<ElectronResult<DeviceInfo[]>>;
  getActivityStack: (deviceId: string, packageName?: string) => Promise<ElectronResult<ActivityStackEntry[]>>;
  getNetworkRequests: (deviceId: string, packageName?: string) => Promise<ElectronResult<NetworkRequest[]>>;
  startMirror: (deviceId: string, options?: MirrorStartOptions) => Promise<ElectronResult<MirrorSession>>;
  stopMirror: (deviceId: string) => Promise<ElectronResult<undefined>>;
  setMirrorAudio: (deviceId: string, forward: boolean) => Promise<ElectronResult<MirrorSession>>;
  checkForUpdate: () => Promise<ElectronResult<undefined>>;
  getUpdateStatus: () => Promise<ElectronResult<UpdateStatus | null>>;
  downloadUpdate: () => Promise<ElectronResult<undefined>>;
  quitAndInstallUpdate: () => Promise<ElectronResult<undefined>>;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
  onMirrorStatus: (callback: (session: MirrorSession) => void) => () => void;
  selectApkFiles: () => Promise<ElectronResult<string[]>>;
  installApk: (deviceId: string, apkPath: string, options?: { allowDowngrade?: boolean }) => Promise<ElectronResult<ApkInstallResult>>;
  uninstallApp: (deviceId: string, packageName: string) => Promise<ElectronResult<{ packageName: string; output: string }>>;
  listInstalledPackages: (deviceId: string) => Promise<ElectronResult<string[]>>;
  installWeakNetHelper: (deviceId: string) => Promise<ElectronResult<{ output: string }>>;
  startWeakNet: (deviceId: string, profile: WeakNetworkProfile) => Promise<ElectronResult<{ output: string }>>;
  stopWeakNet: (deviceId: string) => Promise<ElectronResult<{ output: string }>>;
  queryWeakNetStatus: (deviceId: string) => Promise<ElectronResult<WeakNetworkHelperStatus>>;
  queryWeakNetTraffic: (deviceId: string) => Promise<ElectronResult<WeakNetworkTraffic | null>>;
  exportWeakNetTraffic: (rows: { at: number; rx: number; tx: number }[]) => Promise<ElectronResult<string>>;
  queryWeakNetShaperStats: (deviceId: string) => Promise<ElectronResult<WeakNetworkShaperStats | null>>;
  listDeviceFiles: (deviceId: string, dirPath: string) => Promise<ElectronResult<DeviceFileList>>;
  pullDeviceFile: (deviceId: string, remotePath: string, name: string, isDir: boolean) => Promise<ElectronResult<string>>;
  deleteDeviceFile: (deviceId: string, remotePath: string, isDir: boolean) => Promise<ElectronResult<undefined>>;
  createDeviceFolder: (deviceId: string, dirPath: string, name: string) => Promise<ElectronResult<string>>;
  showItemInFolder: (localPath: string) => Promise<ElectronResult<undefined>>;
  openPath: (targetPath: string) => Promise<ElectronResult<undefined>>;
  getAppVersion: () => Promise<ElectronResult<string>>;
  getReleaseNotes: () => Promise<ElectronResult<string>>;
  pullDeviceFiles: (deviceId: string, items: { path: string; name: string }[], pullId: string) => Promise<ElectronResult<PullFilesResult>>;
  onPullProgress: (callback: (progress: PullProgress) => void) => () => void;
  selectUploadFiles: () => Promise<ElectronResult<string[]>>;
  pushDeviceFile: (deviceId: string, remoteDir: string, localPaths: string[], uploadId: string) => Promise<ElectronResult<number>>;
  onPushProgress: (callback: (progress: PushProgress) => void) => () => void;
  resumeTransfers: (batchId: string, transferId: string) => Promise<ElectronResult<TransferBatchResult>>;
  discardTransfers: (batchId: string) => Promise<ElectronResult<undefined>>;
  getResumeBatches: () => Promise<ElectronResult<TransferResumeBatch[]>>;
  launchApp: (deviceId: string, packageName: string) => Promise<ElectronResult<{ packageName: string; output: string }>>;
  forceStopApp: (deviceId: string, packageName: string) => Promise<ElectronResult<undefined>>;
  sleepDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  wakeDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  unlockDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  rebootDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  exportLogs: (logs: LogEntry[]) => Promise<ElectronResult<string>>;
  exportFullLogs: (deviceId: string) => Promise<ElectronResult<string>>;
  exportFullLogsByPackage: (deviceId: string, packageName: string) => Promise<ElectronResult<string>>;
  exportPerformanceSession: (payload: PerformanceSessionExportPayload) => Promise<ElectronResult<string>>;
  onLogEntry: (callback: (entry: LogEntry) => void) => () => void;
  onLogBatch: (callback: (entries: LogEntry[]) => void) => () => void;
  onAdbStatusChanged: (callback: (status: AdbStatus) => void) => () => void;
  onDeviceConnected: (callback: (device: DeviceInfo) => void) => () => void;
  onDeviceDisconnected: (callback: (deviceId: string) => void) => () => void;
  onDeviceListChanged: (callback: (devices: DeviceInfo[]) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export const hasElectronAPI = (): boolean => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

export {};
