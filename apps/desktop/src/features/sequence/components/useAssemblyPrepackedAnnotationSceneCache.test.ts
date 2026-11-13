import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PREPACKED_ANNOTATION_GEOMETRY_TOKEN } from '@waypoint/genome-renderer';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  type AssemblyReferenceAssetGenerationV1,
} from '../../../shared/indexed-genome';

const { prepareAssemblyAnnotationScene, readAssemblyAnnotationScene } = vi.hoisted(() => ({
  prepareAssemblyAnnotationScene: vi.fn(),
  readAssemblyAnnotationScene: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({ genome: { prepareAssemblyAnnotationScene, readAssemblyAnnotationScene } }),
}));

import {
  activeAnnotationSourcePlacementProvenance,
  ASSEMBLY_ANNOTATION_DATASET_VERSION,
  deriveAssemblyPrepackedAnnotationSceneDescriptor,
  NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE,
  resetAssemblyPrepackedAnnotationSceneCacheTasksForTest,
  shouldDeferGenomeWideFeaturesForPrepackedScene,
  useAssemblyPrepackedAnnotationSceneCache,
} from './useAssemblyPrepackedAnnotationSceneCache';

const ONE_CHROM_VIEWPORT_SCOPE = {
  kind: 'viewport-subset' as const,
  placements: [{ chrom: 'chr1', length: 100, annotationCoverage: 'sourced' as const }],
};

beforeEach(() => {
  prepareAssemblyAnnotationScene.mockReset();
  readAssemblyAnnotationScene.mockReset();
  resetAssemblyPrepackedAnnotationSceneCacheTasksForTest();
});

