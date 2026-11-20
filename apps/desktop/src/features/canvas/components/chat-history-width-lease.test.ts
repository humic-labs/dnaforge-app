// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { LayoutNode, PanelState } from '../types';
import { canvasMinimumWidths, visibleChatPanelIds } from './chat-history-width-lease';

const panel = (panelId: string): LayoutNode => ({ type: 'panel', panelId });

describe('chat pane minimum widths', () => {
  it('releases the minimum when a different kind of tab becomes active', () => {
    const chat = panel('left');
    const left: PanelState = {
      id: 'left',
      activeTabId: 'chat-tab',
      tabs: [
        { id: 'chat-tab', type: 'chat', label: 'Chat', entityId: 'chat' },
        { id: 'page-tab', type: 'page', label: 'Page', entityId: 'page' },
      ],
    };
    const visible = () => visibleChatPanelIds({ panels: { left } });
    expect(canvasMinimumWidths(chat, visible(), new Set()).get(chat)).toBe(256);
    left.activeTabId = 'page-tab';
    expect(canvasMinimumWidths(chat, visible(), new Set(['left'])).size).toBe(0);
  });

  it('reserves history space for each pinned chat and uses the widest stacked child', () => {
    const above = panel('above');
    const below = panel('below');
    const stacked: LayoutNode = {
      type: 'split',
      direction: 'horizontal',
      children: [above, below],
      sizes: [50, 50],
    };
    const right = panel('right');
    const other = panel('other');
    const layout: LayoutNode = {
      type: 'split',
      direction: 'vertical',
      children: [stacked, right, other],
      sizes: [40, 40, 20],
    };
    const widths = canvasMinimumWidths(
      layout,
      ['above', 'below', 'right'],
      new Set(['below', 'right'])
    );
    expect(widths.get(above)).toBe(256);
    expect(widths.get(below)).toBe(583);
    expect(widths.get(stacked)).toBe(583);
    expect(widths.get(right)).toBe(583);
    expect(widths.get(other)).toBe(10);
    expect(widths.get(layout)).toBe(583 + 583 + 10 + 2 * 4);
  });
});
