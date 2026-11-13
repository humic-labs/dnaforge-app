import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTableData } from './useTableData';
import type { TableData, Cell } from '../types';

describe('useTableData', () => {
  let mockOnUpdateAttrs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnUpdateAttrs = vi.fn();
  });

  describe('imported saved formula results', () => {
    const saved = {
      value: '42',
      type: 'text' as const,
      sourceFormula: '=BENCHLING(A1)',
      sourceRenderedValue: '42',
      formulaCompatibility: 'unsupported' as const,
      stale: false,
    };
    const input = (): TableData => ({
      cells: [
        [{ value: '2', type: 'number' }, { ...saved }],
        [
          { value: '3', type: 'number' },
          { value: '', type: 'text' },
        ],
      ],
    });
    type TableActions = ReturnType<typeof useTableData>;
    const range = { startRow: 0, endRow: 0, startCol: 0, endCol: 0 };

    it.each<[string, (table: TableActions) => void]>([
      ['cell edit', (table) => table.updateCell(0, 0, '9')],
      ['paste', (table) => table.pasteCells(1, 0, [[{ value: '9', type: 'text' }]])],
      ['fill', (table) => table.fillRange(range, { ...range, endRow: 1 })],
      ['clear', (table) => table.deleteRange(range)],
      ['add row', (table) => table.addRow()],
      ['add column', (table) => table.addColumn()],
      ['remove row', (table) => table.removeRow(1)],
      ['remove column', (table) => table.removeColumn(0)],
      ['expand', (table) => table.expandAndSetCell(2, 0, '9')],
    ])(
      'marks retained results outdated after %s without changing source evidence',
      (_name, change) => {
        const data = input();
        const { result } = renderHook(() =>
          useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs })
        );
        act(() => change(result.current));
        const written = mockOnUpdateAttrs.mock.lastCall?.[0];
        expect(written.cells.flat().find((cell: Cell) => cell.value === '42')).toEqual({
          ...saved,
          stale: true,
        });
        expect(data.cells?.[0][1]).toEqual(saved);
      }
    );

    it.each(['99', '=1+1'])('makes explicit replacement %s user-owned', (value) => {
      const { result } = renderHook(() =>
        useTableData({ data: input(), onUpdateAttrs: mockOnUpdateAttrs })
      );
      act(() => result.current.updateCell(0, 1, value));
      expect(mockOnUpdateAttrs.mock.lastCall?.[0].cells[0][1]).toEqual({
        value,
        type: value.startsWith('=') ? 'formula' : 'text',
      });
    });

    it('keeps no-op edits, formatting and view changes from invalidating results', () => {
      const { result } = renderHook(() =>
        useTableData({ data: input(), onUpdateAttrs: mockOnUpdateAttrs })
      );
      act(() => result.current.updateCell(0, 1, '42'));
      expect(mockOnUpdateAttrs).not.toHaveBeenCalled();
      act(() => result.current.setCellFormat(range, { bold: true }));
      expect(mockOnUpdateAttrs.mock.lastCall?.[0].cells[0][1]).toEqual(saved);
      act(() => {
        result.current.setSort(0);
        result.current.setFilter(0, '2');
      });
      expect(mockOnUpdateAttrs).toHaveBeenCalledTimes(1);
    });

    it('copies source evidence without pretending moved or filled results were recalculated', () => {
      const { result } = renderHook(() =>
        useTableData({ data: input(), onUpdateAttrs: mockOnUpdateAttrs })
      );
      act(() => result.current.pasteCells(1, 1, [[saved]]));
      expect(mockOnUpdateAttrs.mock.lastCall?.[0].cells[1][1]).toEqual({ ...saved, stale: true });
      act(() =>
        result.current.fillRange(
          { ...range, startCol: 1, endCol: 1 },
          { ...range, startCol: 1, endCol: 1, endRow: 1 }
        )
      );
      expect(mockOnUpdateAttrs.mock.lastCall?.[0].cells[1][1]).toEqual({ ...saved, stale: true });
    });

    it('keeps cut preparation unchanged, then marks moved results outdated on paste', () => {
      const { result } = renderHook(() =>
        useTableData({ data: input(), onUpdateAttrs: mockOnUpdateAttrs })
      );
      const sourceRange = { ...range, startCol: 1, endCol: 1 };
      let copied: Cell[][] = [];
      act(() => {
        copied = result.current.cutCells(sourceRange);
      });
      expect(mockOnUpdateAttrs).not.toHaveBeenCalled();
      act(() => result.current.pasteCells(1, 1, copied, true, sourceRange));
      expect(mockOnUpdateAttrs.mock.lastCall?.[0].cells[0][1]).toEqual({ value: '', type: 'text' });
      expect(mockOnUpdateAttrs.mock.lastCall?.[0].cells[1][1]).toEqual({ ...saved, stale: true });
    });

    it('restores a replaced source result with undo', () => {
      const { result, rerender } = renderHook(
        ({ data }) => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }),
        { initialProps: { data: input() } }
      );
      act(() => result.current.updateCell(0, 1, '=1+1'));
      rerender({ data: mockOnUpdateAttrs.mock.lastCall?.[0] });
      act(() => result.current.undo());
      expect(mockOnUpdateAttrs.mock.lastCall?.[0].cells[0][1]).toEqual(saved);
    });

    it('round-trips outdated state and restores provenance through undo and redo', () => {
      const { result, rerender } = renderHook(
        ({ data }) => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }),
        { initialProps: { data: input() } }
      );
      act(() => result.current.updateCell(0, 0, '9'));
      const edited: TableData = JSON.parse(JSON.stringify(mockOnUpdateAttrs.mock.lastCall?.[0]));
      rerender({ data: edited });
      expect(result.current.cells[0][1]).toEqual({ ...saved, stale: true });
      act(() => result.current.undo());
      const restored: TableData = mockOnUpdateAttrs.mock.lastCall?.[0];
      expect(restored.cells?.[0][1]).toEqual(saved);
      rerender({ data: restored });
      act(() => result.current.redo());
      expect(mockOnUpdateAttrs.mock.lastCall?.[0].cells[0][1]).toEqual({ ...saved, stale: true });
    });
  });

  describe('initialization', () => {
    it('migrates rows/cols format to cells array', () => {
      const data: TableData = { rows: 2, cols: 3 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      expect(result.current.rows).toBe(2);
      expect(result.current.cols).toBe(3);
      expect(result.current.cells).toHaveLength(2);
      expect(result.current.cells[0]).toHaveLength(3);
      expect(result.current.cells[0][0]).toEqual({ value: '', type: 'text' });
    });

    it('uses existing cells array when provided', () => {
      const cells: Cell[][] = [
        [
          { value: 'A1', type: 'text' },
          { value: 'B1', type: 'text' },
        ],
        [
          { value: 'A2', type: 'number' },
          { value: 'B2', type: 'text' },
        ],
      ];
      const data: TableData = { cells, rows: 2, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      expect(result.current.cells).toEqual(cells);
      expect(result.current.cells[0][0].value).toBe('A1');
      expect(result.current.cells[1][0].type).toBe('number');
    });

    it('defaults to 3x3 when no dimensions provided', () => {
      const data: TableData = {};

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      expect(result.current.rows).toBe(3);
      expect(result.current.cols).toBe(3);
    });
  });

  describe('updateCell', () => {
    it('updates a cell value and persists', () => {
      const data: TableData = { rows: 2, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.updateCell(0, 1, 'Hello');
      });

      expect(mockOnUpdateAttrs).toHaveBeenCalledWith(
        expect.objectContaining({
          cells: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({ value: '' }),
              expect.objectContaining({ value: 'Hello' }),
            ]),
          ]),
          rows: 2,
          cols: 2,
        })
      );
    });

    it('sets cell type based on content (text for non-formulas)', () => {
      const cells: Cell[][] = [[{ value: '10', type: 'number' }]];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.updateCell(0, 0, '20');
      });

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cells[0][0]).toEqual({ value: '20', type: 'text' });
    });

    it('sets cell type to formula when value starts with =', () => {
      const cells: Cell[][] = [[{ value: '10', type: 'text' }]];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.updateCell(0, 0, '=SUM(A1:A5)');
      });

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cells[0][0]).toEqual({ value: '=SUM(A1:A5)', type: 'formula' });
    });
  });

  describe('addRow', () => {
    it('adds a new row at the end', () => {
      const data: TableData = { rows: 2, cols: 3 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.addRow();
      });

      expect(mockOnUpdateAttrs).toHaveBeenCalledWith(
        expect.objectContaining({
          rows: 3,
          cols: 3,
        })
      );

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cells).toHaveLength(3);
      expect(call.cells[2]).toHaveLength(3);
    });
  });

  describe('removeRow', () => {
    it('removes a row by index', () => {
      const cells: Cell[][] = [
        [{ value: 'R1', type: 'text' }],
        [{ value: 'R2', type: 'text' }],
        [{ value: 'R3', type: 'text' }],
      ];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.removeRow(1);
      });

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cells).toHaveLength(2);
      expect(call.cells[0][0].value).toBe('R1');
      expect(call.cells[1][0].value).toBe('R3');
    });

    it('does not remove last row (minimum 1 row)', () => {
      const data: TableData = { rows: 1, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.removeRow(0);
      });

      expect(mockOnUpdateAttrs).not.toHaveBeenCalled();
    });
  });

  describe('addColumn', () => {
    it('adds a new column to all rows', () => {
      const cells: Cell[][] = [[{ value: 'A1', type: 'text' }], [{ value: 'A2', type: 'text' }]];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.addColumn();
      });

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cols).toBe(2);
      expect(call.cells[0]).toHaveLength(2);
      expect(call.cells[1]).toHaveLength(2);
      expect(call.cells[0][1]).toEqual({ value: '', type: 'text' });
    });
  });

  describe('removeColumn', () => {
    it('removes a column by index', () => {
      const cells: Cell[][] = [
        [
          { value: 'A1', type: 'text' },
          { value: 'B1', type: 'text' },
          { value: 'C1', type: 'text' },
        ],
      ];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.removeColumn(1);
      });

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cells[0]).toHaveLength(2);
      expect(call.cells[0][0].value).toBe('A1');
      expect(call.cells[0][1].value).toBe('C1');
    });

    it('does not remove last column (minimum 1 column)', () => {
      const data: TableData = { rows: 2, cols: 1 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.removeColumn(0);
      });

      expect(mockOnUpdateAttrs).not.toHaveBeenCalled();
    });
  });

  describe('columnLabels', () => {
    it('persists custom labels separately from cell contents', () => {
      const cells: Cell[][] = [
        [
          { value: 'A1', type: 'text' },
          { value: 'B1', type: 'text' },
        ],
      ];
      const data: TableData = { cells, columnLabels: ['Sample'] };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      expect(result.current.columnLabels).toEqual(['Sample']);

      act(() => {
        result.current.setColumnLabel(1, 'Condition');
      });

      expect(mockOnUpdateAttrs).toHaveBeenCalledWith(
        expect.objectContaining({
          cells,
          rows: 1,
          cols: 2,
          columnLabels: ['Sample', 'Condition'],
        })
      );
    });

    it('keeps labels aligned when appending a column through the toolbar path', () => {
      const cells: Cell[][] = [
        [
          { value: 'A1', type: 'text' },
          { value: 'B1', type: 'text' },
        ],
      ];
      const data: TableData = { cells, columnLabels: ['Sample', 'Condition'] };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.addColumn();
      });

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cols).toBe(3);
      expect(call.columnLabels).toEqual(['Sample', 'Condition', '']);
    });

    it('keeps labels aligned when removing a labeled column', () => {
      const cells: Cell[][] = [
        [
          { value: 'A1', type: 'text' },
          { value: 'B1', type: 'text' },
          { value: 'C1', type: 'text' },
        ],
      ];
      const data: TableData = { cells, columnLabels: ['Sample', 'Condition', 'Notes'] };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.removeColumn(1);
      });

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cells[0].map((cell: Cell) => cell.value)).toEqual(['A1', 'C1']);
      expect(call.columnLabels).toEqual(['Sample', 'Notes']);
    });
  });

  describe('visibleRowIndices ordering and matching', () => {
    const mixedGrid = (): TableData => ({
      cells: [
        [
          { value: 'beta', type: 'text' },
          { value: '=B2*6', type: 'formula' },
        ],
        [
          { value: 'Alpha', type: 'text' },
          { value: '5', type: 'number' },
        ],
        [
          { value: 'gamma', type: 'text' },
          { value: '100', type: 'number' },
        ],
      ],
    });

    it('orders a formula column by its computed number, not its formula text', () => {
      const { result } = renderHook(() =>
        useTableData({ data: mixedGrid(), onUpdateAttrs: mockOnUpdateAttrs })
      );

      act(() => result.current.setSort(1));
      expect(result.current.visibleRowIndices).toEqual([1, 0, 2]);

      act(() => result.current.setSort(1));
      expect(result.current.visibleRowIndices).toEqual([2, 0, 1]);
    });

    it('falls back to case-insensitive text order for a non-numeric column', () => {
      const { result } = renderHook(() =>
        useTableData({ data: mixedGrid(), onUpdateAttrs: mockOnUpdateAttrs })
      );

      act(() => result.current.setSort(0));
      expect(result.current.visibleRowIndices).toEqual([1, 0, 2]);
    });

    it('filters a formula column against the computed result, not the formula text', () => {
      const { result } = renderHook(() =>
        useTableData({ data: mixedGrid(), onUpdateAttrs: mockOnUpdateAttrs })
      );

      act(() => result.current.setFilter(1, '30'));
      expect(result.current.visibleRowIndices).toEqual([0]);

      act(() => result.current.setFilter(1, 'B2'));
      expect(result.current.visibleRowIndices).toEqual([]);
    });

    it('ignores a blank or whitespace-only filter', () => {
      const { result } = renderHook(() =>
        useTableData({ data: mixedGrid(), onUpdateAttrs: mockOnUpdateAttrs })
      );

      act(() => result.current.setFilter(0, '   '));
      expect(result.current.visibleRowIndices).toEqual([0, 1, 2]);
    });
  });

  describe('sorting', () => {
    it('sets sort to ascending on first click', () => {
      const data: TableData = { rows: 2, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.setSort(0);
      });

      expect(result.current.sort).toEqual({ column: 0, direction: 'asc' });
    });

    it('toggles sort to descending on second click', () => {
      const data: TableData = { rows: 2, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.setSort(0);
        result.current.setSort(0);
      });

      expect(result.current.sort).toEqual({ column: 0, direction: 'desc' });
    });

    it('clears sort on third click', () => {
      const data: TableData = { rows: 2, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.setSort(0);
        result.current.setSort(0);
        result.current.setSort(0);
      });

      expect(result.current.sort).toBeNull();
    });

    it('resets to ascending when clicking different column', () => {
      const data: TableData = { rows: 2, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.setSort(0);
        result.current.setSort(1);
      });

      expect(result.current.sort).toEqual({ column: 1, direction: 'asc' });
    });
  });

  describe('filtering', () => {
    it('sets filter for a column', () => {
      const data: TableData = { rows: 2, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.setFilter(0, 'test');
      });

      expect(result.current.filters).toEqual({ 0: 'test' });
    });

    it('clears filter when empty string', () => {
      const data: TableData = { rows: 2, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.setFilter(0, 'test');
        result.current.setFilter(0, '');
      });

      expect(result.current.filters).toEqual({});
    });

    it('clears all filters', () => {
      const data: TableData = { rows: 2, cols: 2 };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.setFilter(0, 'test');
        result.current.setFilter(1, 'hello');
        result.current.clearFilters();
      });

      expect(result.current.filters).toEqual({});
    });
  });

  describe('undo/redo', () => {
    it('can undo a cell update', () => {
      const cells: Cell[][] = [[{ value: 'original', type: 'text' }]];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.updateCell(0, 0, 'changed');
      });

      act(() => {
        result.current.undo();
      });

      const lastCall = mockOnUpdateAttrs.mock.calls[mockOnUpdateAttrs.mock.calls.length - 1][0];
      expect(lastCall.cells[0][0].value).toBe('original');
    });
  });

  describe('deleteRange', () => {
    it('clears cells in the specified range', () => {
      const cells: Cell[][] = [
        [
          { value: 'A1', type: 'text' },
          { value: 'B1', type: 'text' },
        ],
        [
          { value: 'A2', type: 'text' },
          { value: 'B2', type: 'text' },
        ],
      ];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.deleteRange({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 });
      });

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cells[0][0].value).toBe('');
      expect(call.cells[0][1].value).toBe('');
      expect(call.cells[1][0].value).toBe('A2');
    });
  });

  describe('copyCells', () => {
    it('returns a copy of cells in range', () => {
      const cells: Cell[][] = [
        [
          { value: 'A1', type: 'text' },
          { value: 'B1', type: 'text' },
        ],
        [
          { value: 'A2', type: 'text' },
          { value: 'B2', type: 'text' },
        ],
      ];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      let copied: Cell[][] = [];
      act(() => {
        copied = result.current.copyCells({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 });
      });

      expect(copied).toHaveLength(1);
      expect(copied[0]).toHaveLength(2);
      expect(copied[0][0].value).toBe('A1');
      expect(copied[0][1].value).toBe('B1');
    });
  });

  describe('setCellFormat', () => {
    it('applies formatting to cells in range', () => {
      const cells: Cell[][] = [[{ value: 'A1', type: 'text' }]];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.setCellFormat(
          { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
          { bold: true, italic: true }
        );
      });

      const call = mockOnUpdateAttrs.mock.calls[0][0];
      expect(call.cells[0][0].format).toEqual({ bold: true, italic: true });
    });
  });

  describe('displayCells', () => {
    it('evaluates formulas in displayCells', () => {
      const cells: Cell[][] = [
        [{ value: '10', type: 'text' }],
        [{ value: '=A1', type: 'formula' }],
      ];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      expect(result.current.displayCells[1][0].computed).toBe('10');
    });

    it('evaluates numeric formulas correctly', () => {
      const cells: Cell[][] = [
        [
          { value: '10', type: 'text' },
          { value: '20', type: 'text' },
        ],
        [{ value: '=A1+B1', type: 'formula' }],
      ];
      const data: TableData = { cells };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      expect(result.current.displayCells[1][0].computed).toBe(30);
    });
  });

  describe('columnWidths persistence', () => {
    it('setColumnWidth writes columnWidths into the attrs patch', () => {
      const data: TableData = {
        id: 't1',
        name: 'Assays',
        rows: 2,
        cols: 2,
        cells: [
          [
            { value: '', type: 'text' },
            { value: '', type: 'text' },
          ],
          [
            { value: '', type: 'text' },
            { value: '', type: 'text' },
          ],
        ],
      };

      const { result } = renderHook(() => useTableData({ data, onUpdateAttrs: mockOnUpdateAttrs }));

      act(() => {
        result.current.setColumnWidth(0, 220);
      });

      expect(mockOnUpdateAttrs).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 't1',
          name: 'Assays',
          columnWidths: { 0: 220 },
        })
      );
    });

    it('a subsequent cell edit keeps previously set columnWidths', () => {
      const data: TableData = {
        id: 't1',
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
        columnWidths: { 0: 180, 1: 240 },
      };

      const { result, rerender } = renderHook(
        ({ tableData }) => useTableData({ data: tableData, onUpdateAttrs: mockOnUpdateAttrs }),
        { initialProps: { tableData: data } }
      );

      act(() => {
        result.current.updateCell(0, 0, 'changed');
      });

      const patch = mockOnUpdateAttrs.mock.calls.at(-1)?.[0] as TableData;
      expect(patch.columnWidths).toEqual({ 0: 180, 1: 240 });
      expect(patch.id).toBe('t1');

      rerender({ tableData: patch });
      expect(result.current.columnWidths).toEqual({ 0: 180, 1: 240 });
    });
  });
});

