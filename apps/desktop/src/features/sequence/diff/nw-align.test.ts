// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { alignSequences } from './nw-align';

describe('alignSequences', () => {
  it('returns identical strings unchanged', () => {
    const result = alignSequences('ATCGATCG', 'ATCGATCG');
    expect(result.oldGapped).toBe('ATCGATCG');
    expect(result.newGapped).toBe('ATCGATCG');
  });

  it('handles empty old sequence (entire new is insertion)', () => {
    const result = alignSequences('', 'ATCG');
    expect(result.oldGapped).toBe('----');
    expect(result.newGapped).toBe('ATCG');
  });

  it('handles empty new sequence (entire old is deletion)', () => {
    const result = alignSequences('ATCG', '');
    expect(result.oldGapped).toBe('ATCG');
    expect(result.newGapped).toBe('----');
  });

  it('handles both empty', () => {
    const result = alignSequences('', '');
    expect(result.oldGapped).toBe('');
    expect(result.newGapped).toBe('');
  });

  it('handles single insertion in the middle', () => {
    const result = alignSequences('ATCGATCG', 'ATCGAATCG');
    expect(result.oldGapped).toBe('ATCG-ATCG');
    expect(result.newGapped).toBe('ATCGAATCG');
  });

  it('handles insertion at the start', () => {
    const result = alignSequences('ATCG', 'GGATCG');
    expect(result.oldGapped).toBe('--ATCG');
    expect(result.newGapped).toBe('GGATCG');
  });

  it('handles insertion at the end', () => {
    const result = alignSequences('ATCG', 'ATCGCC');
    expect(result.oldGapped).toBe('ATCG--');
    expect(result.newGapped).toBe('ATCGCC');
  });

  it('handles multi-base insertion', () => {
    const result = alignSequences('ATCG', 'ATCCCCG');
    expect(result.oldGapped).toBe('AT---CG');
    expect(result.newGapped).toBe('ATCCCCG');
  });

  it('handles single deletion in the middle', () => {
    const result = alignSequences('ATCGATCG', 'ATCGTCG');
    expect(result.oldGapped).toBe('ATCGATCG');
    expect(result.newGapped).toBe('ATCG-TCG');
  });

  it('handles multi-base contiguous deletion', () => {
    const result = alignSequences('ATCGATCG', 'ATCGCG');
    expect(result.oldGapped).toBe('ATCGATCG');
    expect(result.newGapped).toBe('ATCG--CG');
  });

  it('places contiguous gap for deletion in repetitive DNA', () => {
    const result = alignSequences('ATATATATATAT', 'ATATATAAT');
    const gapRuns = result.newGapped.match(/-+/g) ?? [];
    expect(gapRuns.length).toBe(1);
    expect(result.newGapped.replace(/-/g, '')).toBe('ATATATAAT');
    expect(result.oldGapped.replace(/-/g, '')).toBe('ATATATATATAT');
    expect(result.oldGapped.length).toBe(result.newGapped.length);
  });

  it('keeps separate deletions as separate gaps', () => {
    const result = alignSequences('AAXBBXCC', 'AABBCC');
    const gapRuns = result.newGapped.match(/-+/g) ?? [];
    expect(gapRuns.length).toBe(2);
    expect(result.newGapped.replace(/-/g, '')).toBe('AABBCC');
  });

  it('keeps three separate 1bp deletions as three gaps', () => {
    const result = alignSequences('AAXBXCXD', 'AABCD');
    const gapRuns = result.newGapped.match(/-+/g) ?? [];
    expect(gapRuns.length).toBe(3);
    expect(result.newGapped.replace(/-/g, '')).toBe('AABCD');
  });

  it('handles single substitution without gaps', () => {
    const result = alignSequences('ATCGATCG', 'ATCGGTCG');
    expect(result.oldGapped).toBe('ATCGATCG');
    expect(result.newGapped).toBe('ATCGGTCG');
    expect(result.oldGapped.length).toBe(result.newGapped.length);
    expect(result.oldGapped).not.toContain('-');
    expect(result.newGapped).not.toContain('-');
  });

  it('handles multiple scattered substitutions', () => {
    const result = alignSequences('AAAAAA', 'ABAABA');
    expect(result.oldGapped).toBe('AAAAAA');
    expect(result.newGapped).toBe('ABAABA');
  });

  it('handles insertion + deletion in same sequence', () => {
    const result = alignSequences('ATCGATCG', 'ATCCCCGCG');
    expect(result.oldGapped.length).toBe(result.newGapped.length);
    expect(result.oldGapped.replace(/-/g, '')).toBe('ATCGATCG');
    expect(result.newGapped.replace(/-/g, '')).toBe('ATCCCCGCG');
  });

  it('gapped strings are always the same length', () => {
    const cases = [
      ['AAAA', 'AACCAA'],
      ['AACCAA', 'AAAA'],
      ['ATCG', 'GCTA'],
      ['', 'ATCG'],
      ['ATCG', ''],
      ['ATATATATATAT', 'ATATATAAT'],
      ['AAXBXCXD', 'AABCD'],
    ];
    for (const [old, neu] of cases) {
      const result = alignSequences(old, neu);
      expect(result.oldGapped.length).toBe(result.newGapped.length);
    }
  });

  it('ungapped sequences match the originals', () => {
    const cases = [
      ['ATCG', 'ATCGAATCG'],
      ['ATCGATCG', 'ATCG'],
      ['ATATATATATAT', 'ATATATAAT'],
    ];
    for (const [old, neu] of cases) {
      const result = alignSequences(old, neu);
      expect(result.oldGapped.replace(/-/g, '')).toBe(old);
      expect(result.newGapped.replace(/-/g, '')).toBe(neu);
    }
  });

  it('handles large sequences (10kb) within 500ms', () => {
    const base = 'ATCGATCG'.repeat(1250);
    const edited = base.slice(0, 5000) + 'NNN' + base.slice(5003);
    const start = performance.now();
    const result = alignSequences(base, edited);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result.oldGapped.length).toBe(result.newGapped.length);
  });
});
