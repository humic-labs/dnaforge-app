import { describe, it, expect } from 'vitest';
import {
  estimateNucleotideSearchMatchCount,
  expandIUPACToRegex,
  searchNucleotide,
  searchAnnotationsAndProtein,
  SearchTooBroadError,
} from './sequence-search';
import { searchAnnotations } from './annotation-search';
import type { Annotation } from './types';

function makeAnnotation(
  overrides: Partial<Annotation> & { name: string; start: number; end: number }
): Annotation {
  return {
    type: 'gene',
    direction: 1 as const,
    ...overrides,
  };
}

function makeCDS(name: string, start: number, end: number, direction: 1 | -1 = 1): Annotation {
  return {
    name,
    type: 'CDS',
    start,
    end,
    direction,
  };
}

describe('searchAnnotations', () => {
  const annotations: Annotation[] = [
    makeAnnotation({ name: 'GFP', start: 10, end: 60, type: 'CDS' }),
    makeAnnotation({
      name: 'Promoter',
      start: 5,
      end: 25,
      type: 'misc_feature',
      qualifiers: { note: ['T7 promoter region'] },
    }),
    makeAnnotation({ name: 'KanR', start: 70, end: 110, type: 'CDS', direction: -1 }),
  ];

  it('matches annotation name (case-insensitive)', () => {
    expect(searchAnnotations(annotations, 'gfp')).toHaveLength(1);
    expect(searchAnnotations(annotations, 'GFP')[0].name).toBe('GFP');
  });

  it('matches qualifier value', () => {
    const results = searchAnnotations(annotations, 'T7');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Promoter');
  });

  it('returns empty for no match', () => {
    expect(searchAnnotations(annotations, 'ZZZZZ')).toHaveLength(0);
  });

  it('returns empty for empty query', () => {
    expect(searchAnnotations(annotations, '')).toHaveLength(0);
  });

  it('matches partial name', () => {
    expect(searchAnnotations(annotations, 'Kan')).toHaveLength(1);
  });
});

describe('expandIUPACToRegex', () => {
  it('expands literal bases', () => {
    const re = expandIUPACToRegex('ATGC');
    expect(re.source).toBe('ATGC');
  });

  it('expands single ambiguity code R=[AG]', () => {
    const re = expandIUPACToRegex('R');
    expect(re.source).toBe('[AG]');
  });

  it('expands mixed query ATGWSC', () => {
    const re = expandIUPACToRegex('ATGWSC');
    for (const w of 'AT') {
      for (const s of 'CG') {
        expect(`ATG${w}${s}C`).toMatch(re);
      }
    }
    expect('ATGGAC').not.toMatch(re);
    expect('ATGAAC').not.toMatch(re);
  });

  it('is case-insensitive', () => {
    const re = expandIUPACToRegex('atg');
    expect('ATG').toMatch(re);
    expect('atg').toMatch(re);
  });

  it('expands N to [ACGT]', () => {
    const re = expandIUPACToRegex('N');
    expect('A').toMatch(re);
    expect('C').toMatch(re);
    expect('G').toMatch(re);
    expect('T').toMatch(re);
  });

  it('throws on empty query', () => {
    expect(() => expandIUPACToRegex('')).toThrow('Empty query');
  });

  it('throws on non-IUPAC characters', () => {
    expect(() => expandIUPACToRegex('A.G')).toThrow('Invalid character');
    expect(() => expandIUPACToRegex('ATG[[')).toThrow('Invalid character');
    expect(() => expandIUPACToRegex('123')).toThrow('Invalid character');
  });
});

