import { describe, it, expect } from 'vitest';
import { createKeyedMutex } from './keyed-mutex';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createKeyedMutex  A9 — per-repo commit serialization)', () => {
  it('serializes operations with the SAME key — never overlapping', async () => {
    const mutex = createKeyedMutex();
    const log: string[] = [];
    const gate1 = deferred<void>();
    const gate2 = deferred<void>();

    const p1 = mutex('repo', async () => {
      log.push('enter:1');
      await gate1.promise;
      log.push('exit:1');
    });
    const p2 = mutex('repo', async () => {
      log.push('enter:2');
      await gate2.promise;
      log.push('exit:2');
    });

    await flush();
    expect(log).toEqual(['enter:1']);
    gate1.resolve();
    await flush();
    expect(log).toEqual(['enter:1', 'exit:1', 'enter:2']);
    gate2.resolve();
    await Promise.all([p1, p2]);
    expect(log).toEqual(['enter:1', 'exit:1', 'enter:2', 'exit:2']);
  });

  it('runs DIFFERENT keys concurrently', async () => {
    const mutex = createKeyedMutex();
    const log: string[] = [];
    const gateA = deferred<void>();

    const pa = mutex('repoA', async () => {
      log.push('enter:A');
      await gateA.promise;
      log.push('exit:A');
    });
    const pb = mutex('repoB', async () => {
      log.push('enter:B');
    });

    await pb;
    expect(log).toEqual(['enter:A', 'enter:B']);
    gateA.resolve();
    await pa;
  });

  it('is error-isolating — a rejected op does not wedge the next op for that key', async () => {
    const mutex = createKeyedMutex();
    await expect(
      mutex('repo', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const result = await mutex('repo', async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('returns each operation’s own result', async () => {
    const mutex = createKeyedMutex();
    const [a, b] = await Promise.all([mutex('repo', async () => 1), mutex('repo', async () => 2)]);
    expect([a, b]).toEqual([1, 2]);
  });
});
