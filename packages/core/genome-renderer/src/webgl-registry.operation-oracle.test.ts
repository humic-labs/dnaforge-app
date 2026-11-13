import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from 'pixi.js';
import type { Genome, RenderState } from './types';
import type {
  PixiLinearRendererColdGestureSnapshot,
  PixiLinearRendererOperationSnapshot,
} from './renderers/pixi/linear-renderer';
import {
  ACTIVE_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1,
  ACTIVE_PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
  ACTIVE_WEBGL_COLD_GESTURE_SNAPSHOT_V1,
  registerWebGLInstance,
  snapshotActiveAnnotationPolicyReadiness,
  snapshotActivePixiLinearRendererOperations,
  snapshotActiveWebGLColdGesture,
  unregisterWebGLInstance,
} from './webgl-registry';

const ID = 'renderer-operation-oracle-primary';
const ID_B = 'renderer-operation-oracle-secondary';

afterEach(() => {
  unregisterWebGLInstance(ID);
  unregisterWebGLInstance(ID_B);
});

function operationOracle(rendererGeneration: number): PixiLinearRendererOperationSnapshot {
  return {
    contract: 'pixi-linear-renderer-operation-snapshot.v1',
    rendererGeneration,
    operationEpoch: 12,
    contentOperationEpoch: 3,
    completedFrameEpoch: 9,
    presentedFrameEpoch: 9,
    presentedContentOperationEpoch: 3,
    forensicDebugSnapshotCount: 0,
    counts: {
      loadGenome: 1,
      annotationSnapshotAttempt: 1,
      annotationSnapshotApply: 1,
      prepackedLoad: 0,
      prepackedPrepare: 0,
      prepackedActivate: 0,
      prepackedPolicyUpdate: 0,
      prepackedRetire: 0,
      contentChangedFrame: 1,
      cameraOnlyFrame: 8,
    },
    lastEpochs: {
      loadGenome: 1,
      annotationSnapshotAttempt: 2,
      annotationSnapshotApply: 3,
      prepackedLoad: 0,
      prepackedPrepare: 0,
      prepackedActivate: 0,
      prepackedPolicyUpdate: 0,
      prepackedRetire: 0,
      contentChangedFrame: 4,
      cameraOnlyFrame: 12,
    },
  };
}

