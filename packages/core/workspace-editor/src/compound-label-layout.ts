export interface LabelItem {
  x: number;
  width: number;
}

export function placeCompoundLabels<T extends LabelItem>(
  items: readonly T[],
  left: number,
  right: number,
  gap = 4
): (T & { x: number; width: number })[] {
  if (!items.length || right <= left) return [];
  gap = Math.min(Math.max(0, gap), (right - left) / Math.max(1, items.length * 2));
  const available = Math.max(0, right - left - gap * (items.length - 1));
  const desired = items.reduce((sum, item) => sum + item.width, 0);
  const ratio = desired > available ? available / desired : 1;
  let cursor = left;
  const placed = items.map((item) => {
    const width = item.width * ratio;
    const x = Math.max(cursor, item.x);
    cursor = x + width + gap;
    return { ...item, x, width };
  });
  cursor = right;
  for (let i = placed.length - 1; i >= 0; i--) {
    placed[i].x = Math.max(left, Math.min(placed[i].x, cursor - placed[i].width));
    cursor = placed[i].x - gap;
  }
  return placed;
}
