import { describe, it, expect } from 'vitest';
import {
  validateCoordinateSpace,
  countNonGaps,
  isGappedMode,
  getEffectiveSequence,
  getEffectiveLength,
  isEditingDisabled,
  bioToGapped,
  gappedToBio,
  mapAnnotationToGapped,
  mapAnnotationsToGapped,
} from '../coordinate-space';
import type { CoordinateSpace } from '../types';

describe('coordinate-space utilities', () => {
  describe('countNonGaps', () => {
    it('counts all characters in ungapped sequence', () => {
      expect(countNonGaps('ATGCATGC')).toBe(8);
    });

    it('excludes gap characters from count', () => {
      expect(countNonGaps('ATG--CATGC')).toBe(8);
      expect(countNonGaps('--ATGC--')).toBe(4);
      expect(countNonGaps('----')).toBe(0);
    });

    it('handles empty sequence', () => {
      expect(countNonGaps('')).toBe(0);
    });
  });

  describe('isGappedMode', () => {
    it('returns false when coordinateSpace is undefined', () => {
      expect(isGappedMode(undefined)).toBe(false);
    });

    it('returns false for biological mode', () => {
      expect(isGappedMode({ mode: 'biological' })).toBe(false);
    });

    it('returns true for gapped mode', () => {
      expect(isGappedMode({ mode: 'gapped', gappedSequence: 'ATG--C' })).toBe(true);
    });
  });

  describe('isEditingDisabled', () => {
    it('returns false when coordinateSpace is undefined', () => {
      expect(isEditingDisabled(undefined)).toBe(false);
    });

    it('returns false for biological mode', () => {
      expect(isEditingDisabled({ mode: 'biological' })).toBe(false);
    });

    it('returns true for gapped mode (editing disabled)', () => {
      expect(isEditingDisabled({ mode: 'gapped', gappedSequence: 'ATG--C' })).toBe(true);
    });
  });

  describe('validateCoordinateSpace', () => {
    it('returns true for undefined (biological mode)', () => {
      expect(validateCoordinateSpace(undefined, 'ATGCATGC')).toBe(true);
    });

    it('returns true for explicit biological mode', () => {
      const space: CoordinateSpace = { mode: 'biological' };
      expect(validateCoordinateSpace(space, 'ATGCATGC')).toBe(true);
    });

    it('returns true for valid gapped mode with matching non-gap count', () => {
      const space: CoordinateSpace = {
        mode: 'gapped',
        gappedSequence: 'ATG--CATGC',
      };
      expect(validateCoordinateSpace(space, 'ATGCATGC')).toBe(true);
    });

    it('returns false when gappedSequence is missing in gapped mode', () => {
      const space: CoordinateSpace = { mode: 'gapped' };
      expect(validateCoordinateSpace(space, 'ATGCATGC')).toBe(false);
    });

    it('returns false when gapped sequence has different non-gap count (stale alignment)', () => {
      const space: CoordinateSpace = {
        mode: 'gapped',
        gappedSequence: 'ATG--CAT',
      };
      expect(validateCoordinateSpace(space, 'ATGCATGC')).toBe(false);
    });

    it('returns true for gaps at any position', () => {
      const space: CoordinateSpace = {
        mode: 'gapped',
        gappedSequence: '--ATG--C--',
      };
      expect(validateCoordinateSpace(space, 'ATGC')).toBe(true);
    });
  });

  describe('getEffectiveSequence', () => {
    it('returns biological sequence when coordinateSpace is undefined', () => {
      expect(getEffectiveSequence('ATGCATGC', undefined)).toBe('ATGCATGC');
    });

    it('returns biological sequence for biological mode', () => {
      expect(getEffectiveSequence('ATGCATGC', { mode: 'biological' })).toBe('ATGCATGC');
    });

    it('returns gapped sequence for gapped mode', () => {
      const space: CoordinateSpace = {
        mode: 'gapped',
        gappedSequence: 'ATG--CATGC',
      };
      expect(getEffectiveSequence('ATGCATGC', space)).toBe('ATG--CATGC');
    });
  });

  describe('getEffectiveLength', () => {
    it('returns biological length when coordinateSpace is undefined', () => {
      expect(getEffectiveLength('ATGCATGC', undefined)).toBe(8);
    });

    it('returns biological length for biological mode', () => {
      expect(getEffectiveLength('ATGCATGC', { mode: 'biological' })).toBe(8);
    });

    it('returns gapped length for gapped mode', () => {
      const space: CoordinateSpace = {
        mode: 'gapped',
        gappedSequence: 'ATG--CATGC',
      };
      expect(getEffectiveLength('ATGCATGC', space)).toBe(10);
    });
  });
});

