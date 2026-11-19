import {
  TileCache,
  TileCoordinator,
  PREFETCH_MARGIN_TILES,
  binBp,
  coverageGpuAtlasEligible,
  createAlignmentTileSource,
  createAssemblyCoverageTileSource,
  globalRangeToSegments,
  httpTileTransport,
  maxAlternateGuideLevel,
  maxReadAlignmentLevel,
  maxLevelForAssembly,
  pileupExactReadPreparationEligible,
  pileupExactReadZoomAlpha,
  pickLevel,
  tileGlobalEnd,
  tileGlobalStart,
  tileKeyString,
  tileSpanBp,
  visibleTiles,
  type Assembly,
  type TileData,
  type TileEntry,
  type TileFetchContext,
  type TileKey,
  type TileSource,
  type TileTransport,
  type Viewport,
} from '@waypoint/genome-renderer';
import type {
  CoverageGpuAtlas,
  CoverageLodMetadata,
  CoverageSignal,
  PileupAlternateColumn,
  PileupRecord,
} from '@waypoint/genome-data';
import { shouldEnableTestBridge, type ViteEnv } from '../../lib/test-bridge-gate';
import {
  coverageRange,
  coverageSignalCoversViewport,
  coverageSignalDepthStats,
  coverageSliceComponents,
  coverageSliceDepthStats,
  coverageSlicesForEntry,
  coverageSlicesViewportStatus,
  coverageSpan,
  maxCoverageValue,
  overlayCoverageSlices,
  overwriteCoverageSlices,
  rangeContains,
  rangesViewportStatus,
  withViewportMaxDepth,
  type CoverageCompositionStatus,
  type ReadyCoverageSlice,
} from './tile-engine-coverage';
import { limitConcurrency, type TileTransportQueueSnapshot } from './tile-engine-transport';
import { trackRemoteTileSessionTransport } from './remote-tile-session-drain';
import {
  applyRankedCoverageContributors,
  applyReadsDerivedCoverage,
  collectExactSupportRanges,
  collectResidentSupportRanges,
  collectValidExactSlicesByResolution,
  coverageOutputBinTooWideForPresentation,
  groupResidentLayersByResolution,
  hasAnyCoverageComposeSource,
  rankCoverageContributors,
  rangesCoverViewport,
  resolveForcedCoverageLevel,
  selectCompleteSupportOutputLevel,
} from './tile-engine-resampled-coverage';
import {
  COVERAGE_CORRIDOR_FLOOR_CONTRACT,
  buildCoverageCorridorFloorGpuAtlas,
  loadCoverageCorridorFloor,
  type PreparedCoverageCorridorFloor,
  type VerifiedCoverageCorridorFloor,
} from './coverage-corridor-floor';
import { loadPreparedCoverageCorridorFloorInWorker } from './coverage-corridor-floor-worker-runtime';
import type { PileupSource } from './pileup-source';

export function readForcedCoverageLevelForTestBridge(
  env: ViteEnv,
  scope: { readonly __dna708ForceCoverageLevel?: unknown } = globalThis as {
    readonly __dna708ForceCoverageLevel?: unknown;
  }
): number | null {
  if (!shouldEnableTestBridge(env)) return null;
  const forced = scope.__dna708ForceCoverageLevel;
  return typeof forced === 'number' && Number.isFinite(forced) ? Math.round(forced) : null;
}

type CoverageCorridorFloorLoadCandidate =
  | VerifiedCoverageCorridorFloor
  | PreparedCoverageCorridorFloor;

function isPreparedCoverageCorridorFloor(
  candidate: CoverageCorridorFloorLoadCandidate
): candidate is PreparedCoverageCorridorFloor {
  return 'floor' in candidate && 'atlas' in candidate;
}

export interface TileEngineFeed {
  coverage?: CoverageSignal;
  coverageGpuAtlas?: CoverageGpuAtlas;
  coverageGpuAtlasPresentation?: 'active' | 'handoff-hold' | 'standby';
  coverageLod?: CoverageLodMetadata;
  viewRange?: { start: number; end: number };
  coveragePresentation?:
    | { kind: 'current' }
    | {
        kind: 'none';
        reason: 'target-error' | 'target-pending-no-presentable-surface' | 'no-presentable-surface';
      };
  records: ReadonlyArray<PileupRecord>;
  alternateColumns?: ReadonlyArray<PileupAlternateColumn>;
  readSource?: { truncated?: boolean; windowStartBp?: number; windowEndBp?: number };
  requiredReadBandReady?: boolean;
  fullAssemblyInteractionCorridorReady?: boolean;
  ownerPresentation?:
    | { kind: 'pending' }
    | { kind: 'coverage' }
    | { kind: 'reads' }
    | { kind: 'empty' };
  referenceIntervals?: ReadonlyArray<{
    startBp: number;
    endBp: number;
    state: 'pending' | 'empty';
  }>;
  debugTimings?: {
    totalMs: number;
    coverageComposeMs: number;
    coverageMaxDepthMs: number;
    readsComposeMs: number;
    recordCount: number;
    coverageBinCount: number;
    coverageBinSize: number | null;
    targetLevel?: number;
    viewStartBp?: number;
    viewEndBp?: number;
    coveragePresentationKind?: string;
    coveragePresentationReason?: string | null;
    targetCoveragePending?: boolean;
    targetCoverageErrored?: boolean;
    currentCoverageBinSize?: number | null;
    mixedCoverageBinSize?: number | null;
    residentCoverageCandidateCount?: number;
    coverageMemoHit?: boolean;
    coverageRevision?: string;
    coverageMemoMaterializeCount?: number;
    coverageMemoRevisionChangeCount?: number;
    exactCoverageRecordScanCount?: number;
    exactCoverageGeneration?: number;
  };
}

type TileEngineOwnerPresentationKind = NonNullable<TileEngineFeed['ownerPresentation']>['kind'];

export interface TileEngineDriverOptions {
  assembly: Assembly;
  source: PileupSource;
  referencePathsByChrom?: ReadonlyMap<string, string>;
  baseUrl: string;
  onFeed: (feed: TileEngineFeed) => void;
  onCoverageAtlasReuse?: (presentation: {
    coverageGpuAtlas: CoverageGpuAtlas;
    viewRange: { start: number; end: number };
    fullAssemblyInteractionCorridorReady: boolean;
  }) => void;
  onReadPresentationReuse?: (presentation: {
    feed: TileEngineFeed;
    viewRange: { start: number; end: number };
    requiredReadBandReady: boolean;
  }) => void;
  onTileError?: (failure: { key: TileKey; reason: string }) => void;
  fetchImpl?: typeof fetch;
  transport?: TileTransport;
  frameScheduler?: {
    request: (callback: FrameRequestCallback) => number;
    cancel: (handle: number) => void;
  };
  settlementScheduler?: {
    requestPostPaint: (callback: () => void) => number;
    cancel: (handle: number) => void;
  };
  timeoutMs?: number;
  corridorFloorLoader?: (signal: AbortSignal) => Promise<CoverageCorridorFloorLoadCandidate | null>;
}

const CACHE_MAX_ENTRIES = 512;
const CACHE_MAX_BYTES = 192 * 1024 * 1024;

const MAX_CONCURRENT_TILE_FETCHES = 8;
const MAX_CONCURRENT_HTTP_TILE_FETCHES = 6;
const EMPTY_REGION_SETTLE_MS = 200;
const RESIDENT_COVERAGE_SURFACES_PER_LEVEL = 16;
const EXACT_COVERAGE_TILE_STORE_MAX = 4096;
const MAX_COVERAGE_OUT_BINS = 8192;
const READS_DERIVED_MAX_OUT_BINS = 32768;
const READS_DERIVED_MAX_RECORDS = 80_000;
const READS_DISPLAY_MAX_RECORDS = 100_000;
const READ_TILE_MAX_RECORDS = 100_000;

function subsampleUniform<T>(arr: ReadonlyArray<T>, max: number): T[] {
  if (arr.length <= max) return arr.slice();
  const stride = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  return out;
}
const READ_COMPOSITION_CACHE_ENTRIES = 16;
const READ_COMPOSITION_BAND_MIN_TILES = 16;
const READ_COMPOSITION_BAND_STRIDE_TILES = 4;
const READ_COMPOSITION_MIN_HALO_TILES = 4;
const COVERAGE_DRAW_BAND_VIEWPORTS = 2;
const MAX_COVERAGE_SIGNAL_BINS = 262_144;
const BROAD_COVERAGE_RETAIN_LEVELS = 8;
const FULL_ASSEMBLY_INTERACTION_MIN_SPAN_BP = 150_000_000;
const FINE_ALIGNMENT_RETAIN_MIN_BP = 64_000;
const FINE_ALIGNMENT_RETAIN_VIEWPORTS = 16;
let coverageProducerSequence = 0;

function nextCoverageProducerEpoch(): string {
  coverageProducerSequence += 1;
  const randomId = globalThis.crypto?.randomUUID?.();
  return `tile-engine-${randomId ?? `${Date.now().toString(36)}-${coverageProducerSequence}`}`;
}

export interface AlignmentReadRow {
  start: number;
  end: number;
  strand: '+' | '-';
  mapq: number;
  readId: string;
  flag?: number;
  pair?: PileupRecord['pair'];
  mismatches?: PileupRecord['mismatches'];
  blocks?: ReadonlyArray<{ start: number; end: number }>;
}
export interface AlignmentAlternateColumnRow {
  pos: number;
  kind: PileupAlternateColumn['kind'];
  length: number;
  refBase?: string;
  readBase?: string;
  coveringReadCount: number;
  supportingReadCount: number;
  weightedDepth: number;
  weightedSupport: number;
  weightedFraction: number;
}
interface AlignmentTilePayload {
  reads?: AlignmentReadRow[];
  alternateColumns?: AlignmentAlternateColumnRow[];
  count?: number;
  start?: number;
  end?: number;
  truncated?: boolean;
}

export function projectAlignmentReadRow(
  row: AlignmentReadRow,
  chromosome: { chrom: string; globalStartBp: number }
): PileupRecord {
  return projectAlignmentReadRows(row, chromosome)[0];
}

export function projectAlignmentReadRows(
  row: AlignmentReadRow,
  chromosome: { chrom: string; globalStartBp: number }
): PileupRecord[] {
  const offset = chromosome.globalStartBp;
  const blocks =
    row.blocks && row.blocks.length > 0 ? row.blocks : [{ start: row.start, end: row.end }];
  return blocks.map((block) => ({
    chrom: chromosome.chrom,
    start: block.start + offset,
    end: block.end + offset,
    ...(block.start === row.start ? {} : { alignmentStart: row.start + offset }),
    readId: row.readId,
    strand: row.strand,
    mapq: row.mapq,
    ...(row.flag == null ? {} : { flag: row.flag }),
    ...(row.pair
      ? {
          pair: {
            ...row.pair,
            ...(row.pair.mateStart == null ? {} : { mateStart: row.pair.mateStart + offset }),
          },
        }
      : {}),
    ...(row.mismatches
      ? {
          mismatches: row.mismatches
            .filter((mismatch) => mismatch.pos >= block.start && mismatch.pos < block.end)
            .map((mismatch) => ({
              ...mismatch,
              pos: mismatch.pos + offset,
            })),
        }
      : {}),
  }));
}

export function projectAlignmentAlternateColumn(
  row: AlignmentAlternateColumnRow,
  chromosome: { globalStartBp: number }
): PileupAlternateColumn {
  return {
    ...row,
    pos: row.pos + chromosome.globalStartBp,
  };
}

type ReadCompositionStatus = {
  level: number;
  maxReadAlignmentLevel: number;
  maxFineLevel: number;
  fineLevel: boolean;
  viewStartBp: number;
  viewEndBp: number;
  visibleTileCount: number;
  readyTileCount: number;
  pendingTileCount: number;
  errorTileCount: number;
  readyWithReadsTileCount: number;
  readyEmptyTileCount: number;
  payloadReadCount: number;
  payloadAlternateColumnCount: number;
  composedRecordCount: number;
  composedAlternateColumnCount: number;
  stableBandReady: boolean;
  readyBandTileCount: number;
  expectedBandTileCount: number;
  windowStartBp: number | null;
  windowEndBp: number | null;
  readyCoveredFraction: number;
  readyCoversViewport: boolean;
  readCoveredFraction: number;
  readCoversViewport: boolean;
  readyLevels: number[];
  pendingLevels: number[];
  errorLevels: number[];
  visibleTiles: Array<{
    level: number;
    index: number;
    sourceId: string;
    chrom: string | null;
    state: 'pending' | 'ready' | 'error';
    globalStartBp: number;
    globalEndBp: number;
    payloadStartBp: number | null;
    payloadEndBp: number | null;
    payloadCount: number | null;
    readCount: number | null;
    alternateColumnCount: number | null;
  }>;
  readyGaps: Array<{ startBp: number; endBp: number }>;
  readGaps: Array<{ startBp: number; endBp: number }>;
};
type ResidentCoverageSurface = {
  coverage: CoverageSignal;
  order: number;
};
type ResidentCoverageLayer = {
  globalStart: number;
  globalEnd?: number;
  binSize: number;
  bins: Float32Array;
};

type ExactCoverageTileRecord = {
  key: TileKey;
  slices: ReadyCoverageSlice[];
  order: number;
};
type DebugViewportRange = {
  start: number;
  end: number;
  viewportPx?: number;
};
type SelectedReadTile = {
  cacheKey: string;
  sourceId: string;
  tileStartBp: number;
  tileEndBp: number;
  truncated: boolean;
  records: ReadonlyArray<PileupRecord>;
  alternateColumns: ReadonlyArray<PileupAlternateColumn>;
};
type ReadTileRecordsCacheEntry = {
  records: PileupRecord[];
  alternateColumns: PileupAlternateColumn[];
  exactRecordsMaterialized: boolean;
};
type ReadCompositionCacheEntry = {
  level: number;
  records: PileupRecord[];
  alternateColumns: PileupAlternateColumn[];
  supportRanges: Array<{ globalStart: number; globalEnd: number }>;
  windowStartBp?: number;
  windowEndBp?: number;
  truncated: boolean;
  revisionKey: string;
  order: number;
};
type CoverageMemoEntry = {
  semanticKey: string;
  signal: CoverageSignal;
  level: number;
};
type CoverageBandMemoEntry = {
  signal: CoverageSignal;
  view: Viewport;
  authorityResolution: number | null;
  authorityKey: string;
  depthScaleGeneration: number;
};

interface ChromSources {
  alignment: TileSource;
  globalStartBp: number;
  globalEndBp: number;
  chrom: string;
}

export class TileEngineDriver {
  private readonly assembly: Assembly;
  private readonly opts: TileEngineDriverOptions;
  private readonly transport: ReturnType<typeof limitConcurrency>;
  private readonly readForegroundCoverageSource: TileSource;
  private readonly cache: TileCache;
  private coordinator: TileCoordinator;
  private readonly assemblyCoverageSource: TileSource;
  private readonly chromSources = new Map<string, ChromSources>();
  private readonly sources: TileSource[] = [];
  private readonly residentCoverageByLevel = new Map<number, ResidentCoverageSurface[]>();
  private residentCoverageOrder = 0;
  private readonly exactCoverageTiles = new Map<string, ExactCoverageTileRecord>();
  private exactCoverageOrder = 0;
  private depthPercentiles: NonNullable<CoverageSignal['depthPercentiles']> | null = null;
  private readonly readTileProjectionByPayload = new WeakMap<object, ReadTileRecordsCacheEntry>();
  private readTileProjectionMaterializeCount = 0;
  private readTileProjectionReuseCount = 0;
  private readonly readCompositionCache = new Map<string, ReadCompositionCacheEntry>();
  private readCompositionOrder = 0;
  private exactReadDetailEligible = false;
  private lastPublishedReadRevisionKey: string | null = null;
  private lastPublishedFeed: TileEngineFeed | null = null;
  private lastPublishedOwnerPresentationKind: TileEngineOwnerPresentationKind | null = null;
  private alignmentPresentationGeneration = 0;
  private processedAlignmentPresentationGeneration = 0;
  private readonly alignmentPayloadRevisions = new WeakMap<object, number>();
  private alignmentPayloadRevisionSequence = 0;
  private readonly coveragePayloadRevisions = new WeakMap<object, number>();
  private coveragePayloadRevisionSequence = 0;
  private readonly coverageProducerEpoch = nextCoverageProducerEpoch();
  private exactCoverageGeneration = 0;
  private residentCoverageGeneration = 0;
  private depthScaleGeneration = 0;
  private coverageRevisionSequence = 0;
  private coveragePlanCount = 0;
  private coverageMaterializeCount = 0;
  private coverageMemoHitCount = 0;
  private coverageRevisionChangeCount = 0;
  private exactCoverageRecordScanCount = 0;
  private lastCoverageMemo: CoverageMemoEntry | null = null;
  private coverageBandMemo: CoverageBandMemoEntry | null = null;
  private lastPublishedFullAssemblyInteractionCorridorReady: boolean | null = null;
  private lastPublishedCorridorAtlasAuthorityKey: string | null = null;
  private lastPublishedCorridorAtlasPresentation: TileEngineFeed['coverageGpuAtlasPresentation'] =
    undefined;
  private lastViewport: Viewport | null = null;
  private lastMotionCenterBp: number | null = null;
  private lastViewportMotionAtMs = 0;
  private lastReferenceIntervalSignature = '';
  private lastPresentationViewportPx: number | null = null;
  private retryRequired = false;
  private retryRequiredPlanKey: string | null = null;
  private cancelScheduledFeed: (() => void) | null = null;
  private cancelEmptyRegionSettlement: (() => void) | null = null;
  private disposed = false;
  private readonly maxReadAlignment = maxReadAlignmentLevel();
  private readonly maxAlternateGuide = maxAlternateGuideLevel();
  private readonly boundedReadBand: boolean;
  private readonly residentBaseLayer = new Map<string, ResidentCoverageLayer>();
  private residentBaseLayerState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private residentBaseLayerVerified = false;
  private readonly residentPyramid: Array<Map<string, ResidentCoverageLayer>> = [];
  private verifiedCorridorFloor: VerifiedCoverageCorridorFloor | null = null;
  private verifiedCorridorFloorGpuAtlas: CoverageGpuAtlas | null = null;
  private corridorFloorState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private corridorFloorFailureReason: string | null = null;
  private corridorFloorContractGeneration = 0;
  private corridorReadinessCache: {
    sourceGeneration: string;
    presentationContract: string;
    ready: boolean;
  } | null = null;
  private corridorFloorAbortController: AbortController | null = null;

