import type { AnnotationSceneJsonValue } from './annotation-scene-binary-v1';
import {
  packGpuReadyPartitionedTranscriptSceneBinaryV1,
  unpackPartitionedTranscriptSceneBinaryV1,
  unpackStructurallyValidatedPartitionedTranscriptSceneBinaryV1ForTrustedMain,
  type GpuReadySceneBinaryPackWorkV1,
  type PackPartitionedTranscriptSceneBinaryV1Input,
  type PartitionedTranscriptSceneBinaryManifestV1,
  type UnpackedPartitionedTranscriptSceneBinaryV1,
} from './partitioned-transcript-scene-binary-v1';
import {
  buildPartitionedTranscriptScene,
  type GpuReadyPartitionedTranscriptScene,
} from './partitioned-transcript-scene';
import {
  PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES,
  PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
  validatePrepackedAnnotationInteractionVisualCouplingV2,
  type PrepackedAnnotationInteractionIndexV2,
} from './prepacked-annotation-interaction-index-v2';

export const PARTITIONED_TRANSCRIPT_SCENE_BINARY_V2 =
  'partitioned-transcript-scene-binary.v2' as const;

const UINT32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const UINT64_BYTES = BigUint64Array.BYTES_PER_ELEMENT;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface BinarySectionV2 {
  byteOffset: number;
  byteLength: number;
  count: number;
  recordBytes: number;
  alignmentBytes: 1 | 4 | 8;
  sha256: string;
}

export interface PartitionedTranscriptSceneBinaryManifestV2 {
  schema: typeof PARTITIONED_TRANSCRIPT_SCENE_BINARY_V2;
  visualManifest: PartitionedTranscriptSceneBinaryManifestV1;
  interactionContract: {
    schema: typeof PREPACKED_ANNOTATION_INTERACTION_INDEX_V2;
    featureCount: number;
    primitiveCount: number;
    featureRecordBytes: typeof PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES;
  };
  sections: {
    visualPayload: BinarySectionV2;
    featureRecords: BinarySectionV2;
    rendererIdFeatureIndices: BinarySectionV2;
    canonicalIdentityFeatureIndices: BinarySectionV2;
    intervalFeatureIndices: BinarySectionV2;
    intervalSubtreeMaxEnds: BinarySectionV2;
    featurePrimitiveOffsets: BinarySectionV2;
    featurePrimitiveIndices: BinarySectionV2;
    strings: BinarySectionV2;
  };
  byteLength: number;
  integrity: {
    algorithm: 'sha256';
    payloadSha256: string;
    contractSha256: string;
  };
}

export interface PackPartitionedTranscriptSceneBinaryV2Input extends PackPartitionedTranscriptSceneBinaryV1Input {
  interactionIndex: PrepackedAnnotationInteractionIndexV2;
}

export type PackGpuReadyPartitionedTranscriptSceneBinaryV2Input = Omit<
  PackPartitionedTranscriptSceneBinaryV2Input,
  'primitives' | 'partitionSpanBp'
> & {
  scene: GpuReadyPartitionedTranscriptScene;
};

export interface PackedPartitionedTranscriptSceneBinaryV2 {
  manifest: PartitionedTranscriptSceneBinaryManifestV2;
  payload: Uint8Array;
}

export interface GpuReadySceneBinaryPackWorkV2 {
  primitiveCount: number;
  primitiveObjectAllocations: 0;
  sortOperations: 0;
  primitiveRepackOperations: 0;
  justPackedV1UnpackOperations: 0;
  visualPack: GpuReadySceneBinaryPackWorkV1;
}

export interface PackedGpuReadyPartitionedTranscriptSceneBinaryV2 extends PackedPartitionedTranscriptSceneBinaryV2 {
  packWork: GpuReadySceneBinaryPackWorkV2;
}

