import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { MirrorSession, MirrorSessionStatus } from '../../shared/types';
import { Icon, Badge } from './ui';
import type { BadgeTone } from './ui';

type MirrorStartParams = { maxSize?: number; bitRate?: string; forwardAudio?: boolean };

type MirrorPanelProps = {
  deviceName: string;
  isPico: boolean;
  session: MirrorSession | null;
  starting: boolean;
  onStart: (params: MirrorStartParams) => void;
  onStop: () => void;
  onToggleAudio: (forward: boolean) => void; // 投屏中实时切换音频去向
};

const STATUS_META: Record<MirrorSessionStatus, { label: string; tone: BadgeTone; dot: boolean }> = {
  starting: { label: '启动中', tone: 'info', dot: true },
  running: { label: '镜像中', tone: 'success', dot: true },
  stopped: { label: '已停止', tone: 'neutral', dot: false },
  failed: { label: '启动失败', tone: 'danger', dot: false },
};

const MAX_SIZE_OPTIONS: { label: string; value: number | undefined }[] = [
  { label: '不限', value: undefined },
  { label: '1280', value: 1280 },
  { label: '1600', value: 1600 },
];

const BIT_RATE_OPTIONS = ['4M', '8M', '16M'];

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Alt + h', action: '主页 Home' },
  { keys: 'Alt + b', action: '返回 Back' },
  { keys: 'Alt + s', action: '最近任务' },
  { keys: 'Alt + p', action: '电源键' },
  { keys: 'Alt + ↑ / ↓', action: '音量加 / 减' },
  { keys: 'Alt + r', action: '旋转屏幕' },
];

const cardStyle: CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-md)',
  padding: '16px 18px',
};

const isActive = (session: MirrorSession | null, starting: boolean): boolean => {
  if (starting) return true;
  return session?.status === 'starting' || session?.status === 'running';
};

