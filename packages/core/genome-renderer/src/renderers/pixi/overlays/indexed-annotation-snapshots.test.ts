import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CompiledBroadSurfacePixiPresenterV2 } from '../overview/compiled-broad-surface-pixi-presenter';
import type { AnnotationPresentationDebugSnapshot } from './annotation-presentation-debug';
import type { PrepackedAnnotationSceneOwnerSnapshot } from '../overview/prepacked-annotation-scene';
import {
  getColdGestureSnapshot,
  getDebugSnapshot,
  type AnnotationSnapshotHost,
  type AnnotationSnapshotResident,
  type AnnotationSnapshotSources,
} from './indexed-annotation-snapshots';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function presentation(): AnnotationPresentationDebugSnapshot {
  return {
    annotationLodBackend: null,
    annotationPresentationStyleId: null,
    annotationLodContractViolation: null,
    annotationPresentationOwnerViolations: [],
    layoutInvariantViolations: [],
    annotationPresentationLayerTypes: [],
    annotationPresentationOwners: [],
    runtimeGenomeWideTextureVisible: false,
    prebuiltGenomeWideTextureVisible: false,
    compiledBroadRasterVisible: false,
    sidecarTrackRasterVisible: false,
    sidecarTrackRasterLayerTypes: [],
    rasterOwnerCount: 0,
    prebuiltGenomeWideTextureEligible: false,
    retainedLinearVisibleMeshCount: 0,
    tilePyramidVectorVisibleLayerCount: 0,
    tilePyramidVectorPresentingBlockCount: 0,
    tilePyramidVectorCoverageLevel: null,
    tilePyramidVectorVisibleTileFirst: null,
    tilePyramidVectorVisibleTileLast: null,
    tilePyramidVectorExpectedVisibleTileCount: 0,
    tilePyramidVectorBuiltVisibleTileCount: 0,
    tilePyramidVectorMissingVisibleTileCount: 0,
    tilePyramidVectorCoverageComplete: false,
  };
}

function ownerSnapshot(): PrepackedAnnotationSceneOwnerSnapshot {
  return {
    ownerKey: null,
    ownerGeneration: 0,
    loaded: false,
    status: 'not-loaded',
    gpuPrepared: false,
    metadata: null,
    runtimePolicy: null,
    policyGeneration: 0,
    submittedPartitionCount: 0,
    submittedInstanceCount: 0,
  };
}

