import type {
  AnnotationSceneAssemblyContractV1,
  AnnotationSceneDatasetContractV1,
  AnnotationSceneJsonValue,
  AnnotationScenePrimitiveV1,
  AnnotationShapeFamilyV1,
} from './annotation-scene-binary-v1';
import {
  buildPartitionedTranscriptScene,
  type GpuReadyPartitionedTranscriptScene,
  type TranscriptInstancePartition,
} from './partitioned-transcript-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';
import { BP_COORDINATE_CHUNK_SIZE, unpackBpCoordinate } from './bp-coordinate-packing';

export const PARTITIONED_TRANSCRIPT_SCENE_BINARY_V1 =
  'partitioned-transcript-scene-binary.v1' as const;
export const EXACT_TRANSCRIPT_COORDINATE_RECORD_BYTES = 16;
const UINT32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface BinarySectionV1 {
  byteOffset: number;
  byteLength: number;
  count: number;
  recordBytes: number;
}

export interface PartitionedTranscriptSceneBinaryManifestV1 {
  schema: typeof PARTITIONED_TRANSCRIPT_SCENE_BINARY_V1;
  datasetContract: AnnotationSceneDatasetContractV1;
  assemblyContract: AnnotationSceneAssemblyContractV1;
  families: AnnotationShapeFamilyV1[];
  partitionSpanBp: number;
  maxPrimitiveSpanBp: number;
  partitions: TranscriptInstancePartition[];
  geometryContract: {
    geometryId: 'partitioned-instanced-transcript.track-local.v2';
    coordinateSpace: 'assembly-global-bp';
    coordinateSystem: 'zero-based-half-open';
    exactCoordinateEncoding: 'uint64-le-number-safe';
    gpuCoordinateEncoding: 'float32-chunk-delta-4096-le';
    verticalCoordinateSpace: 'annotation-track-local-px';
    verticalOrigin: 'annotation-track-base';
    annotationBarHeightPx: 14;
    annotationLaneStepPx: 16;
    offsetCenterFormula: '-barHeight/2-lane*laneStep';
    gpuInstanceRecordBytes: 48;
  };
  sections: {
    exactCoordinates: BinarySectionV1;
    gpuInstances: BinarySectionV1;
    primitiveFeatureIndices: BinarySectionV1;
    featureFamilies: BinarySectionV1;
  };
  byteLength: number;
  integrity: {
    algorithm: 'sha256';
    payloadSha256: string;
    contractSha256: string;
  };
}

export interface PackPartitionedTranscriptSceneBinaryV1Input {
  datasetContract: AnnotationSceneDatasetContractV1;
  assemblyContract: AnnotationSceneAssemblyContractV1;
  families: ReadonlyArray<AnnotationShapeFamilyV1>;
  featureFamilyIndices: ArrayLike<number>;
  primitives: ReadonlyArray<AnnotationScenePrimitiveV1>;
  partitionSpanBp: number;
}

export type PackGpuReadyPartitionedTranscriptSceneBinaryV1Input = Omit<
  PackPartitionedTranscriptSceneBinaryV1Input,
  'primitives' | 'partitionSpanBp'
> & {
  scene: GpuReadyPartitionedTranscriptScene;
};

export interface PackedPartitionedTranscriptSceneBinaryV1 {
  manifest: PartitionedTranscriptSceneBinaryManifestV1;
  payload: Uint8Array;
}

export interface GpuReadySceneBinaryPackWorkV1 {
  primitiveCount: number;
  primitiveObjectAllocations: 0;
  sortOperations: 0;
  primitiveRepackOperations: 0;
  exactCoordinateReconstructions: number;
  semanticPrimitiveScans: number;
  packedGpuByteCopies: 1;
}

export interface PackedGpuReadyPartitionedTranscriptSceneBinaryV1 extends PackedPartitionedTranscriptSceneBinaryV1 {
  packWork: GpuReadySceneBinaryPackWorkV1;
}

