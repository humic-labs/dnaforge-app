import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationPresentationPage, Assembly, Feature } from '@waypoint/genome-renderer';
import type { GenomeFeature } from '@waypoint/genome-data';
import {
  GENOME_WIDE_ANNOTATION_RASTER_EXACT_MIN_VISIBLE_FRACTION,
  globalBpToChrom,
  globalRangeToSegments,
  isGenomeWideRasterAnnotationOwner,
} from '@waypoint/genome-renderer';
import { platform } from '../../../platform';
import type {
  AssemblyReferenceAssetGenerationV1,
  GenomeAnnotationFeatureModel,
  GenomeOpenIntent,
} from '../../../shared/indexed-genome';
import {
  applyDensityControls,
  resolveAnnotationFeaturesForViewer,
  type AnnotationLaneStackingOptions,
  type LaneLimit,
  type RendererAnnotationFeatureStats,
  type TranscriptCarrierFeature,
} from './indexed-genome-legacy-adapter';
import { type TranscriptDisplayMode } from './isoform-collapse';
import { visibleTypesForGlyphMode } from './indexed-genome-viewer-controls';
import { isTranscriptGlyphV2Enabled } from '../transcript-glyph-flag';
import { offsetFeaturesToGlobal, offsetSequenceWindowToGlobal } from './assembly-feature-offset';
import { lodTierForViewport } from './assembly-lod-policy';
import {
  sequenceWindowRequestBounds,
  viewportCoverageSatisfiesGuard,
} from './indexed-sequence-window-policy';
import {
  AssemblySessionRegistry,
  type AssemblySessionChromConfig,
} from './assembly-session-registry';
import { waitForCoordinateReadyGenomeSession } from './assembly-session-ready';
import {
  ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
  ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP,
} from './indexed-annotation-tile-policy';
import { shouldEnableTestBridge } from '../../../lib/test-bridge-gate';
import {
  ASSEMBLY_ANNOTATION_PENDING_TILE_STATES,
  loadAssemblyAnnotationTileFeatures,
} from './assembly-annotation-tile-loader';
import {
  ASSEMBLY_ANNOTATION_PAGE_HALO,
  ASSEMBLY_ANNOTATION_RESIDENT_COORDINATE_LIMIT,
  annotationPageRangesForLocalViewport,
  annotationQueryRangeForLocalOwner,
  buildAnnotationPresentationPages,
} from './assembly-annotation-resident-pages';
import { annotationLayerType } from '../annotation-layer-identity';
import { DEFAULT_TRACK_ORDER, deriveAnnotationTrackRegistry } from '../annotation-track-registry';
import { resolveAssemblyAnnotationSearchFocusFeatureFromFeatures } from './indexed-genome-annotation-search-identity';
import { resolveTranscripts } from './spliced-feature-resolver';

const ROUTER_TEST_BRIDGE_ON =
  typeof window !== 'undefined' && shouldEnableTestBridge(import.meta.env);

const DETAIL_VISIBLE_TYPES: ReadonlySet<string> = new Set(['gene', 'mRNA']);
const LANE_STACKING: AnnotationLaneStackingOptions = {
  groupByType: true,
  typeOrder: DEFAULT_TRACK_ORDER,
};
const EMPTY_EXPANDED: ReadonlySet<string> = new Set<string>();
const TILE_POLL_MS = 200;
const TILE_MAX_ATTEMPTS = 30;
const SUMMARY_TILE_BYTE_BUDGET = 4_000_000;
const ANNOTATION_SOURCE_FETCH_TYPES: ReadonlySet<string> = new Set([
  'annotation-source-complete.v1',
]);
const ANNOTATION_SOURCE_PAGE_ARTIFACT = 'annotation-source-page.expanded-uncapped.v1';
const ANNOTATION_SOURCE_REPRESENTATION_REVISION = 'resolved-annotation-source.v1';
const ANNOTATION_DETAIL_PREFETCH_MAX_BP = ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP;
const NO_VISIBLE_CHROMS: ReadonlySet<string> = new Set<string>();

function assemblyCameraIsUnready(args: {
  enabled: boolean;
  hasAssembly: boolean;
  hasViewportRange: boolean;
}): boolean {
  return !args.enabled || !args.hasAssembly || !args.hasViewportRange;
}

function assemblyCameraAllowsDetailWork(args: {
  fetchAnnotationTile: boolean;
  prefetchCodonCarrierPages: boolean;
  compiledSceneOwnsAnnotationBody: boolean;
  visibleBp: number;
}): boolean {
  return (
    args.fetchAnnotationTile ||
    args.prefetchCodonCarrierPages ||
    (!args.compiledSceneOwnsAnnotationBody && args.visibleBp <= ANNOTATION_DETAIL_PREFETCH_MAX_BP)
  );
}
const SEQ_REFETCH_GUARD_BP = 32 * 1024;
const ASSEMBLY_SEQUENCE_WINDOW_MIN_BP = 512 * 1024;

function isResolvedAnnotationCodonCarrier(feature: TranscriptCarrierFeature): boolean {
  return (
    (feature.strand === '+' || feature.strand === '-') &&
    (feature.type === 'CDS' ||
      (Array.isArray(feature._resolvedCds) && feature._resolvedCds.length > 0))
  );
}

function residentCoordinateSlotKey(input: {
  chromosomeId: string;
  ownerStartBp: number;
  ownerEndBp: number;
}): string {
  return [
    'annotation-coordinate-slot.v1',
    input.chromosomeId,
    input.ownerStartBp,
    input.ownerEndBp,
  ].join('\u0000');
}
const CURRENT_RENDERER_RASTER_FRACTION_DIAGNOSTIC: number = 0.72;
const ANNOTATION_OWNERSHIP_THRESHOLD_DIAGNOSTIC = Object.freeze({
  routerRasterFraction: GENOME_WIDE_ANNOTATION_RASTER_EXACT_MIN_VISIBLE_FRACTION,
  rendererRasterFraction: CURRENT_RENDERER_RASTER_FRACTION_DIAGNOSTIC,
  consistent:
    GENOME_WIDE_ANNOTATION_RASTER_EXACT_MIN_VISIBLE_FRACTION ===
    CURRENT_RENDERER_RASTER_FRACTION_DIAGNOSTIC,
});

function normalizedAssetGeneration(generation: AssemblyReferenceAssetGenerationV1 | undefined) {
  if (!generation) return null;
  return {
    contract: generation.contract,
    sourceFingerprint: generation.sourceFingerprint,
    inventoryFingerprint: generation.inventoryFingerprint,
    themeMode: generation.themeMode,
  };
}

function normalizedGenomeOpenIntent(intent: GenomeOpenIntent) {
  switch (intent.kind) {
    case 'reference-single':
      return { kind: intent.kind };
    case 'internal-assembly-segment':
      return {
        kind: intent.kind,
        assetGeneration: normalizedAssetGeneration(intent.assetGeneration),
      };
    case 'reference-assembly':
      return {
        kind: intent.kind,
        annotationProductsReadiness: intent.annotationProductsReadiness,
        searchReadiness: intent.searchReadiness,
        assetGeneration: normalizedAssetGeneration(intent.assetGeneration),
        searchSource: intent.searchSource ?? null,
      };
  }
}

export function assemblySessionConfigsIdentity(
  configs: ReadonlyArray<AssemblySessionChromConfig> | undefined
): string {
  if (!configs) return '';
  return JSON.stringify(
    configs.map((config) => ({
      chrom: config.chrom,
      sourcePath: config.source.sourcePath,
      workspaceRoot: config.source.workspaceRoot ?? null,
      sourceExt: config.source.sourceExt ?? null,
      intent: normalizedGenomeOpenIntent(config.source.intent),
      fastaPath: config.manifest.fastaPath,
      faiPath: config.manifest.faiPath,
      gffPath: config.manifest.gffPath ?? null,
      tbiPath: config.manifest.tbiPath ?? null,
      length: config.manifest.length ?? null,
      circular: config.manifest.circular ?? null,
    }))
  );
}

function rangeCovered(
  coverage: { startBp: number; endBp: number } | undefined,
  start: number,
  end: number,
  guard: number,
  domain?: { startBp: number; endBp: number }
): boolean {
  return viewportCoverageSatisfiesGuard({
    coverage,
    viewportStart: start,
    viewportEnd: end,
    guardBp: guard,
    domainStart: domain?.startBp,
    domainEnd: domain?.endBp,
  });
}

function expandSequenceWindowBounds(input: {
  startBp: number;
  endBp: number;
  centerBp: number;
  length: number;
}): { startBp: number; endBp: number } {
  const current = input.endBp - input.startBp;
  if (current >= ASSEMBLY_SEQUENCE_WINDOW_MIN_BP || input.length <= current) {
    return { startBp: input.startBp, endBp: input.endBp };
  }
  const target = Math.min(input.length, ASSEMBLY_SEQUENCE_WINDOW_MIN_BP);
  const maxStart = Math.max(0, input.length - target);
  const startBp = Math.max(0, Math.min(maxStart, Math.floor(input.centerBp - target / 2)));
  return { startBp, endBp: Math.min(input.length, startBp + target) };
}

export interface AssemblySegmentRouterParams {
  rendererAssembly: Assembly | null;
  sessionConfigs: ReadonlyArray<AssemblySessionChromConfig> | undefined;
  containerWidth: number;
  enabled: boolean;
  overviewFeaturesComplete?: boolean;
  annotationTierOwnership?: AssemblyAnnotationTierOwnership;
  transcriptDisplayMode?: TranscriptDisplayMode;
  visibleTypes?: ReadonlySet<string>;
  laneLimit?: LaneLimit;
  glyphV2Enabled?: boolean;
  annotationSearchFocusSource?: AssemblyAnnotationSearchFocusSource | null;
}

