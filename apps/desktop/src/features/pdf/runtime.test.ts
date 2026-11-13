// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

type ControlledDocument = Pick<
  import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentProxy,
  'numPages'
>;
type ControlledLoadingTask = Pick<
  import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentLoadingTask,
  'docId' | 'destroyed' | 'getData' | 'destroy'
> & {
  promise: Promise<ControlledDocument>;
  onPassword: import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentLoadingTask['onPassword'] | null;
  onProgress: import('pdfjs-dist/legacy/build/pdf.mjs').PDFDocumentLoadingTask['onProgress'] | null;
};

const state = vi.hoisted(() => ({
  getDocument:
    vi.fn<
      (
        ...args: Parameters<typeof import('pdfjs-dist/legacy/build/pdf.mjs').getDocument>
      ) => ControlledLoadingTask
    >(),
  portsAtLoad: [] as unknown[],
  workers: [] as Array<EventTarget & { terminate: ReturnType<typeof vi.fn> }>,
  sdkWorkers: [] as Array<{ destroy: ReturnType<typeof vi.fn>; port: unknown }>,
  sdkCreationFailure: null as Error | null,
  currentPort: null as unknown,
  portAssignmentFailure: null as Error | null,
  constructorFailure: null as Error | null,
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const GlobalWorkerOptions = {
    get workerPort() {
      return state.currentPort;
    },
    set workerPort(port: unknown) {
      if (port !== null && state.portAssignmentFailure) throw state.portAssignmentFailure;
      state.currentPort = port;
    },
  };
  return {
    GlobalWorkerOptions,
    getDocument: state.getDocument,
    PDFWorker: {
      create: vi.fn(({ port }: { port: unknown }) => {
        if (state.sdkCreationFailure) throw state.sdkCreationFailure;
        const sdk = { port, destroy: vi.fn() };
        state.sdkWorkers.push(sdk);
        return sdk;
      }),
    },
  };
});

vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline', () => ({
  default: class PdfWorker extends EventTarget {
    terminate = vi.fn();
    constructor() {
      super();
      if (state.constructorFailure) throw state.constructorFailure;
      state.workers.push(this);
    }
  },
}));

import { getDocument, GlobalWorkerOptions, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beginPdfLoad } from './runtime';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (failure) {
    return failure;
  }
  throw new Error('Expected a controlled synchronous failure');
}

function installTask(
  destroy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  promise: Promise<ControlledDocument> = Promise.resolve({ numPages: 1 })
) {
  const task: ControlledLoadingTask = {
    docId: 'controlled-loading-task',
    destroyed: false,
    promise,
    onPassword: null,
    onProgress: null,
    getData: vi.fn(async () => new Uint8Array([1])),
    destroy,
  };
  state.getDocument.mockImplementationOnce(() => {
    state.portsAtLoad.push(GlobalWorkerOptions.workerPort);
    return task;
  });
  return task;
}

