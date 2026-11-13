// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTableData } from './useTableData';
import * as formulas from '../../../../../shared/notebook-model/table/utils/formulas';
import { executeTableEditorCommand, tableEditorCommandSchema } from '../table-editor-control';
import { readSavedFormulaResult } from '../../../../../shared/source-formula-result';
import { tableCellDisplayValue } from '../components/table-cell-presentation';
import * as csv from '../utils/csv';
import type { Cell, TableData } from '../types';

function setup(data: TableData) {
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

const reference = (row: number, col: number) => ({
  startRow: row,
  endRow: row,
  startCol: col,
  endCol: col,
});
const nativeFormula = (value: string): Cell => ({ value, type: 'formula', computed: -999 });

afterEach(() => vi.restoreAllMocks());

describe('T3 actual table revision and value consumers', () => {
  it('shares native table inspection with the evaluated human revision through undo and redo', () => {
    const evaluate = vi.spyOn(formulas, 'evaluateTableRevision');
    const hook = renderHook(() => {
      const [data, setData] = useState<TableData>({
        cells: [
          [
            { value: '2', type: 'number' },
            { value: '=A1+3', type: 'formula' },
            { value: '=2+3', type: 'formula' },
          ],
        ],
      });
      const commands = useTableData({
        data,
        onUpdateAttrs: (attrs) => setData((previous) => ({ ...previous, ...attrs })),
      });
      return { data, commands };
    });
    const control = {
      pageId: 'native-page',
      tableId: 'native-table',
      view: 'panel' as const,
      current: () => hook.result.current,
    };
    const inspect = () =>
      executeTableEditorCommand(control, tableEditorCommandSchema.parse({ kind: 'inspect' }));
    const expectValues = (dependent: number) => {
      expect(hook.result.current.commands.displayCells[0][1].computed).toBe(dependent);
      expect(inspect()).toMatchObject({
        cells: [[{}, { value: '=A1+3', computed: dependent }, { value: '=2+3', computed: 5 }]],
      });
      expect(hook.result.current.data.cells?.[0][1]).toEqual({ value: '=A1+3', type: 'formula' });
    };
    expectValues(5);
    expect(evaluate).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.commands.updateCell(0, 0, '20'));
    expectValues(23);
    act(() => hook.result.current.commands.undo());
    expectValues(5);
    act(() => hook.result.current.commands.redo());
    expectValues(23);
    hook.unmount();
  });

  it.each(['text', 'formula'] as const)(
    'uses new dependency values and preserves %s saved evidence',
    async (type) => {
      const saved: Cell =
        type === 'text'
          ? {
              value: '42',
              type,
              sourceFormula: '=SOURCE(A1)',
              sourceRenderedValue: '42',
              formulaCompatibility: 'unsupported',
              stale: false,
            }
          : {
              value: '=SOURCE(A1)',
              type,
              computed: '42',
              formulaCompatibility: 'unsupported',
              stale: false,
            };
      const data: TableData = {
        cells: [
          [{ value: '2', type: 'number' }, nativeFormula('=A1+1'), nativeFormula('=B1+1'), saved],
          [
            { value: '10', type: 'number' },
            nativeFormula('=A2+1'),
            nativeFormula('=B2+1'),
            { value: '7', type: 'text' },
          ],
          [
            { value: '5', type: 'number' },
            nativeFormula('=A3+1'),
            nativeFormula('=B3+1'),
            { value: '19', type: 'text' },
          ],
        ],
      };
      const { result, writes, commit } = setup(data);
      expect(result.current.displayCells.map((row) => row[2].computed)).toEqual([4, 12, 7]);
      act(() => result.current.setSort(2));
      expect(result.current.visibleRowIndices).toEqual([0, 2, 1]);
      act(() => result.current.updateCell(0, 0, '20'));
      const next = commit();
      expect(result.current.displayCells.map((row) => row[2].computed)).toEqual([22, 12, 7]);
      expect(result.current.visibleRowIndices).toEqual([2, 1, 0]);
      act(() => result.current.setFilter(2, '22'));
      expect(result.current.visibleRowIndices).toEqual([0]);
      expect(next.cells?.[0][1]).toEqual(data.cells?.[0][1]);
      expect(next.cells?.[0][2].value).toBe('=B1+1');
      expect(data.cells?.[0][0].value).toBe('2');
      expect(readSavedFormulaResult(next.cells?.[0][3])).toEqual({
        formula: '=SOURCE(A1)',
        value: '42',
        stale: true,
      });
      expect(tableCellDisplayValue(result.current.displayCells[0][3])).toBe('42');
      const expected = '20,21,22,42\n10,11,12,7\n5,6,7,19';
      expect(csv.cellsToCSV(result.current.displayCells)).toBe(expected);
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      try {
        await result.current.copyToClipboard();
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith(expected);
      } finally {
        if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
        else Reflect.deleteProperty(navigator, 'clipboard');
      }
      const download = vi.spyOn(csv, 'downloadCSV').mockImplementation(() => undefined);
      act(() => result.current.exportCSV());
      expect(download).toHaveBeenCalledTimes(1);
      expect(csv.cellsToCSV(download.mock.calls[0][0])).toBe(expected);
      expect(writes).toHaveBeenCalledTimes(1);
      const serialized = setup(JSON.parse(JSON.stringify(next)) as TableData);
      expect(serialized.result.current.displayCells[0][2].computed).toBe(22);
      expect(readSavedFormulaResult(serialized.result.current.cells[0][3])?.stale).toBe(true);
      act(() => result.current.undo());
      commit();
      expect(result.current.displayCells[0][2].computed).toBe(4);
      expect(readSavedFormulaResult(result.current.cells[0][3])?.stale).toBe(false);
      act(() => result.current.redo());
      commit();
      expect(result.current.displayCells[0][2].computed).toBe(22);
    }
  );

  it.each(['text', 'formula'] as const)(
    'sorts and filters visible saved %s values under ',
    (type) => {
      const saved = (value: string): Cell =>
        type === 'text'
          ? {
              value,
              type,
              sourceFormula: '=SOURCE()',
              sourceRenderedValue: value,
              formulaCompatibility: 'unsupported',
            }
          : {
              value: '=SOURCE()',
              type,
              sourceRenderedValue: value,
              computed: -999,
              formulaCompatibility: 'unsupported',
            };
      const { result, writes } = setup({ cells: [[saved('20')], [saved('3')], [saved('100')]] });
      act(() => result.current.setSort(0));
      expect(result.current.visibleRowIndices).toEqual([1, 0, 2]);
      act(() => result.current.setSort(0));
      expect(result.current.visibleRowIndices).toEqual([2, 0, 1]);
      act(() => result.current.setFilter(0, '20'));
      expect(result.current.visibleRowIndices).toEqual([0]);
      expect(result.current.displayCells.map((row) => tableCellDisplayValue(row[0]))).toEqual([
        '20',
        '3',
        '100',
      ]);
      expect(writes).not.toHaveBeenCalled();
    }
  );
});

