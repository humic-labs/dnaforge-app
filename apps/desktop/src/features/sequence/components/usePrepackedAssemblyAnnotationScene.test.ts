import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
  buildAnnotationPolicyGpuInstanceDataV1,
  buildAnnotationPolicyDirectFineIndexV1,
  buildAnnotationPolicyDirectSubmissionBankV1,
  buildAnnotationPolicyProjectionTableV1,
  buildPartitionedTranscriptScene,
  buildPrepackedAnnotationInteractionIndexV2,
} from '@waypoint/genome-renderer/pure';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
} from '../../../shared/indexed-genome';
import type {
  AssemblyPrepackedAnnotationSceneCacheState,
  AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt,
  AssemblyPrepackedAnnotationSceneDescriptor,
} from './useAssemblyPrepackedAnnotationSceneCache';
import {
  assemblyPrepackedAnnotationSceneOwnerKey,
  executePrepackedAssemblyAnnotationScene,
  hasPreparedPrepackedAssemblyAnnotationScene,
  resetPrepackedAssemblyAnnotationSceneTasksForTest,
} from './usePrepackedAssemblyAnnotationScene';

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

const descriptor: AssemblyPrepackedAnnotationSceneDescriptor = {
  sourceIdentity: `assembly-source:${'a'.repeat(64)}`,
  placementFingerprint: `ap1:${'b'.repeat(24)}`,
  datasetContract: {
    datasetId: 'waypoint:assembly-annotation:grch38',
    datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
    sourceSha256: 'a'.repeat(64),
  },
  artifact,
  runtimeCacheKey: 'runtime-policy-neutral-owner',
  sceneKey: 'scene-policy-neutral-owner',
  request: {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'grch38',
    workspaceRoot: '/workspace',
    chromosomes: [{ chrom: 'contig-a', sourcePath: '/workspace/a.gff3', length: 1_000 }],
    scope: {
      kind: 'complete-assembly',
      placements: [{ chrom: 'contig-a', length: 1_000, annotationCoverage: 'sourced' }],
    },
    datasetContract: {
      datasetId: 'waypoint:assembly-annotation:grch38',
      datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
      sourceSha256: 'a'.repeat(64),
    },
    artifact,
    requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
  },
};

const primitives = [
  {
    startBp: 10,
    endBp: 20,
    featureIndex: 0,
    offsetCenter: -7,
    halfH: 7,
    color: 0x123456,
    alpha: 1,
    cdsFade: 0,
    dirSign: 1,
  },
];
const gpuReadyScene = buildPartitionedTranscriptScene(
  primitives,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP
);
const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
  [
    {
      rendererId: 0,
      startBp: 10,
      endBp: 20,
      lane: 0,
      direction: 'forward',
      displayName: 'fixture transcript',
      type: 'mRNA',
      transcriptId: 'tx-fixture',
      sourceId: 'source-fixture',
      canonicalIdentity: 'canonical-fixture',
    },
  ],
  primitives
);
const policyProjection = buildAnnotationPolicyProjectionTableV1({
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
});
const submissionBank = buildAnnotationPolicyDirectSubmissionBankV1(
  gpuReadyScene,
  buildAnnotationPolicyGpuInstanceDataV1(gpuReadyScene.featureIndices, policyProjection)
);
const expandedFine = buildAnnotationPolicyDirectFineIndexV1(submissionBank.expanded, 1_000);
const directUnpacked = {
  scene: gpuReadyScene,
  families: [{ id: 'transcript-glyph-v2', kind: 'transcript' as const, metadata: {} }],
  featureFamilyIndices: new Uint32Array([0]),
  interactionIndex,
  policyProjection,
  submissionBank,
  submissionFineIndices: {
    expanded: expandedFine,
    canonical: buildAnnotationPolicyDirectFineIndexV1(
      submissionBank.canonical,
      1_000,
      expandedFine.sourceTilePrimitiveCounts
    ),
  },
};

