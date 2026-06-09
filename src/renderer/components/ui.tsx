/* 安卓设备监控 — 共享 UI 基元（对齐 Design System ui_kit）。
   依赖 styles/design-tokens.css + styles/components.css 的类与变量。 */
import React from 'react';
import * as Lucide from 'lucide-react';

type IconComponent = React.ComponentType<{ size?: number | string }>;

const toPascalCase = (name: string): string =>
  name
    .split(/[-_ ]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

/** Lucide 图标：传 kebab 名（如 'monitor-smartphone'），动态映射到 lucide-react 组件。 */
export function Icon({
  name,
  size = 16,
  color,
  className = '',
  style = {},
}: {
  name: string;
  size?: number;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const Cmp = (Lucide as unknown as Record<string, IconComponent>)[toPascalCase(name)];
  return (
    <span className={'icon ' + className} style={{ width: size, height: size, color, ...style }}>
      {Cmp ? <Cmp size={size} /> : null}
    </span>
  );
}

type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'outline'
  | 'o-green'
  | 'o-amber'
  | 'o-red'
  | 'o-blue';

export function Button({
  variant = 'secondary',
  size,
  icon,
  children,
  className = '',
  ...rest
}: {
  variant?: ButtonVariant;
  size?: 'sm';
  icon?: string;
  children?: React.ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ['btn', variant, size === 'sm' ? 'sm' : '', !children ? 'iconbtn' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export type BadgeTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export function Badge({
  tone = 'neutral',
  icon,
  dot,
  children,
}: {
  tone?: BadgeTone;
  icon?: string;
  dot?: boolean;
  children?: React.ReactNode;
}) {
  const map: Record<BadgeTone, { bg: string; fg: string }> = {
    success: { bg: 'var(--success-soft)', fg: 'var(--success)' },
    info: { bg: 'var(--info-soft)', fg: 'var(--info)' },
    warning: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
    danger: { bg: 'var(--danger-soft)', fg: 'var(--danger)' },
    neutral: { bg: 'var(--bg-elevated)', fg: 'var(--fg-secondary)' },
  };
  const c = map[tone];
  return (
    <span className="badge" style={{ background: c.bg, color: c.fg }}>
      {dot && <span className="dot" style={{ background: c.fg }} />}
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

export const Tag = ({ children }: { children?: React.ReactNode }) => <span className="tag">{children}</span>;

export function Empty({
  icon,
  title,
  sub,
  children,
}: {
  icon: string;
  title: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={40} />
      <div className="et">{title}</div>
      {sub && <div className="es">{sub}</div>}
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: string }[];
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--r-sm)',
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 11px',
              border: 0,
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12.5,
              fontFamily: 'var(--font-sans)',
              fontWeight: active ? 600 : 500,
              background: active ? 'var(--bg-active)' : 'transparent',
              color: active ? 'var(--fg-primary)' : 'var(--fg-tertiary)',
            }}
          >
            {o.icon && <Icon name={o.icon} size={14} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** 应用图标占位：按包名取冷色调色块（绿/红保留给状态语义）。 */
const AV_COLORS = ['#5597DC', '#46C6C0', '#A78BFA', '#6E8BE8', '#8C7BE0', '#5BA8C4', '#7C89A8', '#C77DD6'];
export function AppAvatar({ name, size = 36 }: { name: string; size?: number }) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const col = AV_COLORS[h % AV_COLORS.length];
  const letter = (
    name.replace(/^[a-z0-9]+\.[a-z0-9]+\./i, '').replace(/[^a-zA-Z0-9]/g, '')[0] ||
    name.replace(/[^a-zA-Z0-9]/g, '')[0] ||
    '?'
  ).toUpperCase();
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: size * 0.28,
        background: col + '1F',
        border: '1px solid ' + col + '44',
        color: col,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: size * 0.42,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {letter}
    </span>
  );
}

/** 性能折线图（SVG）。 */
export function LineChart({
  data,
  color,
  height = 120,
  max,
  fill = true,
}: {
  data: number[];
  color: string;
  height?: number;
  max?: number;
  fill?: boolean;
}) {
  const w = 600;
  const h = height;
  const pad = 6;
  const mx = max || Math.max(...data, 1);
  const step = (w - pad * 2) / Math.max(data.length - 1, 1);
  const pts = data.map((v, i) => [pad + i * step, h - pad - (v / mx) * (h - pad * 2)] as const);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L ${pad + (data.length - 1) * step} ${h - pad} L ${pad} ${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={pad} x2={w - pad} y1={h * g} y2={h * g} stroke="var(--chart-grid)" strokeWidth="1" />
      ))}
      {fill && <path d={area} fill={color} opacity="0.10" />}
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