export interface UnpackedPartitionedTranscriptSceneBinaryV2 {
  visual: UnpackedPartitionedTranscriptSceneBinaryV1;
  interactionIndex: PrepackedAnnotationInteractionIndexV2;
}

export const TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2 =
  'main-process-fully-validated-partitioned-transcript-scene.v2' as const;

export interface TrustedMainPartitionedTranscriptSceneDecodeWorkV2 {
  payloadBytesCopied: 0;
  hashOperations: 0;
  visualSemanticPrimitiveScans: 0;
  interactionSemanticFeatureScans: 0;
  visualInteractionCouplingPrimitiveScans: 0;
  justPackedV1UnpackOperations: 0;
}

export interface TrustedMainUnpackedPartitionedTranscriptSceneBinaryV2 extends UnpackedPartitionedTranscriptSceneBinaryV2 {
  trustedMainDecodeWork: TrustedMainPartitionedTranscriptSceneDecodeWorkV2;
}

type SectionKey = keyof PartitionedTranscriptSceneBinaryManifestV2['sections'];

const SECTION_ORDER: ReadonlyArray<{
  key: SectionKey;
  recordBytes: number;
  alignmentBytes: 1 | 4 | 8;
}> = [
  { key: 'visualPayload', recordBytes: 1, alignmentBytes: 8 },
  {
    key: 'featureRecords',
    recordBytes: PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES,
    alignmentBytes: 8,
  },
  { key: 'rendererIdFeatureIndices', recordBytes: UINT32_BYTES, alignmentBytes: 4 },
  { key: 'canonicalIdentityFeatureIndices', recordBytes: UINT32_BYTES, alignmentBytes: 4 },
  { key: 'intervalFeatureIndices', recordBytes: UINT32_BYTES, alignmentBytes: 4 },
  { key: 'intervalSubtreeMaxEnds', recordBytes: UINT64_BYTES, alignmentBytes: 8 },
  { key: 'featurePrimitiveOffsets', recordBytes: UINT32_BYTES, alignmentBytes: 4 },
  { key: 'featurePrimitiveIndices', recordBytes: UINT32_BYTES, alignmentBytes: 4 },
  { key: 'strings', recordBytes: 1, alignmentBytes: 1 },
];

export async function packPartitionedTranscriptSceneBinaryV2(
  input: PackPartitionedTranscriptSceneBinaryV2Input
): Promise<PackedPartitionedTranscriptSceneBinaryV2> {
  const scene = buildPartitionedTranscriptScene(input.primitives, input.partitionSpanBp);
  const direct = await packGpuReadyPartitionedTranscriptSceneBinaryV2({
    datasetContract: input.datasetContract,
    assemblyContract: input.assemblyContract,
    families: input.families,
    featureFamilyIndices: input.featureFamilyIndices,
    interactionIndex: input.interactionIndex,
    scene,
  });
  const { packWork: _packWork, ...packed } = direct;
  return packed;
}

