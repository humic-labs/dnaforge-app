export const INTRON_DASH_PATTERN: [number, number] = [4, 4];
export const INTRON_STROKE_WIDTH = 1;
export const INTRON_OPACITY = 0.5;

export interface IntronLineSegment {
  lineIndex: number;
  startPos: number;
  endPos: number;
  type: 'single' | 'start' | 'middle' | 'end';
}

export function getIntronLineSegments(
  genomicStart: number,
  genomicEnd: number,
  basesPerLine: number
): IntronLineSegment[] {
  const startLine = Math.floor(genomicStart / basesPerLine);
  const endLine = Math.floor(genomicEnd / basesPerLine);

  if (startLine === endLine) {
    return [
      {
        lineIndex: startLine,
        startPos: genomicStart,
        endPos: genomicEnd,
        type: 'single',
      },
    ];
  }

  const segments: IntronLineSegment[] = [];

  segments.push({
    lineIndex: startLine,
    startPos: genomicStart,
    endPos: (startLine + 1) * basesPerLine - 1,
    type: 'start',
  });

  for (let line = startLine + 1; line < endLine; line++) {
    segments.push({
      lineIndex: line,
      startPos: line * basesPerLine,
      endPos: (line + 1) * basesPerLine - 1,
      type: 'middle',
    });
  }

  segments.push({
    lineIndex: endLine,
    startPos: endLine * basesPerLine,
    endPos: genomicEnd,
    type: 'end',
  });

  return segments;
}

export function getIntronLabel(intronNumber: number, lengthBp: number): string {
  return `intron ${intronNumber} (${lengthBp} bp)`;
}

export function getResidueNumberVisibility(
  residueIndex: number,
  cellWidth: number,
  fontSize: number,
  isIntronBoundary = false
): boolean {
  if (isIntronBoundary) return true;

  const availableWidth = cellWidth * 3;
  const digitCount = Math.floor(Math.log10(Math.max(residueIndex, 1))) + 1;
  const charWidth = fontSize * 0.6;
  const requiredWidth = digitCount * charWidth + 4;

  if (availableWidth >= requiredWidth) {
    return true;
  }

  const interval = availableWidth >= requiredWidth * 0.6 ? 5 : 10;
  return residueIndex % interval === 0;
}
