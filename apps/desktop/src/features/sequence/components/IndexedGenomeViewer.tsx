import type { SequenceDataLayerProjectionProps } from './sequence-data-layer-props';
import { comparisonTargetViewport } from '../comparison-projection-navigation';
import type { ComparisonProjectionProps } from './comparison-projection-props';
import type { ContactProjectionProps } from './contact-projection-props';
import { toUserMessage } from '@waypoint/user-messages';
import { assemblyContigNaming } from '../contig-name-map';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type {
  GenomeFeature,
  IndexedGenomeManifest,
  TrackAdmissionRequestV1,
} from '@waypoint/genome-data';
import {
  assemblyCompiledBroadRasterFinestSpanBpV1,
  type AssemblyAnnotationSceneSourceRequest,
  type AssemblyReferenceAssetGenerationV1,
  type GenomeAnnotationFeatureModel,
  type GenomeTrackDescriptor,
  type GenomeTileCacheState,
  type GenomeTrackTile,
} from '../../../shared/indexed-genome';

import { platform } from '../../../platform';
import { rendererInteractionQuietDelayMs } from '../../../lib/renderer-interaction-activity';
import { shouldEnableTestBridge } from '../../../lib/test-bridge-gate';
import {
  installAssemblyAnnotationPolicyTestBridge,
  type AssemblyAnnotationPolicyBridgeTarget,
} from '../../../test/assembly-annotation-policy-bridge';
import { isTranscriptGlyphV2Enabled } from '../transcript-glyph-flag';
import {
  annotationLayerType,
  selectableAnnotationLayerTypesForGlyphMode,
} from '../annotation-layer-identity';
import {
  defaultVisibleAnnotationTypes,
  toggleAnnotationLaneVisible,
  toggleVisibleFeatureType,
  visibleTypesForGlyphMode,
} from './indexed-genome-viewer-controls';
import {
  clampSequenceBp,
  normalizeSequenceViewportRange,
  type SequenceViewportRange,
  type SequenceWindowPending,
} from './indexed-sequence-window-policy';
import {
  applyIndexedGenomeSequenceWindowCameraDecision,
  processIndexedGenomeAssemblyCameraChange,
  resolveIndexedGenomeSequenceWindowCameraChange,
  type IndexedGenomeSequenceWindowCameraHost,
} from './indexed-genome-sequence-window-camera';
import {
  type AnnotationViewportTileState,
  isPendingAnnotationTileState,
  retainAnnotationViewportTiles,
  sameStringArray,
  sceneViewportPublicationKey,
  sequenceViewportRangesEqual,
  uniqueSorted,
} from './indexed-genome-viewer-viewport';
import { type AnnotationTilePending } from './indexed-annotation-tile-policy';
import { selectActiveAnnotationViewportTile } from './annotation-viewport-tile-selection';
import {
  applyDensityControls,
  pickSpliceDemoFeature,
  uniqueFeatureTypes,
  type LaneLimit,
  type TranscriptCarrierFeature,
} from './indexed-genome-legacy-adapter';
import {
  deriveAnnotationTrackRegistry,
  type AnnotationTrackPreferences,
} from '../annotation-track-registry';
import { type AnnotationIndex } from '../genome-annotation-index';
import {
  deriveAnnotationSearchReveal,
  persistTemporarilyRevealedTrack,
} from '../annotation-search-reveal';
import {
  resolveAssemblyAnnotationSearchFocusFeature,
  resolveSingleChromosomeAnnotationSearchFocusCarrier,
} from './indexed-genome-annotation-search-identity';
import {
  compiledAnnotationBroadSetIsInteractive,
  compiledAnnotationDetailSetIsPrepared,
  qualifyCompiledAnnotationInteractionAuthority,
} from './compiled-annotation-interaction-authority';

import {
  ANNOTATION_LANE_STACKING_BY_TYPE,
  annotationGlyphPayloadCount,
} from './indexed-genome-compatibility-scene';
import { type IndexedGenomeCompatibilityProjection } from './IndexedGenomeCompatibilityScene';
import { isQuantitativeDataset } from './IndexedQuantitativeTrackAxes';
import {
  evaluateIndexedGenomeSceneInvariants,
  indexedGenomeSceneHasWholeFeaturePayload,
  type IndexedGenomeScene,
  type IndexedGenomeSceneInvariantReport,
} from './indexed-genome-scene';
import { type InvariantViolation } from './annotation-rendering-invariants';
import { buildAnnotationTileRequest } from './indexed-annotation-tile-request';
import { pollAnnotationSummaryTile } from './pollAnnotationSummaryTile';
import {
  ANNOTATION_VIEWPORT_TILE_COALESCE_MS,
  IndexedGenomeCameraTileDispatcher,
  type IndexedGenomeCameraTileHost,
} from './indexed-genome-camera-tile-dispatcher';
import { sourceFingerprintForManifest } from './indexed-genome-viewer-scene-state';
import {
  type IndexedGenomeContextMenuHandler,
  type IndexedGenomeSelectionChangeHandler,
  type IndexedGenomeSelectedAnnotation,
  type IndexedGenomeTileNativeMapHandle,
} from './IndexedGenomeTileNativeMap';
import type { IndexedSequenceOverlays } from './indexed-sequence-overlays';
import {
  assemblyAnnotationLayerTypes,
  hasCompleteIndexedAssemblyOverview,
} from './assembly-renderer-genome';
import {
  buildRendererFeatureLaneSamples,
  findCdsLociFromRendererFeatures,
  findFeatureStructuresFromRendererFeatures,
  type DebugCdsLocus,
  type RendererFeatureLaneSample,
  type RendererFeatureStructureSnapshot,
} from './indexed-genome-debug-snapshot';
import { useLaneScreenBands } from './useLaneScreenBands';
import { useBamTrackImport } from './useBamTrackImport';
import {
  COMPILED_BROAD_ANNOTATION_INTERACTION_AUTHORITY_SNAPSHOT_V1,
  PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP,
  resolveAnnotationTrackIdentity,
  type Assembly,
  type Feature,
  type Genome,
} from '@waypoint/genome-renderer';
import type { GenomeAssembly } from '@waypoint/genome-data';
import {
  useAssemblySegmentRouter,
  type AssemblyAnnotationTierOwnership,
} from './useAssemblySegmentRouter';
import {
  filterAnnotationPresentationPagesForCodonCarriers,
  mergeAnnotationPageCoverage,
} from './assembly-annotation-resident-pages';
import {
  annotationRoutingRedriveGeneration,
  compiledViewportDetailRosterCoversViewportV1,
} from './assembly-lod-policy';
import type { AssemblySessionChromConfig } from './assembly-session-registry';
import type {
  AssemblyOverviewTexture,
  AssemblyOverviewTextureStatus,
} from './useAssemblyOverviewTexture';
import {
  type CompiledBroadTrackReadinessReceipt,
  type IndexedGenomeAnnotationMapperPolicy,
} from './AssemblyCompiledAnnotationTrack';
import {
  activeAnnotationSourcePlacementProvenance,
  assemblyReferenceAssetGenerationKey,
  NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE,
  type AssemblyPrepackedAnnotationSceneCacheState,
} from './useAssemblyPrepackedAnnotationSceneCache';
import {
  readActivePrepackedAnnotationSceneOwnerOracle,
  type PrepackedAssemblyAnnotationScenePresentationReceipt,
  usePrepackedAssemblyAnnotationScene,
} from './usePrepackedAssemblyAnnotationScene';
import { resolveRendererAssembly } from './renderer-assembly-projection';
import {
  LEGACY_BUCKET,
  useLaneContractStore,
  type ActiveStressDataset,
  type Lane,
} from '../lane-contract-store';
import { syncAnnotationTilePyramidRendererFlag } from '../annotation-tile-pyramid-flag';
import { useIndexedPileupStreaming } from './useIndexedPileupStreaming';
import { useIndexedLaneContractTracks } from './useIndexedLaneContractTracks';
import { useIndexedUcscTrackStreaming } from './useIndexedUcscTrackStreaming';
import { useExperimentalHybridPileupStreaming } from './useExperimentalHybridPileupStreaming';
import {
  buildExperimentalHybridStreamingLanes,
  buildPileupReadSourcesByTrackId,
  deriveExperimentalHybridPileupLanes,
} from '../experimental-hybrid-pileup';
import { useIndexedFeatureDetails, type FeatureDetailsState } from './useIndexedFeatureDetails';
import {
  type AnnotationResidentPagePublicationCandidate,
  type AnnotationPresentationSnapshotCandidate,
  useAnnotationResidentPagePublication,
  useAnnotationPresentationSnapshot,
} from './useAnnotationPresentationSnapshot';

import { usePrebuiltAssemblyOverviewTexture } from './usePrebuiltAssemblyOverviewTexture';
import {
  isExactActiveMrnaPresentation,
  type AssemblyAnnotationPolicyPreparationPublication,
} from './assembly-annotation-policy-transaction';
import { useAnnotationPyramidInventory } from './useAnnotationPyramidInventory';
import type {
  AssemblyCompiledBroadRasterLoaderDiagnosticsV1,
  AssemblyCompiledBroadRasterPolicyCommitReceiptV1,
} from './assembly-compiled-broad-raster-loader';
import {
  clampAnnotationMapperPolicyToLaneCapability,
  sameAnnotationMapperPolicy,
  useIndexedAnnotationMapperPolicy,
} from './useIndexedAnnotationMapperPolicy';
import {
  admittedAnnotationSceneSourceIdentity,
  admittedAnnotationSourceFingerprint as resolveAdmittedAnnotationSourceFingerprint,
  annotationPreparationUiState as resolveAnnotationPreparationUiState,
  annotationPresentationPolicyKey as resolveAnnotationPresentationPolicyKey,
  annotationPresentationSnapshotForMap as resolveAnnotationPresentationSnapshotForMap,
  annotationPresentationSourceIdentity as resolveAnnotationPresentationSourceIdentity,
  annotationResidentPagePublicationForMap as resolveAnnotationResidentPagePublicationForMap,
  assemblyDisplayName,
  assemblyShellAnnotationSourcePlacementProvenance as resolveAssemblyShellAnnotationSourcePlacementProvenance,
  atomicAnnotationRasterRequest as resolveAtomicAnnotationRasterRequest,
  compiledBroadBootstrapTrackType as resolveCompiledBroadBootstrapTrackType,
  compiledBroadMaxSupportedFiniteLaneLimit,
  compiledBroadOverviewTexture,
  compiledBroadOverviewTextureStatus,
  compiledBroadOwnsSceneViewport as resolveCompiledBroadOwnsSceneViewport,
  compiledBroadRasterSourceRequest as resolveCompiledBroadRasterSourceRequest,
  compiledBroadRasterThemeMode as resolveCompiledBroadRasterThemeMode,
  compiledBroadSelectedTargetRosterKey as resolveCompiledBroadSelectedTargetRosterKey,
  compiledResidentOwnerReadinessScopeKey as resolveCompiledResidentOwnerReadinessScopeKey,
  compatibilityProjectionFields,
  createIndexedGenomeViewerInstanceId,
  descriptorAnnotationSourceIdentity,
  isActivePrepackedMrnaPresentation,
  isCompiledBroadOwnedAssembly,
  isExactMrnaLayerContract,
  isIndexedGenomeAnnotationOwnerPending,
  isIndexedGenomeAssemblyRoutingEnabled,
  isPendingAnnotationRasterReady,
  laneAssemblyId as resolveLaneAssemblyId,
  livePresentedPrepackedOwnerMatch as resolveLivePresentedPrepackedOwnerMatch,
  nextRetainedAnnotationSourceIdentity,
  overviewAnnotationAuthorityComplete as resolveOverviewAnnotationAuthorityComplete,
  pendingAnnotationMapperPolicyRequestId,
  pendingAnnotationMapperPolicyValue,
  pendingAnnotationRasterCommitted as resolvePendingAnnotationRasterCommitted,
  pendingAnnotationTargetCache as resolvePendingAnnotationTargetCache,
  prepackedSceneEffectiveLayerTypes,
  presentationAnnotationMapperPolicy as resolvePresentationAnnotationMapperPolicy,
  presentationCacheForCompiledBroad as resolvePresentationCache,
  presentationPolicyRequestId as resolvePresentationPolicyRequestId,
  presentedPrepackedReceipt,
  presentedPrepackedRendererEpoch,
  rendererAnnotationSearchFocusForMap as resolveRendererAnnotationSearchFocusForMap,
  rendererGenomeForMap as resolveRendererGenomeForMap,
  rendererGenomeSourceIdentity as resolveRendererGenomeSourceIdentity,
  residentCoordinatePagesCoverSceneViewport as resolveResidentCoordinatePagesCoverSceneViewport,
  retainCompiledBroadTrackMountTypes,
  retainedAssemblyAnnotationTrackTypes as resolveRetainedAssemblyAnnotationTrackTypes,
  sceneAnnotationViewportTileForAssembly,
  sceneAnnotationViewportTilesForAssembly,
  shouldClearCompatibilityProjection,
  stickyActivatedTick,
  stickyTrue,
  suppliedOrLocalAnnotationMapperPolicy,
  type RetainedAssemblyAnnotationSourceIdentity,
} from './indexed-genome-viewer-presentation';
import { IndexedGenomeViewerSurface } from './IndexedGenomeViewerSurface';

export type { IndexedGenomeAnnotationMapperPolicy };

interface CompiledAnnotationResidentReadinessSnapshot {
  readonly contract: 'compiled-annotation-resident-readiness.v1';
  readonly readinessScopeKey: string;
  readonly selectedTrackTypes: readonly string[];
  readonly selectedSetPrepared: boolean;
  readonly selectedBroadSetInteractive: boolean;
  readonly tracks: ReadonlyArray<
    Readonly<{ trackType: string } & CompiledBroadTrackReadinessReceipt>
  >;
}

type LivePrepackedAnnotationOwnerReader = {
  getPrepackedAnnotationSceneOwnerSnapshot?: () => {
    ownerKey: string | null;
    loaded: boolean;
    gpuPrepared: boolean;
    metadata: PrepackedAssemblyAnnotationScenePresentationReceipt['metadata'] | null;
    runtimePolicy?: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null } | null;
  };
};

type LiveCompiledBroadRasterVisualReader = {
  getColdGestureSnapshot?: (trackId: string) => {
    annotation?: {
      compiledBroadRasterVisible?: boolean;
      compiledBroadRasterProvenanceValid?: boolean;
      compiledBroadRasterPlanStatus?: string;
    };
  };
};

type LiveCompiledAnnotationInteractionReader = {
  getCompiledBroadAnnotationInteractionAuthoritySnapshot?: () => {
    contract: typeof COMPILED_BROAD_ANNOTATION_INTERACTION_AUTHORITY_SNAPSHOT_V1;
    residentGeneration: number;
    preparedOwnerKeys: readonly string[];
  };
};

function liveRendererHasPresentedCompiledBroadRaster(
  handle: IndexedGenomeTileNativeMapHandle | null
): boolean {
  const renderer = handle?.getLinearRenderer?.() as LiveCompiledBroadRasterVisualReader | null;
  if (typeof renderer?.getColdGestureSnapshot !== 'function') return false;
  try {
    const annotation = renderer.getColdGestureSnapshot('').annotation;
    return Boolean(
      annotation?.compiledBroadRasterPlanStatus === 'detail-required' ||
      (annotation?.compiledBroadRasterVisible && annotation.compiledBroadRasterProvenanceValid)
    );
  } catch {
    return false;
  }
}

function liveRendererMatchesPrepackedPresentation(
  handle: IndexedGenomeTileNativeMapHandle | null,
  receipt: PrepackedAssemblyAnnotationScenePresentationReceipt
): boolean | null {
  const renderer = handle?.getLinearRenderer?.() as LivePrepackedAnnotationOwnerReader | null;
  if (!renderer) return false;
  if (typeof renderer.getPrepackedAnnotationSceneOwnerSnapshot !== 'function') return null;
  let owner: ReturnType<
    NonNullable<LivePrepackedAnnotationOwnerReader['getPrepackedAnnotationSceneOwnerSnapshot']>
  >;
  try {
    owner = renderer.getPrepackedAnnotationSceneOwnerSnapshot();
  } catch {
    return false;
  }
  const actual = owner.metadata;
  const expected = receipt.metadata;
  return Boolean(
    owner.loaded &&
    owner.gpuPrepared &&
    owner.ownerKey === receipt.ownerKey &&
    actual &&
    actual.genomeIdentity === expected.genomeIdentity &&
    actual.genomeLengthBp === expected.genomeLengthBp &&
    actual.partitionSpanBp === expected.partitionSpanBp &&
    actual.artifactKey === expected.artifactKey &&
    actual.themeMode === expected.themeMode &&
    actual.trackType === expected.trackType &&
    actual.annotationBarHeightPx === expected.annotationBarHeightPx &&
    actual.laneAlgorithmToken === expected.laneAlgorithmToken &&
    actual.mapperContractToken === expected.mapperContractToken &&
    actual.geometryContractToken === expected.geometryContractToken &&
    actual.interactionContractToken === expected.interactionContractToken &&
    owner.runtimePolicy?.isoformMode === receipt.runtimePolicy.isoformMode &&
    owner.runtimePolicy?.laneLimit === receipt.runtimePolicy.laneLimit
  );
}

const EMPTY_TRACK_LANES: ReadonlyArray<Lane> = [];

interface IndexedGenomeViewerProps
  extends ContactProjectionProps, ComparisonProjectionProps, SequenceDataLayerProjectionProps {
  laneOwnerId?: string;
  allowAutomaticSignalReadPileupViews?: boolean;
  onAddVariantTrackRequest?: (request: TrackAdmissionRequestV1) => Promise<void>;
  onOpenMutationNavigator?: () => void;
  manifest: IndexedGenomeManifest;
  sessionId?: string;
  themeMode?: 'light' | 'dark';
  length: number;
  height?: number;
  isActive?: boolean;
  targetViewport?: { id: number; start: number; end: number } | null;
  onTargetViewportCommitted?: (viewport: { id: number; start: number; end: number }) => void;
  onViewportPresented?: (sessionId: string, commandId: number | null) => void;
  searchHighlight?: {
    id: number;
    start: number;
    end: number;
    featureType?: string;
    annotationTrackId?: string;
    canonicalIdentity?: string;
    annotationFeatureIndex?: number;
    proteinSegments?: ReadonlyArray<Readonly<{ start: number; end: number }>>;
  } | null;
  onContextMenu?: IndexedGenomeContextMenuHandler;
  onSelectionChange?: IndexedGenomeSelectionChangeHandler;
  onSelectionClear?: () => void;
  sequenceOverlays?: IndexedSequenceOverlays;
  onCameraSample?: (range: Readonly<{ start: number; end: number }>) => void;
  userAnnotationDataset?: ActiveStressDataset | null;
  onViewportRangeChange?: (range: SequenceViewportRange | null) => void;
  onAnnotationIndexBuilt?: (index: AnnotationIndex | null) => void;
  onVisibleAnnotationTypesChange?: (types: ReadonlySet<string>) => void;
  onAnnotationTrackOrderChange?: (orderedTrackIds: ReadonlyArray<string>) => void;
  annotationVisibilityCommand?: Readonly<{
    id: string;
    visibleTrackIds: ReadonlyArray<string>;
    orderedTrackIds: ReadonlyArray<string>;
  }> | null;
  onLoadPhase?: (phase: 'loading' | 'ready' | 'error', message?: string) => void;
  onTrackError?: (kind: GenomeTrackDescriptor['kind'], message: string) => void;
  onTrackReady?: (kind: GenomeTrackDescriptor['kind']) => void;
  onFeatureDetailsStateChange?: (state: FeatureDetailsState) => void;
  assemblyChromIds?: ReadonlyArray<string>;
  assemblyDefinition?: GenomeAssembly;
  trackAssemblyId?: string;
  chromGffPaths?: ReadonlyMap<string, string>;
  scope?: 'all' | 'chromosome' | 'locus';
  assemblyFeatures?: ReadonlyArray<Feature>;
  assemblyByChrom?: ReadonlyMap<string, ReadonlyArray<Feature>>;
  assemblyAnnotationTrackTypes?: ReadonlyArray<string>;
  assemblySessionConfigs?: ReadonlyArray<AssemblySessionChromConfig>;
  overviewTexture?: AssemblyOverviewTexture | null;
  overviewTextureStatus?: AssemblyOverviewTextureStatus;
  annotationSceneSourceRequest?: AssemblyAnnotationSceneSourceRequest | null;
  prepackedAnnotationSceneCache?: AssemblyPrepackedAnnotationSceneCacheState;
  annotationAssetGeneration?: AssemblyReferenceAssetGenerationV1 | null;
  annotationProductPublicationReady?: boolean;
  annotationInteractionPayloadEnabled?: boolean;
  annotationInteractionPreparationGeneration?: number;
  annotationMapperPolicy?: IndexedGenomeAnnotationMapperPolicy;
  onAnnotationMapperPolicyChange?: (policy: IndexedGenomeAnnotationMapperPolicy) => void;
  allocateAnnotationMapperPolicyRequestId?: () => number;
  onAnnotationMapperPolicyPreparationRequest?: (
    publication: AssemblyAnnotationPolicyPreparationPublication
  ) => void;
  annotationMapperPolicyRasterPreparation?: {
    requestId: number;
    policy: IndexedGenomeAnnotationMapperPolicy;
    status: 'loading' | 'ready' | 'miss' | 'error';
  } | null;
  onPrepackedAnnotationScenePresented?: (
    receipt: PrepackedAssemblyAnnotationScenePresentationReceipt
  ) => void;
  onCompiledBroadRasterVisualReady?: () => void;
  requireFullAssemblyReadiness?: boolean;
}