  constructor(options: TileEngineDriverOptions) {
    this.assembly = options.assembly;
    this.opts = options;
    this.boundedReadBand = options.source.remote != null || options.transport == null;
    let rawTransport =
      options.transport ??
      httpTileTransport({
        baseUrl: options.source.remote?.tileBaseUrl ?? options.baseUrl,
        fetchImpl: options.fetchImpl,
      });
    const remoteSessionId = options.source.remote?.sessionId;
    if (remoteSessionId && options.transport == null) {
      rawTransport = trackRemoteTileSessionTransport(remoteSessionId, rawTransport);
    }
    const transportLimit =
      options.transport == null ? MAX_CONCURRENT_HTTP_TILE_FETCHES : MAX_CONCURRENT_TILE_FETCHES;
    this.transport = limitConcurrency(rawTransport, transportLimit, {
      canAbortActive: (request) =>
        options.transport == null &&
        options.source.htsget == null &&
        (request.kind === 'alignment' ||
          (options.source.remote == null &&
            (request.kind === 'coverage' || request.kind === 'coverage-assembly'))),
      preferCurrentCoverage: () => {
        const view = this.lastViewport;
        if (!view) return false;
        const viewportPx = this.lastPresentationViewportPx ?? view.viewportPx;
        return (
          pileupExactReadZoomAlpha(viewportPx / Math.max(1, view.globalEnd - view.globalStart)) < 1
        );
      },
      currentReadAlignmentLevel:
        options.transport == null
          ? () =>
              this.lastViewport
                ? this.readLevelForView(this.lastViewport, this.coordinator.level ?? 0)
                : null
          : undefined,
    });
    this.cache = new TileCache({
      maxEntries: CACHE_MAX_ENTRIES,
      maxBytes: CACHE_MAX_BYTES,
      disposeTile: () => {},
    });
    this.assemblyCoverageSource = createAssemblyCoverageTileSource(
      {
        bamPath: this.opts.source.bamPath,
        indexPath: this.opts.source.indexPath,
        referencePath: this.opts.source.referencePath,
        sourceGeneration: this.opts.source.generation,
        htsget: this.opts.source.htsget,
      },
      { transport: this.transport, timeoutMs: this.opts.timeoutMs },
      options.source.remote == null || options.source.remote.tileBaseUrl
        ? 'prepared-pyramid'
        : 'bounded-foreground'
    );
    this.readForegroundCoverageSource = {
      id: this.assemblyCoverageSource.id,
      levelRange: this.assemblyCoverageSource.levelRange,
      prefetch: { ...this.assemblyCoverageSource.prefetch, wholeGenomeResident: false },
      fetchTile: (...args) => this.assemblyCoverageSource.fetchTile(...args),
    };
    this.coordinator = this.buildCoordinator();
    const corridorFloorLoader =
      this.opts.source.htsget || options.source.remote != null
        ? null
        : (options.corridorFloorLoader ??
          (options.transport == null
            ? options.fetchImpl
              ? (signal: AbortSignal) =>
                  loadCoverageCorridorFloor({
                    baseUrl: options.baseUrl,
                    source: options.source,
                    assembly: options.assembly,
                    fetchImpl: options.fetchImpl,
                    signal,
                  })
              : (signal: AbortSignal) =>
                  loadPreparedCoverageCorridorFloorInWorker(
                    {
                      baseUrl: options.baseUrl,
                      source: options.source,
                      assembly: options.assembly,
                    },
                    signal
                  )
            : null));
    if (corridorFloorLoader) this.beginCorridorFloorLoad(corridorFloorLoader);
  }

  private beginCorridorFloorLoad(
    loader: NonNullable<TileEngineDriverOptions['corridorFloorLoader']>
  ): void {
    const controller = new AbortController();
    this.corridorFloorAbortController = controller;
    if (!this.verifiedCorridorFloor) {
      this.corridorFloorState = 'loading';
      this.corridorFloorFailureReason = null;
    }
    void loader(controller.signal).then(
      (candidate) => {
        if (controller.signal.aborted || this.disposed) return;
        this.corridorFloorAbortController = null;
        if (!candidate) {
          if (!this.verifiedCorridorFloor) {
            this.corridorFloorState = 'error';
            this.corridorFloorFailureReason = 'loader-returned-no-candidate';
          }
          return;
        }
        try {
          this.installVerifiedCorridorFloor(candidate);
        } catch (error) {
          if (!this.verifiedCorridorFloorGpuAtlas) {
            this.corridorFloorState = 'error';
            this.corridorFloorFailureReason = this.corridorFloorErrorReason(
              'atlas-admission-failed',
              error
            );
          }
        }
      },
      (error) => {
        if (controller.signal.aborted || this.disposed) return;
        this.corridorFloorAbortController = null;
        if (!this.verifiedCorridorFloor) {
          this.corridorFloorState = 'error';
          this.corridorFloorFailureReason = this.corridorFloorErrorReason('loader-rejected', error);
        }
      }
    );
  }

  private corridorFloorErrorReason(boundary: string, error: unknown): string {
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    return `${boundary}:${detail}`;
  }

  private installVerifiedCorridorFloor(candidate: CoverageCorridorFloorLoadCandidate): void {
    const prepared = isPreparedCoverageCorridorFloor(candidate)
      ? candidate
      : { floor: candidate, atlas: buildCoverageCorridorFloorGpuAtlas(candidate) };
    this.assertPreparedCorridorFloorAdmission(prepared);
    const { floor, atlas } = prepared;
    this.verifiedCorridorFloor = floor;
    this.verifiedCorridorFloorGpuAtlas = atlas;
    this.corridorFloorState = 'ready';
    this.corridorFloorFailureReason = null;
    this.corridorFloorContractGeneration += 1;
    this.corridorReadinessCache = null;
    this.retireRedundantBroadCoverageWork();
    this.scheduleFeed();
  }

  private assertPreparedCorridorFloorAdmission(prepared: PreparedCoverageCorridorFloor): void {
    const { floor, atlas } = prepared;
    const expectedAuthorityKey = JSON.stringify([
      'coverage-gpu-atlas.v1',
      floor.sourceIdentity,
      floor.orderedAssemblyFingerprint,
      floor.statistic,
      floor.requestFingerprint,
    ]);
    if (
      floor.contract !== COVERAGE_CORRIDOR_FLOOR_CONTRACT ||
      floor.assemblyStart !== 0 ||
      floor.assemblyEnd !== this.assembly.totalLengthBp ||
      floor.layers.size !== this.assembly.chromosomes.length ||
      atlas.contract !== 'coverage-gpu-atlas.v1' ||
      atlas.authorityKey !== expectedAuthorityKey ||
      atlas.sourceIdentity !== floor.sourceIdentity ||
      atlas.assemblyFingerprint !== floor.orderedAssemblyFingerprint ||
      atlas.statistic !== floor.statistic ||
      atlas.payloadRevision !== floor.requestFingerprint ||
      atlas.assemblyStartBp !== floor.assemblyStart ||
      atlas.assemblyEndBp !== floor.assemblyEnd ||
      atlas.baseBinSizeBp !== floor.binSize ||
      atlas.chromosomes.length !== floor.layers.size ||
      !Number.isSafeInteger(atlas.textureWidth) ||
      !Number.isSafeInteger(atlas.textureHeight) ||
      atlas.textureWidth <= 0 ||
      atlas.textureHeight <= 0 ||
      atlas.data.length !== atlas.textureWidth * atlas.textureHeight
    ) {
      throw new Error('coverage corridor worker returned a mismatched authority pair');
    }
    for (let index = 0; index < this.assembly.chromosomes.length; index += 1) {
      const placement = this.assembly.chromosomes[index]!;
      const chrom = placement.chromosome.id;
      const layer = floor.layers.get(chrom);
      const atlasChromosome = atlas.chromosomes[index];
      if (
        !layer ||
        !atlasChromosome ||
        layer.chrom !== chrom ||
        layer.globalStart !== placement.globalStartBp ||
        layer.globalEnd !== placement.globalEndBp ||
        layer.binSize !== floor.binSize ||
        layer.bins.length !==
          Math.ceil((placement.globalEndBp - placement.globalStartBp) / floor.binSize) ||
        atlasChromosome.chrom !== chrom ||
        atlasChromosome.globalStartBp !== layer.globalStart ||
        atlasChromosome.globalEndBp !== layer.globalEnd ||
        atlasChromosome.baseBinCount !== layer.bins.length
      ) {
        throw new Error('coverage corridor worker returned a mismatched chromosome layout');
      }
    }
  }

  private retireRedundantBroadCoverageWork(): void {
    const view = this.lastViewport;
    if (!view || !this.corridorAtlasPhysicallyEligible(view)) return;
    this.activateSourcesForRange(
      view.globalStart,
      view.globalEnd,
      this.convergedLevelForView(view),
      false
    );
    this.coordinator.cancelPendingWhere((entry) => isCoverageSourceId(entry.key.sourceId));
  }

  private buildCoordinator(): TileCoordinator {
    return new TileCoordinator({
      assembly: this.assembly,
      sources: this.sources,
      cache: this.cache,
      levelForSource: (source, view, level) =>
        source.id.startsWith('aln:') ? this.readLevelForView(view, level) : level,
      onTileReady: (key) => {
        this.rememberExactCoverageTile(key);
        if (key.sourceId.startsWith('aln:')) {
          const payload = this.cache.peek(key)?.data?.payload as AlignmentTilePayload | undefined;
          const isGuideOnlyLevel = key.level > this.maxReadAlignment;
          const hasGuideColumns =
            Array.isArray(payload?.alternateColumns) && payload.alternateColumns.length > 0;
          if (!isGuideOnlyLevel || hasGuideColumns) {
            this.alignmentPresentationGeneration += 1;
          }
        }
        this.scheduleFeed();
      },
      onTileError: (key, reason) => {
        this.scheduleFeed();
        if (this.tileOwnsCurrentRecoveryPlan(key)) {
          this.retryRequired = true;
          this.retryRequiredPlanKey = this.viewportFetchPlanKey(this.lastViewport!);
          this.opts.onTileError?.({ key, reason });
        }
      },
    });
  }

  private tileOwnsCurrentRecoveryPlan(key: TileKey): boolean {
    const view = this.lastViewport;
    const level = this.coordinator.level;
    // global coordinator epoch is deliberately not an additional stale guard.
    if (
      this.disposed ||
      !view ||
      level == null ||
      !this.sources.some((source) => source.id === key.sourceId) ||
      this.cache.peek(key)?.state !== 'error'
    ) {
      return false;
    }
    const readLevel = this.readLevelForView(view, level);
    if (key.level !== (key.sourceId.startsWith('aln:') ? readLevel : level)) return false;
    const exactReadsOwnViewport = this.exactReadPreparationIsEligible(view);
    if (exactReadsOwnViewport) {
      return (
        key.sourceId.startsWith('aln:') &&
        this.computeReadCompositionBand(view, readLevel).expectedBandTileKeys.has(
          tileKeyString(key)
        )
      );
    }
    return (
      isCoverageSourceId(key.sourceId) &&
      tileGlobalEnd(key.index, key.level) > view.globalStart &&
      tileGlobalStart(key.index, key.level) < view.globalEnd
    );
  }

  private viewportFetchPlanKey(view: Viewport, level = this.convergedLevelForView(view)): string {
    const spanBp = tileSpanBp(level);
    const firstCore = Math.floor(view.globalStart / spanBp);
    const lastCore = Math.floor(Math.max(view.globalStart, view.globalEnd - 1) / spanBp);
    const readLevel = this.readLevelForView(view, level);
    const readSpanBp = tileSpanBp(readLevel);
    const firstReadCore = Math.floor(view.globalStart / readSpanBp);
    const lastReadCore = Math.floor(Math.max(view.globalStart, view.globalEnd - 1) / readSpanBp);
    return [
      `L${level}`,
      `core:${firstCore}-${lastCore}`,
      this.exactReadPreparationIsEligible(view)
        ? `reads:L${readLevel}:${firstReadCore}-${lastReadCore}`
        : 'reads:0',
    ].join('|');
  }

  private ensureSourcesForRange(globalStart: number, globalEnd: number): void {
    for (const segment of globalRangeToSegments(this.assembly, globalStart, globalEnd)) {
      const chrom = segment.chrom;
      if (this.chromSources.has(chrom)) continue;
      const file = {
        bamPath: this.opts.source.bamPath,
        indexPath: this.opts.source.indexPath,
        referencePath:
          this.opts.source.remote != null
            ? (this.opts.referencePathsByChrom?.get(chrom) ?? this.opts.source.referencePath)
            : (this.opts.source.referencePath ?? this.opts.referencePathsByChrom?.get(chrom)),
        sourceGeneration: this.opts.source.generation,
        htsget: this.opts.source.htsget,
      };
      const baseOpts = { transport: this.transport, timeoutMs: this.opts.timeoutMs };
      const alignment = withChromBoundSource(
        createAlignmentTileSource(
          file,
          baseOpts,
          this.boundedReadBand ? 'bounded-network' : 'local'
        ),
        chrom,
        `:${chrom}`
      );
      this.chromSources.set(chrom, {
        alignment,
        globalStartBp: segment.globalStart,
        globalEndBp: segment.placement.globalEndBp,
        chrom,
      });
    }
  }

  private activateSourcesForRange(
    globalStart: number,
    globalEnd: number,
    targetLevel: number,
    requestCoverage: boolean
  ): void {
    const activeChroms = new Set(
      globalRangeToSegments(this.assembly, globalStart, globalEnd).map((s) => s.chrom)
    );
    const activeAlignmentSources: TileSource[] = [];
    if (this.exactReadDetailEligible) {
      for (const chrom of activeChroms) {
        const chromSource = this.chromSources.get(chrom);
        if (!chromSource) continue;
        activeAlignmentSources.push(chromSource.alignment);
      }
    }
    const coverageSource =
      this.opts.transport == null &&
      this.opts.source.remote == null &&
      this.opts.source.htsget == null &&
      this.exactReadDetailEligible
        ? this.readForegroundCoverageSource
        : this.assemblyCoverageSource;
    const activeSources = requestCoverage
      ? targetLevel > this.maxReadAlignment
        ? [coverageSource, ...activeAlignmentSources]
        : [...activeAlignmentSources, coverageSource]
      : activeAlignmentSources;
    this.sources.splice(0, this.sources.length, ...activeSources);
  }

  setViewport(
    range: { start: number; end: number },
    viewportPx: number,
    presentationViewportPx = viewportPx
  ): void {
    if (this.disposed) return;
    const view = this.updatePresentationViewport(range, viewportPx, presentationViewportPx);
    if (!view) return;
    if (this.retryRequired) {
      const nextPlanKey = this.viewportFetchPlanKey(view);
      if (nextPlanKey === this.retryRequiredPlanKey) return;
      this.retryRequired = false;
      this.retryRequiredPlanKey = null;
    }

    this.activateSourcesForRange(
      view.globalStart,
      view.globalEnd,
      this.convergedLevelForView(view),
      this.shouldRequestBamCoverage(view)
    );
    this.commitViewportFetch(view);
  }

  retryCurrentViewport(options: { readonly restartPending?: boolean } = {}): boolean {
    if (this.disposed || !this.lastViewport) return false;
    const view = this.lastViewport;
    this.retryRequired = false;
    this.retryRequiredPlanKey = null;
    if (options.restartPending === true) {
      this.coordinator.cancelPendingWhere(() => true);
    }
    this.activateSourcesForRange(
      view.globalStart,
      view.globalEnd,
      this.convergedLevelForView(view),
      this.shouldRequestBamCoverage(view)
    );
    this.commitViewportFetch(view);
    return true;
  }

  presentViewport(
    range: { start: number; end: number },
    viewportPx: number,
    presentationViewportPx = viewportPx
  ): boolean {
    if (this.disposed) return false;
    const view = this.updatePresentationViewport(range, viewportPx, presentationViewportPx);
    if (!view) return false;
    const presented = this.recomputeFeed();
    if (!presented || !this.exactReadPreparationIsEligible(view)) return presented;
    return this.composeReads(view, this.readLevelForView(view, this.coordinator.level ?? 0))
      .coversViewport;
  }

