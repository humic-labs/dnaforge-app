import type { Worker } from 'node:worker_threads';

import type { IndexedGenomeManifest } from '@waypoint/genome-data';
import { describe, expect, it, vi } from 'vitest';

import {
  GenomeDataWorkerThreadSource,
  getGenomeDataWorkerThreadStats,
} from './genome-data-worker-thread-client';
import type {
  GenomeDataThreadRequest,
  GenomeDataThreadResponse,
} from './genome-data-worker-thread-protocol';

const workerFactory = vi.hoisted(() => ({
  current: null as Worker | null,
}));

vi.mock('./genome-data-worker-thread-entry?nodeWorker', () => ({
  default: () => {
    if (!workerFactory.current) throw new Error('test worker was not installed');
    return workerFactory.current;
  },
}));

import {
  closeFailedGenomeDataWorkerThreadSources,
  createGenomeDataWorkerThreadSource,
} from './genome-data-worker-thread-factory';

const manifest: IndexedGenomeManifest = {
  chrom: 'chrI',
  fastaPath: '/tmp/chrI.fa',
  faiPath: '/tmp/chrI.fa.fai',
};

describe('createGenomeDataWorkerThreadSource', () => {
  it('terminates and releases a worker whose initialization rejects', async () => {
    const worker = new RejectingInitWorker();
    workerFactory.current = worker as unknown as Worker;
    const activeBefore = getGenomeDataWorkerThreadStats().activeWorkers;

    await expect(createGenomeDataWorkerThreadSource(manifest)).rejects.toThrow(
      'injected initialization failure'
    );

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(getGenomeDataWorkerThreadStats().activeWorkers).toBe(activeBefore);
    expect(worker.listenerCount()).toBe(0);
  });

  it('cancels initialization and physically terminates the worker when its owner leaves', async () => {
    const worker = new HangingInitWorker();
    workerFactory.current = worker as unknown as Worker;
    const activeBefore = getGenomeDataWorkerThreadStats().activeWorkers;
    const controller = new AbortController();

    const creation = createGenomeDataWorkerThreadSource(manifest, undefined, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(creation).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(getGenomeDataWorkerThreadStats().activeWorkers).toBe(activeBefore);
    expect(worker.listenerCount()).toBe(0);
  });

  it('retains worker accounting after termination fails and allows a later close retry', async () => {
    const worker = new SuccessfulInitWorker();
    worker.terminate.mockRejectedValueOnce(new Error('terminate failed'));
    const activeBefore = getGenomeDataWorkerThreadStats().activeWorkers;
    const source = new GenomeDataWorkerThreadSource(worker as unknown as Worker);
    await source.init(manifest);

    await expect(source.close()).rejects.toThrow('terminate failed');
    expect(getGenomeDataWorkerThreadStats().activeWorkers).toBe(activeBefore + 1);
    expect(worker.listenerCount()).toBe(0);

    await expect(source.close()).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledTimes(2);
    expect(getGenomeDataWorkerThreadStats().activeWorkers).toBe(activeBefore);
  });

  it('quarantines a failed initialization owner until its termination can be retried', async () => {
    const worker = new RejectingInitWorker();
    worker.terminate.mockRejectedValueOnce(new Error('terminate failed'));
    workerFactory.current = worker as unknown as Worker;
    const activeBefore = getGenomeDataWorkerThreadStats().activeWorkers;

    await expect(createGenomeDataWorkerThreadSource(manifest)).rejects.toThrow(
      'initialization and termination both failed'
    );
    expect(getGenomeDataWorkerThreadStats().activeWorkers).toBe(activeBefore + 1);

    await expect(closeFailedGenomeDataWorkerThreadSources()).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledTimes(2);
    expect(getGenomeDataWorkerThreadStats().activeWorkers).toBe(activeBefore);
  });
});

class RejectingInitWorker {
  private readonly listeners = new Map<string, Set<(message: unknown) => void>>();
  readonly terminate = vi.fn(async () => undefined);

  on(event: string, listener: (message: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (message: unknown) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  postMessage(message: GenomeDataThreadRequest): void {
    if (message.type !== 'init') return;
    queueMicrotask(() => {
      this.emit('message', {
        id: message.id,
        type: 'error',
        error: { name: 'Error', message: 'injected initialization failure' },
      });
    });
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }

  private emit(event: string, message: GenomeDataThreadResponse): void {
    for (const listener of this.listeners.get(event) ?? []) listener(message);
  }
}

class HangingInitWorker {
  private readonly listeners = new Map<string, Set<(message: unknown) => void>>();
  readonly terminate = vi.fn(async () => undefined);

  on(event: string, listener: (message: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (message: unknown) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  postMessage(_message: GenomeDataThreadRequest): void {}

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

class SuccessfulInitWorker {
  private readonly listeners = new Map<string, Set<(message: unknown) => void>>();
  readonly terminate = vi.fn(async () => undefined);

  on(event: string, listener: (message: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (message: unknown) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  postMessage(message: GenomeDataThreadRequest): void {
    if (message.type !== 'init') return;
    queueMicrotask(() => {
      this.emit('message', { id: message.id, type: 'result', result: undefined });
    });
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }

  private emit(event: string, message: GenomeDataThreadResponse): void {
    for (const listener of this.listeners.get(event) ?? []) listener(message);
  }
}
