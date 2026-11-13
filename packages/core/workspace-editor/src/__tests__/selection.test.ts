import { describe, it, expect } from 'vitest';
import {
  SELECTION_TEST_CASES,
  SEQUENCE_LENGTH,
  validateSelection,
  validateNotOver100Percent,
  getSelectionLength,
  type SelectionState,
  type ScrollState,
} from './selection-edge-cases';

const SCROLL_THRESHOLD = 300;

function getShiftSelectionDirection(
  clickPos: number,
  currentSel: SelectionState | null,
  seqLen: number,
  scrollState: ScrollState
): { useForward: boolean; anchor: number } | null {
  if (!currentSel || seqLen === 0) return null;

  const selStart = currentSel.start;
  const selEnd = currentSel.end;

  const forwardDist = clickPos >= selStart ? clickPos - selStart : seqLen - selStart + clickPos;
  const backwardDist = selEnd >= clickPos ? selEnd - clickPos : seqLen - clickPos + selEnd;
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

  const anchor = useForward ? selStart : selEnd;
  return { useForward, anchor };
}

function calculateShiftSelection(
  anchor: number,
  clickPos: number,
  seqLen: number,
  scrollState: ScrollState,
  currentSel: SelectionState | null
): SelectionState {
  if (seqLen === 0) {
    return { start: Math.min(anchor, clickPos), end: Math.max(anchor, clickPos) };
  }

  const directionInfo = getShiftSelectionDirection(clickPos, currentSel, seqLen, scrollState);
  const useForward = directionInfo?.useForward ?? true;

  if (useForward) {
    const shouldWrap = clickPos < anchor;
    return { start: anchor, end: clickPos, wraps: shouldWrap || undefined };
  } else {
    const shouldWrap = clickPos > anchor;
    return { start: clickPos, end: anchor, wraps: shouldWrap || undefined };
  }
}

function calculateAnnotationShiftSelection(
  currentSel: SelectionState | null,
  annStart: number,
  annEnd: number,
  seqLen: number,
  scrollState: ScrollState,
  viewCursor: number | null
): SelectionState {
  if (!currentSel) {
    if (viewCursor !== null) {
      return {
        start: Math.min(viewCursor, annStart),
        end: Math.max(viewCursor, annEnd),
      };
    }
    return { start: annStart, end: annEnd };
  }

  if (!currentSel.wraps) {
    const annInsideSelection = annStart >= currentSel.start && annEnd <= currentSel.end;
    if (annInsideSelection) {
      return currentSel;
    }

    const annOverlapsSelection = annStart < currentSel.end && annEnd > currentSel.start;

    if (annOverlapsSelection) {
      return {
        start: Math.min(currentSel.start, annStart),
        end: Math.max(currentSel.end, annEnd),
      };
    }
  }

  const annMid = Math.floor((annStart + annEnd) / 2);
  const directionInfo = getShiftSelectionDirection(annMid, currentSel, seqLen, scrollState);
  const useForward = directionInfo?.useForward ?? true;

  const clickPos = useForward ? annEnd : annStart;
  const anchor = directionInfo?.anchor ?? (useForward ? currentSel.start : currentSel.end);

  const baseRange = calculateShiftSelection(anchor, clickPos, seqLen, scrollState, currentSel);

  if (!baseRange.wraps) {
    return {
      start: Math.min(baseRange.start, annStart),
      end: Math.max(baseRange.end, annEnd),
    };
  } else {
    if (useForward) {
      return {
        start: baseRange.start,
        end: Math.max(baseRange.end, annEnd),
        wraps: true,
      };
    } else {
      return {
        start: Math.min(baseRange.start, annStart),
        end: baseRange.end,
        wraps: true,
      };
    }
  }
}

function calculateHandleDrag(
  currentSel: SelectionState,
  edge: 'start' | 'end',
  newPosition: number,
  _seqLen: number
): SelectionState {
  const anchor = edge === 'start' ? currentSel.end : currentSel.start;

  let newSel: SelectionState;
  if (edge === 'start') {
    newSel = { start: newPosition, end: anchor };
  } else {
    newSel = { start: anchor, end: newPosition };
  }

  if (newSel.start > newSel.end) {
    newSel = { ...newSel, wraps: true };
  }

  return newSel;
}

