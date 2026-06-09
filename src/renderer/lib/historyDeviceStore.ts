import type { DeviceInfo, HistoryDevice } from '../../shared/types';

// 历史 WiFi 设备持久化：沿用项目已有的「自定义设备名」做法（渲染层 localStorage），
// 物理上落在 Electron userData 目录下，UI 不暴露宿主绝对路径。
// key 带 v1 版本后缀，方便后续结构升级时平滑迁移。
const HISTORY_DEVICE_STORAGE_KEY = 'adm.historyDevices.v1';

// 校验从 localStorage 读出的单条记录结构，避免脏数据污染列表。
// name 为后加字段：旧记录可能缺失，校验时不强制（缺失在 load 时回退为 model），
// 避免老历史被当脏数据丢弃。
const isValidHistoryDevice = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.serialNo === 'string' &&
    item.serialNo.length > 0 &&
    typeof item.model === 'string' &&
    typeof item.lastAddress === 'string' &&
    typeof item.lastConnectedAt === 'number'
  );
};

// 归一化单条记录：补齐缺失的 name（回退型号），保证返回值满足 HistoryDevice。
const normalizeHistoryDevice = (value: Record<string, unknown>): HistoryDevice => {
  const model = String(value.model ?? '');
  const name = typeof value.name === 'string' && value.name.trim() ? value.name : model;
  return {
    serialNo: String(value.serialNo),
    name,
    model,
    lastAddress: String(value.lastAddress),
    lastConnectedAt: Number(value.lastConnectedAt),
  };
};

// 读取历史设备列表，按最近连接时间倒序。解析失败时容错返回空数组，不抛错。
export const loadHistoryDevices = (): HistoryDevice[] => {
  if (typeof window === 'undefined') return [];
  try {
    const rawValue = window.localStorage.getItem(HISTORY_DEVICE_STORAGE_KEY);
    if (!rawValue) return [];
    const parsedValue = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) return [];
    return parsedValue
      .filter(isValidHistoryDevice)
      .map((item) => normalizeHistoryDevice(item as Record<string, unknown>))
      .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  } catch {
    return [];
  }
};

export const saveHistoryDevices = (list: HistoryDevice[]) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(HISTORY_DEVICE_STORAGE_KEY, JSON.stringify(list));
};

// 写入/更新一条历史：按 serialNo 去重，存在则覆盖 lastAddress/lastConnectedAt/model，
// 不存在则新增。返回排序后的新列表，调用方据此刷新状态。
export const upsertHistoryDevice = (
  list: HistoryDevice[],
  entry: HistoryDevice
): HistoryDevice[] => {
  const next = list.filter((item) => item.serialNo !== entry.serialNo);
  next.push(entry);
  next.sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  return next;
};

// 按 serialNo 移除一条历史，返回新列表。
export const removeHistoryDevice = (
  list: HistoryDevice[],
  serialNo: string
): HistoryDevice[] => list.filter((item) => item.serialNo !== serialNo);

// 仅当设备通过 WiFi 成功连接、且带有有效 serialNo 时，从 DeviceInfo 构造一条历史记录。
// USB 设备即插即识别，无需记忆，返回 null。
export const buildHistoryEntryFromDevice = (
  device: DeviceInfo,
  displayName: string,
  connectedAt: number
): HistoryDevice | null => {
  if (device.connectionType !== 'wifi') return null;
  const serialNo = device.serialNo?.trim();
  if (!serialNo) return null;
  const model = device.model || device.name || serialNo;
  return {
    serialNo,
    name: displayName.trim() || model,
    model,
    lastAddress: device.id,
    lastConnectedAt: connectedAt,
  };
};

// 历史卡片「上次连接时间」的本地时间展示，格式 YYYY-MM-DD HH:mm。
export const formatHistoryTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};
