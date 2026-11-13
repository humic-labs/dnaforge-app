import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  prepackedAnnotationSceneArtifactKey,
} from '@waypoint/genome-renderer';
import {
  buildPartitionedTranscriptScene,
  buildPrepackedAnnotationInteractionIndexV2,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/pure';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
  ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
  ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyAnnotationSceneDetailReadRequestV1,
  type AssemblyAnnotationSceneDetailWireHitResultV1,
  type AssemblyAnnotationSceneWireReadResult,
  type AssemblyCompiledBroadInteractionWireHitResultV1,
  type AssemblyAnnotationSearchQueryRequestV1,
  type AssemblyProteinSearchQueryRequestV1,
  type AssemblySequenceSearchRequestV1,
} from '../shared/indexed-genome';
import {
  electronBridge,
  materializeAssemblyCompiledBroadInteractionWireResultV1,
  materializeAssemblyAnnotationSceneDetailWireResultV1,
  materializeAssemblyAnnotationSceneWireResult,
  resetRetainedTrustedAssemblyAnnotationScenesForTest,
} from './electron';
import { referenceAssemblyById } from '../features/sequence/reference-catalog';
import { chromosomeById } from '../features/sequence/tracks/cytobands';

const SHA = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(24);
const COMPILER_FINGERPRINT = 'c'.repeat(64);
const URL = `waypoint-annotation-scene://artifact/${'A'.repeat(43)}`;
const GRCH38 = referenceAssemblyById('grch38')!;
const FULL_GRCH38_PLACEMENTS = GRCH38.members.map((member) => ({
  chrom: member.chrom,
  length: chromosomeById[member.chrom].length,
  annotationCoverage: 'sourced' as const,
}));

beforeEach(() => {
  resetRetainedTrustedAssemblyAnnotationScenesForTest();
});

const WIRE = {
  status: 'hit',
  ipcContractVersion: 'assembly-annotation-scene-ipc.v4',
  fingerprint: FINGERPRINT,
  sourceBuildFingerprint: COMPILER_FINGERPRINT,
  scope: {
    kind: 'complete-assembly',
    placements: FULL_GRCH38_PLACEMENTS,
  },
  artifact: {},
  byteCount: 4,
  manifest: { integrity: { payloadSha256: SHA } },
  resource: {
    url: URL,
    expiresAtMs: 2_000,
    byteCount: 4,
    payloadSha256: SHA,
  },
} as unknown as AssemblyAnnotationSceneWireReadResult;

function validHeaders(): Headers {
  return new Headers({
    'content-length': '4',
    'x-waypoint-scene-sha256': SHA,
    'x-waypoint-scene-fingerprint': FINGERPRINT,
    'x-waypoint-scene-compiler-fingerprint': COMPILER_FINGERPRINT,
  });
}

