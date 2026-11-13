// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { calculateTmNN, calculateTmWallace, calculateGcContent, estimateTm } from './tm-calculator';

describe('calculateGcContent', () => {
  it('calculates 50% for equal ATGC', () => {
    expect(calculateGcContent('ATGC')).toBe(50);
  });

  it('calculates 100% for all GC', () => {
    expect(calculateGcContent('GGCC')).toBe(100);
  });

  it('calculates 0% for all AT', () => {
    expect(calculateGcContent('AATT')).toBe(0);
  });

  it('handles lowercase', () => {
    expect(calculateGcContent('atgc')).toBe(50);
  });

  it('returns 0 for empty string', () => {
    expect(calculateGcContent('')).toBe(0);
  });

  it('calculates correct percentage for typical primer', () => {
    expect(calculateGcContent('ATGCGATCGATCGATCGATC')).toBe(50);
  });
});

describe('calculateTmWallace', () => {
  it('calculates Tm for short oligo using Wallace rule', () => {
    expect(calculateTmWallace('ATGC')).toBe(12);
  });

  it('calculates Tm for GC-rich sequence', () => {
    expect(calculateTmWallace('GCGCGCGCGCGC')).toBe(48);
  });

  it('calculates Tm for AT-rich sequence', () => {
    expect(calculateTmWallace('ATATAT')).toBe(12);
  });
});

describe('calculateTmNN', () => {
  it('calculates reasonable Tm for 20bp primer', () => {
    const seq = 'ATGCGATCGATCGATCGATC';
    const tm = calculateTmNN(seq);
    expect(tm).toBeGreaterThan(50);
    expect(tm).toBeLessThan(70);
  });

  it('calculates higher Tm for GC-rich primer', () => {
    const gcRich = 'GCGCGCGCGCGCGCGCGCGC';
    const balanced = 'ATGCGATCGATCGATCGATC';

    const tmGcRich = calculateTmNN(gcRich);
    const tmBalanced = calculateTmNN(balanced);

    expect(tmGcRich).toBeGreaterThan(tmBalanced);
  });

  it('calculates lower Tm for AT-rich primer', () => {
    const atRich = 'ATATATATATATATATATAT';
    const balanced = 'ATGCGATCGATCGATCGATC';

    const tmAtRich = calculateTmNN(atRich);
    const tmBalanced = calculateTmNN(balanced);

    expect(tmAtRich).toBeLessThan(tmBalanced);
  });

  it('returns a number for sequences shorter than 2bp (though unreliable)', () => {
    expect(typeof calculateTmNN('A')).toBe('number');
    expect(typeof calculateTmNN('')).toBe('number');
  });

  it('handles lowercase sequences', () => {
    const upper = calculateTmNN('ATGCGATCGATCGATCGATC');
    const lower = calculateTmNN('atgcgatcgatcgatcgatc');
    expect(upper).toBeGreaterThan(30);
    expect(upper).toBe(lower);
  });

  it('accepts custom primer concentration', () => {
    const seq = 'ATGCGATCGATCGATCGATC';
    const tm250 = calculateTmNN(seq, { primerConc: 250 });
    const tm500 = calculateTmNN(seq, { primerConc: 500 });

    expect(tm500).toBeGreaterThan(tm250 - 2);
    expect(tm500).toBeLessThan(tm250 + 5);
  });

  it('accepts custom Na+ concentration', () => {
    const seq = 'ATGCGATCGATCGATCGATC';
    const tm50 = calculateTmNN(seq, { naConc: 50 });
    const tm100 = calculateTmNN(seq, { naConc: 100 });

    expect(tm50).toBeGreaterThan(50);
    expect(tm100).toBeGreaterThan(50);
    expect(Math.abs(tm100 - tm50)).toBeLessThan(5);
  });

  it('produces values in reasonable range for 20bp primer', () => {
    const seq = 'ATGCGATCGATCGATCGATC';
    const tm = calculateTmNN(seq, { primerConc: 250, naConc: 50 });

    expect(tm).toBeGreaterThan(50);
    expect(tm).toBeLessThan(70);
  });
});

describe('estimateTm (default export)', () => {
  it('uses nearest-neighbor method', () => {
    const seq = 'ATGCGATCGATCGATCGATC';
    const tmNN = calculateTmNN(seq);
    const tmDefault = estimateTm(seq);

    expect(tmNN).toBeGreaterThan(30);
    expect(tmDefault).toBe(tmNN);
  });

  it('returns sensible Tm for typical Gibson homology region', () => {
    const homology = 'ATGCGATCGATCGATCGATCGATCGATCGA';
    const tm = estimateTm(homology);

    expect(tm).toBeGreaterThan(55);
    expect(tm).toBeLessThan(80);
  });
});

describe('edge cases', () => {
  it('handles sequences with non-ATGC characters', () => {
    const withN = 'ATGCNATGC';
    const tm = calculateTmNN(withN);
    expect(typeof tm).toBe('number');
  });

  it('returns a number for very short sequences (even if unreliable)', () => {
    const tm = calculateTmNN('AT');
    expect(typeof tm).toBe('number');
  });

  it('handles self-complementary sequences', () => {
    const palindrome = 'GAATTC';
    const tm = calculateTmNN(palindrome);
    expect(typeof tm).toBe('number');
  });

  it('gives sensible results for realistic primer lengths (18-25bp)', () => {
    const primer18 = 'ATGCGATCGATCGATCGA';
    const primer25 = 'ATGCGATCGATCGATCGATCGATCG';

    const tm18 = calculateTmNN(primer18);
    const tm25 = calculateTmNN(primer25);

    expect(tm18).toBeGreaterThan(45);
    expect(tm18).toBeLessThan(75);
    expect(tm25).toBeGreaterThan(50);
    expect(tm25).toBeLessThan(80);
  });
});
