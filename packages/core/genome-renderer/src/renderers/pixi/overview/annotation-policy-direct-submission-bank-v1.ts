import {
  ANNOTATION_POLICY_GPU_ABSENT_LANE,
  ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT,
  annotationPolicyLaneCenterOffsetPxV1,
  validateAnnotationPolicyGpuInstanceDataV1,
  type AnnotationPolicyGpuRuntimeV1,
} from './annotation-policy-gpu-instances-v1';
import {
  decodeAnnotationPolicyProjectionFeatureV1,
  validateAnnotationPolicyProjectionTableV1,
  type AnnotationPolicyProjectionTableV1,
} from './annotation-policy-projection-v1';
import {
  fineTranscriptInstanceViewRange,
  type FineTranscriptInstanceViewRange,
} from './fine-transcript-view-planner';
import {
  planTranscriptPartitionSubmissions,
  type GpuReadyPartitionedTranscriptScene,
  type TranscriptInstancePartition,
} from './partitioned-transcript-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';

export const ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1 =
  'annotation-policy-direct-submission-bank.v1' as const;

export type AnnotationPolicyDirectSubmissionModeV1 = AnnotationPolicyGpuRuntimeV1['isoformMode'];

export interface AnnotationPolicyDirectSubmissionPartitionV1 extends TranscriptInstancePartition {
  readonly sourceInstanceCount: number;
  readonly hiddenByIsoformMembershipInstanceCount: number;
  readonly lanePrefixEnds: Uint32Array;
}

export interface AnnotationPolicyDirectSubmissionModeBankV1 {
  readonly mode: AnnotationPolicyDirectSubmissionModeV1;
  readonly packedInstanceData: Float32Array;
  readonly featureIndices: Uint32Array;
  readonly sourcePrimitiveIndices?: Uint32Array;
  readonly partitions: ReadonlyArray<AnnotationPolicyDirectSubmissionPartitionV1>;
  readonly maxTrackLane: number;
}

export interface AnnotationPolicyDirectSubmissionBankV1 {
  readonly schema: typeof ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1;
  readonly sourcePrimitiveCount: number;
  readonly sourcePartitionSpanBp: number;
  readonly expanded: AnnotationPolicyDirectSubmissionModeBankV1;
  readonly canonical: AnnotationPolicyDirectSubmissionModeBankV1;
}

export interface AnnotationPolicyDirectCompiledSubmissionModeBankV1 extends AnnotationPolicyDirectSubmissionModeBankV1 {
  readonly sourcePrimitiveIndices: Uint32Array;
}

export interface AnnotationPolicyDirectCompiledSubmissionBankV1 extends Omit<
  AnnotationPolicyDirectSubmissionBankV1,
  'expanded' | 'canonical'
> {
  readonly expanded: AnnotationPolicyDirectCompiledSubmissionModeBankV1;
  readonly canonical: AnnotationPolicyDirectCompiledSubmissionModeBankV1;
}

export interface AnnotationPolicyDirectFineTileBankV1 {
  readonly mode: AnnotationPolicyDirectSubmissionModeV1;
  readonly range: FineTranscriptInstanceViewRange;
  readonly packedInstanceData: Float32Array;
  readonly featureIndices: Uint32Array;
  readonly sourcePrimitiveIndices?: Uint32Array;
  readonly lanePrefixEnds: Uint32Array;
  readonly maxTrackLane: number;
  readonly hiddenByIsoformMembershipInstanceCount: number;
}

export interface AnnotationPolicyDirectCompiledFineTileBankV1 extends AnnotationPolicyDirectFineTileBankV1 {
  readonly sourcePrimitiveIndices: Uint32Array;
}

export interface AnnotationPolicyDirectSubmissionPlanV1 {
  readonly selectedPartitionIndices: ReadonlyArray<number>;
  readonly submittedSourcePrimitiveIndices: Uint32Array;
  readonly exactVisibleSourcePrimitiveIndices: Uint32Array;
  readonly actualSubmittedInstanceCount: number;
  readonly actualSubmittedVertexCount: number;
  readonly spatialEnvelopeOverfetchInstanceCount: number;
  readonly hiddenByIsoformMembershipInstanceCount: number;
  readonly hiddenByLaneCapInstanceCount: number;
}

interface OrderedSourceEntry {
  readonly sourcePrimitiveIndex: number;
  readonly trackLane: number;
}

