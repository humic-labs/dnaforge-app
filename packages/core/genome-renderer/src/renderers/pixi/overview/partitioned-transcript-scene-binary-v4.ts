import {
  assertSourceAnnotationAliasesV1,
  type SourceAnnotationAliasesV1,
} from '../../../annotation-data-appearance';
import type {
  AnnotationSceneAssemblyContractV1,
  AnnotationSceneDatasetContractV1,
  AnnotationSceneJsonValue,
  AnnotationShapeFamilyV1,
} from './annotation-scene-binary-v1';
import { annotationPolicyLaneCenterOffsetPxV1 } from './annotation-policy-gpu-instances-v1';
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
  ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1,
  assertAnnotationPolicyDirectSubmissionBankV1,
  type AnnotationPolicyDirectSubmissionBankV1,
  type AnnotationPolicyDirectSubmissionModeBankV1,
  type AnnotationPolicyDirectSubmissionPartitionV1,
} from './annotation-policy-direct-submission-bank-v1';
import {
  ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1,
  assertAnnotationPolicyDirectFineIndexV1,
  type AnnotationPolicyDirectFineIndexV1,
} from './annotation-policy-direct-fine-index-v1';
import type {
  GpuReadyPartitionedTranscriptScene,
  TranscriptInstancePartition,
} from './partitioned-transcript-scene';
import {
  PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES,
  PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
  decodePrepackedAnnotationInteractionFeatureV2,
  validatePrepackedAnnotationInteractionIndexV2,
  validatePrepackedAnnotationInteractionVisualCouplingAfterValidatedIndexV2,
  validatePrepackedAnnotationInteractionVisualCouplingV2,
  type PrepackedAnnotationInteractionVisualCouplingValidationWorkV2,
  type PrepackedAnnotationInteractionIndexV2,
} from './prepacked-annotation-interaction-index-v2';
import { FINE_TRANSCRIPT_VIEW_SPAN_BP } from './fine-transcript-view-planner';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';
import { unpackBpCoordinate } from './bp-coordinate-packing';
import type { AnnotationColorRoleKeyV1 } from '../../../annotation-role-palette';

export const PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4 =
  'partitioned-transcript-scene-binary.v4' as const;
export const TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4 =
  'main-process-fully-validated-partitioned-transcript-scene.v4' as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const U32_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const U64_BYTES = BigUint64Array.BYTES_PER_ELEMENT;

interface BinarySectionV4 {
  byteOffset: number;
  byteLength: number;
  count: number;
  recordBytes: number;
  alignmentBytes: 1 | 4 | 8;
}

interface DirectPartitionContractV4 extends Omit<
  AnnotationPolicyDirectSubmissionPartitionV1,
  'lanePrefixEnds'
> {
  lanePrefixOffset: number;
  lanePrefixCount: number;
}

interface DirectModeContractV4 {
  mode: 'expanded' | 'canonical';
  instanceCount: number;
  maxTrackLane: number;
  partitions: DirectPartitionContractV4[];
}

type SectionKeyV4 =
  | 'expandedGlyphs'
  | 'expandedFeatureIndices'
  | 'expandedLanePrefixes'
  | 'expandedFineTileOffsets'
  | 'expandedFineBankRecordIndices'
  | 'canonicalGlyphs'
  | 'canonicalFeatureIndices'
  | 'canonicalExpandedBankRecordIndices'
  | 'canonicalLanePrefixes'
  | 'canonicalFineTileOffsets'
  | 'canonicalFineBankRecordIndices'
  | 'sourceFineTilePrimitiveCounts'
  | 'featureFamilyIndices'
  | 'policyFeatureRecords'
  | 'interactionFeatureRecords'
  | 'interactionRendererIdFeatureIndices'
  | 'interactionCanonicalIdentityFeatureIndices'
  | 'interactionIntervalFeatureIndices'
  | 'interactionIntervalSubtreeMaxEnds'
  | 'interactionFeaturePrimitiveOffsets'
  | 'interactionFeaturePrimitiveIndices'
  | 'interactionStrings';

export interface PartitionedTranscriptSceneBinaryManifestV4 {
  schema: typeof PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4;
  datasetContract: AnnotationSceneDatasetContractV1;
  assemblyContract: AnnotationSceneAssemblyContractV1;
  families: AnnotationShapeFamilyV1[];
  featureCount: number;
  sourceAnnotationAliases?: readonly SourceAnnotationAliasesV1[];
  sourcePrimitiveCount: number;
  partitionSpanBp: number;
  maxPrimitiveSpanBp: number;
  directContract: {
    schema: typeof ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1;
    glyphRecordBytes: typeof TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes;
    fineIndexSchema: typeof ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1;
    fineTileSpanBp: typeof FINE_TRANSCRIPT_VIEW_SPAN_BP;
    fineTileCount: number;
    expanded: DirectModeContractV4;
    canonical: DirectModeContractV4;
  };
  policyContract: {
    schema: typeof ANNOTATION_POLICY_PROJECTION_V1;
    featureRecordBytes: typeof ANNOTATION_POLICY_FEATURE_RECORD_BYTES;
    absentLaneSentinel: typeof ANNOTATION_POLICY_ABSENT_LANE;
    annotationTypes: string[];
    expandedBandTypeIndices: number[];
    canonicalBandTypeIndices: number[];
  };
  interactionContract: {
    schema: typeof PREPACKED_ANNOTATION_INTERACTION_INDEX_V2;
    featureRecordBytes: typeof PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES;
  };
  sections: Record<SectionKeyV4, BinarySectionV4>;
  byteLength: number;
  integrity: {
    algorithm: 'sha256';
    payloadSha256: string;
    contractSha256: string;
  };
}

export interface PackGpuReadyPartitionedTranscriptSceneBinaryV4Input {
  datasetContract: AnnotationSceneDatasetContractV1;
  assemblyContract: AnnotationSceneAssemblyContractV1;
  families: ReadonlyArray<AnnotationShapeFamilyV1>;
  featureFamilyIndices: ArrayLike<number>;
  scene: GpuReadyPartitionedTranscriptScene;
  interactionIndex: PrepackedAnnotationInteractionIndexV2;
  policyProjection: BuildAnnotationPolicyProjectionTableV1Input;
  payloadSha256?: PartitionedTranscriptSceneBinarySha256V4;
}

export type PartitionedTranscriptSceneBinarySha256V4 = (bytes: Uint8Array) => Promise<string>;

export interface PartitionedTranscriptSceneBinaryValidationWorkV4 {
  readonly interactionIndexValidationCount: 1;
  readonly interactionFeatureScanCardinality: number;
  readonly couplingPrimitiveScanCardinality: number;
  readonly directFineIndexValidationCount: 2;
  readonly directFineIndexRecordScanCardinality: number;
}

export interface PartitionedTranscriptSceneRoleSidecarV1 {
  readonly roleTable: readonly AnnotationColorRoleKeyV1[];
  readonly expandedRoleIndices: Uint8Array;
  readonly canonicalRoleIndices: Uint8Array;
}

export interface PackedPartitionedTranscriptSceneBinaryV4 {
  manifest: PartitionedTranscriptSceneBinaryManifestV4;
  payload: Uint8Array;
  roleSidecar?: PartitionedTranscriptSceneRoleSidecarV1;
  packWork: {
    sourcePrimitiveCount: number;
    expandedDirectPrimitiveCount: number;
    canonicalDirectPrimitiveCount: number;
    retainedExpandedSourceGlyphBytes: 0;
    retainedPolicyGpuBytes: 0;
    fineRecordIndexCount: number;
  };
}

export interface AnnotationPolicyDirectFineIndicesV1 {
  readonly expanded: AnnotationPolicyDirectFineIndexV1;
  readonly canonical: AnnotationPolicyDirectFineIndexV1;
}

export interface TrustedPartitionedTranscriptRendererAdmissionV4 {
  readonly __trustedPartitionedTranscriptRendererAdmissionV4: never;
}

export interface TrustedPartitionedTranscriptRendererProvenanceV4 {
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly sourceSha256: string;
  readonly assemblyId: string;
  readonly assemblyLengthBp: number;
  readonly payloadSha256: string;
  readonly contractSha256: string;
  readonly byteLength: number;
}

export interface TrustedPartitionedTranscriptRendererLoadIdentityV4 {
  readonly ownerKey: string;
  readonly sceneContractSha256: string;
  readonly genomeIdentity: string;
  readonly genomeLengthBp: number;
  readonly partitionSpanBp: number;
  readonly artifactKey: string;
  readonly themeMode: 'light' | 'dark';
  readonly trackType: string;
  readonly annotationBarHeightPx: number;
  readonly laneAlgorithmToken: string;
  readonly mapperContractToken: string;
  readonly geometryContractToken: string;
  readonly interactionContractToken: string;
}

