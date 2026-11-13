import { describe, it, expect } from 'vitest';
import { findOrfAtPointInBand, findOrfAtPoint, type OrfBand } from '../orf-hit-test';
import { ORF_LANE_GAP } from '../orf-drawing';
import { TRANSLATION_AA_HEIGHT_RATIO } from '../layout-constants';
import type { ORFWithLane } from '../types';

const ROW_HEIGHT = 20;
const LANE_HEIGHT = ROW_HEIGHT * TRANSLATION_AA_HEIGHT_RATIO;
const LANE_STEP = LANE_HEIGHT + ORF_LANE_GAP;

const mkBand = (bandY: number, laneCount: number, orfs: ORFWithLane[]): OrfBand => ({
  bandY,
  bandHeight: laneCount * LANE_STEP,
  laneCount,
  laneHeight: LANE_HEIGHT,
  orfs,
});

const orf = (start: number, end: number, lane: number, strand: '+' | '-' = '+'): ORFWithLane => ({
  start,
  end,
  frame: 1,
  strand,
  length: end - start + 1,
  lane,
});

describe('findOrfAtPointInBand', () => {
  it('returns null when click is above the band', () => {
    const band = mkBand(100, 2, [orf(50, 250, 0)]);
    expect(findOrfAtPointInBand(band, 99, 100)).toBeNull();
  });

  it('returns null when click is below the band', () => {
    const band = mkBand(100, 2, [orf(50, 250, 0)]);
    expect(findOrfAtPointInBand(band, 100 + 2 * LANE_STEP + 1, 100)).toBeNull();
  });

  it('returns null when click lands in the gap below a lane chevron', () => {
    const band = mkBand(100, 2, [orf(50, 250, 0)]);
    expect(findOrfAtPointInBand(band, 100 + LANE_HEIGHT + 1, 100)).toBeNull();
  });

  it('returns null when position is outside the ORF range', () => {
    const band = mkBand(100, 1, [orf(50, 250, 0)]);
    expect(findOrfAtPointInBand(band, 105, 49)).toBeNull();
    expect(findOrfAtPointInBand(band, 105, 251)).toBeNull();
  });

  it('lane-aware: overlapping ORFs in different lanes resolve to the clicked lane', () => {
    const band = mkBand(100, 2, [orf(50, 250, 0), orf(100, 200, 1)]);

    const lane0Hit = findOrfAtPointInBand(band, 105, 150);
    expect(lane0Hit).not.toBeNull();
    expect(lane0Hit!.start).toBe(50);
    expect(lane0Hit!.end).toBe(250);

    const lane1Hit = findOrfAtPointInBand(band, 100 + LANE_STEP + 5, 150);
    expect(lane1Hit).not.toBeNull();
    expect(lane1Hit!.start).toBe(100);
    expect(lane1Hit!.end).toBe(200);
  });

  it('returns null when laneCount=0 even with ORFs in the array', () => {
    const band: OrfBand = {
      bandY: 100,
      bandHeight: 0,
      laneCount: 0,
      laneHeight: LANE_HEIGHT,
      orfs: [orf(50, 250, 0)],
    };
    expect(findOrfAtPointInBand(band, 105, 100)).toBeNull();
  });
});

describe('findOrfAtPoint (forward + reverse)', () => {
  it('checks forward band before reverse', () => {
    const forward = mkBand(100, 1, [orf(50, 250, 0, '+')]);
    const reverse = mkBand(200, 1, [orf(50, 250, 0, '-')]);

    expect(findOrfAtPoint(forward, reverse, 105, 100)?.strand).toBe('+');
    expect(findOrfAtPoint(forward, reverse, 205, 100)?.strand).toBe('-');
  });

  it('returns null when click hits neither band', () => {
    const forward = mkBand(100, 1, [orf(50, 250, 0, '+')]);
    const reverse = mkBand(200, 1, [orf(50, 250, 0, '-')]);
    expect(findOrfAtPoint(forward, reverse, 150, 100)).toBeNull();
  });
});