describe('T-N2 actual copy/cut/fill expression policy', () => {
  function input(): TableData {
    return {
      cells: Array.from({ length: 3 }, (_, row) =>
        Array.from({ length: 3 }, (_, col) =>
          row === 1 && col === 1
            ? {
                value: '=CONCAT("A1",$A1,A$1,$A$1)',
                type: 'formula' as const,
                format: { italic: true },
              }
            : { value: '2', type: 'text' as const }
        )
      ),
    };
  }
  it('keeps the existing ordinary rich-copy expression policy without deleting its source', () => {
    const { result, commit } = setup(input());
    const copied = result.current.copyCells(reference(1, 1));
    act(() => result.current.pasteCells(2, 2, copied));
    const next = commit();
    expect(next.cells?.[1][1].value).toBe('=CONCAT("A1",$A1,A$1,$A$1)');
    expect(next.cells?.[2][2].value).toBe('=CONCAT("A1",$A1,A$1,$A$1)');
    expect(next.cells?.[2][2].format).toEqual({ italic: true });
  });
  it('relocates an owned cut through the existing mixed-reference helper and has one Undo', () => {
    const before = input();
    const { result, commit } = setup(before);
    let copied: Cell[][] = [];
    act(() => {
      copied = result.current.cutCells(reference(1, 1));
    });
    act(() => result.current.pasteCells(2, 2, copied, true, reference(1, 1)));
    expect(commit().cells?.[2][2].value).toBe('=CONCAT("A1",$A2,B$1,$A$1)');
    expect(result.current.cells[1][1].value).toBe('');
    act(() => result.current.undo());
    expect(commit().cells).toEqual(before.cells);
  });
  it('relocates fill through the same helper, including a literal that resembles a reference', () => {
    const { result, commit } = setup(input());
    act(() => result.current.fillRange(reference(1, 1), reference(2, 2)));
    expect(commit().cells?.[2][2].value).toBe('=CONCAT("A1",$A2,B$1,$A$1)');
  });
});

