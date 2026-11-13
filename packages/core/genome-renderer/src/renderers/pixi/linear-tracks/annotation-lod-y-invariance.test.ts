import { describe, expect, test } from 'vitest';
import { featureLaneY } from './annotation-track-coords';

const LANE_HEIGHT = 14;
const LANE_GAP = 2;
const TRACK_HEIGHT = 400;

function laneContractScreenYStep(laneHeightPx: number, laneGapPx: number): number {
  return -(laneHeightPx + laneGapPx);
}

describe(' B2: annotation LOD Y-direction invariance', () => {
  test('sanity: the two tiers currently disagree on stacking direction (documents the bug)', () => {
    const pyramidStep =
      featureLaneY(1, LANE_HEIGHT, TRACK_HEIGHT) - featureLaneY(0, LANE_HEIGHT, TRACK_HEIGHT);
    const contractStep = laneContractScreenYStep(LANE_HEIGHT, LANE_GAP);
    expect(Math.sign(pyramidStep)).toBe(1);
    expect(Math.sign(contractStep)).toBe(-1);
  });

  test.fails(
    'INVARIANT (B2): pyramid/detail tier must stack lanes the SAME direction as the lane contract',
    () => {
      const pyramidStep =
        featureLaneY(1, LANE_HEIGHT, TRACK_HEIGHT) - featureLaneY(0, LANE_HEIGHT, TRACK_HEIGHT);
      const contractStep = laneContractScreenYStep(LANE_HEIGHT, LANE_GAP);
      expect(Math.sign(pyramidStep)).toBe(Math.sign(contractStep));
    }
  );
});
