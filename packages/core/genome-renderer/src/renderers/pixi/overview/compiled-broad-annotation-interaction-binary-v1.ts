import type {
  AnnotationSceneAssemblyContractV1,
  AnnotationSceneDatasetContractV1,
} from './annotation-scene-binary-v1';
import {
  ANNOTATION_POLICY_FEATURE_RECORD_BYTES,
  ANNOTATION_POLICY_PROJECTION_V1,
  validateAnnotationPolicyProjectionTableV1,
  type AnnotationPolicyProjectionTableV1,
} from './annotation-policy-projection-v1';
import { PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4 } from './partitioned-transcript-scene-binary-v4';
import {
  PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES,
  PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
  validatePrepackedAnnotationFeatureLookupIndexV2,
  type PrepackedAnnotationFeatureLookupIndexV2,
} from './prepacked-annotation-interaction-index-v2';

export const COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1 =
  'compiled-broad-annotation-interaction-binary.v1' as const;
export const TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1 =
  'main-process-fully-validated-compiled-broad-annotation-interaction.v1' as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const U64_BYTES = BigUint64Array.BYTES_PER_ELEMENT;

type SectionKey =
  | 'policyFeatureRecords'
  | 'interactionFeatureRecords'
  | 'interactionRendererIdFeatureIndices'
  | 'interactionCanonicalIdentityFeatureIndices'
  | 'interactionIntervalFeatureIndices'
  | 'interactionIntervalSubtreeMaxEnds'
  | 'interactionFeaturePrimitiveOffsets'
  | 'interactionStrings';

interface BinarySectionV1 {
  byteOffset: number;
  byteLength: number;
  count: number;
  recordBytes: number;
  alignmentBytes: 1 | 4 | 8;
}

export interface CompiledBroadAnnotationInteractionSourceSceneV1 {
  schema: typeof PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4;
  payloadSha256: string;
  contractSha256: string;
  byteLength: number;
}

export interface CompiledBroadAnnotationInteractionBinaryManifestV1 {
  schema: typeof COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1;
  sourceScene: CompiledBroadAnnotationInteractionSourceSceneV1;
  datasetContract: AnnotationSceneDatasetContractV1;
  assemblyContract: AnnotationSceneAssemblyContractV1;
  featureCount: number;
  primitiveCount: number;
  policyContract: {
    schema: typeof ANNOTATION_POLICY_PROJECTION_V1;
    featureRecordBytes: typeof ANNOTATION_POLICY_FEATURE_RECORD_BYTES;
    annotationTypes: string[];
    expandedBandTypeIndices: number[];
    canonicalBandTypeIndices: number[];
  };
  interactionContract: {
    schema: typeof PREPACKED_ANNOTATION_INTERACTION_INDEX_V2;
    featureRecordBytes: typeof PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES;
  };
  sections: Record<SectionKey, BinarySectionV1>;
  byteLength: number;
  integrity: {
    algorithm: 'sha256';
    payloadSha256: string;
  };
}

export interface PackCompiledBroadAnnotationInteractionBinaryV1Input {
  sourceScene: CompiledBroadAnnotationInteractionSourceSceneV1;
  datasetContract: AnnotationSceneDatasetContractV1;
  assemblyContract: AnnotationSceneAssemblyContractV1;
  policyProjection: AnnotationPolicyProjectionTableV1;
  featureLookup: PrepackedAnnotationFeatureLookupIndexV2;
  payloadSha256?: (bytes: Uint8Array) => Promise<string>;
}

export interface PackedCompiledBroadAnnotationInteractionBinaryV1 {
  manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
  payload: Uint8Array;
}

export interface UnpackedCompiledBroadAnnotationInteractionBinaryV1 {
  policyProjection: AnnotationPolicyProjectionTableV1;
  featureLookup: PrepackedAnnotationFeatureLookupIndexV2;
}

const SECTION_DEFINITIONS: ReadonlyArray<{
  key: SectionKey;
  recordBytes: number;
  alignmentBytes: 1 | 4 | 8;
}> = [
  {
    key: 'policyFeatureRecords',
    recordBytes: ANNOTATION_POLICY_FEATURE_RECORD_BYTES,
    alignmentBytes: 4,
  },
  {
    key: 'interactionFeatureRecords',
    recordBytes: PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES,
    alignmentBytes: 8,
  },
  { key: 'interactionRendererIdFeatureIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  {
    key: 'interactionCanonicalIdentityFeatureIndices',
    recordBytes: U32_BYTES,
    alignmentBytes: 4,
  },
  { key: 'interactionIntervalFeatureIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  {
    key: 'interactionIntervalSubtreeMaxEnds',
    recordBytes: U64_BYTES,
    alignmentBytes: 8,
  },
  { key: 'interactionFeaturePrimitiveOffsets', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'interactionStrings', recordBytes: 1, alignmentBytes: 1 },
];

