export interface SelectionRange {
  start: number;
  end: number;
  wraps?: boolean;
}

interface InternalRange {
  start: number;
  end: number;
  wraps?: boolean;
}

export function annotationToRange(ann: { start: number; end: number }): SelectionRange {
  return {
    start: ann.start - 1,
    end: ann.end - 1,
  };
}

export function rangeToAnnotation(range: SelectionRange): {
  start: number;
  end: number;
} {
  return {
    start: range.start + 1,
    end: range.end + 1,
  };
}

export function isPositionInRange(pos: number, range: SelectionRange, seqLen: number): boolean {
  if (seqLen === 0) return false;

  const normalizedPos = ((pos % seqLen) + seqLen) % seqLen;

  if (range.wraps) {
    return normalizedPos >= range.start || normalizedPos <= range.end;
  } else {
    const rangeStart = Math.min(range.start, range.end);
    const rangeEnd = Math.max(range.start, range.end);
    return normalizedPos >= rangeStart && normalizedPos <= rangeEnd;
  }
}

export function rangesOverlap(a: SelectionRange, b: SelectionRange, seqLen: number): boolean {
  const aInternal = toInternalRange(a);
  const bInternal = toInternalRange(b);

  if (!a.wraps && !b.wraps) {
    return aInternal.end > bInternal.start && bInternal.end > aInternal.start;
  }

  return (
    isPositionInRange(a.start, b, seqLen) ||
    isPositionInRange(a.end, b, seqLen) ||
    isPositionInRange(b.start, a, seqLen) ||
    isPositionInRange(b.end, a, seqLen)
  );
}

export function rangeContains(
  outer: SelectionRange,
  inner: SelectionRange,
  seqLen: number
): boolean {
  return (
    isPositionInRange(inner.start, outer, seqLen) && isPositionInRange(inner.end, outer, seqLen)
  );
}

export function getSelectionLength(range: SelectionRange, seqLen: number): number {
  if (seqLen === 0) return 0;

  if (range.wraps) {
    return seqLen - range.start + range.end + 1;
  } else {
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    return end - start + 1;
  }
}

export function getShortestDistance(
  from: number,
  to: number,
  seqLen: number
): { distance: number; direction: 'forward' | 'backward' } {
  if (seqLen === 0) return { distance: 0, direction: 'forward' };

  const forward = (((to - from) % seqLen) + seqLen) % seqLen;
  const backward = (((from - to) % seqLen) + seqLen) % seqLen;

  if (forward <= backward) {
    return { distance: forward, direction: 'forward' };
  } else {
    return { distance: backward, direction: 'backward' };
  }
}

export function getForwardDistance(from: number, to: number, seqLen: number): number {
  if (seqLen === 0) return 0;
  return (((to - from) % seqLen) + seqLen) % seqLen;
}

export function normalizeRange(range: SelectionRange): SelectionRange {
  if (range.wraps) {
    return { ...range };
  }
  return {
    start: Math.min(range.start, range.end),
    end: Math.max(range.start, range.end),
  };
}

export function createDirectionalSelection(
  anchor: number,
  current: number,
  direction: 'forward' | 'backward',
  _seqLen: number
): SelectionRange {
  if (direction === 'forward') {
    if (current >= anchor) {
      return { start: anchor, end: current };
    } else {
      return { start: anchor, end: current, wraps: true };
    }
  } else {
    if (current <= anchor) {
      return { start: current, end: anchor };
    } else {
      return { start: current, end: anchor, wraps: true };
    }
  }
}

export function extendSelection(
  anchor: number,
  newPos: number,
  cumulativeDelta: number,
  seqLen: number
): SelectionRange {
  const direction: 'forward' | 'backward' = cumulativeDelta >= 0 ? 'forward' : 'backward';

  return createDirectionalSelection(anchor, newPos, direction, seqLen);
}

export function combineRanges(
  a: SelectionRange,
  b: SelectionRange,
  seqLen: number
): SelectionRange {
  if (!a.wraps && !b.wraps) {
    return {
      start: Math.min(a.start, b.start),
      end: Math.max(a.end, b.end),
    };
  }

  const aStart = a.start;
  const aEnd = a.end;
  const bStart = b.start;
  const bEnd = b.end;

  if (a.wraps && b.wraps) {
    return {
      start: Math.min(aStart, bStart),
      end: Math.max(aEnd, bEnd),
      wraps: true,
    };
  }

  const wrapping = a.wraps ? a : b;
  const normal = a.wraps ? b : a;

  if (
    isPositionInRange(normal.start, wrapping, seqLen) &&
    isPositionInRange(normal.end, wrapping, seqLen)
  ) {
    return { ...wrapping };
  }

  return {
    start: Math.min(wrapping.start, normal.start),
    end: Math.max(wrapping.end, normal.end),
    wraps: true,
  };
}

