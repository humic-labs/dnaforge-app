// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { AnnotationViewportDetailAuthWorkerClient } from './annotation-viewport-detail-auth-worker-client';
import type {
  AnnotationViewportDetailAuthWorkerLike,
  AnnotationViewportDetailAuthWorkerRequest,
} from './annotation-viewport-detail-auth-worker-protocol';

class FakeWorker implements AnnotationViewportDetailAuthWorkerLike {
  readonly requests: AnnotationViewportDetailAuthWorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminateCount = 0;
  postMessageError: Error | null = null;
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  private readonly failureListeners = new Map<
    'error' | 'messageerror',
    Set<(event: Event) => void>
  >([
    ['error', new Set()],
    ['messageerror', new Set()],
  ]);

  postMessage(
    message: AnnotationViewportDetailAuthWorkerRequest,
    transfer: Transferable[] = []
  ): void {
    if (this.postMessageError) throw this.postMessageError;
    this.requests.push(message);
    this.transfers.push(transfer);
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
      return;
    }
    this.failureListeners.get(type)?.add(listener as (event: Event) => void);
  }

  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(listener as (event: MessageEvent<unknown>) => void);
      return;
    }
    this.failureListeners.get(type)?.delete(listener as (event: Event) => void);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  respond(response: unknown): void {
    for (const listener of this.messageListeners) {
      listener({ data: response } as MessageEvent<unknown>);
    }
  }

  listenerCount(): number {
    return (
      this.messageListeners.size +
      [...this.failureListeners.values()].reduce((count, listeners) => count + listeners.size, 0)
    );
  }
}

describe('AnnotationViewportDetailAuthWorkerClient', () => {
  it('transfers the packet out and terminates after the authenticated bytes return', async () => {
    const worker = new FakeWorker();
    const client = new AnnotationViewportDetailAuthWorkerClient(worker);
    const payload = new Uint8Array([1, 2, 3]);
    const returned = new Uint8Array([1, 2, 3]);

    const pending = client.authenticate(payload);
    expect(worker.requests).toEqual([{ id: 1, type: 'authenticate', payload }]);
    expect(worker.transfers).toEqual([[payload.buffer]]);
    worker.respond({
      id: 1,
      type: 'result',
      payload: returned,
      sha256: 'a'.repeat(64),
    });

    await expect(pending).resolves.toEqual({ payload: returned, sha256: 'a'.repeat(64) });
    expect(worker.terminateCount).toBe(1);
    expect(worker.listenerCount()).toBe(0);
  });

  it('terminates and releases listeners when cancellation wins', async () => {
    const worker = new FakeWorker();
    const client = new AnnotationViewportDetailAuthWorkerClient(worker);
    const controller = new AbortController();
    const pending = client.authenticate(new Uint8Array([1]), controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminateCount).toBe(1);
    worker.respond({
      id: 1,
      type: 'result',
      payload: new Uint8Array([1]),
      sha256: 'a'.repeat(64),
    });
    expect(worker.terminateCount).toBe(1);
  });

  it('fails closed and terminates when the worker result is malformed', async () => {
    const worker = new FakeWorker();
    const client = new AnnotationViewportDetailAuthWorkerClient(worker);
    const pending = client.authenticate(new Uint8Array([1]));

    worker.respond({
      id: 1,
      type: 'result',
      payload: new Uint8Array([1]),
      sha256: 'not-a-sha256',
    });

    await expect(pending).rejects.toThrow('invalid result');
    expect(worker.terminateCount).toBe(1);
    expect(worker.listenerCount()).toBe(0);
  });

  it('rejects a returned view that would retain unrelated worker bytes', async () => {
    const worker = new FakeWorker();
    const client = new AnnotationViewportDetailAuthWorkerClient(worker);
    const pending = client.authenticate(new Uint8Array([1, 2]));
    const sharedAllocation = new Uint8Array([9, 1, 2, 9]);

    worker.respond({
      id: 1,
      type: 'result',
      payload: sharedAllocation.subarray(1, 3),
      sha256: 'a'.repeat(64),
    });

    await expect(pending).rejects.toThrow('invalid result');
    expect(worker.terminateCount).toBe(1);
    expect(worker.listenerCount()).toBe(0);
  });

  it('fails closed and terminates for an unreadable response instead of leaking the worker', async () => {
    const worker = new FakeWorker();
    const client = new AnnotationViewportDetailAuthWorkerClient(worker);
    const pending = client.authenticate(new Uint8Array([1]));

    worker.respond(null);

    await expect(pending).rejects.toThrow('invalid result');
    expect(worker.terminateCount).toBe(1);
    expect(worker.listenerCount()).toBe(0);
  });

  it('fails closed and terminates for a response from the wrong request', async () => {
    const worker = new FakeWorker();
    const client = new AnnotationViewportDetailAuthWorkerClient(worker);
    const pending = client.authenticate(new Uint8Array([1]));

    worker.respond({
      id: 2,
      type: 'result',
      payload: new Uint8Array([1]),
      sha256: 'a'.repeat(64),
    });

    await expect(pending).rejects.toThrow('invalid result');
    expect(worker.terminateCount).toBe(1);
    expect(worker.listenerCount()).toBe(0);
  });

  it('terminates and releases listeners when sending the packet throws', async () => {
    const worker = new FakeWorker();
    worker.postMessageError = new Error('send failed');
    const client = new AnnotationViewportDetailAuthWorkerClient(worker);

    await expect(client.authenticate(new Uint8Array([1]))).rejects.toThrow('send failed');
    expect(worker.terminateCount).toBe(1);
    expect(worker.listenerCount()).toBe(0);
  });

  it('rejects concurrent reuse without displacing the first packet owner', async () => {
    const worker = new FakeWorker();
    const client = new AnnotationViewportDetailAuthWorkerClient(worker);
    const first = client.authenticate(new Uint8Array([1]));

    await expect(client.authenticate(new Uint8Array([2]))).rejects.toThrow('already consumed');
    expect(worker.requests).toHaveLength(1);
    worker.respond({
      id: 1,
      type: 'result',
      payload: new Uint8Array([1]),
      sha256: 'a'.repeat(64),
    });

    await expect(first).resolves.toMatchObject({ sha256: 'a'.repeat(64) });
    expect(worker.terminateCount).toBe(1);
    expect(worker.listenerCount()).toBe(0);
  });
});
