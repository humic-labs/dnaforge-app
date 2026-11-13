import type { PrimerDisplay } from './types';
import { rangeOverlapsLine } from './utils/range-utils';

export function primerOverlapsLine(
  primer: PrimerDisplay,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): boolean {
  const primerSpansOrigin = primer.start > primer.end;
  const lineSpans = lineStartPos > lineEndPos;

  if (primerSpansOrigin) {
    const seg1Overlaps = rangeOverlapsLine(
      primer.start,
      sequenceLength,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
    const seg2Overlaps = rangeOverlapsLine(0, primer.end, lineStartPos, lineEndPos, sequenceLength);
    return seg1Overlaps || seg2Overlaps;
  }

  if (lineSpans) {
    return rangeOverlapsLine(primer.start, primer.end, lineStartPos, lineEndPos, sequenceLength);
  }

  return primer.start < lineEndPos && primer.end > lineStartPos;
}

function getPrimerVisibleRanges(
  primer: PrimerDisplay,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): Array<{ start: number; end: number }> {
  const primerSpansOrigin = primer.start > primer.end;
  const lineSpansOrigin = lineStartPos > lineEndPos;

  const primerSegs: Array<{ start: number; end: number }> = primerSpansOrigin
    ? [
        { start: primer.start, end: sequenceLength },
        { start: 0, end: primer.end },
      ]
    : [{ start: primer.start, end: primer.end }];

  const lineSegs: Array<{ start: number; end: number }> = lineSpansOrigin
    ? [
        { start: lineStartPos, end: sequenceLength },
        { start: 0, end: lineEndPos },
      ]
    : [{ start: lineStartPos, end: lineEndPos }];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const ps of primerSegs) {
    for (const ls of lineSegs) {
      const start = Math.max(ps.start, ls.start);
      const end = Math.min(ps.end, ls.end);
      if (end > start) ranges.push({ start, end });
    }
  }

  return ranges;
}

export function packPrimerLanes(
  primers: PrimerDisplay[],
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): { laneMap: Map<string, number>; laneCount: number } {
  if (primers.length === 0) return { laneMap: new Map(), laneCount: 0 };

  const items = primers
    .map((p) => ({
      primer: p,
      ranges: getPrimerVisibleRanges(p, lineStartPos, lineEndPos, sequenceLength),
    }))
    .filter((item) => item.ranges.length > 0);

  if (items.length === 0) return { laneMap: new Map(), laneCount: 0 };

  items.sort((a, b) => {
    const aMin = Math.min(...a.ranges.map((r) => r.start));
    const bMin = Math.min(...b.ranges.map((r) => r.start));
    return aMin - bMin;
  });

  const laneRanges: Array<Array<{ start: number; end: number }>> = [];
  const laneMap = new Map<string, number>();

  for (const { primer, ranges } of items) {
    let assignedLane = -1;
    for (let lane = 0; lane < laneRanges.length; lane++) {
      const occupied = laneRanges[lane];
      const hasOverlap = ranges.some((myRange) =>
        occupied.some((occ) => myRange.start < occ.end && occ.start < myRange.end)
      );
      if (!hasOverlap) {
        assignedLane = lane;
        break;
      }
    }

    if (assignedLane === -1) {
      assignedLane = laneRanges.length;
      laneRanges.push([]);
    }

    laneRanges[assignedLane].push(...ranges);
    laneMap.set(primer.id, assignedLane);
  }

  return { laneMap, laneCount: laneRanges.length };
}
