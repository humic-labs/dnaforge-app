import type { AnnotationSceneJsonValue } from './annotation-scene-binary-v1';
import {
  ANNOTATION_POLICY_GPU_ABSENT_LANE,
  ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT,
  ANNOTATION_POLICY_GPU_INSTANCES_V1,
  ANNOTATION_POLICY_GPU_MAX_EXACT_LANE,
  buildAnnotationPolicyGpuInstanceDataV1,
  validateAnnotationPolicyGpuInstanceDataV1,
} from './annotation-policy-gpu-instances-v1';
import {
  ANNOTATION_POLICY_ABSENT_LANE,
  ANNOTATION_POLICY_FEATURE_RECORD_BYTES,
  ANNOTATION_POLICY_PROJECTION_V1,
  buildAnnotationPolicyProjectionTableV1,
  decodeAnnotationPolicyProjectionFeatureV1,
  validateAnnotationPolicyProjectionTableV1,
  type AnnotationPolicyProjectionTableV1,
  type BuildAnnotationPolicyProjectionTableV1Input,
} from './annotation-policy-projection-v1';
import {
  buildPartitionedTranscriptScene,
  type GpuReadyPartitionedTranscriptScene,
} from './partitioned-transcript-scene';
import {
  PARTITIONED_TRANSCRIPT_SCENE_BINARY_V2,
  TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2,
  packGpuReadyPartitionedTranscriptSceneBinaryV2,
  unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV2,
  validatePartitionedTranscriptSceneBinaryV2,
  type GpuReadySceneBinaryPackWorkV2,
  type PackGpuReadyPartitionedTranscriptSceneBinaryV2Input,
  type PackPartitionedTranscriptSceneBinaryV2Input,
  type PartitionedTranscriptSceneBinaryManifestV2,
  type UnpackedPartitionedTranscriptSceneBinaryV2,
} from './partitioned-transcript-scene-binary-v2';
import { decodePrepackedAnnotationInteractionFeatureV2 } from './prepacked-annotation-interaction-index-v2';
import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_LANE_STEP_PX,
} from './prepacked-annotation-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';

export const PARTITIONED_TRANSCRIPT_SCENE_BINARY_V3 =
  'partitioned-transcript-scene-binary.v3' as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

interface BinarySectionV3 {
  byteOffset: number;
  byteLength: number;
  count: number;
  recordBytes: number;
  alignmentBytes: 4 | 8;
  sha256: string;
}

export interface PartitionedTranscriptSceneBinaryManifestV3 {
  schema: typeof PARTITIONED_TRANSCRIPT_SCENE_BINARY_V3;
  expandedSceneManifest: PartitionedTranscriptSceneBinaryManifestV2;
  policyContract: {
    schema: typeof ANNOTATION_POLICY_PROJECTION_V1;
    featureCount: number;
    primitiveCount: number;
    featureRecordBytes: typeof ANNOTATION_POLICY_FEATURE_RECORD_BYTES;
    absentLaneSentinel: typeof ANNOTATION_POLICY_ABSENT_LANE;
    annotationTypes: string[];
    expandedBandTypeIndices: number[];
    canonicalBandTypeIndices: number[];
    geometryProjection: 'expanded-uncapped';
    runtimeProjection: 'canonical-membership-and-lane-cap.v1';
    spacerLanes: 1;
    fixedBandCapacityExceptionType: 'CDS';
    gpuInstanceSchema: typeof ANNOTATION_POLICY_GPU_INSTANCES_V1;
    gpuInstanceRecordBytes: typeof ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideBytes;
    gpuAbsentLane: typeof ANNOTATION_POLICY_GPU_ABSENT_LANE;
    gpuMaxExactLane: typeof ANNOTATION_POLICY_GPU_MAX_EXACT_LANE;
  };
  sections: {
    expandedScenePayload: BinarySectionV3;
    policyFeatureRecords: BinarySectionV3;
    policyGpuInstances: BinarySectionV3;
  };
  byteLength: number;
  integrity: {
    algorithm: 'sha256';
    payloadSha256: string;
    contractSha256: string;
  };
}

export interface PackPartitionedTranscriptSceneBinaryV3Input extends PackPartitionedTranscriptSceneBinaryV2Input {
  policyProjection: BuildAnnotationPolicyProjectionTableV1Input;
}