describe('searchNucleotide', () => {
  const sequence = 'ATCGATCGATATGAGCAAGGGCGAGGAGCTGTTCACCGGGGTGGTGCCCATCCTGGTCGAGCTGGACGGC';

  it('finds a single match', () => {
    const matches = searchNucleotide(sequence, 'ATGAGC');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const m = matches.find((m) => m.start === 10);
    expect(m).toBeDefined();
    expect(m!.end).toBe(15);
    expect(m!.strand).toBe('forward');
    expect(m!.type).toBe('nucleotide');
  });

  it('finds multiple matches', () => {
    const matches = searchNucleotide(sequence, 'ATG');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for no match', () => {
    const matches = searchNucleotide(sequence, 'ZZZZZZZ');
    expect(matches).toHaveLength(0);
  });

  it('returns empty for empty query', () => {
    expect(searchNucleotide(sequence, '')).toHaveLength(0);
  });

  it('returns empty for empty sequence', () => {
    expect(searchNucleotide('', 'ATG')).toHaveLength(0);
  });

  it('searches reverse complement strand', () => {
    const matches = searchNucleotide(sequence, 'GCTCAT', { reverseComplement: true });
    const revMatch = matches.find((m) => m.strand === 'reverse');
    expect(revMatch).toBeDefined();
  });

  it('handles IUPAC ambiguity codes', () => {
    const matches = searchNucleotide(sequence, 'ATGWSC');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].start).toBe(10);
  });

  it('handles circular origin-spanning matches', () => {
    const circular = 'GCATGC';
    const matches = searchNucleotide(circular, 'GCGC', { circular: true });
    const wrapping = matches.find((m) => m.wraps);
    expect(wrapping).toBeDefined();
  });

  it('does not return origin-spanning for non-circular', () => {
    const seq = 'GCATGC';
    const matches = searchNucleotide(seq, 'GCGC', { circular: false });
    expect(matches).toHaveLength(0);
  });

  it('rejects 1-character query (minimum length is 2)', () => {
    const matches = searchNucleotide('AAACCC', 'A');
    expect(matches).toHaveLength(0);
  });

  it('handles query longer than sequence', () => {
    const matches = searchNucleotide('ATG', 'ATGATGATG');
    expect(matches).toHaveLength(0);
  });

  it('estimates broad IUPAC DNA searches before scanning genome-scale sequences', () => {
    const estimated = estimateNucleotideSearchMatchCount(4_641_652, 'ARSC', {
      circular: true,
      reverseComplement: true,
    });

    expect(estimated).toBeGreaterThan(100_000);
  });

  it('throws SearchTooBroadError instead of returning unrenderable match sets', () => {
    expect(() => searchNucleotide('A'.repeat(100), 'AA', { maxMatches: 10 })).toThrow(
      SearchTooBroadError
    );
  });
});

describe('searchNucleotide ground-truth comparison', () => {
  function slidingWindowMatches(seq: string, query: string): Set<string> {
    const positions = new Set<string>();
    const s = seq.toUpperCase();
    const q = query.toUpperCase();
    for (let i = 0; i <= s.length - q.length; i++) {
      if (s.slice(i, i + q.length) === q) {
        positions.add(`${i}-${i + q.length - 1}`);
      }
    }
    return positions;
  }

  function gtReverseComplement(seq: string): string {
    const comp: Record<string, string> = {
      A: 'T',
      T: 'A',
      G: 'C',
      C: 'G',
      a: 't',
      t: 'a',
      g: 'c',
      c: 'g',
    };
    return seq
      .split('')
      .reverse()
      .map((b) => comp[b] ?? b)
      .join('');
  }

  function expectedMatchCount(seq: string, query: string): number {
    const seqLen = seq.length;

    const fwdPositions = slidingWindowMatches(seq, query);

    const revSeq = gtReverseComplement(seq);
    const revPositionsInRevSpace = slidingWindowMatches(revSeq, query);

    const revPositionsOnFwd = new Set<string>();
    for (const pos of revPositionsInRevSpace) {
      const [revStart, revEnd] = pos.split('-').map(Number);
      const fwdStart = seqLen - 1 - revEnd;
      const fwdEnd = seqLen - 1 - revStart;
      revPositionsOnFwd.add(`${fwdStart}-${fwdEnd}`);
    }

    const allPositions = new Set(fwdPositions);
    for (const pos of revPositionsOnFwd) {
      if (!fwdPositions.has(pos)) {
        allPositions.add(pos);
      }
    }

    return allPositions.size;
  }

  const sequence = 'ATCGATCGATATGAGCAAGGGCGAGGAGCTGTTCACCGGGGTGGTGCCCATCCTGGTCGAGCTGGACGGC';

  const queries = ['ATG', 'ATGAGC', 'GC', 'ATCG', 'GAG', 'GGG', 'CTG', 'CC', 'GCTCAT', 'CGATCG'];

  for (const query of queries) {
    it(`matches ground truth for "${query}" (forward only)`, () => {
      const matches = searchNucleotide(sequence, query, { reverseComplement: false });
      const fwdExpected = slidingWindowMatches(sequence, query);
      expect(matches).toHaveLength(fwdExpected.size);

      for (const m of matches) {
        expect(fwdExpected.has(`${m.start}-${m.end}`)).toBe(true);
      }
    });

    it(`matches ground truth for "${query}" (both strands)`, () => {
      const matches = searchNucleotide(sequence, query, { reverseComplement: true });
      const expected = expectedMatchCount(sequence, query);
      expect(matches).toHaveLength(expected);
    });
  }

  const longSeq = 'ATGATGATGATGATGATGATGATGATGATGATGATGATGATG';

  it('matches ground truth for "ATG" in repetitive sequence (forward only)', () => {
    const matches = searchNucleotide(longSeq, 'ATG', { reverseComplement: false });
    const expected = slidingWindowMatches(longSeq, 'ATG');
    expect(matches).toHaveLength(expected.size);
  });

  it('matches ground truth for "ATG" in repetitive sequence (both strands)', () => {
    const matches = searchNucleotide(longSeq, 'ATG', { reverseComplement: true });
    const expected = expectedMatchCount(longSeq, 'ATG');
    expect(matches).toHaveLength(expected);
  });

  const palindromeSeq = 'AAAAAGATCTAAAAA';
  it('handles palindromic sequence without double-counting', () => {
    const matches = searchNucleotide(palindromeSeq, 'AGATCT', { reverseComplement: true });
    const expected = expectedMatchCount(palindromeSeq, 'AGATCT');
    expect(expected).toBe(1);
    expect(matches).toHaveLength(1);
  });
});

