import { expect, it } from 'vitest';
import { clipMorphPolygon } from './webgl-row-morph';

it('reveals a text tile by cropping its UV coordinates without changing pixels per texel', () => {
  const cropped = clipMorphPolygon(
    [
      [10, 46, 0, 0],
      [50, 46, 1, 0],
      [50, 64, 1, 1],
      [10, 64, 0, 1],
    ],
    0,
    54
  );
  expect(Math.min(...cropped.map((v) => v[1]))).toBe(46);
  expect(Math.max(...cropped.map((v) => v[1]))).toBe(54);
  for (const vertex of cropped) {
    expect(vertex[2]).toBeCloseTo((vertex[0] - 10) / 40);
    expect(vertex[3]).toBeCloseTo((vertex[1] - 46) / 18);
  }
});

it('does not submit a hidden annotation into the following nucleotide track', () => {
  expect(
    clipMorphPolygon(
      [
        [10, 46, 0, 0],
        [50, 46, 1, 0],
        [50, 64, 1, 1],
        [10, 64, 0, 1],
      ],
      0,
      22
    )
  ).toEqual([]);
});

it('clips both edges of a triangle while retaining linear texture coordinates', () => {
  const cropped = clipMorphPolygon(
    [
      [0, 0, 0, 0],
      [20, 20, 1, 1],
      [0, 20, 0, 1],
    ],
    5,
    15
  );
  for (const vertex of cropped) {
    expect(vertex[1]).toBeGreaterThanOrEqual(5);
    expect(vertex[1]).toBeLessThanOrEqual(15);
    expect(vertex[2]).toBeCloseTo(vertex[0] / 20);
    expect(vertex[3]).toBeCloseTo(vertex[1] / 20);
  }
});
