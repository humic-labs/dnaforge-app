import type {
  LayoutSnapshot2D,
  Layout2DRow,
  SequenceLayoutSummary,
  WorkspaceEditorConfig,
  PrimerDisplay,
} from './types';
import { calculateLinePositions } from './line-positions';
import { rowPaintY } from './predictive-wrap-layout';
import { gappedToBio, bioToGapped } from './coordinate-space';
import { positionWithinLine } from './cds-extension-affordance';

export function hasCircularScrollBuffers(layout: LayoutSnapshot2D | null): boolean {
  if (!layout || !layout.lines.length) return false;

  if (layout.summary) {
    return (
      layout.summary.isCircular &&
      layout.summary.topBufferCount > 0 &&
      layout.summary.bottomBufferCount > 0 &&
      layout.summary.topBufferCount < layout.summary.totalRows &&
      layout.summary.topBufferCount + layout.summary.realRowCount < layout.summary.totalRows
    );
  }

  const firstRealRowIndex = layout.firstRealRowIndex ?? 0;
  const firstBottomBufferIndex = layout.firstBottomBufferIndex ?? layout.lines.length;
  return firstRealRowIndex > 0 && firstBottomBufferIndex < layout.lines.length;
}

export function continuousCircularScrollY(
  pos: number,
  layout: LayoutSnapshot2D | null
): number | null {
  if (!layout || !hasCircularScrollBuffers(layout)) return null;
  const summary = layout.summary;
  if (!summary || summary.realRowCount <= 0) return null;

  const realStartY = layout.realRowsStartY ?? 0;
  const realSpan = (layout.bottomBufferStartY ?? 0) - realStartY;
  const seqLen = summary.seqLength || layout.sequenceLength || 1;
  if (!(realSpan > 0) || !(seqLen > 0)) return null;

  const pxPerBp = realSpan / seqLen;
  const dBp = (((pos - summary.topBp) % seqLen) + seqLen) % seqLen;
  return realStartY + dBp * pxPerBp;
}

export function absoluteRowIndexForBp(bp: number, summary: SequenceLayoutSummary): number {
  const { cpr, seqLength, isCircular, topBp, topBufferCount, realRowCount } = summary;
  if (cpr <= 0 || seqLength <= 0 || realRowCount <= 0) return -1;

  let normBp: number;
  if (isCircular) {
    normBp = ((bp % seqLength) + seqLength) % seqLength;
  } else {
    if (bp < 0 || bp >= seqLength) return -1;
    normBp = bp;
  }

  const diff = isCircular
    ? (((normBp - topBp) % seqLength) + seqLength) % seqLength
    : normBp - topBp;
  if (!isCircular && diff < 0) return -1;
  const effectiveIndex = Math.floor(diff / cpr);
  if (effectiveIndex < 0 || effectiveIndex >= realRowCount) {
    return -1;
  }
  return topBufferCount + effectiveIndex;
}

export function bpForAbsoluteRowIndex(rowIndex: number, summary: SequenceLayoutSummary): number {
  const { cpr, seqLength, isCircular, topBp, topBufferCount, totalRows } = summary;
  if (rowIndex < 0 || rowIndex >= totalRows) return -1;
  const effectiveIndex = rowIndex - topBufferCount;
  const raw = topBp + effectiveIndex * cpr;
  if (isCircular) {
    return ((raw % seqLength) + seqLength) % seqLength;
  }
  return Math.max(0, Math.min(seqLength - 1, raw));
}

export function approximateYForAbsoluteRowIndex(
  rowIndex: number,
  summary: SequenceLayoutSummary
): number {
  if (rowIndex <= 0) return summary.topPaddingPx;
  return summary.topPaddingPx + rowIndex * (summary.avgRowHeight + summary.rowGapPx);
}

export function approximateAbsoluteRowIndexForY(y: number, summary: SequenceLayoutSummary): number {
  if (y <= summary.topPaddingPx) return 0;
  const perRow = summary.avgRowHeight + summary.rowGapPx;
  if (perRow <= 0) return 0;
  const idx = Math.floor((y - summary.topPaddingPx) / perRow);
  return Math.max(0, Math.min(summary.totalRows - 1, idx));
}

