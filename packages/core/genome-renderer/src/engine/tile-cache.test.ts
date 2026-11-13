import { describe, it, expect } from 'vitest';
import { TileCache, type TileEntry } from './tile-cache';
import {
  assertCountBound,
  assertByteBound,
  assertLruTouch,
  assertPinProtection,
  assertEvictAbortsPending,
  assertEvictDisposesGpu,
  key,
  readyEntry,
  readyData,
} from './tile-cache-assertions';

function makeCache(maxEntries: number, maxBytes: number, disposed: unknown[] = []) {
  return new TileCache({
    maxEntries,
    maxBytes,
    disposeTile: (e: TileEntry) => disposed.push(e.gpu),
  });
}

describe('engine/tile-cache — byte+count LRU, sync onEvict, pin protection', () => {
  it('count bound: never more than maxEntries resident (LRU)', () =>
    assertCountBound(makeCache(3, 1e9)));
  it('byte bound: never more than maxBytes resident', () => assertByteBound(makeCache(100, 100)));
  it('LRU touch: get() promotes an entry', () => assertLruTouch(makeCache(3, 1e9)));
  it('pin protection: pinned entry is never the eviction victim', () =>
    assertPinProtection(makeCache(3, 1e9)));
  it('soft retention survives viewport cleanup but yields to newly visible admission', () => {
    const cache = makeCache(2, 1e9);
    const a = key(0, 0);
    const b = key(0, 1);
    const current = key(0, 2);
    cache.set(readyEntry(a, 10));
    cache.set(readyEntry(b, 10));
    cache.setRetained([a, b]);

    expect(cache.evict(a), 'normal cleanup respects soft retention').toBe(false);
    cache.set(readyEntry(current, 10));

    expect(cache.size).toBe(2);
    expect(
      cache.has(current),
      'new current work must never self-evict behind retained history'
    ).toBe(true);
    expect(cache.has(a), 'capacity admission evicts the oldest soft-retained entry').toBe(false);
    expect(cache.has(b)).toBe(true);
  });
  it('onEvict aborts a pending fetch synchronously', () =>
    assertEvictAbortsPending(makeCache(100, 1e9)));
  it('authority cancellation aborts matching pending work despite pins/retention', () => {
    const cache = makeCache(100, 1e9);
    const obsolete = key(0, 0);
    const unrelated = key(0, 1);
    const obsoleteAbort = new AbortController();
    const unrelatedAbort = new AbortController();
    cache.set({
      key: obsolete,
      state: 'pending',
      epoch: 1,
      byteSize: 0,
      abort: obsoleteAbort,
    });
    cache.set({
      key: unrelated,
      state: 'pending',
      epoch: 1,
      byteSize: 0,
      abort: unrelatedAbort,
    });
    cache.setPins([obsolete]);
    cache.setRetained([obsolete]);

    expect(cache.cancelPendingWhere((entry) => entry.key.index === 0)).toBe(1);
    expect(obsoleteAbort.signal.aborted).toBe(true);
    expect(cache.has(obsolete)).toBe(false);
    expect(unrelatedAbort.signal.aborted).toBe(false);
    expect(cache.has(unrelated)).toBe(true);
  });
  it('onEvict disposes a ready tile GPU handle', () => {
    const disposed: unknown[] = [];
    assertEvictDisposesGpu(makeCache(100, 1e9, disposed), disposed);
  });

  it('resolve(): pending → ready re-prices bytes and clears the abort', () => {
    const cache = makeCache(100, 1e9);
    const ac = new AbortController();
    cache.set({ key: key(0, 0), state: 'pending', epoch: 1, byteSize: 0, abort: ac });
    expect(cache.byteSize).toBe(0);
    cache.resolve(key(0, 0), readyData(key(0, 0), 500), { id: 'g' });
    const e = cache.peek(key(0, 0))!;
    expect(e.state).toBe('ready');
    expect(e.byteSize).toBe(500);
    expect(cache.byteSize).toBe(500);
    expect(e.abort).toBeUndefined();
  });

  it('replacing an entry re-prices bytes (no double count)', () => {
    const cache = makeCache(100, 1e9);
    cache.set(readyEntry(key(0, 0), 30));
    cache.set(readyEntry(key(0, 0), 70));
    expect(cache.size).toBe(1);
    expect(cache.byteSize).toBe(70);
  });

  it('peek does NOT touch LRU order (only get does)', () => {
    const cache = makeCache(3, 1e9);
    cache.set(readyEntry(key(0, 0), 10));
    cache.set(readyEntry(key(0, 1), 10));
    cache.set(readyEntry(key(0, 2), 10));
    cache.peek(key(0, 0));
    cache.set(readyEntry(key(0, 3), 10));
    expect(cache.has(key(0, 0))).toBe(false);
  });

  it('clear() disposes/aborts everything and zeroes bytes', () => {
    const disposed: unknown[] = [];
    const cache = makeCache(100, 1e9, disposed);
    cache.set(readyEntry(key(0, 0), 10, { id: 'a' }));
    cache.set(readyEntry(key(0, 1), 10, { id: 'b' }));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
    expect(disposed.length).toBe(2);
  });
});