describe('T-N3 coherent structural history', () => {
  const initial = (): TableData => ({
    id: 'synthetic-table',
    name: 'Synthetic',
    cells: [
      [
        { value: 'A', type: 'text' },
        { value: 'B', type: 'text' },
        { value: 'C', type: 'text' },
      ],
    ],
    columnLabels: ['first', 'middle', 'last'],
    columnWidths: { 0: 120, 1: 180, 2: 240 },
    rowHeights: { 0: 32 },
  });
  it.each([1, 2])(
    'restores cells, labels, widths and heights after removing column %s',
    (column) => {
      const before = initial();
      const { result, writes, commit } = setup(before);
      act(() => result.current.removeColumn(column));
      const removed = commit();
      expect(removed.cells?.[0].map((cell) => cell.value)).toEqual(
        column === 1 ? ['A', 'C'] : ['A', 'B']
      );
      expect(removed.columnLabels).toEqual(column === 1 ? ['first', 'last'] : ['first', 'middle']);
      expect(removed.columnWidths).toEqual(column === 1 ? { 0: 120, 1: 240 } : { 0: 120, 1: 180 });
      expect(removed.rowHeights).toEqual({ 0: 32 });
      expect(writes).toHaveBeenCalledTimes(1);
      act(() => result.current.undo());
      const restored = commit();
      expect(restored).toMatchObject({ ...before, rows: 1, cols: 3 });
      act(() => result.current.redo());
      expect(commit()).toEqual(removed);
    }
  );
  it('shifts and restores row heights through row removal', () => {
    const before: TableData = {
      cells: [[{ value: 'A', type: 'text' }], [{ value: 'B', type: 'text' }]],
      rowHeights: { 0: 24, 1: 48 },
      columnWidths: { 0: 150 },
    };
    const { result, commit } = setup(before);
    act(() => result.current.removeRow(0));
    expect(commit().rowHeights).toEqual({ 0: 48 });
    act(() => result.current.undo());
    expect(commit()).toMatchObject(before);
    act(() => result.current.redo());
    expect(commit().rowHeights).toEqual({ 0: 48 });
  });
  it('retains a refused Undo for retry and does not consume its redo branch', () => {
    const before = initial();
    const { result, writes, commit } = setup(before);
    act(() => result.current.removeColumn(2));
    const removed = commit();
    const refusal = new Error('synthetic history refusal');
    writes.mockImplementationOnce(() => {
      throw refusal;
    });
    act(() => expect(() => result.current.undo()).toThrow(refusal));
    expect(result.current.cells).toEqual(removed.cells);
    act(() => result.current.undo());
    expect(commit()).toMatchObject(before);
    act(() => result.current.redo());
    expect(commit()).toEqual(removed);
  });
  it('does not roll back later layout-only changes during content-only Undo', () => {
    const { result, commit } = setup(initial());
    act(() => result.current.updateCell(0, 0, 'edit'));
    commit();
    act(() => result.current.setColumnWidth(0, 333));
    commit();
    act(() => result.current.undo());
    const restored = commit();
    expect(restored.cells?.[0][0].value).toBe('A');
    expect(restored.columnWidths?.[0]).toBe(333);
  });
});

