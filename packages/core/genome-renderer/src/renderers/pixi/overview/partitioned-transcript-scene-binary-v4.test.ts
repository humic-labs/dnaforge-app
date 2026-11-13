import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import { materializeAnnotationPolicyDirectFineTileV1 } from './annotation-policy-direct-fine-index-v1';
import { directFineTileInstanceCountForLaneLimitV1 } from './annotation-policy-direct-submission-bank-v1';
import { buildPartitionedTranscriptScene } from './partitioned-transcript-scene';
import {
  PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
  TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4,
  isTrustedPartitionedTranscriptRendererAdmissionV4,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  resealPartitionedTranscriptSceneBinaryDatasetContractV4,
  scopeTrustedPartitionedTranscriptRendererAdmissionV4,
  unpackPartitionedTranscriptSceneBinaryV4,
  unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4,
  validatePartitionedTranscriptSceneBinaryV4,
} from './partitioned-transcript-scene-binary-v4';
import {
  buildPrepackedAnnotationInteractionIndexV2,
  decodePrepackedAnnotationInteractionFeatureV2,
} from './prepacked-annotation-interaction-index-v2';

const primitives: AnnotationScenePrimitiveV1[] = [
  primitive(2, 300, 400, 0),
  primitive(0, 100, 200, 0),
  primitive(1, 150, 250, 1),
];
const scene = buildPartitionedTranscriptScene(primitives, 1_000);
const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
  [
    interactionFeature(0, 100, 200, 0, 'mRNA'),
    interactionFeature(1, 150, 250, 1, 'mRNA'),
    interactionFeature(2, 300, 400, 3, 'lncRNA'),
  ],
  scene.sortedPrimitives
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

function input() {
  return {
    datasetContract: {
      datasetId: 'fixture-v4',
      datasetVersion: 'direct-bank-v4',
      sourceSha256: 'a'.repeat(64),
    },
    assemblyContract: { assemblyId: 'fixture-assembly', assemblyLengthBp: 10_000 },
    families: [{ id: 'transcript-glyph-v2', kind: 'transcript' as const, metadata: {} }],
    featureFamilyIndices: new Uint32Array([0, 0, 0]),
    scene,
    interactionIndex,
    policyProjection,
  };
}

