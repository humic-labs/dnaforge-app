import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import {
  packGpuReadyPartitionedTranscriptSceneBinaryV2,
  packPartitionedTranscriptSceneBinaryV2,
  TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2,
  unpackPartitionedTranscriptSceneBinaryV2,
  unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV2,
  validatePartitionedTranscriptSceneBinaryV2,
} from './partitioned-transcript-scene-binary-v2';
import {
  buildPartitionedTranscriptScene,
  type GpuReadyPartitionedTranscriptScene,
} from './partitioned-transcript-scene';
import {
  buildPrepackedAnnotationInteractionIndexV2,
  decodePrepackedAnnotationInteractionFeatureV2,
  findPrepackedAnnotationFeatureByCanonicalIdentityV2,
} from './prepacked-annotation-interaction-index-v2';

const primitive = (
  featureIndex: number,
  startBp: number,
  endBp: number,
  offsetCenter = featureIndex * 18 + 9
): AnnotationScenePrimitiveV1 => ({
  startBp,
  endBp,
  featureIndex,
  offsetCenter,
  halfH: 7,
  color: 0x123456,
  alpha: 0.85,
  cdsFade: 0,
  dirSign: featureIndex % 2 ? -1 : 1,
});

const makeInput = () => {
  const primitives = [
    primitive(2, 250_000_000, 310_000_000),
    primitive(0, 99_999_990, 100_000_020),
    primitive(1, 180_000_000, 180_001_000),
    primitive(0, 100_000_020, 100_000_050),
  ];
  const partitionSpanBp = 100_000_000;
  const sortedPrimitives = buildPartitionedTranscriptScene(
    primitives,
    partitionSpanBp
  ).sortedPrimitives;
  const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
    [
      {
        rendererId: 41,
        startBp: 99_999_900,
        endBp: 100_000_100,
        lane: 0,
        direction: 'forward',
        displayName: 'SEAM1-201',
        type: 'mRNA',
        transcriptId: 'ENST-SEAM',
        sourceId: 'gencode-v47',
        canonicalIdentity: 'grch38|mRNA|ENST-SEAM',
      },
      {
        rendererId: 7,
        startBp: 179_999_900,
        endBp: 180_001_100,
        lane: 1,
        direction: 'reverse',
        displayName: 'MID1-201',
        type: 'mRNA',
        transcriptId: null,
        sourceId: 'gencode-v47',
        canonicalIdentity: 'grch38|mRNA|MID1-201',
      },
      {
        rendererId: 99,
        startBp: 200_000_000,
        endBp: 320_000_000,
        lane: 2,
        direction: 'none',
        displayName: 'LONG1-201',
        type: 'lnc_RNA',
        transcriptId: 'ENST-LONG',
        sourceId: null,
        canonicalIdentity: 'grch38|lnc_RNA|ENST-LONG',
      },
    ],
    sortedPrimitives
  );
  return {
    datasetContract: {
      datasetId: 'grch38-gencode-v47',
      datasetVersion: 'mapper-policy-12-all',
      sourceSha256: 'a'.repeat(64),
    },
    assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 3_088_269_832 },
    families: [{ id: 'transcript-glyph-v2', kind: 'transcript' as const, metadata: {} }],
    featureFamilyIndices: new Uint32Array([0, 0, 0]),
    primitives,
    partitionSpanBp,
    interactionIndex,
  };
};

const gpuOnlyScene = (
  built: ReturnType<typeof buildPartitionedTranscriptScene>
): GpuReadyPartitionedTranscriptScene => ({
  partitionSpanBp: built.partitionSpanBp,
  maxPrimitiveSpanBp: built.maxPrimitiveSpanBp,
  packedInstanceData: built.packedInstanceData,
  featureIndices: built.featureIndices,
  partitions: built.partitions,
});