export interface TrustedPartitionedTranscriptRendererAdmissionBindingV4 {
  readonly provenance: TrustedPartitionedTranscriptRendererProvenanceV4;
  readonly loadIdentity: TrustedPartitionedTranscriptRendererLoadIdentityV4;
  readonly scene: GpuReadyPartitionedTranscriptScene;
  readonly families: AnnotationShapeFamilyV1[];
  readonly featureFamilyIndices: Uint32Array;
  readonly interactionIndex: PrepackedAnnotationInteractionIndexV2;
  readonly policyProjection: AnnotationPolicyProjectionTableV1;
  readonly submissionBank: AnnotationPolicyDirectSubmissionBankV1;
  readonly submissionFineIndices: AnnotationPolicyDirectFineIndicesV1;
}

const trustedRendererAdmissionBindingsV4 = new WeakMap<
  object,
  Omit<TrustedPartitionedTranscriptRendererAdmissionBindingV4, 'loadIdentity'> & {
    readonly loadIdentity: TrustedPartitionedTranscriptRendererLoadIdentityV4 | null;
  }
>();

export interface UnpackedPartitionedTranscriptSceneBinaryV4 {
  scene: GpuReadyPartitionedTranscriptScene;
  families: AnnotationShapeFamilyV1[];
  featureFamilyIndices: Uint32Array;
  interactionIndex: PrepackedAnnotationInteractionIndexV2;
  policyProjection: AnnotationPolicyProjectionTableV1;
  submissionBank: AnnotationPolicyDirectSubmissionBankV1;
  submissionFineIndices: AnnotationPolicyDirectFineIndicesV1;
}

export interface TrustedMainUnpackedPartitionedTranscriptSceneBinaryV4 extends UnpackedPartitionedTranscriptSceneBinaryV4 {
  rendererAdmissionCapability: TrustedPartitionedTranscriptRendererAdmissionV4;
  rendererAdmissionProvenance: TrustedPartitionedTranscriptRendererProvenanceV4;
  trustedMainDecodeWork: {
    payloadBytesCopied: 0;
    hashOperations: 0;
    visualSemanticPrimitiveScans: 0;
    interactionSemanticFeatureScans: 0;
    couplingPrimitiveScans: 0;
    policyProjectionScans: 0;
  };
}