export function yForAbsoluteRowIndex(rowIndex: number, summary: SequenceLayoutSummary): number {
  if (rowIndex <= 0) return summary.rowYOffsets[0] ?? summary.topPaddingPx;
  const clamped = Math.min(rowIndex, summary.totalRows);
  return summary.rowYOffsets[clamped] ?? summary.topPaddingPx;
}

export function absoluteRowIndexForY(y: number, summary: SequenceLayoutSummary): number {
  const offsets = summary.rowYOffsets;
  if (offsets.length === 0) return 0;
  if (y <= offsets[0]) return 0;
  if (y >= offsets[summary.totalRows]) return Math.max(0, summary.totalRows - 1);
  let lo = 0;
  let hi = summary.totalRows;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function rowPitchPx(rowIndex: number, summary: SequenceLayoutSummary): number {
  const top = yForAbsoluteRowIndex(rowIndex, summary);
  const bottom = yForAbsoluteRowIndex(Math.min(rowIndex + 1, summary.totalRows), summary);
  return Math.max(1, bottom - top);
}

export function yForBp(bp: number, summary: SequenceLayoutSummary): number | null {
  const rowIndex = absoluteRowIndexForBp(bp, summary);
  if (rowIndex < 0) return null;
  return yForAbsoluteRowIndex(rowIndex, summary);
}

export function bpForY(y: number, summary: SequenceLayoutSummary): number {
  const rowIndex = absoluteRowIndexForY(y, summary);
  return bpForAbsoluteRowIndex(rowIndex, summary);
}

export function findLineByAbsoluteIndex(
  lines: Layout2DRow[],
  rowIndex: number
): Layout2DRow | undefined {
  const direct = lines[rowIndex];
  if (direct?.lineIndex === rowIndex) return direct;
  return lines.find((line) => line.lineIndex === rowIndex);
}

function inferCharsInRow(rowIndex: number, summary: SequenceLayoutSummary): number {
  if (summary.isCircular) return summary.cpr;
  const rowStart = bpForAbsoluteRowIndex(rowIndex, summary);
  if (rowStart < 0) return summary.cpr;
  return Math.max(1, Math.min(summary.cpr, summary.seqLength - rowStart));
}

export function getSequencePositionAtScrollY(
  scrollY: number,
  layout: LayoutSnapshot2D | null
): number | null {
  if (!layout || !layout.lines.length) return null;
  if (layout.summary?.rowYOffsets?.length) {
    const summary = layout.summary;
    const rowIndex = absoluteRowIndexForY(scrollY, summary);
    const rowTop = yForAbsoluteRowIndex(rowIndex, summary);
    const rowHeight = rowPitchPx(rowIndex, summary);
    const line = findLineByAbsoluteIndex(layout.lines, rowIndex);
    const rowStart = line?.startPos ?? bpForAbsoluteRowIndex(rowIndex, summary);
    const charsInRow = line?.sequence.length ?? inferCharsInRow(rowIndex, summary);
    if (rowHeight <= 0 || charsInRow <= 0) return rowStart;
    const progressInLine = Math.max(0, Math.min(1, (scrollY - rowTop) / rowHeight));
    const charOffset = Math.floor(progressInLine * charsInRow);
    return (rowStart + charOffset) % (layout.sequenceLength || summary.seqLength || 1);
  }

  const lineIndex = layout.lines.findIndex((line, idx) => {
    const nextLine = layout.lines[idx + 1];
    const lineBottom = nextLine ? nextLine.y : line.y + 100;
    return scrollY >= line.y && scrollY < lineBottom;
  });

  if (lineIndex === -1) {
    if (scrollY < layout.lines[0].y) return layout.lines[0].startPos;
    return layout.lines[layout.lines.length - 1].endPos;
  }

  const line = layout.lines[lineIndex];
  const nextLine = layout.lines[lineIndex + 1];
  const lineHeight = nextLine ? nextLine.y - line.y : 100;

  if (lineHeight <= 0) return line.startPos;

  const progressInLine = Math.max(0, Math.min(1, (scrollY - line.y) / lineHeight));
  const charOffset = Math.floor(progressInLine * line.sequence.length);

  return (line.startPos + charOffset) % (layout.sequenceLength || 1);
}

export function nearestRowCopyForBp(
  layout: {
    lines: ReadonlyArray<{ lineIndex: number; startPos: number; endPos: number; y: number }>;
  } | null,
  bp: number,
  scrollTop: number
): { lineIndex: number; offsetPx: number } | null {
  if (!layout) return null;
  let best: { lineIndex: number; offsetPx: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of layout.lines) {
    if (!positionWithinLine(line.startPos, line.endPos, bp)) continue;
    const offsetPx = line.y - scrollTop;
    const distance = Math.abs(offsetPx);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { lineIndex: line.lineIndex, offsetPx };
    }
  }
  return best;
}

