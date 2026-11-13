import { describe, it, expect } from 'vitest';
import { pickTickStep } from '../ruler-ticks';

describe('pickTickStep', () => {
  it('returns step=1 at high zoom (many px per base)', () => {
    expect(pickTickStep(60)).toBe(1);
  });

  it('returns step=10 at medium zoom where 10 * pxPerBase >= 40', () => {
    expect(pickTickStep(4)).toBe(10);
  });

  it('returns larger steps at low zoom', () => {
    expect(pickTickStep(0.1)).toBe(500);
  });

  it('honors custom minPxBetweenLabels', () => {
    expect(pickTickStep(4, 100)).toBe(50);
  });

  it('clamps to 1 for non-positive pxPerBase', () => {
    expect(pickTickStep(0)).toBe(1);
    expect(pickTickStep(-1)).toBe(1);
  });

  it('returns largest nice step when no candidate satisfies spacing', () => {
    expect(pickTickStep(0.00001)).toBe(50_000);
  });
});
