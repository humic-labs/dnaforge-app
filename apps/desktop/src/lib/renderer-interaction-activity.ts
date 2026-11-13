import type { CooperationOptions } from '../shared/artifact-operation-ports';
const INTERACTION_QUIET_MS = 250;
export const RENDERER_BACKGROUND_SCAN_BATCH_SIZE = 16;

let lastInteractionAtMs = Number.NEGATIVE_INFINITY;

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  const scheduler: unknown = Reflect.get(globalThis, 'scheduler');
  if (
    ms === 0 &&
    typeof scheduler === 'object' &&
    scheduler !== null &&
    'yield' in scheduler &&
    typeof scheduler.yield === 'function'
  ) {
    const yielded = Promise.resolve(scheduler.yield()).then(() => undefined);
    if (!signal) return yielded;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      yielded.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

export function markRendererInteractionActivity(nowMs = Date.now()): void {
  lastInteractionAtMs = Math.max(lastInteractionAtMs, nowMs);
}

export function rendererInteractionQuietDelayMs(nowMs = Date.now()): number {
  return Math.max(0, lastInteractionAtMs + INTERACTION_QUIET_MS - nowMs);
}

export function rendererInteractionCooperationIfNeeded(
  iteration: number,
  options: CooperationOptions = {}
): Promise<void> | null {
  options.signal?.throwIfAborted();
  const now = options.now ?? Date.now;
  if (
    iteration % RENDERER_BACKGROUND_SCAN_BATCH_SIZE !== 0 &&
    rendererInteractionQuietDelayMs(now()) <= 0
  ) {
    return null;
  }
  return cooperateWithRendererInteraction(iteration, options);
}

export async function cooperateWithRendererInteraction(
  iteration: number,
  options: CooperationOptions = {}
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  signal?.throwIfAborted();
  if (iteration % RENDERER_BACKGROUND_SCAN_BATCH_SIZE === 0) await sleep(0, signal);
  for (;;) {
    signal?.throwIfAborted();
    const remainingMs = rendererInteractionQuietDelayMs(now());
    if (remainingMs <= 0) return;
    await sleep(Math.max(1, remainingMs), signal);
  }
}

export function resetRendererInteractionActivityForTest(): void {
  lastInteractionAtMs = Number.NEGATIVE_INFINITY;
}