const SECTION_DEFINITIONS: ReadonlyArray<{
  key: SectionKeyV4;
  recordBytes: number;
  alignmentBytes: 1 | 4 | 8;
}> = [
  {
    key: 'expandedGlyphs',
    recordBytes: TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes,
    alignmentBytes: 4,
  },
  { key: 'expandedFeatureIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'expandedLanePrefixes', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'expandedFineTileOffsets', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'expandedFineBankRecordIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  {
    key: 'canonicalGlyphs',
    recordBytes: TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes,
    alignmentBytes: 4,
  },
  { key: 'canonicalFeatureIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'canonicalExpandedBankRecordIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'canonicalLanePrefixes', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'canonicalFineTileOffsets', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'canonicalFineBankRecordIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'sourceFineTilePrimitiveCounts', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'featureFamilyIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
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
  { key: 'interactionCanonicalIdentityFeatureIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'interactionIntervalFeatureIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'interactionIntervalSubtreeMaxEnds', recordBytes: U64_BYTES, alignmentBytes: 8 },
  { key: 'interactionFeaturePrimitiveOffsets', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'interactionFeaturePrimitiveIndices', recordBytes: U32_BYTES, alignmentBytes: 4 },
  { key: 'interactionStrings', recordBytes: 1, alignmentBytes: 1 },
];

export async function packGpuReadyPartitionedTranscriptSceneBinaryV4(
  input: PackGpuReadyPartitionedTranscriptSceneBinaryV4Input
): Promise<PackedPartitionedTranscriptSceneBinaryV4> {
  validatePackContracts(input);
  validatePrepackedAnnotationInteractionVisualCouplingV2(
    input.interactionIndex,
    input.scene,
    input.assemblyContract.assemblyLengthBp
  );
  const policyProjection = buildAnnotationPolicyProjectionTableV1(input.policyProjection);
  if (policyProjection.featureCount !== input.interactionIndex.featureCount) {
    throw new Error('partitioned transcript scene v4 policy feature count mismatch');
  }
  const trackLanes = buildPolicyTrackLaneTables(policyProjection);
  const expandedCensus = censusDirectMode(input.scene, trackLanes.expanded, 'expanded');
  const canonicalCensus = censusDirectMode(input.scene, trackLanes.canonical, 'canonical');
  if (expandedCensus.instanceCount !== input.scene.featureIndices.length) {
    throw new Error(
      'partitioned transcript scene v4 expanded bank must own every source primitive'
    );
  }
  validateUint32Input(
    input.featureFamilyIndices,
    input.interactionIndex.featureCount,
    'feature family indices'
  );
  const fineTileCount = Math.ceil(
    input.assemblyContract.assemblyLengthBp / FINE_TRANSCRIPT_VIEW_SPAN_BP
  );
  const counts = directSectionCounts(
    expandedCensus,
    canonicalCensus,
    fineTileCount,
    input.interactionIndex,
    input.interactionIndex.featureCount
  );
  const { sections, byteLength } = buildSectionLayout(counts);
  const cursor = byteLength;
  const payload = new Uint8Array(cursor);
  let sourceToExpandedBankRecord: Uint32Array | null = new Uint32Array(
    input.scene.featureIndices.length
  );
  const sourceRoles =
    input.scene.roleIndices && input.scene.roleTable ? input.scene.roleIndices : undefined;
  if (sourceRoles && sourceRoles.length !== input.scene.featureIndices.length) {
    throw new Error('partitioned transcript scene v4 role indices are not parallel to glyphs');
  }
  const expandedRoles = sourceRoles ? new Uint8Array(expandedCensus.instanceCount) : undefined;
  const canonicalRoles = sourceRoles ? new Uint8Array(canonicalCensus.instanceCount) : undefined;
  fillDirectModePayload(
    input.scene,
    trackLanes.expanded,
    expandedCensus,
    f32View(payload, sections.expandedGlyphs),
    u32View(payload, sections.expandedFeatureIndices),
    u32View(payload, sections.expandedLanePrefixes),
    sourceToExpandedBankRecord,
    undefined,
    undefined,
    sourceRoles,
    expandedRoles
  );
  fillDirectModePayload(
    input.scene,
    trackLanes.canonical,
    canonicalCensus,
    f32View(payload, sections.canonicalGlyphs),
    u32View(payload, sections.canonicalFeatureIndices),
    u32View(payload, sections.canonicalLanePrefixes),
    undefined,
    sourceToExpandedBankRecord,
    u32View(payload, sections.canonicalExpandedBankRecordIndices),
    sourceRoles,
    canonicalRoles
  );
  fillDirectFineIndexPayload(
    f32View(payload, sections.expandedGlyphs),
    expandedCensus.instanceCount,
    input.assemblyContract.assemblyLengthBp,
    u32View(payload, sections.expandedFineTileOffsets),
    u32View(payload, sections.expandedFineBankRecordIndices),
    u32View(payload, sections.sourceFineTilePrimitiveCounts)
  );
  fillDirectFineIndexPayload(
    f32View(payload, sections.canonicalGlyphs),
    canonicalCensus.instanceCount,
    input.assemblyContract.assemblyLengthBp,
    u32View(payload, sections.canonicalFineTileOffsets),
    u32View(payload, sections.canonicalFineBankRecordIndices)
  );
  copyUint32Input(input.featureFamilyIndices, u32View(payload, sections.featureFamilyIndices));
  payload.set(policyProjection.featureRecordBytes, sections.policyFeatureRecords.byteOffset);
  fillInteractionPayload(payload, sections, input.interactionIndex, sourceToExpandedBankRecord);
  sourceToExpandedBankRecord = null;
  const manifest: PartitionedTranscriptSceneBinaryManifestV4 = {
    schema: PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
    datasetContract: structuredClone(input.datasetContract),
    assemblyContract: structuredClone(input.assemblyContract),
    families: structuredClone([...input.families]),
    featureCount: input.interactionIndex.featureCount,
    ...(input.scene.sourceAnnotationAliases
      ? { sourceAnnotationAliases: structuredClone(input.scene.sourceAnnotationAliases) }
      : {}),
    sourcePrimitiveCount: input.scene.featureIndices.length,
    partitionSpanBp: input.scene.partitionSpanBp,
    maxPrimitiveSpanBp: input.scene.maxPrimitiveSpanBp,
    directContract: {
      schema: ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1,
      glyphRecordBytes: TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes,
      fineIndexSchema: ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1,
      fineTileSpanBp: FINE_TRANSCRIPT_VIEW_SPAN_BP,
      fineTileCount,
      expanded: modeContractFromCensus(expandedCensus),
      canonical: modeContractFromCensus(canonicalCensus),
    },
    policyContract: {
      schema: ANNOTATION_POLICY_PROJECTION_V1,
      featureRecordBytes: ANNOTATION_POLICY_FEATURE_RECORD_BYTES,
      absentLaneSentinel: ANNOTATION_POLICY_ABSENT_LANE,
      annotationTypes: [...policyProjection.annotationTypes],
      expandedBandTypeIndices: [...policyProjection.expandedBandTypeIndices],
      canonicalBandTypeIndices: [...policyProjection.canonicalBandTypeIndices],
    },
    interactionContract: {
      schema: PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
      featureRecordBytes: PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES,
    },
    sections,
    byteLength: payload.byteLength,
    integrity: { algorithm: 'sha256', payloadSha256: '', contractSha256: '' },
  };
  const payloadSha256 = await (input.payloadSha256 ?? sha256Hex)(payload);
  if (!SHA256_HEX.test(payloadSha256)) {
    throw new Error('partitioned transcript scene v4 payload hasher returned an invalid digest');
  }
  manifest.integrity.payloadSha256 = payloadSha256;
  manifest.integrity.contractSha256 = await hashContract(manifest);
  return {
    manifest,
    payload,
    ...(sourceRoles && input.scene.roleTable && expandedRoles && canonicalRoles
      ? {
          roleSidecar: {
            roleTable: [...input.scene.roleTable],
            expandedRoleIndices: expandedRoles,
            canonicalRoleIndices: canonicalRoles,
          },
        }
      : {}),
    packWork: {
      sourcePrimitiveCount: input.scene.featureIndices.length,
      expandedDirectPrimitiveCount: expandedCensus.instanceCount,
      canonicalDirectPrimitiveCount: canonicalCensus.instanceCount,
      retainedExpandedSourceGlyphBytes: 0,
      retainedPolicyGpuBytes: 0,
      fineRecordIndexCount: expandedCensus.instanceCount + canonicalCensus.instanceCount,
    },
  };
}

export async function resealPartitionedTranscriptSceneBinaryDatasetContractV4(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  datasetContract: PartitionedTranscriptSceneBinaryManifestV4['datasetContract']
): Promise<PartitionedTranscriptSceneBinaryManifestV4> {
  if (
    !nonemptyContractString(datasetContract?.datasetId) ||
    !nonemptyContractString(datasetContract?.datasetVersion) ||
    !SHA256_HEX.test(datasetContract?.sourceSha256 ?? '')
  ) {
    throw new Error('partitioned transcript scene v4 reseal dataset contract is invalid');
  }
  const resealed: PartitionedTranscriptSceneBinaryManifestV4 = {
    ...manifest,
    datasetContract: { ...datasetContract },
    integrity: {
      ...manifest.integrity,
      contractSha256: '',
    },
  };
  resealed.integrity.contractSha256 = await hashContract(resealed);
  return resealed;
}

interface DirectPartitionCensusV4 {
  readonly source: TranscriptInstancePartition;
  readonly firstInstance: number;
  readonly instanceCount: number;
  readonly maxTrackLane: number;
  readonly laneCounts: Uint32Array;
  readonly lanePrefixOffset: number;
}

interface DirectModeCensusV4 {
  readonly mode: 'expanded' | 'canonical';
  readonly instanceCount: number;
  readonly maxTrackLane: number;
  readonly lanePrefixCount: number;
  readonly partitions: ReadonlyArray<DirectPartitionCensusV4>;
}

function buildPolicyTrackLaneTables(policy: AnnotationPolicyProjectionTableV1): {
  expanded: Uint32Array;
  canonical: Uint32Array;
} {
  const expanded = new Uint32Array(policy.featureCount);
  const canonical = new Uint32Array(policy.featureCount);
  canonical.fill(ANNOTATION_POLICY_ABSENT_LANE);
  for (let featureIndex = 0; featureIndex < policy.featureCount; featureIndex++) {
    const feature = decodeAnnotationPolicyProjectionFeatureV1(policy, featureIndex);
    if (
      feature.expandedTrackLane >= policy.featureCount ||
      (feature.canonicalTrackLane !== null && feature.canonicalTrackLane >= policy.featureCount)
    ) {
      throw new Error('partitioned transcript scene v4 track-lane domain exceeds feature count');
    }
    expanded[featureIndex] = feature.expandedTrackLane;
    canonical[featureIndex] = feature.canonicalTrackLane ?? ANNOTATION_POLICY_ABSENT_LANE;
  }
  assertDenseTrackLaneDomain(expanded, 'expanded');
  assertDenseTrackLaneDomain(canonical, 'canonical');
  return { expanded, canonical };
}

function assertDenseTrackLaneDomain(lanes: Uint32Array, mode: 'expanded' | 'canonical'): void {
  const seen = new Uint8Array(lanes.length);
  let maxLane = -1;
  for (const lane of lanes) {
    if (lane === ANNOTATION_POLICY_ABSENT_LANE) continue;
    seen[lane] = 1;
    maxLane = Math.max(maxLane, lane);
  }
  for (let lane = 0; lane <= maxLane; lane++) {
    if (!seen[lane]) {
      throw new Error(`partitioned transcript scene v4 ${mode} track-lane domain is sparse`);
    }
  }
}

function censusDirectMode(
  scene: GpuReadyPartitionedTranscriptScene,
  trackLanesByFeature: Uint32Array,
  mode: 'expanded' | 'canonical'
): DirectModeCensusV4 {
  const partitions: DirectPartitionCensusV4[] = [];
  let instanceCount = 0;
  let maxTrackLane = -1;
  let lanePrefixCount = 0;
  for (const source of scene.partitions) {
    const counts: number[] = [];
    let partitionCount = 0;
    let partitionMaxTrackLane = -1;
    const end = source.firstInstance + source.instanceCount;
    for (let sourceIndex = source.firstInstance; sourceIndex < end; sourceIndex++) {
      const featureIndex = scene.featureIndices[sourceIndex];
      if (featureIndex >= trackLanesByFeature.length) {
        throw new Error('partitioned transcript scene v4 primitive policy owner is invalid');
      }
      const lane = trackLanesByFeature[featureIndex];
      if (lane === ANNOTATION_POLICY_ABSENT_LANE) continue;
      counts[lane] = (counts[lane] ?? 0) + 1;
      partitionCount++;
      partitionMaxTrackLane = Math.max(partitionMaxTrackLane, lane);
    }
    const laneCounts = new Uint32Array(partitionMaxTrackLane + 1);
    for (let lane = 0; lane < laneCounts.length; lane++) laneCounts[lane] = counts[lane] ?? 0;
    partitions.push({
      source,
      firstInstance: instanceCount,
      instanceCount: partitionCount,
      maxTrackLane: partitionMaxTrackLane,
      laneCounts,
      lanePrefixOffset: lanePrefixCount,
    });
    instanceCount = checkedAdd(instanceCount, partitionCount, `${mode} instance count`);
    lanePrefixCount = checkedAdd(
      lanePrefixCount,
      partitionMaxTrackLane + 2,
      `${mode} lane prefixes`
    );
    maxTrackLane = Math.max(maxTrackLane, partitionMaxTrackLane);
  }
  return { mode, instanceCount, maxTrackLane, lanePrefixCount, partitions };
}

function directSectionCounts(
  expanded: DirectModeCensusV4,
  canonical: DirectModeCensusV4,
  fineTileCount: number,
  interaction: PrepackedAnnotationInteractionIndexV2,
  featureCount: number
): Record<SectionKeyV4, number> {
  return {
    expandedGlyphs: expanded.instanceCount,
    expandedFeatureIndices: expanded.instanceCount,
    expandedLanePrefixes: expanded.lanePrefixCount,
    expandedFineTileOffsets: fineTileCount + 1,
    expandedFineBankRecordIndices: expanded.instanceCount,
    canonicalGlyphs: canonical.instanceCount,
    canonicalFeatureIndices: canonical.instanceCount,
    canonicalExpandedBankRecordIndices: canonical.instanceCount,
    canonicalLanePrefixes: canonical.lanePrefixCount,
    canonicalFineTileOffsets: fineTileCount + 1,
    canonicalFineBankRecordIndices: canonical.instanceCount,
    sourceFineTilePrimitiveCounts: fineTileCount,
    featureFamilyIndices: featureCount,
    policyFeatureRecords: featureCount,
    interactionFeatureRecords: featureCount,
    interactionRendererIdFeatureIndices: interaction.rendererIdFeatureIndices.length,
    interactionCanonicalIdentityFeatureIndices: interaction.canonicalIdentityFeatureIndices.length,
    interactionIntervalFeatureIndices: interaction.intervalFeatureIndices.length,
    interactionIntervalSubtreeMaxEnds: interaction.intervalFeatureIndices.length,
    interactionFeaturePrimitiveOffsets: interaction.featurePrimitiveOffsets.length,
    interactionFeaturePrimitiveIndices: interaction.featurePrimitiveIndices.length,
    interactionStrings: interaction.stringBytes.byteLength,
  };
}

function buildSectionLayout(counts: Record<SectionKeyV4, number>): {
  sections: Record<SectionKeyV4, BinarySectionV4>;
  byteLength: number;
} {
  const sections = {} as Record<SectionKeyV4, BinarySectionV4>;
  let cursor = 0;
  for (const definition of SECTION_DEFINITIONS) {
    cursor = align(cursor, definition.alignmentBytes);
    const count = counts[definition.key];
    const byteLength = checkedMultiply(count, definition.recordBytes, definition.key);
    sections[definition.key] = {
      byteOffset: cursor,
      byteLength,
      count,
      recordBytes: definition.recordBytes,
      alignmentBytes: definition.alignmentBytes,
    };
    cursor = checkedAdd(cursor, byteLength, definition.key);
  }
  return { sections, byteLength: cursor };
}

function fillDirectModePayload(
  scene: GpuReadyPartitionedTranscriptScene,
  trackLanesByFeature: Uint32Array,
  census: DirectModeCensusV4,
  targetGlyphs: Float32Array,
  targetFeatureIndices: Uint32Array,
  targetLanePrefixes: Uint32Array,
  sourceToExpandedBankRecord?: Uint32Array,
  expandedBankRecordsBySource?: Uint32Array,
  canonicalExpandedBankRecords?: Uint32Array,
  sourceRoles?: Uint8Array,
  targetRoles?: Uint8Array
): void {
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  if (
    targetGlyphs.length !== census.instanceCount * stride ||
    targetFeatureIndices.length !== census.instanceCount ||
    targetLanePrefixes.length !== census.lanePrefixCount ||
    (canonicalExpandedBankRecords && canonicalExpandedBankRecords.length !== census.instanceCount)
  ) {
    throw new Error(`partitioned transcript scene v4 ${census.mode} payload shape mismatch`);
  }
  const sourceGlyphs = scene.packedInstanceData;
  for (const partition of census.partitions) {
    const prefix = targetLanePrefixes.subarray(
      partition.lanePrefixOffset,
      partition.lanePrefixOffset + partition.maxTrackLane + 2
    );
    const writeCursors = new Uint32Array(partition.laneCounts.length);
    let running = 0;
    prefix[0] = 0;
    for (let lane = 0; lane < partition.laneCounts.length; lane++) {
      writeCursors[lane] = partition.firstInstance + running;
      running += partition.laneCounts[lane];
      prefix[lane + 1] = running;
    }
    if (running !== partition.instanceCount) {
      throw new Error('partitioned transcript scene v4 direct census changed during fill');
    }
    const sourceEnd = partition.source.firstInstance + partition.source.instanceCount;
    for (let sourceIndex = partition.source.firstInstance; sourceIndex < sourceEnd; sourceIndex++) {
      const featureIndex = scene.featureIndices[sourceIndex];
      const lane = trackLanesByFeature[featureIndex];
      if (lane === ANNOTATION_POLICY_ABSENT_LANE) continue;
      const targetIndex = writeCursors[lane]++;
      const sourceBase = sourceIndex * stride;
      const targetBase = targetIndex * stride;
      for (let float = 0; float < stride; float++) {
        targetGlyphs[targetBase + float] = sourceGlyphs[sourceBase + float];
      }
      targetGlyphs[targetBase + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter] =
        annotationPolicyLaneCenterOffsetPxV1(lane);
      targetFeatureIndices[targetIndex] = featureIndex;
      if (targetRoles && sourceRoles) targetRoles[targetIndex] = sourceRoles[sourceIndex];
      if (sourceToExpandedBankRecord) sourceToExpandedBankRecord[sourceIndex] = targetIndex;
      if (canonicalExpandedBankRecords) {
        if (!expandedBankRecordsBySource) {
          throw new Error('partitioned transcript scene v4 canonical mapping source is absent');
        }
        canonicalExpandedBankRecords[targetIndex] = expandedBankRecordsBySource[sourceIndex];
      }
    }
  }
}

function fillDirectFineIndexPayload(
  glyphs: Float32Array,
  instanceCount: number,
  assemblyLengthBp: number,
  tileOffsets: Uint32Array,
  bankRecordIndices: Uint32Array,
  sourceTilePrimitiveCounts?: Uint32Array
): void {
  const tileCount = Math.ceil(assemblyLengthBp / FINE_TRANSCRIPT_VIEW_SPAN_BP);
  if (
    tileOffsets.length !== tileCount + 1 ||
    bankRecordIndices.length !== instanceCount ||
    (sourceTilePrimitiveCounts && sourceTilePrimitiveCounts.length !== tileCount)
  ) {
    throw new Error('partitioned transcript scene v4 direct fine payload shape mismatch');
  }
  const counts = new Uint32Array(tileCount);
  const tiles = new Uint32Array(instanceCount);
  for (let bankIndex = 0; bankIndex < instanceCount; bankIndex++) {
    const tileIndex = fineTileForGlyph(glyphs, bankIndex, tileCount);
    tiles[bankIndex] = tileIndex;
    counts[tileIndex]++;
  }
  let cursor = 0;
  for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
    tileOffsets[tileIndex] = cursor;
    cursor += counts[tileIndex];
  }
  tileOffsets[tileCount] = cursor;
  if (cursor !== instanceCount) {
    throw new Error('partitioned transcript scene v4 direct fine census mismatch');
  }
  const writeCursors = tileOffsets.slice(0, tileCount);
  for (let bankIndex = 0; bankIndex < instanceCount; bankIndex++) {
    bankRecordIndices[writeCursors[tiles[bankIndex]]++] = bankIndex;
  }
  const lanes = new Float64Array(instanceCount).fill(Number.NaN);
  const laneOf = (bankIndex: number): number => {
    let lane = lanes[bankIndex];
    if (Number.isNaN(lane)) {
      lane = glyphTrackLane(glyphs, bankIndex);
      lanes[bankIndex] = lane;
    }
    return lane;
  };
  for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
    if (tileOffsets[tileIndex + 1] - tileOffsets[tileIndex] < 2) continue;
    bankRecordIndices
      .subarray(tileOffsets[tileIndex], tileOffsets[tileIndex + 1])
      .sort((left, right) => laneOf(left) - laneOf(right) || left - right);
  }
  sourceTilePrimitiveCounts?.set(counts);
}

