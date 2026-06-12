/**
 * 采集「问题关键帧」自动检测（一键分析的第一块）。
 *
 * 标记是 samples + 阈值的**纯派生结果**，不存进会话文件——于是导入导出/回放天然都有（samples 本就跟着走），
 * 且阈值改了立刻重算、不会过期。阈值全局可调，localStorage 持久化。
 *
 * 与现有两套标记区分：过滤标记/波峰波谷都是「曲线色 + 锚在数值点」；问题标记走「严重度色(红/黄) + 时间轴顶部 ▼」。
 */
import type { PerformanceCaptureSession, PerformanceSample } from '../../shared/types';
import { sampleElapsedMs } from '../components/perfFormat';

export type ProblemSeverity = 'critical' | 'warning';
/** 一个问题时刻：相对会话起点的毫秒 + 严重度 + 给 hover 看的说明。 */
export type ProblemMarker = { atMs: number; severity: ProblemSeverity; label: string };

/** 可调阈值。gfx(普通安卓 gfxinfo)与 pico(逐帧)各一套口径。 */
export type ProblemThresholds = {
  /** gfx：单帧最大耗时 > 此倍数×帧预算 → 严重(红)。默认 2。 */
  criticalMaxFactor: number;
  /** gfx：p99 > 此倍数×帧预算 → 警告(黄)。默认 1.5。 */
  warningP99Factor: number;
  /** gfx：该秒 jank% > 此值 → 警告(黄)。默认 10。 */
  warningJankPct: number;
  /** pico：max(FrmGpu,FrmCpu) > 此倍数×帧预算 → 严重(红)。默认 2。 */
  picoCriticalFactor: number;
  /** pico：max(FrmGpu,FrmCpu) > 此倍数×帧预算 → 警告(黄)。默认 1。 */
  picoWarningFactor: number;
};

export const DEFAULT_PROBLEM_THRESHOLDS: ProblemThresholds = {
  criticalMaxFactor: 2,
  warningP99Factor: 1.5,
  warningJankPct: 10,
  picoCriticalFactor: 2,
  picoWarningFactor: 1,
};

const THRESHOLDS_KEY = 'adm-problem-thresholds';

export function loadThresholds(): ProblemThresholds {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(THRESHOLDS_KEY) : null;
    if (raw) return { ...DEFAULT_PROBLEM_THRESHOLDS, ...JSON.parse(raw) };
  } catch { /* 损坏/不可用退默认 */ }
  return { ...DEFAULT_PROBLEM_THRESHOLDS };
}
export function saveThresholds(t: ProblemThresholds) {
  try { localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(t)); } catch { /* 忽略 */ }
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** 相邻坏点 ≤ 此间隔(ms) 并成一簇，只留最狠的一个，避免连成一片三角。 */
const CLUSTER_GAP_MS = 1500;

type Cand = { atMs: number; severity: ProblemSeverity; score: number; label: string };
const sevRank = (s: ProblemSeverity) => (s === 'critical' ? 1 : 0);
const worse = (a: Cand, b: Cand) => sevRank(a.severity) > sevRank(b.severity) || (sevRank(a.severity) === sevRank(b.severity) && a.score > b.score);

