import type { LayoutSnapshot2D } from './types';

export function offsetLayoutViewport(layout: LayoutSnapshot2D, offset: number): LayoutSnapshot2D {
  const delta = offset - (layout.viewportOriginOffset ?? 0);
  if (!delta) return layout;
  const totalHeight = layout.totalHeight + delta;
  return {
    ...layout,
    viewportOriginOffset: offset,
    totalHeight,
    lines: layout.lines.map((row) => ({ ...row, y: row.y + delta })),
    realRowsStartY: layout.realRowsStartY === undefined ? undefined : layout.realRowsStartY + delta,
    bottomBufferStartY:
      layout.bottomBufferStartY === undefined ? undefined : layout.bottomBufferStartY + delta,
    summary: layout.summary
      ? {
          ...layout.summary,
          topPaddingPx: layout.summary.topPaddingPx + delta,
          avgRowHeight: totalHeight / Math.max(1, layout.summary.totalRows),
          rowYOffsets: Float64Array.from(layout.summary.rowYOffsets, (y) => y + delta),
        }
      : undefined,
  };
}

export function linearScrollEndGeometry(layout: LayoutSnapshot2D, viewportHeight: number) {
  const summary = layout.summary;
  const lastIndex = (summary?.totalRows ?? layout.lines.length) - 1;
  const lastLine = layout.lines.find((row) => row.lineIndex === lastIndex);
  const lastRowHeight =
    summary?.rowHeights[lastIndex] ??
    Math.max(0, layout.totalHeight - (lastLine?.y ?? layout.totalHeight) - 32);
  const lastRowTop = summary?.rowYOffsets[lastIndex] ?? lastLine?.y ?? 0;
  const headroom =
    layout.isCircular || viewportHeight <= 0
      ? 0
      : Math.max(0, lastRowTop + lastRowHeight / 2 + viewportHeight / 2 - layout.totalHeight);
  return { headroom, lastRowHeight, lastRowTop, totalHeight: layout.totalHeight, viewportHeight };
}
