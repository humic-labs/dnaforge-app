export function biologicalColumn(virtualCol: number, columnCount: number): number {
  return ((virtualCol % columnCount) + columnCount) % columnCount;
}

export function effectiveEnd(
  start: number,
  end: number,
  columnCount: number,
  isCircular: boolean
): number {
  if (isCircular && end < start) return end + columnCount;
  return end;
}

export function rangeIntersectsViewport(
  start: number,
  end: number,
  viewportStart: number,
  viewportEnd: number,
  columnCount: number,
  isCircular: boolean
): boolean {
  const effEnd = effectiveEnd(start, end, columnCount, isCircular);
  if (start <= viewportEnd && effEnd >= viewportStart) return true;
  if (!isCircular) return false;
  const shiftedStartPos = start + columnCount;
  const shiftedEndPos = effEnd + columnCount;
  if (shiftedStartPos <= viewportEnd && shiftedEndPos >= viewportStart) return true;
  const shiftedStartNeg = start - columnCount;
  const shiftedEndNeg = effEnd - columnCount;
  if (shiftedStartNeg <= viewportEnd && shiftedEndNeg >= viewportStart) return true;
  return false;
}

export function isCrossCycleDrag(
  anchorVirtual: number,
  currentVirtual: number,
  columnCount: number
): boolean {
  return Math.floor(anchorVirtual / columnCount) !== Math.floor(currentVirtual / columnCount);
}
