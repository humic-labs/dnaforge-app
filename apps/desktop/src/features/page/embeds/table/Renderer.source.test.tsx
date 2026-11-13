// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableRenderer } from './Renderer';
import { TablePanel } from './components/TablePanel';
import { useTableStore } from './store/tableStore';
import { usePageStore } from '../../store';
import { useCanvasStore } from '../../../canvas/public/store';
import type { TableData } from './types';
import type { TableOperationObservation } from '../../../../shared/table-notebook-observation';
vi.mock('../../../../lib/analytics', async (original) => ({
  ...(await original<typeof import('../../../../lib/analytics')>()),
  isAnalyticsCaptureReady: () => true,
  captureAnalyticsOptionalOrigin: () => ({
    consentScope: '71400000-0000-4000-8000-000000000001',
    contextId: '71400000-0000-4000-8000-000000000002',
    processId: '71400000-0000-4000-8000-000000000003',
    classification: 'synthetic',
  }),
}));

vi.mock('../../store', async () => {
  const { create } = await import('zustand');
  return { usePageStore: create(() => ({ dirtyIds: new Set<string>() })) };
});
vi.mock('../../../canvas/public/store', async () => {
  const { create } = await import('zustand');
  return {
    useCanvasStore: create(() => ({
      panels: {},
      openWithSmartPlacement: vi.fn(),
      updateTab: vi.fn(),
    })),
  };
});
vi.mock('../components/EmbedWrapper', () => ({
  EmbedWrapper: ({
    label,
    children,
    onExpand,
  }: {
    label: import('react').ReactNode;
    children: import('react').ReactNode;
    onExpand?: () => void;
  }) => (
    <section>
      {label}
      {onExpand && (
        <button aria-label="Open table panel" onClick={onExpand}>
          Expand
        </button>
      )}
      {children}
    </section>
  ),
}));

const initial = (): TableData => ({
  id: 'synthetic-table',
  name: 'Synthetic',
  rows: 2,
  cols: 2,
  cells: [
    [
      { value: 'before', type: 'text' },
      { value: 'other', type: 'text' },
    ],
    [
      { value: 'third', type: 'text' },
      { value: 'last', type: 'text' },
    ],
  ],
  columnLabels: ['Sample', 'Condition'],
  columnWidths: { 0: 120, 1: 180 },
  rowHeights: { 0: 28 },
});
let scroll: PropertyDescriptor | undefined;
beforeEach(() => {
  useTableStore.setState({ expandedTables: {} });
  usePageStore.setState({ dirtyIds: new Set() });
  useCanvasStore.setState({ panels: {} });
  useCanvasStore.setState({ openWithSmartPlacement: vi.fn() });
  scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal('crypto', { randomUUID: () => 'NONFUNCTIONAL_SOURCE_REBIND_OPERATION' });
});