type PrimitiveTrackLane = (
  sourcePrimitiveIndex: number,
  mode: AnnotationPolicyDirectSubmissionModeV1
) => number;

export function buildAnnotationPolicyDirectSubmissionBankV1(
  scene: GpuReadyPartitionedTranscriptScene,
  policyGpuInstanceData: Float32Array
): AnnotationPolicyDirectCompiledSubmissionBankV1 {
  assertSourceScene(scene);
  validateAnnotationPolicyGpuInstanceDataV1(policyGpuInstanceData, scene.featureIndices.length);
  return buildBankFromTrackLanes(
    scene,
    (sourcePrimitiveIndex, mode) =>
      policyGpuInstanceData[
        sourcePrimitiveIndex * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats +
          trackLaneOffsetForMode(mode)
      ]
  );
}

export function buildAnnotationPolicyDirectSubmissionBankFromProjectionV1(
  scene: GpuReadyPartitionedTranscriptScene,
  policy: AnnotationPolicyProjectionTableV1
): AnnotationPolicyDirectCompiledSubmissionBankV1 {
  assertSourceScene(scene);
  validateAnnotationPolicyProjectionTableV1(policy);
  const expandedTrackLanes = new Int32Array(policy.featureCount);
  const canonicalTrackLanes = new Int32Array(policy.featureCount);
  canonicalTrackLanes.fill(ANNOTATION_POLICY_GPU_ABSENT_LANE);
  for (let featureIndex = 0; featureIndex < policy.featureCount; featureIndex++) {
    const feature = decodeAnnotationPolicyProjectionFeatureV1(policy, featureIndex);
    expandedTrackLanes[featureIndex] = feature.expandedTrackLane;
    canonicalTrackLanes[featureIndex] =
      feature.canonicalTrackLane ?? ANNOTATION_POLICY_GPU_ABSENT_LANE;
  }
  for (const featureIndex of scene.featureIndices) {
    if (featureIndex >= policy.featureCount) {
      throw new Error('annotation direct submission primitive policy owner is invalid');
    }
  }
  return buildBankFromTrackLanes(scene, (sourcePrimitiveIndex, mode) => {
    const featureIndex = scene.featureIndices[sourcePrimitiveIndex];
    return mode === 'expanded'
      ? expandedTrackLanes[featureIndex]
      : canonicalTrackLanes[featureIndex];
  });
}

function buildBankFromTrackLanes(
  scene: GpuReadyPartitionedTranscriptScene,
  trackLane: PrimitiveTrackLane
): AnnotationPolicyDirectCompiledSubmissionBankV1 {
  return {
    schema: ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1,
    sourcePrimitiveCount: scene.featureIndices.length,
    sourcePartitionSpanBp: scene.partitionSpanBp,
    expanded: buildModeBank(scene, trackLane, 'expanded'),
    canonical: buildModeBank(scene, trackLane, 'canonical'),
  };
}

export function buildAnnotationPolicyDirectFineTileBankV1(
  scene: GpuReadyPartitionedTranscriptScene,
  policyGpuInstanceData: Float32Array,
  mode: AnnotationPolicyDirectSubmissionModeV1,
  tileIndex: number
): AnnotationPolicyDirectCompiledFineTileBankV1 {
  assertSourceScene(scene);
  validateAnnotationPolicyGpuInstanceDataV1(policyGpuInstanceData, scene.featureIndices.length);
  return buildAnnotationPolicyDirectFineTileBankFromValidatedStreamsV1(
    scene,
    policyGpuInstanceData,
    mode,
    tileIndex
  );
}

export function buildAnnotationPolicyDirectFineTileBankFromValidatedStreamsV1(
  scene: GpuReadyPartitionedTranscriptScene,
  policyGpuInstanceData: Float32Array,
  mode: AnnotationPolicyDirectSubmissionModeV1,
  tileIndex: number
): AnnotationPolicyDirectCompiledFineTileBankV1 {
  const range = fineTranscriptInstanceViewRange(scene, tileIndex);
  const entries = collectOrderedEntries(
    (sourcePrimitiveIndex, requestedMode) =>
      policyGpuInstanceData[
        sourcePrimitiveIndex * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideFloats +
          trackLaneOffsetForMode(requestedMode)
      ],
    mode,
    range.firstInstance,
    range.instanceCount
  );
  const direct = copyOrderedGlyphRecords(scene, mode, entries);
  return {
    mode,
    range,
    ...direct,
    hiddenByIsoformMembershipInstanceCount: range.instanceCount - entries.length,
  };
}

