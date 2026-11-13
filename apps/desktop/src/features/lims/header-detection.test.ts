// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { detectHeaderRow } from './header-detection';

describe('detectHeaderRow', () => {
  describe('header under title', () => {
    const matrix: string[][] = [
      ['Supplementary Table S3 — Strains'],
      [''],
      ['Strain', 'Genotype', 'Organism'],
      ['DH5a', 'F- endA1 glnV44', 'E. coli'],
      ['BL21', 'F- ompT hsdSB', 'E. coli'],
    ];

    it('detects the header row beneath a sparse title + blank spacer', () => {
      const result = detectHeaderRow(matrix);
      expect(result.headerRowIndex).toBe(2);
      expect(result.mode).toBe('detected');
      expect(result.titleRowsAbove).toBe(2);
      expect(result.headers).toEqual(['Strain', 'Genotype', 'Organism']);
      expect(result.sideBySide).toBeUndefined();
    });

    it('detects a text header over machine-typed data with no title above', () => {
      const result = detectHeaderRow([
        ['Name', 'Sequence', 'Length'],
        ['p1', 'ACGTACGTACGTACGT', '20'],
        ['p2', 'TTTTGGGGCCCCAAAA', '18'],
      ]);
      expect(result.mode).toBe('detected');
      expect(result.headerRowIndex).toBe(0);
      expect(result.titleRowsAbove).toBe(0);
      expect(result.headers).toEqual(['Name', 'Sequence', 'Length']);
    });
  });

  describe('headerless synthesis', () => {
    it('synthesizes Well / Name / Sequence for a headerless plate', () => {
      const result = detectHeaderRow([
        ['A1', 'oligo-fwd', 'ACGTACGTACGTACGT'],
        ['A2', 'oligo-rev', 'TTTTGGGGCCCCAAAA'],
        ['B1', 'oligo-probe', 'GGGGCCCCTTTTAAAA'],
      ]);
      expect(result.mode).toBe('synthesized');
      expect(result.headerRowIndex).toBe(0);
      expect(result.headers).toEqual(['Well', 'Name', 'Sequence']);
    });

    it('gives a leading empty column Column 1 without stealing the Name slot', () => {
      const result = detectHeaderRow([
        ['', 'oligo-fwd', 'ACGTACGTACGTACGT'],
        ['', 'oligo-rev', 'TTTTGGGGCCCCAAAA'],
      ]);
      expect(result.mode).toBe('synthesized');
      expect(result.headers).toEqual(['Column 1', 'Name', 'Sequence']);
    });

    it('generalizes beyond DNA: a [name, text, text] table yields Name + Column N', () => {
      const result = detectHeaderRow([
        ['alpha', 'red', 'big'],
        ['beta', 'blue', 'small'],
      ]);
      expect(result.mode).toBe('synthesized');
      expect(result.headerRowIndex).toBe(0);
      expect(result.headers).toEqual(['Name', 'Column 2', 'Column 3']);
    });

    it('never emits duplicate synthesized headers for two DNA columns', () => {
      const result = detectHeaderRow([
        ['oligo-1', 'ACGTACGTACGTACGT', 'TTTTGGGGCCCCAAAA'],
        ['oligo-2', 'GGGGCCCCAAAATTTT', 'ACACACACACACGTGT'],
      ]);
      expect(result.mode).toBe('synthesized');
      expect(new Set(result.headers).size).toBe(result.headers.length);
      expect(result.headers).toEqual(['Name', 'Sequence', 'Column 3']);
    });
  });

  describe('side-by-side tables', () => {
    it('separates two tables at a fully-empty column and returns only the primary header', () => {
      const result = detectHeaderRow([
        ['Well', 'Sequence', '', 'Well', 'Sequence'],
        ['A1', 'ACGTACGTACGTACGT', '', 'B2', 'TTTTGGGGCCCCAAAA'],
        ['A2', 'GGGGCCCCAAAATTTT', '', 'B3', 'ACACACACACACGTGT'],
      ]);
      expect(result.sideBySide).toEqual({
        primaryCols: [0, 1],
        leftoverCols: [[3, 4]],
      });
      expect(result.headers).toEqual(['Well', 'Sequence']);
      expect(result.mode).toBe('detected');
      expect(result.headerRowIndex).toBe(0);
    });
  });

  describe('headerRowOverride', () => {
    it('uses the given row verbatim as the header', () => {
      const result = detectHeaderRow(
        [
          ['Supplementary Table S3 — Strains'],
          ['Strain', 'Genotype', 'Organism'],
          ['DH5a', 'F- endA1', 'E. coli'],
        ],
        { headerRowOverride: 1 }
      );
      expect(result.mode).toBe('detected');
      expect(result.headerRowIndex).toBe(1);
      expect(result.titleRowsAbove).toBe(1);
      expect(result.headers).toEqual(['Strain', 'Genotype', 'Organism']);
    });
  });
});
