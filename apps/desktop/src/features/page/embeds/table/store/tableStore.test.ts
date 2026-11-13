// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTableStore } from './tableStore';
import type { TableData } from '../types';

describe('tableStore', () => {
  beforeEach(() => {
    useTableStore.setState({ expandedTables: {} });
  });

  describe('registerTable', () => {
    it('registers a table with basic data', () => {
      const data: TableData = {
        cells: [[{ value: 'test', type: 'text' }]],
        rows: 1,
        cols: 1,
      };

      useTableStore.getState().registerTable('table-1', data, 'Test Table');

      const table = useTableStore.getState().getTable('table-1');
      expect(table).toBeDefined();
      expect(table?.id).toBe('table-1');
      expect(table?.label).toBe('Test Table');
      expect(table?.data).toEqual(data);
    });

    it('registers a table with options', () => {
      const data: TableData = { rows: 2, cols: 2 };
      const onUpdate = vi.fn();

      useTableStore.getState().registerTable('table-2', data, 'My Table', {
        sourcePageId: 'page-123',
        onUpdate,
      });

      const table = useTableStore.getState().getTable('table-2');
      expect(table?.sourcePageId).toBe('page-123');
      expect(table?.onUpdate).toBe(onUpdate);
    });

    it('overwrites existing table with same ID', () => {
      const data1: TableData = { rows: 1, cols: 1 };
      const data2: TableData = { rows: 3, cols: 3 };

      useTableStore.getState().registerTable('table-1', data1, 'First');
      useTableStore.getState().registerTable('table-1', data2, 'Second');

      const table = useTableStore.getState().getTable('table-1');
      expect(table?.label).toBe('Second');
      expect(table?.data).toEqual(data2);
    });
  });

  describe('unregisterTable', () => {
    it('removes a registered table', () => {
      const data: TableData = { rows: 1, cols: 1 };
      useTableStore.getState().registerTable('table-1', data, 'Test');

      useTableStore.getState().unregisterTable('table-1');

      expect(useTableStore.getState().getTable('table-1')).toBeUndefined();
    });

    it('does nothing for non-existent table', () => {
      useTableStore.getState().unregisterTable('non-existent');
      expect(useTableStore.getState().expandedTables).toEqual({});
    });

    it('preserves other tables when removing one', () => {
      const data: TableData = { rows: 1, cols: 1 };
      useTableStore.getState().registerTable('table-1', data, 'First');
      useTableStore.getState().registerTable('table-2', data, 'Second');

      useTableStore.getState().unregisterTable('table-1');

      expect(useTableStore.getState().getTable('table-1')).toBeUndefined();
      expect(useTableStore.getState().getTable('table-2')).toBeDefined();
    });
  });

  describe('updateTableData', () => {
    it('updates table data in store', () => {
      const data: TableData = { rows: 1, cols: 1 };
      const newData: TableData = {
        cells: [[{ value: 'updated', type: 'text' }]],
        rows: 1,
        cols: 1,
      };

      useTableStore.getState().registerTable('table-1', data, 'Test', { onUpdate: vi.fn() });
      useTableStore.getState().updateTableData('table-1', newData);

      const table = useTableStore.getState().getTable('table-1');
      expect(table?.data).toEqual({ rows: 1, cols: 1, cells: newData.cells });
    });

    it('calls onUpdate callback with the merged attrs', () => {
      const data: TableData = { rows: 1, cols: 1, columnWidths: { 0: 160 } };
      const newData: TableData = { rows: 2, cols: 2 };
      const onUpdate = vi.fn();

      useTableStore.getState().registerTable('table-1', data, 'Test', { onUpdate });
      useTableStore.getState().updateTableData('table-1', newData);

      expect(onUpdate).toHaveBeenCalledWith({
        rows: 2,
        cols: 2,
        columnWidths: { 0: 160 },
      });
    });

    it('preserves columnWidths when a cell-only patch omits them', () => {
      const data: TableData = {
        id: 't1',
        name: 'Assays',
        rows: 1,
        cols: 1,
        cells: [[{ value: 'a', type: 'text' }]],
        columnWidths: { 0: 200 },
      };
      useTableStore.getState().registerTable('table-1', data, 'Test', { onUpdate: vi.fn() });
      useTableStore.getState().updateTableData('table-1', {
        cells: [[{ value: 'b', type: 'text' }]],
        rows: 1,
        cols: 1,
      });

      const table = useTableStore.getState().getTable('table-1');
      expect(table?.data.columnWidths).toEqual({ 0: 200 });
      expect(table?.data.id).toBe('t1');
      expect(table?.data.name).toBe('Assays');
      expect(table?.data.cells?.[0]?.[0]?.value).toBe('b');
    });

    it('does nothing for non-existent table', () => {
      const newData: TableData = { rows: 1, cols: 1 };
      useTableStore.getState().updateTableData('non-existent', newData);
      expect(useTableStore.getState().expandedTables).toEqual({});
    });

    it('preserves other table properties when updating data', () => {
      const data: TableData = { rows: 1, cols: 1 };
      const newData: TableData = { rows: 2, cols: 2 };
      const onUpdate = vi.fn();

      useTableStore.getState().registerTable('table-1', data, 'Test', {
        sourcePageId: 'page-123',
        onUpdate,
      });
      useTableStore.getState().updateTableData('table-1', newData);

      const table = useTableStore.getState().getTable('table-1');
      expect(table?.sourcePageId).toBe('page-123');
      expect(table?.label).toBe('Test');
    });
  });

  describe('getTable', () => {
    it('returns undefined for non-existent table', () => {
      expect(useTableStore.getState().getTable('non-existent')).toBeUndefined();
    });

    it('returns table data for existing table', () => {
      const data: TableData = { rows: 3, cols: 4 };
      useTableStore.getState().registerTable('table-1', data, 'Test');

      const table = useTableStore.getState().getTable('table-1');
      expect(table).toEqual({
        id: 'table-1',
        data,
        label: 'Test',
        sourcePageId: undefined,
        onUpdate: undefined,
        sourceGeneration: 0,
      });
    });
  });

  describe('expandedTables state', () => {
    it('starts empty', () => {
      expect(useTableStore.getState().expandedTables).toEqual({});
    });

    it('tracks multiple tables', () => {
      const data: TableData = { rows: 1, cols: 1 };
      useTableStore.getState().registerTable('table-1', data, 'First');
      useTableStore.getState().registerTable('table-2', data, 'Second');
      useTableStore.getState().registerTable('table-3', data, 'Third');

      const { expandedTables } = useTableStore.getState();
      expect(Object.keys(expandedTables)).toHaveLength(3);
    });
  });
});