export interface AssemblyAnnotationSearchFocusSource {
  startBp: number;
  endBp: number;
  trackId: string;
  canonicalIdentity: string;
  genomeIdentity: string;
}

function annotationSearchFocusQueryRanges(input: {
  ownerStartBp: number;
  ownerEndBp: number;
  chromosomeLengthBp: number;
}): Array<{ localStartBp: number; localEndBp: number }> {
  const span = input.ownerEndBp - input.ownerStartBp;
  if (
    !Number.isSafeInteger(input.ownerStartBp) ||
    !Number.isSafeInteger(input.ownerEndBp) ||
    !Number.isSafeInteger(input.chromosomeLengthBp) ||
    input.ownerStartBp < 0 ||
    input.ownerEndBp <= input.ownerStartBp ||
    input.ownerEndBp > input.chromosomeLengthBp
  ) {
    return [];
  }
  if (span <= ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP) {
    const centered = annotationQueryRangeForLocalOwner(input);
    return centered.localStartBp <= input.ownerStartBp && centered.localEndBp >= input.ownerEndBp
      ? [centered]
      : [];
  }
  const ranges: Array<{ localStartBp: number; localEndBp: number }> = [];
  for (
    let localStartBp = input.ownerStartBp;
    localStartBp < input.ownerEndBp;
    localStartBp += ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP
  ) {
    ranges.push({
      localStartBp,
      localEndBp: Math.min(
        input.ownerEndBp,
        localStartBp + ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP
      ),
    });
  }
  return ranges;
}

function annotationSearchRawFeatureIdentity(feature: GenomeFeature): string {
  if (feature.raw) return `raw:${feature.raw}`;
  const attributes = Object.fromEntries(
    Object.entries(feature.attributes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values]])
  );
  return JSON.stringify([
    feature.chrom,
    feature.source,
    feature.type,
    feature.start,
    feature.end,
    feature.score,
    feature.strand,
    feature.phase,
    attributes,
  ]);
}

export type AssemblyAnnotationTierOwnership =
  | Readonly<{
      broadOwner: 'legacy-summary';
      detailOwner: 'resident-coordinate-pages';
    }>
  | Readonly<{
      broadOwner: 'compiled-broad-raster';
      detailOwner: 'compiled-resident-scene';
      codonCarrierOwner: 'resident-coordinate-pages';
      identityKey: string;
      broadCorridorFinestSpanBp: number;
      residentSceneCoversViewport: boolean;
    }>;

const LEGACY_ASSEMBLY_ANNOTATION_TIER_OWNERSHIP: AssemblyAnnotationTierOwnership = Object.freeze({
  broadOwner: 'legacy-summary',
  detailOwner: 'resident-coordinate-pages',
});

export interface AssemblySequenceWindow {
  startBp: number;
  endBp: number;
  generation: number;
  byteCount: number;
  bases: string;
}

interface AssemblySequencePending {
  startBp: number;
  endBp: number;
  token: number;
  requestId: string;
}

interface AssemblyDetailPending {
  startBp: number;
  endBp: number;
  requestToken: number;
  requestId: string;
}

interface AssemblyResidentDetail {
  startBp: number;
  endBp: number;
  features: Feature[];
  featureStats: RendererAnnotationFeatureStats;
}

interface AssemblyResidentCoordinatePage {
  requestKey: string;
  chromosomeId: string;
  localStartBp: number;
  localEndBp: number;
  globalStartBp: number;
  globalEndBp: number;
  pages: ReadonlyArray<AnnotationPresentationPage>;
}

function featureTrackId(feature: Feature): string {
  return feature.annotationTrackId ?? feature.type;
}

export interface AssemblySegmentRouterResult {
  detailByChrom: ReadonlyMap<string, Feature[]>;
  exactDetailCoverageByChrom: ReadonlyMap<string, { startBp: number; endBp: number }>;
  annotationPages: ReadonlyArray<AnnotationPresentationPage>;
  annotationSearchFocusFeature: Feature | null;
  annotationSourcePageStreamKey: string;
  annotationProjectionPolicy: Readonly<{
    isoformMode: TranscriptDisplayMode;
    laneLimit: LaneLimit;
    visibleTypes: ReadonlyArray<string>;
  }>;
  sequenceWindow: AssemblySequenceWindow | null;
  onCamera: (
    viewportRange: { start: number; end: number } | null,
    opts?: { immediate?: boolean }
  ) => void;
  ensureSessionForChrom: (chrom: string) => Promise<{ sessionId: string } | null>;
}

function buildRegistry(
  configs: ReadonlyArray<AssemblySessionChromConfig>
): AssemblySessionRegistry {
  return new AssemblySessionRegistry({
    driver: {
      open: async (source) =>
        waitForCoordinateReadyGenomeSession({
          initialShell: await platform().genome.open(source),
          getSession: (sessionId) => platform().genome.getSession(sessionId),
        }),
      closeSession: (sessionId) => platform().genome.closeSession(sessionId),
      cancel: (sessionId, requestId) => platform().genome.cancelRequest(sessionId, requestId),
    },
    chroms: configs,
    exposeDebug: typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV),
    onError: (chrom, err) => {
      if (typeof window !== 'undefined' && import.meta.env?.DEV) {
        (window as Window & { __assemblyRegistryError?: unknown }).__assemblyRegistryError = {
          chrom,
          message: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        };
      }
      // eslint-disable-next-line no-console
      console.warn(`[assembly-session] open ${chrom} failed:`, err);
    },
  });
}

