import type { TileEngineFeed } from '../tile-engine-driver';

type PileupRange = { start: number; end: number };

export type IndexedFirstInteractionReadinessReason =
  | 'source-unavailable'
  | 'viewport-unavailable'
  | 'renderer-unavailable'
  | 'range-unavailable'
  | 'lane-contract-not-wired'
  | 'coverage-not-ready'
  | 'ready';

export interface IndexedFirstInteractionReadinessSnapshot {
  ready: boolean;
  reason: IndexedFirstInteractionReadinessReason;
  key: string;
  sourceKey: string | null;
  viewportPx: number;
  range: PileupRange | null;
  wiredTrackIds: ReadonlyArray<string>;
  readyTrackIds: ReadonlyArray<string>;
}

export interface IndexedFirstInteractionReadinessSignal {
  subscribe(listener: () => void): () => void;
  getSnapshot(): boolean;
  getServerSnapshot(): boolean;
  inspect(): IndexedFirstInteractionReadinessSnapshot;
  batch<T>(operation: () => T): T;
  noteViewport(renderer: object | null, range: PileupRange | null): void;
  noteLaneContractWired(
    renderer: object,
    range: PileupRange | null,
    wiredTrackIds: ReadonlyArray<string>
  ): void;
  noteCoverageFeed(
    renderer: object | null,
    trackId: string,
    currentRange: PileupRange | null,
    feed: TileEngineFeed
  ): void;
  noteCoverageUnavailable(
    renderer: object | null,
    trackId: string,
    currentRange: PileupRange | null
  ): void;
}

export function createIndexedFirstInteractionReadiness(input: {
  sourceKey: string | null;
  viewportPx: number;
  expectedTrackIds: ReadonlyArray<string>;
  requireFullAssemblyCorridor?: boolean;
}): IndexedFirstInteractionReadinessSignal {
  const listeners = new Set<() => void>();
  const expectedTrackIds = [...new Set(input.expectedTrackIds)].sort();
  const expectedTrackIdSet = new Set(expectedTrackIds);
  let renderer: object | null = null;
  let rendererGeneration = 0;
  let range: PileupRange | null = null;
  let wiredTrackIds = new Set<string>();
  let readyTrackIds = new Set<string>();
  let latchedReady = false;
  let batchDepth = 0;
  let batchStartedReady = false;

  const currentViewportIsReady = (): boolean =>
    Boolean(
      input.sourceKey &&
      input.viewportPx > 0 &&
      renderer &&
      range &&
      expectedTrackIds.length > 0 &&
      expectedTrackIds.every((trackId) => wiredTrackIds.has(trackId) && readyTrackIds.has(trackId))
    );

  const isReady = (): boolean => latchedReady || currentViewportIsReady();

  const notifyIfChanged = (before: boolean): void => {
    if (batchDepth > 0 || before === isReady()) return;
    for (const listener of listeners) listener();
  };

  const mutate = (operation: () => void): void => {
    const before = isReady();
    operation();
    if (!latchedReady && currentViewportIsReady()) latchedReady = true;
    notifyIfChanged(before);
  };

  const updateViewport = (nextRenderer: object | null, nextRange: PileupRange | null): void => {
    const normalizedRange = normalizeRange(nextRange);
    const rendererChanged = nextRenderer !== renderer;
    const rangeChanged = !rangesEqual(normalizedRange, range);
    if (!rendererChanged && !rangeChanged) return;
    if (rendererChanged) {
      renderer = nextRenderer;
      rendererGeneration += 1;
      wiredTrackIds = new Set();
      readyTrackIds = new Set();
      latchedReady = false;
    }
    range = normalizedRange;
    if (rangeChanged && !latchedReady) readyTrackIds = new Set();
  };

  const signal: IndexedFirstInteractionReadinessSignal = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: isReady,
    getServerSnapshot: () => false,
    inspect() {
      const ready = isReady();
      return {
        ready,
        reason: readinessReason({
          sourceKey: input.sourceKey,
          viewportPx: input.viewportPx,
          renderer,
          range,
          expectedTrackIds,
          wiredTrackIds,
          readyTrackIds,
        }),
        key: [
          input.sourceKey ?? 'source:none',
          `px:${input.viewportPx}`,
          `renderer:${renderer ? rendererGeneration : 'none'}`,
          range ? `range:${range.start}-${range.end}` : 'range:none',
        ].join('|'),
        sourceKey: input.sourceKey,
        viewportPx: input.viewportPx,
        range: range ? { ...range } : null,
        wiredTrackIds: [...wiredTrackIds].sort(),
        readyTrackIds: [...readyTrackIds].sort(),
      };
    },
    batch<T>(operation: () => T): T {
      if (batchDepth === 0) batchStartedReady = isReady();
      batchDepth += 1;
      try {
        return operation();
      } finally {
        batchDepth -= 1;
        if (batchDepth === 0) notifyIfChanged(batchStartedReady);
      }
    },
    noteViewport(nextRenderer, nextRange) {
      mutate(() => updateViewport(nextRenderer, nextRange));
    },
    noteLaneContractWired(nextRenderer, nextRange, nextWiredTrackIds) {
      mutate(() => {
        updateViewport(nextRenderer, nextRange);
        wiredTrackIds = new Set(
          nextWiredTrackIds.filter((trackId) => expectedTrackIdSet.has(trackId))
        );
      });
    },
    noteCoverageFeed(nextRenderer, trackId, currentRange, feed) {
      mutate(() => {
        updateViewport(nextRenderer, currentRange);
        if (!expectedTrackIdSet.has(trackId)) return;
        if (
          range &&
          exactCoherentCoverageFeedCovers(feed, range, input.requireFullAssemblyCorridor === true)
        ) {
          readyTrackIds.add(trackId);
        } else {
          readyTrackIds.delete(trackId);
        }
      });
    },
    noteCoverageUnavailable(nextRenderer, trackId, currentRange) {
      mutate(() => {
        updateViewport(nextRenderer, currentRange);
        if (!latchedReady) readyTrackIds.delete(trackId);
      });
    },
  };
  return signal;
}