export async function packCompiledBroadAnnotationInteractionBinaryV1(
  input: PackCompiledBroadAnnotationInteractionBinaryV1Input
): Promise<PackedCompiledBroadAnnotationInteractionBinaryV1> {
  assertSourceScene(input.sourceScene);
  assertDatasetAssemblyContracts(input.datasetContract, input.assemblyContract);
  validateAnnotationPolicyProjectionTableV1(input.policyProjection);
  validatePrepackedAnnotationFeatureLookupIndexV2(input.featureLookup);
  if (input.policyProjection.featureCount !== input.featureLookup.featureCount) {
    throw new Error('compiled broad interaction feature authorities disagree');
  }

  const counts: Record<SectionKey, number> = {
    policyFeatureRecords: input.policyProjection.featureCount,
    interactionFeatureRecords: input.featureLookup.featureCount,
    interactionRendererIdFeatureIndices: input.featureLookup.rendererIdFeatureIndices.length,
    interactionCanonicalIdentityFeatureIndices:
      input.featureLookup.canonicalIdentityFeatureIndices.length,
    interactionIntervalFeatureIndices: input.featureLookup.intervalFeatureIndices.length,
    interactionIntervalSubtreeMaxEnds: input.featureLookup.intervalFeatureIndices.length,
    interactionFeaturePrimitiveOffsets: input.featureLookup.featurePrimitiveOffsets.length,
    interactionStrings: input.featureLookup.stringBytes.byteLength,
  };
  const { sections, byteLength } = layoutSections(counts);
  const payload = new Uint8Array(byteLength);
  copySection(payload, sections.policyFeatureRecords, input.policyProjection.featureRecordBytes);
  copySection(payload, sections.interactionFeatureRecords, input.featureLookup.featureRecordBytes);
  copySection(
    payload,
    sections.interactionRendererIdFeatureIndices,
    bytesOf(input.featureLookup.rendererIdFeatureIndices)
  );
  copySection(
    payload,
    sections.interactionCanonicalIdentityFeatureIndices,
    bytesOf(input.featureLookup.canonicalIdentityFeatureIndices)
  );
  copySection(
    payload,
    sections.interactionIntervalFeatureIndices,
    bytesOf(input.featureLookup.intervalFeatureIndices)
  );
  copySection(
    payload,
    sections.interactionIntervalSubtreeMaxEnds,
    input.featureLookup.intervalSubtreeMaxEndBytes
  );
  copySection(
    payload,
    sections.interactionFeaturePrimitiveOffsets,
    bytesOf(input.featureLookup.featurePrimitiveOffsets)
  );
  copySection(payload, sections.interactionStrings, input.featureLookup.stringBytes);

  const payloadSha256 = await (input.payloadSha256 ?? sha256WebCrypto)(payload);
  if (!SHA256_HEX.test(payloadSha256)) {
    throw new Error('compiled broad interaction payload sha256 is invalid');
  }
  return {
    manifest: {
      schema: COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1,
      sourceScene: { ...input.sourceScene },
      datasetContract: { ...input.datasetContract },
      assemblyContract: { ...input.assemblyContract },
      featureCount: input.featureLookup.featureCount,
      primitiveCount: input.featureLookup.primitiveCount,
      policyContract: {
        schema: ANNOTATION_POLICY_PROJECTION_V1,
        featureRecordBytes: ANNOTATION_POLICY_FEATURE_RECORD_BYTES,
        annotationTypes: [...input.policyProjection.annotationTypes],
        expandedBandTypeIndices: [...input.policyProjection.expandedBandTypeIndices],
        canonicalBandTypeIndices: [...input.policyProjection.canonicalBandTypeIndices],
      },
      interactionContract: {
        schema: PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
        featureRecordBytes: PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES,
      },
      sections,
      byteLength,
      integrity: { algorithm: 'sha256', payloadSha256 },
    },
    payload,
  };
}

