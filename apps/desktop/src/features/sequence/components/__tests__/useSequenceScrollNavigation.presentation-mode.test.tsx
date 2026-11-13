/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SequenceViewMode } from '../SequenceViewerModeToggle';
import { useSequenceScrollNavigation } from '../useSequenceScrollNavigation';

afterEach(cleanup);

it('retires a held receipt when the live mode changes before the next hook render', () => {
  const mode = { current: '2d' as SequenceViewMode };
  const presented = vi.fn();
  const { result } = renderHook(() =>
    useSequenceScrollNavigation({
      sequenceViewModeRef: mode,
      sequenceViewerRef: { current: null },
      sequenceAnnotations: [],
      sequenceSurfaceVisible: true,
      setHighlightedRange: vi.fn(),
      setViewCursor: vi.fn(),
      setSelectedAnnotation: vi.fn(),
      navigateMapToPosition: vi.fn(),
    })
  );
  act(() => {
    result.current.scrollToPositionWithTimeout(100, undefined, {
      animate: false,
      onPresented: presented,
    });
  });
  const held = result.current.scrollPresentation;
  expect(held).toBeTruthy();
  if (!held) throw new Error('owned presentation packet missing');
  act(() => result.current.onScrollToPositionComplete());
  mode.current = 'tracks';
  act(() => held.presented());
  expect(presented).not.toHaveBeenCalled();
  expect(result.current.scrollPresentation).toBeNull();
  mode.current = '2d';
  act(() => held.presented());
  expect(presented).not.toHaveBeenCalled();
});
