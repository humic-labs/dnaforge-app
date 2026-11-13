import { afterEach, describe, expect, it, vi } from 'vitest';

import { disposeBbiReaderWorkerClient, getBbiReaderWorkerClient } from './bbi-reader-runtime';
import type { BbiReaderWorkerRequest, BbiReaderWorkerResponse } from './bbi-reader-worker-protocol';

const state = vi.hoisted(() => ({
  workers: [] as Array<{
    dispatchEvent(event: Event): boolean;
    terminate: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('./bbi-reader-worker?worker&inline', () => ({
  default: class extends EventTarget {
    terminate = vi.fn();
    postMessage = vi.fn<(request: BbiReaderWorkerRequest) => void>();

    constructor() {
      super();
      state.workers.push(this);
    }
  },
}));

afterEach(() => {
  disposeBbiReaderWorkerClient();
  state.workers.length = 0;
});

function respond(worker: (typeof state.workers)[number], response: BbiReaderWorkerResponse): void {
  worker.dispatchEvent(new MessageEvent('message', { data: response }));
}

describe('shared BBI reader recovery', () => {
  it('replaces a crashed worker and completes the next track query', async () => {
    const failedClient = getBbiReaderWorkerClient();
    const pending = failedClient.queryIntervals('first-track', []);
    const rejected = expect(pending).rejects.toThrow('reader worker failed');
    state.workers[0]!.dispatchEvent(new ErrorEvent('error', { message: 'worker stopped' }));
    await rejected;

    const replacement = getBbiReaderWorkerClient();
    expect(replacement).not.toBe(failedClient);
    expect(state.workers).toHaveLength(2);
    expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();

    const next = replacement.queryIntervals('second-track', []);
    const request = state.workers[1]!.postMessage.mock.calls[0]![0] as BbiReaderWorkerRequest;
    respond(state.workers[1]!, { id: request.id, type: 'result', result: [] });
    await expect(next).resolves.toEqual([]);
    expect(getBbiReaderWorkerClient()).toBe(replacement);
  });

  it('keeps a healthy worker after an individual source read fails', async () => {
    const client = getBbiReaderWorkerClient();
    const pending = client.queryIntervals('missing-file', []);
    const rejected = expect(pending).rejects.toThrow('source missing');
    const request = state.workers[0]!.postMessage.mock.calls[0]![0] as BbiReaderWorkerRequest;
    respond(state.workers[0]!, {
      id: request.id,
      type: 'error',
      error: { name: 'Error', message: 'source missing' },
    });
    await rejected;
    expect(getBbiReaderWorkerClient()).toBe(client);
    expect(state.workers).toHaveLength(1);
  });
});
