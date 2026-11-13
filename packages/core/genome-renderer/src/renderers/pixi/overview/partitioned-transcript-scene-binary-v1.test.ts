import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import {
  compareAnnotationSceneRendererPreparationWork,
  packGpuReadyPartitionedTranscriptSceneBinaryV1,
  packPartitionedTranscriptSceneBinaryV1,
  unpackPartitionedTranscriptSceneBinaryV1,
  validatePartitionedTranscriptSceneBinaryV1,
} from './partitioned-transcript-scene-binary-v1';
import {
  buildPartitionedTranscriptScene,
  type GpuReadyPartitionedTranscriptScene,
  planTranscriptPartitionSubmissions,
} from './partitioned-transcript-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';

const primitive = (
  featureIndex: number,
  startBp: number,
  endBp: number
): AnnotationScenePrimitiveV1 => ({
  startBp,
  endBp,
  featureIndex,
  offsetCenter: featureIndex + 0.25,
  halfH: 7,
  color: 0x123456,
  alpha: 0.85,
  cdsFade: 0,
  dirSign: featureIndex % 2 ? -1 : 1,
});

const input = () => ({
  datasetContract: {
    datasetId: 'hg002',
    datasetVersion: 'resolved-v2',
    sourceSha256: 'a'.repeat(64),
  },
  assemblyContract: { assemblyId: 'grch38', assemblyLengthBp: 43_100_000_000 },
  families: [{ id: 'transcript-glyph-v2', kind: 'transcript' as const, metadata: {} }],
  featureFamilyIndices: new Uint32Array([0, 0, 0, 0]),
  primitives: [
    primitive(3, 40_000_000_003, 40_000_001_003),
    primitive(0, 10, 20),
    primitive(2, 250_000_000, 310_000_000),
    primitive(1, 120_000_000, 120_000_100),
  ],
  partitionSpanBp: 100_000_000,
});

const gpuOnlyScene = (
  built: ReturnType<typeof buildPartitionedTranscriptScene>
): GpuReadyPartitionedTranscriptScene => ({
  partitionSpanBp: built.partitionSpanBp,
  maxPrimitiveSpanBp: built.maxPrimitiveSpanBp,
  packedInstanceData: built.packedInstanceData,
  featureIndices: built.featureIndices,
  partitions: built.partitions,
});