const hitCache: Extract<AssemblyPrepackedAnnotationSceneCacheState, { status: 'hit' }> = {
  status: 'hit',
  descriptor,
  result: {
    status: 'hit',
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    fingerprint: 'b'.repeat(24),
    sourceBuildFingerprint: 'source-build-v3',
    scope: descriptor.request.scope,
    artifact,
    byteCount: 1,
    manifest: {
      integrity: {
        payloadSha256: '1'.repeat(64),
        contractSha256: '2'.repeat(64),
      },
    } as never,
    payload: new Uint8Array([1]),
  },
  error: null,
  lifecycle: {
    currentPhase: 'complete',
    origin: 'durable-hit',
    initialProbe: 'hit',
    terminalResult: 'hit',
    preparationAttempts: 0,
    startedAt: 1,
    preparationReadyObservedAt: null,
    completedAt: 2,
    history: [
      { phase: 'probing', probe: 'initial', at: 1 },
      { phase: 'probe-result-received', probe: 'initial', outcome: 'hit', at: 2 },
      { phase: 'complete', outcome: 'hit', at: 2 },
    ],
  } satisfies AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt,
};

function renderer() {
  let ownerKey: string | null = null;
  let metadata: PrepackedAnnotationSceneLoadInput['metadata'] | null = null;
  let runtimePolicy: PrepackedAnnotationSceneLoadInput['runtimePolicy'] = undefined;
  return {
    loadPrepackedAnnotationScene: vi.fn((input: PrepackedAnnotationSceneLoadInput) => {
      ownerKey = input.ownerKey;
      metadata = input.metadata;
      runtimePolicy = input.runtimePolicy;
      return true;
    }),
    updatePrepackedAnnotationPolicy: vi.fn(
      (policy: NonNullable<PrepackedAnnotationSceneLoadInput['runtimePolicy']>) => {
        if (ownerKey === null) return false;
        runtimePolicy = { ...policy };
        return true;
      }
    ),
    buildAndLoadPrepackedAnnotationScene: vi.fn(),
    getPrepackedAnnotationSceneOwnerSnapshot: vi.fn(() => ({
      ownerKey,
      ownerGeneration: ownerKey === null ? 0 : 1,
      loaded: ownerKey !== null,
      status: ownerKey === null ? 'not-loaded' : 'eligible',
      gpuPrepared: ownerKey !== null,
      metadata,
      runtimePolicy: runtimePolicy ?? null,
    })),
  };
}

beforeEach(() => resetPrepackedAssemblyAnnotationSceneTasksForTest());

