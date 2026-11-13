import { describe, it, expect } from 'vitest';
import {
  getAlignmentCodonsForCDS,
  getCodonsForSingleCDS,
  getDraftCodonsForCDS,
  getCachedSplicedSequence,
} from './codon-calculator';
import {
  buildCustomGeneticCode,
  reverseComplement,
  type Annotation,
} from '@waypoint/sequence-utils';

describe('spliced sequence cache identity', () => {
  it.each([1, -1] as const)(
    'keeps different exon boundaries distinct on strand %i',
    (direction) => {
      const bases = 'ATG'.repeat(100);
      const first: Annotation = {
        name: 'INS',
        type: 'CDS',
        start: 1,
        end: 300,
        direction,
        segments: [
          { start: 1, end: 30 },
          { start: 121, end: 150 },
          { start: 241, end: 300 },
        ],
      };
      const changed: Annotation = {
        ...first,
        segments: [
          { start: 1, end: 18 },
          { start: 43, end: 300 },
        ],
      };
      const original = getCachedSplicedSequence(first, bases);
      const updated = getCachedSplicedSequence(changed, bases);
      expect(updated.introns.map((gap) => [gap.genomicStart, gap.genomicEnd])).toEqual([[18, 41]]);
      expect(updated).not.toBe(original);
      expect(getCachedSplicedSequence(structuredClone(first), bases)).toBe(original);
      const qualifiers = { _locationString: ['join(1..30,121..150,241..300)'] };
      getCachedSplicedSequence({ ...first, qualifiers }, bases);
      expect(
        getCachedSplicedSequence({ ...changed, qualifiers }, bases).introns.map((gap) => [
          gap.genomicStart,
          gap.genomicEnd,
        ])
      ).toEqual([[18, 41]]);
    }
  );
});

