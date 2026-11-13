import {
  RetentionPool,
  type RetentionPoolOptions,
  type RetentionPoolSnapshot,
} from './retention-pool';

const pools = new Map<string, RetentionPool>();

export function registerRetentionPool(options: RetentionPoolOptions): RetentionPool {
  const existing = pools.get(options.id);
  if (existing) return existing;
  const pool = new RetentionPool(options);
  pools.set(options.id, pool);
  return pool;
}

export function listRetentionPools(): RetentionPoolSnapshot[] {
  return [...pools.values()].map((pool) => pool.snapshot());
}
