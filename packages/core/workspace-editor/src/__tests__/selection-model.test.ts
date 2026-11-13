import { describe, it, expect } from 'vitest';
import {
  isPositionInRange,
  getSelectionLength,
  invertSelection,
  rangesOverlap,
  rangeContains,
  normalizeRange,
  createDirectionalSelection,
  extendSelection,
  combineRanges,
  dragHandle,
  getShiftClickDirection,
  calculateShiftClickSelection,
  rangeOverlapsLine,
  getVisibleRangeOnLine,
  annotationToRange,
  rangeToAnnotation,
  getShortestDistance,
  getForwardDistance,
  handleShiftClickNucleotide,
  handleOptionShiftClickNucleotide,
  computeShiftClickRangeForAnnotation,
  type SelectionRange,
} from '../selection-model';

const SEQ_LEN = 10000;

describe('Coordinate Conversion', () => {
  it('should convert 1-indexed annotation to 0-indexed range', () => {
    const range = annotationToRange({ start: 100, end: 200 });
    expect(range.start).toBe(99);
    expect(range.end).toBe(199);
  });

  it('should convert 0-indexed range to 1-indexed annotation', () => {
    const ann = rangeToAnnotation({ start: 99, end: 199 });
    expect(ann.start).toBe(100);
    expect(ann.end).toBe(200);
  });

  it('should round-trip correctly', () => {
    const original = { start: 500, end: 1500 };
    const range = annotationToRange(original);
    const back = rangeToAnnotation(range);
    expect(back).toEqual(original);
  });
});

describe('isPositionInRange', () => {
  describe('Normal (non-wrapping) ranges', () => {
    it('should return true for position inside range', () => {
      expect(isPositionInRange(500, { start: 100, end: 1000 }, SEQ_LEN)).toBe(true);
    });

    it('should return true for position at range start', () => {
      expect(isPositionInRange(100, { start: 100, end: 1000 }, SEQ_LEN)).toBe(true);
    });

    it('should return true for position at range end', () => {
      expect(isPositionInRange(1000, { start: 100, end: 1000 }, SEQ_LEN)).toBe(true);
    });

    it('should return false for position before range', () => {
      expect(isPositionInRange(50, { start: 100, end: 1000 }, SEQ_LEN)).toBe(false);
    });

    it('should return false for position after range', () => {
      expect(isPositionInRange(1500, { start: 100, end: 1000 }, SEQ_LEN)).toBe(false);
    });
  });

  describe('Wrapping ranges', () => {
    const wrappingRange: SelectionRange = { start: 9000, end: 500, wraps: true };

    it('should return true for position in first segment (after start)', () => {
      expect(isPositionInRange(9500, wrappingRange, SEQ_LEN)).toBe(true);
    });

    it('should return true for position in second segment (before end)', () => {
      expect(isPositionInRange(200, wrappingRange, SEQ_LEN)).toBe(true);
    });

    it('should return true for position at start', () => {
      expect(isPositionInRange(9000, wrappingRange, SEQ_LEN)).toBe(true);
    });

    it('should return true for position at end', () => {
      expect(isPositionInRange(500, wrappingRange, SEQ_LEN)).toBe(true);
    });

    it('should return false for position in the gap', () => {
      expect(isPositionInRange(5000, wrappingRange, SEQ_LEN)).toBe(false);
    });

    it('should return false for position just after end', () => {
      expect(isPositionInRange(501, wrappingRange, SEQ_LEN)).toBe(false);
    });

    it('should return false for position just before start', () => {
      expect(isPositionInRange(8999, wrappingRange, SEQ_LEN)).toBe(false);
    });
  });
});

describe('getSelectionLength', () => {
  it('should calculate length of normal range', () => {
    expect(getSelectionLength({ start: 100, end: 199 }, SEQ_LEN)).toBe(100);
  });

  it('should calculate length of single-position range', () => {
    expect(getSelectionLength({ start: 500, end: 500 }, SEQ_LEN)).toBe(1);
  });

  it('should calculate length of wrapping range', () => {
    expect(getSelectionLength({ start: 9500, end: 500, wraps: true }, SEQ_LEN)).toBe(1001);
  });

  it('should calculate length of nearly-full-circle wrapping range', () => {
    expect(getSelectionLength({ start: 100, end: 99, wraps: true }, SEQ_LEN)).toBe(10000);
  });
});

