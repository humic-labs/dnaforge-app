// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { LayoutNode } from '../types';
import {
  PINNED_CHAT_PANEL_MIN_WIDTH_PX,
  requiredWidthForPinnedHistory,
} from './chat-history-width-lease';

const panel = (panelId: string): LayoutNode => ({ type: 'panel', panelId });

describe('pinned chat history width lease', () => {
  it('requires the exact picker, gap, edge inset, and usable-chat width for one panel', () => {
    expect(requiredWidthForPinnedHistory(panel('chat'), 'chat')).toBe(
      PINNED_CHAT_PANEL_MIN_WIDTH_PX
    );
    expect(requiredWidthForPinnedHistory(panel('other'), 'chat')).toBeNull();
  });

  it('does not add width for vertically stacked panels', () => {
    const layout: LayoutNode = {
      type: 'split',
      direction: 'horizontal',
      children: [panel('chat'), panel('below')],
      sizes: [50, 50],
    };
    expect(requiredWidthForPinnedHistory(layout, 'chat')).toBe(487);
  });

  it('retains side-by-side sibling minima and separators through nested splits', () => {
    const layout: LayoutNode = {
      type: 'split',
      direction: 'vertical',
      children: [
        {
          type: 'split',
          direction: 'horizontal',
          children: [panel('chat'), panel('below')],
          sizes: [50, 50],
        },
        panel('right'),
        panel('far-right'),
      ],
      sizes: [50, 25, 25],
    };
    expect(requiredWidthForPinnedHistory(layout, 'chat')).toBe(487 + 2 * 10 + 2 * 4);
  });
});
