import type { SharedSequenceAxis } from './shared-sequence-read-model';

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
