import { expect } from 'vitest';
import type { Assembly } from '../assembly';
import type { TileCache } from './tile-cache';
import { FakeInMemoryTileSource, type TileKey } from './tile-source';

export interface CoordinatorLike {
  setViewport(view: { globalStart: number; globalEnd: number; viewportPx: number }): void;
  readonly epoch: number;
  readonly level: number | null;
  readonly inFlight: number;
}

export interface Harness {
  coord: CoordinatorLike;
  source: FakeInMemoryTileSource;
  cache: TileCache;
  ready: TileKey[];
  errors: Array<{ key: TileKey; reason: string }>;
}

export type MakeHarness = (asm: Assembly, source: FakeInMemoryTileSource) => Harness;

const FINE = { level: [0, 30] as const };

function microtask(): Promise<void> {
  return Promise.resolve();
}

function sameTile(a: TileKey, b: TileKey): boolean {
  return a.sourceId === b.sourceId && a.level === b.level && a.index === b.index;
}

export async function assertUnconditionalEpochBump(
  asm: Assembly,
  make: MakeHarness
): Promise<void> {
  const src = new FakeInMemoryTileSource({ id: 's', levelRange: FINE.level, manual: true });
  const h = make(asm, src);
  const v = { globalStart: 1000, globalEnd: 3000, viewportPx: 1000 };
  h.coord.setViewport(v);
  const e1 = h.coord.epoch;
  h.coord.setViewport(v);
  const e2 = h.coord.epoch;
  expect(e2).toBeGreaterThan(e1);
}

export async function assertStaleArrivalDropped(asm: Assembly, make: MakeHarness): Promise<void> {
  const src = new FakeInMemoryTileSource({
    id: 's',
    levelRange: FINE.level,
    manual: true,
    resolveAfterAbort: true,
  });
  const h = make(asm, src);
  h.coord.setViewport({ globalStart: 1000, globalEnd: 3000, viewportPx: 1000 });
  const keys = src.fetches.map((f) => f.key);
  expect(keys.length).toBeGreaterThan(0);
  const staleKey = keys[0];
  h.coord.setViewport({ globalStart: 120_000, globalEnd: 122_000, viewportPx: 1000 });
  src.resolveKey(staleKey);
  await microtask();
  await microtask();
  expect(h.ready.find((k) => sameTile(k, staleKey))).toBeUndefined();
}

export async function assertStaleRejectionDropped(asm: Assembly, make: MakeHarness): Promise<void> {
  const src = new FakeInMemoryTileSource({
    id: 's',
    levelRange: FINE.level,
    manual: true,
    resolveAfterAbort: true,
  });
  const h = make(asm, src);
  h.coord.setViewport({ globalStart: 1000, globalEnd: 3000, viewportPx: 1000 });
  const keys = src.fetches.map((f) => f.key);
  expect(keys.length).toBeGreaterThan(0);
  const staleKey = keys[0];
  h.coord.setViewport({ globalStart: 120_000, globalEnd: 122_000, viewportPx: 1000 });
  src.rejectKey(staleKey, new Error('late transport failure'));
  await microtask();
  await microtask();
  expect(h.cache.peek(staleKey)).toBeUndefined();
  expect(h.errors.find((e) => sameTile(e.key, staleKey))).toBeUndefined();
}

export async function assertStaleResolutionDoesNotClearCurrentFetch(
  asm: Assembly,
  make: MakeHarness
): Promise<void> {
  const src = new FakeInMemoryTileSource({
    id: 's',
    levelRange: FINE.level,
    manual: true,
    resolveAfterAbort: true,
  });
  const h = make(asm, src);
  const a = { globalStart: 1000, globalEnd: 3000, viewportPx: 1000 };
  const b = { globalStart: 120_000, globalEnd: 122_000, viewportPx: 1000 };
  h.coord.setViewport(a);
  const staleKey = src.fetches[0].key;
  h.coord.setViewport(b);
  h.coord.setViewport(a);
  const before = h.coord.inFlight;
  expect(before).toBeGreaterThan(0);
  src.resolveKey(staleKey);
  await microtask();
  await microtask();
  expect(h.coord.inFlight).toBe(before);
  expect(h.cache.peek(staleKey)?.state).toBe('pending');
  expect(h.ready.find((k) => sameTile(k, staleKey))).toBeUndefined();
}

