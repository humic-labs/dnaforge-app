// @vitest-environment node

import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDna708bColdStartReloadBridge,
  installDna708bColdStartReloadBridge,
  type ColdStartReloadBridgeRuntime,
} from './cold-start-reload-bridge';

const GENOME_LENGTH = 3_088_269_832;
const PRESET = 'assembly-grch38-local-hg002-80x';
const TRACK_ID = 'pileup-genomewide-grch38';
const ANNOTATION_SOURCE_IDENTITY = `assembly-annotation-source-sha256.v1:${'c'.repeat(64)}`;
const ANNOTATION_ARTIFACT_KEY = 'annotation-scene-v4-fixture';
const PHYSICAL_GPU_ATLAS_DIAGNOSTIC = {
  densityRowsMeshVisible: false,
  coverageSignalNonzeroBinCount: 0,
  coverageLodLevel: null,
  coverageLodTargetLevel: null,
  coverageGpuAtlasActive: true,
  coverageGpuAtlasAuthorityKey: '["coverage-gpu-atlas.v1","source","assembly","mean","revision"]',
  coverageGpuAtlasRenderOwner: 'coverage-gpu-atlas-fill',
  coverageGpuAtlasShaderProgramName: 'coverage-gpu-atlas-fill-fragment',
  coverageGpuAtlasShaderProgramCompiled: true,
  coverageGpuAtlasShaderProgramKey: 9001,
  coverageGpuAtlasShaderTextureResourceBound: true,
  coverageGpuAtlasTextureResourceUid: 41,
  coverageGpuAtlasShaderTextureResourceUid: 41,
  coverageGpuAtlasTextureResourceCreateCount: 1,
  coverageGpuAtlasGpuTextureResourceCreateCount: 1,
  coverageGpuAtlasGpuTextureUploadCount: 1,
  coverageGpuAtlasGpuTextureUploadComplete: true,
  coverageGpuAtlasGeometryBuildCount: 1,
  coverageGpuAtlasCameraUniformUpdateCount: 1,
  coverageGpuAtlasBaseBinSizeBp: 1024,
  coverageSamplePassCount: 0,
  coverageGeometryBuildCount: 0,
  coverageBufferUploadCount: 0,
};