describe('Electron annotation-scene resource materialization', () => {
  it('owns the fetched ArrayBuffer in the renderer and restores the public Uint8Array shape', async () => {
    const ownedBuffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const arrayBuffer = vi.fn(async () => ownedBuffer);
    const fetchResource = vi.fn(
      async () =>
        ({
          ok: true,
          headers: validHeaders(),
          arrayBuffer,
        }) as unknown as Response
    );

    const result = await materializeAssemblyAnnotationSceneWireResult(WIRE, undefined, {
      now: () => 1_000,
      fetchResource,
    });

    expect(fetchResource).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'omit' })
    );
    expect(result).toMatchObject({ status: 'hit', byteCount: 4 });
    expect(result && result.status === 'hit' ? result.payload.buffer : null).toBe(ownedBuffer);
    expect(result && 'resource' in result).toBe(false);
  });

  it('materializes colour roles beside the scene and drops only them when they fail', async () => {
    const ROLE_SHA = 'd'.repeat(64);
    const ROLE_URL = `waypoint-annotation-scene://artifact/${'B'.repeat(43)}`;
    const wire = {
      ...WIRE,
      colorRoles: {
        roleTable: ['transcript:intron', 'transcript:cdsThick'],
        expandedCount: 2,
        canonicalCount: 1,
        resource: { url: ROLE_URL, expiresAtMs: 2_000, byteCount: 3, payloadSha256: ROLE_SHA },
      },
    } as unknown as AssemblyAnnotationSceneWireReadResult;
    const respond = (url: string, roleOk: boolean) => {
      if (url === URL) {
        return {
          ok: true,
          headers: validHeaders(),
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        } as unknown as Response;
      }
      if (!roleOk) throw new Error('role fetch failed');
      return {
        ok: true,
        headers: new Headers({
          'content-length': '3',
          'x-waypoint-scene-sha256': ROLE_SHA,
          'x-waypoint-scene-fingerprint': FINGERPRINT,
          'x-waypoint-scene-compiler-fingerprint': COMPILER_FINGERPRINT,
        }),
        arrayBuffer: async () => new Uint8Array([1, 0, 1]).buffer,
      } as unknown as Response;
    };

    const withRoles = await materializeAssemblyAnnotationSceneWireResult(wire, undefined, {
      now: () => 1_000,
      fetchResource: vi.fn(async (url: string | URL | Request) => respond(String(url), true)),
    });
    if (!withRoles || withRoles.status !== 'hit') throw new Error('expected a hit');
    expect(withRoles.colorRoles?.roleTable).toEqual(['transcript:intron', 'transcript:cdsThick']);
    expect(Array.from(withRoles.colorRoles?.expandedRoleIndices ?? [])).toEqual([1, 0]);
    expect(Array.from(withRoles.colorRoles?.canonicalRoleIndices ?? [])).toEqual([1]);

    const withoutRoles = await materializeAssemblyAnnotationSceneWireResult(wire, undefined, {
      now: () => 1_000,
      fetchResource: vi.fn(async (url: string | URL | Request) => respond(String(url), false)),
    });
    expect(withoutRoles).toMatchObject({ status: 'hit', byteCount: 4 });
    expect(withoutRoles && 'colorRoles' in withoutRoles).toBe(false);
  });

  it('materializes a compact interaction only when it names the exact parent scene', async () => {
    const sourceScene = {
      byteCount: 300_607_490,
      payloadSha256: 'd'.repeat(64),
      contractSha256: 'e'.repeat(64),
    };
    const wire = {
      contract: ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
      status: 'hit',
      authorityKind: 'portable',
      origin: 'durable-hit',
      fingerprint: FINGERPRINT,
      sourceBuildFingerprint: COMPILER_FINGERPRINT,
      scope: WIRE.status === 'hit' ? WIRE.scope : null,
      artifact: WIRE.status === 'hit' ? WIRE.artifact : null,
      sourceScene,
      byteCount: 4,
      manifest: {
        sourceScene: {
          schema: 'partitioned-transcript-scene-binary.v4',
          byteLength: sourceScene.byteCount,
          payloadSha256: sourceScene.payloadSha256,
          contractSha256: sourceScene.contractSha256,
        },
        integrity: { payloadSha256: SHA },
      },
      resource: {
        url: URL,
        expiresAtMs: 2_000,
        byteCount: 4,
        payloadSha256: SHA,
      },
    } as unknown as AssemblyCompiledBroadInteractionWireHitResultV1;
    const ownedBuffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await materializeAssemblyCompiledBroadInteractionWireResultV1(wire, undefined, {
      now: () => 1_000,
      fetchResource: async () =>
        ({
          ok: true,
          headers: validHeaders(),
          arrayBuffer: async () => ownedBuffer,
        }) as unknown as Response,
    });
    expect(result?.payload.buffer).toBe(ownedBuffer);
    expect(result && 'resource' in result).toBe(false);

    await expect(
      materializeAssemblyCompiledBroadInteractionWireResultV1({
        ...wire,
        sourceScene: { ...wire.sourceScene, payloadSha256: 'f'.repeat(64) },
      })
    ).rejects.toMatchObject({ code: 'invalid-capability' });
  });

  it('materializes bounded detail only for its exact source, scope, and requested range', async () => {
    const artifact = {
      artifactKey: 'exact-detail-test',
      themeMode: 'dark' as const,
      trackType: 'mRNA',
      partitionSpanBp: 100_000_000,
      annotationBarHeightPx: 4,
      laneAlgorithmToken: 'lane-v1',
      mapperContractToken: 'mapper-v1',
      geometryContractToken: 'geometry-v1',
      interactionContractToken: 'interaction-v1',
    };
    const chromosomes = GRCH38.members.map((member) => ({
      chrom: member.chrom,
      sourcePath: `/workspace/${member.relativePath}`,
      length: chromosomeById[member.chrom].length,
    }));
    const request = {
      contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
      source: {
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        assemblyId: 'grch38',
        workspaceRoot: '/workspace',
        chromosomes,
        scope: { kind: 'complete-assembly', placements: FULL_GRCH38_PLACEMENTS },
        datasetContract: {
          datasetId: 'gencode',
          datasetVersion: 'test',
          sourceSha256: 'd'.repeat(64),
        },
        artifact,
      },
      startBp: 500_000_000,
      endBp: 501_000_000,
    } satisfies AssemblyAnnotationSceneDetailReadRequestV1;
    const wire = {
      contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
      status: 'hit',
      fingerprint: FINGERPRINT,
      sourceBuildFingerprint: COMPILER_FINGERPRINT,
      scope: request.source.scope,
      artifact,
      byteCount: 4,
      manifest: {
        requestedRange: { startBp: request.startBp, endBp: request.endBp },
        assemblyLengthBp: chromosomes.reduce((sum, chromosome) => sum + chromosome.length, 0),
        partitionSpanBp: artifact.partitionSpanBp,
        byteLength: 4,
        integrity: { payloadSha256: SHA },
      },
      resource: {
        url: URL,
        expiresAtMs: 2_000,
        byteCount: 4,
        payloadSha256: SHA,
      },
    } as unknown as AssemblyAnnotationSceneDetailWireHitResultV1;
    const ownedBuffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await materializeAssemblyAnnotationSceneDetailWireResultV1(
      request,
      wire,
      undefined,
      {
        now: () => 1_000,
        fetchResource: async () =>
          ({
            ok: true,
            headers: validHeaders(),
            arrayBuffer: async () => ownedBuffer,
          }) as unknown as Response,
      }
    );
    expect(result?.payload.buffer).toBe(ownedBuffer);
    expect(result && 'resource' in result).toBe(false);

    await expect(
      materializeAssemblyAnnotationSceneDetailWireResultV1(request, {
        contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
        status: 'unavailable',
        reason: 'range-catalog-unavailable',
        fingerprint: FINGERPRINT,
        sourceBuildFingerprint: COMPILER_FINGERPRINT,
        scope: request.source.scope,
        artifact,
      })
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'range-catalog-unavailable',
      artifact,
    });

    await expect(
      materializeAssemblyAnnotationSceneDetailWireResultV1(request, {
        ...wire,
        manifest: {
          ...wire.manifest,
          requestedRange: { startBp: request.startBp + 1, endBp: request.endBp },
        },
      })
    ).rejects.toMatchObject({ code: 'invalid-capability' });
  });

  it('fails closed before reading the body when protocol integrity headers disagree', async () => {
    const arrayBuffer = vi.fn();
    const headers = validHeaders();
    headers.set('x-waypoint-scene-sha256', 'd'.repeat(64));
    await expect(
      materializeAssemblyAnnotationSceneWireResult(WIRE, undefined, {
        now: () => 1_000,
        fetchResource: async () => ({ ok: true, headers, arrayBuffer }) as unknown as Response,
      })
    ).rejects.toMatchObject({
      name: 'AnnotationSceneResourceMaterializationError',
      code: 'invalid-response',
    });

    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('surfaces a custom-protocol fetch failure instead of disguising a validated hit as a miss', async () => {
    await expect(
      materializeAssemblyAnnotationSceneWireResult(WIRE, undefined, {
        now: () => 1_000,
        fetchResource: async () => {
          throw new TypeError('URL scheme is not supported');
        },
      })
    ).rejects.toMatchObject({
      name: 'AnnotationSceneResourceMaterializationError',
      code: 'resource-fetch-failed',
    });
  });

  it('propagates renderer cancellation and passes its AbortSignal to fetch', async () => {
    const controller = new AbortController();
    const fetchResource = vi.fn(async (_url: string, init?: RequestInit) => {
      controller.abort();
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;

    await expect(
      materializeAssemblyAnnotationSceneWireResult(
        WIRE,
        { signal: controller.signal },
        { now: () => 1_000, fetchResource }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('mints trusted decode authority only for the exact transport-admitted hit object', async () => {
    const sourceSha256 = 'd'.repeat(64);
    const artifact = {
      artifactKey: prepackedAnnotationSceneArtifactKey({ themeMode: 'light', trackType: 'mRNA' }),
      themeMode: 'light' as const,
      trackType: 'mRNA',
      partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
      annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
      laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
      mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    };
    const chromosomes = GRCH38.members.map((member) => ({
      chrom: member.chrom,
      sourcePath: `/workspace/${member.relativePath}`,
      length: chromosomeById[member.chrom].length,
    }));
    const assemblyLengthBp = chromosomes.reduce((sum, chromosome) => sum + chromosome.length, 0);
    const request: AssemblyAnnotationSceneReadRequest = {
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      assemblyId: 'grch38',
      workspaceRoot: '/workspace',
      chromosomes,
      scope: {
        kind: 'complete-assembly',
        placements: chromosomes.map(({ chrom, length }) => ({
          chrom,
          length,
          annotationCoverage: 'sourced' as const,
        })),
      },
      datasetContract: {
        datasetId: 'waypoint:assembly-annotation:grch38',
        datasetVersion: 'fixture-v1',
        sourceSha256,
      },
      artifact,
      requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
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
    const scene = buildPartitionedTranscriptScene(
      primitives,
      PREPACKED_ANNOTATION_PARTITION_SPAN_BP
    );
    const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 1,
          startBp: 10,
          endBp: 20,
          lane: 0,
          direction: 'forward',
          displayName: 'fixture',
          type: 'mRNA',
          transcriptId: 'tx-1',
          sourceId: 'source-1',
          canonicalIdentity: 'canonical-1',
        },
      ],
      primitives
    );
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: request.datasetContract,
      assemblyContract: { assemblyId: request.assemblyId, assemblyLengthBp },
      families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: new Uint32Array([0]),
      scene,
      interactionIndex,
      policyProjection: {
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
      },
    });
    const wire = {
      status: 'hit',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: FINGERPRINT,
      sourceBuildFingerprint: COMPILER_FINGERPRINT,
      scope: request.scope,
      artifact,
      byteCount: packed.payload.byteLength,
      manifest: packed.manifest,
      resource: {
        url: URL,
        expiresAtMs: Date.now() + 10_000,
        byteCount: packed.payload.byteLength,
        payloadSha256: packed.manifest.integrity.payloadSha256,
      },
    } as AssemblyAnnotationSceneWireReadResult;
    const headers = new Headers({
      'content-length': String(packed.payload.byteLength),
      'x-waypoint-scene-sha256': packed.manifest.integrity.payloadSha256,
      'x-waypoint-scene-fingerprint': FINGERPRINT,
      'x-waypoint-scene-compiler-fingerprint': COMPILER_FINGERPRINT,
    });
    window.electronAPI = {
      genome: { readAssemblyAnnotationScene: vi.fn(async () => wire) },
    } as never;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers,
        arrayBuffer: async () => packed.payload.slice().buffer,
      }))
    );

    const retainedAssetGeneration = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: FINGERPRINT,
      inventoryFingerprint: 'e'.repeat(64),
      themeMode: 'light' as const,
    };
    const result = await electronBridge.genome.readAssemblyAnnotationScene(request, {
      retainedAssetGeneration,
    });
    expect(result?.status).toBe('hit');
    const trusted = electronBridge.genome.getTrustedAssemblyAnnotationScene(result!);
    expect(trusted).toMatchObject({
      rendererAdmissionProvenance: {
        sourceSha256,
        assemblyId: 'grch38',
        assemblyLengthBp,
      },
      rendererAdmissionLoadIdentity: {
        genomeIdentity: `assembly-annotation-source-sha256.v1:${sourceSha256}`,
        artifactKey: artifact.artifactKey,
      },
    });
    expect(electronBridge.genome.getTrustedAssemblyAnnotationScene({ ...result! })).toBeNull();

    const reopened = await electronBridge.genome.readAssemblyAnnotationScene(request, {
      retainedAssetGeneration,
    });
    expect(reopened).toBe(result);
    expect(window.electronAPI.genome.readAssemblyAnnotationScene).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    const reopenedAcrossPublicationEnvelope =
      await electronBridge.genome.readAssemblyAnnotationScene(request, {
        retainedAssetGeneration: {
          ...retainedAssetGeneration,
          inventoryFingerprint: 'f'.repeat(64),
        },
        retainedInteractionOwnerKey: assemblyAnnotationSceneInteractionOwnerKeyV3({
          sourceFingerprint: FINGERPRINT,
          scenePayloadSha256: packed.manifest.integrity.payloadSha256,
          sceneArtifactKey: artifact.artifactKey,
        }),
      });
    expect(reopenedAcrossPublicationEnvelope).toBe(result);
    expect(window.electronAPI.genome.readAssemblyAnnotationScene).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bridges a renderer abort to one exact main cancellation and removes the listener', async () => {
    let resolveQuery!: (value: null) => void;
    const query = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveQuery = resolve;
        })
    );
    const cancel = vi.fn(async () => true);
    window.electronAPI = {
      genome: {
        queryAssemblyAnnotationSearch: query,
        cancelAssemblyAnnotationSearch: cancel,
      },
    } as never;
    const request = {
      source: {} as AssemblyAnnotationSceneReadRequest,
      clientId: 'find-client-a',
      requestId: 'find-request-7',
      query: 'HBB',
      limit: 500,
    } satisfies AssemblyAnnotationSearchQueryRequestV1;
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = electronBridge.genome.queryAssemblyAnnotationSearch(request, {
      signal: controller.signal,
    });
    controller.abort();

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith({
      clientId: request.clientId,
      requestId: request.requestId,
    });
    resolveQuery(null);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('bridges a protein-search abort to the exact main request without cloning the signal', async () => {
    let resolveQuery!: (value: null) => void;
    const query = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveQuery = resolve;
        })
    );
    const cancel = vi.fn(async () => true);
    window.electronAPI = {
      genome: {
        queryAssemblyProteinSearch: query,
        cancelAssemblyProteinSearch: cancel,
      },
    } as never;
    const request = {
      source: {} as AssemblyAnnotationSceneReadRequest,
      clientId: 'find-client-protein',
      requestId: 'find-request-protein-2',
      query: 'PEPTI',
      limit: 500,
    } satisfies AssemblyProteinSearchQueryRequestV1;
    const controller = new AbortController();

    const pending = electronBridge.genome.queryAssemblyProteinSearch(request, {
      signal: controller.signal,
    });
    controller.abort();

    expect(query).toHaveBeenCalledWith(request);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith({
      clientId: request.clientId,
      requestId: request.requestId,
    });
    resolveQuery(null);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps nucleotide abort signals renderer-local and cancels the exact main request once', async () => {
    let resolveQuery!: (value: []) => void;
    const query = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveQuery = resolve;
        })
    );
    const cancel = vi.fn(async () => true);
    window.electronAPI = {
      genome: {
        searchSequence: query,
        cancelSequenceSearch: cancel,
      },
    } as never;
    const manifest = {
      chrom: 'chr11',
      fastaPath: '/workspace/chr11.fa',
      faiPath: '/workspace/chr11.fa.fai',
    };
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const control = {
      clientId: 'find-client-a',
      requestId: 'find-request-8',
      signal: controller.signal,
    };

    const pending = electronBridge.genome.searchSequence(
      manifest,
      'chr11',
      'ACGT',
      { maxResults: 500, reverseComplement: true },
      control
    );
    expect(query).toHaveBeenCalledWith(
      manifest,
      'chr11',
      'ACGT',
      { maxResults: 500, reverseComplement: true },
      { clientId: control.clientId, requestId: control.requestId }
    );
    expect(query.mock.calls[0]?.[4]).not.toHaveProperty('signal');

    controller.abort();
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith({
      clientId: control.clientId,
      requestId: control.requestId,
    });

    resolveQuery([]);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('keeps assembly nucleotide abort signals renderer-local and cancels the exact main request', async () => {
    let resolveQuery!: (value: { hits: []; truncated: false }) => void;
    const query = vi.fn(
      () =>
        new Promise<{ hits: []; truncated: false }>((resolve) => {
          resolveQuery = resolve;
        })
    );
    const cancel = vi.fn(async () => true);
    window.electronAPI = {
      genome: {
        searchAssemblySequence: query,
        cancelSequenceSearch: cancel,
      },
    } as never;
    const request = {
      source: {
        contract: ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
        assemblyId: 'assembly-a',
        chromosomes: [
          {
            chrom: 'chr11',
            length: 135_086_622,
            manifest: {
              chrom: 'chr11',
              fastaPath: '/workspace/chr11.fa',
              faiPath: '/workspace/chr11.fa.fai',
              length: 135_086_622,
            },
          },
        ],
      },
      clientId: 'find-client-a',
      requestId: 'find-request-assembly-9',
      motif: 'ACGT',
      limit: 500,
      reverseComplement: true,
    } satisfies AssemblySequenceSearchRequestV1;
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = electronBridge.genome.searchAssemblySequence(request, {
      signal: controller.signal,
    });
    expect(query).toHaveBeenCalledWith(request);
    expect(query.mock.calls[0]?.[0]).not.toHaveProperty('signal');

    controller.abort();
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith({
      clientId: request.clientId,
      requestId: request.requestId,
    });

    resolveQuery({ hits: [], truncated: false });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