export async function packGpuReadyPartitionedTranscriptSceneBinaryV2(
  input: PackGpuReadyPartitionedTranscriptSceneBinaryV2Input
): Promise<PackedGpuReadyPartitionedTranscriptSceneBinaryV2> {
  validatePrepackedAnnotationInteractionVisualCouplingV2(
    input.interactionIndex,
    input.scene,
    input.assemblyContract.assemblyLengthBp
  );
  const visualPacked = await packGpuReadyPartitionedTranscriptSceneBinaryV1({
    datasetContract: input.datasetContract,
    assemblyContract: input.assemblyContract,
    families: input.families,
    featureFamilyIndices: input.featureFamilyIndices,
    scene: input.scene,
  });
  validateVisualInteractionCounts(
    visualPacked.manifest,
    input.interactionIndex,
    visualPacked.manifest.assemblyContract.assemblyLengthBp
  );

  const sourceBytes: Record<SectionKey, Uint8Array> = {
    visualPayload: visualPacked.payload,
    featureRecords: input.interactionIndex.featureRecordBytes,
    rendererIdFeatureIndices: bytesOf(input.interactionIndex.rendererIdFeatureIndices),
    canonicalIdentityFeatureIndices: bytesOf(
      input.interactionIndex.canonicalIdentityFeatureIndices
    ),
    intervalFeatureIndices: bytesOf(input.interactionIndex.intervalFeatureIndices),
    intervalSubtreeMaxEnds: input.interactionIndex.intervalSubtreeMaxEndBytes,
    featurePrimitiveOffsets: bytesOf(input.interactionIndex.featurePrimitiveOffsets),
    featurePrimitiveIndices: bytesOf(input.interactionIndex.featurePrimitiveIndices),
    strings: input.interactionIndex.stringBytes,
  };
  const sectionCounts: Record<SectionKey, number> = {
    visualPayload: visualPacked.payload.byteLength,
    featureRecords: input.interactionIndex.featureCount,
    rendererIdFeatureIndices: input.interactionIndex.featureCount,
    canonicalIdentityFeatureIndices: input.interactionIndex.featureCount,
    intervalFeatureIndices: input.interactionIndex.intervalFeatureIndices.length,
    intervalSubtreeMaxEnds: input.interactionIndex.intervalFeatureIndices.length,
    featurePrimitiveOffsets: input.interactionIndex.featureCount + 1,
    featurePrimitiveIndices: input.interactionIndex.primitiveCount,
    strings: input.interactionIndex.stringBytes.byteLength,
  };
  const sections = {} as PartitionedTranscriptSceneBinaryManifestV2['sections'];
  let cursor = 0;
  for (const definition of SECTION_ORDER) {
    cursor = align(cursor, definition.alignmentBytes);
    const bytes = sourceBytes[definition.key];
    const expectedByteLength = checkedMultiply(
      sectionCounts[definition.key],
      definition.recordBytes,
      definition.key
    );
    if (bytes.byteLength !== expectedByteLength) {
      throw new Error(`partitioned transcript scene v2 ${definition.key} length is invalid`);
    }
    sections[definition.key] = {
      byteOffset: cursor,
      byteLength: bytes.byteLength,
      count: sectionCounts[definition.key],
      recordBytes: definition.recordBytes,
      alignmentBytes: definition.alignmentBytes,
      sha256: '',
    };
    cursor = checkedAdd(cursor, bytes.byteLength, definition.key);
  }

  const payload = new Uint8Array(cursor);
  for (const definition of SECTION_ORDER) {
    const entry = sections[definition.key];
    const bytes = sourceBytes[definition.key];
    payload.set(bytes, entry.byteOffset);
  }
  const sectionHashes = await Promise.all(
    SECTION_ORDER.map((definition) => sha256Hex(sourceBytes[definition.key]))
  );
  for (let i = 0; i < SECTION_ORDER.length; i += 1) {
    sections[SECTION_ORDER[i].key].sha256 = sectionHashes[i];
  }
  const manifest: PartitionedTranscriptSceneBinaryManifestV2 = {
    schema: PARTITIONED_TRANSCRIPT_SCENE_BINARY_V2,
    visualManifest: structuredClone(visualPacked.manifest),
    interactionContract: {
      schema: PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
      featureCount: input.interactionIndex.featureCount,
      primitiveCount: input.interactionIndex.primitiveCount,
      featureRecordBytes: PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES,
    },
    sections,
    byteLength: payload.byteLength,
    integrity: { algorithm: 'sha256', payloadSha256: '', contractSha256: '' },
  };
  manifest.integrity.payloadSha256 = await sha256Hex(payload);
  manifest.integrity.contractSha256 = await sha256Hex(
    new TextEncoder().encode(canonicalJson(contractMaterial(manifest)))
  );
  return {
    manifest,
    payload,
    packWork: {
      primitiveCount: input.scene.featureIndices.length,
      primitiveObjectAllocations: 0,
      sortOperations: 0,
      primitiveRepackOperations: 0,
      justPackedV1UnpackOperations: 0,
      visualPack: visualPacked.packWork,
    },
  };
}