export function getScrollYForSequencePosition(
  position: number,
  layout: LayoutSnapshot2D | null,
  preferRealRows: boolean = false,
  positionAnchor: 'start' | 'center' = 'start'
): number | null {
  if (!layout || !layout.lines.length) return null;
  const withinPosition = positionAnchor === 'center' ? 0.5 : 0;
  if (layout.summary && layout.lines.length !== layout.summary.totalRows) {
    const rowTop = yForBp(position, layout.summary);
    if (rowTop === null) return null;
    const rowIndex = absoluteRowIndexForBp(position, layout.summary);
    const rowStart = rowIndex >= 0 ? bpForAbsoluteRowIndex(rowIndex, layout.summary) : position;
    const rowHeight = rowIndex >= 0 ? rowPitchPx(rowIndex, layout.summary) : 0;
    const seqLen = layout.summary.seqLength || 1;
    const offset =
      rowStart <= position
        ? position - rowStart
        : seqLen - rowStart + (((position % seqLen) + seqLen) % seqLen);
    const progress = Math.max(
      0,
      Math.min(1, (offset + withinPosition) / Math.max(1, layout.summary.cpr))
    );
    return rowTop + progress * rowHeight;
  }

  const seqLen = layout.sequenceLength || 1;
  const normalizedPos = ((position % seqLen) + seqLen) % seqLen;

  const checkLine = (line: (typeof layout.lines)[0], idx: number): number | null => {
    let containsPosition: boolean;
    if (line.startPos <= line.endPos) {
      containsPosition = normalizedPos >= line.startPos && normalizedPos <= line.endPos;
    } else {
      containsPosition = normalizedPos >= line.startPos || normalizedPos <= line.endPos;
    }

    if (containsPosition) {
      const nextLine = layout.lines[idx + 1];
      const lineHeight = nextLine ? nextLine.y - line.y : 100;

      if (lineHeight <= 0) return line.y;

      let charOffset: number;
      if (line.startPos <= line.endPos) {
        charOffset = normalizedPos - line.startPos;
      } else if (normalizedPos >= line.startPos) {
        charOffset = normalizedPos - line.startPos;
      } else {
        charOffset = seqLen - line.startPos + normalizedPos;
      }

      const progressInLine = (charOffset + withinPosition) / line.sequence.length;
      return line.y + progressInLine * lineHeight;
    }
    return null;
  };

  if (preferRealRows) {
    const { firstRealRowIndex = 0, firstBottomBufferIndex = layout.lines.length } = layout;

    for (let i = firstRealRowIndex; i < firstBottomBufferIndex; i++) {
      const result = checkLine(layout.lines[i], i);
      if (result !== null) return result;
    }
  }

  for (let i = 0; i < layout.lines.length; i++) {
    const result = checkLine(layout.lines[i], i);
    if (result !== null) return result;
  }

  return null;
}