function fineTileForGlyph(glyphs: Float32Array, bankIndex: number, tileCount: number): number {
  const base = bankIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const start = unpackBpCoordinate(
    glyphs[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
    glyphs[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta]
  );
  const tile = Math.floor(start / FINE_TRANSCRIPT_VIEW_SPAN_BP);
  if (tile < 0 || tile >= tileCount) {
    throw new Error('partitioned transcript scene v4 direct fine glyph lies outside assembly');
  }
  return tile;
}

function glyphTrackLane(glyphs: Float32Array, bankIndex: number): number {
  const base = bankIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const offset = glyphs[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter];
  const lane = (-7 - offset) / 16;
  if (!Number.isSafeInteger(lane) || lane < 0) {
    throw new Error('partitioned transcript scene v4 glyph track lane is invalid');
  }
  return lane;
}

function fillInteractionPayload(
  payload: Uint8Array,
  sections: Record<SectionKeyV4, BinarySectionV4>,
  interaction: PrepackedAnnotationInteractionIndexV2,
  sourceToExpandedBankRecord: Uint32Array
): void {
  payload.set(interaction.featureRecordBytes, sections.interactionFeatureRecords.byteOffset);
  payload.set(
    bytesOf(interaction.rendererIdFeatureIndices),
    sections.interactionRendererIdFeatureIndices.byteOffset
  );
  payload.set(
    bytesOf(interaction.canonicalIdentityFeatureIndices),
    sections.interactionCanonicalIdentityFeatureIndices.byteOffset
  );
  payload.set(
    bytesOf(interaction.intervalFeatureIndices),
    sections.interactionIntervalFeatureIndices.byteOffset
  );
  payload.set(
    interaction.intervalSubtreeMaxEndBytes,
    sections.interactionIntervalSubtreeMaxEnds.byteOffset
  );
  payload.set(
    bytesOf(interaction.featurePrimitiveOffsets),
    sections.interactionFeaturePrimitiveOffsets.byteOffset
  );
  payload.set(interaction.stringBytes, sections.interactionStrings.byteOffset);
  const target = u32View(payload, sections.interactionFeaturePrimitiveIndices);
  for (let cursor = 0; cursor < target.length; cursor++) {
    const sourceIndex = interaction.featurePrimitiveIndices[cursor];
    if (sourceIndex >= sourceToExpandedBankRecord.length) {
      throw new Error('partitioned transcript scene v4 interaction source ordinal is invalid');
    }
    target[cursor] = sourceToExpandedBankRecord[sourceIndex];
  }
}

function validateUint32Input(input: ArrayLike<number>, count: number, label: string): void {
  if (input.length !== count) {
    throw new Error(`partitioned transcript scene v4 ${label} count mismatch`);
  }
  for (let index = 0; index < count; index++) {
    const value = input[index];
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(`partitioned transcript scene v4 ${label} is invalid`);
    }
  }
}

