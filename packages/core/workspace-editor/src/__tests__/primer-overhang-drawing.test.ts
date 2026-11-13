import { describe, it, expect } from 'vitest';
import { calculateRetainedPortions } from '../primer-overhang-drawing';

describe('calculateRetainedPortions', () => {
  describe('forward primers - full 4bp scar visible', () => {
    it('should handle all synthetic (cognate4bpLength=0)', () => {
      const result = calculateRetainedPortions(0, 4, 0, 0, true);
      expect(result.literalVisStart).toBe(4);
      expect(result.literalVisEnd).toBe(4);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(4);
      expect(result.cognateDrawStart).toBe(4);
      expect(result.cognateDrawEnd).toBe(4);
    });

    it('should handle 1 cognate base at end (cognate4bpLength=1)', () => {
      const result = calculateRetainedPortions(0, 4, 0, 1, true);
      expect(result.literalVisStart).toBe(4);
      expect(result.literalVisEnd).toBe(4);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(3);
      expect(result.cognateDrawStart).toBe(3);
      expect(result.cognateDrawEnd).toBe(4);
    });

    it('should handle 2 cognate bases at end (cognate4bpLength=2)', () => {
      const result = calculateRetainedPortions(0, 4, 0, 2, true);
      expect(result.literalVisStart).toBe(4);
      expect(result.literalVisEnd).toBe(4);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(2);
      expect(result.cognateDrawStart).toBe(2);
      expect(result.cognateDrawEnd).toBe(4);
    });

    it('should handle 3 cognate bases at end (cognate4bpLength=3)', () => {
      const result = calculateRetainedPortions(0, 4, 0, 3, true);
      expect(result.literalVisStart).toBe(4);
      expect(result.literalVisEnd).toBe(4);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(1);
      expect(result.cognateDrawStart).toBe(1);
      expect(result.cognateDrawEnd).toBe(4);
    });

    it('should handle all cognate (cognate4bpLength=4)', () => {
      const result = calculateRetainedPortions(0, 4, 0, 4, true);
      expect(result.literalVisStart).toBe(4);
      expect(result.literalVisEnd).toBe(4);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(0);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(4);
    });
  });

  describe('forward primers - partial 4bp scar (scar4bpIdxStart > 0)', () => {
    it('should handle starting at scar index 1, 2 cognate bases', () => {
      const result = calculateRetainedPortions(0, 3, 1, 2, true);
      expect(result.literalVisStart).toBe(3);
      expect(result.literalVisEnd).toBe(3);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(1);
      expect(result.cognateDrawStart).toBe(1);
      expect(result.cognateDrawEnd).toBe(3);
    });

    it('should handle starting at scar index 2, 1 cognate base', () => {
      const result = calculateRetainedPortions(0, 2, 2, 1, true);
      expect(result.literalVisStart).toBe(2);
      expect(result.literalVisEnd).toBe(2);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(1);
      expect(result.cognateDrawStart).toBe(1);
      expect(result.cognateDrawEnd).toBe(2);
    });

    it('should handle starting at scar index 3, 0 cognate bases', () => {
      const result = calculateRetainedPortions(0, 1, 3, 0, true);
      expect(result.literalVisStart).toBe(1);
      expect(result.literalVisEnd).toBe(1);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(1);
      expect(result.cognateDrawStart).toBe(1);
      expect(result.cognateDrawEnd).toBe(1);
    });

    it('should handle starting at scar index 2, all cognate (cognate4bpLength=4)', () => {
      const result = calculateRetainedPortions(0, 2, 2, 4, true);
      expect(result.literalVisStart).toBe(2);
      expect(result.literalVisEnd).toBe(2);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(0);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(2);
    });
  });

  describe('forward primers - with literal portion', () => {
    it('should handle literal bases after 4bp scar', () => {
      const result = calculateRetainedPortions(0, 6, 0, 2, true);
      expect(result.literalVisStart).toBe(4);
      expect(result.literalVisEnd).toBe(6);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(2);
      expect(result.cognateDrawStart).toBe(2);
      expect(result.cognateDrawEnd).toBe(4);
    });
  });

  describe('reverse primers - full 4bp scar visible', () => {
    it('should handle all synthetic (cognate4bpLength=0)', () => {
      const result = calculateRetainedPortions(0, 4, 3, 0, false);
      expect(result.literalVisStart).toBe(0);
      expect(result.literalVisEnd).toBe(0);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(4);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(0);
    });

    it('should handle 1 cognate base at start (cognate4bpLength=1)', () => {
      const result = calculateRetainedPortions(0, 4, 3, 1, false);
      expect(result.literalVisStart).toBe(0);
      expect(result.literalVisEnd).toBe(0);
      expect(result.syntheticDrawStart).toBe(1);
      expect(result.syntheticDrawEnd).toBe(4);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(1);
    });

    it('should handle 2 cognate bases at start (cognate4bpLength=2)', () => {
      const result = calculateRetainedPortions(0, 4, 3, 2, false);
      expect(result.literalVisStart).toBe(0);
      expect(result.literalVisEnd).toBe(0);
      expect(result.syntheticDrawStart).toBe(2);
      expect(result.syntheticDrawEnd).toBe(4);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(2);
    });

    it('should handle 3 cognate bases at start (cognate4bpLength=3)', () => {
      const result = calculateRetainedPortions(0, 4, 3, 3, false);
      expect(result.literalVisStart).toBe(0);
      expect(result.literalVisEnd).toBe(0);
      expect(result.syntheticDrawStart).toBe(3);
      expect(result.syntheticDrawEnd).toBe(4);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(3);
    });

    it('should handle all cognate (cognate4bpLength=4)', () => {
      const result = calculateRetainedPortions(0, 4, 3, 4, false);
      expect(result.literalVisStart).toBe(0);
      expect(result.literalVisEnd).toBe(0);
      expect(result.syntheticDrawStart).toBe(4);
      expect(result.syntheticDrawEnd).toBe(4);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(4);
    });
  });

  describe('reverse primers - partial 4bp scar', () => {
    it('should handle starting at scar index 2, 2 cognate bases', () => {
      const result = calculateRetainedPortions(0, 3, 2, 2, false);
      expect(result.literalVisStart).toBe(0);
      expect(result.literalVisEnd).toBe(0);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(1);
      expect(result.syntheticDrawStart).toBe(1);
      expect(result.syntheticDrawEnd).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('should handle single base retained, forward, within scar, cognate', () => {
      const result = calculateRetainedPortions(0, 1, 3, 4, true);
      expect(result.literalVisStart).toBe(1);
      expect(result.literalVisEnd).toBe(1);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(1);
    });

    it('should handle forward primer with scar4bpIdxStart=4 (all literal)', () => {
      const result = calculateRetainedPortions(0, 3, 4, 2, true);
      expect(result.literalVisStart).toBe(0);
      expect(result.literalVisEnd).toBe(3);
      expect(result.syntheticDrawStart).toBe(0);
      expect(result.syntheticDrawEnd).toBe(0);
      expect(result.cognateDrawStart).toBe(0);
      expect(result.cognateDrawEnd).toBe(0);
    });

    it('should handle non-zero retainedVisStart', () => {
      const result = calculateRetainedPortions(5, 9, 0, 2, true);
      expect(result.literalVisStart).toBe(9);
      expect(result.literalVisEnd).toBe(9);
      expect(result.syntheticDrawStart).toBe(5);
      expect(result.syntheticDrawEnd).toBe(7);
      expect(result.cognateDrawStart).toBe(7);
      expect(result.cognateDrawEnd).toBe(9);
    });
  });

  describe('invariants', () => {
    const testCases = [
      {
        retainedVisStart: 0,
        retainedVisEnd: 4,
        scar4bpIdxStart: 0,
        cognate4bpLength: 2,
        isForward: true,
      },
      {
        retainedVisStart: 0,
        retainedVisEnd: 4,
        scar4bpIdxStart: 3,
        cognate4bpLength: 2,
        isForward: false,
      },
      {
        retainedVisStart: 0,
        retainedVisEnd: 6,
        scar4bpIdxStart: 0,
        cognate4bpLength: 4,
        isForward: true,
      },
      {
        retainedVisStart: 2,
        retainedVisEnd: 8,
        scar4bpIdxStart: 1,
        cognate4bpLength: 1,
        isForward: true,
      },
    ];

    testCases.forEach(
      ({ retainedVisStart, retainedVisEnd, scar4bpIdxStart, cognate4bpLength, isForward }) => {
        it(`should have non-overlapping ranges for (${retainedVisStart}-${retainedVisEnd}, idx=${scar4bpIdxStart}, cog=${cognate4bpLength}, fwd=${isForward})`, () => {
          const result = calculateRetainedPortions(
            retainedVisStart,
            retainedVisEnd,
            scar4bpIdxStart,
            cognate4bpLength,
            isForward
          );

          expect(result.literalVisStart).toBeLessThanOrEqual(result.literalVisEnd);
          expect(result.syntheticDrawStart).toBeLessThanOrEqual(result.syntheticDrawEnd);
          expect(result.cognateDrawStart).toBeLessThanOrEqual(result.cognateDrawEnd);

          expect(result.literalVisStart).toBeGreaterThanOrEqual(retainedVisStart);
          expect(result.literalVisEnd).toBeLessThanOrEqual(retainedVisEnd);
          expect(result.syntheticDrawStart).toBeGreaterThanOrEqual(retainedVisStart);
          expect(result.syntheticDrawEnd).toBeLessThanOrEqual(retainedVisEnd);
          expect(result.cognateDrawStart).toBeGreaterThanOrEqual(retainedVisStart);
          expect(result.cognateDrawEnd).toBeLessThanOrEqual(retainedVisEnd);
        });
      }
    );
  });
});