export async function validatePartitionedTranscriptSceneBinaryV2(
  manifest: PartitionedTranscriptSceneBinaryManifestV2,
  payload: Uint8Array
): Promise<void> {
  await validateAndUnpackPartitionedTranscriptSceneBinaryV2(manifest, payload);
}

export async function unpackPartitionedTranscriptSceneBinaryV2(
  manifest: PartitionedTranscriptSceneBinaryManifestV2,
  payload: Uint8Array
): Promise<UnpackedPartitionedTranscriptSceneBinaryV2> {
  return validateAndUnpackPartitionedTranscriptSceneBinaryV2(manifest, payload);
}

export function unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV2(
  manifest: PartitionedTranscriptSceneBinaryManifestV2,
  payload: Uint8Array,
  validation: typeof TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2
): TrustedMainUnpackedPartitionedTranscriptSceneBinaryV2 {
  if (validation !== TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2) {
    throw new Error('partitioned transcript scene v2 trusted-main validation marker is invalid');
  }
  validateManifestStructure(manifest, payload);
  const visualPayload = sectionBytes(payload, manifest.sections.visualPayload);
  const visual = unpackStructurallyValidatedPartitionedTranscriptSceneBinaryV1ForTrustedMain(
    manifest.visualManifest,
    visualPayload
  );
  const interactionIndex = interactionViews(manifest, payload);
  validateVisualInteractionCounts(
    manifest.visualManifest,
    interactionIndex,
    manifest.visualManifest.assemblyContract.assemblyLengthBp
  );
  return {
    visual,
    interactionIndex,
    trustedMainDecodeWork: {
      payloadBytesCopied: 0,
      hashOperations: 0,
      visualSemanticPrimitiveScans: 0,
      interactionSemanticFeatureScans: 0,
      visualInteractionCouplingPrimitiveScans: 0,
      justPackedV1UnpackOperations: 0,
    },
  };
}

async function validateAndUnpackPartitionedTranscriptSceneBinaryV2(
  manifest: PartitionedTranscriptSceneBinaryManifestV2,
  payload: Uint8Array
): Promise<UnpackedPartitionedTranscriptSceneBinaryV2> {
  validateManifestStructure(manifest, payload);
  const [payloadHash, contractHash, ...sectionHashes] = await Promise.all([
    sha256Hex(payload),
    sha256Hex(new TextEncoder().encode(canonicalJson(contractMaterial(manifest)))),
    ...SECTION_ORDER.map((definition) =>
      sha256Hex(sectionBytes(payload, manifest.sections[definition.key]))
    ),
  ]);
  if (payloadHash !== manifest.integrity.payloadSha256) {
    throw new Error('partitioned transcript scene v2 payload sha256 mismatch');
  }
  for (let i = 0; i < SECTION_ORDER.length; i += 1) {
    const definition = SECTION_ORDER[i];
    if (sectionHashes[i] !== manifest.sections[definition.key].sha256) {
      throw new Error(`partitioned transcript scene v2 ${definition.key} sha256 mismatch`);
    }
  }
  if (contractHash !== manifest.integrity.contractSha256) {
    throw new Error('partitioned transcript scene v2 contract sha256 mismatch');
  }

  const visualPayload = sectionBytes(payload, manifest.sections.visualPayload);
  const visual = await unpackPartitionedTranscriptSceneBinaryV1(
    manifest.visualManifest,
    visualPayload
  );
  const interactionIndex = interactionViews(manifest, payload);
  validateVisualInteractionCounts(
    manifest.visualManifest,
    interactionIndex,
    manifest.visualManifest.assemblyContract.assemblyLengthBp
  );
  validatePrepackedAnnotationInteractionVisualCouplingV2(
    interactionIndex,
    visual.scene,
    manifest.visualManifest.assemblyContract.assemblyLengthBp
  );
  return { visual, interactionIndex };
}