export function calculateVisibleRange(
  scrollTop: number,
  viewportHeight: number,
  lines: Layout2DRow[],
  sequenceLength: number,
  isCircular: boolean,
  summary?: SequenceLayoutSummary
): { startPos: number; endPos: number } | null {
  if (!lines.length || sequenceLength === 0) return null;
  if (summary?.rowYOffsets?.length) {
    const viewportBottom = scrollTop + viewportHeight;
    const firstVisibleIdx = absoluteRowIndexForY(scrollTop, summary);
    const lastVisibleIdx = absoluteRowIndexForY(viewportBottom, summary);
    const firstLine = findLineByAbsoluteIndex(lines, firstVisibleIdx);
    const rowTop = yForAbsoluteRowIndex(firstVisibleIdx, summary);
    const firstLineHeight = rowPitchPx(firstVisibleIdx, summary);
    const charsInFirstLine =
      firstLine?.sequence.length ?? inferCharsInRow(firstVisibleIdx, summary);
    const rowStartPos = firstLine?.startPos ?? bpForAbsoluteRowIndex(firstVisibleIdx, summary);

    const firstLineProgress = Math.max(0, Math.min(1, (scrollTop - rowTop) / firstLineHeight));
    const startOffset = Math.floor(firstLineProgress * charsInFirstLine);
    const startPos = (rowStartPos + startOffset) % sequenceLength;

    const visibleLineCount = Math.max(1, lastVisibleIdx - firstVisibleIdx + 1);
    const visibleTop = yForAbsoluteRowIndex(firstVisibleIdx, summary);
    const visibleBottom = yForAbsoluteRowIndex(
      Math.min(lastVisibleIdx + 1, summary.totalRows),
      summary
    );
    const avgLineHeight = Math.max(1, (visibleBottom - visibleTop) / visibleLineCount);
    const viewportSizeInBases = Math.round((viewportHeight / avgLineHeight) * charsInFirstLine);

    const endPos = isCircular
      ? (startPos + viewportSizeInBases) % sequenceLength
      : Math.min(startPos + viewportSizeInBases, sequenceLength);

    return { startPos, endPos: endPos || sequenceLength };
  }

  const viewportBottom = scrollTop + viewportHeight;

  let firstVisibleIdx = lines.findIndex((line, idx) => {
    const nextLine = lines[idx + 1];
    const lineBottom = nextLine ? nextLine.y : line.y + 100;
    return lineBottom > scrollTop;
  });
  if (firstVisibleIdx === -1) firstVisibleIdx = 0;

  let lastVisibleIdx = lines.findIndex((line) => line.y >= viewportBottom);
  if (lastVisibleIdx === -1) lastVisibleIdx = lines.length - 1;
  else if (lastVisibleIdx > 0) lastVisibleIdx--;

  const firstLine = lines[firstVisibleIdx];
  const lastLine = lines[lastVisibleIdx];
  const nextAfterFirst = lines[firstVisibleIdx + 1];
  const nextAfterLast = lines[lastVisibleIdx + 1];

  const firstLineHeight = nextAfterFirst ? nextAfterFirst.y - firstLine.y : 100;
  const lastLineHeight = nextAfterLast ? nextAfterLast.y - lastLine.y : 100;

  const firstLineProgress = Math.max(0, Math.min(1, (scrollTop - firstLine.y) / firstLineHeight));
  const charsInFirstLine = firstLine.sequence.length;
  const startOffset = Math.floor(firstLineProgress * charsInFirstLine);
  const startPos = (firstLine.startPos + startOffset) % sequenceLength;

  const visibleLineCount = lastVisibleIdx - firstVisibleIdx + 1;
  const avgLineHeight =
    visibleLineCount > 0
      ? (lines[lastVisibleIdx].y - firstLine.y + lastLineHeight) / visibleLineCount
      : 100;
  const viewportSizeInBases = Math.round((viewportHeight / avgLineHeight) * charsInFirstLine);

  const endPos = isCircular
    ? (startPos + viewportSizeInBases) % sequenceLength
    : Math.min(startPos + viewportSizeInBases, sequenceLength);

  return { startPos, endPos: endPos || sequenceLength };
}