export function deriveCompiledBroadTrackMountScopeKey(input: {
  readonly requirementIdentityKey: string | null;
  readonly stableSourceIdentity: string | null;
  readonly sourceScopeKey: string | null;
}): string {
  if (input.requirementIdentityKey) {
    return input.requirementIdentityKey;
  }
  return ['not-compiled', input.sourceScopeKey ?? input.stableSourceIdentity ?? 'source'].join(
    '\n'
  );
}

function assemblyAnnotationSourceScopeKey(
  assembly: Assembly | null,
  sessionConfigs: ReadonlyArray<AssemblySessionChromConfig> | undefined
): string | null {
  if (!assembly) return null;
  const configsByChrom = new Map((sessionConfigs ?? []).map((config) => [config.chrom, config]));
  const normalizePath = (value: string | null | undefined) =>
    (value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return [
    'assembly-annotation-source-scope.v1',
    assembly.id,
    assembly.totalLengthBp,
    ...assembly.chromosomes.map((placement, index) => {
      const config = configsByChrom.get(placement.chromosome.id);
      const manifest = config?.manifest;
      const source = config?.source;
      return [
        index,
        placement.chromosome.id,
        placement.globalStartBp,
        placement.chromosome.length,
        normalizePath(source?.workspaceRoot),
        normalizePath(source?.sourcePath),
        source?.sourceSizeBytes ?? '',
        source?.sourceExt ?? '',
        normalizePath(manifest?.fastaPath),
        normalizePath(manifest?.faiPath),
        normalizePath(manifest?.gffPath),
        normalizePath(manifest?.tbiPath),
      ].join('|');
    }),
  ].join('\n');
}

type SelectedAnnotation = IndexedGenomeSelectedAnnotation;

const DEFAULT_LANE_LIMIT: LaneLimit = 2;

type IndexedGenomeViewerDebugSnapshot = {
  instanceId: string;
  readonly compiledBroadRasterLoaderDiagnostics: AssemblyCompiledBroadRasterLoaderDiagnosticsV1 | null;
  readonly compiledBroadRasterLoaderDiagnosticsByTrack: Readonly<
    Record<string, AssemblyCompiledBroadRasterLoaderDiagnosticsV1 | null>
  >;
  readonly compiledAnnotationResidentReadiness: CompiledAnnotationResidentReadinessSnapshot;
  rendererReadyEpoch: number;
  rendererGenomeCommitEpoch: number;
  annotationAuthority: {
    sourceScopeKey: string | null;
    stableSourceIdentity: string | null;
    admittedSourceIdentity: string | null;
    sourceRequestPresent: boolean;
    seedCacheStatus: AssemblyPrepackedAnnotationSceneCacheState['status'];
    seedDescriptorSourceIdentity: string | null;
  };
  sessionId: string | null;
  chrom: string;
  length: number;
  rawFeatureCount: number;
  tileFeatureCount: number;
  resolvedFeatureCount: number;
  typeFilteredFeatureCount: number;
  postLaneFeatureCount: number;
  renderedFeatureCount: number;
  droppedByLaneCap: number;
  featureModel: GenomeAnnotationFeatureModel;
  tileCacheState: GenomeTileCacheState;
  availableTypes: string[];
  visibleTypes: string[];
  laneLimit: LaneLimit;
  sequenceLoadedBp: number;
  sequenceWindow: { startBp: number; endBp: number } | null;
  annotationViewportTile: {
    startBp: number;
    endBp: number;
    state: GenomeTrackTile['state'];
    fidelity: GenomeTrackTile['fidelity'];
    laneEpoch: string | null;
    recordCount: number;
    byteCount: number;
  } | null;
  annotationViewportTiles: Array<{
    startBp: number;
    endBp: number;
    generation: number;
    state: GenomeTrackTile['state'];
    fidelity: GenomeTrackTile['fidelity'];
    laneEpoch: string | null;
    recordCount: number;
    byteCount: number;
  }>;
  annotationResidentPageReadiness: {
    requestedPageCount: number;
    publishedPageCount: number;
    publicationGeneration: number | null;
    pendingCommit: boolean;
  };
  annotationOverviewTile: {
    state: GenomeTrackTile['state'];
    fidelity: GenomeTrackTile['fidelity'];
    laneEpoch: string | null;
    recordCount: number;
    payloadGlyphCount: number;
    payloadCompactGeometryCount: number;
    payloadTypeFilteredCount: number;
    payloadDroppedCount: number;
    payloadByteCount: number;
  };
  scene: IndexedGenomeScene | null;
  sceneHasWholeFeaturePayload: boolean;
  sceneInvariant: IndexedGenomeSceneInvariantReport | null;
  rendererGenomeSummary: {
    name: string;
    length: number;
    featureCount: number;
    sequenceWindowBp: number;
    hasWholeSequence: boolean;
  };
  rendererFeatureLaneSamples: RendererFeatureLaneSample[];
  loadTiming?: {
    tileLoadMs: number;
  };
  invariantViolations?: ReadonlyArray<InvariantViolation>;
};

type IndexedGenomeViewerDebugEvent = {
  instanceId: string;
  event: string;
  t: number;
  detail?: Record<string, unknown>;
};

type IndexedGenomeDebugWindow = Window & {
  __webglExposeForTests?: boolean;
  __indexedGenomeVerboseEvents?: boolean;
  __indexedGenomeViewerDebug?: IndexedGenomeViewerDebugSnapshot;
  __indexedGenomeViewerEvents?: IndexedGenomeViewerDebugEvent[];
  __indexedGenomeFindCdsLoci?: (max?: number) => DebugCdsLocus[];
  __indexedGenomeFindFeatureStructures?: (
    query: string,
    max?: number
  ) => RendererFeatureStructureSnapshot[];
  __indexedGenomeJumpToSpliceDemo?: () => boolean;
};

const HIGH_VOLUME_DEBUG_EVENTS = new Set([
  'camera-change',
  'annotation-viewport-tile-covered',
  'annotation-viewport-tile-pending',
  'compiled-broad-raster-cells-admitted',
  'compiled-broad-raster-cells-staged',
  'compiled-broad-raster-cells-transported',
  'sequence-window-covered',
  'sequence-window-pending',
  'sequence-window-skip-lod',
]);

function recordIndexedGenomeViewerEvent(
  instanceId: string,
  event: string,
  detail?: Record<string, unknown>
): void {
  if (typeof window === 'undefined') return;
  const hooks = window as IndexedGenomeDebugWindow;
  if (!hooks.__webglExposeForTests) return;
  if (!hooks.__indexedGenomeVerboseEvents && HIGH_VOLUME_DEBUG_EVENTS.has(event)) return;
  const entries = hooks.__indexedGenomeViewerEvents ?? (hooks.__indexedGenomeViewerEvents = []);
  entries.push({
    instanceId,
    event,
    t:
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
    ...(detail ? { detail } : {}),
  });
  while (entries.length > 200) entries.shift();
}

function cancelGenomeRequest(sessionId: string | undefined, requestId: string | null | undefined) {
  if (!sessionId || !requestId) return;
  void Promise.resolve(platform().genome.cancelRequest(sessionId, requestId)).catch(
    () => undefined
  );
}

type LoadState =
  | { kind: 'loading'; message: string }
  | {
      kind: 'ready';
      tileFeatures: GenomeFeature[];
      featureModel: GenomeAnnotationFeatureModel;
      tileCacheState: GenomeTileCacheState;
      summaryTileState: GenomeTrackTile['state'];
      summaryTileFidelity: GenomeTrackTile['fidelity'];
      summaryTileGeneration: number;
      summaryTileByteCount: number;
      summaryTileValidationState: GenomeTrackTile['validationState'];
      summaryTileMessage?: string;
      sourceRecordCount?: number;
      layerTypes?: string[];
      loadTiming?: {
        tileLoadMs: number;
      };
      sequence: string;
    }
  | { kind: 'error'; message: string };

interface SequenceWindowState {
  startBp: number;
  endBp: number;
  generation: number;
  byteCount: number;
  bases: string;
}

export function IndexedGenomeViewer({
  laneOwnerId = '__standalone-indexed-genome-viewer__',
  allowAutomaticSignalReadPileupViews = true,
  dataLayerTracks,
  dataLayerControls,
  annotationColorsByIdentity,
  missingAnnotationColor,
  comparisonProjection,
  comparisonCamera,
  onComparisonCameraChange,
  contactProjection,
  contactCamera,
  contactUnit,
  onContactCameraChange,
  onAddVariantTrackRequest,
  onOpenMutationNavigator,
  manifest,
  sessionId,
  themeMode = 'light',
  length,
  height = 480,
  isActive = true,
  targetViewport = null,
  searchHighlight = null,
  onContextMenu,
  onSelectionChange,
  onSelectionClear,
  sequenceOverlays,
  onCameraSample,
  userAnnotationDataset = null,
  onTargetViewportCommitted,
  onViewportPresented,
  onViewportRangeChange,
  onAnnotationIndexBuilt,
  onVisibleAnnotationTypesChange,
  onAnnotationTrackOrderChange,
  annotationVisibilityCommand = null,
  onLoadPhase,
  onTrackError,
  onTrackReady,
  onFeatureDetailsStateChange,
  assemblyChromIds,
  assemblyDefinition,
  trackAssemblyId,
  assemblyFeatures,
  assemblyByChrom,
  assemblyAnnotationTrackTypes,
  assemblySessionConfigs,
  overviewTexture,
  overviewTextureStatus = 'not-applicable',
  annotationSceneSourceRequest = null,
  prepackedAnnotationSceneCache = NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE,
  annotationAssetGeneration = null,
  annotationProductPublicationReady = true,
  annotationInteractionPayloadEnabled = true,
  annotationInteractionPreparationGeneration = 0,
  annotationMapperPolicy: controlledAnnotationMapperPolicy,
  onAnnotationMapperPolicyChange,
  allocateAnnotationMapperPolicyRequestId,
  onAnnotationMapperPolicyPreparationRequest,
  annotationMapperPolicyRasterPreparation,
  onPrepackedAnnotationScenePresented,
  onCompiledBroadRasterVisualReady,
  requireFullAssemblyReadiness = false,
}: IndexedGenomeViewerProps) {
  const onLoadPhaseRef = useRef(onLoadPhase);
  onLoadPhaseRef.current = onLoadPhase;
  const onViewportRangeChangeRef = useRef(onViewportRangeChange);
  onViewportRangeChangeRef.current = onViewportRangeChange;
  const onCameraSampleRef = useRef(onCameraSample);
  onCameraSampleRef.current = onCameraSample;
  const onTargetViewportCommittedRef = useRef(onTargetViewportCommitted);
  onTargetViewportCommittedRef.current = onTargetViewportCommitted;
  const onViewportPresentedRef = useRef(onViewportPresented);
  onViewportPresentedRef.current = onViewportPresented;
  const targetViewportIdRef = useRef(targetViewport?.id);
  targetViewportIdRef.current = targetViewport?.id;
  const onCompiledBroadRasterVisualReadyRef = useRef(onCompiledBroadRasterVisualReady);
  onCompiledBroadRasterVisualReadyRef.current = onCompiledBroadRasterVisualReady;
  const coordinateGenomeReadyRef = useRef(false);
  const coordinateGenomeEverReadyChromRef = useRef<string | null>(null);
  const compiledBroadRasterPhysicallyReadyRef = useRef(false);
  const compiledBroadRasterPhysicalOwnerKeyRef = useRef<string | null>(null);
  const effectiveAssemblyIds = assemblyChromIds;

  const rendererAssembly = useMemo<Assembly | null>(
    () => resolveRendererAssembly(effectiveAssemblyIds, assemblyDefinition),
    [assemblyDefinition, effectiveAssemblyIds]
  );
  const compiledBroadSurfaceRequirement = useMemo(
    () =>
      rendererAssembly && !contactProjection && !comparisonProjection
        ? {
            identityKey: `indexed-full-assembly:${rendererAssembly.id}`,
            genomeLengthBp: rendererAssembly.totalLengthBp,
            broadCorridorFinestSpanBp: assemblyCompiledBroadRasterFinestSpanBpV1(
              rendererAssembly.totalLengthBp
            ),
          }
        : null,
    [comparisonProjection, contactProjection, rendererAssembly]
  );
  const compiledBroadOwnsAssembly = isCompiledBroadOwnedAssembly(
    rendererAssembly,
    compiledBroadSurfaceRequirement
  );
  const annotationSourceScopeKey = useMemo(
    () => assemblyAnnotationSourceScopeKey(rendererAssembly, assemblySessionConfigs),
    [rendererAssembly, assemblySessionConfigs]
  );
  const retainedAnnotationSourceIdentityRef =
    useRef<RetainedAssemblyAnnotationSourceIdentity | null>(null);
  const admittedSourceIdentity = admittedAnnotationSceneSourceIdentity(
    annotationSceneSourceRequest
  );
  const descriptorSourceIdentity = descriptorAnnotationSourceIdentity(
    admittedSourceIdentity,
    prepackedAnnotationSceneCache.descriptor?.sourceIdentity
  );
  const admittedAnnotationSourceFingerprint = resolveAdmittedAnnotationSourceFingerprint(
    prepackedAnnotationSceneCache
  );
  const annotationSourcePlacementProvenance = useMemo(
    () => activeAnnotationSourcePlacementProvenance(prepackedAnnotationSceneCache),
    [
      admittedAnnotationSourceFingerprint,
      prepackedAnnotationSceneCache.descriptor?.placementFingerprint,
      prepackedAnnotationSceneCache.status,
    ]
  );
  const retainedAnnotationSource = nextRetainedAnnotationSourceIdentity(
    annotationSourceScopeKey,
    descriptorSourceIdentity,
    retainedAnnotationSourceIdentityRef.current
  );
  retainedAnnotationSourceIdentityRef.current = retainedAnnotationSource.retained;
  const stableAnnotationSourceIdentity = retainedAnnotationSource.stableIdentity;
  const [state, setState] = useState<LoadState>({ kind: 'loading', message: 'Loading genome…' });
  const [rendererReadyEpoch, setRendererReadyEpoch] = useState(0);
  const [rendererGenomeCommitEpoch, setRendererGenomeCommitEpoch] = useState(0);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [sceneViewportRange, setSceneViewportRange] = useState<SequenceViewportRange | null>(null);
  const [assemblyColdInteractionReady, setAssemblyColdInteractionReady] = useState<boolean>(false);
  const fullAssemblyInteractionReady = state.kind === 'ready';

  const assemblyRoutingEnabled = isIndexedGenomeAssemblyRoutingEnabled(
    rendererAssembly,
    assemblySessionConfigs
  );
  const [uncontrolledAnnotationMapperPolicy, setUncontrolledAnnotationMapperPolicy] =
    useState<IndexedGenomeAnnotationMapperPolicy>({
      isoformMode: 'canonical',
      laneLimit: DEFAULT_LANE_LIMIT,
    });
  const suppliedAnnotationMapperPolicy = suppliedOrLocalAnnotationMapperPolicy(
    controlledAnnotationMapperPolicy,
    uncontrolledAnnotationMapperPolicy
  );
  const maxSupportedFiniteLaneLimit = compiledBroadMaxSupportedFiniteLaneLimit(
    compiledBroadSurfaceRequirement
  );
  const annotationMapperPolicy = useMemo(
    () =>
      clampAnnotationMapperPolicyToLaneCapability(
        suppliedAnnotationMapperPolicy,
        maxSupportedFiniteLaneLimit
      ),
    [maxSupportedFiniteLaneLimit, suppliedAnnotationMapperPolicy]
  );
  const transcriptDisplayMode = annotationMapperPolicy.isoformMode;
  const laneLimit = annotationMapperPolicy.laneLimit;
  const commitAnnotationMapperPolicy = useCallback(
    (next: IndexedGenomeAnnotationMapperPolicy) => {
      if (controlledAnnotationMapperPolicy) {
        onAnnotationMapperPolicyChange?.(next);
        return;
      }
      setUncontrolledAnnotationMapperPolicy(next);
    },
    [controlledAnnotationMapperPolicy, onAnnotationMapperPolicyChange]
  );
  const publishedPolicyCapabilityCorrectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !controlledAnnotationMapperPolicy ||
      sameAnnotationMapperPolicy(controlledAnnotationMapperPolicy, annotationMapperPolicy)
    ) {
      publishedPolicyCapabilityCorrectionRef.current = null;
      return;
    }
    const correctionKey = [
      compiledBroadSurfaceRequirement?.identityKey ?? 'legacy',
      controlledAnnotationMapperPolicy.isoformMode,
      controlledAnnotationMapperPolicy.laneLimit ?? 'all',
      annotationMapperPolicy.laneLimit ?? 'all',
    ].join(':');
    if (publishedPolicyCapabilityCorrectionRef.current === correctionKey) return;
    publishedPolicyCapabilityCorrectionRef.current = correctionKey;
    onAnnotationMapperPolicyChange?.(annotationMapperPolicy);
  }, [
    annotationMapperPolicy,
    compiledBroadSurfaceRequirement?.identityKey,
    controlledAnnotationMapperPolicy,
    onAnnotationMapperPolicyChange,
  ]);
  const selectedCompiledBroadTrackTypesRef = useRef<readonly string[]>([]);
  const {
    annotationPolicyTransaction,
    annotationPolicyTransactionRef,
    pendingAnnotationMapperPolicy,
    requestAnnotationMapperPolicy,
    failAnnotationPolicyTransaction,
    handleAnnotationRasterAtomicCommitted,
    acknowledgeCompiledBroadPolicyReceipt,
    isCompiledBroadPolicyReceiptBarrierTrack,
  } = useIndexedAnnotationMapperPolicy({
    annotationMapperPolicy,
    maxSupportedFiniteLaneLimit,
    commitAnnotationMapperPolicy,
    allocateAnnotationMapperPolicyRequestId,
    onAnnotationMapperPolicyPreparationRequest,
    rendererAssemblyPresent: Boolean(rendererAssembly),
    prepackedAnnotationSceneCacheStatus: prepackedAnnotationSceneCache.status,
    compiledBroadSurfaceEnabled: Boolean(compiledBroadSurfaceRequirement),
    getCompiledBroadRequiredTrackTypes: () => selectedCompiledBroadTrackTypesRef.current,
  });
  const cacheForAnnotationPolicy = useCallback(
    (_policy: IndexedGenomeAnnotationMapperPolicy) => prepackedAnnotationSceneCache,
    [prepackedAnnotationSceneCache]
  );
  const pendingAnnotationTargetCache = resolvePendingAnnotationTargetCache(
    pendingAnnotationMapperPolicy,
    cacheForAnnotationPolicy
  );
  useEffect(() => {
    if (!pendingAnnotationMapperPolicy || !pendingAnnotationTargetCache) return;
    if (compiledBroadSurfaceRequirement) return;
    if (pendingAnnotationTargetCache.status === 'miss') {
      failAnnotationPolicyTransaction(pendingAnnotationMapperPolicy.requestId, 'cache-miss');
    } else if (pendingAnnotationTargetCache.status === 'error') {
      failAnnotationPolicyTransaction(pendingAnnotationMapperPolicy.requestId, 'cache-error');
    }
  }, [
    failAnnotationPolicyTransaction,
    compiledBroadSurfaceRequirement,
    pendingAnnotationMapperPolicy,
    pendingAnnotationTargetCache,
  ]);
  useEffect(() => {
    if (
      !pendingAnnotationMapperPolicy ||
      annotationMapperPolicyRasterPreparation == null ||
      pendingAnnotationMapperPolicy.requestId !==
        annotationMapperPolicyRasterPreparation.requestId ||
      !sameAnnotationMapperPolicy(
        pendingAnnotationMapperPolicy.policy,
        annotationMapperPolicyRasterPreparation.policy
      )
    ) {
      return;
    }
    if (compiledBroadSurfaceRequirement) return;
    if (annotationMapperPolicyRasterPreparation.status === 'miss') {
      failAnnotationPolicyTransaction(pendingAnnotationMapperPolicy.requestId, 'cache-miss');
    } else if (annotationMapperPolicyRasterPreparation.status === 'error') {
      failAnnotationPolicyTransaction(pendingAnnotationMapperPolicy.requestId, 'cache-error');
    }
  }, [
    annotationMapperPolicyRasterPreparation,
    compiledBroadSurfaceRequirement,
    failAnnotationPolicyTransaction,
    pendingAnnotationMapperPolicy,
  ]);
  const defaultVisibleTypes = useMemo(
    () => defaultVisibleAnnotationTypes(assemblyAnnotationTrackTypes),
    [assemblyAnnotationTrackTypes]
  );
  const [visibleTypes, setVisibleTypes] = useState<ReadonlySet<string>>(() =>
    annotationVisibilityCommand
      ? new Set(
          (assemblyAnnotationTrackTypes ?? annotationVisibilityCommand.orderedTrackIds).filter(
            (id) =>
              annotationVisibilityCommand.orderedTrackIds.includes(id)
                ? annotationVisibilityCommand.visibleTrackIds.includes(id)
                : defaultVisibleTypes.has(id)
          )
        )
      : defaultVisibleTypes
  );
  const [orderedAnnotationTrackIds, setOrderedAnnotationTrackIds] = useState<ReadonlyArray<string>>(
    () => [...(annotationVisibilityCommand?.orderedTrackIds ?? [])]
  );
  const priorAnnotationRosterRef = useRef(
    assemblyAnnotationTrackTypes ?? annotationVisibilityCommand?.orderedTrackIds
  );
  useEffect(() => {
    const previous = priorAnnotationRosterRef.current;
    priorAnnotationRosterRef.current = assemblyAnnotationTrackTypes;
    if (!assemblyAnnotationTrackTypes) return;
    if (!previous) {
      setVisibleTypes(defaultVisibleTypes);
      return;
    }
    const current = new Set(assemblyAnnotationTrackTypes);
    const old = new Set(previous);
    setVisibleTypes(
      (visible) =>
        new Set([
          ...[...visible].filter((id) => current.has(id)),
          ...[...defaultVisibleTypes].filter((id) => !old.has(id)),
        ])
    );
    setOrderedAnnotationTrackIds((order) => [
      ...new Set([...order.filter((id) => current.has(id)), ...assemblyAnnotationTrackTypes]),
    ]);
  }, [assemblyAnnotationTrackTypes, defaultVisibleTypes]);
  const appliedAnnotationVisibilityCommandRef = useRef<string | null>(
    annotationVisibilityCommand?.id ?? null
  );
  useEffect(() => {
    if (
      !annotationVisibilityCommand ||
      appliedAnnotationVisibilityCommandRef.current === annotationVisibilityCommand.id
    ) {
      return;
    }
    appliedAnnotationVisibilityCommandRef.current = annotationVisibilityCommand.id;
    setVisibleTypes(new Set(annotationVisibilityCommand.visibleTrackIds));
    setOrderedAnnotationTrackIds([...annotationVisibilityCommand.orderedTrackIds]);
  }, [annotationVisibilityCommand]);
  const [glyphV2Enabled] = useState<boolean>(() => isTranscriptGlyphV2Enabled());
  const effectiveVisibleTypes = useMemo(
    () =>
      visibleTypesForGlyphMode(
        visibleTypes,
        glyphV2Enabled,
        rendererAssembly ? assemblyAnnotationTrackTypes : undefined
      ),
    [assemblyAnnotationTrackTypes, glyphV2Enabled, rendererAssembly, visibleTypes]
  );
  useEffect(() => {
    onVisibleAnnotationTypesChange?.(new Set(effectiveVisibleTypes));
  }, [effectiveVisibleTypes, onVisibleAnnotationTypesChange]);
  const annotationSearchReveal = useMemo(
    () => deriveAnnotationSearchReveal(effectiveVisibleTypes, searchHighlight),
    [effectiveVisibleTypes, searchHighlight]
  );
  const rendererEffectiveVisibleTypes = effectiveVisibleTypes;
  const rendererAnnotationSearchFocus = useMemo(
    () =>
      annotationSearchReveal.kind !== 'unavailable'
        ? {
            trackId: annotationSearchReveal.trackId,
            canonicalIdentity: annotationSearchReveal.canonicalIdentity,
            ...(annotationSearchReveal.kind === 'visible'
              ? { presentation: 'temporary-additional-lane' as const }
              : {}),
          }
        : null,
    [annotationSearchReveal]
  );
  const assemblyAnnotationSearchFocusSource = useMemo(
    () =>
      rendererAssembly &&
      rendererAnnotationSearchFocus &&
      searchHighlight &&
      stableAnnotationSourceIdentity
        ? {
            startBp: searchHighlight.start,
            endBp: searchHighlight.end,
            trackId: rendererAnnotationSearchFocus.trackId,
            canonicalIdentity: rendererAnnotationSearchFocus.canonicalIdentity,
            genomeIdentity: stableAnnotationSourceIdentity,
          }
        : null,
    [
      rendererAnnotationSearchFocus,
      rendererAssembly,
      searchHighlight,
      stableAnnotationSourceIdentity,
    ]
  );
  const annotationsVisible = rendererEffectiveVisibleTypes.size > 0;
  const rendererEffectiveVisibleLayerTypes = useMemo(
    () => [...rendererEffectiveVisibleTypes].sort((a, b) => a.localeCompare(b)),
    [rendererEffectiveVisibleTypes]
  );
  const rendererEffectiveVisibleLayerKey = rendererEffectiveVisibleLayerTypes.join('\0');
  selectedCompiledBroadTrackTypesRef.current = rendererEffectiveVisibleLayerTypes;
  const exactMrnaLayerContract = isExactMrnaLayerContract(
    compiledBroadSurfaceRequirement,
    rendererEffectiveVisibleLayerTypes
  );
  const mrnaLayerVisible = rendererEffectiveVisibleLayerTypes.includes('mRNA');
  const compiledBroadBootstrapTrackType = resolveCompiledBroadBootstrapTrackType(
    prepackedAnnotationSceneCache.descriptor?.artifact?.trackType,
    assemblyAnnotationTrackTypes
  );
  const compiledResidentOwnerReadinessScopeKey = resolveCompiledResidentOwnerReadinessScopeKey({
    identityKey: compiledBroadSurfaceRequirement?.identityKey,
    sourceScopeKey: annotationSourceScopeKey,
    runtimeCacheKey: prepackedAnnotationSceneCache.descriptor?.runtimeCacheKey,
    assetGenerationKey: assemblyReferenceAssetGenerationKey(annotationAssetGeneration),
    rendererReadyEpoch,
    rendererGenomeCommitEpoch,
  });
  const [compiledBroadRasterReadinessByTrack, setCompiledBroadRasterReadinessByTrack] = useState<
    Readonly<Record<string, CompiledBroadTrackReadinessReceipt>>
  >({});
  const handleCompiledBroadRasterTrackReadinessChanged = useCallback(
    (trackType: string, receipt: CompiledBroadTrackReadinessReceipt) => {
      setCompiledBroadRasterReadinessByTrack((previous) => {
        const current = previous[trackType];
        return current?.readiness === receipt.readiness &&
          current.targetIdentityKey === receipt.targetIdentityKey &&
          current.readinessTargetIdentityKey === receipt.readinessTargetIdentityKey &&
          current.readinessRendererMatchesCurrent === receipt.readinessRendererMatchesCurrent &&
          current.validatedSourceFingerprint === receipt.validatedSourceFingerprint &&
          current.interactionReadiness === receipt.interactionReadiness &&
          current.interactionOwnerKey === receipt.interactionOwnerKey &&
          current.ownerReadinessScopeKey === receipt.ownerReadinessScopeKey &&
          current.interactionCacheStatus === receipt.interactionCacheStatus &&
          current.interactionCacheOrigin === receipt.interactionCacheOrigin &&
          current.interactionCacheInitialProbe === receipt.interactionCacheInitialProbe &&
          current.interactionCacheCompletedAt === receipt.interactionCacheCompletedAt &&
          current.interactionSourceIdentity === receipt.interactionSourceIdentity &&
          current.interactionArtifactKey === receipt.interactionArtifactKey &&
          current.interactionPayloadBytes === receipt.interactionPayloadBytes &&
          current.compactInteractionStatus === receipt.compactInteractionStatus &&
          current.compactInteractionOwnerKey === receipt.compactInteractionOwnerKey &&
          current.compactInteractionStartedAt === receipt.compactInteractionStartedAt &&
          current.compactInteractionReadCompletedAt === receipt.compactInteractionReadCompletedAt &&
          current.compactInteractionPreparedAt === receipt.compactInteractionPreparedAt &&
          current.compactInteractionCompletedAt === receipt.compactInteractionCompletedAt &&
          current.compactInteractionAuthorityKind === receipt.compactInteractionAuthorityKind &&
          current.compactInteractionOrigin === receipt.compactInteractionOrigin &&
          current.compactInteractionPayloadBytes === receipt.compactInteractionPayloadBytes &&
          current.compactInteractionAuthorityPresent ===
            receipt.compactInteractionAuthorityPresent &&
          current.compactInteractionGenomeLengthBp === receipt.compactInteractionGenomeLengthBp &&
          current.compactInteractionError === receipt.compactInteractionError &&
          current.viewportDetailStatus === receipt.viewportDetailStatus &&
          current.viewportDetailCoverageStartBp === receipt.viewportDetailCoverageStartBp &&
          current.viewportDetailCoverageEndBp === receipt.viewportDetailCoverageEndBp &&
          current.viewportDetailPayloadBytes === receipt.viewportDetailPayloadBytes &&
          current.viewportDetailError === receipt.viewportDetailError
          ? previous
          : { ...previous, [trackType]: receipt };
      });
    },
    []
  );
  const compiledBroadSelectedReadinessReceipts = rendererEffectiveVisibleLayerTypes.map(
    (trackType) => ({
      trackType,
      receipt: compiledBroadRasterReadinessByTrack[trackType] ?? null,
    })
  );
  const compiledBroadSelectedSetReady =
    compiledBroadSelectedReadinessReceipts.length > 0 &&
    compiledBroadSelectedReadinessReceipts.every(
      ({ receipt }) =>
        receipt?.ownerReadinessScopeKey === compiledResidentOwnerReadinessScopeKey &&
        receipt?.readiness === 'ready' &&
        receipt.readinessRendererMatchesCurrent &&
        receipt.targetIdentityKey !== null &&
        receipt.readinessTargetIdentityKey === receipt.targetIdentityKey
    );
  const compiledResidentSelectedSetPrepared = compiledAnnotationDetailSetIsPrepared({
    readinessScopeKey: compiledResidentOwnerReadinessScopeKey,
    selectedTrackTypes: rendererEffectiveVisibleLayerTypes,
    tracks: compiledBroadSelectedReadinessReceipts.flatMap(({ trackType, receipt }) =>
      receipt ? [{ trackType, ...receipt }] : []
    ),
  });
  const compiledResidentSceneCoversViewport = compiledViewportDetailRosterCoversViewportV1({
    selectedSetPrepared: compiledResidentSelectedSetPrepared,
    viewport: sceneViewportRange,
    tracks: compiledBroadSelectedReadinessReceipts.map(({ receipt }) => ({
      status: receipt?.viewportDetailStatus ?? 'not-applicable',
      coverageStartBp: receipt?.viewportDetailCoverageStartBp ?? null,
      coverageEndBp: receipt?.viewportDetailCoverageEndBp ?? null,
    })),
  });
  const compiledBroadSelectedSetInteractive = compiledAnnotationBroadSetIsInteractive({
    contract: 'compiled-annotation-resident-readiness.v1',
    readinessScopeKey: compiledResidentOwnerReadinessScopeKey,
    selectedTrackTypes: rendererEffectiveVisibleLayerTypes,
    tracks: compiledBroadSelectedReadinessReceipts.flatMap(({ trackType, receipt }) =>
      receipt ? [{ trackType, ...receipt }] : []
    ),
  });
  const compiledAnnotationResidentReadiness = useMemo<CompiledAnnotationResidentReadinessSnapshot>(
    () =>
      Object.freeze({
        contract: 'compiled-annotation-resident-readiness.v1' as const,
        readinessScopeKey: compiledResidentOwnerReadinessScopeKey,
        selectedTrackTypes: Object.freeze([...rendererEffectiveVisibleLayerTypes]),
        selectedSetPrepared: compiledResidentSelectedSetPrepared,
        selectedBroadSetInteractive: compiledBroadSelectedSetInteractive,
        tracks: Object.freeze(
          compiledBroadSelectedReadinessReceipts.flatMap(({ trackType, receipt }) =>
            receipt ? [Object.freeze({ trackType, ...receipt })] : []
          )
        ),
      }),
    [
      compiledBroadRasterReadinessByTrack,
      compiledBroadSelectedSetInteractive,
      compiledResidentOwnerReadinessScopeKey,
      compiledResidentSelectedSetPrepared,
      rendererEffectiveVisibleLayerTypes,
    ]
  );
  useEffect(() => {
    if (!compiledBroadSurfaceRequirement || !compiledResidentSelectedSetPrepared) return;
    onTrackReady?.('annotation');
  }, [compiledBroadSurfaceRequirement, compiledResidentSelectedSetPrepared, onTrackReady]);
  const compiledBroadSelectedTargetRosterKey = resolveCompiledBroadSelectedTargetRosterKey(
    compiledBroadSelectedSetReady,
    compiledBroadSelectedReadinessReceipts
  );
  const assemblyAnnotationTierOwnership = useMemo<AssemblyAnnotationTierOwnership>(
    () =>
      compiledBroadSurfaceRequirement
        ? Object.freeze({
            broadOwner: 'compiled-broad-raster' as const,
            detailOwner: 'compiled-resident-scene' as const,
            codonCarrierOwner: 'resident-coordinate-pages' as const,
            identityKey: compiledBroadSurfaceRequirement.identityKey,
            broadCorridorFinestSpanBp: compiledBroadSurfaceRequirement.broadCorridorFinestSpanBp,
            residentSceneCoversViewport: compiledResidentSceneCoversViewport,
          })
        : Object.freeze({
            broadOwner: 'legacy-summary' as const,
            detailOwner: 'resident-coordinate-pages' as const,
          }),
    [compiledBroadSurfaceRequirement, compiledResidentSceneCoversViewport]
  );
  const overviewFeaturesComplete = useMemo(
    () =>
      hasCompleteIndexedAssemblyOverview({
        assemblyByChrom,
        indexedChroms: assemblySessionConfigs?.map((config) => config.chrom) ?? [],
      }),
    [assemblyByChrom, assemblySessionConfigs]
  );
  const overviewAnnotationAuthorityComplete = resolveOverviewAnnotationAuthorityComplete(
    overviewFeaturesComplete,
    assemblyColdInteractionReady
  );
  const {
    exactDetailCoverageByChrom: assemblyExactDetailCoverageByChrom,
    annotationPages: assemblyAnnotationPages,
    annotationSearchFocusFeature: assemblyAnnotationSearchFocusFeature,
    annotationSourcePageStreamKey: assemblyAnnotationSourcePageStreamKey,
    sequenceWindow: assemblySequenceWindow,
    onCamera: onAssemblyCamera,
    ensureSessionForChrom: ensureAssemblySessionForChrom,
  } = useAssemblySegmentRouter({
    rendererAssembly,
    sessionConfigs: assemblySessionConfigs,
    containerWidth,
    enabled: assemblyRoutingEnabled,
    overviewFeaturesComplete: overviewAnnotationAuthorityComplete,
    annotationTierOwnership: assemblyAnnotationTierOwnership,
    transcriptDisplayMode,
    visibleTypes,
    laneLimit,
    glyphV2Enabled,
    annotationSearchFocusSource: assemblyAnnotationSearchFocusSource,
  });
  const assemblyExactAnnotationCoverage = useMemo(() => {
    if (assemblyAnnotationPages.length > 0) {
      return mergeAnnotationPageCoverage(assemblyAnnotationPages);
    }
    return [...assemblyExactDetailCoverageByChrom.values()].sort(
      (left, right) => left.startBp - right.startBp
    );
  }, [assemblyAnnotationPages, assemblyExactDetailCoverageByChrom]);
  const compiledBroadOwnsSceneViewport = resolveCompiledBroadOwnsSceneViewport({
    requirement: compiledBroadSurfaceRequirement,
    sceneViewportRange,
    containerWidth,
  });
  const residentCoordinatePagesCoverSceneViewport =
    resolveResidentCoordinatePagesCoverSceneViewport(
      sceneViewportRange,
      assemblyExactAnnotationCoverage
    );
  const annotationOwnerPending = isIndexedGenomeAnnotationOwnerPending({
    annotationsVisible,
    compiledBroadSurfaceRequirement,
    sceneViewportRange,
    compiledBroadOwnsSceneViewport,
    compiledResidentSceneCoversViewport,
    residentCoordinatePagesCoverSceneViewport,
  });
  const annotationRoutingOwnerGenerationRef = useRef<string | null>(null);
  useEffect(() => {
    const generation = annotationRoutingRedriveGeneration({
      routingEnabled: assemblyRoutingEnabled,
      sourceScopeKey: annotationSourceScopeKey,
      routerStreamKey: assemblyAnnotationSourcePageStreamKey,
      viewportPublicationKey: sceneViewportPublicationKey(sceneViewportRange),
      residentSceneCoversViewport: compiledResidentSceneCoversViewport,
    });
    if (!generation || annotationRoutingOwnerGenerationRef.current === generation) return;
    annotationRoutingOwnerGenerationRef.current = generation;
    onAssemblyCamera(sceneViewportRange, { immediate: false });
  }, [
    assemblyRoutingEnabled,
    annotationSourceScopeKey,
    assemblyAnnotationSourcePageStreamKey,
    compiledResidentSceneCoversViewport,
    onAssemblyCamera,
    sceneViewportRange,
  ]);
  const [sequenceWindow, setSequenceWindow] = useState<SequenceWindowState | null>(null);
  const [pendingSequenceWindow, setPendingSequenceWindow] = useState<SequenceWindowPending | null>(
    null
  );
  const [annotationViewportTiles, setAnnotationViewportTiles] = useState<
    AnnotationViewportTileState[]
  >([]);
  const annotationViewportTile = useMemo(
    () => selectActiveAnnotationViewportTile(annotationViewportTiles, sceneViewportRange),
    [annotationViewportTiles, sceneViewportRange]
  );
  const [pendingAnnotationViewportTile, setPendingAnnotationViewportTile] =
    useState<AnnotationTilePending | null>(null);
  const debugInstanceIdRef = useRef(createIndexedGenomeViewerInstanceId());

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [expandedGeneIds, _setExpandedGeneIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const toggleTranscriptDisplayMode = useCallback(() => {
    requestAnnotationMapperPolicy({
      ...annotationMapperPolicy,
      isoformMode: transcriptDisplayMode === 'canonical' ? 'expanded' : 'canonical',
    });
  }, [annotationMapperPolicy, requestAnnotationMapperPolicy, transcriptDisplayMode]);
  const changeLaneLimit = useCallback(
    (next: LaneLimit) => {
      requestAnnotationMapperPolicy({ ...annotationMapperPolicy, laneLimit: next });
    },
    [annotationMapperPolicy, requestAnnotationMapperPolicy]
  );

  const annotationLaneStashRef = useRef<ReadonlySet<string> | null>(null);
  const toggleVisibleType = useCallback((type: string) => {
    setVisibleTypes((previous) => {
      const next = toggleVisibleFeatureType(previous, type);
      annotationLaneStashRef.current =
        next.size === 0 && previous.size > 0 ? new Set(previous) : null;
      return next;
    });
  }, []);
  const setVisibleTypesFromPicker = useCallback((types: ReadonlySet<string>) => {
    setVisibleTypes((previous) => {
      const next = new Set(types);
      annotationLaneStashRef.current =
        next.size === 0 && previous.size > 0 ? new Set(previous) : null;
      return next;
    });
  }, []);
  const showTemporarilyRevealedTrack = useCallback(() => {
    if (annotationSearchReveal.kind !== 'temporary') return;
    setVisibleTypes((previous) =>
      persistTemporarilyRevealedTrack(previous, annotationSearchReveal.trackId)
    );
  }, [annotationSearchReveal]);
  const raiseSearchLaneLimitByOne = useCallback(() => {
    if (laneLimit === null) return;
    changeLaneLimit(laneLimit + 1);
  }, [changeLaneLimit, laneLimit]);
  const toggleAnnotationLane = useCallback(() => {
    setVisibleTypes((previous) => {
      const { next, stash } = toggleAnnotationLaneVisible(
        previous,
        annotationLaneStashRef.current,
        defaultVisibleTypes
      );
      annotationLaneStashRef.current = stash;
      return next;
    });
  }, [defaultVisibleTypes]);

  const fetchTokenRef = useRef(0);
  const sequenceWindowCoverageRef = useRef<{ startBp: number; endBp: number } | null>(null);
  const sequenceWindowPendingRef = useRef<SequenceWindowPending | null>(null);
  const cameraTiles = useRef(new IndexedGenomeCameraTileDispatcher()).current;
  const summaryTilePendingRequestRef = useRef<string | null>(null);
  const annotationViewportTileHostRef = useRef<IndexedGenomeCameraTileHost | null>(null);
  const pendingAnnotationResidentPageCandidateRef =
    useRef<AnnotationResidentPagePublicationCandidate | null>(null);
  const [committedAnnotationResidentPageCandidate, setCommittedAnnotationResidentPageCandidate] =
    useState<AnnotationResidentPagePublicationCandidate | undefined>(undefined);
  const hasBeenActiveRef = useRef(isActive);
  hasBeenActiveRef.current = stickyTrue(hasBeenActiveRef.current, isActive);
  const [activatedTick, setActivatedTick] = useState(stickyActivatedTick(hasBeenActiveRef.current));
  useEffect(() => {
    if (isActive && activatedTick === 0) setActivatedTick(1);
  }, [isActive, activatedTick]);
  const webglRef = useRef<IndexedGenomeTileNativeMapHandle>(null);
  const prepareAnnotationFineViewsPostPresent = useCallback(
    function prepareFineViews(deadlineMs: number): void {
      const handle = webglRef.current;
      const viewport = handle?.getViewportRange?.();
      const renderer = handle?.getLinearRenderer?.();
      if (!handle || !viewport || !renderer || length <= 0) return;
      const viewportSpanBp = viewport.end - viewport.start;
      const prewarmSpanBp = Math.min(length, PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP);
      const centerBp = (viewport.start + viewport.end) / 2;
      const prewarmStartBp = Math.max(
        0,
        Math.min(length - prewarmSpanBp, Math.floor(centerBp - prewarmSpanBp / 2))
      );
      const range =
        viewportSpanBp > 0 && viewportSpanBp <= PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP
          ? viewport
          : { start: prewarmStartBp, end: prewarmStartBp + prewarmSpanBp };
      let preparedAny = false;
      let pendingOwnerCount = 0;
      do {
        const result = renderer.preparePrepackedAnnotationFineViews(
          range.start,
          range.end,
          undefined,
          deadlineMs
        );
        preparedAny ||= result.preparedOwnerKey !== null;
        pendingOwnerCount = result.pendingOwnerCount;
      } while (pendingOwnerCount > 0 && performance.now() < deadlineMs);
      if (preparedAny) handle.requestRender();
      if (pendingOwnerCount > 0) handle.schedulePostPresentWork(prepareFineViews);
    },
    [length]
  );
  const scheduleAnnotationFineViewsPostPresent = useCallback((): void => {
    webglRef.current?.schedulePostPresentWork(prepareAnnotationFineViewsPostPresent);
  }, [prepareAnnotationFineViewsPostPresent]);
  const [annotationDetailRosterAdmissionEpoch, setAnnotationDetailRosterAdmissionEpoch] =
    useState(0);
  const handleAnnotationDetailRosterAdmission = useCallback((): void => {
    setAnnotationDetailRosterAdmissionEpoch((epoch) => epoch + 1);
    scheduleAnnotationFineViewsPostPresent();
  }, [scheduleAnnotationFineViewsPostPresent]);
  const handleRendererReady = useCallback((_childEpoch: number) => {
    setRendererReadyEpoch((previous) => previous + 1);
  }, []);
  const handleRendererGenomeCommit = useCallback((_childEpoch: number) => {
    setRendererGenomeCommitEpoch((previous) => previous + 1);
  }, []);

  const laneAssemblyId = resolveLaneAssemblyId(
    trackAssemblyId,
    rendererAssembly?.id,
    manifest.chrom
  );
  const trackAssemblyReferences = useMemo(() => {
    if (assemblyDefinition?.chromosomes.length) {
      return assemblyContigNaming(assemblyDefinition.chromosomes);
    }
    return (
      rendererAssembly?.chromosomes.map((placement) => ({
        name: placement.chromosome.id,
        length: placement.chromosome.length,
      })) ?? [{ name: manifest.chrom, length }]
    );
  }, [assemblyDefinition, length, manifest.chrom, rendererAssembly]);
  const bamImportGenome = useMemo(
    () => ({
      laneOwnerId,
      assemblyId: laneAssemblyId,
      displayName: assemblyDisplayName(
        assemblyDefinition?.displayName,
        rendererAssembly?.displayName,
        laneAssemblyId
      ),
      references: trackAssemblyReferences,
    }),
    [
      assemblyDefinition?.displayName,
      laneAssemblyId,
      laneOwnerId,
      rendererAssembly?.displayName,
      trackAssemblyReferences,
    ]
  );
  const bamImport = useBamTrackImport(bamImportGenome);
  const ownedTrackLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[laneOwnerId] ?? EMPTY_TRACK_LANES
  );
  const addLane = useLaneContractStore((state) => state.addLane);
  const legacyTrackLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[LEGACY_BUCKET] ?? EMPTY_TRACK_LANES
  );
  const attemptedHybridTrackIdsRef = useRef(new Set<string>());
  const experimentalHybridCandidates = useMemo(
    () => deriveExperimentalHybridPileupLanes(ownedTrackLanes, allowAutomaticSignalReadPileupViews),
    [allowAutomaticSignalReadPileupViews, ownedTrackLanes]
  );
  useEffect(() => {
    for (const candidate of experimentalHybridCandidates) {
      if (attemptedHybridTrackIdsRef.current.has(candidate.dataset.trackId)) continue;
      attemptedHybridTrackIdsRef.current.add(candidate.dataset.trackId);
      const stillNeeded = deriveExperimentalHybridPileupLanes(
        useLaneContractStore.getState().lanesForOwner(laneOwnerId),
        allowAutomaticSignalReadPileupViews
      ).some((current) => current.dataset.trackId === candidate.dataset.trackId);
      if (!stillNeeded) continue;
      addLane(
        laneOwnerId,
        candidate.assemblyId,
        candidate.dataset,
        true,
        undefined,
        undefined,
        'skip'
      );
    }
  }, [addLane, allowAutomaticSignalReadPileupViews, experimentalHybridCandidates, laneOwnerId]);
  const laneScreenBands = useLaneScreenBands(webglRef);
  const allTrackLanes = useMemo(
    () => [...ownedTrackLanes, ...legacyTrackLanes],
    [legacyTrackLanes, ownedTrackLanes]
  );
  const activeStressDatasets = useMemo(
    () => [
      ...allTrackLanes.filter((lane) => lane.visible).map((lane) => lane.dataset),
      ...(userAnnotationDataset ? [userAnnotationDataset] : []),
    ],
    [allTrackLanes, userAnnotationDataset]
  );
  const streamingTrackLanes = useMemo(
    () => buildExperimentalHybridStreamingLanes(allTrackLanes),
    [allTrackLanes]
  );
  const streamingStressDatasets = useMemo(
    () => streamingTrackLanes.map((lane) => lane.dataset),
    [streamingTrackLanes]
  );
  const readSourcesByTrackId = useMemo(
    () => buildPileupReadSourcesByTrackId(streamingStressDatasets),
    [streamingStressDatasets]
  );
  const recordDebugEvent = useCallback(
    (event: string, detail?: Record<string, unknown>) =>
      recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, event, detail),
    []
  );
  const compiledBroadRasterTrackPolicyRefreshersRef = useRef(new Map<string, () => void>());
  const registerCompiledBroadRasterTrackPolicyRefresher = useCallback(
    (trackType: string, refresher: () => void) => {
      compiledBroadRasterTrackPolicyRefreshersRef.current.set(trackType, refresher);
      return () => {
        if (compiledBroadRasterTrackPolicyRefreshersRef.current.get(trackType) === refresher) {
          compiledBroadRasterTrackPolicyRefreshersRef.current.delete(trackType);
        }
      };
    },
    []
  );
  const handleCompiledBroadRasterPolicyCommitted = useCallback(
    (trackType: string, receipt: AssemblyCompiledBroadRasterPolicyCommitReceiptV1) => {
      for (const [peerTrackType, refresh] of compiledBroadRasterTrackPolicyRefreshersRef.current) {
        const selectedPeer = resolveAnnotationTrackIdentity(
          peerTrackType,
          selectedCompiledBroadTrackTypesRef.current,
          (selectedTrackType) => selectedTrackType
        );
        if (peerTrackType === trackType || selectedPeer.status !== 'matched') {
          continue;
        }
        refresh();
      }
      if (receipt.policyRequestId === null) return;
      acknowledgeCompiledBroadPolicyReceipt(trackType, receipt);
    },
    [acknowledgeCompiledBroadPolicyReceipt]
  );
  const compiledBroadRasterTrackCameraNotifiersRef = useRef(
    new Set<
      (
        reason: 'scroll' | 'zoom',
        viewportRange?: Readonly<{ start: number; end: number }>,
        zoomAnchorBp?: number | null
      ) => void
    >()
  );
  const latestCompiledBroadRasterCameraReasonRef = useRef<'scroll' | 'zoom'>('scroll');
  const latestCompiledBroadRasterZoomAnchorBpRef = useRef<number | null>(null);
  const registerCompiledBroadRasterTrackCameraNotifier = useCallback(
    (
      notifier: (
        reason: 'scroll' | 'zoom',
        viewportRange?: Readonly<{ start: number; end: number }>,
        zoomAnchorBp?: number | null
      ) => void
    ) => {
      compiledBroadRasterTrackCameraNotifiersRef.current.add(notifier);
      notifier(
        latestCompiledBroadRasterCameraReasonRef.current,
        webglRef.current?.getViewportRange?.() ?? undefined,
        latestCompiledBroadRasterZoomAnchorBpRef.current
      );
      return () => compiledBroadRasterTrackCameraNotifiersRef.current.delete(notifier);
    },
    []
  );
  const replayCompiledBroadRasterCameraDemand = useCallback((): boolean => {
    const viewportRange = webglRef.current?.getViewportRange?.() ?? null;
    if (!viewportRange) return false;
    for (const notify of compiledBroadRasterTrackCameraNotifiersRef.current) {
      notify(
        latestCompiledBroadRasterCameraReasonRef.current,
        viewportRange,
        latestCompiledBroadRasterZoomAnchorBpRef.current
      );
    }
    return true;
  }, []);
  useEffect(() => {
    if (rendererReadyEpoch === 0 && rendererGenomeCommitEpoch === 0) return;
    const handle = webglRef.current;
    if (!handle || replayCompiledBroadRasterCameraDemand()) return;

    const unsubscribe = handle.subscribeToPresentedFrames(() => {
      if (replayCompiledBroadRasterCameraDemand()) unsubscribe();
    });
    handle.requestRender();
    return unsubscribe;
  }, [rendererGenomeCommitEpoch, rendererReadyEpoch, replayCompiledBroadRasterCameraDemand]);
  const compiledBroadRasterTrackDiagnosticsRef = useRef(
    new Map<string, () => AssemblyCompiledBroadRasterLoaderDiagnosticsV1 | null>()
  );
  const registerCompiledBroadRasterTrackDiagnostics = useCallback(
    (
      trackType: string,
      getDiagnostics: () => AssemblyCompiledBroadRasterLoaderDiagnosticsV1 | null
    ) => {
      compiledBroadRasterTrackDiagnosticsRef.current.set(trackType, getDiagnostics);
      return () => {
        if (compiledBroadRasterTrackDiagnosticsRef.current.get(trackType) === getDiagnostics) {
          compiledBroadRasterTrackDiagnosticsRef.current.delete(trackType);
        }
      };
    },
    []
  );
  const getCompiledBroadRasterLoaderDiagnostics = useCallback(() => {
    for (const trackType of selectedCompiledBroadTrackTypesRef.current) {
      const diagnostics = compiledBroadRasterTrackDiagnosticsRef.current.get(trackType)?.();
      if (diagnostics) return diagnostics;
    }
    return null;
  }, []);
  const getCompiledBroadRasterLoaderDiagnosticsByTrack = useCallback(
    () =>
      Object.fromEntries(
        selectedCompiledBroadTrackTypesRef.current.map((trackType) => [
          trackType,
          compiledBroadRasterTrackDiagnosticsRef.current.get(trackType)?.() ?? null,
        ])
      ),
    []
  );
  useEffect(() => {
    if (
      !compiledBroadSurfaceRequirement ||
      !compiledBroadSelectedSetReady ||
      !compiledBroadSelectedTargetRosterKey
    ) {
      return;
    }
    const physicalOwnerKey = [
      compiledBroadSurfaceRequirement.identityKey,
      rendererReadyEpoch,
      compiledBroadSelectedTargetRosterKey,
    ].join('\n');
    if (compiledBroadRasterPhysicalOwnerKeyRef.current !== physicalOwnerKey) {
      compiledBroadRasterPhysicalOwnerKeyRef.current = physicalOwnerKey;
      compiledBroadRasterPhysicallyReadyRef.current = false;
    }

    let cancelled = false;
    let frameId: number | null = null;
    const reportAfterPhysicalPresentation = () => {
      if (cancelled) return;
      if (liveRendererHasPresentedCompiledBroadRaster(webglRef.current)) {
        if (!compiledBroadRasterPhysicallyReadyRef.current) {
          compiledBroadRasterPhysicallyReadyRef.current = true;
          onCompiledBroadRasterVisualReadyRef.current?.();
        }
        return;
      }
      frameId = requestAnimationFrame(reportAfterPhysicalPresentation);
    };
    reportAfterPhysicalPresentation();
    return () => {
      cancelled = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [
    compiledBroadSelectedSetReady,
    compiledBroadSelectedTargetRosterKey,
    compiledBroadSurfaceRequirement,
    rendererReadyEpoch,
    webglRef,
  ]);
  const handleCompiledBroadRasterTrackUnavailable = useCallback(
    (requestId: number, trackType: string) => {
      if (!isCompiledBroadPolicyReceiptBarrierTrack(requestId, trackType)) {
        return;
      }
      recordDebugEvent('annotation-track-policy-unavailable', { requestId, trackType });
      failAnnotationPolicyTransaction(requestId, 'cache-error');
    },
    [failAnnotationPolicyTransaction, isCompiledBroadPolicyReceiptBarrierTrack, recordDebugEvent]
  );
  const lastOverviewTextureStatusReportRef = useRef<string | null>(null);
  useEffect(() => {
    if (!rendererAssembly) return;
    if (compiledBroadSurfaceRequirement) return;
    const key = `${rendererAssembly.id}:${overviewTextureStatus}`;
    if (lastOverviewTextureStatusReportRef.current === key) return;
    lastOverviewTextureStatusReportRef.current = key;
    recordDebugEvent('assembly-overview-texture-status', {
      assemblyId: rendererAssembly.id,
      status: overviewTextureStatus,
    });
    if (overviewTextureStatus === 'miss' || overviewTextureStatus === 'error') {
      onTrackError?.(
        'annotation',
        `Assembly overview texture ${overviewTextureStatus}; broad assembly annotations are unavailable.`
      );
    }
  }, [
    compiledBroadSurfaceRequirement,
    onTrackError,
    overviewTextureStatus,
    recordDebugEvent,
    rendererAssembly,
  ]);
  const {
    selectedAnnotation,
    featureDetailsState,
    featureDetailsStateRef,
    handleSelectedAnnotationChange,
  } = useIndexedFeatureDetails({
    sessionId,
    manifestChrom: manifest.chrom,
    rendererAssembly,
    assemblyRoutingEnabled,
    ensureAssemblySessionForChrom,
    recordEvent: recordDebugEvent,
  });
  const onFeatureDetailsStateChangeRef = useRef(onFeatureDetailsStateChange);
  onFeatureDetailsStateChangeRef.current = onFeatureDetailsStateChange;
  useEffect(() => {
    onFeatureDetailsStateChangeRef.current?.(featureDetailsState);
  }, [featureDetailsState]);
  useEffect(() => () => onFeatureDetailsStateChangeRef.current?.({ kind: 'idle' }), []);
  const pileupReferencePathsByChrom = useMemo<ReadonlyMap<string, string>>(() => {
    const paths = new Map<string, string>();
    for (const config of assemblySessionConfigs ?? []) {
      const fastaPath = config.manifest.fastaPath.trim();
      if (fastaPath) paths.set(config.chrom, fastaPath);
    }
    const anchorFastaPath = manifest.fastaPath.trim();
    if (anchorFastaPath && !paths.has(manifest.chrom)) {
      paths.set(manifest.chrom, anchorFastaPath);
    }
    return paths;
  }, [assemblySessionConfigs, manifest.chrom, manifest.fastaPath]);
  const experimentalHybridStreaming = useExperimentalHybridPileupStreaming({
    webglRef,
    activeStressDatasets: streamingStressDatasets,
  });
  const pileupStreaming = useIndexedPileupStreaming({
    webglRef,
    rendererAssembly,
    containerWidth,
    activeStressDatasets: streamingStressDatasets,
    referencePathsByChrom: pileupReferencePathsByChrom,
    enabled: isActive,
    onTrackDataPublished: experimentalHybridStreaming.publishAlignment,
    reconnectRemoteTrack: bamImport.reconnectRemoteTrack,
  });
  const pileupTrackStatuses = useSyncExternalStore(
    pileupStreaming.trackLifecycle.subscribe,
    pileupStreaming.trackLifecycle.getSnapshot,
    pileupStreaming.trackLifecycle.getSnapshot
  );
  const { streamPileupViaTileEngine } = pileupStreaming;
  const ucscStreaming = useIndexedUcscTrackStreaming({
    webglRef,
    rendererAssembly,
    containerWidth,
    activeLanes: streamingTrackLanes,
    onTrackRecordsPublished: experimentalHybridStreaming.publishQuantitative,
    onTrackPendingIntervalsPublished: experimentalHybridStreaming.publishHistogramPendingIntervals,
    reconnectRemoteTrack: bamImport.reconnectRemoteTrack,
  });
  useIndexedLaneContractTracks({
    supplementalTracks: dataLayerTracks,
    onTrackSelection: onSelectionChange,
    webglRef,
    rendererReadyEpoch,
    rendererAssembly,
    manifestChrom: manifest.chrom,
    manifestChromLength: length,
    activeStressDatasets,
    pileupStreaming,
    ucscStreaming,
    experimentalHybridStreaming,
    recordEvent: recordDebugEvent,
  });

  useEffect(() => {
    return syncAnnotationTilePyramidRendererFlag();
  }, []);

  const annotationRasterPolicyGateEnabled = annotationMapperPolicyRasterPreparation !== undefined;
  const pendingAnnotationRasterReady = isPendingAnnotationRasterReady({
    pendingAnnotationMapperPolicy,
    annotationMapperPolicyRasterPreparation,
  });
  const atomicAnnotationRasterRequest = resolveAtomicAnnotationRasterRequest(
    compiledBroadSurfaceRequirement,
    annotationRasterPolicyGateEnabled,
    pendingAnnotationRasterReady,
    pendingAnnotationMapperPolicy
  );
  const annotationRasterAtomicCommit = usePrebuiltAssemblyOverviewTexture({
    overviewTexture: compiledBroadOverviewTexture(compiledBroadSurfaceRequirement, overviewTexture),
    overviewTextureStatus: compiledBroadOverviewTextureStatus(
      compiledBroadSurfaceRequirement,
      overviewTextureStatus
    ),
    rendererReadyEpoch,
    webglRef,
    recordEvent: recordDebugEvent,
    atomicRequest: atomicAnnotationRasterRequest,
    onAtomicCommitted: handleAnnotationRasterAtomicCommitted,
  });
  useEffect(() => {
    if (compiledBroadSurfaceRequirement) return;
    if (
      !pendingAnnotationMapperPolicy ||
      annotationRasterAtomicCommit.status !== 'error' ||
      annotationRasterAtomicCommit.requestId !== pendingAnnotationMapperPolicy.requestId ||
      !sameAnnotationMapperPolicy(
        annotationRasterAtomicCommit.policy,
        pendingAnnotationMapperPolicy.policy
      )
    ) {
      return;
    }
    failAnnotationPolicyTransaction(pendingAnnotationMapperPolicy.requestId, 'cache-error');
  }, [
    annotationRasterAtomicCommit,
    compiledBroadSurfaceRequirement,
    failAnnotationPolicyTransaction,
    pendingAnnotationMapperPolicy,
  ]);

  const [measuredCanvasHeight, setMeasuredCanvasHeight] = useState(height);
  const [canvasHostEl, setCanvasHostEl] = useState<HTMLDivElement | null>(null);
  const canvasHostRef = useCallback((el: HTMLDivElement | null) => {
    setCanvasHostEl(el);
    if (!el) return;
    const nextWidth = Math.floor(el.clientWidth || el.getBoundingClientRect().width);
    const nextHeight = Math.floor(el.clientHeight || el.getBoundingClientRect().height);
    if (nextWidth > 0) {
      setContainerWidth((prev) => (prev === nextWidth ? prev : nextWidth));
    }
    if (nextHeight > 0) {
      setMeasuredCanvasHeight((prev) => (prev === nextHeight ? prev : nextHeight));
    }
  }, []);
  useEffect(() => {
    if (!canvasHostEl || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const nextWidth = Math.floor(
        canvasHostEl.clientWidth || canvasHostEl.getBoundingClientRect().width
      );
      const nextHeight = Math.floor(
        canvasHostEl.clientHeight || canvasHostEl.getBoundingClientRect().height
      );
      if (nextWidth > 0) {
        setContainerWidth((prev) => (prev === nextWidth ? prev : nextWidth));
      }
      if (nextHeight > 0) {
        setMeasuredCanvasHeight((prev) => (prev === nextHeight ? prev : nextHeight));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvasHostEl);
    return () => observer.disconnect();
  }, [canvasHostEl]);
  const sceneViewportPublicationKeyRef = useRef<string | null>(null);
  const lastViewportCenterRef = useRef<number | null>(null);
  const lastCommittedTargetViewportIdRef = useRef<number | null>(null);
  const pendingTargetPresentationRef = useRef<{
    renderer: NonNullable<ReturnType<IndexedGenomeTileNativeMapHandle['getLinearRenderer']>>;
    sessionId: string | undefined;
    id: number;
    start: number;
    end: number;
  } | null>(null);
  const onTrackErrorRef = useRef(onTrackError);
  useEffect(() => {
    onTrackErrorRef.current = onTrackError;
  }, [onTrackError]);

  const commitSceneViewportRange = useCallback(
    (range: SequenceViewportRange | null | undefined, maxLength = length) => {
      const normalized = normalizeSequenceViewportRange(range, maxLength);
      onViewportRangeChangeRef.current?.(normalized);
      const nextPublicationKey = sceneViewportPublicationKey(normalized);
      if (nextPublicationKey === sceneViewportPublicationKeyRef.current) return;
      sceneViewportPublicationKeyRef.current = nextPublicationKey;
      setSceneViewportRange((prev) => {
        if (sequenceViewportRangesEqual(prev, normalized)) return prev;
        return normalized;
      });
    },
    [length]
  );

  useEffect(() => {
    if (state.kind !== 'ready') return;
    commitSceneViewportRange(
      webglRef.current?.getViewportRange?.() ?? null,
      rendererAssembly?.totalLengthBp ?? length
    );
  }, [commitSceneViewportRange, length, rendererAssembly, rendererReadyEpoch, state.kind]);

  const commitAnnotationViewportTileToRenderer = useCallback(
    (tile: AnnotationViewportTileState, reason: 'immediate' | 'camera-idle') => {
      setAnnotationViewportTiles((prev) => retainAnnotationViewportTiles(prev, tile));
      recordIndexedGenomeViewerEvent(
        debugInstanceIdRef.current,
        'annotation-viewport-tile-committed',
        {
          reason,
          generation: tile.generation,
          state: tile.state,
          fidelity: tile.fidelity,
          startBp: tile.startBp,
          endBp: tile.endBp,
          recordCount: tile.recordCount,
          byteCount: tile.byteCount,
          featureCount: tile.features.length,
          laneEpoch: tile.laneEpoch ?? null,
        }
      );
    },
    []
  );

  const flushPendingAnnotationResidentPageCommit = useCallback(() => {
    const candidate = pendingAnnotationResidentPageCandidateRef.current;
    if (!candidate) return;
    pendingAnnotationResidentPageCandidateRef.current = null;
    setCommittedAnnotationResidentPageCandidate((previous) =>
      previous?.semanticIdentity === candidate.semanticIdentity ? previous : candidate
    );
  }, []);

  annotationViewportTileHostRef.current = {
    isAssembly: Boolean(rendererAssembly),
    length,
    containerWidth,
    sessionId,
    manifest,
    visibleTypes: rendererEffectiveVisibleTypes,
    laneLimit,
    debugInstanceId: debugInstanceIdRef.current,
    recordEvent: (event, detail) =>
      recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, event, detail),
    setPending: setPendingAnnotationViewportTile,
    commitTile: commitAnnotationViewportTileToRenderer,
    flushResidentPage: flushPendingAnnotationResidentPageCommit,
    onTrackError: (kind, message) => onTrackErrorRef.current?.(kind, message),
    cancelRequest: (requestId) => cancelGenomeRequest(sessionId, requestId),
    fetchTile: (request, requestId) => {
      if (!sessionId) {
        return Promise.reject(new Error('annotation-viewport-tile-no-session'));
      }
      return platform().genome.getAnnotationTile(sessionId, request, requestId);
    },
  };

  useEffect(() => {
    if (activatedTick === 0) {
      setState({ kind: 'loading', message: 'Tab idle — open to load.' });
      onLoadPhase?.('loading');
      return;
    }

    let cancelled = false;
    recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, 'load-effect-start', {
      chrom: manifest.chrom,
      sessionReady: Boolean(sessionId),
    });
    const alreadyPresented = coordinateGenomeEverReadyChromRef.current === manifest.chrom;
    if (!alreadyPresented) {
      setState({ kind: 'loading', message: `Loading ${manifest.chrom}…` });
    }
    setSequenceWindow(null);
    setPendingSequenceWindow(null);
    setAnnotationViewportTiles([]);
    setPendingAnnotationViewportTile(null);
    coordinateGenomeReadyRef.current = false;
    sequenceWindowCoverageRef.current = null;
    sequenceWindowPendingRef.current = null;
    cameraTiles.annotationTileCoveragesRef.current = [];
    cameraTiles.annotationTilePendingRef.current = null;
    if (!alreadyPresented) {
      onLoadPhase?.('loading');
    }

    (async () => {
      try {
        const loadStartedAt =
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        const generation = ++fetchTokenRef.current;
        let committedFirstTile = false;
        const commitSummaryTile = (
          annotationTile: GenomeTrackTile,
          options: { notifyReady?: boolean } = {}
        ) => {
          const tileFeatures = Array.isArray(annotationTile.features)
            ? annotationTile.features
            : [];
          setState({
            kind: 'ready',
            tileFeatures,
            featureModel: annotationTile.featureModel ?? 'raw-gff3',
            tileCacheState: annotationTile.cacheState ?? 'none',
            summaryTileState: annotationTile.state,
            summaryTileFidelity: annotationTile.fidelity,
            summaryTileGeneration: annotationTile.generation,
            summaryTileByteCount: annotationTile.byteCount,
            summaryTileValidationState: annotationTile.validationState,
            summaryTileMessage: annotationTile.message,
            sourceRecordCount: annotationTile.sourceRecordCount ?? annotationTile.recordCount,
            layerTypes: annotationTile.layerTypes,
            loadTiming: {
              tileLoadMs:
                (typeof performance !== 'undefined' && typeof performance.now === 'function'
                  ? performance.now()
                  : Date.now()) - loadStartedAt,
            },
            sequence: '',
          });
          if ((options.notifyReady ?? true) && !committedFirstTile) {
            committedFirstTile = true;
            coordinateGenomeReadyRef.current = true;
            coordinateGenomeEverReadyChromRef.current = manifest.chrom;
            onLoadPhaseRef.current?.('ready');
          }
        };
        if (rendererAssembly) {
          const request = buildAnnotationTileRequest({
            chrom: manifest.chrom,
            start: 0,
            end: length,
            lod: 0,
            generation,
            fidelity: 'summary',
            byteBudget: 0,
            sourceFingerprint: sourceFingerprintForManifest(manifest),
            visibleTypes: rendererEffectiveVisibleTypes,
            laneLimit,
          });
          commitSummaryTile({
            sessionId: sessionId ?? `assembly-shell:${rendererAssembly.id}`,
            requestId: `assembly-empty-summary-${generation}`,
            trackId: request.trackId,
            chrom: manifest.chrom,
            start: 0,
            end: length,
            generation,
            state: 'empty',
            fidelity: 'summary',
            validationState: 'metadata_match',
            byteCount: 0,
            recordCount: 0,
            sourceRecordCount: 0,
            layerTypes: [],
            featureModel: 'raw-gff3',
            cacheState: 'none',
            laneEpoch: request.laneEpoch,
            features: [],
            message: 'Assembly annotation overview is owned by tiled assembly rendering.',
          });
          recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, 'assembly-summary-skipped', {
            chrom: manifest.chrom,
            assemblyId: rendererAssembly.id,
            generation,
          });
          return;
        }
        if (!sessionId) {
          setState({ kind: 'loading', message: 'Waiting for genome session…' });
          return;
        }
        const annotationTile = await pollAnnotationSummaryTile({
          sessionId,
          chrom: manifest.chrom,
          length,
          generation,
          visibleTypes: rendererEffectiveVisibleTypes,
          laneLimit,
          sourceFingerprint: sourceFingerprintForManifest(manifest),
          getAnnotationTile: (nextSessionId, request, requestId) =>
            platform().genome.getAnnotationTile(nextSessionId, request, requestId),
          isCancelled: () => cancelled,
          onRequestStart: (requestId) => {
            summaryTilePendingRequestRef.current = requestId;
          },
          onRequestEnd: (requestId) => {
            if (summaryTilePendingRequestRef.current === requestId) {
              summaryTilePendingRequestRef.current = null;
            }
          },
          onPendingTile: (tile) => {
            if (cancelled) return;
            commitSummaryTile(tile, { notifyReady: false });
          },
        });
        if (cancelled) return;
        recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, 'tile-promises-done', {
          chrom: manifest.chrom,
          featureModel: annotationTile.featureModel ?? 'raw-gff3',
          cacheState: annotationTile.cacheState ?? 'none',
          featureCount: Array.isArray(annotationTile.features) ? annotationTile.features.length : 0,
        });
        commitSummaryTile(annotationTile);
        recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, 'set-ready-state', {
          chrom: manifest.chrom,
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load indexed genome.';
        if (coordinateGenomeEverReadyChromRef.current === manifest.chrom) {
          onTrackErrorRef.current?.('annotation', message);
          coordinateGenomeReadyRef.current = true;
          onLoadPhaseRef.current?.('ready');
          return;
        }
        setState({ kind: 'error', message });
        onLoadPhase?.('error', message);
      }
    })();

    return () => {
      cancelled = true;
      fetchTokenRef.current += 1;
      cameraTiles.annotationTileTokenRef.current += 1;
      cameraTiles.reset();
      pendingAnnotationResidentPageCandidateRef.current = null;
      cancelGenomeRequest(sessionId, summaryTilePendingRequestRef.current);
      cancelGenomeRequest(sessionId, sequenceWindowPendingRef.current?.requestId);
      cancelGenomeRequest(sessionId, cameraTiles.annotationTilePendingRef.current?.requestId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, sessionId, length, activatedTick, rendererAssembly]);

  const processCameraChange = useCallback(
    (
      reportedCenterBp: number,
      reason: 'scroll' | 'zoom',
      publishedViewportRange?: Readonly<{ start: number; end: number }> | null
    ) => {
      const handle = webglRef.current;
      const handleCenter = handle?.getViewCenter?.();
      const viewportRange = publishedViewportRange ?? handle?.getViewportRange?.();
      if (rendererAssembly) {
        processIndexedGenomeAssemblyCameraChange({
          reportedCenterBp,
          reason,
          handleCenter,
          viewportRange,
          assemblyLengthBp: rendererAssembly.totalLengthBp,
          assemblyRoutingEnabled,
          lastViewportCenter: lastViewportCenterRef,
          recordEvent: (event, detail) =>
            recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, event, detail),
          commitSceneViewportRange,
          onAssemblyCamera,
          streamPileupViaTileEngine,
        });
        return;
      }
      const sequenceWindowHost: IndexedGenomeSequenceWindowCameraHost = {
        length,
        containerWidth,
        sessionId,
        chrom: manifest.chrom,
        lastViewportCenter: lastViewportCenterRef,
        sequenceWindowCoverage: sequenceWindowCoverageRef,
        sequenceWindowPending: sequenceWindowPendingRef,
        fetchToken: fetchTokenRef,
        recordEvent: (event, detail) =>
          recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, event, detail),
        commitSceneViewportRange,
        setPendingSequenceWindow,
        setSequenceWindow,
        cancelRequest: (requestId) => cancelGenomeRequest(sessionId, requestId),
        fetchSequenceWindow: (request, requestId) => {
          if (!sessionId) {
            return Promise.reject(new Error('sequence-window-no-session'));
          }
          return platform().genome.getSequenceWindow(sessionId, request, requestId);
        },
        onSequenceTrackError: (message) => {
          onTrackErrorRef.current?.('sequence', message);
        },
      };
      const decision = resolveIndexedGenomeSequenceWindowCameraChange({
        reportedCenterBp,
        reason,
        handleCenter,
        viewportRange,
        host: sequenceWindowHost,
      });
      const tileHost = annotationViewportTileHostRef.current;
      if (tileHost) {
        cameraTiles.requestAnnotationViewportTile(
          {
            reportedCenterBp,
            handleCenterBp: handleCenter,
            viewportRange,
            reason,
            deferMs: ANNOTATION_VIEWPORT_TILE_COALESCE_MS,
          },
          tileHost
        );
      }
      applyIndexedGenomeSequenceWindowCameraDecision(decision, reason, sequenceWindowHost);
    },
    [
      assemblyFeatures,
      assemblyRoutingEnabled,
      cameraTiles,
      commitSceneViewportRange,
      containerWidth,
      length,
      manifest,
      onAssemblyCamera,
      rendererAssembly,
      sessionId,
      streamPileupViaTileEngine,
    ]
  );

  const handleCameraChange = useCallback(
    (
      reportedCenterBp: number,
      reason: 'scroll' | 'zoom',
      _zoom?: number,
      publishedViewportRange?: Readonly<{ start: number; end: number }>,
      cameraIntent?: Readonly<{ zoomAnchorBp: number | null }>
    ) => {
      latestCompiledBroadRasterCameraReasonRef.current = reason;
      latestCompiledBroadRasterZoomAnchorBpRef.current = cameraIntent?.zoomAnchorBp ?? null;
      for (const notify of compiledBroadRasterTrackCameraNotifiersRef.current) {
        notify(reason, publishedViewportRange, cameraIntent?.zoomAnchorBp ?? null);
      }
      const tileHost = annotationViewportTileHostRef.current;
      if (tileHost) {
        cameraTiles.noteCameraInteraction(tileHost);
      }
      const immediateViewportRange =
        publishedViewportRange ?? webglRef.current?.getViewportRange?.() ?? null;
      if (
        immediateViewportRange &&
        immediateViewportRange.end - immediateViewportRange.start <=
          PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP
      ) {
        scheduleAnnotationFineViewsPostPresent();
      }
      onAssemblyCamera(immediateViewportRange, { immediate: true });
      if (immediateViewportRange) onCameraSampleRef.current?.(immediateViewportRange);
      if (rendererAssembly) {
        streamPileupViaTileEngine(immediateViewportRange);
      }
      cameraTiles.scheduleCoalescedCameraChange(
        {
          reportedCenterBp,
          reason,
          viewportRange: publishedViewportRange ?? null,
        },
        processCameraChange
      );
    },
    [
      assemblyRoutingEnabled,
      cameraTiles,
      onAssemblyCamera,
      processCameraChange,
      rendererAssembly,
      scheduleAnnotationFineViewsPostPresent,
      streamPileupViaTileEngine,
    ]
  );

  useLayoutEffect(() => {
    const handle = webglRef.current;
    const renderer = handle?.getLinearRenderer();
    if (
      !onViewportPresentedRef.current ||
      !sessionId ||
      !isActive ||
      state.kind !== 'ready' ||
      !fullAssemblyInteractionReady ||
      !handle ||
      !renderer
    )
      return;

    let firstReported = false;
    const unsubscribe = handle.subscribeToCurrentGenomeFrames(() => {
      const currentHandle = webglRef.current;
      if (currentHandle?.getLinearRenderer() !== renderer) return;
      const range = currentHandle.getViewportRange();
      if (!range || range.end <= range.start) return;
      if (!firstReported) {
        firstReported = true;
        onViewportPresentedRef.current?.(sessionId, null);
      }
      const pending = pendingTargetPresentationRef.current;
      if (
        pending?.renderer === renderer &&
        pending.sessionId === sessionId &&
        pending.id === targetViewportIdRef.current &&
        Math.abs(range.start - pending.start) < 1e-6 &&
        Math.abs(range.end - pending.end) < 1e-6
      ) {
        pendingTargetPresentationRef.current = null;
        onViewportPresentedRef.current?.(sessionId, pending.id);
      }
    });
    handle.requestRender();
    return unsubscribe;
  }, [
    fullAssemblyInteractionReady,
    isActive,
    rendererGenomeCommitEpoch,
    rendererReadyEpoch,
    sessionId,
    state.kind,
  ]);

  useEffect(() => {
    if (state.kind !== 'ready' || !fullAssemblyInteractionReady || !targetViewport) {
      return;
    }
    if (lastCommittedTargetViewportIdRef.current === targetViewport.id) return;
    const handle = webglRef.current;
    if (!handle || length <= 0) return;
    const start = Math.max(0, Math.min(length - 1, targetViewport.start));
    const end = Math.max(start + 1, Math.min(length, targetViewport.end));
    const renderer = handle.getLinearRenderer();
    const committed = handle.setViewport({ start, end });
    if (!committed) return;
    pendingTargetPresentationRef.current = renderer
      ? { renderer, sessionId, id: targetViewport.id, ...committed }
      : null;
    const centerBp = (committed.start + committed.end) / 2;
    lastCommittedTargetViewportIdRef.current = targetViewport.id;
    lastViewportCenterRef.current = centerBp;
    onTargetViewportCommittedRef.current?.({ id: targetViewport.id, ...committed });
    recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, 'external-viewport-commit', {
      id: targetViewport.id,
      start: committed.start,
      end: committed.end,
      centerBp,
    });
  }, [
    fullAssemblyInteractionReady,
    length,
    rendererAssembly,
    rendererGenomeCommitEpoch,
    rendererReadyEpoch,
    sessionId,
    state.kind,
    targetViewport,
  ]);

  useEffect(() => {
    if (state.kind !== 'ready' || !isActive) return;
    const w = window as Window & {
      __test?: {
        workspaceViewer?: {
          getLastViewportCenterBp: () => number | null;
          getLastViewportRange: () => { start: number; end: number; wraps?: boolean } | null;
          scrollToBp: (bp: number) => void;
          setViewport: (range: { start: number; end: number }) => void;
          getSequenceLength: () => number;
          getCircular: () => boolean;
          selectAnnotationForTest: (annotation: SelectedAnnotation | null) => void;
          getFeatureDetailsState: () => { kind: string; message?: string };
          getSelectedBpRange: () => readonly [number, number] | null;
        };
      };
    };
    if (!w.__test) return;
    const bridge = {
      getLastViewportCenterBp: () => lastViewportCenterRef.current,
      getLastViewportRange: () => {
        const range = normalizeSequenceViewportRange(
          webglRef.current?.getViewportRange?.(),
          length
        );
        if (range) return range;
        const center = lastViewportCenterRef.current;
        return center == null ? null : { start: center, end: center + 1 };
      },
      scrollToBp: (bp: number) => {
        const centerBp = clampSequenceBp(Math.trunc(bp) - 1, length);
        lastViewportCenterRef.current = centerBp;
        webglRef.current?.setViewCenter?.(centerBp);
      },
      setViewport: (range: { start: number; end: number }) => {
        const start = Math.max(0, Math.min(length - 1, range.start));
        const end = Math.max(start + 1, Math.min(length, range.end));
        webglRef.current?.setViewport({ start, end });
      },
      getSequenceLength: () => length,
      getCircular: () => false,
      selectAnnotationForTest: (annotation: SelectedAnnotation | null) => {
        handleSelectedAnnotationChange(annotation);
      },
      getSelectedBpRange: () => webglRef.current?.getSelection?.() ?? null,
      getFeatureDetailsState: () => ({
        kind: featureDetailsStateRef.current.kind,
        message:
          featureDetailsStateRef.current.kind === 'error'
            ? toUserMessage(featureDetailsStateRef.current.message, 'tracks.loadFailed')
            : undefined,
      }),
    };
    w.__test.workspaceViewer = bridge;
    return () => {
      if (!w.__test || w.__test.workspaceViewer !== bridge) return;
      delete w.__test.workspaceViewer;
    };
  }, [handleCameraChange, handleSelectedAnnotationChange, isActive, state.kind, length]);

  const compiledBroadRasterSourceRequest = useMemo(
    () =>
      resolveCompiledBroadRasterSourceRequest({
        annotationSceneSourceRequest,
        descriptorRequest: prepackedAnnotationSceneCache.descriptor?.request,
        annotationAssetGeneration,
      }),
    [
      annotationAssetGeneration,
      annotationSceneSourceRequest,
      prepackedAnnotationSceneCache.descriptor?.runtimeCacheKey,
    ]
  );
  const compiledBroadRasterThemeMode = resolveCompiledBroadRasterThemeMode(
    prepackedAnnotationSceneCache.descriptor?.artifact?.themeMode
  );
  const compiledBroadTrackMountScopeKey = deriveCompiledBroadTrackMountScopeKey({
    requirementIdentityKey: compiledBroadSurfaceRequirement?.identityKey ?? null,
    stableSourceIdentity: stableAnnotationSourceIdentity,
    sourceScopeKey: annotationSourceScopeKey,
  });
  const compiledBroadTrackMountStateRef = useRef<{
    scopeKey: string;
    trackTypes: Set<string>;
  }>({ scopeKey: compiledBroadTrackMountScopeKey, trackTypes: new Set<string>() });
  compiledBroadTrackMountStateRef.current = retainCompiledBroadTrackMountTypes(
    compiledBroadTrackMountStateRef.current,
    compiledBroadTrackMountScopeKey,
    rendererEffectiveVisibleLayerTypes,
    compiledBroadBootstrapTrackType
  );
  const mountedCompiledBroadTrackTypes = [
    ...compiledBroadTrackMountStateRef.current.trackTypes,
  ].sort((left, right) => left.localeCompare(right));
  const annotationPyramidAvailableTypes = useAnnotationPyramidInventory({
    seedProduct: prepackedAnnotationSceneCache.descriptor?.request ?? null,
    requestKey: prepackedAnnotationSceneCache.descriptor?.runtimeCacheKey ?? null,
  });
  const pendingAnnotationRasterCommitted = resolvePendingAnnotationRasterCommitted({
    compiledBroadSurfaceRequirement,
    annotationRasterPolicyGateEnabled,
    pendingAnnotationMapperPolicy,
    annotationRasterAtomicCommit,
  });
  const presentationAnnotationMapperPolicy = resolvePresentationAnnotationMapperPolicy(
    pendingAnnotationMapperPolicy,
    pendingAnnotationRasterCommitted,
    annotationMapperPolicy
  );
  const presentationCache = resolvePresentationCache(
    compiledBroadSurfaceRequirement,
    prepackedAnnotationSceneCache,
    NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE
  );
  const currentPrepackedDescriptorRef = useRef(prepackedAnnotationSceneCache.descriptor);
  currentPrepackedDescriptorRef.current = prepackedAnnotationSceneCache.descriptor;
  const rendererEffectiveVisibleLayerTypesRef = useRef(rendererEffectiveVisibleLayerTypes);
  rendererEffectiveVisibleLayerTypesRef.current = rendererEffectiveVisibleLayerTypes;
  const rendererReadyEpochRef = useRef(rendererReadyEpoch);
  rendererReadyEpochRef.current = rendererReadyEpoch;
  const [mrnaPresentationEligibilityGeneration, setMrnaPresentationEligibilityGeneration] =
    useState(0);
  const mrnaPresentationEligibilityGenerationRef = useRef(mrnaPresentationEligibilityGeneration);
  mrnaPresentationEligibilityGenerationRef.current = mrnaPresentationEligibilityGeneration;
  const previousExactMrnaLayerContractRef = useRef(exactMrnaLayerContract);
  const prepackedAnnotationSceneFailureReportedRef = useRef(false);
  const [presentedPrepackedAnnotationOwner, setPresentedPrepackedAnnotationOwner] = useState<{
    receipt: PrepackedAssemblyAnnotationScenePresentationReceipt;
    rendererEpoch: number;
  } | null>(null);
  const presentationPolicyRequestId = resolvePresentationPolicyRequestId(
    pendingAnnotationRasterCommitted,
    pendingAnnotationMapperPolicy
  );
  useLayoutEffect(() => {
    const departedExactMrna = previousExactMrnaLayerContractRef.current && !exactMrnaLayerContract;
    previousExactMrnaLayerContractRef.current = exactMrnaLayerContract;
    if (departedExactMrna) {
      setMrnaPresentationEligibilityGeneration((generation) => generation + 1);
    }
    setPresentedPrepackedAnnotationOwner((current) => {
      if (!current) return current;
      const descriptor = prepackedAnnotationSceneCache.descriptor;
      const liveOwnerMatch = liveRendererMatchesPrepackedPresentation(
        webglRef.current,
        current.receipt
      );
      return exactMrnaLayerContract &&
        current.rendererEpoch === rendererReadyEpoch &&
        descriptor != null &&
        current.receipt.descriptor.sceneKey === descriptor.sceneKey &&
        current.receipt.descriptor.runtimeCacheKey === descriptor.runtimeCacheKey &&
        current.receipt.descriptor.artifact?.artifactKey === descriptor.artifact?.artifactKey &&
        liveOwnerMatch !== false
        ? current
        : null;
    });
  }, [
    prepackedAnnotationSceneCache.descriptor?.artifact?.artifactKey,
    prepackedAnnotationSceneCache.descriptor?.runtimeCacheKey,
    prepackedAnnotationSceneCache.descriptor?.sceneKey,
    exactMrnaLayerContract,
    rendererGenomeCommitEpoch,
    rendererReadyEpoch,
  ]);
  const handlePrepackedAnnotationScenePresented = useCallback(
    (receipt: PrepackedAssemblyAnnotationScenePresentationReceipt) => {
      const descriptor = currentPrepackedDescriptorRef.current;
      const receiptRendererEpoch = rendererReadyEpoch;
      if (
        receiptRendererEpoch !== rendererReadyEpochRef.current ||
        mrnaPresentationEligibilityGeneration !== mrnaPresentationEligibilityGenerationRef.current
      ) {
        return;
      }
      const exactActivePresentation = isExactActiveMrnaPresentation({
        receipt,
        descriptor,
        effectiveLayerTypes: rendererEffectiveVisibleLayerTypesRef.current,
        receiptRendererEpoch,
        currentRendererEpoch: receiptRendererEpoch,
      });
      const liveOwnerMatch = liveRendererMatchesPrepackedPresentation(webglRef.current, receipt);
      if (liveOwnerMatch === false) return;
      prepackedAnnotationSceneFailureReportedRef.current = false;
      onTrackReady?.('annotation');
      if (!exactActivePresentation) return;
      onPrepackedAnnotationScenePresented?.(receipt);
      setPresentedPrepackedAnnotationOwner((current) =>
        current?.rendererEpoch === receiptRendererEpoch &&
        current.receipt.ownerKey === receipt.ownerKey &&
        sameAnnotationMapperPolicy(current.receipt.runtimePolicy, receipt.runtimePolicy)
          ? current
          : { receipt, rendererEpoch: receiptRendererEpoch }
      );
      if (
        !compiledBroadSurfaceRequirement &&
        !annotationRasterPolicyGateEnabled &&
        presentationPolicyRequestId !== null &&
        receipt.requestId === presentationPolicyRequestId
      ) {
        const transaction = annotationPolicyTransactionRef.current;
        if (
          transaction.status === 'preparing' &&
          transaction.request.requestId === presentationPolicyRequestId &&
          sameAnnotationMapperPolicy(receipt.runtimePolicy, transaction.request.policy)
        ) {
          commitAnnotationMapperPolicy(transaction.request.policy);
        }
      }
    },
    [
      annotationRasterPolicyGateEnabled,
      commitAnnotationMapperPolicy,
      compiledBroadSurfaceRequirement,
      mrnaPresentationEligibilityGeneration,
      onPrepackedAnnotationScenePresented,
      onTrackReady,
      presentationPolicyRequestId,
      rendererReadyEpoch,
    ]
  );
  const prepackedAnnotationSceneReadiness = usePrepackedAssemblyAnnotationScene({
    cache: presentationCache,
    overviewFeaturesComplete,
    effectiveLayerTypes: prepackedSceneEffectiveLayerTypes(
      mrnaLayerVisible,
      rendererEffectiveVisibleLayerTypes
    ),
    requestedPolicy: { trackType: 'mRNA', ...presentationAnnotationMapperPolicy },
    activateOwner: exactMrnaLayerContract,
    publishBridge: exactMrnaLayerContract,
    requestId: presentationPolicyRequestId,
    onPresented: handlePrepackedAnnotationScenePresented,
    readinessGeneration: debugInstanceIdRef.current,
    readinessScopeKey: compiledResidentOwnerReadinessScopeKey,
    rendererReadyEpoch,
    rendererGenomeCommitEpoch,
    webglRef,
  });
  const prepackedAnnotationSceneReady = prepackedAnnotationSceneReadiness === 'loaded-hit';
  useEffect(() => {
    if (
      !compiledAnnotationResidentReadiness.selectedSetPrepared &&
      !prepackedAnnotationSceneReady
    ) {
      return;
    }
    scheduleAnnotationFineViewsPostPresent();
  }, [
    compiledAnnotationResidentReadiness.readinessScopeKey,
    compiledAnnotationResidentReadiness.selectedSetPrepared,
    prepackedAnnotationSceneReady,
    rendererReadyEpoch,
    scheduleAnnotationFineViewsPostPresent,
  ]);
  useEffect(() => {
    if (!requireFullAssemblyReadiness || !rendererAssembly) return;
    const failed =
      prepackedAnnotationSceneCache.status === 'error' ||
      prepackedAnnotationSceneCache.status === 'miss' ||
      prepackedAnnotationSceneReadiness === 'error';
    if (failed) {
      if (prepackedAnnotationSceneFailureReportedRef.current) return;
      prepackedAnnotationSceneFailureReportedRef.current = true;
      onTrackError?.(
        'annotation',
        'Cached reference data is present, but DNAForge could not load the annotation view.'
      );
      return;
    }
    if (
      prepackedAnnotationSceneFailureReportedRef.current &&
      prepackedAnnotationSceneReadiness === 'loaded-hit'
    ) {
      prepackedAnnotationSceneFailureReportedRef.current = false;
      onTrackReady?.('annotation');
    }
  }, [
    onTrackError,
    onTrackReady,
    prepackedAnnotationSceneCache.status,
    prepackedAnnotationSceneReadiness,
    rendererAssembly,
    requireFullAssemblyReadiness,
  ]);
  useEffect(() => {
    if (!pendingAnnotationMapperPolicy) return;
    if (compiledBroadSurfaceRequirement) return;
    if (
      rendererEffectiveVisibleLayerTypes.length !== 1 ||
      rendererEffectiveVisibleLayerTypes[0] !== 'mRNA' ||
      prepackedAnnotationSceneReadiness === 'ineligible'
    ) {
      failAnnotationPolicyTransaction(pendingAnnotationMapperPolicy.requestId, 'ineligible');
    } else if (prepackedAnnotationSceneReadiness === 'waiting-policy') {
      failAnnotationPolicyTransaction(pendingAnnotationMapperPolicy.requestId, 'policy-mismatch');
    } else if (prepackedAnnotationSceneReadiness === 'error') {
      failAnnotationPolicyTransaction(pendingAnnotationMapperPolicy.requestId, 'cache-error');
    }
  }, [
    compiledBroadSurfaceRequirement,
    failAnnotationPolicyTransaction,
    pendingAnnotationMapperPolicy,
    prepackedAnnotationSceneReadiness,
    rendererEffectiveVisibleLayerTypes,
  ]);
  const livePresentedPrepackedOwnerMatch = resolveLivePresentedPrepackedOwnerMatch(
    presentedPrepackedAnnotationOwner,
    (owner) => liveRendererMatchesPrepackedPresentation(webglRef.current, owner.receipt)
  );
  const activePrepackedMrnaPresentation = isActivePrepackedMrnaPresentation({
    livePresentedPrepackedOwnerMatch,
    exactActive: isExactActiveMrnaPresentation({
      receipt: presentedPrepackedReceipt(presentedPrepackedAnnotationOwner),
      descriptor: prepackedAnnotationSceneCache.descriptor,
      effectiveLayerTypes: rendererEffectiveVisibleLayerTypes,
      receiptRendererEpoch: presentedPrepackedRendererEpoch(presentedPrepackedAnnotationOwner),
      currentRendererEpoch: rendererReadyEpoch,
    }),
  });
  useLayoutEffect(() => {
    if (!presentedPrepackedAnnotationOwner || livePresentedPrepackedOwnerMatch !== false) return;
    setMrnaPresentationEligibilityGeneration((generation) => generation + 1);
    setPresentedPrepackedAnnotationOwner(null);
  }, [livePresentedPrepackedOwnerMatch, presentedPrepackedAnnotationOwner]);
  const annotationPreparationState = resolveAnnotationPreparationUiState(
    annotationPolicyTransaction.status,
    pendingAnnotationMapperPolicy
  );
  const annotationPolicyBridgeStateRef = useRef({
    committedPolicy: annotationMapperPolicy,
    requestedPolicy: pendingAnnotationMapperPolicyValue(
      pendingAnnotationMapperPolicy,
      annotationMapperPolicy
    ),
    pendingRequestId: pendingAnnotationMapperPolicyRequestId(pendingAnnotationMapperPolicy),
    preparationState: annotationPreparationState,
  });
  annotationPolicyBridgeStateRef.current = {
    committedPolicy: annotationMapperPolicy,
    requestedPolicy: pendingAnnotationMapperPolicyValue(
      pendingAnnotationMapperPolicy,
      annotationMapperPolicy
    ),
    pendingRequestId: pendingAnnotationMapperPolicyRequestId(pendingAnnotationMapperPolicy),
    preparationState: annotationPreparationState,
  };
  useEffect(() => {
    if (typeof window === 'undefined' || !shouldEnableTestBridge(import.meta.env)) return;
    const target = window as AssemblyAnnotationPolicyBridgeTarget;
    if (!target.__test) return;
    return installAssemblyAnnotationPolicyTestBridge(target, {
      getPolicy: () => annotationPolicyBridgeStateRef.current.requestedPolicy,
      getTransaction: () => annotationPolicyBridgeStateRef.current,
      requestPolicy: requestAnnotationMapperPolicy,
    });
  }, [requestAnnotationMapperPolicy]);
  useEffect(() => {
    if (
      !requireFullAssemblyReadiness ||
      !rendererAssembly ||
      !assemblyRoutingEnabled ||
      state.kind !== 'ready'
    ) {
      setAssemblyColdInteractionReady(!requireFullAssemblyReadiness || !rendererAssembly);
      return;
    }
    if (compiledBroadSurfaceRequirement) {
      if (!assemblyColdInteractionReady) setAssemblyColdInteractionReady(true);
      return;
    }
    if (
      prepackedAnnotationSceneReadiness === 'error' ||
      prepackedAnnotationSceneReadiness === 'ineligible'
    ) {
      if (!assemblyColdInteractionReady) {
        setAssemblyColdInteractionReady(true);
      }
      return;
    }
    if (!prepackedAnnotationSceneReady) {
      return;
    }
    let cancelled = false;
    const frameId = requestAnimationFrame(() => {
      if (cancelled) return;
      setAssemblyColdInteractionReady(true);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [
    assemblyRoutingEnabled,
    compiledBroadSurfaceRequirement,
    prepackedAnnotationSceneReadiness,
    prepackedAnnotationSceneReady,
    rendererAssembly,
    requireFullAssemblyReadiness,
    state.kind,
    assemblyColdInteractionReady,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined' || !shouldEnableTestBridge(import.meta.env)) return;
    const coverage = pileupStreaming.firstInteractionReadiness.inspect();
    const activeOwnerOracle = readActivePrepackedAnnotationSceneOwnerOracle();
    const activeOwner =
      activeOwnerOracle?.verdict === 'exactly-one' ? activeOwnerOracle.owner : null;
    const renderer = webglRef.current?.getLinearRenderer?.() as
      | LiveCompiledAnnotationInteractionReader
      | null
      | undefined;
    const interactionAuthority =
      renderer?.getCompiledBroadAnnotationInteractionAuthoritySnapshot?.();
    const validInteractionAuthority =
      interactionAuthority?.contract === COMPILED_BROAD_ANNOTATION_INTERACTION_AUTHORITY_SNAPSHOT_V1
        ? interactionAuthority
        : null;
    const compiledAuthority = compiledBroadSurfaceRequirement
      ? qualifyCompiledAnnotationInteractionAuthority({
          receipt: compiledAnnotationResidentReadiness,
          rendererCompactOwnerKeys: validInteractionAuthority?.preparedOwnerKeys ?? [],
          rendererCompactRosterGeneration: validInteractionAuthority?.residentGeneration ?? 0,
        })
      : null;
    const authorityKind = compiledBroadSurfaceRequirement
      ? 'compiled-resident-roster'
      : 'active-prepacked-owner';
    const legacyOwnerReady = Boolean(
      prepackedAnnotationSceneReady && activeOwner?.loaded && activeOwner.gpuPrepared
    );
    const annotationActionReady = compiledBroadSurfaceRequirement
      ? compiledAuthority !== null
      : legacyOwnerReady;
    const ready = fullAssemblyInteractionReady && annotationActionReady;
    const authorityKey = compiledBroadSurfaceRequirement
      ? (compiledAuthority?.authorityKey ?? null)
      : activeOwner
        ? JSON.stringify([
            'active-prepacked-owner.v1',
            activeOwner.ownerKey,
            activeOwner.ownerGeneration,
            prepackedAnnotationSceneCache.descriptor?.sceneKey ?? null,
          ])
        : null;
    const target = window as Window & {
      __dna708FullAssemblyInteractionReadiness?: Record<string, unknown>;
    };
    const previous = target.__dna708FullAssemblyInteractionReadiness;
    const sameKey =
      previous?.runGeneration === debugInstanceIdRef.current &&
      previous?.authorityKind === authorityKind &&
      previous?.authorityKey === authorityKey &&
      previous?.webglInstanceId === (activeOwnerOracle?.instanceId ?? null) &&
      previous?.webglInstanceCreatedAt === (activeOwnerOracle?.instanceCreatedAt ?? null) &&
      previous?.coverageKey === coverage.key;
    const now = performance.now();
    target.__dna708FullAssemblyInteractionReadiness = {
      runGeneration: debugInstanceIdRef.current,
      authorityKind,
      authorityKey,
      webglInstanceId: activeOwnerOracle?.instanceId ?? null,
      webglInstanceCreatedAt: activeOwnerOracle?.instanceCreatedAt ?? null,
      ownerKey: compiledAuthority ? null : (activeOwner?.ownerKey ?? null),
      ownerGeneration:
        compiledAuthority?.residentRosterGeneration ?? activeOwner?.ownerGeneration ?? null,
      coordinateReady: fullAssemblyInteractionReady,
      annotationActionReady,
      ready,
      readyAt:
        ready && sameKey && typeof previous?.readyAt === 'number'
          ? previous.readyAt
          : ready
            ? now
            : null,
      sceneKey:
        compiledAuthority?.readinessScopeKey ??
        prepackedAnnotationSceneCache.descriptor?.sceneKey ??
        null,
      selectedTrackTypes:
        compiledAuthority?.selectedTrackTypes ??
        compiledAnnotationResidentReadiness.selectedTrackTypes,
      expectedOwnerKeys: compiledAuthority?.expectedOwnerKeys ?? [],
      isoformMode: annotationMapperPolicy.isoformMode,
      laneLimit: annotationMapperPolicy.laneLimit,
      coverageKey: coverage.key,
      coverageReason: coverage.reason,
      updatedAt: now,
    };
  }, [
    assemblyColdInteractionReady,
    annotationMapperPolicy.isoformMode,
    annotationMapperPolicy.laneLimit,
    compiledAnnotationResidentReadiness,
    compiledBroadSurfaceRequirement,
    fullAssemblyInteractionReady,
    pileupStreaming.firstInteractionReadiness,
    prepackedAnnotationSceneCache.descriptor?.sceneKey,
    prepackedAnnotationSceneReady,
  ]);

  useEffect(
    () => () => {
      if (typeof window === 'undefined' || !shouldEnableTestBridge(import.meta.env)) return;
      const target = window as Window & {
        __dna708FullAssemblyInteractionReadiness?: { runGeneration?: unknown };
      };
      if (
        target.__dna708FullAssemblyInteractionReadiness?.runGeneration ===
        debugInstanceIdRef.current
      ) {
        delete target.__dna708FullAssemblyInteractionReadiness;
      }
    },
    []
  );

  const [compatibilityProjection, setCompatibilityProjection] =
    useState<IndexedGenomeCompatibilityProjection | null>(null);
  if (shouldClearCompatibilityProjection(compiledBroadOwnsAssembly, compatibilityProjection)) {
    setCompatibilityProjection(null);
  }
  const handleCompatibilityProjectionChange = useCallback(
    (next: IndexedGenomeCompatibilityProjection) => {
      setCompatibilityProjection((previous) => (previous === next ? previous : next));
    },
    []
  );
  const {
    resolverOutput,
    annotationIndex,
    annotationViewportResolvedFeaturesByGeneration,
    annotationOverviewGlyphPayload,
    annotationOverviewGlyphPayloadByteCount,
    activeTileNativeScene,
    tileNativeRendererGenome,
    activeFilteredRendererFeatures,
    invariantViolations,
  } = compatibilityProjectionFields(compiledBroadOwnsAssembly, compatibilityProjection);

  const assemblyObservedAvailableTypes = useMemo(() => {
    const prebuiltTypes =
      overviewTextureStatus === 'loaded' ? (overviewTexture?.manifest.layerTypes ?? []) : [];
    if (!compiledBroadOwnsAssembly) {
      return (
        compatibilityProjection?.assemblyObservedAvailableTypes ??
        assemblyAnnotationLayerTypes(null, prebuiltTypes)
      );
    }
    const types = new Set(prebuiltTypes);
    for (const feature of assemblyFeatures ?? []) types.add(annotationLayerType(feature));
    for (const features of assemblyByChrom?.values() ?? []) {
      for (const feature of features) types.add(annotationLayerType(feature));
    }
    return [...types].sort((left, right) => left.localeCompare(right));
  }, [
    assemblyByChrom,
    assemblyFeatures,
    compatibilityProjection?.assemblyObservedAvailableTypes,
    compiledBroadOwnsAssembly,
    overviewTexture,
    overviewTextureStatus,
  ]);
  const assemblyAnnotationTrackContractKey = rendererAssembly?.id ?? null;
  const assemblyAnnotationTrackContractCandidates = useMemo(
    () =>
      rendererAssembly
        ? selectableAnnotationLayerTypesForGlyphMode(
            assemblyAnnotationTrackTypes ?? assemblyObservedAvailableTypes,
            glyphV2Enabled,
            { inventory: assemblyAnnotationTrackTypes ? 'resolved' : 'source' }
          )
        : [],
    [assemblyAnnotationTrackTypes, assemblyObservedAvailableTypes, glyphV2Enabled, rendererAssembly]
  );
  const [retainedAssemblyAnnotationTrackContract, setRetainedAssemblyAnnotationTrackContract] =
    useState<{ key: string | null; types: string[] }>({ key: null, types: [] });
  const retainedAssemblyAnnotationTrackTypes = resolveRetainedAssemblyAnnotationTrackTypes(
    retainedAssemblyAnnotationTrackContract,
    assemblyAnnotationTrackContractKey
  );

  useEffect(() => {
    if (!rendererAssembly || assemblyAnnotationTrackContractKey == null) return;
    setRetainedAssemblyAnnotationTrackContract((prev) => {
      const retained = prev.key === assemblyAnnotationTrackContractKey ? prev.types : [];
      const next = uniqueSorted([...retained, ...assemblyAnnotationTrackContractCandidates]);
      if (prev.key === assemblyAnnotationTrackContractKey && sameStringArray(prev.types, next)) {
        return prev;
      }
      return { key: assemblyAnnotationTrackContractKey, types: next };
    });
  }, [
    assemblyAnnotationTrackContractCandidates,
    assemblyAnnotationTrackContractKey,
    rendererAssembly,
  ]);
  const assemblyAvailableTypes = useMemo(
    () =>
      rendererAssembly
        ? assemblyAnnotationTrackTypes !== undefined
          ? assemblyAnnotationTrackContractCandidates
          : uniqueSorted([
              ...retainedAssemblyAnnotationTrackTypes,
              ...assemblyAnnotationTrackContractCandidates,
            ])
        : assemblyObservedAvailableTypes,
    [
      assemblyAnnotationTrackContractCandidates,
      assemblyAnnotationTrackTypes,
      assemblyObservedAvailableTypes,
      rendererAssembly,
      retainedAssemblyAnnotationTrackTypes,
    ]
  );

  useEffect(() => {
    onAnnotationIndexBuilt?.(annotationIndex);
  }, [annotationIndex, onAnnotationIndexBuilt]);

  const lastCommittedSearchHighlightIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const handle = webglRef.current;
    if (!handle) return;
    if (!searchHighlight) {
      lastCommittedSearchHighlightIdRef.current = null;
      handle.setSelection?.(null, null);
      handle.setProteinSearchHighlightRanges?.(null);
      return;
    }
    if (lastCommittedSearchHighlightIdRef.current === searchHighlight.id) return;
    lastCommittedSearchHighlightIdRef.current = searchHighlight.id;
    const start = Math.max(0, Math.min(length, Math.floor(searchHighlight.start)));
    const end = Math.max(start + 1, Math.min(length, Math.ceil(searchHighlight.end)));
    const proteinSegments = searchHighlight.proteinSegments
      ?.map((segment) => {
        const segmentStart = Math.max(0, Math.min(length, Math.floor(segment.start)));
        const segmentEnd = Math.max(segmentStart + 1, Math.min(length, Math.ceil(segment.end)));
        return [segmentStart, segmentEnd] as const;
      })
      .filter(([segmentStart, segmentEnd]) => segmentEnd > segmentStart);
    if (proteinSegments?.length) {
      handle.setSelection?.(null, null);
      handle.setProteinSearchHighlightRanges?.(proteinSegments);
    } else {
      handle.setProteinSearchHighlightRanges?.(null);
      handle.setSelection?.(start, end - 1);
    }
  }, [searchHighlight, state.kind, length]);

  const availableTypes = useMemo(() => {
    if (rendererAssembly && assemblyAnnotationTrackTypes !== undefined) {
      return assemblyAvailableTypes;
    }
    const observed = uniqueSorted([
      ...(assemblyAnnotationTrackTypes === undefined ? defaultVisibleTypes : []),
      ...assemblyAvailableTypes,
      ...annotationPyramidAvailableTypes,
      ...assemblyAnnotationPages.map((page) => page.trackId),
      ...(resolverOutput?.availableTypes ?? []),
      ...annotationViewportTiles.flatMap((tile) => tile.layerTypes),
      ...[...(annotationViewportResolvedFeaturesByGeneration?.values() ?? [])].flatMap((features) =>
        uniqueFeatureTypes(features)
      ),
    ]);
    return selectableAnnotationLayerTypesForGlyphMode(observed, glyphV2Enabled);
  }, [
    annotationViewportResolvedFeaturesByGeneration,
    annotationViewportTiles,
    annotationPyramidAvailableTypes,
    assemblyAnnotationPages,
    assemblyAnnotationTrackTypes,
    assemblyAvailableTypes,
    defaultVisibleTypes,
    glyphV2Enabled,
    rendererAssembly,
    resolverOutput,
  ]);

  const trackPreferences = useMemo<AnnotationTrackPreferences>(
    () => ({
      visibilityByTrackId: new Map<string, boolean>(
        availableTypes.map((t) => [t, visibleTypes.has(t)])
      ),
      orderedTrackIds: orderedAnnotationTrackIds,
    }),
    [availableTypes, orderedAnnotationTrackIds, visibleTypes]
  );
  const annotationTrackRegistry = useMemo(
    () => deriveAnnotationTrackRegistry(availableTypes, trackPreferences),
    [availableTypes, trackPreferences]
  );
  useEffect(() => {
    onAnnotationTrackOrderChange?.(annotationTrackRegistry.map((track) => track.trackId));
  }, [annotationTrackRegistry, onAnnotationTrackOrderChange]);

  const rendererAnnotationSearchFocusFeature = useMemo<Feature | null>(() => {
    if (!rendererAnnotationSearchFocus) return null;
    if (rendererAssembly) {
      if (!stableAnnotationSourceIdentity) return null;
      if (assemblyAnnotationSearchFocusFeature) return assemblyAnnotationSearchFocusFeature;
      const carrier = resolveAssemblyAnnotationSearchFocusFeature({
        pages: assemblyAnnotationPages,
        genomeIdentity: stableAnnotationSourceIdentity,
        focus: rendererAnnotationSearchFocus,
      });
      return carrier;
    }
    if (!resolverOutput || searchHighlight?.annotationFeatureIndex === undefined) return null;
    const carrier = resolveSingleChromosomeAnnotationSearchFocusCarrier({
      features: resolverOutput.resolvedFeatures as TranscriptCarrierFeature[],
      featureIndex: searchHighlight.annotationFeatureIndex,
      genomeIdentity: sourceFingerprintForManifest(manifest),
      focus: rendererAnnotationSearchFocus,
    });
    if (!carrier) return null;
    const projected = applyDensityControls(
      [carrier],
      manifest.chrom,
      length,
      new Set([rendererAnnotationSearchFocus.trackId]),
      laneLimit,
      ANNOTATION_LANE_STACKING_BY_TYPE
    ).features[0];
    if (!projected) return null;
    return {
      ...projected,
      annotationTrackId: rendererAnnotationSearchFocus.trackId,
      canonicalIdentity: rendererAnnotationSearchFocus.canonicalIdentity,
    };
  }, [
    laneLimit,
    length,
    manifest,
    rendererAnnotationSearchFocus,
    rendererAssembly,
    assemblyAnnotationPages,
    assemblyAnnotationSearchFocusFeature,
    stableAnnotationSourceIdentity,
    resolverOutput,
    searchHighlight?.annotationFeatureIndex,
  ]);
  const rendererAnnotationSearchFocusForMap = resolveRendererAnnotationSearchFocusForMap(
    rendererAssembly,
    rendererAnnotationSearchFocusFeature,
    rendererAnnotationSearchFocus
  );

  const sceneAnnotationViewportTile = sceneAnnotationViewportTileForAssembly(
    rendererAssembly,
    annotationViewportTile
  );
  const sceneAnnotationViewportTiles = sceneAnnotationViewportTilesForAssembly(
    rendererAssembly,
    annotationViewportTiles
  );

  const annotationPresentationSourceIdentity = resolveAnnotationPresentationSourceIdentity({
    compiledBroadOwnsAssembly,
    stableAnnotationSourceIdentity,
    annotationSourceScopeKey,
    rendererAssemblyId: rendererAssembly?.id,
    tileNativeRendererGenome,
  });
  const annotationPresentationPolicyKey = resolveAnnotationPresentationPolicyKey(
    rendererAssembly,
    assemblyAnnotationSourcePageStreamKey
  );
  const annotationPresentationUsesImmutablePolicyPlane = compiledBroadOwnsAssembly;
  const requestedAnnotationResidentPages = useMemo(
    () =>
      filterAnnotationPresentationPagesForCodonCarriers(
        assemblyAnnotationPages,
        rendererEffectiveVisibleLayerTypes
      ),
    [assemblyAnnotationPages, rendererEffectiveVisibleLayerKey]
  );
  const requestedAnnotationResidentLayerTypes = useMemo(
    () => [...new Set(requestedAnnotationResidentPages.map((page) => page.trackId))],
    [requestedAnnotationResidentPages]
  );
  const requestedAnnotationResidentCoverage = useMemo(
    () => mergeAnnotationPageCoverage(requestedAnnotationResidentPages),
    [requestedAnnotationResidentPages]
  );
  const residentPageSemanticIdentity = useMemo(
    () => ({
      contract: 'annotation-codon-carrier-page-publication.v1',
      sourceIdentity: annotationPresentationSourceIdentity,
      policyKey: annotationPresentationPolicyKey,
      pages: requestedAnnotationResidentPages,
      exactCoverage: requestedAnnotationResidentCoverage,
      requestedLayerTypes: requestedAnnotationResidentLayerTypes.join('\u0000'),
    }),
    [
      annotationPresentationPolicyKey,
      annotationPresentationSourceIdentity,
      requestedAnnotationResidentCoverage,
      requestedAnnotationResidentPages,
      requestedAnnotationResidentLayerTypes,
    ]
  );
  const compatibilitySemanticIdentity = useMemo(
    () => ({ genome: tileNativeRendererGenome, pages: assemblyAnnotationPages }),
    [assemblyAnnotationPages, tileNativeRendererGenome]
  );
  const annotationResidentPagePublicationCandidate = useMemo<
    AnnotationResidentPagePublicationCandidate | undefined
  >(() => {
    if (
      !rendererAssembly ||
      !annotationPresentationSourceIdentity ||
      !annotationPresentationPolicyKey
    ) {
      return undefined;
    }
    return {
      contract: 'annotation-codon-carrier-page-publication.v1',
      semanticIdentity: residentPageSemanticIdentity,
      sourceIdentity: annotationPresentationSourceIdentity,
      genomeLengthBp: rendererAssembly.totalLengthBp,
      policyKey: annotationPresentationPolicyKey,
      requestedLayerTypes: requestedAnnotationResidentLayerTypes,
      exactCoverage: requestedAnnotationResidentCoverage,
      pages: requestedAnnotationResidentPages,
    };
  }, [
    annotationPresentationPolicyKey,
    annotationPresentationSourceIdentity,
    rendererAssembly,
    requestedAnnotationResidentCoverage,
    requestedAnnotationResidentPages,
    requestedAnnotationResidentLayerTypes,
    residentPageSemanticIdentity,
  ]);
  useLayoutEffect(() => {
    if (!annotationResidentPagePublicationCandidate) return;
    if (cameraTiles.cameraInteractionActiveRef.current || rendererInteractionQuietDelayMs() > 0) {
      pendingAnnotationResidentPageCandidateRef.current =
        annotationResidentPagePublicationCandidate;
      const tileHost = annotationViewportTileHostRef.current;
      if (tileHost) {
        cameraTiles.flushWhenQuiet(tileHost);
      }
      return;
    }
    setCommittedAnnotationResidentPageCandidate((previous) =>
      previous?.semanticIdentity === annotationResidentPagePublicationCandidate.semanticIdentity
        ? previous
        : annotationResidentPagePublicationCandidate
    );
  }, [annotationResidentPagePublicationCandidate]);
  const annotationResidentPagePublication = useAnnotationResidentPagePublication(
    committedAnnotationResidentPageCandidate
  );

  const annotationPresentationSnapshotCandidate = useMemo<
    AnnotationPresentationSnapshotCandidate | undefined
  >(() => {
    if (
      annotationPresentationUsesImmutablePolicyPlane ||
      !rendererAssembly ||
      !tileNativeRendererGenome ||
      !annotationPresentationSourceIdentity ||
      !annotationPresentationPolicyKey
    ) {
      return undefined;
    }
    return {
      semanticIdentity: compatibilitySemanticIdentity,
      sourceIdentity: annotationPresentationSourceIdentity,
      genomeLengthBp: rendererAssembly.totalLengthBp,
      policyKey: annotationPresentationPolicyKey,
      features: tileNativeRendererGenome.features ?? [],
      requestedLayerTypes: tileNativeRendererGenome.annotationLayerTypes ?? [],
      layout: tileNativeRendererGenome.annotationLayout ?? {
        maxAnnotationLane: -1,
        maxCdsLane: -1,
      },
      exactCoverage: tileNativeRendererGenome.annotationExactCoverage ?? [],
    };
  }, [
    annotationPresentationUsesImmutablePolicyPlane,
    annotationPresentationPolicyKey,
    annotationPresentationSourceIdentity,
    compatibilitySemanticIdentity,
    rendererAssembly,
    tileNativeRendererGenome,
  ]);
  const annotationPresentationSnapshot = useAnnotationPresentationSnapshot(
    annotationPresentationSnapshotCandidate
  );

  const assemblyShellAnnotationSourcePlacementProvenance =
    resolveAssemblyShellAnnotationSourcePlacementProvenance(
      compiledBroadSurfaceRequirement,
      annotationSourcePlacementProvenance
    );

  const assemblyRendererGenomeShell = useMemo<Genome | null>(() => {
    if (!rendererAssembly) return null;
    const sourceIdentity = compiledBroadOwnsAssembly
      ? (stableAnnotationSourceIdentity ?? annotationSourceScopeKey ?? rendererAssembly.id)
      : (stableAnnotationSourceIdentity ??
        annotationPresentationSourceIdentity ??
        annotationSourceScopeKey ??
        rendererAssembly.id);
    return {
      name: rendererAssembly.displayName,
      sourceIdentity,
      length: rendererAssembly.totalLengthBp,
      circular: false,
      sequenceAvailable: Boolean(manifest.fastaPath),
      annotationLayerTypes: rendererEffectiveVisibleLayerTypes,
      ...(assemblyShellAnnotationSourcePlacementProvenance
        ? {
            annotationSourcePlacementProvenance: assemblyShellAnnotationSourcePlacementProvenance,
          }
        : undefined),
    };
  }, [
    annotationPresentationSourceIdentity,
    assemblyShellAnnotationSourcePlacementProvenance,
    annotationSourceScopeKey,
    Boolean(manifest.fastaPath),
    compiledBroadOwnsAssembly,
    rendererAssembly?.displayName,
    rendererAssembly?.id,
    rendererAssembly?.totalLengthBp,
    rendererEffectiveVisibleLayerKey,
    stableAnnotationSourceIdentity,
  ]);
  const rendererGenomeForMap = resolveRendererGenomeForMap(
    rendererAssembly,
    assemblyRendererGenomeShell,
    tileNativeRendererGenome
  );
  const rendererGenomeSourceIdentity = resolveRendererGenomeSourceIdentity(rendererGenomeForMap);
  const annotationPresentationSnapshotForMap = resolveAnnotationPresentationSnapshotForMap(
    compiledBroadOwnsAssembly,
    annotationPresentationSnapshot,
    rendererGenomeSourceIdentity,
    rendererGenomeForMap?.length
  );
  const annotationResidentPagePublicationForMap = resolveAnnotationResidentPagePublicationForMap(
    annotationResidentPagePublication,
    rendererGenomeSourceIdentity,
    rendererGenomeForMap?.length
  );

  useEffect(() => {
    const hooks = typeof window !== 'undefined' ? (window as IndexedGenomeDebugWindow) : null;
    if (!hooks?.__webglExposeForTests) return;
    const compiledDebugReady = compiledBroadOwnsAssembly && Boolean(assemblyRendererGenomeShell);
    const legacyDebugReady = Boolean(
      resolverOutput && activeTileNativeScene && tileNativeRendererGenome
    );
    if (
      state.kind !== 'ready' ||
      isPendingAnnotationTileState(state.summaryTileState) ||
      !activeFilteredRendererFeatures ||
      (!compiledDebugReady && !legacyDebugReady)
    ) {
      delete hooks.__indexedGenomeViewerDebug;
      return;
    }
    const w = window as Window & { __indexedGenomeViewerRenderCount?: number };
    w.__indexedGenomeViewerRenderCount = (w.__indexedGenomeViewerRenderCount ?? 0) + 1;
    const debugRendererGenome = rendererGenomeForMap!;
    const rendererFeatures = tileNativeRendererGenome?.features ?? [];
    const structuralFeatures = compiledBroadOwnsAssembly
      ? requestedAnnotationResidentPages.flatMap((page) => page.features)
      : rendererFeatures;
    hooks.__indexedGenomeFindCdsLoci = (max?: number) =>
      findCdsLociFromRendererFeatures(rendererFeatures, max);
    hooks.__indexedGenomeFindFeatureStructures = (query: string, max?: number) =>
      findFeatureStructuresFromRendererFeatures(structuralFeatures, query, max);
    hooks.__indexedGenomeJumpToSpliceDemo = () => {
      const target = pickSpliceDemoFeature(resolverOutput?.resolvedFeatures ?? []);
      const handle = webglRef.current;
      if (!target || !handle) return false;
      const maxVisibleBp = 30_000;
      const span = target.end - target.start;
      const pad = Math.max(500, Math.ceil(span * 0.1));
      const visibleBp = Math.min(span + 2 * pad, maxVisibleBp);
      const center = (target.start + target.end) / 2;
      const start = Math.max(0, center - visibleBp / 2);
      handle.setViewport({ start, end: Math.min(length, start + visibleBp) });
      return true;
    };
    hooks.__indexedGenomeViewerDebug = {
      instanceId: debugInstanceIdRef.current,
      get compiledBroadRasterLoaderDiagnostics() {
        return getCompiledBroadRasterLoaderDiagnostics();
      },
      get compiledBroadRasterLoaderDiagnosticsByTrack() {
        return getCompiledBroadRasterLoaderDiagnosticsByTrack();
      },
      compiledAnnotationResidentReadiness,
      rendererReadyEpoch,
      rendererGenomeCommitEpoch,
      annotationAuthority: {
        sourceScopeKey: annotationSourceScopeKey,
        stableSourceIdentity: stableAnnotationSourceIdentity,
        admittedSourceIdentity,
        sourceRequestPresent: annotationSceneSourceRequest !== null,
        seedCacheStatus: prepackedAnnotationSceneCache.status,
        seedDescriptorSourceIdentity:
          prepackedAnnotationSceneCache.descriptor?.sourceIdentity ?? null,
      },
      sessionId: sessionId ?? null,
      chrom: manifest.chrom,
      length,
      rawFeatureCount: rendererAssembly
        ? activeFilteredRendererFeatures.typeFilteredCount
        : (state.sourceRecordCount ?? state.tileFeatures.length),
      tileFeatureCount: rendererAssembly
        ? activeFilteredRendererFeatures.typeFilteredCount
        : state.tileFeatures.length,
      resolvedFeatureCount: rendererAssembly
        ? activeFilteredRendererFeatures.typeFilteredCount
        : (resolverOutput?.resolvedFeatures.length ?? 0),
      typeFilteredFeatureCount: activeFilteredRendererFeatures.typeFilteredCount,
      postLaneFeatureCount: activeFilteredRendererFeatures.features.length,
      renderedFeatureCount: rendererFeatures.length,
      droppedByLaneCap: activeFilteredRendererFeatures.droppedCount,
      featureModel: state.featureModel,
      tileCacheState: state.tileCacheState,
      annotationOverviewTile: {
        state: state.summaryTileState,
        fidelity: state.summaryTileFidelity,
        laneEpoch:
          activeTileNativeScene?.tileSlots.find(
            (slot) => slot.kind === 'annotation' && slot.fidelity === 'summary'
          )?.laneEpoch ?? null,
        recordCount: state.tileFeatures.length,
        payloadGlyphCount: annotationGlyphPayloadCount(annotationOverviewGlyphPayload),
        payloadCompactGeometryCount: annotationOverviewGlyphPayload?.compactGeometry?.length ?? 0,
        payloadTypeFilteredCount: annotationOverviewGlyphPayload?.typeFilteredCount ?? 0,
        payloadDroppedCount: annotationOverviewGlyphPayload?.droppedCount ?? 0,
        payloadByteCount: annotationOverviewGlyphPayloadByteCount,
      },
      scene: activeTileNativeScene,
      get sceneHasWholeFeaturePayload() {
        return activeTileNativeScene
          ? indexedGenomeSceneHasWholeFeaturePayload(activeTileNativeScene)
          : false;
      },
      get sceneInvariant() {
        return activeTileNativeScene
          ? evaluateIndexedGenomeSceneInvariants(activeTileNativeScene)
          : null;
      },
      rendererGenomeSummary: {
        name: debugRendererGenome.name,
        length: debugRendererGenome.length,
        featureCount: rendererFeatures.length,
        sequenceWindowBp: sequenceWindow?.bases.length ?? 0,
        hasWholeSequence: Boolean(debugRendererGenome.sequence),
      },
      rendererFeatureLaneSamples: buildRendererFeatureLaneSamples(rendererFeatures),
      invariantViolations,
      availableTypes,
      visibleTypes: [...rendererEffectiveVisibleTypes].sort(),
      laneLimit,
      sequenceLoadedBp: state.sequence.length,
      sequenceWindow: sequenceWindow
        ? {
            startBp: sequenceWindow.startBp,
            endBp: sequenceWindow.endBp,
          }
        : null,
      annotationViewportTile: sceneAnnotationViewportTile
        ? {
            startBp: sceneAnnotationViewportTile.startBp,
            endBp: sceneAnnotationViewportTile.endBp,
            state: sceneAnnotationViewportTile.state,
            fidelity: sceneAnnotationViewportTile.fidelity,
            laneEpoch: sceneAnnotationViewportTile.laneEpoch ?? null,
            recordCount: sceneAnnotationViewportTile.recordCount,
            byteCount: sceneAnnotationViewportTile.byteCount,
          }
        : null,
      annotationViewportTiles: sceneAnnotationViewportTiles.map((tile) => ({
        startBp: tile.startBp,
        endBp: tile.endBp,
        generation: tile.generation,
        state: tile.state,
        fidelity: tile.fidelity,
        laneEpoch: tile.laneEpoch ?? null,
        recordCount: tile.recordCount,
        byteCount: tile.byteCount,
      })),
      annotationResidentPageReadiness: {
        requestedPageCount: requestedAnnotationResidentPages.length,
        publishedPageCount: annotationResidentPagePublication?.pages.length ?? 0,
        publicationGeneration: annotationResidentPagePublication?.generation ?? null,
        pendingCommit: pendingAnnotationResidentPageCandidateRef.current !== null,
      },
      loadTiming: state.loadTiming,
    };
    recordIndexedGenomeViewerEvent(debugInstanceIdRef.current, 'debug-ready', {
      renderedFeatureCount: rendererFeatures.length,
      legacyFilteredFeatureCount: activeFilteredRendererFeatures.features.length,
      annotationOverviewGlyphCount: annotationGlyphPayloadCount(annotationOverviewGlyphPayload),
      annotationOverviewPayloadByteCount: annotationOverviewGlyphPayloadByteCount,
      cacheState: state.tileCacheState,
    });
    return () => {
      if (hooks.__indexedGenomeViewerDebug?.instanceId === debugInstanceIdRef.current) {
        delete hooks.__indexedGenomeViewerDebug;
        delete hooks.__indexedGenomeFindCdsLoci;
        delete hooks.__indexedGenomeFindFeatureStructures;
        delete hooks.__indexedGenomeJumpToSpliceDemo;
      }
    };
  }, [
    state,
    resolverOutput,
    availableTypes,
    activeFilteredRendererFeatures,
    activeTileNativeScene,
    assemblyRendererGenomeShell,
    compiledBroadOwnsAssembly,
    tileNativeRendererGenome,
    rendererGenomeForMap,
    rendererEffectiveVisibleTypes,
    laneLimit,
    manifest.chrom,
    length,
    sequenceWindow,
    sceneAnnotationViewportTile,
    annotationOverviewGlyphPayload,
    annotationOverviewGlyphPayloadByteCount,
    requestedAnnotationResidentPages,
    annotationResidentPagePublication,
    rendererGenomeCommitEpoch,
    rendererReadyEpoch,
    getCompiledBroadRasterLoaderDiagnostics,
    getCompiledBroadRasterLoaderDiagnosticsByTrack,
    compiledAnnotationResidentReadiness,
  ]);

  return (
    <IndexedGenomeViewerSurface
      dataLayerControls={dataLayerControls}
      annotationColorsByIdentity={annotationColorsByIdentity}
      missingAnnotationColor={missingAnnotationColor}
      compiledBroadOwnsAssembly={compiledBroadOwnsAssembly}
      state={state}
      comparisonProjection={comparisonProjection}
      comparisonCamera={comparisonCamera}
      onComparisonCameraChange={(camera, reason) => {
        onComparisonCameraChange?.(camera, reason);
        if (!comparisonProjection) return;
        const range = comparisonTargetViewport(comparisonProjection, camera);
        if (range) handleCameraChange((range.start + range.end) / 2, reason, undefined, range);
      }}
      contactProjection={contactProjection}
      contactCamera={contactCamera}
      contactUnit={contactUnit}
      onContactCameraChange={(camera, reason) => {
        onContactCameraChange?.(camera, reason);
        const range = { start: camera.xStart, end: camera.xEnd };
        const zoom = contactProjection
          ? contactProjection.xReference.length / (camera.xEnd - camera.xStart)
          : undefined;
        handleCameraChange((camera.xStart + camera.xEnd) / 2, reason, zoom, range);
      }}
      manifest={manifest}
      sessionId={sessionId}
      length={length}
      height={height}
      hasDataTracks={
        activeStressDatasets.length > 0 ||
        (dataLayerTracks?.length ?? 0) > 0 ||
        Boolean(contactProjection || comparisonProjection)
      }
      hasQuantitativeTracks={allTrackLanes.some((lane) => isQuantitativeDataset(lane.dataset))}
      hasPileupTracks={allTrackLanes.some((lane) => lane.visible && lane.dataset.kind === 'pileup')}
      containerWidth={containerWidth}
      glyphV2Enabled={glyphV2Enabled}
      rendererAssembly={rendererAssembly}
      assemblyByChrom={assemblyByChrom}
      assemblyFeatures={assemblyFeatures}
      rendererEffectiveVisibleTypes={rendererEffectiveVisibleTypes}
      rendererEffectiveVisibleLayerTypes={rendererEffectiveVisibleLayerTypes}
      laneLimit={laneLimit}
      transcriptDisplayMode={transcriptDisplayMode}
      expandedGeneIds={expandedGeneIds}
      annotationViewportTiles={annotationViewportTiles}
      annotationViewportTile={annotationViewportTile}
      pendingAnnotationViewportTile={pendingAnnotationViewportTile}
      sceneViewportRange={sceneViewportRange}
      sequenceWindow={sequenceWindow}
      pendingSequenceWindow={pendingSequenceWindow}
      overviewTexture={overviewTexture}
      overviewTextureStatus={overviewTextureStatus}
      stableAnnotationSourceIdentity={stableAnnotationSourceIdentity}
      assemblyExactAnnotationCoverage={assemblyExactAnnotationCoverage}
      activePrepackedMrnaPresentation={activePrepackedMrnaPresentation}
      presentedPrepackedAnnotationOwner={presentedPrepackedAnnotationOwner}
      recordEvent={recordDebugEvent}
      onProjectionChange={handleCompatibilityProjectionChange}
      assemblyRendererGenomeShell={assemblyRendererGenomeShell}
      tileNativeRendererGenome={tileNativeRendererGenome}
      activeFilteredRendererFeatures={activeFilteredRendererFeatures}
      activeTileNativeScene={activeTileNativeScene}
      mountedCompiledBroadTrackTypes={mountedCompiledBroadTrackTypes}
      compiledBroadTrackMountScopeKey={compiledBroadTrackMountScopeKey}
      prepackedAnnotationSceneCache={prepackedAnnotationSceneCache}
      annotationAssetGeneration={annotationAssetGeneration}
      annotationProductPublicationReady={annotationProductPublicationReady}
      compiledBroadRasterSourceRequest={compiledBroadRasterSourceRequest}
      annotationInteractionPayloadEnabled={annotationInteractionPayloadEnabled}
      annotationInteractionPreparationGeneration={annotationInteractionPreparationGeneration}
      compiledBroadRasterThemeMode={compiledBroadRasterThemeMode}
      compiledBroadSurfaceRequirement={compiledBroadSurfaceRequirement}
      pendingAnnotationMapperPolicy={pendingAnnotationMapperPolicy}
      annotationMapperPolicy={annotationMapperPolicy}
      rendererReadyEpoch={rendererReadyEpoch}
      rendererGenomeCommitEpoch={rendererGenomeCommitEpoch}
      annotationDetailRosterAdmissionEpoch={annotationDetailRosterAdmissionEpoch}
      webglRef={webglRef}
      registerCompiledBroadRasterTrackCameraNotifier={
        registerCompiledBroadRasterTrackCameraNotifier
      }
      registerCompiledBroadRasterTrackPolicyRefresher={
        registerCompiledBroadRasterTrackPolicyRefresher
      }
      registerCompiledBroadRasterTrackDiagnostics={registerCompiledBroadRasterTrackDiagnostics}
      overviewFeaturesComplete={overviewFeaturesComplete}
      handleCompiledBroadRasterPolicyCommitted={handleCompiledBroadRasterPolicyCommitted}
      handleCompiledBroadRasterTrackUnavailable={handleCompiledBroadRasterTrackUnavailable}
      handleCompiledBroadRasterTrackReadinessChanged={
        handleCompiledBroadRasterTrackReadinessChanged
      }
      handleAnnotationDetailRosterAdmission={handleAnnotationDetailRosterAdmission}
      debugInstanceId={debugInstanceIdRef.current}
      compiledResidentOwnerReadinessScopeKey={compiledResidentOwnerReadinessScopeKey}
      laneOwnerId={laneOwnerId}
      laneAssemblyId={laneAssemblyId}
      assemblyDefinition={assemblyDefinition}
      trackAssemblyReferences={trackAssemblyReferences}
      visibleTypes={visibleTypes}
      toggleAnnotationLane={toggleAnnotationLane}
      annotationTrackRegistry={annotationTrackRegistry}
      toggleVisibleType={toggleVisibleType}
      setVisibleTypesFromPicker={setVisibleTypesFromPicker}
      annotationSearchReveal={annotationSearchReveal}
      showTemporarilyRevealedTrack={showTemporarilyRevealedTrack}
      raiseSearchLaneLimitByOne={raiseSearchLaneLimitByOne}
      maxSupportedFiniteLaneLimit={maxSupportedFiniteLaneLimit}
      changeLaneLimit={changeLaneLimit}
      toggleTranscriptDisplayMode={toggleTranscriptDisplayMode}
      annotationPreparationState={annotationPreparationState}
      ucscTrackErrors={ucscStreaming.trackErrors}
      onRetryUcscTracks={ucscStreaming.retryFailedTiles}
      pileupTrackStatuses={pileupTrackStatuses}
      onRetryPileupTrack={pileupStreaming.retryTrack}
      bamImport={bamImport}
      onAddVariantTrackRequest={onAddVariantTrackRequest}
      onOpenMutationNavigator={onOpenMutationNavigator}
      laneScreenBands={laneScreenBands}
      canvasHostRef={canvasHostRef}
      rendererGenomeForMap={rendererGenomeForMap}
      themeMode={themeMode}
      annotationPresentationSnapshotForMap={annotationPresentationSnapshotForMap}
      annotationResidentPagePublicationForMap={annotationResidentPagePublicationForMap}
      rendererAnnotationSearchFocusForMap={rendererAnnotationSearchFocusForMap}
      rendererAnnotationSearchFocusFeature={rendererAnnotationSearchFocusFeature}
      annotationsVisible={annotationsVisible}
      readSourcesByTrackId={readSourcesByTrackId}
      referencePathsByChrom={pileupReferencePathsByChrom}
      assemblyRoutingEnabled={assemblyRoutingEnabled}
      assemblySequenceWindow={assemblySequenceWindow}
      measuredCanvasHeight={measuredCanvasHeight}
      handleCameraChange={handleCameraChange}
      handleRendererReady={handleRendererReady}
      handleRendererGenomeCommit={handleRendererGenomeCommit}
      fullAssemblyInteractionReady={fullAssemblyInteractionReady}
      selectedAnnotation={selectedAnnotation}
      handleSelectedAnnotationChange={handleSelectedAnnotationChange}
      onContextMenu={onContextMenu}
      onSelectionChange={onSelectionChange}
      onSelectionClear={onSelectionClear}
      sequenceOverlays={sequenceOverlays}
      annotationOwnerPending={annotationOwnerPending}
    />
  );
}
