/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { useScrollIdleGate } from './useScrollIdleGate';

describe('useScrollIdleGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () => ({ overflowY: 'auto', overflow: 'auto' }) as CSSStyleDeclaration
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not grant idle just because mount was quiet (open→wheel gap)', () => {
    const scrollParent = document.createElement('div');
    const child = document.createElement('div');
    scrollParent.appendChild(child);
    document.body.appendChild(scrollParent);

    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(child);
      return useScrollIdleGate(ref, { idleMs: 100, noInteractionFallbackMs: 1500 });
    });

    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBe(false);

    document.body.removeChild(scrollParent);
  });

  it('grants idle after scroll interaction then quiet period', () => {
    const scrollParent = document.createElement('div');
    const child = document.createElement('div');
    scrollParent.appendChild(child);
    document.body.appendChild(scrollParent);

    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(child);
      return useScrollIdleGate(ref, { idleMs: 100, noInteractionFallbackMs: 1500 });
    });

    act(() => {
      scrollParent.dispatchEvent(new Event('wheel'));
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(true);

    document.body.removeChild(scrollParent);
  });

  it('falls back to idle when the user never scrolls', () => {
    const scrollParent = document.createElement('div');
    const child = document.createElement('div');
    scrollParent.appendChild(child);
    document.body.appendChild(scrollParent);

    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(child);
      return useScrollIdleGate(ref, { idleMs: 100, noInteractionFallbackMs: 1500 });
    });

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current).toBe(true);

    document.body.removeChild(scrollParent);
  });
});