describe('getAlignmentCodonsForCDS', () => {
  const makeCDS = (
    start: number,
    end: number,
    direction: 1 | -1 = 1,
    startCol?: number,
    endCol?: number
  ): Annotation & { startCol?: number; endCol?: number } => ({
    name: 'test_cds',
    type: 'CDS',
    start,
    end,
    direction,
    color: '#000',
    startCol,
    endCol,
  });

  describe('basic codon extraction', () => {
    it('should extract codons from aligned sequences', () => {
      const alignedRef = 'ATGGCTGAA';
      const alignedQuery = 'ATGGCTGAA';
      const cds = makeCDS(1, 9, 1, 0, 9);

      const codons = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 100);

      expect(codons).toHaveLength(3);
      expect(codons[0]).toMatchObject({
        columnStart: 0,
        columnEnd: 2,
        refAa: 'M',
        queryAa: 'M',
        status: 'match',
      });
      expect(codons[1]).toMatchObject({
        columnStart: 3,
        columnEnd: 5,
        refAa: 'A',
        queryAa: 'A',
        status: 'match',
      });
      expect(codons[2]).toMatchObject({
        columnStart: 6,
        columnEnd: 8,
        refAa: 'E',
        queryAa: 'E',
        status: 'match',
      });
    });
  });

  describe('deletion handling', () => {
    it('should show deleted reference codons where query has gaps', () => {
      const alignedRef = 'ATGGCTGAA';
      const alignedQuery = 'ATG---GAA';
      const cds = makeCDS(1, 9, 1, 0, 9);

      const codons = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 100);

      expect(codons).toHaveLength(3);

      expect(codons[0]).toMatchObject({
        columnStart: 0,
        columnEnd: 2,
        refAa: 'M',
        queryAa: 'M',
        status: 'match',
      });

      expect(codons[1]).toMatchObject({
        columnStart: 3,
        columnEnd: 5,
        refAa: 'A',
        queryAa: '-',
        status: 'deleted',
      });

      expect(codons[2]).toMatchObject({
        columnStart: 6,
        columnEnd: 8,
        refAa: 'E',
        queryAa: 'E',
        status: 'match',
      });
    });

    it('should handle partial deletion (frameshift)', () => {
      const alignedRef = 'ATGGCTGAA';
      const alignedQuery = 'ATG--TGAA';
      const cds = makeCDS(1, 9, 1, 0, 9);

      const codons = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 100);

      expect(codons).toHaveLength(3);

      expect(codons[0]).toMatchObject({
        columnStart: 0,
        columnEnd: 2,
        status: 'match',
      });

      expect(codons[1]).toMatchObject({
        columnStart: 3,
        columnEnd: 5,
        status: 'frameshifted',
        queryAa: 'X',
      });

      expect(codons[2]).toMatchObject({
        columnStart: 6,
        columnEnd: 8,
        status: 'match',
      });
    });
  });

  describe('insertion handling (reference-centric)', () => {
    it('should extend codons to fill gaps from insertions at boundaries', () => {
      const alignedRef = 'ATG---GCTGAA';
      const alignedQuery = 'ATGAAAGCTGAA';
      const cds = makeCDS(1, 9, 1, 0, 12);

      const codons = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 100);

      expect(codons).toHaveLength(3);

      expect(codons[0]).toMatchObject({
        columnStart: 0,
        columnEnd: 5,
        refAa: 'M',
        queryAa: 'M',
        status: 'match',
      });

      expect(codons[1]).toMatchObject({
        columnStart: 6,
        columnEnd: 8,
        refAa: 'A',
        queryAa: 'A',
        status: 'match',
      });

      expect(codons[2]).toMatchObject({
        columnStart: 9,
        columnEnd: 11,
        refAa: 'E',
        queryAa: 'E',
        status: 'match',
      });
    });
  });

  describe('substitution handling', () => {
    it('should detect substitutions', () => {
      const alignedRef = 'ATGGCTGAA';
      const alignedQuery = 'ATGGGTGAA';
      const cds = makeCDS(1, 9, 1, 0, 9);

      const codons = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 100);

      expect(codons).toHaveLength(3);
      expect(codons[0].status).toBe('match');
      expect(codons[1].status).toBe('substitution');
      expect(codons[1].refAa).toBe('A');
      expect(codons[1].queryAa).toBe('G');
      expect(codons[2].status).toBe('match');
    });
  });

  describe('reverse strand', () => {
    it('should handle reverse strand CDS with deletion', () => {
      const alignedRef = 'TTCAGCCAT';
      const alignedQuery = 'TTC---CAT';
      const cds = makeCDS(1, 9, -1, 0, 9);

      const codons = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 100);

      expect(codons).toHaveLength(3);

      const deletedCodon = codons.find((c) => c.status === 'deleted');
      expect(deletedCodon).toBeDefined();
      expect(deletedCodon?.columnStart).toBe(3);
      expect(deletedCodon?.columnEnd).toBe(5);
    });

    it('should translate reverse strand correctly', () => {
      const alignedRef = 'TTCAGCCAT';
      const alignedQuery = 'TTCAGCCAT';
      const cds = makeCDS(1, 9, -1, 0, 9);

      const codons = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 100);

      expect(codons).toHaveLength(3);

      const sortedByCodonIdx = [...codons].sort((a, b) => a.codonIndex - b.codonIndex);
      expect(sortedByCodonIdx[0].refAa).toBe('M');
      expect(sortedByCodonIdx[1].refAa).toBe('A');
      expect(sortedByCodonIdx[2].refAa).toBe('E');
    });
  });

  describe('line visibility', () => {
    it('should only return codons visible on the line', () => {
      const alignedRef = 'ATGGCTGAA';
      const alignedQuery = 'ATGGCTGAA';
      const cds = makeCDS(1, 9, 1, 0, 9);

      const codons = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 3, 6);

      expect(codons).toHaveLength(1);
      expect(codons[0].columnStart).toBe(3);
      expect(codons[0].refAa).toBe('A');
    });
  });

  describe('row-spanning codons', () => {
    it('should only render letter on primary line (not continuation)', () => {
      const alignedRef = 'AT-GGCTGAA';
      const alignedQuery = 'ATCGGCTGAA';
      const cds = makeCDS(1, 9, 1, 0, 10);

      const codonsLine1 = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 3);
      const codonsLine2 = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 3, 10);

      const codon1OnLine1 = codonsLine1.find((c) => c.codonIndex === 0);
      const codon1OnLine2 = codonsLine2.find((c) => c.codonIndex === 0);

      expect(codon1OnLine1).toBeDefined();
      expect(codon1OnLine1!.isPartialAtStart).toBe(false);
      expect(codon1OnLine1!.renderLetter).toBe(true);

      expect(codon1OnLine2).toBeDefined();
      expect(codon1OnLine2!.isPartialAtStart).toBe(true);
      expect(codon1OnLine2!.renderLetter).toBe(false);
    });

    it('should handle codon split evenly across lines', () => {
      const alignedRef = 'AT-GGCTGAA';
      const alignedQuery = 'ATCGGCTGAA';
      const cds = makeCDS(1, 9, 1, 0, 10);

      const codonsLine1 = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 2);
      const codonsLine2 = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 2, 6);

      const codon1Line1 = codonsLine1.find((c) => c.codonIndex === 0);
      const codon1Line2 = codonsLine2.find((c) => c.codonIndex === 0);

      expect(codon1Line1).toBeDefined();
      expect(codon1Line1!.renderLetter).toBe(true);

      expect(codon1Line2).toBeDefined();
      expect(codon1Line2!.isPartialAtStart).toBe(true);
      expect(codon1Line2!.renderLetter).toBe(false);
    });

    it('should render letter on continuation row when first row had only 1 column', () => {
      const alignedRef = 'AT-GGCTGAA';
      const alignedQuery = 'ATCGGCTGAA';
      const cds = makeCDS(1, 9, 1, 0, 10);

      const codonsLine1 = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 0, 1);
      const codonsLine2 = getAlignmentCodonsForCDS(alignedRef, alignedQuery, cds, 1, 6);

      const codon1Line1 = codonsLine1.find((c) => c.codonIndex === 0);
      const codon1Line2 = codonsLine2.find((c) => c.codonIndex === 0);

      expect(codon1Line1).toBeDefined();
      expect(codon1Line1!.renderLetter).toBe(false);

      expect(codon1Line2).toBeDefined();
      expect(codon1Line2!.isPartialAtStart).toBe(true);
      expect(codon1Line2!.renderLetter).toBe(true);
    });
  });
});

