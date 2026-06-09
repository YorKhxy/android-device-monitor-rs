import { memo, useMemo, useState } from 'react';
import type { WeakNetworkHelperStatus, WeakNetworkProfile, WeakNetworkShaperStats } from '../../shared/types';
import { WEAK_NETWORK_PRESETS } from '../../shared/types';
import { Icon, Badge, LineChart, type BadgeTone } from './ui';

type WeakNetParams = Omit<WeakNetworkProfile, 'packageName'>;

type WeakNetTraffic = { rxBytes: number; txBytes: number; rxRate: number; txRate: number };

type WeakNetPanelProps = {
  deviceConnected: boolean;
  status: WeakNetworkHelperStatus;
  traffic: WeakNetTraffic | null;
  trafficHistory: { rx: number; tx: number }[];
  shaperStats: WeakNetworkShaperStats | null;
  onExportTraffic: () => void;
  installedPackages: string[];
  loadingPackages: boolean;
  busy: boolean;
  errorMessage: string | null;
  onRefreshPackages: () => void;
  onRefreshStatus: () => void;
  onInstallHelper: () => void;
  onStart: (profile: WeakNetworkProfile) => void;
  onStop: () => void;
  onAuthorize: () => void;
};

const DEFAULT_PARAMS: WeakNetParams = {
  latencyMs: 0,
  jitterMs: 0,
  packetLossPercent: 0,
  uploadKbps: 0,
  downloadKbps: 0,
};

const STATUS_META: Record<WeakNetworkHelperStatus, { label: string; tone: BadgeTone }> = {
  'not-installed': { label: '未安装', tone: 'neutral' },
  idle: { label: '已就绪', tone: 'success' },
  'need-vpn-permission': { label: '待授权', tone: 'warning' },
  running: { label: '运行中', tone: 'info' },
  stopped: { label: '已停止', tone: 'neutral' },
  error: { label: '异常', tone: 'danger' },
};

const PARAM_FIELDS: { key: keyof WeakNetParams; label: string; min: number; max: number; step: number }[] = [
  { key: 'latencyMs', label: '延迟 (ms)', min: 0, max: 60000, step: 10 },
  { key: 'jitterMs', label: '抖动 (ms)', min: 0, max: 60000, step: 10 },
  { key: 'packetLossPercent', label: '丢包 (%)', min: 0, max: 100, step: 1 },
  { key: 'uploadKbps', label: '上行 (kbps，0=不限)', min: 0, max: 1000000, step: 64 },
  { key: 'downloadKbps', label: '下行 (kbps，0=不限)', min: 0, max: 1000000, step: 64 },
];

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
};

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r-sm)',
  color: 'var(--fg-primary)',
  fontSize: '13px',
  outline: 'none',
  fontFamily: 'var(--font-mono)',
};

const formatBytes = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
};
const formatRate = (n: number): string => `${formatBytes(n)}/s`;

