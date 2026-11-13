import { describe, it, expect } from 'vitest';
import type { MutationMarker } from '../types';
import { MUTATION_COLORS } from '../types';
import { getMutationColor, getMutationsForLine, generateMutationMarkers } from '../mutation-track';

describe('mutation-track utilities', () => {
  describe('getMutationColor', () => {
    it('returns yellow for substitution', () => {
      expect(getMutationColor('substitution')).toBe(MUTATION_COLORS.substitution);
    });

    it('returns purple for insertion', () => {
      expect(getMutationColor('insertion')).toBe(MUTATION_COLORS.insertion);
    });

    it('returns red for deletion', () => {
      expect(getMutationColor('deletion')).toBe(MUTATION_COLORS.deletion);
    });
  });

  describe('getMutationsForLine', () => {
    const mutations: MutationMarker[] = [
      { column: 5, type: 'substitution', refBase: 'A', queryBase: 'G' },
      { column: 15, type: 'insertion', refBase: '-', queryBase: 'T' },
      { column: 25, type: 'deletion', refBase: 'C', queryBase: '-' },
      { column: 35, type: 'substitution', refBase: 'T', queryBase: 'A' },
    ];

    it('returns mutations within line range', () => {
      const result = getMutationsForLine(mutations, 0, 20);
      expect(result).toHaveLength(2);
      expect(result[0].column).toBe(5);
      expect(result[1].column).toBe(15);
    });

    it('returns empty array when no mutations in range', () => {
      const result = getMutationsForLine(mutations, 40, 60);
      expect(result).toHaveLength(0);
    });

    it('excludes mutations at endCol (exclusive)', () => {
      const result = getMutationsForLine(mutations, 0, 15);
      expect(result).toHaveLength(1);
      expect(result[0].column).toBe(5);
    });

    it('includes mutations at startCol (inclusive)', () => {
      const result = getMutationsForLine(mutations, 15, 30);
      expect(result).toHaveLength(2);
      expect(result[0].column).toBe(15);
      expect(result[1].column).toBe(25);
    });
  });

  describe('generateMutationMarkers', () => {
    it('detects substitution when bases differ', () => {
      const alignedRef = 'ATGC';
      const alignedQuery = 'ATAC';

      const markers = generateMutationMarkers(alignedRef, alignedQuery);

      expect(markers).toHaveLength(1);
      expect(markers[0].column).toBe(2);
      expect(markers[0].type).toBe('substitution');
      expect(markers[0].refBase).toBe('G');
      expect(markers[0].queryBase).toBe('A');
    });

    it('detects insertion when reference has gap', () => {
      const alignedRef = 'AT-GC';
      const alignedQuery = 'ATTGC';

      const markers = generateMutationMarkers(alignedRef, alignedQuery);

      expect(markers).toHaveLength(1);
      expect(markers[0].column).toBe(2);
      expect(markers[0].type).toBe('insertion');
      expect(markers[0].refBase).toBe('-');
      expect(markers[0].queryBase).toBe('T');
    });

    it('detects deletion when query has gap', () => {
      const alignedRef = 'ATGC';
      const alignedQuery = 'AT-C';

      const markers = generateMutationMarkers(alignedRef, alignedQuery);

      expect(markers).toHaveLength(1);
      expect(markers[0].column).toBe(2);
      expect(markers[0].type).toBe('deletion');
      expect(markers[0].refBase).toBe('G');
      expect(markers[0].queryBase).toBe('-');
    });

    it('detects multiple mutations', () => {
      const alignedRef = 'ATGCATGC';
      const alignedQuery = 'AAGC-TGC';

      const markers = generateMutationMarkers(alignedRef, alignedQuery);

      expect(markers).toHaveLength(2);
      expect(markers[0].type).toBe('substitution');
      expect(markers[0].column).toBe(1);
      expect(markers[1].type).toBe('deletion');
      expect(markers[1].column).toBe(4);
    });

    it('returns empty array for identical sequences', () => {
      const alignedRef = 'ATGCATGC';
      const alignedQuery = 'ATGCATGC';

      const markers = generateMutationMarkers(alignedRef, alignedQuery);

      expect(markers).toHaveLength(0);
    });

    it('handles sequences with only gaps matching', () => {
      const alignedRef = 'AT--GC';
      const alignedQuery = 'AT--GC';

      const markers = generateMutationMarkers(alignedRef, alignedQuery);

      expect(markers).toHaveLength(0);
    });

    it('calculates refPosition for non-gap reference bases', () => {
      const alignedRef = 'A-TGC';
      const alignedQuery = 'AATGC';

      const markers = generateMutationMarkers(alignedRef, alignedQuery);

      expect(markers).toHaveLength(1);
      expect(markers[0].column).toBe(1);
      expect(markers[0].type).toBe('insertion');
      expect(markers[0].refPosition).toBeUndefined();
    });

    it('includes refPosition for substitutions and deletions', () => {
      const alignedRef = 'ATGC';
      const alignedQuery = 'ATAC';

      const markers = generateMutationMarkers(alignedRef, alignedQuery);

      expect(markers).toHaveLength(1);
      expect(markers[0].refPosition).toBe(3);
    });
  });
});

describe('mutation track colors', () => {
  it('has correct values for all mutation types (deprecated alias for CHANGE_COLORS)', () => {
    expect(MUTATION_COLORS.substitution).toBe('hsl(42, 85%, 52%)');
    expect(MUTATION_COLORS.insertion).toBe('hsl(152, 55%, 42%)');
    expect(MUTATION_COLORS.deletion).toBe('hsl(0, 72%, 55%)');
    expect(MUTATION_COLORS.match).toBe('#F5F5F5');
  });
});
