import { describe, it } from 'vitest';
import type { Assembly } from '../assembly';
import type { Chromosome } from '../chromosome';
import { buildAssembly } from '../assembly-layout';
import { pickLevel, visibleTiles, maxLevelForAssembly, type Viewport } from './lod';
import { TileCache } from './tile-cache';
import {
  FakeInMemoryTileSource,
  levelInRange,
  tileKeyString,
  type TileSource,
  type TileKey,
  type TileData,
} from './tile-source';
import { TileCoordinator } from './coordinator';
import {
  assertUnconditionalEpochBump,
  assertStaleArrivalDropped,
  assertStaleRejectionDropped,
  assertStaleResolutionDoesNotClearCurrentFetch,
  assertStaleRejectionDoesNotClearCurrentFetch,
  assertCurrentArrivalEmitted,
  assertAbortOnLeave,
  assertPendingNotRefetched,
  type Harness,
  type CoordinatorLike,
} from './coordinator-assertions';
import { assertMutantKilledAsync, assertCorrectImplPassesAsync } from './testing/mutation-harness';

function chrom(id: string, length: number): Chromosome {
  return { id, displayName: id, length, cytobands: [] };
}
const asm = buildAssembly('test', 'test', [chrom('chr1', 200_000), chrom('chr2', 200_000)]);

type Mut =
  | 'epoch-bump-dropped'
  | 'stale-compare-inverted'
  | 'stale-guard-dropped'
  | 'stale-reject-guard-dropped'
  | 'stale-resolve-controller-delete-before-guard'
  | 'stale-reject-controller-delete-before-guard'
  | 'abort-on-leave-dropped'
  | 'pending-refetched';

class MutantCoordinator implements CoordinatorLike {
  private currentEpoch = 0;
  private lastLevel: number | null = null;
  private readonly controllers = new Map<string, AbortController>();
  private readonly maxLevel: number;
  constructor(
    private readonly assembly: Assembly,
    private readonly sources: TileSource[],
    private readonly cache: TileCache,
    private readonly ready: TileKey[],
    private readonly errors: Array<{ key: TileKey; reason: string }>,
    private readonly mut: Mut
  ) {
    this.maxLevel = maxLevelForAssembly(assembly);
  }
  get epoch() {
    return this.currentEpoch;
  }
  get level() {
    return this.lastLevel;
  }
  get inFlight() {
    return this.controllers.size;
  }

  setViewport(view: Viewport): void {
    const L = pickLevel(view, this.maxLevel, this.lastLevel);
    this.lastLevel = L;
    if (this.mut !== 'epoch-bump-dropped') this.currentEpoch++;

    const tiles = visibleTiles(view, L, this.assembly);
    const visibleKeys = new Set<string>();
    for (const source of this.sources) {
      if (!levelInRange(source, L)) continue;
      for (const t of tiles) {
        const key: TileKey = { sourceId: source.id, level: L, index: t.index };
        const ks = tileKeyString(key);
        visibleKeys.add(ks);
        const existing = this.cache.peek(key);
        if (existing && this.mut !== 'pending-refetched') {
          if (existing.state === 'ready') this.cache.get(key);
          continue;
        }
        const ac = new AbortController();
        this.controllers.set(ks, ac);
        this.cache.set({ key, state: 'pending', epoch: this.currentEpoch, byteSize: 0, abort: ac });
        const stamped = this.currentEpoch;
        source
          .fetchTile(L, t.index, t.segments, ac.signal)
          .then((d) => this.onResolve(key, stamped, d))
          .catch((e) => this.onReject(key, stamped, e));
      }
    }
    if (this.mut !== 'abort-on-leave-dropped') {
      for (const entry of this.cache.entries()) {
        const ks = tileKeyString(entry.key);
        if (visibleKeys.has(ks)) continue;
        if (this.cache.isPinned(entry.key)) continue;
        this.controllers.delete(ks);
        this.cache.evict(entry.key);
      }
    }
  }

  private onResolve(key: TileKey, stamped: number, data: TileData): void {
    const entry = this.cache.peek(key);
    const wanted = !!entry && entry.epoch === stamped;
    const stale = this.mut === 'stale-compare-inverted' ? wanted : !wanted;
    if (this.mut === 'stale-resolve-controller-delete-before-guard') {
      this.controllers.delete(tileKeyString(key));
    }
    if (this.mut !== 'stale-guard-dropped' && stale) return;
    this.controllers.delete(tileKeyString(key));
    if (data.state === 'error') return;
    this.cache.resolve(key, data);
    this.ready.push(key);
  }
  private onReject(key: TileKey, stamped: number, err: unknown): void {
    const name = (err as { name?: string } | undefined)?.name;
    if (name === 'AbortError') return;
    const entry = this.cache.peek(key);
    const wanted = !!entry && entry.epoch === stamped;
    if (this.mut === 'stale-reject-controller-delete-before-guard') {
      this.controllers.delete(tileKeyString(key));
    }
    if (this.mut !== 'stale-reject-guard-dropped' && !wanted) return;
    this.controllers.delete(tileKeyString(key));
    if (entry) entry.state = 'error';
    this.errors.push({ key, reason: 'fetch-failed' });
  }
}

