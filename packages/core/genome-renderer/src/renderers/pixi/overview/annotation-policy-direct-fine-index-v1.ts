import {
  type AnnotationPolicyDirectFineTileBankV1,
  type AnnotationPolicyDirectSubmissionModeBankV1,
} from './annotation-policy-direct-submission-bank-v1';
import { FINE_TRANSCRIPT_VIEW_SPAN_BP } from './fine-transcript-view-planner';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';
import { unpackBpCoordinate } from './bp-coordinate-packing';

export const ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1 =
  'annotation-policy-direct-fine-index.v1' as const;

export interface AnnotationPolicyDirectFineIndexV1 {
  readonly schema: typeof ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1;
  readonly tileSpanBp: typeof FINE_TRANSCRIPT_VIEW_SPAN_BP;
  readonly tileCount: number;
  readonly tileOffsets: Uint32Array;
  readonly bankRecordIndices: Uint32Array;
  readonly sourceTilePrimitiveCounts: Uint32Array;
}

export function buildAnnotationPolicyDirectFineIndexV1(
  modeBank: AnnotationPolicyDirectSubmissionModeBankV1,
  assemblyLengthBp: number,
  sourceTilePrimitiveCounts?: Uint32Array
): AnnotationPolicyDirectFineIndexV1 {
  if (!Number.isSafeInteger(assemblyLengthBp) || assemblyLengthBp <= 0) {
    throw new Error('annotation direct fine index assembly length is invalid');
  }
  const tileCount = Math.ceil(assemblyLengthBp / FINE_TRANSCRIPT_VIEW_SPAN_BP);
  if (tileCount > 0xffff_ffff) {
    throw new Error('annotation direct fine index tile count exceeds uint32');
  }
  const buckets = Array.from({ length: tileCount }, () => [] as number[]);
  for (
    let bankRecordIndex = 0;
    bankRecordIndex < modeBank.featureIndices.length;
    bankRecordIndex++
  ) {
    const tileIndex = Math.floor(
      glyphStartBp(modeBank.packedInstanceData, bankRecordIndex) / FINE_TRANSCRIPT_VIEW_SPAN_BP
    );
    if (tileIndex < 0 || tileIndex >= tileCount) {
      throw new Error('annotation direct fine index glyph lies outside assembly');
    }
    buckets[tileIndex].push(bankRecordIndex);
  }
  const tileOffsets = new Uint32Array(tileCount + 1);
  const bankRecordIndices = new Uint32Array(modeBank.featureIndices.length);
  let cursor = 0;
  for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
    tileOffsets[tileIndex] = cursor;
    buckets[tileIndex].sort((left, right) => {
      const laneDelta =
        glyphTrackLane(modeBank.packedInstanceData, left) -
        glyphTrackLane(modeBank.packedInstanceData, right);
      return laneDelta || left - right;
    });
    for (const bankRecordIndex of buckets[tileIndex]) bankRecordIndices[cursor++] = bankRecordIndex;
  }
  tileOffsets[tileCount] = cursor;
  const sourceCounts = sourceTilePrimitiveCounts
    ? new Uint32Array(sourceTilePrimitiveCounts)
    : Uint32Array.from(buckets, (bucket) => bucket.length);
  if (sourceCounts.length !== tileCount) {
    throw new Error('annotation direct fine index source tile counts are invalid');
  }
  const index = {
    schema: ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1,
    tileSpanBp: FINE_TRANSCRIPT_VIEW_SPAN_BP,
    tileCount,
    tileOffsets,
    bankRecordIndices,
    sourceTilePrimitiveCounts: sourceCounts,
  } satisfies AnnotationPolicyDirectFineIndexV1;
  assertAnnotationPolicyDirectFineIndexV1(modeBank, index);
  return index;
}

