/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SequenceViewMode } from '../SequenceViewerModeToggle';
import { useSequenceScrollNavigation } from '../useSequenceScrollNavigation';

function navigation(visible = true, mode: SequenceViewMode = '2d') {
  const modeRef = { current: mode };
  const callbacks = {
    setHighlightedRange: vi.fn(),
    setViewCursor: vi.fn(),
    setSelectedAnnotation: vi.fn(),
    navigateMapToPosition: vi.fn(),
  };
  const view = renderHook(
    ({ visible }) =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: modeRef,
        sequenceViewerRef: { current: null },
        sequenceAnnotations: [],
        sequenceSurfaceVisible: visible,
        ...callbacks,
      }),
    { initialProps: { visible } }
  );
  return { ...view, modeRef };
}

function packet(api: ReturnType<typeof useSequenceScrollNavigation>) {
  const value = api.scrollPresentation;
  expect(value).toBeTruthy();
  if (!value) throw new Error('owned presentation packet missing');
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useSequenceScrollNavigation presentation lifetime', () => {
  it('keeps the receipt owner after applied completion and delivers it only once', () => {
    const { result } = navigation();
    const applied = vi.fn(),
      presented = vi.fn();
    act(() => {
      result.current.scrollToPositionWithTimeout(100, applied, {
        animate: false,
        onPresented: presented,
      });
    });
    const held = packet(result.current);
    expect(held.position).toBe(100);
    act(() => result.current.onScrollToPositionComplete());
    expect(applied).toHaveBeenCalledTimes(1);
    expect(result.current.scrollToPosition).toBeNull();
    expect(result.current.scrollPresentation).toBe(held);
    expect(presented).not.toHaveBeenCalled();
    act(() => {
      held.presented();
      held.presented();
    });
    expect(presented).toHaveBeenCalledTimes(1);
    expect(result.current.scrollPresentation).toBeNull();
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('cancels a held receipt after applied completion already retired its command', () => {
    const { result } = navigation();
    const applied = vi.fn(),
      presented = vi.fn();
    let cancel!: () => void;
    act(() => {
      cancel = result.current.scrollToPositionWithTimeout(100, applied, {
        animate: false,
        onPresented: presented,
      });
    });
    const held = packet(result.current);
    act(() => result.current.onScrollToPositionComplete());
    act(() => cancel());
    expect(result.current.scrollPresentation).toBeNull();
    act(() => held.presented());
    expect(presented).not.toHaveBeenCalled();
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('uses distinct receipt owners for requests that coalesce the same legacy command id', () => {
    const { result } = navigation();
    const firstApplied = vi.fn(),
      secondApplied = vi.fn(),
      firstPresented = vi.fn(),
      secondPresented = vi.fn();
    let cancelFirst!: () => void;
    act(() => {
      cancelFirst = result.current.scrollToPositionWithTimeout(100, firstApplied, {
        animate: false,
        onPresented: firstPresented,
      });
    });
    const first = packet(result.current),
      id = result.current.scrollCommandId;
    act(() => {
      result.current.scrollToPositionWithTimeout(100, secondApplied, {
        animate: false,
        onPresented: secondPresented,
      });
    });
    const second = packet(result.current);
    expect(result.current.scrollCommandId).toBe(id);
    expect(second).not.toBe(first);
    act(() => {
      cancelFirst();
      first.presented();
    });
    expect(result.current.scrollPresentation).toBe(second);
    expect(firstPresented).not.toHaveBeenCalled();
    expect(secondPresented).not.toHaveBeenCalled();
    act(() => result.current.onScrollToPositionComplete());
    expect(secondApplied).toHaveBeenCalledTimes(1);
    expect(firstApplied).not.toHaveBeenCalled();
    expect(result.current.scrollPresentation).toBe(second);
    act(() => second.presented());
    expect(secondPresented).toHaveBeenCalledTimes(1);
    expect(firstPresented).not.toHaveBeenCalled();
  });

  it('does not clear applied completion when presentation happens first', () => {
    const { result } = navigation();
    const applied = vi.fn(),
      presented = vi.fn();
    act(() => {
      result.current.scrollToPositionWithTimeout(100, applied, {
        animate: false,
        onPresented: presented,
      });
    });
    const held = packet(result.current);
    act(() => held.presented());
    expect(presented).toHaveBeenCalledTimes(1);
    expect(applied).not.toHaveBeenCalled();
    expect(result.current.scrollToPosition).toBe(100);
    act(() => result.current.onScrollToPositionComplete());
    expect(applied).toHaveBeenCalledTimes(1);
    expect(presented).toHaveBeenCalledTimes(1);
  });

  it('retires presentation when a later command has no presentation observer', () => {
    const { result } = navigation();
    const presented = vi.fn();
    act(() => {
      result.current.scrollToPositionWithTimeout(100, undefined, {
        animate: false,
        onPresented: presented,
      });
    });
    const held = packet(result.current);
    act(() => {
      result.current.scrollToPositionWithTimeout(200, undefined, { animate: false });
    });
    expect(result.current.scrollToPosition).toBe(200);
    expect(result.current.scrollPresentation).toBeNull();
    act(() => held.presented());
    expect(presented).not.toHaveBeenCalled();
  });

  it('keeps hidden timer completion from admitting or completing a presentation', () => {
    const { result } = navigation(false);
    const applied = vi.fn(),
      presented = vi.fn();
    act(() => {
      result.current.scrollToPositionWithTimeout(100, applied, {
        animate: false,
        onPresented: presented,
      });
    });
    expect(result.current.scrollPresentation).toBeNull();
    act(() => vi.advanceTimersByTime(0));
    expect(applied).toHaveBeenCalledTimes(1);
    expect(presented).not.toHaveBeenCalled();
  });

  it('retires a held owner on hide and requires a new intent after showing', () => {
    const { result, rerender } = navigation();
    const presented = vi.fn();
    act(() => {
      result.current.scrollToPositionWithTimeout(100, undefined, {
        animate: false,
        onPresented: presented,
      });
    });
    const held = packet(result.current);
    act(() => result.current.onScrollToPositionComplete());
    rerender({ visible: false });
    expect(result.current.scrollPresentation).toBeNull();
    rerender({ visible: true });
    act(() => held.presented());
    expect(result.current.scrollPresentation).toBeNull();
    expect(presented).not.toHaveBeenCalled();
  });

  it('cannot deliver a held owner after unmount', () => {
    const { result, unmount } = navigation();
    const presented = vi.fn();
    act(() => {
      result.current.scrollToPositionWithTimeout(100, undefined, {
        animate: false,
        onPresented: presented,
      });
    });
    const held = packet(result.current);
    unmount();
    act(() => held.presented());
    expect(presented).not.toHaveBeenCalled();
  });

  it('does not admit a 2D packet on the tracks surface or revive one across a mode switch', () => {
    const { result, rerender, modeRef } = navigation();
    const presented = vi.fn();
    act(() => {
      result.current.scrollToPositionWithTimeout(100, undefined, {
        animate: false,
        onPresented: presented,
      });
    });
    const held = packet(result.current);
    modeRef.current = 'tracks';
    rerender({ visible: true });
    expect(result.current.scrollPresentation).toBeNull();
    act(() => {
      held.presented();
      result.current.scrollToPositionWithTimeout(100, undefined, {
        animate: false,
        onPresented: presented,
      });
    });
    expect(result.current.scrollPresentation).toBeNull();
    expect(presented).not.toHaveBeenCalled();
  });
});
