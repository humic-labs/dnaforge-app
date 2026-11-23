import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSequencePaneCapacity } from './useSequencePaneCapacity';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('holds graphics memory through a shrinking drag and releases it when the pane settles', () => {
  const { result, rerender } = renderHook(({ w, h }) => useSequencePaneCapacity(w, h), {
    initialProps: { w: 2936, h: 1740 },
  });
  const initial = result.current;
  for (let step = 1; step <= 10; step++) {
    rerender({ w: 2936 - step * 70, h: 1740 - step * 75 });
    expect(result.current).toBe(initial);
    act(() => vi.advanceTimersByTime(40));
  }
  act(() => vi.advanceTimersByTime(500));
  expect(result.current.width).toBeLessThan(initial.width);
  expect(result.current.height).toBeLessThan(initial.height);
  expect(result.current.width).toBeGreaterThanOrEqual(2236);
  expect(result.current.height).toBeGreaterThanOrEqual(990);
});

it('grows immediately while the other dimension is shrinking', () => {
  const { result, rerender } = renderHook(({ w, h }) => useSequencePaneCapacity(w, h), {
    initialProps: { w: 850, h: 1000 },
  });
  const initialHeight = result.current.height;
  rerender({ w: 1600, h: 400 });
  expect(result.current.width).toBeGreaterThanOrEqual(1600);
  expect(result.current.height).toBe(initialHeight);
  rerender({ w: 1600, h: 1000 });
  act(() => vi.advanceTimersByTime(500));
  expect(result.current.height).toBe(initialHeight);
});
