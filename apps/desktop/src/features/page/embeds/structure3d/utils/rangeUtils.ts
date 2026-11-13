export function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length <= 1) return ranges;

  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];

    if (current[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

export function addPositionToRanges(
  ranges: [number, number][],
  position: number
): [number, number][] {
  for (const [start, end] of ranges) {
    if (position >= start && position <= end) {
      return ranges;
    }
  }

  const newRanges: [number, number][] = [...ranges, [position, position]];
  return mergeRanges(newRanges);
}

export function isPositionInRanges(ranges: [number, number][], position: number): boolean {
  for (const [start, end] of ranges) {
    if (position >= start && position <= end) {
      return true;
    }
  }
  return false;
}

export function togglePositionInRanges(
  ranges: [number, number][],
  position: number
): [number, number][] {
  if (isPositionInRanges(ranges, position)) {
    return removePositionFromRanges(ranges, position);
  } else {
    return addPositionToRanges(ranges, position);
  }
}

export function removePositionFromRanges(
  ranges: [number, number][],
  position: number
): [number, number][] {
  const result: [number, number][] = [];

  for (const [start, end] of ranges) {
    if (position < start || position > end) {
      result.push([start, end]);
      // eslint-disable-next-line no-empty
    } else if (position === start && position === end) {
    } else if (position === start) {
      result.push([start + 1, end]);
    } else if (position === end) {
      result.push([start, end - 1]);
    } else {
      result.push([start, position - 1]);
      result.push([position + 1, end]);
    }
  }

  return result;
}

export function positionsToRanges(positions: number[]): [number, number][] {
  if (positions.length === 0) return [];

  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === rangeEnd + 1) {
      rangeEnd = sorted[i];
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
    }
  }
  ranges.push([rangeStart, rangeEnd]);

  return ranges;
}
