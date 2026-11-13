'use client';

import { useEffect, useRef, type RefObject } from 'react';
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
  const hasClearedFresh = useRef(false);

  useEffect(() => {
    if (!shouldAutoFocus) {
      return;
    }

    if (!hasClearedFresh.current) {
      hasClearedFresh.current = true;
      onClearFresh?.();
    }

    let isActive = true;

    requestAnimationFrame(() => {
      if (!isActive) return;
      requestAnimationFrame(() => {
        if (!isActive) return;
        safeFocus(inputRef.current);

        setTimeout(() => {
          if (!isActive) return;
          if (document.activeElement !== inputRef.current) {
            safeFocus(inputRef.current);
          }
        }, 50);
      });
    });

    return () => {
      isActive = false;
    };
  });
}
