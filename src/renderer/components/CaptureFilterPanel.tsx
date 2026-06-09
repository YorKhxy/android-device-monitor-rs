import type { CSSProperties } from 'react';
import {
  METRIC_COLORS,
  METRIC_LABELS,
  type CaptureFilterOp,
  type CaptureMetricKey,
  type FilterCondition,
} from './perfFormat';

type CaptureFilterPanelProps = {
  conditions: FilterCondition[];
  onChange: (conditions: FilterCondition[]) => void;
  onApply: () => void;
  onClear: () => void;
  /** 非 Pico 设备无 GPU 指标，隐藏该选项。 */
  isPico: boolean;
  /** 已应用过滤时命中的时间点数量。 */
  hitCount: number;
  /** 是否已应用过滤（控制命中提示与「清除」可用）。 */
  applied: boolean;
};

const OPS: CaptureFilterOp[] = ['>', '=', '<'];

const selectStyle: CSSProperties = {
  backgroundColor: 'var(--bg-input)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r-sm)',
  color: 'var(--fg-primary)',
  height: '34px',
  padding: '0 8px',
  fontSize: '12px',
};

// 自绘阈值步进按钮（▲/▼）：贴合工具暗色主题，替代原生 number 上下箭头。
const stepButtonStyle: CSSProperties = {
  border: 'none',
  backgroundColor: 'var(--bg-input)',
  color: 'var(--fg-tertiary)',
  cursor: 'pointer',
  width: '20px',
  height: '17px',
  fontSize: '8px',
  lineHeight: '17px',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const makeConditionId = () => `c-${Math.round(performance.now() * 1000)}-${Math.floor(Math.random() * 1e6)}`;

export function CaptureFilterPanel({ conditions, onChange, onApply, onClear, isPico, hitCount, applied }: CaptureFilterPanelProps) {
  const metricKeys: CaptureMetricKey[] = isPico ? ['fps', 'cpu', 'mem', 'gpu'] : ['fps', 'cpu', 'mem'];

  const updateCondition = (id: string, patch: Partial<FilterCondition>) =>
    onChange(conditions.map((condition) => (condition.id === id ? { ...condition, ...patch } : condition)));

  const removeCondition = (id: string) => onChange(conditions.filter((condition) => condition.id !== id));

  // 新条件阈值留空（NaN）而非 0：避免受控 number 输入里那个删不掉、老挡在前面的默认 0。
  const addCondition = () =>
    onChange([...conditions, { id: makeConditionId(), metricKey: 'fps', op: '>', threshold: NaN }]);

  // 至少有一条「填了有效阈值」的条件才可过滤。
  const canApply = conditions.some((c) => Number.isFinite(c.threshold));

  return (
    <div style={{ backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
        <div style={{ color: 'var(--fg-primary)', fontSize: '13px', fontWeight: 600 }}>参数过滤</div>
        <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>每条独立标在对应指标曲线上（按颜色区分，跟随曲线显隐）</div>
      </div>

      {conditions.length === 0 ? (
        <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>添加条件后点「过滤」，在曲线上标出命中时间点。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {conditions.map((condition) => {
            const thresholdEmpty = !Number.isFinite(condition.threshold);
            return (
            <div key={condition.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* 色块：与该指标曲线及其命中标记同色，标识「这条过滤标在哪条曲线上」。 */}
              <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: METRIC_COLORS[condition.metricKey], flexShrink: 0 }} data-tip="该参数曲线颜色" />
              <select
                value={condition.metricKey}
                onChange={(e) => updateCondition(condition.id, { metricKey: e.target.value as CaptureMetricKey })}
                style={selectStyle}
                aria-label="指标"
              >
                {metricKeys.map((key) => (
                  <option key={key} value={key}>{METRIC_LABELS[key]}</option>
                ))}
              </select>
              <select
                value={condition.op}
                onChange={(e) => updateCondition(condition.id, { op: e.target.value as CaptureFilterOp })}
                style={selectStyle}
                aria-label="运算符"
              >
                {OPS.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
              {/* 阈值输入 + 自绘 ▲▼ 步进（hxy0601 功能）：整体一个边框容器、输入透明无边、步进列只加分隔线，
                  颜色用设计系统 token（ui-fresh 口径）。隐藏原生上下箭头由 .adm-number 负责。 */}
              <div style={{ display: 'flex', alignItems: 'stretch', height: '34px', borderRadius: 'var(--r-sm)', overflow: 'hidden', border: `1px solid ${thresholdEmpty ? 'var(--danger)' : 'var(--border-default)'}`, backgroundColor: 'var(--bg-input)' }}>
                <input
                  type="number"
                  inputMode="decimal"
                  className="adm-number"
                  placeholder="阈值"
                  value={Number.isFinite(condition.threshold) ? condition.threshold : ''}
                  onChange={(e) => updateCondition(condition.id, { threshold: e.target.value === '' ? NaN : Number(e.target.value) })}
                  style={{ width: '62px', backgroundColor: 'transparent', border: 'none', outline: 'none', color: 'var(--fg-primary)', padding: '0 8px', fontSize: '12px' }}
                  aria-label="阈值"
                />
                <div style={{ display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${thresholdEmpty ? 'var(--danger)' : 'var(--border-default)'}` }}>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="增大阈值"
                    onClick={() => updateCondition(condition.id, { threshold: (Number.isFinite(condition.threshold) ? condition.threshold : 0) + 1 })}
                    style={stepButtonStyle}
                  >▲</button>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="减小阈值"
                    onClick={() => updateCondition(condition.id, { threshold: Math.max(0, (Number.isFinite(condition.threshold) ? condition.threshold : 0) - 1) })}
                    style={{ ...stepButtonStyle, borderTop: '1px solid var(--border-default)' }}
                  >▼</button>
                </div>
              </div>
              {thresholdEmpty && <span style={{ color: 'var(--danger)', fontSize: '11px' }}>阈值不能为空</span>}
              <button
                type="button"
                onClick={() => removeCondition(condition.id)}
                className="btn ghost sm iconbtn"
                style={{ marginLeft: 'auto' }}
                aria-label="删除条件"
              >×</button>
            </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={addCondition}
          className="btn ghost sm"
          style={{ borderStyle: 'dashed', borderColor: 'var(--border-default)' }}
        >+ 添加条件</button>
        <button
          type="button"
          onClick={onApply}
          disabled={!canApply}
          className="btn primary sm"
        >过滤</button>
        <button
          type="button"
          onClick={onClear}
          disabled={!applied && conditions.length === 0}
          className="btn secondary sm"
        >清除</button>
        {applied && (
          <span style={{ color: hitCount > 0 ? 'var(--gold)' : 'var(--fg-tertiary)', fontSize: '12px' }}>
            {hitCount > 0 ? `命中 ${hitCount} 处（点标记跳转）` : '无命中'}
          </span>
        )}
      </div>
    </div>
  );
}
