import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { parseAndValidateDesktopSyncLatestInDedicatedWorker } from './workspace-sync-latest-worker-client';

class FakeWorker extends EventEmitter {
  terminateCount = 0;
  throwOnPost = false;

  postMessage(): void {
    if (this.throwOnPost) throw new Error('postMessage failed');
  }

  async terminate(): Promise<number> {
    this.terminateCount += 1;
    return 0;
  }
}

describe('workspace sync latest worker client', () => {
  it('terminates a worker that never returns within the bounded deadline', async () => {
    const worker = new FakeWorker();

    await expect(
      parseAndValidateDesktopSyncLatestInDedicatedWorker(new Uint8Array([1]), {
        createWorker: () => worker as unknown as Worker,
        timeoutMs: 5,
      })
    ).rejects.toThrow(/execution deadline/i);

    expect(worker.terminateCount).toBe(1);
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    expect(worker.listenerCount('exit')).toBe(0);
  });

  it('terminates exactly once when postMessage throws synchronously', async () => {
    const worker = new FakeWorker();
    worker.throwOnPost = true;

    await expect(
      parseAndValidateDesktopSyncLatestInDedicatedWorker(new Uint8Array([1]), {
        createWorker: () => worker as unknown as Worker,
      })
    ).rejects.toThrow('postMessage failed');

    expect(worker.terminateCount).toBe(1);
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    expect(worker.listenerCount('exit')).toBe(0);
  });
});