describe('rangesOverlap', () => {
  it('should detect overlapping normal ranges', () => {
    expect(rangesOverlap({ start: 100, end: 500 }, { start: 400, end: 800 }, SEQ_LEN)).toBe(true);
  });

  it('should return false for non-overlapping normal ranges', () => {
    expect(rangesOverlap({ start: 100, end: 500 }, { start: 600, end: 800 }, SEQ_LEN)).toBe(false);
  });

  it('should detect adjacent ranges as non-overlapping', () => {
    expect(rangesOverlap({ start: 100, end: 500 }, { start: 501, end: 800 }, SEQ_LEN)).toBe(false);
  });

  it('should detect wrapping range overlapping with normal range', () => {
    const wrapping: SelectionRange = { start: 9000, end: 500, wraps: true };
    const normal: SelectionRange = { start: 200, end: 400 };
    expect(rangesOverlap(wrapping, normal, SEQ_LEN)).toBe(true);
  });
});

describe('rangeContains', () => {
  it('should detect inner range fully contained', () => {
    expect(rangeContains({ start: 100, end: 1000 }, { start: 200, end: 800 }, SEQ_LEN)).toBe(true);
  });

  it('should return false when inner extends past outer', () => {
    expect(rangeContains({ start: 100, end: 500 }, { start: 200, end: 800 }, SEQ_LEN)).toBe(false);
  });
});

describe('getShortestDistance', () => {
  it('should return forward distance when shorter', () => {
    const result = getShortestDistance(100, 600, SEQ_LEN);
    expect(result.distance).toBe(500);
    expect(result.direction).toBe('forward');
  });

  it('should return backward distance when shorter', () => {
    const result = getShortestDistance(600, 100, SEQ_LEN);
    expect(result.distance).toBe(500);
    expect(result.direction).toBe('backward');
  });

  it('should prefer forward for equal distances', () => {
    const result = getShortestDistance(0, 5000, SEQ_LEN);
    expect(result.distance).toBe(5000);
    expect(result.direction).toBe('forward');
  });
});

describe('getForwardDistance', () => {
  it('should calculate forward distance without wrap', () => {
    expect(getForwardDistance(100, 600, SEQ_LEN)).toBe(500);
  });

  it('should calculate forward distance with wrap', () => {
    expect(getForwardDistance(9500, 500, SEQ_LEN)).toBe(1000);
  });

  it('should return 0 for same position', () => {
    expect(getForwardDistance(500, 500, SEQ_LEN)).toBe(0);
  });
});

describe('normalizeRange', () => {
  it('should sort start and end for normal range', () => {
    const result = normalizeRange({ start: 800, end: 200 });
    expect(result.start).toBe(200);
    expect(result.end).toBe(800);
  });

  it('should preserve wrapping ranges', () => {
    const result = normalizeRange({ start: 9000, end: 500, wraps: true });
    expect(result.start).toBe(9000);
    expect(result.end).toBe(500);
    expect(result.wraps).toBe(true);
  });
});

describe('createDirectionalSelection', () => {
  it('should create forward selection without wrap', () => {
    const result = createDirectionalSelection(100, 500, 'forward', SEQ_LEN);
    expect(result.start).toBe(100);
    expect(result.end).toBe(500);
    expect(result.wraps).toBeUndefined();
  });

  it('should create forward selection with wrap when current < anchor', () => {
    const result = createDirectionalSelection(9500, 500, 'forward', SEQ_LEN);
    expect(result.start).toBe(9500);
    expect(result.end).toBe(500);
    expect(result.wraps).toBe(true);
  });

  it('should create backward selection without wrap', () => {
    const result = createDirectionalSelection(500, 100, 'backward', SEQ_LEN);
    expect(result.start).toBe(100);
    expect(result.end).toBe(500);
    expect(result.wraps).toBeUndefined();
  });

  it('should create backward selection with wrap when current > anchor', () => {
    const result = createDirectionalSelection(500, 9500, 'backward', SEQ_LEN);
    expect(result.start).toBe(9500);
    expect(result.end).toBe(500);
    expect(result.wraps).toBe(true);
  });
});

describe('extendSelection', () => {
  it('should extend forward with positive cumulative delta', () => {
    const result = extendSelection(100, 800, 500, SEQ_LEN);
    expect(result.start).toBe(100);
    expect(result.end).toBe(800);
    expect(result.wraps).toBeUndefined();
  });

  it('should extend backward with negative cumulative delta', () => {
    const result = extendSelection(800, 100, -500, SEQ_LEN);
    expect(result.start).toBe(100);
    expect(result.end).toBe(800);
    expect(result.wraps).toBeUndefined();
  });

  it('should create wrapping selection when forward drag crosses origin', () => {
    const result = extendSelection(9500, 500, 1500, SEQ_LEN);
    expect(result.start).toBe(9500);
    expect(result.end).toBe(500);
    expect(result.wraps).toBe(true);
  });
});

