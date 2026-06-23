// APK 安装历史：持久化到渲染层 localStorage（物理落在 Electron userData 目录下），
// 重启工具后仍在，可从历史列表「加入」放回安装区再次安装。与「日志搜索历史」「历史设备」同一套持久化方式。
const APK_HISTORY_STORAGE_KEY = 'adm.apkInstallHistory.v1';
const MAX_APK_HISTORY = 100;

// 单台设备对某 APK 的安装记录（按设备 id 去重，记最近成功时间与成功次数）。供历史项 tooltip 展示「哪些设备装过、各自时间」。
export interface ApkInstallRecord {
  id: string; // 设备 id（去重键）
  label: string; // 设备标识，写入当时快照：优先 SN，无 SN 回退显示名（设备离线也能看）
  at: number; // 该设备最近一次安装成功时间戳
  count: number; // 该设备累计安装成功次数
}

// 一条安装历史：按 path 去重。exists 为运行时态（每次由后端校验文件是否还在），不持久化。
export interface ApkHistoryItem {
  path: string; // APK 在 PC 上的绝对路径，唯一标识 / 去重键
  fileName: string; // 文件名（列表主显示）
  lastInstalledAt: number; // 最近一次（任意设备）安装成功的时间戳，列表倒序排序用
  installCount: number; // 累计成功安装次数（所有设备合计）
  devices: ApkInstallRecord[]; // 各设备的安装记录，按 at 倒序
}

const isRecord = (v: unknown): v is ApkInstallRecord => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.label === 'string';
};

const normalizeDevices = (v: unknown): ApkInstallRecord[] => {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRecord)
    .map((o) => ({
      id: o.id,
      label: o.label,
      at: typeof o.at === 'number' ? o.at : 0,
      count: typeof o.count === 'number' && o.count > 0 ? o.count : 1,
    }))
    .sort((a, b) => b.at - a.at);
};

const isValidItem = (v: unknown): v is { path: string; fileName: string } => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.path === 'string' && o.path.length > 0 && typeof o.fileName === 'string';
};

export const loadApkHistory = (): ApkHistoryItem[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(APK_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidItem)
      .map((o) => {
        const r = o as Record<string, unknown>;
        return {
          path: r.path as string,
          fileName: r.fileName as string,
          lastInstalledAt: typeof r.lastInstalledAt === 'number' ? r.lastInstalledAt : 0,
          installCount: typeof r.installCount === 'number' && r.installCount > 0 ? r.installCount : 1,
          devices: normalizeDevices(r.devices), // 旧数据无 devices 字段 → 空数组（tooltip 回退「无设备记录」）
        };
      })
      .sort((a, b) => b.lastInstalledAt - a.lastInstalledAt)
      .slice(0, MAX_APK_HISTORY);
  } catch {
    return [];
  }
};

export const saveApkHistory = (list: ApkHistoryItem[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(APK_HISTORY_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // localStorage 写入失败（配额/隐私模式）时静默降级，不影响安装本身。
  }
};

// 记一次「某台设备安装成功」：按 path 去重——已存在则更新总时间/总次数、并按 deviceId 合并该设备记录；不存在则新增。置顶。返回新列表。
export const upsertApkHistory = (
  list: ApkHistoryItem[],
  entry: { path: string; fileName: string; deviceId: string; deviceLabel: string },
  now: number,
): ApkHistoryItem[] => {
  const existing = list.find((x) => x.path === entry.path);
  const rest = list.filter((x) => x.path !== entry.path);
  const prevDevices = existing?.devices ?? [];
  const devHit = prevDevices.find((d) => d.id === entry.deviceId);
  const devRest = prevDevices.filter((d) => d.id !== entry.deviceId);
  const mergedDevice: ApkInstallRecord = devHit
    ? { ...devHit, label: entry.deviceLabel, at: now, count: devHit.count + 1 }
    : { id: entry.deviceId, label: entry.deviceLabel, at: now, count: 1 };
  const devices = [mergedDevice, ...devRest].sort((a, b) => b.at - a.at);
  const merged: ApkHistoryItem = {
    path: entry.path,
    fileName: entry.fileName,
    lastInstalledAt: now,
    installCount: (existing?.installCount ?? 0) + 1,
    devices,
  };
  return [merged, ...rest].slice(0, MAX_APK_HISTORY);
};

export const removeApkHistory = (list: ApkHistoryItem[], path: string): ApkHistoryItem[] =>
  list.filter((x) => x.path !== path);

// 清理失效项：删掉所有 path 不在 existingPaths 集合里的条目。
export const pruneMissingApkHistory = (list: ApkHistoryItem[], existingPaths: Set<string>): ApkHistoryItem[] =>
  list.filter((x) => existingPaths.has(x.path));
