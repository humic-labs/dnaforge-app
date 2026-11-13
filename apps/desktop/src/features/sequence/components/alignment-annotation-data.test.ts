import { describe, expect, it } from 'vitest';
import type { Feature } from '@waypoint/genome-renderer';
import { annotationDnaData, alignmentColumnChanges } from './alignment-annotation-data';

const feature: Feature = {
  id: 7,
  type: 'gene',
  start: 0,
  end: 6,
  direction: 'forward',
  displayName: 'reference annotation',
  color: 0x123456,
  lane: 0,
};

describe('alignment annotation data', () => {
  it('counts DNA differences in gapped columns, including deleted bases', () => {
    expect(annotationDnaData(feature, 'ACGTAC', 'AC-TAC')).toEqual({
      dnaChange: 'modified',
      dnaChanged: true,
      insertedBases: 0,
      deletedBases: 1,
      substitutedBases: 0,
      referenceBases: 6,
      queryBases: 5,
    });
  });

  it('distinguishes wholly added/removed DNA from an upstream coordinate shift', () => {
    expect(annotationDnaData({ ...feature, start: 1, end: 2 }, 'A-CGT', 'AACGT').dnaChange).toBe(
      'added'
    );
    expect(annotationDnaData({ ...feature, start: 1, end: 2 }, 'AACGT', 'A-CGT').dnaChange).toBe(
      'removed'
    );
    expect(annotationDnaData({ ...feature, start: 2, end: 5 }, 'A-CGT', 'AACGT').dnaChange).toBe(
      'unchanged'
    );
  });

  it('checks spliced annotation parts without counting introns or duplicate coverage', () => {
    const spliced = {
      ...feature,
      exons: [
        { start: 1, end: 2 },
        { start: 5, end: 6 },
        { start: 5, end: 6 },
      ],
    };
    expect(annotationDnaData(spliced, 'ACGTAC', 'ACA-AC')).toMatchObject({
      dnaChanged: false,
      referenceBases: 4,
      queryBases: 4,
    });
    expect(annotationDnaData(feature, 'ACGTAC', 'ACA-AC')).toMatchObject({
      dnaChanged: true,
      deletedBases: 1,
      substitutedBases: 1,
    });
  });

  it('treats letter casing as the same underlying DNA and preserves exact mismatch positions', () => {
    expect(annotationDnaData(feature, 'ACGTAC', 'acgtac').dnaChanged).toBe(false);
    expect(alignmentColumnChanges('A-CGTAC', 'AAC-TTC')).toEqual([
      { start: 1, end: 2, kind: 'insertion' },
      { start: 3, end: 4, kind: 'deletion' },
      { start: 5, end: 6, kind: 'substitution' },
    ]);
  });

  it('counts both ends of an annotation crossing a circular origin, excluding the opposite interval', () => {
    const wrapped = { ...feature, start: 4, end: 2 };
    expect(annotationDnaData(wrapped, 'ACGTAC', 'ACGTA-')).toMatchObject({
      dnaChange: 'modified',
      deletedBases: 1,
      referenceBases: 4,
      queryBases: 3,
    });
    expect(annotationDnaData(wrapped, 'ACGTAC', 'CCGTAC')).toMatchObject({
      dnaChange: 'modified',
      substitutedBases: 1,
    });
    expect(annotationDnaData(wrapped, 'ACGTAC', 'AC-TAC')).toMatchObject({
      dnaChange: 'unchanged',
      referenceBases: 4,
      queryBases: 4,
    });
  });
});
