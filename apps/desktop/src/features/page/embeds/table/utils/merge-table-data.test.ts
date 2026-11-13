// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { mergeTableDataPatch } from './merge-table-data';
import type { TableData } from '../types';

describe('mergeTableDataPatch', () => {
  const base: TableData = {
    id: 'table-1',
    name: 'Assays',
    rows: 2,
    cols: 2,
    cells: [
      [
        { value: 'a', type: 'text' },
        { value: 'b', type: 'text' },
      ],
      [
        { value: 'c', type: 'text' },
        { value: 'd', type: 'text' },
      ],
    ],
    columnWidths: { 0: 160, 1: 220 },
    rowHeights: { 0: 28 },
    columnLabels: ['Gene', 'Notes'],
  };

  it('preserves columnWidths / rowHeights / labels when a cell patch omits them', () => {
    const next = mergeTableDataPatch(base, {
      cells: base.cells,
      rows: 2,
      cols: 2,
    });
    expect(next.columnWidths).toEqual({ 0: 160, 1: 220 });
    expect(next.rowHeights).toEqual({ 0: 28 });
    expect(next.columnLabels).toEqual(['Gene', 'Notes']);
    expect(next.id).toBe('table-1');
    expect(next.name).toBe('Assays');
  });

  it('applies a columnWidths patch without dropping identity fields', () => {
    const next = mergeTableDataPatch(base, {
      cells: base.cells,
      rows: 2,
      cols: 2,
      columnWidths: { 0: 300, 1: 220 },
    });
    expect(next.columnWidths).toEqual({ 0: 300, 1: 220 });
    expect(next.id).toBe('table-1');
    expect(next.name).toBe('Assays');
    expect(next.columnLabels).toEqual(['Gene', 'Notes']);
  });

  it('allows explicitly clearing layout maps when patch sets them undefined is NOT how we clear — omit means keep', () => {
    const next = mergeTableDataPatch(base, { name: 'Renamed' });
    expect(next.name).toBe('Renamed');
    expect(next.columnWidths).toEqual(base.columnWidths);
  });
});
