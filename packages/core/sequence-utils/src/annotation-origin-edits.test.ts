import { describe, expect, it } from 'vitest';
import {
  adjustAnnotationsForDelete,
  adjustAnnotationsForInsert,
} from './annotation-coordinate-edit';
import type { Annotation } from './types';

describe('origin-spanning annotation coordinate edits', () => {
  for (const direction of [1, -1] as const) {
    for (const segmented of [false, true]) {
      const annotation: Annotation = {
        name: 'origin feature',
        type: 'rep_origin',
        start: 8,
        end: 3,
        direction,
        qualifiers: { note: ['retained'] },
        ...(segmented
          ? {
              segments: [
                { start: 8, end: 10 },
                { start: 1, end: 3 },
              ],
            }
          : {}),
      };

      it(`keeps both arms through gap insertion and deletion (${direction}, ${segmented})`, () => {
        const inserted = adjustAnnotationsForInsert([annotation], 4, 2, 10);
        expect(inserted).toMatchObject([
          {
            ...annotation,
            start: 10,
            end: 3,
            ...(segmented
              ? {
                  segments: [
                    { start: 10, end: 12 },
                    { start: 1, end: 3 },
                  ],
                }
              : {}),
          },
        ]);
        if (!segmented) expect(inserted[0].segments).toBeUndefined();
        expect(adjustAnnotationsForDelete(inserted, 4, 6, 12)).toMatchObject([
          {
            ...annotation,
            segments: [
              { start: 8, end: 10 },
              { start: 1, end: 3 },
            ],
          },
        ]);
      });

      it(`retains surviving arms and removes only an entirely deleted feature (${direction}, ${segmented})`, () => {
        expect(adjustAnnotationsForDelete([annotation], 0, 2, 10)).toMatchObject([
          {
            ...annotation,
            start: 6,
            end: 1,
            segments: [
              { start: 6, end: 8 },
              { start: 1, end: 1 },
            ],
          },
        ]);
        expect(adjustAnnotationsForDelete([annotation], 0, 3, 10)).toMatchObject([
          {
            ...annotation,
            start: 5,
            end: 7,
            segments: [{ start: 5, end: 7 }],
          },
        ]);
        expect(adjustAnnotationsForDelete([annotation], 7, 10, 10)).toMatchObject([
          {
            ...annotation,
            start: 1,
            end: 3,
            segments: [{ start: 1, end: 3 }],
          },
        ]);
        expect(adjustAnnotationsForDelete([annotation], 0, 10, 10)).toEqual([]);
        expect(annotation.start).toBe(8);
        expect(annotation.end).toBe(3);
      });
    }
  }
});
