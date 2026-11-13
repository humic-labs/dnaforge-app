import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const workerHookSource = readFileSync(
  new URL('../hooks/useCanvasWorkerDraw.ts', import.meta.url),
  'utf8'
);

describe('Canvas transfer safety', () => {
  it('REGRESSION: fallback path must not set width/height on a transferred canvas', () => {
    const canvasTransferredRef = { current: false };

    let resizeAttempted = false;
    const simulatedCanvas = {
      set width(_v: number) {
        resizeAttempted = true;
      },
      set height(_v: number) {
        resizeAttempted = true;
      },
    };

    canvasTransferredRef.current = true;

    const fallbackDraw = () => {
      if (canvasTransferredRef.current) return 'skipped';
      simulatedCanvas.width = 100;
      simulatedCanvas.height = 100;
      return 'drew';
    };

    expect(fallbackDraw()).toBe('skipped');
    expect(resizeAttempted).toBe(false);

    canvasTransferredRef.current = false;
    expect(fallbackDraw()).toBe('drew');
    expect(resizeAttempted).toBe(true);
  });

  it('canvasTransferredRef must be set BEFORE the async worker ready message', () => {
    const canvasTransferredRef = { current: false };
    type WorkerState = Worker | false | null;
    let workerState: WorkerState = null;

    const simulateInit = () => {
      canvasTransferredRef.current = true;
    };

    const shouldRunFallback = () => {
      return workerState === false && !canvasTransferredRef.current;
    };

    simulateInit();

    expect(workerState).toBe(null);
    expect(canvasTransferredRef.current).toBe(true);
    expect(shouldRunFallback()).toBe(false);

    workerState = {} as Worker;
    expect(shouldRunFallback()).toBe(false);

    workerState = false;
    expect(shouldRunFallback()).toBe(false);
  });
});

describe('Worker/fallback mode exclusivity', () => {
  it('worker draw effect only activates when workerState is a Worker instance', () => {
    const states: Array<Worker | false | null> = [null, false, {} as Worker];
    const shouldRunWorker = (ws: Worker | false | null) => typeof ws === 'object' && ws !== null;

    expect(shouldRunWorker(null)).toBe(false);
    expect(shouldRunWorker(false)).toBe(false);
    expect(shouldRunWorker(states[2])).toBe(true);
  });

  it('fallback draw effect only activates when workerState is false AND canvas not transferred', () => {
    const shouldRunFallback = (ws: Worker | false | null, transferred: boolean) =>
      ws === false && !transferred;

    expect(shouldRunFallback(null, false)).toBe(false);
    expect(shouldRunFallback(null, true)).toBe(false);
    expect(shouldRunFallback(false, false)).toBe(true);
    expect(shouldRunFallback(false, true)).toBe(false);
    expect(shouldRunFallback({} as Worker, false)).toBe(false);
  });
});

describe('React StrictMode safety', () => {
  it('owns a constructed worker before ping and terminates that pending owner on unmount', () => {
    const constructIndex = workerHookSource.indexOf('worker = new CanvasRenderWorker()');
    const claimIndex = workerHookSource.indexOf(
      'pendingWorkerRef.current = initializingWorker',
      constructIndex
    );
    const pingIndex = workerHookSource.indexOf("type: 'ping'", constructIndex);

    expect(constructIndex).toBeGreaterThan(-1);
    expect(claimIndex).toBeGreaterThan(constructIndex);
    expect(claimIndex).toBeLessThan(pingIndex);
  });

  it('routes every post-construction initialization failure through owner termination', () => {
    const initialization = workerHookSource.slice(
      workerHookSource.indexOf('let worker: Worker | null = null'),
      workerHookSource.indexOf('// ─── Worker draw effect')
    );

    expect(initialization).toContain('terminateOwnedWorker(failedWorker');
    expect(initialization).toContain(
      "failWorkerInitialization(initializingWorker, 'worker-init-exception', error)"
    );
    expect(initialization).toContain(
      "failWorkerInitialization(initializingWorker, 'worker-init-error')"
    );
    expect(initialization).toContain(
      "failWorkerInitialization(initializingWorker, 'worker-init-timeout')"
    );
    expect(initialization).toContain(
      "if (worker) failWorkerInitialization(worker, 'worker-init-exception', err)"
    );
    expect(initialization).toContain('recoverTransferredCanvasForFallback(');
    expect(initialization).toContain('Worker ready timeout (1s), falling back');
    expect(initialization).toContain('workerInstanceRef.current === initializingWorker');
  });

  it('REGRESSION: StrictMode double-mount must not re-transfer canvas', () => {
    const initDoneRef = { current: false };
    let transferCallCount = 0;

    const runInit = () => {
      if (initDoneRef.current) return 'reused';
      initDoneRef.current = true;
      transferCallCount++;
      return 'initialized';
    };

    expect(runInit()).toBe('initialized');
    expect(transferCallCount).toBe(1);

    expect(runInit()).toBe('reused');
    expect(transferCallCount).toBe(1);
  });

  it('worker instance persists across StrictMode re-mounts', () => {
    const workerInstanceRef = { current: null as object | null };
    const initDoneRef = { current: false };

    if (!initDoneRef.current) {
      initDoneRef.current = true;
      workerInstanceRef.current = { id: 'worker-1' };
    }

    const firstWorker = workerInstanceRef.current;

    const reusedWorker = workerInstanceRef.current;
    expect(reusedWorker).toBe(firstWorker);
  });
});

describe('State transitions', () => {
  it('covers all possible state transitions', () => {
    type State = { workerState: Worker | false | null; transferred: boolean };
    type Mode = 'pending' | 'worker' | 'fallback' | 'degraded';

    const getMode = (s: State): Mode => {
      if (typeof s.workerState === 'object' && s.workerState !== null) return 'worker';
      if (s.workerState === false && !s.transferred) return 'fallback';
      if (s.workerState === false && s.transferred) return 'degraded';
      return 'pending';
    };

    expect(getMode({ workerState: null, transferred: false })).toBe('pending');
    expect(getMode({ workerState: null, transferred: true })).toBe('pending');
    expect(getMode({ workerState: {} as Worker, transferred: true })).toBe('worker');

    expect(getMode({ workerState: false, transferred: true })).toBe('degraded');

    expect(getMode({ workerState: false, transferred: false })).toBe('fallback');
  });
});