function readinessReason(input: {
  sourceKey: string | null;
  viewportPx: number;
  renderer: object | null;
  range: PileupRange | null;
  expectedTrackIds: ReadonlyArray<string>;
  wiredTrackIds: ReadonlySet<string>;
  readyTrackIds: ReadonlySet<string>;
}): IndexedFirstInteractionReadinessReason {
  if (!input.sourceKey || input.expectedTrackIds.length === 0) return 'source-unavailable';
  if (!(input.viewportPx > 0)) return 'viewport-unavailable';
  if (!input.renderer) return 'renderer-unavailable';
  if (!input.range) return 'range-unavailable';
  if (!input.expectedTrackIds.every((trackId) => input.wiredTrackIds.has(trackId))) {
    return 'lane-contract-not-wired';
  }
  if (!input.expectedTrackIds.every((trackId) => input.readyTrackIds.has(trackId))) {
    return 'coverage-not-ready';
  }
  return 'ready';
}

function exactCoherentCoverageFeedCovers(
  feed: TileEngineFeed,
  range: PileupRange,
  requireFullAssemblyCorridor: boolean
): boolean {
  if (requireFullAssemblyCorridor && feed.fullAssemblyInteractionCorridorReady !== true) {
    return false;
  }
  if (feed.coveragePresentation?.kind !== 'current') return false;
  if (!rangesEqual(normalizeRange(feed.viewRange ?? null), range)) return false;
  const atlas = feed.coverageGpuAtlas;
  if (atlas && feed.coverageGpuAtlasPresentation === 'active') {
    return (
      atlas.contract === 'coverage-gpu-atlas.v1' &&
      atlas.authorityKey.length > 0 &&
      atlas.sourceIdentity.length > 0 &&
      atlas.assemblyFingerprint.length > 0 &&
      atlas.statistic.length > 0 &&
      atlas.payloadRevision.length > 0 &&
      atlas.assemblyStartBp <= range.start + 1 &&
      atlas.assemblyEndBp >= range.end - 1 &&
      atlas.baseBinSizeBp > 0 &&
      atlas.textureWidth > 0 &&
      atlas.textureHeight > 0 &&
      atlas.data.length === atlas.textureWidth * atlas.textureHeight &&
      atlas.chromosomes.length > 0 &&
      Number.isFinite(atlas.depthPercentiles.max) &&
      atlas.depthPercentiles.max > 0
    );
  }
  const coverage = feed.coverage;
  const lod = feed.coverageLod;
  if (!coverage || !lod) return false;
  if (coverage.provenance?.exact !== true || lod.provenanceExact !== true) return false;
  if (coverage.provenance.source !== 'tile-engine') return false;
  if (!(coverage.binSize > 0) || lod.binSize !== coverage.binSize) return false;
  if (!Number.isFinite(coverage.maxDepth) || coverage.maxDepth <= 0) return false;
  if (coverage.bins.length === 0) return false;
  let maxBin = 0;
  for (const bin of coverage.bins) {
    if (!Number.isFinite(bin) || bin < 0) return false;
    maxBin = Math.max(maxBin, bin);
  }
  if (!(maxBin > 0) || coverage.maxDepth + Number.EPSILON < maxBin) return false;
  const start = coverage.startBp ?? 0;
  const end = start + coverage.bins.length * coverage.binSize;
  return start <= range.start + 1 && end >= range.end - 1;
}

function normalizeRange(value: PileupRange | null): PileupRange | null {
  if (!value || !Number.isFinite(value.start) || !Number.isFinite(value.end)) return null;
  const start = Math.min(value.start, value.end);
  const end = Math.max(value.start, value.end);
  return end > start ? { start, end } : null;
}

function rangesEqual(a: PileupRange | null, b: PileupRange | null): boolean {
  return Boolean(a && b && a.start === b.start && a.end === b.end) || (!a && !b);
}
