/**
 * Tauri 桥接 shim（取代原 Electron preload 注入的 window.electronAPI）。
 *
 * 原渲染层有 97 处直接调用 window.electronAPI.*，为零改动迁移，这里构造一份
 * 实现 ElectronAPI 接口的对象并挂到 window.electronAPI：
 *   - 请求/响应方法 → @tauri-apps/api 的 invoke(命令名, 参数)
 *   - on* 事件订阅   → listen(事件名, cb)，返回取消订阅函数
 *
 * 约定：
 *   - 命令名 = ElectronAPI 方法名的 snake_case（如 getDevices → 'get_devices'）
 *   - 参数以 camelCase 传入，Rust 命令用 #[tauri::command(rename_all = "camelCase")] 接收
 *   - Rust 命令统一返回 ElectronResult<T> 形状（{ success, data, error, code, hint, details }）
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event } from '@tauri-apps/api/event';
import type { ElectronAPI, ElectronResult } from './electronApi';

// invoke 包装：始终解析为 ElectronResult；底层异常兜底成 success:false
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<ElectronResult<T>> {
  try {
    return (await invoke(cmd, args)) as ElectronResult<T>;
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// 事件订阅包装：返回同步的取消订阅函数（与原 on* 语义一致）
function sub<T>(event: string, cb: (payload: T) => void): () => void {
  const p = listen<T>(event, (ev: Event<T>) => cb(ev.payload));
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  p.then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  }).catch(() => {});
  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}

const api: ElectronAPI = {
  // —— 设备连接 ——
  getAdbStatus: () => call('get_adb_status'),
  getDevices: () => call('get_devices'),
  connectWiFi: (ip) => call('connect_wifi', { ip }),
  discoverMdnsDevices: () => call('discover_mdns_devices'),
  pairWiFi: (target, pairingCode) => call('pair_wifi', { target, pairingCode }),
  disconnect: (deviceId) => call('disconnect', { deviceId }),
  connectUSB: () => call('connect_usb'),

  // —— 日志 ——
  startLogcat: (deviceId, minLevel, packageName, pid, includeHistory) =>
    call('start_logcat', { deviceId, minLevel, packageName, pid, includeHistory }),
  stopLogcat: (deviceId) => call('stop_logcat', { deviceId }),

  // —— 性能/采集 ——
  getPerformance: (deviceId) => call('get_performance', { deviceId }),
  startCaptureSession: (deviceId, recordAudio, bitRateMbps) => call('start_capture_session', { deviceId, recordAudio, bitRateMbps }),
  stopCaptureSession: (deviceId) => call('stop_capture_session', { deviceId }),
  getActiveCaptureSessions: () => call('get_active_capture_sessions'),
  listCaptureSessions: () => call('list_capture_sessions'),
  loadCaptureSession: (sessionId) => call('load_capture_session', { sessionId }),
  deleteCaptureSession: (sessionId) => call('delete_capture_session', { sessionId }),
  renameCaptureSession: (sessionId, title) => call('rename_capture_session', { sessionId, title }),
  saveCaptureMarkers: (sessionId, markers) => call('save_capture_markers', { sessionId, markers }),
  saveCaptureFrame: (sessionId, dataUrl) => call('save_capture_frame', { sessionId, dataUrl }),
  exportCaptureSession: (sessionId) => call('export_capture_session', { sessionId }),
  selectImportFiles: () => call('select_import_files'),
  importCaptureSessions: (paths) => call('import_capture_sessions', { paths }),
  exportPerformanceSession: (payload) => call('export_performance_session', { payload }),

  // —— 运行情况 ——
  getProcesses: (deviceId) => call('get_processes', { deviceId }),
  getRunningPackages: (deviceId) => call('get_running_packages', { deviceId }),
  getActivityStack: (deviceId, packageName) => call('get_activity_stack', { deviceId, packageName }),

  // —— 投屏 ——
  startMirror: (deviceId, options) => call('start_mirror', { deviceId, options }),
  stopMirror: (deviceId) => call('stop_mirror', { deviceId }),
  setMirrorAudio: (deviceId, forward) => call('set_mirror_audio', { deviceId, forward }),

  // —— 更新 ——
  checkForUpdate: () => call('check_for_update'),
  getUpdateStatus: () => call('get_update_status'),
  downloadUpdate: () => call('download_update'),
  quitAndInstallUpdate: () => call('quit_and_install_update'),

  // —— 应用安装/管理 ——
  selectApkFiles: () => call('select_apk_files'),
  installApk: (deviceId, apkPath, options, installId) => call('install_apk', { deviceId, apkPath, options, installId }),
  cancelInstall: (installId) => call('cancel_install', { installId }),
  checkApksOnDevice: (deviceId, apkPaths) => call('check_apks_on_device', { deviceId, apkPaths }),
  checkFilesExist: (paths) => call('check_files_exist', { paths }),
  onInstallProgress: (cb) => sub('install_progress', cb),
  uninstallApp: (deviceId, packageName) => call('uninstall_app', { deviceId, packageName }),
  listInstalledPackages: (deviceId) => call('list_installed_packages', { deviceId }),
  listAppLabels: (deviceId) => call('list_app_labels', { deviceId }),
  launchApp: (deviceId, packageName) => call('launch_app', { deviceId, packageName }),
  forceStopApp: (deviceId, packageName) => call('force_stop_app', { deviceId, packageName }),

  // —— 弱网 ——
  installWeakNetHelper: (deviceId) => call('install_weaknet_helper', { deviceId }),
  startWeakNet: (deviceId, profile) => call('start_weaknet', { deviceId, profile }),
  stopWeakNet: (deviceId) => call('stop_weaknet', { deviceId }),
  queryWeakNetStatus: (deviceId) => call('query_weaknet_status', { deviceId }),
  queryWeakNetTraffic: (deviceId) => call('query_weaknet_traffic', { deviceId }),
  exportWeakNetTraffic: (rows) => call('export_weaknet_traffic', { rows }),
  queryWeakNetShaperStats: (deviceId) => call('query_weaknet_shaper_stats', { deviceId }),

  // —— 文件管理/传输 ——
  listDeviceFiles: (deviceId, dirPath) => call('list_device_files', { deviceId, dirPath }),
  pullDeviceFile: (deviceId, remotePath, name, isDir) =>
    call('pull_device_file', { deviceId, remotePath, name, isDir }),
  pullDeviceFiles: (deviceId, items, pullId) => call('pull_device_files', { deviceId, items, pullId }),
  cancelTransfer: (transferId) => call('cancel_transfer', { transferId }),
  deleteDeviceFile: (deviceId, remotePath, isDir) =>
    call('delete_device_file', { deviceId, remotePath, isDir }),
  createDeviceFolder: (deviceId, dirPath, name) => call('create_device_folder', { deviceId, dirPath, name }),
  selectUploadFiles: () => call('select_upload_files'),
  pushDeviceFile: (deviceId, remoteDir, localPaths, uploadId) =>
    call('push_device_file', { deviceId, remoteDir, localPaths, uploadId }),
  resumeTransfers: (batchId, transferId) => call('resume_transfers', { batchId, transferId }),
  discardTransfers: (batchId) => call('discard_transfers', { batchId }),
  getResumeBatches: () => call('get_resume_batches'),

  // —— 系统/杂项 ——
  showItemInFolder: (localPath) => call('show_item_in_folder', { localPath }),
  openPath: (targetPath) => call('open_path', { targetPath }),
  getAppVersion: () => call('get_app_version'),
  getReleaseNotes: () => call('get_release_notes'),
  sleepDevice: (deviceId) => call('sleep_device', { deviceId }),
  wakeDevice: (deviceId) => call('wake_device', { deviceId }),
  unlockDevice: (deviceId) => call('unlock_device', { deviceId }),
  rebootDevice: (deviceId) => call('reboot_device', { deviceId }),
  exportLogs: (logs) => call('export_logs', { logs }),
  exportFullLogs: (deviceId) => call('export_full_logs', { deviceId }),
  exportFullLogsByPackage: (deviceId, packageName) =>
    call('export_full_logs_by_package', { deviceId, packageName }),
  exportDeviceLogBuffer: (deviceId) => call('export_device_log_buffer', { deviceId }),

  // —— 事件订阅 ——
  onCaptureSample: (cb) => sub('capture_sample', cb),
  onCaptureSizeLimit: (cb) => sub('capture_size_limit', cb),
  onUpdateStatus: (cb) => sub('update_status', cb),
  onMirrorStatus: (cb) => sub('mirror_status', cb),
  onPullProgress: (cb) => sub('pull_progress', cb),
  onPushProgress: (cb) => sub('push_progress', cb),
  onLogEntry: (cb) => sub('log_entry', cb),
  onLogBatch: (cb) => sub('log_batch', cb),
  onAdbStatusChanged: (cb) => sub('adb_status_changed', cb),
  onDeviceConnected: (cb) => sub('device_connected', cb),
  onDeviceDisconnected: (cb) => sub('device_disconnected', cb),
  onDeviceListChanged: (cb) => sub('device_list_changed', cb),
};

// 安装到 window，供原渲染层代码无改动调用
if (typeof window !== 'undefined') {
  window.electronAPI = api;
}

export {};