export interface PackGpuReadyPartitionedTranscriptSceneBinaryV3Input extends PackGpuReadyPartitionedTranscriptSceneBinaryV2Input {
  policyProjection: BuildAnnotationPolicyProjectionTableV1Input;
}

export interface PackedPartitionedTranscriptSceneBinaryV3 {
  manifest: PartitionedTranscriptSceneBinaryManifestV3;
  payload: Uint8Array;
}

export interface PackedGpuReadyPartitionedTranscriptSceneBinaryV3 extends PackedPartitionedTranscriptSceneBinaryV3 {
  packWork: {
    expandedScenePack: GpuReadySceneBinaryPackWorkV2;
    policyFeatureRecordsWritten: number;
    policyGpuInstanceRecordsWritten: number;
    sourceGlyphGeometryMutations: 0;
  };
}

export interface UnpackedPartitionedTranscriptSceneBinaryV3 {
  expandedScene: UnpackedPartitionedTranscriptSceneBinaryV2;
  policyProjection: AnnotationPolicyProjectionTableV1;
  policyGpuInstanceData: Float32Array;
}

export const TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V3 =
  'main-process-fully-validated-partitioned-transcript-scene.v3' as const;

export interface TrustedMainPartitionedTranscriptSceneDecodeWorkV3 {
  payloadBytesCopied: 0;
  hashOperations: 0;
  visualSemanticPrimitiveScans: 0;
  interactionSemanticFeatureScans: 0;
  policySemanticFeatureScans: 0;
  visualInteractionCouplingPrimitiveScans: 0;
  visualPolicyCouplingPrimitiveScans: 0;
}

export interface TrustedMainUnpackedPartitionedTranscriptSceneBinaryV3 extends UnpackedPartitionedTranscriptSceneBinaryV3 {
  trustedMainDecodeWork: TrustedMainPartitionedTranscriptSceneDecodeWorkV3;
}

export async function packPartitionedTranscriptSceneBinaryV3(
  input: PackPartitionedTranscriptSceneBinaryV3Input
): Promise<PackedPartitionedTranscriptSceneBinaryV3> {
  const { primitives, partitionSpanBp, policyProjection, ...shared } = input;
  const scene = buildPartitionedTranscriptScene(primitives, partitionSpanBp);
  const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV3({
    ...shared,
    scene,
    policyProjection,
  });
  const { packWork: _packWork, ...result } = packed;
  return result;
}

