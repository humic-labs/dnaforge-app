import { expect, it } from 'vitest';
import { adjustAnnotationsForInsert } from './annotation-coordinate-edit';
import type { Annotation } from './types';

it.each([1, -1] as const)(
  'preserves repeated origin-crossing join order on strand %s',
  (direction) => {
    const annotation: Annotation = {
      name: 'ordered circular join',
      type: 'CDS',
      start: 8,
      end: 2,
      direction,
      segments: [
        { start: 8, end: 10 },
        { start: 1, end: 3 },
        { start: 8, end: 9 },
        { start: 1, end: 2 },
      ],
    };
    const original = structuredClone(annotation);
    expect(adjustAnnotationsForInsert([annotation], 4, 2, 10)[0]).toMatchObject({
      ...annotation,
      start: 10,
      end: 2,
      segments: [
        { start: 10, end: 12 },
        { start: 1, end: 3 },
        { start: 10, end: 11 },
        { start: 1, end: 2 },
      ],
    });
    expect(annotation).toEqual(original);
  }
);
