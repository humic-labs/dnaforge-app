// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { overwriteCoverageSlices, withViewportMaxDepth } from './tile-engine-coverage';

describe('tile-engine coverage composition helpers', () => {
  it('lets exact target zeros clear parent placeholder values', () => {
    const bins = [9, 9, 9, 9];
    const maxDepth = overwriteCoverageSlices(
      [
        {
          globalStart: 100,
          globalEnd: 104,
          binSize: 1,
          payload: {
            start: 100,
            end: 104,
            binSize: 1,
            bins: [0, 7, 0, 3],
            provenance: { exact: true, method: 'test' },
          },
        },
      ],
      100,
      1,
      bins
    );

    expect(bins).toEqual([0, 7, 0, 3]);
    expect(maxDepth).toBe(7);
  });

  it('does not derive a second viewport scale when source percentiles are authoritative', () => {
    const bins = new Proxy([1, 2, 3], {
      get(target, property, receiver) {
        if (property === 'length' || (typeof property === 'string' && /^\d+$/.test(property))) {
          throw new Error('viewport bins must not be scanned');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const coverage = {
      startBp: 0,
      bins,
      binSize: 64,
      maxDepth: 317,
      depthPercentiles: { p50: 30, p90: 80, p95: 100, p99: 140, max: 317 },
    };

    expect(withViewportMaxDepth(coverage, { globalStart: 0, globalEnd: 192, viewportPx: 3 })).toBe(
      coverage
    );
  });
});
