/** @vitest-environment jsdom */

import { StrictMode, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  recoverTransferredCanvasForFallback,
  terminateOwnedWorker,
  useStrictModeSafeWorkerLifetime,
  type TerminableWorker,
} from './useStrictModeSafeWorkerLifetime';

afterEach(() => {
  vi.useRealTimers();
});

describe('useStrictModeSafeWorkerLifetime', () => {
  it('remounts an irreversibly transferred canvas when the worker init post throws', () => {
    const canvasTransferredRef = { current: false };
    const initDoneRef = { current: true };
    const remountCanvas = vi.fn();
    const canvas = {
      transferControlToOffscreen: () => {
        canvasTransferredRef.current = true;
        return {};
      },
    };
    const worker = {
      postMessage: () => {
        throw new Error('injected init post failure');
      },
    };

    expect(() => {
      const offscreen = canvas.transferControlToOffscreen();
      try {
        worker.postMessage({ type: 'init', canvas: offscreen });
      } catch (error) {
        recoverTransferredCanvasForFallback({ canvasTransferredRef, initDoneRef }, remountCanvas);
        throw error;
      }
    }).toThrow('injected init post failure');

    expect(canvasTransferredRef.current).toBe(false);
    expect(initDoneRef.current).toBe(false);
    expect(remountCanvas).toHaveBeenCalledOnce();
  });

  it('clears every initialization owner when a constructed worker fails', () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const worker: TerminableWorker = { terminate };
    const pendingWorkerRef = { current: worker as TerminableWorker | null };
    const workerInstanceRef = { current: null as TerminableWorker | null };
    const initTimeoutRef = { current: setTimeout(() => undefined, 1_000) };
    const teardownTimeoutRef = { current: null as ReturnType<typeof setTimeout> | null };

    expect(
      terminateOwnedWorker(worker, {
        pendingWorkerRef,
        workerInstanceRef,
        initTimeoutRef,
        teardownTimeoutRef,
      })
    ).toBe(true);
    expect(terminate).toHaveBeenCalledOnce();
    expect(pendingWorkerRef.current).toBeNull();
    expect(workerInstanceRef.current).toBeNull();
    expect(initTimeoutRef.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the pending worker through StrictMode replay and terminates it on real unmount', () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const onWorkerTerminated = vi.fn();
    const worker: TerminableWorker = { terminate };

    function Harness(): null {
      const pendingWorkerRef = useRef<TerminableWorker | null>(worker);
      const workerInstanceRef = useRef<TerminableWorker | null>(null);
      const initTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
      const teardownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
      const onWorkerTerminatedRef = useRef(onWorkerTerminated);
      useStrictModeSafeWorkerLifetime({
        pendingWorkerRef,
        workerInstanceRef,
        initTimeoutRef,
        teardownTimeoutRef,
        onWorkerTerminatedRef,
      });
      return null;
    }

    const mounted = render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    act(() => vi.runOnlyPendingTimers());
    expect(terminate).not.toHaveBeenCalled();
    expect(onWorkerTerminated).not.toHaveBeenCalled();

    mounted.unmount();
    expect(terminate).not.toHaveBeenCalled();
    act(() => vi.runOnlyPendingTimers());
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(onWorkerTerminated).toHaveBeenCalledExactlyOnceWith(worker);
  });
});
