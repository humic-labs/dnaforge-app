// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAnnotationPolicyProjectionTableV1,
  buildPrepackedAnnotationInteractionIndexV2,
  packCompiledBroadAnnotationInteractionBinaryV1,
  projectPrepackedAnnotationFeatureLookupIndexV2,
} from '@waypoint/genome-renderer/pure';
import {
  ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
  assemblyAnnotationSceneScopeForRequest,
  type AssemblyCompiledBroadInteractionHitResultV1,
} from '../../../shared/indexed-genome';
import { deriveAssemblyPrepackedAnnotationSceneDescriptor } from '../assembly-annotation-product-descriptor';
import { readNullableAuthorityUntilPublishedV1 } from './awaitNullableAuthorityPublication';
import {
  compiledBroadInteractionLoadInputV1,
  useAssemblyCompiledBroadInteraction,
} from './useAssemblyCompiledBroadInteraction';

const { readCompact } = vi.hoisted(() => ({ readCompact: vi.fn() }));

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: { readAssemblyCompiledBroadInteractionV1: readCompact },
  }),
}));

async function fixture(sourceDirectory = '/workspace') {
  const chromosomes = [
    { chrom: 'contig-a', length: 1_500, sourcePath: `${sourceDirectory}/a.gff.gz` },
    { chrom: 'contig-b', length: 1_500, sourcePath: `${sourceDirectory}/b.gff.gz` },
  ];
  const descriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
    request: {
      assemblyId: 'complete-test-assembly',
      chromosomes,
      workspaceRoot: '/workspace',
      scope: assemblyAnnotationSceneScopeForRequest('complete-assembly', chromosomes),
    },
    themeMode: 'light',
    policy: { trackType: 'enhancer', isoformMode: 'canonical', laneLimit: 2 },
  });
  const features = [
    {
      rendererId: 71,
      startBp: 100,
      endBp: 220,
      lane: 0,
      direction: 'none' as const,
      displayName: 'Enhancer 1',
      type: 'enhancer',
      transcriptId: null,
      sourceId: 'enh-1',
      canonicalIdentity: 'enhancer|enh-1||100|220|none',
    },
  ];
  const interaction = buildPrepackedAnnotationInteractionIndexV2(features, [{ featureIndex: 0 }]);
  const packed = await packCompiledBroadAnnotationInteractionBinaryV1({
    sourceScene: {
      schema: 'partitioned-transcript-scene-binary.v4',
      payloadSha256: 'a'.repeat(64),
      contractSha256: 'b'.repeat(64),
      byteLength: 300_000_000,
    },
    datasetContract: descriptor.datasetContract,
    assemblyContract: { assemblyId: descriptor.request.assemblyId, assemblyLengthBp: 3_000 },
    policyProjection: buildAnnotationPolicyProjectionTableV1({
      features: [
        {
          annotationType: 'enhancer',
          expandedLane: 0,
          expandedTrackLane: 0,
          canonicalLane: 0,
          canonicalTrackLane: 0,
        },
      ],
      expandedBandOrder: ['enhancer'],
      canonicalBandOrder: ['enhancer'],
    }),
    featureLookup: projectPrepackedAnnotationFeatureLookupIndexV2(interaction),
  });
  const fingerprint = 'c'.repeat(24);
  const ownerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
    sourceFingerprint: fingerprint,
    scenePayloadSha256: packed.manifest.sourceScene.payloadSha256,
    sceneArtifactKey: descriptor.artifact.artifactKey,
  });
  if (!ownerKey) throw new Error('fixture owner key was invalid');
  const result: AssemblyCompiledBroadInteractionHitResultV1 = {
    contract: ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
    status: 'hit',
    authorityKind: 'portable',
    origin: 'durable-hit',
    fingerprint,
    sourceBuildFingerprint: 'test-build',
    scope: descriptor.request.scope,
    artifact: descriptor.artifact,
    sourceScene: {
      byteCount: packed.manifest.sourceScene.byteLength,
      payloadSha256: packed.manifest.sourceScene.payloadSha256,
      contractSha256: packed.manifest.sourceScene.contractSha256,
    },
    byteCount: packed.payload.byteLength,
    manifest: packed.manifest,
    payload: packed.payload,
  };
  return { descriptor, ownerKey, result };
}

