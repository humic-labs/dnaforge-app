// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { diffToGappedAlignment } from './diff-alignment';

describe('diffToGappedAlignment', () => {
  it('handles pure insertion', () => {
    const result = diffToGappedAlignment('ATCGATCG', 'ATCGCCATCG');
    expect(result.oldGapped).toBe('ATCG--ATCG');
    expect(result.newGapped).toBe('ATCGCCATCG');
  });

  it('handles pure deletion', () => {
    const result = diffToGappedAlignment('ATCGATCG', 'ATCGCG');
    expect(result.oldGapped).toBe('ATCGATCG');
    expect(result.newGapped).toBe('ATCG--CG');
  });

  it('handles substitution in-place (no gaps)', () => {
    const result = diffToGappedAlignment('ATCGATCG', 'ATCGGTCG');
    expect(result.oldGapped).toBe('ATCGATCG');
    expect(result.newGapped).toBe('ATCGGTCG');
    expect(result.oldGapped.length).toBe(result.newGapped.length);
  });

  it('handles identical sequences', () => {
    const result = diffToGappedAlignment('ATCG', 'ATCG');
    expect(result.oldGapped).toBe('ATCG');
    expect(result.newGapped).toBe('ATCG');
  });

  it('handles mixed insertions and deletions', () => {
    const result = diffToGappedAlignment('ATCGATCGATCG', 'ATCGCCATCGCG');
    expect(result.oldGapped.length).toBe(result.newGapped.length);
  });

  it('gapped strings are always the same length', () => {
    const cases = [
      ['AAAA', 'AACCAA'],
      ['AACCAA', 'AAAA'],
      ['ATCG', 'GCTA'],
      ['', 'ATCG'],
      ['ATCG', ''],
    ];
    for (const [old, neu] of cases) {
      const result = diffToGappedAlignment(old, neu);
      expect(result.oldGapped.length).toBe(result.newGapped.length);
    }
  });
});