describe('prepacked assembly annotation scene v4 execution', () => {
  it('preserves miss-then-build provenance through materialization instead of reporting a cold hit', async () => {
    const builtCache: Extract<AssemblyPrepackedAnnotationSceneCacheState, { status: 'hit' }> = {
      ...hitCache,
      lifecycle: {
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
      },
    };

    const prepared = await executePrepackedAssemblyAnnotationScene({
      cache: builtCache,
      renderer: renderer(),
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
      isCurrent: () => true,
      readUnpacked: vi.fn(async () => directUnpacked) as never,
    });

    expect(prepared?.origin).toBe('built');
    expect(builtCache.lifecycle).toMatchObject({
      origin: 'prepared-after-miss',
      initialProbe: 'miss',
      terminalResult: 'hit',
    });
  });

  it('loads one validated policy-neutral hit and switches mode/cap without decode or reload', async () => {
    const r = renderer();
    const unpack = vi.fn(async () => directUnpacked);
    const current = () => true;

    const canonical = await executePrepackedAssemblyAnnotationScene({
      cache: hitCache,
      renderer: r,
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
      isCurrent: current,
      readUnpacked: unpack as never,
    });
    expect(canonical?.input).toMatchObject({
      metadata: { artifactKey: artifact.artifactKey },
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
    });
    expect(canonical?.input.policyProjection).toBe(policyProjection);
    expect(canonical?.input.submissionBank).toBe(submissionBank);
    expect(canonical?.input.submissionFineIndices).toBe(directUnpacked.submissionFineIndices);
    expect(canonical?.input.policyGpuInstanceData).toBeUndefined();
    expect(r.loadPrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(r.updatePrepackedAnnotationPolicy).not.toHaveBeenCalled();

    const repeatedCanonical = await executePrepackedAssemblyAnnotationScene({
      cache: hitCache,
      renderer: r,
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
      isCurrent: current,
      readUnpacked: unpack as never,
    });
    expect(repeatedCanonical?.input.ownerKey).toBe(canonical?.input.ownerKey);
    expect(unpack).toHaveBeenCalledTimes(1);
    expect(r.loadPrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(r.updatePrepackedAnnotationPolicy).not.toHaveBeenCalled();

    const expanded = await executePrepackedAssemblyAnnotationScene({
      cache: hitCache,
      renderer: r,
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 24 },
      isCurrent: current,
      readUnpacked: unpack as never,
    });
    expect(expanded?.input.ownerKey).toBe(canonical?.input.ownerKey);
    expect(unpack).toHaveBeenCalledTimes(1);
    expect(r.loadPrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(r.updatePrepackedAnnotationPolicy).toHaveBeenCalledTimes(1);
    expect(r.updatePrepackedAnnotationPolicy).toHaveBeenLastCalledWith({
      isoformMode: 'expanded',
      laneLimit: 24,
    });
    expect(r.buildAndLoadPrepackedAnnotationScene).not.toHaveBeenCalled();
  });

  it('cold-loads prepared bytes into a replacement renderer with the current policy and no update', async () => {
    const firstRenderer = renderer();
    const replacementRenderer = renderer();
    const unpack = vi.fn(async () => directUnpacked);
    const current = () => true;

    await executePrepackedAssemblyAnnotationScene({
      cache: hitCache,
      renderer: firstRenderer,
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
      isCurrent: current,
      readUnpacked: unpack as never,
    });
    const expanded = await executePrepackedAssemblyAnnotationScene({
      cache: hitCache,
      renderer: replacementRenderer,
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 24 },
      isCurrent: current,
      readUnpacked: unpack as never,
    });

    expect(unpack).toHaveBeenCalledTimes(1);
    expect(replacementRenderer.loadPrepackedAnnotationScene).toHaveBeenCalledTimes(1);
    expect(replacementRenderer.loadPrepackedAnnotationScene).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePolicy: { isoformMode: 'expanded', laneLimit: 24 },
      })
    );
    expect(replacementRenderer.updatePrepackedAnnotationPolicy).not.toHaveBeenCalled();
    expect(expanded?.input.runtimePolicy).toEqual({ isoformMode: 'expanded', laneLimit: 24 });
  });

  it('retains one policy-neutral payload and evicts the retired artifact after replacement', async () => {
    const replacementDescriptor: AssemblyPrepackedAnnotationSceneDescriptor = {
      ...descriptor,
      runtimeCacheKey: 'runtime-policy-neutral-owner-replacement',
      sceneKey: 'scene-policy-neutral-owner-replacement',
    };
    const replacementCache: Extract<AssemblyPrepackedAnnotationSceneCacheState, { status: 'hit' }> =
      {
        ...hitCache,
        descriptor: replacementDescriptor,
        result: {
          ...hitCache.result,
          fingerprint: 'd'.repeat(24),
          manifest: {
            integrity: {
              payloadSha256: '3'.repeat(64),
              contractSha256: '4'.repeat(64),
            },
          } as never,
          payload: new Uint8Array([2]),
        },
      };
    const replacementScene = {
      ...directUnpacked,
      scene: {
        ...directUnpacked.scene,
        packedInstanceData: directUnpacked.scene.packedInstanceData.slice(),
      },
    };
    const unpackOriginal = vi.fn(async () => directUnpacked);
    const unpackReplacement = vi.fn(async () => replacementScene);
    const policy = { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 };

    const original = await executePrepackedAssemblyAnnotationScene({
      cache: hitCache,
      renderer: renderer(),
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: policy,
      isCurrent: () => true,
      readUnpacked: unpackOriginal as never,
    });
    expect(hasPreparedPrepackedAssemblyAnnotationScene(hitCache)).toBe(true);
    expect(original?.input.gpuReadyScene).toBe(directUnpacked.scene);

    await executePrepackedAssemblyAnnotationScene({
      cache: hitCache,
      renderer: renderer(),
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: { ...policy, isoformMode: 'expanded', laneLimit: 24 },
      isCurrent: () => true,
      readUnpacked: unpackOriginal as never,
    });
    expect(unpackOriginal).toHaveBeenCalledTimes(1);

    const replacement = await executePrepackedAssemblyAnnotationScene({
      cache: replacementCache,
      renderer: renderer(),
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: policy,
      isCurrent: () => true,
      readUnpacked: unpackReplacement as never,
    });
    expect(replacement?.input.gpuReadyScene).toBe(replacementScene.scene);
    expect(hasPreparedPrepackedAssemblyAnnotationScene(replacementCache)).toBe(true);
    expect(hasPreparedPrepackedAssemblyAnnotationScene(hitCache)).toBe(false);

    await executePrepackedAssemblyAnnotationScene({
      cache: hitCache,
      renderer: renderer(),
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: policy,
      isCurrent: () => true,
      readUnpacked: unpackOriginal as never,
    });
    expect(unpackOriginal).toHaveBeenCalledTimes(2);
  });

  it('never compiles, packs, writes, or loads a renderer-owned cache miss', async () => {
    const r = renderer();
    const result = await executePrepackedAssemblyAnnotationScene({
      cache: {
        status: 'miss',
        descriptor,
        result: {
          status: 'miss',
          ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
          fingerprint: 'c'.repeat(24),
          sourceBuildFingerprint: 'source-build-v3',
        },
        error: null,
        lifecycle: {
          currentPhase: 'complete',
          origin: 'miss',
          initialProbe: 'miss',
          terminalResult: 'miss',
          preparationAttempts: 0,
          startedAt: 1,
          preparationReadyObservedAt: null,
          completedAt: 2,
          history: [],
        },
      },
      renderer: r,
      effectiveLayerTypes: ['mRNA'],
      requestedPolicy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
      isCurrent: () => true,
    });
    expect(result).toBeNull();
    expect(r.buildAndLoadPrepackedAnnotationScene).not.toHaveBeenCalled();
    expect(r.loadPrepackedAnnotationScene).not.toHaveBeenCalled();
  });

  it('binds owner identity to source and immutable artifact, not runtime policy', () => {
    const base = {
      fingerprint: 'd'.repeat(24),
      payloadSha256: 'e'.repeat(64),
      contractSha256: 'f'.repeat(64),
      artifactKey: artifact.artifactKey,
    };
    expect(assemblyPrepackedAnnotationSceneOwnerKey(base)).toBe(
      assemblyAnnotationSceneInteractionOwnerKeyV3({
        sourceFingerprint: base.fingerprint,
        scenePayloadSha256: base.payloadSha256,
        sceneArtifactKey: base.artifactKey,
      })
    );
    expect(() =>
      assemblyPrepackedAnnotationSceneOwnerKey({ ...base, artifactKey: 'forged\nartifact' })
    ).toThrow(/provenance/);
  });

  it('contains no camera dependency, renderer build path, persistence, or base64 conversion', () => {
    const source = readFileSync(
      'src/features/sequence/components/usePrepackedAssemblyAnnotationScene.ts',
      'utf8'
    );
    expect(source).not.toMatch(
      /handleCameraChange|sceneViewportRange|viewportStartBp|viewportEndBp/
    );
    expect(source).not.toMatch(/atob|btoa|base64/i);
    expect(source).not.toContain('scene-build-start');
    expect(source).not.toContain('binary-pack-start');
    expect(source).not.toContain('cache-write-start');
  });
});