describe('T2 focused block patches and deliberate replacement recovery', () => {
  const initial = (): TableData => ({
    id: 'synthetic-table',
    name: 'Synthetic table',
    cells: [
      [
        { value: 'A', type: 'text', format: { italic: true } },
        { value: 'B', type: 'text' },
      ],
      [
        { value: 'C', type: 'text' },
        { value: 'D', type: 'text' },
      ],
    ],
    columnLabels: ['Sample', 'Condition'],
    columnWidths: { 0: 135, 1: 210 },
    rowHeights: { 0: 28 },
    presentation: 'document',
  });
  function setup(data = initial()) {
    const writes = vi.fn();
    const hook = renderHook(({ data }) => useTableData({ data, onUpdateAttrs: writes }), {
      initialProps: { data },
    });
    const commit = () => {
      const next = writes.mock.lastCall?.[0] as TableData;
      hook.rerender({ data: next });
      return next;
    };
    return { ...hook, writes, commit };
  }

  it('patches a non-origin TSV block in one write, expands bounds, and preserves unaffected metadata', () => {
    const before = initial();
    const { result, writes, commit } = setup(before);
    act(() => expect(result.current.pasteCSV('X\tY\nZ\tW', 1, 1)).toBe(true));
    const next = commit();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(next.cells?.map((row) => row.map((cell) => cell.value))).toEqual([
      ['A', 'B', ''],
      ['C', 'X', 'Y'],
      ['', 'Z', 'W'],
    ]);
    expect(next.cells?.[0][0]).toEqual(before.cells?.[0][0]);
    expect(next).toMatchObject({
      id: before.id,
      name: before.name,
      columnLabels: before.columnLabels,
      columnWidths: before.columnWidths,
      rowHeights: before.rowHeights,
      presentation: 'document',
      rows: 3,
      cols: 3,
    });
    expect(before.cells?.[1][1].value).toBe('D');
    act(() => result.current.undo());
    const restored = commit();
    expect(restored.cells).toEqual(before.cells);
    expect(restored.rows).toBe(2);
    expect(restored.cols).toBe(2);
    const calls = writes.mock.calls.length;
    act(() => expect(result.current.undo()).toBeNull());
    expect(writes).toHaveBeenCalledTimes(calls);
    act(() => result.current.redo());
    expect(commit()).toEqual(next);
  });

  it('pastes single-column newlines as rows rather than one multiline cell', () => {
    const { result, commit } = setup();
    act(() => expect(result.current.pasteCSV('X\nY', 1, 1)).toBe(true));
    const next = commit();
    expect(next.cells?.[1][1].value).toBe('X');
    expect(next.cells?.[2][1].value).toBe('Y');
    expect(next.cells?.[0][0].value).toBe('A');
  });

  it('patches formatted HTML at the destination and pads ragged rows inside that block', () => {
    const { result, writes, commit } = setup();
    act(() =>
      expect(
        result.current.pasteHTMLTable(
          '<table><tr><td style="font-weight:700">X</td><td>Y</td></tr><tr><td>Z</td></tr></table>',
          1,
          1
        )
      ).toBe(true)
    );
    const next = commit();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(next.cells?.[0][0]).toMatchObject({ value: 'A', format: { italic: true } });
    expect(next.cells?.[1][1]).toMatchObject({ value: 'X', format: { bold: true } });
    expect(next.cells?.[2].map((cell) => cell.value)).toEqual(['', 'Z', '']);
    expect(next.columnLabels).toEqual(['Sample', 'Condition']);
  });

  it.each([
    {
      type: 'text' as const,
      value: '42',
      sourceFormula: '=BENCHLING(A1)',
      sourceRenderedValue: '42',
    },
    { type: 'formula' as const, value: '=BENCHLING(A1)', sourceRenderedValue: '42' },
  ])('retains imported result provenance for moved $type cells', (source) => {
    const data = initial();
    const saved: Cell = {
      ...source,
      formulaCompatibility: 'unsupported',
      stale: false,
      format: { bold: true },
    };
    data.cells![0][0] = saved;
    const { result, commit } = setup(data);
    const range = { startRow: 0, endRow: 0, startCol: 0, endCol: 0 };
    let copied: Cell[][] = [];
    act(() => {
      copied = result.current.cutCells(range);
    });
    act(() => result.current.pasteCells(1, 1, copied, true, range));
    const next = commit();
    expect(next.cells?.[1][1]).toEqual({ ...saved, stale: true });
    expect(next.cells?.[0][0]).toEqual({ value: '', type: 'text' });
    expect(saved.stale).toBe(false);
    act(() => result.current.undo());
    expect(commit().cells?.[0][0]).toEqual(saved);
  });

  it('moves an overlapping cut atomically and restores the complete grid with one undo', () => {
    const data: TableData = {
      cells: [
        [
          { value: 'A', type: 'text', format: { bold: true } },
          { value: 'B', type: 'text' },
          { value: 'C', type: 'text' },
          { value: 'D', type: 'text' },
        ],
      ],
    };
    const { result, writes, commit } = setup(data);
    const range = { startRow: 0, endRow: 0, startCol: 0, endCol: 1 };
    let copied: Cell[][] = [];
    act(() => {
      copied = result.current.cutCells(range);
    });
    act(() => result.current.pasteCells(0, 1, copied, true, range));
    const next = commit();
    expect(next.cells?.[0].map((cell) => cell.value)).toEqual(['', 'A', 'B', 'D']);
    expect(next.cells?.[0][1].format).toEqual({ bold: true });
    expect(writes).toHaveBeenCalledTimes(1);
    act(() => result.current.undo());
    expect(commit().cells).toEqual(data.cells);
    act(() => result.current.redo());
    expect(commit().cells).toEqual(next.cells);
  });

  it('does not clear a cut source edited after the snapshot', () => {
    const { result, commit } = setup();
    const range = { startRow: 0, endRow: 0, startCol: 0, endCol: 0 };
    let copied: Cell[][] = [];
    act(() => {
      copied = result.current.cutCells(range);
    });
    act(() => result.current.updateCell(0, 0, 'NEW_SOURCE'));
    commit();
    act(() => result.current.pasteCells(1, 1, copied, true, range));
    const next = commit();
    expect(next.cells?.[0][0].value).toBe('NEW_SOURCE');
    expect(next.cells?.[1][1].value).toBe('A');
  });

  it('refuses negative positions and malformed rich blocks without a partial write', () => {
    const { result, writes } = setup();
    act(() => {
      result.current.pasteCells(-1, 0, [[{ value: 'X', type: 'text' }]]);
      result.current.pasteCells(1, 1, [[{ value: 'X', type: 'text' }], []]);
    });
    expect(writes).not.toHaveBeenCalled();
  });

  it('explicit replacement preserves identity/layout, has one-step undo/redo and survives a normal data roundtrip', () => {
    const before = initial();
    const { result, writes, commit } = setup(before);
    act(() => expect(result.current.replaceTableFromClipboard('new\ttable')).toBe(true));
    const replaced = commit();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(replaced.cells?.map((row) => row.map((cell) => cell.value))).toEqual([['new', 'table']]);
    expect(replaced.columnLabels).toEqual(before.columnLabels);
    expect(replaced.columnWidths).toEqual(before.columnWidths);
    expect(replaced.rowHeights).toEqual(before.rowHeights);
    expect(replaced.id).toBe(before.id);
    act(() => result.current.undo());
    expect(commit().cells).toEqual(before.cells);
    act(() => result.current.redo());
    expect(commit()).toEqual(replaced);
    const reopened = setup(JSON.parse(JSON.stringify(replaced)) as TableData);
    expect(reopened.result.current.cells).toEqual(replaced.cells);
    expect(reopened.result.current.columnLabels).toEqual(before.columnLabels);
  });

  it('retains history/retry after a refused replacement and leaves empty imports untouched', () => {
    const primary = new Error('synthetic update refusal');
    const { result, writes, commit } = setup();
    act(() => expect(result.current.replaceTableFromClipboard('')).toBe(false));
    expect(writes).not.toHaveBeenCalled();
    writes.mockImplementationOnce(() => {
      throw primary;
    });
    act(() => expect(() => result.current.replaceTableFromClipboard('X\tY')).toThrow(primary));
    act(() => expect(result.current.undo()).toBeNull());
    act(() => expect(result.current.replaceTableFromClipboard('X\tY')).toBe(true));
    commit();
    act(() => result.current.undo());
    expect(commit().cells?.[0][0].value).toBe('A');
    const calls = writes.mock.calls.length;
    act(() => expect(result.current.undo()).toBeNull());
    expect(writes).toHaveBeenCalledTimes(calls);
  });

  it('Copy awaits the controlled writer and rejects unavailable clipboard access', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let finish!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const { result } = setup();
      let fulfilled = false;
      const copying = result.current.copyToClipboard().then(() => {
        fulfilled = true;
      });
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(fulfilled).toBe(false);
      finish();
      await copying;
      expect(fulfilled).toBe(true);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      await expect(result.current.copyToClipboard()).rejects.toThrow(
        'Clipboard access is unavailable'
      );
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});

describe('T2 clipboard dialect and blank-row preservation', () => {
  it('preserves TSV commas, blank cells and row positions at the focused destination', () => {
    const write = vi.fn();
    const { result } = renderHook(() =>
      useTableData({
        data: { cells: [[{ value: 'untouched', type: 'text' }]] },
        onUpdateAttrs: write,
      })
    );
    act(() => expect(result.current.pasteCSV('a,b\tc\n\t\nz\tw\n', 1, 1)).toBe(true));
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      write.mock.lastCall?.[0].cells.map((row: Cell[]) => row.map((cell) => cell.value))
    ).toEqual([
      ['untouched', '', ''],
      ['', 'a,b', 'c'],
      ['', '', ''],
      ['', 'z', 'w'],
    ]);
  });
});

