import { describe, expect, it } from 'vitest';

import { cullFeaturesToViewport, featureLaneY, featureRowHeight } from './annotation-track-coords';

describe('cullFeaturesToViewport', () => {
  const features = [
    { start: 0, end: 100 },
    { start: 90, end: 110 },
    { start: 200, end: 300 },
    { start: 400, end: 410 },
    { start: 500, end: 600 },
  ] as const;
  const viewport = { start: 100, end: 410 };

  it('drops features fully outside the viewport', () => {
    const out = cullFeaturesToViewport(features, viewport);
    expect(out).not.toContain(features[0]);
    expect(out).not.toContain(features[4]);
  });

  it('keeps features that overlap the viewport', () => {
    const out = cullFeaturesToViewport(features, viewport);
    expect(out).toContain(features[1]);
    expect(out).toContain(features[2]);
    expect(out).toContain(features[3]);
    expect(out).toHaveLength(3);
  });

  it('returns empty when the viewport is degenerate (end <= start)', () => {
    expect(cullFeaturesToViewport(features, { start: 200, end: 200 })).toEqual([]);
    expect(cullFeaturesToViewport(features, { start: 300, end: 200 })).toEqual([]);
  });

  it('treats edge-abutting features as non-overlapping', () => {
    const abutting = [{ start: 0, end: 100 }];
    expect(cullFeaturesToViewport(abutting, { start: 100, end: 200 })).toEqual([]);
  });

  it('preserves feature order', () => {
    const out = cullFeaturesToViewport(features, viewport);
    const expected = [features[1], features[2], features[3]];
    expect(out).toEqual(expected);
  });
});

describe('featureLaneY', () => {
  it('places lane 0 at y=0', () => {
    expect(featureLaneY(0, 8, 100)).toBe(0);
  });

  it('places lane N at y = N * laneHeight when room remains', () => {
    expect(featureLaneY(3, 8, 100)).toBe(24);
  });

  it('clamps to keep the row inside the track', () => {
    expect(featureLaneY(100, 8, 40)).toBe(32);
  });

  it('returns 0 when laneHeightPx is non-positive', () => {
    expect(featureLaneY(5, 0, 100)).toBe(0);
    expect(featureLaneY(5, -8, 100)).toBe(0);
  });
});

describe('featureRowHeight', () => {
  it('returns laneHeight - 1 when there is room (1px gap between lanes)', () => {
    expect(featureRowHeight(0, 8, 100)).toBe(7);
  });

  it('shrinks to fit remaining track height', () => {
    expect(featureRowHeight(95, 8, 100)).toBe(5);
  });

  it('returns 0 when y is past the track bottom', () => {
    expect(featureRowHeight(100, 8, 100)).toBe(0);
    expect(featureRowHeight(120, 8, 100)).toBe(0);
  });
});
