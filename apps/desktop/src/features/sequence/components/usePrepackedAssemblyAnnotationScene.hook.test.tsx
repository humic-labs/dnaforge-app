import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  prepackedAnnotationSceneArtifactKey,
  type PrepackedAnnotationSceneLoadInput,
} from '@waypoint/genome-renderer';
import {
  buildPartitionedTranscriptScene,
  buildPrepackedAnnotationInteractionIndexV2,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/pure';
import { ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT } from '../../../shared/indexed-genome';

const write = vi.fn(async () => ({
  fingerprint: 'b'.repeat(24),
  byteCount: 1,
  scenePath: 'scene',
  manifestPath: 'manifest',
}));

vi.mock('../../../platform', () => ({
  platform: () => ({ genome: { writeAssemblyAnnotationScene: write } }),
}));

import type {
  AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt,
  AssemblyPrepackedAnnotationSceneDescriptor,
} from './useAssemblyPrepackedAnnotationSceneCache';
import {
  resetPrepackedAssemblyAnnotationSceneTasksForTest,
  scopedPrepackedAssemblyAnnotationSceneReadiness,
  usePrepackedAssemblyAnnotationScene,
} from './usePrepackedAssemblyAnnotationScene';

describe('scopedPrepackedAssemblyAnnotationSceneReadiness', () => {
  it('cannot carry a loaded receipt into a new source, theme, or renderer scope', () => {
    const staleLoadedReceipt = {
      requestId: null,
      readinessScopeKey: 'source-a:light:renderer-1',
      status: 'loaded-hit' as const,
    };

    expect(
      scopedPrepackedAssemblyAnnotationSceneReadiness({
        state: staleLoadedReceipt,
        currentRequestId: null,
        currentReadinessScopeKey: 'source-b:dark:renderer-2',
      })
    ).toBe('loading-hit');
    expect(
      scopedPrepackedAssemblyAnnotationSceneReadiness({
        state: staleLoadedReceipt,
        currentRequestId: null,
        currentReadinessScopeKey: staleLoadedReceipt.readinessScopeKey,
      })
    ).toBe('loaded-hit');
  });
});

const artifact = {
  artifactKey: prepackedAnnotationSceneArtifactKey({ themeMode: 'light', trackType: 'mRNA' }),
  themeMode: 'light' as const,
  trackType: 'mRNA',
  partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  annotationBarHeightPx: 14,
  laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
  mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
  geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
};
const legacySceneVariant = {
  ...artifact,
  sceneVariantKey: artifact.artifactKey,
  isoformMode: 'canonical' as const,
  laneLimit: 12,
};

const descriptor: AssemblyPrepackedAnnotationSceneDescriptor = {
  sourceIdentity: 'expected-source',
  placementFingerprint: `ap1:${'b'.repeat(24)}`,
  datasetContract: {
    datasetId: 'dataset',
    datasetVersion: 'version',
    sourceSha256: 'b'.repeat(64),
  },
  artifact,
  sceneVariant: legacySceneVariant,
  runtimeCacheKey: 'runtime-mismatch-then-ready',
  sceneKey: 'mismatch-then-ready',
  request: {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'grch38',
    workspaceRoot: '/workspace',
    chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 1000 }],
    scope: {
      kind: 'viewport-subset',
      placements: [{ chrom: 'chr1', length: 1000, annotationCoverage: 'sourced' }],
    },
    datasetContract: {
      datasetId: 'dataset',
      datasetVersion: 'version',
      sourceSha256: 'b'.repeat(64),
    },
    artifact,
    sceneVariant: legacySceneVariant,
    requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
  },
};