describe('partitioned transcript scene binary v2', () => {
  it('packs the GPU-ready visual/index pair with byte parity and no primitive rebuild or v1 re-decode', async () => {
    const source = makeInput();
    const scene = gpuOnlyScene(
      buildPartitionedTranscriptScene(source.primitives, source.partitionSpanBp)
    );
    const [legacy, direct] = await Promise.all([
      packPartitionedTranscriptSceneBinaryV2(source),
      packGpuReadyPartitionedTranscriptSceneBinaryV2({
        datasetContract: source.datasetContract,
        assemblyContract: source.assemblyContract,
        families: source.families,
        featureFamilyIndices: source.featureFamilyIndices,
        interactionIndex: source.interactionIndex,
        scene,
      }),
    ]);

    expect(direct.manifest).toEqual(legacy.manifest);
    expect(direct.payload).toEqual(legacy.payload);
    expect(direct.packWork).toEqual({
      primitiveCount: 4,
      primitiveObjectAllocations: 0,
      sortOperations: 0,
      primitiveRepackOperations: 0,
      justPackedV1UnpackOperations: 0,
      visualPack: {
        primitiveCount: 4,
        primitiveObjectAllocations: 0,
        sortOperations: 0,
        primitiveRepackOperations: 0,
        exactCoordinateReconstructions: 4,
        semanticPrimitiveScans: 4,
        packedGpuByteCopies: 1,
      },
    });
  });

  it('unpacks the visual artifact and every interaction section as views of one payload', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV2(makeInput());
    const unpacked = await unpackPartitionedTranscriptSceneBinaryV2(
      packed.manifest,
      packed.payload
    );

    expect(unpacked.visual.scene.packedInstanceData.buffer).toBe(packed.payload.buffer);
    expect(unpacked.visual.scene.featureIndices.buffer).toBe(packed.payload.buffer);
    expect(unpacked.visual.featureFamilyIndices.buffer).toBe(packed.payload.buffer);
    expect(unpacked.visual.exactCoordinateBytes.buffer).toBe(packed.payload.buffer);
    expect(unpacked.interactionIndex.featureRecordBytes.buffer).toBe(packed.payload.buffer);
    expect(unpacked.interactionIndex.rendererIdFeatureIndices.buffer).toBe(packed.payload.buffer);
    expect(unpacked.interactionIndex.canonicalIdentityFeatureIndices.buffer).toBe(
      packed.payload.buffer
    );
    expect(unpacked.interactionIndex.intervalFeatureIndices.buffer).toBe(packed.payload.buffer);
    expect(unpacked.interactionIndex.intervalSubtreeMaxEndBytes.buffer).toBe(packed.payload.buffer);
    expect(unpacked.interactionIndex.featurePrimitiveOffsets.buffer).toBe(packed.payload.buffer);
    expect(unpacked.interactionIndex.featurePrimitiveIndices.buffer).toBe(packed.payload.buffer);
    expect(unpacked.interactionIndex.stringBytes.buffer).toBe(packed.payload.buffer);
    expect(
      decodePrepackedAnnotationInteractionFeatureV2(unpacked.interactionIndex, 0)
    ).toMatchObject({
      rendererId: 41,
      displayName: 'SEAM1-201',
      canonicalIdentity: 'grch38|mRNA|ENST-SEAM',
    });
    expect(
      findPrepackedAnnotationFeatureByCanonicalIdentityV2(
        unpacked.interactionIndex,
        'grch38|mRNA|ENST-SEAM'
      )
    ).toBe(0);
  });

  it('trusted-main decode remains zero-copy while skipping every redundant expensive validation pass', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV2(makeInput());
    await validatePartitionedTranscriptSceneBinaryV2(packed.manifest, packed.payload);
    const unpacked = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV2(
      packed.manifest,
      packed.payload,
      TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2
    );

    expect(unpacked.visual.scene.packedInstanceData.buffer).toBe(packed.payload.buffer);
    expect(unpacked.visual.scene.featureIndices.buffer).toBe(packed.payload.buffer);
    expect(unpacked.visual.featureFamilyIndices.buffer).toBe(packed.payload.buffer);
    expect(unpacked.interactionIndex.featureRecordBytes.buffer).toBe(packed.payload.buffer);
    expect(unpacked.interactionIndex.featurePrimitiveIndices.buffer).toBe(packed.payload.buffer);
    expect(unpacked.visual.decodeWork.semanticPrimitiveScans).toBe(0);
    expect(unpacked.trustedMainDecodeWork).toEqual({
      payloadBytesCopied: 0,
      hashOperations: 0,
      visualSemanticPrimitiveScans: 0,
      interactionSemanticFeatureScans: 0,
      visualInteractionCouplingPrimitiveScans: 0,
      justPackedV1UnpackOperations: 0,
    });
  });

  it('trusted-main decode still rejects structural, count, alignment, padding, and trust-marker corruption', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV2(makeInput());
    const decode = (
      manifest = packed.manifest,
      payload = packed.payload,
      marker: string = TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2
    ) =>
      unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV2(
        manifest,
        payload,
        marker as typeof TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2
      );

    const countDrift = structuredClone(packed.manifest);
    countDrift.interactionContract.primitiveCount += 1;
    expect(() => decode(countDrift)).toThrow(/sections are not exact and aligned/);

    const partitionDrift = structuredClone(packed.manifest);
    partitionDrift.visualManifest.partitions[0].firstInstance += 1;
    expect(() => decode(partitionDrift)).toThrow(/partition structure is invalid/);

    const offsetDrift = structuredClone(packed.manifest);
    offsetDrift.sections.intervalSubtreeMaxEnds.byteOffset += 4;
    expect(() => decode(offsetDrift)).toThrow(/sections are not exact and aligned/);

    const misalignedBacking = new Uint8Array(packed.payload.byteLength + 1);
    misalignedBacking.set(packed.payload, 1);
    expect(() => decode(packed.manifest, misalignedBacking.subarray(1))).toThrow(
      /payload is not typed-array aligned/
    );

    const paddingCorrupt = packed.payload.slice();
    const visualEnd =
      packed.manifest.sections.visualPayload.byteOffset +
      packed.manifest.sections.visualPayload.byteLength;
    expect(packed.manifest.sections.featureRecords.byteOffset).toBeGreaterThan(visualEnd);
    paddingCorrupt[visualEnd] = 1;
    expect(() => decode(packed.manifest, paddingCorrupt)).toThrow(/alignment padding is not zero/);

    expect(() => decode(packed.manifest, packed.payload, 'unvalidated-renderer-input')).toThrow(
      /trusted-main validation marker is invalid/
    );
  });

  it('hashes every section and rejects byte, section, and outer-contract mutation', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV2(makeInput());
    const corrupt = packed.payload.slice();
    corrupt[packed.manifest.sections.featureRecords.byteOffset] ^= 1;
    await expect(
      validatePartitionedTranscriptSceneBinaryV2(packed.manifest, corrupt)
    ).rejects.toThrow(/payload sha256 mismatch/);

    const sectionHashDrift = structuredClone(packed.manifest);
    sectionHashDrift.sections.canonicalIdentityFeatureIndices.sha256 = 'b'.repeat(64);
    await expect(
      validatePartitionedTranscriptSceneBinaryV2(sectionHashDrift, packed.payload)
    ).rejects.toThrow(/canonicalIdentityFeatureIndices sha256 mismatch/);

    const canonicalPermutationCorrupt = packed.payload.slice();
    canonicalPermutationCorrupt[
      packed.manifest.sections.canonicalIdentityFeatureIndices.byteOffset
    ] ^= 1;
    await expect(
      validatePartitionedTranscriptSceneBinaryV2(packed.manifest, canonicalPermutationCorrupt)
    ).rejects.toThrow(/payload sha256 mismatch/);

    const missingCanonicalSection = structuredClone(packed.manifest);
    delete (missingCanonicalSection.sections as Partial<typeof missingCanonicalSection.sections>)
      .canonicalIdentityFeatureIndices;
    await expect(
      validatePartitionedTranscriptSceneBinaryV2(missingCanonicalSection, packed.payload)
    ).rejects.toThrow(/sections are not exact and aligned/);

    const contractDrift = structuredClone(packed.manifest);
    contractDrift.interactionContract.featureRecordBytes = 72;
    contractDrift.visualManifest.datasetContract.datasetVersion = 'stale-policy';
    await expect(
      validatePartitionedTranscriptSceneBinaryV2(contractDrift, packed.payload)
    ).rejects.toThrow(/contract sha256 mismatch/);
  });

  it('rejects misaligned section contracts before constructing typed views', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV2(makeInput());
    const drift = structuredClone(packed.manifest);
    drift.sections.intervalSubtreeMaxEnds.byteOffset += 4;
    await expect(validatePartitionedTranscriptSceneBinaryV2(drift, packed.payload)).rejects.toThrow(
      /sections are not exact and aligned/
    );

    const backing = new Uint8Array(packed.payload.byteLength + 1);
    backing.set(packed.payload, 1);
    await expect(
      validatePartitionedTranscriptSceneBinaryV2(packed.manifest, backing.subarray(1))
    ).rejects.toThrow(/payload is not typed-array aligned/);
  });

  it('refuses a same-sized interaction index owned by different visual primitives', async () => {
    const input = makeInput();
    const sortedPrimitives = buildPartitionedTranscriptScene(
      input.primitives,
      input.partitionSpanBp
    ).sortedPrimitives;
    input.interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 41,
          startBp: 0,
          endBp: 400_000_000,
          lane: 0,
          direction: 'forward',
          displayName: 'SEAM1-201',
          type: 'mRNA',
          transcriptId: 'ENST-SEAM',
          sourceId: 'gencode-v47',
          canonicalIdentity: 'grch38|mRNA|ENST-SEAM',
        },
        {
          rendererId: 7,
          startBp: 0,
          endBp: 400_000_000,
          lane: 1,
          direction: 'reverse',
          displayName: 'MID1-201',
          type: 'mRNA',
          transcriptId: null,
          sourceId: 'gencode-v47',
          canonicalIdentity: 'grch38|mRNA|MID1-201',
        },
        {
          rendererId: 99,
          startBp: 0,
          endBp: 400_000_000,
          lane: 2,
          direction: 'none',
          displayName: 'LONG1-201',
          type: 'lnc_RNA',
          transcriptId: 'ENST-LONG',
          sourceId: null,
          canonicalIdentity: 'grch38|lnc_RNA|ENST-LONG',
        },
      ],
      sortedPrimitives.map((entry) => ({ featureIndex: (entry.featureIndex + 1) % 3 }))
    );
    await expect(packPartitionedTranscriptSceneBinaryV2(input)).rejects.toThrow(
      /visual owner mismatch/
    );
  });

  it('refuses feature coordinates beyond the declared full assembly', async () => {
    const input = makeInput();
    const features = Array.from({ length: input.interactionIndex.featureCount }, (_, index) => {
      const { featureIndex: _featureIndex, ...feature } =
        decodePrepackedAnnotationInteractionFeatureV2(input.interactionIndex, index);
      return index === 2
        ? { ...feature, endBp: input.assemblyContract.assemblyLengthBp + 1 }
        : feature;
    });
    input.interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
      features,
      buildPartitionedTranscriptScene(input.primitives, input.partitionSpanBp).sortedPrimitives
    );
    await expect(packPartitionedTranscriptSceneBinaryV2(input)).rejects.toThrow(
      /exceeds assembly length/
    );
  });
});
