import type { LogEntry } from '../../shared/types';

// 内存环形缓冲上限。对齐 Android Studio「连上回放整缓冲」后历史量更大，且变高虚拟滚动渲染成本 O(视口)
// 非 O(总量)，5 万行无渲染压力。完整日志另有落盘(device-logs/)，UI 超限丢最旧不丢盘。
export const MAX_LOG_ENTRIES = 50000;
export const BATCH_UPDATE_SIZE = 50;
export const BATCH_UPDATE_DELAY = 100;
export const MAX_PENDING_LOG_BUFFER = 2000;
export const LOG_CHUNK_SIZE = 512;
export const LOG_ROW_HEIGHT = 28;
// 单条日志内每个文本行的高度。多行日志整条铺开时，行高 = 行数 × LOG_LINE_HEIGHT + 垂直内边距，
// 使单行日志仍为 LOG_ROW_HEIGHT（20 + 8），高度可由换行数确定性算出，供变高虚拟滚动使用。
export const LOG_LINE_HEIGHT = 20;
export const LOG_OVERSCAN_ROWS = 12;

export type LogCounts = Record<LogEntry['level'], number>;

export const createLogCounts = (): LogCounts => ({ V: 0, D: 0, I: 0, W: 0, E: 0, F: 0 });

export class ChunkedLogStore {
  private chunks: LogEntry[][] = [];
  private totalCount = 0;
  // 单调累计 append 数：永不随淘汰减少（淘汰只动 totalCount）。增量过滤据此定位「自上次以来的新增条目」
  // 并算出当前最旧条目的全局序号（appendedTotal - count），用于把已滚出环形缓冲的匹配项从筛选结果里剔除。
  private appended = 0;
  private counts = createLogCounts();

  constructor(private limit: number) {}

  get count(): number {
    return this.totalCount;
  }

  // 累计 append 过的条目总数（含已淘汰），单调递增；clear 归零。
  get appendedTotal(): number {
    return this.appended;
  }

  setLimit(limit: number): void {
    this.limit = limit;
    this.trimToLimit();
  }

  append(entries: LogEntry[]): void {
    for (const entry of entries) {
      let chunk = this.chunks[this.chunks.length - 1];
      if (!chunk || chunk.length >= LOG_CHUNK_SIZE) {
        chunk = [];
        this.chunks.push(chunk);
      }
      chunk.push(entry);
      this.totalCount++;
      this.appended++;
      this.counts[entry.level]++;
    }
    this.trimToLimit();
  }

  clear(): void {
    this.chunks = [];
    this.totalCount = 0;
    this.appended = 0;
    this.counts = createLogCounts();
  }

  // 取最近 n 条（保持原顺序）。增量过滤用它只扫新增的那一小段，而非每次重扫整个缓冲。
  tail(n: number): LogEntry[] {
    const count = Math.min(n, this.totalCount);
    if (count <= 0) return [];
    const startGlobal = this.totalCount - count;
    const out: LogEntry[] = [];
    let gi = 0;
    for (const chunk of this.chunks) {
      if (gi + chunk.length <= startGlobal) {
        gi += chunk.length;
        continue;
      }
      const from = Math.max(0, startGlobal - gi);
      for (let i = from; i < chunk.length; i++) out.push(chunk[i]);
      gi += chunk.length;
    }
    return out;
  }

  get(index: number): LogEntry | undefined {
    if (index < 0 || index >= this.totalCount) return undefined;
    let offset = index;
    for (const chunk of this.chunks) {
      if (offset < chunk.length) return chunk[offset];
      offset -= chunk.length;
    }
    return undefined;
  }

  getCounts(): LogCounts {
    return { ...this.counts };
  }

  toArray(): LogEntry[] {
    return this.chunks.flat();
  }

  private trimToLimit(): void {
    let overflow = this.totalCount - this.limit;
    while (overflow > 0 && this.chunks.length > 0) {
      const firstChunk = this.chunks[0];
      if (overflow >= firstChunk.length) {
        for (const entry of firstChunk) {
          this.counts[entry.level]--;
        }
        overflow -= firstChunk.length;
        this.totalCount -= firstChunk.length;
        this.chunks.shift();
      } else {
        const removed = firstChunk.splice(0, overflow);
        for (const entry of removed) {
          this.counts[entry.level]--;
        }
        this.totalCount -= removed.length;
        overflow = 0;
      }
    }
  }
}

export type DeviceLogState = {
  store: ChunkedLogStore;
  buffer: LogEntry[];
  updateScheduled: boolean;
  flushTimer: number | null;
  running: boolean;
  paused: boolean;
};

export const createDeviceLogState = (limit: number): DeviceLogState => ({
  store: new ChunkedLogStore(limit),
  buffer: [],
  updateScheduled: false,
  flushTimer: null,
  running: false,
  paused: false,
});