export interface DirectSceneDecodeWork {
  primitiveCount: number;
  primitiveObjectAllocations: 0;
  sortOperations: 0;
  repackOperations: 0;
  payloadBytesCopied: 0;
  typedArrayViews: 3;
  semanticPrimitiveScans: number;
}

export interface AnnotationSceneRendererPreparationComparison {
  legacySourcePrimitivePath: {
    primitiveObjectAllocations: number;
    fullRecordPasses: 6;
    sortOperations: 1;
    repackOperations: 1;
    typedArrayBytesAllocated: number;
  };
  directPartitionedBinaryPath: {
    primitiveObjectAllocations: 0;
    fullRecordPasses: 1;
    sortOperations: 0;
    repackOperations: 0;
    typedArrayBytesAllocated: 0;
  };
}

export function compareAnnotationSceneRendererPreparationWork(
  primitiveCount: number,
  featureCount: number
): AnnotationSceneRendererPreparationComparison {
  if (
    !Number.isSafeInteger(primitiveCount) ||
    primitiveCount < 0 ||
    !Number.isSafeInteger(featureCount) ||
    featureCount < 0
  ) {
    throw new Error('annotation scene preparation counts must be non-negative safe integers');
  }
  return {
    legacySourcePrimitivePath: {
      primitiveObjectAllocations: primitiveCount * 3,
      fullRecordPasses: 6,
      sortOperations: 1,
      repackOperations: 1,
      typedArrayBytesAllocated:
        primitiveCount *
          (TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes + Uint32Array.BYTES_PER_ELEMENT) +
        featureCount * Uint32Array.BYTES_PER_ELEMENT,
    },
    directPartitionedBinaryPath: {
      primitiveObjectAllocations: 0,
      fullRecordPasses: 1,
      sortOperations: 0,
      repackOperations: 0,
      typedArrayBytesAllocated: 0,
    },
  };
}

export interface UnpackedPartitionedTranscriptSceneBinaryV1 {
  scene: GpuReadyPartitionedTranscriptScene;
  families: AnnotationShapeFamilyV1[];
  featureFamilyIndices: Uint32Array;
  exactCoordinateBytes: Uint8Array;
  decodeWork: DirectSceneDecodeWork;
}

const GEOMETRY_CONTRACT = {
  geometryId: 'partitioned-instanced-transcript.track-local.v2',
  coordinateSpace: 'assembly-global-bp',
  coordinateSystem: 'zero-based-half-open',
  exactCoordinateEncoding: 'uint64-le-number-safe',
  gpuCoordinateEncoding: 'float32-chunk-delta-4096-le',
  verticalCoordinateSpace: 'annotation-track-local-px',
  verticalOrigin: 'annotation-track-base',
  annotationBarHeightPx: 14,
  annotationLaneStepPx: 16,
  offsetCenterFormula: '-barHeight/2-lane*laneStep',
  gpuInstanceRecordBytes: 48,
} as const;

export async function packPartitionedTranscriptSceneBinaryV1(
  input: PackPartitionedTranscriptSceneBinaryV1Input
): Promise<PackedPartitionedTranscriptSceneBinaryV1> {
  validateOuterContracts(input);
  const built = buildPartitionedTranscriptScene(input.primitives, input.partitionSpanBp);
  return packGpuReadyScenePayload({
    datasetContract: input.datasetContract,
    assemblyContract: input.assemblyContract,
    families: input.families,
    featureFamilyIndices: input.featureFamilyIndices,
    scene: built,
  });
}

