import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';

import type { GenomeFeature, IndexedGenomeManifest } from '@waypoint/genome-data';
import type {
  GenomeAnnotationFeatureModel,
  GenomeAnnotationGlyphPayload,
  GenomeTileCacheState,
  GenomeTrackTile,
} from '../../../shared/indexed-genome';
import {
  annotationGlyphPayloadFromRendererFeatures,
  annotationSummaryGlyphPayloadFromRendererFeatures,
  applyDensityControls,
  buildAnnotationGlyphPayloadWithStableLanes,
  estimateAnnotationGlyphPayloadByteCount,
  resolveAnnotationFeaturesForViewer,
  uniqueFeatureTypes,
  type FilteredRendererFeatureResult,
  type LaneLimit,
  type TranscriptCarrierFeature,
} from './indexed-genome-legacy-adapter';
import { collapseToCanonicalIsoforms, type TranscriptDisplayMode } from './isoform-collapse';
import { buildAnnotationIndex, type AnnotationIndex } from '../genome-annotation-index';
import { materializeSingleChromosomeAnnotationSearchFeature } from './indexed-genome-annotation-search-identity';
import type { IndexedGenomeScene } from './indexed-genome-scene';
import {
  buildLaneAssignmentMap,
  featureRetentionIdentity,
  indexedGenomeSceneToRendererGenome,
} from './indexed-genome-renderer-adapter';
import { buildRetainedIdentityMap } from './annotation-tile-transition';
import {
  checkAnnotationRenderingInvariants,
  reportInvariantViolations,
  type InvariantViolation,
} from './annotation-rendering-invariants';
import { INITIAL_TRANSITION_STATE, transitionReducer } from './annotation-transition-state';
import {
  buildIndexedGenomeViewerScene,
  sourceFingerprintForManifest,
  type IndexedGenomeViewerSequenceWindowState,
} from './indexed-genome-viewer-scene-state';
import {
  assemblyAnnotationLayoutOwnershipKey,
  assemblyAnnotationLayerTypes,
  applyAssemblyRendererLaneControls,
  buildAssemblyAnnotationScene,
  buildAssemblyComposedFeatures,
} from './assembly-renderer-genome';
import type { Assembly, Feature, Genome } from '@waypoint/genome-renderer';
import { annotationFeatureArraysSemanticallyEqual } from './annotation-feature-semantic-equality';
import { uniqueSorted, type AnnotationViewportTileState } from './indexed-genome-viewer-viewport';
import type { AnnotationTilePending } from './indexed-annotation-tile-policy';
import type {
  SequenceViewportRange,
  SequenceWindowPending,
} from './indexed-sequence-window-policy';
import type {
  AssemblyOverviewTexture,
  AssemblyOverviewTextureStatus,
} from './useAssemblyOverviewTexture';
import {
  ANNOTATION_LANE_STACKING_BY_TYPE,
  ANNOTATION_OVERVIEW_TILE_BYTE_BUDGET,
  EMPTY_ASSEMBLY_DETAIL_FEATURE_PARTITIONS,
  annotationGlyphPayloadCount,
} from './indexed-genome-compatibility-scene';

export type IndexedGenomeCompatibilityReadyState = {
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
  sequence: string;
};

export type IndexedGenomeCompatibilitySourceState =
  | { kind: 'loading'; message: string }
  | { kind: 'error'; message: string }
  | IndexedGenomeCompatibilityReadyState;

export type IndexedGenomeCompatibilityResolverOutput = {
  resolvedFeatures: GenomeFeature[];
  availableTypes: string[];
};

export type IndexedGenomeCompatibilityProjection = {
  resolverOutput: IndexedGenomeCompatibilityResolverOutput | null;
  annotationIndex: AnnotationIndex | null;
  assemblyComposedFeatures: ReadonlyArray<Feature> | null;
  assemblyObservedAvailableTypes: string[];
  assemblyFilteredRendererFeatures: FilteredRendererFeatureResult | null;
  filteredRendererFeatures: FilteredRendererFeatureResult | null;
  annotationViewportResolvedFeaturesByGeneration: ReadonlyMap<number, GenomeFeature[]>;
  annotationViewportGlyphPayloads: ReadonlyMap<number, GenomeAnnotationGlyphPayload>;
  annotationOverviewGlyphPayload: GenomeAnnotationGlyphPayload | null;
  annotationOverviewGlyphPayloadByteCount: number;
  tileNativeScene: IndexedGenomeScene | null;
  assemblyTileNativeScene: IndexedGenomeScene | null;
  activeTileNativeScene: IndexedGenomeScene | null;
  tileNativeRendererGenome: Genome | null;
  activeFilteredRendererFeatures: FilteredRendererFeatureResult | null;
  invariantViolations: ReadonlyArray<InvariantViolation>;
};