function renderer({
  start = 0,
  end = GENOME_LENGTH,
  present = true,
  owners = ['compiled-broad-raster-surface'],
  packCount = 0,
  buildCount = 0,
  rasterLoaded = true,
  rasterVisible = true,
  rasterEligible = true,
  rasterContractMatch = true,
  rasterSourceMatch = true,
  rasterPlacementMatch = true,
  rasterSourceFingerprint = '0123456789abcdef01234567',
  rasterPlacementFingerprint = 'ap1:0123456789abcdef01234567',
  rasterLayerTypes = ['mRNA'],
  rasterComposites = 1,
  prepackedSubmittedPartitionCount = 0,
  prepackedSubmittedInstanceCount = 0,
  compiledResidentOwnerKey = null,
  compiledResidentArtifactKey = null,
  compiledResidentRosterGeneration = 0,
  presentedFrameEpoch = 9,
  presentedContentOperationEpoch = 3,
  coverageDiagnosticOverrides = {},
}: {
  start?: number;
  end?: number;
  present?: boolean;
  owners?: string[];
  packCount?: number | null;
  buildCount?: number | null;
  rasterLoaded?: boolean;
  rasterVisible?: boolean;
  rasterEligible?: boolean;
  rasterContractMatch?: boolean;
  rasterSourceMatch?: boolean;
  rasterPlacementMatch?: boolean;
  rasterSourceFingerprint?: string | null;
  rasterPlacementFingerprint?: string | null;
  rasterLayerTypes?: string[];
  rasterComposites?: number;
  prepackedSubmittedPartitionCount?: number;
  prepackedSubmittedInstanceCount?: number;
  compiledResidentOwnerKey?: string | null;
  compiledResidentArtifactKey?: string | null;
  compiledResidentRosterGeneration?: number;
  presentedFrameEpoch?: number;
  presentedContentOperationEpoch?: number;
  coverageDiagnosticOverrides?: Record<string, unknown>;
} = {}) {
  const diagnostics = {
    renderedReadDensityAlpha: present ? 1 : 0,
    rendererViewportStartBp: start,
    rendererViewportEndBp: end,
    ...PHYSICAL_GPU_ATLAS_DIAGNOSTIC,
    coverageGpuAtlasActive: present,
    ...coverageDiagnosticOverrides,
  };
  const presentationLayerTypes = ['mRNA'];
  const annotation = {
    annotationPresentationStyleId: 'indexed-linear-annotation-visual-contract-v1',
    annotationPresentationOwnerViolations: [],
    annotationPresentationLayerTypes: presentationLayerTypes,
    annotationPresentationOwners: owners.map((ownerId) => ({
      ownerId,
      visible: true,
      role: 'exact',
      layerTypes: presentationLayerTypes,
      coverageComplete: true,
    })),
    retainedLinearDataBuilds: packCount,
    retainedLinearTranscriptBuilds: buildCount,
    prepackedAnnotationSceneStatus: 'eligible',
    prepackedAnnotationSceneLoaded: true,
    prepackedAnnotationSceneGpuPrepared: true,
    prepackedAnnotationSceneLayerCreates: 1,
    prepackedAnnotationSceneLayerDestroys: 0,
    prepackedAnnotationSceneVisiblePartitionCount: prepackedSubmittedPartitionCount,
    prepackedAnnotationSceneVisibleInstanceCount: prepackedSubmittedInstanceCount,
    prebuiltGenomeWideTextureLoaded: rasterLoaded,
    prebuiltGenomeWideTextureVisible: rasterVisible,
    prebuiltGenomeWideTextureEligible: rasterEligible,
    prebuiltGenomeWideTextureContractMatch: rasterContractMatch,
    prebuiltGenomeWideTextureSourceMatch: rasterSourceMatch,
    prebuiltGenomeWideTexturePlacementMatch: rasterPlacementMatch,
    prebuiltGenomeWideTexturePlacementFingerprint: rasterPlacementFingerprint,
    prebuiltGenomeWideTextureLayerTypes: rasterLayerTypes,
    prebuiltGenomeWideComposites: rasterComposites,
  };
  const coldAnnotation = {
    contract: 'annotation-overlay-cold-gesture-snapshot.v1',
    genomeIdentity: ANNOTATION_SOURCE_IDENTITY,
    genomeLengthBp: GENOME_LENGTH,
    presentationVisible: true,
    requestedLayerM_RNAOnly: true,
    soleOwnerCount: owners.length,
    soleOwnerId: owners.length === 1 ? owners[0] : null,
    soleOwnerRole: owners.length === 1 ? 'exact' : null,
    soleOwnerCoverageComplete: owners.length === 1,
    soleOwnerContractValid: owners.length === 1,
    activeOwnerKey: compiledResidentOwnerKey,
    activeOwnerGeneration: compiledResidentRosterGeneration,
    activeArtifactKey: compiledResidentArtifactKey,
    activeSourceIdentity: owners.length === 1 ? ANNOTATION_SOURCE_IDENTITY : null,
    activeTrackType: owners.length === 1 ? 'mRNA' : null,
    activeRuntimeIsoformMode: owners.length === 1 ? 'canonical' : null,
    activeRuntimeLaneLimit: owners.length === 1 ? 2 : null,
    activePolicyGeneration: owners.length === 1 ? 1 : 0,
    activeSourceFingerprint: owners.length === 1 ? rasterSourceFingerprint : null,
    activePlacementFingerprint: owners.length === 1 ? rasterPlacementFingerprint : null,
    runtimeGenomeWideTextureVisible: false,
    prebuiltRasterLoaded: rasterLoaded,
    prebuiltRasterVisible: rasterVisible,
    prebuiltRasterEligible: rasterEligible,
    prebuiltRasterContractMatch: rasterContractMatch,
    prebuiltRasterSourceMatch: rasterSourceMatch,
    prebuiltRasterPlacementMatch: rasterPlacementMatch,
    prebuiltRasterArtifactM_RNAOnly:
      rasterLayerTypes.length === 1 && rasterLayerTypes[0] === 'mRNA',
    prebuiltRasterSourceFingerprint: rasterSourceFingerprint,
    prebuiltRasterPlacementFingerprint: rasterPlacementFingerprint,
    prebuiltRasterCompositeCount: rasterComposites,
    overviewGlyphTilesVisible: false,
    overviewGlyphTilesCoverageComplete: false,
    overviewGlyphTilesBuildCount: 0,
    overviewGlyphTilesCompositeCount: 0,
    compiledVectorVisible: false,
    compiledVectorCoverageComplete: false,
    compiledBroadRasterLoaded: compiledResidentOwnerKey !== null,
    compiledBroadRasterVisible: compiledResidentOwnerKey !== null,
    compiledBroadRasterProvenanceValid: compiledResidentOwnerKey !== null,
    compiledBroadRasterProvenancePrepackedOwnerKey: compiledResidentOwnerKey,
    compiledBroadRasterProvenancePrepackedArtifactKey: compiledResidentArtifactKey,
    compiledBroadRasterHoldingLastGood: false,
    compiledBroadRasterActiveLevelIds: [],
    compiledBroadRasterActiveMipWeights: [],
    compiledBroadRasterActiveResidentCellIds: [],
    compiledBroadRasterSubmittedCellIds: [],
    compiledBroadRasterRuntimeCellCompileCount: 0,
    compiledBroadRasterRuntimeDurableWriteCount: 0,
    compiledBroadInteractionResidentGeneration: compiledResidentRosterGeneration,
    compiledBroadInteractionRequestedOwnerPresent: compiledResidentOwnerKey !== null,
    retainedTranscriptVisible: false,
    retainedSourceShapeVisible: false,
    immediateLiveVisible: false,
    prepackedOwnerKey: null,
    prepackedOwnerGeneration: 0,
    prepackedResidentRosterGeneration: compiledResidentRosterGeneration,
    prepackedRequestedResidentCount: compiledResidentOwnerKey === null ? 0 : 1,
    prepackedRequestedResidentRosterReady: compiledResidentOwnerKey !== null,
    prepackedRequestedSingleResidentOwnerKey: compiledResidentOwnerKey,
    prepackedRequestedSingleResidentArtifactKey: compiledResidentArtifactKey,
    prepackedLoaded: false,
    prepackedStatus: 'not-loaded',
    prepackedGpuPrepared: false,
    prepackedMetadataGenomeIdentity: null,
    prepackedMetadataGenomeLengthBp: null,
    prepackedMetadataPartitionSpanBp: null,
    prepackedMetadataArtifactKey: null,
    prepackedMetadataThemeMode: null,
    prepackedMetadataTrackType: null,
    prepackedMetadataAnnotationBarHeightPx: null,
    prepackedMetadataLaneAlgorithmToken: null,
    prepackedMetadataMapperContractToken: null,
    prepackedMetadataGeometryContractToken: null,
    prepackedMetadataInteractionContractToken: null,
    prepackedRuntimeIsoformMode: null,
    prepackedRuntimeLaneLimit: null,
    prepackedPolicyGeneration: 0,
    prepackedSubmittedPartitionCount,
    prepackedSubmittedInstanceCount,
    prepackedSceneLayerCreates: 1,
    prepackedSceneLayerDestroys: 0,
    prepackedSceneGpuPreparations: 1,
    prepackedSceneVisiblePartitionCount: prepackedSubmittedPartitionCount,
    prepackedSceneVisibleInstanceCount: prepackedSubmittedInstanceCount,
    prepackedSceneStartupBuilds: 0,
    retainedLinearDataBuilds: packCount,
    retainedLinearTranscriptBuilds: buildCount,
    retainedLinearTranscriptPacks: 0,
    retainedTranscriptDecorationBuilds: 0,
  };
  return {
    getCurrentPathMapper: () => ({ model: { viewStartBp: start, viewEndBp: end } }),
    getTrackDiagnostics: (trackId: string) => (trackId === TRACK_ID ? diagnostics : null),
    getRendererDebugSnapshot: () => ({
      annotationOverlay: annotation,
      laneContract: { trackDiagnostics: { [TRACK_ID]: diagnostics } },
    }),
    annotationOverlay: {
      getDebugSnapshot: () => annotation,
    },
    getColdGestureSnapshot: (trackId: string) => ({
      contract: 'pixi-linear-renderer-cold-gesture-snapshot.v1',
      supported: trackId === TRACK_ID,
      genomeIdentity: ANNOTATION_SOURCE_IDENTITY,
      genomeLengthBp: GENOME_LENGTH,
      viewportStartBp: start,
      viewportEndBp: end,
      viewportWidthPx: 1200,
      viewportHeightPx: 800,
      operation: {
        contract: 'pixi-linear-renderer-operation-snapshot.v1',
        rendererGeneration: 2,
        operationEpoch: 12,
        contentOperationEpoch: 3,
        completedFrameEpoch: 9,
        presentedFrameEpoch,
        presentedContentOperationEpoch,
        counts: {
          loadGenome: 1,
          annotationSnapshotAttempt: 1,
          annotationSnapshotApply: 1,
          prepackedLoad: 1,
          prepackedPrepare: 1,
          prepackedActivate: 1,
          prepackedPolicyUpdate: 0,
          prepackedRetire: 0,
          contentChangedFrame: 1,
          cameraOnlyFrame: 8,
        },
        lastEpochs: {
          loadGenome: 1,
          annotationSnapshotAttempt: 2,
          annotationSnapshotApply: 3,
          prepackedLoad: 4,
          prepackedPrepare: 5,
          prepackedActivate: 6,
          prepackedPolicyUpdate: 0,
          prepackedRetire: 0,
          contentChangedFrame: 7,
          cameraOnlyFrame: 12,
        },
      },
      track: {
        requestedTrackId: trackId,
        trackFound: trackId === TRACK_ID,
        diagnosticsSupported: trackId === TRACK_ID,
        trackType: 'pileup-genomewide',
        ...diagnostics,
      },
      annotation: coldAnnotation,
    }),
  };
}