function snapshotHost(overrides: Partial<AnnotationSnapshotHost> = {}): AnnotationSnapshotHost {
  const residents = new Map<string, AnnotationSnapshotResident>();
  return {
    compiledBroadSurfaceManifest: null,
    compiledBroadSurfaceProvenance: null,
    compiledBroadSurfacePresenter: null,
    compiledBroadSurfaceTrackOwners: new Map(),
    compiledBroadSurfacePresentingLayerTypes: () => [],
    compiledBroadSurfaceOwnerForTrack: () => null,
    compiledBroadSurfaceProvenanceIsCurrent: () => false,
    annotationLayerTypesForPresentation: () => [],
    annotationRequestedLayerTypes: [],
    prepackedAnnotationSceneLastCompleteOwnerKeys: [],
    prepackedAnnotationSceneResidents: residents,
    requestedPrepackedAnnotationSceneResidentForTrack: () => null,
    prepackedAnnotationScenePresentingResidents: () => [],
    prepackedAnnotationPolicyGeneration: 0,
    prebuiltRasterContractForLastFrame: {
      contractMatch: false,
      sourceMatch: false,
      placementMatch: false,
      artifactLayerTypes: Object.freeze([]),
      artifactSourceFingerprint: null,
      artifactPlacementFingerprint: null,
    },
    presentationVisible: true,
    genomeWideTextureCacheLayer: null,
    prebuiltRasterEligibleForLastFrame: false,
    rttGlyphTilePyramidCompositor: null,
    tilePyramidVectorCompositor: null,
    retainedLinearTranscriptLayer: null,
    retainedLinearTranscriptBlockCount: 0,
    retainedLinearFeatureLayer: null,
    retainedLinearBinCount: 0,
    graphics: { visible: false },
    lastDrawnFeatureCount: 0,
    lastImmediateDrawnLayerTypes: new Set(),
    prepackedAnnotationSceneOwnerMetadata: null,
    prepackedAnnotationRuntimePolicy: null,
    compiledBroadAnnotationInteractionResidentGeneration: 0,
    prepackedAnnotationSceneOwnerGeneration: 0,
    compiledBroadSurfaceSteadyRoster: null,
    currentGenomeIdentity: 'test-genome',
    genomeLength: 1000,
    currentAnnotationSourceFingerprint: null,
    currentAnnotationPlacementFingerprint: null,
    compiledBroadSurfacePlanStatus: 'not-loaded',
    compiledBroadAnnotationInteractionResidents: new Map(),
    prepackedAnnotationSceneOwnerKey: null,
    prepackedAnnotationSceneResidentGeneration: 0,
    prepackedAnnotationSceneLayer: null,
    prepackedAnnotationSceneInput: null,
    prepackedAnnotationSceneStatus: 'not-loaded',
    prepackedAnnotationSceneLayerCreates: 0,
    prepackedAnnotationSceneLayerDestroys: 0,
    prepackedAnnotationSceneGpuPreparations: 0,
    prepackedAnnotationSceneVisiblePartitionCount: 0,
    prepackedAnnotationSceneVisibleInstanceCount: 0,
    prepackedAnnotationSceneStartupBuilds: 0,
    retainedLinearDataBuilds: 0,
    retainedLinearTranscriptBuilds: 0,
    retainedTranscriptDecorationBuilds: 0,
    buildPresentationDebugSnapshot: presentation,
    getPrepackedAnnotationSceneOwnerSnapshot: ownerSnapshot,
    labelIndex: 0,
    labelPool: [],
    curvedLabels: {
      activeCount: 0,
      activeRotations: [],
      activeFontSizes: [],
      activeScales: [],
      activeResolutions: [],
      activePositions: [],
    },
    overviewBinDrawCount: 0,
    annotationResidentPageStore: null,
    residentAnnotationPageSnapshotApplies: 0,
    residentAnnotationPageFlatGraphSkips: 0,
    residentAnnotationViewportSelectionStatus: 'unavailable',
    residentAnnotationViewportSelectionQueries: 0,
    residentAnnotationViewportSelectedPageCount: 0,
    residentAnnotationViewportSelectedFeatureCount: 0,
    residentAnnotationViewportExpectedPageCount: 0,
    residentAnnotationViewportMissingPageCount: 0,
    residentAnnotationViewportCoverageComplete: false,
    residentAnnotationViewportProducerCoverageComplete: false,
    retainedLinearTranscriptStaleHolds: 0,
    retainedLinearTranscriptLastBuildCause: '',
    compiledBroadSurfaceRgbaAdmissions: 0,
    compiledBroadSurfaceGpuPreuploads: 0,
    compiledBroadSurfaceExplicitRgbaCopyBytes: 0,
    compiledBroadSurfaceGpuPreuploadedBytes: 0,
    compiledBroadSurfacePostPresentGpuUploads: 0,
    compiledBroadSurfacePostPresentGpuUploadBytes: 0,
    compiledBroadSurfacePlanDerivationCount: 0,
    compiledBroadSurfaceCameraContractCreateCount: 0,
    compiledBroadSurfaceFastCameraMailboxCreateCount: 0,
    compiledBroadSurfaceGpuPreuploadFailures: 0,
    retainedLinearTranscriptVisibleFeatureCount: 0,
    lastRetainedTranscriptDecorationsDrawn: false,
    retainedLinearSourceWindow: null,
    featureEnvelope: () => null,
    lastInteractionOutlineCommandCount: 0,
    annotationSearchFocusMaskDrawCount: 0,
    annotationSearchFocusPrimitiveDrawCount: 0,
    annotationSearchFocusResolvedTrackId: null,
    annotationSearchFocusResolvedCanonicalIdentity: null,
    annotationSearchFocusPresentationLane: null,
    features: [],
    hitCache: { length: 0 },
    renderCallCount: 0,
    geometryRebuildCount: 0,
    geometryCacheHitCount: 0,
    lastRenderMode: 'none',
    lastGeometryRebuildReasons: [],
    lastOverviewAggregationEnabled: false,
    lastOverviewAggregationCacheHit: false,
    lastOverviewPassthroughFeatureCount: 0,
    lastOverviewDensityAtlasBinBp: 0,
    lastOverviewDensityAtlasSampleScreenPx: 0,
    lastOverviewDensityAtlasLevelCount: 0,
    lastOverviewDensityAtlasEstimatedBinCount: 0,
    lastOverviewDensityAtlasWasCoarsened: false,
    lastOverviewDensityAtlasBudgetExceeded: false,
    lastOverviewLodCompressionBlend: 0,
    lastOverviewLodFullShapeBlend: 1,
    lastOverviewCacheMs: 0,
    lastOverviewImmediateBlendMs: 0,
    retiredPrepackedAnnotationSceneLayers: new Set(),
    prepackedAnnotationSceneCameraUpdates: 0,
    prepackedAnnotationInteractionCouplingValidationCount: 0,
    prepackedAnnotationInteractionCouplingPrimitiveScanCardinality: 0,
    prepackedAnnotationTrustedV4AdmissionCount: 0,
    prepackedAnnotationInteractionQueries: 0,
    prepackedAnnotationInteractionLastVisitedNodes: 0,
    prepackedAnnotationInteractionMaxVisitedNodes: 0,
    prepackedAnnotationInteractionLastPrimitiveCandidates: 0,
    prepackedAnnotationInteractionP99Ms: () => 0,
    prepackedAnnotationInteractionMaxMs: 0,
    _layout: null,
    maxAnnotationLane: 0,
    maxCdsLane: 0,
    lastDrawAudit: null,
    ...overrides,
  };
}