describe('partitioned transcript scene binary v1', () => {
  it('packs an already GPU-ready scene with byte-identical durable output and zero primitive work', async () => {
    const source = input();
    const scene = gpuOnlyScene(
      buildPartitionedTranscriptScene(source.primitives, source.partitionSpanBp)
    );
    const [legacy, direct] = await Promise.all([
      packPartitionedTranscriptSceneBinaryV1(source),
      packGpuReadyPartitionedTranscriptSceneBinaryV1({
        datasetContract: source.datasetContract,
        assemblyContract: source.assemblyContract,
        families: source.families,
        featureFamilyIndices: source.featureFamilyIndices,
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
      exactCoordinateReconstructions: 4,
      semanticPrimitiveScans: 4,
      packedGpuByteCopies: 1,
    });
  });

  it('fails closed on corrupt GPU coordinates, feature ownership, and partition structure', async () => {
    const source = input();
    const built = gpuOnlyScene(
      buildPartitionedTranscriptScene(source.primitives, source.partitionSpanBp)
    );
    const directInput = () => ({
      datasetContract: source.datasetContract,
      assemblyContract: source.assemblyContract,
      families: source.families,
      featureFamilyIndices: source.featureFamilyIndices,
      scene: {
        partitionSpanBp: built.partitionSpanBp,
        maxPrimitiveSpanBp: built.maxPrimitiveSpanBp,
        packedInstanceData: built.packedInstanceData.slice(),
        featureIndices: built.featureIndices.slice(),
        partitions: built.partitions.map((partition) => ({ ...partition })),
      },
    });

    const fractionalCoordinate = directInput();
    fractionalCoordinate.scene.packedInstanceData[1] += 0.5;
    await expect(
      packGpuReadyPartitionedTranscriptSceneBinaryV1(fractionalCoordinate)
    ).rejects.toThrow(/GPU coordinate 0 start pair is not exact/);

    const staleFeatureOwner = directInput();
    staleFeatureOwner.scene.featureIndices[0] = source.featureFamilyIndices.length;
    await expect(packGpuReadyPartitionedTranscriptSceneBinaryV1(staleFeatureOwner)).rejects.toThrow(
      /GPU feature index 0 is invalid/
    );

    const invalidPartition = directInput();
    invalidPartition.scene.partitions[0].firstInstance = 1;
    await expect(packGpuReadyPartitionedTranscriptSceneBinaryV1(invalidPartition)).rejects.toThrow(
      /partition ranges are invalid/
    );

    const unsorted = directInput();
    const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
    const first = unsorted.scene.packedInstanceData.slice(0, stride);
    unsorted.scene.packedInstanceData.copyWithin(0, stride, stride * 2);
    unsorted.scene.packedInstanceData.set(first, stride);
    await expect(packGpuReadyPartitionedTranscriptSceneBinaryV1(unsorted)).rejects.toThrow(
      /primitive [01] is invalid/
    );
  });

  it('decodes typed-array views directly over one payload with exact uint64 sidecars', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV1(input());
    const unpacked = await unpackPartitionedTranscriptSceneBinaryV1(
      packed.manifest,
      packed.payload
    );

    expect(unpacked.scene.packedInstanceData.buffer).toBe(packed.payload.buffer);
    expect(unpacked.scene.featureIndices.buffer).toBe(packed.payload.buffer);
    expect(unpacked.featureFamilyIndices.buffer).toBe(packed.payload.buffer);
    expect(Array.from(unpacked.scene.featureIndices)).toEqual([0, 1, 2, 3]);
    expect(unpacked.scene.packedInstanceData.byteLength).toBe(
      input().primitives.length * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes
    );
    expect(unpacked.scene.partitions.map(({ partitionIndex }) => partitionIndex)).toEqual([
      0, 1, 2, 400,
    ]);

    const exact = new DataView(
      unpacked.exactCoordinateBytes.buffer,
      unpacked.exactCoordinateBytes.byteOffset,
      unpacked.exactCoordinateBytes.byteLength
    );
    expect(Number(exact.getBigUint64(3 * 16, true))).toBe(40_000_000_003);
    expect(Number(exact.getBigUint64(3 * 16 + 8, true))).toBe(40_000_001_003);
    expect(unpacked.decodeWork).toEqual({
      primitiveCount: 4,
      primitiveObjectAllocations: 0,
      sortOperations: 0,
      repackOperations: 0,
      payloadBytesCopied: 0,
      typedArrayViews: 3,
      semanticPrimitiveScans: 4,
    });
    expect(packed.manifest.geometryContract).toMatchObject({
      geometryId: 'partitioned-instanced-transcript.track-local.v2',
      verticalCoordinateSpace: 'annotation-track-local-px',
      verticalOrigin: 'annotation-track-base',
      annotationBarHeightPx: 14,
      annotationLaneStepPx: 16,
      offsetCenterFormula: '-barHeight/2-lane*laneStep',
      gpuInstanceRecordBytes: 48,
    });
  });

  it('preserves partition halos and stable feature-index hit identity', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV1(input());
    const { scene } = await unpackPartitionedTranscriptSceneBinaryV1(
      packed.manifest,
      packed.payload
    );
    expect(
      planTranscriptPartitionSubmissions(scene, 300_000_000, 320_000_000).map(
        ({ partitionIndex }) => partitionIndex
      )
    ).toEqual([2]);
    const partition = scene.partitions.find(({ partitionIndex }) => partitionIndex === 400)!;
    expect(scene.featureIndices[partition.firstInstance]).toBe(3);
  });

  it('rejects byte and contract mutation before exposing GPU views', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV1(input());
    const corrupt = packed.payload.slice();
    corrupt[0] ^= 1;
    await expect(
      validatePartitionedTranscriptSceneBinaryV1(packed.manifest, corrupt)
    ).rejects.toThrow(/payload sha256 mismatch/);
    const drift = structuredClone(packed.manifest);
    drift.partitionSpanBp += 1;
    await expect(validatePartitionedTranscriptSceneBinaryV1(drift, packed.payload)).rejects.toThrow(
      /contract sha256 mismatch/
    );
  });

  it('rejects a blob carrying the old spine-relative geometry contract before exposing GPU views', async () => {
    const packed = await packPartitionedTranscriptSceneBinaryV1(input());
    const old = structuredClone(packed.manifest);
    const oldGeometry = old.geometryContract as unknown as Record<string, unknown>;
    oldGeometry.geometryId = 'partitioned-instanced-transcript.v1';
    delete oldGeometry.verticalCoordinateSpace;
    delete oldGeometry.verticalOrigin;
    delete oldGeometry.annotationBarHeightPx;
    delete oldGeometry.annotationLaneStepPx;
    delete oldGeometry.offsetCenterFormula;
    await expect(unpackPartitionedTranscriptSceneBinaryV1(old, packed.payload)).rejects.toThrow(
      /geometry contract is unsupported/
    );
  });

  it('accounts the realistic 437,521-record cold-hit work without wall-time guesses', () => {
    const comparison = compareAnnotationSceneRendererPreparationWork(437_521, 19_869);
    expect(comparison).toEqual({
      legacySourcePrimitivePath: {
        primitiveObjectAllocations: 1_312_563,
        fullRecordPasses: 6,
        sortOperations: 1,
        repackOperations: 1,
        typedArrayBytesAllocated: 22_830_568,
      },
      directPartitionedBinaryPath: {
        primitiveObjectAllocations: 0,
        fullRecordPasses: 1,
        sortOperations: 0,
        repackOperations: 0,
        typedArrayBytesAllocated: 0,
      },
    });
  });
});