describe('getCodonsForSingleCDS — non-spliced codon_start', () => {
  it('respects codon_start on forward CDS codon cells', () => {
    const seq = 'NATGGCTTAA';
    const cds: Annotation = {
      name: 'forward',
      type: 'CDS',
      start: 1,
      end: 10,
      direction: 1,
      qualifiers: { codon_start: ['2'] },
    };

    const codons = getCodonsForSingleCDS(cds, 0, seq.length, seq);

    expect(codons.map((codon) => codon.codon)).toEqual(['ATG', 'GCT', 'TAA']);
    expect(codons.map((codon) => codon.startPos)).toEqual([1, 4, 7]);
  });

  it('respects codon_start on reverse CDS codon cells', () => {
    const seq = 'TTAAGCCATN';
    const cds: Annotation = {
      name: 'reverse',
      type: 'CDS',
      start: 1,
      end: 10,
      direction: -1,
      qualifiers: { codon_start: ['2'] },
    };

    const codons = getCodonsForSingleCDS(cds, 0, seq.length, seq);

    expect(codons.map((codon) => codon.codon)).toEqual(['ATG', 'GCT', 'TAA']);
    expect(codons.map((codon) => codon.startPos)).toEqual([6, 3, 0]);
  });
});

describe.each([1, -1] as const)('ordinary row clipping on strand %i', (direction) => {
  it.each(['1', '2', '3'])('preserves every clipped codon with codon_start=%s', (codonStart) => {
    const sequence = 'NNATGAAATGATTTCCCGGGTGANNN';
    const cds: Annotation = {
      name: 'clipped translation',
      type: 'CDS',
      start: 3,
      end: 23,
      direction,
      qualifiers: { codon_start: [codonStart], transl_except: ['(pos:9..11,aa:Sec)'] },
    };
    for (const code of [1, 4]) {
      const complete = getCodonsForSingleCDS(cds, 0, sequence.length, sequence, code);
      for (let start = 0; start < sequence.length; start++) {
        for (let end = start + 1; end <= sequence.length; end++) {
          const expected = complete
            .filter((codon) => codon.startPos < end && codon.endPos >= start)
            .map((codon) => {
              const visibleStart = Math.max(start, codon.startPos);
              const visibleEnd = Math.min(end - 1, codon.endPos);
              return {
                ...codon,
                visibleStart,
                visibleEnd,
                renderLetter: visibleEnd - visibleStart + 1 >= 2,
              };
            });
          expect(getCodonsForSingleCDS(cds, start, end, sequence, code)).toEqual(expected);
        }
      }
    }
  });
});

