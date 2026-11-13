import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboard } from './useKeyboard';

describe('useKeyboard', () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  it('registers keydown listener on mount', () => {
    renderHook(() => useKeyboard([{ key: 'k', handler: vi.fn() }]));
    expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('removes keydown listener on unmount', () => {
    const { unmount } = renderHook(() => useKeyboard([{ key: 'k', handler: vi.fn() }]));
    unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('calls handler when key matches', () => {
    const handler = vi.fn();
    renderHook(() => useKeyboard([{ key: 'k', handler }]));

    const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK' });
    document.dispatchEvent(event);

    expect(handler).toHaveBeenCalled();
  });

  it('does not call handler when key does not match', () => {
    const handler = vi.fn();
    renderHook(() => useKeyboard([{ key: 'k', handler }]));

    const event = new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ' });
    document.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
  });

  describe('modifier keys', () => {
    it('cmd option matches metaKey (Mac)', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'k', cmd: true, handler }]));

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: false })
      );
      expect(handler).not.toHaveBeenCalled();

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true })
      );
      expect(handler).toHaveBeenCalled();
    });

    it('cmd option matches ctrlKey (Windows/Linux)', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'k', cmd: true, handler }]));

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true })
      );
      expect(handler).toHaveBeenCalled();
    });

    it('shift modifier requires shiftKey', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'b', cmd: true, shift: true, handler }]));

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true, shiftKey: false })
      );
      expect(handler).not.toHaveBeenCalled();

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true, shiftKey: true })
      );
      expect(handler).toHaveBeenCalled();
    });

    it('alt modifier requires altKey', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'x', alt: true, handler }]));

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', altKey: false })
      );
      expect(handler).not.toHaveBeenCalled();

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '≈', code: 'KeyX', altKey: true })
      );
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('input focus behavior', () => {
    it('leaves terminal keys to the terminal even when app shortcuts allow text input', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'r', cmd: true, handler, allowInInput: true }]));
      const terminal = document.createElement('div');
      terminal.dataset.terminalSurface = '';
      const input = document.createElement('textarea');
      terminal.appendChild(input);
      document.body.appendChild(terminal);
      try {
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'r',
            code: 'KeyR',
            ctrlKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
        expect(handler).not.toHaveBeenCalled();
      } finally {
        terminal.remove();
      }
    });

    it('does not repeat a shortcut already handled by a focused widget', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'r', cmd: true, handler, allowInInput: true }]));
      const event = new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, cancelable: true });
      event.preventDefault();
      document.dispatchEvent(event);
      expect(handler).not.toHaveBeenCalled();
    });

    it('blocks shortcuts in input elements by default', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'k', handler }]));

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true });
      input.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
      document.body.removeChild(input);
    });

    it('allows shortcuts in input when allowInInput is true', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'k', cmd: true, handler, allowInInput: true }]));

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      const event = new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        metaKey: true,
        bubbles: true,
      });
      input.dispatchEvent(event);

      expect(handler).toHaveBeenCalled();
      document.body.removeChild(input);
    });

    it('always allows Escape key in inputs', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'Escape', handler }]));

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
      input.dispatchEvent(event);

      expect(handler).toHaveBeenCalled();
      document.body.removeChild(input);
    });
  });

  describe('preventDefault', () => {
    it('prevents default by default', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'k', handler }]));

      const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      document.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('does not prevent default when preventDefault is false', () => {
      const handler = vi.fn();
      renderHook(() => useKeyboard([{ key: 'k', handler, preventDefault: false }]));

      const event = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK' });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      document.dispatchEvent(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });
  });
});
