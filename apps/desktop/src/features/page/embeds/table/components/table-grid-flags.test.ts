// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { tableCellWrapperClasses } from './table-cell-presentation';
import {
  tableGridCanEditColumnLabels,
  tableGridColumnCount,
  tableGridDataCellClasses,
  tableGridFilterStatusVisible,
  tableGridFocusedCellAddress,
  tableGridFocusedCellRawValue,
  tableGridFormulaBarValue,
  tableGridIsEmpty,
  tableGridLabelOnlySelection,
  tableGridLabelSelectionExtendsIntoCells,
  tableGridOverflowX,
  tableGridRenderedRowCount,
  tableGridShouldShowColumnLabels,
  tableGridShouldShowFormulaBar,
  tableGridTotalCount,
  tableGridWhenWritable,
} from './table-grid-flags';

describe('tableGridColumnCount', () => {
  it('reads the first row length and treats a missing row as empty', () => {
    expect(tableGridColumnCount([['a', 'b', 'c']])).toBe(3);
    expect(tableGridColumnCount([])).toBe(0);
  });
});

describe('tableGridShouldShowFormulaBar', () => {
  it('defaults on for writable grids and off for read-only, unless the parent overrides', () => {
    expect(tableGridShouldShowFormulaBar(undefined, false)).toBe(true);
    expect(tableGridShouldShowFormulaBar(undefined, true)).toBe(false);
    expect(tableGridShouldShowFormulaBar(true, true)).toBe(true);
    expect(tableGridShouldShowFormulaBar(false, false)).toBe(false);
  });
});

describe('tableGridCanEditColumnLabels', () => {
  it('requires a writable grid and a label-change handler', () => {
    expect(tableGridCanEditColumnLabels(false, () => undefined)).toBe(true);
    expect(tableGridCanEditColumnLabels(true, () => undefined)).toBe(false);
    expect(tableGridCanEditColumnLabels(false, undefined)).toBe(false);
  });
});

describe('tableGridShouldShowColumnLabels', () => {
  it('shows labels when the parent asked, or when labels were supplied', () => {
    expect(tableGridShouldShowColumnLabels(undefined, ['A'])).toBe(true);
    expect(tableGridShouldShowColumnLabels(undefined, [])).toBe(false);
    expect(tableGridShouldShowColumnLabels(false, ['A'])).toBe(false);
  });
});

describe('tableGridTotalCount / rendered rows / empty', () => {
  it('adds ghost cells only when asked, and search replaces the rendered row list', () => {
    expect(tableGridTotalCount(true, 10, 3)).toBe(13);
    expect(tableGridTotalCount(false, 10, 3)).toBe(10);
    expect(tableGridRenderedRowCount(true, 2, 13)).toBe(2);
    expect(tableGridRenderedRowCount(false, 2, 13)).toBe(13);
    expect(tableGridIsEmpty(0, 4)).toBe(true);
    expect(tableGridIsEmpty(3, 0)).toBe(true);
    expect(tableGridIsEmpty(3, 4)).toBe(false);
  });
});

describe('tableGridWhenWritable', () => {
  it('swaps live handlers for inert fallbacks on a read-only grid', () => {
    const live = () => 1;
    const inert = () => 0;
    expect(tableGridWhenWritable(false, live, inert)).toBe(live);
    expect(tableGridWhenWritable(true, live, inert)).toBe(inert);
  });
});

describe('tableGridOverflowX / filter status / label selection', () => {
  it('marks overflow only when the grid actually overflows', () => {
    expect(tableGridOverflowX(true)).toEqual({
      dataOverflowX: 'auto',
      className: 'overflow-x-auto overflow-y-clip',
    });
    expect(tableGridOverflowX(false)).toEqual({
      dataOverflowX: 'none',
      className: undefined,
    });
  });

  it('shows the filter footer when filters or search are active', () => {
    expect(tableGridFilterStatusVisible(0, false)).toBe(false);
    expect(tableGridFilterStatusVisible(1, false)).toBe(true);
    expect(tableGridFilterStatusVisible(0, true)).toBe(true);
  });

  it('treats a column-label-only range as a header selection', () => {
    expect(
      tableGridLabelOnlySelection({
        hasLabelSelection: true,
        activeKind: 'column-labels',
        selectionStartRow: 0,
        selectionEndRow: 2,
        columnLabelSelectionRow: -1,
      })
    ).toBe(true);
    expect(
      tableGridLabelOnlySelection({
        hasLabelSelection: true,
        activeKind: 'cells',
        selectionStartRow: -1,
        selectionEndRow: -1,
        columnLabelSelectionRow: -1,
      })
    ).toBe(true);
    expect(tableGridLabelSelectionExtendsIntoCells(true, 3)).toBe(true);
    expect(tableGridLabelSelectionExtendsIntoCells(true, -1)).toBe(false);
  });
});

