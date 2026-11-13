export interface WireRange {
  start: number;
  end: number;
}

export function displayRangeToWire(
  startText: string,
  endText: string,
  sequenceLength: number
): WireRange | null {
  const startNum = Number.parseInt(startText.trim(), 10);
  const endNum = Number.parseInt(endText.trim(), 10);
  if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) return null;
  if (startNum < 1 || endNum < startNum) return null;
  if (sequenceLength > 0 && endNum > sequenceLength) return null;
  return { start: startNum - 1, end: endNum };
}
