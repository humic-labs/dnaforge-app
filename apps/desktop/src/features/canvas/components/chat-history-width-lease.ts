import { CHAT_FIRST_INPUT } from '../../../lib/chat-first-input';
import type { CanvasState, LayoutNode } from '../types';

export const CANVAS_PANEL_MIN_WIDTH_PX = 10;
const CHAT_MIN_WIDTH_PX = CHAT_FIRST_INPUT ? 336 : 256;
const PINNED_HISTORY_EXTRA_WIDTH_PX = 320 + 16 - 9;
const CANVAS_SEPARATOR_WIDTH_PX = 4;

export function visibleChatPanelIds({ panels }: Pick<CanvasState, 'panels'>): string[] {
  return Object.values(panels)
    .filter((panel) =>
      panel.tabs.some((tab) => tab.id === panel.activeTabId && tab.type === 'chat')
    )
    .map((panel) => panel.id);
}

export function canvasMinimumWidths(
  layout: LayoutNode,
  chatPanelIds: readonly string[],
  pinnedPanelIds: ReadonlySet<string>
): Map<LayoutNode, number> {
  const widths = new Map<LayoutNode, number>();
  if (chatPanelIds.length === 0) return widths;

  function measure(node: LayoutNode): number {
    let width = CANVAS_PANEL_MIN_WIDTH_PX;
    if (node.type === 'panel') {
      if (chatPanelIds.includes(node.panelId)) {
        width =
          CHAT_MIN_WIDTH_PX +
          (pinnedPanelIds.has(node.panelId) ? PINNED_HISTORY_EXTRA_WIDTH_PX : 0);
      }
    } else {
      const children = node.children.map(measure);
      width =
        node.direction === 'horizontal'
          ? Math.max(CANVAS_PANEL_MIN_WIDTH_PX, ...children)
          : children.reduce((total, child) => total + child, 0) +
            CANVAS_SEPARATOR_WIDTH_PX * (children.length - 1);
    }
    widths.set(node, width);
    return width;
  }
  measure(layout);
  return widths;
}
