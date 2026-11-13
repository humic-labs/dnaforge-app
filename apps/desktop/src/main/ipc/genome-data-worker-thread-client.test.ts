import type { Worker } from 'node:worker_threads';

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_GENOME_DATA_WORKER_PENDING_REQUESTS,
  GenomeDataWorkerThreadSource,
} from './genome-data-worker-thread-client';
import type {
  GenomeDataThreadRequest,
  GenomeDataThreadResponse,
} from './genome-data-worker-thread-protocol';

describe('GenomeDataWorkerThreadSource', () => {
  it('cancels pending range requests when their abort signal fires', async () => {
    const worker = new FakeNodeWorker({ keepFeaturesOpen: true });
    const source = new GenomeDataWorkerThreadSource(worker as unknown as Worker);
    const controller = new AbortController();

    const request = source.getFeatures('chrI', 1, 4, 1, { signal: controller.signal });
    const featureMessage = worker.messages.find((message) => message.type === 'getFeatures');

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.messages).toContainEqual({
      id: expect.any(Number),
      type: 'cancel',
      targetId: featureMessage?.id,
    });
    await source.close();
  });

  it('locally rejects an aborted streaming search when the worker never acknowledges cancel', async () => {
    const worker = new FakeNodeWorker({ keepSearchOpen: true });
    const source = new GenomeDataWorkerThreadSource(worker as unknown as Worker);
    const controller = new AbortController();
    const iterator = source
      .searchSequence('chrI', 'ACGT', { signal: controller.signal })
      [Symbol.asyncIterator]();
    const next = iterator.next();
    const searchMessage = worker.messages.find((message) => message.type === 'searchSequence');

    controller.abort();

    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.messages).toContainEqual({
      id: expect.any(Number),
      type: 'cancel',
      targetId: searchMessage?.id,
    });
    if (searchMessage) {
      worker.emitMessage({ id: searchMessage.id, type: 'result', result: undefined });
    }
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    await source.close();
  });

  it('bounds physical jobs until the worker acknowledges cancellation', async () => {
    const worker = new FakeNodeWorker({ keepFeaturesOpen: true });
    const source = new GenomeDataWorkerThreadSource(worker as unknown as Worker);
    const controllers = Array.from(
      { length: MAX_GENOME_DATA_WORKER_PENDING_REQUESTS },
      () => new AbortController()
    );
    const requests = controllers.map((controller, index) =>
      source.getFeatures('chrI', index, index + 1, 1, { signal: controller.signal })
    );

    await expect(source.getFeatures('chrI', 100, 101, 1)).rejects.toThrow(
      'Genome data worker request capacity is full'
    );
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const abortedIterator = source
      .searchSequence('chrI', 'ACGT', { signal: alreadyAborted.signal })
      [Symbol.asyncIterator]();
    await expect(abortedIterator.next()).rejects.toMatchObject({ name: 'AbortError' });

    controllers[0]?.abort();
    await expect(requests[0]).rejects.toMatchObject({ name: 'AbortError' });
    await expect(source.getFeatures('chrI', 100, 101, 1)).rejects.toThrow(
      'Genome data worker request capacity is full'
    );

    const firstRequest = worker.messages.find(
      (message) => message.type === 'getFeatures' && message.start === 0
    );
    expect(firstRequest).toBeDefined();
    if (firstRequest) {
      worker.emitMessage({
        id: firstRequest.id,
        type: 'error',
        error: { name: 'AbortError', message: 'cancelled' },
      });
    }

    const replacementController = new AbortController();
    const replacement = source.getFeatures('chrI', 100, 101, 1, {
      signal: replacementController.signal,
    });
    expect(worker.messages.filter((message) => message.type === 'getFeatures')).toHaveLength(
      MAX_GENOME_DATA_WORKER_PENDING_REQUESTS + 1
    );

    for (const controller of controllers.slice(1)) controller.abort();
    replacementController.abort();
    await Promise.allSettled([...requests.slice(1), replacement]);
    await source.close();
  });

  it('reports physical settlement only after an aborted worker job reaches a terminal response', async () => {
    const worker = new FakeNodeWorker({ keepFeaturesOpen: true });
    const source = new GenomeDataWorkerThreadSource(worker as unknown as Worker);
    const controller = new AbortController();
    const physicalLifecycle = { started: vi.fn(), settled: vi.fn() };
    const request = source.getFeatures('chrI', 1, 4, 1, {
      signal: controller.signal,
      physicalLifecycle,
    });
    const featureMessage = worker.messages.find((message) => message.type === 'getFeatures');

    expect(physicalLifecycle.started).toHaveBeenCalledOnce();
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(physicalLifecycle.settled).not.toHaveBeenCalled();

    expect(featureMessage).toBeDefined();
    if (featureMessage) {
      worker.emitMessage({
        id: featureMessage.id,
        type: 'error',
        error: { name: 'AbortError', message: 'cancelled' },
      });
    }
    expect(physicalLifecycle.settled).toHaveBeenCalledOnce();

    await source.close();
  });

  it('reports streaming-search physical settlement only after worker termination', async () => {
    const worker = new FakeNodeWorker({ keepSearchOpen: true });
    const source = new GenomeDataWorkerThreadSource(worker as unknown as Worker);
    const controller = new AbortController();
    const physicalLifecycle = { started: vi.fn(), settled: vi.fn() };
    const iterator = source
      .searchSequenceWithPhysicalLifecycle('chrI', 'ACGT', {
        signal: controller.signal,
        physicalLifecycle,
      })
      [Symbol.asyncIterator]();
    const next = iterator.next();
    const searchMessage = worker.messages.find((message) => message.type === 'searchSequence');

    expect(physicalLifecycle.started).toHaveBeenCalledOnce();
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(physicalLifecycle.settled).not.toHaveBeenCalled();

    expect(searchMessage).toBeDefined();
    if (searchMessage) {
      worker.emitMessage({ id: searchMessage.id, type: 'result', result: undefined });
    }
    expect(physicalLifecycle.settled).toHaveBeenCalledOnce();

    await source.close();
  });
});

class FakeNodeWorker {
  private readonly listeners = new Map<string, Set<(message: unknown) => void>>();
  readonly messages: GenomeDataThreadRequest[] = [];
  readonly terminate = vi.fn(async () => undefined);

  constructor(
    private readonly opts: { keepFeaturesOpen?: boolean; keepSearchOpen?: boolean } = {}
  ) {}

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
    this.messages.push(message);
    if (message.type === 'cancel') return;
    if (message.type === 'searchSequence' && this.opts.keepSearchOpen) return;
    if (message.type === 'getFeatures' && this.opts.keepFeaturesOpen) return;
    if (message.type === 'getFeatures') {
      this.emit('message', { id: message.id, type: 'result', result: [] });
    }
  }

  emitMessage(message: GenomeDataThreadResponse): void {
    this.emit('message', message);
  }

  private emit(event: string, message: GenomeDataThreadResponse): void {
    for (const listener of this.listeners.get(event) ?? []) listener(message);
  }
}