describe('compact broad interaction app admission', () => {
  beforeEach(() => {
    readCompact.mockReset();
  });

  it.each(['identity', 'length'] as const)(
    'waits for the renderer genome %s before admitting a replacement interaction',
    async (mismatch) => {
      const { descriptor, ownerKey, result: compactResult } = await fixture();
      const loadInput = compiledBroadInteractionLoadInputV1({
        descriptor,
        expectedInteractionOwnerKey: ownerKey,
        result: compactResult,
      });
      const committedContext = {
        supported: true,
        genomeIdentity: loadInput.metadata.genomeIdentity,
        genomeLengthBp: loadInput.metadata.genomeLengthBp,
      };
      let context = {
        ...committedContext,
        ...(mismatch === 'identity'
          ? { genomeIdentity: 'previous-reference' }
          : { genomeLengthBp: committedContext.genomeLengthBp + 1 }),
      };
      readCompact.mockResolvedValue(compactResult);
      const renderer = {
        getAnnotationPolicyReadinessSnapshot: () => context,
        loadCompiledBroadAnnotationInteraction: vi.fn(
          (input: ReturnType<typeof compiledBroadInteractionLoadInputV1>) =>
            context === committedContext ? input : null
        ),
      };
      const webglRef = { current: { getLinearRenderer: () => renderer } };
      const { result: hookResult, rerender } = renderHook(
        ({ commitEpoch }) =>
          useAssemblyCompiledBroadInteraction({
            enabled: true,
            publicationReady: true,
            descriptor,
            expectedInteractionOwnerKey: ownerKey,
            rendererReadyEpoch: 1,
            rendererGenomeCommitEpoch: commitEpoch,
            webglRef: webglRef as never,
          }),
        { initialProps: { commitEpoch: 1 } }
      );
      await waitFor(() => expect(hookResult.current.status).toBe('waiting-renderer'));
      expect(hookResult.current.error).toBeNull();
      expect(renderer.loadCompiledBroadAnnotationInteraction).not.toHaveBeenCalled();
      context = committedContext;
      rerender({ commitEpoch: 2 });
      await waitFor(() => expect(hookResult.current.status).toBe('loaded'));
      expect(readCompact).toHaveBeenCalledTimes(1);
      expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps a renderer rejection as an error after the matching genome is committed', async () => {
    const { descriptor, ownerKey, result: compactResult } = await fixture();
    const loadInput = compiledBroadInteractionLoadInputV1({
      descriptor,
      expectedInteractionOwnerKey: ownerKey,
      result: compactResult,
    });
    readCompact.mockResolvedValue(compactResult);
    const renderer = {
      getAnnotationPolicyReadinessSnapshot: () => ({
        supported: true,
        genomeIdentity: loadInput.metadata.genomeIdentity,
        genomeLengthBp: loadInput.metadata.genomeLengthBp,
      }),
      loadCompiledBroadAnnotationInteraction: vi.fn(() => null),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    const { result: hookResult } = renderHook(() =>
      useAssemblyCompiledBroadInteraction({
        enabled: true,
        publicationReady: true,
        descriptor,
        expectedInteractionOwnerKey: ownerKey,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );
    await waitFor(() => expect(hookResult.current.status).toBe('error'));
    expect(String(hookResult.current.error)).toContain('renderer rejected');
  });

  it('loads already-published interaction before the parent publication session is ready', async () => {
    const { descriptor, ownerKey, result } = await fixture();
    readCompact.mockResolvedValue(result);
    const renderer = {
      loadCompiledBroadAnnotationInteraction: vi.fn(
        (input: ReturnType<typeof compiledBroadInteractionLoadInputV1>) => ({ ...input })
      ),
    };
    const webglRef = {
      current: { getLinearRenderer: () => renderer },
    };

    const { result: hookResult } = renderHook(() =>
      useAssemblyCompiledBroadInteraction({
        enabled: true,
        publicationReady: false,
        descriptor,
        expectedInteractionOwnerKey: ownerKey,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    await waitFor(() => expect(hookResult.current.status).toBe('loaded'));
    expect(readCompact).toHaveBeenCalledWith(descriptor.request, {
      signal: expect.any(AbortSignal),
    });
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenCalledTimes(1);
    expect(renderer.loadCompiledBroadAnnotationInteraction.mock.calls[0]?.[0]).toMatchObject({
      ownerKey,
      sourceFingerprint: result.fingerprint,
      metadata: { trackType: 'enhancer', genomeLengthBp: 3_000 },
    });
    expect(hookResult.current.authority).toBe(
      renderer.loadCompiledBroadAnnotationInteraction.mock.results[0]?.value
    );
    expect(hookResult.current.authority).not.toBe(
      renderer.loadCompiledBroadAnnotationInteraction.mock.calls[0]?.[0]
    );
    expect(hookResult.current.payloadBytes).toBe(result.payload.byteLength);
  });

  it('admits authenticated compact interaction before raster publication names its owner', async () => {
    const { descriptor, ownerKey: sourceOwnerKey, result: compactResult } = await fixture();
    const resealedRasterOwnerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
      sourceFingerprint: compactResult.fingerprint,
      scenePayloadSha256: compactResult.sourceScene.payloadSha256,
      sceneArtifactKey: compactResult.artifact.artifactKey,
    });
    if (!resealedRasterOwnerKey) throw new Error('resealed fixture owner key was invalid');
    readCompact.mockResolvedValue(compactResult);
    const renderer = {
      loadCompiledBroadAnnotationInteraction: vi.fn(
        (input: ReturnType<typeof compiledBroadInteractionLoadInputV1>) => input
      ),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { result: hookResult, rerender } = renderHook(
      ({ expectedOwnerKey }: { expectedOwnerKey: string | null }) =>
        useAssemblyCompiledBroadInteraction({
          enabled: true,
          publicationReady: true,
          descriptor,
          expectedInteractionOwnerKey: expectedOwnerKey,
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: 1,
          webglRef: webglRef as never,
        }),
      { initialProps: { expectedOwnerKey: null as string | null } }
    );

    await waitFor(() => expect(hookResult.current.status).toBe('loaded'));
    expect(hookResult.current.ownerKey).toBe(sourceOwnerKey);
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerKey: sourceOwnerKey })
    );

    rerender({ expectedOwnerKey: resealedRasterOwnerKey });
    await waitFor(() =>
      expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenCalledTimes(2)
    );
    expect(hookResult.current.ownerKey).toBe(resealedRasterOwnerKey);
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerKey: resealedRasterOwnerKey })
    );
    expect(readCompact).toHaveBeenCalledTimes(1);
  });

  it('fails closed before unpacking when the raster names a different parent scene', async () => {
    const { descriptor, result } = await fixture();
    expect(() =>
      compiledBroadInteractionLoadInputV1({
        descriptor,
        expectedInteractionOwnerKey: 'not-the-current-raster-owner',
        result,
      })
    ).toThrow(/currently presented raster owner/);
  });

  it('binds a locally resealed portable child to its published raster parent', async () => {
    const { descriptor, result } = await fixture();
    const publishedOwnerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
      sourceFingerprint: result.fingerprint,
      scenePayloadSha256: result.sourceScene.payloadSha256,
      sceneArtifactKey: result.artifact.artifactKey,
    });
    expect(publishedOwnerKey).not.toBeNull();

    const loadInput = compiledBroadInteractionLoadInputV1({
      descriptor,
      expectedInteractionOwnerKey: publishedOwnerKey!,
      result,
    });

    expect(loadInput.ownerKey).toBe(publishedOwnerKey);
    expect(loadInput.sourceScene.contractSha256).toBe(result.sourceScene.contractSha256);
  });

  it('does not read compact bytes until a concrete renderer exists', async () => {
    const { descriptor, ownerKey } = await fixture();
    const webglRef = { current: { getLinearRenderer: () => null } };
    const { result: hookResult } = renderHook(() =>
      useAssemblyCompiledBroadInteraction({
        enabled: true,
        publicationReady: true,
        descriptor,
        expectedInteractionOwnerKey: ownerKey,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );
    expect(hookResult.current.status).toBe('waiting-renderer');
    expect(readCompact).not.toHaveBeenCalled();
  });

  it('waits through an annotation source handoff without admitting old interaction into the new renderer', async () => {
    const previous = await fixture();
    const next = await fixture('/workspace/annotation-update');
    const previousInput = compiledBroadInteractionLoadInputV1({
      descriptor: previous.descriptor,
      expectedInteractionOwnerKey: previous.ownerKey,
      result: previous.result,
    });
    const nextInput = compiledBroadInteractionLoadInputV1({
      descriptor: next.descriptor,
      expectedInteractionOwnerKey: next.ownerKey,
      result: next.result,
    });
    let currentGenomeIdentity = previousInput.metadata.genomeIdentity;
    const renderer = {
      getAnnotationPolicyReadinessSnapshot: () => ({
        supported: true,
        genomeIdentity: currentGenomeIdentity,
        genomeLengthBp: 3_000,
      }),
      loadCompiledBroadAnnotationInteraction: vi.fn(
        (input: ReturnType<typeof compiledBroadInteractionLoadInputV1>) =>
          input.metadata.genomeIdentity === currentGenomeIdentity ? input : null
      ),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    readCompact.mockResolvedValueOnce(previous.result).mockResolvedValue(next.result);
    const { result: hookResult, rerender } = renderHook(
      ({ descriptor, ownerKey, commitEpoch }) =>
        useAssemblyCompiledBroadInteraction({
          enabled: true,
          publicationReady: true,
          descriptor,
          expectedInteractionOwnerKey: ownerKey,
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: commitEpoch,
          webglRef: webglRef as never,
        }),
      {
        initialProps: {
          descriptor: previous.descriptor as typeof previous.descriptor | null,
          ownerKey: previous.ownerKey,
          commitEpoch: 1,
        },
      }
    );
    await waitFor(() => expect(hookResult.current.status).toBe('loaded'));
    currentGenomeIdentity = nextInput.metadata.genomeIdentity;
    rerender({ descriptor: null, ownerKey: previous.ownerKey, commitEpoch: 2 });
    expect(hookResult.current.status).toBe('waiting-renderer');
    expect(hookResult.current.authority).toBeNull();
    expect(hookResult.current.error).toBeNull();
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenCalledTimes(1);
    rerender({ descriptor: next.descriptor, ownerKey: next.ownerKey, commitEpoch: 2 });
    await waitFor(() => expect(hookResult.current.status).toBe('loaded'));
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerKey: next.ownerKey })
    );
    expect(readCompact).toHaveBeenCalledTimes(2);
  });

  it('still reports a rejected authority when it belongs to the current renderer source', async () => {
    const { descriptor, ownerKey, result: compactResult } = await fixture();
    const input = compiledBroadInteractionLoadInputV1({
      descriptor,
      expectedInteractionOwnerKey: ownerKey,
      result: compactResult,
    });
    readCompact.mockResolvedValue(compactResult);
    const renderer = {
      getAnnotationPolicyReadinessSnapshot: () => ({
        supported: true,
        genomeIdentity: input.metadata.genomeIdentity,
        genomeLengthBp: 3_000,
      }),
      loadCompiledBroadAnnotationInteraction: vi.fn(() => null),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };
    const { result: hookResult } = renderHook(() =>
      useAssemblyCompiledBroadInteraction({
        enabled: true,
        publicationReady: true,
        descriptor,
        expectedInteractionOwnerKey: ownerKey,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );
    await waitFor(() => expect(hookResult.current.status).toBe('error'));
    expect(hookResult.current.error).toMatchObject({
      message: 'The renderer rejected the compact annotation interaction authority.',
    });
  });

  it('retains one immutable read across same-renderer genome commits and re-admits its result', async () => {
    const { descriptor, ownerKey, result: compactResult } = await fixture();
    let resolveRead!: (result: AssemblyCompiledBroadInteractionHitResultV1) => void;
    const pendingRead = new Promise<AssemblyCompiledBroadInteractionHitResultV1>((resolve) => {
      resolveRead = resolve;
    });
    readCompact.mockReturnValue(pendingRead);
    const renderer = {
      loadCompiledBroadAnnotationInteraction: vi.fn(
        (input: ReturnType<typeof compiledBroadInteractionLoadInputV1>) => input
      ),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { result: hookResult, rerender } = renderHook(
      ({
        rendererGenomeCommitEpoch,
        descriptorValue,
      }: {
        rendererGenomeCommitEpoch: number;
        descriptorValue: typeof descriptor | null;
      }) =>
        useAssemblyCompiledBroadInteraction({
          enabled: true,
          publicationReady: true,
          descriptor: descriptorValue,
          expectedInteractionOwnerKey: ownerKey,
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch,
          webglRef: webglRef as never,
        }),
      { initialProps: { rendererGenomeCommitEpoch: 1, descriptorValue: descriptor } }
    );

    await waitFor(() => expect(hookResult.current.status).toBe('loading'));
    expect(readCompact).toHaveBeenCalledTimes(1);
    const firstSignal = readCompact.mock.calls[0]?.[1]?.signal as AbortSignal;

    rerender({ rendererGenomeCommitEpoch: 1, descriptorValue: null });
    expect(readCompact).toHaveBeenCalledTimes(1);
    expect(firstSignal.aborted).toBe(false);

    rerender({
      rendererGenomeCommitEpoch: 2,
      descriptorValue: {
        ...descriptor,
        runtimeCacheKey: `${descriptor.runtimeCacheKey}:late-generation-receipt`,
      },
    });
    expect(readCompact).toHaveBeenCalledTimes(1);
    expect(firstSignal.aborted).toBe(false);

    await act(async () => resolveRead(compactResult));
    await waitFor(() => expect(hookResult.current.status).toBe('loaded'));
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenCalledTimes(1);

    rerender({ rendererGenomeCommitEpoch: 3, descriptorValue: { ...descriptor } });
    await waitFor(() =>
      expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenCalledTimes(2)
    );
    expect(readCompact).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an admitted immutable read when renderer readiness advances', async () => {
    const { descriptor, ownerKey, result: compactResult } = await fixture();
    readCompact.mockResolvedValue(compactResult);
    const renderer = {
      loadCompiledBroadAnnotationInteraction: vi.fn(
        (input: ReturnType<typeof compiledBroadInteractionLoadInputV1>) => input
      ),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { result: hookResult, rerender } = renderHook(
      ({ rendererReadyEpoch }: { rendererReadyEpoch: number }) =>
        useAssemblyCompiledBroadInteraction({
          enabled: true,
          publicationReady: true,
          descriptor,
          expectedInteractionOwnerKey: ownerKey,
          rendererReadyEpoch,
          rendererGenomeCommitEpoch: 1,
          webglRef: webglRef as never,
        }),
      { initialProps: { rendererReadyEpoch: 1 } }
    );

    await waitFor(() => expect(hookResult.current.status).toBe('loaded'));
    expect(readCompact).toHaveBeenCalledTimes(1);

    rerender({ rendererReadyEpoch: 2 });
    await act(async () => Promise.resolve());

    expect(readCompact).toHaveBeenCalledTimes(1);
    expect(hookResult.current.status).toBe('loaded');
  });

  it('keeps one owner and one renderer admission when only the transport contract is resealed', async () => {
    const { descriptor, ownerKey: localOwnerKey, result: compactResult } = await fixture();
    const publishedOwnerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
      sourceFingerprint: compactResult.fingerprint,
      scenePayloadSha256: compactResult.sourceScene.payloadSha256,
      sceneArtifactKey: compactResult.artifact.artifactKey,
    });
    if (!publishedOwnerKey) throw new Error('published fixture owner key was invalid');
    expect(publishedOwnerKey).toBe(localOwnerKey);
    readCompact.mockResolvedValue(compactResult);
    const renderer = {
      loadCompiledBroadAnnotationInteraction: vi.fn(
        (input: ReturnType<typeof compiledBroadInteractionLoadInputV1>) => input
      ),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { result: hookResult, rerender } = renderHook(
      ({ expectedOwnerKey }: { expectedOwnerKey: string }) =>
        useAssemblyCompiledBroadInteraction({
          enabled: true,
          publicationReady: true,
          descriptor,
          expectedInteractionOwnerKey: expectedOwnerKey,
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: 1,
          webglRef: webglRef as never,
        }),
      { initialProps: { expectedOwnerKey: publishedOwnerKey } }
    );

    await waitFor(() => expect(hookResult.current.status).toBe('loaded'));
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerKey: publishedOwnerKey })
    );

    rerender({ expectedOwnerKey: localOwnerKey });
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenCalledTimes(1);
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerKey: localOwnerKey })
    );
    expect(readCompact).toHaveBeenCalledTimes(1);
  });

  it('keeps a legitimate publication race loading until the compact authority appears', async () => {
    const { descriptor, ownerKey, result } = await fixture();
    readCompact.mockResolvedValueOnce(null).mockResolvedValue(result);
    const renderer = {
      loadCompiledBroadAnnotationInteraction: vi.fn(
        (input: ReturnType<typeof compiledBroadInteractionLoadInputV1>) => input
      ),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { result: hookResult } = renderHook(() =>
      useAssemblyCompiledBroadInteraction({
        enabled: true,
        publicationReady: true,
        descriptor,
        expectedInteractionOwnerKey: ownerKey,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    await waitFor(() => expect(readCompact).toHaveBeenCalledTimes(1));
    expect(hookResult.current.status).toBe('loading');
    expect(hookResult.current.error).toBeNull();
    await waitFor(() => expect(hookResult.current.status).toBe('loaded'));
    expect(readCompact).toHaveBeenCalledTimes(2);
    expect(renderer.loadCompiledBroadAnnotationInteraction).toHaveBeenCalledTimes(1);
  });

  it('retains a large-roster compact publication beyond the shared default deadline', async () => {
    const { descriptor, ownerKey } = await fixture();
    readCompact.mockResolvedValue(null);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const renderer = {
      loadCompiledBroadAnnotationInteraction: vi.fn(),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { result: hookResult, unmount } = renderHook(() =>
      useAssemblyCompiledBroadInteraction({
        enabled: true,
        publicationReady: true,
        descriptor,
        expectedInteractionOwnerKey: ownerKey,
        rendererReadyEpoch: 1,
        rendererGenomeCommitEpoch: 1,
        webglRef: webglRef as never,
      })
    );

    await waitFor(() => expect(readCompact).toHaveBeenCalledTimes(1));
    expect(hookResult.current.status).toBe('loading');
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
    unmount();
    timeoutSpy.mockRestore();
  });

  it('fails loudly after a bounded number of unpublished reads', async () => {
    const read = vi.fn(async () => null);
    const controller = new AbortController();

    await expect(
      readNullableAuthorityUntilPublishedV1({
        read,
        signal: controller.signal,
        deadlineMs: 35,
        initialRetryDelayMs: 5,
        maxRetryDelayMs: 10,
      })
    ).rejects.toThrow('was not published within 35 ms');
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(read.mock.calls.length).toBeLessThanOrEqual(6);
    expect((read.mock.calls[0]?.[0] as AbortSignal).aborted).toBe(true);
  });

  it('starts the missing-publication deadline only after its parent session is ready', async () => {
    let publicationReady = false;
    const read = vi.fn(async () => null);
    const controller = new AbortController();
    const pending = readNullableAuthorityUntilPublishedV1({
      read,
      signal: controller.signal,
      deadlineReady: () => publicationReady,
      deadlineMs: 25,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 5,
    });

    await new Promise((resolve) => window.setTimeout(resolve, 40));
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(controller.signal.aborted).toBe(false);

    publicationReady = true;
    await expect(pending).rejects.toThrow('was not published within 25 ms');
  });

  it('cancels the pending publication retry when its viewer identity disappears', async () => {
    const { descriptor, ownerKey } = await fixture();
    readCompact.mockResolvedValue(null);
    const renderer = {
      loadCompiledBroadAnnotationInteraction: vi.fn(
        (input: ReturnType<typeof compiledBroadInteractionLoadInputV1>) => input
      ),
    };
    const webglRef = { current: { getLinearRenderer: () => renderer } };

    const { result: hookResult, rerender } = renderHook(
      ({ enabled }) =>
        useAssemblyCompiledBroadInteraction({
          enabled,
          publicationReady: true,
          descriptor,
          expectedInteractionOwnerKey: ownerKey,
          rendererReadyEpoch: 1,
          rendererGenomeCommitEpoch: 1,
          webglRef: webglRef as never,
        }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(readCompact).toHaveBeenCalledTimes(1));
    const firstSignal = readCompact.mock.calls[0]?.[1]?.signal as AbortSignal;
    rerender({ enabled: false });
    await waitFor(() => expect(hookResult.current.status).toBe('not-applicable'));
    expect(firstSignal.aborted).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 75));
    expect(readCompact).toHaveBeenCalledTimes(1);
    expect(renderer.loadCompiledBroadAnnotationInteraction).not.toHaveBeenCalled();
  });
});
