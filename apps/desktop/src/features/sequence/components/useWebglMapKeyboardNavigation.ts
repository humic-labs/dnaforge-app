import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createDirectionalSelection } from '@waypoint/workspace-editor/shift-click-range';
import type { SelectionRange, SelectionState } from '../selection-state';

export interface WebglMapCursorNavigation {
  position: number;
  selecting: boolean;
}

interface UseWebglMapKeyboardNavigationInput {
  sequenceLength: number;
  circular: boolean;
  selection: SelectionState;
  editCursorPosition?: number;
  onEditKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onCursorNavigate?: (navigation: WebglMapCursorNavigation) => void;
  setViewCursor: (position: number | null) => void;
  setHighlightedRange: (range: SelectionRange | null) => void;
}

type SelectionDirection = 'forward' | 'backward';

function adjacentPosition(
  position: number,
  delta: -1 | 1,
  sequenceLength: number,
  circular: boolean
): number {
  if (circular) {
    return (((position + delta) % sequenceLength) + sequenceLength) % sequenceLength;
  }
  return Math.max(0, Math.min(sequenceLength - 1, position + delta));
}

export function useWebglMapKeyboardNavigation({
  sequenceLength,
  circular,
  selection,
  editCursorPosition,
  onEditKeyDown,
  onCursorNavigate,
  setViewCursor,
  setHighlightedRange,
}: UseWebglMapKeyboardNavigationInput): (event: ReactKeyboardEvent<HTMLDivElement>) => void {
  const anchorRef = useRef<number | null>(null);
  const liveEndRef = useRef<number | null>(null);
  const directionRef = useRef<SelectionDirection | null>(null);

  useEffect(() => {
    if (selection.kind === 'range') return;
    anchorRef.current = null;
    directionRef.current = null;
    liveEndRef.current = selection.kind === 'cursor' ? selection.position : null;
  }, [selection]);

  return useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      onEditKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (sequenceLength <= 0) return;

      let currentPosition: number | null = editCursorPosition ?? null;
      if (currentPosition === null && selection.kind === 'cursor') {
        currentPosition = selection.position;
      }
      if (currentPosition === null && selection.kind === 'range') {
        if (anchorRef.current === null || liveEndRef.current === null) {
          anchorRef.current = selection.start;
          liveEndRef.current = selection.end;
          directionRef.current = 'forward';
        }
        currentPosition = liveEndRef.current;
      }
      if (currentPosition === null) return;

      const delta = event.key === 'ArrowLeft' ? -1 : 1;
      const nextPosition = adjacentPosition(currentPosition, delta, sequenceLength, circular);

      event.preventDefault();
      event.stopPropagation();

      if (!event.shiftKey) {
        anchorRef.current = null;
        directionRef.current = null;
        liveEndRef.current = nextPosition;
        setHighlightedRange(null);
        setViewCursor(nextPosition);
        onCursorNavigate?.({ position: nextPosition, selecting: false });
        return;
      }

      if (anchorRef.current === null) {
        anchorRef.current = currentPosition;
      }
      if (liveEndRef.current === null) {
        liveEndRef.current = currentPosition;
      }
      if (liveEndRef.current === anchorRef.current) {
        directionRef.current = delta === 1 ? 'forward' : 'backward';
      }
      const direction = directionRef.current ?? (delta === 1 ? 'forward' : 'backward');
      directionRef.current = direction;
      liveEndRef.current = nextPosition;

      if (nextPosition === anchorRef.current) {
        setHighlightedRange(null);
        setViewCursor(nextPosition);
      } else {
        setHighlightedRange(
          circular
            ? createDirectionalSelection(anchorRef.current, nextPosition, direction, sequenceLength)
            : {
                start: Math.min(anchorRef.current, nextPosition),
                end: Math.max(anchorRef.current, nextPosition),
              }
        );
      }
      onCursorNavigate?.({ position: nextPosition, selecting: true });
    },
    [
      circular,
      editCursorPosition,
      onCursorNavigate,
      onEditKeyDown,
      selection,
      sequenceLength,
      setHighlightedRange,
      setViewCursor,
    ]
  );
}
