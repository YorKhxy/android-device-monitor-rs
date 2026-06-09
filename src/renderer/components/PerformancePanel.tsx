import { useState } from 'react';
import type { DeviceInfo, PerformanceCaptureMarker, PerformanceCaptureSession, PerformanceMetrics, PerformanceSample, PicoMetricsState } from '../../shared/types';
import { useCooldown } from '../lib/useCooldown';
import { CaptureReport } from './CaptureReport';
import { CaptureHistoryList } from './CaptureHistoryList';
import { computeMetricStat, formatClock, formatMemoryMb, METRIC_COLORS } from './perfFormat';
import { Badge, Icon } from './ui';

type PerformancePanelProps = {
  device: DeviceInfo | null;
  performance: PerformanceMetrics | null;
  /** 当前展示的会话：采集中=活动会话，停止后=报告会话；无则未采集且无报告。 */
  captureSession: PerformanceCaptureSession | null;
  captureSamples: PerformanceSample[];
  isCapturing: boolean;
  /** start/stop 异步进行中：禁用开关防重复点击。 */
  isCaptureBusy: boolean;
  /** 当前设备是否正在投屏：用于提示「投屏会增加负载、轻微影响性能读数」（非阻塞）。 */
  isDeviceMirroring?: boolean;
  elapsedMs: number;
  /** 软上限提醒文本（达 30 分钟 / 2GB），null 表示不显示。 */
  softLimitNotice: string | null;
  /** 当前会话已存的过滤标记（加载历史会话时带入）。 */
  captureMarkers?: PerformanceCaptureMarker[];
  /** 采集回看列表（倒序）。 */
  captureSessions: PerformanceCaptureSession[];
  /** 当前在报告区展示的会话 id（列表高亮用）。 */
  loadedSessionId: string | null;
  onToggleCapture: () => void;
  onDismissSoftLimit: () => void;
  onSaveCaptureMarkers: (sessionId: string, markers: PerformanceCaptureMarker[]) => void;
  onSaveCaptureFrame: (sessionId: string, dataUrl: string) => Promise<string | undefined>;
  onSelectCaptureSession: (sessionId: string) => void;
  onRenameCaptureSession: (sessionId: string, title: string) => void;
  onDeleteCaptureSession: (sessionId: string) => void;
  onExportCaptureSession: (sessionId: string) => void;
  /** 刷新采集回看列表（手动重新拉取归档会话）。 */
  onRefreshCaptureSessions: () => void;
  /** 选 zip 文件导入。 */
  onImportCaptureSessions: () => void;
  /** 拖拽导入（.zip 或会话文件夹路径）。 */
  onImportCapturePaths: (paths: string[]) => void;
  onExportSession: () => void;
  /** 最近一次导出的采集 zip 在 PC 上的路径；非空时显示「打开位置」按钮。 */
  lastExportedCapturePath?: string | null;
  /** 在资源管理器中定位最近导出的采集 zip。 */
  onRevealExportedCapture?: () => void;
};

type MetricChip = { label: string; value: string; unit?: string; color: string; muted?: boolean };

// 把指标压成紧凑一行小条（色点 + 名 + 数值 + 单位），把竖向空间让给曲线/视频。
const buildMetricChips = (performance: PerformanceMetrics | null, isPicoView: boolean, showPicoFallback: boolean): MetricChip[] => {
  const fps = performance ? String(performance.fps) : '--';
  const cpu = performance ? performance.cpuUsage.toFixed(1) : '--';
  const mem = performance ? formatMemoryMb(performance.memoryUsage) : '--';
  const base: MetricChip[] = [
    { label: 'FPS', value: fps, color: METRIC_COLORS.fps },
    { label: 'CPU', value: cpu, unit: '%', color: METRIC_COLORS.cpu },
    { label: 'MEM', value: mem, unit: 'MB', color: METRIC_COLORS.mem },
  ];
  if (!isPicoView) return base;

  const pico = performance?.picoMetrics;
  if (showPicoFallback) {
    return [
      ...base,
      { label: 'GPU', value: '--', color: METRIC_COLORS.gpu, muted: true },
      { label: 'MTP', value: '--', color: 'var(--info)', muted: true },
      { label: 'FrmCpu', value: '--', color: 'var(--success)', muted: true },
      { label: 'FrmGpu', value: '--', color: 'var(--warning)', muted: true },
      { label: 'ATWGPU', value: '--', color: 'var(--gold)', muted: true },
    ];
  }
  const picoFps = pico?.fps?.value ?? performance?.fps;
  return [
    { label: 'FPS', value: picoFps !== undefined ? String(picoFps) : '--', unit: pico?.fps?.maxValue !== undefined ? `/${pico.fps.maxValue}` : '', color: METRIC_COLORS.fps },
    { label: 'CPU', value: cpu, unit: '%', color: METRIC_COLORS.cpu },
    { label: 'MEM', value: mem, unit: 'MB', color: METRIC_COLORS.mem },
    { label: 'GPU', value: pico?.gpuUtil ? String(pico.gpuUtil.value) : '--', unit: pico?.gpuUtil?.unit || '%', color: METRIC_COLORS.gpu },
    { label: 'MTP', value: pico?.mtp ? String(pico.mtp.value) : '--', unit: pico?.mtp?.unit || '', color: 'var(--info)' },
    { label: 'FrmCpu', value: pico?.frameCpu ? String(pico.frameCpu.value) : '--', unit: pico?.frameCpu?.unit || '', color: 'var(--success)' },
    { label: 'FrmGpu', value: pico?.frameGpu ? String(pico.frameGpu.value) : '--', unit: pico?.frameGpu?.unit || '', color: 'var(--warning)' },
    { label: 'ATWGPU', value: pico?.atwGpu ? String(pico.atwGpu.value) : '--', unit: pico?.atwGpu?.unit || '', color: 'var(--gold)' },
  ];
};