it.each([1, -1] as const)(
  'keeps repeated triplets distinct from positional exceptions on strand %i',
  (direction) => {
    const coding = 'TGATGATGATGATGATGATGATGATGA';
    const sequence = direction === 1 ? coding : reverseComplement(coding);
    const cds: Annotation = {
      name: 'positional readings',
      type: 'CDS',
      start: 1,
      end: sequence.length,
      direction,
      qualifiers: {
        transl_except: ['invalid', '(pos:10..12,aa:Sec)', '(pos:19..21,aa:OTHER)'],
        note: ['p-azido-L-phenylalanine (pAzF)'],
      },
    };
    const read = (bases = sequence, code = 1) =>
      getCodonsForSingleCDS(cds, 0, bases.length, bases, code);
    const ordinary = ['*', '*', '*', 'U', '*', '*', 'X', '*', '*'];
    expect(read().map((codon) => codon.aa)).toEqual(
      direction === 1 ? ordinary : [...ordinary].reverse()
    );
    const exception = read().find((codon) => codon.startPos === 18);
    expect(exception?.display).toMatchObject({
      kind: 'residue',
      fromException: true,
      alsoTerminates: true,
    });
    expect(read(sequence, 4).map((codon) => codon.aa)).toEqual(Array(9).fill('W'));
    const edited = sequence.slice(0, 9) + (direction === 1 ? 'AAA' : 'TTT') + sequence.slice(12);
    expect(read(edited).find((codon) => codon.startPos === 9)?.aa).toBe('K');
    cds.qualifiers = {};
    expect(read().map((codon) => codon.aa)).toEqual(Array(9).fill('*'));
  }
);

describe.each([1, -1] as const)('ordinary row clipping on strand %i', (direction) => {
  it.each(['1', '2', '3'])('preserves every clipped codon with codon_start=%s', (codonStart) => {
    const sequence = 'NNATGAAATGATTTCCCGGGTGANNN';
    const cds: Annotation = {
      name: 'clipped translation',
      type: 'CDS',
      start: 3,
      end: 23,
      direction,
      qualifiers: { codon_start: [codonStart], transl_except: ['(pos:9..11,aa:Sec)'] },
    };
    for (const code of [1, 4]) {
      const complete = getCodonsForSingleCDS(cds, 0, sequence.length, sequence, code);
      for (let start = 0; start < sequence.length; start++) {
        for (let end = start + 1; end <= sequence.length; end++) {
          const expected = complete
            .filter((codon) => codon.startPos < end && codon.endPos >= start)
            .map((codon) => {
              const visibleStart = Math.max(start, codon.startPos);
              const visibleEnd = Math.min(end - 1, codon.endPos);
              return {
                ...codon,
                visibleStart,
                visibleEnd,
                renderLetter: visibleEnd - visibleStart + 1 >= 2,
              };
            });
          expect(getCodonsForSingleCDS(cds, start, end, sequence, code)).toEqual(expected);
        }
      }
    }
  });
});

