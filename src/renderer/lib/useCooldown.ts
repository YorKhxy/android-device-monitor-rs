import { useCallback, useEffect, useRef, useState } from 'react';

// 瞬时动作按钮的"假冷却"：点一下后即使逻辑瞬间完成，也保持 ms 毫秒的冷却态，
// 让按钮有可见的"执行中"反馈（配合禁用 + 图标转圈）。冷却期内重复点击被忽略，顺带防抖。
export function useCooldown(ms = 500): { cooling: boolean; run: (action?: () => void) => void } {
  const [cooling, setCooling] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const run = useCallback(
    (action?: () => void) => {
      if (cooling) return;
      setCooling(true);
      try {
        action?.();
      } finally {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCooling(false), ms);
      }
    },
    [cooling, ms]
  );

  return { cooling, run };
}
