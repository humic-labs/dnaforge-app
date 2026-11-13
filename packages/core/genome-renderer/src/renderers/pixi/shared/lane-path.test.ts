import { describe, expect, it } from 'vitest';
import type { PathMapper } from './path-mapper';
import {
  clampedLanePillPlacement,
  laneCdsLabelStripOutlinePolygon,
  laneCdsTransitionOutlinePolygon,
  laneRoundedPillPolygon,
} from './lane-path';

function createArcPath(radius = 120): PathMapper {
  return {
    isArcMode: true,
    pixelsPerBp: 1,
    featureLabelPosAt(bp: number, offsetPx: number) {
      const theta = bp / radius;
      const r = radius + offsetPx;
      return {
        x: 200 + Math.cos(theta) * r,
        y: 200 + Math.sin(theta) * r,
        angle: theta + Math.PI / 2,
      };
    },
  } as PathMapper;
}

function createCompactedArcPath(radius = 120, normalScale = 0.35): PathMapper {
  return {
    ...createArcPath(radius),
    scaleNormalOffset: (baseOffsetPx: number) => baseOffsetPx * normalScale,
  } as PathMapper;
}

function createLinearPath(pixelsPerBp = 10): PathMapper {
  return {
    isArcMode: false,
    pixelsPerBp,
    featureLabelPosAt(bp: number, offsetPx: number) {
      return {
        x: bp * pixelsPerBp + pixelsPerBp / 2,
        y: 20 + offsetPx,
        angle: 0,
      };
    },
    bpLeftX(bp: number) {
      return bp * pixelsPerBp;
    },
  } as PathMapper;
}

function createTwoIslandVisiblePath(): PathMapper {
  return {
    isArcMode: true,
    pixelsPerBp: 1,
    featureLabelPosAt(bp: number, offsetPx: number) {
      let x: number;
      let y = 20 + offsetPx;
      if (bp <= 40) {
        x = bp;
      } else if (bp >= 70) {
        x = bp - 20;
      } else {
        x = 500;
        y = 500;
      }
      return { x, y, angle: 0 };
    },
  } as PathMapper;
}

function toPoints(pts: number[]): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < pts.length; i += 2) out.push({ x: pts[i], y: pts[i + 1] });
  return out;
}

function maxDeviationFromChord(points: Array<{ x: number; y: number }>): number {
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.max(
    ...points.map(
      (point) => Math.abs(dy * point.x - dx * point.y + last.x * first.y - last.y * first.x) / len
    )
  );
}

function minDistanceToPoint(
  points: Array<{ x: number; y: number }>,
  target: { x: number; y: number }
): number {
  return Math.min(...points.map((point) => Math.hypot(point.x - target.x, point.y - target.y)));
}

