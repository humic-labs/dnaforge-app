// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { BbiReaderWorkerClient } from './bbi-reader-worker-client';
import type {
  BbiReaderWorkerLike,
  BbiReaderWorkerRequest,
  BbiReaderWorkerResponse,
} from './bbi-reader-worker-protocol';

class FakeWorker implements BbiReaderWorkerLike {
  readonly requests: BbiReaderWorkerRequest[] = [];
  private readonly messageListeners = new Set<
    (event: MessageEvent<BbiReaderWorkerResponse>) => void
  >();
  private readonly failureListeners = new Map<
    'error' | 'messageerror',
    Set<(event: Event) => void>
  >([
    ['error', new Set()],
    ['messageerror', new Set()],
  ]);

  postMessage(message: BbiReaderWorkerRequest): void {
    this.requests.push(message);
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<BbiReaderWorkerResponse>) => void) | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.add(listener as (event: MessageEvent<BbiReaderWorkerResponse>) => void);
      return;
    }
    this.failureListeners.get(type)?.add(listener as (event: Event) => void);
  }

  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<BbiReaderWorkerResponse>) => void) | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(
        listener as (event: MessageEvent<BbiReaderWorkerResponse>) => void
      );
      return;
    }
    this.failureListeners.get(type)?.delete(listener as (event: Event) => void);
  }

  fail(message: string): void {
    const event = new Event('error') as ErrorEvent;
    Object.defineProperty(event, 'message', { value: message });
    for (const listener of this.failureListeners.get('error') ?? []) listener(event);
  }

  respond(
    id: number,
    result: Extract<BbiReaderWorkerResponse, { type: 'result' }>['result']
  ): void {
    const event = new MessageEvent<BbiReaderWorkerResponse>('message', {
      data: { id, type: 'result', result },
    });
    for (const listener of this.messageListeners) listener(event);
  }
}

describe('BbiReaderWorkerClient', () => {
  it('requests bounded BigBed intervals and preserves BED columns for semantic adapters', async () => {
    const worker = new FakeWorker();
    const client = new BbiReaderWorkerClient(worker);
    const pending = client.queryIntervals(
      'source',
      [{ refName: 'chr1', start: 100, end: 200 }],
      new AbortController().signal
    );

    expect(worker.requests[0]).toEqual({
      id: 1,
      type: 'query-intervals',
      sourceKey: 'source',
      regions: [{ refName: 'chr1', start: 100, end: 200 }],
    });
    worker.respond(worker.requests[0].id, [
      [
        {
          start: 120,
          end: 150,
          score: 960,
          rest: 'MYC\t960\t+\t120\t150\t255,0,0',
          uniqueId: 'block:1',
        },
      ],
    ]);

    await expect(pending).resolves.toEqual([
      [
        {
          start: 120,
          end: 150,
          score: 960,
          rest: 'MYC\t960\t+\t120\t150\t255,0,0',
          uniqueId: 'block:1',
        },
      ],
    ]);
  });

  it('reuses a live admitted reader and reopens it after the grant expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const worker = new FakeWorker();
    const client = new BbiReaderWorkerClient(worker);
    const grant = {
      baseUrl: 'http://127.0.0.1:8099',
      sourceUri: 'https://example.org/source.bw',
      sourceToken: 'source-token',
      canonicalUrlHash: 'canonical-hash',
      byteLength: 1024,
      provenanceId: 'provenance-id',
      expiresAtMs: 61_000,
    };
    const header = {
      fileType: 'bigwig' as const,
      references: [{ name: 'chr1', length: 100 }],
      zoomReductionLevels: [10],
    };

    const first = client.open('source', 'bigwig', grant);
    worker.respond(worker.requests[0].id, header);
    await expect(first).resolves.toEqual(header);
    await expect(client.open('source', 'bigwig', grant)).resolves.toEqual(header);
    expect(worker.requests).toHaveLength(1);

    now.mockReturnValue(32_000);
    const refreshed = client.open('source', 'bigwig', {
      ...grant,
      sourceToken: 'refreshed-token',
      expiresAtMs: 92_000,
    });
    worker.respond(worker.requests[1].id, header);
    await expect(refreshed).resolves.toEqual(header);
    expect(worker.requests).toHaveLength(2);
    now.mockRestore();
  });

  it('rejects pending and future work instead of hanging when the worker crashes', async () => {
    const worker = new FakeWorker();
    const client = new BbiReaderWorkerClient(worker);
    expect(client.hasFailed()).toBe(false);
    const grant = {
      baseUrl: 'http://127.0.0.1:8099',
      sourceUri: 'https://example.org/source.bw',
      sourceToken: 'source-token',
      canonicalUrlHash: 'canonical-hash',
      byteLength: 1024,
      provenanceId: 'provenance-id',
      expiresAtMs: Date.now() + 60_000,
    };

    const pending = client.open('source', 'bigwig', grant);
    worker.fail('worker script could not load');
    expect(client.hasFailed()).toBe(true);

    await expect(pending).rejects.toThrow(
      'BigWig reader worker failed: worker script could not load'
    );
    await expect(client.open('source', 'bigwig', grant)).rejects.toThrow(
      'BigWig reader worker failed: worker script could not load'
    );
  });
});
