// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { TextIntervalReaderWorkerClient } from './text-interval-reader-worker-client';
import type {
  TextIntervalReaderWorkerLike,
  TextIntervalReaderWorkerRequest,
  TextIntervalReaderWorkerResponse,
} from './text-interval-reader-worker-protocol';

class FakeWorker implements TextIntervalReaderWorkerLike {
  readonly requests: TextIntervalReaderWorkerRequest[] = [];
  readonly transfers: ReadonlyArray<Transferable>[] = [];
  private readonly messageListeners = new Set<
    (event: MessageEvent<TextIntervalReaderWorkerResponse>) => void
  >();
  private readonly failureListeners = new Map<
    'error' | 'messageerror',
    Set<(event: Event) => void>
  >([
    ['error', new Set()],
    ['messageerror', new Set()],
  ]);

  postMessage(
    message: TextIntervalReaderWorkerRequest,
    transfer: ReadonlyArray<Transferable> = []
  ): void {
    this.requests.push(message);
    this.transfers.push(transfer);
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener:
      | ((event: MessageEvent<TextIntervalReaderWorkerResponse>) => void)
      | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.add(
        listener as (event: MessageEvent<TextIntervalReaderWorkerResponse>) => void
      );
      return;
    }
    this.failureListeners.get(type)?.add(listener as (event: Event) => void);
  }

  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener:
      | ((event: MessageEvent<TextIntervalReaderWorkerResponse>) => void)
      | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(
        listener as (event: MessageEvent<TextIntervalReaderWorkerResponse>) => void
      );
      return;
    }
    this.failureListeners.get(type)?.delete(listener as (event: Event) => void);
  }

  respond(
    id: number,
    result: Extract<TextIntervalReaderWorkerResponse, { type: 'result' }>['result']
  ): void {
    const event = new MessageEvent<TextIntervalReaderWorkerResponse>('message', {
      data: { id, type: 'result', result },
    });
    for (const listener of this.messageListeners) listener(event);
  }
}

describe('TextIntervalReaderWorkerClient', () => {
  it('transfers source bytes once and returns the parsed source summary', async () => {
    const worker = new FakeWorker();
    const client = new TextIntervalReaderWorkerClient(worker);
    const bytes = new TextEncoder().encode('chr1\t10\t20\n');
    const pending = client.open('source', 'bed', bytes);

    expect(worker.requests[0]).toMatchObject({
      id: 1,
      type: 'open',
      sourceKey: 'source',
      formatId: 'bed',
    });
    expect(worker.transfers[0]).toHaveLength(1);
    const summary = {
      formatId: 'bed' as const,
      scientificKind: 'interval' as const,
      referenceExtents: [{ name: 'chr1', maxEnd: 20 }],
      recordCount: 1,
      sourceByteLength: bytes.byteLength,
      decodedByteLength: bytes.byteLength,
      contentSha256: `sha256:${'a'.repeat(64)}`,
    };
    worker.respond(worker.requests[0].id, summary);

    await expect(pending).resolves.toEqual(summary);
  });

  it('forwards bounded regional query options and cancels aborted work', async () => {
    const worker = new FakeWorker();
    const client = new TextIntervalReaderWorkerClient(worker);
    const controller = new AbortController();
    const pending = client.query(
      'source',
      [{ refName: 'chr1', start: 100, end: 200 }],
      { maxRecords: 1_000, maxOverlap: 32, densityBinCount: 256 },
      controller.signal
    );

    expect(worker.requests[0]).toEqual({
      id: 1,
      type: 'query',
      sourceKey: 'source',
      regions: [{ refName: 'chr1', start: 100, end: 200 }],
      options: { maxRecords: 1_000, maxOverlap: 32, densityBinCount: 256 },
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.requests[1]).toEqual({ id: 2, type: 'cancel', targetId: 1 });
  });
});