function coldRendererSnapshot(
  rendererGeneration: number,
  requestedTrackId = 'pileup-track'
): PixiLinearRendererColdGestureSnapshot {
  return {
    contract: 'pixi-linear-renderer-cold-gesture-snapshot.v1',
    supported: true,
    genomeIdentity: 'cold-genome',
    genomeLengthBp: 3_088_269_832,
    viewportStartBp: 100,
    viewportEndBp: 150_000_100,
    viewportWidthPx: 1200,
    viewportHeightPx: 800,
    operation: operationOracle(rendererGeneration),
    track: {
      requestedTrackId,
      trackFound: true,
      diagnosticsSupported: true,
      trackType: 'pileup',
      coverageLodRole: 'resident',
      coverageLodLevel: 4,
      coverageLodTargetLevel: 4,
      coverageLodBinSize: 16384,
      coverageLodAuthority: 'gpu-atlas',
      coverageLodProvenanceExact: true,
      coverageSamplePassCount: 0,
      coverageGeometryBuildCount: 0,
      coverageBufferUploadCount: 0,
      coverageSignalNonzeroBinCount: 12_345,
      renderedReadDensityAlpha: 1,
      densityRowsMeshVisible: false,
      coverageGpuAtlasAuthorityKey: 'coverage-authority',
      coverageGpuAtlasTextureResourceCreateCount: 1,
      coverageGpuAtlasGpuTextureResourceCreateCount: 1,
      coverageGpuAtlasGpuTextureUploadCount: 1,
      coverageGpuAtlasGpuTextureUploadComplete: true,
      coverageGpuAtlasTextureResourceUid: 0,
      coverageGpuAtlasShaderTextureResourceUid: 0,
      coverageGpuAtlasShaderTextureResourceBound: true,
      coverageGpuAtlasGeometryBuildCount: 1,
      coverageGpuAtlasCameraUniformUpdateCount: 3,
      coverageGpuAtlasRenderOwner: 'coverage-gpu-atlas',
      coverageGpuAtlasShaderProgramName: 'coverage-gpu-atlas',
      coverageGpuAtlasShaderProgramKey: 0,
      coverageGpuAtlasShaderProgramCompiled: true,
      coverageGpuAtlasActive: true,
      coverageGpuAtlasBaseBinSizeBp: 256,
      rendererViewportStartBp: 100,
      rendererViewportEndBp: 150_000_100,
    },
    annotation: {
      contract: 'annotation-overlay-cold-gesture-snapshot.v1',
      genomeIdentity: 'cold-genome',
      genomeLengthBp: 3_088_269_832,
      presentationVisible: true,
      requestedLayerTypes: ['mRNA'],
      lastCompleteLayerTypes: ['mRNA'],
      requestedResidentTracks: [],
      requestedLayerM_RNAOnly: true,
      soleOwnerCount: 1,
      soleOwnerId: 'prepacked-partitioned-vector-surface',
      soleOwnerRole: 'exact',
      soleOwnerLayerTypes: ['mRNA'],
      soleOwnerVisualGroups: ['transcript-body', 'cds-exon', 'intron-connector'],
      soleOwnerCoverageComplete: true,
      soleOwnerContractValid: true,
      activeOwnerKey: 'owner',
      activeOwnerGeneration: 1,
      activeArtifactKey: 'artifact',
      activeSourceIdentity: 'cold-genome',
      activeTrackType: 'mRNA',
      activeRuntimeIsoformMode: 'canonical',
      activeRuntimeLaneLimit: 12,
      activePolicyGeneration: 2,
      activeSourceFingerprint: 'source',
      activePlacementFingerprint: 'placement',
      runtimeGenomeWideTextureVisible: false,
      prebuiltRasterLoaded: true,
      prebuiltRasterVisible: false,
      prebuiltRasterEligible: false,
      prebuiltRasterContractMatch: true,
      prebuiltRasterSourceMatch: true,
      prebuiltRasterPlacementMatch: true,
      prebuiltRasterArtifactM_RNAOnly: true,
      prebuiltRasterSourceFingerprint: 'source',
      prebuiltRasterPlacementFingerprint: 'placement',
      prebuiltRasterCompositeCount: 1,
      legacyPrebuiltRasterVisible: false,
      rasterOwnerCount: 0,
      compiledBroadRasterLoaded: false,
      compiledBroadRasterVisible: false,
      compiledBroadRasterProvenanceValid: false,
      compiledBroadRasterProvenanceManifestFingerprint: null,
      compiledBroadRasterProvenanceSourceFingerprint: null,
      compiledBroadRasterProvenancePlacementFingerprint: null,
      compiledBroadRasterProvenancePrepackedOwnerKey: null,
      compiledBroadRasterProvenancePrepackedArtifactKey: null,
      compiledBroadRasterHoldingLastGood: false,
      compiledBroadRasterPlanStatus: 'not-loaded',
      compiledBroadRasterResidentCellCount: 0,
      compiledBroadRasterSubmittedCellCount: 0,
      compiledBroadRasterMissingCellCount: 0,
      compiledBroadRasterActiveLevelIds: [],
      compiledBroadRasterActiveMipWeights: [],
      compiledBroadRasterActiveResidentCellIds: [],
      compiledBroadRasterSubmittedCellIds: [],
      compiledBroadRasterVectorSubmissionCount: 0,
      compiledBroadRasterRuntimeCellCompileCount: 0,
      compiledBroadRasterRuntimeDurableWriteCount: 0,
      compiledBroadInteractionResidentGeneration: 0,
      compiledBroadInteractionRequestedOwnerPresent: false,
      compiledBroadRasterMeshCreationCount: 0,
      compiledBroadRasterShaderCreationCount: 0,
      compiledBroadRasterGeometryCreationCount: 0,
      overviewGlyphTilesVisible: false,
      overviewGlyphTilesCoverageComplete: false,
      overviewGlyphTilesBuildCount: 0,
      overviewGlyphTilesCompositeCount: 0,
      compiledVectorVisible: false,
      compiledVectorCoverageComplete: false,
      retainedTranscriptVisible: false,
      retainedSourceShapeVisible: false,
      immediateLiveVisible: false,
      prepackedOwnerKey: 'owner',
      prepackedOwnerGeneration: 1,
      prepackedResidentRosterGeneration: 1,
      prepackedRequestedResidentCount: 0,
      prepackedRequestedResidentRosterReady: false,
      prepackedRequestedSingleResidentOwnerKey: null,
      prepackedRequestedSingleResidentArtifactKey: null,
      prepackedRequestedSingleResidentCoverageStartBp: null,
      prepackedRequestedSingleResidentCoverageEndBp: null,
      prepackedRequestedSingleResidentHandoffStartBp: null,
      prepackedRequestedSingleResidentHandoffEndBp: null,
      prepackedRequestedSingleResidentPresentationAdmitted: null,
      prepackedLoaded: true,
      prepackedStatus: 'eligible',
      prepackedGpuPrepared: true,
      prepackedMetadataGenomeIdentity: 'cold-genome',
      prepackedMetadataGenomeLengthBp: 3_088_269_832,
      prepackedMetadataPartitionSpanBp: 100_000_000,
      prepackedMetadataArtifactKey: 'artifact',
      prepackedMetadataThemeMode: 'light',
      prepackedMetadataTrackType: 'mRNA',
      prepackedMetadataAnnotationBarHeightPx: 10,
      prepackedMetadataLaneAlgorithmToken: 'lane',
      prepackedMetadataMapperContractToken: 'mapper',
      prepackedMetadataGeometryContractToken: 'geometry',
      prepackedMetadataInteractionContractToken: 'interaction',
      prepackedRuntimeIsoformMode: 'canonical',
      prepackedRuntimeLaneLimit: 12,
      prepackedPolicyGeneration: 2,
      prepackedSubmittedPartitionCount: 2,
      prepackedSubmittedInstanceCount: 12,
      prepackedSceneLayerCreates: 1,
      prepackedSceneLayerDestroys: 0,
      prepackedSceneGpuPreparations: 1,
      prepackedSceneVisiblePartitionCount: 2,
      prepackedSceneVisibleInstanceCount: 12,
      prepackedSceneStartupBuilds: 0,
      retainedLinearDataBuilds: 0,
      retainedLinearTranscriptBuilds: 0,
      retainedLinearTranscriptPacks: 0,
      retainedTranscriptDecorationBuilds: 0,
    },
  };
}

