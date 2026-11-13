import { describe, expect, it } from 'vitest';
import { getStadiumDimensions } from './stadium';

const narrowPanes = [
  { width: 279, height: 600, padding: 20 },
  { width: 160, height: 600, padding: 24 },
  { width: 44, height: 600, padding: 20 },
];

describe('assembly map circularity in a narrow drawer layout', () => {
  it.each(narrowPanes)(
    'keeps the actual backbone inside a $width × $height pane at every circularity',
    ({ width, height, padding }) => {
      for (const morph of [0, 1e-7, 0.01, 0.25, 0.5, 0.99, 1]) {
        const dims = getStadiumDimensions(width, height, morph, padding);
        for (const value of Object.values(dims)) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
        expect(dims.radius).toBeGreaterThan(0);
        expect(dims.width).toBeCloseTo(2 * dims.radius + dims.straightLength, 6);
        expect(dims.height).toBeCloseTo(2 * dims.radius, 6);
        expect(dims.totalLength).toBeCloseTo(
          2 * dims.straightLength + 2 * Math.PI * dims.radius,
          6
        );
        expect(dims.width).toBeLessThanOrEqual(width - 2 * padding + 1e-6);
        expect(dims.height).toBeLessThanOrEqual(height - 2 * padding + 1e-6);
      }
    }
  );

  it.each(narrowPanes)(
    'does not jump when a $width × $height map crosses the stadium boundary',
    ({ width, height, padding }) => {
      const stadium = getStadiumDimensions(width, height, 0, padding);
      const almostStadium = getStadiumDimensions(width, height, 1e-7, padding);
      for (const property of [
        'width',
        'height',
        'radius',
        'straightLength',
        'totalLength',
      ] as const) {
        expect(Math.abs(stadium[property] - almostStadium[property])).toBeLessThan(0.001);
      }
    }
  );

  it('preserves the established wide stadium and its perimeter', () => {
    expect(getStadiumDimensions(800, 400, 0, 80)).toEqual({
      width: 640,
      height: 240,
      radius: 120,
      straightLength: 400,
      totalLength: 800 + 240 * Math.PI,
    });
  });
});
