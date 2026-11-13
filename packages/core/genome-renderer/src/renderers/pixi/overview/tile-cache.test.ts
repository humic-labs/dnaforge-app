import { describe, expect, it, vi } from 'vitest';
import { TileCache } from './tile-cache';

function makeCache(capacity: number) {
  const disposed: Array<[string, string]> = [];
  const dispose = vi.fn((key: string, value: string) => {
    disposed.push([key, value]);
  });
  const cache = new TileCache<string>({ capacity, dispose });
  return { cache, dispose, disposed };
}

describe('TileCache — basic get/has/set/size', () => {
  it('get returns the stored value and undefined for misses', () => {
    const { cache } = makeCache(4);
    cache.set('a', 'A');
    expect(cache.get('a')).toBe('A');
    expect(cache.get('missing')).toBeUndefined();
  });

  it('has reports membership without inserting', () => {
    const { cache } = makeCache(4);
    expect(cache.has('a')).toBe(false);
    cache.set('a', 'A');
    expect(cache.has('a')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('size tracks live entries', () => {
    const { cache } = makeCache(4);
    expect(cache.size).toBe(0);
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.size).toBe(2);
  });

  it('keys() are least-recently-used first, most-recently-used last', () => {
    const { cache } = makeCache(4);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    expect(cache.keys()).toEqual(['a', 'b', 'c']);
    cache.keys().push('zzz');
    expect(cache.keys()).toEqual(['a', 'b', 'c']);
  });
});

describe('TileCache — LRU eviction order', () => {
  it('evicts the least-recently-used entry on overflow', () => {
    const { cache, disposed } = makeCache(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    expect(cache.has('a')).toBe(false);
    expect(cache.keys()).toEqual(['b', 'c']);
    expect(disposed).toEqual([['a', 'A']]);
  });

  it('get bumps recency so a different entry is evicted', () => {
    const { cache, disposed } = makeCache(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.get('a')).toBe('A');
    cache.set('c', 'C');
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.keys()).toEqual(['a', 'c']);
    expect(disposed).toEqual([['b', 'B']]);
  });

  it('touch bumps recency without reading, redirecting eviction', () => {
    const { cache, disposed } = makeCache(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.touch('a');
    cache.set('c', 'C');
    expect(cache.keys()).toEqual(['a', 'c']);
    expect(disposed).toEqual([['b', 'B']]);
  });

  it('touch on an absent key is a no-op (no throw, no dispose)', () => {
    const { cache, dispose } = makeCache(2);
    cache.set('a', 'A');
    expect(() => cache.touch('nope')).not.toThrow();
    expect(cache.keys()).toEqual(['a']);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('re-setting an existing key bumps it and does not evict others', () => {
    const { cache, disposed } = makeCache(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    cache.set('a', 'A');
    expect(cache.size).toBe(3);
    expect(cache.keys()).toEqual(['b', 'c', 'a']);
    expect(disposed).toEqual([]);
  });

  it('evicts multiple LRU entries when an update would still fit but a fresh insert overflows', () => {
    const { cache, disposed } = makeCache(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    cache.set('d', 'D');
    expect(cache.keys()).toEqual(['c', 'd']);
    expect(disposed).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
  });
});

describe('TileCache — dispose exactly once', () => {
  it('disposes an evicted entry exactly once', () => {
    const { cache, dispose } = makeCache(1);
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith('a', 'A');
  });

  it('does NOT dispose entries that remain live', () => {
    const { cache, dispose } = makeCache(4);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.get('a');
    cache.touch('b');
    cache.has('a');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('delete disposes exactly once and returns true; absent key returns false and disposes nothing', () => {
    const { cache, dispose, disposed } = makeCache(4);
    cache.set('a', 'A');
    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    expect(disposed).toEqual([['a', 'A']]);
    expect(cache.delete('a')).toBe(false);
    expect(cache.delete('never')).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('never double-disposes across a full lifecycle (evict, then delete, then clear)', () => {
    const { cache, dispose, disposed } = makeCache(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    cache.delete('b');
    cache.set('d', 'D');
    cache.clear();
    const counts = new Map<string, number>();
    for (const [k] of disposed) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect(counts).toEqual(
      new Map([
        ['a', 1],
        ['b', 1],
        ['c', 1],
        ['d', 1],
      ])
    );
    expect(dispose).toHaveBeenCalledTimes(4);
  });
});

describe('TileCache — update existing key disposes the OLD value', () => {
  it('disposes the old value (once) when a key is updated with a different value', () => {
    const { cache, dispose, disposed } = makeCache(4);
    cache.set('a', 'OLD');
    cache.set('a', 'NEW');
    expect(cache.get('a')).toBe('NEW');
    expect(cache.size).toBe(1);
    expect(disposed).toEqual([['a', 'OLD']]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does NOT dispose when the same key is set to an identical value (Object.is)', () => {
    const value = { id: 1 };
    const disposed: Array<[string, { id: number }]> = [];
    const dispose = vi.fn((key: string, v: { id: number }) => {
      disposed.push([key, v]);
    });
    const cache = new TileCache<{ id: number }>({ capacity: 4, dispose });
    cache.set('a', value);
    cache.set('a', value);
    expect(dispose).not.toHaveBeenCalled();
    expect(cache.get('a')).toBe(value);
  });

  it('updating with a different value bumps recency (does not re-trigger old eviction)', () => {
    const { cache, disposed } = makeCache(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('a', 'A2');
    cache.set('c', 'C');
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(disposed).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
  });
});

describe('TileCache — capacity edges', () => {
  it('capacity 1 holds at most one entry, evicting on every new key', () => {
    const { cache, disposed } = makeCache(1);
    cache.set('a', 'A');
    expect(cache.keys()).toEqual(['a']);
    cache.set('b', 'B');
    expect(cache.keys()).toEqual(['b']);
    cache.set('c', 'C');
    expect(cache.keys()).toEqual(['c']);
    expect(disposed).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
    expect(cache.size).toBe(1);
  });

  it('capacity 0 is unbounded — never evicts for size', () => {
    const { cache, dispose } = makeCache(0);
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, `v${i}`);
    expect(cache.size).toBe(100);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('negative capacity is unbounded too', () => {
    const { cache, dispose } = makeCache(-5);
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, `v${i}`);
    expect(cache.size).toBe(50);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('unbounded cache still disposes on delete/clear', () => {
    const { cache, dispose, disposed } = makeCache(0);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.delete('a');
    cache.clear();
    expect(dispose).toHaveBeenCalledTimes(2);
    const keys = disposed.map(([k]) => k).sort();
    expect(keys).toEqual(['a', 'b']);
  });
});

describe('TileCache — has does not bump recency', () => {
  it('has() leaves the eviction victim unchanged', () => {
    const { cache, disposed } = makeCache(2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.has('a')).toBe(true);
    cache.set('c', 'C');
    expect(cache.has('a')).toBe(false);
    expect(cache.keys()).toEqual(['b', 'c']);
    expect(disposed).toEqual([['a', 'A']]);
  });
});

describe('TileCache — clear disposes all', () => {
  it('clear() disposes every live entry exactly once and empties the cache', () => {
    const { cache, dispose, disposed } = makeCache(4);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.keys()).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(3);
    const keys = disposed.map(([k]) => k).sort();
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('clear() on an empty cache disposes nothing', () => {
    const { cache, dispose } = makeCache(4);
    cache.clear();
    expect(dispose).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it('cache is reusable after clear', () => {
    const { cache } = makeCache(2);
    cache.set('a', 'A');
    cache.clear();
    cache.set('b', 'B');
    expect(cache.get('b')).toBe('B');
    expect(cache.size).toBe(1);
  });
});
