import { describe, expect, it, vi } from 'vitest';

import { RemoteByteCache } from './remote-byte-cache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('RemoteByteCache ownership and bounds', () => {
  it('shares one fetch and preserves it when one reader cancels', async () => {
    const cache = new RemoteByteCache();
    const data = deferred<Buffer>();
    let fetching!: AbortSignal;
    const load = vi.fn((signal: AbortSignal) => {
      fetching = signal;
      return data.promise;
    });
    const first = new AbortController();
    const second = new AbortController();
    const abandoned = cache.get('source:1:alignment:0', load, first.signal);
    const remaining = cache.get('source:1:alignment:0', load, second.signal);
    first.abort();
    await expect(abandoned).rejects.toThrow('cancelled');
    expect(fetching.aborted).toBe(false);
    data.resolve(Buffer.from('exact bytes'));
    await expect(remaining).resolves.toEqual(Buffer.from('exact bytes'));
    expect(load).toHaveBeenCalledOnce();
  });

  it('holds active capacity until an abandoned upstream is reaped and never starts abandoned queued work', async () => {
    const cache = new RemoteByteCache(128, 1, 3);
    const data = deferred<Buffer>();
    let fetching!: AbortSignal;
    const active = new AbortController();
    const queued = new AbortController();
    const first = cache.get(
      'source:1:alignment:0',
      (signal) => {
        fetching = signal;
        return data.promise;
      },
      active.signal
    );
    const queuedLoad = vi.fn(async () => Buffer.from('unused'));
    const second = cache.get('source:1:alignment:1', queuedLoad, queued.signal);
    const thirdLoad = vi.fn(async () => Buffer.from('next'));
    const third = cache.get('other:1:alignment:0', thirdLoad, new AbortController().signal);
    active.abort();
    queued.abort();
    await expect(first).rejects.toThrow('cancelled');
    await expect(second).rejects.toThrow('cancelled');
    expect(fetching.aborted).toBe(true);
    expect(queuedLoad).not.toHaveBeenCalled();
    expect(thirdLoad).not.toHaveBeenCalled();
    data.reject(new Error('owned request closed'));
    await expect(third).resolves.toEqual(Buffer.from('next'));
    expect(queuedLoad).not.toHaveBeenCalled();
  });

  it('bounds pending unique fetches while allowing existing readers to join', async () => {
    const cache = new RemoteByteCache(128, 1, 1);
    const data = deferred<Buffer>();
    const signal = new AbortController().signal;
    const first = cache.get('source:1:alignment:0', () => data.promise, signal);
    const joined = cache.get('source:1:alignment:0', vi.fn(), signal);
    await expect(cache.get('other:1:alignment:0', vi.fn(), signal)).rejects.toThrow(
      'queue is full'
    );
    data.resolve(Buffer.from('same'));
    await expect(Promise.all([first, joined])).resolves.toEqual([
      Buffer.from('same'),
      Buffer.from('same'),
    ]);
  });

  it('evicts the least recently read blocks across sources under one memory allowance', async () => {
    const cache = new RemoteByteCache(8);
    const signal = new AbortController().signal;
    const a = vi.fn(async () => Buffer.from('aaaa'));
    const b = vi.fn(async () => Buffer.from('bbbb'));
    const c = vi.fn(async () => Buffer.from('cccc'));
    await cache.get('source:1:alignment:0', a, signal);
    await cache.get('other:1:signal:0', b, signal);
    await cache.get('source:1:alignment:0', a, signal);
    await cache.get('third:1:alignment:0', c, signal);
    await cache.get('source:1:alignment:0', a, signal);
    expect(a).toHaveBeenCalledOnce();
    await cache.get('other:1:signal:0', b, signal);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the exact source and waits for its cancelled fetches', async () => {
    const cache = new RemoteByteCache();
    const signal = new AbortController().signal;
    const source = vi.fn(async () => Buffer.from('old'));
    const sibling = vi.fn(async () => Buffer.from('sibling'));
    await cache.get('source:1:alignment:0', source, signal);
    await cache.get('source-other:1:signal:0', sibling, signal);
    const data = deferred<Buffer>();
    let fetching!: AbortSignal;
    const pending = cache.get(
      'source:1:alignment:1',
      (fetchSignal) => {
        fetching = fetchSignal;
        return data.promise;
      },
      signal
    );
    const rejected = expect(pending).rejects.toThrow('closed');
    let finished = false;
    const invalidating = cache.invalidateSource('source').then(() => {
      finished = true;
    });
    expect(fetching.aborted).toBe(true);
    await Promise.resolve();
    expect(finished).toBe(false);
    data.reject(new Error('closed'));
    await Promise.all([invalidating, rejected]);
    await cache.get('source:1:alignment:0', source, signal);
    await cache.get('source-other:1:signal:0', sibling, signal);
    expect(source).toHaveBeenCalledTimes(2);
    expect(sibling).toHaveBeenCalledOnce();
  });

  it('never retains a failed fetch', async () => {
    const cache = new RemoteByteCache();
    const signal = new AbortController().signal;
    await expect(
      cache.get(
        'source:1:alignment:0',
        async () => {
          throw new Error('truncated');
        },
        signal
      )
    ).rejects.toThrow('truncated');
    const fresh = vi.fn(async () => Buffer.from('complete'));
    await expect(cache.get('source:1:alignment:0', fresh, signal)).resolves.toEqual(
      Buffer.from('complete')
    );
    expect(fresh).toHaveBeenCalledOnce();
  });
});