export function MirrorPanel({ deviceName, isPico, session, starting, onStart, onStop, onToggleAudio }: MirrorPanelProps) {
  // 默认分辨率上限 1280、码率 4M（流畅优先；可在投屏前下拉调整）。
  const [maxSize, setMaxSize] = useState<number | undefined>(1280);
  const [bitRate, setBitRate] = useState<string>('4M');
  const [showShortcuts, setShowShortcuts] = useState(false);
  // 启动时是否把声音转到电脑（未投屏时由此控制初值）。默认 false：声音留在设备本机输出。
  const [forwardAudio, setForwardAudio] = useState(false);

  const active = isActive(session, starting);
  // 复选框的真值：投屏中以主进程会话的实际音频状态为准，未投屏时用本地初值。
  const audioOn = active ? Boolean(session?.audioForwarded) : forwardAudio;
  const status: MirrorSessionStatus = starting ? 'starting' : session?.status ?? 'stopped';
  const meta = STATUS_META[status];

  return (
    <div style={{ maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* 投屏控制 */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--fg-primary)', marginBottom: '8px' }}>
              投屏镜像与操控
            </div>
            <div style={{ fontSize: '13px', color: 'var(--fg-secondary)' }}>
              当前设备：<b style={{ color: 'var(--fg-primary)' }}>{deviceName}</b>
              {isPico && <span style={{ color: 'var(--fg-tertiary)' }}> · Pico 单眼裁切</span>}
            </div>
            <div style={{ marginTop: '8px' }}>
              <Badge tone={meta.tone} dot={meta.dot}>{meta.label}</Badge>
            </div>
          </div>

          <button
            className={`btn ${active ? 'outline o-red' : 'primary'}`}
            onClick={active ? onStop : () => onStart({ maxSize, bitRate, forwardAudio })}
            disabled={starting}
          >
            <Icon name={active ? 'square' : 'cast'} />
            {active ? '停止投屏' : '开始投屏'}
          </button>
        </div>
      </div>

      {/* 投屏设置 */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '22px', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '9px', fontSize: '13px', color: 'var(--fg-secondary)' }}>
          分辨率上限
          <select
            className="nat"
            value={maxSize ?? ''}
            disabled={active}
            onChange={(e) => setMaxSize(e.target.value ? Number(e.target.value) : undefined)}
            style={{ cursor: active ? 'not-allowed' : 'pointer', opacity: active ? 0.6 : 1 }}
          >
            {MAX_SIZE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value ?? ''}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '9px', fontSize: '13px', color: 'var(--fg-secondary)' }}>
          码率
          <select
            className="nat"
            value={bitRate}
            disabled={active}
            onChange={(e) => setBitRate(e.target.value)}
            style={{ cursor: active ? 'not-allowed' : 'pointer', opacity: active ? 0.6 : 1 }}
          >
            {BIT_RATE_OPTIONS.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '9px',
            fontSize: '13px',
            color: 'var(--fg-secondary)',
            cursor: starting ? 'not-allowed' : 'pointer',
            opacity: starting ? 0.6 : 1,
            whiteSpace: 'nowrap',
          }}
          data-tip="默认声音只在设备本机播放；勾选后电脑也出声。设备 Android 13+ 时两边同时出声（设备不静音），低版本会自动降级为仅电脑出声（设备静音）。投屏过程中可随时切换，不影响画面。"
        >
          <input
            type="checkbox"
            checked={audioOn}
            disabled={starting}
            onChange={(e) => {
              // 投屏中实时切换；未投屏时仅记录启动初值。
              if (active) onToggleAudio(e.target.checked);
              else setForwardAudio(e.target.checked);
            }}
            style={{ cursor: starting ? 'not-allowed' : 'pointer', accentColor: 'var(--accent)' }}
          />
          把设备声音传到电脑{active ? '（可实时切换）' : ''}
        </label>
        {active && (
          <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>
            分辨率 / 码率投屏中不可改，声音可随时切换
          </span>
        )}
        {active && audioOn && session?.audioMode === 'both' && (
          <Badge tone="success" icon="volume-2">设备与电脑同时出声</Badge>
        )}
        {active && audioOn && session?.audioMode === 'pc-only' && (
          <Badge tone="warning" icon="triangle-alert">该设备不支持两边同时出声（需 Android 13+），已改为仅电脑出声（设备静音）</Badge>
        )}
      </div>

      {/* Pico 提示 */}
      {isPico && (
        <div
          style={{
            background: 'var(--warning-soft)',
            border: '1px solid var(--warning)',
            borderRadius: 'var(--r-md)',
            padding: '13px 16px',
            display: 'flex',
            gap: '11px',
          }}
        >
          <Icon name="triangle-alert" size={17} color="var(--warning)" style={{ flex: 'none', marginTop: '1px' }} />
          <div style={{ fontSize: '13px', color: 'var(--fg-secondary)', lineHeight: '20px' }}>
            <b style={{ color: 'var(--warning)' }}>Pico 设备：</b>仅支持 <b style={{ color: 'var(--fg-primary)' }}>2D 界面</b>
            （启动器、平面应用）的触屏操控；VR 沉浸场景的 <b style={{ color: 'var(--fg-primary)' }}>6DoF 手柄无法操控</b>
            （手柄输入走 VR runtime，非标准 Android 事件，scrcpy 无法注入）。画面已自动裁切为单眼显示。
          </div>
        </div>
      )}

      {/* 启动失败提示 */}
      {status === 'failed' && session?.error && (
        <div
          style={{
            background: 'var(--danger-soft)',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--r-md)',
            padding: '13px 16px',
            display: 'flex',
            gap: '11px',
            color: 'var(--danger)',
            fontSize: '13px',
            lineHeight: '20px',
            wordBreak: 'break-all',
          }}
        >
          <Icon name="circle-alert" size={17} color="var(--danger)" style={{ flex: 'none', marginTop: '1px' }} />
          <div>{session.error}</div>
        </div>
      )}

      {/* 使用说明 */}
      <div style={{ ...cardStyle, fontSize: '13px', color: 'var(--fg-secondary)' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-primary)', marginBottom: '12px' }}>使用说明</div>
        <ul style={{ margin: 0, paddingLeft: '18px', lineHeight: '23px' }}>
          <li>点击「开始投屏」会调起独立的 scrcpy 镜像窗口，高帧率显示并可操控设备。</li>
          <li>在镜像窗口内用鼠标点击 / 拖拽操作触屏，键盘可直接输入文字。</li>
          <li>把 .apk 文件拖进镜像窗口可直接安装；拖其他文件则推送到设备 /sdcard/Download/（安装无窗口内提示，结果可在设备查看）。</li>
          <li>关闭镜像窗口或点「停止投屏」即结束，设备上无需安装任何应用。</li>
        </ul>

        <div className="link" style={{ marginTop: '12px', fontSize: '13px' }} onClick={() => setShowShortcuts((v) => !v)}>
          {showShortcuts ? '▾ 收起快捷键速查' : '▸ 展开快捷键速查'}
        </div>

        {showShortcuts && (
          <div style={{ marginTop: '10px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px 24px' }}>
            {SHORTCUTS.map((s) => (
              <div key={s.keys} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12.5px' }}>
                <span className="tag">{s.keys}</span>
                <span style={{ color: 'var(--fg-tertiary)' }}>{s.action}</span>
              </div>
            ))}
            <div style={{ gridColumn: '1 / -1', marginTop: '4px', fontSize: '12px', color: 'var(--fg-tertiary)' }}>
              修饰键 MOD 默认为左 Alt 或左 Super，可在 scrcpy 启动参数中改。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
