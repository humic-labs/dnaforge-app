import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useColumnResize } from './useColumnResize';

describe('useColumnResize', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'PointerEvent',
      class PointerEvent extends MouseEvent {
        constructor(type: string, init?: MouseEventInit) {
          super(type, init);
        }
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('previews width locally during drag and commits only on pointerup', () => {
    const onColumnResize = vi.fn();
    const { result } = renderHook(() =>
      useColumnResize({ columnWidths: { 0: 80 }, onColumnResize })
    );

    act(() => {
      result.current.handleResizeStart(0, {
        clientX: 100,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.PointerEvent);
    });

    expect(result.current.resizingCol).toBe(0);
    expect(onColumnResize).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 160 }));
    });
    expect(result.current.getColWidth(0)).toBe(140);
    expect(onColumnResize).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup'));
    });
    expect(onColumnResize).toHaveBeenCalledTimes(1);
    expect(onColumnResize).toHaveBeenCalledWith(0, 140);
    expect(result.current.resizingCol).toBeNull();
  });
});
