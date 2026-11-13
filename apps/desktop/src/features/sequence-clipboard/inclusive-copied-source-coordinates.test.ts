// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { inclusiveCopiedSourceCoordinates } from './rich-sequence-clipboard';

describe('inclusiveCopiedSourceCoordinates', () => {
  it('turns a 1-indexed exclusive end into the inclusive range Ask AI uses', () => {
    expect(inclusiveCopiedSourceCoordinates({ start: 10, end: 14 }, 100)).toEqual({
      start: 10,
      end: 13,
    });
  });

  it('keeps a circular origin wrap on the last base of the source', () => {
    expect(inclusiveCopiedSourceCoordinates({ start: 90, end: 0, wraps: true }, 100)).toEqual({
      start: 90,
      end: 100,
      wraps: true,
    });
  });

  it('marks a selection that crosses the origin as wrapping', () => {
    expect(inclusiveCopiedSourceCoordinates({ start: 90, end: 11, wraps: true }, 100)).toEqual({
      start: 90,
      end: 10,
      wraps: true,
    });
  });

  it('rejects a range that is not 1-indexed', () => {
    expect(inclusiveCopiedSourceCoordinates({ start: 0, end: 4 }, 100)).toBeNull();
  });
});