function copyUint32Input(input: ArrayLike<number>, target: Uint32Array): void {
  for (let index = 0; index < target.length; index++) target[index] = input[index];
}

export async function validatePartitionedTranscriptSceneBinaryV4(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array,
  payloadSha256: PartitionedTranscriptSceneBinarySha256V4 = sha256Hex
): Promise<PartitionedTranscriptSceneBinaryValidationWorkV4> {
  validateManifestStructure(manifest, payload);
  if ((await payloadSha256(payload)) !== manifest.integrity.payloadSha256) {
    throw new Error('partitioned transcript scene v4 payload sha256 mismatch');
  }
  if ((await hashContract(manifest)) !== manifest.integrity.contractSha256) {
    throw new Error('partitioned transcript scene v4 contract sha256 mismatch');
  }
  const decoded = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
    manifest,
    payload,
    TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
  );
  validatePrepackedAnnotationInteractionIndexV2(decoded.interactionIndex);
  const couplingWork = validateSemanticCoupling(
    manifest,
    decoded,
    u32View(payload, manifest.sections.canonicalExpandedBankRecordIndices)
  );
  return {
    interactionIndexValidationCount: 1,
    interactionFeatureScanCardinality: couplingWork.featureScanCardinality,
    couplingPrimitiveScanCardinality: couplingWork.primitiveScanCardinality,
    directFineIndexValidationCount: 2,
    directFineIndexRecordScanCardinality:
      decoded.submissionFineIndices.expanded.bankRecordIndices.length +
      decoded.submissionFineIndices.canonical.bankRecordIndices.length,
  };
}

export async function unpackPartitionedTranscriptSceneBinaryV4(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array
): Promise<UnpackedPartitionedTranscriptSceneBinaryV4> {
  await validatePartitionedTranscriptSceneBinaryV4(manifest, payload);
  const { trustedMainDecodeWork: _work, ...decoded } =
    unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
      manifest,
      payload,
      TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
    );
  return decoded;
}

export function unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array,
  marker: typeof TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
): TrustedMainUnpackedPartitionedTranscriptSceneBinaryV4 {
  if (marker !== TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4) {
    throw new Error('partitioned transcript scene v4 trusted-main marker is invalid');
  }
  validateManifestStructure(manifest, payload);
  const sourceCounts = u32View(payload, manifest.sections.sourceFineTilePrimitiveCounts);
  const expanded = modeBankView(manifest, payload, 'expanded');
  const canonical = modeBankView(manifest, payload, 'canonical');
  const submissionBank: AnnotationPolicyDirectSubmissionBankV1 = {
    schema: ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1,
    sourcePrimitiveCount: manifest.sourcePrimitiveCount,
    sourcePartitionSpanBp: manifest.partitionSpanBp,
    expanded,
    canonical,
  };
  const expandedFine = fineIndexView(manifest, payload, 'expanded', sourceCounts);
  const canonicalFine = fineIndexView(manifest, payload, 'canonical', sourceCounts);
  freezeModeBankContainer(expanded);
  freezeModeBankContainer(canonical);
  Object.freeze(submissionBank);
  Object.freeze(expandedFine);
  Object.freeze(canonicalFine);
  const submissionFineIndices = Object.freeze({
    expanded: expandedFine,
    canonical: canonicalFine,
  });
  const families = freezeSmallContainerGraph(structuredClone(manifest.families));
  const interactionIndex = Object.freeze(interactionView(manifest, payload));
  const policyProjection = policyProjectionView(manifest, payload);
  policyProjection.annotationTypes = Object.freeze([
    ...policyProjection.annotationTypes,
  ]) as string[];
  policyProjection.expandedBandTypeIndices = Object.freeze([
    ...policyProjection.expandedBandTypeIndices,
  ]) as number[];
  policyProjection.canonicalBandTypeIndices = Object.freeze([
    ...policyProjection.canonicalBandTypeIndices,
  ]) as number[];
  Object.freeze(policyProjection);
  const scene = {
    sourceAnnotationIdentity: Object.freeze({
      payloadSha256: manifest.integrity.payloadSha256,
      contractSha256: manifest.integrity.contractSha256,
    }),
    ...(manifest.sourceAnnotationAliases
      ? {
          sourceAnnotationAliases: freezeSmallContainerGraph(
            structuredClone(manifest.sourceAnnotationAliases)
          ),
        }
      : {}),
    partitionSpanBp: manifest.partitionSpanBp,
    maxPrimitiveSpanBp: manifest.maxPrimitiveSpanBp,
    packedInstanceData: expanded.packedInstanceData,
    featureIndices: expanded.featureIndices,
    partitions: expanded.partitions.map((partition) =>
      Object.freeze(stripDirectPartition(partition))
    ),
  };
  Object.freeze(scene.partitions);
  Object.freeze(scene);
  const decoded: UnpackedPartitionedTranscriptSceneBinaryV4 = {
    scene,
    families,
    featureFamilyIndices: u32View(payload, manifest.sections.featureFamilyIndices),
    interactionIndex,
    policyProjection,
    submissionBank,
    submissionFineIndices,
  };
  const rendererAdmissionProvenance = Object.freeze({
    datasetId: manifest.datasetContract.datasetId,
    datasetVersion: manifest.datasetContract.datasetVersion,
    sourceSha256: manifest.datasetContract.sourceSha256,
    assemblyId: manifest.assemblyContract.assemblyId,
    assemblyLengthBp: manifest.assemblyContract.assemblyLengthBp,
    payloadSha256: manifest.integrity.payloadSha256,
    contractSha256: manifest.integrity.contractSha256,
    byteLength: manifest.byteLength,
  });
  const rendererAdmissionCapability = mintTrustedRendererAdmissionV4({
    provenance: rendererAdmissionProvenance,
    loadIdentity: null,
    ...decoded,
  });
  return {
    ...decoded,
    rendererAdmissionCapability,
    rendererAdmissionProvenance,
    trustedMainDecodeWork: {
      payloadBytesCopied: 0,
      hashOperations: 0,
      visualSemanticPrimitiveScans: 0,
      interactionSemanticFeatureScans: 0,
      couplingPrimitiveScans: 0,
      policyProjectionScans: 0,
    },
  };
}

export function isTrustedPartitionedTranscriptRendererAdmissionV4(
  capability: unknown,
  binding: TrustedPartitionedTranscriptRendererAdmissionBindingV4
): capability is TrustedPartitionedTranscriptRendererAdmissionV4 {
  if ((typeof capability !== 'object' && typeof capability !== 'function') || capability === null) {
    return false;
  }
  const trusted = trustedRendererAdmissionBindingsV4.get(capability);
  return (
    trusted?.provenance === binding.provenance &&
    trusted.loadIdentity === binding.loadIdentity &&
    trusted.scene === binding.scene &&
    trusted.families === binding.families &&
    trusted.featureFamilyIndices === binding.featureFamilyIndices &&
    trusted.interactionIndex === binding.interactionIndex &&
    trusted.policyProjection === binding.policyProjection &&
    trusted.submissionBank === binding.submissionBank &&
    trusted.submissionFineIndices === binding.submissionFineIndices
  );
}

