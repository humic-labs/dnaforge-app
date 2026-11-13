import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useClipboardOperations,
  TABLE_CLIPBOARD_OPERATION,
  type TableClipboardEvent,
} from './useClipboardOperations';
import { useTableData } from './useTableData';
import type { TableData } from '../types';

function eventData(values: Record<string, string> = {}, target = document.createElement('div')) {
  const data = new Map(Object.entries(values));
  const clipboardData = {
    getData: vi.fn((type: string) => data.get(type) ?? ''),
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
    }),
  };
  const preventDefault = vi.fn();
  return {
    data,
    clipboardData,
    preventDefault,
    event: {
      clipboardData,
      preventDefault,
      target,
      currentTarget: target,
    } satisfies TableClipboardEvent,
  };
}

function setup() {
  const writes = vi.fn();
  const initial: TableData = {
    id: 'synthetic-table',
    name: 'Synthetic table',
    cells: [
      [
        { value: 'INTERNAL_A', type: 'text', format: { bold: true } },
        { value: 'untouched', type: 'text' },
      ],
      [
        { value: 'other', type: 'text' },
        { value: 'destination', type: 'text' },
      ],
    ],
  };
  const hook = renderHook(() => {
    const [data, setData] = useState(initial);
    const [focused, setFocused] = useState({ row: 1, col: 1 });
    const [editing, setEditing] = useState(false);
    const table = useTableData({
      data,
      onUpdateAttrs: (attrs) => {
        writes(attrs);
        setData(attrs as TableData);
      },
    });
    const clipboard = useClipboardOperations({
      displayCells: table.displayCells,
      selection: { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
      focusedCell: focused,
      isEditing: editing,
      rows: table.rows,
      cols: table.cols,
      onPaste: table.pasteCSV,
      onPasteHTML: table.pasteHTMLTable,
      onPasteCells: table.pasteCells,
      onCopyCells: table.copyCells,
      onCutCells: table.cutCells,
      onClearCut: table.clearCut,
      onCellChange: table.updateCell,
      onExpandAndSetCell: table.expandAndSetCell,
    });
    return { data, table, clipboard, setFocused, setEditing };
  });
  return { ...hook, writes, initial };
}

beforeEach(() => {
  let operation = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `NONFUNCTIONAL_TABLE_OPERATION_${++operation}` });
});
afterEach(() => vi.unstubAllGlobals());

