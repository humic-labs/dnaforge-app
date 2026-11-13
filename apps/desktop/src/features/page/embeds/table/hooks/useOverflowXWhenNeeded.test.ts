import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useOverflowXWhenNeeded } from './useOverflowXWhenNeeded';

describe('useOverflowXWhenNeeded', () => {
  let observe: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    observe = vi.fn();
    disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when content fits (no scrollport needed)', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollWidth', { value: 100, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(el);
      return useOverflowXWhenNeeded(ref, 'fit');
    });

    expect(result.current).toBe(false);
    expect(observe).toHaveBeenCalled();
  });

  it('is true when content overflows horizontally', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollWidth', { value: 500, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(el);
      return useOverflowXWhenNeeded(ref, 'wide');
    });

    expect(result.current).toBe(true);
  });
});
