// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { RetentionPool } from './retention-pool';

const budgets = { normal: 3, moderate: 2, critical: 1 } as const;

function poolWith(...usedOldestFirst: string[]): RetentionPool {
  const pool = new RetentionPool({ id: 'test', budgets });
  for (const key of usedOldestFirst) pool.touch(key);
  return pool;
}

describe('RetentionPool', () => {
  it('keeps the most recently used entries up to the normal budget', () => {
    const pool = poolWith('a', 'b', 'c', 'd');
    expect([...pool.retain('normal', new Set(['d']))].sort()).toEqual(['b', 'c', 'd']);
  });

  it('touching an entry again makes it the most recent', () => {
    const pool = poolWith('a', 'b', 'c', 'd', 'a');
    expect([...pool.retain('normal', new Set())].sort()).toEqual(['a', 'c', 'd']);
  });

  it('shrinks to the moderate budget, then to only pinned entries at critical', () => {
    const pool = poolWith('a', 'b', 'c');
    expect([...pool.retain('moderate', new Set(['c']))].sort()).toEqual(['b', 'c']);
    expect([...pool.retain('critical', new Set(['c']))]).toEqual(['c']);
  });

  it('never drops a pinned entry, even past the budget', () => {
    const pool = poolWith('a', 'b', 'c');
    expect([...pool.retain('critical', new Set(['a', 'b']))].sort()).toEqual(['a', 'b']);
  });

  it('evicts what it cuts, so easing pressure does not bring it back', () => {
    const pool = poolWith('a', 'b', 'c');
    expect([...pool.retain('critical', new Set(['c']))]).toEqual(['c']);
    expect([...pool.retain('normal', new Set(['c']))]).toEqual(['c']);
    pool.touch('a');
    expect([...pool.retain('normal', new Set(['c']))].sort()).toEqual(['a', 'c']);
  });

  it('budgets unknown pressure like normal', () => {
    const pool = poolWith('a', 'b', 'c', 'd');
    expect(pool.retain('unknown', new Set()).size).toBe(3);
  });

  it('forgets closed entries so they stop holding budget', () => {
    const pool = poolWith('a', 'b', 'c', 'd');
    pool.prune(new Set(['a', 'd']));
    expect(pool.snapshot().recency).toEqual(['d', 'a']);
    pool.forget('d');
    expect(pool.snapshot().recency).toEqual(['a']);
  });

  it('rejects budgets that are not positive or that grow with pressure', () => {
    expect(
      () => new RetentionPool({ id: 'x', budgets: { normal: 0, moderate: 0, critical: 0 } })
    ).toThrow(/positive integer/);
    expect(
      () => new RetentionPool({ id: 'x', budgets: { normal: 2, moderate: 4, critical: 1 } })
    ).toThrow(/must not grow/);
  });
});
