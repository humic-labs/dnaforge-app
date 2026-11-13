import { describe, expect, it } from 'vitest';

import { buildAnnotationPolicyProjectionTableV1 } from './annotation-policy-projection-v1';
import {
  COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1,
  TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1,
  packCompiledBroadAnnotationInteractionBinaryV1,
  unpackCompiledBroadAnnotationInteractionBinaryV1,
  unpackTrustedMainValidatedCompiledBroadAnnotationInteractionBinaryV1,
  validateCompiledBroadAnnotationInteractionBinaryV1,
} from './compiled-broad-annotation-interaction-binary-v1';
import {
  buildPrepackedAnnotationInteractionIndexV2,
  decodePrepackedAnnotationInteractionFeatureV2,
  projectPrepackedAnnotationFeatureLookupIndexV2,
  queryPrepackedAnnotationInteractionIndexV2,
} from './prepacked-annotation-interaction-index-v2';

const features = [
  {
    rendererId: 1,
    startBp: 10,
    endBp: 100,
    lane: 0,
    direction: 'forward' as const,
    displayName: 'TX-1',
    type: 'mRNA',
    transcriptId: 'TX-1',
    sourceId: 'rna-1',
    canonicalIdentity: 'mRNA|rna-1|TX-1|10|100|forward',
  },
  {
    rendererId: 2,
    startBp: 80,
    endBp: 140,
    lane: 1,
    direction: 'none' as const,
    displayName: 'ENH-1',
    type: 'enhancer',
    transcriptId: null,
    sourceId: 'enh-1',
    canonicalIdentity: 'enhancer|enh-1||80|140|none',
  },
  {
    rendererId: 3,
    startBp: 200,
    endBp: 230,
    lane: 2,
    direction: 'reverse' as const,
    displayName: 'REG-1',
    type: 'regulatory_region',
    transcriptId: null,
    sourceId: 'reg-1',
    canonicalIdentity: 'regulatory_region|reg-1||200|230|reverse',
  },
];

function input() {
  const interaction = buildPrepackedAnnotationInteractionIndexV2(
    features,
    features.map((_, featureIndex) => ({ featureIndex }))
  );
  return {
    sourceScene: {
      schema: 'partitioned-transcript-scene-binary.v4' as const,
      payloadSha256: 'a'.repeat(64),
      contractSha256: 'b'.repeat(64),
      byteLength: 300_000_000,
    },
    datasetContract: {
      datasetId: 'gencode',
      datasetVersion: 'v-test',
      sourceSha256: 'c'.repeat(64),
    },
    assemblyContract: {
      assemblyId: 'grch38',
      assemblyLengthBp: 3_088_269_832,
    },
    policyProjection: buildAnnotationPolicyProjectionTableV1({
      features: [
        {
          annotationType: 'mRNA',
          expandedLane: 0,
          expandedTrackLane: 0,
          canonicalLane: 0,
          canonicalTrackLane: 0,
        },
        {
          annotationType: 'enhancer',
          expandedLane: 2,
          expandedTrackLane: 0,
          canonicalLane: 2,
          canonicalTrackLane: 0,
        },
        {
          annotationType: 'regulatory_region',
          expandedLane: 4,
          expandedTrackLane: 0,
          canonicalLane: 4,
          canonicalTrackLane: 0,
        },
      ],
      expandedBandOrder: ['mRNA', 'enhancer', 'regulatory_region'],
      canonicalBandOrder: ['mRNA', 'enhancer', 'regulatory_region'],
    }),
    featureLookup: projectPrepackedAnnotationFeatureLookupIndexV2(interaction),
  };
}

describe('compiled broad annotation interaction binary v1', () => {
  it('round-trips arbitrary annotation types without primitive drawing geometry', async () => {
    const packed = await packCompiledBroadAnnotationInteractionBinaryV1(input());
    expect(packed.manifest.schema).toBe(COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1);
    expect(packed.manifest.sourceScene.byteLength).toBe(300_000_000);
    expect(packed.payload.byteLength).toBeLessThan(2_000);

    await expect(
      validateCompiledBroadAnnotationInteractionBinaryV1(packed.manifest, packed.payload)
    ).resolves.toBeUndefined();
    const unpacked = unpackCompiledBroadAnnotationInteractionBinaryV1(
      packed.manifest,
      packed.payload
    );
    expect('featurePrimitiveIndices' in unpacked.featureLookup).toBe(false);
    expect(unpacked.policyProjection.annotationTypes).toEqual([
      'mRNA',
      'enhancer',
      'regulatory_region',
    ]);

    const hitTypes: string[] = [];
    queryPrepackedAnnotationInteractionIndexV2(unpacked.featureLookup, 90, 91, (featureIndex) =>
      hitTypes.push(
        decodePrepackedAnnotationInteractionFeatureV2(unpacked.featureLookup, featureIndex).type
      )
    );
    expect(hitTypes.sort()).toEqual(['enhancer', 'mRNA']);
  });

  it('uses the trusted-main marker for a structural zero-copy renderer decode', async () => {
    const packed = await packCompiledBroadAnnotationInteractionBinaryV1(input());
    const unpacked = unpackTrustedMainValidatedCompiledBroadAnnotationInteractionBinaryV1(
      packed.manifest,
      packed.payload,
      TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1
    );
    expect(unpacked.featureLookup.featureRecordBytes.buffer).toBe(packed.payload.buffer);
    expect(() =>
      unpackTrustedMainValidatedCompiledBroadAnnotationInteractionBinaryV1(
        packed.manifest,
        packed.payload,
        'forged' as typeof TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1
      )
    ).toThrow(/trusted-main marker/);
  });

  it('fails closed when compact bytes or parent scene identity are changed', async () => {
    const packed = await packCompiledBroadAnnotationInteractionBinaryV1(input());
    const corruptPayload = packed.payload.slice();
    corruptPayload[0] ^= 0xff;
    await expect(
      validateCompiledBroadAnnotationInteractionBinaryV1(packed.manifest, corruptPayload)
    ).rejects.toThrow(/sha256/);

    const corruptManifest = {
      ...packed.manifest,
      sourceScene: { ...packed.manifest.sourceScene, payloadSha256: 'not-a-hash' },
    };
    await expect(
      validateCompiledBroadAnnotationInteractionBinaryV1(corruptManifest, packed.payload)
    ).rejects.toThrow(/source scene/);
  });
});