describe('partitioned transcript scene binary v4', () => {
  it('reseals only a path-dependent dataset digest while reusing the exact authenticated payload', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4(input());
    const localDatasetContract = {
      ...packed.manifest.datasetContract,
      sourceSha256: 'b'.repeat(64),
    };

    const resealed = await resealPartitionedTranscriptSceneBinaryDatasetContractV4(
      packed.manifest,
      localDatasetContract
    );

    expect(packed.manifest.datasetContract.sourceSha256).toBe('a'.repeat(64));
    expect(resealed.datasetContract).toEqual(localDatasetContract);
    expect(resealed.assemblyContract).toBe(packed.manifest.assemblyContract);
    expect(resealed.directContract).toBe(packed.manifest.directContract);
    expect(resealed.policyContract).toBe(packed.manifest.policyContract);
    expect(resealed.interactionContract).toBe(packed.manifest.interactionContract);
    expect(resealed.sections).toBe(packed.manifest.sections);
    expect(resealed.integrity.payloadSha256).toBe(packed.manifest.integrity.payloadSha256);
    expect(resealed.integrity.contractSha256).not.toBe(packed.manifest.integrity.contractSha256);
    await expect(
      validatePartitionedTranscriptSceneBinaryV4(resealed, packed.payload)
    ).resolves.toBeDefined();
  });

  it('persists direct banks and compact fine indices without retaining v3 visual/policy planes', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4(input());
    expect(packed.manifest.schema).toBe(PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4);
    expect(packed.packWork).toMatchObject({
      sourcePrimitiveCount: 3,
      expandedDirectPrimitiveCount: 3,
      canonicalDirectPrimitiveCount: 2,
      retainedExpandedSourceGlyphBytes: 0,
      retainedPolicyGpuBytes: 0,
      fineRecordIndexCount: 5,
    });
    expect(Object.keys(packed.manifest.sections)).not.toContain('expandedScenePayload');
    expect(Object.keys(packed.manifest.sections)).not.toContain('policyGpuInstances');
    expect(Object.keys(packed.manifest.sections)).not.toContain('expandedSourcePrimitiveIndices');
    expect(Object.keys(packed.manifest.sections)).not.toContain('canonicalSourcePrimitiveIndices');

    const decoded = await unpackPartitionedTranscriptSceneBinaryV4(packed.manifest, packed.payload);
    expect(decoded.submissionBank.expanded.sourcePrimitiveIndices).toBeUndefined();
    expect(decoded.submissionBank.canonical.sourcePrimitiveIndices).toBeUndefined();
    expect(decoded.scene.packedInstanceData).toBe(
      decoded.submissionBank.expanded.packedInstanceData
    );
    expect(decoded.policyProjection.featureRecordBytes.buffer).toBe(packed.payload.buffer);
    expect(decoded.submissionFineIndices.expanded.bankRecordIndices.buffer).toBe(
      packed.payload.buffer
    );
  });

  it('rewrites interaction CSR ordinals to the lane-reordered expanded bank', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4(input());
    const decoded = await unpackPartitionedTranscriptSceneBinaryV4(packed.manifest, packed.payload);
    expect(Array.from(decoded.interactionIndex.featurePrimitiveIndices)).toEqual([0, 2, 1]);
    expect(decoded.scene.featureIndices[2]).toBe(1);
    expect(decodePrepackedAnnotationInteractionFeatureV2(decoded.interactionIndex, 1).lane).toBe(1);
  });

  it('rewrites every CSR ordinal when one feature owns multiple lane-reordered primitives', async () => {
    const multiPrimitives = [
      primitive(0, 100, 120, 1),
      primitive(0, 130, 140, 1),
      primitive(1, 150, 160, 0),
    ];
    const multiScene = buildPartitionedTranscriptScene(multiPrimitives, 1_000);
    const multiInteraction = buildPrepackedAnnotationInteractionIndexV2(
      [interactionFeature(0, 100, 140, 1, 'mRNA'), interactionFeature(1, 150, 160, 0, 'mRNA')],
      multiScene.sortedPrimitives
    );
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      ...input(),
      featureFamilyIndices: new Uint32Array([0, 0]),
      scene: multiScene,
      interactionIndex: multiInteraction,
      policyProjection: {
        features: [policyFeature('mRNA', 1, 1, 1, 1), policyFeature('mRNA', 0, 0, 0, 0)],
        expandedBandOrder: ['mRNA'],
        canonicalBandOrder: ['mRNA'],
      },
    });
    const decoded = await unpackPartitionedTranscriptSceneBinaryV4(packed.manifest, packed.payload);
    expect(decoded.submissionBank.expanded.sourcePrimitiveIndices).toBeUndefined();
    expect(Array.from(decoded.interactionIndex.featurePrimitiveIndices)).toEqual([1, 2, 0]);
    expect(Array.from(decoded.scene.featureIndices)).toEqual([1, 0, 0]);
  });

  it('materializes one exact fine tile from persisted record ordinals with arbitrary lane caps', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4(input());
    const decoded = await unpackPartitionedTranscriptSceneBinaryV4(packed.manifest, packed.payload);
    const expanded = materializeAnnotationPolicyDirectFineTileV1(
      decoded.submissionBank.expanded,
      decoded.submissionFineIndices.expanded,
      0
    );
    const canonical = materializeAnnotationPolicyDirectFineTileV1(
      decoded.submissionBank.canonical,
      decoded.submissionFineIndices.canonical,
      0
    );
    expect(Array.from(expanded.featureIndices)).toEqual([0, 2, 1]);
    expect(Array.from(canonical.featureIndices)).toEqual([0, 2]);
    expect(canonical.hiddenByIsoformMembershipInstanceCount).toBe(1);
    expect(directFineTileInstanceCountForLaneLimitV1(expanded, 1)).toBe(2);
    expect(directFineTileInstanceCountForLaneLimitV1(expanded, 37)).toBe(3);
    expect(directFineTileInstanceCountForLaneLimitV1(expanded, null)).toBe(3);
  });

  it('provides zero-copy trusted renderer decode only after the explicit main marker', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4(input());
    const validationWork = await validatePartitionedTranscriptSceneBinaryV4(
      packed.manifest,
      packed.payload
    );
    expect(validationWork).toEqual({
      interactionIndexValidationCount: 1,
      interactionFeatureScanCardinality: 3,
      couplingPrimitiveScanCardinality: 3,
      directFineIndexValidationCount: 2,
      directFineIndexRecordScanCardinality: 5,
    });
    const decoded = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
      packed.manifest,
      packed.payload,
      TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
    );
    expect(decoded.scene.packedInstanceData.buffer).toBe(packed.payload.buffer);
    expect(decoded.interactionIndex.featureRecordBytes.buffer).toBe(packed.payload.buffer);
    expect(decoded.trustedMainDecodeWork).toEqual({
      payloadBytesCopied: 0,
      hashOperations: 0,
      visualSemanticPrimitiveScans: 0,
      interactionSemanticFeatureScans: 0,
      couplingPrimitiveScans: 0,
      policyProjectionScans: 0,
    });
    expect(() =>
      unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
        packed.manifest,
        packed.payload,
        'forged' as typeof TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
      )
    ).toThrow(/trusted-main marker/);
  });

  it('binds renderer admission to exact artifact objects and assembly length', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4(input());
    await validatePartitionedTranscriptSceneBinaryV4(packed.manifest, packed.payload);
    const decoded = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
      packed.manifest,
      packed.payload,
      TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
    );
    const intrinsicBinding = {
      provenance: decoded.rendererAdmissionProvenance,
      scene: decoded.scene,
      families: decoded.families,
      featureFamilyIndices: decoded.featureFamilyIndices,
      interactionIndex: decoded.interactionIndex,
      policyProjection: decoded.policyProjection,
      submissionBank: decoded.submissionBank,
      submissionFineIndices: decoded.submissionFineIndices,
    };
    const loadIdentity = {
      ownerKey: 'fixture-owner',
      sceneContractSha256: decoded.rendererAdmissionProvenance.contractSha256,
      genomeIdentity: 'fixture-source',
      genomeLengthBp: packed.manifest.assemblyContract.assemblyLengthBp,
      partitionSpanBp: decoded.scene.partitionSpanBp,
      artifactKey: 'fixture-artifact',
      themeMode: 'light' as const,
      trackType: 'mRNA',
      annotationBarHeightPx: 14,
      laneAlgorithmToken: 'fixture-lanes',
      mapperContractToken: 'fixture-mapper',
      geometryContractToken: 'fixture-geometry',
      interactionContractToken: 'fixture-interaction',
    };
    const scoped = scopeTrustedPartitionedTranscriptRendererAdmissionV4(
      decoded.rendererAdmissionCapability,
      intrinsicBinding,
      loadIdentity
    );
    expect(() =>
      scopeTrustedPartitionedTranscriptRendererAdmissionV4(
        { ...decoded.rendererAdmissionCapability },
        intrinsicBinding,
        loadIdentity
      )
    ).toThrow(/scope capability mismatch/);
    const binding = { ...intrinsicBinding, loadIdentity: scoped.loadIdentity };

    expect(isTrustedPartitionedTranscriptRendererAdmissionV4(scoped.capability, binding)).toBe(
      true
    );
    expect(
      isTrustedPartitionedTranscriptRendererAdmissionV4({ ...scoped.capability }, binding)
    ).toBe(false);
    expect(isTrustedPartitionedTranscriptRendererAdmissionV4({}, binding)).toBe(false);
    const copiedPlaneBindings = [
      { ...binding, provenance: { ...binding.provenance } },
      { ...binding, scene: { ...binding.scene } },
      { ...binding, families: [...binding.families] },
      { ...binding, featureFamilyIndices: binding.featureFamilyIndices.slice() },
      { ...binding, interactionIndex: { ...binding.interactionIndex } },
      { ...binding, policyProjection: { ...binding.policyProjection } },
      { ...binding, submissionBank: { ...binding.submissionBank } },
      { ...binding, submissionFineIndices: { ...binding.submissionFineIndices } },
      { ...binding, loadIdentity: { ...binding.loadIdentity } },
    ];
    for (const copiedBinding of copiedPlaneBindings) {
      expect(
        isTrustedPartitionedTranscriptRendererAdmissionV4(scoped.capability, copiedBinding)
      ).toBe(false);
    }

    const secondPacked = await packGpuReadyPartitionedTranscriptSceneBinaryV4(input());
    const second = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
      secondPacked.manifest,
      secondPacked.payload,
      TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
    );
    const secondIntrinsicBinding = {
      provenance: second.rendererAdmissionProvenance,
      scene: second.scene,
      families: second.families,
      featureFamilyIndices: second.featureFamilyIndices,
      interactionIndex: second.interactionIndex,
      policyProjection: second.policyProjection,
      submissionBank: second.submissionBank,
      submissionFineIndices: second.submissionFineIndices,
    };
    const secondScoped = scopeTrustedPartitionedTranscriptRendererAdmissionV4(
      second.rendererAdmissionCapability,
      secondIntrinsicBinding,
      { ...binding.loadIdentity, ownerKey: 'fixture-owner-b' }
    );
    const secondBinding = {
      ...secondIntrinsicBinding,
      loadIdentity: secondScoped.loadIdentity,
    };
    const mixedArtifactBindings = [
      { ...binding, provenance: secondBinding.provenance },
      { ...binding, scene: secondBinding.scene },
      { ...binding, families: secondBinding.families },
      { ...binding, featureFamilyIndices: secondBinding.featureFamilyIndices },
      { ...binding, interactionIndex: secondBinding.interactionIndex },
      { ...binding, policyProjection: secondBinding.policyProjection },
      { ...binding, submissionBank: secondBinding.submissionBank },
      { ...binding, submissionFineIndices: secondBinding.submissionFineIndices },
      { ...binding, loadIdentity: secondBinding.loadIdentity },
      secondBinding,
    ];
    for (const mixedBinding of mixedArtifactBindings) {
      expect(
        isTrustedPartitionedTranscriptRendererAdmissionV4(scoped.capability, mixedBinding)
      ).toBe(false);
    }
  });

  it('fails closed on payload corruption and interaction/direct-bank decoupling', async () => {
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4(input());
    const corrupt = packed.payload.slice();
    corrupt[packed.manifest.sections.canonicalGlyphs.byteOffset] ^= 1;
    await expect(
      validatePartitionedTranscriptSceneBinaryV4(packed.manifest, corrupt)
    ).rejects.toThrow(/payload sha256 mismatch/);

    await expect(
      packGpuReadyPartitionedTranscriptSceneBinaryV4({
        ...input(),
        interactionIndex: {
          ...interactionIndex,
          featurePrimitiveIndices: Uint32Array.from([1, 0, 2]),
        },
      })
    ).rejects.toThrow(/visual owner mismatch/);

    const badLayout = structuredClone(packed.manifest);
    badLayout.sections.canonicalGlyphs.byteOffset += 4;
    await expect(
      validatePartitionedTranscriptSceneBinaryV4(badLayout, packed.payload)
    ).rejects.toThrow(/sections are not exact and aligned/);
  });

  it('rejects an unbounded or sparse track-lane domain before direct-bank census', async () => {
    await expect(
      packGpuReadyPartitionedTranscriptSceneBinaryV4({
        ...input(),
        policyProjection: {
          ...policyProjection,
          features: [
            policyFeature('mRNA', 0, 0xffff_fffe, 0, 0),
            policyFeature('mRNA', 1, 1, null, null),
            policyFeature('lncRNA', 3, 0, 2, 0),
          ],
        },
      })
    ).rejects.toThrow(/track-lane domain exceeds feature count/);

    await expect(
      packGpuReadyPartitionedTranscriptSceneBinaryV4({
        ...input(),
        policyProjection: {
          ...policyProjection,
          features: [
            policyFeature('mRNA', 0, 0, 0, 0),
            policyFeature('mRNA', 1, 2, null, null),
            policyFeature('lncRNA', 3, 2, 2, 0),
          ],
        },
      })
    ).rejects.toThrow(/expanded track-lane domain is sparse/);
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
