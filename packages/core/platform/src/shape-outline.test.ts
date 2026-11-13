import { describe, expect, it } from 'vitest';
import {
  rectangleContour,
  roundedRectangleContour,
  unionOuterContours,
  type OutlinePoint,
} from './shape-outline';

const area = (points: readonly OutlinePoint[]) =>
  points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length];
    return sum + p.x * next.y - p.y * next.x;
  }, 0) / 2;

describe('compound annotation perimeter', () => {
  it('removes both the shared line/band edge and the overlapping pill interior', () => {
    const [contour] = unionOuterContours([
      rectangleContour(0, 14, 100, 18),
      rectangleContour(0, 12, 100, 2),
      rectangleContour(30, 0, 40, 14),
    ]);
    expect(area(contour)).toBe(2480);
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i],
        b = contour[(i + 1) % contour.length];
      expect(a.y === 14 && b.y === 14).toBe(false);
      if (a.y === 12 && b.y === 12)
        expect(Math.max(a.x, b.x) <= 30 || Math.min(a.x, b.x) >= 70).toBe(true);
    }
  });

  it('preserves concave corners, without duplicate boundaries from coincident shapes', () => {
    const a = rectangleContour(0, 0, 20, 10),
      b = rectangleContour(10, 5, 20, 10);
    const contours = unionOuterContours([a, b, [...a].reverse()]);
    expect(contours).toHaveLength(1);
    expect(area(contours[0])).toBe(350);
    expect(contours[0]).toContainEqual({ x: 20, y: 5 });
    expect(contours[0]).toContainEqual({ x: 10, y: 10 });
  });

  it('splits intersecting diagonals at their actual intersection', () => {
    const contours = unionOuterContours([
      [
        { x: 0, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 20 },
      ],
      rectangleContour(0, 0, 15, 10),
    ]);
    expect(contours).toHaveLength(1);
    expect(area(contours[0])).toBeCloseTo(256.25);
    expect(contours[0]).toContainEqual({ x: 15, y: 7.5 });
  });

  it('keeps disconnected and point-touching shapes as simple contours', () => {
    const contours = unionOuterContours([
      rectangleContour(0, 0, 10, 10),
      rectangleContour(10, 10, 10, 10),
      rectangleContour(30, 0, 10, 10),
    ]);
    expect(contours).toHaveLength(3);
    expect(contours.map(area)).toEqual([100, 100, 100]);
    for (const contour of contours)
      expect(new Set(contour.map((p) => `${p.x}:${p.y}`)).size).toBe(contour.length);
  });

  it('reduces a long straight codon band to its four boundary corners', () => {
    const top = Array.from({ length: 1001 }, (_, x) => ({ x, y: 0 }));
    const bottom = top.map(({ x }) => ({ x, y: 20 })).reverse();
    const contours = unionOuterContours([[...top, ...bottom]]);
    expect(contours).toHaveLength(1);
    expect(contours[0]).toHaveLength(4);
    expect(area(contours[0])).toBe(20_000);
  });

  it('joins a rounded name pill to a flush retained line and keeps its rounded shoulders', () => {
    const pill = roundedRectangleContour(30, 0, 40, 14, 3);
    const contours = unionOuterContours([rectangleContour(0, 12, 100, 20), pill]);
    expect(contours).toHaveLength(1);
    const contour = contours[0];
    expect(Math.min(...contour.map((p) => p.y))).toBe(0);
    expect(Math.max(...contour.map((p) => p.y))).toBe(32);
    expect(contour.some((p) => p.x > 30 && p.x < 33 && p.y > 0 && p.y < 3)).toBe(true);
    expect(contour.some((p) => p.x > 30 && p.x < 70 && p.y > 12 && p.y < 32)).toBe(false);
  });
});
