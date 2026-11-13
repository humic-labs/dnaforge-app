import { describe, expect, it } from 'vitest';
import type { RenderState } from '../../../types';
import { interactionOutlineStyle } from './interaction-outline';

function createState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 200,
    height: 120,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    ...overrides,
  };
}

describe('interactionOutlineStyle', () => {
  it('returns null when a feature is neither hovered nor selected', () => {
    expect(interactionOutlineStyle(createState(), 7)).toBeNull();
  });

  it('uses the shared hover outline style', () => {
    expect(interactionOutlineStyle(createState({ hoveredId: 7 }), 7)).toEqual({
      width: 1.5,
      color: 0x111827,
      alpha: 0.55,
    });
  });

  it('gives selected state priority and respects dark mode color', () => {
    expect(
      interactionOutlineStyle(
        createState({ hoveredId: 7, selectedIds: new Set([7]), themeMode: 'dark' }),
        7
      )
    ).toEqual({
      width: 2,
      color: 0xf8fafc,
      alpha: 0.85,
    });
  });
});
