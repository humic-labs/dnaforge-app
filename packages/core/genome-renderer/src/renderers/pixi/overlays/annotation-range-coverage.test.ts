import { describe, expect, it } from 'vitest';

import { rangesCoverInterval } from './annotation-range-coverage';

describe('rangesCoverInterval', () => {
  it('returns false for empty or invalid ranges', () => {
    expect(rangesCoverInterval([], 0, 10, 100)).toBe(false);
    expect(rangesCoverInterval(null, 0, 10, 100)).toBe(false);
    expect(rangesCoverInterval([{ startBp: 0, endBp: 10 }], 10, 10, 100)).toBe(false);
  });

  it('requires contiguous union coverage of the camera interval', () => {
    expect(
      rangesCoverInterval(
        [
          { startBp: 0, endBp: 5 },
          { startBp: 5, endBp: 12 },
        ],
        0,
        10,
        100
      )
    ).toBe(true);
    expect(
      rangesCoverInterval(
        [
          { startBp: 0, endBp: 4 },
          { startBp: 6, endBp: 12 },
        ],
        0,
        10,
        100
      )
    ).toBe(false);
  });

  it('accepts out-of-order ranges', () => {
    expect(
      rangesCoverInterval(
        [
          { startBp: 50, endBp: 100 },
          { startBp: 0, endBp: 50 },
        ],
        0,
        100,
        100
      )
    ).toBe(true);
  });
});
