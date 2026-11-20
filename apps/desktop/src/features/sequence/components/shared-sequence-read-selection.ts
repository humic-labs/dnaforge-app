import type { SearchMatch } from '@waypoint/sequence-utils';
import type { SharedSequenceAxis, SharedSequenceReadLane } from './shared-sequence-read-model';

export interface PrimarySequenceSelection {
  start: number;
  end: number;
}

function lowerBoundBase(axis: SharedSequenceAxis, column: number): number {
  let low = 0;
  let high = axis.biologicalLength;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const mapped = axis.bioToColumn(middle);
    if (mapped !== null && mapped < column) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function primaryBiologicalSelectionForColumns(
  axis: SharedSequenceAxis,
  selection: PrimarySequenceSelection
): PrimarySequenceSelection | null {
  if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)) return null;
  const firstColumn = Math.max(0, Math.min(selection.start, selection.end));
  const lastColumn = Math.min(axis.length - 1, Math.max(selection.start, selection.end));
  if (lastColumn < firstColumn) return null;
  const start = lowerBoundBase(axis, firstColumn);
  const end = lowerBoundBase(axis, lastColumn + 1) - 1;
  return start <= end ? { start, end } : null;
}

export function primaryColumnSelectionForBiological(
  axis: SharedSequenceAxis,
  selection: PrimarySequenceSelection | null
): PrimarySequenceSelection | null {
  if (!selection) return null;
  const start = axis.bioToColumn(selection.start);
  const end = axis.bioToColumn(selection.end);
  return start === null || end === null ? null : { start, end };
}

export function biologicalViewportForColumns(
  axis: SharedSequenceAxis,
  range: PrimarySequenceSelection,
  center: number
) {
  if (!axis.biologicalLength) return null;
  const centerColumn = Math.max(0, Math.min(axis.length - 1, Math.round(center)));
  const centerBase = Math.max(0, lowerBoundBase(axis, centerColumn + 1) - 1);
  const bases = primaryBiologicalSelectionForColumns(axis, range);
  return {
    start: bases?.start ?? centerBase,
    end: bases?.end ?? centerBase,
    centerColumn: centerBase,
  };
}

function readCallAtColumn(
  lane: Extract<SharedSequenceReadLane, { kind: 'sanger' }>,
  column: number
) {
  const first = lane.baseToColumn[0];
  const virtual = lane.cycleLength
    ? column + Math.ceil((first - column) / lane.cycleLength) * lane.cycleLength
    : column;
  const index = lane.baseToColumn.indexOf(virtual);
  const base = lane.sequence[index];
  return base
    ? {
        base,
        position: (lane.sourceBaseIndices?.[index] ?? index) + 1,
        quality: lane.quality?.[index],
        sample: lane.sourcePeakPositions?.[index] ?? lane.trace.peakPositions[index],
      }
    : null;
}

export function readSelectionForColumns(
  lane: SharedSequenceReadLane,
  range: PrimarySequenceSelection
) {
  if (lane.kind === 'alignment') {
    const start = Math.max(0, Math.min(range.start, range.end));
    const end = Math.max(range.start, range.end);
    const bases = lane.alignedQuery.slice(start, end + 1).replace(/-/g, '');
    if (!bases) return null;
    const first = lane.alignedQuery.slice(0, start).replace(/-/g, '').length + 1;
    return { bases, first, last: first + bases.length - 1, quality: undefined, sample: undefined };
  }
  const call = readCallAtColumn(lane, range.start);
  if (!call || range.start !== range.end) return null;
  return {
    bases: call.base,
    first: call.position,
    last: call.position,
    quality: call.quality,
    sample: call.sample,
  };
}

export function searchColumnRanges(axis: SharedSequenceAxis, matches: readonly SearchMatch[]) {
  const biological = matches
    .flatMap((match) => {
      if (match.protein?.segments.length)
        return match.protein.segments.map(({ start, end }) => ({ start, end: end - 1 }));
      return match.wraps
        ? [
            { start: match.start, end: axis.biologicalLength - 1 },
            { start: 0, end: match.end },
          ]
        : [{ start: match.start, end: match.end }];
    })
    .sort((a, b) => a.start - b.start);
  const ranges: { start: number; end: number }[] = [];
  let consumed = -1;
  for (const range of biological) {
    let first = Math.max(range.start, consumed + 1, 0);
    const last = Math.min(axis.biologicalLength - 1, range.end);
    while (first <= last) {
      const column = axis.bioToColumn(first);
      if (column == null) break;
      let low = first;
      let high = last;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (axis.bioToColumn(mid) === column + mid - first) low = mid;
        else high = mid - 1;
      }
      const end = column + low - first + 1;
      const previous = ranges.at(-1);
      if (previous?.end === column) previous.end = end;
      else ranges.push({ start: column, end });
      first = low + 1;
    }
    consumed = Math.max(consumed, last);
  }
  return ranges;
}
