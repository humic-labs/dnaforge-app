import type { AssemblySegment } from '../assembly-layout';
import type { TileTransportPriority } from './sources/tile-transport';

export interface TileKey {
  readonly sourceId: string;
  readonly level: number;
  readonly index: number;
}

export function tileKeyString(key: TileKey): string {
  return `${key.sourceId}:${key.level}:${key.index}`;
}

export function parseTileKey(s: string): TileKey {
  const lastColon = s.lastIndexOf(':');
  const prevColon = s.lastIndexOf(':', lastColon - 1);
  return {
    sourceId: s.slice(0, prevColon),
    level: Number(s.slice(prevColon + 1, lastColon)),
    index: Number(s.slice(lastColon + 1)),
  };
}

export interface TileData {
  readonly key: TileKey;
  readonly state: 'ready' | 'error';
  readonly byteSize: number;
  readonly count: number;
  readonly payload?: unknown;
  readonly errorReason?: string;
  readonly errorRetryable?: boolean;
  readonly errorScope?: 'source' | 'request';
}

export interface TileFetchContext {
  readonly priority?: TileTransportPriority;
}

export interface TileSource {
  readonly id: string;
  readonly levelRange: readonly [number, number];
  readonly prefetch?: {
    readonly wholeGenomeResident?: boolean;
    readonly coverageWorkingSetMarginTiles?: number;
    readonly sameLevelMarginTiles?: number;
    readonly sameLevelMarginMinLevel?: number;
    readonly criticalFinerLevel?: number;
    readonly criticalFinerPrefetchLevels?: number;
    readonly criticalFinerMaxCurrentLevel?: number;
    readonly finerLookaheadWindowBp?: number;
    readonly additionalCriticalFinerHandoffs?: readonly {
      readonly level: number;
      readonly prefetchLevels?: number;
      readonly minCurrentLevel?: number;
      readonly maxCurrentLevel?: number;
      readonly lookaheadWindowBp?: number;
    }[];
  };
  fetchTile(
    level: number,
    index: number,
    segments: AssemblySegment[],
    signal: AbortSignal,
    context?: TileFetchContext
  ): Promise<TileData>;
}

export function levelInRange(source: TileSource, level: number): boolean {
  return level >= source.levelRange[0] && level <= source.levelRange[1];
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export interface FakeTileSourceOptions {
  id: string;
  levelRange: readonly [number, number];
  byteSize?: number;
  dataFor?: (key: TileKey) => Partial<TileData>;
  manual?: boolean;
  resolveAfterAbort?: boolean;
}

export class FakeInMemoryTileSource implements TileSource {
  readonly id: string;
  readonly levelRange: readonly [number, number];
  private readonly byteSize: number;
  private readonly dataFor?: (key: TileKey) => Partial<TileData>;
  private readonly manual: boolean;
  private readonly resolveAfterAbort: boolean;

  readonly fetches: Array<{
    key: TileKey;
    aborted: boolean;
    priority?: TileFetchContext['priority'];
  }> = [];
  private readonly pending = new Map<
    string,
    Array<{ resolve: (d: TileData) => void; reject: (e: unknown) => void; key: TileKey }>
  >();

  constructor(opts: FakeTileSourceOptions) {
    this.id = opts.id;
    this.levelRange = opts.levelRange;
    this.byteSize = opts.byteSize ?? 1024;
    this.dataFor = opts.dataFor;
    this.manual = opts.manual ?? false;
    this.resolveAfterAbort = opts.resolveAfterAbort ?? false;
  }

  fetchTile(
    level: number,
    index: number,
    _segments: AssemblySegment[],
    signal: AbortSignal,
    context?: TileFetchContext
  ): Promise<TileData> {
    const key: TileKey = { sourceId: this.id, level, index };
    const record = { key, aborted: false, priority: context?.priority };
    this.fetches.push(record);
    const data: TileData = {
      key,
      state: 'ready',
      byteSize: this.byteSize,
      count: 1,
      ...this.dataFor?.(key),
    };
    if (signal.aborted) {
      record.aborted = true;
      return Promise.reject(abortError());
    }
    if (!this.manual) {
      return Promise.resolve(data);
    }
    return new Promise<TileData>((resolve, reject) => {
      const ks = tileKeyString(key);
      const queue = this.pending.get(ks) ?? [];
      queue.push({ resolve, reject, key });
      this.pending.set(ks, queue);
      signal.addEventListener('abort', () => {
        record.aborted = true;
        if (this.resolveAfterAbort) return;
        this.deletePending(ks, resolve);
        reject(abortError());
      });
    });
  }

  private takePending(key: TileKey): {
    resolve: (d: TileData) => void;
    reject: (e: unknown) => void;
    key: TileKey;
  } | null {
    const ks = tileKeyString(key);
    const queue = this.pending.get(ks);
    const p = queue?.shift();
    if (!queue || queue.length === 0) {
      this.pending.delete(ks);
    }
    return p ?? null;
  }

  private deletePending(ks: string, resolve: (d: TileData) => void): void {
    const queue = this.pending.get(ks);
    if (!queue) return;
    const next = queue.filter((p) => p.resolve !== resolve);
    if (next.length > 0) {
      this.pending.set(ks, next);
    } else {
      this.pending.delete(ks);
    }
  }

  resolveKey(key: TileKey, override?: Partial<TileData>): void {
    const p = this.takePending(key);
    if (!p) return;
    p.resolve({
      key,
      state: 'ready',
      byteSize: this.byteSize,
      count: 1,
      ...this.dataFor?.(key),
      ...override,
    });
  }

  rejectKey(key: TileKey, error: unknown = new Error('fetch failed')): void {
    const p = this.takePending(key);
    if (!p) return;
    p.reject(error);
  }

  resolveAll(): void {
    const keys = [...this.pending.values()].flat().map((p) => p.key);
    for (const key of keys) {
      this.resolveKey(key);
    }
  }

  get pendingCount(): number {
    let count = 0;
    for (const queue of this.pending.values()) {
      count += queue.length;
    }
    return count;
  }
}
