/**
 * 采集回放「视频独立窗口」（方案二）前后端契约。
 *
 * 视频被分离到独立 OS 窗口（Rust 命令 open/close_capture_popout 建窗，label = capture-popout，
 * 复用主 bundle 带 ?popout=capture）。初始化数据走拉取式：
 *   - 主窗开窗前 set_popout_session 存 {session, playheadMs}；弹出窗挂载后 get_popout_session 主动拉。
 *   - 弹出窗关闭时后端发 capture-popout-closed，主窗据此恢复内嵌。
 *   - 时间轴双向同步（第二步加）：主窗拖 → seek 事件给弹出窗；弹出窗播 → playhead 事件回主窗。
 */
import type { PerformanceCaptureSession } from '../../shared/types';

export const POPOUT_EVENTS = {
  closed: 'capture-popout-closed',
  /** 弹出窗 → 主窗：当前播放头 + 播放状态（单一主钟，主窗据此对齐游标与播放按钮）。 */
  playhead: 'capture-popout-playhead',
  /** 主窗 → 弹出窗：跳转到指定时间（pause=true 跳转并暂停）。 */
  seek: 'capture-popout-seek',
  /** 主窗 → 弹出窗：设置播放/暂停（统一播放控制，避免两窗各播各的、轴漂移）。 */
  setPlaying: 'capture-popout-set-playing',
} as const;

/** 后端交接箱里的初始化数据（get_popout_session 返回的 data）。 */
export type PopoutInit = { session: PerformanceCaptureSession; playheadMs: number };
/** 弹出窗 → 主窗：当前播放头（相对会话起点毫秒）+ 是否正在播放。 */
export type PopoutPlayhead = { ms: number; playing: boolean };
/** 主窗 → 弹出窗：跳转到指定时间（pause=true 跳转并暂停）。 */
export type PopoutSeek = { ms: number; pause?: boolean };
/** 主窗 → 弹出窗：设置播放/暂停。 */
export type PopoutSetPlaying = { playing: boolean };

/** 当前 webview 是否为视频独立窗口（main.tsx 据此渲染 CapturePopout 而非 SimpleApp）。
 *  优先认 hash(#popout=capture，资源解析安全)，兼容 query(?popout=capture)。 */
export const isCapturePopoutWindow = () => {
  if (typeof window === 'undefined') return false;
  if (window.location.hash.includes('popout=capture')) return true;
  return new URLSearchParams(window.location.search).get('popout') === 'capture';
};