export function useAssemblySegmentRouter(
  params: AssemblySegmentRouterParams
): AssemblySegmentRouterResult {
  const {
    rendererAssembly,
    sessionConfigs,
    containerWidth,
    enabled,
    overviewFeaturesComplete = false,
    annotationTierOwnership = LEGACY_ASSEMBLY_ANNOTATION_TIER_OWNERSHIP,
    transcriptDisplayMode = 'canonical',
    visibleTypes = DETAIL_VISIBLE_TYPES,
    laneLimit = null,
    glyphV2Enabled = isTranscriptGlyphV2Enabled(),
    annotationSearchFocusSource = null,
  } = params;
  const configKey = assemblySessionConfigsIdentity(sessionConfigs);
  const annotationCapableChroms = useMemo(
    () =>
      new Set(
        (sessionConfigs ?? [])
          .filter((config) => Boolean(config.manifest.gffPath && config.manifest.tbiPath))
          .map((config) => config.chrom)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [configKey]
  );
  const annotationCapableChromsRef = useRef<ReadonlySet<string>>(annotationCapableChroms);
  annotationCapableChromsRef.current = annotationCapableChroms;
  const compiledBroadOwnsOverview = annotationTierOwnership.broadOwner === 'compiled-broad-raster';
  const compiledSceneOwnsAnnotationBody =
    annotationTierOwnership.detailOwner === 'compiled-resident-scene';
  const effectiveDetailVisibleTypes = useMemo(
    () => visibleTypesForGlyphMode(visibleTypes, glyphV2Enabled),
    [visibleTypes, glyphV2Enabled]
  );
  const effectiveDetailVisibleTypesRef = useRef<ReadonlySet<string>>(effectiveDetailVisibleTypes);
  effectiveDetailVisibleTypesRef.current = effectiveDetailVisibleTypes;
  const glyphV2EnabledRef = useRef(glyphV2Enabled);
  glyphV2EnabledRef.current = glyphV2Enabled;
  const displayModeRef = useRef<TranscriptDisplayMode>(transcriptDisplayMode);
  displayModeRef.current = transcriptDisplayMode;
  const laneLimitRef = useRef<LaneLimit>(laneLimit);
  laneLimitRef.current = laneLimit;
  const annotationProjectionPolicy = useMemo(
    () =>
      Object.freeze({
        isoformMode: transcriptDisplayMode,
        laneLimit,
        visibleTypes: Object.freeze(
          [...visibleTypes].sort((left, right) => left.localeCompare(right))
        ),
      }),
    [laneLimit, transcriptDisplayMode, visibleTypes]
  );
  const lastCameraUsesDetailRef = useRef(false);
  const lastCameraAllowsDetailWorkRef = useRef(false);
  const [detailByChrom, setDetailByChrom] = useState<ReadonlyMap<string, Feature[]>>(new Map());
  const [exactDetailCoverageByChrom, setExactDetailCoverageByChrom] = useState<
    ReadonlyMap<string, { startBp: number; endBp: number }>
  >(new Map());
  const [annotationPages, setAnnotationPages] = useState<ReadonlyArray<AnnotationPresentationPage>>(
    []
  );
  const [annotationSearchFocusState, setAnnotationSearchFocusState] = useState<{
    sourceKey: string;
    feature: Feature;
  } | null>(null);
  const [sequenceWindow, setSequenceWindow] = useState<AssemblySequenceWindow | null>(null);
  const detailByChromRef = useRef(detailByChrom);
  detailByChromRef.current = detailByChrom;
  const annotationPagesRef = useRef(annotationPages);
  annotationPagesRef.current = annotationPages;
  const sequenceWindowRef = useRef(sequenceWindow);
  sequenceWindowRef.current = sequenceWindow;
  const registryRef = useRef<AssemblySessionRegistry | null>(null);
  const residentCoordinatePagesRef = useRef<Map<string, AssemblyResidentCoordinatePage>>(new Map());
  const residentCoordinatePageLruRef = useRef<string[]>([]);
  const residentCoordinateHaloReadyChromsRef = useRef<Set<string>>(new Set());
  const latestCoordinateProtectedKeysRef = useRef<Set<string>>(new Set());
  const pendingCoordinatePageKeysRef = useRef<Set<string>>(new Set());
  const presentedDetailChromsRef = useRef<ReadonlySet<string>>(new Set());
  const overviewSummaryCoverageRef = useRef<Map<string, { startBp: number; endBp: number }>>(
    new Map()
  );
  const overviewSummaryPendingCoverageRef = useRef<Map<string, AssemblyDetailPending>>(new Map());
  const residentOverviewSummaryRef = useRef<Map<string, AssemblyResidentDetail>>(new Map());
  const presentedOverviewChromsRef = useRef<ReadonlySet<string>>(new Set());
  const seqCoverageRef = useRef<Map<string, { startBp: number; endBp: number }>>(new Map());
  const seqPendingCoverageRef = useRef<Map<string, AssemblySequencePending>>(new Map());
  const tokenRef = useRef(0);
  const detailRequestSeqRef = useRef(0);
  const detailRequestTokensRef = useRef<Map<string, number>>(new Map());
  const coordinatePageRequestCountRef = useRef(0);
  const coordinateRepositoryPublicationCountRef = useRef(0);
  const annotationSearchFocusRequestSeqRef = useRef(0);
  const overviewSummaryRequestSeqRef = useRef(0);
  const overviewSummaryRequestTokensRef = useRef<Map<string, number>>(new Map());
  const seqTokenRef = useRef(0);
  const activeChromRef = useRef<string | null>(null);
  const lastDecisionRef = useRef<Record<string, unknown> | null>(null);
  const detailFetchDebugRef = useRef<Record<string, Record<string, unknown>>>({});
  const detailFeatureStatsRef = useRef<WeakMap<Feature[], RendererAnnotationFeatureStats>>(
    new WeakMap()
  );
  const annotationSearchFocusSourceRef = useRef(annotationSearchFocusSource);
  annotationSearchFocusSourceRef.current = annotationSearchFocusSource;
  const annotationSearchFocusSourceKey = annotationSearchFocusSource
    ? JSON.stringify([
        annotationSearchFocusSource.startBp,
        annotationSearchFocusSource.endBp,
        annotationSearchFocusSource.trackId,
        annotationSearchFocusSource.canonicalIdentity,
        annotationSearchFocusSource.genomeIdentity,
      ])
    : '';
  const annotationSearchFocusFeature =
    annotationSearchFocusState?.sourceKey === annotationSearchFocusSourceKey
      ? annotationSearchFocusState.feature
      : null;
  const publishDebugSnapshot = useCallback(
    (lastDecision: Record<string, unknown> | null = lastDecisionRef.current) => {
      if (typeof window === 'undefined' || (!import.meta.env?.DEV && !ROUTER_TEST_BRIDGE_ON))
        return;
      const currentDetail = detailByChromRef.current;
      const currentSequenceWindow = sequenceWindowRef.current;
      const detailCounts: Record<string, number> = {};
      const detailStats: Record<string, RendererAnnotationFeatureStats> = {};
      for (const [chrom, feats] of currentDetail) {
        detailCounts[chrom] = feats.length;
        const cachedStats = detailFeatureStatsRef.current.get(feats);
        if (cachedStats) detailStats[chrom] = cachedStats;
      }
      (window as Window & { __assemblyDetailDebug?: unknown }).__assemblyDetailDebug = {
        enabled,
        containerWidth,
        activeChrom: activeChromRef.current,
        lastDecision,
        overviewFeaturesComplete,
        annotationTierOwnership,
        ownershipThresholds: ANNOTATION_OWNERSHIP_THRESHOLD_DIAGNOSTIC,
        visibleTypes: [...effectiveDetailVisibleTypes].sort(),
        detailChroms: [...currentDetail.keys()],
        detailCounts,
        detailStats,
        coordinatePageRequestCount: coordinatePageRequestCountRef.current,
        coordinateRepositoryPublicationCount: coordinateRepositoryPublicationCountRef.current,
        pendingCoordinatePageCount: pendingCoordinatePageKeysRef.current.size,
        residentCoordinatePageCount: residentCoordinatePagesRef.current.size,
        annotationSourcePageCount: annotationPagesRef.current.length,
        detailFetches: Object.fromEntries(
          Object.entries(detailFetchDebugRef.current).map(([chrom, value]) => [chrom, { ...value }])
        ),
        sequenceWindow: currentSequenceWindow
          ? {
              startBp: currentSequenceWindow.startBp,
              endBp: currentSequenceWindow.endBp,
              bases: currentSequenceWindow.bases.length,
            }
          : null,
      };
    },
    [
      annotationTierOwnership,
      containerWidth,
      effectiveDetailVisibleTypes,
      enabled,
      overviewFeaturesComplete,
    ]
  );
  const recordDecision = useCallback(
    (decision: Record<string, unknown>) => {
      lastDecisionRef.current = decision;
      if (typeof window === 'undefined' || (!import.meta.env?.DEV && !ROUTER_TEST_BRIDGE_ON)) {
        return;
      }
      const debug = (
        window as Window & {
          __assemblyDetailDebug?: {
            activeChrom?: string | null;
            lastDecision?: Record<string, unknown> | null;
            coordinatePageRequestCount?: number;
            coordinateRepositoryPublicationCount?: number;
            pendingCoordinatePageCount?: number;
            residentCoordinatePageCount?: number;
            annotationSourcePageCount?: number;
          };
        }
      ).__assemblyDetailDebug;
      if (debug) {
        debug.activeChrom = activeChromRef.current;
        debug.lastDecision = decision;
        debug.coordinatePageRequestCount = coordinatePageRequestCountRef.current;
        debug.coordinateRepositoryPublicationCount =
          coordinateRepositoryPublicationCountRef.current;
        debug.pendingCoordinatePageCount = pendingCoordinatePageKeysRef.current.size;
        debug.residentCoordinatePageCount = residentCoordinatePagesRef.current.size;
        debug.annotationSourcePageCount = annotationPagesRef.current.length;
        return;
      }
      publishDebugSnapshot(decision);
    },
    [publishDebugSnapshot]
  );
  useEffect(() => {
    publishDebugSnapshot();
  }, [annotationPages, publishDebugSnapshot]);
  useEffect(() => {
    if (
      (!overviewFeaturesComplete && !compiledBroadOwnsOverview) ||
      lastCameraUsesDetailRef.current
    ) {
      return;
    }
    overviewSummaryRequestTokensRef.current.clear();
    overviewSummaryPendingCoverageRef.current.clear();
    residentOverviewSummaryRef.current.clear();
    presentedOverviewChromsRef.current = new Set();
    setDetailByChrom((prev) => (prev.size === 0 ? prev : new Map()));
  }, [compiledBroadOwnsOverview, overviewFeaturesComplete]);

  const detailPageSourceIdentity = [
    ANNOTATION_SOURCE_REPRESENTATION_REVISION,
    rendererAssembly?.id ?? 'no-assembly',
    glyphV2Enabled ? 'glyph-v2' : 'glyph-v1',
    configKey,
  ].join('\u0000');
  const detailPageSourceIdentityRef = useRef(detailPageSourceIdentity);
  detailPageSourceIdentityRef.current = detailPageSourceIdentity;
  useEffect(() => {
    if (!enabled || !sessionConfigs || sessionConfigs.length === 0) {
      registryRef.current?.dispose();
      registryRef.current = null;
      annotationSearchFocusRequestSeqRef.current += 1;
      setAnnotationSearchFocusState(null);
      return;
    }
    registryRef.current?.dispose();
    registryRef.current = buildRegistry(sessionConfigs);
    residentCoordinatePagesRef.current.clear();
    residentCoordinatePageLruRef.current = [];
    residentCoordinateHaloReadyChromsRef.current.clear();
    latestCoordinateProtectedKeysRef.current.clear();
    pendingCoordinatePageKeysRef.current.clear();
    presentedDetailChromsRef.current = new Set();
    coordinatePageRequestCountRef.current = 0;
    detailRequestTokensRef.current.clear();
    overviewSummaryCoverageRef.current.clear();
    overviewSummaryPendingCoverageRef.current.clear();
    residentOverviewSummaryRef.current.clear();
    presentedOverviewChromsRef.current = new Set();
    overviewSummaryRequestTokensRef.current.clear();
    seqCoverageRef.current.clear();
    seqPendingCoverageRef.current.clear();
    setDetailByChrom(new Map());
    setExactDetailCoverageByChrom(new Map());
    setAnnotationPages([]);
    annotationSearchFocusRequestSeqRef.current += 1;
    setAnnotationSearchFocusState(null);
    setSequenceWindow(null);
    activeChromRef.current = null;
    return () => {
      registryRef.current?.dispose();
      registryRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, configKey, detailPageSourceIdentity]);

  const publishResidentCoordinateRepository = useCallback(() => {
    coordinateRepositoryPublicationCountRef.current += 1;
    const entries = [...residentCoordinatePagesRef.current.values()].sort(
      (left, right) =>
        left.globalStartBp - right.globalStartBp ||
        left.chromosomeId.localeCompare(right.chromosomeId)
    );
    const pages = entries.flatMap((entry) => entry.pages);
    setAnnotationPages((prev) =>
      prev.length === pages.length && prev.every((page, index) => page === pages[index])
        ? prev
        : pages
    );
    setExactDetailCoverageByChrom((prev) => {
      const next = new Map<string, { startBp: number; endBp: number }>();
      for (const entry of entries) {
        const previous = next.get(entry.chromosomeId);
        next.set(entry.chromosomeId, {
          startBp: Math.min(previous?.startBp ?? entry.globalStartBp, entry.globalStartBp),
          endBp: Math.max(previous?.endBp ?? entry.globalEndBp, entry.globalEndBp),
        });
      }
      if (
        next.size === prev.size &&
        [...next].every(
          ([chrom, range]) =>
            prev.get(chrom)?.startBp === range.startBp && prev.get(chrom)?.endBp === range.endBp
        )
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const publishResidentDetailForChroms = useCallback(
    (_visibleChroms: ReadonlySet<string>, _options: { replace?: boolean } = {}) => {
      publishResidentCoordinateRepository();
      setDetailByChrom((prev) => (prev.size === 0 ? prev : new Map()));
    },
    [publishResidentCoordinateRepository]
  );

  const publishResidentDetailForSegments = useCallback(
    (segments: ReadonlyArray<{ chrom: string }>, options: { replace?: boolean } = {}) =>
      publishResidentDetailForChroms(new Set(segments.map((segment) => segment.chrom)), options),
    [publishResidentDetailForChroms]
  );

  const detailSegmentPageState = useCallback(
    (
      segment: {
        chrom: string;
        globalStart: number;
        localStart: number;
        localEnd: number;
        placement: { chromosome: { length: number } };
      },
      options: { includeHalo?: boolean } = {}
    ): {
      resident: boolean;
      residentOrPending: boolean;
    } => {
      if (!annotationCapableChromsRef.current.has(segment.chrom)) {
        return { resident: true, residentOrPending: true };
      }
      const includeHalo =
        options.includeHalo === true &&
        !residentCoordinateHaloReadyChromsRef.current.has(segment.chrom);
      const ranges = annotationPageRangesForLocalViewport({
        localStartBp: segment.localStart,
        localEndBp: segment.localEnd,
        chromosomeLengthBp: segment.placement.chromosome.length,
        haloPages: includeHalo
          ? compiledSceneOwnsAnnotationBody
            ? 1
            : ASSEMBLY_ANNOTATION_PAGE_HALO
          : 0,
      });
      const states = ranges.map((range) => {
        const requestKey = residentCoordinateSlotKey({
          chromosomeId: segment.chrom,
          ownerStartBp: segment.globalStart + range.localStartBp,
          ownerEndBp: segment.globalStart + range.localEndBp,
        });
        latestCoordinateProtectedKeysRef.current.add(requestKey);
        const resident = residentCoordinatePagesRef.current.has(requestKey);
        return {
          resident,
          residentOrPending: resident || pendingCoordinatePageKeysRef.current.has(requestKey),
        };
      });
      return {
        resident: states.length > 0 && states.every((state) => state.resident),
        residentOrPending: states.length > 0 && states.every((state) => state.residentOrPending),
      };
    },
    [compiledSceneOwnsAnnotationBody]
  );

  const publishResidentOverviewForSegments = useCallback(
    (
      segments: ReadonlyArray<{
        chrom: string;
        globalStart: number;
        placement: { chromosome: { length: number } };
      }>
    ) => {
      setDetailByChrom((prev) => {
        const next = new Map<string, Feature[]>();
        for (const segment of segments) {
          const resident = residentOverviewSummaryRef.current.get(segment.chrom);
          if (!resident) continue;
          const chromStart = segment.globalStart;
          const chromEnd = segment.globalStart + segment.placement.chromosome.length;
          if (!rangeCovered(resident, chromStart, chromEnd, 0)) continue;
          next.set(segment.chrom, resident.features);
        }
        if (next.size !== prev.size) return next;
        for (const [chrom, features] of next) {
          if (prev.get(chrom) !== features) return next;
        }
        return prev;
      });
    },
    []
  );

  const fetchOverviewSummaryForChrom = useCallback(
    async (chrom: string, globalStart: number, chromLength: number) => {
      if (!annotationCapableChromsRef.current.has(chrom)) return;
      const registry = registryRef.current;
      if (!registry) {
        detailFetchDebugRef.current = {
          ...detailFetchDebugRef.current,
          [chrom]: { chrom, status: 'no-registry-summary' },
        };
        publishDebugSnapshot();
        return;
      }
      const epoch = tokenRef.current;
      const requestToken = ++overviewSummaryRequestSeqRef.current;
      const requestId = `assembly-summary-${chrom}-${requestToken}`;
      const startedAt =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      const updateFetchDebug = (patch: Record<string, unknown>) => {
        const now =
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        detailFetchDebugRef.current = {
          ...detailFetchDebugRef.current,
          [chrom]: {
            ...(detailFetchDebugRef.current[chrom] ?? {}),
            chrom,
            summaryRequestToken: requestToken,
            ...patch,
            elapsedMs: Math.round((now - startedAt) * 10) / 10,
          },
        };
        publishDebugSnapshot();
      };

      overviewSummaryRequestTokensRef.current.set(chrom, requestToken);
      overviewSummaryPendingCoverageRef.current.set(chrom, {
        startBp: globalStart,
        endBp: globalStart + chromLength,
        requestToken,
        requestId,
      });
      const summaryVisibleTypes = effectiveDetailVisibleTypesRef.current;
      const summaryGlyphV2Enabled = glyphV2EnabledRef.current;
      const isCurrentRequest = () =>
        epoch === tokenRef.current &&
        overviewSummaryRequestTokensRef.current.get(chrom) === requestToken;

      updateFetchDebug({ status: 'summary-ensure-session', requestId, globalStart, chromLength });
      const handle = await registry.ensure(chrom);
      if (!handle) {
        updateFetchDebug({ status: 'summary-no-session', requestId });
        return;
      }
      if (!isCurrentRequest()) {
        updateFetchDebug({ status: 'summary-stale-after-session', requestId });
        return;
      }

      registry.registerInflight(chrom, requestId);
      try {
        const loaded = await loadAssemblyAnnotationTileFeatures({
          sessionId: handle.sessionId,
          requestId,
          chrom,
          start: 0,
          end: chromLength,
          lod: 0,
          generation: requestToken,
          fidelity: 'summary',
          byteBudget: SUMMARY_TILE_BYTE_BUDGET,
          sourceFingerprint: handle.sourceFingerprint,
          visibleTypes: summaryVisibleTypes,
          laneLimit: laneLimitRef.current,
          length: handle.manifest.length ?? chromLength,
          globalStart,
          glyphV2Enabled: summaryGlyphV2Enabled,
          transcriptDisplayMode: displayModeRef.current,
          expandedGeneIds: EMPTY_EXPANDED,
          laneStacking: LANE_STACKING,
          maxAttempts: TILE_MAX_ATTEMPTS,
          pollMs: TILE_POLL_MS,
          isCurrent: isCurrentRequest,
          getAnnotationTile: (sessionId, request, id) =>
            platform().genome.getAnnotationTile(sessionId, request, id),
          onTile: (tile, attempt) => {
            updateFetchDebug({
              status: ASSEMBLY_ANNOTATION_PENDING_TILE_STATES.has(tile.state)
                ? 'summary-pending-tile'
                : 'summary-returned',
              attempt,
              tileState: tile.state,
              tileFidelity: tile.fidelity,
              byteCount: tile.byteCount,
              recordCount: tile.recordCount,
              rawFeatureCount: Array.isArray(tile.features) ? tile.features.length : null,
              featureModel: tile.featureModel ?? null,
              cacheState: tile.cacheState ?? null,
              requestId,
            });
          },
        });
        if (!loaded) {
          updateFetchDebug({ status: 'summary-not-current-or-empty', requestId });
          return;
        }
        const resident = {
          startBp: globalStart,
          endBp: globalStart + chromLength,
          features: loaded.features,
          featureStats: loaded.featureStats,
        };
        detailFeatureStatsRef.current.set(loaded.features, loaded.featureStats);
        overviewSummaryCoverageRef.current.set(chrom, {
          startBp: resident.startBp,
          endBp: resident.endBp,
        });
        residentOverviewSummaryRef.current.set(chrom, resident);
        if (presentedOverviewChromsRef.current.has(chrom)) {
          setDetailByChrom((prev) => {
            const next = new Map(prev);
            if (next.get(chrom) === loaded.features) return prev;
            next.set(chrom, loaded.features);
            return next;
          });
        }
        updateFetchDebug({
          status: presentedOverviewChromsRef.current.has(chrom)
            ? 'summary-published'
            : 'summary-resident',
          requestId,
          rawFeatureCount: loaded.rawFeatureCount,
          resolvedFeatureCount: loaded.resolvedFeatureCount,
          collapsedFeatureCount: loaded.collapsedFeatureCount,
          localFeatureCount: loaded.localFeatureCount,
          typeFilteredCount: loaded.typeFilteredCount,
          droppedCount: loaded.droppedCount,
          offsetFeatureCount: loaded.features.length,
        });
      } catch (err) {
        updateFetchDebug({
          status: 'summary-error',
          requestId,
          message: err instanceof Error ? err.message : String(err),
        });
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.warn(`[assembly-summary] ${chrom} summary fetch failed:`, err);
        }
      } finally {
        if (overviewSummaryRequestTokensRef.current.get(chrom) === requestToken) {
          overviewSummaryRequestTokensRef.current.delete(chrom);
        }
        const pending = overviewSummaryPendingCoverageRef.current.get(chrom);
        if (pending?.requestId === requestId)
          overviewSummaryPendingCoverageRef.current.delete(chrom);
        registry.clearInflight(chrom, requestId);
      }
    },
    [publishDebugSnapshot]
  );

  const fetchDetailForChrom = useCallback(
    async (
      chrom: string,
      globalStart: number,
      localStart: number,
      localEnd: number,
      chromLength: number,
      options: { publishOnResolve?: boolean; includeHalo?: boolean } = {}
    ) => {
      if (!annotationCapableChromsRef.current.has(chrom)) return;
      const registry = registryRef.current;
      if (!registry) {
        detailFetchDebugRef.current = {
          ...detailFetchDebugRef.current,
          [chrom]: { chrom, status: 'no-registry' },
        };
        publishDebugSnapshot();
        return;
      }
      const epoch = tokenRef.current;
      const sourceIdentity = detailPageSourceIdentityRef.current;
      const detailGlyphV2Enabled = glyphV2EnabledRef.current;
      const visibleRanges = annotationPageRangesForLocalViewport({
        localStartBp: localStart,
        localEndBp: localEnd,
        chromosomeLengthBp: chromLength,
        haloPages: 0,
      });
      const plannedRanges =
        options.includeHalo === false
          ? visibleRanges
          : annotationPageRangesForLocalViewport({
              localStartBp: localStart,
              localEndBp: localEnd,
              chromosomeLengthBp: chromLength,
              haloPages: compiledSceneOwnsAnnotationBody ? 1 : ASSEMBLY_ANNOTATION_PAGE_HALO,
            });
      const requestKeyForRange = (range: { localStartBp: number; localEndBp: number }) =>
        residentCoordinateSlotKey({
          chromosomeId: chrom,
          ownerStartBp: globalStart + range.localStartBp,
          ownerEndBp: globalStart + range.localEndBp,
        });

      if (
        plannedRanges.every((range) => {
          const key = requestKeyForRange(range);
          return (
            residentCoordinatePagesRef.current.has(key) ||
            pendingCoordinatePageKeysRef.current.has(key)
          );
        })
      ) {
        for (const range of plannedRanges) {
          const key = requestKeyForRange(range);
          const index = residentCoordinatePageLruRef.current.indexOf(key);
          if (index >= 0) {
            residentCoordinatePageLruRef.current.splice(index, 1);
            residentCoordinatePageLruRef.current.push(key);
          }
        }
        return;
      }

      const startedAt =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      const updateFetchDebug = (patch: Record<string, unknown>) => {
        const now =
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        detailFetchDebugRef.current = {
          ...detailFetchDebugRef.current,
          [chrom]: {
            ...(detailFetchDebugRef.current[chrom] ?? {}),
            chrom,
            sourceIdentity,
            sourceArtifact: ANNOTATION_SOURCE_PAGE_ARTIFACT,
            plannedPageCount: plannedRanges.length,
            ...patch,
            elapsedMs: Math.round((now - startedAt) * 10) / 10,
          },
        };
        publishDebugSnapshot();
      };

      const fetchCoordinatePage = async (range: {
        localStartBp: number;
        localEndBp: number;
      }): Promise<void> => {
        if (epoch !== tokenRef.current || sourceIdentity !== detailPageSourceIdentityRef.current) {
          return;
        }
        const requestKey = requestKeyForRange(range);
        if (
          residentCoordinatePagesRef.current.has(requestKey) ||
          pendingCoordinatePageKeysRef.current.has(requestKey)
        ) {
          return;
        }
        const requestToken = ++detailRequestSeqRef.current;
        const requestId = `assembly-detail-page-${chrom}-${range.localStartBp}-${requestToken}`;
        const queryRange = annotationQueryRangeForLocalOwner({
          ownerStartBp: range.localStartBp,
          ownerEndBp: range.localEndBp,
          chromosomeLengthBp: chromLength,
        });
        detailRequestTokensRef.current.set(requestKey, requestToken);
        pendingCoordinatePageKeysRef.current.add(requestKey);
        coordinatePageRequestCountRef.current += 1;
        const isCurrentRequest = () =>
          epoch === tokenRef.current &&
          sourceIdentity === detailPageSourceIdentityRef.current &&
          detailRequestTokensRef.current.get(requestKey) === requestToken;
        let registeredInflight = false;
        try {
          updateFetchDebug({
            status: 'ensure-page-session',
            requestId,
            requestToken,
            pageStart: range.localStartBp,
            pageEnd: range.localEndBp,
            queryStart: queryRange.localStartBp,
            queryEnd: queryRange.localEndBp,
          });
          const handle = await registry.ensure(chrom);
          if (!handle || !isCurrentRequest()) return;
          registry.registerInflight(chrom, requestId);
          registeredInflight = true;
          const loaded = await loadAssemblyAnnotationTileFeatures({
            sessionId: handle.sessionId,
            requestId,
            chrom,
            start: queryRange.localStartBp,
            end: queryRange.localEndBp,
            lod: 1,
            generation: requestToken,
            fidelity: 'exact',
            byteBudget: ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
            annotationOwner: {
              start: range.localStartBp,
              end: range.localEndBp,
            },
            sourceFingerprint: handle.sourceFingerprint,
            visibleTypes: ANNOTATION_SOURCE_FETCH_TYPES,
            laneLimit: null,
            length: handle.manifest.length ?? chromLength,
            globalStart,
            glyphV2Enabled: detailGlyphV2Enabled,
            transcriptDisplayMode: 'expanded',
            expandedGeneIds: EMPTY_EXPANDED,
            laneStacking: LANE_STACKING,
            maxAttempts: TILE_MAX_ATTEMPTS,
            pollMs: TILE_POLL_MS,
            requireCompleteSource: true,
            isCurrent: isCurrentRequest,
            getAnnotationTile: (sessionId, request, id) =>
              platform().genome.getAnnotationTile(sessionId, request, id),
            onTile: (tile, attempt) => {
              updateFetchDebug({
                status: ASSEMBLY_ANNOTATION_PENDING_TILE_STATES.has(tile.state)
                  ? 'pending-page-tile'
                  : 'page-tile-returned',
                requestId,
                requestToken,
                attempt,
                pageStart: range.localStartBp,
                pageEnd: range.localEndBp,
                queryStart: queryRange.localStartBp,
                queryEnd: queryRange.localEndBp,
                tileState: tile.state,
                byteCount: tile.byteCount,
                recordCount: tile.recordCount,
                cacheState: tile.cacheState ?? null,
              });
            },
          });
          if (!loaded || !isCurrentRequest()) return;
          const sourceInputFeatures = compiledSceneOwnsAnnotationBody
            ? loaded.resolvedExpandedFeatures.filter(isResolvedAnnotationCodonCarrier)
            : loaded.resolvedExpandedFeatures;
          const sourceTypes = new Set(
            sourceInputFeatures.map((feature) => annotationLayerType(feature))
          );
          const sourceDensity = applyDensityControls(
            [...sourceInputFeatures],
            chrom,
            handle.manifest.length ?? chromLength,
            sourceTypes,
            null,
            LANE_STACKING
          );
          const sourceFeatures = offsetFeaturesToGlobal(sourceDensity.features, globalStart);
          const sourceTrackIds = [...new Set(sourceFeatures.map(featureTrackId))];
          if (sourceTrackIds.length === 0) sourceTrackIds.push('mRNA');
          const sourceTracks = deriveAnnotationTrackRegistry(sourceTrackIds);
          const requestedTracks = sourceTracks.map(({ trackId, order: trackOrder }) => {
            const laneCapacity = sourceFeatures.reduce(
              (capacity, feature) =>
                featureTrackId(feature) === trackId
                  ? Math.max(capacity, (feature.annotationTrackLane ?? feature.lane) + 1)
                  : capacity,
              1
            );
            return { trackId, trackOrder, laneCapacity };
          });
          const builtPages = await buildAnnotationPresentationPages({
            sourceIdentity: `${sourceIdentity}\u0000${handle.sourceFingerprint}`,
            policyKey: ANNOTATION_SOURCE_PAGE_ARTIFACT,
            chromosomeId: chrom,
            ownerStartBp: globalStart + range.localStartBp,
            ownerEndBp: globalStart + range.localEndBp,
            requestedTracks,
            features: sourceFeatures,
          });
          if (!isCurrentRequest()) return;
          const previous = residentCoordinatePagesRef.current.get(requestKey);
          const pages = Object.freeze(
            builtPages.map((page) => {
              const stable = previous?.pages.find(
                (candidate) =>
                  candidate.pageKey === page.pageKey &&
                  candidate.contentRevision === page.contentRevision
              );
              return stable ?? page;
            })
          );
          residentCoordinatePagesRef.current.set(requestKey, {
            requestKey,
            chromosomeId: chrom,
            localStartBp: range.localStartBp,
            localEndBp: range.localEndBp,
            globalStartBp: globalStart + range.localStartBp,
            globalEndBp: globalStart + range.localEndBp,
            pages,
          });
          const existingLruIndex = residentCoordinatePageLruRef.current.indexOf(requestKey);
          if (existingLruIndex >= 0) {
            residentCoordinatePageLruRef.current.splice(existingLruIndex, 1);
          }
          residentCoordinatePageLruRef.current.push(requestKey);
          while (
            residentCoordinatePageLruRef.current.length >
            ASSEMBLY_ANNOTATION_RESIDENT_COORDINATE_LIMIT
          ) {
            const evictIndex = residentCoordinatePageLruRef.current.findIndex(
              (candidate) => !latestCoordinateProtectedKeysRef.current.has(candidate)
            );
            const [evicted] = residentCoordinatePageLruRef.current.splice(
              evictIndex >= 0 ? evictIndex : 0,
              1
            );
            if (evicted) residentCoordinatePagesRef.current.delete(evicted);
          }
          updateFetchDebug({
            status: 'page-resident',
            requestId,
            requestToken,
            pageStart: range.localStartBp,
            pageEnd: range.localEndBp,
            pageTrackCount: pages.length,
            pageFeatureCount: pages.reduce((sum, page) => sum + page.features.length, 0),
            residentCoordinatePageCount: residentCoordinatePagesRef.current.size,
          });
        } catch (err) {
          updateFetchDebug({
            status: 'page-error',
            requestId,
            requestToken,
            pageStart: range.localStartBp,
            pageEnd: range.localEndBp,
            message: err instanceof Error ? err.message : String(err),
          });
          if (import.meta.env?.DEV) {
            // eslint-disable-next-line no-console
            console.warn(`[assembly-detail] ${chrom} page fetch failed:`, err);
          }
        } finally {
          if (detailRequestTokensRef.current.get(requestKey) === requestToken) {
            detailRequestTokensRef.current.delete(requestKey);
            pendingCoordinatePageKeysRef.current.delete(requestKey);
          }
          if (registeredInflight) registry.clearInflight(chrom, requestId);
          publishDebugSnapshot();
        }
      };

      for (const range of plannedRanges) {
        const requestKey = requestKeyForRange(range);
        if (residentCoordinatePagesRef.current.has(requestKey)) {
          const existingLruIndex = residentCoordinatePageLruRef.current.indexOf(requestKey);
          if (existingLruIndex >= 0) {
            residentCoordinatePageLruRef.current.splice(existingLruIndex, 1);
          }
          residentCoordinatePageLruRef.current.push(requestKey);
        }
      }

      const runBounded = async (
        ranges: ReadonlyArray<{ localStartBp: number; localEndBp: number }>,
        concurrency: number
      ): Promise<void> => {
        let cursor = 0;
        const worker = async () => {
          while (cursor < ranges.length) {
            const range = ranges[cursor];
            cursor += 1;
            await fetchCoordinatePage(range);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(concurrency, ranges.length) }, () => worker())
        );
      };

      const visibleKeys = new Set(visibleRanges.map(requestKeyForRange));
      const visibleCenter = (localStart + localEnd) / 2;
      const visibleToFetch = visibleRanges.filter((range) => {
        const requestKey = requestKeyForRange(range);
        return (
          !residentCoordinatePagesRef.current.has(requestKey) &&
          !pendingCoordinatePageKeysRef.current.has(requestKey)
        );
      });
      const haloToFetch = plannedRanges
        .filter((range) => {
          const requestKey = requestKeyForRange(range);
          return (
            !visibleKeys.has(requestKey) &&
            !residentCoordinatePagesRef.current.has(requestKey) &&
            !pendingCoordinatePageKeysRef.current.has(requestKey)
          );
        })
        .sort(
          (left, right) =>
            Math.abs((left.localStartBp + left.localEndBp) / 2 - visibleCenter) -
            Math.abs((right.localStartBp + right.localEndBp) / 2 - visibleCenter)
        );

      const shouldPublishNow = () =>
        options.publishOnResolve !== false || presentedDetailChromsRef.current.has(chrom);
      const publishResolvedRepository = () => {
        if (epoch !== tokenRef.current || sourceIdentity !== detailPageSourceIdentityRef.current) {
          return;
        }
        if (shouldPublishNow()) {
          publishResidentDetailForChroms(presentedDetailChromsRef.current, { replace: true });
        } else {
          publishResidentCoordinateRepository();
        }
      };
      await runBounded(visibleToFetch, 2);
      if (visibleToFetch.length > 0) publishResolvedRepository();
      await runBounded(haloToFetch, 4);
      if (haloToFetch.length > 0) publishResolvedRepository();
      if (
        options.includeHalo !== false &&
        epoch === tokenRef.current &&
        sourceIdentity === detailPageSourceIdentityRef.current
      ) {
        residentCoordinateHaloReadyChromsRef.current.add(chrom);
      }
    },
    [
      compiledSceneOwnsAnnotationBody,
      publishDebugSnapshot,
      publishResidentCoordinateRepository,
      publishResidentDetailForChroms,
    ]
  );

  useEffect(() => {
    const requestToken = ++annotationSearchFocusRequestSeqRef.current;
    const focus = annotationSearchFocusSourceRef.current;
    setAnnotationSearchFocusState((previous) => (previous === null ? previous : null));
    if (!enabled || !rendererAssembly || !focus || !annotationSearchFocusSourceKey) return;
    if (
      !Number.isSafeInteger(focus.startBp) ||
      !Number.isSafeInteger(focus.endBp) ||
      focus.startBp < 0 ||
      focus.endBp <= focus.startBp ||
      !focus.trackId ||
      !focus.canonicalIdentity ||
      !focus.genomeIdentity
    ) {
      return;
    }

    const segments = globalRangeToSegments(rendererAssembly, focus.startBp, focus.endBp);
    if (segments.length !== 1) return;
    const [segment] = segments;
    if (!annotationCapableChromsRef.current.has(segment.chrom)) return;
    if (
      segment.localStart !== focus.startBp - segment.globalStart ||
      segment.localEnd !== focus.endBp - segment.globalStart
    ) {
      return;
    }

    const residentFeatures = [...residentCoordinatePagesRef.current.values()]
      .filter(
        (resident) =>
          resident.chromosomeId === segment.chrom &&
          resident.globalStartBp <= focus.startBp &&
          focus.startBp < resident.globalEndBp
      )
      .flatMap((resident) => resident.pages)
      .filter((page) => page.trackId === focus.trackId)
      .flatMap((page) => page.features);
    const residentCarrier = resolveAssemblyAnnotationSearchFocusFeatureFromFeatures({
      features: residentFeatures,
      genomeIdentity: focus.genomeIdentity,
      focus,
    });
    if (residentCarrier) {
      setAnnotationSearchFocusState({
        sourceKey: annotationSearchFocusSourceKey,
        feature: residentCarrier,
      });
      return;
    }

    const queryRanges = annotationSearchFocusQueryRanges({
      ownerStartBp: segment.localStart,
      ownerEndBp: segment.localEnd,
      chromosomeLengthBp: segment.placement.chromosome.length,
    });
    if (queryRanges.length === 0) return;

    const sourceIdentity = detailPageSourceIdentityRef.current;
    const registry = registryRef.current;
    if (!registry) return;
    let cancelled = false;
    let pendingSessionId: string | null = null;
    let pendingRequestId: string | null = null;
    const isCurrentRequest = () =>
      !cancelled &&
      requestToken === annotationSearchFocusRequestSeqRef.current &&
      sourceIdentity === detailPageSourceIdentityRef.current;

    void (async () => {
      try {
        const handle = await registry.ensure(segment.chrom);
        if (!handle || !isCurrentRequest()) return;
        pendingSessionId = handle.sessionId;
        const rawByIdentity = new Map<string, GenomeFeature>();
        let featureModel: GenomeAnnotationFeatureModel | null = null;
        for (let queryIndex = 0; queryIndex < queryRanges.length; queryIndex += 1) {
          if (!isCurrentRequest()) return;
          const queryRange = queryRanges[queryIndex];
          const requestId = `assembly-annotation-search-focus-${segment.chrom}-${requestToken}-${queryIndex}`;
          pendingRequestId = requestId;
          registry.registerInflight(segment.chrom, requestId);
          try {
            const loaded = await loadAssemblyAnnotationTileFeatures({
              sessionId: handle.sessionId,
              requestId,
              chrom: segment.chrom,
              start: queryRange.localStartBp,
              end: queryRange.localEndBp,
              lod: 1,
              generation: requestToken,
              fidelity: 'best_available',
              byteBudget: ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
              sourceFingerprint: handle.sourceFingerprint,
              visibleTypes: ANNOTATION_SOURCE_FETCH_TYPES,
              laneLimit: null,
              length: handle.manifest.length ?? segment.placement.chromosome.length,
              globalStart: segment.globalStart,
              glyphV2Enabled: glyphV2EnabledRef.current,
              transcriptDisplayMode: 'expanded',
              expandedGeneIds: EMPTY_EXPANDED,
              laneStacking: LANE_STACKING,
              maxAttempts: TILE_MAX_ATTEMPTS,
              pollMs: TILE_POLL_MS,
              requireCompleteSource: true,
              isCurrent: isCurrentRequest,
              getAnnotationTile: (sessionId, request, id) =>
                platform().genome.getAnnotationTile(sessionId, request, id),
            });
            if (!loaded || !isCurrentRequest()) return;
            const loadedModel = loaded.tile.featureModel ?? 'raw-gff3';
            if (featureModel && featureModel !== loadedModel) return;
            featureModel = loadedModel;
            for (const rawFeature of loaded.tile.features ?? []) {
              rawByIdentity.set(annotationSearchRawFeatureIdentity(rawFeature), rawFeature);
            }
          } finally {
            registry.clearInflight(segment.chrom, requestId);
            if (pendingRequestId === requestId) pendingRequestId = null;
          }
        }
        if (!featureModel || !isCurrentRequest()) return;
        const rawSourceFeatures = [...rawByIdentity.values()];
        const resolvedExpandedFeatures = resolveAnnotationFeaturesForViewer(
          rawSourceFeatures,
          featureModel,
          glyphV2EnabledRef.current
        ) as TranscriptCarrierFeature[];
        const topLevelSourceFeatures =
          featureModel === 'raw-gff3' ? resolveTranscripts(rawSourceFeatures) : rawSourceFeatures;
        const focusSourceByIdentity = new Map<string, GenomeFeature>();
        for (const feature of topLevelSourceFeatures) {
          focusSourceByIdentity.set(annotationSearchRawFeatureIdentity(feature), feature);
        }
        for (const feature of resolvedExpandedFeatures) {
          focusSourceByIdentity.set(annotationSearchRawFeatureIdentity(feature), feature);
        }
        const exactFocusSourceFeatures = [...focusSourceByIdentity.values()].filter(
          (feature) => annotationLayerType(feature) === focus.trackId
        );
        const sourceDensity = applyDensityControls(
          exactFocusSourceFeatures,
          segment.chrom,
          handle.manifest.length ?? segment.placement.chromosome.length,
          new Set([focus.trackId]),
          null,
          LANE_STACKING
        );
        const sourceFeatures = offsetFeaturesToGlobal(sourceDensity.features, segment.globalStart);
        const carrier = resolveAssemblyAnnotationSearchFocusFeatureFromFeatures({
          features: sourceFeatures,
          genomeIdentity: focus.genomeIdentity,
          focus,
        });
        if (!isCurrentRequest()) return;
        setAnnotationSearchFocusState(
          carrier
            ? {
                sourceKey: annotationSearchFocusSourceKey,
                feature: carrier,
              }
            : null
        );
      } catch (err) {
        if (!isCurrentRequest()) return;
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.warn('[assembly-annotation-search-focus] exact source fetch failed:', err);
        }
      } finally {
        pendingRequestId = null;
      }
    })();

    return () => {
      cancelled = true;
      if (!pendingSessionId || !pendingRequestId) return;
      registry.clearInflight(segment.chrom, pendingRequestId);
      void Promise.resolve(
        platform().genome.cancelRequest(pendingSessionId, pendingRequestId)
      ).catch(() => undefined);
    };
  }, [annotationSearchFocusSourceKey, detailPageSourceIdentity, enabled, rendererAssembly]);

  const fetchSequenceForChrom = useCallback(
    async (
      chrom: string,
      globalStart: number,
      localStart: number,
      localEnd: number,
      chromLength: number
    ) => {
      const registry = registryRef.current;
      if (!registry) return;
      const token = ++seqTokenRef.current;
      const center = (localStart + localEnd) / 2;
      const baseBounds = sequenceWindowRequestBounds({
        centerBp: center,
        viewportRange: { start: localStart, end: localEnd },
        length: chromLength,
      });
      const { startBp, endBp } = expandSequenceWindowBounds({
        ...baseBounds,
        centerBp: center,
        length: chromLength,
      });
      if (endBp <= startBp) return;
      const requestId = `assembly-seq-${chrom}-${token}`;
      registry.registerInflight(chrom, requestId);
      seqPendingCoverageRef.current.set(chrom, {
        startBp: startBp + globalStart,
        endBp: endBp + globalStart,
        token,
        requestId,
      });
      try {
        const handle = await registry.ensure(chrom);
        if (!handle || token !== seqTokenRef.current) return;
        const window = await platform().genome.getSequenceWindow(
          handle.sessionId,
          { chrom, start: startBp, end: endBp, generation: token },
          requestId
        );
        if (token !== seqTokenRef.current) return;
        if (!window || !window.bases || window.bases.length === 0) return;
        const local: AssemblySequenceWindow = {
          startBp: window.start,
          endBp: window.end,
          generation: window.generation,
          byteCount: window.byteCount,
          bases: window.bases,
        };
        seqCoverageRef.current.clear();
        seqCoverageRef.current.set(chrom, {
          startBp: window.start + globalStart,
          endBp: window.end + globalStart,
        });
        setSequenceWindow(offsetSequenceWindowToGlobal(local, globalStart));
      } catch (err) {
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.warn(`[assembly-seq] ${chrom} sequence window failed:`, err);
        }
      } finally {
        const pending = seqPendingCoverageRef.current.get(chrom);
        if (pending?.requestId === requestId) seqPendingCoverageRef.current.delete(chrom);
        registry.clearInflight(chrom, requestId);
      }
    },
    []
  );

  const onCamera = useCallback(
    (viewportRange: { start: number; end: number } | null, opts?: { immediate?: boolean }) => {
      if (
        assemblyCameraIsUnready({
          enabled,
          hasAssembly: Boolean(rendererAssembly),
          hasViewportRange: Boolean(viewportRange),
        })
      ) {
        recordDecision({
          kind: 'skip-prereq',
          enabled,
          hasAssembly: Boolean(rendererAssembly),
          hasViewportRange: Boolean(viewportRange),
        });
        return;
      }
      if (!rendererAssembly || !viewportRange) return;
      const immediate = opts?.immediate ?? false;
      latestCoordinateProtectedKeysRef.current.clear();
      const visibleBp = viewportRange.end - viewportRange.start;
      const widthPx = Math.max(0, containerWidth);
      const clearLoadedDetail = () => {
        tokenRef.current += 1;
        detailRequestTokensRef.current.clear();
        pendingCoordinatePageKeysRef.current.clear();
        overviewSummaryRequestTokensRef.current.clear();
        seqTokenRef.current += 1;
        activeChromRef.current = null;
        presentedDetailChromsRef.current = new Set();
        presentedOverviewChromsRef.current = new Set();
        overviewSummaryCoverageRef.current.clear();
        overviewSummaryPendingCoverageRef.current.clear();
        residentOverviewSummaryRef.current.clear();
        seqCoverageRef.current.clear();
        setDetailByChrom((prev) => (prev.size === 0 ? prev : new Map()));
        setSequenceWindow((prev) => (prev === null ? prev : null));
      };
      if (widthPx <= 0) {
        recordDecision({
          kind: 'skip-width',
          containerWidth,
          visibleBp,
          viewportRange,
        });
        clearLoadedDetail();
        return;
      }
      const pixelsPerBp = visibleBp > 0 ? widthPx / visibleBp : null;
      const lod = lodTierForViewport({
        visibleBp,
        pixelsPerBp,
        compiledBroadSurface:
          annotationTierOwnership.broadOwner === 'compiled-broad-raster'
            ? {
                broadCorridorFinestSpanBp: annotationTierOwnership.broadCorridorFinestSpanBp,
                viewportCssWidthPx: widthPx,
                devicePixelRatio:
                  typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1),
                residentSceneCoversViewport: annotationTierOwnership.residentSceneCoversViewport,
              }
            : null,
      });
      const cameraAllowsDetailWork = assemblyCameraAllowsDetailWork({
        fetchAnnotationTile: lod.fetchAnnotationTile,
        prefetchCodonCarrierPages: lod.prefetchCodonCarrierPages,
        compiledSceneOwnsAnnotationBody,
        visibleBp,
      });
      const leftDetailWorkCorridor =
        lastCameraAllowsDetailWorkRef.current && !cameraAllowsDetailWork;
      lastCameraAllowsDetailWorkRef.current = cameraAllowsDetailWork;
      lastCameraUsesDetailRef.current = lod.fetchAnnotationTile;

      if (leftDetailWorkCorridor) {
        tokenRef.current += 1;
        detailRequestTokensRef.current.clear();
        pendingCoordinatePageKeysRef.current.clear();
        registryRef.current?.cancelInflightOutside(NO_VISIBLE_CHROMS);
      }

      if (!immediate && cameraAllowsDetailWork) publishResidentCoordinateRepository();

      const visibleSegments = globalRangeToSegments(
        rendererAssembly,
        viewportRange.start,
        viewportRange.end
      );
      if (visibleSegments.length === 0) {
        recordDecision({
          kind: 'skip-no-segments',
          containerWidth,
          visibleBp,
          pixelsPerBp,
          viewportRange,
        });
        return;
      }

      const center = (viewportRange.start + viewportRange.end) / 2;
      const locus = globalBpToChrom(rendererAssembly, center);
      if (!locus) {
        recordDecision({
          kind: 'skip-no-locus',
          containerWidth,
          visibleBp,
          pixelsPerBp,
          viewportRange,
          center,
          segmentChroms: visibleSegments.map((segment) => segment.chrom),
        });
        return;
      }
      const chrom = locus.chrom;
      const activeSegment = visibleSegments.find((segment) => segment.chrom === chrom);
      if (!activeSegment) {
        recordDecision({
          kind: 'skip-no-active-segment',
          containerWidth,
          visibleBp,
          pixelsPerBp,
          viewportRange,
          chrom,
          segmentChroms: visibleSegments.map((segment) => segment.chrom),
        });
        return;
      }
      const globalStart = activeSegment.globalStart;
      const localStart = activeSegment.localStart;
      const localEnd = activeSegment.localEnd;
      if (localEnd <= localStart) {
        recordDecision({
          kind: 'skip-empty-active-segment',
          containerWidth,
          visibleBp,
          pixelsPerBp,
          viewportRange,
          chrom,
          localStart,
          localEnd,
        });
        return;
      }

      const visibleChroms = new Set(visibleSegments.map((segment) => segment.chrom));
      const annotationVisibleSegments = visibleSegments.filter((segment) =>
        annotationCapableChromsRef.current.has(segment.chrom)
      );
      const annotationVisibleChroms = new Set(
        annotationVisibleSegments.map((segment) => segment.chrom)
      );
      if (activeChromRef.current !== null && activeChromRef.current !== chrom) {
        seqTokenRef.current += 1;
        seqPendingCoverageRef.current.clear();
      }
      activeChromRef.current = chrom;

      registryRef.current?.cancelInflightOutside(visibleChroms);
      const wantNucleotides = lod.streamNucleotides;
      const chromLength = activeSegment.placement.chromosome.length;
      const activeGlobalStart = activeSegment.globalStart + activeSegment.localStart;
      const activeGlobalEnd = activeSegment.globalStart + activeSegment.localEnd;
      if (!wantNucleotides) {
        seqTokenRef.current += 1;
        setSequenceWindow((prev) => (prev === null ? prev : null));
        seqCoverageRef.current.clear();
        seqPendingCoverageRef.current.clear();
      }
      const chromosomeDomain = {
        startBp: activeSegment.globalStart,
        endBp: activeSegment.globalStart + chromLength,
      };
      const seqCovered = rangeCovered(
        seqCoverageRef.current.get(chrom),
        activeGlobalStart,
        activeGlobalEnd,
        SEQ_REFETCH_GUARD_BP,
        chromosomeDomain
      );
      const seqPending = rangeCovered(
        seqPendingCoverageRef.current.get(chrom),
        activeGlobalStart,
        activeGlobalEnd,
        SEQ_REFETCH_GUARD_BP,
        chromosomeDomain
      );
      if (seqCovered && !seqPending && seqPendingCoverageRef.current.has(chrom)) {
        seqTokenRef.current += 1;
        seqPendingCoverageRef.current.clear();
      }
      if (wantNucleotides && !seqCovered && !seqPending) {
        void fetchSequenceForChrom(chrom, globalStart, localStart, localEnd, chromLength);
      }

      if (!lod.fetchAnnotationTile) {
        if (compiledBroadOwnsOverview || overviewFeaturesComplete) {
          overviewSummaryRequestTokensRef.current.clear();
          overviewSummaryPendingCoverageRef.current.clear();
          presentedDetailChromsRef.current = new Set();
          presentedOverviewChromsRef.current = new Set();
          setDetailByChrom((prev) => (prev.size === 0 ? prev : new Map()));
          const shouldPrepareCoordinatePages = compiledSceneOwnsAnnotationBody
            ? lod.prefetchCodonCarrierPages
            : visibleBp <= ANNOTATION_DETAIL_PREFETCH_MAX_BP;
          const detailPrefetchSegments = shouldPrepareCoordinatePages
            ? annotationVisibleSegments.filter((segment) => {
                return !detailSegmentPageState(segment, { includeHalo: !immediate })
                  .residentOrPending;
              })
            : [];
          recordDecision({
            kind: compiledBroadOwnsOverview
              ? lod.annotationRepresentation === 'compiled-broad'
                ? 'overview-compiled-broad'
                : lod.annotationRepresentation === 'compiled-transition-hold'
                  ? 'overview-compiled-transition-hold'
                  : 'overview-compiled-resident-scene'
              : 'overview-primary-complete',
            containerWidth,
            visibleBp,
            pixelsPerBp,
            lod,
            viewportRange,
            chrom,
            overviewFeaturesComplete,
            annotationTierOwnership,
            wantNucleotides,
            seqCovered,
            seqPending,
            detailPrefetchCovered:
              shouldPrepareCoordinatePages && detailPrefetchSegments.length === 0,
            detailPrefetchSegments: detailPrefetchSegments.map((segment) => segment.chrom),
            routerRasterOwns: isGenomeWideRasterAnnotationOwner({
              genomeLength: rendererAssembly.totalLengthBp,
              viewStartBp: viewportRange.start,
              viewEndBp: viewportRange.end,
            }),
            ownershipThresholds: ANNOTATION_OWNERSHIP_THRESHOLD_DIAGNOSTIC,
          });
          for (const segment of detailPrefetchSegments) {
            void fetchDetailForChrom(
              segment.chrom,
              segment.globalStart,
              segment.localStart,
              segment.localEnd,
              segment.placement.chromosome.length,
              { publishOnResolve: false, includeHalo: !immediate }
            );
          }
          return;
        }

        const genomeWideRasterOwns = isGenomeWideRasterAnnotationOwner({
          genomeLength: rendererAssembly.totalLengthBp,
          viewStartBp: viewportRange.start,
          viewEndBp: viewportRange.end,
        });
        if (genomeWideRasterOwns) {
          presentedDetailChromsRef.current = new Set();
          presentedOverviewChromsRef.current = new Set();
          setDetailByChrom((prev) => (prev.size === 0 ? prev : new Map()));
          recordDecision({
            kind: 'overview-genome-wide-raster',
            containerWidth,
            visibleBp,
            pixelsPerBp,
            lod,
            viewportRange,
            chrom,
          });
          return;
        }

        presentedDetailChromsRef.current = new Set();
        presentedOverviewChromsRef.current = annotationVisibleChroms;
        publishResidentOverviewForSegments(annotationVisibleSegments);

        const summarySegmentsToFetch = annotationVisibleSegments.filter((segment) => {
          const chromStart = segment.globalStart;
          const chromEnd = segment.globalStart + segment.placement.chromosome.length;
          const covered = rangeCovered(
            overviewSummaryCoverageRef.current.get(segment.chrom),
            chromStart,
            chromEnd,
            0
          );
          const pending = rangeCovered(
            overviewSummaryPendingCoverageRef.current.get(segment.chrom),
            chromStart,
            chromEnd,
            0
          );
          return !covered && !pending;
        });
        const detailPrefetchCovered = detailSegmentPageState(activeSegment, {
          includeHalo: !immediate,
        }).residentOrPending;
        recordDecision({
          kind:
            summarySegmentsToFetch.length === 0
              ? 'overview-summary-covered'
              : 'overview-summary-fetch',
          containerWidth,
          visibleBp,
          pixelsPerBp,
          lod,
          viewportRange,
          chrom,
          summarySegmentsToFetch: summarySegmentsToFetch.map((segment) => segment.chrom),
          detailPrefetchCovered,
        });
        for (const segment of summarySegmentsToFetch) {
          void fetchOverviewSummaryForChrom(
            segment.chrom,
            segment.globalStart,
            segment.placement.chromosome.length
          );
        }
        if (visibleBp <= ANNOTATION_DETAIL_PREFETCH_MAX_BP && !detailPrefetchCovered) {
          void fetchDetailForChrom(
            chrom,
            activeSegment.globalStart,
            locus.localBp,
            locus.localBp + 1,
            activeSegment.placement.chromosome.length,
            { publishOnResolve: false, includeHalo: !immediate }
          );
        }
        return;
      }

      const detailPublicationRosterChanged =
        presentedDetailChromsRef.current.size !== annotationVisibleChroms.size ||
        [...annotationVisibleChroms].some(
          (visibleChrom) => !presentedDetailChromsRef.current.has(visibleChrom)
        );
      presentedDetailChromsRef.current = annotationVisibleChroms;
      presentedOverviewChromsRef.current = new Set();
      if (!immediate || detailPublicationRosterChanged) {
        publishResidentDetailForSegments(annotationVisibleSegments, { replace: true });
      }

      const detailSegmentsToFetch = annotationVisibleSegments.filter((segment) => {
        return !detailSegmentPageState(segment, { includeHalo: !immediate }).residentOrPending;
      });
      const detailCovered = detailSegmentsToFetch.length === 0;
      if (immediate) {
        recordDecision({
          kind: 'immediate-prefetch',
          containerWidth,
          visibleBp,
          pixelsPerBp,
          viewportRange,
          chrom,
          detailSegmentsToFetch: detailSegmentsToFetch.map((segment) => segment.chrom),
          wantNucleotides,
          seqCovered,
          seqPending,
        });
        for (const segment of detailSegmentsToFetch) {
          void fetchDetailForChrom(
            segment.chrom,
            segment.globalStart,
            segment.localStart,
            segment.localEnd,
            segment.placement.chromosome.length,
            { includeHalo: false }
          );
        }
        return;
      }

      if (detailCovered && (!wantNucleotides || seqCovered || seqPending)) {
        recordDecision({
          kind: 'covered',
          containerWidth,
          visibleBp,
          pixelsPerBp,
          viewportRange,
          chrom,
          wantNucleotides,
          seqCovered,
          seqPending,
        });
        return;
      }
      recordDecision({
        kind: 'fetch-detail',
        containerWidth,
        visibleBp,
        pixelsPerBp,
        viewportRange,
        chrom,
        detailSegmentsToFetch: detailSegmentsToFetch.map((segment) => segment.chrom),
        wantNucleotides,
        seqCovered,
        seqPending,
      });

      for (const segment of detailSegmentsToFetch) {
        void fetchDetailForChrom(
          segment.chrom,
          segment.globalStart,
          segment.localStart,
          segment.localEnd,
          segment.placement.chromosome.length
        );
      }
    },
    [
      enabled,
      rendererAssembly,
      containerWidth,
      fetchDetailForChrom,
      fetchSequenceForChrom,
      annotationTierOwnership,
      compiledBroadOwnsOverview,
      compiledSceneOwnsAnnotationBody,
      overviewFeaturesComplete,
      detailSegmentPageState,
      publishResidentCoordinateRepository,
      publishResidentDetailForSegments,
      recordDecision,
    ]
  );

  useEffect(() => {
    publishDebugSnapshot();
  }, [detailByChrom, sequenceWindow, publishDebugSnapshot]);

  const ensureSessionForChrom = useCallback(
    async (chrom: string): Promise<{ sessionId: string } | null> => {
      const registry = registryRef.current;
      if (!registry) return null;
      const handle = await registry.ensure(chrom);
      if (!handle) return null;
      return { sessionId: handle.sessionId };
    },
    []
  );

  return {
    detailByChrom,
    exactDetailCoverageByChrom,
    annotationPages,
    annotationSearchFocusFeature,
    annotationSourcePageStreamKey: ANNOTATION_SOURCE_PAGE_ARTIFACT,
    annotationProjectionPolicy,
    sequenceWindow,
    onCamera,
    ensureSessionForChrom,
  };
}
