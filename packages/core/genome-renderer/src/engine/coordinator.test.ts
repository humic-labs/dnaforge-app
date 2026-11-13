import { describe, it, expect } from 'vitest';
import type { Chromosome } from '../chromosome';
import { buildAssembly } from '../assembly-layout';
import { TileCache } from './tile-cache';
import { FakeInMemoryTileSource, type TileKey, type TileSource } from './tile-source';
import { TileCoordinator } from './coordinator';
import {
  assertUnconditionalEpochBump,
  assertStaleArrivalDropped,
  assertStaleRejectionDropped,
  assertStaleResolutionDoesNotClearCurrentFetch,
  assertStaleRejectionDoesNotClearCurrentFetch,
  assertVisibleSlowTileNotDroppedOnRecommit,
  assertCurrentArrivalEmitted,
  assertAbortOnLeave,
  assertPendingNotRefetched,
  type Harness,
} from './coordinator-assertions';

function chrom(id: string, length: number): Chromosome {
  return { id, displayName: id, length, cytobands: [] };
}
const asm = buildAssembly('test', 'test', [chrom('chr1', 200_000), chrom('chr2', 200_000)]);

function makeHarness(assembly = asm, source?: FakeInMemoryTileSource): Harness {
  const src = source ?? new FakeInMemoryTileSource({ id: 's', levelRange: [0, 30], manual: true });
  const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
  const ready: TileKey[] = [];
  const errors: Array<{ key: TileKey; reason: string }> = [];
  const coord = new TileCoordinator({
    assembly,
    sources: [src],
    cache,
    onTileReady: (k) => ready.push(k),
    onTileError: (key, reason) => errors.push({ key, reason }),
  });
  return { coord, source: src, cache, ready, errors };
}

