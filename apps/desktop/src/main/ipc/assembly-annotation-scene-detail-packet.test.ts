import { createHash } from 'node:crypto';

import {
  buildPartitionedTranscriptScene,
  buildPartitionedTranscriptSceneRangeCatalogV1,
  buildPrepackedAnnotationInteractionIndexV2,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
} from '@waypoint/genome-renderer/pure';
import { describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import { readAssemblyAnnotationSceneDetailPacketV1 } from './assembly-annotation-scene-detail-packet';
import type { AssemblyAnnotationSceneCacheIndexHit } from './assembly-overview-texture-cache';

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex');

describe('assembly annotation scene detail packet', () => {
  it('reads bounded authenticated ranges and rechecks the parent after I/O', async () => {
    const fixture = await buildFixture();
    const readIndex = vi.fn(async () => fixture.index);
    const reads: Array<{ offset: number; length: number }> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await readAssemblyAnnotationSceneDetailPacketV1(
      {
        contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
        source: REQUEST,
        startBp: 120,
        endBp: 140,
      },
      {
        readIndex,
        readRange: async (_path, range) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            reads.push({ offset: range.byteOffset, length: range.byteLength });
            await Promise.resolve();
            return fixture.payload.slice(range.byteOffset, range.byteOffset + range.byteLength);
          } finally {
            inFlight -= 1;
          }
        },
      }
    );

    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(reads).toHaveLength(7);
    expect(maxInFlight).toBe(7);
    if (result?.status !== 'hit') throw new Error('detail packet read did not return a hit');
    expect(result?.packet.manifest.selectedPartitionIndices).toEqual([1]);
    expect(result?.packet.payload.byteLength).toBeLessThan(fixture.payload.byteLength);
    expect(result?.fingerprint).toBe(fixture.index.fingerprint);
  });

  it("attaches the packet records' colour roles cut from the parent roles", async () => {
    const fixture = await buildFixture();
    const roleSidecar = {
      payloadPath: '/fixture/scene.annotation-roles.v1.bin',
      byteCount: 4,
      payloadSha256: '4'.repeat(64),
      roleTable: ['transcript:intron', 'transcript:utr'],
      expandedCount: 2,
      canonicalCount: 2,
    } as NonNullable<AssemblyAnnotationSceneCacheIndexHit['roleSidecar']>;
    const readRoleSidecar = vi.fn(async () => ({
      roleTable: ['transcript:intron', 'transcript:utr'] as const,
      expandedRoleIndices: Uint8Array.of(0, 1),
      canonicalRoleIndices: Uint8Array.of(0, 1),
    }));
    const result = await readAssemblyAnnotationSceneDetailPacketV1(
      {
        contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
        source: REQUEST,
        startBp: 120,
        endBp: 140,
      },
      {
        readIndex: async () => ({ ...fixture.index, roleSidecar }),
        readRange: async (_path, range) =>
          fixture.payload.slice(range.byteOffset, range.byteOffset + range.byteLength),
        readRoleSidecar: readRoleSidecar as never,
      }
    );
    expect(readRoleSidecar).toHaveBeenCalledWith(roleSidecar);
    expect(result?.status).toBe('hit');
    const hit = result as Extract<typeof result, { status: 'hit' }>;
    expect(hit.colorRoles?.roleTable).toEqual(['transcript:intron', 'transcript:utr']);
    expect(Array.from(hit.colorRoles!.expandedRoleIndices)).toEqual([1]);
    expect(Array.from(hit.colorRoles!.canonicalRoleIndices)).toEqual([1]);
  });

  it('does not publish a packet when the parent scene changes during the read', async () => {
    const fixture = await buildFixture();
    const readIndex = vi
      .fn()
      .mockResolvedValueOnce(fixture.index)
      .mockResolvedValueOnce({
        ...fixture.index,
        payloadSha256: 'b'.repeat(64),
      });

    await expect(
      readAssemblyAnnotationSceneDetailPacketV1(
        {
          contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
          source: REQUEST,
          startBp: 120,
          endBp: 140,
        },
        {
          readIndex,
          readRange: async (_path, range) =>
            fixture.payload.slice(range.byteOffset, range.byteOffset + range.byteLength),
        }
      )
    ).resolves.toBeNull();
  });

  it('distinguishes a prepared legacy scene without a range catalog from a transient miss', async () => {
    const fixture = await buildFixture();
    const { detailRangeCatalog: _detailRangeCatalog, ...legacyIndex } = fixture.index;

    await expect(
      readAssemblyAnnotationSceneDetailPacketV1(
        {
          contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
          source: REQUEST,
          startBp: 120,
          endBp: 140,
        },
        { readIndex: async () => legacyIndex }
      )
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'range-catalog-unavailable',
      fingerprint: fixture.index.fingerprint,
      artifact: fixture.index.artifact,
    });

    await expect(
      readAssemblyAnnotationSceneDetailPacketV1(
        {
          contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
          source: REQUEST,
          startBp: 120,
          endBp: 140,
        },
        { readIndex: async () => ({ status: 'miss' }) as never }
      )
    ).resolves.toBeNull();
  });
});