export async function packGpuReadyPartitionedTranscriptSceneBinaryV1(
  input: PackGpuReadyPartitionedTranscriptSceneBinaryV1Input
): Promise<PackedGpuReadyPartitionedTranscriptSceneBinaryV1> {
  validateOuterContracts({
    ...input,
    primitives: [],
    partitionSpanBp: input.scene.partitionSpanBp,
  });
  const packed = await packGpuReadyScenePayload(input);
  const primitiveCount = input.scene.featureIndices.length;
  return {
    ...packed,
    packWork: {
      primitiveCount,
      primitiveObjectAllocations: 0,
      sortOperations: 0,
      primitiveRepackOperations: 0,
      exactCoordinateReconstructions: primitiveCount,
      semanticPrimitiveScans: primitiveCount,
      packedGpuByteCopies: 1,
    },
  };
}

async function packGpuReadyScenePayload(
  input: PackGpuReadyPartitionedTranscriptSceneBinaryV1Input
): Promise<PackedPartitionedTranscriptSceneBinaryV1> {
  const built = input.scene;
  const featureFamilyIndices = normalizeUint32Indices(
    input.featureFamilyIndices,
    input.families.length,
    'featureFamilyIndices'
  );
  validateGpuReadySceneShape(built, featureFamilyIndices.length);
  const primitiveCount = built.featureIndices.length;

  const exactCoordinates = section(0, primitiveCount, EXACT_TRANSCRIPT_COORDINATE_RECORD_BYTES);
  const gpuInstances = section(
    exactCoordinates.byteOffset + exactCoordinates.byteLength,
    primitiveCount,
    TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes
  );
  const primitiveFeatureIndices = section(
    gpuInstances.byteOffset + gpuInstances.byteLength,
    primitiveCount,
    UINT32_BYTES
  );
  const featureFamilies = section(
    primitiveFeatureIndices.byteOffset + primitiveFeatureIndices.byteLength,
    featureFamilyIndices.length,
    UINT32_BYTES
  );
  const byteLength = featureFamilies.byteOffset + featureFamilies.byteLength;
  const payload = new Uint8Array(byteLength);
  const view = new DataView(payload.buffer);
  for (let i = 0; i < primitiveCount; i++) {
    const recordBase = i * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
    const startBp = exactCoordinateFromGpuPair(
      built.packedInstanceData[recordBase + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
      built.packedInstanceData[recordBase + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta],
      i,
      'start'
    );
    const endBp = exactCoordinateFromGpuPair(
      built.packedInstanceData[recordBase + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk],
      built.packedInstanceData[recordBase + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta],
      i,
      'end'
    );
    if (
      !Number.isSafeInteger(startBp) ||
      !Number.isSafeInteger(endBp) ||
      startBp < 0 ||
      endBp <= startBp ||
      endBp > input.assemblyContract.assemblyLengthBp
    ) {
      throw new Error(`partitioned transcript GPU coordinate ${i} is invalid`);
    }
    if (built.featureIndices[i] >= featureFamilyIndices.length) {
      throw new Error(`partitioned transcript GPU feature index ${i} is invalid`);
    }
    const offset = exactCoordinates.byteOffset + i * EXACT_TRANSCRIPT_COORDINATE_RECORD_BYTES;
    view.setBigUint64(offset, BigInt(startBp), true);
    view.setBigUint64(offset + 8, BigInt(endBp), true);
    view.setUint32(
      primitiveFeatureIndices.byteOffset + i * UINT32_BYTES,
      built.featureIndices[i],
      true
    );
  }
  payload.set(
    new Uint8Array(
      built.packedInstanceData.buffer,
      built.packedInstanceData.byteOffset,
      built.packedInstanceData.byteLength
    ),
    gpuInstances.byteOffset
  );
  for (let i = 0; i < featureFamilyIndices.length; i++) {
    view.setUint32(featureFamilies.byteOffset + i * UINT32_BYTES, featureFamilyIndices[i], true);
  }

  const manifest: PartitionedTranscriptSceneBinaryManifestV1 = {
    schema: PARTITIONED_TRANSCRIPT_SCENE_BINARY_V1,
    datasetContract: structuredClone(input.datasetContract),
    assemblyContract: structuredClone(input.assemblyContract),
    families: input.families.map((family) => structuredClone(family)),
    partitionSpanBp: built.partitionSpanBp,
    maxPrimitiveSpanBp: built.maxPrimitiveSpanBp,
    partitions: structuredClone(built.partitions),
    geometryContract: { ...GEOMETRY_CONTRACT },
    sections: { exactCoordinates, gpuInstances, primitiveFeatureIndices, featureFamilies },
    byteLength,
    integrity: { algorithm: 'sha256', payloadSha256: '', contractSha256: '' },
  };
  validatePayloadSemantics(manifest, payload);
  manifest.integrity.payloadSha256 = await sha256Hex(payload);
  manifest.integrity.contractSha256 = await sha256Hex(
    new TextEncoder().encode(canonicalJson(contractMaterial(manifest)))
  );
  return { manifest, payload };
}

function exactCoordinateFromGpuPair(
  chunk: number,
  delta: number,
  primitiveIndex: number,
  edge: 'start' | 'end'
): number {
  if (
    !Number.isInteger(chunk) ||
    chunk < 0 ||
    chunk > 2 ** 24 ||
    !Number.isInteger(delta) ||
    delta < 0 ||
    delta >= BP_COORDINATE_CHUNK_SIZE
  ) {
    throw new Error(
      `partitioned transcript GPU coordinate ${primitiveIndex} ${edge} pair is not exact`
    );
  }
  return unpackBpCoordinate(chunk, delta);
}

export async function validatePartitionedTranscriptSceneBinaryV1(
  manifest: PartitionedTranscriptSceneBinaryManifestV1,
  payload: Uint8Array
): Promise<void> {
  validateManifestStructure(manifest, payload);
  if ((await sha256Hex(payload)) !== manifest.integrity.payloadSha256) {
    throw new Error('partitioned transcript scene payload sha256 mismatch');
  }
  if (
    (await sha256Hex(new TextEncoder().encode(canonicalJson(contractMaterial(manifest))))) !==
    manifest.integrity.contractSha256
  ) {
    throw new Error('partitioned transcript scene contract sha256 mismatch');
  }
  validatePayloadSemantics(manifest, payload);
}

export async function unpackPartitionedTranscriptSceneBinaryV1(
  manifest: PartitionedTranscriptSceneBinaryManifestV1,
  payload: Uint8Array
): Promise<UnpackedPartitionedTranscriptSceneBinaryV1> {
  await validatePartitionedTranscriptSceneBinaryV1(manifest, payload);
  return createZeroCopyViews(manifest, payload, manifest.sections.gpuInstances.count);
}

export function unpackStructurallyValidatedPartitionedTranscriptSceneBinaryV1ForTrustedMain(
  manifest: PartitionedTranscriptSceneBinaryManifestV1,
  payload: Uint8Array
): UnpackedPartitionedTranscriptSceneBinaryV1 {
  validateManifestStructure(manifest, payload);
  validatePartitionStructure(manifest);
  return createZeroCopyViews(manifest, payload, 0);
}

function createZeroCopyViews(
  manifest: PartitionedTranscriptSceneBinaryManifestV1,
  payload: Uint8Array,
  semanticPrimitiveScans: number
): UnpackedPartitionedTranscriptSceneBinaryV1 {
  const absolute = payload.byteOffset;
  const instances = manifest.sections.gpuInstances;
  const primitiveFeatures = manifest.sections.primitiveFeatureIndices;
  const featureFamilies = manifest.sections.featureFamilies;
  if (
    (absolute + instances.byteOffset) % Float32Array.BYTES_PER_ELEMENT !== 0 ||
    (absolute + primitiveFeatures.byteOffset) % Uint32Array.BYTES_PER_ELEMENT !== 0 ||
    (absolute + featureFamilies.byteOffset) % Uint32Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new Error('partitioned transcript scene payload is not typed-array aligned');
  }
  return {
    scene: {
      partitionSpanBp: manifest.partitionSpanBp,
      maxPrimitiveSpanBp: manifest.maxPrimitiveSpanBp,
      packedInstanceData: new Float32Array(
        payload.buffer,
        absolute + instances.byteOffset,
        instances.byteLength / Float32Array.BYTES_PER_ELEMENT
      ),
      featureIndices: new Uint32Array(
        payload.buffer,
        absolute + primitiveFeatures.byteOffset,
        primitiveFeatures.count
      ),
      partitions: manifest.partitions.map((partition) => ({ ...partition })),
    },
    families: structuredClone(manifest.families),
    featureFamilyIndices: new Uint32Array(
      payload.buffer,
      absolute + featureFamilies.byteOffset,
      featureFamilies.count
    ),
    exactCoordinateBytes: payload.subarray(
      manifest.sections.exactCoordinates.byteOffset,
      manifest.sections.exactCoordinates.byteOffset + manifest.sections.exactCoordinates.byteLength
    ),
    decodeWork: {
      primitiveCount: instances.count,
      primitiveObjectAllocations: 0,
      sortOperations: 0,
      repackOperations: 0,
      payloadBytesCopied: 0,
      typedArrayViews: 3,
      semanticPrimitiveScans,
    },
  };
}

function validateOuterContracts(input: PackPartitionedTranscriptSceneBinaryV1Input): void {
  if (!input.datasetContract?.datasetId || !input.datasetContract.datasetVersion) {
    throw new Error('partitioned transcript scene dataset contract is invalid');
  }
  if (!SHA256_HEX.test(input.datasetContract.sourceSha256)) {
    throw new Error('partitioned transcript scene source sha256 is invalid');
  }
  if (
    !input.assemblyContract?.assemblyId ||
    !Number.isSafeInteger(input.assemblyContract.assemblyLengthBp) ||
    input.assemblyContract.assemblyLengthBp <= 0
  ) {
    throw new Error('partitioned transcript scene assembly contract is invalid');
  }
  if (!Array.isArray(input.families) || input.families.length === 0) {
    throw new Error('partitioned transcript scene families are invalid');
  }
}

function validateGpuReadySceneShape(
  scene: GpuReadyPartitionedTranscriptScene,
  featureCount: number
): void {
  if (!Number.isSafeInteger(scene.partitionSpanBp) || scene.partitionSpanBp <= 0) {
    throw new Error('partitioned transcript GPU scene partition span is invalid');
  }
  if (!Number.isSafeInteger(scene.maxPrimitiveSpanBp) || scene.maxPrimitiveSpanBp <= 0) {
    throw new Error('partitioned transcript GPU scene max primitive span is invalid');
  }
  if (!(scene.packedInstanceData instanceof Float32Array)) {
    throw new Error('partitioned transcript GPU instance data is invalid');
  }
  if (!(scene.featureIndices instanceof Uint32Array)) {
    throw new Error('partitioned transcript GPU feature indices are invalid');
  }
  if (
    scene.packedInstanceData.length !==
    scene.featureIndices.length * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats
  ) {
    throw new Error('partitioned transcript GPU instance/feature counts do not match');
  }
  if (!Number.isSafeInteger(featureCount) || featureCount <= 0) {
    throw new Error('partitioned transcript GPU feature count is invalid');
  }
  if (!Array.isArray(scene.partitions) || scene.partitions.length === 0) {
    throw new Error('partitioned transcript GPU partitions are invalid');
  }
}

function validateManifestStructure(
  manifest: PartitionedTranscriptSceneBinaryManifestV1,
  payload: Uint8Array
): void {
  if (manifest?.schema !== PARTITIONED_TRANSCRIPT_SCENE_BINARY_V1) {
    throw new Error(
      `partitioned transcript scene schema must be ${PARTITIONED_TRANSCRIPT_SCENE_BINARY_V1}`
    );
  }
  validateOuterContracts({
    datasetContract: manifest.datasetContract,
    assemblyContract: manifest.assemblyContract,
    families: manifest.families,
    featureFamilyIndices: [],
    primitives: [],
    partitionSpanBp: manifest.partitionSpanBp,
  });
  if (
    manifest.geometryContract?.geometryId !== GEOMETRY_CONTRACT.geometryId ||
    manifest.geometryContract.coordinateSpace !== GEOMETRY_CONTRACT.coordinateSpace ||
    manifest.geometryContract.coordinateSystem !== GEOMETRY_CONTRACT.coordinateSystem ||
    manifest.geometryContract.exactCoordinateEncoding !==
      GEOMETRY_CONTRACT.exactCoordinateEncoding ||
    manifest.geometryContract.gpuCoordinateEncoding !== GEOMETRY_CONTRACT.gpuCoordinateEncoding ||
    manifest.geometryContract.verticalCoordinateSpace !==
      GEOMETRY_CONTRACT.verticalCoordinateSpace ||
    manifest.geometryContract.verticalOrigin !== GEOMETRY_CONTRACT.verticalOrigin ||
    manifest.geometryContract.annotationBarHeightPx !== GEOMETRY_CONTRACT.annotationBarHeightPx ||
    manifest.geometryContract.annotationLaneStepPx !== GEOMETRY_CONTRACT.annotationLaneStepPx ||
    manifest.geometryContract.offsetCenterFormula !== GEOMETRY_CONTRACT.offsetCenterFormula ||
    manifest.geometryContract.gpuInstanceRecordBytes !==
      TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes
  ) {
    throw new Error('partitioned transcript scene geometry contract is unsupported');
  }
  if (!Number.isSafeInteger(manifest.partitionSpanBp) || manifest.partitionSpanBp <= 0) {
    throw new Error('partitioned transcript scene partition span is invalid');
  }
  if (!Number.isSafeInteger(manifest.maxPrimitiveSpanBp) || manifest.maxPrimitiveSpanBp <= 0) {
    throw new Error('partitioned transcript scene max primitive span is invalid');
  }
  const ordered = [
    [manifest.sections?.exactCoordinates, EXACT_TRANSCRIPT_COORDINATE_RECORD_BYTES],
    [manifest.sections?.gpuInstances, TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes],
    [manifest.sections?.primitiveFeatureIndices, UINT32_BYTES],
    [manifest.sections?.featureFamilies, UINT32_BYTES],
  ] as const;
  let expectedOffset = 0;
  for (const [entry, recordBytes] of ordered) {
    if (
      !entry ||
      entry.byteOffset !== expectedOffset ||
      entry.recordBytes !== recordBytes ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 0 ||
      entry.byteLength !== entry.count * entry.recordBytes
    ) {
      throw new Error('partitioned transcript scene sections are not exact and contiguous');
    }
    expectedOffset += entry.byteLength;
  }
  if (
    manifest.sections.exactCoordinates.count !== manifest.sections.gpuInstances.count ||
    manifest.sections.exactCoordinates.count !== manifest.sections.primitiveFeatureIndices.count ||
    manifest.byteLength !== expectedOffset ||
    payload.byteLength !== expectedOffset
  ) {
    throw new Error('partitioned transcript scene payload length/count contract is invalid');
  }
  if (
    manifest.integrity?.algorithm !== 'sha256' ||
    !SHA256_HEX.test(manifest.integrity.payloadSha256) ||
    !SHA256_HEX.test(manifest.integrity.contractSha256)
  ) {
    throw new Error('partitioned transcript scene integrity contract is invalid');
  }
}

function validatePartitionStructure(manifest: PartitionedTranscriptSceneBinaryManifestV1): void {
  const primitiveCount = manifest.sections.gpuInstances.count;
  if (!Array.isArray(manifest.partitions) || manifest.partitions.length === 0) {
    throw new Error('partitioned transcript scene partition structure is invalid');
  }
  let cursor = 0;
  let previousPartitionIndex = -1;
  for (const partition of manifest.partitions) {
    if (
      !partition ||
      !Number.isSafeInteger(partition.partitionIndex) ||
      partition.partitionIndex < 0 ||
      partition.partitionIndex <= previousPartitionIndex ||
      partition.key !== `bp-partition-${partition.partitionIndex}` ||
      !Number.isSafeInteger(partition.startBp) ||
      partition.startBp !== partition.partitionIndex * manifest.partitionSpanBp ||
      !Number.isSafeInteger(partition.endBpExclusive) ||
      partition.endBpExclusive !==
        (manifest.partitionSpanBp > Number.MAX_SAFE_INTEGER - partition.startBp
          ? Number.MAX_SAFE_INTEGER
          : partition.startBp + manifest.partitionSpanBp) ||
      partition.endBpExclusive <= partition.startBp ||
      partition.firstInstance !== cursor ||
      !Number.isSafeInteger(partition.instanceCount) ||
      partition.instanceCount <= 0 ||
      !Number.isSafeInteger(partition.minStartBp) ||
      !Number.isSafeInteger(partition.maxEndBp) ||
      partition.minStartBp < partition.startBp ||
      partition.minStartBp >= partition.endBpExclusive ||
      partition.maxEndBp <= partition.minStartBp ||
      partition.maxEndBp > manifest.assemblyContract.assemblyLengthBp
    ) {
      throw new Error('partitioned transcript scene partition structure is invalid');
    }
    cursor += partition.instanceCount;
    if (!Number.isSafeInteger(cursor) || cursor > primitiveCount) {
      throw new Error('partitioned transcript scene partition structure is invalid');
    }
    previousPartitionIndex = partition.partitionIndex;
  }
  if (cursor !== primitiveCount) {
    throw new Error('partitioned transcript scene partition structure is invalid');
  }
}

function validatePayloadSemantics(
  manifest: PartitionedTranscriptSceneBinaryManifestV1,
  payload: Uint8Array
): void {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const coords = manifest.sections.exactCoordinates;
  const features = manifest.sections.primitiveFeatureIndices;
  const instances = manifest.sections.gpuInstances;
  const familyCount = manifest.sections.featureFamilies.count;
  let previousStart = -1;
  let previousPartitionIndex = -1;
  let recordCursor = 0;
  let computedMaxSpan = 0;
  for (const partition of manifest.partitions) {
    if (
      partition.firstInstance !== recordCursor ||
      partition.instanceCount <= 0 ||
      partition.partitionIndex <= previousPartitionIndex ||
      partition.key !== `bp-partition-${partition.partitionIndex}` ||
      partition.startBp !== partition.partitionIndex * manifest.partitionSpanBp ||
      partition.endBpExclusive !==
        (manifest.partitionSpanBp > Number.MAX_SAFE_INTEGER - partition.startBp
          ? Number.MAX_SAFE_INTEGER
          : partition.startBp + manifest.partitionSpanBp)
    ) {
      throw new Error('partitioned transcript scene partition ranges are invalid');
    }
    let minStart = Number.MAX_SAFE_INTEGER;
    let maxEnd = 0;
    for (let i = 0; i < partition.instanceCount; i++) {
      const index = recordCursor + i;
      const offset = coords.byteOffset + index * EXACT_TRANSCRIPT_COORDINATE_RECORD_BYTES;
      const start = safeUint64(view.getBigUint64(offset, true));
      const end = safeUint64(view.getBigUint64(offset + 8, true));
      const featureIndex = view.getUint32(features.byteOffset + index * UINT32_BYTES, true);
      const instanceOffset =
        instances.byteOffset + index * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes;
      const attribute = (floatOffset: number) =>
        view.getFloat32(instanceOffset + floatOffset * Float32Array.BYTES_PER_ELEMENT, true);
      const gpuStart = unpackBpCoordinate(
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk),
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta)
      );
      const gpuEnd = unpackBpCoordinate(
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk),
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta)
      );
      const scalarAttributes = [
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter),
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH),
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.dirSign),
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.cdsFade),
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color),
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 1),
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 2),
        attribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 3),
      ];
      if (
        start < previousStart ||
        end <= start ||
        end > manifest.assemblyContract.assemblyLengthBp ||
        featureIndex >= familyCount ||
        Math.floor(start / manifest.partitionSpanBp) !== partition.partitionIndex ||
        gpuStart !== start ||
        gpuEnd !== end ||
        scalarAttributes.some((value) => !Number.isFinite(value)) ||
        scalarAttributes[1] < 0 ||
        ![-1, 0, 1].includes(scalarAttributes[2]) ||
        scalarAttributes.slice(3).some((value) => value < 0 || value > 1)
      ) {
        throw new Error(`partitioned transcript scene primitive ${index} is invalid`);
      }
      previousStart = start;
      minStart = Math.min(minStart, start);
      maxEnd = Math.max(maxEnd, end);
      computedMaxSpan = Math.max(computedMaxSpan, end - start);
    }
    if (partition.minStartBp !== minStart || partition.maxEndBp !== maxEnd) {
      throw new Error('partitioned transcript scene partition envelope is invalid');
    }
    recordCursor += partition.instanceCount;
    previousPartitionIndex = partition.partitionIndex;
  }
  if (recordCursor !== coords.count || computedMaxSpan !== manifest.maxPrimitiveSpanBp) {
    throw new Error('partitioned transcript scene partitions do not cover every primitive');
  }
  const familySection = manifest.sections.featureFamilies;
  for (let i = 0; i < familySection.count; i++) {
    if (
      view.getUint32(familySection.byteOffset + i * UINT32_BYTES, true) >= manifest.families.length
    ) {
      throw new Error(`partitioned transcript scene feature family ${i} is invalid`);
    }
  }
}

