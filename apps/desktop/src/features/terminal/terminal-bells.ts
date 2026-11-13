import { useCallback, useEffect, useRef, useState } from 'react';

export function useTerminalBells(duration: number) {
  const [bells, setBells] = useState<Record<string, true>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const clear = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setBells((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  const ring = useCallback(
    (id: string) => {
      const previous = timers.current.get(id);
      if (previous) clearTimeout(previous);
      setBells((current) => (current[id] ? current : { ...current, [id]: true }));
      const timeout = Number.isFinite(duration) ? Math.max(100, Math.min(10_000, duration)) : 1000;
      timers.current.set(
        id,
        setTimeout(() => clear(id), timeout)
      );
    },
    [duration, clear]
  );
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );
  return { bells, ring, clear };
}
