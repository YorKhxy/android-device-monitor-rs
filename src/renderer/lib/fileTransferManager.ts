import type { PushProgress, PullProgress, PullFilesResult, TransferResumeBatch, TransferBatchResult } from '@/shared/types';
import { hasElectronAPI, ElectronResult } from './electronApi';

// 文件传输（上传 / 批量下载）状态管理器——单例，存活于模块作用域，不随 FilesPanel 卸载而消失。
// 关闭文件管理界面时只卸载 UI，传输仍在主进程继续，进度状态保留在这里；重新打开时订阅即可显示回正在进行的进度。
type TransferState = {
  upload: PushProgress | null;
  uploadDir: string | null; // 上传目标目录（设备端路径），用于进度条展示「正在往哪传」
  pull: PullProgress | null;
  pullDir: string | null; // 下载来源目录（设备端路径），用于进度条展示与「点击前往」
  deviceId: string | null; // 当前传输所属设备，重开界面时据此判断是否显示进度
};

let state: TransferState = { upload: null, uploadDir: null, pull: null, pullDir: null, deviceId: null };
let activeUploadId: string | null = null;
let activePullId: string | null = null;
const listeners = new Set<() => void>();
let initialized = false;

const emit = () => {
  // 每次都换新引用，方便 React 以 setState(snapshot) 触发重渲染
  state = { ...state };
  listeners.forEach((listener) => listener());
};

// 进度订阅只在主进程层注册一次并常驻，不随组件挂载/卸载增减，避免关界面后丢失进度更新。
const ensureInit = () => {
  if (initialized || !hasElectronAPI() || !window.electronAPI) return;
  initialized = true;
  window.electronAPI.onPushProgress?.((progress) => {
    if (progress.uploadId !== activeUploadId) return;
    state.upload = progress;
    emit();
  });
  window.electronAPI.onPullProgress?.((progress) => {
    if (progress.pullId !== activePullId) return;
    state.pull = progress;
    emit();
  });
};

export const getTransferState = (): TransferState => state;

export const subscribeTransfer = (callback: () => void): (() => void) => {
  ensureInit();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
};

// 是否有传输进行中（可选限定设备）
export const isTransferActive = (deviceId?: string): boolean => {
  const active = Boolean(state.upload || state.pull);
  if (!deviceId) return active;
  return active && state.deviceId === deviceId;
};

// 发起上传。进度状态写入管理器，调用方拿到最终结果做提示/刷新；即使界面已关，传输仍在主进程跑完并清理进度。
export const startUpload = async (
  deviceId: string,
  remoteDir: string,
  localPaths: string[]
): Promise<ElectronResult<number>> => {
  ensureInit();
  if (!hasElectronAPI() || !window.electronAPI) {
    return { success: false, error: 'Electron 接口不可用' };
  }
  const uploadId = `up-${Date.now()}-${localPaths.length}`;
  activeUploadId = uploadId;
  state.deviceId = deviceId;
  state.uploadDir = remoteDir;
  state.upload = { uploadId, fileName: '', index: 0, total: localPaths.length, percent: 0, status: 'uploading' };
  emit();
  try {
    return await window.electronAPI.pushDeviceFile(deviceId, remoteDir, localPaths, uploadId);
  } finally {
    activeUploadId = null;
    state.upload = null;
    state.uploadDir = null;
    emit();
  }
};

// 发起批量下载。语义同上。
export const startPullFiles = async (
  deviceId: string,
  items: { path: string; name: string }[],
  sourceDir: string
): Promise<ElectronResult<PullFilesResult>> => {
  ensureInit();
  if (!hasElectronAPI() || !window.electronAPI) {
    return { success: false, error: 'Electron 接口不可用' };
  }
  const pullId = `pull-${Date.now()}-${items.length}`;
  activePullId = pullId;
  state.deviceId = deviceId;
  state.pullDir = sourceDir;
  state.pull = { pullId, fileName: '', index: 0, total: items.length, status: 'downloading' };
  emit();
  try {
    return await window.electronAPI.pullDeviceFiles(deviceId, items, pullId);
  } finally {
    activePullId = null;
    state.pull = null;
    state.pullDir = null;
    emit();
  }
};

// 恢复一批未完成传输（启动弹窗「继续」时调用）。复用与新建传输同一套 uploadId/pullId 进度通道，
// 进度条照常显示。目标目录在主进程 journal 中，渲染层摘要无该信息，故进度条不展示「往哪传」。
export const startResumeTransfer = async (
  batch: TransferResumeBatch
): Promise<ElectronResult<TransferBatchResult>> => {
  ensureInit();
  if (!hasElectronAPI() || !window.electronAPI) {
    return { success: false, error: 'Electron 接口不可用' };
  }
  const transferId = `resume-${batch.batchId}-${Date.now()}`;
  state.deviceId = batch.deviceId;
  if (batch.direction === 'upload') {
    activeUploadId = transferId;
    state.uploadDir = null;
    state.upload = { uploadId: transferId, fileName: '', index: 0, total: batch.remaining, percent: 0, status: 'uploading' };
    emit();
    try {
      return await window.electronAPI.resumeTransfers(batch.batchId, transferId);
    } finally {
      activeUploadId = null;
      state.upload = null;
      state.uploadDir = null;
      emit();
    }
  }
  activePullId = transferId;
  state.pullDir = null;
  state.pull = { pullId: transferId, fileName: '', index: 0, total: batch.remaining, status: 'downloading' };
  emit();
  try {
    return await window.electronAPI.resumeTransfers(batch.batchId, transferId);
  } finally {
    activePullId = null;
    state.pull = null;
    state.pullDir = null;
    emit();
  }
};
