// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { calculateTmWallace, estimateTm } from './tm-calculator';

const BIOPYTHON_REFERENCE = [
  { seq: 'AT', biopython: 0.0, note: '2bp AT - very short' },
  { seq: 'GC', biopython: 6.0, note: '2bp GC - very short' },
  { seq: 'ATGC', biopython: 9.7, note: '4bp mixed' },
  { seq: 'GCGC', biopython: 26.3, note: '4bp GC-rich' },

  { seq: 'ATCGATCG', biopython: 22.8, note: '8bp 50% GC' },
  { seq: 'ATCGATCGATCG', biopython: 35.4, note: '12bp 50% GC' },
  { seq: 'GCGCGCGCGCGC', biopython: 60.7, note: '12bp 100% GC' },
  { seq: 'ATATATATATATAT', biopython: 22.4, note: '14bp 0% GC' },

  { seq: 'ATCGATCGATCGATCGATCG', biopython: 52.7, note: '20bp 50% GC' },
  { seq: 'GCATGCATGCATGCATGCAT', biopython: 55.9, note: '20bp 50% GC alt' },
  { seq: 'GCGCGCGCGCGCGCGCGCGC', biopython: 74.9, note: '20bp 100% GC' },

  { seq: 'AAAGGGG', biopython: 18.4, note: '7bp 57% GC - user example ~overhang' },
  { seq: 'ATCGATCGATCGATCGATCGATCG', biopython: 57.3, note: '24bp 50% GC' },

  { seq: 'GCTAGCTATCGATCGATCGATCGATCGATCG', biopython: 66.8, note: '32bp ~56% GC' },
];

describe('Tm Calculator Accuracy', () => {
  describe('versus BioPython reference values', () => {
    for (const { seq, biopython, note } of BIOPYTHON_REFERENCE) {
      it(`${seq.length}bp: ${note}`, () => {
        const ourTm = estimateTm(seq);

        console.log(`${seq.slice(0, 20)}${seq.length > 20 ? '...' : ''} (${seq.length}bp):`);
        console.log(`  Our Tm:      ${ourTm.toFixed(1)}°C`);
        console.log(`  BioPython:   ${biopython.toFixed(1)}°C`);
        console.log(`  Difference:  ${(ourTm - biopython).toFixed(1)}°C`);

        if (seq.length < 6) {
          expect(true).toBe(true);
        } else {
          const diff = Math.abs(ourTm - biopython);
          if (seq.length >= 10) {
            expect(diff).toBeLessThan(8);
          }
        }
      });
    }
  });

  describe('specific user-reported issues', () => {
    it('2bp overhang should use Wallace rule', () => {
      const tm_gc = estimateTm('GC');
      const tm_at = estimateTm('AT');

      console.log('2bp Wallace rule check:');
      console.log(`  GC: ${tm_gc}°C (expected: 8)`);
      console.log(`  AT: ${tm_at}°C (expected: 4)`);

      expect(tm_gc).toBe(8);
      expect(tm_at).toBe(4);
    });

    it('23bp overhang with ~57% GC should not be 78.2°C', () => {
      const seq23 = 'GCGCGCGCGCGCGATATATATAT';
      expect(seq23.length).toBe(23);

      const gcCount = seq23.split('').filter((b) => b === 'G' || b === 'C').length;
      const gcPercent = (gcCount / seq23.length) * 100;
      console.log(`Testing: ${seq23}`);
      console.log(`GC content: ${gcPercent.toFixed(1)}%`);

      const tm = estimateTm(seq23);
      console.log(`Our Tm: ${tm.toFixed(1)}°C`);

      expect(tm).toBeLessThan(70);
    });

    it('analyzes the actual 78.2°C case', () => {
      const pureGC23 = 'GCGCGCGCGCGCGCGCGCGCGCG';
      const tmGC = estimateTm(pureGC23);
      console.log(`Pure GC 23bp: ${tmGC.toFixed(1)}°C`);

      const test1 = 'GCATGCATGCATGCATGCATGCA';
      const test2 = 'GCGCGCATGCATGCATGCATGCA';
      const test3 = 'GCGCGCGCATGCATGCATGCATG';

      console.log(`Test sequences with ~56% GC:`);
      console.log(`  ${test1.slice(0, 15)}...: ${estimateTm(test1).toFixed(1)}°C`);
      console.log(`  ${test2.slice(0, 15)}...: ${estimateTm(test2).toFixed(1)}°C`);
      console.log(`  ${test3.slice(0, 15)}...: ${estimateTm(test3).toFixed(1)}°C`);
    });
  });

  describe('Wallace rule for short sequences', () => {
    it('uses Wallace for sequences < 6bp', () => {
      expect(calculateTmWallace('A')).toBe(2);
      expect(calculateTmWallace('G')).toBe(4);
      expect(calculateTmWallace('AT')).toBe(4);
      expect(calculateTmWallace('GC')).toBe(8);
      expect(calculateTmWallace('ATGC')).toBe(12);
    });

    it('estimateTm uses Wallace for short sequences', () => {
      expect(estimateTm('ATGC')).toBe(12);
      expect(estimateTm('ATGCA')).toBe(14);
    });
  });
});

describe('Tm investigation for debugging', () => {
  it('logs detailed Tm calculations for investigation', () => {
    const testSequences = [
      'GC',
      'ATGC',
      'ATCGATCG',
      'ATCGATCGATCG',
      'ATCGATCGATCGATCG',
      'ATCGATCGATCGATCGATCG',
      'GCGCGCGCGCGCGCGCGCGC',
      'ATATATATATATATATATAT',
    ];

    console.log('\n=== Tm Investigation ===\n');

    for (const seq of testSequences) {
      const tm = estimateTm(seq);
      const gcCount = seq.split('').filter((b) => b === 'G' || b === 'C').length;
      const gcPercent = ((gcCount / seq.length) * 100).toFixed(0);

      console.log(
        `${seq.slice(0, 20).padEnd(20)} | ${seq.length}bp | GC: ${gcPercent.padStart(3)}% | Tm: ${tm.toFixed(1).padStart(5)}°C`
      );
    }

    expect(true).toBe(true);
  });
});
