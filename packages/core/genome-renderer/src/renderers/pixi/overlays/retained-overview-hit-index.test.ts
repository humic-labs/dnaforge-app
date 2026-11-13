import { describe, expect, it } from 'vitest';

import { retainedOverviewHitCandidates, type RetainedHitBin } from './retained-overview-hit-index';

function bins(seed: number, count: number, genomeLength: number): RetainedHitBin[] {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  return Array.from({ length: count }, () => {
    const startBp = Math.floor(random() * genomeLength);
    const lengthBp = 50 + Math.floor(random() * (random() < 0.05 ? 50_000 : 900));
    return { startBp, endBp: Math.min(genomeLength, startBp + lengthBp) };
  });
}

describe('retainedOverviewHitCandidates', () => {
  const genomeLength = 4_641_652;
  const pixelsPerBp = 2 ** -9;
  const toleranceBp = 8 / pixelsPerBp;

  it('returns every bin that can contain the pointer, in descending index order', () => {
    const source = bins(7, 5_000, genomeLength);
    for (const bp of [12, 1_000, 250_000, 2_320_826, 4_640_000, genomeLength - 3]) {
      const path = { pixelsPerBp, nearestBpAt: () => bp };
      const candidates = retainedOverviewHitCandidates(source, path, 0, 0, genomeLength);
      if (!candidates) throw new Error('expected candidates');
      const expected = source
        .map((bin, index) => ({ bin, index }))
        .filter(({ bin }) =>
          [bp, bp + genomeLength, bp - genomeLength].some(
            (query) => bin.startBp <= query + toleranceBp && bin.endBp >= query - toleranceBp
          )
        )
        .map(({ index }) => index)
        .sort((left, right) => right - left);
      expect(candidates).toStrictEqual(expected);
      expect(candidates.length).toBeLessThan(source.length / 10);
    }
  });

  it('scans everything when the path has no inverse mapping', () => {
    expect(
      retainedOverviewHitCandidates(bins(1, 10, genomeLength), { pixelsPerBp }, 0, 0, genomeLength)
    ).toBeNull();
  });
});