export async function packGpuReadyPartitionedTranscriptSceneBinaryV3(
  input: PackGpuReadyPartitionedTranscriptSceneBinaryV3Input
): Promise<PackedGpuReadyPartitionedTranscriptSceneBinaryV3> {
  const { policyProjection: policyInput, ...expandedInput } = input;
  const policyProjection = buildAnnotationPolicyProjectionTableV1(policyInput);
  validateExpandedGeometryPolicyCoupling(
    expandedInput.scene,
    expandedInput.interactionIndex,
    policyProjection
  );
  const policyGpuInstanceData = buildAnnotationPolicyGpuInstanceDataV1(
    expandedInput.scene.featureIndices,
    policyProjection
  );
  const expandedPacked = await packGpuReadyPartitionedTranscriptSceneBinaryV2(expandedInput);

  const expandedSceneOffset = 0;
  const policyOffset = align(expandedPacked.payload.byteLength, 4);
  const policyGpuOffset = align(policyOffset + policyProjection.featureRecordBytes.byteLength, 4);
  const byteLength = checkedAdd(policyGpuOffset, policyGpuInstanceData.byteLength, 'payload');
  const payload = new Uint8Array(byteLength);
  payload.set(expandedPacked.payload, expandedSceneOffset);
  payload.set(policyProjection.featureRecordBytes, policyOffset);
  const policyGpuBytes = new Uint8Array(
    policyGpuInstanceData.buffer,
    policyGpuInstanceData.byteOffset,
    policyGpuInstanceData.byteLength
  );
  payload.set(policyGpuBytes, policyGpuOffset);

  const expandedSceneSection: BinarySectionV3 = {
    byteOffset: expandedSceneOffset,
    byteLength: expandedPacked.payload.byteLength,
    count: expandedPacked.payload.byteLength,
    recordBytes: 1,
    alignmentBytes: 8,
    sha256: expandedPacked.manifest.integrity.payloadSha256,
  };
  const policyFeatureSection: BinarySectionV3 = {
    byteOffset: policyOffset,
    byteLength: policyProjection.featureRecordBytes.byteLength,
    count: policyProjection.featureCount,
    recordBytes: ANNOTATION_POLICY_FEATURE_RECORD_BYTES,
    alignmentBytes: 4,
    sha256: await sha256Hex(policyProjection.featureRecordBytes),
  };
  const policyGpuSection: BinarySectionV3 = {
    byteOffset: policyGpuOffset,
    byteLength: policyGpuInstanceData.byteLength,
    count: expandedInput.scene.featureIndices.length,
    recordBytes: ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideBytes,
    alignmentBytes: 4,
    sha256: await sha256Hex(policyGpuBytes),
  };
  const manifest: PartitionedTranscriptSceneBinaryManifestV3 = {
    schema: PARTITIONED_TRANSCRIPT_SCENE_BINARY_V3,
    expandedSceneManifest: expandedPacked.manifest,
    policyContract: {
      schema: ANNOTATION_POLICY_PROJECTION_V1,
      featureCount: policyProjection.featureCount,
      primitiveCount: expandedInput.scene.featureIndices.length,
      featureRecordBytes: ANNOTATION_POLICY_FEATURE_RECORD_BYTES,
      absentLaneSentinel: ANNOTATION_POLICY_ABSENT_LANE,
      annotationTypes: [...policyProjection.annotationTypes],
      expandedBandTypeIndices: [...policyProjection.expandedBandTypeIndices],
      canonicalBandTypeIndices: [...policyProjection.canonicalBandTypeIndices],
      geometryProjection: 'expanded-uncapped',
      runtimeProjection: 'canonical-membership-and-lane-cap.v1',
      spacerLanes: 1,
      fixedBandCapacityExceptionType: 'CDS',
      gpuInstanceSchema: ANNOTATION_POLICY_GPU_INSTANCES_V1,
      gpuInstanceRecordBytes: ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideBytes,
      gpuAbsentLane: ANNOTATION_POLICY_GPU_ABSENT_LANE,
      gpuMaxExactLane: ANNOTATION_POLICY_GPU_MAX_EXACT_LANE,
    },
    sections: {
      expandedScenePayload: expandedSceneSection,
      policyFeatureRecords: policyFeatureSection,
      policyGpuInstances: policyGpuSection,
    },
    byteLength,
    integrity: {
      algorithm: 'sha256',
      payloadSha256: '',
      contractSha256: '',
    },
  };
  manifest.integrity.payloadSha256 = await sha256Hex(payload);
  manifest.integrity.contractSha256 = await hashManifestContract(manifest);
  return {
    manifest,
    payload,
    packWork: {
      expandedScenePack: expandedPacked.packWork,
      policyFeatureRecordsWritten: policyProjection.featureCount,
      policyGpuInstanceRecordsWritten: expandedInput.scene.featureIndices.length,
      sourceGlyphGeometryMutations: 0,
    },
  };
}

export async function validatePartitionedTranscriptSceneBinaryV3(
  manifest: PartitionedTranscriptSceneBinaryManifestV3,
  payload: Uint8Array
): Promise<void> {
  validateManifestStructure(manifest, payload);
  if ((await sha256Hex(payload)) !== manifest.integrity.payloadSha256) {
    throw new Error('partitioned transcript scene v3 payload sha256 mismatch');
  }
  if ((await hashManifestContract(manifest)) !== manifest.integrity.contractSha256) {
    throw new Error('partitioned transcript scene v3 contract sha256 mismatch');
  }
  const expandedPayload = sectionBytes(payload, manifest.sections.expandedScenePayload);
  const policyBytes = sectionBytes(payload, manifest.sections.policyFeatureRecords);
  const policyGpuBytes = sectionBytes(payload, manifest.sections.policyGpuInstances);
  if ((await sha256Hex(expandedPayload)) !== manifest.sections.expandedScenePayload.sha256) {
    throw new Error('partitioned transcript scene v3 expanded scene sha256 mismatch');
  }
  if ((await sha256Hex(policyBytes)) !== manifest.sections.policyFeatureRecords.sha256) {
    throw new Error('partitioned transcript scene v3 policy sha256 mismatch');
  }
  if ((await sha256Hex(policyGpuBytes)) !== manifest.sections.policyGpuInstances.sha256) {
    throw new Error('partitioned transcript scene v3 policy GPU sha256 mismatch');
  }

  await validatePartitionedTranscriptSceneBinaryV2(manifest.expandedSceneManifest, expandedPayload);
  const policyProjection = policyTableView(manifest, policyBytes);
  const policyGpuInstanceData = policyGpuView(manifest, payload);
  validateAnnotationPolicyProjectionTableV1(policyProjection);
  validateAnnotationPolicyGpuInstanceDataV1(
    policyGpuInstanceData,
    manifest.policyContract.primitiveCount
  );
  const expandedScene = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV2(
    manifest.expandedSceneManifest,
    expandedPayload,
    TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2
  );
  validateExpandedGeometryPolicyCoupling(
    expandedScene.visual.scene,
    expandedScene.interactionIndex,
    policyProjection,
    policyGpuInstanceData
  );
}

