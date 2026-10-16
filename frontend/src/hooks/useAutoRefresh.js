import { useEffect, useRef } from 'react';

/** Периодический вызов переданной sync/async-функции и логирование ошибок. */
export function useAutoRefresh(fn, delay = 3000) {
  const saved = useRef(fn);

  useEffect(() => {
    saved.current = fn;
  }, [fn]);

  useEffect(() => {
    // Выполнение одного цикла автообновления.
    const tick = () => {
      try {
        const result = saved.current?.();
        if (result && typeof result.then === 'function') {
          result.catch((err) => console.error('Auto-refresh error', err));
        }
      } catch (err) {
        console.error('Auto-refresh error', err);
      }
    };
    const id = setInterval(tick, delay);
    return () => clearInterval(id);
  }, [delay]);
}
