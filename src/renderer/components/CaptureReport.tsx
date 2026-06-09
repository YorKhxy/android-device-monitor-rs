import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { PerformanceCaptureMarker, PerformanceCaptureSession, PerformanceSample } from '../../shared/types';
import { CaptureChart } from './CaptureChart';
import { CaptureFilterPanel } from './CaptureFilterPanel';
import { Icon } from './ui';
import { captureSegmentFrame, findNearestSample, renderMetricOverlay, renderRecordingPlaceholder } from './captureReportHelpers';
import {
  buildSegmentMediaUrl,
  captureTotalMs,
  computeMarkers,
  formatClock,
  shouldCropCaptureVideo,
  type FilterCondition,
} from './perfFormat';

// 曲线 / 视频是性能模块最重要的内容，给一个较大的固定高度让它占主要区域。
const REPORT_HEIGHT = 440;

type CaptureReportProps = {
  session: PerformanceCaptureSession | null;
  samples: PerformanceSample[];
  /** true = 采集进行中（实时曲线 + 录制中占位，无时间轴）；false = 报告（视频 + 时间轴联动）。 */
  live: boolean;
  /** 采集中已用时长（毫秒），用于占位块显示。 */
  elapsedMs?: number;
  /** 加载历史会话时带入的已存过滤标记（实时/刚停止时为空）。 */
  markers?: PerformanceCaptureMarker[];
  /** 过滤后持久化标记到会话（SimpleApp 走 saveCaptureMarkers）。 */
  onSaveMarkers?: (sessionId: string, markers: PerformanceCaptureMarker[]) => void;
  /** 视频快捷截图：把当前帧 PNG dataUrl 归档到会话 screenshots/（SimpleApp 走 saveCaptureFrame），成功返回相对路径。 */
  onSaveFrame?: (sessionId: string, dataUrl: string) => Promise<string | undefined>;
  /** 回放时上抛播放头处的样本，让上层「前台应用 + 参数」块跟随回放数据（Pico/安卓口径自适应）。 */
  onActiveSampleChange?: (sample: PerformanceSample | null) => void;
};