describe('assembly prepacked annotation scene descriptor', () => {
  it('derives one deterministic source, dataset, and policy-neutral artifact identity', async () => {
    const input = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: {
          ...ONE_CHROM_VIEWPORT_SCOPE,
          placements: [{ ...ONE_CHROM_VIEWPORT_SCOPE.placements[0], length: 248_956_422 }],
        },
        chromosomes: [
          { chrom: 'chr1', sourcePath: '/workspace/chr1.gff3.gz', length: 248_956_422 },
        ],
      },
      themeMode: 'dark' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };

    const first = await deriveAssemblyPrepackedAnnotationSceneDescriptor(input);
    const second = await deriveAssemblyPrepackedAnnotationSceneDescriptor(input);

    expect(first.datasetContract.datasetVersion).toBe(
      'resolved-annotation-v4:structural-composite-kinds.v1'
    );
    expect(first.datasetContract.datasetVersion).toBe(ASSEMBLY_ANNOTATION_DATASET_VERSION);
    expect(second).toEqual(first);
    expect(first.sourceIdentity).toMatch(/^assembly-annotation-source-sha256\.v1:[0-9a-f]{64}$/);
    expect(first.placementFingerprint).toBe('ap1:f88defb70c86c0cbe311cadb');
    expect(first.sceneKey).toContain('0|chr1|248956422|workspace:chr1.gff3.gz');
    expect(first.datasetContract.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.artifact).toMatchObject({
      themeMode: 'dark',
      trackType: 'mRNA',
      partitionSpanBp: 100_000_000,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: 'source-lanes.v1',
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      mapperContractToken: 'annotation-isoform-mapper.v2',
      interactionContractToken: 'annotation-feature-hit-index.v3',
    });
    expect(first.sceneKey).toContain(first.datasetContract.sourceSha256);
    expect(first.request.ipcContractVersion).toBe(ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT);
    expect(JSON.stringify(first.request)).not.toContain('base64');
  });

  it('keeps a portable product on the exact dataset version admitted by main', async () => {
    const admittedDatasetVersion = 'resolved-annotation-v3:mapped-track-input.v1';
    const descriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      request: {
        assemblyId: 'published-assembly',
        workspaceRoot: '/workspace',
        datasetVersion: admittedDatasetVersion,
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3.gz', length: 100 }],
      },
      themeMode: 'light',
      policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
    });

    expect(descriptor.datasetContract.datasetVersion).toBe(admittedDatasetVersion);
    expect(descriptor.request.datasetVersion).toBe(admittedDatasetVersion);
    expect(descriptor.sceneKey).toContain(admittedDatasetVersion);
  });

  it('keys explicit scope provenance and rejects missing or reordered placement coverage', async () => {
    const chromosomes = [
      { chrom: 'contig-a', sourcePath: '/workspace/a.gff3', length: 100 },
      { chrom: 'contig-b', sourcePath: null, length: 50 },
    ];
    const policy = { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 };
    const complete = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      request: {
        assemblyId: 'assembly',
        workspaceRoot: '/workspace',
        chromosomes,
        scope: {
          kind: 'complete-assembly',
          placements: [
            { chrom: 'contig-a', length: 100, annotationCoverage: 'sourced' },
            { chrom: 'contig-b', length: 50, annotationCoverage: 'unsourced' },
          ],
        },
      },
      themeMode: 'light',
      policy,
    });
    const viewport = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      request: {
        ...complete.request,
        scope: { ...complete.request.scope, kind: 'viewport-subset' },
      },
      themeMode: 'light',
      policy,
    });

    expect(complete.request.scope.kind).toBe('complete-assembly');
    expect(complete.sceneKey).not.toBe(viewport.sceneKey);
    await expect(
      deriveAssemblyPrepackedAnnotationSceneDescriptor({
        request: {
          ...complete.request,
          scope: {
            ...complete.request.scope,
            placements: complete.request.scope.placements.slice(0, 1),
          },
        },
        themeMode: 'light',
        policy,
      })
    ).rejects.toThrow(/scope/i);
    await expect(
      deriveAssemblyPrepackedAnnotationSceneDescriptor({
        request: {
          ...complete.request,
          scope: {
            ...complete.request.scope,
            placements: [...complete.request.scope.placements].reverse(),
          },
        },
        themeMode: 'light',
        policy,
      })
    ).rejects.toThrow(/scope/i);
  });

  it('changes source and scene keys when source or resolved theme changes', async () => {
    const base = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const light = await deriveAssemblyPrepackedAnnotationSceneDescriptor(base);
    const dark = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      ...base,
      themeMode: 'dark',
    });
    const changed = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      ...base,
      request: {
        ...base.request,
        chromosomes: [{ ...base.request.chromosomes[0], sourcePath: '/workspace/chr1-v2.gff3' }],
      },
    });
    expect(dark.sourceIdentity).toBe(light.sourceIdentity);
    expect(dark.sceneKey).not.toBe(light.sceneKey);
    expect(changed.sourceIdentity).not.toBe(light.sourceIdentity);
    expect(changed.sceneKey).not.toBe(light.sceneKey);
  });

  it('keys artifacts by track while isoform and lane policy reuse one artifact', async () => {
    const base = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: {
        trackType: 'mRNA',
        isoformMode: 'canonical' as const,
        laneLimit: 12,
      },
    };
    const canonical = await deriveAssemblyPrepackedAnnotationSceneDescriptor(base);
    const expanded = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      ...base,
      policy: { ...base.policy, isoformMode: 'expanded' },
    });
    const eightLanes = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      ...base,
      policy: { ...base.policy, laneLimit: 8 },
    });
    const geneTrack = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      ...base,
      policy: { ...base.policy, trackType: 'gene' },
    });
    const hiddenCanonical = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      ...base,
      policy: { ...base.policy, visible: false } as never,
    });

    expect(
      new Set([canonical.sceneKey, expanded.sceneKey, eightLanes.sceneKey, geneTrack.sceneKey]).size
    ).toBe(2);
    expect(expanded.sceneKey).toBe(canonical.sceneKey);
    expect(eightLanes.sceneKey).toBe(canonical.sceneKey);
    expect(expanded.runtimeCacheKey).toBe(canonical.runtimeCacheKey);
    expect(eightLanes.runtimeCacheKey).toBe(canonical.runtimeCacheKey);
    expect(expanded.sourceIdentity).toBe(canonical.sourceIdentity);
    expect(eightLanes.sourceIdentity).toBe(canonical.sourceIdentity);
    expect(geneTrack.sourceIdentity).toBe(canonical.sourceIdentity);
    expect(expanded.placementFingerprint).toBe(canonical.placementFingerprint);
    expect(eightLanes.placementFingerprint).toBe(canonical.placementFingerprint);
    expect(geneTrack.placementFingerprint).toBe(canonical.placementFingerprint);
    expect(hiddenCanonical.sceneKey).toBe(canonical.sceneKey);
  });

  it('publishes truthful admitted source/placement provenance independent of finite mapper policy', async () => {
    const base = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const canonical = await deriveAssemblyPrepackedAnnotationSceneDescriptor(base);
    const expandedEight = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      ...base,
      policy: { ...base.policy, isoformMode: 'expanded', laneLimit: 8 },
    });
    const admittedFingerprint = 'a'.repeat(24);
    const cacheFor = (descriptor: typeof canonical) =>
      ({
        status: 'hit',
        descriptor,
        result: { fingerprint: admittedFingerprint },
        error: null,
      }) as never;

    expect(activeAnnotationSourcePlacementProvenance(cacheFor(canonical))).toEqual({
      contract: 'validated-annotation-source-placement.v1',
      sourceFingerprint: admittedFingerprint,
      placementFingerprint: canonical.placementFingerprint,
    });
    expect(activeAnnotationSourcePlacementProvenance(cacheFor(expandedEight))).toEqual(
      activeAnnotationSourcePlacementProvenance(cacheFor(canonical))
    );
  });

  it('normalizes track identity and fails closed on malformed mapper policy', async () => {
    const base = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const normalized = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
      ...base,
      policy: { ...base.policy, trackType: '  mRNA  ' },
    });
    const canonical = await deriveAssemblyPrepackedAnnotationSceneDescriptor(base);
    expect(normalized.sceneKey).toBe(canonical.sceneKey);
    await expect(
      deriveAssemblyPrepackedAnnotationSceneDescriptor({
        ...base,
        policy: { ...base.policy, trackType: '' },
      })
    ).rejects.toThrow('track type is required');
    await expect(
      deriveAssemblyPrepackedAnnotationSceneDescriptor({
        ...base,
        policy: { ...base.policy, laneLimit: -1 },
      })
    ).rejects.toThrow('lane limit');
  });

  it('reuses equivalent requests but reprobes when the admitted asset generation changes', async () => {
    readAssemblyAnnotationScene.mockResolvedValue({
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    });
    const request = () => ({
      assemblyId: 'grch38',
      workspaceRoot: '/workspace',
      scope: ONE_CHROM_VIEWPORT_SCOPE,
      chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
    });
    const initialProps = {
      request: request(),
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
      assetGeneration: null as AssemblyReferenceAssetGenerationV1 | null,
    };
    const { result, rerender } = renderHook(
      (props: typeof initialProps) => useAssemblyPrepackedAnnotationSceneCache(props),
      { initialProps }
    );
    await waitFor(() => expect(result.current.status).toBe('miss'));
    expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(1);

    rerender({
      request: request(),
      themeMode: 'light',
      policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
      assetGeneration: null,
    });
    await waitFor(() => expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(1));

    rerender({
      request: request(),
      themeMode: 'light',
      policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 12 },
      assetGeneration: null,
    });
    await waitFor(() => expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(1));

    rerender({
      request: request(),
      themeMode: 'light',
      policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 12 },
      assetGeneration: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'a'.repeat(24),
        inventoryFingerprint: 'b'.repeat(64),
        themeMode: 'light',
      },
    });
    await waitFor(() => expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(2));
  });

  it('preserves the immutable publication generation in the exact IPC request snapshot', async () => {
    readAssemblyAnnotationScene.mockResolvedValue({
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    });
    const expectedAssetGeneration: AssemblyReferenceAssetGenerationV1 = {
      contract: 'assembly-reference-asset-generation.v1',
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      themeMode: 'light',
    };
    const { result } = renderHook(() =>
      useAssemblyPrepackedAnnotationSceneCache({
        request: {
          assemblyId: 'grch38',
          workspaceRoot: '/workspace',
          scope: ONE_CHROM_VIEWPORT_SCOPE,
          chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
          expectedAssetGeneration,
        },
        assetGeneration: expectedAssetGeneration,
        themeMode: 'light',
        policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
      })
    );

    await waitFor(() => expect(result.current.status).toBe('miss'));
    expect(readAssemblyAnnotationScene).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAssetGeneration }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        retainedAssetGeneration: expectedAssetGeneration,
      })
    );
  });

  it('does no descriptor or IPC work while a standby variant is disabled', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    const props = {
      enabled: false,
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'expanded' as const, laneLimit: 12 },
    };

    const { result, rerender } = renderHook(
      (input: typeof props) => useAssemblyPrepackedAnnotationSceneCache(input),
      { initialProps: props }
    );
    expect(result.current).toBe(NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE);
    expect(readAssemblyAnnotationScene).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();

    rerender({ ...props, request: { ...props.request } });
    expect(result.current).toBe(NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE);
    expect(readAssemblyAnnotationScene).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    digest.mockRestore();
  });

  it('starts exactly one read when a standby variant becomes enabled', async () => {
    readAssemblyAnnotationScene.mockResolvedValue({
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    });
    const props = {
      enabled: false,
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'expanded' as const, laneLimit: 12 },
    };
    const { result, rerender } = renderHook(
      (input: typeof props) => useAssemblyPrepackedAnnotationSceneCache(input),
      { initialProps: props }
    );

    rerender({ ...props, enabled: true });
    await waitFor(() => expect(result.current.status).toBe('miss'));
    expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(1);

    rerender({ ...props, enabled: true, request: { ...props.request } });
    await waitFor(() => expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(1));
  });

  it('publishes the raster descriptor before the optional V4 interaction payload is enabled', async () => {
    readAssemblyAnnotationScene.mockResolvedValue({
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    });
    const props = {
      enabled: true,
      interactionPayloadEnabled: false,
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'expanded' as const, laneLimit: 8 },
    };
    const { result, rerender } = renderHook(
      (input: typeof props) => useAssemblyPrepackedAnnotationSceneCache(input),
      { initialProps: props }
    );

    await waitFor(() => expect(result.current.status).toBe('loading'));
    expect(result.current.descriptor).toMatchObject({
      sourceIdentity: expect.stringMatching(/^assembly-annotation-source-sha256\.v1:/),
      request: expect.objectContaining({ assemblyId: 'grch38' }),
    });
    expect(readAssemblyAnnotationScene).not.toHaveBeenCalled();

    rerender({ ...props, interactionPayloadEnabled: true });
    await waitFor(() => expect(result.current.status).toBe('miss'));
    expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(1);

    rerender({ ...props, interactionPayloadEnabled: true, request: { ...props.request } });
    await waitFor(() => expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(1));
  });

  it('offers the exact raster-published owner to renderer-local retained-scene admission', async () => {
    readAssemblyAnnotationScene.mockResolvedValue({
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    });
    const requiredInteractionOwnerKey = 'owner\nowner';

    const { result } = renderHook(() =>
      useAssemblyPrepackedAnnotationSceneCache({
        requiredInteractionOwnerKey,
        request: {
          assemblyId: 'grch38',
          workspaceRoot: '/workspace',
          scope: ONE_CHROM_VIEWPORT_SCOPE,
          chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
        },
        themeMode: 'light',
        policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 2 },
      })
    );

    await waitFor(() => expect(result.current.status).toBe('miss'));
    expect(readAssemblyAnnotationScene).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ retainedInteractionOwnerKey: requiredInteractionOwnerKey })
    );
  });

  it('keeps a cold target loading while main prepares it, then re-probes the exact hit', async () => {
    readAssemblyAnnotationScene
      .mockResolvedValueOnce({
        status: 'miss',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
      })
      .mockImplementationOnce(async (request) => ({
        status: 'hit',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
        scope: request.scope,
        artifact: request.artifact,
        byteCount: 0,
        manifest: {},
        payload: new Uint8Array(),
      }));
    prepareAssemblyAnnotationScene.mockResolvedValue({
      status: 'ready',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    });
    const props = {
      enabled: true,
      prepareOnMiss: true,
      preparationGeneration: 7,
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'expanded' as const, laneLimit: 12 },
    };
    const { result } = renderHook(() => useAssemblyPrepackedAnnotationSceneCache(props));

    await waitFor(() => expect(result.current.status).toBe('hit'));
    expect(prepareAssemblyAnnotationScene).toHaveBeenCalledTimes(1);
    expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(2);
    expect(result.current.status === 'hit' ? result.current.lifecycle : null).toMatchObject({
      currentPhase: 'complete',
      origin: 'prepared-after-miss',
      initialProbe: 'miss',
      terminalResult: 'hit',
      preparationAttempts: 1,
      preparationReadyObservedAt: expect.any(Number),
      completedAt: expect.any(Number),
    });
    expect(
      result.current.status === 'hit'
        ? result.current.lifecycle.history.map(({ phase, probe, outcome }) => ({
            phase,
            probe,
            outcome,
          }))
        : []
    ).toEqual([
      { phase: 'probing', probe: 'initial', outcome: undefined },
      { phase: 'probe-result-received', probe: 'initial', outcome: 'miss' },
      { phase: 'preparing', probe: undefined, outcome: undefined },
      { phase: 'prepare-result-received', probe: undefined, outcome: 'ready' },
      { phase: 'reprobing', probe: 'reprobe', outcome: undefined },
      { phase: 'probe-result-received', probe: 'reprobe', outcome: 'hit' },
      { phase: 'complete', probe: undefined, outcome: 'hit' },
    ]);
    expect(prepareAssemblyAnnotationScene).toHaveBeenCalledWith(
      expect.objectContaining({
        assemblyId: 'grch38',
        artifact: expect.objectContaining({ trackType: 'mRNA' }),
        requestedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
      })
    );
  });

  it('bounds continuous stale-revision churn instead of spinning indefinitely', async () => {
    readAssemblyAnnotationScene.mockResolvedValue({
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    });
    prepareAssemblyAnnotationScene.mockResolvedValue({
      status: 'unavailable',
      reason: 'stale',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    });

    const { result } = renderHook(() =>
      useAssemblyPrepackedAnnotationSceneCache({
        prepareOnMiss: true,
        request: {
          assemblyId: 'grch38',
          workspaceRoot: '/workspace',
          scope: ONE_CHROM_VIEWPORT_SCOPE,
          chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
        },
        themeMode: 'light',
        policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 12 },
      })
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(4);
    expect(prepareAssemblyAnnotationScene).toHaveBeenCalledTimes(3);
    expect(result.current.error).toEqual(
      new Error('annotation scene preparation exhausted 3 validated attempts')
    );
  });

  it('re-authorizes preparation when the source revision changes during a stale build', async () => {
    const miss = (fingerprint: string) => ({
      status: 'miss' as const,
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint,
      sourceBuildFingerprint: 'source-build-a',
    });
    readAssemblyAnnotationScene
      .mockResolvedValueOnce(miss('a'.repeat(24)))
      .mockResolvedValueOnce(miss('b'.repeat(24)))
      .mockImplementationOnce(async (request) => ({
        status: 'hit',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'b'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
        scope: request.scope,
        artifact: request.artifact,
        byteCount: 0,
        manifest: {},
        payload: new Uint8Array(),
      }));
    prepareAssemblyAnnotationScene
      .mockResolvedValueOnce({
        status: 'unavailable',
        reason: 'stale',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
      })
      .mockResolvedValueOnce({
        status: 'ready',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'b'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
      });

    const { result } = renderHook(() =>
      useAssemblyPrepackedAnnotationSceneCache({
        prepareOnMiss: true,
        request: {
          assemblyId: 'grch38',
          workspaceRoot: '/workspace',
          scope: ONE_CHROM_VIEWPORT_SCOPE,
          chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
        },
        themeMode: 'light',
        policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 12 },
      })
    );

    await waitFor(() => expect(result.current.status).toBe('hit'));
    expect(prepareAssemblyAnnotationScene).toHaveBeenCalledTimes(2);
    expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(3);
  });

  it('recovers from a transient worker timeout by re-probing before a bounded retry', async () => {
    const miss = {
      status: 'miss' as const,
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    };
    readAssemblyAnnotationScene
      .mockResolvedValueOnce(miss)
      .mockResolvedValueOnce(miss)
      .mockImplementationOnce(async (request) => ({
        status: 'hit',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
        scope: request.scope,
        artifact: request.artifact,
        byteCount: 0,
        manifest: {},
        payload: new Uint8Array(),
      }));
    prepareAssemblyAnnotationScene
      .mockResolvedValueOnce({ status: 'failed', reason: 'timeout', message: 'worker timed out' })
      .mockResolvedValueOnce({
        status: 'ready',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
      });

    const { result } = renderHook(() =>
      useAssemblyPrepackedAnnotationSceneCache({
        prepareOnMiss: true,
        request: {
          assemblyId: 'grch38',
          workspaceRoot: '/workspace',
          scope: ONE_CHROM_VIEWPORT_SCOPE,
          chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
        },
        themeMode: 'light',
        policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 12 },
      })
    );

    await waitFor(() => expect(result.current.status).toBe('hit'));
    expect(prepareAssemblyAnnotationScene).toHaveBeenCalledTimes(2);
    expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(3);
  });

  it('retries the same policy when its explicit preparation generation advances', async () => {
    const miss = {
      status: 'miss' as const,
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    };
    readAssemblyAnnotationScene
      .mockResolvedValueOnce(miss)
      .mockResolvedValueOnce(miss)
      .mockImplementationOnce(async (request) => ({
        status: 'hit',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
        scope: request.scope,
        artifact: request.artifact,
        byteCount: 0,
        manifest: {},
        payload: new Uint8Array(),
      }));
    prepareAssemblyAnnotationScene
      .mockResolvedValueOnce({
        status: 'unavailable',
        reason: 'source-unavailable',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
      })
      .mockResolvedValueOnce({
        status: 'ready',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
      });
    const initialProps = {
      preparationGeneration: 0,
      prepareOnMiss: true,
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'expanded' as const, laneLimit: 12 },
    };
    const { result, rerender } = renderHook(
      (props: typeof initialProps) => useAssemblyPrepackedAnnotationSceneCache(props),
      { initialProps }
    );
    await waitFor(() => expect(result.current.status).toBe('miss'));

    rerender({ ...initialProps, preparationGeneration: 1 });
    await waitFor(() => expect(result.current.status).toBe('hit'));
    expect(prepareAssemblyAnnotationScene).toHaveBeenCalledTimes(2);
  });

  it('suppresses an in-flight completion after a standby variant is disabled', async () => {
    let transportSignal: AbortSignal | undefined;
    let resolveRead!: (value: {
      status: 'miss';
      ipcContractVersion: typeof ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT;
      fingerprint: string;
      sourceBuildFingerprint: string;
    }) => void;
    readAssemblyAnnotationScene.mockImplementation(
      (_request, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          transportSignal = options?.signal;
          resolveRead = resolve;
        })
    );
    const props = {
      enabled: true,
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'expanded' as const, laneLimit: 12 },
    };
    const { result, rerender } = renderHook(
      (input: typeof props) => useAssemblyPrepackedAnnotationSceneCache(input),
      { initialProps: props }
    );
    await waitFor(() => expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(1));

    rerender({ ...props, enabled: false });
    expect(result.current).toBe(NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE);
    expect(transportSignal?.aborted).toBe(true);
    resolveRead({
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    });
    await Promise.resolve();
    expect(result.current).toBe(NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE);
  });

  it('keeps a deduplicated transport alive until its last hook subscriber unmounts', async () => {
    let transportSignal: AbortSignal | undefined;
    readAssemblyAnnotationScene.mockImplementation(
      (_request, options?: { signal?: AbortSignal }) =>
        new Promise(() => {
          transportSignal = options?.signal;
        })
    );
    const props = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const first = renderHook(() => useAssemblyPrepackedAnnotationSceneCache(props));
    const second = renderHook(() => useAssemblyPrepackedAnnotationSceneCache(props));
    await waitFor(() => {
      expect(first.result.current.status).toBe('loading');
      expect(second.result.current.status).toBe('loading');
      expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(1);
    });

    first.unmount();
    expect(transportSignal?.aborted).toBe(false);
    second.unmount();
    expect(transportSignal?.aborted).toBe(true);
  });

  it('aborts stale identity transport before starting the replacement read', async () => {
    const signals: AbortSignal[] = [];
    readAssemblyAnnotationScene.mockImplementation(
      (_request, options?: { signal?: AbortSignal }) =>
        new Promise(() => {
          if (options?.signal) signals.push(options.signal);
        })
    );
    const initialProps = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const { rerender } = renderHook(
      (props: typeof initialProps) => useAssemblyPrepackedAnnotationSceneCache(props),
      { initialProps }
    );
    await waitFor(() => expect(signals).toHaveLength(1));

    rerender({
      ...initialProps,
      themeMode: 'dark',
    });

    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('does not reuse one workspace read for another workspace with the same portable scene key', async () => {
    readAssemblyAnnotationScene.mockImplementation(async (request) => ({
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: request.workspaceRoot === '/workspace-a' ? 'a'.repeat(24) : 'b'.repeat(24),
      sourceBuildFingerprint: 'source-build-a',
    }));
    const request = (workspaceRoot: string) => ({
      assemblyId: 'grch38',
      workspaceRoot,
      scope: ONE_CHROM_VIEWPORT_SCOPE,
      chromosomes: [{ chrom: 'chr1', sourcePath: `${workspaceRoot}/chr1.gff3`, length: 100 }],
    });
    const initialProps = {
      request: request('/workspace-a'),
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const { result, rerender } = renderHook(
      (props: typeof initialProps) => useAssemblyPrepackedAnnotationSceneCache(props),
      { initialProps }
    );
    await waitFor(() => expect(result.current.status).toBe('miss'));
    const portableSceneKey = result.current.descriptor?.sceneKey;
    const firstRuntimeCacheKey = result.current.descriptor?.runtimeCacheKey;
    expect(result.current.result).toMatchObject({ fingerprint: 'a'.repeat(24) });

    rerender({ ...initialProps, request: request('/workspace-b') });

    await waitFor(() =>
      expect(result.current.result).toMatchObject({ fingerprint: 'b'.repeat(24) })
    );
    expect(result.current.descriptor?.sceneKey).toBe(portableSceneKey);
    expect(result.current.descriptor?.runtimeCacheKey).not.toBe(firstRuntimeCacheKey);
    expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(2);
    expect(readAssemblyAnnotationScene.mock.calls.map(([value]) => value.workspaceRoot)).toEqual([
      '/workspace-a',
      '/workspace-b',
    ]);
  });

  it('revalidates the same workspace on a new hook lifecycle after an in-place source change', async () => {
    readAssemblyAnnotationScene
      .mockResolvedValueOnce({
        status: 'miss',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'a'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
      })
      .mockResolvedValueOnce({
        status: 'miss',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: 'b'.repeat(24),
        sourceBuildFingerprint: 'source-build-a',
      });
    const props = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const first = renderHook(() => useAssemblyPrepackedAnnotationSceneCache(props));
    await waitFor(() => expect(first.result.current.status).toBe('miss'));
    expect(first.result.current.result).toMatchObject({ fingerprint: 'a'.repeat(24) });
    first.unmount();

    const second = renderHook(() => useAssemblyPrepackedAnnotationSceneCache(props));
    await waitFor(() =>
      expect(second.result.current.result).toMatchObject({ fingerprint: 'b'.repeat(24) })
    );
    expect(readAssemblyAnnotationScene).toHaveBeenCalledTimes(2);
  });

  it('cannot deadlock feature population on first-open or PNG-hit scene misses', () => {
    expect(shouldDeferGenomeWideFeaturesForPrepackedScene(false, 'loading')).toBe(false);
    expect(shouldDeferGenomeWideFeaturesForPrepackedScene(true, 'miss')).toBe(false);
    expect(shouldDeferGenomeWideFeaturesForPrepackedScene(true, 'miss', true)).toBe(true);
    expect(shouldDeferGenomeWideFeaturesForPrepackedScene(true, 'error', true)).toBe(false);
    expect(shouldDeferGenomeWideFeaturesForPrepackedScene(true, 'error')).toBe(false);
    expect(shouldDeferGenomeWideFeaturesForPrepackedScene(true, 'not-applicable')).toBe(true);
    expect(shouldDeferGenomeWideFeaturesForPrepackedScene(true, 'loading')).toBe(true);
    expect(shouldDeferGenomeWideFeaturesForPrepackedScene(true, 'hit')).toBe(true);
  });

  it('classifies an absent or stale-main response as a non-deferring cache error', async () => {
    readAssemblyAnnotationScene.mockResolvedValue(null);
    const props = {
      request: {
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        scope: ONE_CHROM_VIEWPORT_SCOPE,
        chromosomes: [{ chrom: 'chr1', sourcePath: '/workspace/chr1.gff3', length: 100 }],
      },
      themeMode: 'light' as const,
      policy: { trackType: 'mRNA', isoformMode: 'canonical' as const, laneLimit: 12 },
    };

    const { result } = renderHook(() => useAssemblyPrepackedAnnotationSceneCache(props));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toEqual(
      new Error('annotation scene probe failed validation: empty-result')
    );
    expect(shouldDeferGenomeWideFeaturesForPrepackedScene(true, result.current.status)).toBe(false);
  });
});