function makeMutantHarness(mut: Mut): (a: Assembly, s: FakeInMemoryTileSource) => Harness {
  return (a, s) => {
    const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
    const ready: TileKey[] = [];
    const errors: Array<{ key: TileKey; reason: string }> = [];
    const coord = new MutantCoordinator(a, [s], cache, ready, errors, mut);
    return { coord, source: s, cache, ready, errors };
  };
}

function makeRealHarness(a: Assembly, s: FakeInMemoryTileSource): Harness {
  const cache = new TileCache({ maxEntries: 256, maxBytes: 1e9 });
  const ready: TileKey[] = [];
  const errors: Array<{ key: TileKey; reason: string }> = [];
  const coord = new TileCoordinator({
    assembly: a,
    sources: [s],
    cache,
    onTileReady: (k) => ready.push(k),
    onTileError: (key, reason) => errors.push({ key, reason }),
  });
  return { coord, source: s, cache, ready, errors };
}

describe('engine/coordinator — MUTATION kills', () => {
  it('epoch-bump dropped is killed by the unconditional-epoch-bump block', async () => {
    await assertMutantKilledAsync('epoch-bump-dropped', () =>
      assertUnconditionalEpochBump(asm, makeMutantHarness('epoch-bump-dropped'))
    );
  });
  it('stale-guard `!==`→`===` is killed by the current-arrival-emitted block', async () => {
    await assertMutantKilledAsync('stale-compare-inverted', () =>
      assertCurrentArrivalEmitted(asm, makeMutantHarness('stale-compare-inverted'))
    );
  });
  it('stale-guard dropped is killed by the stale-arrival-drop block', async () => {
    await assertMutantKilledAsync('stale-guard-dropped', () =>
      assertStaleArrivalDropped(asm, makeMutantHarness('stale-guard-dropped'))
    );
  });
  it('stale reject guard dropped is killed by the stale-rejection-drop block', async () => {
    await assertMutantKilledAsync('stale-reject-guard-dropped', () =>
      assertStaleRejectionDropped(asm, makeMutantHarness('stale-reject-guard-dropped'))
    );
  });
  it('stale resolve deleting the controller before the guard is killed', async () => {
    await assertMutantKilledAsync('stale-resolve-controller-delete-before-guard', () =>
      assertStaleResolutionDoesNotClearCurrentFetch(
        asm,
        makeMutantHarness('stale-resolve-controller-delete-before-guard')
      )
    );
  });
  it('stale reject deleting the controller before the guard is killed', async () => {
    await assertMutantKilledAsync('stale-reject-controller-delete-before-guard', () =>
      assertStaleRejectionDoesNotClearCurrentFetch(
        asm,
        makeMutantHarness('stale-reject-controller-delete-before-guard')
      )
    );
  });
  it('abort-on-leave dropped is killed by the abort-on-leave block', async () => {
    await assertMutantKilledAsync('abort-on-leave-dropped', () =>
      assertAbortOnLeave(asm, makeMutantHarness('abort-on-leave-dropped'))
    );
  });
  it('pending re-enqueued is killed by the pending-not-refetched block', async () => {
    await assertMutantKilledAsync('pending-refetched', () =>
      assertPendingNotRefetched(asm, makeMutantHarness('pending-refetched'))
    );
  });

  it('CONTROL: every shared block PASSES on the real coordinator (not vacuous)', async () => {
    await assertCorrectImplPassesAsync('epoch', () =>
      assertUnconditionalEpochBump(asm, makeRealHarness)
    );
    await assertCorrectImplPassesAsync('stale', () =>
      assertStaleArrivalDropped(asm, makeRealHarness)
    );
    await assertCorrectImplPassesAsync('stale-reject', () =>
      assertStaleRejectionDropped(asm, makeRealHarness)
    );
    await assertCorrectImplPassesAsync('stale-resolve-keeps-current-fetch', () =>
      assertStaleResolutionDoesNotClearCurrentFetch(asm, makeRealHarness)
    );
    await assertCorrectImplPassesAsync('stale-reject-keeps-current-fetch', () =>
      assertStaleRejectionDoesNotClearCurrentFetch(asm, makeRealHarness)
    );
    await assertCorrectImplPassesAsync('current', () =>
      assertCurrentArrivalEmitted(asm, makeRealHarness)
    );
    await assertCorrectImplPassesAsync('abort', () => assertAbortOnLeave(asm, makeRealHarness));
    await assertCorrectImplPassesAsync('pending', () =>
      assertPendingNotRefetched(asm, makeRealHarness)
    );
  });
});
