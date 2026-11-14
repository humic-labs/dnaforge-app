'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { captureFocusOwnership } from '@waypoint/platform/input-ownership';
import { safeFocus } from '../../../../shared/utils/safeFocus';

export interface UseInlineConfigFocusOptions {
  shouldAutoFocus: boolean;

  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;

  onClearFresh?: () => void;
}

export function useInlineConfigFocus({
  shouldAutoFocus,
  inputRef,
  onClearFresh,
}: UseInlineConfigFocusOptions): void {
  const clearFresh = useRef(onClearFresh);
  clearFresh.current = onClearFresh;

  useEffect(() => {
    const input = inputRef.current;
    if (!shouldAutoFocus || !input) return;
    const ownsFocus = captureFocusOwnership(input);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (ownsFocus() && safeFocus(input)) clearFresh.current?.();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [shouldAutoFocus, inputRef]);
}