export function scopeTrustedPartitionedTranscriptRendererAdmissionV4(
  capability: TrustedPartitionedTranscriptRendererAdmissionV4,
  binding: Omit<TrustedPartitionedTranscriptRendererAdmissionBindingV4, 'loadIdentity'>,
  loadIdentity: TrustedPartitionedTranscriptRendererLoadIdentityV4
): {
  capability: TrustedPartitionedTranscriptRendererAdmissionV4;
  loadIdentity: TrustedPartitionedTranscriptRendererLoadIdentityV4;
} {
  const trusted = trustedRendererAdmissionBindingsV4.get(capability);
  if (
    trusted?.loadIdentity !== null ||
    trusted.provenance !== binding.provenance ||
    trusted.scene !== binding.scene ||
    trusted.families !== binding.families ||
    trusted.featureFamilyIndices !== binding.featureFamilyIndices ||
    trusted.interactionIndex !== binding.interactionIndex ||
    trusted.policyProjection !== binding.policyProjection ||
    trusted.submissionBank !== binding.submissionBank ||
    trusted.submissionFineIndices !== binding.submissionFineIndices
  ) {
    throw new Error('partitioned transcript trusted-v4 scope capability mismatch');
  }
  const frozenLoadIdentity = Object.freeze({ ...loadIdentity });
  if (
    frozenLoadIdentity.genomeLengthBp !== binding.provenance.assemblyLengthBp ||
    frozenLoadIdentity.sceneContractSha256 !== binding.provenance.contractSha256 ||
    frozenLoadIdentity.ownerKey.length === 0 ||
    frozenLoadIdentity.genomeIdentity.length === 0 ||
    frozenLoadIdentity.artifactKey.length === 0
  ) {
    throw new Error('partitioned transcript trusted-v4 load identity is invalid');
  }
  return {
    capability: mintTrustedRendererAdmissionV4({
      ...binding,
      loadIdentity: frozenLoadIdentity,
    }),
    loadIdentity: frozenLoadIdentity,
  };
}

function mintTrustedRendererAdmissionV4(
  binding: Omit<TrustedPartitionedTranscriptRendererAdmissionBindingV4, 'loadIdentity'> & {
    readonly loadIdentity: TrustedPartitionedTranscriptRendererLoadIdentityV4 | null;
  }
): TrustedPartitionedTranscriptRendererAdmissionV4 {
  const capability = Object.freeze(
    Object.create(null)
  ) as TrustedPartitionedTranscriptRendererAdmissionV4;
  trustedRendererAdmissionBindingsV4.set(capability, binding);
  return capability;
}

function freezeModeBankContainer(bank: AnnotationPolicyDirectSubmissionModeBankV1): void {
  for (const partition of bank.partitions) Object.freeze(partition);
  Object.freeze(bank.partitions);
  Object.freeze(bank);
}

function freezeSmallContainerGraph<T>(value: T): T {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value)) freezeSmallContainerGraph(nested);
  return Object.freeze(value);
}

function validatePackContracts(input: PackGpuReadyPartitionedTranscriptSceneBinaryV4Input): void {
  if (
    !input.datasetContract?.datasetId ||
    !input.datasetContract.datasetVersion ||
    !SHA256_HEX.test(input.datasetContract.sourceSha256) ||
    !input.assemblyContract?.assemblyId ||
    !Number.isSafeInteger(input.assemblyContract.assemblyLengthBp) ||
    input.assemblyContract.assemblyLengthBp <= 0 ||
    !Number.isSafeInteger(input.scene.partitionSpanBp) ||
    input.scene.partitionSpanBp <= 0 ||
    input.scene.featureIndices.length > 0xffff_ffff
  ) {
    throw new Error('partitioned transcript scene v4 pack contract is invalid');
  }
}

function isValidV4ManifestHeader(manifest: PartitionedTranscriptSceneBinaryManifestV4): boolean {
  const direct = manifest?.directContract;
  return !(
    manifest?.schema !== PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4 ||
    !nonemptyContractString(manifest.datasetContract?.datasetId) ||
    !nonemptyContractString(manifest.datasetContract?.datasetVersion) ||
    !SHA256_HEX.test(manifest.datasetContract?.sourceSha256 ?? '') ||
    !nonemptyContractString(manifest.assemblyContract?.assemblyId) ||
    !Number.isSafeInteger(manifest.assemblyContract?.assemblyLengthBp) ||
    manifest.assemblyContract.assemblyLengthBp <= 0 ||
    !Number.isSafeInteger(manifest.partitionSpanBp) ||
    manifest.partitionSpanBp <= 0 ||
    !Number.isSafeInteger(manifest.maxPrimitiveSpanBp) ||
    manifest.maxPrimitiveSpanBp < 0 ||
    manifest.maxPrimitiveSpanBp > manifest.assemblyContract.assemblyLengthBp ||
    !validFamilies(manifest.families) ||
    direct?.schema !== ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1 ||
    direct.glyphRecordBytes !== TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes ||
    direct.fineIndexSchema !== ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1 ||
    direct.fineTileSpanBp !== FINE_TRANSCRIPT_VIEW_SPAN_BP ||
    direct.fineTileCount !==
      Math.ceil(manifest.assemblyContract?.assemblyLengthBp / FINE_TRANSCRIPT_VIEW_SPAN_BP) ||
    manifest.policyContract?.schema !== ANNOTATION_POLICY_PROJECTION_V1 ||
    manifest.policyContract.featureRecordBytes !== ANNOTATION_POLICY_FEATURE_RECORD_BYTES ||
    manifest.policyContract.absentLaneSentinel !== ANNOTATION_POLICY_ABSENT_LANE ||
    !validPolicyTypeContract(manifest.policyContract) ||
    manifest.interactionContract?.schema !== PREPACKED_ANNOTATION_INTERACTION_INDEX_V2 ||
    manifest.interactionContract.featureRecordBytes !==
      PREPACKED_ANNOTATION_INTERACTION_FEATURE_RECORD_BYTES ||
    !Number.isSafeInteger(manifest.featureCount) ||
    manifest.featureCount < 0 ||
    !Number.isSafeInteger(manifest.sourcePrimitiveCount) ||
    manifest.sourcePrimitiveCount < 0 ||
    direct.expanded?.instanceCount !== manifest.sourcePrimitiveCount ||
    manifest.integrity?.algorithm !== 'sha256' ||
    !SHA256_HEX.test(manifest.integrity.payloadSha256) ||
    !SHA256_HEX.test(manifest.integrity.contractSha256)
  );
}

function isValidV4SectionCounts(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array,
  cursor: number
): boolean {
  const direct = manifest.directContract;
  const s = manifest.sections;
  return !(
    cursor !== manifest.byteLength ||
    payload.byteLength !== manifest.byteLength ||
    s.expandedGlyphs.count !== direct.expanded.instanceCount ||
    s.expandedFeatureIndices.count !== direct.expanded.instanceCount ||
    s.expandedFineBankRecordIndices.count !== direct.expanded.instanceCount ||
    s.canonicalGlyphs.count !== direct.canonical.instanceCount ||
    s.canonicalFeatureIndices.count !== direct.canonical.instanceCount ||
    s.canonicalExpandedBankRecordIndices.count !== direct.canonical.instanceCount ||
    s.canonicalFineBankRecordIndices.count !== direct.canonical.instanceCount ||
    s.expandedFineTileOffsets.count !== direct.fineTileCount + 1 ||
    s.canonicalFineTileOffsets.count !== direct.fineTileCount + 1 ||
    s.sourceFineTilePrimitiveCounts.count !== direct.fineTileCount ||
    s.featureFamilyIndices.count !== manifest.featureCount ||
    s.policyFeatureRecords.count !== manifest.featureCount ||
    s.interactionFeatureRecords.count !== manifest.featureCount ||
    s.interactionRendererIdFeatureIndices.count !== manifest.featureCount ||
    s.interactionCanonicalIdentityFeatureIndices.count !== manifest.featureCount ||
    s.interactionFeaturePrimitiveOffsets.count !== manifest.featureCount + 1 ||
    s.interactionFeaturePrimitiveIndices.count !== manifest.sourcePrimitiveCount
  );
}

function validateManifestStructure(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array
): void {
  if (!isValidV4ManifestHeader(manifest)) {
    throw new Error('partitioned transcript scene v4 manifest contract is invalid');
  }
  let cursor = 0;
  for (const definition of SECTION_DEFINITIONS) {
    cursor = align(cursor, definition.alignmentBytes);
    const section = manifest.sections?.[definition.key];
    if (
      !section ||
      section.byteOffset !== cursor ||
      section.alignmentBytes !== definition.alignmentBytes ||
      section.recordBytes !== definition.recordBytes ||
      !Number.isSafeInteger(section.count) ||
      section.count < 0 ||
      section.byteLength !== checkedMultiply(section.count, section.recordBytes, definition.key)
    ) {
      throw new Error('partitioned transcript scene v4 sections are not exact and aligned');
    }
    assertZeroPadding(payload, cursorFromPrior(manifest, definition.key), section.byteOffset);
    cursor = section.byteOffset + section.byteLength;
  }
  if (!isValidV4SectionCounts(manifest, payload, cursor)) {
    throw new Error('partitioned transcript scene v4 section counts are inconsistent');
  }
  validateModeContract(manifest, 'expanded');
  validateModeContract(manifest, 'canonical');
  for (const definition of SECTION_DEFINITIONS) {
    if (
      (payload.byteOffset + manifest.sections[definition.key].byteOffset) %
        definition.alignmentBytes !==
      0
    ) {
      throw new Error('partitioned transcript scene v4 typed-array alignment is invalid');
    }
  }
}