export function directSubmissionInstanceCountForLaneLimitV1(
  partition: Pick<AnnotationPolicyDirectSubmissionPartitionV1, 'instanceCount' | 'lanePrefixEnds'>,
  laneLimit: number | null
): number {
  if (laneLimit === null) return partition.instanceCount;
  if (!Number.isSafeInteger(laneLimit) || laneLimit <= 0) {
    throw new Error('annotation direct submission lane limit must be positive or null');
  }
  if (laneLimit >= partition.lanePrefixEnds.length) return partition.instanceCount;
  return partition.lanePrefixEnds[laneLimit];
}

export function directFineTileInstanceCountForLaneLimitV1(
  tile: Pick<AnnotationPolicyDirectFineTileBankV1, 'featureIndices' | 'lanePrefixEnds'>,
  laneLimit: number | null
): number {
  return directSubmissionInstanceCountForLaneLimitV1(
    { instanceCount: tile.featureIndices.length, lanePrefixEnds: tile.lanePrefixEnds },
    laneLimit
  );
}

export function planAnnotationPolicyDirectSubmissionV1(
  scene: GpuReadyPartitionedTranscriptScene,
  bank: AnnotationPolicyDirectSubmissionBankV1,
  viewportStartBp: number,
  viewportEndBp: number,
  runtime: AnnotationPolicyGpuRuntimeV1
): AnnotationPolicyDirectSubmissionPlanV1 {
  assertBankMatchesScene(scene, bank);
  const modeBank = bank[runtime.isoformMode];
  const sourcePrimitiveIndices = modeBank.sourcePrimitiveIndices;
  if (!sourcePrimitiveIndices) {
    throw new Error('annotation direct submission audit requires source primitive identities');
  }
  const selectedSourcePartitions = planTranscriptPartitionSubmissions(
    scene,
    viewportStartBp,
    viewportEndBp
  );
  const selected = new Set(selectedSourcePartitions.map(({ partitionIndex }) => partitionIndex));
  const submitted: number[] = [];
  const exactVisible: number[] = [];
  let membershipHidden = 0;
  let laneCapHidden = 0;
  for (const partition of modeBank.partitions) {
    if (!selected.has(partition.partitionIndex)) continue;
    const count = directSubmissionInstanceCountForLaneLimitV1(partition, runtime.laneLimit);
    membershipHidden += partition.hiddenByIsoformMembershipInstanceCount;
    laneCapHidden += partition.instanceCount - count;
    for (let local = 0; local < count; local++) {
      const sourcePrimitiveIndex = sourcePrimitiveIndices[partition.firstInstance + local];
      submitted.push(sourcePrimitiveIndex);
      if (primitiveOverlapsViewport(scene, sourcePrimitiveIndex, viewportStartBp, viewportEndBp)) {
        exactVisible.push(sourcePrimitiveIndex);
      }
    }
  }
  return {
    selectedPartitionIndices: [...selected].sort((left, right) => left - right),
    submittedSourcePrimitiveIndices: Uint32Array.from(submitted),
    exactVisibleSourcePrimitiveIndices: Uint32Array.from(exactVisible),
    actualSubmittedInstanceCount: submitted.length,
    actualSubmittedVertexCount: submitted.length * 9,
    spatialEnvelopeOverfetchInstanceCount: submitted.length - exactVisible.length,
    hiddenByIsoformMembershipInstanceCount: membershipHidden,
    hiddenByLaneCapInstanceCount: laneCapHidden,
  };
}

export function assertAnnotationPolicyDirectSubmissionBankV1(
  scene: GpuReadyPartitionedTranscriptScene,
  bank: AnnotationPolicyDirectSubmissionBankV1
): void {
  assertSourceScene(scene);
  assertBankMatchesScene(scene, bank);
  assertModeBank(scene, bank.expanded, 'expanded');
  assertModeBank(scene, bank.canonical, 'canonical');
}