export function dragHandle(
  currentSel: SelectionRange,
  edge: 'start' | 'end',
  newPosition: number,
  seqLen: number
): SelectionRange {
  const anchor = edge === 'start' ? currentSel.end : currentSel.start;
  const originalWraps = currentSel.wraps ?? false;

  let newSel: SelectionRange;
  if (edge === 'start') {
    newSel = { start: newPosition, end: anchor };
  } else {
    newSel = { start: anchor, end: newPosition };
  }

  if (seqLen > 0) {
    if (originalWraps) {
      const shouldUnwrap = edge === 'end' ? newPosition >= anchor : newPosition <= anchor;
      newSel = { ...newSel, wraps: !shouldUnwrap };
    } else {
      newSel = { ...newSel, wraps: newSel.start > newSel.end };
    }
  }

  return newSel;
}

export function getShiftClickDirection(
  clickPos: number,
  currentSel: SelectionRange,
  seqLen: number,
  scrollState: {
    cumulativeDelta: number;
    crossedOriginForward: boolean;
    crossedOriginBackward: boolean;
  }
): { direction: 'forward' | 'backward'; anchor: number } {
  const SCROLL_THRESHOLD = 300;

  const selStart = currentSel.start;
  const selEnd = currentSel.end;

  const forwardDist = getForwardDistance(selStart, clickPos, seqLen);
  const backwardDist = getForwardDistance(clickPos, selEnd, seqLen);
  const shorterArcIsForward = forwardDist <= backwardDist;

  const { crossedOriginForward, crossedOriginBackward, cumulativeDelta } = scrollState;
  const scrolledForward = cumulativeDelta > SCROLL_THRESHOLD;
  const scrolledBackward = cumulativeDelta < -SCROLL_THRESHOLD;

  let useForward: boolean;

  if (scrolledForward) {
    const directForwardPath = clickPos >= selEnd;
    if (directForwardPath) {
      useForward = true;
    } else if (crossedOriginForward) {
      useForward = true;
    } else {
      useForward = shorterArcIsForward;
    }
  } else if (scrolledBackward) {
    const directBackwardPath = clickPos <= selStart;
    if (directBackwardPath) {
      useForward = false;
    } else if (crossedOriginBackward) {
      useForward = false;
    } else {
      useForward = shorterArcIsForward;
    }
  } else {
    useForward = shorterArcIsForward;
  }

  return {
    direction: useForward ? 'forward' : 'backward',
    anchor: useForward ? selStart : selEnd,
  };
}

export function calculateShiftClickSelection(
  clickPos: number,
  currentSel: SelectionRange | null,
  seqLen: number,
  scrollState: {
    cumulativeDelta: number;
    crossedOriginForward: boolean;
    crossedOriginBackward: boolean;
  }
): SelectionRange {
  if (!currentSel) {
    return { start: clickPos, end: clickPos };
  }

  if (seqLen === 0) {
    return {
      start: Math.min(currentSel.start, clickPos),
      end: Math.max(currentSel.end, clickPos),
    };
  }

  const { direction, anchor } = getShiftClickDirection(clickPos, currentSel, seqLen, scrollState);

  return createDirectionalSelection(anchor, clickPos, direction, seqLen);
}

export function rangeOverlapsLine(
  range: SelectionRange,
  lineStartPos: number,
  lineEndPos: number,
  seqLen: number
): boolean {
  const lineSpansOrigin = lineStartPos > lineEndPos;

  const rangeStart = range.start;
  const rangeEnd = range.end + 1;

  if (range.wraps) {
    if (lineSpansOrigin) {
      return true;
    } else {
      const seg1Overlaps = rangeStart < lineEndPos && seqLen > lineStartPos && rangeStart < seqLen;
      const seg2Overlaps = rangeEnd > lineStartPos && 0 < lineEndPos;
      return seg1Overlaps || seg2Overlaps;
    }
  } else {
    if (lineSpansOrigin) {
      const overlapsSeg1 = rangeEnd > lineStartPos && rangeStart < seqLen;
      const overlapsSeg2 = rangeEnd > 0 && rangeStart < lineEndPos;
      return overlapsSeg1 || overlapsSeg2;
    } else {
      return rangeEnd > lineStartPos && rangeStart < lineEndPos;
    }
  }
}

