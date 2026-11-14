import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../types';
import { TableGrid } from './TableGrid';
import * as presentation from './table-cell-presentation';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderGrid() {
  const cells: Cell[][] = Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 3 }, (_, col) => ({ type: 'text', value: `${row}:${col}` }))
  );
  render(
    <TableGrid
      displayCells={cells}
      cells={cells}
      visibleRowIndices={[0, 1, 2, 3]}
      filters={{}}
      onCellChange={vi.fn()}
      onExpandAndSetCell={vi.fn()}
      onFillRange={vi.fn()}
      onDeleteRange={vi.fn()}
      onPaste={vi.fn(() => false)}
      showGhostCols
    />
  );
  fireEvent.mouseDown(document.querySelector('[data-cell-position="0,0"]')!);
  fireEvent.mouseUp(document);
  return { unchangedCell: cells[3][2] };
}

describe('TableGrid rendering during keyboard interaction', () => {
  it('keeps unchanged cell presentation out of another cell draft update', () => {
    vi.useFakeTimers();
    const displayValue = vi.spyOn(presentation, 'tableCellDisplayValue');
    const { unchangedCell } = renderGrid();
    fireEvent.keyDown(screen.getByLabelText('Table keyboard navigation'), { key: 'Enter' });
    act(() => vi.runOnlyPendingTimers());
    const input = document.querySelector<HTMLInputElement>('[data-cell-position="0,0"] input')!;
    displayValue.mockClear();

    fireEvent.change(input, { target: { value: 'a longer draft', selectionStart: 14 } });

    expect(input.value).toBe('a longer draft');
    expect(displayValue.mock.calls.filter(([cell]) => cell === unchangedCell)).toHaveLength(0);
  });

  it('keeps unchanged cell presentation out of focus navigation elsewhere in the grid', () => {
    const displayValue = vi.spyOn(presentation, 'tableCellDisplayValue');
    const { unchangedCell } = renderGrid();
    displayValue.mockClear();

    fireEvent.keyDown(screen.getByLabelText('Table keyboard navigation'), { key: 'ArrowRight' });

    expect(
      document
        .querySelector('[data-testid="cell-focus-ring"]')
        ?.closest('[data-cell-position]')
        ?.getAttribute('data-cell-position')
    ).toBe('0,1');
    expect(displayValue.mock.calls.filter(([cell]) => cell === unchangedCell)).toHaveLength(0);
  });
});