function buildModeBank(
  scene: GpuReadyPartitionedTranscriptScene,
  trackLane: PrimitiveTrackLane,
  mode: AnnotationPolicyDirectSubmissionModeV1
): AnnotationPolicyDirectCompiledSubmissionModeBankV1 {
  const partitionCounts = scene.partitions.map((partition) =>
    countModeEntries(trackLane, mode, partition.firstInstance, partition.instanceCount)
  );
  const total = partitionCounts.reduce((sum, count) => sum + count, 0);
  const packedInstanceData = new Float32Array(
    total * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats
  );
  const featureIndices = new Uint32Array(total);
  const sourcePrimitiveIndices = new Uint32Array(total);
  const partitions: AnnotationPolicyDirectSubmissionPartitionV1[] = [];
  let cursor = 0;
  let maxTrackLane = -1;
  for (let index = 0; index < scene.partitions.length; index++) {
    const sourcePartition = scene.partitions[index];
    const entries = collectOrderedEntries(
      trackLane,
      mode,
      sourcePartition.firstInstance,
      sourcePartition.instanceCount
    );
    if (entries.length !== partitionCounts[index]) {
      throw new Error('annotation direct submission count/materialization mismatch');
    }
    const direct = copyOrderedGlyphRecords(
      scene,
      mode,
      entries,
      packedInstanceData,
      featureIndices,
      sourcePrimitiveIndices,
      cursor
    );
    maxTrackLane = Math.max(maxTrackLane, direct.maxTrackLane);
    partitions.push({
      ...sourcePartition,
      firstInstance: cursor,
      instanceCount: entries.length,
      sourceInstanceCount: sourcePartition.instanceCount,
      hiddenByIsoformMembershipInstanceCount: sourcePartition.instanceCount - entries.length,
      lanePrefixEnds: direct.lanePrefixEnds,
    });
    cursor += entries.length;
  }
  return {
    mode,
    packedInstanceData,
    featureIndices,
    sourcePrimitiveIndices,
    partitions,
    maxTrackLane,
  };
}

function countModeEntries(
  trackLane: PrimitiveTrackLane,
  mode: AnnotationPolicyDirectSubmissionModeV1,
  firstInstance: number,
  instanceCount: number
): number {
  let count = 0;
  for (let local = 0; local < instanceCount; local++) {
    const sourcePrimitiveIndex = firstInstance + local;
    if (trackLane(sourcePrimitiveIndex, mode) !== ANNOTATION_POLICY_GPU_ABSENT_LANE) {
      count++;
    }
  }
  return count;
}

function collectOrderedEntries(
  trackLaneForPrimitive: PrimitiveTrackLane,
  mode: AnnotationPolicyDirectSubmissionModeV1,
  firstInstance: number,
  instanceCount: number
): OrderedSourceEntry[] {
  const entries: OrderedSourceEntry[] = [];
  for (let local = 0; local < instanceCount; local++) {
    const sourcePrimitiveIndex = firstInstance + local;
    const trackLane = trackLaneForPrimitive(sourcePrimitiveIndex, mode);
    if (trackLane === ANNOTATION_POLICY_GPU_ABSENT_LANE) continue;
    entries.push({ sourcePrimitiveIndex, trackLane });
  }
  entries.sort(
    (left, right) =>
      left.trackLane - right.trackLane || left.sourcePrimitiveIndex - right.sourcePrimitiveIndex
  );
  return entries;
}

function trackLaneOffsetForMode(mode: AnnotationPolicyDirectSubmissionModeV1): number {
  return mode === 'canonical'
    ? ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.canonicalTrackLane
    : ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedTrackLane;
}

function copyOrderedGlyphRecords(
  scene: GpuReadyPartitionedTranscriptScene,
  mode: AnnotationPolicyDirectSubmissionModeV1,
  entries: ReadonlyArray<OrderedSourceEntry>,
  packedInstanceData = new Float32Array(
    entries.length * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats
  ),
  featureIndices = new Uint32Array(entries.length),
  sourcePrimitiveIndices = new Uint32Array(entries.length),
  targetFirstInstance = 0
): {
  packedInstanceData: Float32Array;
  featureIndices: Uint32Array;
  sourcePrimitiveIndices: Uint32Array;
  lanePrefixEnds: Uint32Array;
  maxTrackLane: number;
} {
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  let maxTrackLane = -1;
  for (let local = 0; local < entries.length; local++) {
    const { sourcePrimitiveIndex, trackLane } = entries[local];
    const targetPrimitiveIndex = targetFirstInstance + local;
    const sourceBase = sourcePrimitiveIndex * stride;
    const targetBase = targetPrimitiveIndex * stride;
    packedInstanceData.set(
      scene.packedInstanceData.subarray(sourceBase, sourceBase + stride),
      targetBase
    );
    packedInstanceData[targetBase + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter] =
      annotationPolicyLaneCenterOffsetPxV1(trackLane);
    featureIndices[targetPrimitiveIndex] = scene.featureIndices[sourcePrimitiveIndex];
    sourcePrimitiveIndices[targetPrimitiveIndex] = sourcePrimitiveIndex;
    maxTrackLane = Math.max(maxTrackLane, trackLane);
  }
  return {
    packedInstanceData,
    featureIndices,
    sourcePrimitiveIndices,
    lanePrefixEnds: buildLanePrefixEnds(entries, maxTrackLane),
    maxTrackLane,
  };
}

