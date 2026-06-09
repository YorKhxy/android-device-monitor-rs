import { useMemo } from 'react';
import type { NetworkRequest } from '../../shared/types';
import { Badge, type BadgeTone } from './ui';

type NetworkPanelProps = {
  packageFilter: string;
  onPackageFilterChange: (value: string) => void;
  networkRequests: NetworkRequest[];
  selectedNetworkRequestId: string | null;
  onSelectNetworkRequest: (requestId: string) => void;
  onCaptureRequests: () => void;
};

const getNetworkStatusColor = (statusCode: number) => {
  if (statusCode >= 500) return 'var(--danger)';
  if (statusCode >= 400) return 'var(--warning)';
  if (statusCode >= 300) return 'var(--info)';
  if (statusCode >= 200) return 'var(--success)';
  return 'var(--fg-tertiary)';
};

const getNetworkStatusTone = (statusCode: number): BadgeTone => {
  if (statusCode >= 500) return 'danger';
  if (statusCode >= 400) return 'warning';
  if (statusCode >= 300) return 'info';
  if (statusCode >= 200) return 'success';
  return 'neutral';
};

const formatNetworkDuration = (duration: number) => {
  if (!duration) return '--';
  if (duration < 1000) return `${duration} ms`;
  return `${(duration / 1000).toFixed(2)} s`;
};

const cellHeadStyle: React.CSSProperties = {
  padding: '10px 12px',
  textAlign: 'left',
  color: 'var(--fg-tertiary)',
  fontSize: '12px',
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

const renderHeaderMap = (headers?: Record<string, string>) => {
  if (!headers || Object.keys(headers).length === 0) {
    return <div style={{ color: 'var(--fg-tertiary)' }}>--</div>;
  }

  return Object.entries(headers).map(([key, value]) => (
    <div
      key={key}
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 1fr',
        gap: '8px',
        padding: '4px 0',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{key}</div>
      <div style={{ color: 'var(--fg-primary)', fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  ));
};

export function NetworkPanel({
  packageFilter,
  onPackageFilterChange,
  networkRequests,
  selectedNetworkRequestId,
  onSelectNetworkRequest,
  onCaptureRequests,
}: NetworkPanelProps) {
  const selectedNetworkRequest = useMemo(
    () => networkRequests.find((request) => request.id === selectedNetworkRequestId) || networkRequests[0] || null,
    [networkRequests, selectedNetworkRequestId]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <label className="field" style={{ flex: 1 }}>
          <input
            type="text"
            placeholder="包名备注，可选"
            value={packageFilter}
            onChange={(event) => onPackageFilterChange(event.target.value)}
          />
        </label>
        <button className="btn primary" onClick={onCaptureRequests}>
          {'抓取 HTTP'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(480px, 1.25fr) minmax(320px, 0.95fr)', gap: '12px', minHeight: '420px' }}>
        <div className="subpanel scroll" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: 'var(--bg-elevated)' }}>
              <tr>
                <th style={cellHeadStyle}>{'方法'}</th>
                <th style={cellHeadStyle}>{'URL'}</th>
                <th style={cellHeadStyle}>{'状态'}</th>
                <th style={cellHeadStyle}>{'耗时'}</th>
                <th style={cellHeadStyle}>{'时间'}</th>
              </tr>
            </thead>
            <tbody>
              {networkRequests.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: '32px', textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                    {'暂无网络请求数据'}
                  </td>
                </tr>
              ) : (
                networkRequests.map((request) => (
                  <tr
                    key={request.id}
                    onClick={() => onSelectNetworkRequest(request.id)}
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      cursor: 'pointer',
                      background: selectedNetworkRequest?.id === request.id ? 'var(--bg-active)' : 'transparent',
                    }}
                  >
                    <td style={{ padding: '10px 12px', color: 'var(--info)', fontWeight: 600, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                      {request.method}
                    </td>
                    <td
                      style={{
                        padding: '10px 12px',
                        color: 'var(--fg-primary)',
                        fontFamily: 'var(--font-mono)',
                        maxWidth: '0',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      data-tip={request.url}
                    >
                      {request.url}
                    </td>
                    <td style={{ padding: '10px 12px', color: getNetworkStatusColor(request.statusCode), fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                      {request.statusCode ? `${request.statusCode}${request.statusText ? ` ${request.statusText}` : ''}` : '--'}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                      {formatNetworkDuration(request.duration)}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--fg-tertiary)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                      {new Date(request.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="subpanel scroll" style={{ padding: '14px', overflow: 'auto' }}>
          {selectedNetworkRequest ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--fg-primary)' }}>
                    {selectedNetworkRequest.method} {selectedNetworkRequest.path || selectedNetworkRequest.url}
                  </div>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--fg-secondary)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                  {selectedNetworkRequest.url}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '10px' }}>
                  <div className="seclabel" style={{ margin: '0 0 4px' }}>{'状态'}</div>
                  {selectedNetworkRequest.statusCode ? (
                    <Badge tone={getNetworkStatusTone(selectedNetworkRequest.statusCode)}>
                      {`${selectedNetworkRequest.statusCode}${selectedNetworkRequest.statusText ? ` ${selectedNetworkRequest.statusText}` : ''}`}
                    </Badge>
                  ) : (
                    <div style={{ color: 'var(--fg-tertiary)' }}>--</div>
                  )}
                </div>
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '10px' }}>
                  <div className="seclabel" style={{ margin: '0 0 4px' }}>{'耗时'}</div>
                  <div style={{ color: 'var(--fg-primary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    {formatNetworkDuration(selectedNetworkRequest.duration)}
                  </div>
                </div>
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '10px' }}>
                  <div className="seclabel" style={{ margin: '0 0 4px' }}>{'主机'}</div>
                  <div style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                    {selectedNetworkRequest.host || selectedNetworkRequest.headers.Host || '--'}
                  </div>
                </div>
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '10px' }}>
                  <div className="seclabel" style={{ margin: '0 0 4px' }}>{'时间'}</div>
                  <div style={{ color: 'var(--fg-primary)', fontFamily: 'var(--font-mono)' }}>
                    {new Date(selectedNetworkRequest.timestamp).toLocaleString('zh-CN', { hour12: false })}
                  </div>
                </div>
              </div>

              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{'状态码和耗时基于短时 tcpdump 文本推断，用于快速排查。'}</div>

              <div>
                <div className="seclabel">{'请求头'}</div>
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '10px' }}>
                  {renderHeaderMap(selectedNetworkRequest.headers)}
                </div>
              </div>
              <div>
                <div className="seclabel">{'响应头'}</div>
                <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)', padding: '10px' }}>
                  {renderHeaderMap(selectedNetworkRequest.responseHeaders)}
                </div>
              </div>
              <div>
                <div className="seclabel">{'请求体'}</div>
                <div
                  style={{
                    background: 'var(--bg-panel)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--r-sm)',
                    padding: '10px',
                    color: 'var(--fg-primary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    minHeight: '72px',
                  }}
                >
                  {selectedNetworkRequest.requestBody || '--'}
                </div>
              </div>
              <div>
                <div className="seclabel">{'响应体'}</div>
                <div
                  style={{
                    background: 'var(--bg-panel)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--r-sm)',
                    padding: '10px',
                    color: 'var(--fg-primary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    minHeight: '72px',
                  }}
                >
                  {selectedNetworkRequest.responseBody || '--'}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--fg-tertiary)' }}>
              {'选中一条请求查看详情'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
