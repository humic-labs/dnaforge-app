import type { DeletedRange, InsertedRange } from '../types';

export function isPositionDeleted(pos: number, deletedRanges: readonly DeletedRange[]): boolean {
  return deletedRanges.some((range) => pos >= range.start && pos < range.end);
}

export function countDeletedBefore(pos: number, deletedRanges: DeletedRange[]): number {
  let count = 0;
  for (const range of deletedRanges) {
    if (range.end <= pos) {
      count += range.end - range.start;
    } else if (range.start < pos) {
      count += pos - range.start;
    }
  }
  return count;
}

let lastDeletedRangesRef: DeletedRange[] | null = null;
let lastSortedRanges: DeletedRange[] = [];

export function getSortedDeletedRanges(deletedRanges: DeletedRange[]): DeletedRange[] {
  if (deletedRanges === lastDeletedRangesRef) {
    return lastSortedRanges;
  }
  lastDeletedRangesRef = deletedRanges;
  lastSortedRanges = [...deletedRanges].sort((a, b) => a.start - b.start);
  return lastSortedRanges;
}

export function effectiveToVisual(effectivePos: number, deletedRanges: DeletedRange[]): number {
  if (deletedRanges.length === 0) return effectivePos;

  const sorted = getSortedDeletedRanges(deletedRanges);

  let visualPos = effectivePos;
  let deletedSoFar = 0;

  for (const range of sorted) {
    const rangeLen = range.end - range.start;
    const effectiveRangeStart = range.start - deletedSoFar;

    if (effectivePos >= effectiveRangeStart) {
      visualPos += rangeLen;
      deletedSoFar += rangeLen;
    } else {
      break;
    }
  }

  return visualPos;
}

export function rangeOverlapsInsertions(
  start: number,
  end: number,
  insertedRanges: InsertedRange[]
): boolean {
  return insertedRanges.some((range) => start < range.end && end > range.start);
}

export function clearRangeCache(): void {
  lastDeletedRangesRef = null;
  lastSortedRanges = [];
}

export function lineSpansOrigin(lineStartPos: number, lineEndPos: number): boolean {
  return lineStartPos > lineEndPos;
}

export function getVisibleRangeSegments(
  rangeStart: number,
  rangeEnd: number,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): Array<{ start: number; end: number; charIndexStart: number }> {
  const segments: Array<{ start: number; end: number; charIndexStart: number }> = [];

  if (!lineSpansOrigin(lineStartPos, lineEndPos)) {
    const visibleStart = Math.max(rangeStart, lineStartPos);
    const visibleEnd = Math.min(rangeEnd, lineEndPos);
    if (visibleEnd > visibleStart) {
      segments.push({
        start: visibleStart,
        end: visibleEnd,
        charIndexStart: visibleStart - lineStartPos,
      });
    }
    return segments;
  }

  const seg1Start = lineStartPos;
  const seg1End = sequenceLength;
  const seg1VisibleStart = Math.max(rangeStart, seg1Start);
  const seg1VisibleEnd = Math.min(rangeEnd, seg1End);
  if (seg1VisibleEnd > seg1VisibleStart) {
    segments.push({
      start: seg1VisibleStart,
      end: seg1VisibleEnd,
      charIndexStart: seg1VisibleStart - lineStartPos,
    });
  }

  const seg2Start = 0;
  const seg2End = lineEndPos;
  const seg2VisibleStart = Math.max(rangeStart, seg2Start);
  const seg2VisibleEnd = Math.min(rangeEnd, seg2End);
  if (seg2VisibleEnd > seg2VisibleStart) {
    const charIndexOffset = sequenceLength - lineStartPos;
    segments.push({
      start: seg2VisibleStart,
      end: seg2VisibleEnd,
      charIndexStart: charIndexOffset + seg2VisibleStart,
    });
  }

  return segments;
}

export function rangeOverlapsLine(
  rangeStart: number,
  rangeEnd: number,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): boolean {
  if (!lineSpansOrigin(lineStartPos, lineEndPos)) {
    return rangeEnd > lineStartPos && rangeStart < lineEndPos;
  }
  const overlapsSegment1 = rangeEnd > lineStartPos && rangeStart < sequenceLength;
  const overlapsSegment2 = rangeEnd > 0 && rangeStart < lineEndPos;
  return overlapsSegment1 || overlapsSegment2;
}
