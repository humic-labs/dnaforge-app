import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchHostedTextInDedicatedWorker } from './hosted-native-regex-worker-client';
import type {
  HostedNativeRegexWorkerJob,
  HostedNativeRegexWorkerResult,
} from './hosted-native-regex-worker-job';

const JOB: HostedNativeRegexWorkerJob = {
  source: 'result',
  caseSensitive: true,
  limit: 10,
  files: [{ path: '/workspace/result.txt', content: 'result' }],
};

const RESULT: HostedNativeRegexWorkerResult = {
  matches: [{ path: '/workspace/result.txt', line: 1, text: 'result' }],
  truncated: false,
};

class FakeWorker extends EventEmitter {
  readonly messages: unknown[] = [];
  terminateCount = 0;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): Promise<number> {
    this.terminateCount += 1;
    return Promise.resolve(0);
  }
}

describe('Hosted native regex worker client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts one validated result and terminates the dedicated worker', async () => {
    const worker = new FakeWorker();
    const pending = searchHostedTextInDedicatedWorker(JOB, {
      createWorker: () => worker as unknown as Worker,
      timeoutMs: 1_000,
    });
    await Promise.resolve();
    worker.emit('message', { type: 'result', result: RESULT });

    await expect(pending).resolves.toEqual(RESULT);
    expect(worker.messages).toEqual([JOB]);
    expect(worker.terminateCount).toBe(1);
  });

  it('terminates a worker that does not return within the fixed execution budget', async () => {
    const worker = new FakeWorker();
    const pending = searchHostedTextInDedicatedWorker(JOB, {
      createWorker: () => worker as unknown as Worker,
      timeoutMs: 5,
    });

    await expect(pending).rejects.toThrow(/safe execution time/i);
    expect(worker.terminateCount).toBe(1);
  });

  it('does not let an ambient test variable bypass the dedicated worker', async () => {
    vi.stubEnv('VITEST', 'true');
    const worker = new FakeWorker();
    const loadWorker = vi.fn(async () => worker as unknown as Worker);
    const pending = searchHostedTextInDedicatedWorker(JOB, {
      loadWorker,
      timeoutMs: 1_000,
    });
    await Promise.resolve();
    worker.emit('message', { type: 'result', result: RESULT });

    await expect(pending).resolves.toEqual(RESULT);
    expect(loadWorker).toHaveBeenCalledOnce();
    expect(worker.messages).toEqual([JOB]);
    expect(worker.terminateCount).toBe(1);
  });
});