function harness() {
  let clock = 100;
  let frameId = 0;
  let timeoutId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timeouts = new Map<number, () => void>();
  const events: string[] = [];
  const oldRenderer = renderer();
  const ownerKey = [
    'annotation-scene-owner.v3',
    '0123456789abcdef01234567',
    'a'.repeat(64),
    ANNOTATION_ARTIFACT_KEY,
  ].join('\n');
  const runGeneration = 'new-viewer-generation';
  const state: any = {
    __webglRenderer: oldRenderer,
    __tileEngineDriver: { built: 4 },
    __tileEngineFeed: {
      published: true,
      targetLevel: 20,
      coverageLevel: 20,
    },
    __tileEngineDebug: () => ({ [TRACK_ID]: { level: 20 } }),
    registry: [
      {
        instanceId: 'old-instance',
        createdAt: 1,
        visible: true,
        frameCount: 40,
        container: { connected: true },
        app: { alive: true, canvasEl: {} },
        genome: { sourceIdentity: ANNOTATION_SOURCE_IDENTITY, length: GENOME_LENGTH },
      },
    ],
  };
  state.presentedSession = {
    sessionId: 'genome-session-new-instance',
    openReady: true,
    annotationReadiness: 'ready',
    searchReadiness: 'ready',
    projectedAnnotationReadiness: 'ready',
    projectedSearchReadiness: 'ready',
  };
  state.document = {
    querySelectorAll: (selector: string) =>
      selector === '[data-testid="indexed-genome-tab"]' && state.presentedSession
        ? [
            {
              getAttribute: (name: string) => {
                if (name === 'data-session-id') return state.presentedSession.sessionId;
                if (name === 'data-session-open-ready') {
                  return String(state.presentedSession.openReady);
                }
                if (name === 'data-session-assembly-annotation-products-readiness') {
                  return state.presentedSession.annotationReadiness;
                }
                if (name === 'data-session-assembly-search-readiness') {
                  return state.presentedSession.searchReadiness;
                }
                if (name === 'data-assembly-annotation-products-readiness')
                  return state.presentedSession.projectedAnnotationReadiness;
                if (name === 'data-assembly-search-readiness')
                  return state.presentedSession.projectedSearchReadiness;
                return null;
              },
            },
          ]
        : [],
  };
  state.registry[0].renderer = () => state.__webglRenderer;
  const inactiveColdGestureSnapshot = (
    verdict: 'none' | 'ambiguous' | 'inactive' | 'unsupported',
    requestedTrackId: string,
    registeredInstanceCount: number
  ) => ({
    contract: 'active-webgl-cold-gesture-snapshot.v1',
    verdict,
    requestedTrackId,
    instanceId: null,
    instanceCreatedAt: null,
    registeredInstanceCount,
    frameCount: null,
    registryGenomeIdentity: null,
    registryGenomeLengthBp: null,
    renderer: null,
  });
  state.__webglColdGestureSnapshot = (requestedTrackId: string) => {
    const registeredInstanceCount = state.registry.length;
    if (registeredInstanceCount === 0) {
      return inactiveColdGestureSnapshot('none', requestedTrackId, 0);
    }
    if (registeredInstanceCount !== 1) {
      return inactiveColdGestureSnapshot('ambiguous', requestedTrackId, registeredInstanceCount);
    }

    const instance = state.registry[0];
    const registryGenomeIdentity = instance.genome?.sourceIdentity ?? null;
    const registryGenomeLengthBp = instance.genome?.length ?? null;
    const identifiedSnapshot = (
      verdict: 'exactly-one' | 'inactive' | 'unsupported',
      rendererSnapshot: unknown
    ) => ({
      contract: 'active-webgl-cold-gesture-snapshot.v1',
      verdict,
      requestedTrackId,
      instanceId: instance.instanceId ?? null,
      instanceCreatedAt: instance.createdAt ?? null,
      registeredInstanceCount,
      frameCount: instance.frameCount ?? null,
      registryGenomeIdentity,
      registryGenomeLengthBp,
      renderer: rendererSnapshot,
    });
    if (
      instance.visible !== true ||
      instance.container?.connected !== true ||
      instance.app?.alive !== true
    ) {
      return identifiedSnapshot('inactive', null);
    }

    const activeRenderer = instance.renderer?.();
    const rawRendererSnapshot = activeRenderer?.getColdGestureSnapshot?.(requestedTrackId) ?? null;
    const owner = state.ownerOracleOwner;
    const rendererSnapshot = rawRendererSnapshot
      ? {
          ...rawRendererSnapshot,
          annotation: {
            ...rawRendererSnapshot.annotation,
            prepackedOwnerKey: owner?.ownerKey ?? null,
            prepackedOwnerGeneration: owner?.ownerGeneration ?? 0,
            prepackedLoaded: owner?.loaded ?? false,
            prepackedStatus: owner?.status ?? 'not-loaded',
            prepackedGpuPrepared: owner?.gpuPrepared ?? false,
            prepackedMetadataGenomeIdentity: owner?.metadata?.genomeIdentity ?? null,
            prepackedMetadataGenomeLengthBp: owner?.metadata?.genomeLengthBp ?? null,
            prepackedMetadataArtifactKey: owner?.metadata?.artifactKey ?? null,
            prepackedMetadataTrackType: 'mRNA',
            activeOwnerKey: owner?.ownerKey ?? rawRendererSnapshot.annotation.activeOwnerKey,
            activeOwnerGeneration:
              owner?.ownerGeneration ?? rawRendererSnapshot.annotation.activeOwnerGeneration,
            activeArtifactKey:
              owner?.metadata?.artifactKey ?? rawRendererSnapshot.annotation.activeArtifactKey,
            activeSourceIdentity:
              owner?.metadata?.genomeIdentity ??
              rawRendererSnapshot.annotation.activeSourceIdentity,
            activeTrackType: owner ? 'mRNA' : rawRendererSnapshot.annotation.activeTrackType,
            activeRuntimeIsoformMode: owner
              ? 'canonical'
              : rawRendererSnapshot.annotation.activeRuntimeIsoformMode,
            activeRuntimeLaneLimit: owner
              ? 2
              : rawRendererSnapshot.annotation.activeRuntimeLaneLimit,
            activePolicyGeneration: owner
              ? 1
              : rawRendererSnapshot.annotation.activePolicyGeneration,
            activeSourceFingerprint:
              owner?.ownerKey?.split('\n')[1] ??
              rawRendererSnapshot.annotation.activeSourceFingerprint,
            activePlacementFingerprint: owner
              ? 'ap1:0123456789abcdef01234567'
              : rawRendererSnapshot.annotation.activePlacementFingerprint,
            prepackedSubmittedPartitionCount: owner?.submittedPartitionCount ?? 0,
            prepackedSubmittedInstanceCount: owner?.submittedInstanceCount ?? 0,
            prepackedSceneVisiblePartitionCount: owner?.submittedPartitionCount ?? 0,
            prepackedSceneVisibleInstanceCount: owner?.submittedInstanceCount ?? 0,
          },
        }
      : null;
    return rendererSnapshot
      ? identifiedSnapshot('exactly-one', rendererSnapshot)
      : identifiedSnapshot('unsupported', null);
  };
  state.ownerOracleOwner = {
    ownerKey,
    ownerGeneration: 7,
    loaded: true,
    status: 'eligible',
    gpuPrepared: true,
    metadata: {
      genomeLengthBp: GENOME_LENGTH,
      genomeIdentity: ANNOTATION_SOURCE_IDENTITY,
      artifactKey: ANNOTATION_ARTIFACT_KEY,
    },
    submittedPartitionCount: 0,
    submittedInstanceCount: 0,
  };
  state.__indexedGenomeViewerDebug = {
    instanceId: runGeneration,
    sessionId: 'genome-session-new-instance',
  };
  state.publishedFeed = null;
  state.__tileEnginePublishedFeedSnapshot = (trackId: string) =>
    trackId === TRACK_ID && state.publishedFeed ? { ...state.publishedFeed } : null;
  state.__webglStateSnapshot = () => ({
    instances: state.registry.map((instance: any) => {
      const model = state.__webglRenderer?.getCurrentPathMapper?.()?.model;
      return {
        ...instance,
        state: {
          ...(instance.state ?? {}),
          viewportRange:
            Number.isFinite(model?.viewStartBp) && Number.isFinite(model?.viewEndBp)
              ? [model.viewStartBp, model.viewEndBp]
              : null,
        },
        renderer: {
          rendererDebug: state.__webglRenderer?.getRendererDebugSnapshot?.() ?? null,
        },
      };
    }),
  });
  state.__webglPrepackedAnnotationSceneOwnerSnapshot = () => {
    const candidates = state.registry.filter(
      (instance: any) =>
        instance.visible === true &&
        instance.container?.connected === true &&
        instance.app?.alive === true
    );
    if (candidates.length !== 1) {
      return {
        verdict: candidates.length === 0 ? 'none' : 'ambiguous',
        instanceId: null,
        instanceCreatedAt: null,
        visibleLiveInstanceCount: candidates.length,
        candidateInstanceIds: candidates.map((instance: any) => instance.instanceId),
        owner: null,
      };
    }
    return {
      verdict: 'exactly-one',
      instanceId: candidates[0].instanceId,
      instanceCreatedAt: candidates[0].createdAt,
      visibleLiveInstanceCount: 1,
      candidateInstanceIds: [candidates[0].instanceId],
      owner: state.ownerOracleOwner,
    };
  };

  const closeAllTabs = vi.fn(() => {
    events.push('close');
    state.registry = [];
  });
  const applyPreset = vi.fn(async (presetId: string) => {
    events.push(`apply:${presetId}`);
    state.appliedPreset = presetId;
    state.__webglRenderer = renderer();
    state.__tileEngineDriver = { built: 5 };
    state.publishedFeed = {
      contract: 'tile-engine-published-feed-receipt.v1',
      trackId: TRACK_ID,
      publisherEpoch: 'tile-publisher-new-instance',
      sourceKey: 'hg002-element-80x-grch38',
      publicationSequence: 1,
      publishedAt: clock,
      currentRange: { start: 0, end: GENOME_LENGTH },
      feedViewRange: { start: 0, end: GENOME_LENGTH },
      coverageGpuAtlasAuthorityKey: PHYSICAL_GPU_ATLAS_DIAGNOSTIC.coverageGpuAtlasAuthorityKey,
      coverageGpuAtlasSourceIdentity: 'source',
      coverageGpuAtlasAssemblyFingerprint: 'assembly',
      coverageGpuAtlasStatistic: 'mean',
      coverageGpuAtlasPayloadRevision: 'revision',
      coverageGpuAtlasBaseBinSizeBp: 1024,
      coverageMemoMaterializeCount: 3,
      coverageMemoRevisionChangeCount: 1,
      exactCoverageRecordScanCount: 2,
      exactCoverageGeneration: 7,
    };
    state.__dna708PrepackedSceneReadiness = {
      runGeneration,
      status: 'loaded-hit',
      sceneKey: 'current-scene',
      sourceIdentity: ANNOTATION_SOURCE_IDENTITY,
      origin: 'hit',
      cacheState: 'hit',
      cacheOrigin: 'durable-hit',
      artifactKey: ANNOTATION_ARTIFACT_KEY,
      payloadBytes: 300_607_441,
      loadedAt: clock,
      writeCompletedAt: null,
      webglInstanceId: 'new-instance',
      webglInstanceCreatedAt: 2,
      ownerKey,
      ownerGeneration: 7,
      ownerLoaded: true,
      ownerGpuPrepared: true,
      layerDebug: {
        prepackedAnnotationSceneStatus: 'eligible',
        prepackedAnnotationSceneLoaded: true,
        prepackedAnnotationSceneLayerCreates: 1,
        prepackedAnnotationSceneLayerDestroys: 0,
      },
    };
    state.__dna708FullAssemblyInteractionReadiness = {
      runGeneration,
      ready: true,
      readyAt: clock,
      sceneKey: 'current-scene',
      coverageKey: 'current-coverage',
      coverageReason: 'ready',
      webglInstanceId: 'new-instance',
      webglInstanceCreatedAt: 2,
      ownerKey,
      ownerGeneration: 7,
    };
    state.registry = [
      {
        instanceId: 'new-instance',
        createdAt: 2,
        visible: true,
        frameCount: 1,
        container: { connected: true },
        app: { alive: true, canvasEl: {} },
        genome: { sourceIdentity: ANNOTATION_SOURCE_IDENTITY, length: GENOME_LENGTH },
        renderer: () => state.__webglRenderer,
      },
    ];
  });
  const runtime: ColdStartReloadBridgeRuntime = {
    target: state,
    closeAllTabs,
    applyPreset,
    mainIpcHeartbeat: vi.fn(async () => ({ sessionId: 'genome-session-new-instance' })),
    getAppliedPresetId: () => state.appliedPreset ?? null,
    now: () => clock,
    requestFrame: (callback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    setFailureTimeout: (callback) => {
      const id = ++timeoutId;
      timeouts.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearFailureTimeout: (id) => timeouts.delete(id as unknown as number),
    timeoutMs: 500,
  };
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const runFrame = async ({ advanceProductFrame = false } = {}) => {
    if (advanceProductFrame && state.registry[0]) state.registry[0].frameCount += 1;
    const pending = [...frames.entries()];
    frames.clear();
    clock += 16;
    for (const [, callback] of pending) callback(clock);
    await flush();
  };
  const failByTimeout = async () => {
    const pending = [...timeouts.values()];
    timeouts.clear();
    for (const callback of pending) callback();
    await flush();
  };
  const warmMainIpcHeartbeats = async () => {
    for (let index = 0; index < 10; index += 1) await runFrame();
  };
  const begin = (
    bridge = createDna708bColdStartReloadBridge(runtime),
    options: { requireDurableCacheHit?: boolean } = {}
  ) =>
    bridge.beginColdReload({
      genomeLength: GENOME_LENGTH,
      targetSpanBp: 150_000_000,
      variant: 'direct',
      requireInitialFullGenomeFrame: true,
      coherenceWarmupMs: 0,
      ...options,
    });
  return {
    state,
    oldRenderer,
    events,
    runtime,
    closeAllTabs,
    applyPreset,
    flush,
    runFrame,
    warmMainIpcHeartbeats,
    failByTimeout,
    begin,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe(' cold-start reload bridge', () => {
  it('records repeated successful Electron-main IPC heartbeats during cold admission', async () => {
    const h = harness();
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.runFrame();
    await h.runFrame();
    await h.runFrame();
    await h.runFrame();
    await h.runFrame();
    await h.runFrame();
    await h.runFrame();
    await h.runFrame({ advanceProductFrame: true });
    await h.runFrame();

    await expect(result).resolves.toMatchObject({
      initialMainIpcHeartbeatSessionId: 'genome-session-new-instance',
      initialMainIpcHeartbeatCount: 3,
      initialMainIpcHeartbeatMaxMs: 0,
      initialMainIpcHeartbeatLastMs: 0,
      initialMainIpcHeartbeatTimeoutCount: 0,
    });
    expect(h.runtime.mainIpcHeartbeat).toHaveBeenCalledTimes(3);
  });

  it('fails by name when Electron main does not answer a cold-admission IPC heartbeat', async () => {
    const h = harness();
    h.runtime.mainIpcHeartbeat = vi.fn(() => new Promise(() => {}));
    h.runtime.setMainIpcHeartbeatTimeout = (callback) => {
      queueMicrotask(callback);
      return 991 as unknown as ReturnType<typeof setTimeout>;
    };
    h.runtime.clearMainIpcHeartbeatTimeout = vi.fn();
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();

    await expect(result).rejects.toThrow(
      'dna708b-main-ipc-heartbeat-timeout:session=genome-session-new-instance:timeoutMs=250'
    );
  });

  it('keeps probing across the documented provisional-to-terminal hosted session upgrade', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__indexedGenomeViewerDebug.sessionId = 'genome-session-provisional';
      h.state.presentedSession = {
        sessionId: 'genome-session-provisional',
        openReady: true,
        annotationReadiness: 'pending',
        searchReadiness: 'pending',
        projectedAnnotationReadiness: 'ready',
        projectedSearchReadiness: 'ready',
      };
    };
    h.runtime.mainIpcHeartbeat = vi.fn(async (sessionId: string) => ({ sessionId }));

    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.warmMainIpcHeartbeats();
    expect(h.runtime.mainIpcHeartbeat).toHaveBeenCalledWith('genome-session-provisional');

    h.state.__indexedGenomeViewerDebug.sessionId = 'genome-session-terminal';
    h.state.presentedSession = {
      sessionId: 'genome-session-terminal',
      openReady: true,
      annotationReadiness: 'ready',
      searchReadiness: 'ready',
      projectedAnnotationReadiness: 'ready',
      projectedSearchReadiness: 'ready',
    };
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });

    await expect(result).resolves.toMatchObject({
      initialMainIpcHeartbeatSessionId: 'genome-session-terminal',
      initialMainIpcHeartbeatCount: 3,
      initialMainIpcHeartbeatTimeoutCount: 0,
    });
  });

  it('certifies annotation presentation while independent search admission remains pending', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.presentedSession.searchReadiness = 'pending';
      h.state.presentedSession.projectedSearchReadiness = 'pending';
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });

    await expect(result).resolves.toMatchObject({
      initialMainIpcHeartbeatSessionId: 'genome-session-new-instance',
      initialSearchReady: false,
    });
  });

  it('uses the live broad owner while detail and search capabilities admit independently', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.presentedSession.annotationReadiness = 'pending';
      h.state.presentedSession.searchReadiness = 'pending';
      h.state.presentedSession.projectedAnnotationReadiness = 'pending';
      h.state.presentedSession.projectedSearchReadiness = 'pending';
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });

    await expect(result).resolves.toMatchObject({
      initialAnnotationOwner: 'compiled-broad-raster-surface',
      initialAnnotationCapabilityReady: false,
      initialSearchReady: false,
    });
  });

  it('rebinds heartbeat evidence if search publication replaces a presentation-ready session', async () => {
    const h = harness();
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();

    h.state.__indexedGenomeViewerDebug.sessionId = 'genome-session-illegal-replacement';
    h.state.presentedSession = {
      sessionId: 'genome-session-illegal-replacement',
      openReady: true,
      annotationReadiness: 'ready',
      searchReadiness: 'ready',
      projectedAnnotationReadiness: 'ready',
      projectedSearchReadiness: 'ready',
    };
    await h.runFrame();
    await h.warmMainIpcHeartbeats();
    await h.runFrame();

    await expect(result).resolves.toMatchObject({
      initialMainIpcHeartbeatSessionId: 'genome-session-illegal-replacement',
      initialMainIpcHeartbeatCount: 3,
      initialSearchReady: true,
    });
  });

  it('provides production-shaped active snapshots before, during, and after reload', async () => {
    const h = harness();
    expect(h.state.__webglColdGestureSnapshot(TRACK_ID)).toMatchObject({
      contract: 'active-webgl-cold-gesture-snapshot.v1',
      verdict: 'exactly-one',
      requestedTrackId: TRACK_ID,
      instanceId: 'old-instance',
      registeredInstanceCount: 1,
      renderer: { contract: 'pixi-linear-renderer-cold-gesture-snapshot.v1' },
    });

    h.closeAllTabs();
    expect(h.state.__webglColdGestureSnapshot(TRACK_ID)).toEqual({
      contract: 'active-webgl-cold-gesture-snapshot.v1',
      verdict: 'none',
      requestedTrackId: TRACK_ID,
      instanceId: null,
      instanceCreatedAt: null,
      registeredInstanceCount: 0,
      frameCount: null,
      registryGenomeIdentity: null,
      registryGenomeLengthBp: null,
      renderer: null,
    });

    await h.applyPreset(PRESET);
    expect(h.state.__webglColdGestureSnapshot(TRACK_ID)).toMatchObject({
      contract: 'active-webgl-cold-gesture-snapshot.v1',
      verdict: 'exactly-one',
      requestedTrackId: TRACK_ID,
      instanceId: 'new-instance',
      registeredInstanceCount: 1,
      registryGenomeIdentity: ANNOTATION_SOURCE_IDENTITY,
      registryGenomeLengthBp: GENOME_LENGTH,
      renderer: { contract: 'pixi-linear-renderer-cold-gesture-snapshot.v1' },
    });
  });

  it('certifies the permanent GPU atlas resource graph without fabricating a legacy CPU density mesh', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__webglRenderer = renderer({
        coverageDiagnosticOverrides: PHYSICAL_GPU_ATLAS_DIAGNOSTIC,
      });
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });
    await expect(result).resolves.toMatchObject({ initialFrameSpanBp: GENOME_LENGTH });
  });

  it.each([
    ['uncompiled shader', { coverageGpuAtlasShaderProgramCompiled: false }],
    ['unbound texture', { coverageGpuAtlasShaderTextureResourceBound: false }],
    ['mismatched texture identity', { coverageGpuAtlasShaderTextureResourceUid: 42 }],
    ['malformed authority', { coverageGpuAtlasAuthorityKey: '["coverage-gpu-atlas.v1"]' }],
    ['wrong owner', { coverageGpuAtlasRenderOwner: 'legacy-density-mesh' }],
    ['wrong shader', { coverageGpuAtlasShaderProgramName: 'unrelated-fragment' }],
    ['duplicate source', { coverageGpuAtlasTextureResourceCreateCount: 2 }],
    ['missing GPU allocation', { coverageGpuAtlasGpuTextureResourceCreateCount: 0 }],
    ['duplicate upload', { coverageGpuAtlasGpuTextureUploadCount: 2 }],
    ['incomplete upload', { coverageGpuAtlasGpuTextureUploadComplete: false }],
    ['duplicate geometry', { coverageGpuAtlasGeometryBuildCount: 2 }],
    ['zero derived alpha', { renderedReadDensityAlpha: 0 }],
    ['non-finite derived alpha', { renderedReadDensityAlpha: Number.NaN }],
  ])('rejects a GPU atlas with %s', async (_name, atlasOverride) => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__webglRenderer = renderer({
        coverageDiagnosticOverrides: {
          ...PHYSICAL_GPU_ATLAS_DIAGNOSTIC,
          ...atlasOverride,
        },
      });
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('certifies an exact eligible raster owner while a fully presented viewer is idle', async () => {
    const h = harness();
    const resultPromise = h.begin();
    await h.flush();
    expect(h.events).toEqual(['close', `apply:${PRESET}`]);
    expect(h.applyPreset).toHaveBeenCalledWith(PRESET);

    await h.runFrame();
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });
    await h.flush();
    expect(resolved).toBe(false);

    await h.warmMainIpcHeartbeats();
    await h.runFrame();
    const lifecycle = await resultPromise;
    expect(lifecycle).toMatchObject({
      reloadGenerationBefore: 0,
      reloadGenerationAfter: 1,
      rendererGenerationBefore: 0,
      rendererGenerationAfter: 1,
      driverGenerationBefore: 4,
      driverGenerationAfter: 5,
      initialFrameSpanBp: GENOME_LENGTH,
      initialAnnotationOwner: 'compiled-broad-raster-surface',
      initialAnnotationOwnerCount: 1,
      initialAnnotationPackCount: 0,
      initialAnnotationBuildCount: 0,
      initialWebglInstanceId: 'new-instance',
      initialAnnotationCacheStatus: 'loaded-hit',
      initialAnnotationCacheOrigin: 'hit',
      initialAnnotationCacheState: 'hit',
      initialAnnotationCacheLifecycleOrigin: 'durable-hit',
      initialAnnotationSourceIdentity: ANNOTATION_SOURCE_IDENTITY,
      initialAnnotationArtifactKey: ANNOTATION_ARTIFACT_KEY,
      initialAnnotationArtifactPayloadBytes: 300_607_441,
      initialRendererGeneration: 2,
      initialRendererOperationEpoch: 12,
      initialRendererContentOperationEpoch: 3,
      initialRendererCompletedFrameEpoch: 9,
      initialRendererPresentedFrameEpoch: 9,
      initialRendererPresentedContentOperationEpoch: 3,
      initialRendererLoadGenomeCount: 1,
      initialRendererAnnotationSnapshotAttemptCount: 1,
      initialRendererAnnotationSnapshotApplyCount: 1,
      initialRendererPrepackedLoadCount: 1,
      initialRendererPrepackedPrepareCount: 1,
      initialRendererPrepackedActivateCount: 1,
      initialRendererPrepackedPolicyUpdateCount: 0,
      initialRendererPrepackedRetireCount: 0,
      initialRendererContentChangedFrameCount: 1,
      initialRendererCameraOnlyFrameCount: 8,
      initialAnnotationRequestedLayerM_RNAOnly: true,
      initialAnnotationMetadataTrackType: 'mRNA',
      initialAnnotationRuntimeIsoformMode: 'canonical',
      initialAnnotationRuntimeLaneLimit: 2,
      initialAnnotationPolicyGeneration: 1,
      initialAnnotationSceneFingerprint: '0123456789abcdef01234567',
      initialAnnotationSourceFingerprint: '0123456789abcdef01234567',
      initialAnnotationPlacementFingerprint: 'ap1:0123456789abcdef01234567',
      initialAnnotationRasterArtifactKey: ANNOTATION_ARTIFACT_KEY,
      initialCoverageProof: 'gpu-atlas-resource-submitted',
      initialCoverageOwner: 'coverage-gpu-atlas-fill',
      initialCoverageAuthorityKey:
        '["coverage-gpu-atlas.v1","source","assembly","mean","revision"]',
      initialCoverageShaderProgramName: 'coverage-gpu-atlas-fill-fragment',
      initialCoverageShaderProgramKey: 9001,
      initialCoverageShaderProgramCompiled: true,
      initialCoverageShaderProgramLinked: true,
      initialCoverageShaderTextureResourceBound: true,
      initialCoverageTextureResourceUid: 41,
      initialCoverageShaderTextureResourceUid: 41,
      initialCoverageTextureResourceCreateCount: 1,
      initialCoverageGpuTextureResourceCreateCount: 1,
      initialCoverageGpuTextureUploadCount: 1,
      initialCoverageGpuTextureUploadComplete: true,
      initialCoverageGeometryBuildCount: 1,
      initialCoverageCameraUniformUpdateCount: 1,
      initialCoverageBaseBinSizeBp: 1024,
      initialCoveragePublisherEpoch: 'tile-publisher-new-instance',
      initialCoveragePublisherSourceKey: 'hg002-element-80x-grch38',
      initialCoveragePublicationSequence: 1,
      initialCoveragePublishedAt: 100,
      initialCoverageMemoMaterializeCount: 3,
      initialCoverageMemoRevisionChangeCount: 1,
      initialExactCoverageRecordScanCount: 2,
      initialExactCoverageGeneration: 7,
      initialLegacyCoverageSamplePassCount: 0,
      initialLegacyCoverageGeometryBuildCount: 0,
      initialLegacyCoverageBufferUploadCount: 0,
    });
    expect(lifecycle.rendererReadyAt).toBeGreaterThanOrEqual(lifecycle.reloadRequestedAt);
    expect(lifecycle.driverReadyAt).toBeGreaterThanOrEqual(lifecycle.reloadRequestedAt);
    expect(lifecycle.initialFullGenomeFrameAt).toBeGreaterThanOrEqual(
      Math.max(lifecycle.rendererReadyAt, lifecycle.driverReadyAt)
    );
    expect(lifecycle.initialFullGenomeFrameAt).toBeGreaterThan(lifecycle.sceneReadyAt);
  });

  it.each([
    ['content changed after presentation', { presentedContentOperationEpoch: 2 }],
    ['latest renderer frame did not reach Pixi', { presentedFrameEpoch: 8 }],
  ])('rejects a stale presentation receipt when %s', async (_name, presentationOverride) => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__webglRenderer = renderer(presentationOverride);
    };

    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('certifies the current compiled raster plus prepare-only resident roster without a singular active owner', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    const preparedOwnerKey = h.state.ownerOracleOwner.ownerKey;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.ownerOracleOwner = null;
      delete h.state.__dna708PrepackedSceneReadiness;
      delete h.state.__dna708FullAssemblyInteractionReadiness;
      h.state.__webglRenderer = renderer({
        compiledResidentOwnerKey: preparedOwnerKey,
        compiledResidentArtifactKey: ANNOTATION_ARTIFACT_KEY,
        compiledResidentRosterGeneration: 1,
      });
      h.state.__indexedGenomeViewerDebug = {
        instanceId: 'new-viewer-generation',
        sessionId: 'genome-session-new-instance',
        compiledAnnotationResidentReadiness: {
          contract: 'compiled-annotation-resident-readiness.v1',
          readinessScopeKey: 'current-compiled-roster',
          selectedTrackTypes: ['mRNA'],
          selectedSetPrepared: false,
          selectedBroadSetInteractive: true,
          tracks: [
            {
              trackType: 'mRNA',
              readiness: 'ready',
              targetIdentityKey: 'current-raster',
              readinessTargetIdentityKey: 'current-raster',
              readinessRendererMatchesCurrent: true,
              interactionReadiness: 'loading-hit',
              interactionOwnerKey: preparedOwnerKey,
              ownerReadinessScopeKey: 'current-compiled-roster',
              interactionCacheStatus: 'not-applicable',
              interactionPayloadBytes: null,
              compactInteractionStatus: 'loaded',
              compactInteractionOwnerKey: preparedOwnerKey,
              compactInteractionCompletedAt: 100,
              compactInteractionOrigin: 'durable-hit',
              compactInteractionPayloadBytes: 44_524_498,
              compactInteractionAuthorityPresent: true,
              compactInteractionGenomeLengthBp: GENOME_LENGTH,
            },
          ],
        },
      };
    };

    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime), {
      requireDurableCacheHit: true,
    });
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });
    await expect(result).resolves.toMatchObject({
      initialAnnotationOwner: 'compiled-broad-raster-surface',
      initialAnnotationOwnerKey: preparedOwnerKey,
      initialAnnotationOwnerGeneration: 1,
      initialAnnotationCacheLifecycleOrigin: 'durable-hit',
    });
  });

  it('rejects a compiled resident receipt whose owner does not match visible raster provenance', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    const preparedOwnerKey = h.state.ownerOracleOwner.ownerKey;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.ownerOracleOwner = null;
      h.state.__webglRenderer = renderer({
        compiledResidentOwnerKey: preparedOwnerKey,
        compiledResidentArtifactKey: ANNOTATION_ARTIFACT_KEY,
        compiledResidentRosterGeneration: 1,
      });
      h.state.__indexedGenomeViewerDebug = {
        instanceId: 'new-viewer-generation',
        compiledAnnotationResidentReadiness: {
          contract: 'compiled-annotation-resident-readiness.v1',
          readinessScopeKey: 'current-compiled-roster',
          selectedTrackTypes: ['mRNA'],
          selectedSetPrepared: false,
          selectedBroadSetInteractive: true,
          tracks: [
            {
              trackType: 'mRNA',
              readiness: 'ready',
              targetIdentityKey: 'current-raster',
              readinessTargetIdentityKey: 'current-raster',
              readinessRendererMatchesCurrent: true,
              interactionReadiness: 'loading-hit',
              interactionOwnerKey: 'wrong-owner',
              ownerReadinessScopeKey: 'current-compiled-roster',
              interactionCacheStatus: 'not-applicable',
              interactionPayloadBytes: null,
              compactInteractionStatus: 'loaded',
              compactInteractionOwnerKey: 'wrong-owner',
              compactInteractionCompletedAt: 100,
              compactInteractionOrigin: 'durable-hit',
              compactInteractionPayloadBytes: 44_524_498,
              compactInteractionAuthorityPresent: true,
              compactInteractionGenomeLengthBp: GENOME_LENGTH,
            },
          ],
        },
      };
    };

    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it.each([
    ['missing oracle', (state: any) => delete state.__tileEnginePublishedFeedSnapshot],
    ['missing receipt', (state: any) => (state.publishedFeed = null)],
    ['wrong track', (state: any) => (state.publishedFeed.trackId = 'other-track')],
    ['stale publication', (state: any) => (state.publishedFeed.publishedAt = 99)],
    ['missing publisher epoch', (state: any) => (state.publishedFeed.publisherEpoch = '')],
    ['missing source key', (state: any) => (state.publishedFeed.sourceKey = '')],
    [
      'mismatched atlas authority',
      (state: any) =>
        (state.publishedFeed.coverageGpuAtlasAuthorityKey =
          '["coverage-gpu-atlas.v1","other","assembly","mean","revision"]'),
    ],
    [
      'mismatched atlas source',
      (state: any) => (state.publishedFeed.coverageGpuAtlasSourceIdentity = 'other'),
    ],
    [
      'mismatched atlas base bin',
      (state: any) => (state.publishedFeed.coverageGpuAtlasBaseBinSizeBp = 2048),
    ],
    [
      'missing memo materialization baseline',
      (state: any) => (state.publishedFeed.coverageMemoMaterializeCount = null),
    ],
    [
      'missing memo revision baseline',
      (state: any) => (state.publishedFeed.coverageMemoRevisionChangeCount = null),
    ],
    [
      'missing exact scan baseline',
      (state: any) => (state.publishedFeed.exactCoverageRecordScanCount = null),
    ],
    [
      'missing exact generation baseline',
      (state: any) => (state.publishedFeed.exactCoverageGeneration = null),
    ],
  ])('does not certify a %s published-feed receipt', async (_name, mutate) => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      mutate(h.state);
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it.each([
    [
      'memo materialization baseline',
      (state: any) => (state.publishedFeed.coverageMemoMaterializeCount += 1),
    ],
    [
      'memo revision baseline',
      (state: any) => (state.publishedFeed.coverageMemoRevisionChangeCount += 1),
    ],
    [
      'exact scan baseline',
      (state: any) => (state.publishedFeed.exactCoverageRecordScanCount += 1),
    ],
    [
      'exact generation baseline',
      (state: any) => (state.publishedFeed.exactCoverageGeneration += 1),
    ],
    ['publisher epoch', (state: any) => (state.publishedFeed.publisherEpoch = 'replacement')],
    ['publisher source', (state: any) => (state.publishedFeed.sourceKey = 'replacement')],
  ])('requires one unchanged %s across consecutive qualified frames', async (_name, mutate) => {
    const h = harness();
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    mutate(h.state);
    await h.runFrame({ advanceProductFrame: true });
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it.each([
    [
      'open annotation source identity',
      (state: any) => {
        state.ownerOracleOwner.metadata.genomeIdentity = 'current-full-assembly';
        state.__dna708PrepackedSceneReadiness.sourceIdentity = 'current-full-assembly';
      },
    ],
    [
      'owner/readiness source mismatch',
      (state: any) => {
        state.ownerOracleOwner.metadata.genomeIdentity = `assembly-annotation-source-sha256.v1:${'d'.repeat(64)}`;
      },
    ],
    [
      'owner-key/readiness artifact mismatch',
      (state: any) => {
        state.__dna708PrepackedSceneReadiness.artifactKey = 'other-artifact';
      },
    ],
    [
      'owner-key/live-metadata artifact mismatch',
      (state: any) => {
        state.ownerOracleOwner.metadata.artifactKey = 'other-artifact';
      },
    ],
  ])('does not certify an %s', async (_name, mutate) => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      mutate(h.state);
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('certifies a validated prepacked vector owner when the resident raster is semantically ineligible', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__webglRenderer = renderer({
        owners: ['prepacked-partitioned-vector-surface'],
        rasterVisible: false,
        rasterEligible: false,
        rasterContractMatch: false,
        prepackedSubmittedPartitionCount: 24,
        prepackedSubmittedInstanceCount: 18_959,
      });
      Object.assign(h.state.ownerOracleOwner, {
        submittedPartitionCount: 24,
        submittedInstanceCount: 18_959,
      });
    };

    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });
    await expect(result).resolves.toMatchObject({
      initialAnnotationOwner: 'prepacked-partitioned-vector-surface',
      initialAnnotationOwnerCount: 1,
      initialAnnotationPackCount: 0,
      initialAnnotationBuildCount: 0,
    });
  });

  it('rejects a visible raster that lacks exact semantic eligibility', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__webglRenderer = renderer({
        rasterVisible: true,
        rasterEligible: false,
        rasterContractMatch: false,
      });
    };

    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('does not fabricate vector ownership from presentation debug without independent submissions', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__webglRenderer = renderer({
        owners: ['prepacked-partitioned-vector-surface'],
        rasterVisible: false,
        rasterEligible: false,
        rasterContractMatch: false,
        prepackedSubmittedPartitionCount: 24,
        prepackedSubmittedInstanceCount: 18_959,
      });
    };

    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('clears only renderer-process warm caches before closing the old tab', async () => {
    const h = harness();
    h.runtime.resetColdCaches = vi.fn(async () => {
      h.events.push('reset-cold-caches');
    });
    const resultPromise = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.flush();
    expect(h.events).toEqual(['reset-cold-caches', 'close', `apply:${PRESET}`]);
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });
    await resultPromise;
  });

  it('rejects a concurrent cold reload', async () => {
    const h = harness();
    const bridge = createDna708bColdStartReloadBridge(h.runtime);
    const first = h.begin(bridge);
    await expect(h.begin(bridge)).rejects.toThrow('already-running');
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });
    await first;
  });

  it('ignores a stale renderer global and times out with no lifecycle evidence', async () => {
    const h = harness();
    h.runtime.applyPreset = vi.fn(async () => {
      h.state.appliedPreset = PRESET;
      h.state.__tileEngineDriver = { built: 5 };
      h.state.registry = [
        {
          instanceId: 'new-instance',
          createdAt: 2,
          visible: true,
          frameCount: 2,
          container: { connected: true },
          app: { alive: true, canvasEl: {} },
          genome: { length: GENOME_LENGTH },
        },
      ];
    });
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('bounds a stuck old-viewer teardown and returns no lifecycle evidence', async () => {
    const h = harness();
    h.runtime.closeAllTabs = vi.fn();
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('reset-timeout');
    expect(h.applyPreset).not.toHaveBeenCalled();
  });

  it('requires the native tile-engine driver construction counter to advance', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__tileEngineDriver = { built: 4 };
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it.each([
    ['partial genome', () => ({ genome: { length: 150_000_000 } })],
    ['disconnected registry instance', () => ({ container: { connected: false } })],
    ['unpresented registry instance', () => ({ frameCount: 0 })],
  ])('does not certify a %s', async (_name, mutate) => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      Object.assign(h.state.registry[0], mutate());
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it.each([
    ['not full viewport', renderer({ start: 100_000_000, end: 250_000_000 })],
    ['blank coverage', renderer({ present: false })],
    ['missing annotation owner', renderer({ owners: [] })],
    ['multiple annotation owners', renderer({ owners: ['a', 'b'] })],
    ['missing pack counter', renderer({ packCount: null })],
    ['missing build counter', renderer({ buildCount: null })],
  ])('does not certify %s', async (_name, replacementRenderer) => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__webglRenderer = replacementRenderer;
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it.each([
    ['missing scene readiness', null],
    [
      'raster-only readiness',
      {
        status: 'loaded-hit',
        sourceIdentity: ANNOTATION_SOURCE_IDENTITY,
        origin: 'hit',
        cacheState: 'hit',
        loadedAt: 100,
        layerDebug: {
          prepackedAnnotationSceneStatus: 'not-loaded',
          prepackedAnnotationSceneLoaded: false,
          prepackedAnnotationSceneLayerCreates: 0,
          prepackedAnnotationSceneLayerDestroys: 0,
        },
      },
    ],
    [
      'stale pre-reload readiness',
      {
        status: 'loaded-hit',
        sourceIdentity: ANNOTATION_SOURCE_IDENTITY,
        origin: 'hit',
        cacheState: 'hit',
        loadedAt: 99,
        layerDebug: {
          prepackedAnnotationSceneStatus: 'eligible',
          prepackedAnnotationSceneLoaded: true,
          prepackedAnnotationSceneLayerCreates: 1,
          prepackedAnnotationSceneLayerDestroys: 0,
        },
      },
    ],
    [
      'destroyed and recreated scene',
      {
        status: 'loaded-hit',
        sourceIdentity: ANNOTATION_SOURCE_IDENTITY,
        origin: 'hit',
        cacheState: 'hit',
        loadedAt: 100,
        layerDebug: {
          prepackedAnnotationSceneStatus: 'eligible',
          prepackedAnnotationSceneLoaded: true,
          prepackedAnnotationSceneLayerCreates: 2,
          prepackedAnnotationSceneLayerDestroys: 1,
        },
      },
    ],
  ])('does not certify %s', async (_name, readiness) => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__dna708PrepackedSceneReadiness = readiness;
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('does not certify before the production interaction barrier commits', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__dna708FullAssemblyInteractionReadiness = {
        ready: false,
        readyAt: null,
        sceneKey: 'current-scene',
        coverageKey: 'current-coverage',
        coverageReason: 'coverage-not-ready',
      };
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('certifies the production interaction barrier without obsolete whole-corridor coverage readiness', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__dna708FullAssemblyInteractionReadiness = {
        ...h.state.__dna708FullAssemblyInteractionReadiness,
        ready: true,
        coverageReason: 'coverage-not-ready',
      };
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });
    await expect(result).resolves.toMatchObject({
      initialAnnotationOwner: 'compiled-broad-raster-surface',
      initialAnnotationOwnerCount: 1,
    });
  });

  it('certifies the same-instance renderer viewport when the optional host viewportRange is null', async () => {
    const h = harness();
    const snapshot = h.state.__webglStateSnapshot;
    h.state.__webglStateSnapshot = () => {
      const value = snapshot();
      for (const instance of value.instances) instance.state.viewportRange = null;
      return value;
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });
    await expect(result).resolves.toMatchObject({ initialFrameSpanBp: GENOME_LENGTH });
  });

  it('rejects a non-full same-instance renderer viewport when host viewportRange is null', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__webglRenderer = renderer({ start: 100_000_000, end: 250_000_000 });
    };
    const snapshot = h.state.__webglStateSnapshot;
    h.state.__webglStateSnapshot = () => {
      const value = snapshot();
      for (const instance of value.instances) instance.state.viewportRange = null;
      return value;
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('does not certify stale same-policy readiness from an old viewer generation', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__dna708PrepackedSceneReadiness.runGeneration = 'old-viewer-generation';
      h.state.__dna708FullAssemblyInteractionReadiness.runGeneration = 'old-viewer-generation';
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('requires one unchanged live owner epoch across consecutive product frames', async () => {
    const h = harness();
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();

    const replacementOwnerKey = [
      'annotation-scene-owner.v3',
      'fedcba9876543210fedcba98',
      'c'.repeat(64),
      ANNOTATION_ARTIFACT_KEY,
    ].join('\n');
    h.state.ownerOracleOwner = {
      ...h.state.ownerOracleOwner,
      ownerKey: replacementOwnerKey,
      ownerGeneration: 8,
    };
    Object.assign(h.state.__dna708PrepackedSceneReadiness, {
      ownerKey: replacementOwnerKey,
      ownerGeneration: 8,
    });
    Object.assign(h.state.__dna708FullAssemblyInteractionReadiness, {
      ownerKey: replacementOwnerKey,
      ownerGeneration: 8,
    });

    await h.runFrame({ advanceProductFrame: true });
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('accepts a persisted build only after the cache write completes', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__dna708PrepackedSceneReadiness = {
        ...h.state.__dna708PrepackedSceneReadiness,
        status: 'loaded-built',
        sceneKey: 'current-scene',
        sourceIdentity: ANNOTATION_SOURCE_IDENTITY,
        origin: 'built',
        cacheState: 'miss',
        cacheOrigin: 'prepared-after-miss',
        artifactKey: ANNOTATION_ARTIFACT_KEY,
        payloadBytes: 300_607_441,
        loadedAt: 100,
        writeCompletedAt: 100,
        layerDebug: {
          prepackedAnnotationSceneStatus: 'eligible',
          prepackedAnnotationSceneLoaded: true,
          prepackedAnnotationSceneLayerCreates: 1,
          prepackedAnnotationSceneLayerDestroys: 0,
        },
      };
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.flush();
    await h.warmMainIpcHeartbeats();
    await h.runFrame({ advanceProductFrame: true });
    await expect(result).resolves.toMatchObject({
      initialAnnotationOwner: 'compiled-broad-raster-surface',
      initialAnnotationPackCount: 0,
      initialAnnotationBuildCount: 0,
    });
  });

  it('rejects a viewer-open build when the caller requires a durable cache hit', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__dna708PrepackedSceneReadiness = {
        ...h.state.__dna708PrepackedSceneReadiness,
        status: 'loaded-built',
        origin: 'built',
        cacheState: 'miss',
        cacheOrigin: 'prepared-after-miss',
        loadedAt: 100,
        writeCompletedAt: 100,
      };
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime), {
      requireDurableCacheHit: true,
    });
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('rejects a coherent legacy CPU density mesh at the full-genome atlas span', async () => {
    const h = harness();
    h.state.__tileEngineDebug = () => ({
      [TRACK_ID]: {
        coverageCorridorFloor: {
          state: 'error',
          failureReason: 'loader-rejected:Error:response contract header mismatch',
        },
      },
    });
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.__webglRenderer = renderer({
        coverageDiagnosticOverrides: {
          coverageGpuAtlasActive: false,
          densityRowsMeshVisible: true,
          coverageSignalNonzeroBinCount: 10,
          coverageLodLevel: 20,
          coverageLodTargetLevel: 20,
        },
      });
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow(
      'readiness-timeout:coverage-atlas-inactive:trackType=pileup-genomewide:legacyMesh=true:legacyLod=20' +
        ':corridorFloorState=error' +
        ':corridorFloorFailure=loader-rejected:Error:response_contract_header_mismatch'
    );
  });

  it('requires one unchanged atlas authority, program, and texture across consecutive frames', async () => {
    const h = harness();
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    h.state.__webglRenderer = renderer({
      coverageDiagnosticOverrides: {
        coverageGpuAtlasTextureResourceUid: 42,
        coverageGpuAtlasShaderTextureResourceUid: 42,
      },
    });
    await h.runFrame({ advanceProductFrame: true });
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('requires a genuine new registry instance even if renderer and driver changed', async () => {
    const h = harness();
    const apply = h.runtime.applyPreset;
    h.runtime.applyPreset = async (presetId) => {
      await apply(presetId);
      h.state.registry[0].instanceId = 'old-instance';
    };
    const result = h.begin(createDna708bColdStartReloadBridge(h.runtime));
    await h.flush();
    await h.runFrame();
    await h.failByTimeout();
    await expect(result).rejects.toThrow('readiness-timeout');
  });

  it('installs one stable bridge object that survives tab teardown', () => {
    const h = harness();
    const first = installDna708bColdStartReloadBridge(h.runtime);
    h.closeAllTabs();
    const second = installDna708bColdStartReloadBridge(h.runtime);
    expect(second).toBe(first);
    expect(h.state.__dna708ColdStartReloadBridge).toBe(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      recordsReloadGeneration: true,
      recordsRendererGeneration: true,
      recordsDriverGeneration: true,
      recordsReadinessTimestamps: true,
      recordsMainIpcResponsiveness: true,
      recordsCoverageAtlasResourceSubmission: true,
      recordsQualifiedCoverageBaselines: true,
    });
  });

  it('replaces a same-schema bridge that predates qualified coverage baselines', () => {
    const h = harness();
    const stale = {
      schemaVersion: 1,
      recordsReloadGeneration: true,
      recordsRendererGeneration: true,
      recordsDriverGeneration: true,
      recordsReadinessTimestamps: true,
      recordsCoverageAtlasResourceSubmission: true,
      beginColdReload: vi.fn(),
    };
    h.state.__dna708ColdStartReloadBridge = stale;
    const installed = installDna708bColdStartReloadBridge(h.runtime);
    expect(installed).not.toBe(stale);
    expect(installed.recordsCoverageAtlasResourceSubmission).toBe(true);
    expect(installed.recordsQualifiedCoverageBaselines).toBe(true);
  });

  it('rejects contracts that permit warming or do not demand the initial full-genome frame', async () => {
    const h = harness();
    const bridge = createDna708bColdStartReloadBridge(h.runtime);
    await expect(
      bridge.beginColdReload({
        genomeLength: GENOME_LENGTH,
        requireInitialFullGenomeFrame: false,
        coherenceWarmupMs: 20_000,
      })
    ).rejects.toThrow('contract-invalid');
    expect(h.closeAllTabs).not.toHaveBeenCalled();
  });

  it('contains no page reload, direct viewport write, fixed sleep, or old readiness helper', () => {
    const source = readFileSync(
      `${process.cwd()}/src/test/cold-start-reload-bridge.ts`,
      'utf8'
    );
    expect(source).not.toMatch(
      /location[.]reload|Page[.]reload|setViewport|waitCoverageReady|\bsleep\s*\(/
    );
    expect(source).not.toMatch(/(?:sleep|warm|settle)[^\n]{0,80}20_000/i);
    expect(source).toContain('requestFrame(poll)');
  });

  it('is installed only inside the existing App DEV/test exposure boundary', () => {
    const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8');
    const normalizedSource = source.replace(/\s+/g, ' ');
    const devBoundary = normalizedSource.indexOf(
      "if ( (import.meta.env.DEV === true || import.meta.env.MODE === 'test') && import.meta.env.MODE !== 'hosted' && getDevTestWindow() )"
    );
    const installer = normalizedSource.indexOf('installDna708bColdStartReloadBridge');
    expect(devBoundary).toBeGreaterThanOrEqual(0);
    expect(installer).toBeGreaterThan(devBoundary);
    expect(normalizedSource.slice(devBoundary, installer)).toContain(
      "import('./test/scenarios/apply-dev')"
    );
    expect(normalizedSource.slice(installer, installer + 1_600)).toContain(
      'mod.applyDevScenarioPreset'
    );
  });
});