function validateModeContract(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  mode: 'expanded' | 'canonical'
): void {
  const contract = manifest.directContract[mode];
  const prefixCount = manifest.sections[`${mode}LanePrefixes`].count;
  let instanceCursor = 0;
  let prefixCursor = 0;
  let previousPartition = -1;
  for (const partition of contract.partitions) {
    if (
      partition.partitionIndex <= previousPartition ||
      partition.key !== `bp-partition-${partition.partitionIndex}` ||
      partition.startBp !== partition.partitionIndex * manifest.partitionSpanBp ||
      partition.endBpExclusive !== partition.startBp + manifest.partitionSpanBp ||
      partition.firstInstance !== instanceCursor ||
      partition.lanePrefixOffset !== prefixCursor ||
      partition.lanePrefixCount <= 0 ||
      partition.sourceInstanceCount < partition.instanceCount ||
      partition.hiddenByIsoformMembershipInstanceCount !==
        partition.sourceInstanceCount - partition.instanceCount
    ) {
      throw new Error(`partitioned transcript scene v4 ${mode} partition contract is invalid`);
    }
    previousPartition = partition.partitionIndex;
    instanceCursor += partition.instanceCount;
    prefixCursor += partition.lanePrefixCount;
  }
  if (instanceCursor !== contract.instanceCount || prefixCursor !== prefixCount) {
    throw new Error(`partitioned transcript scene v4 ${mode} partition coverage is invalid`);
  }
}

function validateSemanticCoupling(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  decoded: UnpackedPartitionedTranscriptSceneBinaryV4,
  canonicalExpandedBankRecordIndices: Uint32Array
): PrepackedAnnotationInteractionVisualCouplingValidationWorkV2 {
  assertAnnotationPolicyDirectSubmissionBankV1(decoded.scene, decoded.submissionBank);
  assertAnnotationPolicyDirectFineIndexV1(
    decoded.submissionBank.expanded,
    decoded.submissionFineIndices.expanded
  );
  assertAnnotationPolicyDirectFineIndexV1(
    decoded.submissionBank.canonical,
    decoded.submissionFineIndices.canonical
  );
  for (
    let tileIndex = 0;
    tileIndex < decoded.submissionFineIndices.expanded.tileCount;
    tileIndex++
  ) {
    const expandedCount =
      decoded.submissionFineIndices.expanded.tileOffsets[tileIndex + 1] -
      decoded.submissionFineIndices.expanded.tileOffsets[tileIndex];
    if (
      decoded.submissionFineIndices.expanded.sourceTilePrimitiveCounts[tileIndex] !== expandedCount
    ) {
      throw new Error('partitioned transcript scene v4 source fine tile count is not exact');
    }
  }
  validateAnnotationPolicyProjectionTableV1(decoded.policyProjection);
  const policyTrackLanes = buildPolicyTrackLaneTables(decoded.policyProjection);
  if (decoded.featureFamilyIndices.length !== manifest.featureCount) {
    throw new Error('partitioned transcript scene v4 feature-family count mismatch');
  }
  for (const familyIndex of decoded.featureFamilyIndices) {
    if (familyIndex >= manifest.families.length) {
      throw new Error('partitioned transcript scene v4 feature-family index is invalid');
    }
  }
  validateExpandedModeSemantic(
    manifest,
    decoded.submissionBank.expanded,
    policyTrackLanes.expanded
  );
  const canonicalSeen = validateCanonicalModeSemantic(
    manifest,
    decoded.submissionBank.expanded,
    decoded.submissionBank.canonical,
    policyTrackLanes.canonical,
    canonicalExpandedBankRecordIndices
  );
  for (let expandedIndex = 0; expandedIndex < manifest.sourcePrimitiveCount; expandedIndex++) {
    const expectedCanonical =
      policyTrackLanes.canonical[decoded.submissionBank.expanded.featureIndices[expandedIndex]] !==
      ANNOTATION_POLICY_ABSENT_LANE;
    if ((canonicalSeen[expandedIndex] !== 0) !== expectedCanonical) {
      throw new Error('partitioned transcript scene v4 canonical membership is not exact');
    }
  }
  const couplingWork = validatePrepackedAnnotationInteractionVisualCouplingAfterValidatedIndexV2(
    decoded.interactionIndex,
    decoded.scene,
    manifest.assemblyContract.assemblyLengthBp
  );
  const index = decoded.interactionIndex;
  for (let featureIndex = 0; featureIndex < index.featureCount; featureIndex++) {
    const feature = decodePrepackedAnnotationInteractionFeatureV2(index, featureIndex);
    const policy = decodeAnnotationPolicyProjectionFeatureV1(
      decoded.policyProjection,
      featureIndex
    );
    if (feature.lane !== policy.expandedLane) {
      throw new Error('partitioned transcript scene v4 interaction/policy lane mismatch');
    }
    if (feature.endBp > manifest.assemblyContract.assemblyLengthBp) {
      throw new Error('partitioned transcript scene v4 interaction exceeds assembly');
    }
  }
  return couplingWork;
}

function validateExpandedModeSemantic(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  modeBank: AnnotationPolicyDirectSubmissionModeBankV1,
  expandedTrackLanes: Uint32Array
): void {
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  for (let bankIndex = 0; bankIndex < modeBank.featureIndices.length; bankIndex++) {
    const featureIndex = modeBank.featureIndices[bankIndex];
    if (featureIndex >= manifest.featureCount) {
      throw new Error('partitioned transcript scene v4 expanded visual owner is invalid');
    }
    const trackLane = expandedTrackLanes[featureIndex];
    const base = bankIndex * stride;
    if (
      modeBank.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter] !==
      Math.fround(annotationPolicyLaneCenterOffsetPxV1(trackLane))
    ) {
      throw new Error('partitioned transcript scene v4 expanded glyph lane is invalid');
    }
    const start = unpackBpCoordinate(
      modeBank.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
      modeBank.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta]
    );
    const end = unpackBpCoordinate(
      modeBank.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk],
      modeBank.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta]
    );
    if (start < 0 || end <= start || end > manifest.assemblyContract.assemblyLengthBp) {
      throw new Error('partitioned transcript scene v4 glyph coordinates are invalid');
    }
  }
}

function validateCanonicalModeSemantic(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  expanded: AnnotationPolicyDirectSubmissionModeBankV1,
  canonical: AnnotationPolicyDirectSubmissionModeBankV1,
  canonicalTrackLanes: Uint32Array,
  canonicalExpandedBankRecordIndices: Uint32Array
): Uint8Array {
  if (canonicalExpandedBankRecordIndices.length !== canonical.featureIndices.length) {
    throw new Error('partitioned transcript scene v4 canonical mapping count mismatch');
  }
  const seen = new Uint8Array(expanded.featureIndices.length);
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const expandedBits = new Uint32Array(
    expanded.packedInstanceData.buffer,
    expanded.packedInstanceData.byteOffset,
    expanded.packedInstanceData.length
  );
  const canonicalBits = new Uint32Array(
    canonical.packedInstanceData.buffer,
    canonical.packedInstanceData.byteOffset,
    canonical.packedInstanceData.length
  );
  for (let canonicalIndex = 0; canonicalIndex < canonical.featureIndices.length; canonicalIndex++) {
    const expandedIndex = canonicalExpandedBankRecordIndices[canonicalIndex];
    if (expandedIndex >= seen.length || seen[expandedIndex]) {
      throw new Error('partitioned transcript scene v4 canonical mapping identity is invalid');
    }
    seen[expandedIndex] = 1;
    const featureIndex = canonical.featureIndices[canonicalIndex];
    if (
      featureIndex >= manifest.featureCount ||
      expanded.featureIndices[expandedIndex] !== featureIndex
    ) {
      throw new Error('partitioned transcript scene v4 canonical visual owner mismatch');
    }
    const canonicalTrackLane = canonicalTrackLanes[featureIndex];
    if (canonicalTrackLane === ANNOTATION_POLICY_ABSENT_LANE) {
      throw new Error('partitioned transcript scene v4 canonical membership is invalid');
    }
    const expandedBase = expandedIndex * stride;
    const canonicalBase = canonicalIndex * stride;
    for (let field = 0; field < stride; field++) {
      if (field === TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter) continue;
      if (expandedBits[expandedBase + field] !== canonicalBits[canonicalBase + field]) {
        throw new Error('partitioned transcript scene v4 canonical glyph identity is invalid');
      }
    }
    if (
      canonical.packedInstanceData[
        canonicalBase + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter
      ] !== Math.fround(annotationPolicyLaneCenterOffsetPxV1(canonicalTrackLane))
    ) {
      throw new Error('partitioned transcript scene v4 canonical glyph lane is invalid');
    }
  }
  return seen;
}

