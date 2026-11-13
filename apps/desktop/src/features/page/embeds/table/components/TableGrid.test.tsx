import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TableGrid } from './TableGrid';
import type { Cell } from '../types';

const cells: Cell[][] = [
  [
    { type: 'text', value: 'sample-a' },
    { type: 'text', value: 'control' },
  ],
  [
    { type: 'text', value: 'sample-b' },
    { type: 'text', value: 'treated' },
  ],
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function renderGrid(overrides: Partial<ComponentProps<typeof TableGrid>> = {}) {
  const onDeleteRange = vi.fn();
  const onColumnLabelChange = vi.fn();

  render(
    <TableGrid
      displayCells={cells}
      cells={cells}
      visibleRowIndices={[0, 1]}
      sort={null}
      filters={{}}
      onCellChange={vi.fn()}
      onExpandAndSetCell={vi.fn()}
      onFillRange={vi.fn()}
      onDeleteRange={onDeleteRange}
      onSort={vi.fn()}
      onFilter={vi.fn()}
      onPaste={vi.fn(() => false)}
      onColumnLabelChange={onColumnLabelChange}
      {...overrides}
    />
  );

  return { onDeleteRange, onColumnLabelChange };
}

function renderGridWithRerender(overrides: Partial<ComponentProps<typeof TableGrid>> = {}) {
  const base = {
    displayCells: cells,
    cells,
    visibleRowIndices: [0, 1],
    sort: null,
    filters: {},
    onCellChange: vi.fn(),
    onExpandAndSetCell: vi.fn(),
    onFillRange: vi.fn(),
    onDeleteRange: vi.fn(),
    onSort: vi.fn(),
    onFilter: vi.fn(),
    onPaste: vi.fn(() => false),
  } satisfies Partial<ComponentProps<typeof TableGrid>>;
  const view = render(<TableGrid {...(base as ComponentProps<typeof TableGrid>)} {...overrides} />);
  return {
    rerender: (next: Partial<ComponentProps<typeof TableGrid>>) =>
      view.rerender(
        <TableGrid {...(base as ComponentProps<typeof TableGrid>)} {...overrides} {...next} />
      ),
  };
}

function copyGridText(): string {
  const clipboardData = {
    clearData: vi.fn(),
    getData: vi.fn(),
    setData: vi.fn(),
  };
  fireEvent.copy(screen.getByTestId('table-grid'), { clipboardData });
  return clipboardData.setData.mock.calls.find(([type]) => type === 'text/plain')?.[1] ?? '';
}

function withElementFromPoint(element: Element, callback: () => void) {
  const original = document.elementFromPoint;
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => element),
  });
  try {
    callback();
  } finally {
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: original,
    });
  }
}