describe('combineRanges', () => {
  it('should combine non-overlapping normal ranges', () => {
    const result = combineRanges({ start: 100, end: 300 }, { start: 500, end: 700 }, SEQ_LEN);
    expect(result.start).toBe(100);
    expect(result.end).toBe(700);
  });

  it('should combine overlapping ranges', () => {
    const result = combineRanges({ start: 100, end: 500 }, { start: 300, end: 700 }, SEQ_LEN);
    expect(result.start).toBe(100);
    expect(result.end).toBe(700);
  });
});

describe('dragHandle', () => {
  it('should move start handle forward', () => {
    const result = dragHandle({ start: 100, end: 500 }, 'start', 200, SEQ_LEN);
    expect(result.start).toBe(200);
    expect(result.end).toBe(500);
  });

  it('should move end handle forward', () => {
    const result = dragHandle({ start: 100, end: 500 }, 'end', 700, SEQ_LEN);
    expect(result.start).toBe(100);
    expect(result.end).toBe(700);
  });

  it('should move start handle past end (creates normal inverted selection)', () => {
    const result = dragHandle({ start: 100, end: 500 }, 'start', 700, SEQ_LEN);
    expect(result.start).toBe(700);
    expect(result.end).toBe(500);
    expect(result.wraps).toBe(true);
  });

  it('should preserve wrapping when dragging wrapping selection', () => {
    const result = dragHandle({ start: 9000, end: 500, wraps: true }, 'end', 1000, SEQ_LEN);
    expect(result.start).toBe(9000);
    expect(result.end).toBe(1000);
    expect(result.wraps).toBe(true);
  });

  it('should unwrap when start crosses end', () => {
    const result = dragHandle({ start: 9500, end: 500, wraps: true }, 'start', 200, SEQ_LEN);
    expect(result.start).toBe(200);
    expect(result.end).toBe(500);
    expect(result.wraps).toBe(false);
  });
});

describe('getShiftClickDirection', () => {
  const noScroll = {
    cumulativeDelta: 0,
    crossedOriginForward: false,
    crossedOriginBackward: false,
  };

  it('should use shorter arc by default', () => {
    const result = getShiftClickDirection(600, { start: 500, end: 550 }, SEQ_LEN, noScroll);
    expect(result.direction).toBe('forward');
    expect(result.anchor).toBe(500);
  });

  it('should extend backward when click is before selection', () => {
    const result = getShiftClickDirection(400, { start: 500, end: 550 }, SEQ_LEN, noScroll);
    expect(result.direction).toBe('backward');
    expect(result.anchor).toBe(550);
  });

  it('should honor scroll direction when significant forward scroll', () => {
    const forwardScroll = {
      cumulativeDelta: 5000,
      crossedOriginForward: false,
      crossedOriginBackward: false,
    };
    const result = getShiftClickDirection(8000, { start: 1000, end: 2000 }, SEQ_LEN, forwardScroll);
    expect(result.direction).toBe('forward');
    expect(result.anchor).toBe(1000);
  });

  it('should use origin crossing when scrolled forward through origin', () => {
    const forwardThroughOrigin = {
      cumulativeDelta: 2000,
      crossedOriginForward: true,
      crossedOriginBackward: false,
    };
    const result = getShiftClickDirection(
      200,
      { start: 9500, end: 9800 },
      SEQ_LEN,
      forwardThroughOrigin
    );
    expect(result.direction).toBe('forward');
    expect(result.anchor).toBe(9500);
  });
});

describe('calculateShiftClickSelection', () => {
  const noScroll = {
    cumulativeDelta: 0,
    crossedOriginForward: false,
    crossedOriginBackward: false,
  };

  it('should create single-position selection when no current selection', () => {
    const result = calculateShiftClickSelection(500, null, SEQ_LEN, noScroll);
    expect(result.start).toBe(500);
    expect(result.end).toBe(500);
  });

  it('should extend selection forward', () => {
    const result = calculateShiftClickSelection(800, { start: 500, end: 600 }, SEQ_LEN, noScroll);
    expect(result.start).toBe(500);
    expect(result.end).toBe(800);
  });

  it('should extend selection backward', () => {
    const result = calculateShiftClickSelection(300, { start: 500, end: 600 }, SEQ_LEN, noScroll);
    expect(result.start).toBe(300);
    expect(result.end).toBe(600);
  });
});