describe('searchAnnotationsAndProtein', () => {
  const sequence = 'ATGAGCAAGGGCGAGGAGCTG';
  const annotations: Annotation[] = [
    makeCDS('GFP', 1, 21, 1),
    makeAnnotation({
      name: 'Promoter',
      start: 1,
      end: 10,
      type: 'misc_feature',
      qualifiers: { note: ['T7 promoter'] },
    }),
  ];

  it('finds CDS annotation by name with fallback to full region', () => {
    const matches = searchAnnotationsAndProtein(annotations, sequence, 'GFP');
    const annMatch = matches.find((m) => m.type === 'annotation');
    expect(annMatch).toBeDefined();
    expect(annMatch!.label).toBe('GFP');
    expect(annMatch!.start).toBe(0);
    expect(annMatch!.end).toBe(20);
    expect(annMatch!.annotation).toEqual({
      type: 'CDS',
      name: 'GFP',
      start: 1,
      end: 21,
      direction: 1,
    });
  });

  it('finds protein subsequence and highlights only matching codons', () => {
    const matches = searchAnnotationsAndProtein(annotations, sequence, 'MSK');
    const protMatch = matches.find((m) => m.type === 'protein');
    expect(protMatch).toBeDefined();
    expect(protMatch!.strand).toBe('forward');
    expect(protMatch!.label).toBe('GFP');
    expect(protMatch!.start).toBe(0);
    expect(protMatch!.end).toBe(8);
    expect(protMatch!.annotation).toEqual({
      type: 'CDS',
      name: 'GFP',
      start: 1,
      end: 21,
      direction: 1,
    });
  });

  it('finds non-CDS annotation by qualifier with full region highlight', () => {
    const matches = searchAnnotationsAndProtein(annotations, sequence, 'T7');
    const annMatch = matches.find((m) => m.type === 'annotation');
    expect(annMatch).toBeDefined();
    expect(annMatch!.label).toBe('Promoter');
    expect(annMatch!.start).toBe(0);
    expect(annMatch!.end).toBe(9);
    expect(annMatch!.annotation).toEqual({
      type: 'misc_feature',
      name: 'Promoter',
      start: 1,
      end: 10,
      direction: 1,
    });
  });

  it('returns empty for no match', () => {
    const matches = searchAnnotationsAndProtein(annotations, sequence, 'ZZZZZ');
    expect(matches).toHaveLength(0);
  });

  it('returns empty for empty query', () => {
    expect(searchAnnotationsAndProtein(annotations, sequence, '')).toHaveLength(0);
  });

  it('returns empty for no annotations', () => {
    expect(searchAnnotationsAndProtein([], sequence, 'ATG')).toHaveLength(0);
  });

  it('reverse strand CDS highlights correct nucleotide positions', () => {
    const revSeq = 'AAAAAAAAA' + 'CATGCTCAT' + 'AAAAAAAAA';
    const revAnnotations: Annotation[] = [makeCDS('RevGene', 10, 18, -1)];
    const matches = searchAnnotationsAndProtein(revAnnotations, revSeq, 'MS');
    const protMatch = matches.find((m) => m.type === 'protein');
    expect(protMatch).toBeDefined();
    expect(protMatch!.strand).toBe('reverse');
    expect(protMatch!.start).toBe(12);
    expect(protMatch!.end).toBe(17);
  });

  it('CDS name match does not produce full-region highlight when protein match exists', () => {
    const specialAnnotations: Annotation[] = [makeCDS('MSK', 1, 21, 1)];
    const matches = searchAnnotationsAndProtein(specialAnnotations, sequence, 'MSK');
    const protMatches = matches.filter((m) => m.type === 'protein');
    const annMatches = matches.filter((m) => m.type === 'annotation');
    expect(protMatches.length).toBeGreaterThan(0);
    expect(annMatches).toHaveLength(0);
    expect(protMatches[0].start).toBe(0);
    expect(protMatches[0].end).toBe(8);
  });
});