  canPresentViewportFromTargetGrid(
    range: { start: number; end: number },
    viewportPx: number,
    presentationViewportPx = viewportPx
  ): boolean {
    if (this.disposed) return false;
    const view = this.normalizeViewport(range, viewportPx);
    if (!view) return false;
    void presentationViewportPx;
    const level = this.convergedLevelForView(view);
    return this.targetGridCoverageCoversViewport(view, level);
  }

  private updatePresentationViewport(
    range: { start: number; end: number },
    viewportPx: number,
    presentationViewportPx: number
  ): Viewport | null {
    const view = this.normalizeViewport(range, viewportPx);
    if (!view) return null;
    const resolvedPresentationViewportPx =
      presentationViewportPx > 0 && Number.isFinite(presentationViewportPx)
        ? presentationViewportPx
        : viewportPx;
    const exactReadDetailEligible = pileupExactReadPreparationEligible(
      resolvedPresentationViewportPx / Math.max(1, view.globalEnd - view.globalStart)
    );
    if (this.exactReadDetailEligible && !exactReadDetailEligible) {
      this.readCompositionCache.clear();
      this.lastPublishedReadRevisionKey = null;
      this.coordinator.cancelPendingWhere((entry) => entry.key.sourceId.startsWith('aln:'));
    }
    this.exactReadDetailEligible = exactReadDetailEligible;
    this.lastViewport = view;
    this.lastPresentationViewportPx = resolvedPresentationViewportPx;
    this.ensureSourcesForRange(view.globalStart, view.globalEnd);
    return view;
  }

  private normalizeViewport(
    range: { start: number; end: number },
    viewportPx: number
  ): Viewport | null {
    const globalStart = Math.max(0, Math.min(range.start, range.end));
    const globalEnd = Math.min(this.assembly.totalLengthBp, Math.max(range.start, range.end));
    if (!(globalEnd > globalStart) || viewportPx <= 0) return null;
    return { globalStart, globalEnd, viewportPx };
  }

  private exactReadPreparationIsEligible(view: Viewport): boolean {
    if (this.lastPresentationViewportPx != null) return this.exactReadDetailEligible;
    return pileupExactReadPreparationEligible(
      view.viewportPx / Math.max(1, view.globalEnd - view.globalStart)
    );
  }

  private readLevelForView(view: Viewport, coverageLevel: number): number {
    return this.exactReadPreparationIsEligible(view)
      ? Math.min(coverageLevel, this.maxReadAlignment)
      : coverageLevel;
  }

  private commitViewportFetch(view: Viewport): void {
    if (this.disposed) return;
    const steps = this.convergenceSteps(view);
    if (steps > 1) {
      this.cache.setPins(Array.from(this.cache.entries(), (e) => e.key));
      const realSources = this.sources.splice(0, this.sources.length);
      for (let i = 0; i < steps - 1; i++) this.coordinator.setViewport(view);
      this.sources.push(...realSources);
    }
    this.cache.setPins([]);
    this.cache.setRetained(this.retentionPins(view));
    this.coordinator.setViewport(view);
    this.recomputeFeed();
  }

  private retentionPins(view: Viewport): TileKey[] {
    return uniqueTileKeys([
      ...this.plannedFineAlignmentPins(view),
      ...this.coverageRetentionPins(view),
      ...this.fineAlignmentRetentionPins(view),
    ]);
  }

  private coverageRetentionPins(view: Viewport): TileKey[] {
    const previousLevel = this.coordinator.level;
    if (previousLevel == null) return [];
    const deferBroadCoverage =
      this.opts.transport == null &&
      this.opts.source.remote == null &&
      this.opts.source.htsget == null &&
      this.exactReadPreparationIsEligible(view);
    const currentLevel = deferBroadCoverage ? this.convergedLevelForView(view) : previousLevel;
    const maxLevel = maxLevelForAssembly(this.assembly);
    const minBroadRetainedLevel = Math.max(0, maxLevel - BROAD_COVERAGE_RETAIN_LEVELS + 1);
    const minRetainedLevel = Math.max(0, currentLevel - 3);
    const maxRetainedLevel = Math.min(maxLevel, currentLevel + 3);
    const criticalHandoffLevels = new Set<number>();
    for (const source of this.sources) {
      if (!isCoverageSourceId(source.id)) continue;
      const criticalLevel = source.prefetch?.criticalFinerLevel;
      if (criticalLevel != null) {
        addRetainedCoverageHandoffLevels(
          criticalHandoffLevels,
          currentLevel,
          criticalLevel,
          normalizeCriticalPrefetchLevels(source.prefetch?.criticalFinerPrefetchLevels),
          source.prefetch?.criticalFinerMaxCurrentLevel ?? maxLevel
        );
      }
      for (const handoff of source.prefetch?.additionalCriticalFinerHandoffs ?? []) {
        addRetainedCoverageHandoffLevels(
          criticalHandoffLevels,
          currentLevel,
          handoff.level,
          normalizeCriticalPrefetchLevels(handoff.prefetchLevels),
          handoff.maxCurrentLevel ?? maxLevel
        );
      }
    }
    const span = Math.max(1, view.globalEnd - view.globalStart);
    const haloBp = Math.max(4_000_000, span * 4);
    const retainStart = Math.max(0, view.globalStart - haloBp);
    const retainEnd = Math.min(this.assembly.totalLengthBp, view.globalEnd + haloBp);
    const center = (view.globalStart + view.globalEnd) / 2;
    const pins: TileKey[] = [];

    for (const entry of this.cache.entries()) {
      if (entry.state !== 'pending' && entry.state !== 'ready') continue;
      if (!isCoverageSourceId(entry.key.sourceId)) continue;
      const inCurrentBand =
        entry.key.level >= minRetainedLevel && entry.key.level <= maxRetainedLevel;
      const inBroadOverviewBand = entry.key.level >= minBroadRetainedLevel;
      const inHandoff = criticalHandoffLevels.has(entry.key.level);

      if (inBroadOverviewBand) {
        if (entry.state === 'pending') {
          if (deferBroadCoverage && !inCurrentBand && !inHandoff) continue;
          if (criticalHandoffLevels.size > 0 && entry.key.level !== maxLevel - 1) continue;
          promotePendingCoveragePriority(entry, this.coordinator.epoch + 1);
        }
        pins.push(entry.key);
        continue;
      }

      const tileStart = tileGlobalStart(entry.key.index, entry.key.level);
      const tileEnd = tileGlobalEnd(entry.key.index, entry.key.level);
      if (inCurrentBand || inHandoff) {
        if (tileEnd <= retainStart || tileStart >= retainEnd) continue;
        pins.push(entry.key);
        continue;
      }
      if (tileStart <= center && center < tileEnd) pins.push(entry.key);
    }
    return pins;
  }

  private fineAlignmentRetentionPins(view: Viewport): TileKey[] {
    if (!this.exactReadPreparationIsEligible(view)) {
      return [];
    }
    const coverageLevel = this.coordinator.level;
    if (coverageLevel == null) return [];
    const currentLevel = this.readLevelForView(view, coverageLevel);
    const span = Math.max(1, view.globalEnd - view.globalStart);
    const haloBp = Math.max(FINE_ALIGNMENT_RETAIN_MIN_BP, span * FINE_ALIGNMENT_RETAIN_VIEWPORTS);
    const retainStart = Math.max(0, view.globalStart - haloBp);
    const retainEnd = Math.min(this.assembly.totalLengthBp, view.globalEnd + haloBp);
    const minLevel = Math.max(0, currentLevel - 2);
    const maxLevel = Math.min(this.maxReadAlignment, currentLevel + 2);
    const pins: TileKey[] = [];

    for (const entry of this.cache.entries()) {
      if (entry.state !== 'pending' && entry.state !== 'ready') continue;
      if (entry.state === 'pending') continue;
      if (!entry.key.sourceId.startsWith('aln:')) continue;
      if (entry.key.level < minLevel || entry.key.level > maxLevel) continue;
      const tileStart = tileGlobalStart(entry.key.index, entry.key.level);
      const tileEnd = tileGlobalEnd(entry.key.index, entry.key.level);
      if (tileEnd <= retainStart || tileStart >= retainEnd) continue;
      pins.push(entry.key);
    }
    return pins;
  }

  private plannedFineAlignmentPins(view: Viewport): TileKey[] {
    if (!this.exactReadPreparationIsEligible(view)) {
      return [];
    }
    const targetLevel = this.readLevelForView(view, this.convergedLevelForView(view));
    const pins: TileKey[] = [];
    for (const source of this.sources) {
      if (!source.id.startsWith('aln:')) continue;
      if (targetLevel < source.levelRange[0] || targetLevel > source.levelRange[1]) continue;
      const marginTiles =
        source.prefetch?.sameLevelMarginTiles != null && source.prefetch.sameLevelMarginTiles > 0
          ? source.prefetch.sameLevelMarginTiles
          : PREFETCH_MARGIN_TILES;
      for (const tile of visibleTiles(view, targetLevel, this.assembly, marginTiles)) {
        pins.push({ sourceId: source.id, level: targetLevel, index: tile.index });
      }
    }
    return pins;
  }

  private convergenceSteps(view: Viewport): number {
    return this.levelConvergence(view).steps;
  }

  private convergedLevelForView(view: Viewport): number {
    return this.levelConvergence(view).level;
  }

  private levelConvergence(view: Viewport): { steps: number; level: number } {
    const maxLevel = maxLevelForAssembly(this.assembly);
    let last = this.coordinator.level;
    let steps = 0;
    for (let i = 0; i < 48; i++) {
      const next = pickLevel(view, maxLevel, last);
      if (next === last) break;
      steps += 1;
      last = next;
    }
    if (last == null) last = pickLevel(view, maxLevel, null);
    return { steps: Math.max(1, steps), level: last };
  }

  private scheduleFeed(): void {
    if (this.cancelScheduledFeed || this.disposed) return;
    const flush = () => {
      this.cancelScheduledFeed = null;
      if (this.disposed) return;
      this.recomputeFeed(false);
    };
    const postPaint = this.opts.settlementScheduler;
    if (postPaint) {
      const handle = postPaint.requestPostPaint(flush);
      this.cancelScheduledFeed = () => postPaint.cancel(handle);
      return;
    }
    const injected = this.opts.frameScheduler;
    if (injected) {
      const handle = injected.request(flush);
      this.cancelScheduledFeed = () => injected.cancel(handle);
      return;
    }
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    if (typeof requestFrame === 'function' && typeof cancelFrame === 'function') {
      let frameHandle: number | null = requestFrame.call(globalThis, () => {
        frameHandle = null;
        const timerHandle = globalThis.setTimeout(flush, 0);
        this.cancelScheduledFeed = () => globalThis.clearTimeout(timerHandle);
      });
      this.cancelScheduledFeed = () => {
        if (frameHandle != null) cancelFrame.call(globalThis, frameHandle);
      };
      return;
    }
    const handle = globalThis.setTimeout(flush, 0);
    this.cancelScheduledFeed = () => globalThis.clearTimeout(handle);
  }

  private exactReadOwnerPresentationKind(args: {
    visibleReadRecordCount: number;
    readsCoverViewport: boolean;
    stableBandReady: boolean;
    cameraSettled: boolean;
  }): TileEngineOwnerPresentationKind {
    if (args.visibleReadRecordCount > 0 && args.readsCoverViewport) return 'reads';
    if (!args.stableBandReady) return 'pending';
    if (!args.cameraSettled) return 'reads';
    return 'empty';
  }

  private cameraSettledForEmptyRegion(view: Viewport): boolean {
    const center = (view.globalStart + view.globalEnd) / 2;
    const moved =
      this.lastMotionCenterBp != null && Math.abs(center - this.lastMotionCenterBp) >= 1;
    this.lastMotionCenterBp = center;
    if (moved) {
      this.lastViewportMotionAtMs = driverNowMs();
      this.cancelEmptyRegionSettlement?.();
      this.cancelEmptyRegionSettlement = null;
    }
    return (
      this.lastViewportMotionAtMs === 0 ||
      driverNowMs() - this.lastViewportMotionAtMs >= EMPTY_REGION_SETTLE_MS
    );
  }

  private scheduleEmptyRegionSettlement(): void {
    if (this.cancelEmptyRegionSettlement || this.disposed) return;
    const remainingMs = Math.max(
      1,
      EMPTY_REGION_SETTLE_MS - (driverNowMs() - this.lastViewportMotionAtMs)
    );
    const handle = globalThis.setTimeout(() => {
      this.cancelEmptyRegionSettlement = null;
      if (!this.disposed) this.scheduleFeed();
    }, remainingMs);
    this.cancelEmptyRegionSettlement = () => globalThis.clearTimeout(handle);
  }

  private exactReadBandOwnsVisiblePileup(args: {
    histogramCoverageBandEligible: boolean;
    exactReadOwner: boolean;
    stableBandReady: boolean;
    readsTruncated: boolean;
    readsCoverViewport: boolean;
    viewportPx: number;
    viewSpanBp: number;
  }): boolean {
    return (
      !args.histogramCoverageBandEligible &&
      args.exactReadOwner &&
      args.stableBandReady &&
      !args.readsTruncated &&
      args.readsCoverViewport &&
      pileupExactReadZoomAlpha(args.viewportPx / args.viewSpanBp) >= 1
    );
  }

  private coverageMemoShouldSkipPublish(args: {
    memoHit: boolean;
    readChanged: boolean;
    corridorReadinessChanged: boolean;
    corridorAtlasChanged: boolean;
    exactReadOwnerPresentationChanged: boolean;
  }): boolean {
    return (
      args.memoHit &&
      !args.readChanged &&
      !args.corridorReadinessChanged &&
      !args.corridorAtlasChanged &&
      !args.exactReadOwnerPresentationChanged
    );
  }

  private publishFeed(feed: TileEngineFeed): void {
    this.lastPublishedFeed = feed;
    this.opts.onFeed(feed);
  }

