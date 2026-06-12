import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import type { PerformanceCaptureSession } from '../../shared/types';
import { POPOUT_EVENTS, type PopoutInit, type PopoutSeek, type PopoutSetPlaying, type PopoutSetAudio } from '../lib/capturePopout';
import { buildSegmentMediaUrl, formatClock, shouldCropCaptureVideo } from './perfFormat';
import { Icon } from './ui';

// 采集回放「视频独立窗口」（方案二，第二步：双向同步）。
// 弹出窗是「播放主钟」：timeupdate 把绝对播放头广播给主窗（驱动图表游标）；接收主窗的 seek 跳转。
// 关闭 = 关窗（主窗据 closed 事件恢复内嵌——第三步接）。
export default function CapturePopout() {
  const [session, setSession] = useState<PerformanceCaptureSession | null>(null);
  const [pulling, setPulling] = useState(true);
  const [segIndex, setSegIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  // 声音开关 + 音量：与主窗双向同步（含音会话才显示控件）。开窗时从交接箱带入主窗当前状态。
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekOffsetRef = useRef<number | null>(null);
  const initMsRef = useRef<number | null>(null);
  // seek 上下文用 ref 持有最新值，供注册一次的事件回调读取。
  const ctxRef = useRef<{ seekTo: (ms: number) => void; pause: () => void; play: () => void; emitState: (playing: boolean, ms?: number) => void }>({ seekTo: () => {}, pause: () => {}, play: () => {}, emitState: () => {} });

  const segments = session?.videoSegments ?? [];
  const totalMs = session ? Math.max(1, session.durationMs || 0, segments.length ? segments[segments.length - 1].endMs : 0) : 1;
  const shouldCrop = session ? shouldCropCaptureVideo(session) : false;
  const hasAudio = Boolean(session?.audioRecorded);
  const seg = segments[segIndex];
  const segmentUrl = session && seg ? buildSegmentMediaUrl(session.id, seg) : undefined;

  const findSegmentIndex = (ms: number) => {
    if (segments.length === 0) return 0;
    const hit = segments.findIndex((s) => ms >= s.startMs && ms < s.endMs);
    if (hit >= 0) return hit;
    return ms >= segments[segments.length - 1].endMs ? segments.length - 1 : 0;
  };

  const seekTo = (ms: number) => {
    if (!session) return;
    const clamped = Math.max(0, Math.min(totalMs, ms));
    setPlayheadMs(clamped);
    if (segments.length === 0) return;
    const idx = findSegmentIndex(clamped);
    const s = segments[idx];
    const offset = Math.max(0, (clamped - s.startMs) / 1000);
    if (idx === segIndex && videoRef.current) {
      videoRef.current.currentTime = offset;
    } else {
      pendingSeekOffsetRef.current = offset;
      setSegIndex(idx);
    }
  };

  const pause = () => {
    if (videoRef.current) videoRef.current.pause();
    setIsPlaying(false);
  };

  // 挂载即主动拉取交接箱数据（拉取式，不依赖主窗 emit）。带重试兜时序。
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const pull = async () => {
      try {
        const res = await invoke<{ success: boolean; data: PopoutInit | null }>('get_popout_session');
        if (cancelled) return;
        if (res?.data?.session) {
          setSession(res.data.session);
          initMsRef.current = res.data.playheadMs;
          if (typeof res.data.muted === 'boolean') setMuted(res.data.muted);
          if (typeof res.data.volume === 'number') setVolume(res.data.volume);
          setPulling(false);
          return;
        }
      } catch { /* 重试 */ }
      if (cancelled) return;
      if (tries++ < 10) window.setTimeout(pull, 300);
      else setPulling(false);
    };
    void pull();
    return () => { cancelled = true; };
  }, []);

  // 收到 init 后定位到主窗当时的播放头。
  useEffect(() => {
    if (session && initMsRef.current != null) {
      const ms = initMsRef.current;
      initMsRef.current = null;
      seekTo(ms);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // 主窗 → 弹出窗：seek 跳转 + setPlaying 播放控制（注册一次，走 ctxRef 取最新）。
  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [];
    unsubs.push(listen<PopoutSeek>(POPOUT_EVENTS.seek, (e) => {
      // 拖动即暂停 + 定格到该位置；随后主窗点播放会从此处续播。
      if (e.payload.pause) ctxRef.current.pause();
      ctxRef.current.seekTo(e.payload.ms);
      ctxRef.current.emitState(!e.payload.pause, e.payload.ms);
    }));
    unsubs.push(listen<PopoutSetPlaying>(POPOUT_EVENTS.setPlaying, (e) => {
      if (e.payload.playing) ctxRef.current.play();
      else { ctxRef.current.pause(); ctxRef.current.emitState(false); }
    }));
    // 主窗 → 弹出窗：设置静音/音量（两窗声音开关一致）。
    unsubs.push(listen<PopoutSetAudio>(POPOUT_EVENTS.setAudio, (e) => {
      setMuted(e.payload.muted);
      setVolume(e.payload.volume);
    }));
    return () => { unsubs.forEach((p) => void p.then((f) => f())); };
  }, []);

  // 把静音/音量同步到 video（切分段时 video 按 key 重建，需重设）。React 不把 muted 当受控属性。
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    v.volume = volume;
  }, [muted, volume, segIndex]);

  const handleLoadedMetadata = (video: HTMLVideoElement) => {
    video.muted = muted;
    video.volume = volume;
    if (pendingSeekOffsetRef.current != null) {
      video.currentTime = pendingSeekOffsetRef.current;
      pendingSeekOffsetRef.current = null;
    }
    if (isPlaying) void video.play().catch(() => undefined);
  };

  // 当前绝对播放头（ms）：优先按 video 实时位置，否则用 state。
  const currentMs = () => {
    const v = videoRef.current;
    const s = segments[segIndex];
    return v && s ? s.startMs + v.currentTime * 1000 : playheadMs;
  };
  // 向主窗广播「播放头 + 播放状态」（高频，不带声音状态——声音变化另走 broadcastAudio，避免覆盖主窗刚切的开关）。
  const emitState = (playing: boolean, ms = currentMs()) => {
    void emit(POPOUT_EVENTS.playhead, { ms, playing });
  };

  const handleTimeUpdate = (video: HTMLVideoElement) => {
    const s = segments[segIndex];
    if (!s) return;
    const ms = s.startMs + video.currentTime * 1000;
    setPlayheadMs(ms);
    // 按视频真实 paused 状态广播：timeupdate 在暂停/拖动定格时也会触发一次，
    // 若写死 true 会把主窗状态错误翻回「播放」，导致两窗不一致。
    emitState(!video.paused, ms);
  };

  const handleEnded = () => {
    const next = segIndex + 1;
    if (next < segments.length) {
      pendingSeekOffsetRef.current = 0;
      setPlayheadMs(segments[next].startMs);
      setSegIndex(next); // 仍 isPlaying → onLoadedMetadata 续播
    } else {
      setIsPlaying(false);
      emitState(false);
    }
  };

  const play = () => {
    const v = videoRef.current;
    if (!v) return;
    void v.play().then(() => { setIsPlaying(true); emitState(true); }).catch(() => undefined);
  };
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (isPlaying) { v.pause(); setIsPlaying(false); emitState(false); }
    else play();
  };
  ctxRef.current = { seekTo, pause, play, emitState };

  // 弹出窗自身拖动进度条：同样「拖动即暂停 + 定格」，并把状态广播给主窗对齐。点播放从此处续播。
  const uiSeek = (ms: number) => {
    pause();
    seekTo(ms);
    emitState(false, ms);
  };

  // 声音开关/音量：本地立即生效 + 立刻广播新值给主窗（暂停态没有 timeupdate，故不能等 emitState）。
  const broadcastAudio = (m: boolean, vol: number) => {
    const v = videoRef.current;
    void emit(POPOUT_EVENTS.playhead, { ms: currentMs(), playing: !!v && !v.paused, muted: m, volume: vol });
  };
  const toggleMute = () => { const next = !muted; setMuted(next); broadcastAudio(next, volume); };
  const changeVolume = (val: number) => { setVolume(val); setMuted(val === 0); broadcastAudio(val === 0, val); };

  const close = () => { void invoke('close_capture_popout').catch(() => {}); };

  return (
    <div className="adm" style={{ height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#000', boxSizing: 'border-box' }}>
      {/* 视频区 */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {segmentUrl ? (
          <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <video
              key={segIndex}
              ref={videoRef}
              src={segmentUrl}
              playsInline
              onLoadedMetadata={(e) => handleLoadedMetadata(e.currentTarget)}
              onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget)}
              onEnded={handleEnded}
              style={shouldCrop
                ? { position: 'absolute', top: 0, left: 0, width: '200%', height: '100%', objectFit: 'fill', display: 'block' }
                : { width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          </div>
        ) : (
          <div style={{ color: 'var(--fg-tertiary)', fontSize: '13px', textAlign: 'center', padding: '0 16px' }}>
            {pulling ? '正在连接主窗口…' : '本次采集没有录屏分段，或未取到数据。'}
          </div>
        )}
      </div>

      {/* 控制栏：播放 + 进度 + 时间 + 关闭。始终在，保证可控可退。 */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', backgroundColor: 'var(--bg-panel)', borderTop: '1px solid var(--border-subtle)' }}>
        <button type="button" onClick={togglePlay} disabled={!segmentUrl} className="btn iconbtn" style={{ width: '36px', height: '36px', borderRadius: '999px', flexShrink: 0 }} aria-label={isPlaying ? '暂停' : '播放'}>
          <Icon name={isPlaying ? 'pause' : 'play'} size={17} />
        </button>
        <input
          type="range"
          min={0}
          max={Math.round(totalMs)}
          value={Math.round(playheadMs)}
          onChange={(e) => uiSeek(Number(e.target.value))}
          disabled={!segmentUrl}
          style={{ flex: 1, minWidth: 0, accentColor: 'var(--accent)', cursor: 'pointer' }}
          aria-label="采集时间轴"
        />
        <div style={{ color: '#ddd', fontSize: '12px', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {formatClock(playheadMs)} / {formatClock(totalMs)}
        </div>
        {hasAudio && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <button type="button" onClick={toggleMute} className="btn secondary sm iconbtn" aria-label={muted ? '取消静音' : '静音'} data-tip={muted ? '取消静音' : '静音'} style={{ flexShrink: 0 }}>
              <Icon name={muted ? 'volume-x' : 'volume-2'} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
              style={{ width: '64px', accentColor: 'var(--accent)', cursor: 'pointer' }}
              aria-label="音量"
            />
          </div>
        )}
        <button onClick={close} className="btn secondary sm" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}><Icon name="corner-up-left" />恢复内嵌</button>
      </div>
    </div>
  );
}
