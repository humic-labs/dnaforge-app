import { unpackBpCoordinate } from './bp-coordinate-packing';
import {
  ANNOTATION_POLICY_GPU_ABSENT_LANE,
  ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT,
  ANNOTATION_POLICY_GPU_MAX_EXACT_LANE,
  validateAnnotationPolicyGpuInstanceDataV1,
  type AnnotationPolicyGpuRuntimeV1,
} from './annotation-policy-gpu-instances-v1';
import {
  planTranscriptPartitionSubmissions,
  type GpuReadyPartitionedTranscriptScene,
  type TranscriptInstancePartition,
} from './partitioned-transcript-scene';
import {
  TRANSCRIPT_GLYPH_INSTANCE_CORNERS,
  TRANSCRIPT_GLYPH_INSTANCE_LAYOUT,
} from './transcript-glyph-instances';

export const ANNOTATION_POLICY_SUBMISSION_CENSUS_V1 =
  'annotation-policy-submission-census.v1' as const;

export const ANNOTATION_POLICY_CENSUS_LANE_LIMITS_V1 = [4, 8, 12, 16, 24, 32, 64, null] as const;

export type AnnotationPolicyCensusLaneLimitV1 =
  (typeof ANNOTATION_POLICY_CENSUS_LANE_LIMITS_V1)[number];

export interface AnnotationPolicySubmissionCensusCellV1 {
  laneLimit: AnnotationPolicyCensusLaneLimitV1;
  eligibleInstanceCount: number;
  hiddenByIsoformMembershipInstanceCount: number;
  hiddenByLaneCapInstanceCount: number;
}

export interface AnnotationPolicySubmissionCensusPartitionV1 {
  partitionIndex: number;
  firstInstance: number;
  currentFullMeshSubmittedInstanceCount: number;
  currentFullMeshSubmittedVertexCount: number;
  expanded: AnnotationPolicySubmissionCensusCellV1[];
  canonical: AnnotationPolicySubmissionCensusCellV1[];
}

export interface AnnotationPolicySubmissionCensusV1 {
  schema: typeof ANNOTATION_POLICY_SUBMISSION_CENSUS_V1;
  primitiveCount: number;
  verticesPerPrimitive: number;
  partitions: AnnotationPolicySubmissionCensusPartitionV1[];
  totals: {
    currentFullMeshSubmittedInstanceCount: number;
    currentFullMeshSubmittedVertexCount: number;
    expanded: AnnotationPolicySubmissionCensusCellV1[];
    canonical: AnnotationPolicySubmissionCensusCellV1[];
  };
}

export interface AnnotationPolicyExactSubmissionPlanV1 {
  runtime: AnnotationPolicyGpuRuntimeV1;
  viewportStartBp: number;
  viewportEndBp: number;
  selectedPartitionIndices: number[];
  currentFullMeshSubmittedPrimitiveIds: Uint32Array;
  exactEligiblePrimitiveIds: Uint32Array;
  currentFullMeshSubmittedInstanceCount: number;
  currentFullMeshSubmittedVertexCount: number;
  exactEligibleInstanceCount: number;
  exactEligibleVertexCount: number;
  spatialEnvelopeOverfetchInstanceCount: number;
  hiddenByIsoformMembershipInstanceCount: number;
  hiddenByLaneCapInstanceCount: number;
}

export function buildAnnotationPolicySubmissionCensusV1(
  scene: GpuReadyPartitionedTranscriptScene,
  policyGpuInstanceData: Float32Array
): AnnotationPolicySubmissionCensusV1 {
  validateCensusInputs(scene, policyGpuInstanceData);
  const partitions = scene.partitions.map((partition) =>
    censusPartition(policyGpuInstanceData, partition)
  );
  return {
    schema: ANNOTATION_POLICY_SUBMISSION_CENSUS_V1,
    primitiveCount: scene.featureIndices.length,
    verticesPerPrimitive: TRANSCRIPT_GLYPH_INSTANCE_CORNERS.length,
    partitions,
    totals: {
      currentFullMeshSubmittedInstanceCount: scene.featureIndices.length,
      currentFullMeshSubmittedVertexCount:
        scene.featureIndices.length * TRANSCRIPT_GLYPH_INSTANCE_CORNERS.length,
      expanded: sumCells(partitions.map(({ expanded }) => expanded)),
      canonical: sumCells(partitions.map(({ canonical }) => canonical)),
    },
  };
}

