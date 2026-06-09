import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// 全局悬停提示：监听任意带 data-tip 的元素，把气泡挂到 document.body（position:fixed + portal），
// 彻底绕开祖先 overflow:hidden 的裁剪（折叠侧栏、滚动面板里的 tip 都能完整显示）。
// 测量气泡尺寸后做上下翻转 + 左右夹取，保证不出屏；悬停 0.35s 才弹，pointer-events:none 不挡交互。
const SHOW_DELAY_MS = 350;
const MARGIN = 8;
const GAP = 6;

type TipState = { text: string; rect: DOMRect };

export function GlobalTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const hide = () => {
      clearTimer();
      activeElRef.current = null;
      setTip(null);
      setPos(null);
    };
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (!el) return;
      const text = el.getAttribute('data-tip');
      if (!text) return; // 空/未设置不弹
      if (activeElRef.current === el) return;
      activeElRef.current = el;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        if (activeElRef.current !== el || !el.isConnected) return;
        setPos(null); // 先隐藏，待测量后再定位，避免左上角闪现
        setTip({ text, rect: el.getBoundingClientRect() });
      }, SHOW_DELAY_MS);
    };
    const onOut = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]');
      if (el && el === activeElRef.current) hide();
    };
    // 捕获阶段监听，覆盖所有层级；滚动/窗口变化即隐藏，避免气泡停在旧位置。
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide, true);
    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide, true);
      clearTimer();
    };
  }, []);

  // 测量气泡后定位：默认下方，下方放不下翻到上方；水平居中后夹取进视口。
  useLayoutEffect(() => {
    if (!tip || !bubbleRef.current) return;
    const b = bubbleRef.current.getBoundingClientRect();
    const r = tip.rect;
    let top = r.bottom + GAP;
    if (top + b.height > window.innerHeight - MARGIN) {
      const above = r.top - GAP - b.height;
      top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - MARGIN - b.height);
    }
    let left = r.left + r.width / 2 - b.width / 2;
    left = Math.min(Math.max(left, MARGIN), window.innerWidth - b.width - MARGIN);
    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;

  return createPortal(
    <div
      ref={bubbleRef}
      style={{
        position: 'fixed',
        left: pos ? pos.left : -9999,
        top: pos ? pos.top : -9999,
        zIndex: 4000,
        maxWidth: '320px',
        padding: '5px 9px',
        background: 'var(--bg-elevated)',
        color: 'var(--fg-secondary)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--r-sm)',
        boxShadow: 'var(--sh-pop)',
        fontSize: '12px',
        lineHeight: 1.4,
        whiteSpace: 'normal',
        wordBreak: 'break-word',
        pointerEvents: 'none',
        opacity: pos ? 1 : 0,
        transition: 'opacity 0.12s ease',
      }}
    >
      {tip.text}
    </div>,
    document.body
  );
}