  private recomputeFeed(publishMemoHit = true): boolean {
    const view = this.lastViewport;
    if (!view) return false;
    const level = this.coordinator.level ?? 0;
    const readLevel = this.readLevelForView(view, level);
    const histogramCoverageBandEligible = this.histogramCoverageBandEligible(view);
    const fullAssemblyInteractionCorridorReady = this.fullAssemblyInteractionCorridorReady(
      view.viewportPx
    );
    const corridorReadinessChanged =
      fullAssemblyInteractionCorridorReady !==
      this.lastPublishedFullAssemblyInteractionCorridorReady;
    const corridorAtlas = this.verifiedCorridorFloorGpuAtlas;
    const corridorAtlasChanged =
      (corridorAtlas?.authorityKey ?? null) !== this.lastPublishedCorridorAtlasAuthorityKey;
    const alignmentPresentationChanged =
      this.alignmentPresentationGeneration !== this.processedAlignmentPresentationGeneration;
    let forceViewportAuthority = false;
    const coverageMemo = this.evaluateCoverageBandMemo({
      publishMemoHit,
      view,
      histogramCoverageBandEligible,
      corridorReadinessChanged,
      corridorAtlasChanged,
      alignmentPresentationChanged,
    });
    if (coverageMemo.kind === 'return') return coverageMemo.value;
    forceViewportAuthority = coverageMemo.forceViewportAuthority;

    const totalStartedAt = driverNowMs();
    const coverageStartedAt = driverNowMs();
    const readsStartedAt = driverNowMs();
    const {
      records,
      alternateColumns,
      windowStartBp,
      windowEndBp,
      truncated: readsTruncated,
      revisionKey: readRevisionKey,
      coversViewport: readsCoverViewport,
      stableBandReady,
    } = this.composeReads(view, readLevel);
    const exactReadOwner = this.exactReadPreparationIsEligible(view);
    const visibleReadRecordCount = records.reduce(
      (count, record) =>
        count + (record.end > view.globalStart && record.start < view.globalEnd ? 1 : 0),
      0
    );
    const cameraSettled = this.cameraSettledForEmptyRegion(view);
    if (exactReadOwner && stableBandReady && visibleReadRecordCount === 0 && !cameraSettled) {
      this.scheduleEmptyRegionSettlement();
    } else {
      this.cancelEmptyRegionSettlement?.();
      this.cancelEmptyRegionSettlement = null;
    }
    const referenceIntervals = exactReadOwner
      ? this.referenceIntervalsForView(view, readLevel)
      : [];
    const referenceIntervalSignature = referenceIntervals
      .map((interval) => `${interval.state}:${interval.startBp}:${interval.endBp}`)
      .join('|');
    const referenceIntervalsChanged =
      referenceIntervalSignature !== this.lastReferenceIntervalSignature;
    const exactReadOwnerPresentationKind = this.exactReadOwnerPresentationKind({
      visibleReadRecordCount,
      readsCoverViewport,
      stableBandReady,
      cameraSettled,
    });
    const exactReadOwnerPresentationChanged =
      exactReadOwner && exactReadOwnerPresentationKind !== this.lastPublishedOwnerPresentationKind;
    this.processedAlignmentPresentationGeneration = this.alignmentPresentationGeneration;
    const readsComposeMs = driverNowMs() - readsStartedAt;
    const readChanged = readRevisionKey !== this.lastPublishedReadRevisionKey;

    if (corridorAtlas && this.corridorAtlasPhysicallyEligible(view)) {
      return this.tryPublishPhysicallyEligibleCorridorAtlas({
        view,
        corridorAtlas,
        corridorAtlasChanged,
        corridorReadinessChanged,
        readChanged,
        readRevisionKey,
        fullAssemblyInteractionCorridorReady,
        exactReadOwner,
        windowStartBp,
        windowEndBp,
        readsTruncated,
        records,
        alternateColumns,
        readsComposeMs,
        totalStartedAt,
        level,
      });
    }

    const viewSpanBp = Math.max(1, view.globalEnd - view.globalStart);
    const exactReadBandOwnsVisiblePileup = this.exactReadBandOwnsVisiblePileup({
      histogramCoverageBandEligible,
      exactReadOwner,
      stableBandReady,
      readsTruncated,
      readsCoverViewport,
      viewportPx: this.lastPresentationViewportPx ?? view.viewportPx,
      viewSpanBp,
    });
    const coverageSemanticKey = this.coverageSemanticKey(
      view,
      histogramCoverageBandEligible ? 'guide-only' : readRevisionKey,
      exactReadBandOwnsVisiblePileup,
      exactReadOwnerPresentationKind
    );
    this.coveragePlanCount += 1;
    const memoHit = this.lastCoverageMemo?.semanticKey === coverageSemanticKey;
    if (
      this.coverageMemoShouldSkipPublish({
        memoHit,
        readChanged,
        corridorReadinessChanged,
        corridorAtlasChanged,
        exactReadOwnerPresentationChanged:
          exactReadOwnerPresentationChanged || referenceIntervalsChanged,
      })
    ) {
      this.coverageMemoHitCount += 1;
      const published = this.lastPublishedFeed;
      if (
        exactReadOwner &&
        readsCoverViewport &&
        !readsTruncated &&
        (exactReadOwnerPresentationKind === 'reads' ||
          exactReadOwnerPresentationKind === 'empty') &&
        published?.ownerPresentation?.kind === exactReadOwnerPresentationKind &&
        published.readSource &&
        !published.readSource.truncated &&
        typeof published.readSource.windowStartBp === 'number' &&
        typeof published.readSource.windowEndBp === 'number' &&
        published.readSource.windowStartBp <= view.globalStart &&
        published.readSource.windowEndBp >= view.globalEnd
      ) {
        this.opts.onReadPresentationReuse?.({
          feed: published,
          viewRange: { start: view.globalStart, end: view.globalEnd },
          requiredReadBandReady: stableBandReady,
        });
      }
      return publishMemoHit;
    }
    const { finest, coverageMaxDepthMs } = this.materializeCoverageForViewport({
      memoHit,
      forceViewportAuthority,
      histogramCoverageBandEligible,
      view,
      records,
      windowStartBp,
      windowEndBp,
      coverageSemanticKey,
    });
    const coverageComposeMs = driverNowMs() - coverageStartedAt - readsComposeMs;
    const readRevisionChanged =
      readRevisionKey !== this.lastPublishedReadRevisionKey || exactReadOwnerPresentationChanged;
    const hasNewCompleteReadOwner =
      visibleReadRecordCount > 0 && readsCoverViewport && readRevisionChanged;
    const hasNewAuthoritativeEmptyOwner =
      exactReadOwner &&
      stableBandReady &&
      cameraSettled &&
      visibleReadRecordCount === 0 &&
      readRevisionChanged;
    const corridorAtlasPresentation = this.corridorAtlasPresentationForFeed(corridorAtlas, finest);
    const corridorAtlasPresentationChanged =
      corridorAtlasPresentation !== this.lastPublishedCorridorAtlasPresentation;
    const externalHistogram = this.remoteHistogramIsBigWig();
    if (
      !finest &&
      !externalHistogram &&
      !hasNewCompleteReadOwner &&
      !hasNewAuthoritativeEmptyOwner &&
      !corridorAtlasChanged &&
      !corridorAtlasPresentationChanged &&
      !referenceIntervalsChanged
    ) {
      return false;
    }
    let composedCoverage: CoverageSignal | undefined;
    let coverageLod: TileEngineFeed['coverageLod'];
    if (finest) {
      composedCoverage = finest.signal;
      coverageLod = this.finestCoverageLod(finest.level, composedCoverage);
      this.rememberResidentCoverage(finest.level, composedCoverage);
    }

    const coveragePresentationDebug = this.coveragePresentationDebugForFeed(
      composedCoverage,
      corridorAtlas
    );
    const ownerPresentation = this.ownerPresentationForFeed(
      exactReadOwner,
      exactReadOwnerPresentationKind,
      composedCoverage,
      corridorAtlas
    );
    this.publishFeed({
      ...(composedCoverage ? { coverage: composedCoverage } : {}),
      ...(corridorAtlas ? { coverageGpuAtlas: corridorAtlas } : {}),
      ...(corridorAtlasPresentation
        ? { coverageGpuAtlasPresentation: corridorAtlasPresentation }
        : {}),
      ...(coverageLod ? { coverageLod } : {}),
      viewRange: { start: view.globalStart, end: view.globalEnd },
      coveragePresentation: coveragePresentationDebug,
      records,
      alternateColumns,
      ownerPresentation,
      ...(exactReadOwner ? { requiredReadBandReady: stableBandReady } : {}),
      referenceIntervals,
      fullAssemblyInteractionCorridorReady,
      readSource:
        exactReadOwner && windowStartBp != null && windowEndBp != null
          ? { truncated: readsTruncated, windowStartBp, windowEndBp }
          : undefined,
      debugTimings: {
        totalMs: driverNowMs() - totalStartedAt,
        coverageComposeMs,
        coverageMaxDepthMs,
        readsComposeMs,
        recordCount: records.length,
        coverageBinCount: composedCoverage?.bins.length ?? 0,
        coverageBinSize: composedCoverage?.binSize ?? null,
        targetLevel: level,
        viewStartBp: view.globalStart,
        viewEndBp: view.globalEnd,
        coveragePresentationKind: coveragePresentationDebug.kind,
        coveragePresentationReason:
          coveragePresentationDebug.kind === 'none' ? coveragePresentationDebug.reason : null,
        targetCoveragePending: false,
        targetCoverageErrored: false,
        currentCoverageBinSize: composedCoverage?.binSize ?? null,
        mixedCoverageBinSize: null,
        residentCoverageCandidateCount: 0,
        coverageMemoHit: memoHit,
        coverageRevision: composedCoverage?.coverageRevision,
        coverageMemoMaterializeCount: this.coverageMaterializeCount,
        coverageMemoRevisionChangeCount: this.coverageRevisionChangeCount,
        exactCoverageRecordScanCount: this.exactCoverageRecordScanCount,
        exactCoverageGeneration: this.exactCoverageGeneration,
      },
    });
    this.lastPublishedReadRevisionKey = readRevisionKey;
    this.lastPublishedFullAssemblyInteractionCorridorReady = fullAssemblyInteractionCorridorReady;
    this.lastPublishedCorridorAtlasAuthorityKey = corridorAtlas?.authorityKey ?? null;
    this.lastPublishedCorridorAtlasPresentation = corridorAtlasPresentation;
    this.lastPublishedOwnerPresentationKind = ownerPresentation.kind;
    this.lastReferenceIntervalSignature = referenceIntervalSignature;
    return true;
  }

  fullAssemblyInteractionCorridorReady(viewportPx: number): boolean {
    if (!(viewportPx > 0) || this.assembly.totalLengthBp <= 0) return false;
    const maxLevel = maxLevelForAssembly(this.assembly);
    const minimumSpan = Math.min(
      this.assembly.totalLengthBp,
      FULL_ASSEMBLY_INTERACTION_MIN_SPAN_BP
    );
    const targetLevel = pickLevel(
      { globalStart: 0, globalEnd: minimumSpan, viewportPx },
      maxLevel,
      null
    );
    const minimumFloorLevel = Math.max(0, targetLevel - 1);
    const wholeAssembly: Viewport = {
      globalStart: 0,
      globalEnd: this.assembly.totalLengthBp,
      viewportPx,
    };
    const maximumCorridorLevel = pickLevel(wholeAssembly, maxLevel, null);
    const presentationContract = JSON.stringify([
      minimumFloorLevel,
      maximumCorridorLevel,
      viewportPx,
      this.assembly.totalLengthBp,
    ]);
    const floorLayer = this.verifiedCorridorFloor?.layers.values().next().value;
    if (
      floorLayer &&
      floorLayer.binSize <= binBp(minimumFloorLevel) &&
      this.corridorFloorCoversAssembly()
    ) {
      this.corridorReadinessCache = {
        sourceGeneration: `corridor-floor:${this.verifiedCorridorFloor!.sourceIdentity}:${this.corridorFloorContractGeneration}`,
        presentationContract,
        ready: true,
      };
      return true;
    }
    const sourceGeneration = `exact:${this.exactCoverageGeneration}`;
    if (
      this.corridorReadinessCache?.sourceGeneration === sourceGeneration &&
      this.corridorReadinessCache.presentationContract === presentationContract
    ) {
      return this.corridorReadinessCache.ready;
    }
    let ready = true;
    for (let level = minimumFloorLevel; level <= maximumCorridorLevel; level += 1) {
      const ranges: Array<{ globalStart: number; globalEnd: number }> = [];
      for (const record of this.exactCoverageTiles.values()) {
        if (record.key.level !== level) continue;
        for (const slice of record.slices) {
          ranges.push({ globalStart: slice.globalStart, globalEnd: slice.globalEnd });
        }
      }
      if (!rangesCoverViewport(ranges, wholeAssembly)) {
        ready = false;
        break;
      }
    }
    this.corridorReadinessCache = { sourceGeneration, presentationContract, ready };
    return ready;
  }

  private coverageSemanticKey(
    view: Viewport,
    readRevisionKey: string,
    exactRowsOwnVisiblePileup = false,
    exactReadOwnerPresentationKind: TileEngineOwnerPresentationKind = 'pending'
  ): string {
    const forcedLevel = readForcedCoverageLevelForTestBridge(import.meta.env);
    if (exactRowsOwnVisiblePileup) {
      return JSON.stringify([
        'exact-read-owner',
        readRevisionKey,
        exactReadOwnerPresentationKind,
        forcedLevel,
      ]);
    }
    return JSON.stringify([
      view.globalStart,
      view.globalEnd,
      view.viewportPx,
      this.exactCoverageContributorKey(view),
      this.residentCoverageGeneration,
      this.depthScaleGeneration,
      readRevisionKey,
      forcedLevel,
    ]);
  }

  private corridorFloorCoversAssembly(): boolean {
    const floor = this.verifiedCorridorFloor;
    if (
      !floor ||
      this.corridorFloorState !== 'ready' ||
      floor.contract !== COVERAGE_CORRIDOR_FLOOR_CONTRACT ||
      floor.layers.size !== this.assembly.chromosomes.length
    ) {
      return false;
    }
    const ranges = [...floor.layers.values()].map((layer) => ({
      globalStart: layer.globalStart,
      globalEnd: Math.min(
        layer.globalEnd ?? Number.POSITIVE_INFINITY,
        layer.globalStart + layer.bins.length * layer.binSize
      ),
    }));
    return rangesCoverViewport(ranges, {
      globalStart: 0,
      globalEnd: this.assembly.totalLengthBp,
      viewportPx: 1,
    });
  }

  private corridorAtlasPhysicallyEligible(view: Viewport): boolean {
    const atlas = this.verifiedCorridorFloorGpuAtlas;
    return (
      atlas != null &&
      this.corridorFloorState === 'ready' &&
      coverageGpuAtlasEligible(atlas, view.globalEnd - view.globalStart, view.viewportPx)
    );
  }

  private histogramCoverageBandEligible(view: Viewport): boolean {
    return !this.exactReadPreparationIsEligible(view);
  }

  private corridorAtlasPresentationForFeed(
    corridorAtlas: CoverageGpuAtlas | null | undefined,
    finest: { signal: CoverageSignal; level: number } | undefined
  ): 'standby' | 'handoff-hold' | undefined {
    if (!corridorAtlas) return undefined;
    return finest ? 'standby' : 'handoff-hold';
  }

  private coveragePresentationDebugForFeed(
    composedCoverage: CoverageSignal | undefined,
    corridorAtlas: CoverageGpuAtlas | null | undefined
  ): { kind: 'current' } | { kind: 'none'; reason: 'no-presentable-surface' } {
    return composedCoverage || corridorAtlas
      ? { kind: 'current' as const }
      : { kind: 'none' as const, reason: 'no-presentable-surface' as const };
  }

  private ownerPresentationForFeed(
    exactReadOwner: boolean,
    exactReadOwnerPresentationKind: TileEngineOwnerPresentationKind,
    composedCoverage: CoverageSignal | undefined,
    corridorAtlas: CoverageGpuAtlas | null | undefined
  ): NonNullable<TileEngineFeed['ownerPresentation']> {
    if (exactReadOwner) return { kind: exactReadOwnerPresentationKind };
    if (composedCoverage || corridorAtlas) return { kind: 'coverage' };
    if (this.remoteHistogramIsBigWig()) return { kind: 'coverage' };
    return { kind: 'pending' };
  }

  private remoteHistogramIsBigWig(): boolean {
    return (this.opts.source.remote?.locator.signalPath?.length ?? 0) > 0;
  }

  private shouldRequestBamCoverage(view: Viewport): boolean {
    return !this.remoteHistogramIsBigWig() && !this.corridorAtlasPhysicallyEligible(view);
  }

  private tryPublishPhysicallyEligibleCorridorAtlas(args: {
    view: Viewport;
    corridorAtlas: CoverageGpuAtlas;
    corridorAtlasChanged: boolean;
    corridorReadinessChanged: boolean;
    readChanged: boolean;
    readRevisionKey: string;
    fullAssemblyInteractionCorridorReady: boolean;
    exactReadOwner: boolean;
    windowStartBp: number | undefined;
    windowEndBp: number | undefined;
    readsTruncated: boolean;
    records: ReadonlyArray<PileupRecord>;
    alternateColumns: ReadonlyArray<PileupAlternateColumn>;
    readsComposeMs: number;
    totalStartedAt: number;
    level: number;
  }): boolean {
    const presentation = 'active' as const;
    const presentationChanged =
      this.lastPublishedCorridorAtlasPresentation !== presentation || args.corridorAtlasChanged;
    const ownerPresentationChanged = this.lastPublishedOwnerPresentationKind !== 'coverage';
    if (
      !args.readChanged &&
      !presentationChanged &&
      !args.corridorReadinessChanged &&
      !ownerPresentationChanged
    ) {
      this.opts.onCoverageAtlasReuse?.({
        coverageGpuAtlas: args.corridorAtlas,
        viewRange: { start: args.view.globalStart, end: args.view.globalEnd },
        fullAssemblyInteractionCorridorReady: args.fullAssemblyInteractionCorridorReady,
      });
      return true;
    }
    this.publishFeed({
      coverageGpuAtlas: args.corridorAtlas,
      coverageGpuAtlasPresentation: presentation,
      viewRange: { start: args.view.globalStart, end: args.view.globalEnd },
      coveragePresentation: { kind: 'current' },
      records: args.records,
      alternateColumns: args.alternateColumns,
      ownerPresentation: { kind: 'coverage' },
      fullAssemblyInteractionCorridorReady: args.fullAssemblyInteractionCorridorReady,
      readSource:
        args.exactReadOwner && args.windowStartBp != null && args.windowEndBp != null
          ? {
              truncated: args.readsTruncated,
              windowStartBp: args.windowStartBp,
              windowEndBp: args.windowEndBp,
            }
          : undefined,
      debugTimings: {
        totalMs: driverNowMs() - args.totalStartedAt,
        coverageComposeMs: 0,
        coverageMaxDepthMs: 0,
        readsComposeMs: args.readsComposeMs,
        recordCount: args.records.length,
        coverageBinCount: 0,
        coverageBinSize: args.corridorAtlas.baseBinSizeBp,
        targetLevel: args.level,
        viewStartBp: args.view.globalStart,
        viewEndBp: args.view.globalEnd,
        coveragePresentationKind: 'current',
        coveragePresentationReason: null,
        targetCoveragePending: false,
        targetCoverageErrored: false,
        currentCoverageBinSize: args.corridorAtlas.baseBinSizeBp,
        mixedCoverageBinSize: null,
        residentCoverageCandidateCount: 1,
        coverageMemoHit: true,
        coverageRevision: args.corridorAtlas.authorityKey,
        coverageMemoMaterializeCount: this.coverageMaterializeCount,
        coverageMemoRevisionChangeCount: this.coverageRevisionChangeCount,
        exactCoverageRecordScanCount: this.exactCoverageRecordScanCount,
        exactCoverageGeneration: this.exactCoverageGeneration,
      },
    });
    this.lastPublishedReadRevisionKey = args.readRevisionKey;
    this.lastPublishedFullAssemblyInteractionCorridorReady =
      args.fullAssemblyInteractionCorridorReady;
    this.lastPublishedCorridorAtlasAuthorityKey = args.corridorAtlas.authorityKey;
    this.lastPublishedCorridorAtlasPresentation = presentation;
    this.lastPublishedOwnerPresentationKind = 'coverage';
    return true;
  }

