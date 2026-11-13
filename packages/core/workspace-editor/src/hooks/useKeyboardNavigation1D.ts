import { useEffect } from 'react';
import type { Selection } from '../types';
import { createDirectionalSelection } from '../selection-model';
import { biologicalColumn } from '../utils/circular-cols';

export interface UseKeyboardNavigation1DProps {
  containerRef: React.RefObject<HTMLElement | null>;
  columnCount: number;
  isCircular: boolean;
  viewCursor: number | null | undefined;
  onViewCursorChange?: (position: number | null) => void;
  selection: Selection | null | undefined;
  onSelectionChange?: (selection: Selection | null) => void;
  scrollToBase?: (baseIndex: number) => void;
  anchorRef: React.MutableRefObject<number | null>;
}

function isTextInputFocused(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function useKeyboardNavigation1D(props: UseKeyboardNavigation1DProps): void {
  const {
    containerRef,
    columnCount,
    isCircular,
    viewCursor,
    onViewCursorChange,
    selection,
    onSelectionChange,
    scrollToBase,
  } = props;

  const anchorRef = props.anchorRef;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || columnCount <= 0) return;

    const handler = (e: KeyboardEvent) => {
      if (isTextInputFocused(document.activeElement)) return;

      let key = e.key;
      const shift = e.shiftKey;
      if (e.metaKey && (key === 'ArrowLeft' || key === 'ArrowRight') && !e.ctrlKey && !e.altKey) {
        key = key === 'ArrowLeft' ? 'Home' : 'End';
      } else if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      const hasSelection = selection !== null && selection !== undefined;
      let liveEnd: number;
      if (anchorRef.current !== null && hasSelection) {
        liveEnd = selection!.start === anchorRef.current ? selection!.end : selection!.start;
      } else if (viewCursor != null) {
        liveEnd = viewCursor;
      } else if (hasSelection) {
        liveEnd = selection!.end;
      } else {
        return;
      }
      const cursor = liveEnd;

      let nextCursor: number | null = null;
      let extendTo: number | null = null;

      switch (key) {
        case 'ArrowLeft': {
          const target = isCircular
            ? biologicalColumn(cursor - 1, columnCount)
            : Math.max(0, cursor - 1);
          if (shift) extendTo = target;
          else nextCursor = target;
          break;
        }
        case 'ArrowRight': {
          const target = isCircular
            ? biologicalColumn(cursor + 1, columnCount)
            : Math.min(columnCount - 1, cursor + 1);
          if (shift) extendTo = target;
          else nextCursor = target;
          break;
        }
        case 'Home': {
          const target = 0;
          if (shift) extendTo = target;
          else nextCursor = target;
          break;
        }
        case 'End': {
          const target = columnCount - 1;
          if (shift) extendTo = target;
          else nextCursor = target;
          break;
        }
        default:
          return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (nextCursor !== null) {
        anchorRef.current = null;
        if (selection) onSelectionChange?.(null);
        onViewCursorChange?.(nextCursor);
        scrollToBase?.(nextCursor);
        return;
      }

      if (extendTo !== null) {
        if (anchorRef.current === null) {
          if (hasSelection) {
            anchorRef.current = selection!.start === cursor ? selection!.end : selection!.start;
          } else {
            anchorRef.current = cursor;
          }
        }
        const anchor = anchorRef.current;

        const wasWrapping = hasSelection && selection!.wraps === true;
        let newSelection: Selection | null;
        if (wasWrapping) {
          const liveIsEnd = anchor === selection!.start;
          const newStart = liveIsEnd ? anchor : extendTo;
          const newEnd = liveIsEnd ? extendTo : anchor;
          if (newStart === newEnd) {
            newSelection = null;
          } else {
            newSelection = { start: newStart, end: newEnd, wraps: true };
          }
        } else {
          if (anchor === extendTo) {
            newSelection = null;
          } else {
            newSelection = {
              start: Math.min(anchor, extendTo),
              end: Math.max(anchor, extendTo),
            };
          }
        }

        void createDirectionalSelection;

        onSelectionChange?.(newSelection);
        onViewCursorChange?.(extendTo);
        scrollToBase?.(extendTo);
      }
    };

    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [
    containerRef,
    columnCount,
    isCircular,
    viewCursor,
    onViewCursorChange,
    selection,
    onSelectionChange,
    scrollToBase,
  ]);
}