it.each([1, -1] as const)(
  'keeps repeated triplets distinct from positional exceptions on strand %i',
  (direction) => {
    const coding = 'TGATGATGATGATGATGATGATGATGA';
    const sequence = direction === 1 ? coding : reverseComplement(coding);
    const cds: Annotation = {
      name: 'positional readings',
      type: 'CDS',
      start: 1,
      end: sequence.length,
      direction,
      qualifiers: {
        transl_except: ['invalid', '(pos:10..12,aa:Sec)', '(pos:19..21,aa:OTHER)'],
        note: ['p-azido-L-phenylalanine (pAzF)'],
      },
    };
    const read = (bases = sequence, code = 1) =>
      getCodonsForSingleCDS(cds, 0, bases.length, bases, code);
    const ordinary = ['*', '*', '*', 'U', '*', '*', 'X', '*', '*'];
    expect(read().map((codon) => codon.aa)).toEqual(
      direction === 1 ? ordinary : [...ordinary].reverse()
    );
    const exception = read().find((codon) => codon.startPos === 18);
    expect(exception?.display).toMatchObject({
      kind: 'residue',
      fromException: true,
      alsoTerminates: true,
    });
    expect(read(sequence, 4).map((codon) => codon.aa)).toEqual(Array(9).fill('W'));
    const edited = sequence.slice(0, 9) + (direction === 1 ? 'AAA' : 'TTT') + sequence.slice(12);
    expect(read(edited).find((codon) => codon.startPos === 9)?.aa).toBe('K');
    cds.qualifiers = {};
    expect(read().map((codon) => codon.aa)).toEqual(Array(9).fill('*'));
  }
);

describe('getCodonsForSingleCDS — spliced CDS', () => {
  it('maps codons to correct genomic positions for spliced forward CDS', () => {
    const seq = 'ATGGCT' + 'nnn' + 'GAAAAA';
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 15,
      direction: 1,
      segments: [
        { start: 1, end: 6 },
        { start: 10, end: 15 },
      ],
      qualifiers: { _locationString: ['join(1..6,10..15)'] },
    };

    const codons = getCodonsForSingleCDS(cds, 0, 15, seq);

    expect(codons).toHaveLength(4);
    expect(codons[0].codon).toBe('ATG');
    expect(codons[0].aa).toBe('M');
    expect(codons[0].startPos).toBe(0);
    expect(codons[0].endPos).toBe(2);

    expect(codons[1].codon).toBe('GCT');
    expect(codons[1].startPos).toBe(3);

    expect(codons[2].codon).toBe('GAA');
    expect(codons[2].startPos).toBe(9);

    expect(codons[3].codon).toBe('AAA');
    expect(codons[3].startPos).toBe(12);
  });

  it('includes residueIndex on each codon (1-indexed protein position)', () => {
    const seq = 'ATGGCT' + 'nnn' + 'GAATAA';
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 15,
      direction: 1,
      segments: [
        { start: 1, end: 6 },
        { start: 10, end: 15 },
      ],
      qualifiers: { _locationString: ['join(1..6,10..15)'] },
    };

    const codons = getCodonsForSingleCDS(cds, 0, 15, seq);

    expect(codons[0].residueIndex).toBe(1);
    expect(codons[1].residueIndex).toBe(2);
    expect(codons[2].residueIndex).toBe(3);
    expect(codons[3].residueIndex).toBe(4);
  });

  it('sets partial flags for phase 1 intron-split codon', () => {
    const seq = 'ATGGCTA' + 'nnn' + 'GAAACC';
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 16,
      direction: 1,
      segments: [
        { start: 1, end: 7 },
        { start: 11, end: 16 },
      ],
      qualifiers: { _locationString: ['join(1..7,11..16)'] },
    };

    const codons = getCodonsForSingleCDS(cds, 0, 16, seq);

    const preIntron = codons.find((c) => c.isPartialPreIntron);
    const postIntron = codons.find((c) => c.isPartialPostIntron);

    expect(preIntron).toBeDefined();
    expect(postIntron).toBeDefined();
    expect(preIntron!.startPos).toBe(6);
    expect(preIntron!.endPos).toBe(6);
    expect(postIntron!.startPos).toBe(10);
    expect(postIntron!.endPos).toBe(11);
    expect(preIntron!.aa).toBe(postIntron!.aa);
    expect(preIntron!.residueIndex).toBe(postIntron!.residueIndex);
    expect(preIntron!.renderLetter).toBe(false);
    expect(postIntron!.renderLetter).toBe(true);
  });

  it('sets no partial flags for phase 0 (clean boundaries)', () => {
    const seq = 'ATGGCTGAA' + 'nnn' + 'AAACCCTTT';
    const cds: Annotation = {
      name: 'test',
      type: 'CDS',
      start: 1,
      end: 21,
      direction: 1,
      segments: [
        { start: 1, end: 9 },
        { start: 13, end: 21 },
      ],
      qualifiers: { _locationString: ['join(1..9,13..21)'] },
    };

    const codons = getCodonsForSingleCDS(cds, 0, 21, seq);

    const partials = codons.filter((c) => c.isPartialPreIntron || c.isPartialPostIntron);
    expect(partials).toHaveLength(0);
    expect(codons).toHaveLength(6);
  });
});

