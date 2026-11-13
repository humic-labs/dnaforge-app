import { describe, expect, it, vi } from 'vitest';
import { HiddenMapRetentionPool } from './hidden-map-retention';

describe('HiddenMapRetentionPool', () => {
  it('evicts only the least-recently-hidden map when the count bound is exceeded', () => {
    const pool = new HiddenMapRetentionPool(3);
    const teardownA = vi.fn();
    const teardownB = vi.fn();
    const teardownC = vi.fn();
    const teardownD = vi.fn();

    pool.retain('a', teardownA);
    pool.retain('b', teardownB);
    pool.retain('c', teardownC);
    pool.retain('d', teardownD);

    expect(pool.instanceIds()).toEqual(['b', 'c', 'd']);
    expect(pool.size).toBe(3);
    expect(teardownA).toHaveBeenCalledExactlyOnceWith('lru-evict');
    expect(teardownB).not.toHaveBeenCalled();
    expect(teardownC).not.toHaveBeenCalled();
    expect(teardownD).not.toHaveBeenCalled();
  });

  it('promotes a retained map to most-recent without tearing it down', () => {
    const pool = new HiddenMapRetentionPool(2);
    const teardownA = vi.fn();
    const teardownB = vi.fn();
    const teardownC = vi.fn();

    pool.retain('a', teardownA);
    pool.retain('b', teardownB);
    pool.retain('a', teardownA);
    pool.retain('c', teardownC);

    expect(pool.instanceIds()).toEqual(['a', 'c']);
    expect(teardownA).not.toHaveBeenCalled();
    expect(teardownB).toHaveBeenCalledExactlyOnceWith('lru-evict');
  });

  it('releases visible or unmounted maps without invoking teardown', () => {
    const pool = new HiddenMapRetentionPool(1);
    const teardown = vi.fn();

    pool.retain('a', teardown);
    pool.release('a');

    expect(pool.instanceIds()).toEqual([]);
    expect(teardown).not.toHaveBeenCalled();
  });

  it('supports a zero-entry policy by evicting synchronously', () => {
    const pool = new HiddenMapRetentionPool(0);
    const teardown = vi.fn();

    pool.retain('a', teardown);

    expect(pool.size).toBe(0);
    expect(teardown).toHaveBeenCalledExactlyOnceWith('lru-evict');
  });

  it('rejects invalid bounds', () => {
    expect(() => new HiddenMapRetentionPool(-1)).toThrow(/non-negative integer/);
    expect(() => new HiddenMapRetentionPool(1.5)).toThrow(/non-negative integer/);
  });
});
