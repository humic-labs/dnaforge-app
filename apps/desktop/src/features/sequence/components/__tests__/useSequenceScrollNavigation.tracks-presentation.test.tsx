/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SequenceViewMode } from '../SequenceViewerModeToggle';
import { useSequenceScrollNavigation } from '../useSequenceScrollNavigation';

afterEach(cleanup);

function setup() {
  const mode: { current: SequenceViewMode } = { current: 'tracks' };
  const presented = vi.fn();
  const hook = renderHook(() =>
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
    hook.result.current.scrollToPositionWithTimeout(100, undefined, {
      animate: false,
      presentationMode: 'tracks',
      onPresented: presented,
    });
  });
  return { ...hook, mode, presented };
}

it('admits a Tracks receipt separately from applied scroll and consumes it once', () => {
  const { result, presented } = setup();
  const held = result.current.scrollPresentation;
  expect(held).toBeTruthy();
  if (!held) throw new Error('owned Tracks presentation missing');
  act(() => result.current.onScrollToPositionComplete());
  expect(presented).not.toHaveBeenCalled();
  act(() => held.presented());
  expect(presented).toHaveBeenCalledTimes(1);
  act(() => held.presented());
  expect(presented).toHaveBeenCalledTimes(1);
});

it('retires a held Tracks receipt across a live mode change and return', () => {
  const { result, mode, presented } = setup();
  const held = result.current.scrollPresentation;
  expect(held).toBeTruthy();
  if (!held) throw new Error('owned Tracks presentation missing');
  mode.current = '2d';
  act(() => held.presented());
  mode.current = 'tracks';
  act(() => held.presented());
  expect(presented).not.toHaveBeenCalled();
  expect(result.current.scrollPresentation).toBeNull();
});