export async function unpackPartitionedTranscriptSceneBinaryV3(
  manifest: PartitionedTranscriptSceneBinaryManifestV3,
  payload: Uint8Array
): Promise<UnpackedPartitionedTranscriptSceneBinaryV3> {
  await validatePartitionedTranscriptSceneBinaryV3(manifest, payload);
  const trusted = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV3(
    manifest,
    payload,
    TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V3
  );
  const { trustedMainDecodeWork: _trustedMainDecodeWork, ...unpacked } = trusted;
  return unpacked;
}

export function unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV3(
  manifest: PartitionedTranscriptSceneBinaryManifestV3,
  payload: Uint8Array,
  validationMarker: typeof TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V3
): TrustedMainUnpackedPartitionedTranscriptSceneBinaryV3 {
  if (validationMarker !== TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V3) {
    throw new Error('partitioned transcript scene v3 trusted-main validation marker is invalid');
  }
  validateManifestStructure(manifest, payload);
  const expandedPayload = sectionBytes(payload, manifest.sections.expandedScenePayload);
  const policyBytes = sectionBytes(payload, manifest.sections.policyFeatureRecords);
  const policyGpuInstanceData = policyGpuView(manifest, payload);
  return {
    expandedScene: unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV2(
      manifest.expandedSceneManifest,
      expandedPayload,
      TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V2
    ),
    policyProjection: policyTableView(manifest, policyBytes),
    policyGpuInstanceData,
    trustedMainDecodeWork: {
      payloadBytesCopied: 0,
      hashOperations: 0,
      visualSemanticPrimitiveScans: 0,
      interactionSemanticFeatureScans: 0,
      policySemanticFeatureScans: 0,
      visualInteractionCouplingPrimitiveScans: 0,
      visualPolicyCouplingPrimitiveScans: 0,
    },
  };
}

