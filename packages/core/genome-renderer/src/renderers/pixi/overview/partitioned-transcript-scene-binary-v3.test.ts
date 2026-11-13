import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import { projectAnnotationPolicyV1 } from './annotation-policy-projection-v1';
import { buildPartitionedTranscriptScene } from './partitioned-transcript-scene';
import { packPartitionedTranscriptSceneBinaryV2 } from './partitioned-transcript-scene-binary-v2';
import {
  PARTITIONED_TRANSCRIPT_SCENE_BINARY_V3,
  TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V3,
  packPartitionedTranscriptSceneBinaryV3,
  unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV3,
  unpackPartitionedTranscriptSceneBinaryV3,
  validatePartitionedTranscriptSceneBinaryV3,
} from './partitioned-transcript-scene-binary-v3';
import {
  buildPrepackedAnnotationInteractionIndexV2,
  decodePrepackedAnnotationInteractionFeatureV2,
} from './prepacked-annotation-interaction-index-v2';

const primitives: AnnotationScenePrimitiveV1[] = [
  primitive(2, 300, 400, 0),
  primitive(0, 100, 200, 0),
  primitive(1, 150, 250, 1),
];

const sortedPrimitives = buildPartitionedTranscriptScene(primitives, 100).sortedPrimitives;
const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
  [
    interactionFeature(0, 100, 200, 0, 'mRNA'),
    interactionFeature(1, 150, 250, 1, 'mRNA'),
    interactionFeature(2, 300, 400, 3, 'lncRNA'),
  ],
  sortedPrimitives
);

const policyProjection = {
  features: [
    policyFeature('mRNA', 0, 0, 0, 0),
    policyFeature('mRNA', 1, 1, null, null),
    policyFeature('lncRNA', 3, 0, 2, 0),
  ],
  expandedBandOrder: ['mRNA', 'lncRNA'],
  canonicalBandOrder: ['mRNA', 'lncRNA'],
};

const baseInput = () => ({
  datasetContract: {
    datasetId: 'fixture-expanded-complete',
    datasetVersion: 'policy-neutral-v3',
    sourceSha256: 'a'.repeat(64),
  },
  assemblyContract: { assemblyId: 'fixture-assembly', assemblyLengthBp: 10_000 },
  families: [{ id: 'transcript-glyph-v2', kind: 'transcript' as const, metadata: {} }],
  featureFamilyIndices: new Uint32Array([0, 0, 0]),
  primitives,
  partitionSpanBp: 100,
  interactionIndex,
});