describe('formula bar value and address', () => {
  it('prefers the in-progress edit, then the focused cell, and blanks with no focus', () => {
    const cells = [[{ value: 'ATG' }]];
    expect(tableGridFocusedCellRawValue({ row: 0, col: 0 }, cells)).toBe('ATG');
    expect(tableGridFocusedCellRawValue(null, cells)).toBe('');
    expect(tableGridFormulaBarValue('=A1', 'ATG')).toBe('=A1');
    expect(tableGridFormulaBarValue(undefined, 'ATG')).toBe('ATG');
    expect(tableGridFocusedCellAddress({ row: 0, col: 0 }, () => 'A')).toBe('A1');
    expect(tableGridFocusedCellAddress(null, () => 'A')).toBe('');
  });
});

describe('tableGridDataCellClasses', () => {
  const tokens = (classes: string): string[] => classes.split(' ').filter(Boolean);
  const heightTokens = (classes: string): string[] =>
    tokens(classes).filter((token) => /^h-/.test(token));

  const whyTheHeightIsThere = [
    'A data cell must name its own height ().',
    'The cell content sits in a wrapper div that asks for height:100% (h-full in',
    'tableCellWrapperClasses), and every selection visual - focus ring, selection',
    'edges, cut overlay - is positioned against that wrapper. In Chromium a',
    'percentage height resolves to auto when the parent names no height of its own,',
    'so without a height here the wrapper shrinks to its own text (22px) while the',
    '<td> stretches to the tallest cell in the row. The ring then draws at 26px,',
    'floating in the middle of a 133px cell. h-px (1px) is the deliberate choice:',
    'any specified height fixes the resolution, and 1px is shorter than every real',
    'row so the table lays out exactly as before.',
    'This runner is jsdom and has no layout engine - every getBoundingClientRect',
    'here returns zeros - so this class assertion is the only automated guard below',
    'L2 that the height is still declared. If you delete it, the overlays break',
    'silently and only a real-browser measurement will notice.',
  ].join(' ');

  it('names a height on the data cell in both the normal and ghost branches, which is what keeps the selection overlays the size of the cell ()', () => {
    expect(heightTokens(tableGridDataCellClasses(false)), whyTheHeightIsThere).toEqual(['h-px']);
    expect(heightTokens(tableGridDataCellClasses(true)), whyTheHeightIsThere).toEqual(['h-px']);
  });

  it('is paired with a cell wrapper that asks for a percentage height, which is the reason the cell height is load-bearing', () => {
    const wrapper = tokens(
      tableCellWrapperClasses({
        isFocused: false,
        isSelected: false,
        isCut: false,
        isGhost: false,
        hasSelectionEdge: false,
        hasBgColor: false,
      })
    );
    expect(wrapper, whyTheHeightIsThere).toContain('h-full');
  });

  it('keeps the layout and pointer classes the grid relies on', () => {
    for (const isGhost of [false, true]) {
      const classes = tokens(tableGridDataCellClasses(isGhost));
      expect(classes).toContain('p-0');
      expect(classes).toContain('min-w-[80px]');
      expect(classes).toContain('cursor-cell');
    }
  });

  it('keeps the full-strength right border on real cells and the muted one on ghost cells', () => {
    const real = tokens(tableGridDataCellClasses(false));
    expect(real).toContain('border-r');
    expect(real).toContain('border-border');
    expect(real).not.toContain('border-border/30');
    expect(real).not.toContain('bg-bg-muted/20');

    const ghost = tokens(tableGridDataCellClasses(true));
    expect(ghost).toContain('border-r');
    expect(ghost).toContain('border-border/30');
    expect(ghost).not.toContain('border-border');
    expect(ghost).toContain('bg-bg-muted/20');
  });
});
