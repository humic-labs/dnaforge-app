import type { InsertedRange } from './types';

export interface DraftPositionMap {
  originalPositionOf(draftPosition: number): number | null;
  originalCodonPositionOf(first: number, second: number, third: number): number | null;
}

export function draftPositionMap(insertedRanges: readonly InsertedRange[]): DraftPositionMap {
  const sorted = insertedRanges
    .filter((range) => range.end > range.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  const ranges: InsertedRange[] = [];
  for (const range of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && range.start <= last.end) {
      if (range.end > last.end) ranges[ranges.length - 1] = { start: last.start, end: range.end };
      continue;
    }
    ranges.push({ start: range.start, end: range.end });
  }
  const shiftBefore: number[] = [];
  let running = 0;
  for (const range of ranges) {
    shiftBefore.push(running);
    running += range.end - range.start;
  }

  const originalPositionOf = (draftPosition: number): number | null => {
    if (ranges.length === 0) return draftPosition;
    let low = 0;
    let high = ranges.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (ranges[mid].start <= draftPosition) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found === -1) return draftPosition;
    if (draftPosition < ranges[found].end) return null;
    return draftPosition - (shiftBefore[found] + (ranges[found].end - ranges[found].start));
  };

  return {
    originalPositionOf,
    originalCodonPositionOf(first, second, third) {
      const mapped = [
        originalPositionOf(first),
        originalPositionOf(second),
        originalPositionOf(third),
      ];
      if (mapped.some((position) => position === null)) return null;
      const sorted = (mapped as number[]).slice().sort((a, b) => a - b);
      if (sorted[1] !== sorted[0] + 1 || sorted[2] !== sorted[1] + 1) return null;
      return sorted[0];
    },
  };
}
