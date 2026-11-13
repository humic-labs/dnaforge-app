import { describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import { FloatingAnnotationClearanceIndex } from './floating-annotation-clearance-index';

const GENOME_LENGTH = 1000;
const BAR_HEIGHT = 14;

function feature(id: number, start: number, end: number, offset: number): Feature {
  return {
    id,
    type: 'gene',
    start,
    end,
    lane: offset,
    color: 0x3b82f6,
    direction: 'none',
    displayName: `feature ${id}`,
  };
}

function bruteMax(features: readonly Feature[], side: -1 | 1, start: number, end: number) {
  const candidates = features.flatMap((item) => {
    const intervals =
      item.end > item.start
        ? [[item.start, item.end]]
        : [
            [item.start, GENOME_LENGTH],
            [0, item.end],
          ];
    return intervals.some(([from, to]) => from <= end && to >= start) ? [item] : [];
  });
  const magnitudes = candidates.flatMap((item) => {
    const offset = item.lane ?? 0;
    if ((offset <= 0 ? -1 : 1) !== side) return [];
    return [side * (offset + (side * BAR_HEIGHT) / 2)];
  });
  return magnitudes.length === 0 ? null : Math.max(...magnitudes);
}

describe('FloatingAnnotationClearanceIndex', () => {
  it('preserves exact outward clearance at feature and query endpoints', () => {
    const features = [
      feature(1, 100, 250, -14),
      feature(2, 250, 400, -42),
      feature(3, 900, 80, 28),
      feature(4, 500, 700, 56),
    ];
    const index = new FloatingAnnotationClearanceIndex(
      features,
      GENOME_LENGTH,
      true,
      (item) => item.lane ?? 0,
      BAR_HEIGHT
    );
    for (const [start, end] of [
      [0, 0],
      [80, 80],
      [100, 100],
      [250, 250],
      [250.1, 300],
      [450, 499],
      [950, 1000],
      [0, GENOME_LENGTH],
    ]) {
      for (const side of [-1, 1] as const) {
        expect(index.maxOutwardMagnitude(side, start, end)).toBe(
          bruteMax(features, side, start, end)
        );
      }
    }
  });

  it('matches a direct overlap scan for dense mixed-side circular annotations', () => {
    let seed = 73;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const features = Array.from({ length: 300 }, (_, id) => {
      const start = Math.floor(next() * GENOME_LENGTH);
      const end = Math.floor(next() * GENOME_LENGTH);
      const offset = (1 + Math.floor(next() * 8)) * (next() < 0.5 ? -7 : 7);
      return feature(id + 1, start, end, offset);
    });
    const index = new FloatingAnnotationClearanceIndex(
      features,
      GENOME_LENGTH,
      true,
      (item) => item.lane ?? 0,
      BAR_HEIGHT
    );
    for (let query = 0; query < 200; query += 1) {
      const start = Math.floor(next() * GENOME_LENGTH);
      const end = start + Math.floor(next() * (GENOME_LENGTH - start));
      for (const side of [-1, 1] as const) {
        expect(index.maxOutwardMagnitude(side, start, end)).toBe(
          bruteMax(features, side, start, end)
        );
      }
    }
  });
});