export async function validateCompiledBroadAnnotationInteractionBinaryV1(
  manifest: CompiledBroadAnnotationInteractionBinaryManifestV1,
  payload: Uint8Array,
  payloadSha256: (bytes: Uint8Array) => Promise<string> = sha256WebCrypto
): Promise<void> {
  assertManifestStructure(manifest, payload);
  if ((await payloadSha256(payload)) !== manifest.integrity.payloadSha256) {
    throw new Error('compiled broad interaction payload sha256 mismatch');
  }
  const unpacked = unpackCompiledBroadAnnotationInteractionBinaryV1(manifest, payload);
  validateAnnotationPolicyProjectionTableV1(unpacked.policyProjection);
  validatePrepackedAnnotationFeatureLookupIndexV2(unpacked.featureLookup);
}

export function unpackCompiledBroadAnnotationInteractionBinaryV1(
  manifest: CompiledBroadAnnotationInteractionBinaryManifestV1,
  payload: Uint8Array
): UnpackedCompiledBroadAnnotationInteractionBinaryV1 {
  assertManifestStructure(manifest, payload);
  const sections = manifest.sections;
  return {
    policyProjection: {
      schema: ANNOTATION_POLICY_PROJECTION_V1,
      featureCount: manifest.featureCount,
      annotationTypes: manifest.policyContract.annotationTypes,
      expandedBandTypeIndices: manifest.policyContract.expandedBandTypeIndices,
      canonicalBandTypeIndices: manifest.policyContract.canonicalBandTypeIndices,
      featureRecordBytes: sectionBytes(payload, sections.policyFeatureRecords),
    },
    featureLookup: {
      schema: PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
      featureCount: manifest.featureCount,
      primitiveCount: manifest.primitiveCount,
      featureRecordBytes: sectionBytes(payload, sections.interactionFeatureRecords),
      rendererIdFeatureIndices: u32View(payload, sections.interactionRendererIdFeatureIndices),
      canonicalIdentityFeatureIndices: u32View(
        payload,
        sections.interactionCanonicalIdentityFeatureIndices
      ),
      intervalFeatureIndices: u32View(payload, sections.interactionIntervalFeatureIndices),
      intervalSubtreeMaxEndBytes: sectionBytes(payload, sections.interactionIntervalSubtreeMaxEnds),
      featurePrimitiveOffsets: u32View(payload, sections.interactionFeaturePrimitiveOffsets),
      stringBytes: sectionBytes(payload, sections.interactionStrings),
    },
  };
}

export function unpackTrustedMainValidatedCompiledBroadAnnotationInteractionBinaryV1(
  manifest: CompiledBroadAnnotationInteractionBinaryManifestV1,
  payload: Uint8Array,
  marker: typeof TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1
): UnpackedCompiledBroadAnnotationInteractionBinaryV1 {
  if (marker !== TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1) {
    throw new Error('compiled broad interaction trusted-main marker is invalid');
  }
  return unpackCompiledBroadAnnotationInteractionBinaryV1(manifest, payload);
}

function assertManifestStructure(
  manifest: CompiledBroadAnnotationInteractionBinaryManifestV1,
  payload: Uint8Array
): void {
  if (manifest?.schema !== COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1) {
    throw new Error('compiled broad interaction schema is invalid');
  }
  assertSourceScene(manifest.sourceScene);
  assertDatasetAssemblyContracts(manifest.datasetContract, manifest.assemblyContract);
  if (
    !Number.isSafeInteger(manifest.featureCount) ||
    manifest.featureCount < 0 ||
    !Number.isSafeInteger(manifest.primitiveCount) ||
    manifest.primitiveCount < 0 ||
    manifest.policyContract?.schema !== ANNOTATION_POLICY_PROJECTION_V1 ||
    manifest.policyContract.featureRecordBytes !== ANNOTATION_POLICY_FEATURE_RECORD_BYTES ||
    !Array.isArray(manifest.policyContract.annotationTypes) ||
    !Array.isArray(manifest.policyContract.expandedBandTypeIndices) ||
    !Array.isArray(manifest.policyContract.canonicalBandTypeIndices) ||
    manifest.interactionContract?.schema !== PREPACKED_ANNOTATION_INTERACTION_INDEX_V2 ||
    manifest.interactionContract.featureRecordBytes !==
      PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES ||
    manifest.integrity?.algorithm !== 'sha256' ||
    !SHA256_HEX.test(manifest.integrity.payloadSha256) ||
    !(payload instanceof Uint8Array) ||
    payload.byteLength !== manifest.byteLength
  ) {
    throw new Error('compiled broad interaction manifest is invalid');
  }
  const sectionKeys = Object.keys(manifest.sections ?? {}).sort();
  const expectedKeys = SECTION_DEFINITIONS.map(({ key }) => key).sort();
  if (sectionKeys.join('\0') !== expectedKeys.join('\0')) {
    throw new Error('compiled broad interaction sections are invalid');
  }
  const counts: Record<SectionKey, number> = {
    policyFeatureRecords: manifest.featureCount,
    interactionFeatureRecords: manifest.featureCount,
    interactionRendererIdFeatureIndices: manifest.featureCount,
    interactionCanonicalIdentityFeatureIndices: manifest.featureCount,
    interactionIntervalFeatureIndices: manifest.sections.interactionIntervalFeatureIndices.count,
    interactionIntervalSubtreeMaxEnds: manifest.sections.interactionIntervalFeatureIndices.count,
    interactionFeaturePrimitiveOffsets: manifest.featureCount + 1,
    interactionStrings: manifest.sections.interactionStrings.count,
  };
  const expected = layoutSections(counts);
  if (
    expected.byteLength !== manifest.byteLength ||
    SECTION_DEFINITIONS.some(
      ({ key }) => !sectionsEqual(manifest.sections[key], expected.sections[key])
    )
  ) {
    throw new Error('compiled broad interaction section layout is invalid');
  }
}

