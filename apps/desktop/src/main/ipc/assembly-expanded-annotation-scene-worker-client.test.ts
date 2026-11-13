import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import {
  runAssemblyAnnotationSearchWorker,
  runExpandedAnnotationSceneInventoryWorker,
  runExpandedAnnotationSceneWorker,
} from './assembly-expanded-annotation-scene-worker-client';
import type { AssemblyAnnotationSearchWorkerJob } from './assembly-annotation-search-compiler';
import type {
  ExpandedAnnotationSceneWorkerJob,
  ExpandedAnnotationSceneWorkerResult,
} from './assembly-expanded-annotation-scene-compiler';

const JOB = { request: { assemblyId: 'test' } } as unknown as ExpandedAnnotationSceneWorkerJob;
const RESULT: ExpandedAnnotationSceneWorkerResult = {
  status: 'committed',
  featureCount: 4,
  droppedCount: 1,
  primitiveCount: 8,
  byteCount: 128,
};

class FakeWorker extends EventEmitter {
  messages: unknown[] = [];
  terminateCount = 0;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  async terminate(): Promise<number> {
    this.terminateCount += 1;
    return 0;
  }
}

describe('finite expanded annotation-scene worker client', () => {
  it('forwards search progress without treating it as a terminal worker response', async () => {
    const worker = new FakeWorker();
    const progress: unknown[] = [];
    const searchJob = JOB as unknown as AssemblyAnnotationSearchWorkerJob;
    const pending = runAssemblyAnnotationSearchWorker(searchJob, {
      createWorker: () => worker as unknown as Worker,
      onAnnotationSearchProgress: (update) => progress.push(update),
    });
    worker.emit('message', {
      type: 'search-progress',
      progress: {
        sequence: 1,
        phase: 'reading-sources',
        completed: 1,
        total: 2,
        chromosome: 'chr1',
      },
    });
    worker.emit('message', {
      type: 'search-result',
      result: { status: 'committed', featureCount: 5, byteCount: 128 },
    });

    await expect(pending).resolves.toEqual({
      status: 'committed',
      featureCount: 5,
      byteCount: 128,
    });
    expect(progress).toEqual([
      {
        sequence: 1,
        phase: 'reading-sources',
        completed: 1,
        total: 2,
        chromosome: 'chr1',
      },
    ]);
    expect(worker.terminateCount).toBe(1);
  });

  it('terminates after success', async () => {
    const worker = new FakeWorker();
    const pending = runExpandedAnnotationSceneWorker(JOB, {
      createWorker: () => worker as unknown as Worker,
    });
    worker.emit('message', { type: 'result', result: RESULT });
    await expect(pending).resolves.toEqual(RESULT);
    expect(worker.messages).toEqual([{ type: 'compile', job: JOB }]);
    expect(worker.terminateCount).toBe(1);
  });

  it('returns source inventory and terminates its finite worker', async () => {
    const worker = new FakeWorker();
    const pending = runExpandedAnnotationSceneInventoryWorker(JOB, {
      createWorker: () => worker as unknown as Worker,
    });
    worker.emit('message', {
      type: 'inventory-result',
      result: { status: 'ready', trackTypes: ['gene', 'lnc_RNA', 'mRNA'] },
    });
    await expect(pending).resolves.toEqual({
      status: 'ready',
      trackTypes: ['gene', 'lnc_RNA', 'mRNA'],
    });
    expect(worker.messages).toEqual([{ type: 'inventory', job: JOB }]);
    expect(worker.terminateCount).toBe(1);
  });

  it('terminates and rejects on worker error or premature exit', async () => {
    const errored = new FakeWorker();
    const errorPending = runExpandedAnnotationSceneWorker(JOB, {
      createWorker: () => errored as unknown as Worker,
    });
    errored.emit('error', new Error('worker boom'));
    await expect(errorPending).rejects.toThrow('worker boom');
    expect(errored.terminateCount).toBe(1);

    const exited = new FakeWorker();
    const exitPending = runExpandedAnnotationSceneWorker(JOB, {
      createWorker: () => exited as unknown as Worker,
    });
    exited.emit('exit', 2);
    await expect(exitPending).rejects.toThrow(/exited/i);
    expect(exited.terminateCount).toBe(1);
  });

  it('terminates immediately when cancelled', async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const pending = runExpandedAnnotationSceneWorker(JOB, {
      createWorker: () => worker as unknown as Worker,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminateCount).toBe(1);
  });

  it('terminates after a structured worker failure', async () => {
    const worker = new FakeWorker();
    const pending = runExpandedAnnotationSceneWorker(JOB, {
      createWorker: () => worker as unknown as Worker,
    });
    worker.emit('message', {
      type: 'error',
      error: { name: 'ExpandedSceneError', message: 'cache envelope invalid' },
    });
    await expect(pending).rejects.toMatchObject({
      name: 'ExpandedSceneError',
      message: 'cache envelope invalid',
    });
    expect(worker.terminateCount).toBe(1);
  });
});
