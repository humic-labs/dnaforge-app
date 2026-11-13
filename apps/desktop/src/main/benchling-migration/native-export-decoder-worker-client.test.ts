import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import { describe, expect, it, vi } from 'vitest';

import { decodeLocalNativeExportInDedicatedWorker } from './native-export-decoder-worker-client';

class FakeWorker extends EventEmitter {
  readonly messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
}

describe('native export decoder worker client', () => {
  it('forwards measured object progress before the terminal worker result', async () => {
    const worker = new FakeWorker();
    const onProgress = vi.fn();
    const pending = decodeLocalNativeExportInDedicatedWorker(
      {} as never,
      () => worker as unknown as Worker,
      onProgress
    );
    await Promise.resolve();

    worker.emit('message', {
      type: 'progress',
      progress: { completed: 64, total: 17_604 },
    });
    expect(onProgress).toHaveBeenCalledWith({ completed: 64, total: 17_604 });

    worker.emit('message', {
      type: 'error',
      error: { name: 'Error', message: 'finished test' },
    });
    await expect(pending).rejects.toThrow('finished test');
  });
});
