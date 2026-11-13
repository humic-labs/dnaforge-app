import { useCallback, type RefObject } from 'react';
import type { AnnotationStateIdentity } from '@waypoint/workspace-editor';
import type { SelectionRange } from '../selection-state';
import type { SequenceOrientation } from '../view-state/sequence-view-state';
import type { SequenceViewStatePatchFn } from '../view-state/useSequenceViewState';

interface ViewCenterTarget {
  setViewCenter?: (center: number) => void;
}

export function canOfferReindexHere(params: {
  circular: boolean;
  contextPosition: number | null;
  selectionLength: number;
}): boolean {
  return params.circular && params.contextPosition != null && params.selectionLength <= 0;
}

interface UseSequenceViewTransformActionsInput {
  circular: boolean;
  contextPosition: number | null;
  sourceSequenceLength: number;
  orientation: SequenceOrientation;
  originOffsetForViewPosition: (viewPosition: number) => number | null;
  patchSeqView: SequenceViewStatePatchFn;
  minimapRef: RefObject<ViewCenterTarget | null>;
  scrollToPositionWithTimeoutRef: RefObject<
    ((position: number, onComplete?: () => void, options?: { animate?: boolean }) => void) | null
  >;
  setViewCursor: (position: number | null) => void;
  setHighlightedRange: (range: SelectionRange | null) => void;
  setSelectedAnnotation: (annotation: AnnotationStateIdentity | null) => void;
}

export function useSequenceViewTransformActions({
  circular,
  contextPosition,
  sourceSequenceLength,
  orientation,
  originOffsetForViewPosition,
  patchSeqView,
  minimapRef,
  scrollToPositionWithTimeoutRef,
  setViewCursor,
  setHighlightedRange,
  setSelectedAnnotation,
}: UseSequenceViewTransformActionsInput) {
  const clearTransientSelection = useCallback(() => {
    setHighlightedRange(null);
    setViewCursor(null);
    setSelectedAnnotation(null);
  }, [setHighlightedRange, setSelectedAnnotation, setViewCursor]);

  const handleReindexHere = useCallback(() => {
    if (!circular || contextPosition == null || sourceSequenceLength <= 0) return;
    const originOffset = originOffsetForViewPosition(contextPosition);
    if (originOffset == null) return;
    patchSeqView({ originOffset, centerBp: 1, webglCenterBp: 1 });
    setViewCursor(0);
    setHighlightedRange(null);
    setSelectedAnnotation(null);
    scrollToPositionWithTimeoutRef.current?.(1, undefined, { animate: false });
    minimapRef.current?.setViewCenter?.(0);
  }, [
    circular,
    contextPosition,
    minimapRef,
    originOffsetForViewPosition,
    patchSeqView,
    scrollToPositionWithTimeoutRef,
    setHighlightedRange,
    setSelectedAnnotation,
    setViewCursor,
    sourceSequenceLength,
  ]);

  const handleFlipOrientation = useCallback(() => {
    patchSeqView({
      orientation: orientation === 'reverse-complement' ? 'forward' : 'reverse-complement',
    });
    clearTransientSelection();
  }, [clearTransientSelection, orientation, patchSeqView]);

  const handleResetSequenceView = useCallback(() => {
    patchSeqView({ orientation: 'forward', originOffset: 0 });
    clearTransientSelection();
  }, [clearTransientSelection, patchSeqView]);

  return {
    handleReindexHere,
    handleFlipOrientation,
    handleResetSequenceView,
  };
}