export function CaptureReport({ session, samples, live, elapsedMs, markers, onSaveMarkers, onSaveFrame, onActiveSampleChange }: CaptureReportProps) {
  const [selectedSeriesKeys, setSelectedSeriesKeys] = useState<Set<string>>(new Set());
  const [playheadMs, setPlayheadMs] = useState(0);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);
  const [appliedMarkers, setAppliedMarkers] = useState<PerformanceCaptureMarker[]>([]);
  const [frameNote, setFrameNote] = useState<string | null>(null);
  const [capturingFrame, setCapturingFrame] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekOffsetRef = useRef<number | null>(null);
  // markers prop 可能每次渲染换新引用；只在切会话时播种，故经 ref 读取避免反复复位过滤态。
  const markersPropRef = useRef(markers);
  markersPropRef.current = markers;
  // 键盘左右键控制时间轴：用 ref 持有最新 seek 上下文（seekTo/playheadMs/totalMs/live），
  // 让早返回之前注册的 keydown effect 也能读到最新值、且不因闭包过期失效。
  const keyboardSeekRef = useRef<{ seekTo: (ms: number) => void; playheadMs: number; totalMs: number; live: boolean }>({
    seekTo: () => {},
    playheadMs: 0,
    totalMs: 0,
    live: true,
  });

  const sessionId = session?.id ?? null;
  // 切换会话 / 重新采集时复位播放态，并从该会话已存的标记还原过滤态——
  // 既显示曲线标记，也把过滤条件行重建出来（marker 含 metricKey/op/threshold），
  // 这样过滤内容一直保留、随时可调，不会执行完就消失。
  useEffect(() => {
    setPlayheadMs(0);
    setActiveSegmentIndex(0);
    setIsPlaying(false);
    setVideoSize(null);
    pendingSeekOffsetRef.current = null;
    const loadedMarkers = markersPropRef.current ?? [];
    setAppliedMarkers(loadedMarkers);
    setFilterConditions(loadedMarkers.map((m) => ({ id: `${m.metricKey}-${m.op}-${m.threshold}`, metricKey: m.metricKey, op: m.op, threshold: m.threshold })));
  }, [sessionId, live]);

  // 上抛播放头处样本（回放态）：让上层指标块跟随回放数据。采集中(live)不抛，上层用实时 performance。
  useEffect(() => {
    if (live || !session) {
      onActiveSampleChange?.(null);
      return;
    }
    onActiveSampleChange?.(findNearestSample(samples, new Date(session.startedAt), playheadMs));
  }, [live, session, samples, playheadMs, onActiveSampleChange]);

  // PC 键盘 ← / → 控制时间轴：左后退、右前进，按住 Shift 大步(5s)否则 1s。
  // 焦点在输入框/文本域/下拉/可编辑元素时不抢方向键；采集中(live)或无时长时不响应。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const ctx = keyboardSeekRef.current;
      if (ctx.live || ctx.totalMs <= 0) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      e.preventDefault();
      const step = e.shiftKey ? 5000 : 1000;
      ctx.seekTo(ctx.playheadMs + (e.key === 'ArrowLeft' ? -step : step));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!session) {
    return <div style={{ color: 'var(--fg-tertiary)', fontSize: '13px' }}>开启采集后，这里会显示本次采集的指标曲线与录屏。</div>;
  }

  const segments = session.videoSegments;
  const totalMs = captureTotalMs(session, samples);
  // 各条件独立标记，总命中点数（用于过滤面板提示与播放头显隐）。
  const markCount = appliedMarkers.reduce((sum, marker) => sum + marker.atMs.length, 0);
  const toggleSeries = (key: string) =>
    setSelectedSeriesKeys((prev) => {
      if (prev.size === 0) return new Set([key]); // 全显状态首点 → 只看这一条
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next; // 删到空集自动回到全显
    });

  const findSegmentIndex = (ms: number) => {
    if (segments.length === 0) return 0;
    const hit = segments.findIndex((s) => ms >= s.startMs && ms < s.endMs);
    if (hit >= 0) return hit;
    return ms >= segments[segments.length - 1].endMs ? segments.length - 1 : 0;
  };

  // 连续轴时间 → 分段索引 + 段内偏移：同段直接 seek，跨段切 <video> 源（remount）后由
  // onLoadedMetadata 落到偏移位置。
  const seekTo = (ms: number) => {
    const clamped = Math.max(0, Math.min(totalMs, ms));
    setPlayheadMs(clamped);
    if (segments.length === 0) return;
    const idx = findSegmentIndex(clamped);
    const seg = segments[idx];
    const offset = Math.max(0, (clamped - seg.startMs) / 1000);
    if (idx === activeSegmentIndex && videoRef.current) {
      videoRef.current.currentTime = offset;
    } else {
      pendingSeekOffsetRef.current = offset;
      setActiveSegmentIndex(idx);
    }
  };

  // 每次渲染同步键盘 seek 上下文（此处之上 seekTo / playheadMs / totalMs / live 均已定义）。
  keyboardSeekRef.current = { seekTo, playheadMs, totalMs, live };

  const handleLoadedMetadata = (video: HTMLVideoElement) => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setVideoSize((prev) =>
        prev && prev.width === video.videoWidth && prev.height === video.videoHeight ? prev : { width: video.videoWidth, height: video.videoHeight }
      );
    }
    if (pendingSeekOffsetRef.current != null) {
      video.currentTime = pendingSeekOffsetRef.current;
      pendingSeekOffsetRef.current = null;
    }
    if (isPlaying) void video.play().catch(() => undefined);
  };

  const handleTimeUpdate = (video: HTMLVideoElement) => {
    const seg = segments[activeSegmentIndex];
    if (seg) setPlayheadMs(seg.startMs + video.currentTime * 1000);
  };

  const handleEnded = () => {
    const next = activeSegmentIndex + 1;
    if (next < segments.length) {
      pendingSeekOffsetRef.current = 0;
      setPlayheadMs(segments[next].startMs);
      setActiveSegmentIndex(next); // 仍 isPlaying → onLoadedMetadata 自动续播下一段
    } else {
      setIsPlaying(false);
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      void video.play().then(() => setIsPlaying(true)).catch(() => undefined);
    }
  };

  // 点过滤命中标记：播放头与曲线游标对齐到该时间点，并暂停视频。
  const seekAndPause = (ms: number) => {
    if (videoRef.current) videoRef.current.pause();
    setIsPlaying(false);
    seekTo(ms);
  };

  const applyFilter = () => {
    const next = computeMarkers(filterConditions, samples, session.startedAt);
    setAppliedMarkers(next);
    onSaveMarkers?.(session.id, next);
  };

  const clearFilter = () => {
    setFilterConditions([]);
    setAppliedMarkers([]);
    onSaveMarkers?.(session.id, []);
  };

  const activeSegment = segments[activeSegmentIndex];
  const segmentUrl = activeSegment ? buildSegmentMediaUrl(session.id, activeSegment) : undefined;
  const shouldCrop = shouldCropCaptureVideo(session);
  const hasVideoSize = Boolean(videoSize && videoSize.width > 0 && videoSize.height > 0);
  const currentSample = findNearestSample(samples, session.startedAt, playheadMs);

  // 截当前帧自动归档：用离屏 crossOrigin video 抓 activeSegment 在播放头处的帧，不弹系统保存框。
  const handleCaptureFrame = async () => {
    if (!activeSegment || !segmentUrl || !onSaveFrame || capturingFrame) return;
    setCapturingFrame(true);
    setFrameNote(null);
    try {
      const offsetSec = Math.max(0, (playheadMs - activeSegment.startMs) / 1000);
      const dataUrl = await captureSegmentFrame(segmentUrl, offsetSec, shouldCrop);
      await onSaveFrame(session.id, dataUrl);
      setFrameNote('截图已保存');
    } catch (error) {
      setFrameNote(`截图失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setCapturingFrame(false);
      window.setTimeout(() => setFrameNote(null), 3000);
    }
  };

  const renderVideoArea = () => {
    if (live) {
      return <div style={{ height: `${REPORT_HEIGHT}px` }}>{renderRecordingPlaceholder(elapsedMs ?? 0)}</div>;
    }
    if (segments.length === 0 || !segmentUrl) {
      return (
        <div style={{ height: `${REPORT_HEIGHT}px`, borderRadius: 'var(--r-md)', backgroundColor: 'var(--bg-mirror)', border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>
          本次采集没有录屏分段。
        </div>
      );
    }
    // 单眼裁切且已知真实分辨率时：录像盒子按可用宽度 100% 铺开，高度由单眼画面比例(aspectRatio)决定。
    // 侧栏折叠腾出横向空间 → 盒子变宽 → 高度随之等比增大，录像「变大撑满」可用空间——纯 CSS 自适应，
    // 浏览器在容器尺寸变化（含侧栏 0.22s 过渡）时自动重排，无需手动测量或监听 resize。
    const useCropFill = shouldCrop && hasVideoSize && !!videoSize;
    const singleEyeRatio = videoSize
      ? `${Math.max(1, Math.floor(videoSize.width / 2))} / ${Math.max(1, videoSize.height)}`
      : undefined;
    const videoBoxStyle: CSSProperties = useCropFill
      ? { position: 'relative', width: '100%', aspectRatio: singleEyeRatio, borderRadius: 'var(--r-md)', backgroundColor: 'var(--bg-mirror)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }
      : { position: 'relative', height: `${REPORT_HEIGHT}px`, borderRadius: 'var(--r-md)', backgroundColor: 'var(--bg-mirror)', border: '1px solid var(--border-subtle)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' };
    return (
      <div>
        {/* 单眼裁切按宽度等比放大填充（hxy0601 功能），盒子配色用设计系统 token（ui-fresh 口径）。 */}
        <div style={videoBoxStyle}>
          <video
            key={activeSegmentIndex}
            ref={videoRef}
            src={segmentUrl}
            playsInline
            onLoadedMetadata={(e) => handleLoadedMetadata(e.currentTarget)}
            onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget)}
            onEnded={handleEnded}
            // 裁切填充态：video 宽 200%、靠 wrapper overflow:hidden 只露左眼，objectFit:fill 铺满盒子。
            // 未裁切 / 分辨率未知态：contain 居中；单眼在拿到真实分辨率前先隐藏，避免闪现双眼画面。
            style={useCropFill
              ? { position: 'absolute', top: 0, left: 0, width: '200%', height: '100%', objectFit: 'fill', display: 'block' }
              : { width: '100%', height: '100%', objectFit: 'contain', backgroundColor: 'var(--bg-mirror)', opacity: shouldCrop ? 0 : 1 }}
          />
          {renderMetricOverlay(currentSample)}
        </div>
        {/* 可拖动时间轴：播放头横跨整条逻辑轴，分段在轴上以刻度分隔。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '10px' }}>
          <button
            type="button"
            onClick={togglePlay}
            className="btn iconbtn"
            style={{ width: '40px', height: '40px', borderRadius: '999px', flexShrink: 0 }}
            aria-label={isPlaying ? '暂停' : '播放'}
          >
            <Icon name={isPlaying ? 'pause' : 'play'} size={18} />
          </button>
          <input
            type="range"
            min={0}
            max={Math.round(totalMs)}
            value={Math.round(playheadMs)}
            onChange={(e) => seekTo(Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer' }}
            aria-label="采集时间轴"
          />
          <div style={{ color: 'var(--fg-secondary)', fontSize: '12px', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {formatClock(playheadMs)} / {formatClock(totalMs)}
          </div>
          {onSaveFrame && (
            <button
              type="button"
              onClick={handleCaptureFrame}
              disabled={capturingFrame}
              data-tip="把当前画面存为截图（自动归档到会话）"
              className="btn secondary sm"
              style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            ><Icon name="image" />{capturingFrame ? '截图中…' : '截图'}</button>
          )}
        </div>
        {frameNote && (
          <div style={{ color: frameNote.startsWith('截图失败') ? 'var(--danger)' : 'var(--success)', fontSize: '12px', marginTop: '6px' }}>{frameNote}</div>
        )}
      </div>
    );
  };

  const showFilter = !live && samples.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* 两列等高：录像按宽度放大变高后，曲线列 stretch 跟着拉伸填满，不在下方留空。
          曲线用「相对盒 + 绝对填充」承载，避免 SVG 在百分比高度下塌缩；minHeight 兜底保证
          无录像 / 实时态仍有基础高度。 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(0, 1fr)', gap: '16px', alignItems: 'stretch' }}>
        <div style={{ position: 'relative', minHeight: `${REPORT_HEIGHT}px` }}>
          <div style={{ position: 'absolute', inset: 0 }}>
            <CaptureChart
              session={session}
              samples={samples}
              totalMs={totalMs}
              selectedSeriesKeys={selectedSeriesKeys}
              onToggleSeries={toggleSeries}
              playheadMs={playheadMs}
              showPlayhead={!live && (segments.length > 0 || markCount > 0)}
              onSeekToMs={!live && segments.length > 0 ? seekTo : undefined}
              markers={appliedMarkers}
              onMarkerClick={!live ? seekAndPause : undefined}
            />
          </div>
        </div>
        {renderVideoArea()}
      </div>
      {showFilter && (
        <CaptureFilterPanel
          conditions={filterConditions}
          onChange={setFilterConditions}
          onApply={applyFilter}
          onClear={clearFilter}
          isPico={session.provider.startsWith('pico')}
          hitCount={markCount}
          applied={appliedMarkers.length > 0}
        />
      )}
    </div>
  );
}
