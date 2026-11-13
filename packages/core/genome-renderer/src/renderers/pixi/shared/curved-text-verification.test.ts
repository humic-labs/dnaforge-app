import { describe, it, expect } from 'vitest';
import {
  getStadiumDimensions,
  normalizedPosToPoint,
  computeOffsetPoint,
  seqPosToPointNorm,
} from '../../../geometry/stadium';

const GENOME_LENGTH = 4641652;
const dims = getStadiumDimensions(1440, 900, 0, 80);

function bpAtNormalized(norm: number, viewOffset = 0): number {
  return ((norm - viewOffset + 1) % 1) * GENOME_LENGTH;
}

function computeLabelCharPositions(
  startBp: number,
  endBp: number,
  numChars: number,
  viewOffset = 0
) {
  const positions: { x: number; y: number; angle: number; segment: string }[] = [];
  for (let i = 0; i < numChars; i++) {
    const t = (i + 0.5) / numChars;
    const bp = startBp + t * (endBp - startBp);
    const pt = seqPosToPointNorm(bp, GENOME_LENGTH, viewOffset, dims);
    const off = computeOffsetPoint(pt, -14);
    positions.push({ x: off.x, y: off.y, angle: pt.angle, segment: pt.segment });
  }
  return positions;
}

describe('curved text geometric verification', () => {
  const topEnd = dims.straightLength / dims.totalLength;
  const rightCapEnd = (dims.straightLength + Math.PI * dims.radius) / dims.totalLength;
  const bottomEnd = (2 * dims.straightLength + Math.PI * dims.radius) / dims.totalLength;

  it('stadium dimensions are valid', () => {
    expect(dims.straightLength).toBeGreaterThan(0);
    expect(dims.radius).toBeGreaterThan(0);
    expect(dims.totalLength).toBeGreaterThan(0);
    console.log('Stadium:', {
      straight: dims.straightLength.toFixed(0),
      radius: dims.radius.toFixed(0),
      total: dims.totalLength.toFixed(0),
      topEnd: topEnd.toFixed(3),
      rightCapEnd: rightCapEnd.toFixed(3),
      bottomEnd: bottomEnd.toFixed(3),
    });
  });

  it('characters on TOP STRAIGHT have identical angles (≈ 0)', () => {
    const midNorm = topEnd / 2;
    const midBp = bpAtNormalized(midNorm);
    const spanBp = 5000;
    const chars = computeLabelCharPositions(midBp - spanBp / 2, midBp + spanBp / 2, 10);

    for (const c of chars) {
      expect(c.segment).toBe('top');
      expect(Math.abs(c.angle)).toBeLessThan(0.01);
    }

    const angles = chars.map((c) => c.angle);
    const maxDiff = Math.max(...angles) - Math.min(...angles);
    expect(maxDiff).toBeLessThan(0.001);
    console.log('Top straight: all angles ≈', angles[0].toFixed(4), 'maxDiff:', maxDiff.toFixed(6));
  });

  it('characters on RIGHT CAP have DIFFERENT angles (text curves)', () => {
    const midNorm = (topEnd + rightCapEnd) / 2;
    const midBp = bpAtNormalized(midNorm);
    const spanBp = GENOME_LENGTH * (rightCapEnd - topEnd) * 0.3;
    const chars = computeLabelCharPositions(midBp - spanBp / 2, midBp + spanBp / 2, 10);

    const capChars = chars.filter((c) => c.segment === 'right-cap');
    expect(capChars.length).toBeGreaterThan(5);

    const angles = capChars.map((c) => c.angle);
    const totalAngleSpan = Math.max(...angles) - Math.min(...angles);

    expect(totalAngleSpan).toBeGreaterThan(0.3);
    console.log(
      'Right cap: angle span =',
      totalAngleSpan.toFixed(3),
      'rad =',
      ((totalAngleSpan * 180) / Math.PI).toFixed(1) + '°'
    );

    for (let i = 1; i < angles.length; i++) {
      expect(angles[i]).toBeGreaterThan(angles[i - 1]);
    }
  });

  it('characters on LEFT CAP have DIFFERENT angles (text curves)', () => {
    const midNorm = (bottomEnd + 1) / 2;
    const midBp = bpAtNormalized(midNorm);
    const spanBp = GENOME_LENGTH * (1 - bottomEnd) * 0.3;
    const chars = computeLabelCharPositions(midBp - spanBp / 2, midBp + spanBp / 2, 10);

    const capChars = chars.filter((c) => c.segment === 'left-cap');
    expect(capChars.length).toBeGreaterThan(5);

    const angles = capChars.map((c) => c.angle);
    const totalAngleSpan = Math.max(...angles) - Math.min(...angles);
    expect(totalAngleSpan).toBeGreaterThan(0.3);
    console.log(
      'Left cap: angle span =',
      totalAngleSpan.toFixed(3),
      'rad =',
      ((totalAngleSpan * 180) / Math.PI).toFixed(1) + '°'
    );
  });

  it('character positions on caps form a curve, not a straight line', () => {
    const midNorm = (topEnd + rightCapEnd) / 2;
    const midBp = bpAtNormalized(midNorm);
    const spanBp = GENOME_LENGTH * (rightCapEnd - topEnd) * 0.3;
    const chars = computeLabelCharPositions(midBp - spanBp / 2, midBp + spanBp / 2, 10);

    let maxCrossProduct = 0;
    for (let i = 1; i < chars.length - 1; i++) {
      const dx1 = chars[i].x - chars[i - 1].x;
      const dy1 = chars[i].y - chars[i - 1].y;
      const dx2 = chars[i + 1].x - chars[i].x;
      const dy2 = chars[i + 1].y - chars[i].y;
      const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
      maxCrossProduct = Math.max(maxCrossProduct, cross);
    }
    expect(maxCrossProduct).toBeGreaterThan(1);
    console.log('Cap curvature (max cross product):', maxCrossProduct.toFixed(2));
  });

  it('computeOffsetPoint: NEGATIVE = outward from center', () => {
    const cx = dims.width / 2;
    const cy = dims.height / 2;

    const topPt = normalizedPosToPoint(topEnd / 2, dims);
    const backboneDist = Math.sqrt((topPt.x - cx) ** 2 + (topPt.y - cy) ** 2);
    const outerPt = computeOffsetPoint(topPt, -22);
    const outerDist = Math.sqrt((outerPt.x - cx) ** 2 + (outerPt.y - cy) ** 2);
    expect(outerDist).toBeGreaterThan(backboneDist);

    const innerPt = computeOffsetPoint(topPt, 22);
    const innerDist = Math.sqrt((innerPt.x - cx) ** 2 + (innerPt.y - cy) ** 2);
    expect(innerDist).toBeLessThan(backboneDist);

    const capMid = (topEnd + rightCapEnd) / 2;
    const capPt = normalizedPosToPoint(capMid, dims);
    const capBackDist = Math.sqrt((capPt.x - cx) ** 2 + (capPt.y - cy) ** 2);
    const capOuterPt = computeOffsetPoint(capPt, -22);
    const capOuterDist = Math.sqrt((capOuterPt.x - cx) ** 2 + (capOuterPt.y - cy) ** 2);
    expect(capOuterDist).toBeGreaterThan(capBackDist);

    const extLabelOffset = -14 - 22;
    const extPt = computeOffsetPoint(topPt, extLabelOffset);
    const extDist = Math.sqrt((extPt.x - cx) ** 2 + (extPt.y - cy) ** 2);
    expect(extDist).toBeGreaterThan(outerDist);

    console.log(
      'Offset convention: -22 outward by',
      (outerDist - backboneDist).toFixed(1) + 'px, +22 inward by',
      (backboneDist - innerDist).toFixed(1) + 'px'
    );
    console.log('External label (-36): ', (extDist - backboneDist).toFixed(1) + 'px outward');
  });

  it('character positions on straights form a line (cross product ≈ 0)', () => {
    const midNorm = topEnd / 2;
    const midBp = bpAtNormalized(midNorm);
    const spanBp = 5000;
    const chars = computeLabelCharPositions(midBp - spanBp / 2, midBp + spanBp / 2, 10);

    let maxCrossProduct = 0;
    for (let i = 1; i < chars.length - 1; i++) {
      const dx1 = chars[i].x - chars[i - 1].x;
      const dy1 = chars[i].y - chars[i - 1].y;
      const dx2 = chars[i + 1].x - chars[i].x;
      const dy2 = chars[i + 1].y - chars[i].y;
      const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
      maxCrossProduct = Math.max(maxCrossProduct, cross);
    }
    expect(maxCrossProduct).toBeLessThan(0.01);
    console.log('Straight linearity (max cross product):', maxCrossProduct.toFixed(6));
  });
});
