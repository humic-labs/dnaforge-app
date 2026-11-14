import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useKeyboardNav } from './useKeyboardNav';

describe('table cell ref lifecycle', () => {
  it('preserves the coordinate ref after the cell detaches and reattaches', () => {
    const { result, rerender } = renderHook(() => useKeyboardNav({ rows: 2, cols: 2 }));
    const node = document.createElement('div');
    const callback = result.current.getCellRef(0, 0);

    callback(node);
    callback(null);
    callback(node);
    rerender();

    expect(result.current.getCellRef(0, 0)).toBe(callback);
  });

  it('keeps the current node and ref when a retired callback detaches later', () => {
    const { result } = renderHook(() => useKeyboardNav({ rows: 2, cols: 2 }));
    const previousNode = document.createElement('div');
    const currentNode = document.createElement('div');
    currentNode.scrollIntoView = vi.fn();
    const previousCallback = result.current.getCellRef(0, 0);
    previousCallback(previousNode);
    previousCallback(null);
    const currentCallback = result.current.getCellRef(0, 0);
    currentCallback(currentNode);

    previousCallback(null);

    expect(result.current.getCellRef(0, 0)).toBe(currentCallback);
    act(() => result.current.setFocusedCell({ row: 0, col: 0 }));
    result.current.scrollFocusedCellIntoView();
    expect(currentNode.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
  });
});
