import { describe, expect, it } from 'vitest';

import { unpackBpCoordinate } from '../overview/bp-coordinate-packing';
import { PILEUP_COVERAGE_ALPHA } from './pileup-coverage-resample';
import {
  coverageSignalInstancedPresentationAlpha,
  packCoverageSignalInstances,
} from './coverage-signal-instanced-layer';

describe('packCoverageSignalInstances', () => {
  it('packs one exact bp-anchored instance per coverage column', () => {
    const heights = new Float32Array([2, 6, 10]);
    const packed = new Float32Array(3 * 6);

    expect(
      packCoverageSignalInstances(packed, {
        viewStartBp: 248_956_400,
        viewEndBp: 248_956_430,
        segmentHeights: heights,
      })
    ).toBe(3);

    const instance = (index: number) => {
      const offset = index * 6;
      return {
        start: unpackBpCoordinate(packed[offset]!, packed[offset + 1]!),
        end: unpackBpCoordinate(packed[offset + 2]!, packed[offset + 3]!),
        leftHeight: packed[offset + 4],
        rightHeight: packed[offset + 5],
      };
    };

    expect(instance(0)).toEqual({
      start: 248_956_400,
      end: 248_956_410,
      leftHeight: 2,
      rightHeight: 4,
    });
    expect(instance(1)).toEqual({
      start: 248_956_410,
      end: 248_956_420,
      leftHeight: 4,
      rightHeight: 8,
    });
    expect(instance(2)).toEqual({
      start: 248_956_420,
      end: 248_956_430,
      leftHeight: 8,
      rightHeight: 10,
    });
  });

  it('fails closed for an invalid range or undersized target', () => {
    expect(() =>
      packCoverageSignalInstances(new Float32Array(6), {
        viewStartBp: 10,
        viewEndBp: 10,
        segmentHeights: new Float32Array([1]),
      })
    ).toThrow('positive bp range');

    expect(() =>
      packCoverageSignalInstances(new Float32Array(5), {
        viewStartBp: 10,
        viewEndBp: 20,
        segmentHeights: new Float32Array([1]),
      })
    ).toThrow('target is smaller');
  });

  it('uses the shared pileup opacity for exact coverage transitions', () => {
    expect(coverageSignalInstancedPresentationAlpha(0.5)).toBe(PILEUP_COVERAGE_ALPHA * 0.5);
    expect(coverageSignalInstancedPresentationAlpha(2)).toBe(PILEUP_COVERAGE_ALPHA);
    expect(coverageSignalInstancedPresentationAlpha(-1)).toBe(0);
  });
});
