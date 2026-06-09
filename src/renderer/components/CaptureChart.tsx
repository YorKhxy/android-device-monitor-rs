import { useLayoutEffect, useRef, useState } from 'react';
import type { PerformanceCaptureSession, PerformanceSample } from '../../shared/types';
import { formatMemoryMb, getGpuValue, METRIC_COLORS, sampleElapsedMs, type CaptureMetricKey } from './perfFormat';

// 图表主题统一走 design token（SVG 的 fill/stroke/background 均接受 var()）。
const THEME = {
  bg: 'var(--bg-mirror)',
  grid: 'var(--chart-grid)',
  axis: 'var(--border-default)',
  axisText: 'var(--fg-tertiary)',
  playhead: 'var(--accent)',
};

const chartPadding = { left: 50, right: 70, top: 22, bottom: 36 };

type ChartSeries = {
  key: string;
  label: string;
  color: string;
  axis: 'percent' | 'memory';
  getValue: (sample: PerformanceSample) => number | undefined;
};

type HoverPoint = { x: number; y: number; sample: PerformanceSample };

type CaptureChartProps = {
  session: PerformanceCaptureSession;
  samples: PerformanceSample[];
  totalMs: number;
  selectedSeriesKeys: Set<string>;
  onToggleSeries: (key: string) => void;
  playheadMs: number;
  showPlayhead: boolean;
  onSeekToMs?: (ms: number) => void;
  /** 参数过滤标记：每个条件各自在「自己指标的曲线」上打点，按指标区分颜色，跟随该曲线显隐。 */
  markers?: Array<{ metricKey: CaptureMetricKey; atMs: number[] }>;
  onMarkerClick?: (ms: number) => void;
};

const SERIES: ChartSeries[] = [
  { key: 'fps', label: 'FPS', color: METRIC_COLORS.fps, axis: 'percent', getValue: (s) => s.metrics.fps },
  { key: 'cpu', label: 'CPU%', color: METRIC_COLORS.cpu, axis: 'percent', getValue: (s) => s.metrics.cpuUsage },
  { key: 'gpu', label: 'GPU%', color: METRIC_COLORS.gpu, axis: 'percent', getValue: getGpuValue },
  { key: 'mem', label: 'MEM MB', color: METRIC_COLORS.mem, axis: 'memory', getValue: (s) => Number(formatMemoryMb(s.metrics.memoryUsage)) },
];

