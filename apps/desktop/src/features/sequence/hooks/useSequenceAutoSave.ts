import { useCallback, useEffect, useRef } from 'react';

export interface UseSequenceAutoSaveOptions {
  editEpoch: number;
  isDirty: boolean;
  save: () => Promise<boolean>;
  enabled?: boolean;
  debounceMs?: number;
}

export function useSequenceAutoSave({
  editEpoch,
  isDirty,
  save,
  enabled = true,
  debounceMs = 1500,
}: UseSequenceAutoSaveOptions): { flush: () => Promise<boolean> } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const rerunRef = useRef(false);
  const rerunWaitersRef = useRef<Array<(saved: boolean) => void>>([]);

  const saveRef = useRef(save);
  saveRef.current = save;

  const runSave = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current !== null) {
      rerunRef.current = true;
      return new Promise<boolean>((resolve) => rerunWaitersRef.current.push(resolve));
    }
    const cycle = (async (): Promise<boolean> => {
      try {
        return await saveRef.current();
      } catch {
        return false;
      }
    })();
    inFlightRef.current = cycle;
    const saved = await cycle;
    inFlightRef.current = null;

    if (!rerunRef.current) return saved;

    rerunRef.current = false;
    const waiters = rerunWaitersRef.current.splice(0);
    const rerunSaved = await runSave();
    for (const resolve of waiters) resolve(rerunSaved);
    return saved || rerunSaved;
  }, []);

  const flush = useCallback((): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return runSave();
  }, [runSave]);

  useEffect(() => {
    if (!enabled || !isDirty) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runSave();
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editEpoch, isDirty, enabled, debounceMs, runSave]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        void runSave();
      }
    };
  }, [runSave]);

  return { flush };
}
