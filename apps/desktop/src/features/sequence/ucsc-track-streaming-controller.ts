import {
  normalizeQuantitativeTrackPresentation,
  sameAdmittedTrackSourceIdentity,
  type PileupReferenceInterval,
} from '@waypoint/genome-data';
import {
  levelInRange,
  maxLevelForAssembly,
  pickLevel,
  PREFETCH_MARGIN_TILES,
  TileCache,
  TileCoordinator,
  tileKeyString,
  visibleTiles,
  type Assembly,
  type TileEntry,
  type Viewport,
} from '@waypoint/genome-renderer';

import type { Lane } from './lane-contract-store';
import {
  createAdmittedTrackTileSource,
  isUcscTilePayload,
  type UcscRenderableRecord,
  type UcscTileSource,
} from './ucsc-tile-source';

const MAX_CACHE_ENTRIES = 96;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const TILE_STALL_TIMEOUT_MS = 20_000;
const RETRY_MAX_DELAY_MS = 30_000;
const MAX_AUTOMATIC_RETRIES = 5;

export interface UcscStreamingDebug {
  readonly status: 'idle' | 'zoom-in' | 'loading' | 'ready' | 'error';
  readonly viewport?: { readonly start: number; readonly end: number };
  readonly trackIds: ReadonlyArray<string>;
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly compositionCounts?: Readonly<Record<string, number>>;
  readonly errorsByTrackId?: Readonly<Record<string, string>>;
  readonly recoveringTrackIds?: ReadonlyArray<string>;
  readonly message?: string;
}

interface RendererTrackDataTarget {
  hasTrackInstance(trackId: string): boolean;
  setTrackData(trackId: string, data: { records: ReadonlyArray<UcscRenderableRecord> }): void;
}

export interface UcscStreamingPresentationTarget {
  getRenderer(): RendererTrackDataTarget | null;
  requestRender(): void;
  publishDebug(debug: UcscStreamingDebug): void;
  publishTrackRecords?(
    trackId: string,
    records: ReadonlyArray<UcscRenderableRecord>,
    revision: string
  ): void;
  publishTrackPendingIntervals?(
    trackId: string,
    intervals: ReadonlyArray<PileupReferenceInterval>
  ): void;
}

type SourceLane = Lane & { source: NonNullable<Lane['source']> };