describe('rangeOverlapsLine', () => {
  describe('Normal line [1000, 1100)', () => {
    const lineStart = 1000;
    const lineEnd = 1100;

    it('should detect overlap when range is inside line', () => {
      expect(rangeOverlapsLine({ start: 1020, end: 1050 }, lineStart, lineEnd, SEQ_LEN)).toBe(true);
    });

    it('should detect overlap when range spans line', () => {
      expect(rangeOverlapsLine({ start: 900, end: 1200 }, lineStart, lineEnd, SEQ_LEN)).toBe(true);
    });

    it('should detect overlap when range starts before line and ends inside', () => {
      expect(rangeOverlapsLine({ start: 900, end: 1050 }, lineStart, lineEnd, SEQ_LEN)).toBe(true);
    });

    it('should return false when range is entirely before line', () => {
      expect(rangeOverlapsLine({ start: 500, end: 800 }, lineStart, lineEnd, SEQ_LEN)).toBe(false);
    });

    it('should return false when range is entirely after line', () => {
      expect(rangeOverlapsLine({ start: 1200, end: 1500 }, lineStart, lineEnd, SEQ_LEN)).toBe(
        false
      );
    });

    it('should detect wrapping range overlapping with normal line via segment 1', () => {
      expect(
        rangeOverlapsLine({ start: 9500, end: 500, wraps: true }, lineStart, lineEnd, SEQ_LEN)
      ).toBe(false);
    });

    it('should not detect wrapping range when line is in the gap', () => {
      expect(rangeOverlapsLine({ start: 9500, end: 500, wraps: true }, 1000, 1100, SEQ_LEN)).toBe(
        false
      );
    });
  });

  describe('Origin-spanning line [9950, 50)', () => {
    const lineStart = 9950;
    const lineEnd = 50;

    it('should detect normal range overlapping pre-origin segment', () => {
      expect(rangeOverlapsLine({ start: 9900, end: 9999 }, lineStart, lineEnd, SEQ_LEN)).toBe(true);
    });

    it('should detect normal range overlapping post-origin segment', () => {
      expect(rangeOverlapsLine({ start: 0, end: 30 }, lineStart, lineEnd, SEQ_LEN)).toBe(true);
    });

    it('should return false for range in the gap', () => {
      expect(rangeOverlapsLine({ start: 100, end: 9900 }, lineStart, lineEnd, SEQ_LEN)).toBe(false);
    });
  });
});

describe('getVisibleRangeOnLine', () => {
  it('should return single segment for normal range on normal line', () => {
    const segments = getVisibleRangeOnLine({ start: 1020, end: 1050 }, 1000, 1100, SEQ_LEN);
    expect(segments).toHaveLength(1);
    expect(segments[0].start).toBe(1020);
    expect(segments[0].end).toBe(1050);
    expect(segments[0].charIndexStart).toBe(20);
  });

  it('should clip range to line bounds', () => {
    const segments = getVisibleRangeOnLine({ start: 900, end: 1200 }, 1000, 1100, SEQ_LEN);
    expect(segments).toHaveLength(1);
    expect(segments[0].start).toBe(1000);
    expect(segments[0].end).toBe(1099);
    expect(segments[0].charIndexStart).toBe(0);
  });

  it('should return empty for non-overlapping range', () => {
    const segments = getVisibleRangeOnLine({ start: 500, end: 800 }, 1000, 1100, SEQ_LEN);
    expect(segments).toHaveLength(0);
  });
});

describe('handleShiftClickNucleotide', () => {
  it('should create selection from cursor to clicked position (click to right)', () => {
    const result = handleShiftClickNucleotide(null, 110, 100, SEQ_LEN);
    expect(result.start).toBe(100);
    expect(result.end).toBe(110);
  });

  it('should create selection from clicked position to cursor (click to left, linear)', () => {
    const result = handleShiftClickNucleotide(null, 90, 100, SEQ_LEN, false);
    expect(result.start).toBe(90);
    expect(result.end).toBe(100);
    expect(result.wraps).toBeUndefined();
  });

  it('should create WRAPPING selection when clicking left on circular sequence', () => {
    const result = handleShiftClickNucleotide(null, 90, 100, SEQ_LEN, true);
    expect(result.start).toBe(100);
    expect(result.end).toBe(90);
    expect(result.wraps).toBe(true);
  });

  it('should modify downstream end when selection exists', () => {
    const result = handleShiftClickNucleotide({ start: 100, end: 200 }, 300, null, SEQ_LEN);
    expect(result.start).toBe(100);
    expect(result.end).toBe(300);
  });
});