const built: PrepackedAnnotationSceneLoadInput = {
  ownerKey: 'test-owner\nfixture',
  metadata: {
    genomeIdentity: descriptor.sourceIdentity,
    genomeLengthBp: 1000,
    partitionSpanBp: 100_000_000,
    artifactKey: descriptor.artifact.artifactKey,
    themeMode: 'light',
    trackType: 'mRNA',
    annotationBarHeightPx: 14,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  },
  scene: {
    primitives: [
      {
        startBp: 1,
        endBp: 2,
        featureIndex: 0,
        offsetCenter: -7,
        halfH: 7,
        color: 0x123456,
        alpha: 1,
        cdsFade: 0,
        dirSign: 0,
      },
    ],
    featureFamilyIndices: new Uint32Array([0]),
    families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
  },
  interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
    [
      {
        rendererId: 0,
        startBp: 1,
        endBp: 2,
        lane: 0,
        direction: 'none',
        displayName: 'fixture transcript',
        type: 'mRNA',
        transcriptId: 'tx-fixture',
        sourceId: 'source-fixture',
        canonicalIdentity: 'canonical-fixture',
      },
    ],
    [{ featureIndex: 0 }]
  ),
};
built.gpuReadyScene = buildPartitionedTranscriptScene(
  built.scene.primitives,
  built.metadata.partitionSpanBp
);
const policyProjection = {
  features: [
    {
      annotationType: 'mRNA',
      expandedLane: 0,
      expandedTrackLane: 0,
      canonicalLane: 0,
      canonicalTrackLane: 0,
    },
  ],
  expandedBandOrder: ['mRNA'],
  canonicalBandOrder: ['mRNA'],
};

const missResult = {
  status: 'miss' as const,
  ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  fingerprint: 'b'.repeat(24),
  sourceBuildFingerprint: 'source-build-fingerprint',
};

const durableHitLifecycle: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt = {
  currentPhase: 'complete',
  origin: 'durable-hit',
  initialProbe: 'hit',
  terminalResult: 'hit',
  preparationAttempts: 0,
  startedAt: 1,
  preparationReadyObservedAt: null,
  completedAt: 2,
  history: [],
};

const missLifecycle: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt = {
  ...durableHitLifecycle,
  origin: 'miss',
  initialProbe: 'miss',
  terminalResult: 'miss',
};

const errorLifecycle: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt = {
  ...durableHitLifecycle,
  currentPhase: 'error',
  origin: 'error',
  initialProbe: 'empty',
  terminalResult: 'error',
};

