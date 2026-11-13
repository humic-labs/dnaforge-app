import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardNav } from './useKeyboardNav';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('useKeyboardNav', () => {
  const defaultProps = { rows: 3, cols: 3 };

  describe('focusedCell state', () => {
    it('starts with no focused cell', () => {
      const { result } = renderHook(() => useKeyboardNav(defaultProps));

      expect(result.current.focusedCell).toBeNull();
    });

    it('can set focused cell', () => {
      const { result } = renderHook(() => useKeyboardNav(defaultProps));

      act(() => {
        result.current.setFocusedCell({ row: 1, col: 2 });
      });

      expect(result.current.focusedCell).toEqual({ row: 1, col: 2 });
    });

    it('can clear focused cell', () => {
      const { result } = renderHook(() => useKeyboardNav(defaultProps));

      act(() => {
        result.current.setFocusedCell({ row: 0, col: 0 });
      });

      act(() => {
        result.current.setFocusedCell(null);
      });

      expect(result.current.focusedCell).toBeNull();
    });
  });

  describe('getCellRef', () => {
    it('returns a ref callback function', () => {
      const { result } = renderHook(() => useKeyboardNav(defaultProps));

      const refCallback = result.current.getCellRef(0, 0);
      expect(typeof refCallback).toBe('function');
    });

    it('creates unique refs for different cells', () => {
      const { result } = renderHook(() => useKeyboardNav(defaultProps));

      const ref00 = result.current.getCellRef(0, 0);
      const ref01 = result.current.getCellRef(0, 1);

      expect(ref00).not.toBe(ref01);
    });
  });

  describe('handleKeyDown', () => {
    it('does nothing when no cell is focused', () => {
      const { result } = renderHook(() => useKeyboardNav(defaultProps));
      const mockInputRef = { current: null };

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(event, mockInputRef);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    describe('Arrow navigation', () => {
      it('ArrowUp moves focus up when not at top', () => {
        const { result } = renderHook(() => useKeyboardNav(defaultProps));

        const mockInputRef = { current: document.createElement('input') };

        act(() => {
          result.current.setFocusedCell({ row: 1, col: 1 });
        });

        const event = {
          key: 'ArrowUp',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent;

        act(() => {
          result.current.handleKeyDown(event, mockInputRef);
        });

        expect(event.preventDefault).toHaveBeenCalled();
        expect(result.current.focusedCell).toEqual({ row: 0, col: 1 });
      });

      it('ArrowDown does not move past bottom row', () => {
        const { result } = renderHook(() => useKeyboardNav({ rows: 2, cols: 2 }));

        act(() => {
          result.current.setFocusedCell({ row: 1, col: 0 });
        });

        const mockInputRef = { current: document.createElement('input') };
        const event = {
          key: 'ArrowDown',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent;

        act(() => {
          result.current.handleKeyDown(event, mockInputRef);
        });

        expect(event.preventDefault).toHaveBeenCalled();
        expect(result.current.focusedCell).toEqual({ row: 1, col: 0 });
      });
    });

    describe('Tab navigation', () => {
      it('Tab moves to next cell', () => {
        const { result } = renderHook(() => useKeyboardNav({ rows: 2, cols: 2 }));

        act(() => {
          result.current.setFocusedCell({ row: 0, col: 0 });
        });

        const mockInputRef = { current: document.createElement('input') };
        const event = {
          key: 'Tab',
          shiftKey: false,
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent;

        act(() => {
          result.current.handleKeyDown(event, mockInputRef);
        });

        expect(event.preventDefault).toHaveBeenCalled();
        expect(result.current.focusedCell).toEqual({ row: 0, col: 1 });
      });

      it('Tab wraps to next row at end of row', () => {
        const { result } = renderHook(() => useKeyboardNav({ rows: 2, cols: 2 }));

        act(() => {
          result.current.setFocusedCell({ row: 0, col: 1 });
        });

        const mockInputRef = { current: document.createElement('input') };
        const event = {
          key: 'Tab',
          shiftKey: false,
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent;

        act(() => {
          result.current.handleKeyDown(event, mockInputRef);
        });

        expect(result.current.focusedCell).toEqual({ row: 1, col: 0 });
      });

      it('Shift+Tab moves to previous cell', () => {
        const { result } = renderHook(() => useKeyboardNav({ rows: 2, cols: 2 }));

        act(() => {
          result.current.setFocusedCell({ row: 0, col: 1 });
        });

        const mockInputRef = { current: document.createElement('input') };
        const event = {
          key: 'Tab',
          shiftKey: true,
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent;

        act(() => {
          result.current.handleKeyDown(event, mockInputRef);
        });

        expect(result.current.focusedCell).toEqual({ row: 0, col: 0 });
      });
    });

    describe('Enter key', () => {
      it('Enter moves to next row', () => {
        const { result } = renderHook(() => useKeyboardNav({ rows: 2, cols: 2 }));

        act(() => {
          result.current.setFocusedCell({ row: 0, col: 0 });
        });

        const mockInputRef = { current: document.createElement('input') };
        const event = {
          key: 'Enter',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent;

        act(() => {
          result.current.handleKeyDown(event, mockInputRef);
        });

        expect(event.preventDefault).toHaveBeenCalled();
        expect(result.current.focusedCell).toEqual({ row: 1, col: 0 });
      });

      it('Enter on last row does not change focus (stays on last row)', () => {
        const { result } = renderHook(() => useKeyboardNav({ rows: 2, cols: 2 }));

        act(() => {
          result.current.setFocusedCell({ row: 1, col: 0 });
        });

        const mockInputRef = { current: document.createElement('input') };
        const event = {
          key: 'Enter',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent;

        act(() => {
          result.current.handleKeyDown(event, mockInputRef);
        });

        expect(result.current.focusedCell).toEqual({ row: 1, col: 0 });
      });
    });

    describe('Escape key', () => {
      it('Escape clears focus state', () => {
        const { result } = renderHook(() => useKeyboardNav(defaultProps));

        act(() => {
          result.current.setFocusedCell({ row: 0, col: 0 });
        });

        const mockInputRef = { current: document.createElement('input') };
        const event = {
          key: 'Escape',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent;

        act(() => {
          result.current.handleKeyDown(event, mockInputRef);
        });

        expect(event.preventDefault).toHaveBeenCalled();
        expect(result.current.focusedCell).toBeNull();
      });

      it('Escape respects onEscape callback', () => {
        const onEscape = vi.fn().mockReturnValue(true);
        const { result } = renderHook(() => useKeyboardNav({ ...defaultProps, onEscape }));

        act(() => {
          result.current.setFocusedCell({ row: 0, col: 0 });
        });

        const mockInputRef = { current: document.createElement('input') };
        const event = {
          key: 'Escape',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent;

        act(() => {
          result.current.handleKeyDown(event, mockInputRef);
        });

        expect(onEscape).toHaveBeenCalled();
        expect(result.current.focusedCell).toEqual({ row: 0, col: 0 });
      });
    });
  });
});
