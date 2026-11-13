import type { LayoutNode } from '../types';

export const PINNED_CHAT_PANEL_MIN_WIDTH_PX = 487;
const CANVAS_PANEL_MIN_WIDTH_PX = 10;
const CANVAS_SEPARATOR_WIDTH_PX = 4;

export function requiredWidthForPinnedHistory(
  node: LayoutNode,
  targetPanelId: string
): number | null {
  if (node.type === 'panel') {
    return node.panelId === targetPanelId ? PINNED_CHAT_PANEL_MIN_WIDTH_PX : null;
  }

  for (const child of node.children) {
    const targetWidth = requiredWidthForPinnedHistory(child, targetPanelId);
    if (targetWidth === null) continue;
    if (node.direction === 'horizontal') return targetWidth;
    return (
      targetWidth +
      CANVAS_PANEL_MIN_WIDTH_PX * (node.children.length - 1) +
      CANVAS_SEPARATOR_WIDTH_PX * (node.children.length - 1)
    );
  }
  return null;
}