/** 从 samples 算出问题关键帧标记（已聚簇）。空会话/无坏点返回 []。 */
export function computeProblemMarkers(
  session: PerformanceCaptureSession,
  samples: PerformanceSample[],
  thresholds: ProblemThresholds,
): ProblemMarker[] {
  if (!samples.length) return [];
  const start = new Date(session.startedAt);
  // 数据源判定与帧耗时图一致：有 gfxinfo 帧统计走 gfx，否则 pico 逐帧。
  const hasGfx = samples.some((s) => { const t = s.metrics.frameTiming; return !!t && t.frameCount > 0; });

  const cands: Cand[] = [];
  for (const s of samples) {
    const atMs = sampleElapsedMs(s, start);
    if (hasGfx) {
      const t = s.metrics.frameTiming;
      if (!t || t.frameCount <= 0 || t.budgetMs <= 0) continue;
      const maxFactor = t.maxMs / t.budgetMs;
      const p99Factor = t.p99Ms / t.budgetMs;
      const stat = `本秒：中位 ${round1(t.p50Ms)}ms · 均 ${round1(t.avgMs)}ms · p90 ${round1(t.p90Ms)}ms · p99 ${round1(t.p99Ms)}ms · 最大 ${round1(t.maxMs)}ms · jank ${round1(t.jankPercent)}% · ${t.frameCount} 帧`;
      const budgetTxt = `${round1(t.budgetMs)}ms·${Math.round(t.refreshHz)}Hz`;
      if (maxFactor > thresholds.criticalMaxFactor) {
        cands.push({
          atMs, severity: 'critical', score: maxFactor,
          label: [
            `触发：单帧最大 ${round1(t.maxMs)}ms 超「严重」阈值（最大 > ${thresholds.criticalMaxFactor}×预算）`,
            stat,
            `为什么有问题：中位才 ${round1(t.p50Ms)}ms、却有一帧 ${round1(t.maxMs)}ms ≈ ${round1(maxFactor)}×预算(${budgetTxt})——不是整体慢，是单帧突然卡很久，肉眼可见顿一下`,
            `怎么定位：拖到这帧对照 CPU/内存——内存跳→GC 停顿；CPU 尖峰→主线程卡；周期性出现多为加载/GC`,
          ].join('\n'),
        });
      } else if (t.jankPercent > thresholds.warningJankPct || p99Factor > thresholds.warningP99Factor) {
        const trig: string[] = [];
        if (t.jankPercent > thresholds.warningJankPct) trig.push(`jank ${round1(t.jankPercent)}% > 阈值 ${thresholds.warningJankPct}%`);
        if (p99Factor > thresholds.warningP99Factor) trig.push(`p99 ${round1(t.p99Ms)}ms > ${thresholds.warningP99Factor}×预算`);
        const everyN = Math.max(2, Math.round(100 / Math.max(0.1, t.jankPercent)));
        cands.push({
          atMs, severity: 'warning', score: Math.max(p99Factor, t.jankPercent / 100),
          label: [
            `触发：${trig.join(' ， ')}`,
            stat,
            `为什么有问题：约每 ${everyN} 帧就有 1 帧迟到(>预算 ${budgetTxt})，最差 1%(p99) 到 ${round1(t.p99Ms)}ms——偶发掉帧、帧节奏不稳，手感不够顺`,
            `怎么定位：拖到这里对照各曲线，看掉帧密集时是 CPU/GPU 还是内存在动`,
          ].join('\n'),
        });
      }
    } else {
      const p = s.metrics.picoMetrics;
      const gpu = p?.frameGpu?.value;
      const cpu = p?.frameCpu?.value;
      if (!finite(gpu) && !finite(cpu)) continue;
      const target = finite(p?.fps?.maxValue) ? (p!.fps!.maxValue as number) : 90;
      const budget = 1000 / Math.max(1, target);
      const gpuV = finite(gpu) ? gpu : 0;
      const cpuV = finite(cpu) ? cpu : 0;
      const over = Math.max(gpuV, cpuV);
      const side = gpuV >= cpuV ? 'GPU' : 'CPU'; // 哪边吃紧（GPU-bound vs CPU-bound）
      const factor = over / budget;
      const hint = side === 'GPU' ? '多为 Drawcall 过多 / 分辨率过高 / Shader 过重' : '多为逻辑脚本 / 物理 / GC 过重';
      const stat = `本秒：FrmGpu ${round1(gpuV)}ms · FrmCpu ${round1(cpuV)}ms · 帧预算 ${round1(budget)}ms(${Math.round(target)}Hz)`;
      if (factor > thresholds.picoCriticalFactor) {
        cands.push({
          atMs, severity: 'critical', score: factor,
          label: [
            `触发：单帧 ${side} ${round1(over)}ms 超「严重」阈值（> ${thresholds.picoCriticalFactor}×预算）`,
            stat,
            `为什么有问题：${side} 单帧 ${round1(over)}ms ≈ ${round1(factor)}×预算——${side} 侧渲染吃紧、撑不住目标帧率（${hint}）`,
            `怎么定位：盯 ${side} 这条线，结合分辨率档位 / 场景复杂度排查`,
          ].join('\n'),
        });
      } else if (factor > thresholds.picoWarningFactor) {
        cands.push({
          atMs, severity: 'warning', score: factor,
          label: [
            `触发：单帧 ${side} ${round1(over)}ms > ${thresholds.picoWarningFactor}×预算(${round1(budget)}ms·${Math.round(target)}Hz)`,
            stat,
            `为什么有问题：${side} 这帧超过帧预算 → ${side} 偶尔超时，帧不稳（${hint}）`,
          ].join('\n'),
        });
      }
    }
  }

  if (!cands.length) return [];
  cands.sort((a, b) => a.atMs - b.atMs);

  // 聚簇：间隔按「簇内最后一个点」算（连续坏点保持一簇），每簇留最狠的。
  const out: ProblemMarker[] = [];
  let worstInCluster = cands[0];
  let lastInCluster = cands[0];
  for (let i = 1; i < cands.length; i++) {
    const c = cands[i];
    if (c.atMs - lastInCluster.atMs <= CLUSTER_GAP_MS) {
      lastInCluster = c;
      if (worse(c, worstInCluster)) worstInCluster = c;
    } else {
      out.push({ atMs: worstInCluster.atMs, severity: worstInCluster.severity, label: worstInCluster.label });
      worstInCluster = c;
      lastInCluster = c;
    }
  }
  out.push({ atMs: worstInCluster.atMs, severity: worstInCluster.severity, label: worstInCluster.label });
  return out;
}