describe('PDF runtime worker ownership', () => {
  beforeEach(() => {
    vi.mocked(getDocument).mockReset();
    state.portsAtLoad.length = 0;
    state.workers.length = 0;
    state.sdkWorkers.length = 0;
    state.sdkCreationFailure = null;
    vi.mocked(PDFWorker.create).mockClear();
    state.currentPort = null;
    state.portAssignmentFailure = null;
    state.constructorFailure = null;
  });

  it('gives consecutive loading tasks different worker ports', async () => {
    installTask();
    installTask();
    const first = beginPdfLoad(new Uint8Array([1]));
    const second = beginPdfLoad(new Uint8Array([2]));

    expect(state.workers).toHaveLength(2);
    expect(state.portsAtLoad).toEqual(state.workers);
    expect(state.portsAtLoad[0]).not.toBe(state.portsAtLoad[1]);
    await Promise.all([first.destroy(), second.destroy()]);
  });

  it('keeps the original loading-task API and waits for its destroy before terminating the raw worker', async () => {
    const shutdown = deferred();
    const destroy = vi.fn(function (this: { destroyed: boolean }) {
      this.destroyed = true;
      return shutdown.promise;
    });
    const original = installTask(destroy);
    const task = beginPdfLoad(new Uint8Array([1]));
    const onProgress = vi.fn();
    task.onProgress = onProgress;

    expect(task).toBe(original);
    expect(task.promise).toBe(original.promise);
    expect(task.docId).toBe(original.docId);
    expect(original.onProgress).toBe(onProgress);
    await expect(task.getData()).resolves.toEqual(new Uint8Array([1]));

    const closing = task.destroy();
    expect(task.destroyed).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy.mock.contexts[0]).toBe(original);
    expect(state.workers[0].terminate).not.toHaveBeenCalled();
    shutdown.resolve();
    await closing;
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });

  it('shares pending and completed destroy calls without destroying or terminating twice', async () => {
    const shutdown = deferred();
    const destroy = vi.fn(() => shutdown.promise);
    installTask(destroy);
    const task = beginPdfLoad(new Uint8Array([1]));
    const first = task.destroy();
    const second = task.destroy();

    expect(second).toBe(first);
    expect(destroy).toHaveBeenCalledTimes(1);
    shutdown.resolve();
    await first;
    expect(task.destroy()).toBe(first);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['older', 'newer'] as const)(
    'isolates overlapping loads when the %s destroy completes first',
    async (firstToClose) => {
      const olderShutdown = deferred();
      const newerShutdown = deferred();
      const olderDestroy = vi.fn(() => olderShutdown.promise);
      const newerDestroy = vi.fn(() => newerShutdown.promise);
      installTask(olderDestroy);
      installTask(newerDestroy);
      const older = beginPdfLoad(new Uint8Array([1]));
      const olderClosing = older.destroy();
      const newer = beginPdfLoad(new Uint8Array([2]));
      const newerClosing = newer.destroy();

      expect(older.destroy()).toBe(olderClosing);
      expect(newer.destroy()).toBe(newerClosing);
      if (firstToClose === 'older') {
        olderShutdown.resolve();
        await olderClosing;
        expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
        expect(state.workers[1].terminate).not.toHaveBeenCalled();
        expect(GlobalWorkerOptions.workerPort).toBe(state.workers[1]);
        newerShutdown.resolve();
      } else {
        newerShutdown.resolve();
        await newerClosing;
        expect(state.workers[1].terminate).toHaveBeenCalledTimes(1);
        expect(state.workers[0].terminate).not.toHaveBeenCalled();
        expect(GlobalWorkerOptions.workerPort).toBeNull();
        olderShutdown.resolve();
      }
      await Promise.all([olderClosing, newerClosing]);
      expect(olderDestroy).toHaveBeenCalledTimes(1);
      expect(newerDestroy).toHaveBeenCalledTimes(1);
      expect(state.workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
      expect(GlobalWorkerOptions.workerPort).toBeNull();
    }
  );

  it.each(['port assignment', 'getDocument'] as const)(
    'terminates the raw worker after a synchronous %s failure',
    (stage) => {
      const primary = new Error(`Controlled ${stage} failure`);
      if (stage === 'port assignment') state.portAssignmentFailure = primary;
      else
        vi.mocked(getDocument).mockImplementationOnce(() => {
          throw primary;
        });

      expect(caught(() => beginPdfLoad(new Uint8Array([1])))).toBe(primary);
      expect(state.workers).toHaveLength(1);
      expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
      expect(GlobalWorkerOptions.workerPort).toBeNull();
      if (stage === 'port assignment') expect(getDocument).not.toHaveBeenCalled();
    }
  );

  it('preserves a worker construction failure before an owned worker exists', () => {
    const primary = new Error('Controlled worker construction failure');
    state.constructorFailure = primary;
    expect(caught(() => beginPdfLoad(new Uint8Array([1])))).toBe(primary);
    expect(state.workers).toHaveLength(0);
    expect(getDocument).not.toHaveBeenCalled();
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });

  it.each(['reject', 'throw'] as const)(
    'terminates even when the task destroy will %s, preserving its raw failure',
    async (mode) => {
      const primary = { controlledFailure: 'task shutdown' };
      const destroy = vi.fn<() => Promise<void>>(() => {
        if (mode === 'throw') throw primary;
        return Promise.reject(primary);
      });
      installTask(destroy);
      const task = beginPdfLoad(new Uint8Array([1]));
      const closing = task.destroy();

      await expect(closing).rejects.toBe(primary);
      expect(task.destroy()).toBe(closing);
      await expect(task.destroy()).rejects.toBe(primary);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
      expect(GlobalWorkerOptions.workerPort).toBeNull();
    }
  );

  it('reports a raw-worker termination failure when task shutdown succeeded', async () => {
    const cleanup = new Error('Controlled raw-worker termination failure');
    installTask();
    const task = beginPdfLoad(new Uint8Array([1]));
    state.workers[0].terminate.mockImplementationOnce(() => {
      throw cleanup;
    });

    await expect(task.destroy()).rejects.toBe(cleanup);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });

  it('preserves the original destroy rejection when terminating its worker also throws', async () => {
    const primary = new Error('Controlled task shutdown failure');
    const cleanup = new Error('Controlled raw-worker termination failure');
    const destroy = vi.fn<() => Promise<void>>().mockRejectedValue(primary);
    installTask(destroy);
    const task = beginPdfLoad(new Uint8Array([1]));
    state.workers[0].terminate.mockImplementationOnce(() => {
      throw cleanup;
    });

    await expect(task.destroy()).rejects.toBe(primary);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });

  it('preserves the original setup throw when terminating its worker also throws', () => {
    const primary = new Error('Controlled getDocument failure');
    const cleanup = new Error('Controlled raw-worker termination failure');
    vi.mocked(getDocument).mockImplementationOnce(() => {
      state.workers[0].terminate.mockImplementationOnce(() => {
        throw cleanup;
      });
      throw primary;
    });

    expect(caught(() => beginPdfLoad(new Uint8Array([1])))).toBe(primary);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });
  it('rejects an unsettled owned result on a modeled raw error and preserves the exact primary reason', async () => {
    const pending = new Promise<{ numPages: number }>(() => {});
    const original = installTask(undefined, pending);
    const sdkDestroy = original.destroy;
    const task = beginPdfLoad(new Uint8Array([1]));
    const primary = new Error('Controlled external worker failure');
    const result = expect(task.result).rejects.toBe(primary);
    const event = new Event('error', { cancelable: true });
    Object.defineProperty(event, 'error', { value: primary });
    state.workers[0].dispatchEvent(event);
    await result;
    await expect(task.workerFailure).resolves.toBe(primary);
    await expect(task.destroy()).rejects.toBe(primary);
    expect(event.defaultPrevented).toBe(true);
    expect(sdkDestroy).toHaveBeenCalledTimes(1);
    expect(state.sdkWorkers[0].destroy).toHaveBeenCalledTimes(1);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });

  it('reports a failure after successful load without changing the SDK promise or task API', async () => {
    const original = installTask();
    const sdkPromise = original.promise;
    const sdkDestroy = original.destroy;
    const task = beginPdfLoad(new Uint8Array([1]));
    await expect(task.result).resolves.toEqual({ numPages: 1 });
    const primary = new Error('Controlled loaded-worker error');
    const event = new Event('error');
    Object.defineProperty(event, 'error', { value: primary });
    state.workers[0].dispatchEvent(event);
    expect(task).toBe(original);
    expect(task.promise).toBe(sdkPromise);
    await expect(task.workerFailure).resolves.toBe(primary);
    await expect(task.destroy()).rejects.toBe(primary);
    expect(sdkDestroy).toHaveBeenCalledTimes(1);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'messageerror'] as const)(
    'retains the actual %s event when it has no error object',
    async (kind) => {
      installTask(undefined, new Promise<{ numPages: number }>(() => {}));
      const task = beginPdfLoad(new Uint8Array([1]));
      const event = new Event(kind);
      const result = expect(task.result).rejects.toBe(event);
      state.workers[0].dispatchEvent(event);
      await result;
      await expect(task.workerFailure).resolves.toBe(event);
      await expect(task.destroy()).rejects.toBe(event);
    }
  );

  it('settles cancellation on a raw failure even when SDK shutdown never acknowledges it', async () => {
    const primary = new Error('Controlled failure during SDK close');
    const destroy = vi.fn(() => {
      const event = new Event('error');
      Object.defineProperty(event, 'error', { value: primary });
      state.workers[0].dispatchEvent(event);
      return new Promise<void>(() => {});
    });
    installTask(destroy);
    const task = beginPdfLoad(new Uint8Array([1]));
    await task.result;
    const closing = task.destroy();
    await expect(closing).rejects.toBe(primary);
    expect(task.destroy()).toBe(closing);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(state.sdkWorkers[0].destroy).toHaveBeenCalledTimes(1);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('keeps one fatal reason and removes both listeners despite duplicate errors and cleanup throws', async () => {
    const original = installTask(undefined, new Promise<{ numPages: number }>(() => {}));
    const sdkDestroy = original.destroy;
    const task = beginPdfLoad(new Uint8Array([1]));
    const removed = vi.spyOn(state.workers[0], 'removeEventListener');
    const primary = new Error('Controlled first raw failure');
    state.sdkWorkers[0].destroy.mockImplementation(() => {
      throw new Error('SDK cleanup failed');
    });
    state.workers[0].terminate.mockImplementation(() => {
      throw new Error('Raw cleanup failed');
    });
    const event = new Event('error');
    Object.defineProperty(event, 'error', { value: primary });
    const result = expect(task.result).rejects.toBe(primary);
    state.workers[0].dispatchEvent(event);
    state.workers[0].dispatchEvent(new Event('messageerror'));
    await result;
    await expect(task.workerFailure).resolves.toBe(primary);
    await expect(task.destroy()).rejects.toBe(primary);
    expect(sdkDestroy).toHaveBeenCalledTimes(1);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls.map(([kind]) => kind)).toEqual(['error', 'messageerror']);
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });

  it('ignores a late retired A error and cannot clear or fail current B', async () => {
    installTask();
    const older = beginPdfLoad(new Uint8Array([1]));
    const removed = vi.spyOn(state.workers[0], 'removeEventListener');
    await older.result;
    await older.destroy();
    const oldListener = removed.mock.calls.find(([kind]) => kind === 'error')?.[1] as EventListener;
    expect(oldListener).toBeTypeOf('function');
    installTask();
    const newer = beginPdfLoad(new Uint8Array([2]));
    const failed = vi.fn();
    void newer.workerFailure.then(failed);
    oldListener(new Event('error'));
    await newer.result;
    await Promise.resolve();
    expect(failed).not.toHaveBeenCalled();
    expect(GlobalWorkerOptions.workerPort).toBe(state.workers[1]);
    expect(state.workers[1].terminate).not.toHaveBeenCalled();
    await newer.destroy();
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('cleans up a public PDFWorker creation failure without accessing SDK internals', () => {
    const primary = new Error('Controlled public worker setup failure');
    state.sdkCreationFailure = primary;
    expect(caught(() => beginPdfLoad(new Uint8Array([1])))).toBe(primary);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(getDocument).not.toHaveBeenCalled();
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });

  it('keeps current B ownership when an overlapping active A worker fails', async () => {
    installTask(undefined, new Promise<{ numPages: number }>(() => {}));
    const older = beginPdfLoad(new Uint8Array([1]));
    installTask();
    const newer = beginPdfLoad(new Uint8Array([2]));
    await newer.result;
    const primary = new Error('Controlled overlapping A failure');
    const rejected = expect(older.result).rejects.toBe(primary);
    const event = new Event('error');
    Object.defineProperty(event, 'error', { value: primary });
    state.workers[0].dispatchEvent(event);
    await rejected;
    expect(GlobalWorkerOptions.workerPort).toBe(state.workers[1]);
    expect(state.sdkWorkers[1].destroy).not.toHaveBeenCalled();
    expect(state.workers[1].terminate).not.toHaveBeenCalled();
    await newer.destroy();
  });

  it('still retires the raw port when public SDK-worker cleanup fails after healthy shutdown', async () => {
    installTask();
    const task = beginPdfLoad(new Uint8Array([1]));
    const primary = new Error('Controlled public SDK-worker cleanup failure');
    state.sdkWorkers[0].destroy.mockImplementation(() => {
      throw primary;
    });
    await expect(task.destroy()).rejects.toBe(primary);
    expect(state.sdkWorkers[0].destroy).toHaveBeenCalledTimes(1);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });

  it('passes the public SDK worker for the same raw port and preserves successful result identity', async () => {
    const document = { numPages: 2 };
    const sdkPromise = Promise.resolve(document);
    const original = installTask(undefined, sdkPromise);
    const bytes = new Uint8Array([1]);
    const task = beginPdfLoad(bytes);
    expect(vi.mocked(PDFWorker.create)).toHaveBeenCalledWith({ port: state.workers[0] });
    expect(vi.mocked(getDocument)).toHaveBeenCalledWith({
      data: bytes,
      worker: state.sdkWorkers[0],
    });
    expect(task).toBe(original);
    expect(task.promise).toBe(sdkPromise);
    await expect(task.result).resolves.toBe(document);
    await task.destroy();
  });

  it('retains an early raw failure before getDocument can throw a later setup error', () => {
    const primary = new Error('Controlled first raw setup failure');
    vi.mocked(getDocument).mockImplementationOnce(() => {
      const event = new Event('error');
      Object.defineProperty(event, 'error', { value: primary });
      state.workers[0].dispatchEvent(event);
      throw new Error('Controlled later SDK setup error');
    });
    expect(caught(() => beginPdfLoad(new Uint8Array([1])))).toBe(primary);
    expect(state.sdkWorkers[0].destroy).toHaveBeenCalledTimes(1);
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(GlobalWorkerOptions.workerPort).toBeNull();
  });

  it('does not replace the raw primary with an SDK rejection caused by fatal cleanup', async () => {
    let rejectSdk!: (reason: unknown) => void;
    const promise = new Promise<{ numPages: number }>((_resolve, reject) => {
      rejectSdk = reject;
    });
    installTask(undefined, promise);
    const task = beginPdfLoad(new Uint8Array([1]));
    const primary = new Error('Controlled raw primary');
    state.sdkWorkers[0].destroy.mockImplementation(() => {
      rejectSdk(new Error('Controlled secondary SDK abort'));
    });
    const result = expect(task.result).rejects.toBe(primary);
    const event = new Event('error');
    Object.defineProperty(event, 'error', { value: primary });
    state.workers[0].dispatchEvent(event);
    await result;
    await expect(task.destroy()).rejects.toBe(primary);
  });
});
