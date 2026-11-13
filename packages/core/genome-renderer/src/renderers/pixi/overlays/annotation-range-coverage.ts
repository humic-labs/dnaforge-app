export type BpRange = Readonly<{ startBp: number; endBp: number }>;

export function rangesCoverInterval(
  ranges: readonly BpRange[] | null | undefined,
  viewStartBp: number,
  viewEndBp: number,
  genomeLength: number
): boolean {
  if (!ranges || ranges.length === 0) return false;
  const start = Math.max(0, Math.min(viewStartBp, viewEndBp));
  const end = Math.min(genomeLength, Math.max(viewStartBp, viewEndBp));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  let cursor = start;
  const ordered = ranges.length === 1 ? ranges : [...ranges].sort((a, b) => a.startBp - b.startBp);
  for (const range of ordered) {
    if (!Number.isFinite(range.startBp) || !Number.isFinite(range.endBp)) continue;
    if (range.endBp <= cursor) continue;
    if (range.startBp > cursor) return false;
    cursor = Math.max(cursor, range.endBp);
    if (cursor >= end) return true;
  }
  return false;
}
