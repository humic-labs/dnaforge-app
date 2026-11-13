import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { runAssemblyCompiledBroadRasterWorkerV1 } from './assembly-compiled-broad-raster-worker-client';
import type {
  AssemblyCompiledBroadRasterWorkerJobV1,
  AssemblyCompiledBroadRasterWorkerResultV1,
} from './assembly-compiled-broad-raster-worker-job';

const JOB = { scenePath: '/ws/scene.bin' } as AssemblyCompiledBroadRasterWorkerJobV1;
const RESULT: AssemblyCompiledBroadRasterWorkerResultV1 = {
  status: 'published',
  sourceFingerprint: 'a'.repeat(24),
  surfaceManifestFingerprint: 'b'.repeat(64),
  catalogFingerprint: 'c'.repeat(64),
  quarantinedCorruptArtifact: false,
};

class FakeWorker extends EventEmitter {
  readonly messages: unknown[] = [];
  terminateCount = 0;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  async terminate(): Promise<number> {
    this.terminateCount += 1;
    return 0;
  }
}

describe('finite compiled broad raster worker client', () => {
  it('terminates after success and posts exactly one job', async () => {
    const worker = new FakeWorker();
    const pending = runAssemblyCompiledBroadRasterWorkerV1(JOB, {
      createWorker: () => worker as unknown as Worker,
    });
    worker.emit('message', { type: 'result', result: RESULT });
    await expect(pending).resolves.toEqual(RESULT);
    expect(worker.messages).toEqual([{ type: 'prepare', job: JOB }]);
    expect(worker.terminateCount).toBe(1);
  });

  it('terminates on crash, structured failure, and abort', async () => {
    const crashed = new FakeWorker();
    const crashedPending = runAssemblyCompiledBroadRasterWorkerV1(JOB, {
      createWorker: () => crashed as unknown as Worker,
    });
    crashed.emit('exit', 9);
    await expect(crashedPending).rejects.toThrow(/exited before completion/);
    expect(crashed.terminateCount).toBe(1);

    const failed = new FakeWorker();
    const failedPending = runAssemblyCompiledBroadRasterWorkerV1(JOB, {
      createWorker: () => failed as unknown as Worker,
    });
    failed.emit('message', {
      type: 'error',
      error: { name: 'RasterPreparationError', message: 'compiler failed' },
    });
    await expect(failedPending).rejects.toMatchObject({
      name: 'RasterPreparationError',
      message: 'compiler failed',
    });
    expect(failed.terminateCount).toBe(1);

    const aborted = new FakeWorker();
    const controller = new AbortController();
    const abortedPending = runAssemblyCompiledBroadRasterWorkerV1(JOB, {
      createWorker: () => aborted as unknown as Worker,
      signal: controller.signal,
    });
    controller.abort();
    await expect(abortedPending).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted.terminateCount).toBe(1);
  });
});