describe('TableGrid keyboard routing', () => {
  const sink = () => screen.getByLabelText('Table keyboard navigation');
  const focusedPosition = () =>
    document
      .querySelector('[data-testid="cell-focus-ring"]')
      ?.closest('[data-cell-position]')
      ?.getAttribute('data-cell-position') ?? null;

  function focusCell(row: number, col: number) {
    fireEvent.mouseDown(document.querySelector(`[data-cell-position="${row},${col}"]`)!);
    fireEvent.mouseUp(document);
  }

  it('routes arrow keys to the navigation hook', () => {
    renderGrid();
    focusCell(0, 0);
    expect(focusedPosition()).toBe('0,0');

    fireEvent.keyDown(sink(), { key: 'ArrowDown' });
    expect(focusedPosition()).toBe('1,0');
    fireEvent.keyDown(sink(), { key: 'ArrowRight' });
    expect(focusedPosition()).toBe('1,1');
  });

  it('routes select-all to the navigation hook alongside the arrow keys', () => {
    renderGrid();
    focusCell(0, 0);

    fireEvent.keyDown(sink(), { key: 'a', ctrlKey: true });
    expect(document.querySelectorAll('[data-table-selected="true"]')).toHaveLength(4);
  });

  it('opens the editor on Enter and on F2, and on a printable character', () => {
    renderGrid();
    focusCell(0, 0);

    fireEvent.keyDown(sink(), { key: 'Enter' });
    expect(document.querySelectorAll('[data-cell-position="0,0"] input')).toHaveLength(1);

    fireEvent.keyDown(document.querySelector('[data-cell-position="0,0"] input')!, {
      key: 'Escape',
    });
    expect(document.querySelectorAll('[data-cell-position="0,0"] input')).toHaveLength(0);

    fireEvent.keyDown(sink(), { key: 'F2' });
    expect(document.querySelectorAll('[data-cell-position="0,0"] input')).toHaveLength(1);

    fireEvent.keyDown(document.querySelector('[data-cell-position="0,0"] input')!, {
      key: 'Escape',
    });
    fireEvent.keyDown(sink(), { key: 'x' });
    const editor = document.querySelector<HTMLInputElement>('[data-cell-position="0,0"] input');
    expect(editor?.value).toBe('x');
  });

  it('preserves continued typing when the initial edit focus runs late', () => {
    vi.useFakeTimers();
    try {
      const onCellChange = vi.fn();
      renderGrid({ onCellChange });
      focusCell(0, 0);
      act(() => vi.runOnlyPendingTimers());
      fireEvent.keyDown(sink(), { key: 'r' });
      fireEvent.keyDown(sink(), { key: 'e' });
      const input = document.querySelector<HTMLInputElement>('[data-cell-position="0,0"] input')!;
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: 'rep', selectionStart: 3, selectionEnd: 3 } });
      expect(input.selectionStart).toBe(3);

      act(() => vi.runOnlyPendingTimers());

      expect(input.selectionStart).toBe(3);
      expect(input.selectionEnd).toBe(3);
      input.setRangeText('lacement', input.selectionStart!, input.selectionEnd!, 'end');
      fireEvent.change(input, { target: { value: input.value, selectionStart: 11 } });
      expect(input.value).toBe('replacement');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onCellChange).toHaveBeenCalledWith(0, 0, 'replacement');
    } finally {
      vi.useRealTimers();
    }
  });

  for (const key of ['Enter', 'F2']) {
    it(`selects the existing cell value after unmodified ${key} edit focus`, () => {
      vi.useFakeTimers();
      try {
        renderGrid();
        focusCell(0, 0);
        act(() => vi.runOnlyPendingTimers());
        fireEvent.keyDown(sink(), { key });
        const input = document.querySelector<HTMLInputElement>('[data-cell-position="0,0"] input')!;

        act(() => vi.runOnlyPendingTimers());

        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('sample-a');
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe('sample-a'.length);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('commits an edit without reclaiming focus when the user returns to notebook text', () => {
    const onCellChange = vi.fn();
    renderGrid({ onCellChange });
    render(
      <div
        contentEditable
        suppressContentEditableWarning
        tabIndex={0}
        data-testid="outside-notebook"
      >
        Notebook text
      </div>
    );
    focusCell(0, 0);
    fireEvent.keyDown(sink(), { key: 'Enter' });
    const input = document.querySelector<HTMLInputElement>('[data-cell-position="0,0"] input')!;
    fireEvent.change(input, { target: { value: 'changed sample' } });
    const notebook = screen.getByTestId('outside-notebook');

    act(() => input.focus());
    act(() => notebook.focus());

    expect(onCellChange).toHaveBeenCalledWith(0, 0, 'changed sample');
    expect(document.activeElement).toBe(notebook);
    expect(focusedPosition()).toBeNull();
    expect(document.querySelector('[data-cell-position="0,0"] input')).toBeNull();
  });

  it('cancels the edit on Escape without committing', () => {
    const onCellChange = vi.fn();
    renderGrid({ onCellChange });
    focusCell(0, 0);

    fireEvent.keyDown(sink(), { key: 'y' });
    const editor = document.querySelector<HTMLInputElement>('[data-cell-position="0,0"] input')!;
    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(document.querySelectorAll('[data-cell-position="0,0"] input')).toHaveLength(0);
    expect(onCellChange).not.toHaveBeenCalled();
  });

  it('clears focus on Escape when not editing, and clears a pending cut first', () => {
    const onClearCut = vi.fn();
    const { rerender } = renderGridWithRerender({
      cutRange: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
      onClearCut,
    });
    focusCell(1, 1);

    fireEvent.keyDown(sink(), { key: 'Escape' });
    expect(onClearCut).toHaveBeenCalledTimes(1);
    expect(focusedPosition()).toBe('1,1');

    rerender({ cutRange: null, onClearCut });
    fireEvent.keyDown(sink(), { key: 'Escape' });
    expect(focusedPosition()).toBeNull();
  });

  it('deletes a multi-cell selection with Delete', () => {
    const { onDeleteRange } = renderGrid();
    focusCell(0, 0);
    fireEvent.keyDown(sink(), { key: 'a', ctrlKey: true });
    fireEvent.keyDown(sink(), { key: 'Delete' });

    expect(onDeleteRange).toHaveBeenCalledWith({
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
    });
  });

  it('leaves every mutation alone in read-only mode', () => {
    const onCellChange = vi.fn();
    const { onDeleteRange } = renderGrid({ readOnly: true, onCellChange });
    focusCell(0, 0);

    fireEvent.keyDown(sink(), { key: 'Enter' });
    expect(document.querySelectorAll('[data-cell-position="0,0"] input')).toHaveLength(0);
    fireEvent.keyDown(sink(), { key: 'z' });
    expect(document.querySelectorAll('[data-cell-position="0,0"] input')).toHaveLength(0);

    fireEvent.keyDown(sink(), { key: 'a', ctrlKey: true });
    fireEvent.keyDown(sink(), { key: 'Delete' });
    expect(onDeleteRange).not.toHaveBeenCalled();
    expect(onCellChange).not.toHaveBeenCalled();
  });
});

describe('TableGrid shared interactions', () => {
  it('opens find from the keyboard shortcut and filters visible rows', () => {
    renderGrid();

    expect(screen.queryByTestId('table-search-input')).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId('table-grid'), { key: 'f', metaKey: true });

    const search = screen.getByTestId('table-search-input');
    expect(screen.getByTestId('table-search-popover')).toBeInTheDocument();
    expect(search).toHaveFocus();

    fireEvent.change(search, {
      target: { value: 'treated' },
    });

    expect(screen.getByText('treated')).toBeInTheDocument();
    expect(screen.getByText('sample-b')).toBeInTheDocument();
    expect(screen.queryByText('control')).not.toBeInTheDocument();
    expect(screen.queryByText('sample-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('table-search-count')).toHaveTextContent('1/2');
    expect(screen.getByTestId('table-search-count')).toHaveAccessibleName('1 of 2 rows');
  });

  it('selects a full data column from the spreadsheet letter header', () => {
    const { onDeleteRange } = renderGrid();

    fireEvent.click(screen.getByRole('button', { name: 'Select column A' }));
    fireEvent.keyDown(screen.getByLabelText('Table keyboard navigation'), { key: 'Delete' });

    expect(screen.getByTestId('table-column-header-A')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('table-column-header-selection-A')).toBeInTheDocument();
    expect(onDeleteRange).toHaveBeenCalledWith({
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 0,
    });
  });

  it('drags and copies custom label headers without selecting data columns', () => {
    const { onDeleteRange } = renderGrid({
      columnLabels: ['Sample', 'Condition'],
      showColumnLabels: true,
    });

    expect(screen.getByRole('button', { name: 'Select column A' })).toHaveClass('h-5');
    expect(screen.getByTestId('table-column-label-0')).toHaveClass('h-5', 'text-[11px]');

    fireEvent.mouseDown(screen.getByTestId('table-column-label-0'));
    fireEvent.mouseEnter(screen.getByTestId('table-column-label-1'));
    fireEvent.mouseUp(document);

    const clipboardData = {
      clearData: vi.fn(),
      getData: vi.fn(),
      setData: vi.fn(),
    };
    fireEvent.copy(screen.getByTestId('table-grid'), { clipboardData });
    fireEvent.keyDown(screen.getByLabelText('Table keyboard navigation'), { key: 'Delete' });

    expect(screen.getByTestId('table-column-header-A')).not.toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('table-column-header-B')).not.toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('table-column-label-cell-0')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('table-column-label-cell-1')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.queryByTestId('table-column-label-selection-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('table-column-label-selection-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('table-promoted-row-selection-range')).toBeInTheDocument();
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'Sample\tCondition');
    expect(onDeleteRange).not.toHaveBeenCalled();
  });

  it('extends a body-cell drag into the promoted label row as one rectangular selection', () => {
    renderGrid({
      columnLabels: ['Sample', 'Condition'],
      showColumnLabels: true,
    });

    const firstBodyCell = document.querySelector('[data-cell-position="0,0"]');
    const secondLabel = screen.getByTestId('table-column-label-1');
    expect(firstBodyCell).not.toBeNull();

    withElementFromPoint(secondLabel, () => {
      fireEvent.mouseDown(firstBodyCell!);
      fireEvent.mouseMove(document);
      fireEvent.mouseUp(document);
    });

    expect(screen.getByTestId('table-column-label-cell-0')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('table-column-label-cell-1')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(document.querySelector('[data-cell-position="0,0"]')).toHaveAttribute(
      'data-table-selected',
      'true'
    );
    expect(document.querySelector('[data-cell-position="0,1"]')).toHaveAttribute(
      'data-table-selected',
      'true'
    );
    expect(screen.getByTestId('table-column-header-A')).not.toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(copyGridText()).toBe('Sample\tCondition\nsample-a\tcontrol');
  });

  it('extends a promoted-label drag into body cells as one rectangular selection', () => {
    renderGrid({
      columnLabels: ['Sample', 'Condition'],
      showColumnLabels: true,
    });

    const secondBodyCell = document.querySelector('[data-cell-position="0,1"]');
    expect(secondBodyCell).not.toBeNull();

    withElementFromPoint(secondBodyCell!, () => {
      fireEvent.mouseDown(screen.getByTestId('table-column-label-0'));
      fireEvent.mouseMove(document);
      fireEvent.mouseUp(document);
    });

    expect(screen.getByTestId('table-column-label-cell-0')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('table-column-label-cell-1')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(document.querySelector('[data-cell-position="0,0"]')).toHaveAttribute(
      'data-table-selected',
      'true'
    );
    expect(document.querySelector('[data-cell-position="0,1"]')).toHaveAttribute(
      'data-table-selected',
      'true'
    );
    expect(screen.getByTestId('table-column-header-B')).not.toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(copyGridText()).toBe('Sample\tCondition\nsample-a\tcontrol');
  });

  it('does not mark column letters selected when a body drag happens to span all data rows', () => {
    renderGrid({
      columnLabels: ['Sample', 'Condition'],
      showColumnLabels: true,
    });

    const bottomRightCell = document.querySelector('[data-cell-position="1,1"]');
    const topLeftCell = document.querySelector('[data-cell-position="0,0"]');
    expect(bottomRightCell).not.toBeNull();
    expect(topLeftCell).not.toBeNull();

    withElementFromPoint(topLeftCell!, () => {
      fireEvent.mouseDown(bottomRightCell!);
      fireEvent.mouseMove(document);
      fireEvent.mouseUp(document);
    });

    expect(document.querySelector('[data-cell-position="0,0"]')).toHaveAttribute(
      'data-table-selected',
      'true'
    );
    expect(document.querySelector('[data-cell-position="0,1"]')).toHaveAttribute(
      'data-table-selected',
      'true'
    );
    expect(document.querySelector('[data-cell-position="1,0"]')).toHaveAttribute(
      'data-table-selected',
      'true'
    );
    expect(document.querySelector('[data-cell-position="1,1"]')).toHaveAttribute(
      'data-table-selected',
      'true'
    );
    expect(screen.getByTestId('table-column-header-A')).not.toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('table-column-header-B')).not.toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(copyGridText()).toBe('sample-a\tcontrol\nsample-b\ttreated');
  });

  it('edits custom column labels when the caller enables label persistence', () => {
    const onColumnLabelChange = vi.fn();
    renderGrid({
      columnLabels: ['Sample', 'Condition'],
      showColumnLabels: true,
      onColumnLabelChange,
    });

    fireEvent.doubleClick(screen.getByTestId('table-column-label-1'));
    const labelInput = screen.getByTestId('table-column-label-input-1');
    fireEvent.change(labelInput, { target: { value: 'Treatment' } });
    fireEvent.keyDown(labelInput, { key: 'Enter' });

    expect(onColumnLabelChange).toHaveBeenCalledWith(1, 'Treatment');
  });

  it('does not enable a horizontal scrollport when the grid content fits', () => {
    renderGrid();
    const scroll = screen.getByTestId('table-grid-scroll');
    expect(scroll).toHaveAttribute('data-overflow-x', 'none');
    expect(scroll).not.toHaveClass('overflow-x-auto');
  });

  it('clips vertical overflow whenever a horizontal scrollport is required', () => {
    renderGrid({
      columnWidths: { 0: 900, 1: 900 },
    });
    const scroll = screen.getByTestId('table-grid-scroll');
    if (scroll.getAttribute('data-overflow-x') === 'auto') {
      expect(scroll).toHaveClass('overflow-y-clip');
    }
  });

  it('renders covered cells in their own columns when a vertical merge anchor is filtered out', () => {
    const mergedCells: Cell[][] = [
      [
        { type: 'text', value: 'merged', span: { rows: 2, cols: 2 } },
        { type: 'text', value: '', covered: true },
        { type: 'text', value: 'anchor-tail' },
      ],
      [
        { type: 'text', value: '', covered: true },
        { type: 'text', value: '', covered: true },
        { type: 'text', value: 'visible-tail' },
      ],
      [
        { type: 'text', value: 'ordinary-a' },
        { type: 'text', value: 'ordinary-b' },
        { type: 'text', value: 'ordinary-c' },
      ],
    ];

    renderGrid({
      cells: mergedCells,
      displayCells: mergedCells,
      visibleRowIndices: [1, 2],
    });

    const visibleTail = screen.getByText('visible-tail').closest('tr');
    expect(visibleTail).not.toBeNull();
    expect(visibleTail!.querySelectorAll('td')).toHaveLength(4);
    expect(visibleTail!.querySelector('[data-cell-position="1,0"]')).toBeInTheDocument();
    expect(visibleTail!.querySelector('[data-cell-position="1,1"]')).toBeInTheDocument();
    expect(visibleTail!.querySelector('[data-cell-position="1,2"]')).toBeInTheDocument();
  });

  it('keeps a vertical merge only while its source rows remain adjacent and ordered', () => {
    const mergedCells: Cell[][] = [
      [
        { type: 'text', value: 'merged', span: { rows: 2, cols: 2 } },
        { type: 'text', value: '', covered: true },
        { type: 'text', value: 'anchor-tail' },
      ],
      [
        { type: 'text', value: '', covered: true },
        { type: 'text', value: '', covered: true },
        { type: 'text', value: 'covered-tail' },
      ],
    ];

    const { unmount } = render(
      <TableGrid
        displayCells={mergedCells}
        cells={mergedCells}
        visibleRowIndices={[0, 1]}
        sort={null}
        filters={{}}
        onCellChange={vi.fn()}
        onExpandAndSetCell={vi.fn()}
        onFillRange={vi.fn()}
        onDeleteRange={vi.fn()}
        onSort={vi.fn()}
        onFilter={vi.fn()}
        onPaste={vi.fn(() => false)}
      />
    );

    const merged = screen.getByText('merged').closest('td');
    expect(merged).toHaveAttribute('rowspan', '2');
    expect(merged).toHaveAttribute('colspan', '2');
    expect(document.querySelector('[data-cell-position="1,0"]')).not.toBeInTheDocument();
    unmount();

    renderGrid({
      cells: mergedCells,
      displayCells: mergedCells,
      visibleRowIndices: [1, 0],
    });
    const reorderedCoveredRow = screen.getByText('covered-tail').closest('tr');
    expect(reorderedCoveredRow).not.toBeNull();
    expect(reorderedCoveredRow!.querySelectorAll('td')).toHaveLength(4);
  });

  it('keeps saved column widths when coordinate and label rows are hidden', () => {
    renderGrid({
      showCoordinateHeaders: false,
      showColumnLabels: false,
      columnWidths: { 0: 137, 1: 211 },
    });

    const columns = document.querySelectorAll('colgroup col');
    expect(columns).toHaveLength(3);
    expect(columns[1]).toHaveStyle({ width: '137px' });
    expect(columns[2]).toHaveStyle({ width: '211px' });
  });
});

describe('T2 real grid clipboard routing', () => {
  function focusClipboardCell(row: number, col: number) {
    fireEvent.mouseDown(document.querySelector(`[data-cell-position="${row},${col}"]`)!);
    fireEvent.mouseUp(document);
  }
  function transfer(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      data,
      getData: vi.fn((type: string) => data.get(type) ?? ''),
      setData: vi.fn((type: string, value: string) => {
        data.set(type, value);
      }),
    };
  }

  it('routes external HTML/TSV to the actual focused non-origin coordinate', () => {
    const onPaste = vi.fn(() => true);
    const onPasteHTML = vi.fn(() => true);
    renderGrid({ onPaste, onPasteHTML });
    focusClipboardCell(1, 1);
    const html = '<table><tr><td>X</td><td>Y</td></tr></table>';
    fireEvent.paste(screen.getByTestId('table-grid'), {
      clipboardData: transfer({ 'text/plain': 'X\tY', 'text/html': html }),
    });
    expect(onPasteHTML).toHaveBeenCalledExactlyOnceWith(html, 1, 1);
    expect(onPaste).not.toHaveBeenCalled();
    fireEvent.paste(screen.getByTestId('table-grid'), {
      clipboardData: transfer({ 'text/plain': 'Z\tW' }),
    });
    expect(onPaste).toHaveBeenCalledExactlyOnceWith('Z\tW', 1, 1);
  });

  it('label copy revokes the earlier actual grid cut token, even if that old event is replayed', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'NONFUNCTIONAL_GRID_OPERATION' });
    try {
      const onPasteCells = vi.fn();
      const onPaste = vi.fn(() => true);
      renderGrid({
        onCopyCells: () => [[{ ...cells[0][0], format: { bold: true } }]],
        onCutCells: () => [[{ ...cells[0][0], format: { bold: true } }]],
        onPasteCells,
        onPaste,
        columnLabels: ['Sample', 'Condition'],
        showColumnLabels: true,
      });
      focusClipboardCell(0, 0);
      const original = transfer();
      fireEvent.cut(screen.getByTestId('table-grid'), { clipboardData: original });
      expect(original.data.get('application/x-dnaforge-table-operation')).toBe(
        'NONFUNCTIONAL_GRID_OPERATION'
      );
      fireEvent.mouseDown(screen.getByTestId('table-column-label-0'));
      fireEvent.mouseUp(document);
      const label = transfer();
      fireEvent.copy(screen.getByTestId('table-grid'), { clipboardData: label });
      expect(label.data.get('text/plain')).toBe('Sample');
      focusClipboardCell(1, 1);
      fireEvent.paste(screen.getByTestId('table-grid'), { clipboardData: original });
      expect(onPasteCells).not.toHaveBeenCalled();
      expect(onPaste).toHaveBeenCalledWith('sample-a', 1, 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not intercept the native paste of an actual open cell editor', () => {
    const onPaste = vi.fn(() => true);
    renderGrid({ onPaste });
    focusClipboardCell(0, 0);
    fireEvent.keyDown(screen.getByLabelText('Table keyboard navigation'), { key: 'Enter' });
    const editor = document.querySelector('[data-cell-position="0,0"] input');
    expect(editor).not.toBeNull();
    const clipboardData = transfer({ 'text/plain': 'EDIT_INPUT' });
    fireEvent.paste(editor!, { clipboardData });
    expect(clipboardData.getData).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });
});