function register(
  rendererRef: { current: unknown | null },
  instanceId = ID,
  createdAt = 123
): void {
  registerWebGLInstance({
    instanceId,
    createdAt,
    containerRef: { current: { isConnected: true } as HTMLElement },
    appRef: { current: { destroyed: false } as unknown as Application },
    rendererRef,
    stateRef: { current: {} as RenderState },
    visibleRef: { current: true },
    genomeRef: { current: null },
    frameCountRef: { current: 0 },
    lastFrameTRef: { current: 0 },
  });
}

describe('constant-time active renderer operation bridge', () => {
  it('pairs the exact registry mount identity with the renderer generation', () => {
    const operation = operationOracle(41);
    const getRendererOperationSnapshot = vi.fn(() => operation);
    const getRendererDebugSnapshot = vi.fn(() => {
      throw new Error('heavy debug snapshot must not be touched');
    });
    register({ current: { getRendererOperationSnapshot, getRendererDebugSnapshot } });

    expect(snapshotActivePixiLinearRendererOperations()).toEqual({
      contract: ACTIVE_PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
      verdict: 'exactly-one',
      instanceId: ID,
      instanceCreatedAt: 123,
      visibleLiveInstanceCount: 1,
      operationOracle: operation,
    });
    expect(getRendererOperationSnapshot).toHaveBeenCalledOnce();
    expect(getRendererDebugSnapshot).not.toHaveBeenCalled();
  });

  it('detects renderer replacement even when the registry mount identity is unchanged', () => {
    const rendererRef = {
      current: { getRendererOperationSnapshot: () => operationOracle(51) } as unknown,
    };
    register(rendererRef);
    const before = snapshotActivePixiLinearRendererOperations();

    rendererRef.current = { getRendererOperationSnapshot: () => operationOracle(52) };
    const after = snapshotActivePixiLinearRendererOperations();

    expect(after.instanceId).toBe(before.instanceId);
    expect(after.instanceCreatedAt).toBe(before.instanceCreatedAt);
    expect(before.operationOracle?.rendererGeneration).toBe(51);
    expect(after.operationOracle?.rendererGeneration).toBe(52);
  });

  it('fails closed on ambiguity without querying either renderer', () => {
    const first = vi.fn(() => operationOracle(61));
    const second = vi.fn(() => operationOracle(62));
    register({ current: { getRendererOperationSnapshot: first } });
    register({ current: { getRendererOperationSnapshot: second } }, ID_B, 456);

    expect(snapshotActivePixiLinearRendererOperations()).toEqual({
      contract: ACTIVE_PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
      verdict: 'ambiguous',
      instanceId: null,
      instanceCreatedAt: null,
      visibleLiveInstanceCount: 2,
      operationOracle: null,
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('fails closed when the sole renderer omits, throws, or returns an invalid oracle', () => {
    register({ current: {} });
    expect(snapshotActivePixiLinearRendererOperations()).toMatchObject({
      verdict: 'unsupported',
      instanceId: ID,
      instanceCreatedAt: 123,
      operationOracle: null,
    });

    unregisterWebGLInstance(ID);
    register({
      current: {
        getRendererOperationSnapshot: () => {
          throw new Error('destroyed');
        },
      },
    });
    expect(snapshotActivePixiLinearRendererOperations()).toMatchObject({
      verdict: 'unsupported',
      operationOracle: null,
    });

    unregisterWebGLInstance(ID);
    register({
      current: {
        getRendererOperationSnapshot: () => ({
          ...operationOracle(71),
          counts: { ...operationOracle(71).counts, cameraOnlyFrame: Number.NaN },
        }),
      },
    });
    expect(snapshotActivePixiLinearRendererOperations()).toMatchObject({
      verdict: 'unsupported',
      operationOracle: null,
    });
  });
});

describe('bounded annotation policy readiness bridge', () => {
  const readiness = {
    contract: 'pixi-linear-renderer-annotation-policy-readiness-snapshot.v1' as const,
    supported: true,
    genomeIdentity: 'GRCh38',
    genomeLengthBp: 3_088_269_832,
    viewportStartBp: 0,
    viewportEndBp: 3_088_269_832,
    annotation: {
      contract: 'annotation-overlay-policy-readiness-snapshot.v1' as const,
      annotationPresentationOwnerViolations: [],
      annotationPresentationLayerTypes: ['mRNA'],
      annotationPresentationOwners: [],
      prebuiltGenomeWideTextureLoaded: false,
      prebuiltGenomeWideTextureContractMatch: false,
      prebuiltGenomeWideTextureSourceMatch: false,
      prebuiltGenomeWideTexturePlacementMatch: false,
      prebuiltGenomeWideTexturePlacementFingerprint: null,
      prebuiltGenomeWideTextureLayerTypes: [],
      prebuiltGenomeWideTextureVisible: false,
      prebuiltGenomeWideTextureEligible: false,
      compiledBroad: null,
    },
  };

  it('reads only the bounded readiness receipt and preserves mount identity', () => {
    const getAnnotationPolicyReadinessSnapshot = vi.fn(() => readiness);
    const getRendererDebugSnapshot = vi.fn(() => {
      throw new Error('forensic renderer snapshot must not run');
    });
    register({ current: { getAnnotationPolicyReadinessSnapshot, getRendererDebugSnapshot } });

    expect(snapshotActiveAnnotationPolicyReadiness()).toEqual({
      contract: ACTIVE_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1,
      verdict: 'exactly-one',
      instanceId: ID,
      instanceCreatedAt: 123,
      visibleLiveInstanceCount: 1,
      renderer: readiness,
    });
    expect(getAnnotationPolicyReadinessSnapshot).toHaveBeenCalledOnce();
    expect(getRendererDebugSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed on ambiguity without sampling either renderer', () => {
    const first = vi.fn(() => readiness);
    const second = vi.fn(() => readiness);
    register({ current: { getAnnotationPolicyReadinessSnapshot: first } });
    register({ current: { getAnnotationPolicyReadinessSnapshot: second } }, ID_B, 456);

    expect(snapshotActiveAnnotationPolicyReadiness()).toMatchObject({
      contract: ACTIVE_ANNOTATION_POLICY_READINESS_SNAPSHOT_V1,
      verdict: 'ambiguous',
      visibleLiveInstanceCount: 2,
      renderer: null,
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});

describe('production cold-gesture registry oracle', () => {
  function registerCold(renderer: unknown, instanceId = ID, createdAt = 123) {
    const containerLayoutRead = vi.fn(() => {
      throw new Error('snapshotOne/DOM layout must not run');
    });
    const app = {
      destroyed: false,
      get canvas() {
        throw new Error('snapshotOne must not inspect canvas');
      },
      get ticker() {
        throw new Error('snapshotOne must not inspect ticker');
      },
      get stage() {
        throw new Error('snapshotOne must not inspect stage');
      },
    } as unknown as Application;
    registerWebGLInstance({
      instanceId,
      createdAt,
      containerRef: {
        current: {
          getBoundingClientRect: containerLayoutRead,
          querySelectorAll: containerLayoutRead,
        } as unknown as HTMLElement,
      },
      appRef: { current: app },
      rendererRef: { current: renderer },
      stateRef: { current: {} as RenderState },
      visibleRef: { current: true },
      genomeRef: {
        current: {
          name: 'cold-genome',
          sourceIdentity: 'cold-genome',
          length: 3_088_269_832,
          circular: false,
          features: [],
        } satisfies Genome,
      },
      frameCountRef: { current: 88 },
      lastFrameTRef: { current: 0 },
    });
    return containerLayoutRead;
  }

  it('binds the exact sole registry identity without invoking either heavy snapshot path', () => {
    const cold = coldRendererSnapshot(81);
    const getColdGestureSnapshot = vi.fn(() => cold);
    const getRendererDebugSnapshot = vi.fn(() => {
      throw new Error('heavy renderer snapshot must not run');
    });
    const getRendererOperationSnapshot = vi.fn(() => {
      throw new Error('separate operation bridge must not run');
    });
    const containerLayoutRead = registerCold({
      getColdGestureSnapshot,
      getRendererDebugSnapshot,
      getRendererOperationSnapshot,
    });

    expect(snapshotActiveWebGLColdGesture('pileup-track')).toEqual({
      contract: ACTIVE_WEBGL_COLD_GESTURE_SNAPSHOT_V1,
      verdict: 'exactly-one',
      requestedTrackId: 'pileup-track',
      instanceId: ID,
      instanceCreatedAt: 123,
      registeredInstanceCount: 1,
      frameCount: 88,
      registryGenomeIdentity: 'cold-genome',
      registryGenomeLengthBp: 3_088_269_832,
      renderer: cold,
    });
    expect(getColdGestureSnapshot).toHaveBeenCalledExactlyOnceWith('pileup-track');
    expect(getRendererDebugSnapshot).not.toHaveBeenCalled();
    expect(getRendererOperationSnapshot).not.toHaveBeenCalled();
    expect(containerLayoutRead).not.toHaveBeenCalled();
  });

  it('fails closed on multiple registered instances without sampling either renderer', () => {
    const first = vi.fn(() => coldRendererSnapshot(91));
    const second = vi.fn(() => coldRendererSnapshot(92));
    registerCold({ getColdGestureSnapshot: first }, ID, 123);
    registerCold({ getColdGestureSnapshot: second }, ID_B, 456);

    expect(snapshotActiveWebGLColdGesture('pileup-track')).toMatchObject({
      verdict: 'ambiguous',
      registeredInstanceCount: 2,
      instanceId: null,
      renderer: null,
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('fails closed when the renderer answers for another requested track', () => {
    registerCold({
      getColdGestureSnapshot: () => coldRendererSnapshot(101, 'different-track'),
    });
    expect(snapshotActiveWebGLColdGesture('pileup-track')).toMatchObject({
      verdict: 'unsupported',
      instanceId: ID,
      registryGenomeIdentity: 'cold-genome',
      renderer: null,
    });
  });

  it.each([
    ['missing active level roster', { compiledBroadRasterActiveLevelIds: undefined }],
    ['malformed mip weights', { compiledBroadRasterActiveMipWeights: [0.5, Number.NaN] }],
    ['malformed active residency', { compiledBroadRasterActiveResidentCellIds: [''] }],
    ['malformed submitted roster', { compiledBroadRasterSubmittedCellIds: [42] }],
    ['negative runtime compile count', { compiledBroadRasterRuntimeCellCompileCount: -1 }],
    ['fractional durable write count', { compiledBroadRasterRuntimeDurableWriteCount: 0.5 }],
    ['malformed owner layer types', { soleOwnerLayerTypes: [''] }],
    ['malformed owner visual groups', { soleOwnerVisualGroups: [42] }],
  ])('fails closed on a %s in the compiled-broad cold receipt', (_name, override) => {
    const cold = coldRendererSnapshot(111);
    registerCold({
      getColdGestureSnapshot: () => ({
        ...cold,
        annotation: { ...cold.annotation, ...override },
      }),
    });
    expect(snapshotActiveWebGLColdGesture('pileup-track')).toMatchObject({
      verdict: 'unsupported',
      renderer: null,
    });
  });
});
