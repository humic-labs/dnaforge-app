import { describe, expect, it } from 'vitest';
import {
  INITIAL_PORTAL_WIDTH_STABILITY,
  samplePortalReattachWidth,
} from './portal-reattach-width-stability';

describe('samplePortalReattachWidth', () => {
  it('rejects a three-frame intermediate width and settles on the restored width', () => {
    let state = INITIAL_PORTAL_WIDTH_STABILITY;
    const samples = [279, 519, 519, 519, 279, 279, 279, 279];
    const results = samples.map((width) => {
      const result = samplePortalReattachWidth(state, width);
      state = result.state;
      return result;
    });

    expect(results.slice(0, -1).every((result) => !result.settled)).toBe(true);
    expect(results.at(-1)).toEqual({
      state: {
        candidateWidth: 279,
        consecutiveSamples: 4,
      },
      settled: true,
    });
  });

  it('settles a genuinely changed width after four matching positive samples', () => {
    let state = INITIAL_PORTAL_WIDTH_STABILITY;
    const results = [640, 640, 640, 640].map((width) => {
      const result = samplePortalReattachWidth(state, width);
      state = result.state;
      return result;
    });

    expect(results.map((result) => result.settled)).toEqual([false, false, false, true]);
  });

  it('resets stability after a zero-width detached sample', () => {
    let state = INITIAL_PORTAL_WIDTH_STABILITY;
    for (const width of [640, 640, 0]) {
      state = samplePortalReattachWidth(state, width).state;
    }

    expect(state).toEqual(INITIAL_PORTAL_WIDTH_STABILITY);
  });
});