function normalizeUint32Indices(
  input: ArrayLike<number>,
  upperExclusive: number,
  label: string
): Uint32Array {
  if (!Number.isSafeInteger(input?.length) || input.length < 0)
    throw new Error(`${label} length is invalid`);
  const result = new Uint32Array(input.length);
  for (let i = 0; i < result.length; i++) {
    const value = input[i];
    if (!Number.isInteger(value) || value < 0 || value >= upperExclusive) {
      throw new Error(`${label}[${i}] is invalid`);
    }
    result[i] = value;
  }
  return result;
}

function section(byteOffset: number, count: number, recordBytes: number): BinarySectionV1 {
  const byteLength = count * recordBytes;
  if (!Number.isSafeInteger(byteLength))
    throw new Error('partitioned transcript scene section overflow');
  return { byteOffset, byteLength, count, recordBytes };
}

function safeUint64(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('partitioned transcript scene coordinate exceeds Number.MAX_SAFE_INTEGER');
  }
  return Number(value);
}

function contractMaterial(
  manifest: PartitionedTranscriptSceneBinaryManifestV1
): AnnotationSceneJsonValue {
  return {
    schema: manifest.schema,
    datasetContract: manifest.datasetContract,
    assemblyContract: manifest.assemblyContract,
    families: manifest.families,
    partitionSpanBp: manifest.partitionSpanBp,
    maxPrimitiveSpanBp: manifest.maxPrimitiveSpanBp,
    partitions: manifest.partitions,
    geometryContract: manifest.geometryContract,
    sections: manifest.sections,
    byteLength: manifest.byteLength,
  } as unknown as AnnotationSceneJsonValue;
}

function canonicalJson(value: AnnotationSceneJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error('partitioned transcript scene sha256 is unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
