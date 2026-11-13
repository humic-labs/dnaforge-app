// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  bpToCodonIndex,
  codonIndexToResidue,
  codonToBpRange,
  residueToCodonIndex,
  type CdsBounds,
} from './codon-residue-mapping';
import type { ResidueLocation } from '../../page/embeds/structure3d/types';

const FWD: CdsBounds = { cdsStart: 0, cdsEnd: 29, strand: 1 };
const REV: CdsBounds = { cdsStart: 100, cdsEnd: 129, strand: -1 };

describe('codonToBpRange — forward strand', () => {
  it('codon 0 spans bp 0..2', () => {
    expect(codonToBpRange(0, FWD)).toEqual({ start: 0, end: 2 });
  });

  it('codon 1 spans bp 3..5', () => {
    expect(codonToBpRange(1, FWD)).toEqual({ start: 3, end: 5 });
  });

  it('last codon (9) spans bp 27..29', () => {
    expect(codonToBpRange(9, FWD)).toEqual({ start: 27, end: 29 });
  });

  it('past-end codon returns null', () => {
    expect(codonToBpRange(10, FWD)).toBeNull();
    expect(codonToBpRange(100, FWD)).toBeNull();
  });

  it('negative codon index returns null', () => {
    expect(codonToBpRange(-1, FWD)).toBeNull();
  });
});

describe('codonToBpRange — reverse strand', () => {
  it('codon 0 (N-terminus) spans the HIGHEST 3 bp', () => {
    expect(codonToBpRange(0, REV)).toEqual({ start: 127, end: 129 });
  });

  it('codon 1 spans the next 3 bp going downward', () => {
    expect(codonToBpRange(1, REV)).toEqual({ start: 124, end: 126 });
  });

  it('last codon (9) spans the LOWEST 3 bp', () => {
    expect(codonToBpRange(9, REV)).toEqual({ start: 100, end: 102 });
  });

  it('past-end codon returns null', () => {
    expect(codonToBpRange(10, REV)).toBeNull();
  });
});

describe('bpToCodonIndex — forward strand', () => {
  it('first base of CDS → codon 0', () => {
    expect(bpToCodonIndex(0, FWD)).toBe(0);
  });

  it('second & third base of codon 0 still map to codon 0', () => {
    expect(bpToCodonIndex(1, FWD)).toBe(0);
    expect(bpToCodonIndex(2, FWD)).toBe(0);
  });

  it('first base of codon 1', () => {
    expect(bpToCodonIndex(3, FWD)).toBe(1);
  });

  it('last bp of CDS → last codon', () => {
    expect(bpToCodonIndex(29, FWD)).toBe(9);
  });

  it('outside CDS returns null', () => {
    expect(bpToCodonIndex(-1, FWD)).toBeNull();
    expect(bpToCodonIndex(30, FWD)).toBeNull();
    expect(bpToCodonIndex(1000, FWD)).toBeNull();
  });
});

describe('bpToCodonIndex — reverse strand', () => {
  it('highest bp (cdsEnd) → codon 0', () => {
    expect(bpToCodonIndex(129, REV)).toBe(0);
    expect(bpToCodonIndex(128, REV)).toBe(0);
    expect(bpToCodonIndex(127, REV)).toBe(0);
  });

  it('next group going down → codon 1', () => {
    expect(bpToCodonIndex(126, REV)).toBe(1);
  });

  it('lowest bp (cdsStart) → last codon', () => {
    expect(bpToCodonIndex(100, REV)).toBe(9);
  });

  it('outside CDS returns null', () => {
    expect(bpToCodonIndex(99, REV)).toBeNull();
    expect(bpToCodonIndex(130, REV)).toBeNull();
  });
});