describe('T2/T-N5 actual source acceptance and rebind', () => {
  const original = (): TableData => ({
    id: 'synthetic-table',
    cells: [[{ value: 'before', type: 'text' }]],
    columnLabels: ['Sample'],
    columnWidths: { 0: 160 },
    rowHeights: { 0: 24 },
  });
  const patch: TableData = { cells: [[{ value: 'after', type: 'text' }]] };
  beforeEach(() => useTableStore.setState({ expandedTables: {} }));

  it('refuses edits without a mounted source and retains the exact prior data until rebind', () => {
    const data = original();
    useTableStore
      .getState()
      .registerTable('table', data, 'Table', { sourcePageId: 'synthetic-page' });
    expect(() => useTableStore.getState().updateTableData('table', patch)).toThrow(
      'Reopen the source notebook'
    );
    expect(useTableStore.getState().getTable('table')?.data).toBe(data);
    const source = vi.fn();
    useTableStore
      .getState()
      .registerTable('table', data, 'Table', { sourcePageId: 'synthetic-page', onUpdate: source });
    useTableStore.getState().updateTableData('table', patch);
    expect(source).toHaveBeenCalledTimes(1);
    expect(useTableStore.getState().getTable('table')?.data).toEqual({ ...data, ...patch });
  });

  it('does not publish optimistic data before synchronous source acceptance or after refusal', () => {
    const data = original();
    const refusal = new Error('synthetic source refusal');
    let refuse = true;
    const source = vi.fn(() => {
      expect(useTableStore.getState().getTable('table')?.data).toBe(data);
      if (refuse) throw refusal;
    });
    useTableStore.getState().registerTable('table', data, 'Table', { onUpdate: source });
    expect(() => useTableStore.getState().updateTableData('table', patch)).toThrow(refusal);
    expect(useTableStore.getState().getTable('table')?.data).toBe(data);
    refuse = false;
    useTableStore.getState().updateTableData('table', patch);
    expect(useTableStore.getState().getTable('table')?.data).toEqual({ ...data, ...patch });
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('an old source cleanup cannot unbind a newer mounted writer', () => {
    const oldWriter = vi.fn();
    const newWriter = vi.fn();
    const data = original();
    useTableStore.getState().registerTable('table', data, 'Table', { onUpdate: oldWriter });
    useTableStore.getState().registerTable('table', data, 'Table', { onUpdate: newWriter });
    useTableStore.getState().unbindSource('table', oldWriter);
    expect(useTableStore.getState().getTable('table')?.onUpdate).toBe(newWriter);
    useTableStore.getState().unbindSource('table', newWriter);
    expect(useTableStore.getState().getTable('table')?.onUpdate).toBeUndefined();
    expect(useTableStore.getState().getTable('table')?.data).toBe(data);
  });

  it.each(['resolve', 'reject'] as const)(
    'does not acknowledge an async writer or let its late %s replace a real rebind',
    async (outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const held = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const data = original();
      const source = vi.fn(() => held);
      useTableStore.getState().registerTable('table', data, 'Table', { onUpdate: source });
      expect(() => useTableStore.getState().updateTableData('table', patch)).toThrow(
        'synchronous source acceptance'
      );
      expect(useTableStore.getState().getTable('table')?.data).toBe(data);
      expect(useTableStore.getState().getTable('table')?.onUpdate).toBeUndefined();
      const fresh = {
        ...data,
        cells: [[{ value: 'authoritative rebind', type: 'text' as const }]],
      };
      const freshWriter = vi.fn();
      useTableStore.getState().registerTable('table', fresh, 'Table', { onUpdate: freshWriter });
      if (outcome === 'resolve') resolve();
      else reject(new Error('synthetic held refusal'));
      await held.catch(() => undefined);
      expect(useTableStore.getState().getTable('table')?.data).toBe(fresh);
      expect(useTableStore.getState().getTable('table')?.onUpdate).toBe(freshWriter);
      expect(freshWriter).not.toHaveBeenCalled();
    }
  );

  it('does not overwrite a source replaced synchronously during acceptance', () => {
    const data = original();
    const replacement = { ...data, cells: [[{ value: 'new source', type: 'text' as const }]] };
    const newer = vi.fn();
    useTableStore.getState().registerTable('table', data, 'Table', {
      onUpdate: () => {
        useTableStore.getState().registerTable('table', replacement, 'Table', { onUpdate: newer });
      },
    });
    expect(() => useTableStore.getState().updateTableData('table', patch)).toThrow(
      'source changed'
    );
    expect(useTableStore.getState().getTable('table')?.data).toBe(replacement);
    expect(useTableStore.getState().getTable('table')?.onUpdate).toBe(newer);
  });
});

it('keeps a local writer generation for ordinary updates and advances it only on authoritative binding changes', () => {
  useTableStore.setState({ expandedTables: {} });
  const source = vi.fn();
  const data: TableData = { cells: [[{ value: 'before', type: 'text' }]] };
  const store = useTableStore.getState();
  store.registerTable('table', data, 'Table', { sourcePageId: 'page-a', onUpdate: source });
  const first = store.getTable('table')!.sourceGeneration!;
  store.updateTableData('table', { name: 'Updated' });
  expect(store.getTable('table')!.sourceGeneration).toBe(first);
  store.registerTable('table', data, 'Table', { sourcePageId: 'page-a', onUpdate: source });
  expect(store.getTable('table')!.sourceGeneration).toBe(first);
  store.unbindSource('table', source);
  expect(store.getTable('table')!.sourceGeneration).toBe(first);
  store.registerTable('table', data, 'Table', { sourcePageId: 'page-a', onUpdate: source });
  expect(store.getTable('table')!.sourceGeneration).toBe(first + 1);
  store.registerTable('table', data, 'Table', { sourcePageId: 'page-b', onUpdate: source });
  expect(store.getTable('table')!.sourceGeneration).toBe(first + 2);
});
