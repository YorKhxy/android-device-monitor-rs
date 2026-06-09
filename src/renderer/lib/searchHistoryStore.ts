// 日志搜索关键字历史：持久化到渲染层 localStorage（物理落在 Electron userData 目录下），
// 重启工具后仍可在搜索框下拉直接选用。与「自定义设备名」「历史设备」同一套持久化方式。
const SEARCH_HISTORY_STORAGE_KEY = 'adm.logSearchHistory.v1';
const MAX_SEARCH_HISTORY = 20;

export const loadSearchHistory = (): string[] => {
  if (typeof window === 'undefined') return [];
  try {
    const rawValue = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!rawValue) return [];
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, MAX_SEARCH_HISTORY);
  } catch {
    return [];
  }
};

export const saveSearchHistory = (list: string[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // localStorage 写入失败（配额/隐私模式）时静默降级，不影响搜索本身。
  }
};

// 记录一次搜索关键字：去重后置顶（最近用的在最前），超出上限截断。返回新列表。
export const addSearchHistory = (list: string[], keyword: string): string[] => {
  const trimmed = keyword.trim();
  if (!trimmed) return list;
  const next = [trimmed, ...list.filter((item) => item !== trimmed)];
  return next.slice(0, MAX_SEARCH_HISTORY);
};

export const removeSearchHistory = (list: string[], keyword: string): string[] =>
  list.filter((item) => item !== keyword);