describe('handleOptionShiftClickNucleotide', () => {
  describe('BUG FIX: selecting leftward from cursor without selection', () => {
    it('should NOT include nucleotide at cursor position when selecting leftward', () => {
      const result = handleOptionShiftClickNucleotide(null, 90, 100, SEQ_LEN);
      expect(result.start).toBe(90);
      expect(result.end).toBe(99);
    });

    it('should work correctly when cursor is near origin', () => {
      const result = handleOptionShiftClickNucleotide(null, 1, 5, SEQ_LEN);
      expect(result.start).toBe(1);
      expect(result.end).toBe(4);
    });

    it('should handle cursor at position 1 (boundary case)', () => {
      const result = handleOptionShiftClickNucleotide(null, 0, 1, SEQ_LEN);
      expect(result.start).toBe(0);
      expect(result.end).toBe(0);
    });
  });

  it('should create selection from cursor to clicked position (click to right, linear)', () => {
    const result = handleOptionShiftClickNucleotide(null, 110, 100, SEQ_LEN, false);
    expect(result.start).toBe(100);
    expect(result.end).toBe(110);
    expect(result.wraps).toBeUndefined();
  });

  it('should create WRAPPING selection when clicking right on circular sequence', () => {
    const result = handleOptionShiftClickNucleotide(null, 110, 100, SEQ_LEN, true);
    expect(result.start).toBe(110);
    expect(result.end).toBe(100);
    expect(result.wraps).toBe(true);
  });

  it('should modify upstream end when selection exists', () => {
    const result = handleOptionShiftClickNucleotide({ start: 100, end: 200 }, 50, null, SEQ_LEN);
    expect(result.start).toBe(50);
    expect(result.end).toBe(200);
  });
});

describe('computeShiftClickRangeForAnnotation', () => {
  it('extends a linear selection through the full annotation range', () => {
    const result = computeShiftClickRangeForAnnotation({
      currentSelection: { start: 100, end: 150 },
      rangeStart: 220,
      rangeEnd: 260,
      cursorPosition: null,
      sequenceLength: SEQ_LEN,
      isLinear: true,
      isAltKey: false,
    });

    expect(result).toEqual({ start: 100, end: 260 });
  });

  it('uses the annotation boundary rather than the clicked base for circular shift-click', () => {
    const result = computeShiftClickRangeForAnnotation({
      currentSelection: { start: 100, end: 150 },
      rangeStart: 220,
      rangeEnd: 260,
      cursorPosition: null,
      sequenceLength: SEQ_LEN,
      isLinear: false,
      isAltKey: false,
    });

    expect(result).toEqual({ start: 100, end: 260 });
  });

  it('uses the annotation start boundary for circular option-shift-click', () => {
    const result = computeShiftClickRangeForAnnotation({
      currentSelection: { start: 100, end: 150 },
      rangeStart: 40,
      rangeEnd: 80,
      cursorPosition: null,
      sequenceLength: SEQ_LEN,
      isLinear: false,
      isAltKey: true,
    });

    expect(result).toEqual({ start: 40, end: 150 });
  });
});

describe('invertSelection', () => {
  it('inverts a normal (non-wrapping) selection', () => {
    const result = invertSelection({ start: 10, end: 19 }, 100);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(20);
    expect(result!.end).toBe(9);
    expect(result!.wraps).toBe(true);
  });

  it('inverts a wrapping selection back to non-wrapping', () => {
    const result = invertSelection({ start: 90, end: 9, wraps: true }, 100);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(10);
    expect(result!.end).toBe(89);
    expect(result!.wraps).toBeUndefined();
  });

  it('returns null when nothing is selected', () => {
    expect(invertSelection(null, 100)).toBeNull();
  });

  it('returns null when entire sequence is selected', () => {
    expect(invertSelection({ start: 0, end: 99 }, 100)).toBeNull();
  });

  it('handles selection at start of sequence', () => {
    const result = invertSelection({ start: 0, end: 4 }, 100);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(5);
    expect(result!.end).toBe(99);
    expect(result!.wraps).toBeUndefined();
  });

  it('handles selection at end of sequence', () => {
    const result = invertSelection({ start: 95, end: 99 }, 100);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(0);
    expect(result!.end).toBe(94);
    expect(result!.wraps).toBeUndefined();
  });

  it('handles single-base selection', () => {
    const result = invertSelection({ start: 50, end: 50 }, 100);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(51);
    expect(result!.end).toBe(49);
    expect(result!.wraps).toBe(true);
  });
});