describe('partitioned transcript scene binary v3', () => {
  it('composes byte-identical approved expanded geometry with canonical membership and both lanes', async () => {
    const source = baseInput();
    const [v2, v3] = await Promise.all([
      packPartitionedTranscriptSceneBinaryV2(source),
      packPartitionedTranscriptSceneBinaryV3({ ...source, policyProjection }),
    ]);

    expect(v3.manifest.schema).toBe(PARTITIONED_TRANSCRIPT_SCENE_BINARY_V3);
    const expandedSection = v3.manifest.sections.expandedScenePayload;
    expect(v3.manifest.expandedSceneManifest).toEqual(v2.manifest);
    expect(
      v3.payload.subarray(
        expandedSection.byteOffset,
        expandedSection.byteOffset + expandedSection.byteLength
      )
    ).toEqual(v2.payload);
    const unpacked = await unpackPartitionedTranscriptSceneBinaryV3(v3.manifest, v3.payload);
    expect(unpacked.expandedScene.visual.scene.packedInstanceData.buffer).toBe(v3.payload.buffer);
    expect(unpacked.policyProjection.featureRecordBytes.buffer).toBe(v3.payload.buffer);
    expect(unpacked.policyGpuInstanceData.buffer).toBe(v3.payload.buffer);
    expect(Array.from(unpacked.policyGpuInstanceData)).toEqual([
      0, 0, 0, 0, 1, 1, -1, -1, 3, 0, 2, 0,
    ]);
    expect(
      decodePrepackedAnnotationInteractionFeatureV2(unpacked.expandedScene.interactionIndex, 1).lane
    ).toBe(1);
    expect(unpacked.policyProjection).toMatchObject({
      featureCount: 3,
      annotationTypes: ['mRNA', 'lncRNA'],
      expandedBandTypeIndices: [0, 1],
      canonicalBandTypeIndices: [0, 1],
    });
  });

  it.each([8, 12, 24] as const)(
    'projects canonical and expanded membership at lane cap %s without rebuilding geometry',
    async (laneLimit) => {
      const packed = await packPartitionedTranscriptSceneBinaryV3({
        ...baseInput(),
        policyProjection,
      });
      const { policyProjection: table } = await unpackPartitionedTranscriptSceneBinaryV3(
        packed.manifest,
        packed.payload
      );

      expect(projectAnnotationPolicyV1(table, { isoformMode: 'expanded', laneLimit })).toEqual({
        features: [
          { featureIndex: 0, annotationType: 'mRNA', lane: 0, trackLane: 0 },
          { featureIndex: 1, annotationType: 'mRNA', lane: 1, trackLane: 1 },
          { featureIndex: 2, annotationType: 'lncRNA', lane: laneLimit + 1, trackLane: 0 },
        ],
        typeFilteredCount: 3,
        droppedCount: 0,
      });
      expect(projectAnnotationPolicyV1(table, { isoformMode: 'canonical', laneLimit })).toEqual({
        features: [
          { featureIndex: 0, annotationType: 'mRNA', lane: 0, trackLane: 0 },
          { featureIndex: 2, annotationType: 'lncRNA', lane: laneLimit + 1, trackLane: 0 },
        ],
        typeFilteredCount: 2,
        droppedCount: 0,
      });
    }
  );

  it('provides a zero-copy, zero-rescan renderer decode after authoritative main validation', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV3({
      ...baseInput(),
      policyProjection,
    });
    await validatePartitionedTranscriptSceneBinaryV3(packed.manifest, packed.payload);
    const unpacked = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV3(
      packed.manifest,
      packed.payload,
      TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V3
    );

    expect(unpacked.expandedScene.visual.scene.packedInstanceData.buffer).toBe(
      packed.payload.buffer
    );
    expect(unpacked.policyProjection.featureRecordBytes.buffer).toBe(packed.payload.buffer);
    expect(unpacked.policyGpuInstanceData.buffer).toBe(packed.payload.buffer);
    expect(unpacked.trustedMainDecodeWork).toEqual({
      payloadBytesCopied: 0,
      hashOperations: 0,
      visualSemanticPrimitiveScans: 0,
      interactionSemanticFeatureScans: 0,
      policySemanticFeatureScans: 0,
      visualInteractionCouplingPrimitiveScans: 0,
      visualPolicyCouplingPrimitiveScans: 0,
    });
    expect(() =>
      unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV3(
        packed.manifest,
        packed.payload,
        'forged' as typeof TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V3
      )
    ).toThrow(/trusted-main validation marker/);
  });

  it('validates main-process Buffer bytes through zero-copy plain Uint8Array section views', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV3({
      ...baseInput(),
      policyProjection,
    });
    const diskBytes = Buffer.from(packed.payload);

    await expect(
      validatePartitionedTranscriptSceneBinaryV3(packed.manifest, diskBytes)
    ).resolves.toBeUndefined();
    const unpacked = await unpackPartitionedTranscriptSceneBinaryV3(packed.manifest, diskBytes);
    expect(unpacked.policyProjection.featureRecordBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(unpacked.policyProjection.featureRecordBytes)).toBe(false);
    expect(unpacked.policyProjection.featureRecordBytes.buffer).toBe(diskBytes.buffer);
  });

  it('projects the uncapped canonical and expanded lane authorities exactly', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV3({
      ...baseInput(),
      policyProjection,
    });
    const { policyProjection: table } = await unpackPartitionedTranscriptSceneBinaryV3(
      packed.manifest,
      packed.payload
    );
    expect(projectAnnotationPolicyV1(table, { isoformMode: 'expanded', laneLimit: null })).toEqual({
      features: [
        { featureIndex: 0, annotationType: 'mRNA', lane: 0, trackLane: 0 },
        { featureIndex: 1, annotationType: 'mRNA', lane: 1, trackLane: 1 },
        { featureIndex: 2, annotationType: 'lncRNA', lane: 3, trackLane: 0 },
      ],
      typeFilteredCount: 3,
      droppedCount: 0,
    });
    expect(projectAnnotationPolicyV1(table, { isoformMode: 'canonical', laneLimit: null })).toEqual(
      {
        features: [
          { featureIndex: 0, annotationType: 'mRNA', lane: 0, trackLane: 0 },
          { featureIndex: 2, annotationType: 'lncRNA', lane: 2, trackLane: 0 },
        ],
        typeFilteredCount: 2,
        droppedCount: 0,
      }
    );
  });

  it('fails closed when expanded lane metadata or immutable glyph offsets do not match v2', async () => {
    await expect(
      packPartitionedTranscriptSceneBinaryV3({
        ...baseInput(),
        policyProjection: {
          ...policyProjection,
          features: [policyFeature('mRNA', 7, 0, 0, 0), ...policyProjection.features.slice(1)],
        },
      })
    ).rejects.toThrow(/not expanded-lane geometry/);

    await expect(
      packPartitionedTranscriptSceneBinaryV3({
        ...baseInput(),
        primitives: primitives.map((value, index) =>
          index === 1 ? { ...value, offsetCenter: value.offsetCenter - 1 } : value
        ),
        policyProjection,
      })
    ).rejects.toThrow(/not expanded-track geometry/);
  });

  it('covers policy bytes with section, payload, and manifest integrity', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV3({
      ...baseInput(),
      policyProjection,
    });
    const corrupt = packed.payload.slice();
    corrupt[packed.manifest.sections.policyFeatureRecords.byteOffset] ^= 1;
    await expect(
      validatePartitionedTranscriptSceneBinaryV3(packed.manifest, corrupt)
    ).rejects.toThrow(/payload sha256 mismatch/);
  });
});

function primitive(
  featureIndex: number,
  startBp: number,
  endBp: number,
  expandedTrackLane: number
): AnnotationScenePrimitiveV1 {
  return {
    startBp,
    endBp,
    featureIndex,
    offsetCenter: -7 - expandedTrackLane * 16,
    halfH: 7,
    color: 0x123456,
    alpha: 0.85,
    cdsFade: 0,
    dirSign: 1,
  };
}

function interactionFeature(
  rendererId: number,
  startBp: number,
  endBp: number,
  lane: number,
  type: string
) {
  return {
    rendererId,
    startBp,
    endBp,
    lane,
    direction: 'forward' as const,
    displayName: `feature-${rendererId}`,
    type,
    transcriptId: `TX-${rendererId}`,
    sourceId: `source-${rendererId}`,
    canonicalIdentity: `fixture|${type}|${rendererId}`,
  };
}

function policyFeature(
  annotationType: string,
  expandedLane: number,
  expandedTrackLane: number,
  canonicalLane: number | null,
  canonicalTrackLane: number | null
) {
  return {
    annotationType,
    expandedLane,
    expandedTrackLane,
    canonicalLane,
    canonicalTrackLane,
  };
}