function modeContractFromCensus(census: DirectModeCensusV4): DirectModeContractV4 {
  return {
    mode: census.mode,
    instanceCount: census.instanceCount,
    maxTrackLane: census.maxTrackLane,
    partitions: census.partitions.map((partition) => {
      return {
        ...partition.source,
        firstInstance: partition.firstInstance,
        instanceCount: partition.instanceCount,
        sourceInstanceCount: partition.source.instanceCount,
        hiddenByIsoformMembershipInstanceCount:
          partition.source.instanceCount - partition.instanceCount,
        lanePrefixOffset: partition.lanePrefixOffset,
        lanePrefixCount: partition.maxTrackLane + 2,
      };
    }),
  };
}

function modeBankView(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array,
  mode: 'expanded' | 'canonical'
): AnnotationPolicyDirectSubmissionModeBankV1 {
  const contract = manifest.directContract[mode];
  const prefixes = u32View(payload, manifest.sections[`${mode}LanePrefixes`]);
  return {
    mode,
    packedInstanceData: f32View(payload, manifest.sections[`${mode}Glyphs`]),
    featureIndices: u32View(payload, manifest.sections[`${mode}FeatureIndices`]),
    partitions: contract.partitions.map((partition) => ({
      key: partition.key,
      partitionIndex: partition.partitionIndex,
      startBp: partition.startBp,
      endBpExclusive: partition.endBpExclusive,
      firstInstance: partition.firstInstance,
      instanceCount: partition.instanceCount,
      minStartBp: partition.minStartBp,
      maxEndBp: partition.maxEndBp,
      sourceInstanceCount: partition.sourceInstanceCount,
      hiddenByIsoformMembershipInstanceCount: partition.hiddenByIsoformMembershipInstanceCount,
      lanePrefixEnds: prefixes.subarray(
        partition.lanePrefixOffset,
        partition.lanePrefixOffset + partition.lanePrefixCount
      ),
    })),
    maxTrackLane: contract.maxTrackLane,
  };
}

function fineIndexView(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array,
  mode: 'expanded' | 'canonical',
  sourceCounts: Uint32Array
): AnnotationPolicyDirectFineIndexV1 {
  return {
    schema: ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1,
    tileSpanBp: FINE_TRANSCRIPT_VIEW_SPAN_BP,
    tileCount: manifest.directContract.fineTileCount,
    tileOffsets: u32View(payload, manifest.sections[`${mode}FineTileOffsets`]),
    bankRecordIndices: u32View(payload, manifest.sections[`${mode}FineBankRecordIndices`]),
    sourceTilePrimitiveCounts: sourceCounts,
  };
}

function interactionView(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array
): PrepackedAnnotationInteractionIndexV2 {
  const s = manifest.sections;
  return {
    schema: PREPACKED_ANNOTATION_INTERACTION_INDEX_V2,
    featureCount: manifest.featureCount,
    primitiveCount: manifest.sourcePrimitiveCount,
    featureRecordBytes: sectionBytes(payload, s.interactionFeatureRecords),
    rendererIdFeatureIndices: u32View(payload, s.interactionRendererIdFeatureIndices),
    canonicalIdentityFeatureIndices: u32View(payload, s.interactionCanonicalIdentityFeatureIndices),
    intervalFeatureIndices: u32View(payload, s.interactionIntervalFeatureIndices),
    intervalSubtreeMaxEndBytes: sectionBytes(payload, s.interactionIntervalSubtreeMaxEnds),
    featurePrimitiveOffsets: u32View(payload, s.interactionFeaturePrimitiveOffsets),
    featurePrimitiveIndices: u32View(payload, s.interactionFeaturePrimitiveIndices),
    stringBytes: sectionBytes(payload, s.interactionStrings),
  };
}

function policyProjectionView(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  payload: Uint8Array
): AnnotationPolicyProjectionTableV1 {
  return {
    schema: ANNOTATION_POLICY_PROJECTION_V1,
    featureCount: manifest.featureCount,
    annotationTypes: manifest.policyContract.annotationTypes,
    expandedBandTypeIndices: manifest.policyContract.expandedBandTypeIndices,
    canonicalBandTypeIndices: manifest.policyContract.canonicalBandTypeIndices,
    featureRecordBytes: sectionBytes(payload, manifest.sections.policyFeatureRecords),
  };
}

function stripDirectPartition(
  partition: AnnotationPolicyDirectSubmissionPartitionV1
): TranscriptInstancePartition {
  const {
    sourceInstanceCount: _source,
    hiddenByIsoformMembershipInstanceCount: _hidden,
    lanePrefixEnds: _prefix,
    ...base
  } = partition;
  return base;
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function sectionBytes(payload: Uint8Array, section: BinarySectionV4): Uint8Array {
  return new Uint8Array(
    payload.buffer,
    payload.byteOffset + section.byteOffset,
    section.byteLength
  );
}

function u32View(payload: Uint8Array, section: BinarySectionV4): Uint32Array {
  return new Uint32Array(payload.buffer, payload.byteOffset + section.byteOffset, section.count);
}

function f32View(payload: Uint8Array, section: BinarySectionV4): Float32Array {
  return new Float32Array(
    payload.buffer,
    payload.byteOffset + section.byteOffset,
    section.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

function align(value: number, alignment: number): number {
  const remainder = value % alignment;
  return remainder === 0 ? value : value + alignment - remainder;
}

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value))
    throw new Error(`partitioned transcript scene v4 ${label} offset overflow`);
  return value;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`partitioned transcript scene v4 ${label} byte length overflow`);
  }
  return value;
}

function nonemptyContractString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value);
}

function validFamilies(families: unknown): families is AnnotationShapeFamilyV1[] {
  if (!Array.isArray(families)) return false;
  const ids = new Set<string>();
  return families.every((family) => {
    if (
      !family ||
      typeof family !== 'object' ||
      !nonemptyContractString((family as AnnotationShapeFamilyV1).id) ||
      ids.has((family as AnnotationShapeFamilyV1).id) ||
      ((family as AnnotationShapeFamilyV1).kind !== 'transcript' &&
        (family as AnnotationShapeFamilyV1).kind !== 'source-shape') ||
      !isJsonValue((family as AnnotationShapeFamilyV1).metadata)
    ) {
      return false;
    }
    ids.add((family as AnnotationShapeFamilyV1).id);
    return true;
  });
}

function validPolicyTypeContract(
  policy: PartitionedTranscriptSceneBinaryManifestV4['policyContract']
): boolean {
  if (!Array.isArray(policy.annotationTypes) || policy.annotationTypes.length === 0) return false;
  const types = new Set<string>();
  for (const value of policy.annotationTypes) {
    if (!nonemptyContractString(value) || types.has(value)) return false;
    types.add(value);
  }
  for (const indices of [policy.expandedBandTypeIndices, policy.canonicalBandTypeIndices]) {
    if (!Array.isArray(indices) || new Set(indices).size !== indices.length) return false;
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= policy.annotationTypes.length) {
        return false;
      }
    }
  }
  return true;
}

function isJsonValue(value: unknown): value is AnnotationSceneJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

function cursorFromPrior(
  manifest: PartitionedTranscriptSceneBinaryManifestV4,
  key: SectionKeyV4
): number {
  const index = SECTION_DEFINITIONS.findIndex((definition) => definition.key === key);
  if (index <= 0) return 0;
  const prior = manifest.sections[SECTION_DEFINITIONS[index - 1].key];
  return prior.byteOffset + prior.byteLength;
}

function assertZeroPadding(payload: Uint8Array, start: number, end: number): void {
  if (start < 0 || end < start || end > payload.byteLength) {
    throw new Error('partitioned transcript scene v4 padding range is invalid');
  }
  for (let index = start; index < end; index++) {
    if (payload[index] !== 0) throw new Error('partitioned transcript scene v4 padding is nonzero');
  }
}

function contractMaterial(
  manifest: PartitionedTranscriptSceneBinaryManifestV4
): AnnotationSceneJsonValue {
  if (manifest.sourceAnnotationAliases)
    assertSourceAnnotationAliasesV1(manifest.sourceAnnotationAliases, manifest.featureCount);
  const { integrity: _integrity, ...contract } = manifest;
  return contract as unknown as AnnotationSceneJsonValue;
}

function canonicalJson(value: AnnotationSceneJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

async function hashContract(manifest: PartitionedTranscriptSceneBinaryManifestV4): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(contractMaterial(manifest))));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error('partitioned transcript scene v4 sha256 is unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    ''
  );
}