export function getVisibleRangeOnLine(
  range: SelectionRange,
  lineStartPos: number,
  lineEndPos: number,
  seqLen: number
): Array<{ start: number; end: number; charIndexStart: number }> {
  const segments: Array<{ start: number; end: number; charIndexStart: number }> = [];

  const lineSpansOrigin = lineStartPos > lineEndPos;
  const rangeStart = range.start;
  const rangeEnd = range.end + 1;

  const addSegment = (
    segStart: number,
    segEnd: number,
    lineSegStart: number,
    lineSegEnd: number,
    charOffset: number
  ) => {
    const visibleStart = Math.max(segStart, lineSegStart);
    const visibleEnd = Math.min(segEnd, lineSegEnd);
    if (visibleEnd > visibleStart) {
      segments.push({
        start: visibleStart,
        end: visibleEnd - 1,
        charIndexStart: charOffset + (visibleStart - lineSegStart),
      });
    }
  };

  if (range.wraps) {
    if (lineSpansOrigin) {
      addSegment(rangeStart, seqLen, lineStartPos, seqLen, 0);
      const charOffsetForLineSeg2 = seqLen - lineStartPos;
      addSegment(0, rangeEnd, 0, lineEndPos, charOffsetForLineSeg2);
    } else {
      addSegment(rangeStart, seqLen, lineStartPos, lineEndPos, 0);
      addSegment(0, rangeEnd, lineStartPos, lineEndPos, 0);
    }
  } else {
    if (lineSpansOrigin) {
      addSegment(rangeStart, rangeEnd, lineStartPos, seqLen, 0);
      const charOffsetForLineSeg2 = seqLen - lineStartPos;
      addSegment(rangeStart, rangeEnd, 0, lineEndPos, charOffsetForLineSeg2);
    } else {
      addSegment(rangeStart, rangeEnd, lineStartPos, lineEndPos, 0);
    }
  }

  return segments;
}

export function isAnnotationFullyInSelection(
  annStart: number,
  annEnd: number,
  selection: SelectionRange,
  seqLen: number
): boolean {
  const startInside = isPositionInRange(annStart, selection, seqLen);
  const endInside = isPositionInRange(annEnd, selection, seqLen);

  if (!startInside || !endInside) {
    return false;
  }

  const selWraps = selection.wraps || selection.start > selection.end;
  const annWraps = annStart > annEnd;

  if (!selWraps && !annWraps) {
    return annStart >= selection.start && annEnd <= selection.end;
  }

  if (selWraps && !annWraps) {
    const inUpperPart = annStart >= selection.start && annEnd >= selection.start;
    const inLowerPart = annStart <= selection.end && annEnd <= selection.end;
    return inUpperPart || inLowerPart;
  }

  if (!selWraps && annWraps) {
    return false;
  }

  return annStart >= selection.start && annEnd <= selection.end;
}

export function modifyDownstreamEnd(
  selection: SelectionRange,
  newEnd: number,
  _seqLen: number
): SelectionRange {
  const start = selection.start;

  const shouldWrap = newEnd < start;

  return {
    start,
    end: newEnd,
    wraps: shouldWrap ? true : undefined,
  };
}

export function modifyUpstreamEnd(
  selection: SelectionRange,
  newStart: number,
  _seqLen: number
): SelectionRange {
  const end = selection.end;

  const shouldWrap = end < newStart;

  return {
    start: newStart,
    end,
    wraps: shouldWrap ? true : undefined,
  };
}

export function shrinkDownstreamToBeforeAnnotation(
  selection: SelectionRange,
  annStart: number,
  seqLen: number
): SelectionRange {
  const newEnd = annStart > 0 ? annStart - 1 : seqLen - 1;

  if (!selection.wraps) {
    if (newEnd < selection.start) {
      return { start: selection.start, end: selection.start };
    }
  }

  return modifyDownstreamEnd(selection, newEnd, seqLen);
}

export function shrinkUpstreamToAfterAnnotation(
  selection: SelectionRange,
  annEnd: number,
  seqLen: number
): SelectionRange {
  const newStart = (annEnd + 1) % seqLen;

  if (!selection.wraps) {
    if (newStart > selection.end) {
      return { start: selection.end, end: selection.end };
    }
  }

  return modifyUpstreamEnd(selection, newStart, seqLen);
}

export function createSelectionFromAnnotation(
  annStart: number,
  annEnd: number,
  _seqLen: number
): SelectionRange {
  const wraps = annStart > annEnd;
  return {
    start: annStart,
    end: annEnd,
    wraps: wraps ? true : undefined,
  };
}

