// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  mergeRanges,
  addPositionToRanges,
  isPositionInRanges,
  removePositionFromRanges,
  positionsToRanges,
} from './rangeUtils';

describe('rangeUtils', () => {
  describe('mergeRanges', () => {
    it('should return empty array for empty input', () => {
      expect(mergeRanges([])).toEqual([]);
    });

    it('should return single range unchanged', () => {
      expect(mergeRanges([[1, 5]])).toEqual([[1, 5]]);
    });

    it('should merge overlapping ranges', () => {
      expect(
        mergeRanges([
          [1, 5],
          [3, 8],
        ])
      ).toEqual([[1, 8]]);
    });

    it('should merge adjacent ranges (touching)', () => {
      expect(
        mergeRanges([
          [1, 3],
          [4, 6],
        ])
      ).toEqual([[1, 6]]);
    });

    it('should NOT merge non-adjacent ranges (gap)', () => {
      expect(
        mergeRanges([
          [1, 3],
          [5, 7],
        ])
      ).toEqual([
        [1, 3],
        [5, 7],
      ]);
    });

    it('should handle nested ranges', () => {
      expect(
        mergeRanges([
          [1, 10],
          [3, 5],
        ])
      ).toEqual([[1, 10]]);
    });

    it('should handle unsorted input', () => {
      expect(
        mergeRanges([
          [5, 7],
          [1, 3],
          [4, 6],
        ])
      ).toEqual([[1, 7]]);
    });

    it('should handle multiple separate ranges', () => {
      expect(
        mergeRanges([
          [1, 2],
          [5, 6],
          [10, 12],
        ])
      ).toEqual([
        [1, 2],
        [5, 6],
        [10, 12],
      ]);
    });

    it('should merge chain of adjacent ranges', () => {
      expect(
        mergeRanges([
          [1, 2],
          [3, 4],
          [5, 6],
        ])
      ).toEqual([[1, 6]]);
    });

    it('should handle duplicate ranges', () => {
      expect(
        mergeRanges([
          [1, 5],
          [1, 5],
        ])
      ).toEqual([[1, 5]]);
    });

    it('should handle single-element ranges', () => {
      expect(
        mergeRanges([
          [1, 1],
          [2, 2],
          [3, 3],
        ])
      ).toEqual([[1, 3]]);
    });
  });

  describe('addPositionToRanges', () => {
    it('should add position to empty ranges', () => {
      expect(addPositionToRanges([], 5)).toEqual([[5, 5]]);
    });

    it('should return unchanged if position already in range', () => {
      const ranges: [number, number][] = [[1, 5]];
      expect(addPositionToRanges(ranges, 3)).toBe(ranges);
    });

    it('should extend range when adjacent (before)', () => {
      expect(addPositionToRanges([[5, 7]], 4)).toEqual([[4, 7]]);
    });

    it('should extend range when adjacent (after)', () => {
      expect(addPositionToRanges([[5, 7]], 8)).toEqual([[5, 8]]);
    });

    it('should create new range when not adjacent', () => {
      expect(addPositionToRanges([[1, 3]], 10)).toEqual([
        [1, 3],
        [10, 10],
      ]);
    });

    it('should bridge gap between ranges', () => {
      expect(
        addPositionToRanges(
          [
            [1, 3],
            [5, 7],
          ],
          4
        )
      ).toEqual([[1, 7]]);
    });

    it('should handle position at range boundary (start)', () => {
      const ranges: [number, number][] = [[5, 10]];
      expect(addPositionToRanges(ranges, 5)).toBe(ranges);
    });

    it('should handle position at range boundary (end)', () => {
      const ranges: [number, number][] = [[5, 10]];
      expect(addPositionToRanges(ranges, 10)).toBe(ranges);
    });
  });

  describe('isPositionInRanges', () => {
    it('should return false for empty ranges', () => {
      expect(isPositionInRanges([], 5)).toBe(false);
    });

    it('should return true for position in range', () => {
      expect(isPositionInRanges([[1, 10]], 5)).toBe(true);
    });

    it('should return true for position at start', () => {
      expect(isPositionInRanges([[5, 10]], 5)).toBe(true);
    });

    it('should return true for position at end', () => {
      expect(isPositionInRanges([[5, 10]], 10)).toBe(true);
    });

    it('should return false for position outside range', () => {
      expect(isPositionInRanges([[5, 10]], 3)).toBe(false);
      expect(isPositionInRanges([[5, 10]], 12)).toBe(false);
    });

    it('should check multiple ranges', () => {
      const ranges: [number, number][] = [
        [1, 3],
        [7, 9],
      ];
      expect(isPositionInRanges(ranges, 2)).toBe(true);
      expect(isPositionInRanges(ranges, 8)).toBe(true);
      expect(isPositionInRanges(ranges, 5)).toBe(false);
    });
  });

  describe('removePositionFromRanges', () => {
    it('should return empty for removing from empty ranges', () => {
      expect(removePositionFromRanges([], 5)).toEqual([]);
    });

    it('should return unchanged if position not in any range', () => {
      expect(removePositionFromRanges([[1, 3]], 5)).toEqual([[1, 3]]);
    });

    it('should remove single-element range entirely', () => {
      expect(removePositionFromRanges([[5, 5]], 5)).toEqual([]);
    });

    it('should shrink from start', () => {
      expect(removePositionFromRanges([[5, 10]], 5)).toEqual([[6, 10]]);
    });

    it('should shrink from end', () => {
      expect(removePositionFromRanges([[5, 10]], 10)).toEqual([[5, 9]]);
    });

    it('should split range when removing from middle', () => {
      expect(removePositionFromRanges([[1, 10]], 5)).toEqual([
        [1, 4],
        [6, 10],
      ]);
    });

    it('should only affect the range containing the position', () => {
      expect(
        removePositionFromRanges(
          [
            [1, 3],
            [7, 9],
          ],
          8
        )
      ).toEqual([
        [1, 3],
        [7, 7],
        [9, 9],
      ]);
    });

    it('should handle removing from two-element range (start)', () => {
      expect(removePositionFromRanges([[5, 6]], 5)).toEqual([[6, 6]]);
    });

    it('should handle removing from two-element range (end)', () => {
      expect(removePositionFromRanges([[5, 6]], 6)).toEqual([[5, 5]]);
    });
  });

  describe('positionsToRanges', () => {
    it('should return empty array for empty input', () => {
      expect(positionsToRanges([])).toEqual([]);
    });

    it('should convert single position to single-element range', () => {
      expect(positionsToRanges([5])).toEqual([[5, 5]]);
    });

    it('should convert consecutive positions to single range', () => {
      expect(positionsToRanges([1, 2, 3, 4, 5])).toEqual([[1, 5]]);
    });

    it('should create separate ranges for non-consecutive positions', () => {
      expect(positionsToRanges([1, 2, 3, 5, 6])).toEqual([
        [1, 3],
        [5, 6],
      ]);
    });

    it('should handle unsorted input', () => {
      expect(positionsToRanges([5, 1, 3, 2])).toEqual([
        [1, 3],
        [5, 5],
      ]);
    });

    it('should handle scattered positions', () => {
      expect(positionsToRanges([1, 5, 10, 15])).toEqual([
        [1, 1],
        [5, 5],
        [10, 10],
        [15, 15],
      ]);
    });

    it('should handle duplicate positions', () => {
      expect(positionsToRanges([1, 1, 2, 2, 3])).toEqual([[1, 3]]);
    });

    it('should handle multiple gaps', () => {
      expect(positionsToRanges([1, 2, 5, 6, 7, 10, 11])).toEqual([
        [1, 2],
        [5, 7],
        [10, 11],
      ]);
    });
  });
});
