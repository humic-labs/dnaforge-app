import { describe, expect, it } from 'vitest';
import { digestFocusMaskSegments } from './digest-focus-mask';

describe('digestFocusMaskSegments', () => {
  it('returns coordinate complement segments for a non-wrapping focused fragment', () => {
    expect(digestFocusMaskSegments([20, 60], 100)).toEqual([
      { start: 0, end: 20 },
      { start: 60, end: 100 },
    ]);
  });

  it('returns one complement segment for a wrapping focused fragment', () => {
    expect(digestFocusMaskSegments([80, 20], 100)).toEqual([{ start: 20, end: 80 }]);
  });

  it('treats an equal start/end range as full focus for one-cut circular digests', () => {
    expect(digestFocusMaskSegments([30, 30], 100)).toEqual([]);
  });
});
