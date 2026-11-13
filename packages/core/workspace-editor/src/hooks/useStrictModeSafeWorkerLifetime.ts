import { useEffect } from 'react';
import type { MutableRefObject } from 'react';

export interface TerminableWorker {
  terminate(): void;
}

export interface StrictModeSafeWorkerLifetimeRefs<TWorker extends TerminableWorker> {
  readonly pendingWorkerRef: MutableRefObject<TWorker | null>;
  readonly workerInstanceRef: MutableRefObject<TWorker | null>;
  readonly initTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  readonly teardownTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  readonly onWorkerTerminatedRef?: MutableRefObject<((worker: TWorker) => void) | null>;
}

export interface TransferredCanvasLifetimeRefs {
  readonly canvasTransferredRef: MutableRefObject<boolean>;
  readonly initDoneRef: MutableRefObject<boolean>;
}

export function recoverTransferredCanvasForFallback(
  refs: TransferredCanvasLifetimeRefs,
  remountCanvas: () => void
): boolean {
  if (!refs.canvasTransferredRef.current) return false;
  refs.canvasTransferredRef.current = false;
  refs.initDoneRef.current = false;
  remountCanvas();
  return true;
}

export function terminateOwnedWorker<TWorker extends TerminableWorker>(
  worker: TWorker,
  refs: StrictModeSafeWorkerLifetimeRefs<TWorker>
): boolean {
  const ownsWorker =
    refs.pendingWorkerRef.current === worker || refs.workerInstanceRef.current === worker;
  if (!ownsWorker) return false;
  if (refs.initTimeoutRef.current) {
    clearTimeout(refs.initTimeoutRef.current);
    refs.initTimeoutRef.current = null;
  }
  if (refs.pendingWorkerRef.current === worker) refs.pendingWorkerRef.current = null;
  if (refs.workerInstanceRef.current === worker) refs.workerInstanceRef.current = null;
  worker.terminate();
  refs.onWorkerTerminatedRef?.current?.(worker);
  return true;
}

export function useStrictModeSafeWorkerLifetime<TWorker extends TerminableWorker>(
  refs: StrictModeSafeWorkerLifetimeRefs<TWorker>
): void {
  const {
    pendingWorkerRef,
    workerInstanceRef,
    initTimeoutRef,
    teardownTimeoutRef,
    onWorkerTerminatedRef,
  } = refs;
  useEffect(() => {
    if (teardownTimeoutRef.current) {
      clearTimeout(teardownTimeoutRef.current);
      teardownTimeoutRef.current = null;
    }
    return () => {
      teardownTimeoutRef.current = setTimeout(() => {
        if (initTimeoutRef.current) {
          clearTimeout(initTimeoutRef.current);
          initTimeoutRef.current = null;
        }
        const ownedWorkers = new Set<TWorker>();
        if (pendingWorkerRef.current) ownedWorkers.add(pendingWorkerRef.current);
        if (workerInstanceRef.current) ownedWorkers.add(workerInstanceRef.current);
        for (const worker of ownedWorkers) {
          worker.terminate();
          onWorkerTerminatedRef?.current?.(worker);
        }
        pendingWorkerRef.current = null;
        workerInstanceRef.current = null;
        teardownTimeoutRef.current = null;
      }, 0);
    };
  }, [
    initTimeoutRef,
    onWorkerTerminatedRef,
    pendingWorkerRef,
    teardownTimeoutRef,
    workerInstanceRef,
  ]);
}
