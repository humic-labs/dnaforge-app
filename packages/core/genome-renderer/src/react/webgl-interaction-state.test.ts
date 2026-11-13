import { describe, expect, it } from 'vitest';

import { resolveWebGLShiftClickRange } from './webgl-shift-selection';
import { recenterViewportRangeOnCamera } from './webgl-viewport-range';

describe('WebGL interaction state', () => {
  it.each([
    {
      name: 'extends a linear selection',
      input: {
        currentRange: [100, 150] as [number, number],
        rangeStart: 200,
        rangeEnd: 259,
        cursorPosition: null,
        genomeLength: 1000,
        circular: false,
        altKey: false,
      },
      expected: [100, 259],
    },
    {
      name: 'preserves a wrapped circular option-selection',
      input: {
        currentRange: [900, 100] as [number, number],
        rangeStart: 700,
        rangeEnd: 750,
        cursorPosition: null,
        genomeLength: 1000,
        circular: true,
        altKey: true,
      },
      expected: [700, 100],
    },
  ])('$name', ({ input, expected }) => {
    expect(resolveWebGLShiftClickRange(input)).toEqual(expected);
  });

  it.each([
    {
      name: 'recenters the viewport marker',
      centerBp: 500,
      circular: true,
      expected: [450, 550],
    },
    {
      name: 'wraps the viewport marker around the origin',
      centerBp: 975,
      circular: true,
      expected: [925, 25],
    },
    {
      name: 'clamps a linear viewport marker to the sequence',
      centerBp: 20,
      circular: false,
      expected: [0, 100],
    },
  ])('$name', ({ centerBp, circular, expected }) => {
    expect(
      recenterViewportRangeOnCamera({
        currentRange: [100, 200],
        centerBp,
        genomeLength: 1000,
        circular,
      })
    ).toEqual(expected);
  });
});