export function planExactAnnotationPolicySubmissionV1(
  scene: GpuReadyPartitionedTranscriptScene,
  policyGpuInstanceData: Float32Array,
  viewportStartBp: number,
  viewportEndBp: number,
  runtime: AnnotationPolicyGpuRuntimeV1
): AnnotationPolicyExactSubmissionPlanV1 {
  validateCensusInputs(scene, policyGpuInstanceData);
  validateRuntime(runtime);
  const selectedPartitions = planTranscriptPartitionSubmissions(
    scene,
    viewportStartBp,
    viewportEndBp
  );
  const submittedIds: number[] = [];
  const eligibleIds: number[] = [];
  let spatialEnvelopeOverfetchInstanceCount = 0;
  let hiddenByIsoformMembershipInstanceCount = 0;
  let hiddenByLaneCapInstanceCount = 0;

  for (const partition of selectedPartitions) {
    const end = partition.firstInstance + partition.instanceCount;
    for (let primitiveIndex = partition.firstInstance; primitiveIndex < end; primitiveIndex++) {
      submittedIds.push(primitiveIndex);
      const { startBp, endBp } = glyphBpRange(scene.packedInstanceData, primitiveIndex);
      if (startBp >= viewportEndBp || endBp <= viewportStartBp) {
        spatialEnvelopeOverfetchInstanceCount += 1;
        continue;
      }
      const classification = classifyPolicyPrimitive(
        policyGpuInstanceData,
        primitiveIndex,
        runtime
      );
      if (classification === 'membership') {
        hiddenByIsoformMembershipInstanceCount += 1;
      } else if (classification === 'lane-cap') {
        hiddenByLaneCapInstanceCount += 1;
      } else {
        eligibleIds.push(primitiveIndex);
      }
    }
  }

  const classifiedCount =
    spatialEnvelopeOverfetchInstanceCount +
    hiddenByIsoformMembershipInstanceCount +
    hiddenByLaneCapInstanceCount +
    eligibleIds.length;
  if (classifiedCount !== submittedIds.length) {
    throw new Error('annotation policy submission census classification is not exhaustive');
  }

  return {
    runtime: { ...runtime },
    viewportStartBp,
    viewportEndBp,
    selectedPartitionIndices: selectedPartitions.map(({ partitionIndex }) => partitionIndex),
    currentFullMeshSubmittedPrimitiveIds: Uint32Array.from(submittedIds),
    exactEligiblePrimitiveIds: Uint32Array.from(eligibleIds),
    currentFullMeshSubmittedInstanceCount: submittedIds.length,
    currentFullMeshSubmittedVertexCount:
      submittedIds.length * TRANSCRIPT_GLYPH_INSTANCE_CORNERS.length,
    exactEligibleInstanceCount: eligibleIds.length,
    exactEligibleVertexCount: eligibleIds.length * TRANSCRIPT_GLYPH_INSTANCE_CORNERS.length,
    spatialEnvelopeOverfetchInstanceCount,
    hiddenByIsoformMembershipInstanceCount,
    hiddenByLaneCapInstanceCount,
  };
}

function censusPartition(
  policyData: Float32Array,
  partition: TranscriptInstancePartition
): AnnotationPolicySubmissionCensusPartitionV1 {
  return {
    partitionIndex: partition.partitionIndex,
    firstInstance: partition.firstInstance,
    currentFullMeshSubmittedInstanceCount: partition.instanceCount,
    currentFullMeshSubmittedVertexCount:
      partition.instanceCount * TRANSCRIPT_GLYPH_INSTANCE_CORNERS.length,
    expanded: censusMode(policyData, partition, 'expanded'),
    canonical: censusMode(policyData, partition, 'canonical'),
  };
}

function censusMode(
  policyData: Float32Array,
  partition: TranscriptInstancePartition,
  isoformMode: AnnotationPolicyGpuRuntimeV1['isoformMode']
): AnnotationPolicySubmissionCensusCellV1[] {
  const laneHistogram = new Map<number, number>();
  let hiddenByIsoformMembershipInstanceCount = 0;
  const end = partition.firstInstance + partition.instanceCount;
  for (let primitiveIndex = partition.firstInstance; primitiveIndex < end; primitiveIndex++) {
    const trackLane = policyTrackLane(policyData, primitiveIndex, isoformMode);
    if (trackLane === ANNOTATION_POLICY_GPU_ABSENT_LANE) {
      hiddenByIsoformMembershipInstanceCount += 1;
    } else {
      laneHistogram.set(trackLane, (laneHistogram.get(trackLane) ?? 0) + 1);
    }
  }
  const membershipEligibleCount = partition.instanceCount - hiddenByIsoformMembershipInstanceCount;
  const sortedLaneCounts = [...laneHistogram.entries()].sort(([left], [right]) => left - right);
  return ANNOTATION_POLICY_CENSUS_LANE_LIMITS_V1.map((laneLimit) => {
    const eligibleInstanceCount =
      laneLimit === null
        ? membershipEligibleCount
        : sortedLaneCounts.reduce(
            (sum, [trackLane, count]) => sum + (trackLane < laneLimit ? count : 0),
            0
          );
    return {
      laneLimit,
      eligibleInstanceCount,
      hiddenByIsoformMembershipInstanceCount,
      hiddenByLaneCapInstanceCount: membershipEligibleCount - eligibleInstanceCount,
    };
  });
}

