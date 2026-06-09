import type { CSSProperties } from 'react';
import type { PerformanceSample } from '../../shared/types';
import { formatClock, formatMemoryMb, formatMetricReading, getGpuValue, sampleElapsedMs } from './perfFormat';

// 采集进行中的视频区占位：红点 + 「录制中」+ 已用时长，工具内不回传画面。
export const renderRecordingPlaceholder = (elapsedMs: number) => (
  <div style={{ height: '100%', minHeight: '260px', borderRadius: 'var(--r-md)', backgroundColor: 'var(--bg-mirror)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'var(--fg-secondary)' }}>
    <span style={{ width: '12px', height: '12px', borderRadius: '999px', backgroundColor: 'var(--danger)', boxShadow: '0 0 0 6px var(--danger-soft)' }} />
    <div style={{ fontSize: '14px', color: 'var(--fg-primary)' }}>录制中</div>
    <div style={{ fontSize: '12px' }}>已录制 {formatClock(elapsedMs)}（采集中不在工具内回传画面）</div>
  </div>
);

// CaptureReport 的视频区辅助：单眼裁切 wrapper 样式、按时间取最近样本、视频上指标浮层。
// 抽到独立文件以保持 CaptureReport 单文件职责清晰、行数受控。

export const getSingleEyeWrapperStyle = (naturalSize: { width: number; height: number }): CSSProperties => ({
  position: 'relative',
  height: '100%',
  maxWidth: '100%',
  aspectRatio: `${Math.max(1, Math.floor(naturalSize.width / 2))} / ${Math.max(1, naturalSize.height)}`,
  overflow: 'hidden',
  backgroundColor: 'var(--bg-mirror)',
  flexShrink: 0,
});

export const findNearestSample = (samples: PerformanceSample[], startedAt: Date, targetMs: number) =>
  samples.reduce<{ sample: PerformanceSample; delta: number } | null>((best, sample) => {
    const delta = Math.abs(sampleElapsedMs(sample, startedAt) - targetMs);
    return !best || delta < best.delta ? { sample, delta } : best;
  }, null)?.sample ?? null;

// 视频快捷截图：用独立的 crossOrigin 离屏 <video> 抓取指定时间的帧，绘到 canvas 取 PNG。
// 不复用主播放器，避免给主 <video> 加 crossOrigin 影响回放；离屏 video 走 corsEnabled 的
// adm-media 协议（performanceMedia 已开 corsEnabled），canvas 不被跨域污染。crop=true 时
// 只取左半（Pico 单眼），与播放显示口径一致。失败（加载/seek/跨域）reject。
export const captureSegmentFrame = (url: string, timeSec: number, crop: boolean): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    // 兜底超时：协议异常挂起（既不 error 也不 loadeddata）时不让 Promise 永不 settle，
    // 否则上层 capturingFrame 卡死、截图按钮永久禁用。
    const timeoutId = window.setTimeout(() => fail('截图超时'), 10000);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeAttribute('src');
      video.load();
    };
    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };
    const draw = () => {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (vw <= 0 || vh <= 0) return fail('无法读取视频帧尺寸');
        const sw = crop ? Math.max(1, Math.floor(vw / 2)) : vw;
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = vh;
        const ctx = canvas.getContext('2d');
        if (!ctx) return fail('无法创建画布上下文');
        ctx.drawImage(video, 0, 0, sw, vh, 0, 0, sw, vh);
        const dataUrl = canvas.toDataURL('image/png');
        cleanup();
        resolve(dataUrl);
      } catch (error) {
        fail(error instanceof Error ? error.message : '截图失败');
      }
    };
    video.addEventListener('error', () => fail('视频加载失败'), { once: true });
    video.addEventListener('loadeddata', () => {
      const target = Math.max(0, Math.min(timeSec, (video.duration || timeSec) - 0.01));
      if (Math.abs(video.currentTime - target) < 0.05) {
        draw();
      } else {
        video.addEventListener('seeked', draw, { once: true });
        video.currentTime = target;
      }
    }, { once: true });
    video.src = url;
  });

export const renderMetricOverlay = (sample: PerformanceSample | null) => {
  if (!sample) return null;
  const pico = sample.metrics.picoMetrics;
  const lines = [
    `FPS ${pico?.fps ? formatMetricReading(pico.fps) : sample.metrics.fps}`,
    `CPU ${sample.metrics.cpuUsage.toFixed(1)}%`,
    `MEM ${formatMemoryMb(sample.metrics.memoryUsage)}MB`,
    `GPU ${pico?.gpuUtil ? formatMetricReading(pico.gpuUtil) : (getGpuValue(sample) ?? '--')}%`,
  ];
  return (
    <div style={{ position: 'absolute', left: '12px', bottom: '12px', backgroundColor: 'var(--bg-scrim)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', padding: '8px 10px', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, auto))', gap: '4px 12px', pointerEvents: 'none', boxShadow: 'var(--sh-md)' }}>
      {lines.map((line) => (
        <span key={line} style={{ color: 'var(--fg-secondary)', fontSize: '12px', whiteSpace: 'nowrap' }}>{line}</span>
      ))}
    </div>
  );
};