export function viewportCenterRowBoundsChanged(
  previous: LayoutSnapshot2D | null,
  current: LayoutSnapshot2D,
  centerY: number
): boolean {
  const before = previous?.summary;
  const after = current.summary;
  if (!before || !after || before.rowYOffsets === after.rowYOffsets) return false;
  const row = absoluteRowIndexForY(centerY, before);
  if (row < 0 || row >= after.totalRows) return false;
  return (
    before.rowYOffsets[row] !== after.rowYOffsets[row] ||
    before.rowYOffsets[row + 1] !== after.rowYOffsets[row + 1]
  );
}

export function captureViewportCenterPosition(
  scrollTop: number,
  clientHeight: number,
  layout: LayoutSnapshot2D | null,
  lastKnownPosition: number | null
): number | null {
  if (scrollTop > 0 && layout) {
    const scrollCenterY = scrollTop + clientHeight / 2;
    return getSequencePositionAtScrollY(scrollCenterY, layout);
  }
  return lastKnownPosition;
}

export interface SequenceTrackGeometry {
  config: WorkspaceEditorConfig;
  primers: readonly PrimerDisplay[];
}

export function getSequenceBandY(
  position: number,
  layout: LayoutSnapshot2D,
  geometry: SequenceTrackGeometry,
  viewport?: { scrollTop: number; height: number }
): number | null {
  let bestY: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of layout.lines) {
    if (!positionWithinLine(line.startPos, line.endPos, position)) continue;
    const y = rowPaintY(
      line,
      calculateLinePositions(
        line,
        geometry.config,
        geometry.primers,
        layout.sequenceLength ?? layout.summary?.seqLength ?? 0
      ).sequenceY
    );
    if (!viewport) {
      if (!line.isTopBuffer && !line.isBottomBuffer && !line.isWrapLine) return y;
      bestY ??= y;
      continue;
    }
    const screenY = y - viewport.scrollTop;
    if (screenY < 0 || screenY > viewport.height) continue;
    const distance = Math.abs(screenY - viewport.height / 2);
    if (distance < bestDistance) {
      bestY = y;
      bestDistance = distance;
    }
  }
  return bestY;
}

export function captureSelectionScreenAnchor(
  scrollTop: number,
  clientHeight: number,
  layout: LayoutSnapshot2D | null,
  selectionStartBp: number,
  geometry?: SequenceTrackGeometry
): { position: number; anchorOffsetPx: number } | null {
  if (!layout || !layout.lines.length) return null;
  if (!Number.isFinite(selectionStartBp) || selectionStartBp < 0) return null;
  const rowY = geometry
    ? getSequenceBandY(selectionStartBp, layout, geometry, { scrollTop, height: clientHeight })
    : getScrollYForSequencePosition(selectionStartBp, layout, true);
  if (rowY === null) return null;
  const screenY = rowY - scrollTop;
  if (screenY < 0 || screenY > clientHeight) return null;
  return { position: selectionStartBp, anchorOffsetPx: screenY };
}

export function convertScrollPosition(
  position: number,
  wasCapturedInGapped: boolean,
  currentlyGapped: boolean,
  capturedGappedSequence?: string,
  currentGappedSequence?: string
): number {
  if (wasCapturedInGapped && !currentlyGapped && capturedGappedSequence) {
    let col = position;
    let bioPos = gappedToBio(col, capturedGappedSequence);
    if (bioPos < 0) {
      while (col > 0 && bioPos < 0) {
        col--;
        bioPos = gappedToBio(col, capturedGappedSequence);
      }
      if (bioPos < 0) {
        col = position + 1;
        while (col < capturedGappedSequence.length && bioPos < 0) {
          bioPos = gappedToBio(col, capturedGappedSequence);
          if (bioPos < 0) col++;
        }
      }
    }
    if (bioPos > 0) {
      return bioPos - 1;
    }
  } else if (!wasCapturedInGapped && currentlyGapped && currentGappedSequence) {
    const col = bioToGapped(position + 1, currentGappedSequence);
    if (col >= 0) {
      return col;
    }
  }

  return position;
}