  private materializeCoverageForViewport(args: {
    memoHit: boolean;
    forceViewportAuthority: boolean;
    histogramCoverageBandEligible: boolean;
    view: Viewport;
    records: ReadonlyArray<PileupRecord>;
    windowStartBp: number | null | undefined;
    windowEndBp: number | null | undefined;
    coverageSemanticKey: string;
  }): {
    finest: { signal: CoverageSignal; level: number } | undefined;
    coverageMaxDepthMs: number;
  } {
    if (args.memoHit) {
      this.coverageMemoHitCount += 1;
      return {
        finest: {
          signal: this.lastCoverageMemo!.signal,
          level: this.lastCoverageMemo!.level,
        },
        coverageMaxDepthMs: 0,
      };
    }

    this.coverageMaterializeCount += 1;
    let materialized: ReturnType<TileEngineDriver['composeResampledCoverage']> = undefined;
    let materializationView = args.view;
    let materializationAuthority = this.exactCoverageAuthority(args.view);
    if (
      !args.forceViewportAuthority &&
      args.histogramCoverageBandEligible &&
      args.records.length === 0
    ) {
      const bandView = this.coverageBandView(args.view);
      const bandAuthority = this.exactCoverageAuthority(bandView);
      materialized = this.composeResampledCoverage(
        bandView,
        args.records,
        args.windowStartBp ?? undefined,
        args.windowEndBp ?? undefined,
        args.view,
        bandAuthority.resolution
      );
      if (materialized) {
        materializationView = bandView;
        materializationAuthority = bandAuthority;
      }
    }
    materialized ??= this.composeResampledCoverage(
      args.view,
      args.records,
      args.windowStartBp ?? undefined,
      args.windowEndBp ?? undefined,
      args.view,
      materializationAuthority.resolution
    );
    if (!materialized) {
      this.lastCoverageMemo = null;
      this.coverageBandMemo = null;
      return { finest: undefined, coverageMaxDepthMs: 0 };
    }

    const depthStartedAt = driverNowMs();
    const scaled = withViewportMaxDepth(materialized.signal, args.view);
    const coverageMaxDepthMs = driverNowMs() - depthStartedAt;
    const signal: CoverageSignal = {
      ...scaled,
      coverageRevision: `${this.coverageProducerEpoch}:${++this.coverageRevisionSequence}`,
    };
    this.coverageRevisionChangeCount += 1;
    this.lastCoverageMemo = {
      semanticKey: args.coverageSemanticKey,
      signal,
      level: materialized.level,
    };
    this.coverageBandMemo = {
      signal,
      view: materializationView,
      authorityResolution: materializationAuthority.resolution,
      authorityKey: materializationAuthority.key,
      depthScaleGeneration: this.depthScaleGeneration,
    };
    return { finest: { signal, level: materialized.level }, coverageMaxDepthMs };
  }

  private evaluateCoverageBandMemo(args: {
    publishMemoHit: boolean;
    view: Viewport;
    histogramCoverageBandEligible: boolean;
    corridorReadinessChanged: boolean;
    corridorAtlasChanged: boolean;
    alignmentPresentationChanged: boolean;
  }): { kind: 'return'; value: boolean } | { kind: 'continue'; forceViewportAuthority: boolean } {
    if (
      this.shouldReusePublishedCoverageBand(
        args.publishMemoHit,
        args.view,
        args.histogramCoverageBandEligible,
        args.corridorReadinessChanged,
        args.corridorAtlasChanged
      )
    ) {
      this.coverageMemoHitCount += 1;
      return { kind: 'return', value: true };
    }
    if (
      !this.shouldInspectCoverageBandMemo(
        args.publishMemoHit,
        args.alignmentPresentationChanged,
        args.corridorReadinessChanged,
        args.corridorAtlasChanged,
        args.histogramCoverageBandEligible
      )
    ) {
      return { kind: 'continue', forceViewportAuthority: false };
    }
    const currentAuthority = this.exactCoverageAuthority(args.view);
    const coverageBandMemo = this.coverageBandMemo;
    if (!coverageBandMemo) {
      return { kind: 'continue', forceViewportAuthority: false };
    }
    if (
      currentAuthority.resolution === coverageBandMemo.authorityResolution &&
      this.depthScaleGeneration === coverageBandMemo.depthScaleGeneration
    ) {
      const bandAuthority = this.exactCoverageAuthority(coverageBandMemo.view);
      if (bandAuthority.key === coverageBandMemo.authorityKey) {
        this.coverageMemoHitCount += 1;
        return { kind: 'return', value: false };
      }
    } else if (
      currentAuthority.resolution != null &&
      (coverageBandMemo.authorityResolution == null ||
        currentAuthority.resolution < coverageBandMemo.authorityResolution)
    ) {
      return { kind: 'continue', forceViewportAuthority: true };
    }
    return { kind: 'continue', forceViewportAuthority: false };
  }

  private shouldReusePublishedCoverageBand(
    publishMemoHit: boolean,
    view: Viewport,
    histogramCoverageBandEligible: boolean,
    corridorReadinessChanged: boolean,
    corridorAtlasChanged: boolean
  ): boolean {
    return (
      publishMemoHit &&
      this.canReuseCoverageBand(view, histogramCoverageBandEligible) &&
      !corridorReadinessChanged &&
      !corridorAtlasChanged
    );
  }

  private shouldInspectCoverageBandMemo(
    publishMemoHit: boolean,
    alignmentPresentationChanged: boolean,
    corridorReadinessChanged: boolean,
    corridorAtlasChanged: boolean,
    histogramCoverageBandEligible: boolean
  ): boolean {
    return (
      !publishMemoHit &&
      !alignmentPresentationChanged &&
      !corridorReadinessChanged &&
      !corridorAtlasChanged &&
      Boolean(this.coverageBandMemo) &&
      histogramCoverageBandEligible
    );
  }

  private canReuseCoverageBand(view: Viewport, histogramCoverageBandEligible: boolean): boolean {
    const signal = this.coverageBandMemo?.signal;
    if (!histogramCoverageBandEligible || !signal) return false;
    const span = view.globalEnd - view.globalStart;
    if (!coverageSignalCoversViewport(signal, view)) return false;
    const presentationPx = this.lastPresentationViewportPx ?? view.viewportPx;
    return (signal.binSize * Math.max(1, presentationPx)) / Math.max(1, span) <= 1.001;
  }

  private coverageBandView(view: Viewport): Viewport {
    const span = Math.max(1, view.globalEnd - view.globalStart);
    const total = this.assembly.totalLengthBp;
    const desiredBandSpan = 2 ** Math.ceil(Math.log2(span * 2));
    if (desiredBandSpan >= total) {
      return { globalStart: 0, globalEnd: total, viewportPx: view.viewportPx };
    }
    const stride = desiredBandSpan / 2;
    let globalStart = Math.floor(view.globalStart / stride) * stride;
    if (view.globalEnd > globalStart + desiredBandSpan) globalStart += stride;
    globalStart = Math.max(0, Math.min(globalStart, total - desiredBandSpan));
    return {
      globalStart,
      globalEnd: globalStart + desiredBandSpan,
      viewportPx: view.viewportPx,
    };
  }

  private exactCoverageContributorKey(view: Viewport): string {
    return this.exactCoverageAuthority(view).key;
  }

  private exactCoverageAuthority(view: Viewport): {
    resolution: number | null;
    key: string;
  } {
    const completeRangesByResolution = new Map<
      number,
      Array<{ globalStart: number; globalEnd: number }>
    >();
    for (const record of this.exactCoverageTiles.values()) {
      this.exactCoverageRecordScanCount += 1;
      for (const slice of record.slices) {
        const bins = slice.payload.bins;
        if (!(slice.binSize > 0) || !Array.isArray(bins) || bins.length === 0) continue;
        const supportedEnd = Math.min(
          slice.globalEnd,
          slice.globalStart + bins.length * slice.binSize
        );
        if (supportedEnd <= view.globalStart || slice.globalStart >= view.globalEnd) continue;
        const ranges = completeRangesByResolution.get(slice.binSize) ?? [];
        ranges.push({ globalStart: slice.globalStart, globalEnd: supportedEnd });
        completeRangesByResolution.set(slice.binSize, ranges);
      }
    }
    const authorityResolution = [...completeRangesByResolution.entries()]
      .sort(([a], [b]) => a - b)
      .find(([, ranges]) => rangesCoverViewport(ranges, view))?.[0];
    if (authorityResolution == null) return { resolution: null, key: '[]' };

    const contributors: Array<
      [
        tileKey: string,
        sliceIndex: number,
        start: number,
        end: number,
        binSize: number,
        revision: number,
      ]
    > = [];
    for (const [tileKey, record] of this.exactCoverageTiles) {
      for (let sliceIndex = 0; sliceIndex < record.slices.length; sliceIndex += 1) {
        const slice = record.slices[sliceIndex]!;
        if (slice.binSize !== authorityResolution) continue;
        if (slice.globalEnd <= view.globalStart || slice.globalStart >= view.globalEnd) continue;
        contributors.push([
          tileKey,
          sliceIndex,
          slice.globalStart,
          slice.globalEnd,
          slice.binSize,
          this.coveragePayloadRevision(slice.payload),
        ]);
      }
    }
    return { resolution: authorityResolution, key: JSON.stringify(contributors) };
  }

  private coveragePayloadRevision(payload: ReadyCoverageSlice['payload']): number {
    const objectPayload = payload as object;
    const existing = this.coveragePayloadRevisions.get(objectPayload);
    if (existing != null) return existing;
    const revision = ++this.coveragePayloadRevisionSequence;
    this.coveragePayloadRevisions.set(objectPayload, revision);
    return revision;
  }

  private composeFinestCoveringCoverage(
    view: Viewport,
    coordinatorLevel: number
  ): { signal: CoverageSignal; level: number } | undefined {
    const px = this.lastPresentationViewportPx ?? view.viewportPx;
    const span = Math.max(1, view.globalEnd - view.globalStart);
    const bpPerPx = span / Math.max(1, px);
    const maxLevel = maxLevelForAssembly(this.assembly);
    const displayFloor = Math.floor(Math.log2(Math.max(1, bpPerPx)));
    let floorLevel = Math.max(0, Math.min(maxLevel, Math.min(displayFloor, coordinatorLevel - 1)));
    const forcedCoverageLevel = readForcedCoverageLevelForTestBridge(import.meta.env);
    if (forcedCoverageLevel !== null) {
      floorLevel = Math.max(0, Math.min(maxLevel, forcedCoverageLevel));
    }
    for (let level = floorLevel; level <= maxLevel; level++) {
      const signal = this.composeCoverageSignal(view, level);
      if (signal && coverageSignalCoversViewport(signal, view)) {
        return { signal, level };
      }
    }
    return undefined;
  }

  private shouldUseReadsDerivedCoverage(
    forcedLevel: number | undefined,
    records: ReadonlyArray<PileupRecord> | undefined
  ): boolean {
    return (
      forcedLevel == null &&
      records != null &&
      records.length > 0 &&
      records.length <= READS_DERIVED_MAX_RECORDS
    );
  }

  private shouldUseResidentCoverage(forcedLevel: number | undefined, view: Viewport): boolean {
    return (
      forcedLevel == null &&
      this.residentBaseLayerVerified === true &&
      this.residentBaseLayerState === 'ready' &&
      this.residentPyramid.length > 0 &&
      this.residentCoverageLevelOverlapsViewport(this.residentBaseLayer, view)
    );
  }

  private collectExactCoveragePerLevel(
    view: Viewport,
    exactAuthorityResolution?: number | null
  ): Array<{ level: number; slices: ReadyCoverageSlice[] }> {
    const perLevel: Array<{ level: number; slices: ReadyCoverageSlice[] }> = [];
    for (const level of this.exactCoverageLevels().sort((a, b) => a - b)) {
      const slices = this.exactCoverageSlicesForLevel(view, level).filter(
        (slice) => exactAuthorityResolution == null || slice.binSize === exactAuthorityResolution
      );
      if (slices.length === 0) continue;
      perLevel.push({ level, slices });
    }
    return perLevel;
  }

  private composeResampledCoverage(
    view: Viewport,
    records?: ReadonlyArray<PileupRecord>,
    windowStartBp?: number,
    windowEndBp?: number,
    presentationView: Viewport = view,
    exactAuthorityResolution?: number | null
  ): { signal: CoverageSignal; level: number } | undefined {
    const span = Math.max(1, presentationView.globalEnd - presentationView.globalStart);
    const maxLevel = maxLevelForAssembly(this.assembly);
    const forcedLevel = resolveForcedCoverageLevel(
      readForcedCoverageLevelForTestBridge(import.meta.env),
      maxLevel
    );
    const perLevel = this.collectExactCoveragePerLevel(view, exactAuthorityResolution);
    const useReads = this.shouldUseReadsDerivedCoverage(forcedLevel, records);
    const useResident = this.shouldUseResidentCoverage(forcedLevel, view);
    if (!hasAnyCoverageComposeSource(perLevel.length, useReads, useResident)) return undefined;

    const effectiveMaxOutBins = useReads ? READS_DERIVED_MAX_OUT_BINS : MAX_COVERAGE_OUT_BINS;
    const capBin = Math.ceil(span / effectiveMaxOutBins);
    const supportRanges = [
      ...collectExactSupportRanges(perLevel),
      ...(useResident ? collectResidentSupportRanges(this.residentPyramid) : []),
    ];
    const capLevel = Math.max(0, Math.min(maxLevel, Math.ceil(Math.log2(Math.max(1, capBin)))));
    const outLevel = selectCompleteSupportOutputLevel({
      forcedLevel,
      capLevel,
      maxLevel,
      supportRanges,
      view,
    });
    if (outLevel == null) return undefined;
    const outBin = binBp(outLevel);
    const presentationPx = this.lastPresentationViewportPx ?? presentationView.viewportPx;
    if (coverageOutputBinTooWideForPresentation(forcedLevel, outBin, presentationPx, span)) {
      return undefined;
    }

    const signalStart = Math.floor(view.globalStart / outBin) * outBin;
    const signalEnd = Math.ceil(view.globalEnd / outBin) * outBin;
    const totalBins = Math.max(1, Math.ceil((signalEnd - signalStart) / outBin));
    if (totalBins > MAX_COVERAGE_SIGNAL_BINS) return undefined;

    const bins = new Array<number>(totalBins).fill(0);
    const covered = new Uint8Array(totalBins);
    const useMeanPool = true;
    const chosenResidentLevel = useResident ? this.pickResidentPyramidLevel(outBin, view) : null;
    const usedCoarserThanOutput = false;
    const contributors = rankCoverageContributors(
      collectValidExactSlicesByResolution(perLevel),
      groupResidentLayersByResolution(chosenResidentLevel)
    );

    if (useReads && records) {
      applyReadsDerivedCoverage({
        records,
        signalStart,
        outBin,
        totalBins,
        windowStartBp,
        windowEndBp,
        bins,
        covered,
      });
    }

    applyRankedCoverageContributors({
      contributors,
      outBin,
      signalStart,
      signalEnd,
      totalBins,
      view,
      bins,
      covered,
      useMeanPool,
    });

    if (covered.some((value) => value !== 1)) return undefined;

    return {
      signal: {
        startBp: signalStart,
        bins,
        binSize: outBin,
        maxDepth: maxBinValue(bins),
        depthPercentiles: this.depthPercentiles ?? undefined,
        provenance: {
          exact: !usedCoarserThanOutput,
          method: useReads ? 'resampled-reads-plus-coverage' : 'resolution-ranked-source-merge',
          source: 'tile-engine',
        },
      },
      level: outLevel,
    };
  }

  private finestCoverageLod(level: number, coverage: CoverageSignal): CoverageLodMetadata {
    const provenance = coverage.provenance;
    return {
      role: 'current-lod',
      level,
      targetLevel: level,
      binSize: coverage.binSize,
      authority:
        provenance?.method === 'target-grid-derived-from-finer'
          ? 'target-grid-derived-from-finer'
          : 'native-target',
      ...(provenance
        ? {
            provenanceExact: provenance.exact,
            provenanceMethod: provenance.method,
            ...(provenance.source ? { provenanceSource: provenance.source } : {}),
          }
        : {}),
    };
  }

  private composeCoverageSignal(view: Viewport, level: number): CoverageSignal | undefined {
    const drawBandView = this.coverageDrawBandView(view);
    const bandTiles = this.readyContinuousCoverageComponentForLevel(
      drawBandView,
      drawBandView,
      level
    );
    if (bandTiles) return this.composeCoverageSignalFromSlices(bandTiles);
    const visibleTiles = this.readyContinuousCoverageComponentForLevel(drawBandView, view, level);
    if (!visibleTiles) return undefined;
    return this.composeCoverageSignalFromSlices(visibleTiles);
  }

  private targetGridCoverageCoversViewport(view: Viewport, level: number): boolean {
    const targetBin = binBp(level);
    const currentCoverage = this.composeCoverageSignal(view, level);
    if (
      currentCoverage?.binSize === targetBin &&
      coverageSignalCoversViewport(currentCoverage, view)
    ) {
      return true;
    }
    for (const surface of this.residentCoverageByLevel.get(level) ?? []) {
      if (surface.coverage.binSize !== targetBin) continue;
      if (coverageSignalCoversViewport(surface.coverage, view)) return true;
    }
    return false;
  }

