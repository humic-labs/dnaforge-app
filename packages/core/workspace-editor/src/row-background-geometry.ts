import { ROW_BOTTOM_PADDING, ROW_TOP_PADDING } from './layout-constants';
import { rowPaintBounds } from './predictive-wrap-layout';
import type { LinePositions } from './types';

export function rowBackgroundBounds(positions: Pick<LinePositions, 'annotationY' | 'lineEndY'>): {
  y: number;
  height: number;
} {
  return {
    y: positions.annotationY - ROW_TOP_PADDING,
    height: positions.lineEndY - positions.annotationY + ROW_TOP_PADDING + ROW_BOTTOM_PADDING,
  };
}

export function paintedRowBackgroundBounds(
  positions: Pick<LinePositions, 'line' | 'annotationY' | 'lineEndY'>,
  scrollTop = 0
): { y: number; height: number } {
  const bounds = rowBackgroundBounds(positions);
  const painted = rowPaintBounds(positions.line, bounds.y + scrollTop, bounds.height);
  return {
    y: painted.y - scrollTop + (positions.line.stripeTopOffsetPx ?? 0),
    height: Math.max(0, painted.height - (positions.line.stripeInsetPx ?? 0)),
  };
}
