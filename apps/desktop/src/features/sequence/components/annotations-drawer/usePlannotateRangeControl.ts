import { useCallback, useEffect, useState } from 'react';
import type { AnnotationRange } from './helpers';
import { displayRangeToWire, type WireRange } from './plannotate-range';

export interface PlannotateRangeControl {
  enabled: boolean;
  startText: string;
  endText: string;
  wraps: boolean;
  hasSelection: boolean;
  setEnabled: (value: boolean) => void;
  setStartText: (value: string) => void;
  setEndText: (value: string) => void;
  resolveWireRange: () => WireRange | undefined;
}

export function usePlannotateRangeControl(
  currentSelectionRange: AnnotationRange | null | undefined,
  selectionWraps: boolean,
  sequenceLength: number
): PlannotateRangeControl {
  const [enabled, setEnabled] = useState(false);
  const [startText, setStartTextState] = useState('');
  const [endText, setEndTextState] = useState('');
  const [dirty, setDirty] = useState(false);

  const selStart = currentSelectionRange?.start;
  const selEnd = currentSelectionRange?.end;
  const hasSelection = !selectionWraps && selStart != null && selEnd != null;

  useEffect(() => {
    if (dirty) return;
    if (selectionWraps || selStart == null || selEnd == null) {
      setStartTextState('');
      setEndTextState('');
      return;
    }
    setStartTextState(String(selStart));
    setEndTextState(String(selEnd));
  }, [dirty, selectionWraps, selStart, selEnd]);

  const setStartText = useCallback(
    (value: string) => {
      setDirty(!(value === '' && endText === ''));
      setStartTextState(value);
    },
    [endText]
  );

  const setEndText = useCallback(
    (value: string) => {
      setDirty(!(value === '' && startText === ''));
      setEndTextState(value);
    },
    [startText]
  );

  const resolveWireRange = useCallback((): WireRange | undefined => {
    if (!enabled) return undefined;
    return displayRangeToWire(startText, endText, sequenceLength) ?? undefined;
  }, [enabled, startText, endText, sequenceLength]);

  return {
    enabled,
    startText,
    endText,
    wraps: selectionWraps,
    hasSelection,
    setEnabled,
    setStartText,
    setEndText,
    resolveWireRange,
  };
}