  private composeCurrentCoverageFromFinerResident(
    view: Viewport,
    level: number,
    residentCoverages: ReadonlyArray<{ level: number; coverage: CoverageSignal }>
  ): CoverageSignal | undefined {
    const targetBin = binBp(level);
    const finerResident = this.selectFinerResidentCoverage(residentCoverages, level);
    if (!finerResident) return undefined;
    const drawBandView = this.coverageDrawBandView(view);
    const coverageView = coverageSignalCoversViewport(finerResident.coverage, drawBandView)
      ? drawBandView
      : view;
    const readyTiles = this.readyCoverageSlicesForLevel(coverageView, level).filter(
      (tile) => tile.binSize === targetBin
    );
    return this.composeDerivedFromFinerCoverage(
      coverageView,
      targetBin,
      finerResident.coverage,
      readyTiles,
      {
        exact: true,
        method: 'target-grid-derived-from-finer',
        source: 'tile-engine',
        sourceLevel: finerResident.level,
        sourceBinSize: finerResident.coverage.binSize,
      }
    );
  }

  private selectFinerResidentCoverage(
    residentCoverages: ReadonlyArray<{ level: number; coverage: CoverageSignal }>,
    targetLevel: number
  ): { level: number; coverage: CoverageSignal } | undefined {
    const targetBin = binBp(targetLevel);
    return [...residentCoverages]
      .filter(
        (candidate) =>
          candidate.level < targetLevel &&
          candidate.coverage.binSize > 0 &&
          candidate.coverage.binSize < targetBin
      )
      .sort(
        (a, b) =>
          residentBinDistance(a.coverage.binSize, targetBin) -
            residentBinDistance(b.coverage.binSize, targetBin) ||
          b.coverage.binSize - a.coverage.binSize ||
          coverageSpan(b.coverage) - coverageSpan(a.coverage)
      )[0];
  }

  private readyCoverageSlicesForLevel(view: Viewport, level: number): ReadyCoverageSlice[] {
    return this.exactCoverageSlicesForLevel(view, level);
  }

  private readyContinuousCoverageBandForLevel(
    requiredView: Viewport,
    level: number
  ): ReadyCoverageSlice[] | undefined {
    return this.readyContinuousCoverageComponentForLevel(requiredView, requiredView, level);
  }

  private readyContinuousCoverageComponentForLevel(
    searchView: Viewport,
    requiredView: Viewport,
    level: number
  ): ReadyCoverageSlice[] | undefined {
    const slices = this.readyCoverageSlicesForLevel(searchView, level);
    if (slices.length === 0) return undefined;
    const candidates = coverageSliceComponents(slices)
      .filter(
        (component) =>
          component.globalStart <= requiredView.globalStart + 1 &&
          component.globalEnd >= requiredView.globalEnd - 1
      )
      .sort(
        (a, b) =>
          b.globalEnd - b.globalStart - (a.globalEnd - a.globalStart) ||
          a.globalStart - b.globalStart
      );
    return candidates[0]?.slices;
  }

  private coverageDrawBandView(view: Viewport): Viewport {
    const span = Math.max(1, view.globalEnd - view.globalStart);
    const marginBp = span * COVERAGE_DRAW_BAND_VIEWPORTS;
    return {
      globalStart: Math.max(0, view.globalStart - marginBp),
      globalEnd: Math.min(this.assembly.totalLengthBp, view.globalEnd + marginBp),
      viewportPx: view.viewportPx,
    };
  }

  private composeCoverageSignalFromSlices(
    readyTiles: ReadyCoverageSlice[]
  ): CoverageSignal | undefined {
    let firstStart = Number.POSITIVE_INFINITY;
    let lastEnd = 0;
    for (const tile of readyTiles) {
      if (tile.globalStart < firstStart) firstStart = tile.globalStart;
      if (tile.globalEnd > lastEnd) lastEnd = tile.globalEnd;
    }
    const finestPayloadBin = Math.min(...readyTiles.map((t) => t.binSize).filter((v) => v > 0));
    if (!(finestPayloadBin > 0)) return undefined;

    const signalBin = finestPayloadBin;
    const methods = new Set(
      readyTiles
        .map((t) => t.payload.provenance?.method)
        .filter((method): method is string => typeof method === 'string' && method.length > 0)
    );
    const signalStart = Math.floor(firstStart / signalBin) * signalBin;
    const signalEnd = Math.ceil(lastEnd / signalBin) * signalBin;
    const totalBins = Math.max(1, Math.ceil((signalEnd - signalStart) / signalBin));
    if (totalBins > MAX_COVERAGE_SIGNAL_BINS) return undefined;
    const bins = new Array<number>(totalBins).fill(0);
    const maxDepth = overlayCoverageSlices(readyTiles, signalStart, signalBin, bins);
    return {
      startBp: signalStart,
      bins,
      binSize: signalBin,
      maxDepth,
      depthPercentiles: this.depthPercentiles ?? undefined,
      provenance: {
        exact: true,
        method: methods.size === 1 ? [...methods][0] : 'mixed-exact-coverage',
        source: 'tile-engine',
      },
    };
  }

  private composeDerivedFromFinerCoverage(
    view: Viewport,
    signalBin: number,
    finerResident: CoverageSignal,
    readyTiles: ReadyCoverageSlice[],
    provenance: NonNullable<CoverageSignal['provenance']>
  ): CoverageSignal | undefined {
    if (!(finerResident.binSize > 0) || finerResident.binSize >= signalBin) return undefined;

    const signalStart = Math.floor(view.globalStart / signalBin) * signalBin;
    const signalEnd = Math.ceil(view.globalEnd / signalBin) * signalBin;
    const totalBins = Math.max(1, Math.ceil((signalEnd - signalStart) / signalBin));
    const bins = new Array<number>(totalBins).fill(0);
    let maxDepth = 0;

    for (let i = 0; i < bins.length; i++) {
      const binStart = signalStart + i * signalBin;
      const binEnd = binStart + signalBin;
      const value = maxCoverageValue(finerResident, binStart, binEnd);
      bins[i] = value;
      if (value > maxDepth) maxDepth = value;
    }
    if (readyTiles.length > 0) {
      overwriteCoverageSlices(readyTiles, signalStart, signalBin, bins);
      maxDepth = maxBinValue(bins);
    }

    return {
      startBp: signalStart,
      bins,
      binSize: signalBin,
      maxDepth,
      provenance,
    };
  }

  private collectResidentCoverageCandidates(
    view: Viewport,
    targetLevel: number
  ): Array<{ level: number; coverage: CoverageSignal }> {
    const candidates: Array<{ level: number; coverage: CoverageSignal }> = [];

    for (const [level, surfaces] of this.residentCoverageByLevel.entries()) {
      for (const surface of surfaces) {
        if (!coverageSignalCoversViewport(surface.coverage, view)) continue;
        candidates.push({ level, coverage: surface.coverage });
      }
    }

    for (const level of this.exactCoverageLevels()) {
      if (level === targetLevel) continue;
      const coverage = this.composeCoverageSignal(view, level);
      if (!coverage || !coverageSignalCoversViewport(coverage, view)) continue;
      this.rememberResidentCoverage(level, coverage);
      candidates.push({ level, coverage });
    }

    return candidates;
  }

  private rememberResidentCoverage(level: number, coverage: CoverageSignal): void {
    if (!coverageSignalCoversViewport(coverage, this.lastViewport)) return;
    const nextRange = coverageRange(coverage);
    const existing = this.residentCoverageByLevel.get(level) ?? [];
    for (const surface of existing) {
      const residentRange = coverageRange(surface.coverage);
      if (!rangeContains(residentRange, nextRange)) continue;
      if (rangeContains(nextRange, residentRange)) {
        surface.coverage = coverage;
        surface.order = ++this.residentCoverageOrder;
      }
      return;
    }

    const next = existing.filter(
      (surface) => !rangeContains(nextRange, coverageRange(surface.coverage))
    );
    next.push({ coverage, order: ++this.residentCoverageOrder });
    next.sort(
      (a, b) =>
        coverageSpan(b.coverage) - coverageSpan(a.coverage) ||
        b.order - a.order ||
        a.coverage.binSize - b.coverage.binSize
    );
    this.residentCoverageByLevel.set(level, next.slice(0, RESIDENT_COVERAGE_SURFACES_PER_LEVEL));
  }

  private rememberExactCoverageTile(key: TileKey): void {
    if (!isCoverageSourceId(key.sourceId)) return;
    const entry = this.cache.peek(key);
    if (entry?.state !== 'ready' || !entry.data) return;
    const dp = (
      entry.data.payload as
        | { depthPercentiles?: NonNullable<CoverageSignal['depthPercentiles']> }
        | undefined
    )?.depthPercentiles;
    if (dp && typeof dp.p99 === 'number' && typeof dp.max === 'number' && dp.max > 0) {
      const previous = this.depthPercentiles;
      const changed =
        previous == null ||
        previous.p50 !== dp.p50 ||
        previous.p90 !== dp.p90 ||
        previous.p95 !== dp.p95 ||
        previous.p99 !== dp.p99 ||
        previous.max !== dp.max;
      if (changed) {
        this.depthPercentiles = dp;
        this.depthScaleGeneration += 1;
      }
    }
    const slices = coverageSlicesForEntry(entry, this.chromSources);
    if (slices.length === 0) return;
    this.exactCoverageTiles.set(tileKeyString(key), {
      key: { ...key },
      slices,
      order: ++this.exactCoverageOrder,
    });
    this.exactCoverageGeneration += 1;
    this.pruneExactCoverageTiles();
  }

  private exactCoverageSlicesForLevel(view: Viewport, level: number): ReadyCoverageSlice[] {
    const slices: ReadyCoverageSlice[] = [];
    for (const record of this.exactCoverageTiles.values()) {
      if (record.key.level !== level) continue;
      let touched = false;
      for (const slice of record.slices) {
        if (slice.globalEnd <= view.globalStart || slice.globalStart >= view.globalEnd) continue;
        slices.push(slice);
        touched = true;
      }
      if (touched) record.order = ++this.exactCoverageOrder;
    }
    return slices;
  }

  private exactCoverageLevels(): number[] {
    return [
      ...new Set([...this.exactCoverageTiles.values()].map((record) => record.key.level)),
    ].sort((a, b) => a - b);
  }

  private pruneExactCoverageTiles(): void {
    const removeCount = this.exactCoverageTiles.size - EXACT_COVERAGE_TILE_STORE_MAX;
    if (removeCount <= 0) return;
    const entries = [...this.exactCoverageTiles.entries()].sort((a, b) => a[1].order - b[1].order);
    for (const [key] of entries.slice(0, removeCount)) this.exactCoverageTiles.delete(key);
    this.exactCoverageGeneration += 1;
  }

  private pickResidentPyramidLevel(
    outBin: number,
    view: Viewport
  ): Map<string, ResidentCoverageLayer> | null {
    if (this.residentPyramid.length === 0) return null;
    let chosen: Map<string, ResidentCoverageLayer> | null = null;
    for (const level of this.residentPyramid) {
      const layers = [...level.values()];
      const anyBin = layers[0]?.binSize ?? Number.POSITIVE_INFINITY;
      if (anyBin > outBin) break;
      if (this.residentCoverageLevelOverlapsViewport(level, view)) chosen = level;
    }
    return chosen;
  }

  private residentCoverageLevelOverlapsViewport(
    level: ReadonlyMap<string, ResidentCoverageLayer>,
    view: Viewport
  ): boolean {
    return [...level.values()].some((layer) => {
      const globalEnd = Math.min(
        layer.globalEnd ?? Number.POSITIVE_INFINITY,
        layer.globalStart + layer.bins.length * layer.binSize
      );
      return globalEnd > view.globalStart && layer.globalStart < view.globalEnd;
    });
  }

  private hasPendingCoverageForCoverageBand(view: Viewport, level: number): boolean {
    return this.hasPendingCoverageForViewport(this.coverageDrawBandView(view), level);
  }

  private hasErrorCoverageForCoverageBand(view: Viewport, level: number): boolean {
    return this.hasErrorCoverageForViewport(this.coverageDrawBandView(view), level);
  }

  private hasPendingCoverageForViewport(view: Viewport, level: number): boolean {
    for (const entry of this.cache.entries()) {
      if (entry.state !== 'pending') continue;
      if (entry.key.level !== level) continue;
      if (!isCoverageSourceId(entry.key.sourceId)) continue;
      const tileStart = tileGlobalStart(entry.key.index, level);
      const tileEnd = tileGlobalEnd(entry.key.index, level);
      if (tileEnd > view.globalStart && tileStart < view.globalEnd) return true;
    }
    return false;
  }

  private hasErrorCoverageForViewport(view: Viewport, level: number): boolean {
    for (const entry of this.cache.entries()) {
      if (entry.state !== 'error') continue;
      if (entry.key.level !== level) continue;
      if (!isCoverageSourceId(entry.key.sourceId)) continue;
      const tileStart = tileGlobalStart(entry.key.index, level);
      const tileEnd = tileGlobalEnd(entry.key.index, level);
      if (tileEnd > view.globalStart && tileStart < view.globalEnd) return true;
    }
    return false;
  }

