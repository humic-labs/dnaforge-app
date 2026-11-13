import { expect, it, vi } from 'vitest';
import { WebGLDrawingContext } from './webgl-drawing-context';
import { strokePathTriangles, transformPoint, type Point, type Transform } from './webgl-geometry';

function area(points: Point[]) {
  let total = 0;
  for (let i = 0; i < points.length; i += 3) {
    const [a, b, c] = points.slice(i, i + 3);
    total += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  return total;
}

it.each<Transform>([
  [1, 0, 0, 1, 17.25, -400.5],
  [2, 0, 0, 2, 17.25, -400.5],
  [1.5, 0, 0, 1.5, -91.7, 312.4],
  [-2, 0, 0, -2, 17.25, -400.5],
  [2, 0, 0, 1, 17.25, -400.5],
  [0, 2, -2, 0, 17.25, -400.5],
  [2, 0.3, 0.1, 1.5, 17.25, -400.5],
])('retains transformed stroke width, caps and joins for matrix %j', (...transform) => {
  const ctx = Object.create(WebGLDrawingContext.prototype) as WebGLDrawingContext;
  const vertex = vi.fn();
  const morphShape = vi.fn((points: Point[]) => ({ points }));
  Object.assign(ctx, {
    atlas: { size: 2048, solidTexture: {} },
    state: {
      transform,
      lineWidth: 0.6,
      lineCap: 'butt',
      lineJoin: 'miter',
      strokeStyle: '#56789A',
      dash: [],
    },
    morphShape,
    useTexture: vi.fn(),
    vertex,
  });
  for (const width of [0.6, 4])
    for (const strand of [1, -1]) {
      const points: Point[] = [
        [100, 30],
        [100 + strand * 1.4, 33.55],
        [100, 37.1],
      ];
      for (const cap of ['butt', 'square', 'round'] as const) {
        ctx.lineCap = cap;
        ctx.lineWidth = width;
        vertex.mockClear();
        ctx.beginPath();
        ctx.moveTo(...points[0]);
        ctx.lineTo(...points[1]);
        ctx.lineTo(...points[2]);
        ctx.stroke();
        const expected = strokePathTriangles(points, width, false, cap, 'miter').map(([x, y]) =>
          transformPoint(transform, x, y)
        );
        const actual: Point[] = vertex.mock.calls.map((call) => call[0]);
        expect(area(actual)).toBeCloseTo(area(expected), 7);
        for (const axis of [0, 1]) {
          expect(Math.min(...actual.map((p) => p[axis]))).toBeCloseTo(
            Math.min(...expected.map((p) => p[axis])),
            7
          );
          expect(Math.max(...actual.map((p) => p[axis]))).toBeCloseTo(
            Math.max(...expected.map((p) => p[axis])),
            7
          );
        }
        if (width === 0.6 && cap !== 'round') {
          expect(actual).toHaveLength(expected.length);
          for (let i = 0; i < expected.length; i++) {
            expect(actual[i][0]).toBeCloseTo(expected[i][0], 7);
            expect(actual[i][1]).toBeCloseTo(expected[i][1], 7);
          }
        }
        for (const call of vertex.mock.calls) expect(call[3]).toBe('#56789A');
      }
    }
  expect(morphShape).toHaveBeenCalledTimes(12);
});