describe('T1 real configure/placement/panel provenance owners', () => {
  it('observes configuration at accepted dimension submission, never render or fresh-flag housekeeping', () => {
    const source = vi.fn(
      (_attrs: Record<string, unknown>, _observation?: TableOperationObservation) => {}
    );
    render(
      <TableRenderer
        type="table"
        refId="synthetic-table"
        attrs={{}}
        selected={false}
        onRemove={() => {}}
        onUpdateAttrs={source}
      />
    );
    expect(source).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('rows'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('cols'), { target: { value: '2' } });
    expect(source).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('cols'), { key: 'Enter' });
    expect(source).toHaveBeenCalledTimes(1);
    expect(source.mock.calls[0][0]).toMatchObject({ rows: 4, cols: 2, cells: [] });
    expect(source.mock.calls[0][1]).toEqual({
      version: 1,
      operation: 'configure',
      surface: 'inline',
      rows: 4,
      columns: 2,
      calculation: {
        result: 'none',
        evaluatedCount: 0,
        errorCount: 0,
        savedCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      },
    });
    expect(source.mock.calls[0][0]).not.toHaveProperty('observation');
  });

  it.each(['accepted', 'missing_tab', 'changed_writer'] as const)(
    'checks actual %s placement and mounted writer before accepting an open',
    (mode) => {
      const before = initial();
      const writes = vi.fn();
      const accepted: boolean[] = [];
      useCanvasStore.setState({
        openWithSmartPlacement: vi.fn(() => {
          if (mode !== 'missing_tab')
            useCanvasStore.setState({
              panels: {
                right: {
                  id: 'right',
                  activeTabId: 'opened-table',
                  tabs: [
                    {
                      id: 'opened-table',
                      type: 'table',
                      entityId: 'synthetic-table',
                      label: 'Table',
                    },
                  ],
                },
              },
            });
          if (mode === 'changed_writer') bind(before, vi.fn());
          return 'opened-table';
        }),
      });
      render(
        <TableRenderer
          type="table"
          refId="synthetic-table"
          attrs={before}
          selected={false}
          onRemove={() => {}}
          onUpdateAttrs={writes}
          onOpenTable={(open) => {
            accepted.push(open());
          }}
        />
      );
      expect(accepted).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Open table panel' }));
      expect(accepted).toEqual([mode === 'accepted']);
      expect(writes).not.toHaveBeenCalled();
    }
  );

  it('keeps inline and expanded mutation provenance attached to the current source through unbind/rebind', () => {
    const before = initial();
    const inline = vi.fn(
      (_attrs: Record<string, unknown>, _observation?: TableOperationObservation) => {}
    );
    const view = render(
      <TableRenderer
        type="table"
        refId="synthetic-table"
        attrs={before}
        selected={false}
        onRemove={() => {}}
        onUpdateAttrs={inline}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(inline.mock.calls[0][1]).toMatchObject({
      operation: 'structure',
      surface: 'inline',
      rows: 3,
      columns: 2,
    });
    view.unmount();
    const old = vi.fn((_attrs: TableData, _observation?: TableOperationObservation) => {});
    bind(before, old);
    render(<TablePanel tableId="synthetic-table" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(old.mock.calls[0][1]).toMatchObject({
      operation: 'structure',
      surface: 'expanded',
      rows: 3,
      columns: 2,
    });
    act(() => useTableStore.getState().unbindSource('synthetic-table', old));
    expect(screen.getByRole('button', { name: 'Add row' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(old).toHaveBeenCalledTimes(1);
    const fresh = vi.fn((_attrs: TableData, _observation?: TableOperationObservation) => {});
    act(() => bind(before, fresh));
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(fresh.mock.calls[0][1]).toMatchObject({
      operation: 'structure',
      surface: 'expanded',
      rows: 3,
      columns: 2,
    });
    expect(old).toHaveBeenCalledTimes(1);
    expect(stored().cells).toHaveLength(3);
  });
});
afterEach(() => {
  if (scroll) Object.defineProperty(Element.prototype, 'scrollIntoView', scroll);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  vi.unstubAllGlobals();
});
function bind(data: TableData, onUpdate?: (data: TableData) => void) {
  useTableStore.getState().registerTable('synthetic-table', data, 'Table', {
    sourcePageId: 'synthetic-page',
    onUpdate,
  });
}
function draft(text = 'new\ttable') {
  fireEvent.click(screen.getByRole('button', { name: 'Replace table…' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Replacement table data' }), {
    target: { value: text },
  });
}
function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Replace all cells' }));
}
function undo() {
  fireEvent.keyDown(screen.getByLabelText('Table keyboard navigation'), {
    key: 'z',
    ctrlKey: true,
  });
}
function redo() {
  fireEvent.keyDown(screen.getByLabelText('Table keyboard navigation'), {
    key: 'z',
    ctrlKey: true,
    shiftKey: true,
  });
}
const stored = () => useTableStore.getState().getTable('synthetic-table')!.data;

describe('T2/T-N5 real table source acceptance and recovery', () => {
  it('keeps an unbound panel read-only and enables it after a real source rebind', () => {
    const before = initial();
    bind(before);
    render(<TablePanel tableId="synthetic-table" />);
    expect(screen.getByText(/Source notebook is not available/)).toBeInTheDocument();
    expect(screen.getByTestId('table-grid')).toHaveAttribute('data-read-only', 'true');
    expect(screen.getByRole('button', { name: 'Add row' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Replace table…' })).toBeDisabled();
    expect(stored()).toBe(before);
    const source = vi.fn();
    act(() => bind(before, source));
    expect(screen.queryByText(/Source notebook is not available/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add row' })).toBeEnabled();
    draft();
    submit();
    expect(source).toHaveBeenCalledTimes(1);
    expect(stored().cells?.map((row) => row.map((cell) => cell.value))).toEqual([['new', 'table']]);
    expect(before.cells?.[0][0].value).toBe('before');
  });

  it('retains prior store/data/history and the replacement draft after a refused source, then retries and Undo/Redo once', () => {
    const before = initial();
    let refuse = true;
    const source = vi.fn(() => {
      if (refuse) throw new Error('synthetic source refusal');
    });
    bind(before, source);
    render(<TablePanel tableId="synthetic-table" />);
    draft();
    submit();
    expect(stored()).toBe(before);
    expect(screen.getByRole('textbox', { name: 'Replacement table data' })).toHaveValue(
      'new\ttable'
    );
    expect(screen.getByText(/The source did not accept this change/)).toBeInTheDocument();
    expect(source).toHaveBeenCalledTimes(1);
    refuse = false;
    submit();
    const accepted = stored();
    expect(accepted.cells?.[0][0].value).toBe('new');
    expect(accepted.columnWidths).toEqual(before.columnWidths);
    expect(source).toHaveBeenCalledTimes(2);
    undo();
    expect(stored()).toMatchObject(before);
    const count = source.mock.calls.length;
    undo();
    expect(source).toHaveBeenCalledTimes(count);
    redo();
    expect(stored()).toEqual(accepted);
  });

  it('refuses held async acceptance, preserves the draft and does not overwrite a newer authoritative rebind on settlement', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const before = initial();
    bind(before, () => held);
    render(<TablePanel tableId="synthetic-table" />);
    draft();
    submit();
    expect(stored()).toBe(before);
    expect(screen.getByText(/Source notebook is not available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace all cells' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Replacement table data' })).toHaveValue(
      'new\ttable'
    );
    const fresh = initial();
    fresh.cells![0][0] = { value: 'fresh authoritative source', type: 'text' };
    const currentWriter = vi.fn();
    act(() => bind(fresh, currentWriter));
    await act(async () => {
      finish();
      await held;
    });
    expect(stored()).toBe(fresh);
    expect(useTableStore.getState().getTable('synthetic-table')?.onUpdate).toBe(currentWriter);
    expect(screen.getByRole('button', { name: 'Replace all cells' })).toBeEnabled();
    submit();
    expect(currentWriter).toHaveBeenCalledTimes(1);
    undo();
    expect(stored()).toMatchObject(fresh);
  });

  it('shows notebook unsaved state after attribute acceptance while the owning save is held', async () => {
    let finish!: () => void;
    const saved = new Promise<void>((resolve) => {
      finish = resolve;
    });
    bind(initial(), () => {
      usePageStore.setState({ dirtyIds: new Set(['synthetic-page']) });
      void saved.then(() => usePageStore.setState({ dirtyIds: new Set() }));
    });
    render(<TablePanel tableId="synthetic-table" />);
    draft();
    submit();
    expect(stored().cells?.[0][0].value).toBe('new');
    expect(screen.getByText('Source notebook has unsaved changes.')).toBeInTheDocument();
    expect(screen.queryByText(/^Saved$/)).not.toBeInTheDocument();
    await act(async () => {
      finish();
      await saved;
    });
    expect(screen.queryByText('Source notebook has unsaved changes.')).not.toBeInTheDocument();
    expect(stored().cells?.[0][0].value).toBe('new');
  });

  it('actual source mount binds, unmount detaches only its writer, and remount restores current source data', () => {
    useCanvasStore.setState({
      panels: {
        pane: {
          id: 'pane',
          tabs: [{ id: 'table-tab', type: 'table', entityId: 'synthetic-table', label: 'Table' }],
          activeTabId: 'table-tab',
        },
      },
    });
    const source = vi.fn();
    const before = initial();
    function Scene({ show, data }: { show: boolean; data: TableData }) {
      return (
        <>
          {show && (
            <TableRenderer
              refId="synthetic-table"
              attrs={data}
              selected={false}
              onRemove={vi.fn()}
              onUpdateAttrs={source}
            />
          )}
          <TablePanel tableId="synthetic-table" />
        </>
      );
    }
    const view = render(<Scene show data={before} />);
    expect(useTableStore.getState().getTable('synthetic-table')?.onUpdate).toBeTypeOf('function');
    view.rerender(<Scene show={false} data={before} />);
    expect(useTableStore.getState().getTable('synthetic-table')?.onUpdate).toBeUndefined();
    expect(stored()).toBe(before);
    expect(screen.getByText(/Source notebook is not available/)).toBeInTheDocument();
    const fresh = initial();
    fresh.cells![0][0] = { value: 'reopened source attrs', type: 'text' };
    view.rerender(<Scene show data={fresh} />);
    expect(stored()).toBe(fresh);
    expect(useTableStore.getState().getTable('synthetic-table')?.onUpdate).toBeTypeOf('function');
    expect(screen.queryByText(/Source notebook is not available/)).not.toBeInTheDocument();
    expect(source).not.toHaveBeenCalled();
  });
});

it('keeps an inline table without a source callback read-only, then accepts edits after binding', () => {
  const data = initial();
  const source = vi.fn();
  const view = render(
    <TableRenderer refId="synthetic-table" attrs={data} selected={false} onRemove={vi.fn()} />
  );
  expect(screen.getByTestId('table-grid')).toHaveAttribute('data-read-only', 'true');
  expect(screen.getByRole('button', { name: 'Add row' })).toBeDisabled();
  view.rerender(
    <TableRenderer
      refId="synthetic-table"
      attrs={data}
      selected={false}
      onRemove={vi.fn()}
      onUpdateAttrs={source}
    />
  );
  expect(screen.getByRole('button', { name: 'Add row' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
  expect(source).toHaveBeenCalledTimes(1);
  expect(source.mock.calls[0][0]).toMatchObject({ id: 'synthetic-table', rows: 3, cols: 2 });
});

it('does not replay old writer history or clipboard ownership after an authoritative rebind', () => {
  const oldWriter = vi.fn();
  const before = initial();
  before.cells![0][0].format = { bold: true };
  bind(before, oldWriter);
  render(<TablePanel tableId="synthetic-table" />);
  const oldGrid = screen.getByTestId('table-grid');
  fireEvent.mouseDown(document.querySelector('[data-cell-position="0,0"]')!);
  fireEvent.mouseUp(document);
  const copied = new Map<string, string>();
  const clipboardData = {
    getData: (type: string) => copied.get(type) ?? '',
    setData: (type: string, value: string) => {
      copied.set(type, value);
    },
  };
  fireEvent.cut(oldGrid, { clipboardData });
  expect(copied.get('application/x-dnaforge-table-operation')).toBeTruthy();
  draft();
  submit();
  expect(stored().cells?.[0][0].value).toBe('new');
  act(() => useTableStore.getState().unbindSource('synthetic-table', oldWriter));
  expect(stored().cells?.[0][0].value).toBe('new');
  const fresh = initial();
  fresh.cells![0][0] = { value: 'new authoritative revision', type: 'text' };
  const newWriter = vi.fn();
  act(() => bind(fresh, newWriter));
  expect(screen.getByTestId('table-grid')).not.toBe(oldGrid);
  undo();
  expect(newWriter).not.toHaveBeenCalled();
  expect(stored()).toBe(fresh);
  fireEvent.mouseDown(document.querySelector('[data-cell-position="1,1"]')!);
  fireEvent.mouseUp(document);
  fireEvent.paste(screen.getByTestId('table-grid'), { clipboardData });
  const afterPaste = stored();
  expect(afterPaste.cells?.[0][0].value).toBe('new authoritative revision');
  expect(afterPaste.cells?.[1][1]).toEqual({ value: 'before', type: 'text' });
  draft('current\trevision');
  submit();
  expect(newWriter).toHaveBeenCalledTimes(2);
  undo();
  expect(stored()).toEqual(afterPaste);
  undo();
  expect(stored()).toMatchObject(fresh);
});

it('keeps a refused panel-name draft for deliberate retry without changing source data', () => {
  const before = initial();
  let refuse = true;
  const source = vi.fn(() => {
    if (refuse) throw new Error('synthetic rename refusal');
  });
  bind(before, source);
  render(<TablePanel tableId="synthetic-table" />);
  fireEvent.click(screen.getByRole('button', { name: 'Synthetic' }));
  const input = screen.getByDisplayValue('Synthetic');
  fireEvent.change(input, { target: { value: 'Renamed' } });
  fireEvent.blur(input);
  expect(stored()).toBe(before);
  expect(screen.getByDisplayValue('Renamed')).toBeInTheDocument();
  expect(screen.getByText(/The source did not accept this change/)).toBeInTheDocument();
  refuse = false;
  fireEvent.keyDown(screen.getByDisplayValue('Renamed'), { key: 'Enter' });
  expect(stored().name).toBe('Renamed');
  expect(source).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Renamed' })).toBeInTheDocument();
});
