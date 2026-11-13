import { describe, expect, it } from 'vitest';

import { LruCache } from './lru';

describe('LruCache', () => {
  it('evicts the least recently used entry at capacity', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('rejects non-positive capacities', () => {
    expect(() => new LruCache(0)).toThrow(/positive integer/);
  });
});