function interactionViews(
  manifest: PartitionedTranscriptSceneBinaryManifestV2,
  payload: Uint8Array
): PrepackedAnnotationInteractionIndexV2 {
  const sections = manifest.sections;
  return {
    schema: PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
    featureCount: manifest.interactionContract.featureCount,
    primitiveCount: manifest.interactionContract.primitiveCount,
    featureRecordBytes: sectionBytes(payload, sections.featureRecords),
    rendererIdFeatureIndices: uint32View(payload, sections.rendererIdFeatureIndices),
    canonicalIdentityFeatureIndices: uint32View(payload, sections.canonicalIdentityFeatureIndices),
    intervalFeatureIndices: uint32View(payload, sections.intervalFeatureIndices),
    intervalSubtreeMaxEndBytes: sectionBytes(payload, sections.intervalSubtreeMaxEnds),
    featurePrimitiveOffsets: uint32View(payload, sections.featurePrimitiveOffsets),
    featurePrimitiveIndices: uint32View(payload, sections.featurePrimitiveIndices),
    stringBytes: sectionBytes(payload, sections.strings),
  };
}

function validateManifestStructure(
  manifest: PartitionedTranscriptSceneBinaryManifestV2,
  payload: Uint8Array
): void {
  if (manifest?.schema !== PARTITIONED_TRANSCRIPT_SCENE_BINARY_V2) {
    throw new Error(
      `partitioned transcript scene schema must be ${PARTITIONED_TRANSCRIPT_SCENE_BINARY_V2}`
    );
  }
  const interaction = manifest.interactionContract;
  if (
    interaction?.schema !== PREPACKED_ANNOTATION_INTERACTION_INDEX_V2 ||
    !Number.isSafeInteger(interaction.featureCount) ||
    interaction.featureCount < 0 ||
    !Number.isSafeInteger(interaction.primitiveCount) ||
    interaction.primitiveCount < 0 ||
    interaction.featureRecordBytes !== PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES
  ) {
    throw new Error('partitioned transcript scene v2 interaction contract is invalid');
  }
  const expectedCounts: Record<SectionKey, number> = {
    visualPayload: manifest.visualManifest?.byteLength,
    featureRecords: interaction.featureCount,
    rendererIdFeatureIndices: interaction.featureCount,
    canonicalIdentityFeatureIndices: interaction.featureCount,
    intervalFeatureIndices: manifest.sections?.intervalFeatureIndices?.count,
    intervalSubtreeMaxEnds: manifest.sections?.intervalFeatureIndices?.count,
    featurePrimitiveOffsets: interaction.featureCount + 1,
    featurePrimitiveIndices: interaction.primitiveCount,
    strings: manifest.sections?.strings?.byteLength,
  };
  let cursor = 0;
  for (const definition of SECTION_ORDER) {
    cursor = align(cursor, definition.alignmentBytes);
    const entry = manifest.sections?.[definition.key];
    const count = expectedCounts[definition.key];
    if (
      !entry ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      entry.byteOffset !== cursor ||
      entry.byteOffset % definition.alignmentBytes !== 0 ||
      entry.alignmentBytes !== definition.alignmentBytes ||
      entry.recordBytes !== definition.recordBytes ||
      entry.count !== count ||
      entry.byteLength !== checkedMultiply(entry.count, entry.recordBytes, definition.key) ||
      !SHA256_HEX.test(entry.sha256)
    ) {
      throw new Error('partitioned transcript scene v2 sections are not exact and aligned');
    }
    assertZeroPadding(
      payload,
      manifest.byteLength,
      cursorFromPreviousSection(manifest, definition.key),
      entry.byteOffset
    );
    cursor = checkedAdd(entry.byteOffset, entry.byteLength, definition.key);
  }
  if (
    manifest.byteLength !== cursor ||
    payload.byteLength !== cursor ||
    manifest.sections.visualPayload.sha256 !== manifest.visualManifest?.integrity?.payloadSha256 ||
    manifest.integrity?.algorithm !== 'sha256' ||
    !SHA256_HEX.test(manifest.integrity.payloadSha256) ||
    !SHA256_HEX.test(manifest.integrity.contractSha256)
  ) {
    throw new Error('partitioned transcript scene v2 payload/integrity contract is invalid');
  }
  validateAbsoluteAlignment(manifest, payload);
}

