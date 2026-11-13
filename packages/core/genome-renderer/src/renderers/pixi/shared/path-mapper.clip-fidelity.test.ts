import { describe, it, expect } from 'vitest';
import { StadiumPathMapper, type StadiumPathInputs } from './path-mapper';
import type { StadiumDimensions } from '../../../geometry/stadium';

function mapper(opts: {
  genomeLength: number;
  viewOffset: number;
  zoom?: number;
  viewportWidth?: number;
  geometryHeight?: number;
}): StadiumPathMapper {
  const dims: StadiumDimensions = {
    width: 372,
    height: 372,
    radius: 186,
    straightLength: 0,
    totalLength: 1168.672467135403,
  } as StadiumDimensions;
  const zoom = opts.zoom ?? 1;
  const viewportWidth = opts.viewportWidth ?? 400;
  const geometryHeight = opts.geometryHeight ?? 400;
  const inputs: StadiumPathInputs = {
    genomeLength: opts.genomeLength,
    viewOffset: opts.viewOffset,
    zoom,
    dims,
    ox: 0,
    oy: 0,
    stagePosX: 0,
    stagePosY: 0,
    bpPerPixel: opts.genomeLength / viewportWidth,
    hasSequence: false,
    viewportWidth,
    viewportHeight: geometryHeight,
    geometryHeight,
  };
  return new StadiumPathMapper(inputs);
}

function outerSampleCount(pts: number[]): number {
  return Math.floor(pts.length / 2 / 2);
}

describe('StadiumPathMapper — window clipping never widens a feature', () => {
  it('declines to clip when the circular intersection is two pieces', () => {
    const genomeLength = 1_072_315;
    const pm = mapper({ genomeLength, viewOffset: 0, zoom: 40 });
    const windowLen = pm.viewEndBp - pm.viewStartBp;

    const gapLen = Math.floor(windowLen / 2);
    const featureLen = genomeLength - gapLen;
    expect(featureLen).toBeGreaterThan(windowLen);
    expect(gapLen).toBeLessThan(windowLen);

    const gapStart = pm.viewStartBp + Math.floor(windowLen / 4);
    const startBp = (((gapStart + gapLen) % genomeLength) + genomeLength) % genomeLength;

    const clipped = pm.featurePolygonAt(startBp, startBp + featureLen, -14, 6);

    const unclipped = mapper({
      genomeLength,
      viewOffset: 0,
      zoom: 40,
      viewportWidth: 40_000,
      geometryHeight: 40_000,
    }).featurePolygonAt(startBp, startBp + featureLen, -14, 6);

    expect(outerSampleCount(clipped)).toBe(outerSampleCount(unclipped));
  });

  it('still clips a feature whose gap is outside the window', () => {
    const genomeLength = 1_072_315;
    const pm = mapper({ genomeLength, viewOffset: 0, zoom: 40 });
    const windowLen = pm.viewEndBp - pm.viewStartBp;

    const gapLen = Math.floor(windowLen / 2);
    const featureLen = genomeLength - gapLen;
    const gapStart = pm.viewStartBp + Math.floor(genomeLength / 2);
    const startBp = (((gapStart + gapLen) % genomeLength) + genomeLength) % genomeLength;

    const clipped = pm.featurePolygonAt(startBp, startBp + featureLen, -14, 6);
    const unclipped = mapper({
      genomeLength,
      viewOffset: 0,
      zoom: 40,
      viewportWidth: 40_000,
      geometryHeight: 40_000,
    }).featurePolygonAt(startBp, startBp + featureLen, -14, 6);

    expect(outerSampleCount(clipped)).toBeLessThan(outerSampleCount(unclipped));
  });

  it('clips a whole-molecule feature to the window (the  case)', () => {
    const genomeLength = 1_072_315;
    const pm = mapper({ genomeLength, viewOffset: 0.5, zoom: 40 });

    const clipped = pm.featurePolygonAt(0, genomeLength, -14, 6);
    const unclipped = mapper({
      genomeLength,
      viewOffset: 0.5,
      zoom: 40,
      viewportWidth: 40_000,
      geometryHeight: 40_000,
    }).featurePolygonAt(0, genomeLength, -14, 6);

    expect(outerSampleCount(clipped)).toBeLessThan(outerSampleCount(unclipped));
  });
});