describe(' actual saved-result grid consumers', () => {
  it.each(['text', 'formula'] as const)(
    'uses visible saved %s values for cell/label copy and auto-fit',
    (type) => {
      const savedValue = '314159265358979';
      const saved: Cell =
        type === 'text'
          ? {
              type,
              value: savedValue,
              sourceFormula: '=SOURCE()',
              sourceRenderedValue: savedValue,
              formulaCompatibility: 'unsupported',
              stale: true,
            }
          : {
              type,
              value: '=SOURCE()',
              sourceRenderedValue: savedValue,
              computed: -999,
              formulaCompatibility: 'unsupported',
              stale: true,
            };
      const grid: Cell[][] = [[saved], [{ type: 'text', value: '2' }]];
      const onColumnResize = vi.fn();
      const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
      const measureText = vi.fn((text: string) => ({ width: text.length * 10 }));
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: () => ({ font: '', measureText }),
      });
      try {
        renderGrid({
          cells: grid,
          displayCells: grid,
          visibleRowIndices: [0, 1],
          columnLabels: ['Saved'],
          showColumnLabels: true,
          showGhostRows: false,
          showGhostCols: false,
          onColumnResize,
        });
        const first = document.querySelector('[data-cell-position="0,0"]')!;
        expect(first).toHaveTextContent(savedValue);
        fireEvent.mouseDown(first);
        fireEvent.mouseUp(document);
        expect(copyGridText()).toBe(savedValue);
        const label = screen.getByTestId('table-column-label-0');
        withElementFromPoint(label, () => {
          fireEvent.mouseDown(first);
          fireEvent.mouseMove(document);
          fireEvent.mouseUp(document);
        });
        expect(copyGridText()).toBe(`Saved\n${savedValue}`);
        const handle = screen
          .getByTestId('table-column-header-A')
          .querySelector('[data-column-resize-handle="true"]')!;
        expect(handle).not.toBeNull();
        fireEvent.doubleClick(handle);
        expect(measureText).toHaveBeenCalledWith(savedValue);
        expect(measureText).not.toHaveBeenCalledWith('=SOURCE()');
        expect(measureText).not.toHaveBeenCalledWith('-999');
        expect(onColumnResize).toHaveBeenCalledWith(0, 174);
        expect(saved.stale).toBe(true);
      } finally {
        if (descriptor)
          Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor);
        else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext');
      }
    }
  );
});
