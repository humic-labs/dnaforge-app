import { describe, it, expect } from 'vitest';
import { getCodonsForSingleCDS, getAlignmentCodonsForCDS } from './codon-calculator';
import type { Annotation } from '@waypoint/sequence-utils';

describe('Alignment vs Normal mode consistency', () => {
  it('should produce same amino acids in alignment mode as normal mode (forward, no gaps)', () => {
    const bioSequence = 'ATGGCTGAA';
    const cds: Annotation = {
      name: 'test_cds',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
      color: '#000',
    };

    const normalCodons = getCodonsForSingleCDS(cds, 0, bioSequence.length, bioSequence);
    const normalAAs = normalCodons.map((c) => c.aa);

    console.log(
      'Normal mode codons:',
      normalCodons.map((c) => ({
        pos: `${c.startPos}-${c.endPos}`,
        codon: c.codon,
        aa: c.aa,
      }))
    );

    const alignedRef = bioSequence;
    const alignedQuery = bioSequence;

    const transformedCds: Annotation & { startCol?: number; endCol?: number } = {
      ...cds,
    };

    const alignmentCodons = getAlignmentCodonsForCDS(
      alignedRef,
      alignedQuery,
      transformedCds,
      0,
      bioSequence.length
    );
    const alignmentAAs = alignmentCodons.map((c) => c.refAa);

    console.log(
      'Alignment mode codons:',
      alignmentCodons.map((c) => ({
        cols: `${c.columnStart}-${c.columnEnd}`,
        refAa: c.refAa,
        queryAa: c.queryAa,
        status: c.status,
      }))
    );

    expect(alignmentAAs).toEqual(normalAAs);
    expect(alignmentAAs).toEqual(['M', 'A', 'E']);
  });

  it('should produce same amino acids with gaps in reference', () => {
    const bioSequence = 'ATGGCTGAA';
    const cds: Annotation = {
      name: 'test_cds',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
      color: '#000',
    };

    const normalCodons = getCodonsForSingleCDS(cds, 0, bioSequence.length, bioSequence);
    const normalAAs = normalCodons.map((c) => c.aa);

    console.log('Normal mode:', normalAAs);

    const alignedRef = 'ATG---GCTGAA';
    const alignedQuery = 'ATGAAAGCTGAA';

    const transformedCds: Annotation & { startCol?: number; endCol?: number } = {
      ...cds,
      start: 1,
      end: 12,
    };

    const alignmentCodons = getAlignmentCodonsForCDS(
      alignedRef,
      alignedQuery,
      transformedCds,
      0,
      alignedRef.length
    );
    const alignmentAAs = alignmentCodons.map((c) => c.refAa);

    console.log('Alignment mode:', alignmentAAs);
    console.log('Alignment codons detail:', alignmentCodons);

    expect(alignmentAAs).toEqual(normalAAs);
    expect(alignmentAAs).toEqual(['M', 'A', 'E']);
  });

  it('should produce same amino acids for reverse strand', () => {
    const bioSequence = 'TTCAGCCAT';
    const cds: Annotation = {
      name: 'test_cds',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: -1,
      color: '#000',
    };

    const normalCodons = getCodonsForSingleCDS(cds, 0, bioSequence.length, bioSequence);

    console.log(
      'Normal mode (reverse):',
      normalCodons.map((c) => ({
        pos: `${c.startPos}-${c.endPos}`,
        codon: c.codon,
        aa: c.aa,
      }))
    );

    const normalPosToAA = new Map<string, string>();
    normalCodons.forEach((c) => {
      normalPosToAA.set(`${c.startPos}-${c.endPos}`, c.aa);
    });

    const alignedRef = bioSequence;
    const alignedQuery = bioSequence;

    const transformedCds: Annotation & { startCol?: number; endCol?: number } = {
      ...cds,
    };

    const alignmentCodons = getAlignmentCodonsForCDS(
      alignedRef,
      alignedQuery,
      transformedCds,
      0,
      bioSequence.length
    );

    console.log(
      'Alignment mode (reverse):',
      alignmentCodons.map((c) => ({
        cols: `${c.columnStart}-${c.columnEnd}`,
        refAa: c.refAa,
      }))
    );

    const alignmentColToAA = new Map<string, string>();
    alignmentCodons.forEach((c) => {
      alignmentColToAA.set(`${c.columnStart}-${c.columnEnd}`, c.refAa);
    });

    expect(alignmentColToAA.get('0-2')).toBe(normalPosToAA.get('0-2'));
    expect(alignmentColToAA.get('3-5')).toBe(normalPosToAA.get('3-5'));
    expect(alignmentColToAA.get('6-8')).toBe(normalPosToAA.get('6-8'));

    expect(alignmentColToAA.get('6-8')).toBe('M');
    expect(alignmentColToAA.get('3-5')).toBe('A');
    expect(alignmentColToAA.get('0-2')).toBe('E');
  });

  it('should work with transformed coordinates (simulating real app)', () => {
    const _bioSequence = 'ATGGCTGAA';
    const alignedRef = 'ATG---GCTGAA';
    const alignedQuery = 'ATGAAAGCTGAA';

    const bioToColMap = new Map<number, number>();
    let bioPos = 0;
    for (let col = 0; col < alignedRef.length; col++) {
      if (alignedRef[col] !== '-') {
        bioPos++;
        bioToColMap.set(bioPos, col);
      }
    }

    console.log('bioToColMap:', Object.fromEntries(bioToColMap));

    const originalCds: Annotation = {
      name: 'test_cds',
      type: 'CDS',
      start: 1,
      end: 9,
      direction: 1,
      color: '#000',
    };

    const startCol = bioToColMap.get(originalCds.start) ?? -1;
    const endCol = bioToColMap.get(originalCds.end) ?? -1;
    const transformedCds: Annotation & { startCol?: number; endCol?: number } = {
      ...originalCds,
      start: startCol >= 0 ? startCol + 1 : originalCds.start,
      end: endCol >= 0 ? endCol + 1 : originalCds.end,
    };

    console.log('Original CDS:', { start: originalCds.start, end: originalCds.end });
    console.log('Transformed CDS:', { start: transformedCds.start, end: transformedCds.end });

    const alignmentCodons = getAlignmentCodonsForCDS(
      alignedRef,
      alignedQuery,
      transformedCds,
      0,
      alignedRef.length
    );

    console.log(
      'Alignment codons:',
      alignmentCodons.map((c) => ({
        cols: `${c.columnStart}-${c.columnEnd}`,
        refAa: c.refAa,
        queryAa: c.queryAa,
      }))
    );

    const refAAs = alignmentCodons.map((c) => c.refAa);
    expect(refAAs).toEqual(['M', 'A', 'E']);

    expect(alignmentCodons[0].columnStart).toBe(0);
    expect(alignmentCodons[1].columnStart).toBe(6);
    expect(alignmentCodons[2].columnStart).toBe(9);
  });
});