describe('usePrepackedAssemblyAnnotationScene renderer ordering', () => {
  beforeEach(() => {
    resetPrepackedAssemblyAnnotationSceneTasksForTest();
    write.mockClear();
  });

  it('publishes MISS-then-prepared provenance as built instead of erasing it with the terminal HIT', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: descriptor.datasetContract,
      assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 1000 },
      families: built.scene.families,
      featureFamilyIndices: built.scene.featureFamilyIndices,
      scene: built.gpuReadyScene!,
      interactionIndex: built.interactionIndex!,
      policyProjection,
    });
    const builtLifecycle: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt = {
      currentPhase: 'complete',
      origin: 'prepared-after-miss',
      initialProbe: 'miss',
      terminalResult: 'hit',
      preparationAttempts: 1,
      startedAt: 1,
      preparationReadyObservedAt: 3,
      completedAt: 4,
      history: [
        { phase: 'probe-result-received', probe: 'initial', outcome: 'miss', at: 2 },
        { phase: 'prepare-result-received', attempt: 1, outcome: 'ready', at: 3 },
        { phase: 'probe-result-received', probe: 'reprobe', outcome: 'hit', at: 4 },
      ],
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: {
        status: 'hit' as const,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'build',
        scope: descriptor.request.scope,
        artifact: descriptor.artifact,
        byteCount: packed.payload.byteLength,
        manifest: packed.manifest,
        payload: packed.payload,
      },
      error: null,
      lifecycle: builtLifecycle,
    };
    let activeInput: PrepackedAnnotationSceneLoadInput | null = null;
    const renderer = {
      getCurrentPathMapper: () => ({}),
      getRendererDebugSnapshot: () => {
        throw new Error('scene reconciliation must not materialize forensic renderer state');
      },
      loadPrepackedAnnotationScene: vi.fn((value: PrepackedAnnotationSceneLoadInput) => {
        activeInput = value;
        return true;
      }),
      getPrepackedAnnotationSceneOwnerSnapshot: () => ({
        ownerKey: activeInput?.ownerKey ?? null,
        ownerGeneration: activeInput ? 1 : 0,
        loaded: activeInput !== null,
        status: activeInput ? 'eligible' : 'not-loaded',
        gpuPrepared: activeInput !== null,
        metadata: activeInput?.metadata ?? null,
        runtimePolicy: activeInput?.runtimePolicy ?? null,
      }),
    };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { result } = renderHook(() =>
      usePrepackedAssemblyAnnotationScene({
        cache,
        overviewFeaturesComplete: false,
        effectiveLayerTypes: ['mRNA'],
        requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
        readinessGeneration: 'built-provenance',
        readinessScopeKey: 'built-provenance-scope',
        webglRef: { current: { getLinearRenderer: () => renderer as never } },
      })
    );
    await waitFor(() => expect(frames).toHaveLength(1));
    await act(async () => frames.shift()!(performance.now()));
    await waitFor(() => expect(result.current).toBe('loaded-hit'));

    const readiness = (
      window as unknown as {
        __dna708PrepackedSceneReadiness?: Record<string, unknown>;
      }
    ).__dna708PrepackedSceneReadiness;
    expect(readiness).toMatchObject({
      status: 'loaded-built',
      origin: 'built',
      cacheState: 'miss',
      cacheOrigin: 'prepared-after-miss',
      writeCompletedAt: 4,
      cacheLifecycle: builtLifecycle,
    });
  });

  it('fails closed instead of retrying or renderer-building an unprepared full-assembly miss', async () => {
    const fullAssemblyDescriptor: AssemblyPrepackedAnnotationSceneDescriptor = {
      ...descriptor,
      request: {
        ...descriptor.request,
        chromosomes: [
          { chrom: 'single-contig', sourcePath: '/workspace/single-contig.gff3', length: 1_000 },
        ],
        scope: {
          kind: 'complete-assembly',
          placements: [{ chrom: 'single-contig', length: 1_000, annotationCoverage: 'sourced' }],
        },
      },
    };
    const renderer = {
      getCurrentPathMapper: () => ({}),
      getRendererDebugSnapshot: () => ({ annotationOverlay: { layout: {} } }),
      loadPrepackedAnnotationScene: vi.fn(),
      buildAndLoadPrepackedAnnotationScene: vi.fn(),
    };
    const requestFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);

    const { result } = renderHook(() =>
      usePrepackedAssemblyAnnotationScene({
        cache: {
          status: 'miss',
          descriptor: fullAssemblyDescriptor,
          result: missResult,
          error: null,
          lifecycle: missLifecycle,
        },
        overviewFeaturesComplete: true,
        effectiveLayerTypes: ['mRNA'],
        requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
        readinessGeneration: 'full-assembly-miss',
        readinessScopeKey: 'full-assembly-miss-scope',
        webglRef: { current: { getLinearRenderer: () => renderer as never } },
      })
    );

    await waitFor(() => expect(result.current).toBe('error'));
    expect(renderer.buildAndLoadPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(renderer.loadPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('does not schedule recurring frames while no concrete renderer exists', async () => {
    const requestFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);

    const { result } = renderHook(() =>
      usePrepackedAssemblyAnnotationScene({
        cache: {
          status: 'miss',
          descriptor,
          result: missResult,
          error: null,
          lifecycle: missLifecycle,
        },
        overviewFeaturesComplete: true,
        effectiveLayerTypes: ['mRNA'],
        requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
        readinessGeneration: 'renderer-absent',
        readinessScopeKey: 'renderer-absent-scope',
        rendererReadyEpoch: 0,
        webglRef: { current: { getLinearRenderer: () => null } },
      })
    );

    await waitFor(() => expect(result.current).toBe('waiting-renderer'));
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('retries exactly once after the same renderer commits a matching genome source', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: descriptor.datasetContract,
      assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 1000 },
      families: built.scene.families,
      featureFamilyIndices: built.scene.featureFamilyIndices,
      scene: built.gpuReadyScene!,
      interactionIndex: built.interactionIndex!,
      policyProjection,
    });
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: {
        status: 'hit' as const,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'build',
        scope: descriptor.request.scope,
        artifact: descriptor.artifact,
        byteCount: packed.payload.byteLength,
        manifest: packed.manifest,
        payload: packed.payload,
      },
      error: null,
      lifecycle: durableHitLifecycle,
    };
    let shellMatches = false;
    let activeInput: PrepackedAnnotationSceneLoadInput | null = null;
    const loadPrepackedAnnotationScene = vi.fn((input: PrepackedAnnotationSceneLoadInput) => {
      if (!shellMatches) return false;
      activeInput = input;
      return true;
    });
    const renderer = {
      getCurrentPathMapper: () => ({}),
      getRendererDebugSnapshot: () => ({
        annotationOverlay: {
          layout: {},
          prepackedAnnotationSceneStatus: shellMatches ? 'eligible' : 'genome-mismatch',
        },
      }),
      loadPrepackedAnnotationScene,
      getPrepackedAnnotationSceneOwnerSnapshot: () => ({
        ownerKey: activeInput?.ownerKey ?? null,
        ownerGeneration: activeInput ? 1 : 0,
        loaded: activeInput !== null,
        status: activeInput ? 'eligible' : 'genome-mismatch',
        gpuPrepared: activeInput !== null,
        metadata: activeInput?.metadata ?? null,
        runtimePolicy: activeInput?.runtimePolicy ?? null,
      }),
    };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { result, rerender } = renderHook(
      ({ rendererGenomeCommitEpoch }) =>
        usePrepackedAssemblyAnnotationScene({
          cache,
          overviewFeaturesComplete: false,
          effectiveLayerTypes: ['mRNA'],
          requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
          readinessGeneration: 'same-renderer-source-commit',
          readinessScopeKey: 'same-renderer-source-commit-scope',
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch,
          webglRef: { current: { getLinearRenderer: () => renderer as never } },
        }),
      { initialProps: { rendererGenomeCommitEpoch: 1 } }
    );

    await waitFor(() => expect(result.current).toBe('waiting-renderer'));
    expect(loadPrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);

    shellMatches = true;
    rerender({ rendererGenomeCommitEpoch: 2 });
    await waitFor(() => expect(frames).toHaveLength(1));
    expect(loadPrepackedAnnotationScene).toHaveBeenCalledTimes(2);
    await act(async () => frames.shift()!(performance.now()));
    await waitFor(() => expect(result.current).toBe('loaded-hit'));
    expect(loadPrepackedAnnotationScene).toHaveBeenCalledTimes(2);
    expect(activeInput?.trustedRendererAdmissionV4).toBeUndefined();
    expect(activeInput?.trustedRendererAdmissionProvenanceV4).toBeUndefined();
    expect(activeInput?.trustedRendererAdmissionLoadIdentityV4).toBeUndefined();
    expect(activeInput?.scene.primitives).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it('never turns a renderer epoch into permission to build a cache miss', async () => {
    let status = 'genome-mismatch';
    let calls = 0;
    let activeInput: PrepackedAnnotationSceneLoadInput | null = null;
    const renderer = {
      getCurrentPathMapper: () => ({}),
      getRendererDebugSnapshot: () => ({
        annotationOverlay: { layout: {}, prepackedAnnotationSceneStatus: status },
      }),
      loadPrepackedAnnotationScene: vi.fn((input: PrepackedAnnotationSceneLoadInput) => {
        activeInput = input;
        return true;
      }),
      updatePrepackedAnnotationPolicy: vi.fn((runtimePolicy) => {
        if (!activeInput) return false;
        activeInput = { ...activeInput, runtimePolicy };
        return true;
      }),
      buildAndLoadPrepackedAnnotationScene: vi.fn(() => {
        calls += 1;
        if (calls === 1) return null;
        status = 'eligible';
        activeInput = built;
        return built;
      }),
      getPrepackedAnnotationSceneOwnerSnapshot: () => ({
        ownerKey: activeInput?.ownerKey ?? null,
        ownerGeneration: activeInput ? 1 : 0,
        loaded: activeInput !== null,
        status: activeInput ? 'eligible' : 'not-loaded',
        gpuPrepared: activeInput !== null,
        metadata: activeInput?.metadata ?? null,
        runtimePolicy: activeInput?.runtimePolicy ?? null,
      }),
    };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { result, rerender } = renderHook(
      ({ rendererReadyEpoch }) =>
        usePrepackedAssemblyAnnotationScene({
          cache: {
            status: 'miss',
            descriptor,
            result: missResult,
            error: null,
            lifecycle: missLifecycle,
          },
          overviewFeaturesComplete: true,
          effectiveLayerTypes: ['mRNA'],
          requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
          readinessGeneration: 'viewer-generation-1',
          readinessScopeKey: `viewer-generation-scope:${rendererReadyEpoch}`,
          rendererReadyEpoch,
          webglRef: { current: { getLinearRenderer: () => renderer as never } },
        }),
      { initialProps: { rendererReadyEpoch: 1 } }
    );
    await waitFor(() => expect(result.current).toBe('waiting-renderer'));
    expect(renderer.buildAndLoadPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);

    rerender({ rendererReadyEpoch: 2 });
    await waitFor(() => expect(result.current).toBe('waiting-renderer'));
    expect(frames).toHaveLength(0);
    expect(renderer.buildAndLoadPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not publish loaded readiness for a displaced owner and reasserts the exact hit', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: descriptor.datasetContract,
      assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 1000 },
      families: built.scene.families,
      featureFamilyIndices: built.scene.featureFamilyIndices,
      scene: built.gpuReadyScene!,
      interactionIndex: built.interactionIndex!,
      policyProjection,
    });
    let activeInput: PrepackedAnnotationSceneLoadInput | null = null;
    let preparedInput: PrepackedAnnotationSceneLoadInput | null = null;
    const renderer = {
      getCurrentPathMapper: () => ({}),
      getRendererDebugSnapshot: () => ({
        annotationOverlay: { layout: {}, prepackedAnnotationSceneStatus: 'eligible' },
      }),
      loadPrepackedAnnotationScene: vi.fn((input: PrepackedAnnotationSceneLoadInput) => {
        activeInput = input;
        return true;
      }),
      preparePrepackedAnnotationScene: vi.fn((input: PrepackedAnnotationSceneLoadInput) => {
        preparedInput = input;
        return true;
      }),
      activatePrepackedAnnotationScene: vi.fn((ownerKey: string) => {
        if (preparedInput?.ownerKey !== ownerKey) return false;
        expect(activeInput?.ownerKey).toBe('displaced-owner');
        activeInput = preparedInput;
        preparedInput = null;
        return true;
      }),
      updatePrepackedAnnotationPolicy: vi.fn((runtimePolicy) => {
        if (!activeInput) return false;
        activeInput = { ...activeInput, runtimePolicy };
        return true;
      }),
      buildAndLoadPrepackedAnnotationScene: vi.fn(),
      getPrepackedAnnotationSceneOwnerSnapshot: () => ({
        ownerKey: activeInput?.ownerKey ?? null,
        ownerGeneration: activeInput ? 1 : 0,
        loaded: activeInput !== null,
        status: activeInput ? 'eligible' : 'not-loaded',
        gpuPrepared: activeInput !== null,
        metadata: activeInput?.metadata ?? null,
        runtimePolicy: activeInput?.runtimePolicy ?? null,
      }),
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: {
        status: 'hit' as const,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'build',
        scope: descriptor.request.scope,
        artifact: descriptor.artifact,
        byteCount: packed.payload.byteLength,
        manifest: packed.manifest,
        payload: packed.payload,
      },
      error: null,
      lifecycle: durableHitLifecycle,
    };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const onPresented = vi.fn();
    const { result, rerender } = renderHook(
      ({ rendererReadyEpoch }) =>
        usePrepackedAssemblyAnnotationScene({
          cache,
          overviewFeaturesComplete: false,
          effectiveLayerTypes: ['mRNA'],
          requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
          onPresented,
          readinessGeneration: 'viewer-generation-1',
          readinessScopeKey: `viewer-generation-scope:${rendererReadyEpoch}`,
          rendererReadyEpoch,
          webglRef: { current: { getLinearRenderer: () => renderer as never } },
        }),
      { initialProps: { rendererReadyEpoch: 1 } }
    );
    await waitFor(() => expect(frames).toHaveLength(1));
    expect(result.current).toBe('loading-hit');
    activeInput = { ...activeInput!, ownerKey: 'displaced-owner' };
    await act(async () => frames.shift()!(performance.now()));
    await waitFor(() => expect(result.current).toBe('waiting-renderer'));
    expect(onPresented).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);

    rerender({ rendererReadyEpoch: 2 });
    await waitFor(() => expect(frames).toHaveLength(1));
    await act(async () => frames.shift()!(performance.now()));
    await waitFor(() => expect(result.current).toBe('loaded-hit'));
    expect(renderer.loadPrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(renderer.activatePrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(renderer.preparePrepackedAnnotationScene).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: expect.objectContaining({ primitives: [] }),
        gpuReadyScene: expect.objectContaining({
          packedInstanceData: expect.any(Float32Array),
          featureIndices: new Uint32Array([0]),
        }),
        interactionIndex: expect.objectContaining({ featureCount: 1, primitiveCount: 1 }),
      })
    );
    expect(renderer.buildAndLoadPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(onPresented).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor,
        ownerKey: activeInput?.ownerKey,
        origin: 'hit',
      })
    );
  });

  it('binds same-policy presentation to the exact request and cancels it on unmount', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: descriptor.datasetContract,
      assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 1000 },
      families: built.scene.families,
      featureFamilyIndices: built.scene.featureFamilyIndices,
      scene: built.gpuReadyScene!,
      interactionIndex: built.interactionIndex!,
      policyProjection,
    });
    let activeInput: PrepackedAnnotationSceneLoadInput | null = null;
    const renderer = {
      getCurrentPathMapper: () => ({}),
      getRendererDebugSnapshot: () => ({
        annotationOverlay: { layout: {}, prepackedAnnotationSceneStatus: 'eligible' },
      }),
      loadPrepackedAnnotationScene: vi.fn((input: PrepackedAnnotationSceneLoadInput) => {
        activeInput = input;
        return true;
      }),
      updatePrepackedAnnotationPolicy: vi.fn((runtimePolicy) => {
        if (!activeInput) return false;
        activeInput = { ...activeInput, runtimePolicy };
        return true;
      }),
      buildAndLoadPrepackedAnnotationScene: vi.fn(),
      getPrepackedAnnotationSceneOwnerSnapshot: () => ({
        ownerKey: activeInput?.ownerKey ?? null,
        ownerGeneration: activeInput ? 1 : 0,
        loaded: activeInput !== null,
        status: activeInput ? 'eligible' : 'not-loaded',
        gpuPrepared: activeInput !== null,
        metadata: activeInput?.metadata ?? null,
        runtimePolicy: activeInput?.runtimePolicy ?? null,
      }),
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: {
        status: 'hit' as const,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'build',
        scope: descriptor.request.scope,
        artifact: descriptor.artifact,
        byteCount: packed.payload.byteLength,
        manifest: packed.manifest,
        payload: packed.payload,
      },
      error: null,
      lifecycle: durableHitLifecycle,
    };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const onPresented = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ requestId }) =>
        usePrepackedAssemblyAnnotationScene({
          cache,
          overviewFeaturesComplete: false,
          effectiveLayerTypes: ['mRNA'],
          requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
          requestId,
          onPresented,
          readinessGeneration: 'viewer-generation-unmount',
          readinessScopeKey: 'viewer-generation-unmount-scope',
          webglRef: { current: { getLinearRenderer: () => renderer as never } },
        }),
      { initialProps: { requestId: 1 } }
    );
    await waitFor(() => expect(frames).toHaveLength(1));

    rerender({ requestId: 2 });
    await waitFor(() => expect(frames).toHaveLength(2));
    await act(async () => frames.shift()!(performance.now()));
    expect(onPresented).not.toHaveBeenCalled();

    await act(async () => frames.shift()!(performance.now()));
    await waitFor(() =>
      expect(onPresented).toHaveBeenCalledWith(expect.objectContaining({ requestId: 2 }))
    );

    rerender({ requestId: 3 });
    await waitFor(() => expect(frames).toHaveLength(1));
    unmount();
    await act(async () => frames.shift()!(performance.now()));

    expect(onPresented).toHaveBeenCalledTimes(1);
  });

  it('switches canonical/expanded policy on one owner without another load or build', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: descriptor.datasetContract,
      assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 1000 },
      families: built.scene.families,
      featureFamilyIndices: built.scene.featureFamilyIndices,
      scene: built.gpuReadyScene!,
      interactionIndex: built.interactionIndex!,
      policyProjection,
    });
    let activeInput: PrepackedAnnotationSceneLoadInput | null = null;
    const renderer = {
      getCurrentPathMapper: () => ({}),
      getRendererDebugSnapshot: () => ({
        annotationOverlay: { layout: {}, prepackedAnnotationSceneStatus: 'eligible' },
      }),
      loadPrepackedAnnotationScene: vi.fn((input: PrepackedAnnotationSceneLoadInput) => {
        activeInput = input;
        return true;
      }),
      updatePrepackedAnnotationPolicy: vi.fn((runtimePolicy) => {
        if (!activeInput) return false;
        activeInput = { ...activeInput, runtimePolicy };
        return true;
      }),
      buildAndLoadPrepackedAnnotationScene: vi.fn(),
      clearPrepackedAnnotationScene: vi.fn(),
      getPrepackedAnnotationSceneOwnerSnapshot: () => ({
        ownerKey: activeInput?.ownerKey ?? null,
        ownerGeneration: activeInput ? 1 : 0,
        loaded: activeInput !== null,
        status: activeInput ? 'eligible' : 'not-loaded',
        gpuPrepared: activeInput !== null,
        metadata: activeInput?.metadata ?? null,
        runtimePolicy: activeInput?.runtimePolicy ?? null,
      }),
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: {
        status: 'hit' as const,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'build',
        scope: descriptor.request.scope,
        artifact: descriptor.artifact,
        byteCount: packed.payload.byteLength,
        manifest: packed.manifest,
        payload: packed.payload,
      },
      error: null,
      lifecycle: durableHitLifecycle,
    };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { result, rerender } = renderHook(
      ({ isoformMode, laneLimit }) => {
        const readiness = usePrepackedAssemblyAnnotationScene({
          cache,
          overviewFeaturesComplete: true,
          effectiveLayerTypes: ['mRNA'],
          requestedPolicy: { trackType: 'mRNA', isoformMode, laneLimit },
          readinessGeneration: 'viewer-generation-1',
          readinessScopeKey: 'viewer-generation-policy-scope',
          webglRef: { current: { getLinearRenderer: () => renderer as never } },
        });
        return {
          readiness,
          interactionReady: readiness === 'loaded-hit',
        };
      },
      { initialProps: { isoformMode: 'canonical' as const, laneLimit: 12 } }
    );
    await waitFor(() => expect(frames).toHaveLength(1));
    await act(async () => frames.shift()!(performance.now()));
    await waitFor(() => expect(result.current.readiness).toBe('loaded-hit'));
    expect(result.current.interactionReady).toBe(true);
    expect(renderer.clearPrepackedAnnotationScene).not.toHaveBeenCalled();
    const loadCountBeforePolicyChange = renderer.loadPrepackedAnnotationScene.mock.calls.length;
    const buildCountBeforePolicyChange =
      renderer.buildAndLoadPrepackedAnnotationScene.mock.calls.length;

    rerender({ isoformMode: 'expanded' as const, laneLimit: 8 });

    await waitFor(() => expect(frames).toHaveLength(1));
    await act(async () => frames.shift()!(performance.now()));
    await waitFor(() => expect(result.current.readiness).toBe('loaded-hit'));
    expect(result.current.interactionReady).toBe(true);
    expect(renderer.clearPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(renderer.loadPrepackedAnnotationScene).toHaveBeenCalledTimes(
      loadCountBeforePolicyChange
    );
    expect(renderer.buildAndLoadPrepackedAnnotationScene).toHaveBeenCalledTimes(
      buildCountBeforePolicyChange
    );
    expect(renderer.updatePrepackedAnnotationPolicy).toHaveBeenLastCalledWith({
      isoformMode: 'expanded',
      laneLimit: 8,
    });
  });

  it('publishes an error without asking the renderer to build an unvalidated cache state', async () => {
    const renderer = {
      getCurrentPathMapper: () => ({}),
      getRendererDebugSnapshot: () => ({ annotationOverlay: { layout: {} } }),
      loadPrepackedAnnotationScene: vi.fn(() => true),
      buildAndLoadPrepackedAnnotationScene: vi.fn(() => built),
    };
    const { result } = renderHook(() =>
      usePrepackedAssemblyAnnotationScene({
        cache: {
          status: 'error',
          descriptor,
          result: null,
          error: new Error('IPC read failed'),
          lifecycle: errorLifecycle,
        },
        overviewFeaturesComplete: true,
        effectiveLayerTypes: ['mRNA'],
        requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
        readinessGeneration: 'viewer-generation-error',
        readinessScopeKey: 'viewer-generation-error-scope',
        webglRef: { current: { getLinearRenderer: () => renderer as never } },
      })
    );
    await waitFor(() => expect(result.current).toBe('error'));
    expect(renderer.buildAndLoadPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(renderer.loadPrepackedAnnotationScene).not.toHaveBeenCalled();
  });
});