export type IndexedGenomeCompatibilitySceneProps = {
  state: IndexedGenomeCompatibilitySourceState;
  manifest: IndexedGenomeManifest;
  sessionId?: string;
  length: number;
  height: number;
  containerWidth: number;
  glyphV2Enabled: boolean;
  rendererAssembly: Assembly | null;
  assemblyByChrom?: ReadonlyMap<string, ReadonlyArray<Feature>> | null;
  assemblyFeatures?: ReadonlyArray<Feature> | null;
  rendererEffectiveVisibleTypes: ReadonlySet<string>;
  rendererEffectiveVisibleLayerTypes: string[];
  laneLimit: LaneLimit;
  transcriptDisplayMode: TranscriptDisplayMode;
  expandedGeneIds: ReadonlySet<string>;
  annotationViewportTiles: readonly AnnotationViewportTileState[];
  annotationViewportTile: AnnotationViewportTileState | null;
  pendingAnnotationViewportTile: AnnotationTilePending | null;
  sceneViewportRange: SequenceViewportRange | null;
  sequenceWindow: IndexedGenomeViewerSequenceWindowState | null;
  pendingSequenceWindow: SequenceWindowPending | null;
  overviewTexture?: AssemblyOverviewTexture | null;
  overviewTextureStatus: AssemblyOverviewTextureStatus;
  stableAnnotationSourceIdentity: string | null;
  assemblyExactAnnotationCoverage: ReadonlyArray<Readonly<{ startBp: number; endBp: number }>>;
  prepackedAnnotationLayoutOwnerKey: string | null;
  recordEvent?: (event: string, detail?: Record<string, unknown>) => void;
  onProjectionChange?: (projection: IndexedGenomeCompatibilityProjection) => void;
  children?: (projection: IndexedGenomeCompatibilityProjection) => ReactNode;
};

