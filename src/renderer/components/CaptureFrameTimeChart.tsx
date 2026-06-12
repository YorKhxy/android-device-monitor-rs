import { useLayoutEffect, useRef, useState } from 'react';
import type { FrameTimingStats, PerformanceCaptureSession, PerformanceSample } from '../../shared/types';
import type { ProblemMarker } from '../lib/captureAnalysis';
import { CHART_PAD_X, sampleElapsedMs } from './perfFormat';
import { renderProblemLane } from './captureReportHelpers';

// 帧耗时时序图（X 与主曲线 / 分类内存图共享 CHART_PAD_X，时间轴严格对齐；Y = 单帧耗时 ms）。
// 两种数据源自适应：
//  - gfx 模式（普通 Android HWUI 应用）：gfxinfo framestats 每帧 FrameCompleted-IntendedVsync 聚合，
//    画 p50~p99 阴影带 + p50/p90/p99 分位线，jank=耗时>帧预算（=1000/刷新率）。看长尾、看分布。
//  - pico 模式（Pico VR 应用，画面在 SurfaceView 上 gfxinfo 抓不到）：用 Pico 官方 PxrMetric 的
//    FrmGpu/FrmCpu/ATWGPU 逐帧耗时画时序线，帧预算按目标帧率（fps 的 maxValue，默认 90Hz）。
const PAD = { l: CHART_PAD_X.left, r: CHART_PAD_X.right, t: 16, b: 22 };

const round1 = (v: number) => Math.round(v * 10) / 10;
const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

type Props = {
  session: PerformanceCaptureSession;
  samples: PerformanceSample[];
  totalMs: number;
  playheadMs: number;
  showPlayhead: boolean;
  onSeekToMs?: (ms: number) => void;
  /** SVG 绘图区高度（图例在其下方，不占此高度）。默认 180。 */
  svgHeight?: number;
  /** 自动检测的问题关键帧标记（顶部 ▼ lane）。 */
  problemMarkers?: ProblemMarker[];
  /** 是否显示问题标记 lane。 */
  showProblems?: boolean;
};

// gfx 模式分位线定义。
const GFX_LINES: Array<{ key: keyof FrameTimingStats; label: string; color: string; dash: string; width: number; tip: string }> = [
  { key: 'p50Ms', label: 'p50', color: '#5E9FD6', dash: '', width: 2, tip: 'p50 中位帧耗时：一半的帧比它更快，代表「通常手感」。' },
  { key: 'p90Ms', label: 'p90', color: '#E8B339', dash: '5 3', width: 1.4, tip: 'p90：90% 的帧快于此值，反映偏慢那批帧的水平。' },
  { key: 'p99Ms', label: 'p99', color: '#E0746C', dash: '2 3', width: 1.6, tip: 'p99：最差 1% 帧的长尾。偶发大卡顿就藏在这里——p99 远高于帧预算 = 有狠卡。' },
];

