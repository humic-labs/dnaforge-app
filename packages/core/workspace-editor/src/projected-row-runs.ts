export interface RowGrid {
  cpr: number;
  topBp: number;
  topBufferCount: number;
  realRowCount: number;
  totalRows: number;
  seqLength: number;
  circular: boolean;
}

export function projectedRowBreakpoints(
  current: RowGrid,
  future: RowGrid,
  futureRunStarts: readonly number[],
  anchorRow: number | null,
  anchorShift: number | null
): number[] {
  const points = new Set<number>();
  visitProjectedRowBreakpoints(current, future, futureRunStarts, anchorRow, anchorShift, (row) =>
    points.add(row)
  );
  return [...points].sort((a, b) => a - b);
}

export function visitProjectedRowBreakpoints(
  current: RowGrid,
  future: RowGrid,
  futureRunStarts: readonly number[],
  anchorRow: number | null,
  anchorShift: number | null,
  visit: (row: number) => void
): void {
  visit(0);
  visit(current.totalRows);
  const add = (row: number, lo: number, hi: number) => {
    if (row > lo && row < hi) visit(row);
  };
  const translated = (lo: number, hi: number, shift: number, ceiling = Infinity) => {
    for (const start of futureRunStarts) if (start <= ceiling) add(start - shift, lo, hi);
  };
  const bottom = current.topBufferCount + current.realRowCount;
  if (anchorShift === null || anchorRow === null) {
    visit(bottom);
    translated(0, bottom, 0, future.topBufferCount + future.realRowCount - 1);
    translated(bottom, current.totalRows, future.realRowCount - current.realRowCount);
    return;
  }
  const localStart = Math.max(0, Math.min(current.totalRows, anchorRow - 128));
  const localEnd = Math.max(0, Math.min(current.totalRows, anchorRow + 129));
  visit(localStart);
  visit(localEnd);
  translated(localStart, localEnd, anchorShift);
  const rawOrigin = current.topBp - current.topBufferCount * current.cpr - future.topBp;
  const raw = (lo: number, hi: number, circular: boolean) => {
    if (hi <= lo) return;
    const firstCycle = circular
      ? Math.floor((rawOrigin + lo * current.cpr) / current.seqLength)
      : 0;
    const lastCycle = circular
      ? Math.floor((rawOrigin + (hi - 1) * current.cpr) / current.seqLength)
      : 0;
    for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
      const shift = circular ? cycle * current.seqLength : 0;
      if (circular) add(Math.ceil((shift - rawOrigin) / current.cpr), lo, hi);
      for (const start of futureRunStarts) {
        const bp = (start - future.topBufferCount) * future.cpr;
        if (circular && (bp < 0 || bp >= current.seqLength)) continue;
        add(Math.ceil((bp + shift - rawOrigin) / current.cpr), lo, hi);
      }
    }
  };

  const cuts = [
    ...new Set([0, localStart, localEnd, current.topBufferCount, bottom, current.totalRows]),
  ].sort((a, b) => a - b);
  for (let i = 0; i < cuts.length - 1; i++) {
    const lo = cuts[i],
      hi = cuts[i + 1];
    visit(lo);
    visit(hi);
    if (lo >= localStart && hi <= localEnd) continue;
    raw(lo, hi, current.circular && lo >= current.topBufferCount && hi <= bottom);
  }
}