describe('engine/coordinator — abort + epoch dataflow', () => {
  it('unconditional epoch bump (same-level commit still advances epoch)', () =>
    assertUnconditionalEpochBump(asm, (a, s) => makeHarness(a, s)));
  it('stale prior-commit arrival is dropped (no stale paint)', () =>
    assertStaleArrivalDropped(asm, (a, s) => makeHarness(a, s)));
  it('stale prior-commit rejection is dropped (no stale error)', () =>
    assertStaleRejectionDropped(asm, (a, s) => makeHarness(a, s)));
  it('stale prior-commit resolution does not clear a newer same-key fetch', () =>
    assertStaleResolutionDoesNotClearCurrentFetch(asm, (a, s) => makeHarness(a, s)));
  it('stale prior-commit rejection does not clear a newer same-key fetch', () =>
    assertStaleRejectionDoesNotClearCurrentFetch(asm, (a, s) => makeHarness(a, s)));
  it('a still-visible slow tile is NOT dropped on a same-viewport re-commit', () =>
    assertVisibleSlowTileNotDroppedOnRecommit(asm, (a, s) => makeHarness(a, s)));
  it('current-epoch arrival IS emitted (drop is selective)', () =>
    assertCurrentArrivalEmitted(asm, (a, s) => makeHarness(a, s)));
  it('abort-on-leave aborts the departed locus fetches (no leak)', () =>
    assertAbortOnLeave(asm, (a, s) => makeHarness(a, s)));
  it('pending tile is not refetched on re-commit (one controller per key)', () =>
    assertPendingNotRefetched(asm, (a, s) => makeHarness(a, s)));

  it('keeps a bounded-network current read collar when the same pan-lead plan overlaps it', () => {
    const source = new FakeInMemoryTileSource({
      id: 'aln:remote',
      levelRange: [0, 30],
      manual: true,
    }) as FakeInMemoryTileSource & { prefetch: TileSource['prefetch'] };
    source.prefetch = { sameLevelMarginTiles: 1 };
    const h = makeHarness(
      buildAssembly('pan-collar', 'pan collar', [chrom('chr1', 2_000_000)]),
      source
    );
    h.coord.setViewport({ globalStart: 10_256, globalEnd: 12_304, viewportPx: 2048 });
    h.coord.setViewport({ globalStart: 51_456, globalEnd: 53_504, viewportPx: 2048 });

    const collar = source.fetches.find(({ key }) => key.level === 0 && key.index === 53);
    expect(h.coord.level).toBe(0);
    expect(collar?.priority).toMatchObject({
      purpose: 'current',
      epoch: 2,
      core: false,
      marginDistanceTiles: 1,
    });
    expect(
      source.fetches.find(({ key }) => key.level === 0 && key.index === 54)?.priority
    ).toMatchObject({ purpose: 'pan-lead', core: true });

    h.coord.setViewport({ globalStart: 52_480, globalEnd: 54_528, viewportPx: 2048 });
    expect(source.fetches.filter(({ key }) => key.level === 0 && key.index === 53)).toHaveLength(1);
    expect(collar?.priority).toMatchObject({
      purpose: 'current',
      epoch: 3,
      core: true,
      marginDistanceTiles: 0,
    });
  });

  it.each([
    { name: 'local sixteen-tile margin', sourceId: 'aln:local', margin: 16, level: 0 },
    { name: 'generic wider margin', sourceId: 'aln:generic', margin: 2, level: 0 },
    { name: 'guide-only alignment', sourceId: 'aln:guide', margin: 1, level: 3 },
  ])('preserves pan-lead promotion for $name', ({ sourceId, margin, level }) => {
    const source = new FakeInMemoryTileSource({
      id: sourceId,
      levelRange: [0, 30],
      manual: true,
    }) as FakeInMemoryTileSource & { prefetch: TileSource['prefetch'] };
    source.prefetch = { sameLevelMarginTiles: margin };
    const h = makeHarness(
      buildAssembly('pan-controls', 'pan controls', [chrom('chr1', 2_000_000)]),
      source
    );
    const span = 1024 * 2 ** level;
    h.coord.setViewport({
      globalStart: 10 * span + 256,
      globalEnd: 12 * span + 256,
      viewportPx: 2048,
    });
    h.coord.setViewport({
      globalStart: 50 * span + 256,
      globalEnd: 52 * span + 256,
      viewportPx: 2048,
    });
    expect(h.coord.level).toBe(level);
    expect(
      source.fetches.find(({ key }) => key.level === level && key.index === 53)?.priority
    ).toMatchObject({ purpose: 'pan-lead', core: true, marginDistanceTiles: 0 });
  });

  it('admits full-genome-axis core tiles when soft retention fills the cache', async () => {
    const fullGenomeAssembly = buildAssembly('full-genome-axis', 'full genome axis', [
      chrom('contigA', 1_500_000_000),
      chrom('contigB', 1_000_000_000),
      chrom('contigC', 600_000_000),
    ]);
    const source = new FakeInMemoryTileSource({
      id: 'cov',
      levelRange: [0, 30],
    });
    const cache = new TileCache({ maxEntries: 512, maxBytes: 1e9 });
    const retainedKeys: TileKey[] = [];
    for (let index = 0; index < 512; index++) {
      const key = { sourceId: 'retained-coverage', level: 22, index };
      retainedKeys.push(key);
      cache.set({
        key,
        state: 'ready',
        epoch: 0,
        byteSize: 1,
        data: { key, state: 'ready', byteSize: 1, count: 1 },
      });
    }
    cache.setRetained(retainedKeys);
    const coordinator = new TileCoordinator({
      assembly: fullGenomeAssembly,
      sources: [source],
      cache,
    });

    coordinator.setViewport({
      globalStart: 2_261_015_727,
      globalEnd: 2_273_455_562,
      viewportPx: 5_352,
    });

    const currentCoreFetches = source.fetches.filter(
      ({ key, priority }) =>
        key.level === coordinator.level && priority?.purpose === 'current' && priority.core === true
    );
    expect(
      currentCoreFetches.length,
      'sanity: the stopped full-axis viewport requires multiple core tiles'
    ).toBeGreaterThanOrEqual(4);
    expect
      .soft(
        currentCoreFetches.every(({ aborted }) => !aborted),
        'new current core requests must not self-evict behind retained history'
      )
      .toBe(true);
    expect
      .soft(
        currentCoreFetches.every(({ key }) => cache.peek(key) != null),
        'all current core keys must remain admitted after the authoritative commit'
      )
      .toBe(true);

    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect
      .soft(
        coordinator.inFlight,
        'settled or synchronously aborted requests must not remain as ghost controllers'
      )
      .toBe(0);
    expect(
      cache.size,
      'required-tile admission must preserve the cache count bound'
    ).toBeLessThanOrEqual(cache.maxEntries);
  });

  it('does not leak controllers when hard pins synchronously reject admission', async () => {
    const source = new FakeInMemoryTileSource({ id: 's', levelRange: [0, 30] });
    const cache = new TileCache({ maxEntries: 1, maxBytes: 1e9 });
    const hard = { sourceId: 'hard-draw', level: 0, index: 0 };
    cache.set({
      key: hard,
      state: 'ready',
      epoch: 0,
      byteSize: 1,
      data: { key: hard, state: 'ready', byteSize: 1, count: 1 },
    });
    cache.setPins([hard]);
    const coordinator = new TileCoordinator({ assembly: asm, sources: [source], cache });

    coordinator.setViewport({ globalStart: 1000, globalEnd: 3000, viewportPx: 1000 });
    expect(source.fetches.some(({ aborted }) => aborted)).toBe(true);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(coordinator.inFlight).toBe(0);
  });

  it('retires cancelled controller ownership before an abort-insensitive transport settles', async () => {
    const source = new FakeInMemoryTileSource({
      id: 'remote-alignment',
      levelRange: [0, 30],
      manual: true,
      resolveAfterAbort: true,
    });
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coordinator = new TileCoordinator({ assembly: asm, sources: [source], cache });
    const view = { globalStart: 1_024, globalEnd: 3_024, viewportPx: 2_000 };

    coordinator.setViewport(view);
    const firstRequestCount = source.fetches.length;
    expect(firstRequestCount).toBeGreaterThan(0);
    expect(coordinator.inFlight).toBe(firstRequestCount);

    const cancelled = coordinator.cancelPendingWhere(() => true);

    expect(cancelled).toBe(firstRequestCount);
    expect(coordinator.inFlight).toBe(0);
    expect(cache.entries()).toHaveLength(0);
    expect(source.fetches.every(({ aborted }) => aborted)).toBe(true);

    coordinator.setViewport(view);
    expect(source.fetches).toHaveLength(firstRequestCount * 2);
    expect(coordinator.inFlight).toBe(firstRequestCount);

    source.resolveAll();
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(coordinator.inFlight).toBe(0);
    expect(cache.entries().every(({ state }) => state === 'ready')).toBe(true);
  });

  it('promotes a pending same-level margin tile when pan makes it visible core', () => {
    const panAsm = buildAssembly('pan-priority', 'pan-priority', [chrom('chr1', 10_000)]);
    const src = new FakeInMemoryTileSource({
      id: 'cov',
      levelRange: [0, 30],
      manual: true,
    }) as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> };
    src.prefetch = { sameLevelMarginTiles: 2 };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: panAsm, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 512, viewportPx: 512 });
    const marginFetch = src.fetches.find(({ key }) => key.level === 0 && key.index === 2);
    expect(marginFetch?.priority).toMatchObject({
      purpose: 'current',
      epoch: 1,
      core: false,
      marginDistanceTiles: 2,
    });

    coord.setViewport({ globalStart: 2048, globalEnd: 2560, viewportPx: 512 });

    const tile2Fetches = src.fetches.filter(({ key }) => key.level === 0 && key.index === 2);
    expect(tile2Fetches, 'pending tile must be promoted in place, not refetched').toHaveLength(1);
    expect(marginFetch?.priority).toMatchObject({
      purpose: 'current',
      epoch: 2,
      core: true,
      marginDistanceTiles: 0,
    });
  });

  it('does not enqueue fetches for a source whose levelRange excludes L', () => {
    const fineOnly = new FakeInMemoryTileSource({ id: 'aln', levelRange: [0, 5], manual: true });
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [fineOnly], cache });
    coord.setViewport({ globalStart: 0, globalEnd: 400_000, viewportPx: 100 });
    expect(coord.level).toBeGreaterThan(5);
    expect(fineOnly.fetches.length).toBe(0);
  });

  it('enqueues next-coarser prefetch tiles before the hysteresis level switch', () => {
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true });
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 11_300, viewportPx: 1_000 });

    expect(coord.level).toBe(4);
    expect(src.fetches.some(({ key }) => key.level === 4)).toBe(true);
    expect(src.fetches.some(({ key }) => key.level === 5)).toBe(true);
  });

  it('does not prefetch a next-coarser level outside the source levelRange', () => {
    const src = new FakeInMemoryTileSource({ id: 'fine', levelRange: [0, 4], manual: true });
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 11_300, viewportPx: 1_000 });

    expect(coord.level).toBe(4);
    expect(src.fetches.some(({ key }) => key.level === 4)).toBe(true);
    expect(src.fetches.some(({ key }) => key.level === 5)).toBe(false);
  });

  it('enqueues next-finer prefetch tiles before the hysteresis level switch for opt-in sources', () => {
    const src = new FakeInMemoryTileSource({
      id: 'cov',
      levelRange: [0, 30],
      manual: true,
    }) as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> };
    src.prefetch = {};
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 10_000, viewportPx: 625 });
    coord.setViewport({ globalStart: 250_000, globalEnd: 260_000, viewportPx: 1_000 });

    expect(coord.level).toBe(4);
    expect(src.fetches.some(({ key }) => key.level === 4)).toBe(true);
    expect(src.fetches.some(({ key }) => key.level === 3)).toBe(true);
  });

  it('does not implicitly warm next-finer tiles for sources without a prefetch policy', () => {
    const src = new FakeInMemoryTileSource({ id: 'aln', levelRange: [0, 30], manual: true });
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 10_000, viewportPx: 625 });
    coord.setViewport({ globalStart: 250_000, globalEnd: 260_000, viewportPx: 1_000 });

    expect(coord.level).toBe(4);
    expect(src.fetches.some(({ key }) => key.level === 4)).toBe(true);
    expect(
      src.fetches.some(({ key }) => key.level === 3),
      'alignment-like sources are expensive; finer warmup must be explicit'
    ).toBe(false);
  });

  it('lets coverage-like sources prefetch one critical finer handoff level before the switch', () => {
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & {
          prefetch: { criticalFinerLevel: number; criticalFinerMaxCurrentLevel: number };
        });
    (
      src as FakeInMemoryTileSource & {
        prefetch: { criticalFinerLevel: number; criticalFinerMaxCurrentLevel: number };
      }
    ).prefetch = {
      criticalFinerLevel: 2,
      criticalFinerMaxCurrentLevel: 5,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 32_000, viewportPx: 1_000 });
    src.fetches.length = 0;
    coord.setViewport({ globalStart: 90_000, globalEnd: 110_000, viewportPx: 1_000 });

    expect(coord.level).toBe(5);
    expect(src.fetches.some(({ key }) => key.level === 5)).toBe(true);
    expect(src.fetches.some(({ key }) => key.level === 2)).toBe(true);
    expect(src.fetches.some(({ key }) => key.level === 4)).toBe(true);
    expect(src.fetches.some(({ key }) => key.level === 3)).toBe(true);
    const firstCritical = src.fetches.findIndex(({ key }) => key.level === 2);
    const firstAdjacent = src.fetches.findIndex(({ key }) => key.level === 4);
    const firstCurrentCore = src.fetches.findIndex(
      ({ key, priority }) => key.level === 5 && priority?.core === true
    );
    const firstCurrentMargin = src.fetches.findIndex(
      ({ key, priority }) => key.level === 5 && priority?.core === false
    );
    expect(firstCritical, 'critical handoff fetch must exist').toBeGreaterThanOrEqual(0);
    expect(firstAdjacent, 'adjacent descent fetch must exist').toBeGreaterThanOrEqual(0);
    expect(firstCurrentCore, 'current visible core fetch must exist').toBeGreaterThanOrEqual(0);
    expect(firstCurrentMargin, 'current margin refinement fetch must exist').toBeGreaterThanOrEqual(
      0
    );
    expect(
      firstCurrentCore,
      'visible current core must be queued before invisible warmup'
    ).toBeLessThan(firstCritical);
    expect(
      firstCurrentMargin,
      'same-level pan margin is visible-product work and must be queued before critical warmup'
    ).toBeLessThan(firstCritical);
    expect(
      firstAdjacent,
      'adjacent descent is the next visible LOD and must be queued before deep critical warmup'
    ).toBeLessThan(firstCritical);
  });

  it('queues visible broad current coverage before critical fine warmups on first full-genome open', () => {
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', 3_100_000_000)]);
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & {
          prefetch: {
            criticalFinerLevel: number;
            criticalFinerPrefetchLevels: number;
            criticalFinerMaxCurrentLevel: number;
            sameLevelMarginTiles: number;
          };
        });
    (
      src as FakeInMemoryTileSource & {
        prefetch: {
          criticalFinerLevel: number;
          criticalFinerPrefetchLevels: number;
          criticalFinerMaxCurrentLevel: number;
          sameLevelMarginTiles: number;
        };
      }
    ).prefetch = {
      criticalFinerLevel: 10,
      criticalFinerPrefetchLevels: 2,
      criticalFinerMaxCurrentLevel: 21,
      sameLevelMarginTiles: 64,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: grchScale, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 3_100_000_000, viewportPx: 2676 });

    expect(coord.level).toBe(21);
    expect(src.fetches[0]?.key.level).toBe(21);
    expect(src.fetches[0]?.priority).toMatchObject({
      purpose: 'current',
      core: true,
      marginDistanceTiles: 0,
    });
    const firstLevel20 = src.fetches.findIndex(({ key }) => key.level === 20);
    const firstLevel19 = src.fetches.findIndex(({ key }) => key.level === 19);
    const firstLevel18 = src.fetches.findIndex(({ key }) => key.level === 18);
    const firstCritical = src.fetches.findIndex(({ key }) => key.level === 10);
    expect(firstLevel20, 'overview must warm the immediate next broad LOD').toBeGreaterThanOrEqual(
      0
    );
    expect(
      firstLevel19,
      'overview must warm the second broad LOD before deep handoff'
    ).toBeGreaterThanOrEqual(0);
    expect(
      firstLevel18,
      'overview must warm the third broad LOD before deep handoff'
    ).toBeGreaterThanOrEqual(0);
    expect(firstCritical, 'critical fine warmup must still be queued').toBeGreaterThanOrEqual(0);
    expect(firstLevel20).toBeLessThan(firstCritical);
    expect(firstLevel19).toBeLessThan(firstCritical);
    expect(firstLevel18).toBeLessThan(firstCritical);
    expect(
      src.fetches.some(({ key }) => key.level === 9),
      'critical fine warmup must still happen after visible broad coverage is queued'
    ).toBe(true);
  });

  it('queues a bounded adjacent descent corridor before deep critical coverage handoff', () => {
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & {
          prefetch: { criticalFinerLevel: number; criticalFinerMaxCurrentLevel: number };
        });
    (
      src as FakeInMemoryTileSource & {
        prefetch: { criticalFinerLevel: number; criticalFinerMaxCurrentLevel: number };
      }
    ).prefetch = {
      criticalFinerLevel: 2,
      criticalFinerMaxCurrentLevel: 7,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 128_000, viewportPx: 1_000 });
    src.fetches.length = 0;
    coord.setViewport({ globalStart: 140_000, globalEnd: 220_000, viewportPx: 1_000 });

    expect(coord.level).toBe(7);
    expect(src.fetches.some(({ key }) => key.level === 7)).toBe(true);
    const firstLevel6 = src.fetches.findIndex(({ key }) => key.level === 6);
    const firstLevel5 = src.fetches.findIndex(({ key }) => key.level === 5);
    const firstLevel4 = src.fetches.findIndex(({ key }) => key.level === 4);
    const firstCritical = src.fetches.findIndex(({ key }) => key.level === 2);
    expect(
      firstLevel6,
      'coverage must warm the next adjacent LOD before deep handoff'
    ).toBeGreaterThanOrEqual(0);
    expect(firstLevel5, 'coverage must warm a bounded descent corridor').toBeGreaterThanOrEqual(0);
    expect(firstLevel4, 'coverage must warm a bounded descent corridor').toBeGreaterThanOrEqual(0);
    expect(firstCritical, 'deep critical handoff still has to be queued').toBeGreaterThanOrEqual(0);
    expect(firstLevel6).toBeLessThan(firstCritical);
    expect(firstLevel5).toBeLessThan(firstCritical);
    expect(firstLevel4).toBeLessThan(firstCritical);
    expect(
      src.fetches.some(({ key }) => key.level === 3),
      'the adjacent descent corridor is bounded; it must not blindly fetch every intervening level'
    ).toBe(false);
  });

  it('resumes adjacent finer coverage prefetch once the critical handoff level is current', () => {
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & {
          prefetch: { criticalFinerLevel: number; criticalFinerMaxCurrentLevel: number };
        });
    (
      src as FakeInMemoryTileSource & {
        prefetch: { criticalFinerLevel: number; criticalFinerMaxCurrentLevel: number };
      }
    ).prefetch = {
      criticalFinerLevel: 4,
      criticalFinerMaxCurrentLevel: 7,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 16_000, viewportPx: 1_000 });
    src.fetches.length = 0;
    coord.setViewport({ globalStart: 0, globalEnd: 10_000, viewportPx: 1_000 });

    expect(coord.level).toBe(4);
    expect(
      src.fetches.some(({ key }) => key.level === 3),
      'coverage must warm the next finer level before the critical handoff level exits, or the renderer falls back to a coarse resident floor'
    ).toBe(true);
    const firstFiner = src.fetches.findIndex(({ key }) => key.level === 3);
    const firstCurrent = src.fetches.findIndex(({ key }) => key.level === 4);
    if (firstCurrent >= 0) {
      expect(
        firstFiner,
        'next-finer handoff must be queued before same-level refinement'
      ).toBeLessThan(firstCurrent);
    }
  });

  it('starts level-9 coverage prefetch immediately when level 10 becomes resident', () => {
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', 3_100_000_000)]);
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & {
          prefetch: { criticalFinerLevel: number; criticalFinerMaxCurrentLevel: number };
        });
    (
      src as FakeInMemoryTileSource & {
        prefetch: {
          criticalFinerLevel: number;
          criticalFinerPrefetchLevels: number;
          criticalFinerMaxCurrentLevel: number;
        };
      }
    ).prefetch = {
      criticalFinerLevel: 10,
      criticalFinerPrefetchLevels: 2,
      criticalFinerMaxCurrentLevel: 17,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: grchScale, sources: [src], cache });

    coord.setViewport({ globalStart: 1_543_000_000, globalEnd: 1_544_000_000, viewportPx: 1_000 });

    expect(coord.level).toBe(10);
    expect(
      src.fetches.some(({ key }) => key.level === 9),
      'coverage must warm level 9 across the full level-10 residence band; waiting until the last 30% of the band leaves the live app on a coarse resident floor'
    ).toBe(true);
    const firstFiner = src.fetches.findIndex(({ key }) => key.level === 9);
    const firstCurrentCore = src.fetches.findIndex(
      ({ key, priority }) => key.level === 10 && priority?.core === true
    );
    const firstCurrentMargin = src.fetches.findIndex(
      ({ key, priority }) => key.level === 10 && priority?.core === false
    );
    expect(firstFiner, 'level-9 handoff fetch must exist').toBeGreaterThanOrEqual(0);
    expect(firstCurrentCore, 'level-10 visible core fetch must exist').toBeGreaterThanOrEqual(0);
    expect(
      firstCurrentMargin,
      'level-10 margin refinement fetch must exist'
    ).toBeGreaterThanOrEqual(0);
    expect(firstCurrentCore, 'level-10 visible core must queue before handoff warmup').toBeLessThan(
      firstFiner
    );
    expect(
      firstCurrentMargin,
      'level-10 current-view margin refinement should queue before invisible level-9 handoff warming'
    ).toBeLessThan(firstFiner);
  });

  it('warms level-9 coverage during the critical level-10 handoff before level 10 is current', () => {
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', 3_100_000_000)]);
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & {
          prefetch: {
            criticalFinerLevel: number;
            criticalFinerPrefetchLevels: number;
            criticalFinerMaxCurrentLevel: number;
          };
        });
    (
      src as FakeInMemoryTileSource & {
        prefetch: {
          criticalFinerLevel: number;
          criticalFinerPrefetchLevels: number;
          criticalFinerMaxCurrentLevel: number;
        };
      }
    ).prefetch = {
      criticalFinerLevel: 10,
      criticalFinerPrefetchLevels: 2,
      criticalFinerMaxCurrentLevel: 17,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: grchScale, sources: [src], cache });

    coord.setViewport({ globalStart: 1_500_000_000, globalEnd: 1_504_096_000, viewportPx: 1_000 });
    src.fetches.length = 0;
    coord.setViewport({ globalStart: 1_543_000_000, globalEnd: 1_544_300_000, viewportPx: 1_000 });

    expect(coord.level).toBe(11);
    expect(
      src.fetches.some(({ key }) => key.level === 9),
      'coverage must warm the real <=1Mb target LOD before level 10 is current; otherwise the live app shows coarse frames after crossing 1Mb'
    ).toBe(true);
    expect(src.fetches.some(({ key }) => key.level === 10)).toBe(true);
    const firstL9 = src.fetches.findIndex(({ key }) => key.level === 9);
    const firstL10 = src.fetches.findIndex(({ key }) => key.level === 10);
    expect(firstL9, 'level-9 target prefetch must exist').toBeGreaterThanOrEqual(0);
    expect(firstL10, 'level-10 critical prefetch must exist').toBeGreaterThanOrEqual(0);
    expect(
      firstL10,
      'critical warmup must follow the zoom-in residence order; level 10 is presented before level 9'
    ).toBeLessThan(firstL9);
  });

  it('starts critical coverage warming across the whole declared coarsest residence level', () => {
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', 3_100_000_000)]);
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & {
          prefetch: {
            criticalFinerLevel: number;
            criticalFinerPrefetchLevels: number;
            criticalFinerMaxCurrentLevel: number;
          };
        });
    (
      src as FakeInMemoryTileSource & {
        prefetch: {
          criticalFinerLevel: number;
          criticalFinerPrefetchLevels: number;
          criticalFinerMaxCurrentLevel: number;
        };
      }
    ).prefetch = {
      criticalFinerLevel: 10,
      criticalFinerPrefetchLevels: 2,
      criticalFinerMaxCurrentLevel: 18,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: grchScale, sources: [src], cache });

    coord.setViewport({
      globalStart: 1_450_000_000,
      globalEnd: 1_650_000_000,
      viewportPx: 1_000,
    });

    expect(coord.level).toBe(18);
    expect(
      src.fetches.some(({ key }) => key.level === 9),
      'waiting until the end of level 18 gives the live app too little time to have L9 resident before the <=1Mb threshold'
    ).toBe(true);
    expect(src.fetches.some(({ key }) => key.level === 10)).toBe(true);
    const firstL9 = src.fetches.findIndex(({ key }) => key.level === 9);
    const firstL10 = src.fetches.findIndex(({ key }) => key.level === 10);
    expect(firstL9).toBeGreaterThanOrEqual(0);
    expect(firstL10).toBeGreaterThanOrEqual(0);
    expect(
      firstL10,
      'critical warmup must follow the zoom-in residence order; level 10 is presented before level 9'
    ).toBeLessThan(firstL9);
  });

  it('warms the fine coverage cascade early without flooding the level-4 queue', () => {
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', 3_100_000_000)]);
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> });
    (src as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }).prefetch = {
      criticalFinerLevel: 17,
      criticalFinerPrefetchLevels: 14,
      criticalFinerMaxCurrentLevel: 21,
      sameLevelMarginTiles: 64,
      sameLevelMarginMinLevel: 9,
      finerLookaheadWindowBp: 256_000,
    };
    const cache = new TileCache({ maxEntries: 1024, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: grchScale, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 3_100_000_000, viewportPx: 2676 });

    expect(coord.level).toBe(21);
    expect(src.fetches[0]?.key.level, 'visible broad coverage must queue before warmup').toBe(21);
    for (const level of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
      expect(
        src.fetches.some(({ key }) => key.level === level),
        `coverage level ${level} must be warmed before the fast zoom ladder reaches it`
      ).toBe(true);
    }
    const level4Count = src.fetches.filter(({ key }) => key.level === 4).length;
    expect(
      level4Count,
      'fine cascade must stay centered and narrow; a 4 Mb level-4 warmup floods the tile queue'
    ).toBeLessThanOrEqual(24);
  });

  it('orders the critical coverage cascade by upcoming LOD residence, not finest-first', () => {
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', 3_100_000_000)]);
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> });
    (src as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }).prefetch = {
      criticalFinerLevel: 17,
      criticalFinerPrefetchLevels: 14,
      criticalFinerMaxCurrentLevel: 21,
      sameLevelMarginTiles: 64,
      sameLevelMarginMinLevel: 9,
      finerLookaheadWindowBp: 256_000,
    };
    const cache = new TileCache({ maxEntries: 1024, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: grchScale, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 3_100_000_000, viewportPx: 2676 });

    const firstFetchIndexForLevel = (level: number): number =>
      src.fetches.findIndex(({ key }) => key.level === level);
    const firstL17 = firstFetchIndexForLevel(17);
    const firstL7 = firstFetchIndexForLevel(7);
    const firstL6 = firstFetchIndexForLevel(6);
    const firstL4 = firstFetchIndexForLevel(4);
    expect(firstL17, 'sanity: broad handoff L17 is warmed').toBeGreaterThanOrEqual(0);
    expect(firstL7, 'sanity: mid zoom L7 is warmed').toBeGreaterThanOrEqual(0);
    expect(firstL6, 'sanity: mid zoom L6 is warmed').toBeGreaterThanOrEqual(0);
    expect(firstL4, 'sanity: fine read-adjacent floor L4 is warmed').toBeGreaterThanOrEqual(0);
    expect(
      firstL17,
      'the first upcoming broad handoff must not wait behind deeper fine warmup'
    ).toBeLessThan(firstL7);
    expect(
      firstL7,
      'level 7 must be warm before a level-4 resident surface can become the visible fallback'
    ).toBeLessThan(firstL4);
    expect(
      firstL6,
      'level 6 must be warm before a level-4 resident surface can become the visible fallback'
    ).toBeLessThan(firstL4);
  });

  it('keeps every cold overview zoom step bounded from full genome through 150 Mb', async () => {
    const totalBp = 3_088_269_832;
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', totalBp)]);
    const spans = [totalBp, 2_200_000_000, 1_300_000_000, 500_000_000, 150_000_000];
    const src = new FakeInMemoryTileSource({
      id: 'covasm:/fake.bam',
      levelRange: [0, 30],
      manual: true,
    }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> });
    (src as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }).prefetch = {
      criticalFinerLevel: 17,
      criticalFinerPrefetchLevels: 1,
      criticalFinerMaxCurrentLevel: 21,
      sameLevelMarginTiles: 64,
      sameLevelMarginMinLevel: 0,
      finerLookaheadWindowBp: 256_000,
    };
    const coord = new TileCoordinator({
      assembly: grchScale,
      sources: [src],
      cache: new TileCache({ maxEntries: 1024, maxBytes: 1e9 }),
    });

    for (const [step, span] of spans.entries()) {
      src.fetches.length = 0;
      const start = Math.floor((totalBp - span) / 2);
      coord.setViewport({ globalStart: start, globalEnd: start + span, viewportPx: 2676 });

      const level = coord.level;
      expect(level, `${span}: coordinator level exists`).not.toBeNull();
      if (step === 0) {
        expect(
          src.fetches.some(
            ({ key, priority }) =>
              key.level === level && priority?.purpose === 'current' && priority.core === true
          ),
          `${span}: authoritative first-paint core must not be demoted by a duplicate backstop plan`
        ).toBe(true);
      }
      const distinctLevels = [...new Set(src.fetches.map(({ key }) => key.level))];
      expect(
        distinctLevels.length,
        `${span}: a cold zoom step must not rematerialize a deep speculative level column`
      ).toBeLessThanOrEqual(7);
      const lowestAllowed = Math.min(17, Math.max(0, (level ?? 0) - 2));
      expect(
        Math.min(...distinctLevels),
        `${span}: distant finer work must wait until the camera approaches it`
      ).toBeGreaterThanOrEqual(lowestAllowed);
      src.resolveAll();
      await Promise.resolve();
    }
  });

  it('lets a streaming coverage source suppress the unavailable whole-genome backstop', () => {
    const totalBp = 3_088_269_832;
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', totalBp)]);
    const src = new FakeInMemoryTileSource({
      id: 'covasm:http://127.0.0.1/remote.bam',
      levelRange: [0, 30],
      manual: true,
    });
    Object.assign(src, {
      prefetch: { wholeGenomeResident: false },
    });
    const coord = new TileCoordinator({
      assembly: grchScale,
      sources: [src],
      cache: new TileCache({ maxEntries: 1024, maxBytes: 1e9 }),
    });

    coord.setViewport({
      globalStart: 1_543_000_000,
      globalEnd: 1_543_010_000,
      viewportPx: 1_000,
    });

    expect(coord.level).toBe(4);
    expect(
      src.fetches.some(({ key }) => key.level === 4),
      'streaming sources must retain exact current-viewport coverage'
    ).toBe(true);
    expect(
      src.fetches.some(({ key }) => key.level === 21),
      'streaming sources cannot materialize a whole-genome pyramid, so they must not retry its permanent 425 response'
    ).toBe(false);
  });

  it('applies wide coverage pan lookahead only to the current level, not adjacent prefetch', () => {
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', 3_100_000_000)]);
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> });
    (src as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }).prefetch = {
      sameLevelMarginTiles: 16,
      sameLevelMarginMinLevel: 9,
      criticalFinerLevel: 10,
      criticalFinerPrefetchLevels: 2,
      criticalFinerMaxCurrentLevel: 18,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: grchScale, sources: [src], cache });

    coord.setViewport({ globalStart: 1_543_000_000, globalEnd: 1_544_000_000, viewportPx: 2676 });

    expect(coord.level).toBe(9);
    const countsByLevel = new Map<number, number>();
    for (const { key } of src.fetches) {
      countsByLevel.set(key.level, (countsByLevel.get(key.level) ?? 0) + 1);
    }
    expect(
      countsByLevel.get(9) ?? 0,
      'same-level coverage must prefetch enough pan-ahead L9 tiles for fast side-scroll'
    ).toBeGreaterThanOrEqual(30);
    expect(
      countsByLevel.get(8) ?? 0,
      'adjacent finer prefetch must not inherit the wide pan margin and flood the fetch queue'
    ).toBeLessThanOrEqual(8);
  });

  it('promotes the leading alignment tile before it becomes visible during a side-pan', () => {
    const source = new FakeInMemoryTileSource({
      id: 'aln:full-bam:chr1',
      levelRange: [0, 2],
      manual: true,
    }) as FakeInMemoryTileSource & {
      prefetch: NonNullable<TileSource['prefetch']>;
    };
    source.prefetch = { sameLevelMarginTiles: 16 };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [source], cache });

    coord.setViewport({ globalStart: 100_000, globalEnd: 100_512, viewportPx: 1_460 });
    coord.setViewport({ globalStart: 99_744, globalEnd: 100_256, viewportPx: 1_460 });

    const currentLevel = coord.level;
    const currentCoreStart = Math.floor(99_744 / (1024 * 2 ** (currentLevel ?? 0)));
    expect(
      source.fetches.some(
        ({ key, priority }) =>
          key.level === currentLevel &&
          key.index < currentCoreStart &&
          priority?.purpose === 'pan-lead' &&
          priority.core === true
      )
    ).toBe(true);
  });

  it('keeps the configured BAM neighborhood warm at the finest read level', () => {
    const source = new FakeInMemoryTileSource({
      id: 'aln:full-bam:chr1',
      levelRange: [0, 2],
      manual: true,
    }) as FakeInMemoryTileSource & {
      prefetch: NonNullable<TileSource['prefetch']>;
    };
    source.prefetch = {
      sameLevelMarginTiles: 16,
      sameLevelMarginMinLevel: 0,
      criticalFinerLevel: 2,
      criticalFinerPrefetchLevels: 2,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [source], cache });

    coord.setViewport({ globalStart: 100_000, globalEnd: 100_512, viewportPx: 1_460 });

    expect(coord.level, 'sanity: this is the exact-read level').toBe(0);
    const currentLevelIndices = source.fetches
      .filter(({ key }) => key.level === 0)
      .map(({ key }) => key.index);
    const visibleStartIndex = Math.floor(100_000 / 1024);
    const visibleEndIndex = Math.floor((100_512 - 1) / 1024);
    expect(Math.min(...currentLevelIndices)).toBe(visibleStartIndex - 16);
    expect(Math.max(...currentLevelIndices)).toBe(visibleEndIndex + 16);
  });

  it('activates additional staged critical handoffs only inside their current-level window', () => {
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', 3_100_000_000)]);
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> });
    (src as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }).prefetch = {
      criticalFinerLevel: 17,
      criticalFinerPrefetchLevels: 14,
      criticalFinerMaxCurrentLevel: 21,
      finerLookaheadWindowBp: 256_000,
      additionalCriticalFinerHandoffs: [
        {
          level: 3,
          prefetchLevels: 1,
          minCurrentLevel: 7,
          maxCurrentLevel: 17,
          lookaheadWindowBp: 32_000,
        },
        {
          level: 2,
          prefetchLevels: 1,
          minCurrentLevel: 7,
          maxCurrentLevel: 17,
          lookaheadWindowBp: 32_000,
        },
      ],
    };
    const cache = new TileCache({ maxEntries: 512, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: grchScale, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 3_100_000_000, viewportPx: 2676 });
    expect(coord.level, 'sanity: whole-genome overview is coarser than the read handoff').toBe(21);
    expect(
      src.fetches.some(({ key }) => key.level === 2),
      'full-genome overview must not enqueue the read-density handoff'
    ).toBe(false);
    expect(
      src.fetches.some(({ key }) => key.level === 3),
      'full-genome overview must not enqueue the read-density bridge handoff'
    ).toBe(false);

    const nearReadSrc = new FakeInMemoryTileSource({
      id: 'cov',
      levelRange: [0, 30],
      manual: true,
    }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> });
    (
      nearReadSrc as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }
    ).prefetch = (
      src as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }
    ).prefetch;
    const nearReadCoord = new TileCoordinator({
      assembly: grchScale,
      sources: [nearReadSrc],
      cache: new TileCache({ maxEntries: 512, maxBytes: 1e9 }),
    });
    nearReadCoord.setViewport({
      globalStart: 1_543_000_000,
      globalEnd: 1_544_000_000,
      viewportPx: 2676,
    });

    expect(nearReadCoord.level, 'sanity: this viewport is near the read-density handoff').toBe(9);
    expect(
      nearReadSrc.fetches.some(({ key }) => key.level === 2),
      'level-9 coverage must warm exact read-density coverage before read rows take over'
    ).toBe(true);
    const nearReadL3 = nearReadSrc.fetches.findIndex(({ key }) => key.level === 3);
    const nearReadL2 = nearReadSrc.fetches.findIndex(({ key }) => key.level === 2);
    expect(
      nearReadL3,
      'level-9 coverage must warm the publishable read-density bridge'
    ).toBeGreaterThanOrEqual(0);
    expect(
      nearReadL3,
      'the publishable level-3 bridge must be queued before exact level-2 density'
    ).toBeLessThan(nearReadL2);

    const readBoundarySrc = new FakeInMemoryTileSource({
      id: 'cov',
      levelRange: [0, 30],
      manual: true,
    }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> });
    (
      readBoundarySrc as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }
    ).prefetch = (
      src as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }
    ).prefetch;
    const readBoundaryCoord = new TileCoordinator({
      assembly: grchScale,
      sources: [readBoundarySrc],
      cache: new TileCache({ maxEntries: 512, maxBytes: 1e9 }),
    });
    readBoundaryCoord.setViewport({
      globalStart: 1_543_000_000,
      globalEnd: 1_543_146_000,
      viewportPx: 2676,
    });

    expect(readBoundaryCoord.level, 'sanity: this viewport is below the staging window').toBe(6);
    expect(
      readBoundarySrc.fetches.some(({ key }) => key.level === 2),
      'level-6 coverage must not start a new read-density staged handoff'
    ).toBe(false);
    expect(
      readBoundarySrc.fetches.some(({ key }) => key.level === 3),
      'level-6 coverage must not start a new read-density bridge staged handoff'
    ).toBe(false);
  });

  it('does not apply wide coverage pan lookahead at exact-read zoom levels', () => {
    const grchScale = buildAssembly('grch-scale', 'grch-scale', [chrom('chr1', 3_100_000_000)]);
    const src = new FakeInMemoryTileSource({ id: 'cov', levelRange: [0, 30], manual: true }) as
      | FakeInMemoryTileSource
      | (FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> });
    (src as FakeInMemoryTileSource & { prefetch: NonNullable<TileSource['prefetch']> }).prefetch = {
      sameLevelMarginTiles: 64,
      sameLevelMarginMinLevel: 9,
      criticalFinerLevel: 17,
      criticalFinerPrefetchLevels: 14,
      criticalFinerMaxCurrentLevel: 21,
      finerLookaheadWindowBp: 256_000,
    };
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: grchScale, sources: [src], cache });

    coord.setViewport({ globalStart: 976_550_000, globalEnd: 976_557_100, viewportPx: 2676 });

    expect(
      coord.level,
      'sanity: this is read-detail zoom, below the L9/L10 coverage handoff'
    ).toBeLessThan(9);
    const currentLevelFetchCount = src.fetches.filter(
      ({ key }) => key.level === coord.level
    ).length;
    expect(
      currentLevelFetchCount,
      'exact-read zoom must not enqueue a 64-tile coverage pan band that starves visible alignment responses'
    ).toBeLessThanOrEqual(12);
  });

  it('does not prefetch a next-finer level outside the source levelRange', () => {
    const src = new FakeInMemoryTileSource({ id: 'coarse', levelRange: [4, 30], manual: true });
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const coord = new TileCoordinator({ assembly: asm, sources: [src], cache });

    coord.setViewport({ globalStart: 0, globalEnd: 10_000, viewportPx: 625 });
    coord.setViewport({ globalStart: 0, globalEnd: 10_000, viewportPx: 1_000 });

    expect(coord.level).toBe(4);
    expect(src.fetches.some(({ key }) => key.level === 4)).toBe(true);
    expect(src.fetches.some(({ key }) => key.level === 3)).toBe(false);
  });

  it('a source that resolves an error marks the tile state error (not ready)', async () => {
    const src = new FakeInMemoryTileSource({
      id: 's',
      levelRange: [0, 30],
      manual: false,
      dataFor: () => ({ state: 'error', errorReason: 'index-missing', byteSize: 0, count: 0 }),
    });
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const errors: Array<{ key: TileKey; reason: string }> = [];
    const ready: TileKey[] = [];
    const coord = new TileCoordinator({
      assembly: asm,
      sources: [src],
      cache,
      onTileReady: (k) => ready.push(k),
      onTileError: (key, reason) => errors.push({ key, reason }),
    });
    coord.setViewport({ globalStart: 1000, globalEnd: 3000, viewportPx: 1000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].reason).toBe('index-missing');
    expect(ready.length).toBe(0);
    expect(
      cache
        .entries()
        .filter((entry) => entry.state === 'error')
        .every((entry) => entry.data?.errorReason === 'index-missing')
    ).toBe(true);
  });

  it('does not strand a wanted tile when a shared reader aborts without cancelling its request', async () => {
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const failures: string[] = [];
    const source: TileSource = {
      id: 'shared-reader',
      levelRange: [0, 30],
      async fetchTile() {
        throw new DOMException('Another reader cancelled a shared lookup.', 'AbortError');
      },
    };
    const coord = new TileCoordinator({
      assembly: asm,
      sources: [source],
      cache,
      onTileError: (_key, reason) => failures.push(reason),
    });
    coord.setViewport({ globalStart: 1000, globalEnd: 3000, viewportPx: 1000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toContain('fetch-failed');
    expect(cache.entries().every((entry) => entry.state === 'error')).toBe(true);
    expect(coord.inFlight).toBe(0);
  });

  it('a tile that errored (e.g. 429 queue-full) is RE-FETCHED on the next commit (self-heals)', async () => {
    const seen = new Set<string>();
    const src = new FakeInMemoryTileSource({
      id: 's',
      levelRange: [0, 30],
      manual: false,
      dataFor: (key) => {
        const ks = `${key.sourceId}:${key.level}:${key.index}`;
        if (!seen.has(ks)) {
          seen.add(ks);
          return { state: 'error', errorReason: 'queue-full', byteSize: 0, count: 0 };
        }
        return { state: 'ready', byteSize: 8, count: 1 };
      },
    });
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const ready: TileKey[] = [];
    const errors: Array<{ key: TileKey; reason: string }> = [];
    const coord = new TileCoordinator({
      assembly: asm,
      sources: [src],
      cache,
      onTileReady: (k) => ready.push(k),
      onTileError: (key, reason) => errors.push({ key, reason }),
    });
    const view = { globalStart: 1000, globalEnd: 3000, viewportPx: 1000 };
    coord.setViewport(view);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.length).toBeGreaterThan(0);
    expect(ready.length).toBe(0);
    coord.setViewport(view);
    await Promise.resolve();
    await Promise.resolve();
    expect(ready.length).toBeGreaterThan(0);
  });

  it('inFlight drops back to 0 once all current fetches resolve', async () => {
    const h = makeHarness();
    h.coord.setViewport({ globalStart: 1000, globalEnd: 3000, viewportPx: 1000 });
    expect(h.coord.inFlight).toBeGreaterThan(0);
    h.source.resolveAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.coord.inFlight).toBe(0);
  });
});