export async function assertStaleRejectionDoesNotClearCurrentFetch(
  asm: Assembly,
  make: MakeHarness
): Promise<void> {
  const src = new FakeInMemoryTileSource({
    id: 's',
    levelRange: FINE.level,
    manual: true,
    resolveAfterAbort: true,
  });
  const h = make(asm, src);
  const a = { globalStart: 1000, globalEnd: 3000, viewportPx: 1000 };
  const b = { globalStart: 120_000, globalEnd: 122_000, viewportPx: 1000 };
  h.coord.setViewport(a);
  const staleKey = src.fetches[0].key;
  h.coord.setViewport(b);
  h.coord.setViewport(a);
  const before = h.coord.inFlight;
  expect(before).toBeGreaterThan(0);
  src.rejectKey(staleKey, new Error('late transport failure'));
  await microtask();
  await microtask();
  expect(h.coord.inFlight).toBe(before);
  expect(h.cache.peek(staleKey)?.state).toBe('pending');
  expect(h.errors.find((e) => sameTile(e.key, staleKey))).toBeUndefined();
}

export async function assertVisibleSlowTileNotDroppedOnRecommit(
  asm: Assembly,
  make: MakeHarness
): Promise<void> {
  const src = new FakeInMemoryTileSource({ id: 's', levelRange: FINE.level, manual: true });
  const h = make(asm, src);
  const v = { globalStart: 1000, globalEnd: 3000, viewportPx: 1000 };
  h.coord.setViewport(v);
  const keys = src.fetches.map((f) => f.key);
  expect(keys.length).toBeGreaterThan(0);
  const slowKey = keys[0];
  h.coord.setViewport(v);
  src.resolveKey(slowKey);
  await microtask();
  await microtask();
  expect(h.ready.some((k) => sameTile(k, slowKey))).toBe(true);
}

export async function assertCurrentArrivalEmitted(asm: Assembly, make: MakeHarness): Promise<void> {
  const src = new FakeInMemoryTileSource({ id: 's', levelRange: FINE.level, manual: true });
  const h = make(asm, src);
  h.coord.setViewport({ globalStart: 1000, globalEnd: 3000, viewportPx: 1000 });
  const keys = src.fetches.map((f) => f.key);
  src.resolveKey(keys[0]);
  await microtask();
  await microtask();
  expect(h.ready.some((k) => sameTile(k, keys[0]))).toBe(true);
}

export async function assertAbortOnLeave(asm: Assembly, make: MakeHarness): Promise<void> {
  const src = new FakeInMemoryTileSource({ id: 's', levelRange: FINE.level, manual: true });
  const h = make(asm, src);
  h.coord.setViewport({ globalStart: 1000, globalEnd: 3000, viewportPx: 1000 });
  const aFetches = [...src.fetches];
  expect(aFetches.length).toBeGreaterThan(0);
  expect(aFetches.every((f) => !f.aborted)).toBe(true);
  h.coord.setViewport({ globalStart: 80_000, globalEnd: 82_000, viewportPx: 1000 });
  await microtask();
  const aborted = aFetches.filter((f) => f.aborted).length;
  expect(aborted).toBeGreaterThan(0);
}

export async function assertPendingNotRefetched(asm: Assembly, make: MakeHarness): Promise<void> {
  const src = new FakeInMemoryTileSource({ id: 's', levelRange: FINE.level, manual: true });
  const h = make(asm, src);
  const v = { globalStart: 1000, globalEnd: 3000, viewportPx: 1000 };
  h.coord.setViewport(v);
  const firstCount = src.fetches.length;
  expect(firstCount).toBeGreaterThan(0);
  h.coord.setViewport(v);
  expect(src.fetches.length).toBe(firstCount);
}
