// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { autoZoomToFeature } from './auto-zoom-to-feature';

const CHR_LEN = 135_086_622;

describe('autoZoomToFeature', () => {
  it('zooms IN when feature is much smaller than viewport (~0% occupancy)', () => {
    const r = autoZoomToFeature({
      featureStart: 63_506_084,
      featureEnd: 63_516_772,
      viewport: { start: 0, end: CHR_LEN },
      genomeLength: CHR_LEN,
    });
    const newWidth = r.end - r.start;
    const featureWidth = 63_516_772 - 63_506_084;
    expect(newWidth).toBeGreaterThan(featureWidth);
    expect(newWidth).toBeLessThan(featureWidth * 10);
    const featureCenter = (63_506_084 + 63_516_772) / 2;
    const viewportCenter = (r.start + r.end) / 2;
    expect(Math.abs(featureCenter - viewportCenter)).toBeLessThan(5);
  });

  it('zooms OUT when feature is larger than half the viewport', () => {
    const r = autoZoomToFeature({
      featureStart: 63_506_000,
      featureEnd: 63_516_000,
      viewport: { start: 63_507_000, end: 63_515_000 },
      genomeLength: CHR_LEN,
    });
    const newWidth = r.end - r.start;
    const featureWidth = 63_516_000 - 63_506_000;
    expect(newWidth).toBeGreaterThan(featureWidth);
    expect(newWidth / featureWidth).toBeGreaterThan(2.5);
    expect(newWidth / featureWidth).toBeLessThan(4);
  });

  it('pans only (preserves zoom) when occupancy is in the comfortable band', () => {
    const viewportWidth = 40_000;
    const r = autoZoomToFeature({
      featureStart: 100_000_000,
      featureEnd: 100_010_000,
      viewport: { start: 99_990_000, end: 99_990_000 + viewportWidth },
      genomeLength: CHR_LEN,
    });
    expect(r.end - r.start).toBe(viewportWidth);
    const featureCenter = (100_000_000 + 100_010_000) / 2;
    const viewportCenter = (r.start + r.end) / 2;
    expect(Math.abs(featureCenter - viewportCenter)).toBeLessThan(5);
  });

  it('clamps the resulting viewport to [0, genomeLength] when feature is near the start', () => {
    const r = autoZoomToFeature({
      featureStart: 100,
      featureEnd: 500,
      viewport: { start: 0, end: CHR_LEN },
      genomeLength: CHR_LEN,
    });
    expect(r.start).toBeGreaterThanOrEqual(0);
    expect(r.end).toBeLessThanOrEqual(CHR_LEN);
  });

  it('clamps to the right edge when feature is near the end of the chromosome', () => {
    const r = autoZoomToFeature({
      featureStart: CHR_LEN - 500,
      featureEnd: CHR_LEN - 100,
      viewport: { start: 0, end: CHR_LEN },
      genomeLength: CHR_LEN,
    });
    expect(r.end).toBeLessThanOrEqual(CHR_LEN);
    expect(r.start).toBeGreaterThan(0);
  });

  it('handles feature exactly equal to current viewport (50% occupancy = boundary)', () => {
    const r = autoZoomToFeature({
      featureStart: 1_000,
      featureEnd: 2_000,
      viewport: { start: 0, end: 2_000 },
      genomeLength: CHR_LEN,
    });
    expect(r.end - r.start).toBe(2_000);
  });

  it('enforces a minimum viewport width (no degenerate 0-bp viewports)', () => {
    const r = autoZoomToFeature({
      featureStart: 1_000,
      featureEnd: 1_001,
      viewport: { start: 0, end: CHR_LEN },
      genomeLength: CHR_LEN,
    });
    expect(r.end - r.start).toBeGreaterThanOrEqual(10);
  });

  it('does not produce a viewport longer than the genome', () => {
    const r = autoZoomToFeature({
      featureStart: 0,
      featureEnd: CHR_LEN,
      viewport: { start: 0, end: 1_000 },
      genomeLength: CHR_LEN,
    });
    expect(r.end - r.start).toBeLessThanOrEqual(CHR_LEN);
  });
});
