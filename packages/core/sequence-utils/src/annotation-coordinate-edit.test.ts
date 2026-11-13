import { describe, expect, it } from 'vitest';
import type { Annotation } from './types';
import {
  adjustAnnotationsForDelete,
  adjustAnnotationsForInsert,
  mapAnnotationThroughSequenceEditTransition,
} from './annotation-coordinate-edit';

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    name: 'feature',
    type: 'CDS',
    start: 50,
    end: 250,
    direction: 1,
    ...overrides,
  };
}

describe('shared annotation coordinate editing', () => {
  it('derives joined-feature bounds from surviving segments and removes an empty join', () => {
    const joined = annotation({
      start: 3,
      end: 8,
      direction: -1,
      segments: [
        { start: 3, end: 4 },
        { start: 7, end: 8 },
      ],
      qualifiers: { note: ['preserved'], _locationString: ['complement(join(3..4,7..8))'] },
    });
    const leftRemoved = adjustAnnotationsForDelete([joined], 2, 4);
    expect(leftRemoved).toEqual([
      annotation({
        start: 5,
        end: 6,
        direction: -1,
        segments: [{ start: 5, end: 6 }],
        qualifiers: { note: ['preserved'] },
      }),
    ]);
    expect(adjustAnnotationsForDelete(leftRemoved, 4, 6)).toEqual([]);
    expect(adjustAnnotationsForDelete([joined], 6, 8)).toEqual([
      annotation({
        start: 3,
        end: 4,
        direction: -1,
        segments: [{ start: 3, end: 4 }],
        qualifiers: { note: ['preserved'] },
      }),
    ]);
  });

  it('preserves ordered surviving join segments and empty-segment legacy ranges', () => {
    const joined = annotation({
      start: 3,
      end: 8,
      segments: [
        { start: 3, end: 4 },
        { start: 7, end: 8 },
      ],
    });
    expect(adjustAnnotationsForDelete([joined], 4, 6)).toEqual([
      annotation({
        start: 3,
        end: 6,
        segments: [
          { start: 3, end: 4 },
          { start: 5, end: 6 },
        ],
      }),
    ]);
    expect(
      adjustAnnotationsForDelete([annotation({ start: 3, end: 6, segments: [] })], 2, 3)
    ).toEqual([annotation({ start: 3, end: 5, segments: [] })]);
  });

  it('preserves the editor insertion and deletion conventions', () => {
    expect(adjustAnnotationsForInsert([annotation()], 10, 2)[0]).toMatchObject({
      start: 52,
      end: 252,
    });
    expect(adjustAnnotationsForInsert([annotation()], 100, 2)[0]).toMatchObject({
      start: 50,
      end: 252,
    });
    expect(adjustAnnotationsForDelete([annotation()], 10, 12)[0]).toMatchObject({
      start: 48,
      end: 248,
    });
  });

  it('maps baseline-coordinate operations with accumulated offsets', () => {
    expect(
      mapAnnotationThroughSequenceEditTransition(annotation(), {
        beforeLength: 500,
        afterLength: 501,
        operations: [
          { kind: 'insert', at: 10, length: 2 },
          { kind: 'delete', start: 20, end: 21 },
          { kind: 'substitute', start: 100, end: 104 },
        ],
      })
    ).toEqual({
      annotation: annotation({ start: 51, end: 251 }),
      substitutionOverlap: true,
    });
  });

  it('removes a fully deleted annotation', () => {
    expect(
      mapAnnotationThroughSequenceEditTransition(annotation(), {
        beforeLength: 500,
        afterLength: 299,
        operations: [{ kind: 'delete', start: 49, end: 250 }],
      })
    ).toEqual({ annotation: null, substitutionOverlap: false });
  });

  it('refuses origin-spanning annotations instead of flattening them', () => {
    expect(() =>
      mapAnnotationThroughSequenceEditTransition(annotation({ start: 450, end: 20 }), {
        beforeLength: 500,
        afterLength: 501,
        operations: [{ kind: 'insert', at: 10, length: 1 }],
      })
    ).toThrow(/Origin-spanning/);
  });

  it('rejects malformed transition length claims', () => {
    expect(() =>
      mapAnnotationThroughSequenceEditTransition(annotation(), {
        beforeLength: 500,
        afterLength: 500,
        operations: [{ kind: 'insert', at: 10, length: 1 }],
      })
    ).toThrow(/length delta/);
  });
});