export function assertAnnotationPolicyDirectFineIndexV1(
  modeBank: AnnotationPolicyDirectSubmissionModeBankV1,
  index: AnnotationPolicyDirectFineIndexV1
): void {
  if (
    index.schema !== ANNOTATION_POLICY_DIRECT_FINE_INDEX_V1 ||
    index.tileSpanBp !== FINE_TRANSCRIPT_VIEW_SPAN_BP ||
    !Number.isSafeInteger(index.tileCount) ||
    index.tileCount <= 0 ||
    index.tileOffsets.length !== index.tileCount + 1 ||
    index.sourceTilePrimitiveCounts.length !== index.tileCount ||
    index.bankRecordIndices.length !== modeBank.featureIndices.length ||
    index.tileOffsets[0] !== 0 ||
    index.tileOffsets[index.tileCount] !== index.bankRecordIndices.length
  ) {
    throw new Error('annotation direct fine index shape is invalid');
  }
  const seen = new Uint8Array(modeBank.featureIndices.length);
  for (let tileIndex = 0; tileIndex < index.tileCount; tileIndex++) {
    const first = index.tileOffsets[tileIndex];
    const end = index.tileOffsets[tileIndex + 1];
    if (end < first || end > index.bankRecordIndices.length) {
      throw new Error('annotation direct fine index offsets are invalid');
    }
    let priorLane = -1;
    for (let cursor = first; cursor < end; cursor++) {
      const bankRecordIndex = index.bankRecordIndices[cursor];
      if (bankRecordIndex >= seen.length || seen[bankRecordIndex]) {
        throw new Error('annotation direct fine index record ownership is invalid');
      }
      seen[bankRecordIndex] = 1;
      const expectedTile = Math.floor(
        glyphStartBp(modeBank.packedInstanceData, bankRecordIndex) / index.tileSpanBp
      );
      const lane = glyphTrackLane(modeBank.packedInstanceData, bankRecordIndex);
      if (expectedTile !== tileIndex || lane < priorLane) {
        throw new Error('annotation direct fine index ordering is invalid');
      }
      priorLane = lane;
    }
    if (index.sourceTilePrimitiveCounts[tileIndex] < end - first) {
      throw new Error('annotation direct fine index source count is invalid');
    }
  }
}

export function materializeAnnotationPolicyDirectFineTileV1(
  modeBank: AnnotationPolicyDirectSubmissionModeBankV1,
  index: AnnotationPolicyDirectFineIndexV1,
  tileIndex: number
): AnnotationPolicyDirectFineTileBankV1 {
  if (!Number.isSafeInteger(tileIndex) || tileIndex < 0 || tileIndex >= index.tileCount) {
    throw new Error('annotation direct fine tile index is invalid');
  }
  const first = index.tileOffsets[tileIndex];
  const end = index.tileOffsets[tileIndex + 1];
  const count = end - first;
  const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const packedInstanceData = new Float32Array(count * stride);
  const featureIndices = new Uint32Array(count);
  const sourcePrimitiveIndices = modeBank.sourcePrimitiveIndices
    ? new Uint32Array(count)
    : undefined;
  let maxTrackLane = -1;
  for (let local = 0; local < count; local++) {
    const bankRecordIndex = index.bankRecordIndices[first + local];
    packedInstanceData.set(
      modeBank.packedInstanceData.subarray(
        bankRecordIndex * stride,
        (bankRecordIndex + 1) * stride
      ),
      local * stride
    );
    featureIndices[local] = modeBank.featureIndices[bankRecordIndex];
    if (sourcePrimitiveIndices && modeBank.sourcePrimitiveIndices) {
      sourcePrimitiveIndices[local] = modeBank.sourcePrimitiveIndices[bankRecordIndex];
    }
    maxTrackLane = Math.max(
      maxTrackLane,
      glyphTrackLane(modeBank.packedInstanceData, bankRecordIndex)
    );
  }
  const lanePrefixEnds = new Uint32Array(maxTrackLane + 2);
  let cursor = 0;
  for (let laneLimit = 0; laneLimit < lanePrefixEnds.length; laneLimit++) {
    while (cursor < count && glyphTrackLane(packedInstanceData, cursor) < laneLimit) cursor++;
    lanePrefixEnds[laneLimit] = cursor;
  }
  const startBp = tileIndex * index.tileSpanBp;
  return {
    mode: modeBank.mode,
    range: {
      key: `fine-bp-view-${tileIndex}`,
      tileIndex,
      startBp,
      endBpExclusive: startBp + index.tileSpanBp,
      firstInstance: 0,
      instanceCount: index.sourceTilePrimitiveCounts[tileIndex],
    },
    packedInstanceData,
    featureIndices,
    ...(sourcePrimitiveIndices ? { sourcePrimitiveIndices } : {}),
    lanePrefixEnds,
    maxTrackLane,
    hiddenByIsoformMembershipInstanceCount: index.sourceTilePrimitiveCounts[tileIndex] - count,
  };
}

function glyphStartBp(data: Float32Array, recordIndex: number): number {
  const base = recordIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  return unpackBpCoordinate(
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk],
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta]
  );
}

function glyphTrackLane(data: Float32Array, recordIndex: number): number {
  const base = recordIndex * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats;
  const offset = data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter];
  const lane = (-7 - offset) / 16;
  if (!Number.isSafeInteger(lane) || lane < 0) {
    throw new Error('annotation direct fine index glyph lane is invalid');
  }
  return lane;
}
