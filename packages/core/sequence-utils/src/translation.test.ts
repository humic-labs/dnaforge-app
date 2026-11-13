import { describe, it, expect } from 'vitest';
import {
  cdsToProtein,
  isStartCodon,
  isStopCodon,
  translateCodon,
  translationInternals,
} from './translation';
import { isStartCodonForGeneticCode, isStopCodonForGeneticCode } from './start-codons';

describe('codon predicates read RNA codons ', () => {
  it('recognizes AUG starts and U stops like their DNA spellings', () => {
    expect(isStartCodon('AUG')).toBe(true);
    expect(isStartCodon('aug')).toBe(true);
    expect(isStopCodon('UAA')).toBe(true);
    expect(isStopCodon('uga')).toBe(true);
    expect(isStartCodonForGeneticCode('GUG', 11)).toBe(true);
    expect(isStopCodonForGeneticCode('UAG')).toBe(true);
    expect(isStartCodon('AUC')).toBe(false);
    expect(isStopCodon('UGG')).toBe(false);
  });
});

describe('translateCodon — degenerate codons ', () => {
  it('resolves fourfold-degenerate families where N does not matter', () => {
    expect(translateCodon('CGN')).toBe('R');
    expect(translateCodon('GGN')).toBe('G');
    expect(translateCodon('CTN')).toBe('L');
    expect(translateCodon('TCN')).toBe('S');
    expect(translateCodon('ACN')).toBe('T');
    expect(translateCodon('GCN')).toBe('A');
    expect(translateCodon('GTN')).toBe('V');
    expect(translateCodon('CCN')).toBe('P');
  });

  it('resolves twofold-degenerate codons via the right ambiguity code', () => {
    expect(translateCodon('TTY')).toBe('F');
    expect(translateCodon('AAR')).toBe('K');
    expect(translateCodon('CAY')).toBe('H');
    expect(translateCodon('GAY')).toBe('D');
  });

  it('resolves degenerate codons that span synonymous families', () => {
    expect(translateCodon('YTR')).toBe('L');
    expect(translateCodon('MGR')).toBe('R');
    expect(translateCodon('TAR')).toBe('*');
  });

  it('returns X when the codon genuinely spans several amino acids', () => {
    expect(translateCodon('NNK')).toBe('X');
    expect(translateCodon('NNN')).toBe('X');
    expect(translateCodon('ATN')).toBe('X');
  });

  it('still translates unambiguous codons unchanged', () => {
    expect(translateCodon('ATG')).toBe('M');
    expect(translateCodon('TAA')).toBe('*');
    expect(translateCodon('atg')).toBe('M');
  });

  it('returns X for malformed codons rather than guessing', () => {
    expect(translateCodon('AT')).toBe('X');
    expect(translateCodon('A-G')).toBe('X');
    expect(translateCodon('')).toBe('X');
  });

  it('does not grow its cache from arbitrary caller input', () => {
    const { DEGENERATE_CODON_CACHE_SIZE_FOR_TEST } = translationInternals;
    const before = DEGENERATE_CODON_CACHE_SIZE_FOR_TEST();
    for (let i = 0; i < 5000; i++) translateCodon(`zz${i}`);
    expect(DEGENERATE_CODON_CACHE_SIZE_FOR_TEST()).toBe(before);

    translateCodon('DBH');
    expect(DEGENERATE_CODON_CACHE_SIZE_FOR_TEST()).toBe(before + 1);
    expect(DEGENERATE_CODON_CACHE_SIZE_FOR_TEST()).toBeLessThanOrEqual(16 ** 3);
  });
});

describe('cdsToProtein', () => {
  it('translates a forward-strand CDS to single-letter protein, dropping trailing stop', () => {
    const seq = 'ATGGCTTAA';
    expect(cdsToProtein(1, 9, 1, seq)).toBe('MA');
  });

  it('translates a reverse-strand CDS by reverse-complementing first', () => {
    const seq = 'ATGGCTTAA';
    expect(cdsToProtein(1, 9, -1, seq)).toBe('LSH');
  });

  it('handles partial trailing codon by ignoring it (no junk amino acid emitted)', () => {
    expect(cdsToProtein(1, 5, 1, 'ATGGC')).toBe('M');
  });

  it('returns null for too-short input', () => {
    expect(cdsToProtein(1, 2, 1, 'AT')).toBeNull();
  });

  it('handles origin-spanning circular CDS via sequenceLength wrap', () => {
    const seq = 'GCTAAAAAAATG';
    expect(cdsToProtein(10, 3, 1, seq, seq.length)).toBe('MA');
  });

  it('returns null for malformed linear wrap (start > end without sequenceLength)', () => {
    expect(cdsToProtein(10, 3, 1, 'GCTAAAAAAATG')).toBeNull();
  });

  it('drops trailing stop only — internal stops are emitted (caller can detect)', () => {
    const seq = 'ATGTAAGCTTAA';
    expect(cdsToProtein(1, 12, 1, seq, undefined)).toBe('M*A');
  });

  it('returns the same protein as a full-record translation roundtrip', () => {
    expect(cdsToProtein(1, 12, 1, 'ATGGCTGAATAA', undefined)).toBe('MAE');
  });
});
