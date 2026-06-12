import { useLayoutEffect, useRef, useState } from 'react';
import type { PerformanceCaptureSession, PerformanceSample, MemoryBreakdown } from '../../shared/types';
import type { ProblemMarker } from '../lib/captureAnalysis';
import { CHART_PAD_X, sampleElapsedMs } from './perfFormat';
import { renderProblemLane } from './captureReportHelpers';

// 分类内存堆叠面积图（dumpsys meminfo App Summary）：把进程内存按 Java/Native/Graphics/Code/Stack
// 五类随时间堆叠，定位「内存涨在哪一类」。每类图例带 hover 分析提示（怎么看、涨了通常意味着什么）。
// 像素级自适应（ResizeObserver）+ 共享 X 边距（CHART_PAD_X）：与主曲线、帧耗时图严格对齐时间轴。
type MemCat = { key: keyof MemoryBreakdown; label: string; color: string; tip: string };

const MEM_CATS: MemCat[] = [
  { key: 'javaKb', label: 'Java', color: '#5E9FD6', tip: 'Java 托管堆（脚本/逻辑层对象）。只涨不降 → 脚本里 new 的对象没回收：事件没反注册、List 一直 Add、缓存无上限。' },
  { key: 'nativeKb', label: 'Native', color: '#E0746C', tip: 'Native 原生堆（引擎 C/C++ 分配）。涨 → 引擎层只创建不销毁：粒子 / 音频 / 物理对象池泄漏。' },
  { key: 'graphicsKb', label: 'Graphics', color: '#A78BFA', tip: 'Graphics 图形内存（贴图 / 模型 / 渲染缓冲，显存相关）。涨 → 场景 / 贴图没卸载：切关卡后旧资源还赖在显存。优化：切场景及时释放、压缩贴图。' },
  { key: 'codeKb', label: 'Code', color: '#22C3B8', tip: 'Code 代码与 so 库占用。基本固定，一般无需关注。' },
  { key: 'stackKb', label: 'Stack', color: '#E8B339', tip: 'Stack 线程调用栈。通常很小；异常飙高 = 线程开太多。' },
];

// 上下边距本图自有（左右用共享 X 边距对齐）。
const PAD = { l: CHART_PAD_X.left, r: CHART_PAD_X.right, t: 14, b: 22 };

const toMb = (kb: number) => kb / 1024;

type Props = {
  session: PerformanceCaptureSession;
  samples: PerformanceSample[];
  totalMs: number;
  playheadMs: number;
  showPlayhead: boolean;
  /** 点击/拖动联动 seek（与其它对齐图共享时间轴时传入）。 */
  onSeekToMs?: (ms: number) => void;
  /** SVG 绘图区高度（图例在其下方，不占此高度）。默认 170。 */
  svgHeight?: number;
  /** 自动检测的问题关键帧标记（顶部 ▼ lane）。 */
  problemMarkers?: ProblemMarker[];
  /** 是否显示问题标记 lane。 */
  showProblems?: boolean;
};

