import type { LogEntry } from '../../shared/types';

export const MAX_LOG_ENTRIES = 20000;
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
  private counts = createLogCounts();

  constructor(private limit: number) {}

  get count(): number {
    return this.totalCount;
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
      this.counts[entry.level]++;
    }
    this.trimToLimit();
  }

  clear(): void {
    this.chunks = [];
    this.totalCount = 0;
    this.counts = createLogCounts();
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
