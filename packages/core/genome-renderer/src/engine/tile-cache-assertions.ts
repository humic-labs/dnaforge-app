import { expect } from 'vitest';
import type { TileCache, TileEntry } from './tile-cache';
import type { TileKey, TileData } from './tile-source';

export function key(level: number, index: number, sourceId = 's'): TileKey {
  return { sourceId, level, index };
}

export function readyEntry(k: TileKey, bytes: number, gpu?: unknown): TileEntry {
  return { key: k, state: 'ready', epoch: 0, byteSize: bytes, gpu: gpu ?? { id: `${k.index}` } };
}

export function pendingEntry(k: TileKey, abort: AbortController): TileEntry {
  return { key: k, state: 'pending', epoch: 0, byteSize: 0, abort };
}

export function readyData(k: TileKey, bytes: number): TileData {
  return { key: k, state: 'ready', byteSize: bytes, count: 1 };
}

export function assertCountBound(cache: TileCache): void {
  for (let i = 0; i < 6; i++) cache.set(readyEntry(key(0, i), 10));
  expect(cache.size).toBe(3);
  expect(cache.has(key(0, 5))).toBe(true);
  expect(cache.has(key(0, 4))).toBe(true);
  expect(cache.has(key(0, 3))).toBe(true);
  expect(cache.has(key(0, 0))).toBe(false);
}

export function assertByteBound(cache: TileCache): void {
  cache.set(readyEntry(key(0, 0), 40));
  cache.set(readyEntry(key(0, 1), 40));
  expect(cache.byteSize).toBe(80);
  cache.set(readyEntry(key(0, 2), 40));
  expect(cache.byteSize).toBeLessThanOrEqual(100);
  expect(cache.has(key(0, 0))).toBe(false);
  expect(cache.has(key(0, 2))).toBe(true);
}

export function assertLruTouch(cache: TileCache): void {
  cache.set(readyEntry(key(0, 0), 10));
  cache.set(readyEntry(key(0, 1), 10));
  cache.set(readyEntry(key(0, 2), 10));
  cache.get(key(0, 0));
  cache.set(readyEntry(key(0, 3), 10));
  expect(cache.has(key(0, 0))).toBe(true);
  expect(cache.has(key(0, 1))).toBe(false);
}

export function assertPinProtection(cache: TileCache): void {
  cache.set(readyEntry(key(0, 0), 10));
  cache.set(readyEntry(key(0, 1), 10));
  cache.set(readyEntry(key(0, 2), 10));
  cache.pin(key(0, 0));
  cache.set(readyEntry(key(0, 3), 10));
  expect(cache.has(key(0, 0))).toBe(true);
  expect(cache.has(key(0, 1))).toBe(false);
  expect(cache.evict(key(0, 0))).toBe(false);
  expect(cache.has(key(0, 0))).toBe(true);
}

export function assertEvictAbortsPending(cache: TileCache): void {
  const ac = new AbortController();
  cache.set(pendingEntry(key(0, 0), ac));
  expect(ac.signal.aborted).toBe(false);
  cache.evict(key(0, 0));
  expect(ac.signal.aborted).toBe(true);
}

export function assertEvictDisposesGpu(cache: TileCache, disposed: unknown[]): void {
  const gpu = { id: 'gpu-7' };
  cache.set(readyEntry(key(0, 0), 10, gpu));
  cache.evict(key(0, 0));
  expect(disposed).toContain(gpu);
}