function validateManifestStructure(
  manifest: PartitionedTranscriptSceneBinaryManifestV3,
  payload: Uint8Array
): void {
  if (manifest?.schema !== PARTITIONED_TRANSCRIPT_SCENE_BINARY_V3) {
    throw new Error(
      `partitioned transcript scene schema must be ${PARTITIONED_TRANSCRIPT_SCENE_BINARY_V3}`
    );
  }
  if (manifest.expandedSceneManifest?.schema !== PARTITIONED_TRANSCRIPT_SCENE_BINARY_V2) {
    throw new Error('partitioned transcript scene v3 expanded scene contract is invalid');
  }
  const policy = manifest.policyContract;
  if (
    policy?.schema !== ANNOTATION_POLICY_PROJECTION_V1 ||
    !Number.isSafeInteger(policy.featureCount) ||
    policy.featureCount < 0 ||
    !Number.isSafeInteger(policy.primitiveCount) ||
    policy.primitiveCount < 0 ||
    policy.featureRecordBytes !== ANNOTATION_POLICY_FEATURE_RECORD_BYTES ||
    policy.absentLaneSentinel !== ANNOTATION_POLICY_ABSENT_LANE ||
    policy.geometryProjection !== 'expanded-uncapped' ||
    policy.runtimeProjection !== 'canonical-membership-and-lane-cap.v1' ||
    policy.spacerLanes !== 1 ||
    policy.fixedBandCapacityExceptionType !== 'CDS' ||
    policy.gpuInstanceSchema !== ANNOTATION_POLICY_GPU_INSTANCES_V1 ||
    policy.gpuInstanceRecordBytes !== ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideBytes ||
    policy.gpuAbsentLane !== ANNOTATION_POLICY_GPU_ABSENT_LANE ||
    policy.gpuMaxExactLane !== ANNOTATION_POLICY_GPU_MAX_EXACT_LANE ||
    policy.featureCount !== manifest.expandedSceneManifest.interactionContract.featureCount ||
    policy.primitiveCount !== manifest.expandedSceneManifest.interactionContract.primitiveCount
  ) {
    throw new Error('partitioned transcript scene v3 policy contract is invalid');
  }
  const expanded = manifest.sections?.expandedScenePayload;
  const records = manifest.sections?.policyFeatureRecords;
  const gpuInstances = manifest.sections?.policyGpuInstances;
  validateSection(expanded, 1, 8, 'expanded scene');
  validateSection(records, ANNOTATION_POLICY_FEATURE_RECORD_BYTES, 4, 'policy feature records');
  validateSection(
    gpuInstances,
    ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideBytes,
    4,
    'policy GPU instances'
  );
  if (
    expanded.byteOffset !== 0 ||
    expanded.byteLength !== manifest.expandedSceneManifest.byteLength ||
    expanded.count !== expanded.byteLength ||
    expanded.sha256 !== manifest.expandedSceneManifest.integrity.payloadSha256 ||
    records.byteOffset !== align(expanded.byteOffset + expanded.byteLength, 4) ||
    records.count !== policy.featureCount ||
    records.byteLength !==
      checkedMultiply(records.count, ANNOTATION_POLICY_FEATURE_RECORD_BYTES, 'policy records') ||
    gpuInstances.byteOffset !== align(records.byteOffset + records.byteLength, 4) ||
    gpuInstances.count !== policy.primitiveCount ||
    gpuInstances.byteLength !==
      checkedMultiply(
        gpuInstances.count,
        ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideBytes,
        'policy GPU instances'
      ) ||
    manifest.byteLength !== gpuInstances.byteOffset + gpuInstances.byteLength ||
    payload.byteLength !== manifest.byteLength ||
    manifest.integrity?.algorithm !== 'sha256' ||
    !SHA256_HEX.test(manifest.integrity.payloadSha256) ||
    !SHA256_HEX.test(manifest.integrity.contractSha256)
  ) {
    throw new Error('partitioned transcript scene v3 sections are not exact and aligned');
  }
  assertZeroPadding(payload, expanded.byteOffset + expanded.byteLength, records.byteOffset);
  assertZeroPadding(payload, records.byteOffset + records.byteLength, gpuInstances.byteOffset);
  if ((payload.byteOffset + gpuInstances.byteOffset) % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('partitioned transcript scene v3 policy GPU data is not aligned');
  }
}

function validateSection(
  section: BinarySectionV3,
  recordBytes: number,
  alignmentBytes: 4 | 8,
  label: string
): void {
  if (
    !section ||
    !Number.isSafeInteger(section.byteOffset) ||
    section.byteOffset < 0 ||
    !Number.isSafeInteger(section.byteLength) ||
    section.byteLength < 0 ||
    !Number.isSafeInteger(section.count) ||
    section.count < 0 ||
    section.recordBytes !== recordBytes ||
    section.alignmentBytes !== alignmentBytes ||
    section.byteOffset % alignmentBytes !== 0 ||
    !SHA256_HEX.test(section.sha256)
  ) {
    throw new Error(`partitioned transcript scene v3 ${label} section is invalid`);
  }
}

function policyTableView(
  manifest: PartitionedTranscriptSceneBinaryManifestV3,
  policyBytes: Uint8Array
): AnnotationPolicyProjectionTableV1 {
  return {
    schema: ANNOTATION_POLICY_PROJECTION_V1,
    featureCount: manifest.policyContract.featureCount,
    annotationTypes: manifest.policyContract.annotationTypes,
    expandedBandTypeIndices: manifest.policyContract.expandedBandTypeIndices,
    canonicalBandTypeIndices: manifest.policyContract.canonicalBandTypeIndices,
    featureRecordBytes: policyBytes,
  };
}