describe('Selection Direction Logic', () => {
  describe('Simple Extensions (no scroll)', () => {
    it('should extend right with shorter arc', () => {
      const result = getShiftSelectionDirection(6000, { start: 5000, end: 5500 }, SEQUENCE_LENGTH, {
        cumulativeDelta: 0,
        crossedOriginForward: false,
        crossedOriginBackward: false,
      });
      expect(result?.useForward).toBe(true);
      expect(result?.anchor).toBe(5000);
    });

    it('should extend left with shorter arc', () => {
      const result = getShiftSelectionDirection(4500, { start: 5000, end: 5500 }, SEQUENCE_LENGTH, {
        cumulativeDelta: 0,
        crossedOriginForward: false,
        crossedOriginBackward: false,
      });
      expect(result?.useForward).toBe(false);
      expect(result?.anchor).toBe(5500);
    });
  });

  describe('Long Arc WITHOUT Origin Crossing', () => {
    it('should use direct forward path when scrolled forward', () => {
      const result = getShiftSelectionDirection(8000, { start: 1000, end: 2000 }, SEQUENCE_LENGTH, {
        cumulativeDelta: 5000,
        crossedOriginForward: false,
        crossedOriginBackward: false,
      });
      expect(result?.useForward).toBe(true);
      expect(result?.anchor).toBe(1000);
    });

    it('should use direct backward path when scrolled backward', () => {
      const result = getShiftSelectionDirection(2000, { start: 8000, end: 9000 }, SEQUENCE_LENGTH, {
        cumulativeDelta: -6000,
        crossedOriginForward: false,
        crossedOriginBackward: false,
      });
      expect(result?.useForward).toBe(false);
      expect(result?.anchor).toBe(9000);
    });
  });

  describe('Origin Crossing', () => {
    it('should extend forward through origin when crossed', () => {
      const result = getShiftSelectionDirection(200, { start: 9500, end: 9800 }, SEQUENCE_LENGTH, {
        cumulativeDelta: 1000,
        crossedOriginForward: true,
        crossedOriginBackward: false,
      });
      expect(result?.useForward).toBe(true);
      expect(result?.anchor).toBe(9500);
    });

    it('should extend backward through origin when crossed', () => {
      const result = getShiftSelectionDirection(9500, { start: 100, end: 200 }, SEQUENCE_LENGTH, {
        cumulativeDelta: -2000,
        crossedOriginForward: false,
        crossedOriginBackward: true,
      });
      expect(result?.useForward).toBe(false);
      expect(result?.anchor).toBe(200);
    });
  });

  describe('Contradictory Scroll', () => {
    it('should fallback to shorter arc when scroll contradicts position', () => {
      const result = getShiftSelectionDirection(3000, { start: 5000, end: 5500 }, SEQUENCE_LENGTH, {
        cumulativeDelta: 3000,
        crossedOriginForward: false,
        crossedOriginBackward: false,
      });
      expect(result?.useForward).toBe(false);
      expect(result?.anchor).toBe(5500);
    });
  });
});

describe('Handle Drag', () => {
  it('should preserve wrapping when dragging wrapping selection', () => {
    const result = calculateHandleDrag(
      { start: 9000, end: 500, wraps: true },
      'end',
      1000,
      SEQUENCE_LENGTH
    );
    expect(result.start).toBe(9000);
    expect(result.end).toBe(1000);
    expect(result.wraps).toBe(true);
  });

  it('should create wrapping selection when dragging past origin', () => {
    const result = calculateHandleDrag({ start: 9000, end: 9500 }, 'end', 500, SEQUENCE_LENGTH);
    expect(result.start).toBe(9000);
    expect(result.end).toBe(500);
    expect(result.wraps).toBe(true);
  });

  it('should unwrap selection when start crosses end', () => {
    const result = calculateHandleDrag(
      { start: 9500, end: 500, wraps: true },
      'start',
      200,
      SEQUENCE_LENGTH
    );
    expect(result.start).toBe(200);
    expect(result.end).toBe(500);
    expect(result.wraps).toBeUndefined();
  });
});

describe('Annotation Shift-Click', () => {
  it('should include full annotation in simple extension', () => {
    const result = calculateAnnotationShiftSelection(
      { start: 1000, end: 2000 },
      3000,
      3500,
      SEQUENCE_LENGTH,
      { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
      null
    );
    expect(result.start).toBe(1000);
    expect(result.end).toBe(3500);
  });

  it('should NOT create >100% selection when crossing origin', () => {
    const result = calculateAnnotationShiftSelection(
      { start: 500, end: 1000 },
      9500,
      9700,
      SEQUENCE_LENGTH,
      { cumulativeDelta: -2000, crossedOriginForward: false, crossedOriginBackward: true },
      null
    );

    const length = getSelectionLength(result, SEQUENCE_LENGTH);
    expect(length).toBeLessThanOrEqual(SEQUENCE_LENGTH);

    expect(result.wraps).toBe(true);
    expect(result.start).toBeLessThanOrEqual(9500);
  });
});

describe('All Edge Cases', () => {
  for (const testCase of SELECTION_TEST_CASES) {
    it(`${testCase.id}: ${testCase.description}`, () => {
      let result: SelectionState;

      switch (testCase.action.type) {
        case 'shift-click': {
          if (!testCase.initialSelection) {
            const cursor = testCase.viewCursor ?? testCase.action.position;
            result = {
              start: Math.min(cursor, testCase.action.position),
              end: Math.max(cursor, testCase.action.position),
            };
          } else {
            const dirInfo = getShiftSelectionDirection(
              testCase.action.position,
              testCase.initialSelection,
              SEQUENCE_LENGTH,
              testCase.scrollState
            );
            result = calculateShiftSelection(
              dirInfo?.anchor ?? testCase.initialSelection.start,
              testCase.action.position,
              SEQUENCE_LENGTH,
              testCase.scrollState,
              testCase.initialSelection
            );
          }
          break;
        }
        case 'shift-click-annotation': {
          result = calculateAnnotationShiftSelection(
            testCase.initialSelection,
            testCase.action.annStart,
            testCase.action.annEnd,
            SEQUENCE_LENGTH,
            testCase.scrollState,
            testCase.viewCursor ?? null
          );
          break;
        }
        case 'handle-drag': {
          result = calculateHandleDrag(
            testCase.initialSelection!,
            testCase.action.edge,
            testCase.action.newPosition,
            SEQUENCE_LENGTH
          );
          break;
        }
      }

      const validation = validateSelection(result, testCase.expected, testCase.id);
      expect(validation.pass).toBe(true);

      const lengthCheck = validateNotOver100Percent(result, SEQUENCE_LENGTH, testCase.id);
      expect(lengthCheck.pass).toBe(true);
    });
  }
});