describe('round-trip codon→bp→codon', () => {
  it('forward: every codon maps back to itself from any of its 3 bp', () => {
    for (let codon = 0; codon < 10; codon++) {
      const range = codonToBpRange(codon, FWD)!;
      expect(bpToCodonIndex(range.start, FWD)).toBe(codon);
      expect(bpToCodonIndex(range.start + 1, FWD)).toBe(codon);
      expect(bpToCodonIndex(range.end, FWD)).toBe(codon);
    }
  });

  it('reverse: every codon maps back to itself from any of its 3 bp', () => {
    for (let codon = 0; codon < 10; codon++) {
      const range = codonToBpRange(codon, REV)!;
      expect(bpToCodonIndex(range.start, REV)).toBe(codon);
      expect(bpToCodonIndex(range.start + 1, REV)).toBe(codon);
      expect(bpToCodonIndex(range.end, REV)).toBe(codon);
    }
  });
});

describe('residueToCodonIndex', () => {
  it('residue position 1 (N-terminus) → codon 0', () => {
    const r: ResidueLocation = { chain: 'A', position: 1 };
    expect(residueToCodonIndex(r)).toBe(0);
  });

  it('residue position 47 → codon 46', () => {
    const r: ResidueLocation = { chain: 'A', position: 47 };
    expect(residueToCodonIndex(r)).toBe(46);
  });

  it('ligand (has compId) returns null', () => {
    const lig: ResidueLocation = { chain: 'A', position: 1, compId: 'ATP' };
    expect(residueToCodonIndex(lig)).toBeNull();
  });

  it('non-positive position returns null', () => {
    expect(residueToCodonIndex({ chain: 'A', position: 0 })).toBeNull();
    expect(residueToCodonIndex({ chain: 'A', position: -1 })).toBeNull();
  });
});

describe('codonIndexToResidue', () => {
  it('codon 0 → residue at position 1', () => {
    expect(codonIndexToResidue(0, 'A')).toEqual({ chain: 'A', position: 1 });
  });

  it('preserves the named chain', () => {
    expect(codonIndexToResidue(5, 'B')).toEqual({ chain: 'B', position: 6 });
  });
});

const SPLICED_FWD: CdsBounds = {
  cdsStart: 0,
  cdsEnd: 23,
  strand: 1,
  segments: [
    { start: 0, end: 5 },
    { start: 10, end: 14 },
    { start: 20, end: 23 },
  ],
};

const SPLICED_REV: CdsBounds = {
  cdsStart: 0,
  cdsEnd: 23,
  strand: -1,
  segments: [
    { start: 0, end: 5 },
    { start: 10, end: 14 },
    { start: 20, end: 23 },
  ],
};

describe('codonToBpRange — spliced CDS forward', () => {
  it('codon 0 wholly inside segment 1 → bp 0..2', () => {
    expect(codonToBpRange(0, SPLICED_FWD)).toEqual({ start: 0, end: 2 });
  });

  it('codon 1 wholly inside segment 1 → bp 3..5', () => {
    expect(codonToBpRange(1, SPLICED_FWD)).toEqual({ start: 3, end: 5 });
  });

  it('codon 2 wholly inside segment 2 → bp 10..12', () => {
    expect(codonToBpRange(2, SPLICED_FWD)).toEqual({ start: 10, end: 12 });
  });

  it('codon 3 spans the second splice → range covers intron bp', () => {
    expect(codonToBpRange(3, SPLICED_FWD)).toEqual({ start: 13, end: 20 });
  });

  it('codon 4 wholly inside segment 3 → bp 21..23', () => {
    expect(codonToBpRange(4, SPLICED_FWD)).toEqual({ start: 21, end: 23 });
  });

  it('past last codon returns null', () => {
    expect(codonToBpRange(5, SPLICED_FWD)).toBeNull();
  });
});

describe('codonToBpRange — spliced CDS reverse', () => {
  it('codon 0 wholly inside segment 3 (highest segment) → bp 21..23', () => {
    expect(codonToBpRange(0, SPLICED_REV)).toEqual({ start: 21, end: 23 });
  });

  it('codon 1 spans the seg3↔seg2 splice', () => {
    expect(codonToBpRange(1, SPLICED_REV)).toEqual({ start: 13, end: 20 });
  });

  it('codon 2 wholly inside segment 2 → bp 10..12', () => {
    expect(codonToBpRange(2, SPLICED_REV)).toEqual({ start: 10, end: 12 });
  });

  it('codon 3 spans the seg2↔seg1 splice', () => {
    expect(codonToBpRange(3, SPLICED_REV)).toEqual({ start: 3, end: 5 });
  });

  it('codon 4 wholly inside segment 1 (lowest) → bp 0..2', () => {
    expect(codonToBpRange(4, SPLICED_REV)).toEqual({ start: 0, end: 2 });
  });
});

