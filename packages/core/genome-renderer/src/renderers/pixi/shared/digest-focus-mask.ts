export interface DigestFocusMaskSegment {
  start: number;
  end: number;
}

function clampBp(value: number, genomeLength: number): number {
  return Math.max(0, Math.min(genomeLength, value));
}

export function digestFocusMaskSegments(
  range: readonly [number, number] | null | undefined,
  genomeLength: number
): DigestFocusMaskSegment[] {
  if (!range || genomeLength <= 0) return [];

  const start = clampBp(range[0], genomeLength);
  const end = clampBp(range[1], genomeLength);
  if (start === end) return [];

  if (end > start) {
    const segments: DigestFocusMaskSegment[] = [];
    if (start > 0) segments.push({ start: 0, end: start });
    if (end < genomeLength) segments.push({ start: end, end: genomeLength });
    return segments;
  }

  return [{ start: end, end: start }];
}