export function CaptureChart({
  session,
  samples,
  totalMs,
  selectedSeriesKeys,
  onToggleSeries,
  playheadMs,
  showPlayhead,
  onSeekToMs,
  markers,
  onMarkerClick,
}: CaptureChartProps) {
  const [hoverPoint, setHoverPoint] = useState<HoverPoint | null>(null);
  const [size, setSize] = useState({ width: 900, height: 420 });
  const scrubbingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 像素级自适应：viewBox 直接用容器实际像素，1:1 映射，铺满区域且文字不被缩糊。
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.max(360, Math.round(width)), height: Math.max(220, Math.round(height)) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { width, height } = size;
  const plotWidth = width - chartPadding.left - chartPadding.right;
  const plotHeight = height - chartPadding.top - chartPadding.bottom;

  const isSeriesVisible = (key: string) => selectedSeriesKeys.size === 0 || selectedSeriesKeys.has(key);
  const visibleSeries = SERIES.filter((s) => isSeriesVisible(s.key));
  // 过滤激活时隐藏波峰波谷，只留过滤命中点，避免两套标记叠在一起很乱。
  const hasFilterMarkers = (markers ?? []).some((m) => m.atMs.length > 0);

  const memoryValues = samples.map((s) => Number(formatMemoryMb(s.metrics.memoryUsage))).filter(Number.isFinite);
  // 顶部留 ~12% 空白：否则内存峰值（如 8662）几乎贴轴顶（8704），其峰值标签会和右上角
  // 「MEM MB」标题、顶刻度叠成一团。乘 1.12 后再向上取整到 512 的倍数，曲线峰值落在 ~89% 处。
  const memoryAxisMax = Math.max(512, Math.ceil((Math.max(1, ...memoryValues) * 1.12) / 512) * 512);
  const fpsMax = Math.max(0, ...samples.map((s) => s.metrics.fps).filter(Number.isFinite));
  const FPS_TIERS = [100, 120, 144, 165, 240];
  const leftAxisMax = Math.max(100, FPS_TIERS.find((t) => t >= fpsMax) ?? Math.ceil(fpsMax / 60) * 60);
  const percentTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(leftAxisMax * r));
  const memoryTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(memoryAxisMax * r));

  const xForMs = (ms: number) => chartPadding.left + (totalMs <= 0 ? 0 : Math.max(0, Math.min(1, ms / totalMs)) * plotWidth);
  const xForSample = (sample: PerformanceSample) => xForMs(sampleElapsedMs(sample, session.startedAt));
  const yForValue = (value: number, axisMax: number) => chartPadding.top + plotHeight - (Math.max(0, value) / axisMax) * plotHeight;

  const buildLine = (series: ChartSeries) => {
    const axisMax = series.axis === 'memory' ? memoryAxisMax : leftAxisMax;
    return samples.map((s) => `${xForSample(s).toFixed(1)},${yForValue(series.getValue(s) || 0, axisMax).toFixed(1)}`).join(' ');
  };

  const seekFromEvent = (clientX: number, target: SVGSVGElement) => {
    if (!onSeekToMs || totalMs <= 0) return;
    const rect = target.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, ((clientX - rect.left) / rect.width * width - chartPadding.left) / plotWidth));
    onSeekToMs(ratio * totalMs);
  };

  const updateHoverPoint = (clientX: number, clientY: number, target: SVGSVGElement) => {
    if (samples.length === 0) return;
    const rect = target.getBoundingClientRect();
    const ratio = plotWidth <= 0 ? 0 : Math.max(0, Math.min(1, ((clientX - rect.left) / rect.width * width - chartPadding.left) / plotWidth));
    const targetMs = ratio * totalMs;
    const nearest = samples.reduce<{ sample: PerformanceSample; delta: number } | null>((best, s) => {
      const delta = Math.abs(sampleElapsedMs(s, session.startedAt) - targetMs);
      return !best || delta < best.delta ? { sample: s, delta } : best;
    }, null);
    if (nearest) setHoverPoint({ x: clientX - rect.left + 12, y: clientY - rect.top + 12, sample: nearest.sample });
  };

  const playheadX = xForMs(playheadMs);
  const baseY = chartPadding.top + plotHeight;
  const elapsedToSample = new Map(samples.map((s) => [sampleElapsedMs(s, session.startedAt), s]));

  // 波峰/波谷数值标签：先按可见曲线收集峰谷点，再做碰撞避让——x 相近且 y 太近的标签上下错开，
  // 避免多条曲线的极值数字叠成一团（如 GPU 99 压住 FPS 85、MEM 8425 压住 FPS 97）。
  const clampLabelY = (y: number) => Math.max(chartPadding.top + 9, Math.min(baseY - 5, y));
  const peakValleyLabels = (() => {
    if (hasFilterMarkers || samples.length < 2) return [] as Array<{ key: string; color: string; text: string; pointX: number; pointY: number; labelY: number }>;
    const labels = visibleSeries.flatMap((series) => {
      const axisMax = series.axis === 'memory' ? memoryAxisMax : leftAxisMax;
      let maxI = 0, minI = 0, maxV = -Infinity, minV = Infinity;
      samples.forEach((sample, i) => {
        const v = Number(series.getValue(sample)) || 0;
        if (v > maxV) { maxV = v; maxI = i; }
        if (v < minV) { minV = v; minI = i; }
      });
      const peakY = yForValue(maxV, axisMax);
      const valleyY = yForValue(minV, axisMax);
      return [
        { key: `${series.key}-peak`, color: series.color, text: String(Math.round(maxV)), pointX: xForSample(samples[maxI]), pointY: peakY, labelY: clampLabelY(peakY - 9) },
        { key: `${series.key}-valley`, color: series.color, text: String(Math.round(minV)), pointX: xForSample(samples[minI]), pointY: valleyY, labelY: clampLabelY(valleyY + 14) },
      ];
    });
    // 贪心避让：x 相近(<CLUSTER_X) 且 y 间距 < MIN_GAP 时，把后者沿 y 推开一个行高。标签数 ≤8，O(n²) 足够。
    const CLUSTER_X = 36, MIN_GAP = 14;
    const ordered = [...labels].sort((a, b) => a.pointX - b.pointX || a.labelY - b.labelY);
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < i; j++) {
        if (Math.abs(ordered[i].pointX - ordered[j].pointX) < CLUSTER_X && Math.abs(ordered[i].labelY - ordered[j].labelY) < MIN_GAP) {
          const pushed = ordered[j].labelY + (ordered[i].labelY >= ordered[j].labelY ? MIN_GAP : -MIN_GAP);
          ordered[i].labelY = clampLabelY(pushed);
        }
      }
    }
    return ordered;
  })();

  // 平均值参考线：每条可见曲线一条同色水平虚线（横线，与过滤圆点/波峰波谷点形态不冲突），右端标「均X」。
  const averageLines = visibleSeries
    .map((series) => {
      const axisMax = series.axis === 'memory' ? memoryAxisMax : leftAxisMax;
      const vals = samples.map((s) => Number(series.getValue(s))).filter(Number.isFinite);
      if (vals.length === 0) return null;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { key: series.key, color: series.color, avg, y: yForValue(avg, axisMax) };
    })
    .filter((x): x is { key: string; color: string; avg: number; y: number } => x !== null);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      {samples.length === 0 ? (
        <div style={{ width: '100%', height: '100%', background: THEME.bg, borderRadius: 'var(--r-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>
          开始采集后，这里会实时记录本次采集的指标曲线。
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          onPointerDown={(e) => {
            if (!onSeekToMs) return;
            scrubbingRef.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromEvent(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            updateHoverPoint(e.clientX, e.clientY, e.currentTarget);
            if (scrubbingRef.current) seekFromEvent(e.clientX, e.currentTarget);
          }}
          onPointerUp={() => { scrubbingRef.current = false; }}
          onMouseLeave={() => setHoverPoint(null)}
          style={{ width: '100%', height: '100%', display: 'block', background: THEME.bg, borderRadius: 'var(--r-md)', cursor: onSeekToMs ? 'col-resize' : 'default', touchAction: 'none' }}
        >
          {percentTicks.map((tick) => {
            const y = yForValue(tick, leftAxisMax);
            return (
              <g key={tick}>
                <line x1={chartPadding.left} y1={y} x2={chartPadding.left + plotWidth} y2={y} stroke={THEME.grid} />
                <text x={chartPadding.left - 8} y={y + 4} fill={THEME.axisText} fontSize="11" textAnchor="end">{tick}</text>
              </g>
            );
          })}
          {memoryTicks.map((tick) => (
            <text key={tick} x={chartPadding.left + plotWidth + 8} y={yForValue(tick, memoryAxisMax) + 4} fill={METRIC_COLORS.mem} fontSize="11" opacity={0.75}>{tick}</text>
          ))}
          <line x1={chartPadding.left} y1={chartPadding.top} x2={chartPadding.left} y2={baseY} stroke={THEME.axis} />
          <line x1={chartPadding.left + plotWidth} y1={chartPadding.top} x2={chartPadding.left + plotWidth} y2={baseY} stroke={METRIC_COLORS.mem} opacity={0.4} />
          <line x1={chartPadding.left} y1={baseY} x2={chartPadding.left + plotWidth} y2={baseY} stroke={THEME.axis} />
          {/* 面积填充：每条可见曲线下方淡色铺到基线。 */}
          {samples.length >= 2 && visibleSeries.map((series) => (
            <polygon
              key={`${series.key}-area`}
              points={`${xForSample(samples[0]).toFixed(1)},${baseY} ${buildLine(series)} ${xForSample(samples[samples.length - 1]).toFixed(1)},${baseY}`}
              fill={series.color}
              opacity={0.1}
            />
          ))}
          {visibleSeries.map((series) => (
            <polyline key={series.key} points={buildLine(series)} fill="none" stroke={series.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {/* 平均值参考线：横向虚线 + 右端「均X」标签，每条可见曲线一条同色。 */}
          {averageLines.map((a) => (
            <g key={`${a.key}-avg`}>
              <line x1={chartPadding.left} y1={a.y} x2={chartPadding.left + plotWidth} y2={a.y} stroke={a.color} strokeWidth="1.5" strokeDasharray="6 4" opacity="0.7" />
              <text x={chartPadding.left + plotWidth - 4} y={a.y - 4} fill={a.color} fontSize="10" fontWeight="600" textAnchor="end">{`均${Math.round(a.avg)}`}</text>
            </g>
          ))}
          {/* 波峰 / 波谷：过滤未激活时才显示。已做碰撞避让 + 半透明底片（描边取曲线色），避免数字叠成一团、压在线上难读。 */}
          {peakValleyLabels.map((l) => {
            const chipW = l.text.length * 6.4 + 9;
            return (
              <g key={l.key}>
                <circle cx={l.pointX} cy={l.pointY} r="2.5" fill={l.color} />
                <rect x={l.pointX - chipW / 2} y={l.labelY - 10} width={chipW} height={14} rx="3.5" fill="var(--bg-elevated)" stroke={l.color} strokeOpacity={0.35} strokeWidth={0.75} />
                <text x={l.pointX} y={l.labelY} fill={l.color} fontSize="10" fontWeight="600" textAnchor="middle">{l.text}</text>
              </g>
            );
          })}
          {/* 参数过滤命中标记：空心圆点打在该指标曲线对应数值位置，颜色取该曲线色，跟随其显隐。 */}
          {(markers ?? []).flatMap((marker) => {
            const series = SERIES.find((s) => s.key === marker.metricKey);
            if (!series || !isSeriesVisible(series.key)) return [];
            const axisMax = series.axis === 'memory' ? memoryAxisMax : leftAxisMax;
            return marker.atMs.flatMap((ms, i) => {
              const sample = elapsedToSample.get(ms);
              if (!sample) return [];
              const cx = xForMs(ms);
              const cy = yForValue(series.getValue(sample) || 0, axisMax);
              return [
                <g key={`${marker.metricKey}-${ms}-${i}`} onPointerDown={(e) => { if (!onMarkerClick) return; e.stopPropagation(); onMarkerClick(ms); }} style={{ cursor: onMarkerClick ? 'pointer' : 'default' }}>
                  <circle cx={cx} cy={cy} r="9" fill="transparent" />
                  <circle cx={cx} cy={cy} r="4.5" fill={THEME.bg} stroke={series.color} strokeWidth="2.5" />
                </g>,
              ];
            });
          })}
          {showPlayhead && (
            <g>
              <line x1={playheadX} y1={chartPadding.top} x2={playheadX} y2={baseY} stroke={THEME.playhead} strokeWidth="1.5" strokeDasharray="4 3" />
              <polygon points={`${playheadX},${chartPadding.top} ${playheadX - 5},${chartPadding.top - 8} ${playheadX + 5},${chartPadding.top - 8}`} fill={THEME.playhead} />
            </g>
          )}
          <text x={chartPadding.left} y="14" fill={THEME.axisText} fontSize="11">% / FPS</text>
          <text x={chartPadding.left + plotWidth - 30} y="14" fill={METRIC_COLORS.mem} fontSize="11" opacity={0.75}>MEM MB</text>
          {SERIES.map((series, index) => {
            const visible = isSeriesVisible(series.key);
            const gx = chartPadding.left + index * 92;
            return (
              <g key={series.key} onPointerDown={(e) => { e.stopPropagation(); onToggleSeries(series.key); }} style={{ cursor: 'pointer' }} opacity={visible ? 1 : 0.4}>
                <rect x={gx - 2} y={height - 21} width="88" height="18" fill="transparent" />
                <rect x={gx} y={height - 18} width="10" height="10" fill={series.color} rx="2" />
                <text x={gx + 14} y={height - 9} fill="var(--fg-secondary)" fontSize="11" textDecoration={visible ? 'none' : 'line-through'}>{series.label}</text>
              </g>
            );
          })}
        </svg>
      )}
      {hoverPoint && (
        <div style={{ position: 'absolute', left: `${hoverPoint.x}px`, top: `${hoverPoint.y}px`, backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-sm)', padding: '8px 10px', boxShadow: 'var(--sh-pop)', pointerEvents: 'none', zIndex: 1 }}>
          <div style={{ color: 'var(--fg-primary)', fontSize: '12px', marginBottom: '4px' }}>{new Date(hoverPoint.sample.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div>
          <div style={{ color: METRIC_COLORS.fps, fontSize: '12px' }}>{`FPS ${hoverPoint.sample.metrics.fps}`}</div>
          <div style={{ color: METRIC_COLORS.cpu, fontSize: '12px' }}>{`CPU ${hoverPoint.sample.metrics.cpuUsage.toFixed(1)}%`}</div>
          <div style={{ color: METRIC_COLORS.mem, fontSize: '12px' }}>{`MEM ${formatMemoryMb(hoverPoint.sample.metrics.memoryUsage)}MB`}</div>
          <div style={{ color: METRIC_COLORS.gpu, fontSize: '12px' }}>{`GPU ${getGpuValue(hoverPoint.sample) ?? '--'}%`}</div>
        </div>
      )}
    </div>
  );
}