describe('ruler indexing behavior', () => {
  it('biological mode uses 1-indexed positions', () => {
    const isZeroIndexed = false;
    expect(isZeroIndexed).toBe(false);
  });

  it('gapped mode uses 0-indexed columns', () => {
    const isZeroIndexed = true;
    expect(isZeroIndexed).toBe(true);
  });
});

describe('annotation coordinate mapping', () => {
  describe('bioToGapped', () => {
    it('converts biological position to column in ungapped sequence', () => {
      const seq = 'ATGCATGC';
      expect(bioToGapped(1, seq)).toBe(0);
      expect(bioToGapped(4, seq)).toBe(3);
      expect(bioToGapped(8, seq)).toBe(7);
    });

    it('skips gaps when counting biological positions', () => {
      const gappedSeq = 'ATG--CATGC';
      expect(bioToGapped(1, gappedSeq)).toBe(0);
      expect(bioToGapped(2, gappedSeq)).toBe(1);
      expect(bioToGapped(3, gappedSeq)).toBe(2);
      expect(bioToGapped(4, gappedSeq)).toBe(5);
      expect(bioToGapped(5, gappedSeq)).toBe(6);
      expect(bioToGapped(8, gappedSeq)).toBe(9);
    });

    it('returns -1 for invalid positions', () => {
      expect(bioToGapped(0, 'ATGC')).toBe(-1);
      expect(bioToGapped(-1, 'ATGC')).toBe(-1);
      expect(bioToGapped(10, 'ATGC')).toBe(-1);
    });

    it('handles sequence with leading gaps', () => {
      const seq = '--ATGC';
      expect(bioToGapped(1, seq)).toBe(2);
      expect(bioToGapped(4, seq)).toBe(5);
    });

    it('handles sequence with trailing gaps', () => {
      const seq = 'ATGC--';
      expect(bioToGapped(1, seq)).toBe(0);
      expect(bioToGapped(4, seq)).toBe(3);
    });
  });

  describe('gappedToBio', () => {
    it('converts column to biological position in ungapped sequence', () => {
      const seq = 'ATGCATGC';
      expect(gappedToBio(0, seq)).toBe(1);
      expect(gappedToBio(3, seq)).toBe(4);
      expect(gappedToBio(7, seq)).toBe(8);
    });

    it('skips gaps and counts only non-gap characters', () => {
      const gappedSeq = 'ATG--CATGC';
      expect(gappedToBio(0, gappedSeq)).toBe(1);
      expect(gappedToBio(1, gappedSeq)).toBe(2);
      expect(gappedToBio(2, gappedSeq)).toBe(3);
      expect(gappedToBio(5, gappedSeq)).toBe(4);
      expect(gappedToBio(6, gappedSeq)).toBe(5);
      expect(gappedToBio(9, gappedSeq)).toBe(8);
    });

    it('returns -1 for gap columns', () => {
      const gappedSeq = 'ATG--CATGC';
      expect(gappedToBio(3, gappedSeq)).toBe(-1);
      expect(gappedToBio(4, gappedSeq)).toBe(-1);
    });

    it('returns -1 for invalid column indices', () => {
      expect(gappedToBio(-1, 'ATGC')).toBe(-1);
      expect(gappedToBio(4, 'ATGC')).toBe(-1);
      expect(gappedToBio(10, 'ATGC')).toBe(-1);
    });

    it('handles sequence with leading gaps', () => {
      const seq = '--ATGC';
      expect(gappedToBio(0, seq)).toBe(-1);
      expect(gappedToBio(1, seq)).toBe(-1);
      expect(gappedToBio(2, seq)).toBe(1);
      expect(gappedToBio(5, seq)).toBe(4);
    });

    it('handles sequence with trailing gaps', () => {
      const seq = 'ATGC--';
      expect(gappedToBio(0, seq)).toBe(1);
      expect(gappedToBio(3, seq)).toBe(4);
      expect(gappedToBio(4, seq)).toBe(-1);
      expect(gappedToBio(5, seq)).toBe(-1);
    });

    it('handles all-gap sequence', () => {
      expect(gappedToBio(0, '----')).toBe(-1);
      expect(gappedToBio(3, '----')).toBe(-1);
    });
  });

  describe('bioToGapped ↔ gappedToBio round-trip invariants', () => {
    it('round-trip: bioToGapped(gappedToBio(col)) === col for non-gap columns', () => {
      const gappedSeq = 'ATG--CATGC';
      const nonGapCols = [0, 1, 2, 5, 6, 7, 8, 9];
      for (const col of nonGapCols) {
        const bio = gappedToBio(col, gappedSeq);
        expect(bio).toBeGreaterThan(0);
        const backToCol = bioToGapped(bio, gappedSeq);
        expect(backToCol).toBe(col);
      }
    });

    it('round-trip: gappedToBio(bioToGapped(pos)) === pos for all valid bio positions', () => {
      const gappedSeq = 'ATG--CATGC';
      for (let bioPos = 1; bioPos <= 8; bioPos++) {
        const col = bioToGapped(bioPos, gappedSeq);
        expect(col).toBeGreaterThanOrEqual(0);
        const backToBio = gappedToBio(col, gappedSeq);
        expect(backToBio).toBe(bioPos);
      }
    });

    it('round-trip with complex gap pattern', () => {
      const gappedSeq = '--ATG---CAT--GC--';
      const bioLen = countNonGaps(gappedSeq);
      expect(bioLen).toBe(8);

      for (let bioPos = 1; bioPos <= bioLen; bioPos++) {
        const col = bioToGapped(bioPos, gappedSeq);
        expect(col).toBeGreaterThanOrEqual(0);
        const backToBio = gappedToBio(col, gappedSeq);
        expect(backToBio).toBe(bioPos);
      }
    });

    it('gap columns have no bio position (one-way trip)', () => {
      const gappedSeq = 'ATG--CATGC';
      expect(gappedToBio(3, gappedSeq)).toBe(-1);
      expect(gappedToBio(4, gappedSeq)).toBe(-1);
    });
  });

  describe('mapAnnotationToGapped', () => {
    it('maps annotation positions to gapped columns', () => {
      const ann = { start: 4, end: 6, name: 'Feature' };
      const gappedSeq = 'ATG--CATGC';

      const result = mapAnnotationToGapped(ann, gappedSeq);

      expect(result.startCol).toBe(5);
      expect(result.endCol).toBe(8);
      expect(result.start).toBe(4);
      expect(result.end).toBe(6);
      expect(result.name).toBe('Feature');
    });

    it('handles annotation at start of sequence', () => {
      const ann = { start: 1, end: 3 };
      const gappedSeq = 'ATG--CATGC';

      const result = mapAnnotationToGapped(ann, gappedSeq);

      expect(result.startCol).toBe(0);
      expect(result.endCol).toBe(3);
    });

    it('handles annotation spanning gaps', () => {
      const ann = { start: 3, end: 5 };
      const gappedSeq = 'ATG--CATGC';

      const result = mapAnnotationToGapped(ann, gappedSeq);

      expect(result.startCol).toBe(2);
      expect(result.endCol).toBe(7);
    });
  });

  describe('mapAnnotationsToGapped', () => {
    it('returns original annotations when coordinateSpace is undefined', () => {
      const anns = [{ start: 1, end: 3 }];
      const result = mapAnnotationsToGapped(anns, undefined);

      expect(result).toBe(anns);
    });

    it('returns original annotations in biological mode', () => {
      const anns = [{ start: 1, end: 3 }];
      const result = mapAnnotationsToGapped(anns, { mode: 'biological' });

      expect(result).toBe(anns);
    });

    it('maps all annotations in gapped mode', () => {
      const anns = [
        { start: 1, end: 3, name: 'A' },
        { start: 4, end: 6, name: 'B' },
      ];
      const space: CoordinateSpace = {
        mode: 'gapped',
        gappedSequence: 'ATG--CATGC',
      };

      const result = mapAnnotationsToGapped(anns, space);

      expect(result).toHaveLength(2);
      expect(result[0].startCol).toBe(0);
      expect(result[0].endCol).toBe(3);
      expect(result[1].startCol).toBe(5);
      expect(result[1].endCol).toBe(8);
    });
  });
});