describe('T-N3 structural history owns its local view', () => {
  const input = (): TableData => ({
    cells: [
      [
        { value: 'A', type: 'text' },
        { value: 'yes', type: 'text' },
        { value: '20', type: 'number' },
      ],
      [
        { value: 'B', type: 'text' },
        { value: 'no', type: 'text' },
        { value: '3', type: 'number' },
      ],
    ],
    columnLabels: ['name', 'condition', 'score'],
    columnWidths: { 0: 100, 1: 140, 2: 180 },
  });

  it('shifts an active sort/filter with a preceding removal, then restores exact view targets on Undo/Redo', () => {
    const { result, commit } = setup(input());
    act(() => {
      result.current.setSort(2);
      result.current.setFilter(2, '20');
    });
    expect(result.current.visibleRowIndices).toEqual([0]);
    act(() => result.current.removeColumn(1));
    const removed = commit();
    expect(result.current.sort).toEqual({ column: 1, direction: 'asc' });
    expect(result.current.filters).toEqual({ 1: '20' });
    expect(result.current.visibleRowIndices).toEqual([0]);
    act(() => result.current.undo());
    commit();
    expect(result.current.sort).toEqual({ column: 2, direction: 'asc' });
    expect(result.current.filters).toEqual({ 2: '20' });
    expect(result.current.visibleRowIndices).toEqual([0]);
    act(() => result.current.redo());
    expect(commit()).toEqual(removed);
    expect(result.current.sort).toEqual({ column: 1, direction: 'asc' });
    expect(result.current.filters).toEqual({ 1: '20' });
  });

  it('removes a last-column view target and restores it only with its matching structural state', () => {
    const { result, commit } = setup(input());
    act(() => {
      result.current.setSort(2);
      result.current.setFilter(2, '20');
    });
    act(() => result.current.removeColumn(2));
    commit();
    expect(result.current.sort).toBeNull();
    expect(result.current.filters).toEqual({});
    expect(result.current.visibleRowIndices).toEqual([0, 1]);
    act(() => result.current.undo());
    commit();
    expect(result.current.sort).toEqual({ column: 2, direction: 'asc' });
    expect(result.current.filters).toEqual({ 2: '20' });
    expect(result.current.visibleRowIndices).toEqual([0]);
    act(() => result.current.redo());
    commit();
    expect(result.current.sort).toBeNull();
    expect(result.current.filters).toEqual({});
  });

  it('keeps view/history branches intact after refused remove, Undo and Redo, then supports retry', () => {
    const { result, writes, commit } = setup(input());
    act(() => {
      result.current.setSort(2);
      result.current.setFilter(2, '20');
    });
    const refuse = () => {
      throw new Error('synthetic view/history refusal');
    };
    writes.mockImplementationOnce(refuse);
    act(() =>
      expect(() => result.current.removeColumn(2)).toThrow('synthetic view/history refusal')
    );
    expect(result.current.sort).toEqual({ column: 2, direction: 'asc' });
    expect(result.current.filters).toEqual({ 2: '20' });
    act(() => expect(result.current.undo()).toBeNull());
    act(() => result.current.removeColumn(2));
    commit();
    writes.mockImplementationOnce(refuse);
    act(() => expect(() => result.current.undo()).toThrow('synthetic view/history refusal'));
    expect(result.current.sort).toBeNull();
    expect(result.current.filters).toEqual({});
    act(() => result.current.undo());
    commit();
    writes.mockImplementationOnce(refuse);
    act(() => expect(() => result.current.redo()).toThrow('synthetic view/history refusal'));
    expect(result.current.sort).toEqual({ column: 2, direction: 'asc' });
    expect(result.current.filters).toEqual({ 2: '20' });
    act(() => result.current.redo());
    commit();
    expect(result.current.sort).toBeNull();
    expect(result.current.filters).toEqual({});
  });

  it.each([
    {
      label: 'row',
      row: 2,
      col: 1,
      values: [
        ['A', 'yes', '20'],
        ['B', 'no', '3'],
        ['', 'added', ''],
      ],
    },
    {
      label: 'column',
      row: 1,
      col: 3,
      values: [
        ['A', 'yes', '20', ''],
        ['B', 'no', '3', 'added'],
      ],
    },
    {
      label: 'row and column',
      row: 2,
      col: 3,
      values: [
        ['A', 'yes', '20', ''],
        ['B', 'no', '3', ''],
        ['', '', '', 'added'],
      ],
    },
  ])(
    'retains the filtered/sorted view after refused ghost $label expansion, then supports retry and history',
    ({ row, col, values }) => {
      const before = input();
      const { result, writes, commit } = setup(before);
      act(() => {
        result.current.setSort(2);
        result.current.setFilter(2, '20');
      });
      const refusal = new Error('synthetic mounted writer refusal');
      writes.mockImplementationOnce(() => {
        throw refusal;
      });

      act(() => expect(() => result.current.expandAndSetCell(row, col, 'added')).toThrow(refusal));
      expect(writes).toHaveBeenCalledTimes(1);
      expect(result.current.cells).toEqual(before.cells);
      expect(result.current.sort).toEqual({ column: 2, direction: 'asc' });
      expect(result.current.filters).toEqual({ 2: '20' });
      expect(result.current.visibleRowIndices).toEqual([0]);
      act(() => expect(result.current.undo()).toBeNull());
      expect(writes).toHaveBeenCalledTimes(1);

      act(() => result.current.expandAndSetCell(row, col, 'added'));
      const expanded = commit();
      expect(writes).toHaveBeenCalledTimes(2);
      expect(expanded.cells?.map((cells) => cells.map((cell) => cell.value))).toEqual(values);
      const originalCells = before.cells ?? [];
      expect(originalCells).toHaveLength(2);
      for (let r = 0; r < originalCells.length; r++) {
        for (let c = 0; c < originalCells[r].length; c++)
          expect(expanded.cells?.[r][c]).toEqual(originalCells[r][c]);
      }
      expect(expanded.columnWidths).toEqual(before.columnWidths);
      expect(expanded.columnLabels).toEqual(before.columnLabels);
      expect(result.current.sort).toBeNull();
      expect(result.current.filters).toEqual({});
      expect(result.current.visibleRowIndices).toEqual(values.map((_, index) => index));

      act(() => result.current.undo());
      expect(commit()).toMatchObject(before);
      expect(result.current.sort).toEqual({ column: 2, direction: 'asc' });
      expect(result.current.filters).toEqual({ 2: '20' });
      expect(result.current.visibleRowIndices).toEqual([0]);
      act(() => result.current.redo());
      expect(commit().cells).toEqual(expanded.cells);
      expect(result.current.sort).toBeNull();
      expect(result.current.filters).toEqual({});
      expect(result.current.visibleRowIndices).toEqual(values.map((_, index) => index));
    }
  );

  it('retains the existing redo branch and view when a ghost expansion is refused', () => {
    const { result, writes, commit } = setup(input());
    act(() => result.current.updateCell(0, 0, 'prior accepted edit'));
    commit();
    act(() => result.current.undo());
    commit();
    act(() => {
      result.current.setSort(2);
      result.current.setFilter(2, '20');
    });
    writes.mockClear();
    writes.mockImplementationOnce(() => {
      throw new Error('synthetic expansion refusal');
    });

    act(() =>
      expect(() => result.current.expandAndSetCell(2, 3, 'refused draft')).toThrow(
        'synthetic expansion refusal'
      )
    );
    expect(result.current.sort).toEqual({ column: 2, direction: 'asc' });
    expect(result.current.filters).toEqual({ 2: '20' });
    expect(result.current.visibleRowIndices).toEqual([0]);
    act(() => expect(result.current.undo()).toBeNull());
    expect(writes).toHaveBeenCalledTimes(1);
    act(() => result.current.redo());
    expect(commit().cells?.[0][0].value).toBe('prior accepted edit');
    expect(writes).toHaveBeenCalledTimes(2);
    expect(result.current.rows).toBe(2);
    expect(result.current.cols).toBe(3);
    expect(result.current.sort).toEqual({ column: 2, direction: 'asc' });
    expect(result.current.filters).toEqual({ 2: '20' });
    expect(result.current.visibleRowIndices).toEqual([0]);
  });
});