export function CaptureMemoryChart({ session, samples, totalMs, playheadMs, showPlayhead, onSeekToMs, svgHeight = 170, problemMarkers, showProblems }: Props) {
  const [hover, setHover] = useState<{ x: number; sample: PerformanceSample } | null>(null);
  // 只测量宽度（用于像素级 X 对齐）；高度固定，避免图例把 SVG 撑变形。
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

  // 只取采到分类内存的样本（前台应用 + dumpsys meminfo 可读时才有）。
  const pts = samples
    .map((s) => ({ s, b: s.metrics.memoryBreakdown }))
    .filter((p): p is { s: PerformanceSample; b: MemoryBreakdown } => !!p.b);

  if (pts.length === 0) {
    return (
      <div ref={containerRef} style={{ height: `${svgHeight}px`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-tertiary)', fontSize: '13px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', backgroundColor: 'var(--bg-mirror)' }}>
        未采集到分类内存（需有前台应用且 dumpsys meminfo 可读）
      </div>
    );
  }

  const width = measuredWidth;
  const height = svgHeight;
  const plotW = width - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const start = new Date(session.startedAt);

  // y 轴上限：取各样本五类合计的最高值，向上取整到 512MB 的倍数 + 留白。
  const maxMb = Math.max(...pts.map((p) => MEM_CATS.reduce((acc, c) => acc + toMb(p.b[c.key]), 0)), 1);
  const topMb = Math.max(512, Math.ceil((maxMb * 1.1) / 512) * 512);

  const xOf = (s: PerformanceSample) => PAD.l + (totalMs > 0 ? Math.min(1, Math.max(0, sampleElapsedMs(s, start) / totalMs)) : 0) * plotW;
  const xForMs = (ms: number) => PAD.l + (totalMs > 0 ? Math.min(1, Math.max(0, ms / totalMs)) : 0) * plotW;
  const yOf = (mb: number) => PAD.t + (1 - mb / topMb) * plotH;

  // 自底向上累加，每类一条填充带（band 底=已累加，顶=累加后）。
  let cumBelow = pts.map(() => 0);
  const bands = MEM_CATS.map((cat) => {
    const bottom = cumBelow.slice();
    const top = pts.map((p, i) => bottom[i] + toMb(p.b[cat.key]));
    cumBelow = top;
    let d = `M ${xOf(pts[0].s).toFixed(1)} ${yOf(top[0]).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${xOf(pts[i].s).toFixed(1)} ${yOf(top[i]).toFixed(1)}`;
    for (let i = pts.length - 1; i >= 0; i--) d += ` L ${xOf(pts[i].s).toFixed(1)} ${yOf(bottom[i]).toFixed(1)}`;
    d += ' Z';
    return { cat, d };
  });

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(topMb * f));
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
    let best = pts[0];
    let bestD = Infinity;
    for (const p of pts) {
      const d = Math.abs(xOf(p.s) - vx);
      if (d < bestD) { bestD = d; best = p; }
    }
    setHover({ x: xOf(best.s), sample: best.s });
  };

  const hb = hover?.sample.metrics.memoryBreakdown;

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        role="img"
        aria-label="Java/Native/Graphics/Code/Stack 分类内存随时间堆叠面积图"
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
        onMouseLeave={() => setHover(null)}
      >
        {gridVals.map((v, i) => {
          const y = yOf(v);
          return (
            <g key={i}>
              <line x1={PAD.l} y1={y} x2={width - PAD.r} y2={y} stroke="var(--chart-grid)" strokeWidth="1" />
              <text x={PAD.l - 6} y={y + 3} fill="var(--fg-tertiary)" fontSize="10" textAnchor="end">{v >= 1024 ? (v / 1024).toFixed(1) + 'G' : v + 'M'}</text>
            </g>
          );
        })}
        {bands.map((b) => (
          <path key={b.cat.key} d={b.d} fill={b.cat.color} fillOpacity={0.78} stroke={b.cat.color} strokeWidth="0.8" />
        ))}
        {showProblems && problemMarkers && renderProblemLane({ markers: problemMarkers, xForMs, topY: PAD.t, bottomY: PAD.t + plotH, onSeek: onSeekToMs })}
        {showPlayhead && (
          <line x1={playX} y1={PAD.t} x2={playX} y2={PAD.t + plotH} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 3" />
        )}
        {hover && <line x1={hover.x} y1={PAD.t} x2={hover.x} y2={PAD.t + plotH} stroke="var(--fg-tertiary)" strokeWidth="1" />}
      </svg>

      {/* 图例：每类色块 + 当前值；hover 出现「怎么看 / 涨了意味着什么」的分析提示。 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '6px', fontSize: '11px', color: 'var(--fg-secondary)' }}>
        {MEM_CATS.map((c) => {
          const lastMb = toMb(pts[pts.length - 1].b[c.key]);
          return (
            <span key={c.key} data-tip={c.tip} style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'help' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: c.color, opacity: 0.8 }} />
              {c.label} {Math.round(lastMb)}MB
            </span>
          );
        })}
        <span style={{ color: 'var(--fg-tertiary)' }} data-tip="五类合计（约等于进程 PSS 总内存）。只涨不降 = 疑似泄漏，看哪类在涨定位方向。">
          合计 {Math.round(MEM_CATS.reduce((acc, c) => acc + toMb(pts[pts.length - 1].b[c.key]), 0))}MB
        </span>
      </div>

      {/* hover 数值气泡 */}
      {hb && (
        <div style={{ position: 'absolute', left: `${(hover!.x / width) * 100}%`, top: 0, transform: 'translateX(8px)', backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-sm)', padding: '6px 9px', fontSize: '11px', pointerEvents: 'none', boxShadow: 'var(--sh-pop)', whiteSpace: 'nowrap' }}>
          {MEM_CATS.map((c) => (
            <div key={c.key} style={{ color: c.color }}>{c.label} {Math.round(toMb(hb[c.key]))}MB</div>
          ))}
        </div>
      )}
    </div>
  );
}