describe('codons under a custom genetic code', () => {
  it('carries what to draw, so a non-standard residue is named rather than shown as X', () => {
    const built = buildCustomGeneticCode({
      id: 'gc-3f2a9c1e',
      revision: 1,
      name: 'Amber suppression (pAzF at TAG)',
      base: 11,
      changes: { TAG: { kind: 'residue', residue: 'pAzF' }, TCG: { kind: 'unassigned' } },
      residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
    });
    if (!built.ok) throw new Error('fixture must build');

    const sequence = 'ATGTAGTCGTAA';
    const cds = { name: 'amber', type: 'CDS', start: 1, end: 12, direction: 1 as const };
    const codons = getCodonsForSingleCDS(cds, 0, sequence.length, sequence, built.definition);

    expect(codons.map((codon) => codon.aa)).toEqual(['M', 'X', 'X', '*']);
    expect(codons.map((codon) => codon.display?.full)).toEqual(['M', 'pAzF', '?', '*']);
    expect(codons[1].display?.kind).toBe('residue');
    expect(codons[2].display?.kind).toBe('unassigned');
  });
});

describe.each([
  { name: 'contiguous', sequence: 'TGATGATGA', segments: undefined },
  {
    name: 'spliced',
    sequence: 'TGATGACCCTGA',
    segments: [
      { start: 1, end: 6 },
      { start: 10, end: 12 },
    ],
  },
])('display readings for a $name CDS', ({ sequence, segments }) => {
  it('keeps repeated codons position-specific and reflects subsequent base/code edits', () => {
    const cds: Annotation = {
      name: 'selenoprotein',
      type: 'CDS',
      start: 1,
      end: sequence.length,
      direction: 1,
      segments,
      qualifiers: { transl_except: ['(pos:4..6,aa:Sec)'] },
    };
    const letters = (bases: string, code = 1) =>
      getCodonsForSingleCDS(cds, 0, bases.length, bases, code).map((codon) => codon.aa);
    expect(letters(sequence)).toEqual(['*', 'U', '*']);
    expect(letters(sequence.slice(0, 3) + 'AAA' + sequence.slice(6))).toEqual(['*', 'K', '*']);
    expect(letters(sequence, 4)).toEqual(['W', 'W', 'W']);
    cds.qualifiers = {};
    expect(letters(sequence)).toEqual(['*', '*', '*']);
    expect(letters(sequence, 4)).toEqual(['W', 'W', 'W']);
  });
});

it.each([1, -1] as const)(
  'clips both row edges without changing residue order on strand %i',
  (direction) => {
    const sequence = 'ATGAAATTTCCCTGA';
    const cds: Annotation = { name: 'clipped', type: 'CDS', start: 1, end: 15, direction };
    const codons = getCodonsForSingleCDS(cds, 1, 8, sequence);
    expect(
      codons.map((codon) => [codon.visibleStart, codon.visibleEnd, codon.residueIndex])
    ).toEqual(
      direction === 1
        ? [
            [1, 2, 1],
            [3, 5, 2],
            [6, 7, 3],
          ]
        : [
            [6, 7, 3],
            [3, 5, 4],
            [1, 2, 5],
          ]
    );
    expect(codons.every((codon) => codon.renderLetter)).toBe(true);
  }
);

