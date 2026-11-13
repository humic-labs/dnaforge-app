import { describe, expect, it } from 'vitest';
import type { RenderState } from '../../types';
import {
  applySelectionAction,
  buildSelectionRange,
  buildBoundarySelectionRange,
  selectionContainsBp,
  shiftSelectionRange,
} from './selection-state';

function state(overrides: Partial<RenderState> = {}): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 300,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    ...overrides,
  };
}

describe('selection-state reducer', () => {
  it('feature focus clears cursor/range and owns only the selected id', () => {
    const s = state({
      cursorPosition: 50,
      selectedIds: new Set([1]),
      highlightRange: [25, 40],
    });

    applySelectionAction(s, {
      type: 'select-feature',
      feature: { id: 7 },
    });

    expect([...s.selectedIds]).toEqual([7]);
    expect(s.highlightRange).toBeNull();
    expect(s.cursorPosition).toBeNull();
  });

  it('feature range selection clears cursor and owns selected id plus inclusive highlight', () => {
    const s = state({ cursorPosition: 50, selectedIds: new Set([1]) });

    applySelectionAction(s, {
      type: 'select-feature-range',
      feature: { id: 7, start: 100, end: 200 },
      genomeLength: 1000,
    });

    expect([...s.selectedIds]).toEqual([7]);
    expect(s.highlightRange).toEqual([100, 199]);
    expect(s.cursorPosition).toBeNull();
  });

  it('placing cursor clears selected feature and highlight immediately', () => {
    const s = state({ selectedIds: new Set([7]), highlightRange: [100, 199] });

    applySelectionAction(s, { type: 'place-cursor', bp: 321 });

    expect(s.selectedIds.size).toBe(0);
    expect(s.highlightRange).toBeNull();
    expect(s.cursorPosition).toBe(321);
  });

  it('builds the shortest wrapped circular drag range', () => {
    expect(buildSelectionRange(900, 100, 1000, true)).toEqual([900, 100]);
    expect(buildSelectionRange(200, 500, 1000, true)).toEqual([200, 500]);
  });

  it('converts between-base drags into inclusive ranges in both directions across the origin', () => {
    expect(buildBoundarySelectionRange(990, 10, 1000, true)).toEqual([990, 9]);
    expect(buildBoundarySelectionRange(10, 990, 1000, true)).toEqual([990, 9]);
    expect(buildBoundarySelectionRange(0, 990, 1000, true)).toEqual([990, 999]);
    expect(buildBoundarySelectionRange(995, 1000, 1000, false)).toEqual([995, 999]);
    expect(buildBoundarySelectionRange(20, 20, 1000, true)).toBeNull();
  });

  it('updates the nearest linear selection handle on shift-click', () => {
    expect(
      shiftSelectionRange({
        currentRange: [100, 200],
        bp: 120,
        genomeLength: 1000,
        circular: false,
      })
    ).toEqual([120, 200]);
    expect(
      shiftSelectionRange({
        currentRange: [100, 200],
        bp: 190,
        genomeLength: 1000,
        circular: false,
      })
    ).toEqual([100, 190]);
  });

  it('detects positions inside wrapped and non-wrapped selections', () => {
    expect(selectionContainsBp([100, 200], 150, 1000)).toBe(true);
    expect(selectionContainsBp([100, 200], 250, 1000)).toBe(false);
    expect(selectionContainsBp([900, 100], 950, 1000)).toBe(true);
    expect(selectionContainsBp([900, 100], 50, 1000)).toBe(true);
    expect(selectionContainsBp([900, 100], 500, 1000)).toBe(false);
  });

  describe('set-residue-link-range', () => {
    it('writes the range when set, clears when null', () => {
      const s = state();
      applySelectionAction(s, { type: 'set-residue-link-range', range: [100, 102] });
      expect(s.residueLinkRange).toEqual([100, 102]);
      applySelectionAction(s, { type: 'set-residue-link-range', range: null });
      expect(s.residueLinkRange).toBeNull();
    });

    it('does NOT touch highlightRange (independent channels)', () => {
      const s = state({ highlightRange: [50, 200] });
      applySelectionAction(s, { type: 'set-residue-link-range', range: [100, 102] });
      expect(s.highlightRange).toEqual([50, 200]);
    });

    it('does NOT touch cursor / hovered / selected fields', () => {
      const s = state({
        cursorPosition: 42,
        hoveredId: 7,
        selectedIds: new Set([3, 11]),
      });
      applySelectionAction(s, { type: 'set-residue-link-range', range: [100, 102] });
      expect(s.cursorPosition).toBe(42);
      expect(s.hoveredId).toBe(7);
      expect([...s.selectedIds].sort((a, b) => a - b)).toEqual([3, 11]);
    });

    it('clear-selection does NOT touch residue-link (purely user-selection clear)', () => {
      const s = state({ residueLinkRange: [100, 102], selectedIds: new Set([7]) });
      applySelectionAction(s, { type: 'clear-selection' });
      expect(s.residueLinkRange).toEqual([100, 102]);
      expect(s.selectedIds.size).toBe(0);
    });

    it('overwrites a prior residue-link range on subsequent writes', () => {
      const s = state();
      applySelectionAction(s, { type: 'set-residue-link-range', range: [100, 102] });
      applySelectionAction(s, { type: 'set-residue-link-range', range: [400, 402] });
      expect(s.residueLinkRange).toEqual([400, 402]);
    });
  });
});