const renderMetricStrip = (performance: PerformanceMetrics | null, isPicoView: boolean, showPicoFallback: boolean) => (
  // 固定列 grid（列数只随容器宽变化，与数值位数无关）：避免数值变大撑宽 chip 触发 flex 换行重排、整条高度跳动。
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
    {buildMetricChips(performance, isPicoView, showPicoFallback).map((chip) => (
      <div key={chip.label} style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '7px 11px', opacity: chip.muted ? 0.5 : 1 }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: chip.color, flexShrink: 0 }} />
        <span style={{ color: 'var(--fg-secondary)', fontSize: '12px' }}>{chip.label}</span>
        <span style={{ color: 'var(--fg-primary)', fontSize: '15px', fontWeight: 600, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{chip.value}</span>
        {chip.unit ? <span style={{ color: 'var(--fg-tertiary)', fontSize: '11px' }}>{chip.unit}</span> : null}
      </div>
    ))}
  </div>
);

const isLikelyPicoDevice = (device: DeviceInfo | null) => {
  const identity = [device?.manufacturer, device?.name, device?.model].filter(Boolean).join(' ').toLowerCase();
  return identity.includes('pico') || identity.includes('a9210') || identity.includes('sparrow');
};

export function PerformancePanel({
  device,
  performance,
  captureSession,
  captureSamples,
  isCapturing,
  isCaptureBusy,
  isDeviceMirroring,
  elapsedMs,
  softLimitNotice,
  captureMarkers,
  captureSessions,
  loadedSessionId,
  onToggleCapture,
  onDismissSoftLimit,
  onSaveCaptureMarkers,
  onSaveCaptureFrame,
  onSelectCaptureSession,
  onRenameCaptureSession,
  onDeleteCaptureSession,
  onExportCaptureSession,
  onRefreshCaptureSessions,
  onImportCaptureSessions,
  onImportCapturePaths,
  onExportSession,
  lastExportedCapturePath,
  onRevealExportedCapture,
}: PerformancePanelProps) {
  const [importDragOver, setImportDragOver] = useState(false);
  // 刷新是瞬时动作（本地重拉列表），用假冷却给可见反馈。
  const refreshCooldown = useCooldown();
  // 采集回看类型筛选：全部 / 仅安卓 / 仅 Pico（手动筛，不再跟随当前设备）。
  const [captureTypeFilter, setCaptureTypeFilter] = useState<'all' | 'android' | 'pico'>('all');
  // 回放时播放头处的样本（由 CaptureReport 上抛）：让「前台应用 + 参数」块跟随回放数据而非实时设备。
  const [playbackSample, setPlaybackSample] = useState<PerformanceSample | null>(null);

  const handleImportDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setImportDragOver(false);
    const paths = Array.from(e.dataTransfer.files || [])
      .map((f) => (f as File & { path?: string }).path || '')
      .filter(Boolean);
    if (paths.length) onImportCapturePaths(paths);
  };
  const isPicoView = performance?.provider === 'pico' || (!performance && isLikelyPicoDevice(device));
  const picoMetricsState: PicoMetricsState = performance?.picoMetricsState || 'native';
  const showPicoFallback = isPicoView && picoMetricsState !== 'native';
  const canExport = captureSamples.length > 0;
  // 回放（非采集且有已加载会话）时，「前台应用 + 参数」块跟随播放头处的回放样本：
  // 样本自带 provider/包名/Pico 指标，于是 Pico 回放显示 Pico 口径，安卓回放显示安卓口径，
  // 不再错误地显示当前实时设备的口径。无回放时仍用实时 performance。
  const isPlayback = !isCapturing && !!captureSession;
  const blockPerformance = isPlayback ? (playbackSample?.metrics ?? captureSamples[0]?.metrics ?? null) : performance;
  const blockIsPicoView = isPlayback ? blockPerformance?.provider === 'pico' : isPicoView;
  const blockShowPicoFallback = blockIsPicoView && (blockPerformance?.picoMetricsState ?? 'native') !== 'native';
  // 按所选类型筛选回看列表：provider 以 pico 开头视为 Pico，否则安卓。
  const filteredSessions = captureSessions.filter((s) =>
    captureTypeFilter === 'all'
      ? true
      : captureTypeFilter === 'pico'
        ? s.provider.startsWith('pico')
        : !s.provider.startsWith('pico'),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {softLimitNotice && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', backgroundColor: 'var(--warning-soft)', border: '1px solid var(--warning)', borderRadius: 'var(--r-md)', padding: '10px 14px', color: 'var(--warning)' }}>
          <span style={{ fontSize: '13px' }}>{softLimitNotice}</span>
          <button onClick={onDismissSoftLimit} className="btn outline o-amber sm" style={{ whiteSpace: 'nowrap' }}>知道了</button>
        </div>
      )}

      {/* 顶部两列：左=采集控制 +「前台应用/参数」合并块，右=采集回看（性能页右上角）。
          stretch 让左列拉到与右侧回看等高，合并块 flex:1 填满采集控制下方空白。 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '12px', alignItems: 'stretch' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <section style={{ backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
            <div style={{ color: 'var(--fg-primary)', fontSize: '15px', fontWeight: 600 }}>采集控制</div>
            <Badge tone={isCapturing ? 'success' : 'neutral'} dot>
              {isCapturing ? `采集中 ${formatClock(elapsedMs)}` : '未采集'}
            </Badge>
          </div>
          <div style={{ color: 'var(--fg-secondary)', fontSize: '12px', lineHeight: 1.5 }}>
            一次「开始采集 → 关闭采集」生成一份采集报告：曲线填满区域，录屏在报告内合并播放，拖动时间轴联动曲线游标与画面。
          </div>
          {isDeviceMirroring && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', color: 'var(--warning)', backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--warning)', borderRadius: 'var(--r-sm)', padding: '7px 10px', fontSize: '12px', lineHeight: 1.5 }}>
              <span style={{ flexShrink: 0, display: 'inline-flex', marginTop: '1px' }}><Icon name="alert-triangle" size={14} /></span>
              <span>当前设备正在投屏：投屏会额外占用编码器与带宽，增加设备负载、轻微影响性能读数。追求更准的数据可先停止投屏再采集。</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              onClick={onToggleCapture}
              disabled={isCaptureBusy || !device}
              className="btn"
              style={{
                flex: 1,
                minWidth: '120px',
                color: '#fff',
                border: 'none',
                backgroundColor: isCaptureBusy || !device ? 'var(--bg-elevated)' : isCapturing ? 'var(--danger)' : 'var(--success)',
              }}
            >
              <Icon name={isCapturing ? 'square' : 'play'} />
              {isCaptureBusy ? '处理中...' : isCapturing ? '关闭采集' : '开始采集'}
            </button>
            <button
              onClick={onExportSession}
              disabled={!canExport}
              className="btn secondary"
              style={{ flex: 1, minWidth: '120px' }}
            >
              <Icon name="download" />
              导出报告
            </button>
          </div>
        </section>

        {/* 合并块：前台应用在上，参数指标条在下；flex:1 撑满左列剩余高度。 */}
        <section style={{ flex: 1, backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', justifyContent: 'center' }}>
          {(blockPerformance?.packageName || blockPerformance?.activityName) && (
            <div>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '6px' }}>{blockIsPicoView ? '当前 Pico 指标关联前台应用' : '当前 FPS 口径'}</div>
              <div style={{ fontSize: '14px', color: 'var(--fg-secondary)', marginBottom: '4px' }}>{blockPerformance?.packageName || '--'}</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', wordBreak: 'break-all' }}>{blockPerformance?.activityName || '未能解析前台 Activity'}</div>
            </div>
          )}
          {renderMetricStrip(blockPerformance, blockIsPicoView, blockShowPicoFallback)}
        </section>
        </div>

        <section
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setImportDragOver(false); }}
          onDrop={handleImportDrop}
          style={{ backgroundColor: 'var(--bg-panel)', border: `1px solid ${importDragOver ? 'var(--accent)' : 'var(--border-subtle)'}`, borderRadius: 'var(--r-md)', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--fg-primary)' }}>采集回看</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {lastExportedCapturePath && onRevealExportedCapture && (
                <button
                  onClick={onRevealExportedCapture}
                  data-tip={`在资源管理器中定位最近导出的采集：${lastExportedCapturePath}`}
                  className="btn outline o-green sm"
                >
                  <Icon name="folder-open" />打开位置
                </button>
              )}
              <button
                onClick={() => refreshCooldown.run(onRefreshCaptureSessions)}
                disabled={refreshCooldown.cooling}
                data-tip="刷新采集回看列表"
                className="btn secondary sm"
              >
                <span className={refreshCooldown.cooling ? 'adm-spin' : undefined} style={{ display: 'inline-flex' }}><Icon name="refresh-cw" /></span>刷新
              </button>
              <button
                onClick={onImportCaptureSessions}
                data-tip="导入采集会话（.zip）；也可把 zip 或会话文件夹拖到此区域"
                className="btn secondary sm"
              >
                <Icon name="upload" />导入
              </button>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{`共 ${filteredSessions.length} 次`}</div>
            </div>
          </div>
          {/* 类型筛选：手动按全部 / 安卓 / Pico 筛选回看，不跟随当前设备。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>类型</span>
            <div style={{ display: 'inline-flex', backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-sm)', padding: '2px' }}>
              {([
                { key: 'all', label: '全部' },
                { key: 'android', label: '安卓' },
                { key: 'pico', label: 'Pico' },
              ] as const).map((opt) => {
                const active = captureTypeFilter === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => setCaptureTypeFilter(opt.key)}
                    style={{ border: 'none', borderRadius: 'var(--r-xs)', cursor: 'pointer', padding: '4px 14px', fontSize: '12px', backgroundColor: active ? 'var(--accent)' : 'transparent', color: active ? '#fff' : 'var(--fg-tertiary)', fontWeight: active ? 600 : 400 }}
                  >{opt.label}</button>
                );
              })}
            </div>
          </div>
          {importDragOver && (
            <div style={{ color: 'var(--accent)', fontSize: '12px' }}>松开以导入采集会话（.zip 或会话文件夹）</div>
          )}
          {/* 列表可能较长，限高并独立滚动，避免顶部行被撑过高。 */}
          <div style={{ maxHeight: '232px', overflowY: 'auto', paddingRight: filteredSessions.length ? '2px' : 0 }}>
            <CaptureHistoryList
              sessions={filteredSessions}
              selectedSessionId={loadedSessionId}
              onSelect={onSelectCaptureSession}
              onRename={onRenameCaptureSession}
              onDelete={onDeleteCaptureSession}
              onExport={onExportCaptureSession}
            />
          </div>
        </section>
      </div>

      {/* 主区：采集报告（曲线 + 单眼视频）+ 参数过滤。 */}
      <div style={{ backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-primary)' }}>{isCapturing ? '实时采集' : '采集报告'}</div>
          <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{`采样 ${captureSamples.length} 条`}</div>
        </div>
        {/* 本次采集统计：FPS/CPU/内存 的 均值/最高/最低，始终可见（不随过滤显隐）。Android 与 Pico 统一口径。 */}
        {captureSamples.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
            {([
              { key: 'fps', label: 'FPS', color: METRIC_COLORS.fps, unit: '', decimals: 0 },
              { key: 'cpu', label: 'CPU', color: METRIC_COLORS.cpu, unit: '%', decimals: 1 },
              { key: 'mem', label: 'MEM', color: METRIC_COLORS.mem, unit: 'MB', decimals: 0 },
              // GPU 仅 Pico 有值：Android 上 computeMetricStat 返回 null → 该 chip 自动不渲染。
              { key: 'gpu', label: 'GPU', color: METRIC_COLORS.gpu, unit: '%', decimals: 0 },
            ] as const).map((item) => {
              const stat = computeMetricStat(captureSamples, item.key);
              if (!stat) return null;
              const fmt = (v: number) => (item.decimals ? v.toFixed(item.decimals) : String(Math.round(v)));
              return (
                <div key={item.key} data-tip={`本次采集 ${item.label} 统计（均值 / 最高 / 最低）`} style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '6px 11px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: item.color, flex: 'none' }} />
                  <span style={{ fontSize: '12px', color: 'var(--fg-secondary)' }}>{item.label}</span>
                  {([['均', stat.avg], ['高', stat.max], ['低', stat.min]] as const).map(([tag, val]) => (
                    <span key={tag} style={{ display: 'inline-flex', alignItems: 'baseline', gap: '3px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>{tag}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 600, color: 'var(--fg-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(val)}</span>
                    </span>
                  ))}
                  {item.unit && <span style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>{item.unit}</span>}
                </div>
              );
            })}
          </div>
        )}
        <CaptureReport
          session={captureSession}
          samples={captureSamples}
          live={isCapturing}
          elapsedMs={elapsedMs}
          markers={captureMarkers}
          onSaveMarkers={onSaveCaptureMarkers}
          onSaveFrame={onSaveCaptureFrame}
          onActiveSampleChange={setPlaybackSample}
        />
      </div>
    </div>
  );
}