function buildLanePrefixEnds(
  entries: ReadonlyArray<OrderedSourceEntry>,
  maxTrackLane: number
): Uint32Array {
  const prefix = new Uint32Array(maxTrackLane + 2);
  let cursor = 0;
  for (let laneLimit = 0; laneLimit < prefix.length; laneLimit++) {
    while (cursor < entries.length && entries[cursor].trackLane < laneLimit) cursor++;
    prefix[laneLimit] = cursor;
  }
  return prefix;
}

function primitiveOverlapsViewport(
  scene: GpuReadyPartitionedTranscriptScene,
  primitiveIndex: number,
  viewportStartBp: number,
  viewportEndBp: number
): boolean {
  const base = primitiveIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const startBp =
    scene.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk] * 4096 +
    scene.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta];
  const endBp =
    scene.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk] * 4096 +
    scene.packedInstanceData[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta];
  return startBp < viewportEndBp && endBp > viewportStartBp;
}

function assertSourceScene(scene: GpuReadyPartitionedTranscriptScene): void {
  const primitiveCount = scene.featureIndices.length;
  if (
    scene.packedInstanceData.length !==
    primitiveCount * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats
  ) {
    throw new Error('annotation direct submission source glyph length is invalid');
  }
  let expectedFirst = 0;
  for (const partition of scene.partitions) {
    if (partition.firstInstance !== expectedFirst || partition.instanceCount <= 0) {
      throw new Error('annotation direct submission source partitions are invalid');
    }
    expectedFirst += partition.instanceCount;
  }
  if (expectedFirst !== primitiveCount) {
    throw new Error('annotation direct submission source partitions do not cover primitives');
  }
}

function assertBankMatchesScene(
  scene: GpuReadyPartitionedTranscriptScene,
  bank: AnnotationPolicyDirectSubmissionBankV1
): void {
  if (
    bank.schema !== ANNOTATION_POLICY_DIRECT_SUBMISSION_BANK_V1 ||
    bank.sourcePrimitiveCount !== scene.featureIndices.length ||
    bank.sourcePartitionSpanBp !== scene.partitionSpanBp
  ) {
    throw new Error('annotation direct submission bank does not match source scene');
  }
}

function assertModeBank(
  scene: GpuReadyPartitionedTranscriptScene,
  modeBank: AnnotationPolicyDirectSubmissionModeBankV1,
  mode: AnnotationPolicyDirectSubmissionModeV1
): void {
  if (
    modeBank.mode !== mode ||
    (modeBank.sourcePrimitiveIndices !== undefined &&
      modeBank.featureIndices.length !== modeBank.sourcePrimitiveIndices.length) ||
    modeBank.packedInstanceData.length !==
      modeBank.featureIndices.length * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats ||
    modeBank.partitions.length !== scene.partitions.length
  ) {
    throw new Error(`annotation direct submission ${mode} bank shape is invalid`);
  }
  let expectedFirst = 0;
  for (let index = 0; index < modeBank.partitions.length; index++) {
    const partition = modeBank.partitions[index];
    const source = scene.partitions[index];
    if (
      partition.partitionIndex !== source.partitionIndex ||
      partition.firstInstance !== expectedFirst ||
      partition.sourceInstanceCount !== source.instanceCount ||
      partition.hiddenByIsoformMembershipInstanceCount !==
        source.instanceCount - partition.instanceCount ||
      partition.lanePrefixEnds[partition.lanePrefixEnds.length - 1] !== partition.instanceCount
    ) {
      throw new Error(`annotation direct submission ${mode} partition is invalid`);
    }
    expectedFirst += partition.instanceCount;
  }
  if (expectedFirst !== modeBank.featureIndices.length) {
    throw new Error(`annotation direct submission ${mode} partitions do not cover bank`);
  }
}
