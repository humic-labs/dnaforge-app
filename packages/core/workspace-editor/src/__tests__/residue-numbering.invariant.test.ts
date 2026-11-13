import { describe, it, expect } from 'vitest';
import type { Annotation } from '@waypoint/sequence-utils';
import { getCodonsForSingleCDS, resolveResidueIndex } from '../translation';

const SEQ = 'ATG' + 'GCT'.repeat(18) + 'TAA' + 'CCCGG';

function cds(partial: Partial<Annotation>): Annotation {
  return {
    name: 'cds',
    type: 'CDS',
    start: 1,
    end: 60,
    direction: 1,
    color: '#3b82f6',
    ...partial,
  } as Annotation;
}

export function runResidueNumberingContract(
  label: string,
  codons: Array<{ startPos: number; residueIndex?: number }>,
  direction: 1 | -1
): void {
  it(`${label}: every codon has a biological residueIndex (no positional fallback)`, () => {
    for (const c of codons) {
      expect(resolveResidueIndex(c)).toBe(c.residueIndex);
      expect(typeof c.residueIndex).toBe('number');
    }
  });

  it(`${label}: residueIndex is contiguous protein order 1..N`, () => {
    const ris = codons.map((c) => c.residueIndex!).sort((a, b) => a - b);
    expect(ris[0]).toBe(1);
    for (let i = 1; i < ris.length; i++) expect(ris[i]).toBe(ris[i - 1] + 1);
  });

  it(`${label}: numbering follows protein order, NOT screen x (direction ${direction})`, () => {
    const byScreenX = [...codons].sort((a, b) => a.startPos - b.startPos);
    const numbersLeftToRight = byScreenX.map((c) => c.residueIndex!);
    const ascending = numbersLeftToRight.every((n, i) => i === 0 || n > numbersLeftToRight[i - 1]);
    const descending = numbersLeftToRight.every((n, i) => i === 0 || n < numbersLeftToRight[i - 1]);
    if (direction === 1) {
      expect(ascending).toBe(true);
    } else {
      expect(descending).toBe(true);
      expect(ascending).toBe(false);
    }
  });
}

describe('residue numbering invariant — Canvas2D codon model (real translation)', () => {
  describe('forward CDS', () => {
    const codons = getCodonsForSingleCDS(cds({ direction: 1 }), 0, 60, SEQ);
    runResidueNumberingContract('forward', codons, 1);
  });

  describe('reverse CDS (the regression case)', () => {
    const codons = getCodonsForSingleCDS(cds({ direction: -1 }), 0, 60, SEQ);
    runResidueNumberingContract('reverse', codons, -1);

    it('residue 1 sits at the HIGHEST genomic coordinate, not the lowest', () => {
      const r1 = codons.find((c) => c.residueIndex === 1)!;
      const rN = codons.find((c) => c.residueIndex === codons.length)!;
      expect(r1.startPos).toBeGreaterThan(rN.startPos);
    });
  });

  describe('origin-spanning reverse CDS is contiguous, NOT spliced/screen-ordered', () => {
    const wrapped = getCodonsForSingleCDS(cds({ start: 55, end: 12, direction: -1 }), 0, 60, SEQ);
    it('residueIndex values are unique (not re-numbered per wrap segment)', () => {
      const ris = wrapped.map((c) => c.residueIndex!);
      expect(new Set(ris).size).toBe(ris.length);
    });
    it('numbering is inverse to genomic order modulo the wrap (reverse strand)', () => {
      const unwrap = (bp: number) => (bp >= 55 ? bp : bp + 60);
      const ordered = [...wrapped].sort((a, b) => unwrap(a.startPos) - unwrap(b.startPos));
      const ris = ordered.map((c) => c.residueIndex!);
      expect(ris.every((n, i) => i === 0 || n < ris[i - 1])).toBe(true);
    });
  });
});

describe('resolveResidueIndex is the only sanctioned accessor', () => {
  it('throws in dev/test when a codon omits residueIndex (no screen-order guess)', () => {
    expect(() => resolveResidueIndex({ startPos: 100 } as { residueIndex?: number })).toThrow(
      /residueIndex/
    );
  });

  it('returns the biological index verbatim when present', () => {
    expect(resolveResidueIndex({ residueIndex: 42 })).toBe(42);
  });
});