function assertSourceScene(source: CompiledBroadAnnotationInteractionSourceSceneV1): void {
  if (
    source?.schema !== PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4 ||
    !SHA256_HEX.test(source.payloadSha256) ||
    !SHA256_HEX.test(source.contractSha256) ||
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength <= 0
  ) {
    throw new Error('compiled broad interaction source scene is invalid');
  }
}

function assertDatasetAssemblyContracts(
  dataset: AnnotationSceneDatasetContractV1,
  assembly: AnnotationSceneAssemblyContractV1
): void {
  if (
    typeof dataset?.datasetId !== 'string' ||
    dataset.datasetId.length === 0 ||
    typeof dataset.datasetVersion !== 'string' ||
    dataset.datasetVersion.length === 0 ||
    !SHA256_HEX.test(dataset.sourceSha256) ||
    typeof assembly?.assemblyId !== 'string' ||
    assembly.assemblyId.length === 0 ||
    !Number.isSafeInteger(assembly.assemblyLengthBp) ||
    assembly.assemblyLengthBp <= 0
  ) {
    throw new Error('compiled broad interaction source contract is invalid');
  }
}

function layoutSections(counts: Record<SectionKey, number>): {
  sections: Record<SectionKey, BinarySectionV1>;
  byteLength: number;
} {
  const sections = {} as Record<SectionKey, BinarySectionV1>;
  let cursor = 0;
  for (const definition of SECTION_DEFINITIONS) {
    const count = counts[definition.key];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`compiled broad interaction ${definition.key} count is invalid`);
    }
    cursor = align(cursor, definition.alignmentBytes);
    const byteLength = count * definition.recordBytes;
    if (!Number.isSafeInteger(byteLength)) {
      throw new Error(`compiled broad interaction ${definition.key} length overflow`);
    }
    sections[definition.key] = {
      byteOffset: cursor,
      byteLength,
      count,
      recordBytes: definition.recordBytes,
      alignmentBytes: definition.alignmentBytes,
    };
    cursor += byteLength;
  }
  return { sections, byteLength: cursor };
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function sectionsEqual(left: BinarySectionV1, right: BinarySectionV1): boolean {
  return (
    left?.byteOffset === right.byteOffset &&
    left.byteLength === right.byteLength &&
    left.count === right.count &&
    left.recordBytes === right.recordBytes &&
    left.alignmentBytes === right.alignmentBytes
  );
}

function copySection(payload: Uint8Array, section: BinarySectionV1, bytes: Uint8Array): void {
  if (bytes.byteLength !== section.byteLength) {
    throw new Error('compiled broad interaction section source length mismatch');
  }
  payload.set(bytes, section.byteOffset);
}

function bytesOf(array: Uint32Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function sectionBytes(payload: Uint8Array, section: BinarySectionV1): Uint8Array {
  return payload.subarray(section.byteOffset, section.byteOffset + section.byteLength);
}

function u32View(payload: Uint8Array, section: BinarySectionV1): Uint32Array {
  return new Uint32Array(payload.buffer, payload.byteOffset + section.byteOffset, section.count);
}

async function sha256WebCrypto(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
