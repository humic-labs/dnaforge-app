import { describe, it, expect } from 'vitest';
import {
  getStadiumDimensions,
  normalizedPosToPoint,
  seqPosToPoint,
  seqPosToPointNorm,
  computeOffsetPoint,
  clickToSeqPos,
  closestSeqPosOnBackbone,
} from './stadium';

describe('getStadiumDimensions', () => {
  it('computes stadium shape at morph=0', () => {
    const dims = getStadiumDimensions(800, 400, 0);
    expect(dims.radius).toBe(200);
    expect(dims.straightLength).toBe(400);
    expect(dims.totalLength).toBeCloseTo(2 * 400 + 2 * Math.PI * 200);
  });

  it('computes circle shape at morph=1', () => {
    const dims = getStadiumDimensions(800, 400, 1);
    expect(dims.straightLength).toBeCloseTo(0, 5);
    expect(dims.radius).toBeGreaterThan(0);
  });

  it('preserves perimeter across morph values', () => {
    const dims0 = getStadiumDimensions(800, 400, 0);
    const dims05 = getStadiumDimensions(800, 400, 0.5);
    expect(dims05.totalLength).toBeGreaterThan(0);
    expect(dims05.totalLength).toBeLessThanOrEqual(dims0.totalLength);
  });

  it('subtracts padding from effective size', () => {
    const dims = getStadiumDimensions(800, 400, 0, 80);
    expect(dims.radius).toBe(120);
    expect(dims.straightLength).toBe(400);
  });
});

describe('normalizedPosToPoint', () => {
  it('returns top-left area at pos=0', () => {
    const dims = getStadiumDimensions(800, 400, 0);
    const pt = normalizedPosToPoint(0, dims);
    expect(pt.segment).toBe('top');
    expect(pt.angle).toBe(0);
  });

  it('wraps pos=1 back to start', () => {
    const dims = getStadiumDimensions(800, 400, 0);
    const pt0 = normalizedPosToPoint(0, dims);
    const pt1 = normalizedPosToPoint(1, dims);
    expect(pt1.x).toBeCloseTo(pt0.x, 5);
    expect(pt1.y).toBeCloseTo(pt0.y, 5);
  });

  it('produces right-cap segment at ~25% for typical stadium', () => {
    const dims = getStadiumDimensions(800, 400, 0);
    const topEnd = dims.straightLength / dims.totalLength;
    const midRightCap = topEnd + 0.5 * ((Math.PI * dims.radius) / dims.totalLength);
    const pt = normalizedPosToPoint(midRightCap, dims);
    expect(pt.segment).toBe('right-cap');
  });
});

describe('seqPosToPoint / seqPosToPointNorm', () => {
  it('seqPosToPointNorm agrees with seqPosToPoint', () => {
    const dims = getStadiumDimensions(800, 400, 0);
    const viewOffset = 0.25;
    const bp = 1000;
    const genomeLength = 5000;

    const ptNorm = seqPosToPointNorm(bp, genomeLength, viewOffset, dims);
    const ptDirect = seqPosToPoint(bp, genomeLength, viewOffset * genomeLength, dims);

    expect(ptNorm.x).toBeCloseTo(ptDirect.x, 5);
    expect(ptNorm.y).toBeCloseTo(ptDirect.y, 5);
  });
});

describe('click-to-sequence mapping', () => {
  it('normalizes rounded seam clicks back to position 0', () => {
    const dims = getStadiumDimensions(800, 400, 0);
    const genomeLength = 1000;
    const nearSeam = seqPosToPoint(999.8, genomeLength, 0, dims);

    expect(closestSeqPosOnBackbone(nearSeam.x, nearSeam.y, dims, 0, genomeLength, 0)).toBe(0);
    expect(clickToSeqPos(nearSeam.x, nearSeam.y, dims, 0, genomeLength, 0, 20)).toBe(0);
  });

  it('roundtrips clicks with normalized view offsets', () => {
    const dims = getStadiumDimensions(1327, 200, 0, 76);
    const genomeLength = 4641652;
    const viewOffset = 0.444;
    const bp = 3107000;
    const pt = seqPosToPointNorm(bp, genomeLength, viewOffset, dims);

    expect(closestSeqPosOnBackbone(pt.x, pt.y, dims, 0, genomeLength, viewOffset)).toBe(bp);
  });
});

describe('computeOffsetPoint', () => {
  it('offsets top segment in Y direction', () => {
    const dims = getStadiumDimensions(800, 400, 0);
    const pt = normalizedPosToPoint(0.05, dims);
    expect(pt.segment).toBe('top');

    const offsetPt = computeOffsetPoint(pt, -10);
    expect(offsetPt.x).toBeCloseTo(pt.x);
    expect(offsetPt.y).toBeCloseTo(pt.y - 10);
  });

  it('offsets bottom segment in negative Y direction', () => {
    const dims = getStadiumDimensions(800, 400, 0);
    const bottomStart = (dims.straightLength + Math.PI * dims.radius) / dims.totalLength;
    const pt = normalizedPosToPoint(bottomStart + 0.05, dims);
    expect(pt.segment).toBe('bottom');

    const offsetPt = computeOffsetPoint(pt, -10);
    expect(offsetPt.y).toBeCloseTo(pt.y + 10);
  });
});