export function IndexedGenomeCompatibilityScene({
  state,
  manifest,
  sessionId,
  length,
  height,
  containerWidth,
  glyphV2Enabled,
  rendererAssembly,
  assemblyByChrom,
  assemblyFeatures,
  rendererEffectiveVisibleTypes,
  rendererEffectiveVisibleLayerTypes,
  laneLimit,
  transcriptDisplayMode,
  expandedGeneIds,
  annotationViewportTiles,
  annotationViewportTile,
  pendingAnnotationViewportTile,
  sceneViewportRange,
  sequenceWindow,
  pendingSequenceWindow,
  overviewTexture,
  overviewTextureStatus,
  stableAnnotationSourceIdentity,
  assemblyExactAnnotationCoverage,
  prepackedAnnotationLayoutOwnerKey,
  recordEvent,
  onProjectionChange,
  children,
}: IndexedGenomeCompatibilitySceneProps) {
  const [transitionState, dispatchTransition] = useReducer(
    transitionReducer,
    INITIAL_TRANSITION_STATE
  );

  type ResolverOutput = IndexedGenomeCompatibilityResolverOutput;
  const retainedResolverOutputRef = useRef<ResolverOutput | null>(null);
  const resolverOutput = useMemo<ResolverOutput | null>(() => {
    if (state.kind !== 'ready') return null;
    const startedAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    recordEvent?.('resolver-start', {
      featureModel: state.featureModel,
      tileFeatureCount: state.tileFeatures.length,
    });
    const overviewResolved = resolveAnnotationFeaturesForViewer(
      state.tileFeatures,
      state.featureModel,
      glyphV2Enabled
    );
    const availableTypes = uniqueSorted([
      ...(state.layerTypes ?? []),
      ...uniqueFeatureTypes(overviewResolved),
    ]);
    const result = {
      resolvedFeatures: overviewResolved,
      availableTypes,
    };
    retainedResolverOutputRef.current = result;
    recordEvent?.('resolver-end', {
      resolvedFeatureCount: result.resolvedFeatures.length,
      dt:
        (typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now()) - startedAt,
    });
    return result;
  }, [
    glyphV2Enabled,
    rendererAssembly,
    recordEvent,
    state.kind,
    state.kind === 'ready' ? state.featureModel : null,
    state.kind === 'ready' ? state.layerTypes : null,
    state.kind === 'ready' ? state.tileFeatures : null,
  ]);

  const rawAssemblyComposedFeatures = useMemo(() => {
    return buildAssemblyComposedFeatures({
      rendererAssembly,
      assemblyByChrom,
      assemblyDetailByChrom: EMPTY_ASSEMBLY_DETAIL_FEATURE_PARTITIONS,
      assemblyFeatures,
      visibleTypes: rendererEffectiveVisibleTypes,
      visibleChroms: null,
    });
  }, [assemblyByChrom, assemblyFeatures, rendererAssembly, rendererEffectiveVisibleTypes]);
  const stableAssemblyComposedFeaturesRef = useRef<ReadonlyArray<Feature> | null>(null);
  const assemblyComposedFeatures = useMemo(() => {
    const prev = stableAssemblyComposedFeaturesRef.current;
    const next = rawAssemblyComposedFeatures;
    if (annotationFeatureArraysSemanticallyEqual(prev, next)) return prev;
    stableAssemblyComposedFeaturesRef.current = next;
    return next;
  }, [rawAssemblyComposedFeatures]);

  const retainedAssemblyCompatibilityProjectionRef = useRef<FilteredRendererFeatureResult | null>(
    null
  );
  const assemblyFilteredRendererFeatures = useMemo<FilteredRendererFeatureResult | null>(() => {
    if (!rendererAssembly) {
      retainedAssemblyCompatibilityProjectionRef.current = null;
      return null;
    }
    const computed = applyAssemblyRendererLaneControls({
      features: assemblyComposedFeatures ?? [],
      length: rendererAssembly.totalLengthBp,
      visibleTypes: rendererEffectiveVisibleTypes,
      laneLimit,
      typeOrder: ANNOTATION_LANE_STACKING_BY_TYPE.typeOrder,
      spacerLanes: ANNOTATION_LANE_STACKING_BY_TYPE.spacerLanes,
    });
    retainedAssemblyCompatibilityProjectionRef.current = computed;
    return computed;
  }, [rendererAssembly, assemblyComposedFeatures, rendererEffectiveVisibleTypes, laneLimit]);

  const assemblyObservedAvailableTypes = useMemo(() => {
    const prebuiltTypes =
      overviewTextureStatus === 'loaded' ? (overviewTexture?.manifest.layerTypes ?? []) : [];
    return assemblyAnnotationLayerTypes(assemblyComposedFeatures, prebuiltTypes);
  }, [assemblyComposedFeatures, overviewTexture, overviewTextureStatus]);

  const annotationIndex = useMemo<AnnotationIndex | null>(() => {
    if (!resolverOutput || resolverOutput.resolvedFeatures.length === 0) return null;
    const genomeIdentity = sourceFingerprintForManifest(manifest);
    return buildAnnotationIndex(
      resolverOutput.resolvedFeatures.map((feature) =>
        materializeSingleChromosomeAnnotationSearchFeature(
          feature as TranscriptCarrierFeature,
          genomeIdentity
        )
      )
    );
  }, [manifest, resolverOutput]);

  const collapsedResolverFeatures = useMemo<TranscriptCarrierFeature[] | null>(() => {
    if (!resolverOutput) return null;
    return collapseToCanonicalIsoforms(
      resolverOutput.resolvedFeatures as TranscriptCarrierFeature[],
      { mode: transcriptDisplayMode, expandedGeneIds }
    );
  }, [rendererAssembly, resolverOutput, transcriptDisplayMode, expandedGeneIds]);
  const expandedGeneIdsKey = useMemo(() => {
    if (expandedGeneIds.size === 0) return '';
    return [...expandedGeneIds].sort().join(',');
  }, [expandedGeneIds]);

  const annotationViewportResolvedFeaturesByGeneration = useMemo<
    Map<number, GenomeFeature[]>
  >(() => {
    const byGeneration = new Map<number, GenomeFeature[]>();
    if (state.kind !== 'ready') return byGeneration;
    for (const tile of annotationViewportTiles) {
      if (tile.state !== 'ready' && tile.state !== 'empty') continue;
      const resolved = resolveAnnotationFeaturesForViewer(
        tile.features,
        tile.featureModel,
        glyphV2Enabled
      );
      const collapsed = collapseToCanonicalIsoforms(resolved as TranscriptCarrierFeature[], {
        mode: transcriptDisplayMode,
        expandedGeneIds,
      });
      byGeneration.set(tile.generation, collapsed);
    }
    return byGeneration;
  }, [
    annotationViewportTiles,
    expandedGeneIds,
    glyphV2Enabled,
    rendererAssembly,
    state.kind,
    transcriptDisplayMode,
  ]);

  const filteredRendererFeatures = useMemo<FilteredRendererFeatureResult | null>(() => {
    if (state.kind !== 'ready' || !resolverOutput || !collapsedResolverFeatures) return null;
    const startedAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    recordEvent?.('filter-start', {
      visibleTypes: [...rendererEffectiveVisibleTypes].sort().join(','),
      sourceFeatureCount: collapsedResolverFeatures.length,
      laneLimit: laneLimit ?? 'all',
    });
    const computed = applyDensityControls(
      collapsedResolverFeatures,
      manifest.chrom,
      length,
      rendererEffectiveVisibleTypes,
      laneLimit,
      ANNOTATION_LANE_STACKING_BY_TYPE
    );
    recordEvent?.('filter-end', {
      renderedFeatureCount: computed.features.length,
      typeFilteredCount: computed.typeFilteredCount,
      droppedCount: computed.droppedCount,
      dt:
        (typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now()) - startedAt,
    });
    return computed;
  }, [
    state,
    resolverOutput,
    collapsedResolverFeatures,
    rendererEffectiveVisibleTypes,
    laneLimit,
    manifest.chrom,
    length,
    rendererAssembly,
    transcriptDisplayMode,
    expandedGeneIdsKey,
    recordEvent,
  ]);

  const annotationViewportGlyphPayloads = useMemo<Map<number, GenomeAnnotationGlyphPayload>>(() => {
    const byGeneration = new Map<number, GenomeAnnotationGlyphPayload>();
    if (state.kind !== 'ready') return byGeneration;
    for (const tile of annotationViewportTiles) {
      if (tile.state !== 'ready' && tile.state !== 'empty') continue;
      const resolvedFeatures =
        annotationViewportResolvedFeaturesByGeneration.get(tile.generation) ?? [];
      const glyphPayload = buildAnnotationGlyphPayloadWithStableLanes(
        resolvedFeatures,
        manifest.chrom,
        length,
        rendererEffectiveVisibleTypes,
        laneLimit,
        filteredRendererFeatures,
        ANNOTATION_LANE_STACKING_BY_TYPE
      );
      byGeneration.set(tile.generation, {
        type: 'annotation-glyphs',
        featureModel: tile.featureModel,
        ...glyphPayload,
      });
    }
    return byGeneration;
  }, [
    annotationViewportResolvedFeaturesByGeneration,
    annotationViewportTiles,
    rendererEffectiveVisibleTypes,
    filteredRendererFeatures,
    laneLimit,
    length,
    manifest.chrom,
    rendererAssembly,
    state.kind,
  ]);

  const annotationViewportGlyphPayload =
    annotationViewportTile != null
      ? (annotationViewportGlyphPayloads.get(annotationViewportTile.generation) ?? null)
      : null;

  const readyFeatureModel = state.kind === 'ready' ? state.featureModel : null;
  const sceneAnnotationViewportTile = rendererAssembly ? null : annotationViewportTile;
  const sceneAnnotationViewportTiles = useMemo(
    () => (rendererAssembly ? [] : annotationViewportTiles),
    [annotationViewportTiles, rendererAssembly]
  );

  const annotationOverviewGlyphPayload = useMemo<GenomeAnnotationGlyphPayload | null>(() => {
    if (!readyFeatureModel || !filteredRendererFeatures) return null;
    return {
      type: 'annotation-glyphs',
      featureModel: readyFeatureModel,
      ...annotationSummaryGlyphPayloadFromRendererFeatures(filteredRendererFeatures, {
        chrom: manifest.chrom,
        viewportRange: { start: 0, end: length },
        widthPx: containerWidth,
        maxPayloadBytes: ANNOTATION_OVERVIEW_TILE_BYTE_BUDGET,
        featureModel: readyFeatureModel,
      }),
    };
  }, [
    containerWidth,
    filteredRendererFeatures,
    length,
    manifest.chrom,
    readyFeatureModel,
    rendererAssembly,
  ]);

  const annotationOverviewGlyphPayloadByteCount = useMemo(
    () => estimateAnnotationGlyphPayloadByteCount(annotationOverviewGlyphPayload),
    [annotationOverviewGlyphPayload]
  );

  const tileNativeScene = useMemo<IndexedGenomeScene | null>(() => {
    if (state.kind !== 'ready') return null;
    if (!sessionId) return null;
    return buildIndexedGenomeViewerScene({
      manifest,
      sessionId,
      length,
      height,
      containerWidth,
      viewportRange: sceneViewportRange,
      sequenceWindow,
      pendingSequenceWindow,
      visibleTypes: rendererEffectiveVisibleTypes,
      laneLimit,
      annotationOverviewTile: {
        state: state.summaryTileState,
        fidelity: state.summaryTileFidelity,
        generation: state.summaryTileGeneration,
        byteCount: annotationOverviewGlyphPayload
          ? annotationOverviewGlyphPayloadByteCount
          : state.summaryTileByteCount,
        validationState: state.summaryTileValidationState,
        cacheState: state.tileCacheState,
        recordCount: state.tileFeatures.length,
        sourceRecordCount: state.sourceRecordCount,
        layerTypes: rendererEffectiveVisibleLayerTypes,
        message: state.summaryTileMessage,
        ...(annotationOverviewGlyphPayload ? { payload: annotationOverviewGlyphPayload } : {}),
      },
      annotationViewportTile: sceneAnnotationViewportTile
        ? {
            ...sceneAnnotationViewportTile,
            layerTypes: rendererEffectiveVisibleLayerTypes,
            ...(annotationViewportGlyphPayload ? { payload: annotationViewportGlyphPayload } : {}),
          }
        : null,
      annotationViewportTiles: sceneAnnotationViewportTiles.map((tile) => ({
        ...tile,
        layerTypes: rendererEffectiveVisibleLayerTypes,
        ...(annotationViewportGlyphPayloads.get(tile.generation)
          ? { payload: annotationViewportGlyphPayloads.get(tile.generation)! }
          : {}),
      })),
      pendingAnnotationViewportTile,
    });
  }, [
    annotationViewportGlyphPayload,
    annotationViewportGlyphPayloads,
    annotationOverviewGlyphPayload,
    annotationOverviewGlyphPayloadByteCount,
    sceneAnnotationViewportTile,
    sceneAnnotationViewportTiles,
    containerWidth,
    rendererEffectiveVisibleTypes,
    rendererEffectiveVisibleLayerTypes,
    height,
    laneLimit,
    length,
    manifest,
    pendingAnnotationViewportTile,
    pendingSequenceWindow,
    sceneViewportRange,
    sequenceWindow,
    sessionId,
    state,
  ]);
  const rendererGenomeDataKey = useMemo(() => {
    if (state.kind !== 'ready') return 'not-ready';
    return [
      manifest.chrom,
      length,
      state.summaryTileGeneration,
      state.summaryTileState,
      state.summaryTileFidelity,
      state.tileCacheState,
      annotationOverviewGlyphPayloadByteCount,
      annotationGlyphPayloadCount(annotationOverviewGlyphPayload),
      annotationOverviewGlyphPayload?.compactGeometry?.length ?? 0,
      annotationViewportTiles
        .map(
          (tile) =>
            `${tile.generation}:${tile.state}:${tile.fidelity}:${tile.startBp}-${tile.endBp}:${tile.recordCount}:${tile.byteCount}`
        )
        .join('|'),
    ].join('::');
  }, [
    annotationOverviewGlyphPayload,
    annotationOverviewGlyphPayloadByteCount,
    annotationViewportTiles,
    length,
    manifest.chrom,
    state,
  ]);
  const previousAnnotationFeatures = transitionState.previousAnnotationFeatures;
  const previousLaneAssignments = transitionState.previousLaneAssignments;
  const annotationTransitionRetentionEnabled = !rendererAssembly;
  const activeFilteredRendererFeatures =
    assemblyFilteredRendererFeatures ?? filteredRendererFeatures;

  const assemblyDetailGlyphPayload = useMemo<GenomeAnnotationGlyphPayload | null>(() => {
    if (!rendererAssembly || !assemblyFilteredRendererFeatures) return null;
    if (assemblyFilteredRendererFeatures.features.length === 0) return null;
    return {
      type: 'annotation-glyphs',
      featureModel: state.kind === 'ready' ? state.featureModel : 'resolved-transcript-v2',
      ...annotationGlyphPayloadFromRendererFeatures(assemblyFilteredRendererFeatures),
    };
  }, [assemblyFilteredRendererFeatures, rendererAssembly, state]);

  const assemblyDetailGlyphPayloadByteCount = useMemo(
    () => estimateAnnotationGlyphPayloadByteCount(assemblyDetailGlyphPayload),
    [assemblyDetailGlyphPayload]
  );

  const retainedAssemblyCompatibilitySceneRef = useRef<IndexedGenomeScene | null>(null);
  const assemblyTileNativeScene = useMemo<IndexedGenomeScene | null>(() => {
    const scene = buildAssemblyAnnotationScene({
      rendererAssembly,
      features: assemblyFilteredRendererFeatures?.features ?? null,
      payload: assemblyDetailGlyphPayload,
      payloadByteCount: assemblyDetailGlyphPayloadByteCount,
      annotationLayerTypes: rendererEffectiveVisibleLayerTypes,
      laneLimit,
      prebuiltOverviewTextureManifest:
        overviewTextureStatus === 'loaded' ? (overviewTexture?.manifest ?? null) : null,
      sourceIdentity: stableAnnotationSourceIdentity,
      viewportRange: null,
      viewportWidthPx: containerWidth,
      viewportHeightPx: height,
      generation: state.kind === 'ready' ? state.summaryTileGeneration : 0,
    });
    retainedAssemblyCompatibilitySceneRef.current = scene;
    return scene;
  }, [
    assemblyDetailGlyphPayload,
    assemblyDetailGlyphPayloadByteCount,
    assemblyFilteredRendererFeatures,
    containerWidth,
    height,
    laneLimit,
    overviewTexture,
    overviewTextureStatus,
    stableAnnotationSourceIdentity,
    rendererAssembly,
    rendererEffectiveVisibleLayerTypes,
    state,
  ]);

  const activeTileNativeScene = rendererAssembly ? assemblyTileNativeScene : tileNativeScene;
  const assemblyAnnotationLayoutOwnerKey = rendererAssembly
    ? prepackedAnnotationLayoutOwnerKey
      ? prepackedAnnotationLayoutOwnerKey
      : assemblyAnnotationLayoutOwnershipKey({
          laneLimit,
          requestedLayerTypes: rendererEffectiveVisibleLayerTypes,
          realizedLayout: activeTileNativeScene?.annotationLayout,
        })
    : 'not-assembly';

  const activeTileNativeSceneRef = useRef(activeTileNativeScene);
  activeTileNativeSceneRef.current = activeTileNativeScene;
  const retainedAssemblyCompatibilityGenomeRef = useRef<Genome | null>(null);
  const tileNativeRendererGenome = useMemo(() => {
    const scene = activeTileNativeSceneRef.current;
    if (!scene) return null;
    const genome = indexedGenomeSceneToRendererGenome(scene, {
      includeSequenceWindow: false,
      enableTransitionRetention: annotationTransitionRetentionEnabled,
      previousAnnotationFeatures: annotationTransitionRetentionEnabled
        ? previousAnnotationFeatures
        : undefined,
      previousLaneAssignments: annotationTransitionRetentionEnabled
        ? previousLaneAssignments
        : undefined,
    });
    const nextGenome = rendererAssembly
      ? {
          ...genome,
          name: rendererAssembly.displayName,
          length: rendererAssembly.totalLengthBp,
          sequenceAvailable: Boolean(manifest.fastaPath),
          annotationExactCoverage: assemblyExactAnnotationCoverage,
        }
      : {
          ...genome,
          sequenceAvailable: Boolean(manifest.fastaPath),
        };
    if (rendererAssembly) retainedAssemblyCompatibilityGenomeRef.current = nextGenome;
    return nextGenome;
  }, [
    rendererGenomeDataKey,
    assemblyAnnotationLayoutOwnerKey,
    assemblyDetailGlyphPayload,
    stableAnnotationSourceIdentity,
    annotationOverviewGlyphPayload,
    previousAnnotationFeatures,
    previousLaneAssignments,
    rendererAssembly,
    assemblyExactAnnotationCoverage,
    annotationTransitionRetentionEnabled,
    manifest.fastaPath,
  ]);

  const invariantViolations = useMemo(() => {
    if (!import.meta.env.DEV) return [] as InvariantViolation[];
    if (!tileNativeRendererGenome || !activeFilteredRendererFeatures)
      return [] as InvariantViolation[];
    const v = checkAnnotationRenderingInvariants(
      tileNativeRendererGenome,
      activeFilteredRendererFeatures,
      { transcriptDisplayMode, expandedGeneIdsKey }
    );
    if (v.length > 0) reportInvariantViolations(v);
    return v;
  }, [
    tileNativeRendererGenome,
    activeFilteredRendererFeatures,
    transcriptDisplayMode,
    expandedGeneIdsKey,
  ]);

  useEffect(() => {
    if (!annotationTransitionRetentionEnabled) return;
    if (!tileNativeRendererGenome) return;
    const features = tileNativeRendererGenome.features ?? [];
    if (features.length === 0) return;
    let activeRangeStart = Number.POSITIVE_INFINITY;
    let activeRangeEnd = Number.NEGATIVE_INFINITY;
    for (const f of features) {
      if (f.start < activeRangeStart) activeRangeStart = f.start;
      if (f.end > activeRangeEnd) activeRangeEnd = f.end;
    }
    const activeRange =
      Number.isFinite(activeRangeStart) && Number.isFinite(activeRangeEnd)
        ? { start: activeRangeStart, end: activeRangeEnd }
        : null;
    const nextFeatures = buildRetainedIdentityMap(features, activeRange, featureRetentionIdentity);
    const nextLanes = buildLaneAssignmentMap(features);
    dispatchTransition({
      type: 'tile-commit',
      featuresByIdentity: nextFeatures,
      laneAssignments: nextLanes,
    });
  }, [annotationTransitionRetentionEnabled, tileNativeRendererGenome]);

  useEffect(() => {
    dispatchTransition({ type: 'workspace-change' });
  }, [manifest.chrom, rendererAssembly?.id]);

  const rendererEffectiveVisibleTypesKey = useMemo(
    () => [...rendererEffectiveVisibleTypes].sort((a, b) => a.localeCompare(b)).join('\u0000'),
    [rendererEffectiveVisibleTypes]
  );

  useEffect(() => {
    dispatchTransition({ type: 'filter-reset' });
  }, [transcriptDisplayMode, expandedGeneIdsKey, rendererEffectiveVisibleTypesKey, laneLimit]);

  const projection = useMemo<IndexedGenomeCompatibilityProjection>(
    () => ({
      resolverOutput,
      annotationIndex,
      assemblyComposedFeatures,
      assemblyObservedAvailableTypes,
      assemblyFilteredRendererFeatures,
      filteredRendererFeatures,
      annotationViewportResolvedFeaturesByGeneration,
      annotationViewportGlyphPayloads,
      annotationOverviewGlyphPayload,
      annotationOverviewGlyphPayloadByteCount,
      tileNativeScene,
      assemblyTileNativeScene,
      activeTileNativeScene,
      tileNativeRendererGenome,
      activeFilteredRendererFeatures,
      invariantViolations,
    }),
    [
      activeFilteredRendererFeatures,
      activeTileNativeScene,
      annotationIndex,
      annotationOverviewGlyphPayload,
      annotationOverviewGlyphPayloadByteCount,
      annotationViewportGlyphPayloads,
      annotationViewportResolvedFeaturesByGeneration,
      assemblyComposedFeatures,
      assemblyFilteredRendererFeatures,
      assemblyObservedAvailableTypes,
      assemblyTileNativeScene,
      filteredRendererFeatures,
      invariantViolations,
      resolverOutput,
      tileNativeRendererGenome,
      tileNativeScene,
    ]
  );

  useLayoutEffect(() => {
    onProjectionChange?.(projection);
  }, [onProjectionChange, projection]);

  return children ? <>{children(projection)}</> : null;
}
