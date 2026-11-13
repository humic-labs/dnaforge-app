export interface MutedRangeSegment {
  start: number;
  end: number;
  muted: boolean;
}

export const DEFAULT_MUTED_COLUMN_COLOR = '#9ca3af';

function normalizeColumn(column: number, sequenceLength?: number): number {
  if (!sequenceLength || sequenceLength <= 0) return column;
  return ((column % sequenceLength) + sequenceLength) % sequenceLength;
}

export function isMutedColumn(
  column: number,
  mutedColumns?: ReadonlySet<number>,
  sequenceLength?: number
): boolean {
  if (!mutedColumns || mutedColumns.size === 0) return false;
  return mutedColumns.has(normalizeColumn(column, sequenceLength));
}

export function rangeOverlapsMutedColumns(
  startInclusive: number,
  endExclusive: number,
  mutedColumns?: ReadonlySet<number>,
  sequenceLength?: number
): boolean {
  if (!mutedColumns || mutedColumns.size === 0) return false;
  if (endExclusive <= startInclusive) {
    if (!sequenceLength || sequenceLength <= 0 || endExclusive === startInclusive) return false;
    return (
      rangeOverlapsMutedColumns(startInclusive, sequenceLength, mutedColumns, sequenceLength) ||
      rangeOverlapsMutedColumns(0, endExclusive, mutedColumns, sequenceLength)
    );
  }

  for (let column = startInclusive; column < endExclusive; column++) {
    if (isMutedColumn(column, mutedColumns, sequenceLength)) return true;
  }
  return false;
}

export function splitRangeByMutedColumns(
  startInclusive: number,
  endExclusive: number,
  mutedColumns?: ReadonlySet<number>,
  sequenceLength?: number
): MutedRangeSegment[] {
  if (endExclusive <= startInclusive) return [];
  if (!mutedColumns || mutedColumns.size === 0) {
    return [{ start: startInclusive, end: endExclusive, muted: false }];
  }

  const segments: MutedRangeSegment[] = [];
  let segmentStart = startInclusive;
  let segmentMuted = isMutedColumn(startInclusive, mutedColumns, sequenceLength);

  for (let column = startInclusive + 1; column < endExclusive; column++) {
    const muted = isMutedColumn(column, mutedColumns, sequenceLength);
    if (muted === segmentMuted) continue;
    segments.push({ start: segmentStart, end: column, muted: segmentMuted });
    segmentStart = column;
    segmentMuted = muted;
  }

  segments.push({ start: segmentStart, end: endExclusive, muted: segmentMuted });
  return segments;
}
