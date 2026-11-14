import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TableCell } from './TableCell';
import { TableGrid } from './TableGrid';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function cellProps(): ComponentProps<typeof TableCell> {
  return {
    cell: { type: 'text', value: 'original' },
    position: { row: 1, col: 1 },
    isFocused: false,
    isEditing: false,
    editingValue: '',
    onCellClick: vi.fn(),
    onCellDoubleClick: vi.fn(),
    onEditingValueChange: vi.fn(),
    onEditCommit: vi.fn(),
    onEditCancel: vi.fn(),
    cellRef: vi.fn(),
  };
}

describe('Table rendering preserves current behavior', () => {
  it('uses a replacement cell event handler when visible cell state is unchanged', () => {
    const props = cellProps();
    const view = render(<TableCell {...props} />);
    const nextDoubleClick = vi.fn();

    view.rerender(<TableCell {...props} onCellDoubleClick={nextDoubleClick} />);
    fireEvent.doubleClick(screen.getByLabelText('Cell row 2, column 2'));

    expect(props.onCellDoubleClick).not.toHaveBeenCalled();
    expect(nextDoubleClick).toHaveBeenCalledWith({ row: 1, col: 1 });
  });

  it('updates displayed data and formatting when a cell revision changes', () => {
    const props = cellProps();
    const view = render(<TableCell {...props} />);

    view.rerender(
      <TableCell
        {...props}
        cell={{ type: 'text', value: 'revised', format: { bold: true, textColor: '#ff0000' } }}
      />
    );

    expect(screen.queryByText('original')).not.toBeInTheDocument();
    expect(screen.getByText('revised')).toHaveClass('font-bold');
    expect(screen.getByText('revised')).toHaveStyle({ color: '#ff0000' });
  });

  it('updates the visible selection and cut edges while the cell stays in both ranges', () => {
    const props = cellProps();
    const interior = { startRow: 0, startCol: 0, endRow: 2, endCol: 2 };
    const view = render(
      <TableCell {...props} isSelected isCut selectionBounds={interior} cutBounds={interior} />
    );
    const wrapper = screen.getByLabelText('Cell row 2, column 2');
    expect(wrapper.style.borderTopWidth).toBe('');

    const edge = { startRow: 1, startCol: 1, endRow: 2, endCol: 2 };
    view.rerender(
      <TableCell {...props} isSelected isCut selectionBounds={edge} cutBounds={edge} />
    );

    expect(wrapper.style.borderTopWidth).toBe('1.5px');
    expect(wrapper.style.borderLeftWidth).toBe('1.5px');
    expect(
      Array.from(wrapper.children).some((child) => child.classList.contains('border-t-[1.5px]'))
    ).toBe(true);
  });

  it('commits the latest draft through the current source callback after a parent update', () => {
    vi.useFakeTimers();
    const originalWrite = vi.fn();
    const currentWrite = vi.fn();
    const props: ComponentProps<typeof TableGrid> = {
      cells: [[{ type: 'text', value: 'original' }]],
      displayCells: [[{ type: 'text', value: 'original' }]],
      visibleRowIndices: [0],
      filters: {},
      onCellChange: originalWrite,
      onExpandAndSetCell: vi.fn(),
      onFillRange: vi.fn(),
      onDeleteRange: vi.fn(),
      onPaste: vi.fn(() => false),
    };
    const view = render(<TableGrid {...props} />);
    fireEvent.mouseDown(document.querySelector('[data-cell-position="0,0"]')!);
    fireEvent.mouseUp(document);
    fireEvent.keyDown(screen.getByLabelText('Table keyboard navigation'), { key: 'Enter' });
    act(() => vi.runOnlyPendingTimers());
    const input = document.querySelector<HTMLInputElement>('[data-cell-position="0,0"] input')!;

    view.rerender(<TableGrid {...props} onCellChange={currentWrite} />);
    fireEvent.change(input, { target: { value: 'current draft', selectionStart: 13 } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(originalWrite).not.toHaveBeenCalled();
    expect(currentWrite).toHaveBeenCalledOnce();
    expect(currentWrite).toHaveBeenCalledWith(0, 0, 'current draft');
  });
});
