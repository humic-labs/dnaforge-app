import type { TileKey, TileData, TileFetchContext } from './tile-source';
import { tileKeyString } from './tile-source';

export type TileEntryState = 'pending' | 'ready' | 'error';

export interface TileEntry {
  readonly key: TileKey;
  state: TileEntryState;
  epoch: number;
  byteSize: number;
  data?: TileData;
  abort?: AbortController;
  priority?: TileFetchContext['priority'];
  gpu?: unknown;
}

export interface TileCacheOptions {
  maxEntries: number;
  maxBytes: number;
  disposeTile?: (entry: TileEntry) => void;
}

export class TileCache {
  private readonly map = new Map<string, TileEntry>();
  private readonly pinned = new Set<string>();
  private readonly retained = new Set<string>();
  private bytes = 0;
  readonly maxEntries: number;
  readonly maxBytes: number;
  private readonly disposeTile?: (entry: TileEntry) => void;

  constructor(opts: TileCacheOptions) {
    this.maxEntries = opts.maxEntries;
    this.maxBytes = opts.maxBytes;
    this.disposeTile = opts.disposeTile;
  }

  get size(): number {
    return this.map.size;
  }
  get byteSize(): number {
    return this.bytes;
  }

  has(key: TileKey): boolean {
    return this.map.has(tileKeyString(key));
  }

  get(key: TileKey): TileEntry | undefined {
    const ks = tileKeyString(key);
    const e = this.map.get(ks);
    if (!e) return undefined;
    this.map.delete(ks);
    this.map.set(ks, e);
    return e;
  }

  peek(key: TileKey): TileEntry | undefined {
    return this.map.get(tileKeyString(key));
  }

  entries(): TileEntry[] {
    return [...this.map.values()];
  }

  set(entry: TileEntry): void {
    const ks = tileKeyString(entry.key);
    const prev = this.map.get(ks);
    if (prev) {
      this.bytes -= prev.byteSize;
      this.map.delete(ks);
    }
    this.bytes += entry.byteSize;
    this.map.set(ks, entry);
    this.enforceBounds();
  }

  resolve(key: TileKey, data: TileData, gpu?: unknown): void {
    const ks = tileKeyString(key);
    const e = this.map.get(ks);
    if (!e) return;
    this.bytes -= e.byteSize;
    e.state = data.state;
    e.data = data;
    e.byteSize = data.byteSize;
    e.gpu = gpu;
    e.abort = undefined;
    e.priority = undefined;
    this.bytes += e.byteSize;
    this.map.delete(ks);
    this.map.set(ks, e);
    this.enforceBounds();
  }

  pin(key: TileKey): void {
    this.pinned.add(tileKeyString(key));
  }
  setPins(keys: Iterable<TileKey>): void {
    this.pinned.clear();
    for (const k of keys) this.pinned.add(tileKeyString(k));
  }
  setRetained(keys: Iterable<TileKey>): void {
    this.retained.clear();
    for (const k of keys) this.retained.add(tileKeyString(k));
  }
  isPinned(key: TileKey): boolean {
    return this.pinned.has(tileKeyString(key));
  }
  isRetained(key: TileKey): boolean {
    return this.retained.has(tileKeyString(key));
  }

  evict(key: TileKey): boolean {
    const ks = tileKeyString(key);
    if (this.pinned.has(ks) || this.retained.has(ks)) return false;
    return this.evictByString(ks);
  }

  cancelPendingWhere(predicate: (entry: TileEntry) => boolean): number {
    let cancelled = 0;
    for (const [ks, entry] of [...this.map.entries()]) {
      if (entry.state !== 'pending' || !predicate(entry)) continue;
      if (this.evictByString(ks)) cancelled += 1;
    }
    return cancelled;
  }

  private evictByString(ks: string): boolean {
    const e = this.map.get(ks);
    if (!e) return false;
    this.onEvict(e);
    this.bytes -= e.byteSize;
    this.map.delete(ks);
    this.retained.delete(ks);
    return true;
  }

  private onEvict(entry: TileEntry): void {
    if (entry.state === 'pending' && entry.abort) {
      entry.abort.abort();
    } else if (entry.gpu !== undefined) {
      this.disposeTile?.(entry);
    }
  }

  private enforceBounds(): void {
    for (const ks of [...this.map.keys()]) {
      if (this.map.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      if (this.pinned.has(ks)) continue;
      this.evictByString(ks);
    }
  }

  clear(): void {
    for (const ks of [...this.map.keys()]) this.evictByString(ks);
    this.pinned.clear();
    this.retained.clear();
    this.bytes = 0;
  }
}
