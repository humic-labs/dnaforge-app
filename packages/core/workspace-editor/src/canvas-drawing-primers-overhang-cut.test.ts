import { describe, expect, it } from 'vitest';
import { primerOverhangCutVisibleRanges } from './canvas-drawing-primers';

describe('primerOverhangCutVisibleRanges', () => {
  it('splits a linear forward overhang at the cut into cleaved then retained', () => {
    expect(
      primerOverhangCutVisibleRanges({
        primerSpansOrigin: false,
        sequenceLength: 100,
        isForward: true,
        cutPos: 4,
        overhangLen: 8,
        fullPrimerLength: 28,
        basesStartIdx: 0,
        basesEndIdx: 8,
        ohAbsStart: 10,
        ohAbsEnd: 18,
        visibleStart: 10,
        visibleEnd: 18,
      })
    ).toEqual({
      cleavedVisStart: 0,
      cleavedVisEnd: 4,
      retainedVisStart: 4,
      retainedVisEnd: 8,
      scar4bpIdxStart: 0,
    });
  });

  it('splits a linear reverse overhang as retained then cleaved', () => {
    expect(
      primerOverhangCutVisibleRanges({
        primerSpansOrigin: false,
        sequenceLength: 100,
        isForward: false,
        cutPos: 4,
        overhangLen: 8,
        fullPrimerLength: 28,
        basesStartIdx: 20,
        basesEndIdx: 28,
        ohAbsStart: 40,
        ohAbsEnd: 48,
        visibleStart: 40,
        visibleEnd: 48,
      })
    ).toEqual({
      cleavedVisStart: 4,
      cleavedVisEnd: 8,
      retainedVisStart: 0,
      retainedVisEnd: 4,
      scar4bpIdxStart: 3,
    });
  });

  it('uses primer-index coordinates for origin-spanning forward primers', () => {
    expect(
      primerOverhangCutVisibleRanges({
        primerSpansOrigin: true,
        sequenceLength: 50,
        isForward: true,
        cutPos: 4,
        overhangLen: 8,
        fullPrimerLength: 28,
        basesStartIdx: 0,
        basesEndIdx: 8,
        ohAbsStart: 0,
        ohAbsEnd: 0,
        visibleStart: 46,
        visibleEnd: 8,
      })
    ).toEqual({
      cleavedVisStart: 0,
      cleavedVisEnd: 4,
      retainedVisStart: 4,
      retainedVisEnd: 8,
      scar4bpIdxStart: 0,
    });
  });
});