describe.each([1, -1] as const)('ordinary row clipping on strand %i', (direction) => {
  it.each(['1', '2', '3'])(
    'preserves molecule-edge codons and partial tails with codon_start=%s',
    (codonStart) => {
      const offset = Number(codonStart) - 1;
      for (const trailingBases of [0, 1, 2]) {
        const forward = 'A'.repeat(offset) + 'ATGTGAAAA' + 'N'.repeat(trailingBases);
        const sequence = direction === 1 ? forward : reverseComplement(forward);
        const cds: Annotation = {
          name: 'molecule-edge',
          type: 'CDS',
          start: 1,
          end: sequence.length,
          direction,
          qualifiers: { codon_start: [codonStart] },
        };
        const codons = getCodonsForSingleCDS(cds, 0, sequence.length, sequence);
        expect(codons.map(({ codon, aa, residueIndex }) => [codon, aa, residueIndex])).toEqual([
          ['ATG', 'M', 1],
          ['TGA', '*', 2],
          ['AAA', 'K', 3],
        ]);
        expect(codons.map(({ startPos, endPos }) => [startPos, endPos])).toEqual(
          direction === 1
            ? [
                [offset, offset + 2],
                [offset + 3, offset + 5],
                [offset + 6, offset + 8],
              ]
            : [
                [trailingBases + 6, trailingBases + 8],
                [trailingBases + 3, trailingBases + 5],
                [trailingBases, trailingBases + 2],
              ]
        );

        expect(getCodonsForSingleCDS(cds, 0, sequence.length + 1, sequence)).toEqual(codons);
      }
    }
  );

  it.each(['1', '2', '3'])('matches whole-CDS readings with codon_start=%s', (codonStart) => {
    const sequence = 'CCCATGAAATGATTTCCCGGGTAAACCCGGG';
    const cds: Annotation = {
      name: 'partial-frame',
      type: 'CDS',
      start: 4,
      end: 26,
      direction,
      qualifiers: { codon_start: [codonStart] },
    };
    const wholeCds = getCodonsForSingleCDS(cds, 0, sequence.length, sequence);

    for (let rowStart = 0; rowStart < sequence.length; rowStart++) {
      for (let rowEnd = rowStart + 1; rowEnd <= sequence.length; rowEnd++) {
        const expected = wholeCds
          .filter((codon) => codon.endPos >= rowStart && codon.startPos < rowEnd)
          .map((codon) => {
            const visibleStart = Math.max(codon.startPos, rowStart);
            const visibleEnd = Math.min(codon.endPos, rowEnd - 1);
            return {
              ...codon,
              visibleStart,
              visibleEnd,
              renderLetter: visibleEnd - visibleStart + 1 >= 2,
            };
          });
        expect(
          getCodonsForSingleCDS(cds, rowStart, rowEnd, sequence),
          `row [${rowStart}, ${rowEnd})`
        ).toEqual(expected);
      }
    }
  });
});

describe('a codon exception survives an uncommitted edit', () => {
  const amberReporter = (end: number): Annotation => ({
    name: 'reporter',
    type: 'CDS',
    start: 1,
    end,
    direction: 1,
    color: '',
    qualifiers: {
      transl_table: ['11'],
      transl_except: ['(pos:7..9,aa:OTHER)'],
      note: ['p-azido-L-phenylalanine (pAzF)'],
    },
  });

  it('reads the flagged codon before anything is typed', () => {
    const { draftCodons } = getDraftCodonsForCDS(amberReporter(12), 'ATGAAATAGAAA', [], [], 0, 12);
    expect(draftCodons.map((codon) => codon.aa)).toEqual(['M', 'K', 'X', 'K']);
  });

  it('still reads it after an insertion has moved it three bases along', () => {
    const { draftCodons } = getDraftCodonsForCDS(
      amberReporter(15),
      'ATGGGGAAATAGAAA',
      [{ start: 3, end: 6 }],
      [],
      0,
      15
    );
    expect(draftCodons.map((codon) => codon.aa)).toEqual(['M', 'G', 'K', 'X', 'K']);
  });

  it('does not put the residue on a codon made of bases you just typed', () => {
    const { draftCodons } = getDraftCodonsForCDS(
      amberReporter(15),
      'ATGTAGAAATAGAAA',
      [{ start: 3, end: 6 }],
      [],
      0,
      15
    );
    expect(draftCodons[1].aa).toBe('*');
    expect(draftCodons[3].aa).toBe('X');
  });
});