function snapshotSources(
  overrides: Partial<AnnotationSnapshotHost> = {}
): AnnotationSnapshotSources {
  const host = snapshotHost(overrides);
  return {
    retained: host,
    prepacked: host,
    compiled: host,
    layout: host,
    searchFocus: host,
    hits: host,
    outlines: host,
    residentPages: host,
    tilePyramid: {
      vector: host.tilePyramidVectorCompositor,
      rtt: host.rttGlyphTilePyramidCompositor,
    },
    leftover: host,
  };
}

function presentingCompiledBroadPresenter(): CompiledBroadSurfacePixiPresenterV2 {
  return {
    isPresenting: true,
    missingCellCount: 0,
    holdingLastGood: false,
    residentCellCount: 2,
    submittedCellCount: 2,
    atomicCommitCount: 1,
    meshCreationCount: 1,
    shaderCreationCount: 1,
    geometryCreationCount: 1,
    diagnostics: () => null,
    getColdGestureSnapshot: () => ({
      activeLevelIds: Object.freeze(['exact:L0']),
      activeMipWeights: Object.freeze([1]),
      activeResidentCellIds: Object.freeze(['c0']),
      submittedCellIds: Object.freeze(['c0']),
      runtimeCellCompileCount: 0,
      runtimeDurableWriteCount: 0,
    }),
  } as unknown as CompiledBroadSurfacePixiPresenterV2;
}

describe('annotation overlay snapshot presenter', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('const compiledBroadLoadedOwners = [');
    expect(source).not.toContain('const diagnosticPrepackedResidents =');
    expect(source).not.toContain('const sourceWindowFeatureSamples =');
    expect(source).not.toContain("soleOwnerId = 'prepacked-partitioned-vector-surface'");
    expect(source).not.toContain('function getColdGestureSnapshot(');
    expect(source).not.toContain('function getDebugSnapshot(');
    expect(source).not.toContain('createAnnotationSnapshotHost');
    expect(source).toContain('getDebugSnapshotFn(this.annotationSnapshotSources())');
  });

  it('exports the snapshot entry points for the overlay façade', () => {
    expect(typeof getColdGestureSnapshot).toBe('function');
    expect(typeof getDebugSnapshot).toBe('function');
  });

  it('reports no sole owner on an empty host', () => {
    expect(getColdGestureSnapshot(snapshotSources())).toMatchObject({
      contract: 'annotation-overlay-cold-gesture-snapshot.v1',
      genomeIdentity: 'test-genome',
      genomeLengthBp: 1000,
      soleOwnerCount: 0,
      soleOwnerId: null,
      compiledBroadRasterVisible: false,
      prepackedLoaded: false,
    });
  });

  it('names the compiled-broad raster as the sole owner when it is the only visible surface', () => {
    const presenter = presentingCompiledBroadPresenter();
    const manifest = {
      trackId: 'mRNA',
      manifestFingerprint: 'fp',
    } as never;
    const provenance = {
      manifestFingerprint: 'fp',
      sourceFingerprint: 'src',
      placementFingerprint: 'plc',
      prepackedOwnerKey: 'mrna',
      prepackedArtifactKey: 'art',
    } as never;
    const owner = { manifest, provenance, presenter };
    expect(
      getColdGestureSnapshot(
        snapshotSources({
          compiledBroadSurfaceManifest: manifest,
          compiledBroadSurfaceProvenance: provenance,
          compiledBroadSurfacePresenter: presenter,
          compiledBroadSurfaceTrackOwners: new Map([['mrna', owner]]),
          compiledBroadSurfacePresentingLayerTypes: () => ['mRNA'],
          compiledBroadSurfaceOwnerForTrack: () => owner,
          compiledBroadSurfaceProvenanceIsCurrent: () => true,
          annotationLayerTypesForPresentation: () => ['mRNA'],
          annotationRequestedLayerTypes: ['mRNA'],
        })
      )
    ).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'compiled-broad-raster-surface',
      soleOwnerRole: 'exact',
      compiledBroadRasterVisible: true,
      compiledBroadRasterProvenanceValid: true,
      compiledBroadRasterResidentCellCount: 2,
      compiledBroadRasterActiveLevelIds: ['exact:L0'],
      requestedLayerM_RNAOnly: true,
    });
  });

  it('spreads presentation diagnostics into the debug snapshot', () => {
    const debug = getDebugSnapshot(
      snapshotSources({
        lastDrawnFeatureCount: 4,
        features: [{ type: 'mRNA' }, { type: 'mRNA' }],
        lastRenderMode: 'retained',
        buildPresentationDebugSnapshot: () => ({
          ...presentation(),
          annotationLodBackend: 'indexed',
          compiledBroadRasterVisible: true,
        }),
      })
    );
    expect(debug).toMatchObject({
      featureCount: 2,
      drawnFeatureCount: 4,
      lastRenderMode: 'retained',
      annotationLodBackend: 'indexed',
      compiledBroadRasterVisible: true,
      prepackedAnnotationSceneLoaded: false,
      prepackedAnnotationInteractionReady: false,
    });
  });
});