describe('bpToCodonIndex — spliced CDS forward', () => {
  it('bp inside segment 1 → correct codon', () => {
    expect(bpToCodonIndex(0, SPLICED_FWD)).toBe(0);
    expect(bpToCodonIndex(5, SPLICED_FWD)).toBe(1);
  });

  it('bp inside segment 2 → correct codon', () => {
    expect(bpToCodonIndex(10, SPLICED_FWD)).toBe(2);
    expect(bpToCodonIndex(12, SPLICED_FWD)).toBe(2);
    expect(bpToCodonIndex(13, SPLICED_FWD)).toBe(3);
    expect(bpToCodonIndex(14, SPLICED_FWD)).toBe(3);
  });

  it('bp inside segment 3 → correct codon', () => {
    expect(bpToCodonIndex(20, SPLICED_FWD)).toBe(3);
    expect(bpToCodonIndex(21, SPLICED_FWD)).toBe(4);
    expect(bpToCodonIndex(23, SPLICED_FWD)).toBe(4);
  });

  it('bp in an intron returns null', () => {
    expect(bpToCodonIndex(6, SPLICED_FWD)).toBeNull();
    expect(bpToCodonIndex(9, SPLICED_FWD)).toBeNull();
    expect(bpToCodonIndex(15, SPLICED_FWD)).toBeNull();
    expect(bpToCodonIndex(19, SPLICED_FWD)).toBeNull();
  });

  it('outside CDS bbox returns null', () => {
    expect(bpToCodonIndex(-1, SPLICED_FWD)).toBeNull();
    expect(bpToCodonIndex(24, SPLICED_FWD)).toBeNull();
  });
});

describe('bpToCodonIndex — spliced CDS reverse', () => {
  it('bp inside segment 3 → codon 0 (N-terminus is at highest bp)', () => {
    expect(bpToCodonIndex(23, SPLICED_REV)).toBe(0);
    expect(bpToCodonIndex(21, SPLICED_REV)).toBe(0);
    expect(bpToCodonIndex(20, SPLICED_REV)).toBe(1);
  });

  it('bp inside segment 2 → middle codons', () => {
    expect(bpToCodonIndex(14, SPLICED_REV)).toBe(1);
    expect(bpToCodonIndex(13, SPLICED_REV)).toBe(1);
    expect(bpToCodonIndex(12, SPLICED_REV)).toBe(2);
    expect(bpToCodonIndex(10, SPLICED_REV)).toBe(2);
  });

  it('bp inside segment 1 → highest codon index', () => {
    expect(bpToCodonIndex(5, SPLICED_REV)).toBe(3);
    expect(bpToCodonIndex(0, SPLICED_REV)).toBe(4);
  });

  it('bp in an intron returns null', () => {
    expect(bpToCodonIndex(7, SPLICED_REV)).toBeNull();
    expect(bpToCodonIndex(17, SPLICED_REV)).toBeNull();
  });
});

describe('round-trip on spliced CDS', () => {
  it('forward: every codon maps back to itself from its first bp', () => {
    for (let codon = 0; codon < 5; codon++) {
      const range = codonToBpRange(codon, SPLICED_FWD)!;
      expect(bpToCodonIndex(range.start, SPLICED_FWD)).toBe(codon);
      expect(bpToCodonIndex(range.end, SPLICED_FWD)).toBe(codon);
    }
  });

  it('reverse: every codon maps back to itself from its endpoints', () => {
    for (let codon = 0; codon < 5; codon++) {
      const range = codonToBpRange(codon, SPLICED_REV)!;
      expect(bpToCodonIndex(range.start, SPLICED_REV)).toBe(codon);
      expect(bpToCodonIndex(range.end, SPLICED_REV)).toBe(codon);
    }
  });
});