async function buildFixture(): Promise<{
  payload: Uint8Array;
  index: AssemblyAnnotationSceneCacheIndexHit;
}> {
  const scene = buildPartitionedTranscriptScene(
    [
      {
        startBp: 10,
        endBp: 40,
        featureIndex: 0,
        offsetCenter: -7,
        halfH: 7,
        color: 0x123456,
        alpha: 1,
        cdsFade: 0,
        dirSign: 1,
      },
      {
        startBp: 110,
        endBp: 160,
        featureIndex: 1,
        offsetCenter: -23,
        halfH: 7,
        color: 0x123456,
        alpha: 1,
        cdsFade: 0,
        dirSign: 1,
      },
    ],
    100
  );
  const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
    datasetContract: REQUEST.datasetContract,
    assemblyContract: { assemblyId: 'fixture', assemblyLengthBp: 300 },
    families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
    featureFamilyIndices: new Uint32Array([0, 0]),
    scene,
    interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
      [interactionFeature(0, 10, 40, 0), interactionFeature(1, 110, 160, 1)],
      scene.sortedPrimitives
    ),
    policyProjection: {
      features: [policyFeature(0), policyFeature(1)],
      expandedBandOrder: ['mRNA'],
      canonicalBandOrder: ['mRNA'],
    },
    payloadSha256: sha256,
  });
  const detailRangeCatalog = await buildPartitionedTranscriptSceneRangeCatalogV1(
    packed.manifest,
    packed.payload,
    sha256
  );
  return {
    payload: packed.payload,
    index: {
      status: 'hit',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: '1'.repeat(24),
      sourceBuildFingerprint: '2'.repeat(64),
      scope: REQUEST.scope,
      artifact: REQUEST.artifact,
      byteCount: packed.payload.byteLength,
      manifest: packed.manifest,
      scenePath: '/fixture/scene.bin',
      payloadSha256: packed.manifest.integrity.payloadSha256,
      placementFingerprint: `ap1:${'3'.repeat(24)}`,
      detailRangeCatalog,
    },
  };
}

const REQUEST: AssemblyAnnotationSceneReadRequest = {
  ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyId: 'fixture',
  workspaceRoot: '/fixture',
  chromosomes: [{ chrom: 'chr1', length: 300, sourcePath: '/fixture/chr1.gff3' }],
  scope: {
    kind: 'complete-assembly',
    placements: [{ chrom: 'chr1', length: 300, annotationCoverage: 'sourced' }],
  },
  datasetContract: {
    datasetId: 'fixture',
    datasetVersion: '1',
    sourceSha256: 'a'.repeat(64),
  },
  artifact: {
    artifactKey: 'fixture-artifact',
    themeMode: 'dark',
    trackType: 'mRNA',
    partitionSpanBp: 100,
    annotationBarHeightPx: 14,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  },
  requestedPolicy: { isoformMode: 'expanded', laneLimit: null },
};

function interactionFeature(rendererId: number, startBp: number, endBp: number, lane: number) {
  return {
    rendererId,
    startBp,
    endBp,
    lane,
    direction: 'forward' as const,
    displayName: `feature-${rendererId}`,
    type: 'mRNA',
    transcriptId: `TX-${rendererId}`,
    sourceId: `source-${rendererId}`,
    canonicalIdentity: `fixture|mRNA|${rendererId}`,
  };
}

function policyFeature(trackLane: number) {
  return {
    annotationType: 'mRNA',
    expandedLane: trackLane,
    expandedTrackLane: trackLane,
    canonicalLane: trackLane,
    canonicalTrackLane: trackLane,
  };
}
