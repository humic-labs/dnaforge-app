import type { Layout2DRow, SequenceLayoutSummary } from './types';
import { ROW_TOP_PADDING } from './layout-constants';
import { rowPaintY } from './predictive-wrap-layout';

export function rowPresentationBounds(
  row: Layout2DRow,
  summary: SequenceLayoutSummary | undefined,
  scrollTop: number,
  surfaceHeight: number,
  fallbackBottom: number
): { top: number; bottom: number } {
  const top = rowPaintY(row, row.y - ROW_TOP_PADDING) - scrollTop;
  if (!summary) return { top, bottom: fallbackBottom };
  if (row.lineIndex === summary.totalRows - 1) return { top, bottom: surfaceHeight };
  const pitch = summary.rowYOffsets[row.lineIndex + 1] - summary.rowYOffsets[row.lineIndex];
  return {
    top,
    bottom:
      row.y + Math.max(summary.rowHeights[row.lineIndex], pitch) - ROW_TOP_PADDING - scrollTop,
  };
}
