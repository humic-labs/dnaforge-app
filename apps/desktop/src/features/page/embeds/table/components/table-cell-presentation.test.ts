// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Cell } from '../types';
import {
  tableCellAlignClass,
  tableCellDisplayValue,
  tableCellEdgeMask,
  tableCellHasSelectionEdge,
  tableCellIsError,
  tableCellNativeEntityId,
  tableCellTitle,
  tableCellWrapperClasses,
} from './table-cell-presentation';

function cell(overrides: Partial<Cell> = {}): Cell {
  return { value: 'hello', type: 'text', ...overrides };
}

describe('tableCellDisplayValue', () => {
  it('uses the computed formula result when present', () => {
    expect(tableCellDisplayValue(cell({ type: 'formula', value: '=A1', computed: 12 }))).toBe('12');
  });

  it('falls back to the raw value', () => {
    expect(tableCellDisplayValue(cell({ value: 'ATG' }))).toBe('ATG');
  });
});

describe('tableCellEdgeMask', () => {
  it('marks only the active bounds edges', () => {
    expect(
      tableCellEdgeMask(
        true,
        { row: 1, col: 2 },
        { startRow: 1, startCol: 2, endRow: 4, endCol: 5 }
      )
    ).toEqual({ top: true, bottom: false, left: true, right: false });
  });

  it('is empty when the cell is not in the active region', () => {
    expect(
      tableCellEdgeMask(
        false,
        { row: 1, col: 2 },
        { startRow: 1, startCol: 2, endRow: 4, endCol: 5 }
      )
    ).toEqual({ top: false, bottom: false, left: false, right: false });
  });
});

describe('tableCellHasSelectionEdge', () => {
  it('hides selection edges on the focused cell', () => {
    expect(
      tableCellHasSelectionEdge(true, true, { top: true, bottom: false, left: false, right: false })
    ).toBe(false);
    expect(
      tableCellHasSelectionEdge(true, false, {
        top: true,
        bottom: false,
        left: false,
        right: false,
      })
    ).toBe(true);
  });
});

describe('tableCellIsError / native id / title / align', () => {
  it('detects formula errors and native references', () => {
    expect(tableCellIsError(cell({ type: 'formula', computed: '#REF!' }))).toBe(true);
    expect(
      tableCellNativeEntityId(cell({ reference: { kind: 'native-entity', entityId: 'e1' } }))
    ).toBe('e1');
    expect(
      tableCellNativeEntityId(
        cell({ reference: { kind: 'migration-destination', destinationTargetId: 'd1' } })
      )
    ).toBe('d1');
  });

  it('titles ghost and formula cells', () => {
    expect(tableCellTitle(cell(), true)).toBe('Type here to expand the table');
    expect(tableCellTitle(cell({ type: 'formula', value: '=A1' }), false)).toBe('Formula: =A1');
    expect(tableCellTitle(cell(), false)).toBeUndefined();
  });

  it('maps alignment', () => {
    expect(tableCellAlignClass({ align: 'center' })).toBe('text-center');
    expect(tableCellAlignClass({ align: 'right' })).toBe('text-right');
    expect(tableCellAlignClass()).toBe('text-left');
  });
});

describe('tableCellWrapperClasses', () => {
  it('keeps hover feedback on the transition-free pointer hot path ', () => {
    const classes = tableCellWrapperClasses({
      isFocused: false,
      isSelected: false,
      isCut: false,
      isGhost: false,
      hasSelectionEdge: false,
      hasBgColor: false,
    }).split(' ');

    expect(classes).toContain('hover:bg-bg-muted');
    expect(classes).toContain('transition-none');
  });
});
