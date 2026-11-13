import { describe, it, expect } from 'vitest';
import {
  adjustAnnotationsForInsert,
  adjustAnnotationsForDelete,
  cleanSequenceFromEditorState,
  createInitialState,
} from './useEditorState';
import type { Annotation } from '@waypoint/sequence-utils';

function makeAnnotation(
  name: string,
  start: number,
  end: number,
  locationString?: string
): Annotation {
  return {
    name,
    type: 'CDS',
    start,
    end,
    strand: 1,
    qualifiers: locationString ? { _locationString: [locationString] } : {},
    color: '#00ff00',
  };
}

function cleanDraft(state: {
  sequence: string;
  annotations: Annotation[];
  deletedRanges: Array<{ start: number; end: number }>;
}) {
  const draft = {
    ...createInitialState(state.sequence, state.annotations),
    deletedRanges: state.deletedRanges,
  };
  const clean = cleanSequenceFromEditorState(draft);
  return { cleanSequence: clean.sequence, cleanAnnotations: clean.annotations };
}

describe('adjustAnnotationsForInsert', () => {
  it('shifts annotations after the insertion point', () => {
    const anns = [makeAnnotation('promoter', 3, 6, '3..6')];
    const result = adjustAnnotationsForInsert(anns, 0, 3);
    expect(result[0].start).toBe(6);
    expect(result[0].end).toBe(9);
    expect(result[0].qualifiers._locationString).toBeUndefined();
  });

  it('expands annotations when inserting within them', () => {
    const anns = [makeAnnotation('gene', 3, 6, '3..6')];
    const result = adjustAnnotationsForInsert(anns, 4, 2);
    expect(result[0].start).toBe(3);
    expect(result[0].end).toBe(8);
    expect(result[0].qualifiers._locationString).toBeUndefined();
  });

  it('preserves _locationString for unmodified annotations before insertion', () => {
    const anns = [makeAnnotation('before', 1, 2, '1..2')];
    const result = adjustAnnotationsForInsert(anns, 5, 3);
    expect(result[0].start).toBe(1);
    expect(result[0].end).toBe(2);
    expect(result[0].qualifiers._locationString?.[0]).toBe('1..2');
  });
});

describe('adjustAnnotationsForDelete', () => {
  it('shifts annotations after the deletion', () => {
    const anns = [makeAnnotation('gene', 5, 10, '5..10')];
    const result = adjustAnnotationsForDelete(anns, 2, 4);
    expect(result[0].start).toBe(3);
    expect(result[0].end).toBe(8);
    expect(result[0].qualifiers._locationString).toBeUndefined();
  });

  it('shrinks annotations that span the deletion', () => {
    const anns = [makeAnnotation('gene', 3, 10, '3..10')];
    const result = adjustAnnotationsForDelete(anns, 5, 7);
    expect(result[0].start).toBe(3);
    expect(result[0].end).toBe(8);
    expect(result[0].qualifiers._locationString).toBeUndefined();
  });

  it('removes annotations entirely within the deletion', () => {
    const anns = [makeAnnotation('gene', 3, 5, '3..5')];
    const result = adjustAnnotationsForDelete(anns, 2, 6);
    expect(result).toHaveLength(0);
  });

  it('preserves _locationString for unaffected annotations', () => {
    const anns = [makeAnnotation('gene', 1, 2, '1..2')];
    const result = adjustAnnotationsForDelete(anns, 5, 7);
    expect(result[0].start).toBe(1);
    expect(result[0].end).toBe(2);
    expect(result[0].qualifiers._locationString?.[0]).toBe('1..2');
  });
});

describe('clean projection: annotations adjusted for deletions', () => {
  it('returns correctly adjusted annotations after single deletion', () => {
    const anns = [makeAnnotation('gene', 5, 10, '5..10')];
    const result = cleanDraft({
      sequence: 'ATCGATCGATCG',
      annotations: anns,
      deletedRanges: [{ start: 2, end: 4 }],
    });
    expect(result.cleanSequence).toBe('ATATCGATCG');
    expect(result.cleanAnnotations[0].start).toBe(3);
    expect(result.cleanAnnotations[0].end).toBe(8);
    expect(result.cleanAnnotations[0].qualifiers._locationString).toBeUndefined();
  });

  it('returns correctly adjusted annotations after deletion within annotation', () => {
    const anns = [makeAnnotation('gene', 3, 10, '3..10')];
    const result = cleanDraft({
      sequence: 'AABBBBBBCC',
      annotations: anns,
      deletedRanges: [{ start: 5, end: 7 }],
    });
    expect(result.cleanAnnotations[0].start).toBe(3);
    expect(result.cleanAnnotations[0].end).toBe(8);
  });

  it('handles multiple non-adjacent deletions', () => {
    const anns = [makeAnnotation('gene', 5, 15, '5..15')];
    const result = cleanDraft({
      sequence: 'ABCDEFGHIJKLMNOP',
      annotations: anns,
      deletedRanges: [
        { start: 1, end: 3 },
        { start: 10, end: 12 },
      ],
    });
    expect(result.cleanAnnotations[0].start).toBe(3);
    expect(result.cleanAnnotations[0].end).toBe(11);
  });
});

describe('clean projection: identity when nothing is soft-deleted', () => {
  it('returns the draft content itself, so callers can compare by reference', () => {
    const draft = createInitialState('ATCG', [makeAnnotation('gene', 1, 2)]);
    const clean = cleanSequenceFromEditorState(draft);
    expect(clean.sequence).toBe(draft.sequence);
    expect(clean.annotations).toBe(draft.annotations);
    expect(clean.pendingPrimerBindings).toBe(draft.pendingPrimerBindings);
  });

  it('drops staged primer bindings that overlap a soft deletion and shifts the rest', () => {
    const draft = {
      ...createInitialState('ATCGATCGATCG', []),
      deletedRanges: [{ start: 2, end: 4 }],
      pendingPrimerBindings: [
        { pendingId: 'pending-inside', primerId: 'inside', start: 1, end: 3, strand: 1 as const },
        { pendingId: 'pending-after', primerId: 'after', start: 6, end: 9, strand: -1 as const },
      ],
    };
    expect(cleanSequenceFromEditorState(draft).pendingPrimerBindings).toEqual([
      { pendingId: 'pending-after', primerId: 'after', start: 4, end: 7, strand: -1 },
    ]);
  });
});
