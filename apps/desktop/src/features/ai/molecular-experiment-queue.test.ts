import { describe, expect, it } from 'vitest';
import { runMolecularExperimentQueue } from './molecular-experiment-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('continuous molecular experiment queue', () => {
  it('stops new dispatch while finishing already active work', async () => {
    const gate = deferred();
    const stop = new AbortController();
    const started: number[] = [];
    const running = runMolecularExperimentQueue(
      [0, 1, 2, 3],
      2,
      async (job) => {
        started.push(job);
        if (job === 0) {
          await Promise.resolve();
          stop.abort();
        } else await gate.promise;
        return job;
      },
      stop.signal
    );
    await new Promise((done) => setTimeout(done, 0));
    expect(started).toEqual([0, 1]);
    gate.resolve();
    expect(await running).toEqual([
      { status: 'fulfilled', value: 0 },
      { status: 'fulfilled', value: 1 },
    ]);
  });

  it('reuses a finished slot while a slower attempt is still running', async () => {
    const gates = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const run = runMolecularExperimentQueue([0, 1, 2, 3, 4], 3, async (job) => {
      started.push(job);
      peak = Math.max(peak, ++active);
      await gates[job].promise;
      active--;
      return job * 10;
    });
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[1].resolve();
    await new Promise((done) => setTimeout(done, 0));
    expect(started).toEqual([0, 1, 2, 3]);
    expect(active).toBe(3);
    gates[3].resolve();
    await new Promise((done) => setTimeout(done, 0));
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates.forEach((gate) => gate.resolve());
    expect(await run).toEqual(
      [0, 10, 20, 30, 40].map((value) => ({
        status: 'fulfilled',
        value,
      }))
    );
    expect(peak).toBe(3);
  });

  it('records a failed attempt and continues to use that slot', async () => {
    const error = new Error('Scene failed');
    const results = await runMolecularExperimentQueue([0, 1, 2], 1, async (job) => {
      if (job === 1) throw error;
      return job;
    });
    expect(results).toEqual([
      { status: 'fulfilled', value: 0 },
      { status: 'rejected', reason: error },
      { status: 'fulfilled', value: 2 },
    ]);
  });

  it('rejects invalid concurrency before starting an attempt', async () => {
    let started = false;
    for (const concurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        runMolecularExperimentQueue([0], concurrency, async () => {
          started = true;
        })
      ).rejects.toThrow('positive integer');
    }
    expect(started).toBe(false);
  });
});