export function handleShiftClickNucleotide(
  selection: SelectionRange | null,
  clickedPos: number,
  cursorPos: number | null,
  seqLen: number,
  isCircular: boolean = false
): SelectionRange {
  if (!selection) {
    if (cursorPos !== null) {
      if (isCircular && clickedPos < cursorPos) {
        return { start: cursorPos, end: clickedPos, wraps: true };
      }
      const start = Math.min(cursorPos, clickedPos);
      const end = Math.max(cursorPos, clickedPos);
      return { start, end };
    }
    return { start: clickedPos, end: clickedPos };
  }

  return modifyDownstreamEnd(selection, clickedPos, seqLen);
}

export function handleOptionShiftClickNucleotide(
  selection: SelectionRange | null,
  clickedPos: number,
  cursorPos: number | null,
  seqLen: number,
  isCircular: boolean = false
): SelectionRange {
  if (!selection) {
    if (cursorPos !== null) {
      const anchor = clickedPos < cursorPos ? Math.max(0, cursorPos - 1) : cursorPos;

      if (isCircular && clickedPos > cursorPos) {
        return { start: clickedPos, end: anchor, wraps: true };
      }
      const start = Math.min(anchor, clickedPos);
      const end = Math.max(anchor, clickedPos);
      return { start, end };
    }
    return { start: clickedPos, end: clickedPos };
  }

  return modifyUpstreamEnd(selection, clickedPos, seqLen);
}

export function handleShiftClickAnnotation(
  selection: SelectionRange | null,
  annStart: number,
  annEnd: number,
  cursorPos: number | null,
  seqLen: number
): SelectionRange {
  if (!selection) {
    return createSelectionFromAnnotation(annStart, annEnd, seqLen);
  }

  const fullyInside = isAnnotationFullyInSelection(annStart, annEnd, selection, seqLen);

  if (fullyInside) {
    return shrinkDownstreamToBeforeAnnotation(selection, annStart, seqLen);
  } else {
    return modifyDownstreamEnd(selection, annEnd, seqLen);
  }
}

export function handleOptionShiftClickAnnotation(
  selection: SelectionRange | null,
  annStart: number,
  annEnd: number,
  cursorPos: number | null,
  seqLen: number
): SelectionRange {
  if (!selection) {
    return createSelectionFromAnnotation(annStart, annEnd, seqLen);
  }

  const fullyInside = isAnnotationFullyInSelection(annStart, annEnd, selection, seqLen);

  if (fullyInside) {
    return shrinkUpstreamToAfterAnnotation(selection, annEnd, seqLen);
  } else {
    return modifyUpstreamEnd(selection, annStart, seqLen);
  }
}

export interface ShiftClickAnnotationRangeInput {
  currentSelection: SelectionRange | null;
  rangeStart: number;
  rangeEnd: number;
  cursorPosition: number | null;
  sequenceLength: number;
  isLinear: boolean;
  isAltKey: boolean;
}

export function computeShiftClickRangeForAnnotation(
  input: ShiftClickAnnotationRangeInput
): SelectionRange {
  const {
    currentSelection,
    rangeStart,
    rangeEnd,
    cursorPosition,
    sequenceLength,
    isLinear,
    isAltKey,
  } = input;

  if (isLinear) {
    return handleLinearShiftClickAnnotation(currentSelection, rangeStart, rangeEnd);
  }
  if (isAltKey) {
    return handleOptionShiftClickAnnotation(
      currentSelection,
      rangeStart,
      rangeEnd,
      cursorPosition,
      sequenceLength
    );
  }
  return handleShiftClickAnnotation(
    currentSelection,
    rangeStart,
    rangeEnd,
    cursorPosition,
    sequenceLength
  );
}

function handleLinearShiftClickAnnotation(
  selection: SelectionRange | null,
  annStart: number,
  annEnd: number
): SelectionRange {
  if (!selection) {
    return { start: annStart, end: annEnd };
  }
  return {
    start: Math.min(selection.start, annStart),
    end: Math.max(selection.end, annEnd),
  };
}

export function invertSelection(
  selection: SelectionRange | null,
  seqLen: number
): SelectionRange | null {
  if (!selection || seqLen === 0) return null;

  const selLength = getSelectionLength(selection, seqLen);
  if (selLength >= seqLen || selLength === 0) return null;

  const newStart = (selection.end + 1) % seqLen;
  const newEnd = (selection.start - 1 + seqLen) % seqLen;

  return {
    start: newStart,
    end: newEnd,
    wraps: newStart > newEnd ? true : undefined,
  };
}

function toInternalRange(range: SelectionRange): InternalRange {
  return {
    start: range.start,
    end: range.end + 1,
    wraps: range.wraps,
  };
}
