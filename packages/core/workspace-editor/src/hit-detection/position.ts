import type { Layout2DRow } from '../types';
import type { SelectionRange } from '../selection-model';
import { calculateLineTrackBounds } from './track-bounds';
import type { HitDetectionConfig, HitTargetHandle, LineAndPosition } from './types';

export function detectHandleHit(
  position: number,
  currentSelection: SelectionRange | null,
  tolerance: number = 1
): HitTargetHandle | null {
  if (!currentSelection || currentSelection.start === currentSelection.end) {
    return null;
  }

  const selStart = currentSelection.wraps
    ? currentSelection.start
    : Math.min(currentSelection.start, currentSelection.end);
  const selEnd = currentSelection.wraps
    ? currentSelection.end
    : Math.max(currentSelection.start, currentSelection.end);

  if (Math.abs(position - selStart) <= tolerance) {
    return {
      type: 'handle',
      edge: 'start',
      selection: currentSelection,
    };
  }

  if (Math.abs(position - (selEnd + 1)) <= tolerance) {
    return {
      type: 'handle',
      edge: 'end',
      selection: currentSelection,
    };
  }

  return null;
}

export function canvasPointFromClient(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top'>
): { x: number; y: number } {
  return { x: Math.floor(clientX) - rect.left, y: Math.floor(clientY) - rect.top };
}

export function getPositionFromX(
  mouseX: number,
  line: Layout2DRow,
  config: HitDetectionConfig,
  _seqLen: number
): number | null {
  mouseX -= line.xOffset ?? 0;
  if (mouseX < config.marginLeft - 5) {
    return null;
  }

  const charIndex = Math.floor((mouseX - config.marginLeft) / config.charWidth);
  const clampedIndex = Math.max(0, Math.min(charIndex, line.sequence.length - 1));

  if (line.preOriginLength !== undefined && clampedIndex >= line.preOriginLength) {
    return clampedIndex - line.preOriginLength;
  }

  return line.startPos + clampedIndex;
}

export function getCursorColumnFromX(
  mouseX: number,
  line: Pick<Layout2DRow, 'sequence' | 'xOffset'>,
  config: Pick<HitDetectionConfig, 'marginLeft' | 'charWidth'>
): number {
  const column = Math.round((mouseX - config.marginLeft - (line.xOffset ?? 0)) / config.charWidth);
  return Math.max(0, Math.min(column, line.sequence.length));
}

export function getCursorPositionFromX(
  mouseX: number,
  line: Layout2DRow,
  config: Pick<HitDetectionConfig, 'marginLeft' | 'charWidth'>
): number | null {
  if (mouseX < config.marginLeft + (line.xOffset ?? 0) - 5) return null;
  const column = getCursorColumnFromX(mouseX, line, config);
  if (line.preOriginLength !== undefined && column >= line.preOriginLength) {
    return column - line.preOriginLength;
  }
  return line.startPos + column;
}

const ROW_GAP = 32;

export function findLineAtY(
  contentY: number,
  lines: Layout2DRow[],
  totalHeight: number
): Layout2DRow | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1];
    const lineEnd = nextLine ? nextLine.y : totalHeight;

    if (contentY >= line.y && contentY < lineEnd) {
      const paintedBands = line.trackMorph?.painted;
      const paintedHeight =
        (paintedBands && paintedBands[paintedBands.length - 1]) ??
        (line.naturalHeight === undefined
          ? undefined
          : line.naturalHeight * (line.heightScale ?? 1));
      const paintedEnd = paintedHeight === undefined ? lineEnd - ROW_GAP : line.y + paintedHeight;
      if (nextLine && contentY >= paintedEnd) {
        return nextLine;
      }
      return line;
    }
  }
  return null;
}

export function getLineAndPosition(
  mouseX: number,
  mouseY: number,
  scrollTop: number,
  lines: Layout2DRow[],
  totalHeight: number,
  config: HitDetectionConfig,
  seqLen: number
): LineAndPosition | null {
  const contentY = mouseY + scrollTop;

  const line = findLineAtY(contentY, lines, totalHeight);
  if (!line) {
    return null;
  }
  const lineIndex = lines.indexOf(line);

  const position = getPositionFromX(mouseX, line, config, seqLen);
  if (position === null) {
    return null;
  }

  return {
    line,
    lineIndex,
    position,
    mouseX,
    contentY,
  };
}

export function findLineIndex(line: Layout2DRow, lines: Layout2DRow[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === line || lines[i].startPos === line.startPos) {
      return i;
    }
  }
  return -1;
}

export function isOnNucleotideRow(
  mouseY: number,
  scrollTop: number,
  line: Layout2DRow,
  config: HitDetectionConfig,
  showReverseComplement: boolean,
  hasForwardPrimers: boolean,
  hasReversePrimers: boolean
): boolean {
  const contentY = mouseY + scrollTop;
  const bounds = calculateLineTrackBounds(
    line,
    config,
    showReverseComplement,
    hasForwardPrimers,
    hasReversePrimers
  );

  const relativeY = contentY - line.y;
  const inForwardStrand =
    relativeY >= bounds.sequenceY && relativeY < bounds.sequenceY + bounds.sequenceHeight;
  const inComplement =
    bounds.complementHeight > 0 &&
    relativeY >= bounds.complementY &&
    relativeY < bounds.complementY + bounds.complementHeight;
  return inForwardStrand || inComplement;
}
