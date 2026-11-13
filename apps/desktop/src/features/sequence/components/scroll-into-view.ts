export interface ScrollOffsetInput {
  rowTop: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  margin: number;
}

export function scrollOffsetForRow({
  rowTop,
  rowHeight,
  viewportHeight,
  scrollTop,
  margin,
}: ScrollOffsetInput): number | null {
  if (viewportHeight <= 0) return null;

  const visibleTop = scrollTop + margin;
  const visibleBottom = scrollTop + viewportHeight;
  const rowBottom = rowTop + rowHeight;

  if (rowTop >= visibleTop && rowBottom <= visibleBottom) return null;

  const target = Math.max(0, rowTop - margin);
  if (target === scrollTop) return null;

  return target;
}
