import { useState } from 'react';
import type { PerformanceCaptureSession } from '../../shared/types';
import { formatDuration, formatLocalDateTime } from './perfFormat';
import { Icon } from './ui';

type CaptureHistoryListProps = {
  sessions: PerformanceCaptureSession[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
};

const defaultTitle = (session: PerformanceCaptureSession) =>
  `${session.deviceSn} · ${formatLocalDateTime(session.startedAt)}`;

export function CaptureHistoryList({ sessions, selectedSessionId, onSelect, onRename, onDelete, onExport }: CaptureHistoryListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const beginEdit = (session: PerformanceCaptureSession) => {
    setEditingId(session.id);
    setEditValue(session.title || defaultTitle(session));
  };

  const commitEdit = (id: string) => {
    onRename(id, editValue);
    setEditingId(null);
  };

  if (sessions.length === 0) {
    return (
      <div style={{ color: 'var(--fg-tertiary)', fontSize: '13px', padding: '18px', textAlign: 'center', border: '1px dashed var(--border-default)', borderRadius: 'var(--r-md)' }}>
        还没有采集记录。点上方「开始采集」录一段，关闭后会归档到这里，随时回看。
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {sessions.map((session) => {
        const selected = session.id === selectedSessionId;
        const isEditing = session.id === editingId;
        const confirming = session.id === confirmingDeleteId;
        return (
          <div
            key={session.id}
            onClick={() => !isEditing && onSelect(session.id)}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              padding: '10px 12px',
              borderRadius: 'var(--r-md)',
              border: `1px solid ${selected ? 'var(--border-selected)' : 'var(--border-subtle)'}`,
              backgroundColor: selected ? 'var(--accent-soft)' : 'var(--bg-elevated)',
              cursor: 'pointer',
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              {isEditing ? (
                <input
                  autoFocus
                  value={editValue}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => commitEdit(session.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit(session.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  style={{ width: '100%', backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-selected)', borderRadius: 'var(--r-sm)', color: 'var(--fg-primary)', padding: '4px 8px', fontSize: '13px' }}
                />
              ) : (
                <div
                  onDoubleClick={(e) => { e.stopPropagation(); beginEdit(session); }}
                  data-tip="双击改名"
                  style={{ color: 'var(--fg-primary)', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {session.title || defaultTitle(session)}
                </div>
              )}
              <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px', marginTop: '3px' }}>
                {`${session.deviceSn} · ${formatLocalDateTime(session.startedAt)} · ${formatDuration(session.durationMs)}`}
                {session.status === 'failed' && <span style={{ color: 'var(--danger)', marginLeft: '8px' }}>失败</span>}
              </div>
            </div>

            {confirming ? (
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => { onDelete(session.id); setConfirmingDeleteId(null); }}
                  className="btn sm"
                  style={{ border: 'none', backgroundColor: 'var(--danger)', color: '#fff' }}
                >确认删除</button>
                <button
                  onClick={() => setConfirmingDeleteId(null)}
                  className="btn secondary sm"
                >取消</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => onExport(session.id)}
                  data-tip="导出为 zip（可拷到另一台 PC 导入查看）"
                  className="btn ghost sm"
                ><Icon name="download" />导出</button>
                <button
                  onClick={() => setConfirmingDeleteId(session.id)}
                  data-tip="删除该采集记录"
                  className="btn ghost sm"
                ><Icon name="trash-2" />删除</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