  private referenceIntervalsForView(
    view: Viewport,
    level: number
  ): NonNullable<TileEngineFeed['referenceIntervals']> {
    const span = tileSpanBp(level);
    if (!(span > 0) || !(view.globalEnd > view.globalStart)) return [];
    const slices: Array<{ start: number; end: number; state: 'pending' | 'empty' | 'data' }> = [];
    for (const segment of globalRangeToSegments(this.assembly, view.globalStart, view.globalEnd)) {
      const source = this.chromSources.get(segment.chrom)?.alignment;
      const firstTile = Math.max(0, Math.floor((segment.globalStart + segment.localStart) / span));
      const lastTile = Math.ceil((segment.globalStart + segment.localEnd) / span);
      for (let index = firstTile; index < lastTile; index += 1) {
        const tileStart = Math.max(index * span, segment.placement.globalStartBp);
        const tileEnd = Math.min((index + 1) * span, segment.placement.globalEndBp);
        const entry = source ? this.cache.peek({ sourceId: source.id, level, index }) : undefined;
        const state =
          entry?.state === 'ready' ? ((entry.data?.count ?? 0) > 0 ? 'data' : 'empty') : 'pending';
        slices.push({ start: tileStart, end: tileEnd, state });
      }
    }
    const merged: typeof slices = [];
    for (const slice of slices) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.state === slice.state &&
        previous.state !== 'pending' &&
        previous.end >= slice.start
      ) {
        previous.end = Math.max(previous.end, slice.end);
      } else {
        merged.push({ ...slice });
      }
    }
    return merged.flatMap((slice) =>
      slice.state === 'data'
        ? []
        : [
            {
              startBp: slice.start,
              endBp: slice.end,
              state: slice.state,
            },
          ]
    );
  }

  private emptyComposeReadsResult(
    level: number,
    expectedBandTileCount = 0
  ): {
    records: PileupRecord[];
    alternateColumns: PileupAlternateColumn[];
    truncated: boolean;
    revisionKey: string;
    coversViewport: boolean;
    stableBandReady: boolean;
    readyBandTileCount: number;
    expectedBandTileCount: number;
  } {
    return {
      records: [],
      alternateColumns: [],
      truncated: false,
      revisionKey: `none:L${level}`,
      coversViewport: false,
      stableBandReady: false,
      readyBandTileCount: 0,
      expectedBandTileCount,
    };
  }

  private computeReadCompositionBand(
    view: Viewport,
    level: number
  ): {
    alignmentTileSpanBp: number;
    compositionStartBp: number;
    compositionEndBp: number;
    expectedBandTileKeys: Set<string>;
    expectedBandTileCount: number;
  } {
    const alignmentTileSpanBp = tileSpanBp(level);
    const firstVisibleTile = Math.floor(view.globalStart / alignmentTileSpanBp);
    const lastVisibleTileExclusive = Math.ceil(view.globalEnd / alignmentTileSpanBp);
    const visibleTileCount = Math.max(1, lastVisibleTileExclusive - firstVisibleTile);
    const boundedNetwork = this.boundedReadBand;
    const boundedNetworkMarginTiles = Math.max(
      0,
      Math.floor(
        this.sources.find((source) => source.id.startsWith('aln:'))?.prefetch
          ?.sameLevelMarginTiles ?? 0
      )
    );
    const haloTiles = boundedNetwork ? boundedNetworkMarginTiles : READ_COMPOSITION_MIN_HALO_TILES;
    const bandTileCount = Math.max(
      boundedNetwork ? 1 : READ_COMPOSITION_BAND_MIN_TILES,
      visibleTileCount + haloTiles * 2
    );
    const centerTile = Math.floor(
      ((view.globalStart + view.globalEnd) * 0.5) / alignmentTileSpanBp
    );
    const totalTileCount = Math.ceil(this.assembly.totalLengthBp / alignmentTileSpanBp);
    let firstBandTile: number;
    let lastBandTileExclusive: number;
    if (boundedNetwork) {
      firstBandTile = Math.max(0, firstVisibleTile - haloTiles);
      lastBandTileExclusive = Math.min(totalTileCount, lastVisibleTileExclusive + haloTiles);
    } else {
      firstBandTile =
        Math.floor(centerTile / READ_COMPOSITION_BAND_STRIDE_TILES) *
          READ_COMPOSITION_BAND_STRIDE_TILES -
        Math.floor((bandTileCount - READ_COMPOSITION_BAND_STRIDE_TILES) / 2);
      firstBandTile = Math.max(
        0,
        Math.min(firstBandTile, Math.max(0, totalTileCount - bandTileCount))
      );
      if (firstVisibleTile < firstBandTile) firstBandTile = firstVisibleTile;
      if (lastVisibleTileExclusive > firstBandTile + bandTileCount) {
        firstBandTile = lastVisibleTileExclusive - bandTileCount;
      }
      lastBandTileExclusive = Math.min(totalTileCount, firstBandTile + bandTileCount);
    }
    const compositionStartBp = firstBandTile * alignmentTileSpanBp;
    const compositionEndBp = Math.min(
      this.assembly.totalLengthBp,
      lastBandTileExclusive * alignmentTileSpanBp
    );
    const expectedBandTileKeys = new Set<string>();
    for (const placement of this.assembly.chromosomes) {
      if (placement.globalEndBp <= view.globalStart || placement.globalStartBp >= view.globalEnd) {
        continue;
      }
      const placementStart = Math.max(compositionStartBp, placement.globalStartBp);
      const placementEnd = Math.min(compositionEndBp, placement.globalEndBp);
      const firstTile = Math.floor(placementStart / alignmentTileSpanBp);
      const lastTileExclusive = Math.ceil(placementEnd / alignmentTileSpanBp);
      const sourceId =
        this.chromSources.get(placement.chromosome.id)?.alignment.id ??
        `aln:${this.opts.source.bamPath}:${placement.chromosome.id}`;
      for (let index = firstTile; index < lastTileExclusive; index += 1) {
        expectedBandTileKeys.add(tileKeyString({ sourceId, level, index }));
      }
    }
    return {
      alignmentTileSpanBp,
      compositionStartBp,
      compositionEndBp,
      expectedBandTileKeys,
      expectedBandTileCount: Math.max(1, expectedBandTileKeys.size),
    };
  }

  private collectReadyReadTilesFromCache(args: {
    viewLevel: number;
    guidesOnly: boolean;
    compositionStartBp: number;
    compositionEndBp: number;
    expectedBandTileKeys: Set<string>;
  }): {
    tiles: SelectedReadTile[];
    readyBandTileKeys: Set<string>;
    windowStartBp: number | undefined;
    windowEndBp: number | undefined;
  } {
    const tiles: SelectedReadTile[] = [];
    const readyBandTileKeys = new Set<string>();
    let windowStartBp: number | undefined;
    let windowEndBp: number | undefined;
    for (const entry of this.cache.entries()) {
      if (entry.state !== 'ready' || !entry.data) continue;
      if (entry.key.level !== args.viewLevel) continue;
      const sourceId = entry.key.sourceId;
      if (!sourceId.startsWith('aln:')) continue;
      const payload = entry.data.payload as AlignmentTilePayload | undefined;
      if (!payload) continue;
      const reads = Array.isArray(payload.reads) ? payload.reads : [];
      const alternateRows = Array.isArray(payload.alternateColumns) ? payload.alternateColumns : [];
      const chrom = chromFromSourceId(sourceId);
      const chromSrc = chrom ? this.chromSources.get(chrom) : undefined;
      if (!chromSrc) continue;
      const gStart = Math.max(
        tileGlobalStart(entry.key.index, args.viewLevel),
        chromSrc.globalStartBp
      );
      const gEnd = Math.min(tileGlobalEnd(entry.key.index, args.viewLevel), chromSrc.globalEndBp);
      if (gEnd <= gStart || gEnd <= args.compositionStartBp || gStart >= args.compositionEndBp)
        continue;
      const tileIdentity = tileKeyString(entry.key);
      if (args.expectedBandTileKeys.has(tileIdentity)) readyBandTileKeys.add(tileIdentity);
      const payloadRevision = this.alignmentPayloadRevision(payload);
      const tileRecordsKey = `${sourceId}:${entry.key.level}:${entry.key.index}:g${payloadRevision}`;
      windowStartBp = windowStartBp == null ? gStart : Math.min(windowStartBp, gStart);
      windowEndBp = windowEndBp == null ? gEnd : Math.max(windowEndBp, gEnd);
      const projection = this.projectReadTile(
        payload,
        reads,
        alternateRows,
        chromSrc,
        !args.guidesOnly
      );
      tiles.push({
        cacheKey: tileRecordsKey,
        sourceId,
        tileStartBp: gStart,
        tileEndBp: gEnd,
        truncated: payload.truncated === true,
        records: args.guidesOnly ? [] : projection.records,
        alternateColumns: projection.alternateColumns,
      });
    }
    return { tiles, readyBandTileKeys, windowStartBp, windowEndBp };
  }

  private selectCoveringResidentReadComposition(
    view: Viewport,
    level: number,
    targetBandSpanBp: number
  ): ReadCompositionCacheEntry | null {
    let coveringResident: ReadCompositionCacheEntry | null = null;
    for (const resident of this.readCompositionCache.values()) {
      if (resident.level !== level) continue;
      if (
        resident.windowStartBp == null ||
        resident.windowEndBp == null ||
        resident.windowStartBp > view.globalStart ||
        resident.windowEndBp < view.globalEnd ||
        !rangesCoverViewport(resident.supportRanges, view)
      ) {
        continue;
      }
      const residentSpanBp = resident.windowEndBp - resident.windowStartBp;
      if (residentSpanBp > targetBandSpanBp) continue;
      if (
        coveringResident === null ||
        residentSpanBp > (coveringResident.windowEndBp ?? 0) - (coveringResident.windowStartBp ?? 0)
      ) {
        coveringResident = resident;
      }
    }
    return coveringResident;
  }

  private composeReads(
    view: Viewport,
    level: number
  ): {
    records: PileupRecord[];
    alternateColumns: PileupAlternateColumn[];
    windowStartBp?: number;
    windowEndBp?: number;
    truncated: boolean;
    revisionKey: string;
    coversViewport: boolean;
    stableBandReady: boolean;
    readyBandTileCount: number;
    expectedBandTileCount: number;
  } {
    if (level > this.maxAlternateGuide) {
      return this.emptyComposeReadsResult(level);
    }
    const guidesOnly = level > this.maxReadAlignment || !this.exactReadPreparationIsEligible(view);
    const { compositionStartBp, compositionEndBp, expectedBandTileKeys, expectedBandTileCount } =
      this.computeReadCompositionBand(view, level);
    const collected = this.collectReadyReadTilesFromCache({
      viewLevel: level,
      guidesOnly,
      compositionStartBp,
      compositionEndBp,
      expectedBandTileKeys,
    });
    let tiles = collected.tiles;
    const readyBandTileKeys = collected.readyBandTileKeys;
    let windowStartBp = collected.windowStartBp;
    let windowEndBp = collected.windowEndBp;
    if (tiles.length === 0) {
      return this.emptyComposeReadsResult(level, expectedBandTileCount);
    }

    tiles.sort(
      (a, b) =>
        a.tileStartBp - b.tileStartBp ||
        a.tileEndBp - b.tileEndBp ||
        a.sourceId.localeCompare(b.sourceId) ||
        a.cacheKey.localeCompare(b.cacheKey)
    );
    const viewportComponent = contiguousReadTilesCoveringViewport(tiles, view);
    if (viewportComponent.length > 0) {
      tiles = viewportComponent;
      windowStartBp = tiles[0]!.tileStartBp;
      windowEndBp = tiles.reduce((end, tile) => Math.max(end, tile.tileEndBp), tiles[0]!.tileEndBp);
    }
    const fullBandReady = [...expectedBandTileKeys].every((tileIdentity) =>
      readyBandTileKeys.has(tileIdentity)
    );
    if (!guidesOnly && !fullBandReady) {
      const coveringResident = this.selectCoveringResidentReadComposition(
        view,
        level,
        compositionEndBp - compositionStartBp
      );
      if (coveringResident) {
        coveringResident.order = ++this.readCompositionOrder;
        return {
          ...coveringResident,
          coversViewport: true,
          stableBandReady: false,
          readyBandTileCount: readyBandTileKeys.size,
          expectedBandTileCount,
        };
      }
    }
    const supportRanges = tiles.map((tile) => ({
      globalStart: tile.tileStartBp,
      globalEnd: tile.tileEndBp,
    }));
    const coversViewport = rangesCoverViewport(supportRanges, view);
    const cacheKey = tiles.map((tile) => tile.cacheKey).join('|');
    const cached = this.readCompositionCache.get(cacheKey);
    if (cached) {
      cached.order = ++this.readCompositionOrder;
      return {
        ...cached,
        coversViewport,
        stableBandReady: fullBandReady,
        readyBandTileCount: readyBandTileKeys.size,
        expectedBandTileCount,
      };
    }

    const records: PileupRecord[] = [];
    const alternateColumns: PileupAlternateColumn[] = [];
    let truncated = false;
    let previous: SelectedReadTile | null = null;
    for (const tile of tiles) {
      appendOwnedReadRecords(records, tile, previous);
      alternateColumns.push(...tile.alternateColumns);
      truncated ||= tile.truncated;
      previous = tile;
    }
    const composed = {
      level,
      records: subsampleUniform(records, READS_DISPLAY_MAX_RECORDS),
      alternateColumns,
      supportRanges,
      windowStartBp,
      windowEndBp,
      truncated: truncated || records.length > READS_DISPLAY_MAX_RECORDS,
      revisionKey: cacheKey,
      order: ++this.readCompositionOrder,
    };
    this.readCompositionCache.set(cacheKey, composed);
    this.pruneReadCompositionCache();
    return {
      ...composed,
      coversViewport,
      stableBandReady: fullBandReady,
      readyBandTileCount: readyBandTileKeys.size,
      expectedBandTileCount,
    };
  }

  private alignmentPayloadRevision(payload: AlignmentTilePayload): number {
    const objectPayload = payload as object;
    const existing = this.alignmentPayloadRevisions.get(objectPayload);
    if (existing !== undefined) return existing;
    const revision = ++this.alignmentPayloadRevisionSequence;
    this.alignmentPayloadRevisions.set(objectPayload, revision);
    return revision;
  }

  private projectReadTile(
    payload: AlignmentTilePayload,
    reads: NonNullable<AlignmentTilePayload['reads']>,
    alternateRows: NonNullable<AlignmentTilePayload['alternateColumns']>,
    chromSrc: ChromSources,
    includeExactReads = true
  ): ReadTileRecordsCacheEntry {
    const cached = this.readTileProjectionByPayload.get(payload);
    if (cached && (!includeExactReads || cached.exactRecordsMaterialized)) {
      this.readTileProjectionReuseCount += 1;
      return cached;
    }

    const records = includeExactReads
      ? subsampleUniform(reads, READ_TILE_MAX_RECORDS).flatMap((row) =>
          projectAlignmentReadRows(row, chromSrc)
        )
      : [];
    const entry = {
      records,
      alternateColumns:
        cached?.alternateColumns ??
        alternateRows.map((row) => projectAlignmentAlternateColumn(row, chromSrc)),
      exactRecordsMaterialized: includeExactReads,
    };
    this.readTileProjectionByPayload.set(payload, entry);
    this.readTileProjectionMaterializeCount += 1;
    return entry;
  }

  private pruneReadCompositionCache(): void {
    const removeCount = this.readCompositionCache.size - READ_COMPOSITION_CACHE_ENTRIES;
    if (removeCount <= 0) return;
    const entries = Array.from(this.readCompositionCache.entries()).sort(
      (a, b) => a[1].order - b[1].order
    );
    for (const [key] of entries.slice(0, removeCount)) this.readCompositionCache.delete(key);
  }

  debugSnapshot(viewOverride?: DebugViewportRange): {
    level: number | null;
    inFlight: number;
    transportQueue: TileTransportQueueSnapshot;
    sourceIds: string[];
    aln: { ready: number; pending: number; error: number; readyLevels: number[]; reads: number };
    cov: {
      ready: number;
      pending: number;
      error: number;
      readyLevels: number[];
      pendingLevels: number[];
      errorLevels: number[];
      readyBinsByLevel: Array<{ level: number; minBinSize: number; maxBinSize: number }>;
    };
    cache: {
      entries: number;
      byteSize: number;
      maxBytes: number;
      pinned: number;
      pinnedAlignment: number;
      pinnedCoverage: number;
      retained: number;
      retainedAlignment: number;
      retainedCoverage: number;
      errors: Array<{
        sourceIndex: number | null;
        level: number;
        index: number;
        epoch: number;
        reason: string | null;
        errorDataPresent: boolean;
        retryable: boolean | null;
        requiredByCurrentPlan: boolean;
      }>;
    };
    coverageMemo: {
      producerEpoch: string;
      planCount: number;
      materializeCount: number;
      hitCount: number;
      revisionChangeCount: number;
      exactCoverageGeneration: number;
      residentCoverageGeneration: number;
      depthScaleGeneration: number;
      lastRevision: string | null;
      exactCoverageRecordScanCount: number;
    };
    readProjection: {
      materializeCount: number;
      reuseCount: number;
      compositionCacheEntries: number;
    };
    coverageCorridorFloor: {
      state: 'idle' | 'loading' | 'ready' | 'error';
      failureReason: string | null;
      layerCount: number;
      atlasAuthorityKey: string | null;
    };
    residentCoverage: Array<{ level: number; binSize: number; startBp: number; endBp: number }>;
    coverageComposition: CoverageCompositionStatus | null;
    readComposition: ReadCompositionStatus | null;
  } {
    const level = this.coordinator.level;
    const sourceIds = this.sources.map((s) => s.id);
    const aln = { ready: 0, pending: 0, error: 0, readyLevels: [] as number[], reads: 0 };
    const cov = {
      ready: 0,
      pending: 0,
      error: 0,
      readyLevels: [] as number[],
      pendingLevels: [] as number[],
      errorLevels: [] as number[],
      readyBinsByLevel: [] as Array<{ level: number; minBinSize: number; maxBinSize: number }>,
    };
    const covBinsByLevel = new Map<number, number[]>();
    const cache = {
      entries: this.cache.size,
      byteSize: this.cache.byteSize,
      maxBytes: this.cache.maxBytes,
      pinned: 0,
      pinnedAlignment: 0,
      pinnedCoverage: 0,
      retained: 0,
      retainedAlignment: 0,
      retainedCoverage: 0,
      errors: [] as Array<{
        sourceIndex: number | null;
        level: number;
        index: number;
        epoch: number;
        reason: string | null;
        errorDataPresent: boolean;
        retryable: boolean | null;
        requiredByCurrentPlan: boolean;
      }>,
    };
    for (const e of this.cache.entries()) {
      const isAln = e.key.sourceId.startsWith('aln:');
      const isCov = isCoverageSourceId(e.key.sourceId);
      if (!isAln && !isCov) continue;
      if (this.cache.isPinned(e.key)) {
        cache.pinned += 1;
        if (isAln) cache.pinnedAlignment += 1;
        else cache.pinnedCoverage += 1;
      }
      if (this.cache.isRetained(e.key)) {
        cache.retained += 1;
        if (isAln) cache.retainedAlignment += 1;
        else cache.retainedCoverage += 1;
      }
      if (e.state === 'ready') {
        if (isAln) {
          aln.ready += 1;
        } else {
          cov.ready += 1;
          cov.readyLevels.push(e.key.level);
          for (const slice of coverageSlicesForEntry(e, this.chromSources)) {
            const bins = covBinsByLevel.get(e.key.level) ?? [];
            bins.push(slice.binSize);
            covBinsByLevel.set(e.key.level, bins);
          }
        }
        if (isAln) {
          aln.readyLevels.push(e.key.level);
          const reads = (e.data?.payload as { reads?: unknown[] })?.reads;
          if (Array.isArray(reads)) aln.reads += reads.length;
        }
      } else if (e.state === 'pending') {
        if (isAln) {
          aln.pending += 1;
        } else {
          cov.pending += 1;
          cov.pendingLevels.push(e.key.level);
        }
      } else if (e.state === 'error') {
        if (isAln) {
          aln.error += 1;
        } else {
          cov.error += 1;
          cov.errorLevels.push(e.key.level);
        }
        if (cache.errors.length < 16) {
          const sourceIndex = sourceIds.indexOf(e.key.sourceId);
          const reason = e.data?.errorReason ?? null;
          cache.errors.push({
            sourceIndex: sourceIndex < 0 ? null : sourceIndex,
            level: e.key.level,
            index: e.key.index,
            epoch: e.epoch,
            reason:
              reason
                ?.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, '[source-url]')
                .replace(/\b(?:Bearer|Basic)\s+\S+/giu, '[authentication]')
                .slice(0, 256) ?? null,
            errorDataPresent: e.data != null,
            retryable: e.data?.errorRetryable ?? null,
            requiredByCurrentPlan: this.tileOwnsCurrentRecoveryPlan(e.key),
          });
        }
      }
    }
    aln.readyLevels = [...new Set(aln.readyLevels)].sort((a, b) => a - b);
    cov.readyLevels = [...new Set(cov.readyLevels)].sort((a, b) => a - b);
    cov.pendingLevels = [...new Set(cov.pendingLevels)].sort((a, b) => a - b);
    cov.errorLevels = [...new Set(cov.errorLevels)].sort((a, b) => a - b);
    cov.readyBinsByLevel = [...covBinsByLevel.entries()]
      .map(([readyLevel, bins]) => ({
        level: readyLevel,
        minBinSize: Math.min(...bins),
        maxBinSize: Math.max(...bins),
      }))
      .sort((a, b) => a.level - b.level);
    const residentCoverage = [...this.residentCoverageByLevel.entries()]
      .flatMap(([residentLevel, surfaces]) =>
        surfaces.map((surface) => {
          const range = coverageRange(surface.coverage);
          return {
            level: residentLevel,
            binSize: surface.coverage.binSize,
            startBp: range.start,
            endBp: range.end,
          };
        })
      )
      .sort((a, b) => a.level - b.level);
    const compositionView =
      viewOverride && this.lastViewport
        ? {
            globalStart: Math.min(viewOverride.start, viewOverride.end),
            globalEnd: Math.max(viewOverride.start, viewOverride.end),
            viewportPx: viewOverride.viewportPx ?? this.lastViewport.viewportPx,
          }
        : this.lastViewport;
    return {
      level,
      inFlight: this.coordinator.inFlight,
      transportQueue: this.transport.debugSnapshot(),
      sourceIds,
      aln,
      cov,
      cache,
      coverageMemo: {
        producerEpoch: this.coverageProducerEpoch,
        planCount: this.coveragePlanCount,
        materializeCount: this.coverageMaterializeCount,
        hitCount: this.coverageMemoHitCount,
        revisionChangeCount: this.coverageRevisionChangeCount,
        exactCoverageGeneration: this.exactCoverageGeneration,
        residentCoverageGeneration: this.residentCoverageGeneration,
        depthScaleGeneration: this.depthScaleGeneration,
        lastRevision: this.lastCoverageMemo?.signal.coverageRevision ?? null,
        exactCoverageRecordScanCount: this.exactCoverageRecordScanCount,
      },
      readProjection: {
        materializeCount: this.readTileProjectionMaterializeCount,
        reuseCount: this.readTileProjectionReuseCount,
        compositionCacheEntries: this.readCompositionCache.size,
      },
      coverageCorridorFloor: {
        state: this.corridorFloorState,
        failureReason: this.corridorFloorFailureReason,
        layerCount: this.verifiedCorridorFloor?.layers.size ?? 0,
        atlasAuthorityKey: this.verifiedCorridorFloorGpuAtlas?.authorityKey ?? null,
      },
      residentCoverage,
      coverageComposition:
        level == null || compositionView == null
          ? null
          : this.describeCoverageComposition(compositionView, level),
      readComposition:
        level == null || compositionView == null
          ? null
          : this.describeReadComposition(
              compositionView,
              this.readLevelForView(compositionView, level)
            ),
    };
  }

  private describeReadComposition(view: Viewport, level: number): ReadCompositionStatus {
    const visibleTiles: ReadCompositionStatus['visibleTiles'] = [];
    const readyRanges: Array<{ globalStart: number; globalEnd: number }> = [];
    const readRanges: Array<{ globalStart: number; globalEnd: number }> = [];
    const readyLevels: number[] = [];
    const pendingLevels: number[] = [];
    const errorLevels: number[] = [];
    let readyTileCount = 0;
    let pendingTileCount = 0;
    let errorTileCount = 0;
    let readyWithReadsTileCount = 0;
    let readyEmptyTileCount = 0;
    let payloadReadCount = 0;
    let payloadAlternateColumnCount = 0;

    for (const entry of this.cache.entries()) {
      if (!entry.key.sourceId.startsWith('aln:')) continue;
      if (entry.key.level !== level) {
        if (entry.state === 'ready') readyLevels.push(entry.key.level);
        else if (entry.state === 'pending') pendingLevels.push(entry.key.level);
        else if (entry.state === 'error') errorLevels.push(entry.key.level);
        continue;
      }
      const chrom = chromFromSourceId(entry.key.sourceId);
      const chromSource = chrom ? this.chromSources.get(chrom) : undefined;
      if (!chromSource) continue;
      const globalStart = Math.max(
        tileGlobalStart(entry.key.index, level),
        chromSource.globalStartBp
      );
      const globalEnd = Math.min(tileGlobalEnd(entry.key.index, level), chromSource.globalEndBp);
      if (globalEnd <= globalStart) continue;
      if (globalEnd <= view.globalStart || globalStart >= view.globalEnd) continue;
      const payload = entry.data?.payload as AlignmentTilePayload | undefined;
      const reads = payload?.reads;
      const readCount = Array.isArray(reads) ? reads.length : null;
      const alternateColumnCount = Array.isArray(payload?.alternateColumns)
        ? payload.alternateColumns.length
        : null;
      const payloadCount = typeof payload?.count === 'number' ? payload.count : null;
      visibleTiles.push({
        level: entry.key.level,
        index: entry.key.index,
        sourceId: entry.key.sourceId,
        chrom,
        state: entry.state,
        globalStartBp: globalStart,
        globalEndBp: globalEnd,
        payloadStartBp: typeof payload?.start === 'number' ? payload.start : null,
        payloadEndBp: typeof payload?.end === 'number' ? payload.end : null,
        payloadCount,
        readCount,
        alternateColumnCount,
      });
      if (entry.state === 'ready') {
        readyTileCount += 1;
        readyLevels.push(entry.key.level);
        readyRanges.push({ globalStart, globalEnd });
        const hasReads = typeof readCount === 'number' && readCount > 0;
        if (hasReads) {
          readyWithReadsTileCount += 1;
          payloadReadCount += readCount;
          readRanges.push({ globalStart, globalEnd });
        } else {
          readyEmptyTileCount += 1;
        }
        payloadAlternateColumnCount += alternateColumnCount ?? 0;
      } else if (entry.state === 'pending') {
        pendingTileCount += 1;
        pendingLevels.push(entry.key.level);
      } else if (entry.state === 'error') {
        errorTileCount += 1;
        errorLevels.push(entry.key.level);
      }
    }

    const readyStatus = rangesViewportStatus(readyRanges, view);
    const readStatus = rangesViewportStatus(readRanges, view);
    const composed = this.composeReads(view, level);

    return {
      level,
      maxReadAlignmentLevel: this.maxReadAlignment,
      maxFineLevel: this.maxReadAlignment,
      fineLevel: level <= this.maxReadAlignment,
      viewStartBp: view.globalStart,
      viewEndBp: view.globalEnd,
      visibleTileCount: visibleTiles.length,
      readyTileCount,
      pendingTileCount,
      errorTileCount,
      readyWithReadsTileCount,
      readyEmptyTileCount,
      payloadReadCount,
      payloadAlternateColumnCount,
      composedRecordCount: composed.records.length,
      composedAlternateColumnCount: composed.alternateColumns.length,
      stableBandReady: composed.stableBandReady,
      readyBandTileCount: composed.readyBandTileCount,
      expectedBandTileCount: composed.expectedBandTileCount,
      windowStartBp: composed.windowStartBp ?? null,
      windowEndBp: composed.windowEndBp ?? null,
      readyCoveredFraction: readyStatus.coveredFraction,
      readyCoversViewport: readyStatus.coversViewport,
      readCoveredFraction: readStatus.coveredFraction,
      readCoversViewport: readStatus.coversViewport,
      readyLevels: [...new Set(readyLevels)].sort((a, b) => a - b),
      pendingLevels: [...new Set(pendingLevels)].sort((a, b) => a - b),
      errorLevels: [...new Set(errorLevels)].sort((a, b) => a - b),
      visibleTiles: visibleTiles
        .sort((a, b) => a.globalStartBp - b.globalStartBp || a.sourceId.localeCompare(b.sourceId))
        .slice(0, 32),
      readyGaps: readyStatus.gaps.slice(0, 16),
      readGaps: readStatus.gaps.slice(0, 16),
    };
  }

  private describeCoverageComposition(view: Viewport, level: number): CoverageCompositionStatus {
    const readySlices = this.exactCoverageSlicesForLevel(view, level);
    const visibleCoreTiles = this.describeVisibleCoverageCoreTiles(view, level);
    let pendingTileCount = 0;
    let errorTileCount = 0;
    for (const entry of this.cache.entries()) {
      if (entry.key.level !== level || !isCoverageSourceId(entry.key.sourceId)) continue;
      if (entry.state === 'pending') {
        const tileStart = tileGlobalStart(entry.key.index, level);
        const tileEnd = tileGlobalEnd(entry.key.index, level);
        if (tileEnd > view.globalStart && tileStart < view.globalEnd) pendingTileCount += 1;
      } else if (entry.state === 'error') {
        const tileStart = tileGlobalStart(entry.key.index, level);
        const tileEnd = tileGlobalEnd(entry.key.index, level);
        if (tileEnd > view.globalStart && tileStart < view.globalEnd) errorTileCount += 1;
      }
    }
    const status = coverageSlicesViewportStatus(readySlices, view);
    const bins = readySlices.map((slice) => slice.binSize).filter((bin) => bin > 0);
    const readyStats = coverageSliceDepthStats(readySlices, view);
    const composedCoverage = status.coversViewport
      ? this.composeCoverageSignalFromSlices(readySlices)
      : undefined;
    const composedStats = composedCoverage
      ? coverageSignalDepthStats(composedCoverage, view)
      : { nonzeroBinCount: 0, maxDepth: 0 };
    return {
      level,
      viewStartBp: view.globalStart,
      viewEndBp: view.globalEnd,
      visibleCoreTileCount: visibleCoreTiles.length,
      exactReadyCoreTileCount: visibleCoreTiles.filter((tile) => tile.state === 'exact-ready')
        .length,
      readyNonExactCoreTileCount: visibleCoreTiles.filter(
        (tile) => tile.state === 'raw-ready-no-exact-slice'
      ).length,
      pendingCoreTileCount: visibleCoreTiles.filter((tile) => tile.state === 'pending').length,
      errorCoreTileCount: visibleCoreTiles.filter((tile) => tile.state === 'error').length,
      absentCoreTileCount: visibleCoreTiles.filter((tile) => tile.state === 'absent').length,
      visibleCoreTiles: visibleCoreTiles.slice(0, 32),
      readySliceCount: readySlices.length,
      readyNonzeroBinCount: readyStats.nonzeroBinCount,
      readyMaxDepth: readyStats.maxDepth,
      pendingTileCount,
      errorTileCount,
      coveredFraction: status.coveredFraction,
      coversViewport: status.coversViewport,
      composedNonzeroBinCount: composedStats.nonzeroBinCount,
      composedMaxDepth: composedStats.maxDepth,
      minBinSize: bins.length > 0 ? Math.min(...bins) : null,
      maxBinSize: bins.length > 0 ? Math.max(...bins) : null,
      intervals: status.intervals.slice(0, 16),
      gaps: status.gaps.slice(0, 16),
    };
  }

  private describeVisibleCoverageCoreTiles(
    view: Viewport,
    level: number
  ): CoverageCompositionStatus['visibleCoreTiles'] {
    return visibleTiles(view, level, this.assembly, 0)
      .filter((tile) => tile.core)
      .map((tile) => {
        const key = {
          sourceId: this.assemblyCoverageSource.id,
          level,
          index: tile.index,
        };
        const keyString = tileKeyString(key);
        const exactRecord = this.exactCoverageTiles.get(keyString);
        const entry = this.cache.peek(key);
        const state =
          exactRecord != null
            ? 'exact-ready'
            : entry?.state === 'ready'
              ? 'raw-ready-no-exact-slice'
              : entry?.state === 'pending' || entry?.state === 'error'
                ? entry.state
                : 'absent';
        const priority = entry?.priority
          ? {
              purpose: entry.priority.purpose,
              epoch: entry.priority.epoch,
              core: entry.priority.core,
              marginDistanceTiles: entry.priority.marginDistanceTiles,
            }
          : null;
        return {
          level,
          index: tile.index,
          state,
          globalStartBp: tile.globalStart,
          globalEndBp: tile.globalEnd,
          priority,
        };
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.corridorFloorAbortController?.abort();
    this.corridorFloorAbortController = null;
    this.cancelScheduledFeed?.();
    this.cancelScheduledFeed = null;
    this.cancelEmptyRegionSettlement?.();
    this.cancelEmptyRegionSettlement = null;
    this.cache.setPins([]);
    this.coordinator.cancelPendingWhere(() => true);
    for (const entry of this.cache.entries()) this.cache.evict(entry.key);
    this.chromSources.clear();
    this.residentCoverageByLevel.clear();
    this.exactCoverageTiles.clear();
    this.readCompositionCache.clear();
    this.lastPublishedFeed = null;
    this.sources.length = 0;
  }
}

function maxBinValue(bins: ReadonlyArray<number>): number {
  let maxDepth = 0;
  for (const value of bins) {
    if (value > maxDepth) maxDepth = value;
  }
  return maxDepth;
}

function withChromBoundSource(
  source: TileSource,
  chrom: string,
  suffix: string,
  levelRange?: readonly [number, number]
): TileSource {
  const id = `${source.id}${suffix}`;
  return {
    id,
    levelRange: levelRange ?? source.levelRange,
    prefetch: source.prefetch,
    fetchTile: (level, index, segments, signal, context?: TileFetchContext) => {
      const matchingSegments = segments.filter((segment) => segment.chrom === chrom);
      if (matchingSegments.length === 0) {
        return Promise.resolve({
          key: { sourceId: id, level, index },
          state: 'ready',
          count: 0,
          byteSize: 0,
        });
      }
      return source
        .fetchTile(level, index, matchingSegments, signal, context)
        .then((d: TileData) => ({
          ...d,
          key: { ...d.key, sourceId: id } as TileKey,
        }));
    },
  };
}

function driverNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function appendOwnedReadRecords(
  out: PileupRecord[],
  tile: SelectedReadTile,
  previous: SelectedReadTile | null
): void {
  const contiguousPrevious =
    previous !== null &&
    previous.sourceId === tile.sourceId &&
    previous.tileEndBp >= tile.tileStartBp - 1;
  for (const record of tile.records) {
    if (record.end <= tile.tileStartBp || record.start >= tile.tileEndBp) continue;
    if (contiguousPrevious && record.start < tile.tileStartBp) continue;
    out.push(record);
  }
}

function contiguousReadTilesCoveringViewport(
  tiles: ReadonlyArray<SelectedReadTile>,
  view: Viewport
): SelectedReadTile[] {
  let component: SelectedReadTile[] = [];
  let componentStart = 0;
  let componentEnd = 0;
  const finishComponent = (): SelectedReadTile[] | null => {
    if (
      component.length > 0 &&
      componentStart <= view.globalStart &&
      componentEnd >= view.globalEnd
    ) {
      return component;
    }
    return null;
  };
  for (const tile of tiles) {
    if (component.length === 0) {
      component = [tile];
      componentStart = tile.tileStartBp;
      componentEnd = tile.tileEndBp;
      continue;
    }
    if (tile.tileStartBp <= componentEnd) {
      component.push(tile);
      componentEnd = Math.max(componentEnd, tile.tileEndBp);
      continue;
    }
    const completed = finishComponent();
    if (completed) return completed;
    component = [tile];
    componentStart = tile.tileStartBp;
    componentEnd = tile.tileEndBp;
  }
  return finishComponent() ?? [];
}

function residentBinDistance(residentBinSize: number, targetBinSize: number): number {
  if (!(residentBinSize > 0) || !(targetBinSize > 0)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.log2(residentBinSize / targetBinSize));
}

function chromFromSourceId(sourceId: string): string | null {
  const idx = sourceId.lastIndexOf(':');
  if (idx < 0) return null;
  return sourceId.slice(idx + 1) || null;
}

function isCoverageSourceId(sourceId: string): boolean {
  return sourceId.startsWith('cov:') || sourceId.startsWith('covasm:');
}

function uniqueTileKeys(keys: ReadonlyArray<TileKey>): TileKey[] {
  const out: TileKey[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const keyString = tileKeyString(key);
    if (seen.has(keyString)) continue;
    seen.add(keyString);
    out.push(key);
  }
  return out;
}

function normalizeCriticalPrefetchLevels(levels: number | undefined): number {
  if (!(levels != null && Number.isFinite(levels))) return 1;
  return Math.max(1, Math.floor(levels));
}

function addRetainedCoverageHandoffLevels(
  out: Set<number>,
  currentLevel: number,
  handoffLevel: number,
  prefetchLevels: number,
  maxCurrentLevel: number
): void {
  const firstPrefetchLevel = Math.max(0, handoffLevel - prefetchLevels + 1);
  if (currentLevel < firstPrefetchLevel || currentLevel > maxCurrentLevel) return;
  for (let level = firstPrefetchLevel; level <= handoffLevel; level += 1) out.add(level);
}

function promotePendingCoveragePriority(entry: TileEntry, epoch: number): void {
  if (entry.state !== 'pending' || !entry.priority) return;
  entry.priority.purpose = 'critical-handoff';
  entry.priority.epoch = epoch;
  entry.priority.core = true;
  entry.priority.marginDistanceTiles = 0;
}

export { tileKeyString };
export { limitConcurrency } from './tile-engine-transport';
