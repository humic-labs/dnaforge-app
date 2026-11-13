const DEFAULT_FALLBACK_MS = 50;

interface StreamProjectionCoalescerOptions<T> {
  commit: (snapshot: T) => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  scheduleFallback?: (callback: () => void, delayMs: number) => number;
  cancelFallback?: (handle: number) => void;
  fallbackMs?: number;
}

export interface StreamProjectionCoalescer<T> {
  push(snapshot: T): void;
  flush(): void;
  cancel(): void;
}

export function createStreamProjectionCoalescer<T>(
  options: StreamProjectionCoalescerOptions<T>
): StreamProjectionCoalescer<T> {
  const requestFrame =
    options.requestFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const scheduleFallback =
    options.scheduleFallback ??
    ((callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs));
  const cancelFallback = options.cancelFallback ?? window.clearTimeout;
  const fallbackMs = options.fallbackMs ?? DEFAULT_FALLBACK_MS;
  let latest: T | undefined;
  let hasPending = false;
  let scheduled = false;
  let frameHandle: number | null = null;
  let fallbackHandle: number | null = null;

  const clearSchedule = (): void => {
    if (frameHandle !== null) cancelFrame(frameHandle);
    if (fallbackHandle !== null) cancelFallback(fallbackHandle);
    frameHandle = null;
    fallbackHandle = null;
    scheduled = false;
  };

  const commitLatest = (): void => {
    if (!hasPending) return;
    const snapshot = latest as T;
    latest = undefined;
    hasPending = false;
    options.commit(snapshot);
  };

  const drain = (): void => {
    if (!scheduled) return;
    clearSchedule();
    commitLatest();
  };

  return {
    push(snapshot) {
      latest = snapshot;
      hasPending = true;
      if (scheduled) return;
      scheduled = true;
      frameHandle = requestFrame(drain);
      fallbackHandle = scheduleFallback(drain, fallbackMs);
    },
    flush() {
      clearSchedule();
      commitLatest();
    },
    cancel() {
      clearSchedule();
      latest = undefined;
      hasPending = false;
    },
  };
}
