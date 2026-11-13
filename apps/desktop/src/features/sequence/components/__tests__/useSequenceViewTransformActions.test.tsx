/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  canOfferReindexHere,
  useSequenceViewTransformActions,
} from '../useSequenceViewTransformActions';

describe('canOfferReindexHere', () => {
  it('is offered for a bare-location right-click on a circular sequence', () => {
    expect(canOfferReindexHere({ circular: true, contextPosition: 42, selectionLength: 0 })).toBe(
      true
    );
  });

  it('is hidden while a range is highlighted (no single position to re-index to)', () => {
    expect(canOfferReindexHere({ circular: true, contextPosition: 42, selectionLength: 30 })).toBe(
      false
    );
  });

  it('is hidden on a linear sequence (no movable origin)', () => {
    expect(canOfferReindexHere({ circular: false, contextPosition: 42, selectionLength: 0 })).toBe(
      false
    );
  });

  it('is hidden without a clicked position', () => {
    expect(canOfferReindexHere({ circular: true, contextPosition: null, selectionLength: 0 })).toBe(
      false
    );
  });
});

describe('useSequenceViewTransformActions', () => {
  it('flips orientation as view metadata and clears transient selection', () => {
    const patchSeqView = vi.fn();
    const setHighlightedRange = vi.fn();
    const setViewCursor = vi.fn();
    const setSelectedAnnotation = vi.fn();

    const { result } = renderHook(() =>
      useSequenceViewTransformActions({
        circular: true,
        contextPosition: 4,
        sourceSequenceLength: 12,
        orientation: 'forward',
        originOffsetForViewPosition: vi.fn(),
        patchSeqView,
        minimapRef: { current: null },
        scrollToPositionWithTimeoutRef: { current: null },
        setViewCursor,
        setHighlightedRange,
        setSelectedAnnotation,
      })
    );

    act(() => {
      result.current.handleFlipOrientation();
    });

    expect(patchSeqView).toHaveBeenCalledWith({ orientation: 'reverse-complement' });
    expect(setHighlightedRange).toHaveBeenCalledWith(null);
    expect(setViewCursor).toHaveBeenCalledWith(null);
    expect(setSelectedAnnotation).toHaveBeenCalledWith(null);
  });

  it('reindexes circular views without touching sequence content callbacks', () => {
    const patchSeqView = vi.fn();
    const setViewCenter = vi.fn();
    const scrollToPosition = vi.fn();

    const { result } = renderHook(() =>
      useSequenceViewTransformActions({
        circular: true,
        contextPosition: 6,
        sourceSequenceLength: 12,
        orientation: 'forward',
        originOffsetForViewPosition: (position) => position + 20,
        patchSeqView,
        minimapRef: { current: { setViewCenter } },
        scrollToPositionWithTimeoutRef: { current: scrollToPosition },
        setViewCursor: vi.fn(),
        setHighlightedRange: vi.fn(),
        setSelectedAnnotation: vi.fn(),
      })
    );

    act(() => {
      result.current.handleReindexHere();
    });

    expect(patchSeqView).toHaveBeenCalledWith({
      originOffset: 26,
      centerBp: 1,
      webglCenterBp: 1,
    });
    expect(scrollToPosition).toHaveBeenCalledWith(1, undefined, { animate: false });
    expect(setViewCenter).toHaveBeenCalledWith(0);
  });

  it('ignores reindex for linear sequences', () => {
    const patchSeqView = vi.fn();
    const { result } = renderHook(() =>
      useSequenceViewTransformActions({
        circular: false,
        contextPosition: 6,
        sourceSequenceLength: 12,
        orientation: 'forward',
        originOffsetForViewPosition: vi.fn(),
        patchSeqView,
        minimapRef: { current: null },
        scrollToPositionWithTimeoutRef: { current: null },
        setViewCursor: vi.fn(),
        setHighlightedRange: vi.fn(),
        setSelectedAnnotation: vi.fn(),
      })
    );

    act(() => {
      result.current.handleReindexHere();
    });

    expect(patchSeqView).not.toHaveBeenCalled();
  });
});