function sumCells(
  partitionCells: ReadonlyArray<ReadonlyArray<AnnotationPolicySubmissionCensusCellV1>>
): AnnotationPolicySubmissionCensusCellV1[] {
  return ANNOTATION_POLICY_CENSUS_LANE_LIMITS_V1.map((laneLimit, capIndex) =>
    partitionCells.reduce<AnnotationPolicySubmissionCensusCellV1>(
      (sum, cells) => ({
        laneLimit,
        eligibleInstanceCount: sum.eligibleInstanceCount + cells[capIndex].eligibleInstanceCount,
        hiddenByIsoformMembershipInstanceCount:
          sum.hiddenByIsoformMembershipInstanceCount +
          cells[capIndex].hiddenByIsoformMembershipInstanceCount,
        hiddenByLaneCapInstanceCount:
          sum.hiddenByLaneCapInstanceCount + cells[capIndex].hiddenByLaneCapInstanceCount,
      }),
      {
        laneLimit,
        eligibleInstanceCount: 0,
        hiddenByIsoformMembershipInstanceCount: 0,
        hiddenByLaneCapInstanceCount: 0,
      }
    )
  );
}

function classifyPolicyPrimitive(
  policyData: Float32Array,
  primitiveIndex: number,
  runtime: AnnotationPolicyGpuRuntimeV1
): 'eligible' | 'membership' | 'lane-cap' {
  const trackLane = policyTrackLane(policyData, primitiveIndex, runtime.isoformMode);
  if (trackLane === ANNOTATION_POLICY_GPU_ABSENT_LANE) return 'membership';
  if (runtime.laneLimit !== null && trackLane >= runtime.laneLimit) return 'lane-cap';
  return 'eligible';
}

function policyTrackLane(
  policyData: Float32Array,
  primitiveIndex: number,
  isoformMode: AnnotationPolicyGpuRuntimeV1['isoformMode']
): number {
  const base = primitiveIndex * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats;
  return policyData[
    base +
      (isoformMode === 'canonical'
        ? ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalTrackLane
        : ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedTrackLane)
  ];
}

function glyphBpRange(
  packedInstanceData: Float32Array,
  primitiveIndex: number
): { startBp: number; endBp: number } {
  const base = primitiveIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const startBp = unpackBpCoordinate(
    packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
    packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta]
  );
  const endBp = unpackBpCoordinate(
    packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk],
    packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta]
  );
  if (
    !Number.isSafeInteger(startBp) ||
    !Number.isSafeInteger(endBp) ||
    startBp < 0 ||
    endBp <= startBp
  ) {
    throw new Error(`annotation policy submission glyph ${primitiveIndex} bp range is invalid`);
  }
  return { startBp, endBp };
}

function validateCensusInputs(
  scene: GpuReadyPartitionedTranscriptScene,
  policyGpuInstanceData: Float32Array
): void {
  const primitiveCount = scene.featureIndices.length;
  validateAnnotationPolicyGpuInstanceDataV1(policyGpuInstanceData, primitiveCount);
  if (
    primitiveCount > 0xffff_ffff ||
    scene.packedInstanceData.length !==
      primitiveCount * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats
  ) {
    throw new Error('annotation policy submission census glyph stream is invalid');
  }
  let expectedFirstInstance = 0;
  let previousPartitionIndex = -1;
  for (const partition of scene.partitions) {
    if (
      !Number.isSafeInteger(partition.partitionIndex) ||
      partition.partitionIndex < 0 ||
      partition.partitionIndex <= previousPartitionIndex ||
      partition.firstInstance !== expectedFirstInstance ||
      !Number.isSafeInteger(partition.instanceCount) ||
      partition.instanceCount <= 0
    ) {
      throw new Error('annotation policy submission census partition ranges are invalid');
    }
    expectedFirstInstance += partition.instanceCount;
    previousPartitionIndex = partition.partitionIndex;
  }
  if (expectedFirstInstance !== primitiveCount) {
    throw new Error('annotation policy submission census partitions do not cover glyphs exactly');
  }
}

function validateRuntime(runtime: AnnotationPolicyGpuRuntimeV1): void {
  if (runtime.isoformMode !== 'canonical' && runtime.isoformMode !== 'expanded') {
    throw new Error('annotation policy submission census isoform mode is invalid');
  }
  if (
    runtime.laneLimit !== null &&
    (!Number.isSafeInteger(runtime.laneLimit) ||
      runtime.laneLimit <= 0 ||
      runtime.laneLimit > ANNOTATION_POLICY_GPU_MAX_EXACT_LANE)
  ) {
    throw new Error('annotation policy submission census lane limit is invalid');
  }
}