describe('actual table clipboard event ownership and data mutations', () => {
  it.each(['copy', 'cut'] as const)(
    'external B wins after internal %s A without deleting A',
    (kind) => {
      const { result, writes } = setup();
      const internal = eventData();
      act(() =>
        kind === 'cut'
          ? result.current.clipboard.handleCut(internal.event)
          : result.current.clipboard.handleCopy(internal.event)
      );
      expect(internal.data.get(TABLE_CLIPBOARD_OPERATION)).toBeTruthy();
      const external = eventData({ 'text/plain': 'EXTERNAL_B' });
      act(() => result.current.clipboard.handlePaste(external.event));
      expect(result.current.data.cells?.[0][0].value).toBe('INTERNAL_A');
      expect(result.current.data.cells?.[1][1]).toEqual({ value: 'EXTERNAL_B', type: 'text' });
      expect(result.current.table.cutRange).toBeNull();
      expect(writes).toHaveBeenCalledTimes(1);
    }
  );

  it('equal external plaintext without the owned event token cannot reuse rich cut authority', () => {
    const { result } = setup();
    const internal = eventData();
    act(() => result.current.clipboard.handleCut(internal.event));
    act(() =>
      result.current.clipboard.handlePaste(eventData({ 'text/plain': 'INTERNAL_A' }).event)
    );
    expect(result.current.data.cells?.[0][0]).toMatchObject({
      value: 'INTERNAL_A',
      format: { bold: true },
    });
    expect(result.current.data.cells?.[1][1]).toEqual({ value: 'INTERNAL_A', type: 'text' });
  });

  it('rejects an old token if the event plaintext or HTML has changed', () => {
    const { result } = setup();
    const copied = eventData();
    act(() => result.current.clipboard.handleCut(copied.event));
    const changed = eventData({
      'text/plain': 'EXTERNAL_B',
      [TABLE_CLIPBOARD_OPERATION]: copied.data.get(TABLE_CLIPBOARD_OPERATION)!,
      'text/html': '<table><tr><td>HTML_B</td></tr></table>',
    });
    act(() => result.current.clipboard.handlePaste(changed.event));
    expect(result.current.data.cells?.[1][1].value).toBe('HTML_B');
    expect(result.current.data.cells?.[0][0].value).toBe('INTERNAL_A');
  });

  it('accepts the actual owned rich cut once, retains formatting, and supports one undo/redo', () => {
    const { result, writes } = setup();
    const copied = eventData();
    act(() => result.current.clipboard.handleCut(copied.event));
    act(() => result.current.clipboard.handlePaste(copied.event));
    expect(result.current.data.cells?.[0][0].value).toBe('');
    expect(result.current.data.cells?.[1][1]).toMatchObject({
      value: 'INTERNAL_A',
      format: { bold: true },
    });
    expect(writes).toHaveBeenCalledTimes(1);
    act(() => result.current.table.undo());
    expect(result.current.data.cells?.[0][0].value).toBe('INTERNAL_A');
    expect(result.current.data.cells?.[1][1].value).toBe('destination');
    act(() => result.current.table.redo());
    expect(result.current.data.cells?.[0][0].value).toBe('');
    expect(result.current.data.cells?.[1][1].value).toBe('INTERNAL_A');
    act(() => result.current.table.updateCell(0, 0, 'LATER_EDIT'));
    act(() => result.current.clipboard.handlePaste(copied.event));
    expect(result.current.data.cells?.[0][0].value).toBe('LATER_EDIT');
  });

  it('passes actual HTML/TSV data to the focused non-origin destination', () => {
    const { result, writes } = setup();
    const external = eventData({ 'text/plain': 'X\tY\nZ\tW' });
    act(() => result.current.clipboard.handlePaste(external.event));
    expect(result.current.table.rows).toBe(3);
    expect(result.current.table.cols).toBe(3);
    expect(result.current.data.cells?.[1][1].value).toBe('X');
    expect(result.current.data.cells?.[2][2].value).toBe('W');
    expect(result.current.data.cells?.[0][0].value).toBe('INTERNAL_A');
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('invalidates retained cell authority when a label-copy path clears the operation', () => {
    const { result } = setup();
    const copied = eventData();
    act(() => result.current.clipboard.handleCut(copied.event));
    act(() => result.current.clipboard.clearClipboard());
    act(() => result.current.clipboard.handlePaste(copied.event));
    expect(result.current.data.cells?.[0][0].value).toBe('INTERNAL_A');
    expect(result.current.data.cells?.[1][1]).toEqual({ value: 'INTERNAL_A', type: 'text' });
  });

  it('leaves cell editors and ordinary text inputs to their native clipboard behavior', () => {
    const { result, writes } = setup();
    const input = eventData({ 'text/plain': 'PRIVATE_INPUT' }, document.createElement('input'));
    act(() => {
      result.current.clipboard.handlePaste(input.event);
      result.current.clipboard.handleCopy(input.event);
      result.current.clipboard.handleCut(input.event);
    });
    expect(input.clipboardData.getData).not.toHaveBeenCalled();
    expect(input.preventDefault).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    act(() => result.current.setEditing(true));
    const editor = eventData({ 'text/plain': 'CELL_EDITOR' });
    act(() => result.current.clipboard.handlePaste(editor.event));
    expect(editor.clipboardData.getData).not.toHaveBeenCalled();
  });

  it('keeps the grid focus sink active and safely falls back if a custom flavor is unsupported', () => {
    const { result } = setup();
    const sink = document.createElement('input');
    sink.className = 'table-focus-sink';
    const copied = eventData({}, sink);
    copied.clipboardData.setData.mockImplementation((type, value) => {
      if (type === TABLE_CLIPBOARD_OPERATION) throw new Error('custom flavor unavailable');
      copied.data.set(type, value);
    });
    act(() => result.current.clipboard.handleCut(copied.event));
    expect(copied.data.get('text/plain')).toBe('INTERNAL_A');
    expect(result.current.table.cutRange).toBeNull();
    act(() => result.current.clipboard.handlePaste(copied.event));
    expect(result.current.data.cells?.[0][0].value).toBe('INTERNAL_A');
    expect(result.current.data.cells?.[1][1]).toEqual({ value: 'INTERNAL_A', type: 'text' });
  });
});

describe('T2 retained operation refusal and retry', () => {
  it('preserves the same owned cut for retry after a refused destination write', () => {
    const { result, writes } = setup();
    const copied = eventData();
    act(() => result.current.clipboard.handleCut(copied.event));
    writes.mockImplementationOnce(() => {
      throw new Error('synthetic authority refusal');
    });
    act(() =>
      expect(() => result.current.clipboard.handlePaste(copied.event)).toThrow(
        'synthetic authority refusal'
      )
    );
    expect(result.current.data.cells?.[0][0].value).toBe('INTERNAL_A');
    expect(result.current.data.cells?.[1][1].value).toBe('destination');
    expect(result.current.table.cutRange).not.toBeNull();
    act(() => result.current.clipboard.handlePaste(copied.event));
    expect(result.current.data.cells?.[0][0].value).toBe('');
    expect(result.current.data.cells?.[1][1]).toMatchObject({
      value: 'INTERNAL_A',
      format: { bold: true },
    });
    act(() => result.current.table.undo());
    expect(result.current.data.cells?.[0][0].value).toBe('INTERNAL_A');
    const calls = writes.mock.calls.length;
    act(() => expect(result.current.table.undo()).toBeNull());
    expect(writes).toHaveBeenCalledTimes(calls);
  });

  it('rejects altered plaintext even when the old token remains and no HTML is present', () => {
    const { result } = setup();
    const copied = eventData();
    act(() => result.current.clipboard.handleCut(copied.event));
    const changed = eventData({
      'text/plain': 'EXTERNAL_B',
      [TABLE_CLIPBOARD_OPERATION]: copied.data.get(TABLE_CLIPBOARD_OPERATION)!,
    });
    act(() => result.current.clipboard.handlePaste(changed.event));
    expect(result.current.data.cells?.[0][0].value).toBe('INTERNAL_A');
    expect(result.current.data.cells?.[1][1]).toEqual({ value: 'EXTERNAL_B', type: 'text' });
    expect(result.current.table.cutRange).toBeNull();
  });
});

describe('T3/ current calculated and saved clipboard values', () => {
  it.each(['text', 'formula'] as const)(
    'copies visible %s results while retaining raw rich source',
    (type) => {
      const saved =
        type === 'text'
          ? {
              value: '42',
              type,
              sourceFormula: '=SOURCE()',
              sourceRenderedValue: '42',
              formulaCompatibility: 'unsupported' as const,
              stale: true,
            }
          : {
              value: '=SOURCE()',
              type,
              sourceRenderedValue: '42',
              computed: -999,
              formulaCompatibility: 'unsupported' as const,
              stale: true,
            };
      const data: TableData = {
        cells: [
          [
            { value: '2', type: 'number' },
            { value: '=A1+1', type: 'formula', computed: -999 },
          ],
          [{ value: '=B1+1', type: 'formula', computed: -999 }, saved],
        ],
      };
      const writes = vi.fn();
      const hook = renderHook(() => {
        const table = useTableData({ data, onUpdateAttrs: writes });
        return useClipboardOperations({
          displayCells: table.displayCells,
          selection: { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
          focusedCell: { row: 0, col: 0 },
          isEditing: false,
          rows: table.rows,
          cols: table.cols,
          onPaste: table.pasteCSV,
          onPasteHTML: table.pasteHTMLTable,
          onPasteCells: table.pasteCells,
          onCopyCells: table.copyCells,
          onCellChange: table.updateCell,
          onExpandAndSetCell: table.expandAndSetCell,
        });
      });
      const copied = eventData();
      act(() => hook.result.current.handleCopy(copied.event));
      expect(copied.data.get('text/plain')).toBe('2\t3\n4\t42');
      expect(copied.data.get(TABLE_CLIPBOARD_OPERATION)).toBeTruthy();
      expect(data.cells?.[0][1].value).toBe('=A1+1');
      expect(data.cells?.[1][1]).toEqual(saved);
      expect(writes).not.toHaveBeenCalled();
    }
  );
});