type SourceRecovery =
  | { readonly phase: 'active' }
  | { readonly phase: 'retrying'; readonly attempt: number; readonly reason: string }
  | {
      readonly phase: 'recovering';
      readonly attempt: number;
      readonly reason: string;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  | { readonly phase: 'blocked'; readonly reason: string };

interface SourceLifetime {
  generation: number;
  recovery: SourceRecovery;
}

export class UcscTrackStreamingController {
  private readonly assembly: Assembly;
  private lanes: ReadonlyArray<SourceLane>;
  private readonly sources: UcscTileSource[];
  private readonly createSource: typeof createAdmittedTrackTileSource;
  private readonly cache: TileCache;
  private readonly coordinator: TileCoordinator;
  private readonly target: UcscStreamingPresentationTarget;
  private readonly publicationSignatures = new Map<string, string>();
  private readonly pendingIntervalSignatures = new Map<string, string>();
  private readonly publicationRecordCounts = new Map<string, number>();
  private readonly compositionCounts = new Map<string, number>();
  private readonly sourceLifetimes = new Map<string, SourceLifetime>();
  private readonly presentationKeys = new Set<string>();
  private smoothingHaloTrackIds = new Set<string>();
  private presentationRenderer: RendererTrackDataTarget | null = null;
  private viewport: Viewport | null = null;
  private disposed = false;

  constructor(input: {
    readonly assembly: Assembly;
    readonly lanes: ReadonlyArray<Lane>;
    readonly target: UcscStreamingPresentationTarget;
    readonly createSource?: typeof createAdmittedTrackTileSource;
  }) {
    this.assembly = input.assembly;
    this.lanes = input.lanes.filter(isSourceLane);
    this.smoothingHaloTrackIds = smoothingHaloTrackIds(input.lanes);
    this.createSource = input.createSource ?? createAdmittedTrackTileSource;
    this.sources = this.lanes.map((lane) =>
      this.makeSource({
        assembly: this.assembly,
        trackId: lane.dataset.trackId,
        source: lane.source,
      })
    );
    this.cache = new TileCache({
      maxEntries: MAX_CACHE_ENTRIES,
      maxBytes: MAX_CACHE_BYTES,
    });
    this.target = input.target;
    this.coordinator = new TileCoordinator({
      assembly: this.assembly,
      sources: this.sources,
      cache: this.cache,
      canFetchSource: (sourceId) => {
        const phase = this.sourceLifetimes.get(sourceId)?.recovery.phase;
        return phase === 'active' || phase === 'retrying';
      },
      onTileReady: (key) => this.presentCurrentViewport(key.sourceId),
      onTileError: (key, reason, retryable) => {
        const lifetime = this.sourceLifetimes.get(key.sourceId);
        if (!lifetime) return;
        if (this.cache.peek(key)?.data?.errorScope === 'request') {
          if (lifetime.recovery.phase === 'retrying') lifetime.recovery = { phase: 'active' };
        } else if (!retryable || this.presentationKeys.has(tileKeyString(key))) {
          this.failSource(key.sourceId, lifetime, reason, retryable);
        }
        this.presentCurrentViewport();
      },
    });
  }

  setViewport(viewport: Viewport): void {
    if (this.disposed) return;
    this.viewport = viewport;
    if (this.sources.length === 0) {
      this.cache.setPins([]);
      this.presentationKeys.clear();
      this.coordinator.setViewport(viewport);
      this.target.publishDebug({ status: 'idle', trackIds: [], recordCounts: {} });
      return;
    }
    this.commitViewportFetch(viewport);
    this.presentCurrentViewport();
  }

  refreshPresentationOwner(reseededTrackIds: ReadonlyArray<string> = []): boolean {
    if (this.disposed) return true;
    const renderer = this.target.getRenderer();
    if (!renderer || this.sources.some((source) => !renderer.hasTrackInstance(source.trackId))) {
      return false;
    }
    if (renderer !== this.presentationRenderer) {
      this.beginPresentationGeneration(renderer);
    } else {
      for (const trackId of reseededTrackIds) {
        this.publicationSignatures.delete(trackId);
        this.publicationRecordCounts.delete(trackId);
      }
    }
    this.presentCurrentViewport();
    return true;
  }

  updateActiveLanes(lanes: ReadonlyArray<Lane>): void {
    if (this.disposed) return;
    const nextLanes = lanes.filter(isSourceLane);
    const previousByTrackId = new Map(
      this.lanes.map(
        (lane, index) => [lane.dataset.trackId, { lane, source: this.sources[index] }] as const
      )
    );
    const nextSources: UcscTileSource[] = [];
    let sourcesChanged = nextLanes.length !== this.lanes.length;
    for (const lane of nextLanes) {
      const previous = previousByTrackId.get(lane.dataset.trackId);
      if (previous && sameAdmittedTrackSourceIdentity(previous.lane.source, lane.source)) {
        nextSources.push(previous.source);
        previousByTrackId.delete(lane.dataset.trackId);
        continue;
      }
      sourcesChanged = true;
      if (previous) {
        this.removeSource(lane.dataset.trackId, previous.source);
        previousByTrackId.delete(lane.dataset.trackId);
      }
      nextSources.push(
        this.makeSource({
          assembly: this.assembly,
          trackId: lane.dataset.trackId,
          source: lane.source,
        })
      );
    }
    for (const [trackId, previous] of previousByTrackId) {
      sourcesChanged = true;
      this.removeSource(trackId, previous.source);
    }
    const nextHalo = smoothingHaloTrackIds(lanes);
    const haloChanged = !sameStringSet(this.smoothingHaloTrackIds, nextHalo);
    this.smoothingHaloTrackIds = nextHalo;
    if (!sourcesChanged && !haloChanged) return;
    this.lanes = nextLanes;
    this.sources.splice(0, this.sources.length, ...nextSources);
    if (this.viewport) this.setViewport(this.viewport);
  }

  retryFailedTiles(): void {
    if (this.disposed || !this.viewport) return;
    for (const [sourceId, lifetime] of this.sourceLifetimes) {
      if (lifetime.recovery.phase === 'active') continue;
      this.cancelSourceRecovery(sourceId, lifetime);
      lifetime.recovery = { phase: 'active' };
    }
    this.commitViewportFetch(this.viewport);
    this.presentCurrentViewport();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [sourceId, lifetime] of this.sourceLifetimes)
      this.cancelSourceRecovery(sourceId, lifetime);
    this.sourceLifetimes.clear();
    this.presentationKeys.clear();
    this.cache.clear();
    this.publicationSignatures.clear();
    this.publicationRecordCounts.clear();
    this.compositionCounts.clear();
    this.presentationRenderer = null;
    for (const source of this.sources) void source.dispose?.();
  }

  private commitViewportFetch(viewport: Viewport): void {
    const steps = this.convergenceSteps(viewport);
    if (steps > 1) {
      this.cache.setPins(this.cache.entries().map((entry) => entry.key));
      const liveSources = this.sources.splice(0, this.sources.length);
      try {
        for (let index = 0; index < steps - 1; index += 1) {
          this.coordinator.setViewport(viewport);
        }
      } finally {
        this.sources.push(...liveSources);
      }
    }
    const level = pickLevel(viewport, maxLevelForAssembly(this.assembly), this.coordinator.level);
    const presentationKeys = this.sources
      .filter((source) => levelInRange(source, level))
      .flatMap((source) =>
        visibleTiles(
          viewport,
          level,
          this.assembly,
          this.smoothingHaloTrackIds.has(source.trackId) ? PREFETCH_MARGIN_TILES : 0
        ).map((tile) => ({ sourceId: source.id, level, index: tile.index }))
      );
    const refreshKeys = new Set<string>();
    for (const source of this.sources) {
      if (this.sourceLifetimes.get(source.id)?.recovery.phase !== 'retrying') continue;
      const keys = presentationKeys.filter((key) => key.sourceId === source.id);
      if (keys.length > 0 && keys.every((key) => this.cache.peek(key)?.state === 'ready')) {
        refreshKeys.add(tileKeyString(keys[0]));
        this.publicationSignatures.delete(source.trackId);
      }
    }
    this.cache.setPins(presentationKeys.filter((key) => !refreshKeys.has(tileKeyString(key))));
    for (const key of presentationKeys)
      if (refreshKeys.has(tileKeyString(key))) this.cache.evict(key);
    this.cache.setPins(presentationKeys);
    this.presentationKeys.clear();
    for (const key of presentationKeys) this.presentationKeys.add(tileKeyString(key));
    this.coordinator.setViewport(viewport);
  }

  private makeSource(input: Parameters<typeof createAdmittedTrackTileSource>[0]): UcscTileSource {
    const source = this.createSource(input);
    const lifetime: SourceLifetime = { generation: 0, recovery: { phase: 'active' } };
    this.sourceLifetimes.set(source.id, lifetime);
    const isCurrent = (generation: number): boolean =>
      !this.disposed &&
      this.sourceLifetimes.get(source.id) === lifetime &&
      lifetime.generation === generation;
    return {
      ...source,
      async fetchTile(level, index, segments, signal, context) {
        const generation = lifetime.generation;
        const request = new AbortController();
        let abort: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          abort = () => {
            request.abort();
            reject(new DOMException('Track request cancelled.', 'AbortError'));
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<Awaited<ReturnType<UcscTileSource['fetchTile']>>>((resolve) => {
          timer = setTimeout(() => {
            request.abort();
            resolve({
              key: { sourceId: source.id, level, index },
              state: 'error',
              count: 0,
              byteSize: 0,
              errorReason: 'The track request timed out.',
              errorRetryable: true,
              errorScope: 'source',
            });
          }, TILE_STALL_TIMEOUT_MS);
        });
        try {
          const data = await Promise.race([
            source.fetchTile(level, index, segments, request.signal, context),
            stalled,
            aborted,
          ]);
          if (!isCurrent(generation))
            throw new DOMException('Track source was replaced.', 'AbortError');
          return data;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener('abort', abort!);
        }
      },
    };
  }

  private failSource(
    sourceId: string,
    lifetime: SourceLifetime,
    reason: string,
    retryable: boolean
  ): void {
    const previous = lifetime.recovery;
    if (previous.phase === 'blocked' || previous.phase === 'recovering') return;
    const attempt = previous.phase === 'retrying' ? previous.attempt + 1 : 1;
    this.cancelSourceRecovery(sourceId, lifetime);
    if (!retryable || attempt > MAX_AUTOMATIC_RETRIES) {
      lifetime.recovery = { phase: 'blocked', reason };
      return;
    }
    const delay = Math.min(RETRY_MAX_DELAY_MS, 250 * 2 ** Math.min(attempt - 1, 7));
    const recovery: SourceRecovery = {
      phase: 'recovering',
      attempt,
      reason,
      timer: setTimeout(() => {
        if (
          this.disposed ||
          this.sourceLifetimes.get(sourceId) !== lifetime ||
          lifetime.recovery !== recovery
        )
          return;
        lifetime.recovery = { phase: 'retrying', attempt, reason };
        if (this.viewport) {
          this.commitViewportFetch(this.viewport);
          this.presentCurrentViewport();
        }
      }, delay),
    };
    lifetime.recovery = recovery;
  }

  private cancelSourceRecovery(sourceId: string, lifetime: SourceLifetime): void {
    if (lifetime.recovery.phase === 'recovering') clearTimeout(lifetime.recovery.timer);
    lifetime.generation += 1;
    this.coordinator.cancelPendingWhere((entry) => entry.key.sourceId === sourceId);
  }

  private removeSource(trackId: string, source: UcscTileSource): void {
    const lifetime = this.sourceLifetimes.get(source.id);
    if (lifetime) this.cancelSourceRecovery(source.id, lifetime);
    this.sourceLifetimes.delete(source.id);
    this.cache.setPins(
      this.cache
        .entries()
        .filter((entry) => entry.key.sourceId !== source.id && this.cache.isPinned(entry.key))
        .map((entry) => entry.key)
    );
    for (const entry of this.cache.entries())
      if (entry.key.sourceId === source.id) this.cache.evict(entry.key);
    this.publicationSignatures.delete(trackId);
    this.publicationRecordCounts.delete(trackId);
    this.pendingIntervalSignatures.delete(trackId);
    this.compositionCounts.delete(trackId);
    void source.dispose?.();
  }

  private convergenceSteps(viewport: Viewport): number {
    const maxLevel = maxLevelForAssembly(this.assembly);
    let level = this.coordinator.level;
    let steps = 0;
    for (let index = 0; index < 48; index += 1) {
      const next = pickLevel(viewport, maxLevel, level);
      if (next === level) break;
      steps += 1;
      level = next;
    }
    return Math.max(1, steps);
  }

  private presentCurrentViewport(freshSourceId?: string): void {
    const viewport = this.viewport;
    const level = this.coordinator.level;
    if (this.disposed || !viewport || level === null) return;

    const renderer = this.target.getRenderer();
    const trackIds = this.sources.map((source) => source.trackId);
    const recordCounts: Record<string, number> = {};
    const compositionCounts: Record<string, number> = {};
    const errorsByTrackId: Record<string, string> = {};
    const recoveringTrackIds: string[] = [];
    let loading = false;
    let zoomIn = false;
    let changed = false;

    for (const source of this.sources) {
      compositionCounts[source.trackId] = this.compositionCounts.get(source.trackId) ?? 0;
      const lifetime = this.sourceLifetimes.get(source.id);
      if (lifetime?.recovery.phase === 'blocked') {
        this.publishPendingIntervals(source.trackId, []);
        errorsByTrackId[source.trackId] = lifetime.recovery.reason;
        continue;
      }
      if (lifetime?.recovery.phase === 'recovering') {
        this.publishPendingIntervals(source.trackId, []);
        recoveringTrackIds.push(source.trackId);
        loading = true;
        continue;
      }
      if (!levelInRange(source, level)) {
        this.publishPendingIntervals(source.trackId, []);
        zoomIn = true;
        recordCounts[source.trackId] = 0;
        changed = this.publishEmptyIfChanged(renderer, source, level) || changed;
        continue;
      }

      const presentationTiles = visibleTiles(
        viewport,
        level,
        this.assembly,
        this.smoothingHaloTrackIds.has(source.trackId) ? PREFETCH_MARGIN_TILES : 0
      ).sort((left, right) => left.index - right.index);
      const entries = presentationTiles.map((tile) =>
        this.cache.peek({ sourceId: source.id, level, index: tile.index })
      );
      const failed = entries.find((entry) => entry?.state === 'error');
      if (failed) {
        this.publishPendingIntervals(source.trackId, []);
        errorsByTrackId[source.trackId] = failed.data?.errorReason ?? 'track-tile-error';
        continue;
      }
      if (entries.some((entry) => entry?.state !== 'ready')) {
        this.publishPendingIntervals(
          source.trackId,
          presentationTiles
            .filter((tile) => tile.core)
            .map((tile) => ({
              startBp: tile.globalStart,
              endBp: Math.min(tile.globalEnd, this.assembly.totalLengthBp),
              state: 'pending' as const,
            }))
        );
        if (lifetime?.recovery.phase === 'retrying') recoveringTrackIds.push(source.trackId);
        loading = true;
        continue;
      }
      if (lifetime?.recovery.phase === 'retrying') {
        if (freshSourceId === source.id) lifetime.recovery = { phase: 'active' };
        else {
          recoveringTrackIds.push(source.trackId);
          loading = true;
        }
      }

      const readyEntries = entries.filter((entry): entry is TileEntry => entry?.state === 'ready');
      const signature = readyEntries.map((entry) => tileKeyString(entry.key)).join('|');
      if (this.publicationSignatures.get(source.trackId) === signature) {
        this.publishPendingIntervals(source.trackId, []);
        recordCounts[source.trackId] = this.publicationRecordCounts.get(source.trackId) ?? 0;
        continue;
      }
      const records =
        source.source.scientificKind === 'quantitative'
          ? composeSortedQuantitativeRecords(readyEntries)
          : deduplicateRecords(
              readyEntries.flatMap((entry) =>
                isUcscTilePayload(entry.data?.payload) ? entry.data.payload.records : []
              )
            );
      recordCounts[source.trackId] = records.length;
      const compositionCount = (this.compositionCounts.get(source.trackId) ?? 0) + 1;
      this.compositionCounts.set(source.trackId, compositionCount);
      compositionCounts[source.trackId] = compositionCount;
      if (renderer?.hasTrackInstance(source.trackId)) {
        renderer.setTrackData(source.trackId, { records });
        this.presentationRenderer ??= renderer;
        changed = true;
      }
      this.publicationSignatures.set(source.trackId, signature);
      this.publicationRecordCounts.set(source.trackId, records.length);
      this.target.publishTrackRecords?.(source.trackId, records, signature);
      this.publishPendingIntervals(source.trackId, []);
    }

    if (changed) this.target.requestRender();
    const range = { start: viewport.globalStart, end: viewport.globalEnd };
    const firstError = Object.values(errorsByTrackId)[0];
    if (firstError) {
      this.target.publishDebug({
        status: 'error',
        viewport: range,
        trackIds,
        recordCounts,
        compositionCounts,
        errorsByTrackId,
        recoveringTrackIds,
        message: firstError,
      });
      return;
    }
    if (loading) {
      this.target.publishDebug({
        status: 'loading',
        viewport: range,
        trackIds,
        recordCounts,
        compositionCounts,
        recoveringTrackIds,
      });
      return;
    }
    if (zoomIn) {
      this.target.publishDebug({
        status: 'zoom-in',
        viewport: range,
        trackIds,
        recordCounts,
        compositionCounts,
      });
      return;
    }
    this.target.publishDebug({
      status: 'ready',
      viewport: range,
      trackIds,
      recordCounts,
      compositionCounts,
    });
  }

  private beginPresentationGeneration(renderer: RendererTrackDataTarget): void {
    this.presentationRenderer = renderer;
    this.publicationSignatures.clear();
    this.pendingIntervalSignatures.clear();
    this.publicationRecordCounts.clear();
  }

  private publishPendingIntervals(
    trackId: string,
    intervals: ReadonlyArray<PileupReferenceInterval>
  ): void {
    const signature = intervals
      .map((interval) => `${interval.startBp}:${interval.endBp}`)
      .join('|');
    if (this.pendingIntervalSignatures.get(trackId) === signature) return;
    this.pendingIntervalSignatures.set(trackId, signature);
    this.target.publishTrackPendingIntervals?.(trackId, intervals);
  }

  private publishEmptyIfChanged(
    renderer: RendererTrackDataTarget | null,
    source: UcscTileSource,
    level: number
  ): boolean {
    const signature = `unsupported-level:${level}`;
    if (this.publicationSignatures.get(source.trackId) === signature) return false;
    const rendered = renderer?.hasTrackInstance(source.trackId) === true;
    if (rendered) renderer.setTrackData(source.trackId, { records: [] });
    this.target.publishTrackRecords?.(source.trackId, [], signature);
    if (rendered) this.presentationRenderer ??= renderer;
    this.publicationSignatures.set(source.trackId, signature);
    this.publicationRecordCounts.set(source.trackId, 0);
    return rendered;
  }
}

function isSourceLane(lane: Lane): lane is SourceLane {
  return lane.visible && lane.dataset.kind !== 'pileup' && lane.source !== undefined;
}

function smoothingHaloTrackIds(lanes: ReadonlyArray<Lane>): Set<string> {
  return new Set(
    lanes.flatMap((lane) => {
      if (!lane.visible || lane.source?.scientificKind !== 'quantitative') return [];
      const presentation = normalizeQuantitativeTrackPresentation(
        lane.dataset.quantitativePresentation
      );
      return (presentation.smoothingSigmaBins ?? 0) > 0 ? [lane.dataset.trackId] : [];
    })
  );
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function deduplicateRecords(
  records: ReadonlyArray<UcscRenderableRecord>
): ReadonlyArray<UcscRenderableRecord> {
  const seen = new Set<string>();
  const unique: UcscRenderableRecord[] = [];
  for (const record of records) {
    const identity = recordIdentity(record);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(record);
  }
  unique.sort((left, right) => left.start - right.start || left.end - right.end);
  return unique;
}

function composeSortedQuantitativeRecords(
  entries: ReadonlyArray<TileEntry>
): ReadonlyArray<UcscRenderableRecord> {
  const unique: UcscRenderableRecord[] = [];
  let previous: UcscRenderableRecord | null = null;
  for (const entry of entries) {
    if (!isUcscTilePayload(entry.data?.payload)) continue;
    for (const record of entry.data.payload.records) {
      if (!('value' in record)) {
        return deduplicateRecords(
          entries.flatMap((candidate) =>
            isUcscTilePayload(candidate.data?.payload) ? candidate.data.payload.records : []
          )
        );
      }
      if (
        previous &&
        'value' in previous &&
        previous.chrom === record.chrom &&
        previous.start === record.start &&
        previous.end === record.end &&
        previous.value === record.value
      ) {
        continue;
      }
      unique.push(record);
      previous = record;
    }
  }
  return unique;
}

function recordIdentity(record: UcscRenderableRecord): string {
  if ('id' in record && typeof record.id === 'string') return `variant\u0000${record.id}`;
  const transcriptId = 'transcriptId' in record ? record.transcriptId : '';
  const name = 'name' in record ? (record.name ?? '') : '';
  const value = 'value' in record ? String(record.value) : '';
  return [record.chrom, record.start, record.end, transcriptId, name, value].join('\u0000');
}
