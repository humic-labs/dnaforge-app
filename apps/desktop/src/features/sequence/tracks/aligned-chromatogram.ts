import { reverseComplementTrace, validateTraceQuality, type TraceData } from '../../trace/public';
import type { ChromatogramLaneOptions } from './chromatogram-lane';

export interface AlignmentInput {
  referenceSequence: string;
  trace: TraceData;
  readSequence: string;
  readQuality?: ReadonlyArray<number>;
  alignedQuery: string;
  alignedReference: string;
  reverseComplemented?: boolean;
  referenceOffset?: number;
}

export interface AlignmentResult {
  laneOptions: ChromatogramLaneOptions;
  coverageStart: number;
  coverageEnd: number;
  retainedPeaks: number[];
  droppedInsertions: number;
  mutationColumns: number[];
  deletionColumns: number[];
}

export function buildAlignedChromatogramOptions(input: AlignmentInput): AlignmentResult {
  const {
    referenceSequence,
    trace: rawTrace,
    readSequence,
    readQuality,
    alignedQuery,
    alignedReference,
    reverseComplemented = false,
  } = input;

  if (alignedQuery.length !== alignedReference.length) {
    throw new Error(
      `aligned_query (${alignedQuery.length}) and aligned_reference (${alignedReference.length}) must have the same length`
    );
  }
  if (rawTrace.peakPositions.length !== readSequence.length) {
    throw new Error(
      `peakPositions (${rawTrace.peakPositions.length}) and readSequence (${readSequence.length}) must have the same length`
    );
  }
  validateTraceQuality(readQuality, readSequence.length);

  const trace = reverseComplemented ? reverseComplementTrace(rawTrace) : rawTrace;

  const ungappedRef = alignedReference.replace(/-/g, '');
  if (ungappedRef.length === 0) {
    throw new Error('alignedReference is empty after gap removal');
  }
  let refOffset: number;
  if (typeof input.referenceOffset === 'number') {
    refOffset = input.referenceOffset;
  } else {
    refOffset = referenceSequence.toUpperCase().indexOf(ungappedRef.toUpperCase());
    if (refOffset < 0) {
      throw new Error(
        `aligned_reference substring not found in referenceSequence — wrong reference passed to alignment?`
      );
    }
  }

  let refIdx = 0;
  let droppedInsertions = 0;
  const retainedPeaks: number[] = [];
  const baseToColumn: number[] = [];
  const mutationColumns: number[] = [];
  const deletionColumns: number[] = [];
  let coverageStart = -1;
  let coverageEnd = 0;

  let lastQueryNonGap = -1;
  for (let i = alignedQuery.length - 1; i >= 0; i--) {
    if (alignedQuery[i] !== '-') {
      lastQueryNonGap = i;
      break;
    }
  }

  const findMatchingReadBase = (alignedChar: string, fromIdx: number): number => {
    if (alignedChar === '-') return fromIdx;
    const u = alignedChar.toUpperCase();
    for (let i = fromIdx; i < readSequence.length; i++) {
      const r = readSequence[i].toUpperCase();
      if (r === u || r === 'N' || u === 'N') return i;
    }
    return -1;
  };

  let readCursor = 0;
  for (let alignIdx = 0; alignIdx < alignedQuery.length; alignIdx++) {
    const qChar = alignedQuery[alignIdx];
    const rChar = alignedReference[alignIdx];

    if (qChar === '-' && rChar === '-') {
      continue;
    }
    if (qChar === '-') {
      if (coverageStart >= 0 && alignIdx < lastQueryNonGap) {
        const refColumn = refOffset + refIdx;
        deletionColumns.push(refColumn);
        coverageEnd = refColumn + 1;
      }
      refIdx++;
      continue;
    }
    if (rChar === '-') {
      const matchedReadIdx = findMatchingReadBase(qChar, readCursor);
      if (matchedReadIdx >= 0) {
        readCursor = matchedReadIdx + 1;
      }
      droppedInsertions++;
      continue;
    }

    const matchedReadIdx = findMatchingReadBase(qChar, readCursor);
    if (matchedReadIdx < 0) {
      droppedInsertions++;
    } else {
      const refColumn = refOffset + refIdx;
      retainedPeaks.push(matchedReadIdx);
      baseToColumn.push(refColumn);
      if (coverageStart < 0) coverageStart = refColumn;
      coverageEnd = refColumn + 1;
      const qU = qChar.toUpperCase();
      const rU = rChar.toUpperCase();
      if (qU !== rU && qU !== 'N' && rU !== 'N') {
        mutationColumns.push(refColumn);
      }
      readCursor = matchedReadIdx + 1;
    }
    refIdx++;
  }

  const trimmedPeakPositions = retainedPeaks.map((i) => trace.peakPositions[i]);
  const trimmedSequence = retainedPeaks.map((i) => readSequence[i]).join('');
  const trimmedQuality = readQuality?.length ? retainedPeaks.map((i) => readQuality[i]) : undefined;

  const trimmedTrace: TraceData = {
    channels: trace.channels,
    peakPositions: trimmedPeakPositions,
    baseOrder: trace.baseOrder,
    maxValue: trace.maxValue,
  };

  const laneOptions: ChromatogramLaneOptions = {
    trace: trimmedTrace,
    sequence: trimmedSequence,
    quality: trimmedQuality,
    baseToColumn,
    totalColumns: referenceSequence.length,
    mutationColumns,
    deletionColumns,
    reverseComplemented: false,
  };

  return {
    laneOptions,
    coverageStart: coverageStart < 0 ? 0 : coverageStart,
    coverageEnd,
    retainedPeaks,
    droppedInsertions,
    mutationColumns,
    deletionColumns,
  };
}