function lanePointAt(
  path: PathMapper,
  bp: number,
  offsetPx: number,
  normalOffsetPx: number
): { x: number; y: number } {
  const center = path.featureLabelPosAt(bp, offsetPx);
  const nx = -Math.sin(center.angle);
  const ny = Math.cos(center.angle);
  const scaledNormalOffsetPx = path.scaleNormalOffset?.(normalOffsetPx) ?? normalOffsetPx;
  return {
    x: center.x + nx * scaledNormalOffsetPx,
    y: center.y + ny * scaledNormalOffsetPx,
  };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function expectExplicitlyClosed(name: string, pts: number[]): void {
  const points = toPoints(pts);
  const first = points[0];
  const last = points[points.length - 1];
  expect(distance(first, last), name).toBeLessThan(0.01);
}

describe('lane-path curved pills', () => {
  it('anchors linear curved-pill helpers to bp boundaries, not base centers', () => {
    const path = createLinearPath();
    const pillPts = toPoints(laneRoundedPillPolygon(path, 10, 80, 0, 8));
    const cdsPts = toPoints(laneCdsLabelStripOutlinePolygon(path, 10, 80, 40, 0, 8, 2.5));

    expect(Math.min(...pillPts.map((point) => point.x))).toBeCloseTo(path.bpLeftX(10), 5);
    expect(Math.min(...cdsPts.map((point) => point.x))).toBeCloseTo(path.bpLeftX(10), 5);
  });

  it('tessellates long pill edges so labels follow the stadium curve', () => {
    const path = createArcPath();
    const pts = laneRoundedPillPolygon(path, 0, 96, 0, 8);
    const topEdge = toPoints(pts).slice(0, 12);

    expect(pts.length).toBeGreaterThan(42);
    expect(maxDeviationFromChord(topEdge)).toBeGreaterThan(0.25);
  });

  it('tessellates CDS pill-and-line outlines instead of drawing straight chords', () => {
    const path = createArcPath();
    const pts = laneCdsLabelStripOutlinePolygon(path, 0, 70, 120, 0, 8, 2.5);

    expect(pts.length).toBeGreaterThan(48);
    expect(maxDeviationFromChord(toPoints(pts).slice(0, 12))).toBeGreaterThan(0.25);
  });

  it('builds one curved outline for CDS transition connector plus pill', () => {
    const path = createArcPath();
    const pts = laneCdsTransitionOutlinePolygon(path, 0, 180, 60, 70, 0, 8, 3, 1000);

    expect(pts.length).toBeGreaterThan(64);
    expect(maxDeviationFromChord(toPoints(pts).slice(0, 12))).toBeGreaterThan(0.25);
  });

  it('uses the path normal scale for curved pill thickness in compact stadium mode', () => {
    const path = createCompactedArcPath(120, 0.35);
    const halfHeight = 8;
    const pts = toPoints(laneRoundedPillPolygon(path, 0, 96, 0, halfHeight));

    expect(minDistanceToPoint(pts, lanePointAt(path, 3, 0, -halfHeight))).toBeLessThan(0.01);
    expect(minDistanceToPoint(pts, lanePointAt(path, 3, 0, halfHeight))).toBeLessThan(0.01);
  });

  it('anchors CDS transition pill boundaries to the requested bp on offset curves', () => {
    const path = createArcPath();
    const offsetPx = -20;
    const pillStartBp = 60;
    const connectorHalfHeight = 3;
    const pts = toPoints(
      laneCdsTransitionOutlinePolygon(
        path,
        0,
        180,
        pillStartBp,
        70,
        offsetPx,
        8,
        connectorHalfHeight,
        1000
      )
    );

    expect(
      minDistanceToPoint(pts, lanePointAt(path, pillStartBp, offsetPx, -connectorHalfHeight))
    ).toBeLessThan(0.5);
    expect(
      minDistanceToPoint(pts, lanePointAt(path, pillStartBp, offsetPx, connectorHalfHeight))
    ).toBeLessThan(0.5);
  });

  it('keeps directional tips in CDS transition outlines', () => {
    const path = createArcPath();
    const forwardPts = toPoints(
      laneCdsTransitionOutlinePolygon(path, 0, 180, 60, 70, 0, 8, 3, 1000, 'forward', 12)
    );
    const reversePts = toPoints(
      laneCdsTransitionOutlinePolygon(path, 0, 180, 60, 70, 0, 8, 3, 1000, 'reverse', 12)
    );

    expect(minDistanceToPoint(forwardPts, path.featureLabelPosAt(180, 0))).toBeLessThan(0.01);
    expect(minDistanceToPoint(reversePts, path.featureLabelPosAt(0, 0))).toBeLessThan(0.01);
  });

  it('explicitly closes curved annotation polygons so Pixi cannot draw straight closing chords', () => {
    const path = createArcPath();

    expectExplicitlyClosed('rounded pill', laneRoundedPillPolygon(path, 12, 96, 0, 8));
    expectExplicitlyClosed(
      'CDS pill-and-line strip',
      laneCdsLabelStripOutlinePolygon(path, 12, 70, 120, 0, 8, 2.5)
    );
    expectExplicitlyClosed(
      'forward CDS transition outline',
      laneCdsTransitionOutlinePolygon(path, 0, 180, 60, 70, 0, 8, 3, 1000, 'forward', 24)
    );
    expectExplicitlyClosed(
      'reverse CDS transition outline',
      laneCdsTransitionOutlinePolygon(path, 0, 180, 60, 70, 0, 8, 3, 1000, 'reverse', 24)
    );
  });

  it('places clamped labels on the visible span nearest the preferred bp, not the longest span', () => {
    const path = createTwoIslandVisiblePath();

    const placement = clampedLanePillPlacement(path, 200, 100, 0, 180, 20, 0, 1000, 10);

    expect(placement.startBp).toBeGreaterThanOrEqual(9);
    expect(placement.startBp).toBeLessThanOrEqual(11);
  });
});
