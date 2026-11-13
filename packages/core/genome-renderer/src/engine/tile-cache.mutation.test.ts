import { describe, it } from 'vitest';
import type { TileKey, TileData } from './tile-source';
import { tileKeyString } from './tile-source';
import type { TileEntry } from './tile-cache';
import { TileCache } from './tile-cache';
import {
  assertByteBound,
  assertLruTouch,
  assertPinProtection,
  assertEvictAbortsPending,
  assertEvictDisposesGpu,
} from './tile-cache-assertions';
import { assertMutantKilled, assertCorrectImplPasses } from './testing/mutation-harness';

type Mutation =
  | 'byte-bound-dropped'
  | 'lru-touch-dropped'
  | 'pin-guard-evict-dropped'
  | 'pin-guard-enforce-dropped'
  | 'onevict-abort-dropped'
  | 'onevict-dispose-dropped';

class MutantCache {
  private readonly map = new Map<string, TileEntry>();
  private readonly pinned = new Set<string>();
  private bytes = 0;
  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
    private readonly disposeTile: (e: TileEntry) => void,
    private readonly mut: Mutation
  ) {}
  get size() {
    return this.map.size;
  }
  get byteSize() {
    return this.bytes;
  }
  has(k: TileKey) {
    return this.map.has(tileKeyString(k));
  }
  peek(k: TileKey) {
    return this.map.get(tileKeyString(k));
  }
  get(k: TileKey) {
    const ks = tileKeyString(k);
    const e = this.map.get(ks);
    if (!e) return undefined;
    if (this.mut !== 'lru-touch-dropped') {
      this.map.delete(ks);
      this.map.set(ks, e);
    }
    return e;
  }
  set(entry: TileEntry) {
    const ks = tileKeyString(entry.key);
    const prev = this.map.get(ks);
    if (prev) {
      this.bytes -= prev.byteSize;
      this.map.delete(ks);
    }
    this.bytes += entry.byteSize;
    this.map.set(ks, entry);
    this.enforce();
  }
  pin(k: TileKey) {
    this.pinned.add(tileKeyString(k));
  }
  resolve(k: TileKey, data: TileData) {
    const e = this.map.get(tileKeyString(k));
    if (!e) return;
    this.bytes -= e.byteSize;
    e.state = data.state;
    e.byteSize = data.byteSize;
    this.bytes += e.byteSize;
    this.enforce();
  }
  evict(k: TileKey): boolean {
    const ks = tileKeyString(k);
    if (this.mut !== 'pin-guard-evict-dropped' && this.pinned.has(ks)) return false;
    return this.evictByString(ks);
  }
  private evictByString(ks: string): boolean {
    const e = this.map.get(ks);
    if (!e) return false;
    this.onEvict(e);
    this.bytes -= e.byteSize;
    this.map.delete(ks);
    return true;
  }
  private onEvict(e: TileEntry) {
    if (e.state === 'pending' && e.abort) {
      if (this.mut !== 'onevict-abort-dropped') e.abort.abort();
    } else if (e.gpu !== undefined) {
      if (this.mut !== 'onevict-dispose-dropped') this.disposeTile(e);
    }
  }
  private enforce() {
    for (const ks of [...this.map.keys()]) {
      const countOk = this.map.size <= this.maxEntries;
      const byteOk = this.mut === 'byte-bound-dropped' ? true : this.bytes <= this.maxBytes;
      if (countOk && byteOk) break;
      if (this.mut !== 'pin-guard-enforce-dropped' && this.pinned.has(ks)) continue;
      this.evictByString(ks);
    }
  }
}

function mutant(mut: Mutation, maxEntries: number, maxBytes: number, disposed: unknown[] = []) {
  return new MutantCache(
    maxEntries,
    maxBytes,
    (e) => disposed.push(e.gpu),
    mut
  ) as unknown as TileCache;
}

describe('engine/tile-cache — MUTATION kills', () => {
  it('byte-bound dropped (count-only) is killed by assertByteBound', () => {
    assertMutantKilled('byte-bound-dropped', () =>
      assertByteBound(mutant('byte-bound-dropped', 100, 100))
    );
  });
  it('LRU-touch dropped is killed by assertLruTouch', () => {
    assertMutantKilled('lru-touch-dropped', () =>
      assertLruTouch(mutant('lru-touch-dropped', 3, 1e9))
    );
  });
  it('pin-guard (evict) dropped is killed by assertPinProtection', () => {
    assertMutantKilled('pin-guard-evict-dropped', () =>
      assertPinProtection(mutant('pin-guard-evict-dropped', 3, 1e9))
    );
  });
  it('pin-guard (enforceBounds) dropped is killed by assertPinProtection', () => {
    assertMutantKilled('pin-guard-enforce-dropped', () =>
      assertPinProtection(mutant('pin-guard-enforce-dropped', 3, 1e9))
    );
  });
  it('onEvict abort dropped (leak) is killed by assertEvictAbortsPending', () => {
    assertMutantKilled('onevict-abort-dropped', () =>
      assertEvictAbortsPending(mutant('onevict-abort-dropped', 100, 1e9))
    );
  });
  it('onEvict dispose dropped (leak) is killed by assertEvictDisposesGpu', () => {
    const disposed: unknown[] = [];
    assertMutantKilled('onevict-dispose-dropped', () =>
      assertEvictDisposesGpu(mutant('onevict-dispose-dropped', 100, 1e9, disposed), disposed)
    );
  });

  it('CONTROL: shared blocks PASS on the real TileCache (not vacuous)', () => {
    const make = (me: number, mb: number, d: unknown[] = []) =>
      new TileCache({ maxEntries: me, maxBytes: mb, disposeTile: (e) => d.push(e.gpu) });
    assertCorrectImplPasses('byte', () => assertByteBound(make(100, 100)));
    assertCorrectImplPasses('lru', () => assertLruTouch(make(3, 1e9)));
    assertCorrectImplPasses('pin', () => assertPinProtection(make(3, 1e9)));
    assertCorrectImplPasses('abort', () => assertEvictAbortsPending(make(100, 1e9)));
    const d: unknown[] = [];
    assertCorrectImplPasses('dispose', () => assertEvictDisposesGpu(make(100, 1e9, d), d));
  });
});