describe('T2 rich copy and explicit HTML replacement', () => {
  it('keeps an ordinary copied expression and imported result metadata without cut deletion', () => {
    const cells: Cell[][] = [
      [
        { value: '=A2+1', type: 'formula', format: { italic: true } },
        {
          value: '=SOURCE(A1)',
          type: 'formula',
          sourceRenderedValue: '42',
          formulaCompatibility: 'unsupported',
        },
      ],
      [
        { value: '2', type: 'text' },
        { value: 'untouched', type: 'text' },
      ],
    ];
    const write = vi.fn();
    const { result } = renderHook(() => useTableData({ data: { cells }, onUpdateAttrs: write }));
    const copied = result.current.copyCells({ startRow: 0, endRow: 0, startCol: 0, endCol: 1 });
    act(() => result.current.pasteCells(2, 0, copied));
    const next = write.mock.lastCall?.[0] as TableData;
    expect(next.cells?.[0]).toEqual(
      cells[0].map((cell, col) => (col === 1 ? { ...cell, stale: true } : cell))
    );
    expect(next.cells?.[2][0]).toMatchObject({
      value: '=A2+1',
      type: 'formula',
      format: { italic: true },
    });
    expect(next.cells?.[2][1]).toMatchObject({
      value: '=SOURCE(A1)',
      sourceRenderedValue: '42',
      formulaCompatibility: 'unsupported',
      stale: true,
    });
    expect(next.cells?.[1][1].value).toBe('untouched');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('uses the deliberate HTML replacement, retains formatting and restores old cells with one Undo', () => {
    const data: TableData = {
      id: 'synthetic-table',
      name: 'Synthetic',
      cells: [[{ value: 'before', type: 'text', format: { italic: true } }]],
      columnWidths: { 0: 140 },
    };
    const write = vi.fn();
    const { result, rerender } = renderHook(
      ({ data }) => useTableData({ data, onUpdateAttrs: write }),
      {
        initialProps: { data },
      }
    );
    act(() =>
      expect(
        result.current.replaceTableFromClipboard(
          'fallback',
          '<table><tr><td style="font-weight:700">HTML</td><td>other</td></tr></table>'
        )
      ).toBe(true)
    );
    const replaced = write.mock.lastCall?.[0] as TableData;
    expect(replaced.cells?.[0][0]).toMatchObject({ value: 'HTML', format: { bold: true } });
    expect(replaced.cells?.[0][1].value).toBe('other');
    expect(replaced.columnWidths).toEqual(data.columnWidths);
    rerender({ data: replaced });
    act(() => result.current.undo());
    expect(write.mock.lastCall?.[0].cells).toEqual(data.cells);
    expect(write.mock.lastCall?.[0].cols).toBe(1);
  });
});
