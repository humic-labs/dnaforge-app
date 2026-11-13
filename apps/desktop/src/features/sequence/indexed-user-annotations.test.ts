import { describe, expect, it } from 'vitest';

import type { IndexedGenomeUserAnnotation } from '../../shared/indexed-genome';
import {
  deleteIndexedUserAnnotation,
  findIndexedUserAnnotationAtRendererPosition,
  indexedUserAnnotationDataset,
  upsertIndexedUserAnnotation,
} from './indexed-user-annotations';

const assembly = {
  chromosomes: [
    { chrom: 'chr1', length: 100 },
    { chrom: 'chr2', length: 50 },
  ],
};

const annotation: IndexedGenomeUserAnnotation = {
  id: 'annotation-1',
  chrom: 'chr2',
  annotation: {
    name: 'reviewed locus',
    type: 'misc_feature',
    start: 10,
    end: 20,
    direction: 1,
    color: '#16a34a',
  },
};

describe('indexed user annotations', () => {
  it('projects chromosome-local, one-based inclusive annotations onto the assembly axis', () => {
    expect(indexedUserAnnotationDataset([annotation], assembly)?.records).toEqual([
      expect.objectContaining({
        chrom: 'chr2',
        start: 109,
        end: 120,
        name: 'reviewed locus',
        strand: '+',
        color: 0x16a34a,
        extra: expect.objectContaining({ userAnnotationId: 'annotation-1' }),
      }),
    ]);
  });

  it('resolves the topmost overlapping overlay using half-open hit boundaries', () => {
    const later = {
      ...annotation,
      id: 'annotation-2',
      annotation: { ...annotation.annotation, name: 'later overlay', start: 12, end: 18 },
    };
    expect(
      findIndexedUserAnnotationAtRendererPosition([annotation, later], 112, assembly)?.id
    ).toBe('annotation-2');
    expect(findIndexedUserAnnotationAtRendererPosition([annotation], 120, assembly)).toBeNull();
  });

  it('upserts and deletes by stable overlay id without mutating the input array', () => {
    const updated = {
      ...annotation,
      annotation: { ...annotation.annotation, name: 'renamed locus' },
    };
    const original = [annotation];
    const next = upsertIndexedUserAnnotation(original, updated);
    expect(next).toEqual([updated]);
    expect(original).toEqual([annotation]);
    expect(deleteIndexedUserAnnotation(next, annotation.id)).toEqual([]);
  });

  it('drops malformed restored records instead of painting invalid geometry', () => {
    const malformed = {
      ...annotation,
      id: 'bad',
      annotation: { ...annotation.annotation, start: 0 },
    };
    expect(indexedUserAnnotationDataset([malformed], assembly)).toBeNull();
  });
});