export function CaptureFrameTimeChart({ session, samples, totalMs, playheadMs, showPlayhead, onSeekToMs, svgHeight = 180, problemMarkers, showProblems }: Props) {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverSample, setHoverSample] = useState<PerformanceSample | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(900);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setMeasuredWidth(Math.max(360, Math.round(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const start = new Date(session.startedAt);

  // gfx 源：采到 gfxinfo 帧耗时聚合的样本。
  const gfxPts = samples
    .map((s) => ({ s, t: s.metrics.frameTiming }))
    .filter((p): p is { s: PerformanceSample; t: FrameTimingStats } => !!p.t && p.t.frameCount > 0);

  // pico 源：采到 Pico 官方逐帧 CPU/GPU 耗时的样本。
  const picoPts = samples
    .map((s) => {
      const p = s.metrics.picoMetrics;
      return { s, cpu: p?.frameCpu?.value, gpu: p?.frameGpu?.value, atw: p?.atwGpu?.value, target: p?.fps?.maxValue };
    })
    .filter((p) => finite(p.cpu) || finite(p.gpu));

  const mode: 'gfx' | 'pico' | 'none' = gfxPts.length > 0 ? 'gfx' : picoPts.length > 0 ? 'pico' : 'none';

  if (mode === 'none') {
    return (
      <div ref={containerRef} style={{ height: `${svgHeight}px`, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 16px', color: 'var(--fg-tertiary)', fontSize: '13px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', backgroundColor: 'var(--bg-mirror)' }}>
        未采集到帧耗时（普通应用走 gfxinfo 逐帧；Pico VR 应用需集成 XR Profiling Toolkit 才有官方逐帧 CPU/GPU 耗时——否则看上方 FPS 口径即可）
      </div>
    );
  }

  const width = measuredWidth;
  const height = svgHeight;
  const plotW = width - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;

  // 统一的 X 锚点样本列表（gfx / pico 各自一套），用于 hover 最近点定位。
  const anchorSamples = (mode === 'gfx' ? gfxPts : picoPts).map((p) => p.s);

  const xOf = (s: PerformanceSample) => PAD.l + (totalMs > 0 ? Math.min(1, Math.max(0, sampleElapsedMs(s, start) / totalMs)) : 0) * plotW;
  const xForMs = (ms: number) => PAD.l + (totalMs > 0 ? Math.min(1, Math.max(0, ms / totalMs)) : 0) * plotW;
  const yOf = (ms: number) => PAD.t + (1 - Math.min(1, Math.max(0, ms / topRef.value))) * plotH;
  // topMs 需先于 yOf 使用，用对象包一层避免 TDZ。
  const topRef = { value: 20 };

  // ——— 按模式准备：预算线、阴影带、折线、各类极值 ———
  type Line = { id: string; label: string; color: string; dash: string; width: number; val: (i: number) => number | undefined; tip: string };
  let budgetMs: number;
  let budgetLabel: string;
  let lines: Line[];
  let bandPath: string | null = null;
  let allVals: number[] = [];
  // 底部徽标
  let badgePrimary: { text: string; color: string; tip: string };
  let worst: { text: string; tip: string };

  if (mode === 'gfx') {
    const pts = gfxPts;
    // 帧预算：取出现最多的 budgetMs（通常全程一致）。
    const counts = new Map<number, number>();
    for (const p of pts) counts.set(p.t.budgetMs, (counts.get(p.t.budgetMs) ?? 0) + 1);
    budgetMs = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const refreshHz = pts.find((p) => p.t.budgetMs === budgetMs)?.t.refreshHz ?? 0;
    budgetLabel = `帧预算 ${round1(budgetMs)}ms${refreshHz ? ` · ${Math.round(refreshHz)}Hz` : ''}`;

    lines = GFX_LINES.map((ln) => ({ id: ln.key as string, label: ln.label, color: ln.color, dash: ln.dash, width: ln.width, tip: ln.tip, val: (i: number) => pts[i].t[ln.key] as number }));
    allVals = pts.flatMap((p) => [p.t.p99Ms, p.t.p50Ms]);

    const totalFrames = pts.reduce((a, p) => a + p.t.frameCount, 0);
    const totalJank = pts.reduce((a, p) => a + p.t.jankCount, 0);
    const jankPercent = totalFrames > 0 ? round1((totalJank / totalFrames) * 100) : 0;
    const maxP99 = Math.max(...pts.map((p) => p.t.p99Ms));
    badgePrimary = {
      text: `jank ${jankPercent}%`,
      color: jankPercent >= 10 ? 'var(--danger)' : jankPercent >= 3 ? 'var(--warning)' : 'var(--success)',
      tip: 'jank（卡顿帧）占比：耗时超过帧预算的帧数 / 总帧数（按帧加权全程汇总）。越低越流畅；>3% 偏卡、>10% 明显卡。',
    };
    worst = { text: `最差 p99 ${round1(maxP99)}ms`, tip: '全程最差的一拍 p99——偶发最狠的卡顿有多深。' };
  } else {
    const pts = picoPts;
    const target = pts.map((p) => p.target).find(finite) ?? 90;
    budgetMs = 1000 / target;
    budgetLabel = `帧预算 ${round1(budgetMs)}ms · ${Math.round(target)}Hz`;

    lines = [
      { id: 'gpu', label: 'FrmGpu', color: '#E0746C', dash: '', width: 2, tip: 'FrmGpu：单帧 GPU 耗时(ms)。VR 多为 GPU 受限，这条最该盯——接近/超帧预算 = 渲染吃紧、易掉帧。', val: (i: number) => pts[i].gpu },
      { id: 'cpu', label: 'FrmCpu', color: '#5E9FD6', dash: '', width: 1.6, tip: 'FrmCpu：单帧 CPU 耗时(ms)。逻辑/脚本开销；接近帧预算说明 CPU 侧吃紧。', val: (i: number) => pts[i].cpu },
    ];
    if (pts.some((p) => finite(p.atw))) {
      lines.push({ id: 'atw', label: 'ATWGpu', color: '#E8B339', dash: '4 3', width: 1.4, tip: 'ATWGPU：异步时间扭曲的 GPU 耗时(ms，VR 重投影)。偏高说明 GPU 紧张到要靠重投影补帧。', val: (i: number) => pts[i].atw });
    }
    allVals = pts.flatMap((p) => [p.gpu, p.cpu, p.atw].filter(finite) as number[]);

    // 超预算占比（pico 为每秒聚合值，非逐帧，故叫「超预算」而非 jank）：max(cpu,gpu) > 预算 的样本占比。
    const over = pts.filter((p) => Math.max(p.gpu ?? 0, p.cpu ?? 0) > budgetMs).length;
    const overPct = pts.length > 0 ? round1((over / pts.length) * 100) : 0;
    const maxGpu = Math.max(0, ...pts.map((p) => p.gpu).filter(finite));
    badgePrimary = {
      text: `超预算 ${overPct}%`,
      color: overPct >= 10 ? 'var(--danger)' : overPct >= 3 ? 'var(--warning)' : 'var(--success)',
      tip: '超预算占比：单帧 CPU/GPU 耗时超过帧预算的采样点占比（Pico 官方指标为每秒聚合值，故按采样点算，非逐帧 jank）。',
    };
    worst = { text: `最差 FrmGpu ${round1(maxGpu)}ms`, tip: '全程最高的单帧 GPU 耗时——GPU 侧最狠的一刻有多吃紧。' };
  }

  // Y 轴上限：覆盖最大值与预算线，留白；最小 20ms 保证预算线（11.1/16.7）可见。
  const maxVal = allVals.length ? Math.max(...allVals) : 0;
  topRef.value = Math.max(20, Math.ceil((Math.max(maxVal, budgetMs) * 1.15) / 5) * 5);

  // p50~p99 阴影带（gfx 模式）：topMs 定了再算坐标，避免 yOf 用到默认值。
  if (mode === 'gfx' && gfxPts.length >= 2) {
    let band = `M ${xOf(gfxPts[0].s).toFixed(1)} ${yOf(gfxPts[0].t.p99Ms).toFixed(1)}`;
    for (let i = 1; i < gfxPts.length; i++) band += ` L ${xOf(gfxPts[i].s).toFixed(1)} ${yOf(gfxPts[i].t.p99Ms).toFixed(1)}`;
    for (let i = gfxPts.length - 1; i >= 0; i--) band += ` L ${xOf(gfxPts[i].s).toFixed(1)} ${yOf(gfxPts[i].t.p50Ms).toFixed(1)}`;
    band += ' Z';
    bandPath = band;
  }

  const pts = mode === 'gfx' ? gfxPts : picoPts;
  const polyline = (line: Line) =>
    pts
      .map((_, i) => ({ x: xOf(anchorSamples[i]), v: line.val(i) }))
      .filter((p) => finite(p.v))
      .map((p) => `${p.x.toFixed(1)},${yOf(p.v as number).toFixed(1)}`)
      .join(' ');

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => round1(topRef.value * f));
  const playX = xForMs(playheadMs);

  const seekFromEvent = (clientX: number, target: SVGSVGElement) => {
    if (!onSeekToMs || totalMs <= 0) return;
    const rect = target.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, ((clientX - rect.left) / rect.width * width - PAD.l) / plotW));
    onSeekToMs(ratio * totalMs);
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * width;
    let bestI = 0;
    let bestD = Infinity;
    anchorSamples.forEach((s, i) => {
      const d = Math.abs(xOf(s) - vx);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    setHoverX(xOf(anchorSamples[bestI]));
    setHoverSample(anchorSamples[bestI]);
  };

  // hover 内容（按模式从样本里取）。
  const hoverRows: Array<{ color: string; text: string }> = [];
  if (hoverSample) {
    if (mode === 'gfx') {
      const t = hoverSample.metrics.frameTiming;
      if (t) {
        hoverRows.push({ color: '#5E9FD6', text: `p50 ${round1(t.p50Ms)}ms` });
        hoverRows.push({ color: '#E8B339', text: `p90 ${round1(t.p90Ms)}ms` });
        hoverRows.push({ color: '#E0746C', text: `p99 ${round1(t.p99Ms)}ms ｜ 最大 ${round1(t.maxMs)}ms` });
        hoverRows.push({ color: 'var(--fg-secondary)', text: `均 ${round1(t.avgMs)}ms ｜ ${t.frameCount} 帧` });
        hoverRows.push({ color: t.jankPercent >= 10 ? 'var(--danger)' : t.jankPercent >= 3 ? 'var(--warning)' : 'var(--success)', text: `jank ${round1(t.jankPercent)}%（预算 ${round1(t.budgetMs)}ms）` });
      }
    } else {
      const p = hoverSample.metrics.picoMetrics;
      if (finite(p?.frameGpu?.value)) hoverRows.push({ color: '#E0746C', text: `FrmGpu ${round1(p!.frameGpu!.value)}ms` });
      if (finite(p?.frameCpu?.value)) hoverRows.push({ color: '#5E9FD6', text: `FrmCpu ${round1(p!.frameCpu!.value)}ms` });
      if (finite(p?.atwGpu?.value)) hoverRows.push({ color: '#E8B339', text: `ATWGpu ${round1(p!.atwGpu!.value)}ms` });
      hoverRows.push({ color: 'var(--fg-tertiary)', text: `预算 ${round1(budgetMs)}ms` });
    }
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        role="img"
        aria-label="帧耗时随时间变化，叠帧预算线"
        style={{ display: 'block', cursor: onSeekToMs ? 'col-resize' : 'default', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (!onSeekToMs) return;
          scrubbingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromEvent(e.clientX, e.currentTarget);
        }}
        onPointerMove={(e) => { if (scrubbingRef.current) seekFromEvent(e.clientX, e.currentTarget); }}
        onPointerUp={() => { scrubbingRef.current = false; }}
        onMouseMove={onMove}
        onMouseLeave={() => { setHoverX(null); setHoverSample(null); }}
      >
        {gridVals.map((v, i) => {
          const y = yOf(v);
          return (
            <g key={i}>
              <line x1={PAD.l} y1={y} x2={width - PAD.r} y2={y} stroke="var(--chart-grid)" strokeWidth="1" />
              <text x={PAD.l - 6} y={y + 3} fill="var(--fg-tertiary)" fontSize="10" textAnchor="end">{v}</text>
            </g>
          );
        })}

        {bandPath && <path d={bandPath} fill="#E0746C" fillOpacity={0.12} />}

        {/* 帧预算线 */}
        <line x1={PAD.l} y1={yOf(budgetMs)} x2={width - PAD.r} y2={yOf(budgetMs)} stroke="var(--success)" strokeWidth="1.5" strokeDasharray="7 4" opacity={0.85} />
        <text x={width - PAD.r - 4} y={yOf(budgetMs) - 4} fill="var(--success)" fontSize="10" fontWeight="600" textAnchor="end">{budgetLabel}</text>

        {/* 折线（≥2 点画线，单点画点） */}
        {pts.length >= 2 && lines.map((ln) => (
          <polyline key={ln.id} points={polyline(ln)} fill="none" stroke={ln.color} strokeWidth={ln.width} strokeDasharray={ln.dash || undefined} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} />
        ))}
        {pts.length === 1 && lines.map((ln) => {
          const v = ln.val(0);
          return finite(v) ? <circle key={ln.id} cx={xOf(anchorSamples[0])} cy={yOf(v)} r="3" fill={ln.color} /> : null;
        })}

        {showProblems && problemMarkers && renderProblemLane({ markers: problemMarkers, xForMs, topY: PAD.t, bottomY: PAD.t + plotH, onSeek: onSeekToMs })}
        {showPlayhead && (
          <line x1={playX} y1={PAD.t} x2={playX} y2={PAD.t + plotH} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 3" />
        )}
        {hoverX != null && <line x1={hoverX} y1={PAD.t} x2={hoverX} y2={PAD.t + plotH} stroke="var(--fg-tertiary)" strokeWidth="1" />}

        <text x={PAD.l} y="11" fill="var(--fg-tertiary)" fontSize="10">帧耗时 ms{mode === 'pico' ? ' · Pico 官方逐帧' : ''}</text>
      </svg>

      {/* 图例 + 徽标 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px', marginTop: '6px', fontSize: '11px', color: 'var(--fg-secondary)' }}>
        {lines.map((ln) => {
          const last = ln.val(pts.length - 1);
          return (
            <span key={ln.id} data-tip={ln.tip} style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'help' }}>
              <span style={{ width: '14px', height: '0', borderTop: `2px ${ln.dash ? 'dashed' : 'solid'} ${ln.color}` }} />
              {ln.label}{finite(last) ? ` ${round1(last)}ms` : ''}
            </span>
          );
        })}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span data-tip={badgePrimary.tip} style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'help' }}>
            <span style={{ color: badgePrimary.color, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{badgePrimary.text}</span>
          </span>
          <span data-tip={worst.tip} style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'help', color: 'var(--fg-tertiary)' }}>
            <span style={{ color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)' }}>{worst.text}</span>
          </span>
        </span>
      </div>

      {/* hover 数值气泡 */}
      {hoverX != null && hoverSample && hoverRows.length > 0 && (
        <div style={{ position: 'absolute', left: `${(hoverX / width) * 100}%`, top: 0, transform: `translateX(${hoverX > width * 0.7 ? 'calc(-100% - 8px)' : '8px'})`, backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-sm)', padding: '6px 9px', fontSize: '11px', pointerEvents: 'none', boxShadow: 'var(--sh-pop)', whiteSpace: 'nowrap' }}>
          <div style={{ color: 'var(--fg-tertiary)', marginBottom: '2px' }}>{new Date(hoverSample.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div>
          {hoverRows.map((r, i) => (
            <div key={i} style={{ color: r.color }}>{r.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}
