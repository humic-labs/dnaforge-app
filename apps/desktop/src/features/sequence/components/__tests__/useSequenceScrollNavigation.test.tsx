/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import type { Annotation } from '@waypoint/sequence-utils';
import type { SelectionRange } from '../../selection-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSequenceScrollNavigation } from '../useSequenceScrollNavigation';

const annotations: Annotation[] = [
  {
    name: 'lacZ',
    type: 'CDS',
    start: 3,
    end: 8,
    direction: 1,
  },
];

describe('useSequenceScrollNavigation', () => {
  it('keeps the external request identity separate from later ordinary sequence navigation', () => {
    const { result } = renderHook(() =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: { current: 'tracks' },
        sequenceViewerRef: { current: null },
        sequenceAnnotations: [],
        sequenceSurfaceVisible: true,
        scrollToPositionProp: 2,
        sequenceNavigationRequestId: 77,
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        navigateMapToPosition: vi.fn(),
      })
    );
    expect(result.current.scrollCommandRequestId).toBe(77);
    act(() => result.current.scrollToPositionWithTimeout(3));
    expect(result.current.scrollCommandRequestId).toBeNull();
    expect(result.current.scrollToPosition).toBe(3);
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies external highlight commands and delegates the map move to navigateMapToPosition', async () => {
    const setHighlightedRange = vi.fn();
    const setViewCursor = vi.fn();
    const setSelectedAnnotation = vi.fn();
    const onHighlightComplete = vi.fn();
    const navigateMapToPosition = vi.fn();

    renderHook(() =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: { current: 'tracks' },
        sequenceViewerRef: { current: null },
        sequenceAnnotations: annotations,
        highlightRangeProp: { start: 2, end: 7 },
        sequenceNavigationRequestId: 1,
        onHighlightComplete,
        setHighlightedRange,
        setViewCursor,
        setSelectedAnnotation,
        navigateMapToPosition,
      })
    );

    expect(setHighlightedRange).toHaveBeenCalledWith({ start: 2, end: 7, wraps: undefined });
    expect(setViewCursor).toHaveBeenCalledWith(null);
    expect(setSelectedAnnotation).toHaveBeenCalledWith({
      type: 'CDS',
      name: 'lacZ',
      start: 3,
      end: 8,
      direction: 1,
    });

    expect(navigateMapToPosition).toHaveBeenCalledWith(0, { start: 2, end: 7 });
    expect(onHighlightComplete).toHaveBeenCalledTimes(1);
  });

  it('uses the active 2D editor ref for biological scroll commands', () => {
    const scrollToBiologicalPosition = vi.fn();
    const { result } = renderHook(() =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: { current: '2d' },
        sequenceViewerRef: { current: { scrollToBiologicalPosition } },
        sequenceAnnotations: [],
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        navigateMapToPosition: vi.fn(),
      })
    );

    act(() => {
      result.current.scrollActiveSequenceViewerToBiologicalPosition(12, {
        continuousCircular: true,
      });
    });

    expect(scrollToBiologicalPosition).toHaveBeenCalledWith(12, { continuousCircular: true });
    expect(result.current.lastSequenceNavigationRef.current).toEqual({
      position: 12,
      mode: '2d',
      usedImperative2d: true,
      hadSequenceViewerRef: true,
      continuousCircular: true,
    });
    expect(result.current.scrollToPosition).toBeNull();
  });

  it('keeps a later selection until another explicit highlight command arrives', () => {
    const command = { start: 604, end: 633 };
    const laterSelection = { start: 592, end: 632 };
    const setViewCursor = vi.fn();
    const setSelectedAnnotation = vi.fn();
    const initialProps = {
      highlightRangeProp: command,
      sequenceAnnotations: annotations,
      onHighlightComplete: vi.fn(),
      navigateMapToPosition: vi.fn(),
      sequenceNavigationRequestId: null as number | null,
    };
    const { result, rerender } = renderHook(
      (props) => {
        const [selection, setSelection] = useState<SelectionRange | null>(null);
        useSequenceScrollNavigation({
          sequenceViewModeRef: { current: 'tracks' },
          sequenceViewerRef: { current: null },
          ...props,
          setHighlightedRange: setSelection,
          setViewCursor,
          setSelectedAnnotation,
        });
        return { selection, setSelection };
      },
      { initialProps }
    );
    expect(result.current.selection).toEqual(command);

    act(() => result.current.setSelection(laterSelection));
    const refreshedProps = {
      ...initialProps,
      sequenceAnnotations: [...annotations],
      onHighlightComplete: vi.fn(),
      navigateMapToPosition: vi.fn(),
    };
    rerender(refreshedProps);
    expect(result.current.selection).toEqual(laterSelection);

    const repeatedCommand = { ...command };
    rerender({ ...refreshedProps, highlightRangeProp: repeatedCommand });
    expect(result.current.selection).toEqual(command);
    act(() => result.current.setSelection(laterSelection));
    rerender({
      ...refreshedProps,
      highlightRangeProp: repeatedCommand,
      sequenceNavigationRequestId: 2,
    });
    expect(result.current.selection).toEqual(command);

    act(() => result.current.setSelection(laterSelection));
    rerender({
      ...refreshedProps,
      highlightRangeProp: { ...command },
      sequenceNavigationRequestId: 2,
    });
    expect(result.current.selection).toEqual(command);
  });

  it('moves the map once when one command carries both a scroll target and a range', () => {
    const navigateMapToPosition = vi.fn();
    const highlightRange = { start: 2, end: 7 };
    const setHighlightedRange = vi.fn();
    const setViewCursor = vi.fn();
    const setSelectedAnnotation = vi.fn();

    const { rerender } = renderHook(
      ({ highlightRangeProp }: { highlightRangeProp: { start: number; end: number } | null }) =>
        useSequenceScrollNavigation({
          sequenceViewModeRef: { current: 'tracks' },
          sequenceViewerRef: { current: null },
          sequenceAnnotations: annotations,
          scrollToPositionProp: 3,
          highlightRangeProp,
          sequenceNavigationRequestId: 1,
          setHighlightedRange,
          setViewCursor,
          setSelectedAnnotation,
          navigateMapToPosition,
        }),
      { initialProps: { highlightRangeProp: highlightRange } }
    );

    rerender({ highlightRangeProp: null });

    expect(navigateMapToPosition).toHaveBeenCalledTimes(1);
    expect(navigateMapToPosition).toHaveBeenCalledWith(3, { start: 2, end: 7 });
  });

  it('uses controlled scroll props when there is no active 2D editor ref', () => {
    const { result } = renderHook(() =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: { current: 'tracks' },
        sequenceViewerRef: { current: null },
        sequenceAnnotations: [],
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        navigateMapToPosition: vi.fn(),
      })
    );

    act(() => {
      result.current.scrollActiveSequenceViewerToBiologicalPosition(9, { animate: false });
    });

    expect(result.current.scrollToPosition).toBe(9);
    expect(result.current.scrollAnimate).toBe(false);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(result.current.scrollToPosition).toBeNull();
  });

  it('keeps an external navigation active until the visible viewer confirms completion', () => {
    const onScrollComplete = vi.fn();
    const setHighlightedRange = vi.fn();
    const setViewCursor = vi.fn();
    const setSelectedAnnotation = vi.fn();
    const navigateMapToPosition = vi.fn();
    const { result } = renderHook(() =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: { current: 'tracks' },
        sequenceViewerRef: { current: null },
        sequenceAnnotations: [],
        scrollToPositionProp: 900_001,
        sequenceSurfaceVisible: true,
        onScrollComplete,
        setHighlightedRange,
        setViewCursor,
        setSelectedAnnotation,
        navigateMapToPosition,
      })
    );

    expect(result.current.scrollToPosition).toBe(900_001);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(result.current.scrollToPosition).toBe(900_001);
    expect(onScrollComplete).not.toHaveBeenCalled();

    act(() => {
      result.current.onScrollToPositionComplete();
    });

    expect(result.current.scrollToPosition).toBeNull();
    expect(onScrollComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps Findbar navigation until its own viewer acknowledgement, not an old timer or completion', () => {
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();
    const timedComplete = vi.fn();
    const { result } = renderHook(() =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: { current: '2d' },
        sequenceViewerRef: { current: null },
        sequenceAnnotations: [],
        sequenceSurfaceVisible: true,
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        navigateMapToPosition: vi.fn(),
      })
    );

    act(() => result.current.scrollToPositionWithTimeout(22, firstComplete));
    const firstViewerAcknowledgement = result.current.onScrollToPositionComplete;
    act(() => result.current.scrollToPositionWithTimeout(187, secondComplete));

    act(() => firstViewerAcknowledgement());
    expect(result.current.scrollToPosition).toBe(187);
    expect(secondComplete).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.scrollToPosition).toBe(187);
    expect(firstComplete).not.toHaveBeenCalled();
    expect(secondComplete).not.toHaveBeenCalled();

    act(() => result.current.onScrollToPositionComplete());
    expect(result.current.scrollToPosition).toBeNull();
    expect(secondComplete).toHaveBeenCalledTimes(1);
    expect(firstComplete).not.toHaveBeenCalled();

    act(() =>
      result.current.scrollToPositionWithTimeout(22, timedComplete, { completion: 'timer' })
    );
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.scrollToPosition).toBeNull();
    expect(timedComplete).toHaveBeenCalledTimes(1);
  });

  it('coalesces repeated pending positions so the running viewer can acknowledge the latest request', () => {
    const firstComplete = vi.fn();
    const latestComplete = vi.fn();
    const { result } = renderHook(() =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: { current: '2d' },
        sequenceViewerRef: { current: null },
        sequenceAnnotations: [],
        sequenceSurfaceVisible: true,
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        navigateMapToPosition: vi.fn(),
      })
    );

    act(() => result.current.scrollToPositionWithTimeout(22, firstComplete));
    const runningViewerAcknowledgement = result.current.onScrollToPositionComplete;
    act(() => result.current.scrollToPositionWithTimeout(22, latestComplete));

    act(() => runningViewerAcknowledgement());
    expect(result.current.scrollToPosition).toBeNull();
    expect(latestComplete).toHaveBeenCalledTimes(1);
    expect(firstComplete).not.toHaveBeenCalled();
  });

  it('identifies a batched return to the same target as a new command', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: { current: '2d' },
        sequenceViewerRef: { current: null },
        sequenceAnnotations: [],
        sequenceSurfaceVisible: true,
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        navigateMapToPosition: vi.fn(),
      })
    );
    act(() => result.current.scrollToPositionWithTimeout(22));
    const firstId = result.current.scrollCommandId;
    const oldAcknowledgement = result.current.onScrollToPositionComplete;
    act(() => {
      result.current.scrollToPositionWithTimeout(187);
      result.current.scrollToPositionWithTimeout(22, onComplete);
    });
    expect(result.current.scrollToPosition).toBe(22);
    expect(result.current.scrollCommandId).not.toBe(firstId);
    act(() => oldAcknowledgement());
    expect(result.current.scrollToPosition).toBe(22);
    act(() => result.current.onScrollToPositionComplete());
    expect(result.current.scrollToPosition).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('gives changed animation or completion ownership a new command identity', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useSequenceScrollNavigation({
        sequenceViewModeRef: { current: '2d' },
        sequenceViewerRef: { current: null },
        sequenceAnnotations: [],
        sequenceSurfaceVisible: true,
        setHighlightedRange: vi.fn(),
        setViewCursor: vi.fn(),
        setSelectedAnnotation: vi.fn(),
        navigateMapToPosition: vi.fn(),
      })
    );
    act(() => result.current.scrollToPositionWithTimeout(22));
    const animatedId = result.current.scrollCommandId;
    act(() => result.current.scrollToPositionWithTimeout(22, undefined, { animate: false }));
    expect(result.current.scrollCommandId).not.toBe(animatedId);
    const instantId = result.current.scrollCommandId;
    const viewerAcknowledgement = result.current.onScrollToPositionComplete;
    act(() =>
      result.current.scrollToPositionWithTimeout(22, onComplete, {
        animate: false,
        completion: 'timer',
      })
    );
    expect(result.current.scrollCommandId).not.toBe(instantId);
    act(() => viewerAcknowledgement());
    expect(result.current.scrollToPosition).toBe(22);
    expect(onComplete).not.toHaveBeenCalled();
    act(() => vi.runOnlyPendingTimers());
    expect(result.current.scrollToPosition).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('preserves initial visible navigation through StrictMode effect replay', () => {
    const onScrollComplete = vi.fn();
    const { result } = renderHook(
      () =>
        useSequenceScrollNavigation({
          sequenceViewModeRef: { current: '2d' },
          sequenceViewerRef: { current: null },
          sequenceAnnotations: [],
          sequenceSurfaceVisible: true,
          scrollToPositionProp: 187,
          onScrollComplete,
          setHighlightedRange: vi.fn(),
          setViewCursor: vi.fn(),
          setSelectedAnnotation: vi.fn(),
          navigateMapToPosition: vi.fn(),
        }),
      { wrapper: StrictMode }
    );
    expect(result.current.scrollToPosition).toBe(187);
    act(() => result.current.onScrollToPositionComplete());
    expect(result.current.scrollToPosition).toBeNull();
    expect(onScrollComplete).toHaveBeenCalledTimes(1);
  });
  it.each([null, 22, 187])(
    'retires only its owned navigation before replacement %s',
    (replacement) => {
      const revokedComplete = vi.fn();
      const currentComplete = vi.fn();
      const { result } = renderHook(() =>
        useSequenceScrollNavigation({
          sequenceViewModeRef: { current: '2d' },
          sequenceViewerRef: { current: null },
          sequenceAnnotations: [],
          sequenceSurfaceVisible: true,
          setHighlightedRange: vi.fn(),
          setViewCursor: vi.fn(),
          setSelectedAnnotation: vi.fn(),
          navigateMapToPosition: vi.fn(),
        })
      );
      let cancel!: () => void;
      act(() => {
        cancel = result.current.scrollToPositionWithTimeout(22, revokedComplete);
      });
      const revokedAcknowledgement = result.current.onScrollToPositionComplete;
      if (replacement !== null) {
        act(() => result.current.scrollToPositionWithTimeout(replacement, currentComplete));
      }
      act(() => cancel());
      expect(result.current.scrollToPosition).toBe(replacement);
      act(() => revokedAcknowledgement());
      expect(revokedComplete).not.toHaveBeenCalled();
      if (replacement !== null) {
        act(() => result.current.onScrollToPositionComplete());
        expect(currentComplete).toHaveBeenCalledTimes(1);
      }
      expect(result.current.scrollToPosition).toBeNull();
      act(() => vi.advanceTimersByTime(1_000));
      expect(revokedComplete).not.toHaveBeenCalled();
    }
  );
});
