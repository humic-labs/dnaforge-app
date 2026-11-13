import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import { buildPartitionedTranscriptScene } from './partitioned-transcript-scene';
import {
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  unpackPartitionedTranscriptSceneBinaryV4,
} from './partitioned-transcript-scene-binary-v4';
import {
  packPartitionedTranscriptSceneDetailPacketV1,
  bindPartitionedTranscriptSceneDetailInteractionV1,
  bindTrustedPartitionedTranscriptSceneDetailInteractionV1,
  isTrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1,
  isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1,
  slicePartitionedTranscriptSceneDetailRolesV1,
  unpackPartitionedTranscriptSceneDetailPacketV1,
} from './partitioned-transcript-scene-detail-packet-v1';
import { buildPartitionedTranscriptSceneRangeCatalogV1 } from './partitioned-transcript-scene-range-catalog-v1';
import {
  buildPrepackedAnnotationInteractionIndexV2,
  queryPrepackedAnnotationInteractionIndexV2,
  validatePrepackedAnnotationInteractionIndexV2,
  validatePrepackedAnnotationViewportInteractionVisualCouplingV2,
} from './prepacked-annotation-interaction-index-v2';

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex');

describe('partitioned transcript scene detail packet v1', () => {
  it('cuts colour roles for exactly the packet records from the parent roles', async () => {
    const source = [
      primitive(0, 10, 40, 0),
      primitive(1, 110, 160, 1),
      primitive(2, 120, 150, 2),
      primitive(3, 210, 260, 3),
    ];
    const scene = buildPartitionedTranscriptScene(source, 100);
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: { datasetId: 'fixture', datasetVersion: '1', sourceSha256: 'a'.repeat(64) },
      assemblyContract: { assemblyId: 'fixture', assemblyLengthBp: 300 },
      families: [{ id: 'transcript-glyph-v2', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: new Uint32Array([0, 0, 0, 0]),
      scene,
      interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
        [
          interactionFeature(0, 10, 40, 0),
          interactionFeature(1, 110, 160, 1),
          interactionFeature(2, 120, 150, 2),
          interactionFeature(3, 210, 260, 3),
        ],
        scene.sortedPrimitives
      ),
      policyProjection: {
        features: [
          policyFeature(0, 0),
          policyFeature(1, 1),
          policyFeature(2, 2),
          policyFeature(3, 3),
        ],
        expandedBandOrder: ['mRNA'],
        canonicalBandOrder: ['mRNA'],
      },
      payloadSha256: sha256,
    });
    const catalog = await buildPartitionedTranscriptSceneRangeCatalogV1(
      packed.manifest,
      packed.payload,
      sha256
    );
    const full = await unpackPartitionedTranscriptSceneBinaryV4(packed.manifest, packed.payload);
    const parent = {
      roleTable: ['source:000000', 'source:000001', 'source:000002', 'source:000003'] as const,
      expandedRoleIndices: Uint8Array.from(full.submissionBank.expanded.featureIndices),
      canonicalRoleIndices: Uint8Array.from(full.submissionBank.canonical.featureIndices),
    };
    const detail = await packPartitionedTranscriptSceneDetailPacketV1({
      sourceManifest: packed.manifest,
      rangeCatalog: catalog,
      startBp: 115,
      endBp: 230,
      readRange: async (range) =>
        packed.payload.slice(range.byteOffset, range.byteOffset + range.byteLength),
      payloadSha256: sha256,
    });
    const unpacked = await unpackPartitionedTranscriptSceneDetailPacketV1(
      detail.manifest,
      detail.payload,
      sha256
    );
    const roles = slicePartitionedTranscriptSceneDetailRolesV1(
      catalog,
      detail.manifest.selectedPartitionIndices,
      { ...parent, roleTable: [...parent.roleTable] }
    );
    expect(detail.manifest.selectedPartitionIndices).toEqual([1, 2]);
    expect(Array.from(roles!.expandedRoleIndices)).toEqual(
      Array.from(unpacked.submissionBank.expanded.featureIndices)
    );
    expect(Array.from(roles!.canonicalRoleIndices)).toEqual(
      Array.from(unpacked.submissionBank.canonical.featureIndices)
    );
    expect(
      slicePartitionedTranscriptSceneDetailRolesV1(catalog, [1], {
        ...parent,
        roleTable: [...parent.roleTable],
        expandedRoleIndices: parent.expandedRoleIndices.subarray(1),
      })
    ).toBeNull();
  });

  it('admits only exact viewport partitions while preserving both policy banks', async () => {
    const source = [primitive(0, 10, 40, 0), primitive(1, 110, 160, 1)];
    const scene = buildPartitionedTranscriptScene(source, 100);
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: {
        datasetId: 'fixture',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: { assemblyId: 'fixture', assemblyLengthBp: 300 },
      families: [{ id: 'transcript-glyph-v2', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: new Uint32Array([0, 0]),
      scene,
      interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
        [interactionFeature(0, 10, 40, 0), interactionFeature(1, 110, 160, 1)],
        scene.sortedPrimitives
      ),
      policyProjection: {
        features: [policyFeature(0, 0), policyFeature(1, 1)],
        expandedBandOrder: ['mRNA'],
        canonicalBandOrder: ['mRNA'],
      },
      payloadSha256: sha256,
    });
    const catalog = await buildPartitionedTranscriptSceneRangeCatalogV1(
      packed.manifest,
      packed.payload,
      sha256
    );

    const detail = await packPartitionedTranscriptSceneDetailPacketV1({
      sourceManifest: packed.manifest,
      rangeCatalog: catalog,
      startBp: 120,
      endBp: 140,
      readRange: async (range) =>
        packed.payload.slice(range.byteOffset, range.byteOffset + range.byteLength),
      payloadSha256: sha256,
    });
    const unpacked = await unpackPartitionedTranscriptSceneDetailPacketV1(
      detail.manifest,
      detail.payload,
      sha256
    );
    const full = await unpackPartitionedTranscriptSceneBinaryV4(packed.manifest, packed.payload);

    expect(detail.manifest.selectedPartitionIndices).toEqual([1]);
    expect(detail.payload.byteLength).toBeLessThan(packed.payload.byteLength);
    expect(unpacked.empty).toBe(false);
    expect(Array.from(unpacked.submissionBank.expanded.featureIndices)).toEqual([1]);
    expect(Array.from(unpacked.submissionBank.canonical.featureIndices)).toEqual([1]);
    expect(Array.from(unpacked.submissionBank.expanded.packedInstanceData)).toEqual(
      Array.from(
        full.submissionBank.expanded.packedInstanceData.subarray(
          full.submissionBank.expanded.partitions[1]!.firstInstance * 12,
          (full.submissionBank.expanded.partitions[1]!.firstInstance + 1) * 12
        )
      )
    );
    expect(unpacked.submissionFineIndices.expanded.bankRecordIndices).toHaveLength(1);
    expect(unpacked.submissionFineIndices.canonical.bankRecordIndices).toHaveLength(1);
    expect(Array.from(unpacked.interactionPrimitiveCsr.featurePrimitiveOffsets)).toEqual([0, 1]);
    expect(Array.from(unpacked.interactionPrimitiveCsr.featurePrimitiveIndices)).toEqual([0]);
    expect(Array.from(unpacked.interactionPrimitiveCsr.activeFeatureIndices)).toEqual([1]);
    expect(unpacked.interactionPrimitiveCsr.featurePrimitiveOffsets.buffer).toBe(
      detail.payload.buffer
    );
    const admissionBinding = {
      scene: unpacked.scene,
      submissionBank: unpacked.submissionBank,
      submissionFineIndices: unpacked.submissionFineIndices,
      featureFamilyIndices: unpacked.featureFamilyIndices,
    };
    expect(
      isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1(
        unpacked.rendererAdmissionCapability,
        admissionBinding
      )
    ).toBe(true);
    expect(
      isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1(
        { ...unpacked.rendererAdmissionCapability },
        admissionBinding
      )
    ).toBe(false);
    expect(
      isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1(
        unpacked.rendererAdmissionCapability,
        { ...admissionBinding, scene: { ...unpacked.scene } }
      )
    ).toBe(false);
    const interaction = bindPartitionedTranscriptSceneDetailInteractionV1(
      detail.manifest,
      unpacked.scene,
      full.interactionIndex
    );
    expect(interaction.primitiveCount).toBe(1);
    expect(Array.from(interaction.featurePrimitiveOffsets)).toEqual([0, 1]);
    expect(Array.from(interaction.featurePrimitiveIndices)).toEqual([0]);
    expect(interaction.intervalFeatureIndices).toBe(full.interactionIndex.intervalFeatureIndices);
    expect(interaction.intervalSubtreeMaxEndBytes).toBe(
      full.interactionIndex.intervalSubtreeMaxEndBytes
    );
    const activeHits: number[] = [];
    queryPrepackedAnnotationInteractionIndexV2(interaction, 120, 140, (featureIndex) =>
      activeHits.push(featureIndex)
    );
    expect(activeHits).toEqual([1]);
    const inactiveHits: number[] = [];
    queryPrepackedAnnotationInteractionIndexV2(interaction, 20, 21, (featureIndex) =>
      inactiveHits.push(featureIndex)
    );
    expect(inactiveHits).toEqual([]);
    expect(() => validatePrepackedAnnotationInteractionIndexV2(interaction)).not.toThrow();
    expect(
      validatePrepackedAnnotationViewportInteractionVisualCouplingV2(
        interaction,
        full.interactionIndex,
        unpacked.scene,
        300
      )
    ).toEqual({
      interactionIndexValidationCount: 0,
      featureScanCardinality: 1,
      primitiveScanCardinality: 1,
    });
    expect(() =>
      validatePrepackedAnnotationViewportInteractionVisualCouplingV2(
        { ...interaction, stringBytes: interaction.stringBytes.slice() },
        full.interactionIndex,
        unpacked.scene,
        300
      )
    ).toThrow(/parent authority mismatch/);
    expect(() =>
      validatePrepackedAnnotationViewportInteractionVisualCouplingV2(
        { ...interaction, intervalFeatureIndices: interaction.intervalFeatureIndices.slice() },
        full.interactionIndex,
        unpacked.scene,
        300
      )
    ).toThrow(/parent authority mismatch/);
    const trustedInteraction = bindTrustedPartitionedTranscriptSceneDetailInteractionV1(
      detail.manifest,
      unpacked.scene,
      full.interactionIndex,
      unpacked.rendererAdmissionCapability
    );
    const trustedInteractionBinding = {
      sourceScene: detail.manifest.sourceScene,
      scene: unpacked.scene,
      parentFeatureLookup: full.interactionIndex,
      interactionIndex: trustedInteraction.interactionIndex,
    };
    expect(trustedInteraction.interactionIndex.featurePrimitiveOffsets).toBe(
      unpacked.interactionPrimitiveCsr.featurePrimitiveOffsets
    );
    expect(trustedInteraction.interactionIndex.featurePrimitiveIndices).toBe(
      unpacked.interactionPrimitiveCsr.featurePrimitiveIndices
    );
    expect(
      isTrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1(
        trustedInteraction.rendererAdmissionCapability,
        trustedInteractionBinding
      )
    ).toBe(true);
    expect(
      isTrustedPartitionedTranscriptSceneDetailInteractionAdmissionV1(
        trustedInteraction.rendererAdmissionCapability,
        { ...trustedInteractionBinding, interactionIndex: interaction }
      )
    ).toBe(false);
  });

  it('rejects a changed source range before constructing a renderer packet', async () => {
    const source = [primitive(0, 10, 40, 0)];
    const scene = buildPartitionedTranscriptScene(source, 100);
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: {
        datasetId: 'fixture',
        datasetVersion: '1',
        sourceSha256: 'a'.repeat(64),
      },
      assemblyContract: { assemblyId: 'fixture', assemblyLengthBp: 100 },
      families: [{ id: 'transcript-glyph-v2', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: new Uint32Array([0]),
      scene,
      interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
        [interactionFeature(0, 10, 40, 0)],
        scene.sortedPrimitives
      ),
      policyProjection: {
        features: [policyFeature(0, 0)],
        expandedBandOrder: ['mRNA'],
        canonicalBandOrder: ['mRNA'],
      },
      payloadSha256: sha256,
    });
    const catalog = await buildPartitionedTranscriptSceneRangeCatalogV1(
      packed.manifest,
      packed.payload,
      sha256
    );

    await expect(
      packPartitionedTranscriptSceneDetailPacketV1({
        sourceManifest: packed.manifest,
        rangeCatalog: catalog,
        startBp: 10,
        endBp: 20,
        readRange: async (range) => {
          const bytes = packed.payload.slice(range.byteOffset, range.byteOffset + range.byteLength);
          if (bytes.byteLength > 0) bytes[0] ^= 1;
          return bytes;
        },
        payloadSha256: sha256,
      })
    ).rejects.toThrow(/range hash/);
  });
});

function primitive(
  featureIndex: number,
  startBp: number,
  endBp: number,
  trackLane: number
): AnnotationScenePrimitiveV1 {
  return {
    startBp,
    endBp,
    featureIndex,
    offsetCenter: -7 - trackLane * 16,
    halfH: 7,
    color: 0x123456,
    alpha: 0.85,
    cdsFade: 0,
    dirSign: 1,
  };
}

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

function policyFeature(expandedTrackLane: number, canonicalTrackLane: number | null) {
  return {
    annotationType: 'mRNA',
    expandedLane: expandedTrackLane,
    expandedTrackLane,
    canonicalLane: canonicalTrackLane,
    canonicalTrackLane,
  };
}