// 抽成 memo 组件：只在流量历史(2.5s 才变)的引用变化时重绘，
// 对 SimpleApp 的高频重渲染（日志批量推送每 250ms、电量轮询等）免疫，避免 SVG 反复重绘闪烁。
const TrafficChart = memo(function TrafficChart({ history }: { history: { rx: number; tx: number }[] }) {
  const max = Math.max(1, ...history.map((p) => Math.max(p.rx, p.tx)));
  return (
    <div style={{ position: 'relative', height: 96, background: 'var(--bg-mirror)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <LineChart data={history.map((p) => p.rx)} color="var(--success)" max={max} height={96} />
      </div>
      <div style={{ position: 'absolute', inset: 0 }}>
        <LineChart data={history.map((p) => p.tx)} color="var(--info)" max={max} height={96} fill={false} />
      </div>
      <div style={{ position: 'absolute', top: 4, right: 8, fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--fg-tertiary)' }}>峰值 {formatRate(max)}</div>
    </div>
  );
});

export function WeakNetPanel({
  deviceConnected,
  status,
  traffic,
  trafficHistory,
  shaperStats,
  onExportTraffic,
  installedPackages,
  loadingPackages,
  busy,
  errorMessage,
  onRefreshPackages,
  onRefreshStatus,
  onInstallHelper,
  onStart,
  onStop,
  onAuthorize,
}: WeakNetPanelProps) {
  const [selectedPackage, setSelectedPackage] = useState('');
  const [params, setParams] = useState<WeakNetParams>(DEFAULT_PARAMS);

  const statusMeta = STATUS_META[status];
  const isRunning = status === 'running';
  const installed = status !== 'not-installed';
  const canStart = deviceConnected && installed && !busy && !isRunning && selectedPackage.trim().length > 0;

  const setParam = (field: typeof PARAM_FIELDS[number], rawValue: string) => {
    const parsed = field.key === 'packetLossPercent' ? Number.parseFloat(rawValue) : Number.parseInt(rawValue, 10);
    setParams((prev) => ({ ...prev, [field.key]: clamp(Number.isNaN(parsed) ? 0 : parsed, field.min, field.max) }));
  };

  const applyPreset = (values: WeakNetParams) => setParams(values);

  const handleStart = () => {
    if (!canStart) return;
    onStart({ packageName: selectedPackage.trim(), ...params });
  };

  // 运行中热更新参数：再次下发 START（助手会先停旧引擎再起），不需手动先停。
  const handleApply = () => {
    if (busy || selectedPackage.trim().length === 0) return;
    onStart({ packageName: selectedPackage.trim(), ...params });
  };

  const packageOptions = useMemo(() => installedPackages.slice().sort((a, b) => a.localeCompare(b)), [installedPackages]);

  const labelStyle: React.CSSProperties = { color: 'var(--fg-tertiary)', minWidth: '64px', fontSize: '13px' };

  if (!deviceConnected) {
    return (
      <div style={{ color: 'var(--fg-tertiary)', padding: '24px', textAlign: 'center' }}>
        请先连接并选中一台设备，再使用弱网控制。
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px' }}>
      {/* 状态栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span style={labelStyle}>助手状态</span>
        <Badge tone={statusMeta.tone} dot>{statusMeta.label}</Badge>
        <button className="btn secondary sm" onClick={onRefreshStatus} disabled={busy}>
          <Icon name="refresh-cw" />刷新状态
        </button>
        {!installed && (
          <button className="btn primary sm" onClick={onInstallHelper} disabled={busy}>
            <Icon name="download" />{busy ? '安装中…' : '安装助手'}
          </button>
        )}
        <button className="btn secondary sm" onClick={onAuthorize} disabled={busy || !installed}>
          <Icon name="shield-check" />在设备上授权 VPN
        </button>
      </div>

      {installed && (
        <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>
          首次使用需先点「在设备上授权 VPN」，并在头显内确认 VPN 连接请求；授权后再启动弱网。
        </div>
      )}

      {errorMessage && (
        <div style={{ color: 'var(--danger)', background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: '13px' }}>
          {errorMessage}
        </div>
      )}

      {/* 目标应用 */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={labelStyle}>目标应用</span>
        <select
          className="nat"
          value={selectedPackage}
          onChange={(event) => setSelectedPackage(event.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 0 }}
        >
          <option value="">{loadingPackages ? '加载中…' : packageOptions.length ? '请选择目标应用包名' : '未获取到已安装应用'}</option>
          {packageOptions.map((pkg) => (
            <option key={pkg} value={pkg}>{pkg}</option>
          ))}
        </select>
        <button className="btn secondary sm" onClick={onRefreshPackages} disabled={busy}>
          <Icon name="refresh-cw" />刷新列表
        </button>
      </div>

      {/* 预设档位 */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={labelStyle}>预设档位</span>
        {WEAK_NETWORK_PRESETS.map((preset) => (
          <button key={preset.id} className="btn outline o-blue sm" onClick={() => applyPreset(preset.values)} disabled={busy}>
            {preset.label}
          </button>
        ))}
        <button className="btn ghost sm" onClick={() => applyPreset(DEFAULT_PARAMS)} disabled={busy}>清零</button>
      </div>

      {/* 参数 */}
      <div className="subpanel" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', padding: '16px' }}>
        {PARAM_FIELDS.map((field) => (
          <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px', color: 'var(--fg-tertiary)', fontSize: '12px' }}>
            {field.label}
            <input
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={params[field.key]}
              disabled={busy}
              onChange={(event) => setParam(field, event.target.value)}
              style={inputStyle}
            />
          </label>
        ))}
      </div>

      {/* 实时流量（仅运行中显示，读 tun 计数算速率 + 曲线）*/}
      {isRunning && traffic && (
        <div className="subpanel" style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 16px' }}>
          <div style={{ display: 'flex', gap: '32px', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Icon name="arrow-up" size={16} color="var(--info)" />
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', color: 'var(--fg-primary)' }}>{formatRate(traffic.txRate)}</div>
                <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>上行 · 累计 {formatBytes(traffic.txBytes)}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Icon name="arrow-down" size={16} color="var(--success)" />
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', color: 'var(--fg-primary)' }}>{formatRate(traffic.rxRate)}</div>
                <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>下行 · 累计 {formatBytes(traffic.rxBytes)}</div>
              </div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '14px', fontSize: '11.5px', color: 'var(--fg-tertiary)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}><span style={{ width: 12, height: 2, background: 'var(--info)' }} />上行</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}><span style={{ width: 12, height: 2, background: 'var(--success)' }} />下行</span>
              <button className="btn ghost sm" onClick={onExportTraffic} disabled={trafficHistory.length === 0} title="导出流量曲线为 CSV">
                <Icon name="download" />导出 CSV
              </button>
            </div>
          </div>
          {shaperStats && (
            <div style={{ display: 'flex', gap: '28px', alignItems: 'center', paddingTop: '4px', borderTop: '1px solid var(--border-subtle)' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', color: shaperStats.lossPercent > 0 ? 'var(--danger)' : 'var(--fg-primary)' }}>
                  {shaperStats.lossPercent.toFixed(1)}%
                </div>
                <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>实测丢包</div>
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', color: 'var(--fg-primary)' }}>
                  {shaperStats.avgRttMs > 0 ? `${Math.round(shaperStats.avgRttMs)} ms` : '--'}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>实测往返延迟</div>
              </div>
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', color: 'var(--fg-secondary)' }}>
                  {shaperStats.droppedPackets} / {shaperStats.decidedPackets}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>丢弃 / 决策</div>
              </div>
              <span style={{ marginLeft: 'auto', fontSize: '11.5px', color: 'var(--fg-tertiary)' }}>实测值来自助手整形层（非配置值）</span>
            </div>
          )}

          {trafficHistory.length >= 2 && <TrafficChart history={trafficHistory} />}
        </div>
      )}

      {/* 起停 */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        {isRunning ? (
          <>
            <button className="btn o-red outline" onClick={onStop} disabled={busy} style={{ height: 40 }}>
              <Icon name="square" />{busy ? '处理中…' : '停止弱网'}
            </button>
            <button className="btn primary" onClick={handleApply} disabled={busy} style={{ height: 40 }}>
              <Icon name="refresh-cw" />应用新参数
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={handleStart} disabled={!canStart} style={{ height: 40 }}>
            <Icon name="play" />{busy ? '处理中…' : '启动弱网'}
          </button>
        )}
        <span style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>
          {isRunning ? '弱网生效中，改完参数点「应用新参数」即时生效。' : '弱网仅作用于所选目标应用，不影响整机网络与 ADB。'}
        </span>
      </div>
    </div>
  );
}
