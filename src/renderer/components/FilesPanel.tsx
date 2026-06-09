import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DeviceInfo, DeviceFileEntry, TransferResumeBatch } from '@/shared/types';
import { hasElectronAPI } from '@/renderer/lib/electronApi';
import { getTransferState, subscribeTransfer, startUpload, startPullFiles, startResumeTransfer } from '@/renderer/lib/fileTransferManager';
import { Icon, Badge } from './ui';

interface FilesPanelProps {
  selectedDevice: DeviceInfo | null;
  onError: (message: string) => void;
}

const ROOT_PATH = '/sdcard';

// 常用目录快捷入口，覆盖照片/录像/下载/截图等绝大多数需求
const QUICK_LINKS: { label: string; path: string }[] = [
  { label: '内部存储', path: '/sdcard' },
  { label: '相机', path: '/sdcard/DCIM/Camera' },
  { label: '图片', path: '/sdcard/Pictures' },
  { label: '影片', path: '/sdcard/Movies' },
  { label: '下载', path: '/sdcard/Download' },
];

const formatSize = (bytes: number): string => {
  if (bytes <= 0) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const buildBreadcrumbs = (path: string): { label: string; path: string }[] => {
  const parts = path.split('/').filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
};

const parentPath = (path: string): string => {
  if (path === '/' || path === '') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
};

export const FilesPanel: React.FC<FilesPanelProps> = ({ selectedDevice, onError }) => {
  const [currentPath, setCurrentPath] = useState<string>(ROOT_PATH);
  const [entries, setEntries] = useState<DeviceFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  // 批量删除：confirmBatchDelete 控制二次确认态，batchDeleting 防重复提交
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [notice, setNotice] = useState<string>('');
  // 内联提示的语气：success 绿色（操作成功），warn 琥珀色（目录不存在/访问受限等温和提醒）
  const [noticeKind, setNoticeKind] = useState<'success' | 'warn'>('success');
  // 最近一次下载到 PC 的本地路径，用于「打开所在文件夹」快捷按钮
  const [lastDownloadPath, setLastDownloadPath] = useState<string | null>(null);
  // 当前目录内的文件名搜索关键词（仅过滤当前已加载的列表，不重新请求设备）
  const [search, setSearch] = useState('');
  // 列表排序：点表头列切换；默认按名称升序（与主进程默认一致）。
  const [sortKey, setSortKey] = useState<'name' | 'size' | 'mtime'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  // 多选下载：选中的文件路径集合
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const uploadDirRef = useRef<string>(ROOT_PATH);
  // 上传/批量下载进度来自传输管理器（单例，不随本组件卸载消失）。订阅它，关界面再打开仍能显示回正在进行的进度。
  const [transfer, setTransfer] = useState(getTransferState());
  // 新建文件夹：creatingFolder 控制输入行显隐，newFolderName 为输入值，creatingFolderBusy 防重复提交
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolderBusy, setCreatingFolderBusy] = useState(false);
  // 进入该设备文件管理时，若上次有未传完的传输（崩溃/被杀残留），就地提示「继续/丢弃」。
  // 比启动时全局弹窗更合理：此刻设备必然已连上、且用户正处在传输语境里。
  const [resumeBatches, setResumeBatches] = useState<TransferResumeBatch[]>([]);
  const [resumeBusyBatchId, setResumeBusyBatchId] = useState<string | null>(null);

  const deviceId = selectedDevice?.id ?? null;
  // 仅显示属于当前设备的传输进度（管理器是全局单例，可能记着别的设备的传输）
  const upload = transfer.deviceId === deviceId ? transfer.upload : null;
  const uploadDir = transfer.deviceId === deviceId ? transfer.uploadDir : null;
  const pull = transfer.deviceId === deviceId ? transfer.pull : null;
  const pullDir = transfer.deviceId === deviceId ? transfer.pullDir : null;
  // 传输（上传 / 下载）进行中：禁止删除与再次下载，避免删掉/重复拉取正在传输的文件
  const transferBusy = Boolean(upload) || Boolean(pull);

  const loadDir = useCallback(
    async (path: string) => {
      if (!deviceId || !hasElectronAPI()) return;
      setLoading(true);
      setNotice('');
      // 切换目录后「打开所在文件夹」按钮指向的是旧的下载结果，已无意义，清掉避免挂在新提示上
      setLastDownloadPath(null);
      try {
        const result = await window.electronAPI!.listDeviceFiles(deviceId, path);
        if (result.success && result.data) {
          setEntries(result.data.entries);
          setCurrentPath(result.data.path);
          setSearch('');
          setSelectedPaths(new Set());
        } else {
          // 目录不存在 / 访问受限等：保留当前列表不动，仅给温和内联提示，不弹全局红色报错。
          // 例如 Pico 等 VR 设备没有 /sdcard/DCIM/Camera，点击「相机」快捷入口时不再惊扰用户。
          setNotice(result.error || '该目录不存在或无法访问');
          setNoticeKind('warn');
        }
      } catch (err) {
        setEntries([]);
        onError('列出设备文件失败：' + (err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [deviceId, onError]
  );

  // 切换设备时回到根目录并重新加载
  useEffect(() => {
    if (deviceId) {
      loadDir(ROOT_PATH);
    } else {
      setEntries([]);
      setCurrentPath(ROOT_PATH);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const handleEntryClick = (entry: DeviceFileEntry) => {
    if (entry.isDir || entry.isSymlink) {
      loadDir(entry.path);
    }
  };

  // 下载（单个或多个）走传输管理器：绿色进度条、点击进度条跳转、关界面不中断、重开续显进度。
  // 返回是否成功，供批量下载据此清空选择。
  const runDownload = async (items: { path: string; name: string }[]): Promise<boolean> => {
    if (!deviceId || !hasElectronAPI() || items.length === 0) return false;
    setNotice('');
    setLastDownloadPath(null);
    try {
      const result = await startPullFiles(deviceId, items, currentPath);
      if (result.success && result.data) {
        const { savedDir, succeeded, failed } = result.data;
        setNotice(`已下载 ${succeeded} 个到 ${savedDir}${failed > 0 ? `，${failed} 个失败` : ''}`);
        setNoticeKind('success');
        setLastDownloadPath(savedDir);
        return true;
      }
      if (result.error && result.error !== '取消下载') {
        onError(result.error);
      }
      return false;
    } catch (err) {
      onError('下载失败：' + (err as Error).message);
      return false;
    }
  };

  const downloadOne = (entry: DeviceFileEntry) => {
    runDownload([{ path: entry.path, name: entry.name }]);
  };

  // 删除采用行内二次确认：第一次点「删除」进入确认态，再点「确认删除」才真正删除。
  const doDelete = async (entry: DeviceFileEntry) => {
    if (!deviceId || !hasElectronAPI()) return;
    if (transferBusy) {
      onError('文件传输进行中，暂时不能删除');
      setConfirmDeletePath(null);
      return;
    }
    setConfirmDeletePath(null);
    setDeletingPath(entry.path);
    setNotice('');
    try {
      const result = await window.electronAPI!.deleteDeviceFile(deviceId, entry.path, entry.isDir);
      if (result.success) {
        setNotice(`已删除：${entry.name}`);
        setNoticeKind('success');
        loadDir(currentPath);
      } else {
        onError(result.error || '删除失败');
      }
    } catch (err) {
      onError('删除失败：' + (err as Error).message);
    } finally {
      setDeletingPath(null);
    }
  };

  const toggleSelect = (path: string) => {
    setConfirmBatchDelete(false); // 改动选择即取消待确认的批量删除
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // 批量下载选中的文件到 PC 同一个文件夹（与单文件下载共用 runDownload）
  const downloadSelected = async () => {
    if (!deviceId || !hasElectronAPI() || selectedPaths.size === 0) return;
    // 只下载文件，忽略目录（目录批量下载交互复杂，单独「下载」按钮已支持单个目录）
    const items = entries
      .filter((e) => selectedPaths.has(e.path) && !e.isDir)
      .map((e) => ({ path: e.path, name: e.name }));
    if (items.length === 0) {
      onError('选中项中没有可下载的文件（目录请用行内「下载」按钮）');
      return;
    }
    const ok = await runDownload(items);
    if (ok) setSelectedPaths(new Set());
  };

  // 批量删除选中项（文件与目录均可，目录递归删）。二次确认由 confirmBatchDelete 控制，
  // 这里只在确认后执行：逐项调 deleteDeviceFile，汇总成功/失败，删完刷新目录、清空选择。
  const deleteSelected = async () => {
    if (!deviceId || !hasElectronAPI() || selectedPaths.size === 0) return;
    setConfirmBatchDelete(false);
    if (transferBusy) {
      onError('文件传输进行中，暂时不能删除');
      return;
    }
    const targets = entries.filter((e) => selectedPaths.has(e.path));
    if (targets.length === 0) return;
    setBatchDeleting(true);
    setNotice('');
    let succeeded = 0;
    let failed = 0;
    try {
      for (const entry of targets) {
        try {
          const result = await window.electronAPI!.deleteDeviceFile(deviceId, entry.path, entry.isDir);
          if (result.success) succeeded++;
          else failed++;
        } catch {
          failed++;
        }
      }
      setNotice(`已删除 ${succeeded} 项${failed > 0 ? `，${failed} 项失败` : ''}`);
      setNoticeKind(failed > 0 ? 'warn' : 'success');
      setSelectedPaths(new Set());
      loadDir(currentPath);
    } finally {
      setBatchDeleting(false);
    }
  };

  // 始终用最新目录作为上传目标（拖拽/上传都进当前目录）
  useEffect(() => {
    uploadDirRef.current = currentPath;
  }, [currentPath]);

  // 订阅传输管理器：进度变化时刷新本组件展示（管理器常驻，关界面再打开仍能拿到正在进行的进度）
  useEffect(() => subscribeTransfer(() => setTransfer(getTransferState())), []);

  // 拉取当前设备的未完成传输批次（拉取式，无启动时序竞态）。仅保留属于本设备的。
  const refreshResumeBatches = useCallback(async () => {
    if (!deviceId || !hasElectronAPI() || !window.electronAPI) {
      setResumeBatches([]);
      return;
    }
    const result = await window.electronAPI.getResumeBatches();
    const list = result.success && result.data ? result.data : [];
    setResumeBatches(list.filter((b) => b.deviceId === deviceId));
  }, [deviceId]);

  // 进入/切换设备时拉取一次未完成传输
  useEffect(() => {
    void refreshResumeBatches();
  }, [refreshResumeBatches]);

  // 「继续」：恢复该批次，进度复用现有传输进度条；完成后刷新提示（批次清空则消失）。
  const handleResumeBatch = async (batch: TransferResumeBatch) => {
    setResumeBatches((prev) => prev.filter((b) => b.batchId !== batch.batchId));
    await startResumeTransfer(batch);
    await refreshResumeBatches();
    if (deviceId) loadDir(currentPath);
  };

  // 「丢弃」：清理残留 .part 并移出 journal，下次不再提示。
  const handleDiscardBatch = async (batch: TransferResumeBatch) => {
    if (!hasElectronAPI() || !window.electronAPI) return;
    setResumeBusyBatchId(batch.batchId);
    try {
      await window.electronAPI.discardTransfers(batch.batchId);
    } finally {
      setResumeBusyBatchId(null);
      setResumeBatches((prev) => prev.filter((b) => b.batchId !== batch.batchId));
    }
  };

  const uploadFiles = async (localPaths: string[]) => {
    if (!deviceId || !hasElectronAPI() || localPaths.length === 0) return;
    const targetDir = uploadDirRef.current;
    setNotice('');
    try {
      const result = await startUpload(deviceId, targetDir, localPaths);
      if (result.success) {
        setNotice(`已上传 ${result.data} 个文件到 ${targetDir}`);
        setNoticeKind('success');
        loadDir(targetDir);
      } else if (result.error && result.error !== '取消选择') {
        onError(result.error);
      }
    } catch (err) {
      onError('上传失败：' + (err as Error).message);
    }
  };

  const handleUploadClick = async () => {
    if (!hasElectronAPI()) return;
    const result = await window.electronAPI!.selectUploadFiles();
    if (result.success && result.data && result.data.length > 0) {
      uploadFiles(result.data);
    }
  };

  // 在当前目录新建文件夹
  const handleCreateFolder = async () => {
    if (!deviceId || !hasElectronAPI()) return;
    const name = newFolderName.trim();
    if (!name) {
      onError('请输入文件夹名称');
      return;
    }
    if (/[\/\\]/.test(name)) {
      onError('文件夹名称不能包含 / 或 \\');
      return;
    }
    setCreatingFolderBusy(true);
    setNotice('');
    try {
      const result = await window.electronAPI!.createDeviceFolder(deviceId, currentPath, name);
      if (result.success) {
        setNotice(`已创建文件夹：${name}`);
        setNoticeKind('success');
        setCreatingFolder(false);
        setNewFolderName('');
        loadDir(currentPath);
      } else {
        onError(result.error || '创建文件夹失败');
      }
    } catch (err) {
      onError('创建文件夹失败：' + (err as Error).message);
    } finally {
      setCreatingFolderBusy(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // Electron 渲染层 File 对象带 .path 绝对路径
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      uploadFiles(paths);
    } else {
      onError('无法获取拖入文件的路径，请改用「上传文件」按钮');
    }
  };

  if (!selectedDevice) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, width: '100%' }}>
        <div className="empty">
          <Icon name="folder" size={40} color="var(--gold)" />
          <div className="et">未选择设备</div>
          <div className="es">请选择一个设备后再浏览文件</div>
        </div>
      </div>
    );
  }

  const crumbs = buildBreadcrumbs(currentPath);
  const canGoUp = currentPath !== '/';
  const keyword = search.trim().toLowerCase();
  const visibleEntries = keyword
    ? entries.filter((entry) => entry.name.toLowerCase().includes(keyword))
    : entries;
  // 目录恒在前（文件管理器惯例），组内按所选列排序。mtime 为 YYYY-MM-DD HH:MM，字典序即时间序。
  const sortedEntries = [...visibleEntries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    if (sortKey === 'size') cmp = a.size - b.size;
    else if (sortKey === 'mtime') cmp = a.mtime.localeCompare(b.mtime);
    else cmp = a.name.localeCompare(b.name, 'zh');
    return sortDir === 'asc' ? cmp : -cmp;
  });
  const toggleSort = (key: 'name' | 'size' | 'mtime') => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'mtime' ? 'desc' : 'asc'); // 时间默认最新在前
    }
  };
  const sortArrow = (key: 'name' | 'size' | 'mtime') => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');

  return (
    <div
      style={{ padding: '16px', color: 'var(--fg-primary)', position: 'relative', display: 'flex', flexDirection: 'column', maxHeight: '100%', minHeight: 0, boxSizing: 'border-box', width: '100%' }}
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div style={{ position: 'absolute', inset: '8px', border: '2px dashed var(--accent)', borderRadius: 'var(--r-md)', backgroundColor: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
          <span style={{ fontSize: '16px', color: 'var(--accent)', fontWeight: 600 }}>松开即上传到 {currentPath}</span>
        </div>
      )}
      {/* 快捷入口 */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {QUICK_LINKS.map((link) => (
          <button
            key={link.path}
            onClick={() => loadDir(link.path)}
            className={'btn sm ' + (currentPath === link.path ? 'primary' : 'secondary')}
          >
            {link.label}
          </button>
        ))}
      </div>

      {/* 路径面包屑 + 上一级 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <button
          onClick={() => loadDir(parentPath(currentPath))}
          disabled={!canGoUp || loading}
          className="btn sm secondary"
        >
          <Icon name="corner-left-up" size={14} />
          上一级
        </button>
        <button
          onClick={() => loadDir(currentPath)}
          disabled={loading}
          data-tip="重新加载当前目录"
          className="btn sm secondary"
        >
          <Icon name="refresh-cw" size={14} />
          {loading ? '刷新中…' : '刷新'}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', fontSize: '12.5px', fontFamily: 'var(--font-mono)', marginLeft: '2px' }}>
          <Icon name="smartphone" size={14} color="var(--fg-tertiary)" />
          {crumbs.map((crumb, idx) => (
            <React.Fragment key={crumb.path}>
              {idx > 0 && <Icon name="chevron-right" size={13} color="var(--fg-disabled)" />}
              <button
                onClick={() => loadDir(crumb.path)}
                style={{ background: 'none', border: 'none', color: idx === crumbs.length - 1 ? 'var(--fg-primary)' : 'var(--fg-tertiary)', cursor: 'pointer', fontSize: '12.5px', fontFamily: 'var(--font-mono)', padding: '2px 2px' }}
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
        </div>
        <button
          onClick={() => { setCreatingFolder((v) => !v); setNewFolderName(''); }}
          className={'btn sm ' + (creatingFolder ? 'primary' : 'secondary')}
          style={{ marginLeft: 'auto' }}
        >
          <Icon name="folder-plus" size={14} color={creatingFolder ? undefined : 'var(--gold)'} />
          新建文件夹
        </button>
        <button
          onClick={handleUploadClick}
          disabled={Boolean(upload)}
          className="btn sm primary"
        >
          <Icon name="upload" size={14} />
          上传文件
        </button>
      </div>

      {/* 新建文件夹输入行 */}
      {creatingFolder && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
          <label className="field" style={{ flex: 1, minWidth: 0 }}>
            <Icon name="folder-plus" size={15} color="var(--gold)" />
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder();
                else if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName(''); }
              }}
              placeholder={`在 ${currentPath} 下新建文件夹的名称`}
            />
          </label>
          <button
            onClick={handleCreateFolder}
            disabled={creatingFolderBusy}
            className="btn sm outline o-green"
            style={{ flexShrink: 0 }}
          >{creatingFolderBusy ? '创建中…' : '创建'}</button>
          <button
            onClick={() => { setCreatingFolder(false); setNewFolderName(''); }}
            className="btn sm secondary"
            style={{ flexShrink: 0 }}
          >取消</button>
        </div>
      )}

      {/* 未完成传输恢复提示：进入该设备文件管理时若有上次没传完的批次，就地提示继续/丢弃。
          上传/下载用方向徽标（箭头+配色+文案）明显区分：上传=蓝色↑，下载=青色↓。 */}
      {resumeBatches.map((batch) => {
        const busy = resumeBusyBatchId === batch.batchId;
        const isUpload = batch.direction === 'upload';
        const accent = isUpload ? 'var(--accent)' : 'var(--info)'; // 上传蓝 / 下载青
        return (
          <div key={batch.batchId} className="subpanel" style={{ marginBottom: '12px', padding: '10px 12px', borderLeft: `4px solid ${accent}`, display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                <Badge tone={isUpload ? 'info' : 'success'} icon={isUpload ? 'upload' : 'download'}>
                  {isUpload ? '上传到设备' : '从设备下载'}
                </Badge>
                <span style={{ fontSize: '13px', color: 'var(--warning)', fontWeight: 600 }}>
                  上次有 {batch.remaining} 个文件没传完
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {batch.sampleNames.join('、')}{batch.remaining > batch.sampleNames.length ? ' …' : ''}
              </div>
            </div>
            <button
              onClick={() => handleDiscardBatch(batch)}
              disabled={busy}
              className="btn sm secondary"
              style={{ flexShrink: 0 }}
            >丢弃</button>
            <button
              onClick={() => handleResumeBatch(batch)}
              disabled={busy || transferBusy}
              data-tip={transferBusy ? '有传输进行中，稍候再继续' : ''}
              className="btn sm primary"
              style={{ flexShrink: 0 }}
            >继续</button>
          </div>
        );
      })}

      {/* 上传进度条 */}
      {upload && (
        <div
          onClick={() => { if (uploadDir) loadDir(uploadDir); }}
          data-tip={uploadDir ? `点击前往：${uploadDir}` : undefined}
          className="subpanel"
          style={{ marginBottom: '12px', padding: '10px 12px', cursor: uploadDir ? 'pointer' : 'default' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--fg-secondary)', marginBottom: '6px' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
              {upload.status === 'error' ? '上传失败：' : '上传中：'}{upload.fileName || '准备中…'}
              {upload.total > 1 && ` (${upload.index + 1}/${upload.total})`}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{upload.percent}%</span>
          </div>
          {uploadDir && (
            <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)', marginBottom: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }} data-tip={uploadDir}>
              上传到：{uploadDir}　<span style={{ color: 'var(--accent)' }}>（点击前往）</span>
            </div>
          )}
          <div style={{ height: '6px', backgroundColor: 'var(--bg-active)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${upload.percent}%`, backgroundColor: upload.status === 'error' ? 'var(--danger)' : 'var(--accent)', transition: 'width 240ms ease' }} />
          </div>
        </div>
      )}

      {notice && (
        <div style={{ marginBottom: '12px', padding: '8px 12px', backgroundColor: noticeKind === 'warn' ? 'var(--warning-soft)' : 'var(--success-soft)', color: noticeKind === 'warn' ? 'var(--warning)' : 'var(--success)', borderRadius: 'var(--r-sm)', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ wordBreak: 'break-all' }}>{notice}</span>
          {lastDownloadPath && (
            <button
              onClick={async () => {
                if (!hasElectronAPI()) return;
                // 直接打开下载保存的目录（lastDownloadPath 为保存文件夹）；
                // 若 preload 较旧没有 openPath，则回退到 showItemInFolder，避免报错。
                const api = window.electronAPI!;
                const result = api.openPath
                  ? await api.openPath(lastDownloadPath)
                  : await api.showItemInFolder(lastDownloadPath);
                if (!result.success && result.error) onError(result.error);
              }}
              className="btn sm outline o-green"
              style={{ flexShrink: 0 }}
            >
              <Icon name="folder-open" size={14} />
              打开下载目录</button>
          )}
        </div>
      )}

      {/* 文件名搜索 */}
      <label className="field" style={{ marginBottom: '12px' }}>
        <Icon name="search" size={15} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={'搜索当前目录文件名…'}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            style={{ flexShrink: 0, background: 'none', border: 'none', color: 'var(--fg-tertiary)', cursor: 'pointer', fontSize: '14px', lineHeight: 1, display: 'flex', alignItems: 'center' }}
          >
            <Icon name="x" size={15} />
          </button>
        )}
      </label>

      {/* 批量操作栏：选中文件后出现，支持批量下载与批量删除（删除带二次确认） */}
      {selectedPaths.size > 0 && (
        <div className="subpanel" style={{ marginBottom: '12px', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ fontSize: '13px', color: 'var(--fg-secondary)' }}>已选中 {selectedPaths.size} 个文件</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => { setConfirmBatchDelete(false); setSelectedPaths(new Set()); }}
              disabled={Boolean(pull) || batchDeleting}
              className="btn sm secondary"
            >清空</button>
            <button
              onClick={downloadSelected}
              disabled={Boolean(pull) || batchDeleting}
              className="btn sm outline o-green"
              style={{ whiteSpace: 'nowrap' }}
            >
              <Icon name="download" size={14} />
              下载选中 ({selectedPaths.size})</button>
            {confirmBatchDelete ? (
              <>
                <button
                  onClick={deleteSelected}
                  disabled={transferBusy || batchDeleting}
                  data-tip={transferBusy ? '文件传输进行中，暂时不能删除' : undefined}
                  className="btn sm primary"
                  style={{ whiteSpace: 'nowrap', backgroundColor: 'var(--danger)', borderColor: 'var(--danger)' }}
                >{batchDeleting ? '删除中…' : `确认删除 ${selectedPaths.size} 项`}</button>
                <button
                  onClick={() => setConfirmBatchDelete(false)}
                  disabled={batchDeleting}
                  className="btn sm secondary"
                >取消</button>
              </>
            ) : (
              <button
                onClick={() => setConfirmBatchDelete(true)}
                disabled={transferBusy || batchDeleting}
                data-tip={transferBusy ? '文件传输进行中，暂时不能删除' : undefined}
                className="btn sm outline o-red"
                style={{ whiteSpace: 'nowrap' }}
              >
                <Icon name="trash-2" size={14} />
                删除选中 ({selectedPaths.size})</button>
            )}
          </div>
        </div>
      )}

      {/* 下载进度条（单文件 / 批量共用）。绿色，区别于上传的蓝色；点击跳到正在下载文件的设备目录 */}
      {pull && (
        <div
          onClick={() => { if (pullDir) loadDir(pullDir); }}
          data-tip={pullDir ? `点击前往：${pullDir}` : undefined}
          className="subpanel"
          style={{ marginBottom: '12px', padding: '10px 12px', cursor: pullDir ? 'pointer' : 'default' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--fg-secondary)', marginBottom: '6px' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
              {pull.status === 'error' ? '下载失败：' : '下载中：'}{pull.fileName || '准备中…'} ({pull.index + 1}/{pull.total})
            </span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{Math.round(((pull.index + (pull.status === 'done' ? 1 : 0)) / pull.total) * 100)}%</span>
          </div>
          {pullDir && (
            <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)', marginBottom: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }} data-tip={pullDir}>
              来自：{pullDir}　<span style={{ color: 'var(--success)' }}>（点击前往）</span>
            </div>
          )}
          <div style={{ height: '6px', backgroundColor: 'var(--bg-active)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round(((pull.index + (pull.status === 'done' ? 1 : 0)) / pull.total) * 100)}%`, backgroundColor: 'var(--success)', transition: 'width 240ms ease' }} />
          </div>
        </div>
      )}

      {/* 文件列表（内容超高时仅此区域滚动，上方工具区固定；内容少时按内容高度贴合） */}
      <div className="scroll" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', flex: '0 1 auto', minHeight: 0 }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'grid', gridTemplateColumns: '32px 1fr 80px 115px 200px', backgroundColor: 'var(--bg-elevated)', color: 'var(--fg-tertiary)', fontSize: '12px', fontWeight: 700, padding: '8px 12px', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)' }}>
          <input
            type="checkbox"
            data-tip="全选/取消当前列表中的文件"
            checked={visibleEntries.filter((e) => !e.isDir).length > 0 && visibleEntries.filter((e) => !e.isDir).every((e) => selectedPaths.has(e.path))}
            onChange={(e) => {
              const fileEntries = visibleEntries.filter((en) => !en.isDir);
              setSelectedPaths((prev) => {
                const next = new Set(prev);
                if (e.target.checked) fileEntries.forEach((en) => next.add(en.path));
                else fileEntries.forEach((en) => next.delete(en.path));
                return next;
              });
            }}
          />
          <span onClick={() => toggleSort('name')} data-tip="点击按名称排序（再点切换升/降序）" style={{ cursor: 'pointer', userSelect: 'none', color: sortKey === 'name' ? 'var(--fg-secondary)' : undefined }}>{'名称'}{sortArrow('name')}</span>
          <span onClick={() => toggleSort('size')} data-tip="点击按大小排序（再点切换升/降序）" style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none', color: sortKey === 'size' ? 'var(--fg-secondary)' : undefined }}>{'大小'}{sortArrow('size')}</span>
          <span onClick={() => toggleSort('mtime')} data-tip="点击按修改时间排序（再点切换升/降序）" style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none', color: sortKey === 'mtime' ? 'var(--fg-secondary)' : undefined }}>{'修改时间'}{sortArrow('mtime')}</span>
          <span style={{ textAlign: 'right' }}>{'操作'}</span>
        </div>

        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>加载中…</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>此目录为空</div>
        ) : visibleEntries.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>没有匹配「{search.trim()}」的文件</div>
        ) : (
          sortedEntries.map((entry) => {
            // 当前正在上传的就是这一项（同目录 + 同文件名）时，禁止下载，避免下到半成品
            const uploadingThisEntry = !!(upload && currentPath === uploadDir && upload.fileName === entry.name);
            // 当前正在下载的就是这一项时，标记「下载中…」
            const downloadingThisEntry = !!(pull && currentPath === pullDir && pull.fileName === entry.name);
            return (
            <div
              key={entry.path}
              className="app-row"
              style={{
                display: 'grid',
                gridTemplateColumns: '32px 1fr 80px 115px 200px',
                alignItems: 'center',
                padding: '8px 12px',
                borderTop: '1px solid var(--border-subtle)',
                fontSize: '13px',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center' }}>
                {!entry.isDir && (
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(entry.path)}
                    onChange={() => toggleSelect(entry.path)}
                  />
                )}
              </span>
              <span
                onClick={() => handleEntryClick(entry)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: entry.isDir || entry.isSymlink ? 'pointer' : 'default',
                  color: entry.isDir || entry.isSymlink ? 'var(--fg-primary)' : 'var(--fg-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                data-tip={entry.name}
              >
                <Icon
                  name={entry.isDir ? 'folder' : entry.isSymlink ? 'link' : 'file'}
                  size={16}
                  color={entry.isDir ? 'var(--gold)' : entry.isSymlink ? 'var(--info)' : 'var(--fg-secondary)'}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</span>
              </span>
              <span style={{ textAlign: 'right', color: 'var(--fg-tertiary)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{entry.isDir ? '--' : formatSize(entry.size)}</span>
              <span style={{ textAlign: 'right', color: 'var(--fg-tertiary)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{entry.mtime}</span>
              <span style={{ textAlign: 'right', display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => downloadOne(entry)}
                  disabled={transferBusy}
                  data-tip={uploadingThisEntry ? '该文件正在上传，暂不可下载' : transferBusy ? '传输进行中，暂不可下载' : undefined}
                  className="btn sm outline o-green"
                >
                  {downloadingThisEntry ? '下载中…' : uploadingThisEntry ? '上传中…' : '下载'}
                </button>
                {confirmDeletePath === entry.path ? (
                  <>
                    <button
                      onClick={() => doDelete(entry)}
                      disabled={transferBusy}
                      className="btn sm primary"
                      style={{ backgroundColor: 'var(--danger)', borderColor: 'var(--danger)' }}
                    >确认删除</button>
                    <button
                      onClick={() => setConfirmDeletePath(null)}
                      className="btn sm secondary"
                    >取消</button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeletePath(entry.path)}
                    disabled={deletingPath === entry.path || transferBusy}
                    data-tip={transferBusy ? '文件传输进行中，暂时不能删除' : undefined}
                    className="btn sm outline o-red"
                  >{deletingPath === entry.path ? '删除中…' : '删除'}</button>
                )}
              </span>
            </div>
            );
          })
        )}
      </div>

      <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--fg-tertiary)', flexShrink: 0 }}>
        提示：照片/录像/下载等公共存储免 root 可访问；应用私有数据（/data/data）需要 root，访问受限时会提示。
      </div>
    </div>
  );
};