function validateVisualInteractionCounts(
  visualManifest: PartitionedTranscriptSceneBinaryManifestV1,
  interactionIndex: PrepackedAnnotationInteractionIndexV2,
  assemblyLengthBp: number
): void {
  if (
    visualManifest.sections.featureFamilies.count !== interactionIndex.featureCount ||
    visualManifest.sections.gpuInstances.count !== interactionIndex.primitiveCount ||
    visualManifest.assemblyContract.assemblyLengthBp !== assemblyLengthBp
  ) {
    throw new Error('partitioned transcript scene v2 visual/interaction counts do not match');
  }
}

function validateAbsoluteAlignment(
  manifest: PartitionedTranscriptSceneBinaryManifestV2,
  payload: Uint8Array
): void {
  for (const definition of SECTION_ORDER) {
    if (definition.alignmentBytes === 1) continue;
    const absolute = payload.byteOffset + manifest.sections[definition.key].byteOffset;
    if (absolute % definition.alignmentBytes !== 0) {
      throw new Error('partitioned transcript scene v2 payload is not typed-array aligned');
    }
  }
}

function cursorFromPreviousSection(
  manifest: PartitionedTranscriptSceneBinaryManifestV2,
  key: SectionKey
): number {
  const index = SECTION_ORDER.findIndex((definition) => definition.key === key);
  if (index <= 0) return 0;
  const previous = manifest.sections[SECTION_ORDER[index - 1].key];
  return previous.byteOffset + previous.byteLength;
}

function assertZeroPadding(
  payload: Uint8Array,
  declaredByteLength: number,
  start: number,
  end: number
): void {
  if (start < 0 || end < start || end > declaredByteLength || end > payload.byteLength) {
    throw new Error('partitioned transcript scene v2 padding range is invalid');
  }
  for (let i = start; i < end; i += 1) {
    if (payload[i] !== 0) {
      throw new Error('partitioned transcript scene v2 alignment padding is not zero');
    }
  }
}

function uint32View(payload: Uint8Array, entry: BinarySectionV2): Uint32Array {
  return new Uint32Array(
    payload.buffer,
    payload.byteOffset + entry.byteOffset,
    entry.byteLength / UINT32_BYTES
  );
}

function sectionBytes(payload: Uint8Array, entry: BinarySectionV2): Uint8Array {
  return payload.subarray(entry.byteOffset, entry.byteOffset + entry.byteLength);
}

function bytesOf(view: Uint32Array): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function align(value: number, alignment: number): number {
  const remainder = value % alignment;
  return remainder === 0 ? value : checkedAdd(value, alignment - remainder, 'alignment');
}

function checkedMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`partitioned transcript scene v2 ${label} byte length overflows`);
  }
  return value;
}

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`partitioned transcript scene v2 ${label} offset overflows`);
  }
  return value;
}

function contractMaterial(
  manifest: PartitionedTranscriptSceneBinaryManifestV2
): AnnotationSceneJsonValue {
  return {
    schema: manifest.schema,
    visualManifest: manifest.visualManifest,
    interactionContract: manifest.interactionContract,
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
  if (!globalThis.crypto?.subtle) {
    throw new Error('partitioned transcript scene v2 sha256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
