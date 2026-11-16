import { describe, expect, it } from 'vitest';
import {
  alignmentEvidence,
  alignmentColumnAddress,
  interpretReferenceAlignment,
  mutationAlignmentColumns,
} from './alignment-observation';

describe('reference alignment observations', () => {
  it('retains the actual partial read and locates its globally numbered mutation', () => {
    const source = {
      alignedReference: 'CCCGGG',
      alignedQuery: 'CCTGGG',
      circularOffset: 6,
      referenceLength: 15,
    };
    const observed = interpretReferenceAlignment(source, {
      sequence: 'ATGAAACCCGGGTAA',
      topology: 'circular',
    });
    expect(observed).toMatchObject({
      kind: 'placed',
      value: {
        referencePositions: [7, 8, 9, 10, 11, 12],
        observedColumns: [true, true, true, true, true, true],
        coverage: { start: 7, end: 12 },
        evidence: { total: 15, unresolved: 9, complete: false },
        completeInReferenceOrder: false,
      },
    });
    expect(alignmentEvidence(source)).toMatchObject({ total: 15, unresolved: 9, complete: false });
    expect(
      mutationAlignmentColumns(source, { position: 9, type: 'substitution', length: 1 }, 'circular')
    ).toEqual({ column: 2 });
    expect(source.alignedReference).toBe('CCCGGG');
    expect(source.alignedQuery).toBe('CCTGGG');
  });

  it('uses the recorded repeat occurrence and refuses to place an offsetless partial read', () => {
    const reference = { sequence: 'ACACACAC', topology: 'circular' as const };
    expect(
      interpretReferenceAlignment(
        { alignedReference: 'ACAC', alignedQuery: 'ACAC', circularOffset: 4, referenceLength: 8 },
        reference
      )
    ).toMatchObject({ kind: 'placed', value: { referencePositions: [5, 6, 7, 8] } });
    expect(
      interpretReferenceAlignment({ alignedReference: 'ACAC', alignedQuery: 'ACAC' }, reference)
    ).toMatchObject({ kind: 'unplaced' });
    expect(alignmentEvidence({ alignedReference: 'ACAC', alignedQuery: 'ACAC' }).complete).toBe(
      true
    );
    expect(
      alignmentEvidence({ alignedReference: 'ACAC', alignedQuery: 'ACAC', referenceLength: 8 })
    ).toMatchObject({ complete: false, unresolved: 4 });
    expect(
      interpretReferenceAlignment(
        { alignedReference: 'ACACACAC', alignedQuery: 'ACACACAC' },
        reference
      )
    ).toMatchObject({ kind: 'placed', value: { circularOffset: 0, referenceLength: 8 } });
  });

  it('walks an internal deletion across the origin without observing the absent middle', () => {
    const source = {
      alignedReference: 'ACAC',
      alignedQuery: 'A--C',
      circularOffset: 4,
      referenceLength: 6,
    };
    expect(
      interpretReferenceAlignment(source, { sequence: 'ACGTAC', topology: 'circular' })
    ).toMatchObject({
      kind: 'placed',
      value: {
        referencePositions: [5, 6, 1, 2],
        observedColumns: [true, true, true, true],
        coverage: { start: 5, end: 2 },
        evidence: { unresolved: 2, complete: false },
      },
    });
    expect(
      mutationAlignmentColumns(source, { position: 6, type: 'deletion', length: 2 }, 'circular')
    ).toEqual({ column: 1, endColumn: 2 });
    expect(
      mutationAlignmentColumns(source, { position: 3, type: 'deletion', length: 1 }, 'circular')
    ).toBeNull();
    expect(alignmentEvidence({ ...source, alignedQuery: '--AC' })).toMatchObject({ unresolved: 4 });
  });

  it('anchors an origin insertion once and preserves a terminal linear insertion', () => {
    const source = {
      alignedReference: 'AC--AC',
      alignedQuery: 'ACTTAC',
      circularOffset: 4,
      referenceLength: 6,
    };
    expect(
      interpretReferenceAlignment(source, { sequence: 'ACGTAC', topology: 'circular' })
    ).toMatchObject({
      kind: 'placed',
      value: { insertionBoundaries: [null, null, 0, 0, null, null] },
    });
    expect(
      mutationAlignmentColumns(source, { position: 1, type: 'insertion', length: 2 }, 'circular')
    ).toEqual({ column: 2, endColumn: 3 });
    expect(alignmentColumnAddress(source, 2, 'circular')).toEqual({
      referencePosition: null,
      insertionBoundary: 0,
      observed: true,
    });
    expect(alignmentColumnAddress(source, 4, 'circular')).toEqual({
      referencePosition: 1,
      insertionBoundary: null,
      observed: true,
    });
    expect(
      mutationAlignmentColumns(
        { alignedReference: 'AC--', alignedQuery: 'ACTT', circularOffset: 0, referenceLength: 2 },
        { position: 3, type: 'insertion', length: 2 },
        'linear'
      )
    ).toEqual({ column: 2, endColumn: 3 });
    expect(
      mutationAlignmentColumns(
        { alignedReference: 'AC--', alignedQuery: 'ACTT', circularOffset: 0, referenceLength: 2 },
        { position: 3, type: 'insertion', length: 2 },
        'circular'
      )
    ).toEqual({ column: 2, endColumn: 3 });
  });

  it('separates complete evidence from safe whole-query order', () => {
    expect(
      interpretReferenceAlignment(
        { alignedReference: 'GTAC', alignedQuery: 'GTAC', circularOffset: 2, referenceLength: 4 },
        { sequence: 'ACGT', topology: 'circular' }
      )
    ).toMatchObject({
      kind: 'placed',
      value: { evidence: { complete: true }, completeInReferenceOrder: false },
    });
    expect(
      interpretReferenceAlignment(
        { alignedReference: 'ACGT', alignedQuery: 'AC-T', circularOffset: 0, referenceLength: 4 },
        { sequence: 'ACGT', topology: 'linear' }
      )
    ).toMatchObject({
      kind: 'placed',
      value: { evidence: { complete: true }, completeInReferenceOrder: true },
    });
    expect(
      alignmentEvidence({
        alignedReference: 'AC-',
        alignedQuery: 'ACN',
        circularOffset: 0,
        referenceLength: 2,
      })
    ).toMatchObject({ unresolved: 0, ambiguousInsertions: 1, complete: false });
  });

  it.each([
    { alignedReference: 'AC', alignedQuery: 'AC', circularOffset: -1, referenceLength: 4 },
    { alignedReference: 'AC', alignedQuery: 'AC', circularOffset: 0.5, referenceLength: 4 },
    { alignedReference: 'AC', alignedQuery: 'AC', circularOffset: 4, referenceLength: 4 },
    { alignedReference: 'AC', alignedQuery: 'A', circularOffset: 0, referenceLength: 4 },
    { alignedReference: 'ACGTA', alignedQuery: 'ACGTA', circularOffset: 0, referenceLength: 4 },
    { alignedReference: 'GT', alignedQuery: 'GT', circularOffset: 0, referenceLength: 4 },
    { alignedReference: 'AC', alignedQuery: 'AC', circularOffset: 0, referenceLength: 5 },
  ])('refuses malformed or contradictory placement %#', (source) => {
    expect(
      interpretReferenceAlignment(source, { sequence: 'ACGT', topology: 'circular' })
    ).toMatchObject({ kind: 'invalid' });
  });

  it('refuses circular displacement on a linear reference', () => {
    expect(
      interpretReferenceAlignment(
        { alignedReference: 'GT', alignedQuery: 'GT', circularOffset: 2, referenceLength: 4 },
        { sequence: 'ACGT', topology: 'linear' }
      )
    ).toMatchObject({ kind: 'invalid' });
  });
});