function policyGpuView(
  manifest: PartitionedTranscriptSceneBinaryManifestV3,
  payload: Uint8Array
): Float32Array {
  const section = manifest.sections.policyGpuInstances;
  return new Float32Array(
    payload.buffer,
    payload.byteOffset + section.byteOffset,
    section.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

function validateExpandedGeometryPolicyCoupling(
  scene: GpuReadyPartitionedTranscriptScene,
  interactionIndex: PackGpuReadyPartitionedTranscriptSceneBinaryV2Input['interactionIndex'],
  policy: AnnotationPolicyProjectionTableV1,
  policyGpuInstanceData?: Float32Array
): void {
  if (interactionIndex.featureCount !== policy.featureCount) {
    throw new Error('partitioned transcript scene v3 visual/policy feature counts do not match');
  }
  for (let featureIndex = 0; featureIndex < policy.featureCount; featureIndex += 1) {
    const interactionFeature = decodePrepackedAnnotationInteractionFeatureV2(
      interactionIndex,
      featureIndex
    );
    const policyFeature = decodeAnnotationPolicyProjectionFeatureV1(policy, featureIndex);
    if (interactionFeature.lane !== policyFeature.expandedLane) {
      throw new Error(
        `partitioned transcript scene v3 feature ${featureIndex} is not expanded-lane geometry`
      );
    }
  }

  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  if (scene.packedInstanceData.length !== scene.featureIndices.length * stride) {
    throw new Error('partitioned transcript scene v3 expanded instance layout is invalid');
  }
  for (let primitiveIndex = 0; primitiveIndex < scene.featureIndices.length; primitiveIndex += 1) {
    const featureIndex = scene.featureIndices[primitiveIndex];
    if (featureIndex >= policy.featureCount) {
      throw new Error('partitioned transcript scene v3 primitive policy owner is invalid');
    }
    const policyFeature = decodeAnnotationPolicyProjectionFeatureV1(policy, featureIndex);
    const expectedOffset = Math.fround(
      -PREPACKED_ANNOTATION_BAR_HEIGHT_PX / 2 -
        policyFeature.expandedTrackLane * PREPACKED_ANNOTATION_LANE_STEP_PX
    );
    const actualOffset =
      scene.packedInstanceData[
        primitiveIndex * stride + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter
      ];
    if (actualOffset !== expectedOffset) {
      throw new Error(
        `partitioned transcript scene v3 primitive ${primitiveIndex} is not expanded-track geometry`
      );
    }
    if (policyGpuInstanceData) {
      const policyBase = primitiveIndex * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats;
      const expectedGpuValues = [
        policyFeature.expandedLane,
        policyFeature.expandedTrackLane,
        policyFeature.canonicalLane ?? ANNOTATION_POLICY_GPU_ABSENT_LANE,
        policyFeature.canonicalTrackLane ?? ANNOTATION_POLICY_GPU_ABSENT_LANE,
      ];
      for (let valueIndex = 0; valueIndex < expectedGpuValues.length; valueIndex++) {
        if (policyGpuInstanceData[policyBase + valueIndex] !== expectedGpuValues[valueIndex]) {
          throw new Error(
            `partitioned transcript scene v3 primitive ${primitiveIndex} policy GPU coupling is invalid`
          );
        }
      }
    }
  }
}

function sectionBytes(payload: Uint8Array, section: BinarySectionV3): Uint8Array {
  return new Uint8Array(
    payload.buffer,
    payload.byteOffset + section.byteOffset,
    section.byteLength
  );
}

function assertZeroPadding(payload: Uint8Array, start: number, end: number): void {
  if (start < 0 || end < start || end > payload.byteLength) {
    throw new Error('partitioned transcript scene v3 padding range is invalid');
  }
  for (let index = start; index < end; index += 1) {
    if (payload[index] !== 0) {
      throw new Error('partitioned transcript scene v3 alignment padding is not zero');
    }
  }
}

function align(value: number, alignment: number): number {
  const remainder = value % alignment;
  return remainder === 0 ? value : checkedAdd(value, alignment - remainder, 'alignment');
}

function checkedMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`partitioned transcript scene v3 ${label} byte length overflows`);
  }
  return value;
}

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`partitioned transcript scene v3 ${label} offset overflows`);
  }
  return value;
}

function contractMaterial(
  manifest: PartitionedTranscriptSceneBinaryManifestV3
): AnnotationSceneJsonValue {
  return {
    schema: manifest.schema,
    expandedSceneManifest: manifest.expandedSceneManifest,
    policyContract: manifest.policyContract,
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

async function hashManifestContract(
  manifest: PartitionedTranscriptSceneBinaryManifestV3
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(contractMaterial(manifest))));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('partitioned transcript scene v3 sha256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
