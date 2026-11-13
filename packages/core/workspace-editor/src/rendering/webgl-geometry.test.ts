import { describe, expect, it } from 'vitest';
import earcut from 'earcut';
import {
  parseWebGLColor,
  triangulatePath,
  transformPoint,
  strokePathTriangles,
  type Point,
  type Transform,
} from './webgl-geometry';

describe('sequence WebGL geometry', () => {
  it.each(['rectangle', 'forward arrow', 'reverse arrow'] as const)(
    'preserves the general triangulator vertex order for compact %s silhouettes',
    (shape) => {
      for (const [width, height] of [
        [0.000001, 0.25],
        [0.6, 6],
        [24, 23.4],
      ]) {
        const depth = width * 0.3;
        const points: Point[] =
          shape === 'rectangle'
            ? [
                [0, 0],
                [width, 0],
                [width, height],
                [0, height],
              ]
            : shape === 'forward arrow'
              ? [
                  [0, 0],
                  [width - depth, 0],
                  [width, height / 2],
                  [width - depth, height],
                  [0, height],
                ]
              : [
                  [depth, 0],
                  [width, 0],
                  [width, height],
                  [depth, height],
                  [0, height / 2],
                ];
        for (const transform of [
          [1, 0, 0, 1, 0, 0],
          [2, 0, 0, 1.5, 17.25, -400.5],
        ] as Transform[]) {
          const transformed = points.map(([x, y]) => transformPoint(transform, x, y));
          const actual = triangulatePath(transformed, true);
          expect(actual).toEqual(earcut(transformed.flat(), undefined, 2));
          expect(actual).toEqual(
            shape === 'rectangle' ? [2, 3, 0, 0, 1, 2] : [3, 4, 0, 0, 1, 2, 2, 3, 0]
          );
          expect(triangleArea(actual.map((i) => transformed[i]))).toBeCloseTo(
            (width - (shape === 'rectangle' ? 0 : depth / 2)) *
              height *
              transform[0] *
              transform[3],
            8
          );
        }
      }
    }
  );

  it('preserves exact triangulation for gradients, tears, concave and degenerate shapes and other transforms', () => {
    const rectangle: Point[] = [
      [0, 0],
      [8, 0],
      [8, 4],
      [0, 4],
    ];
    const arrow: Point[] = [
      [0, 0],
      [6, 0],
      [8, 2],
      [6, 4],
      [0, 4],
    ];
    const cases: Point[][] = [
      [
        [0, 0],
        [8, 0],
        [3, 2],
        [8, 4],
        [0, 4],
      ],
      [
        [0, 0],
        [7, 0],
        [6, 1],
        [8, 2],
        [6, 3],
        [7, 4],
        [0, 4],
      ],
      [
        [0, 0],
        [8, 0],
        [8, 0],
        [0, 0],
      ],
      [
        [0, 0],
        [0, 0],
        [0, 4],
        [0, 4],
      ],
    ];
    for (const points of [rectangle, arrow]) {
      expect(triangulatePath(points, false)).toEqual(earcut(points.flat(), undefined, 2));
      for (const transform of [
        [-1, 0, 0, 1, 0, 0],
        [0, 1, -1, 0, 0, 0],
        [1, 0, 0.25, 1, 0, 0],
      ] as Transform[])
        cases.push(points.map(([x, y]) => transformPoint(transform, x, y)));
    }
    for (const points of cases) {
      const actual = triangulatePath(points, true);
      expect(actual).toEqual(earcut(points.flat(), undefined, 2));
    }
  });

  it('preserves coverage for convex arrows and quads plus concave, crossing and degenerate contours', () => {
    const contours: [number, number][][] = [
      [
        [0, 0],
        [20, 0],
        [20, 10],
        [0, 10],
      ],
      [
        [2.5, -3],
        [21.25, 1],
        [18.5, 11.75],
        [-1, 8.5],
      ],
      [
        [0, 0],
        [20, 0],
        [20, 0.0001],
        [0, 0.0001],
      ],
      [
        [0, 0],
        [20, 0],
        [4, 3],
        [0, 10],
      ],
      [
        [0, 0],
        [20, 10],
        [20, 0],
        [0, 10],
      ],
      [
        [0, 0],
        [10, 0],
        [20, 0],
        [0, 10],
      ],
      [
        [0, 0],
        [0, 0],
        [20, 10],
        [0, 10],
      ],
      [
        [0, 0],
        [18, 0],
        [22, 5],
        [18, 10],
        [0, 10],
      ],
      [
        [4, 0],
        [22, 0],
        [22, 10],
        [4, 10],
        [0, 5],
      ],
      [
        [0, 0],
        [22, 0],
        [8, 4],
        [22, 10],
        [0, 10],
      ],
      [
        [10, 0],
        [15, 20],
        [0, 7],
        [20, 7],
        [5, 20],
      ],
    ];
    for (const contour of contours) {
      for (const points of [contour, [...contour].reverse()]) {
        const actual = triangulatePath(points);
        const baseline = earcut(points.flat(), undefined, 2);

        expect(actual).toEqual(baseline);
        const mesh = (indices: readonly number[]) => indices.map((i) => points[i]);
        expect(triangleArea(mesh(actual))).toBeCloseTo(triangleArea(mesh(baseline)), 10);
        const covered = (indices: readonly number[], x: number, y: number) => {
          for (let i = 0; i < indices.length; i += 3) {
            const [a, b, c] = indices.slice(i, i + 3).map((index) => points[index]);
            const side = (p: [number, number], q: [number, number]) =>
              (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
            const signs = [side(a, b), side(b, c), side(c, a)];
            if (signs.every((s) => s >= 0) || signs.every((s) => s <= 0)) return true;
          }
          return false;
        };
        for (let x = -2.13; x < 23; x += 0.83)
          for (let y = -3.17; y < 23; y += 0.71)
            expect(covered(actual, x, y)).toBe(covered(baseline, x, y));
      }
    }
  });
  it.each([1, -1])(
    'retains the exact solid codon area and notch while reusing topology on strand %s',
    (direction) => {
      for (const width of [0.6, 1.08, 24]) {
        const depth = 1,
          height = 5.4;
        const points: [number, number][] = [
          [0, 0],
          [width, 0],
          [width + direction * depth, height / 2],
          [width, height],
          [0, height],
          [direction * depth, height / 2],
        ];
        const optimized = triangulatePath(points, true);
        const original = triangulatePath(points);
        const mesh = (indices: readonly number[]) => indices.map((i) => points[i]);
        expect(triangleArea(mesh(optimized))).toBeCloseTo(width * height, 10);
        expect(triangleArea(mesh(optimized))).toBeCloseTo(triangleArea(mesh(original)), 10);
        expect(Object.isFrozen(optimized)).toBe(true);
        expect(
          triangulatePath(
            points.map(([x, y]) => [x + 200, y + 50]),
            true
          )
        ).toBe(optimized);
        const covered = (indices: readonly number[], x: number, y: number) => {
          for (let i = 0; i < indices.length; i += 3) {
            const [a, b, c] = indices.slice(i, i + 3).map((index) => points[index]);
            const cross = (p: [number, number], q: [number, number]) =>
              (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
            const signs = [cross(a, b), cross(b, c), cross(c, a)];
            if (signs.every((s) => s >= 0) || signs.every((s) => s <= 0)) return true;
          }
          return false;
        };
        for (let x = -1.93; x < width + 2; x += 0.17)
          for (let y = 0.13; y < height; y += 0.19)
            expect(covered(optimized, x, y)).toBe(covered(original, x, y));
      }
    }
  );
  it('preserves theme alpha, hexadecimal colors, and named transparent color', () => {
    expect(parseWebGLColor('rgba(180, 160, 50, 0.25)')).toEqual([
      180 / 255,
      160 / 255,
      50 / 255,
      0.25,
    ]);
    expect(parseWebGLColor('#1234')).toEqual([17 / 255, 34 / 255, 51 / 255, 68 / 255]);
    expect(parseWebGLColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(parseWebGLColor('#FF6600')).toEqual([1, 102 / 255, 0, 1]);
  });

  it('triangulates a concave codon chevron without filling its notch', () => {
    const points = [
      [0, 0],
      [18, 0],
      [22, 10],
      [18, 20],
      [0, 20],
      [4, 10],
    ] as [number, number][];
    const indices = triangulatePath(points);
    let area = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
      area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    expect(area).toBe(360);
    expect(indices).toHaveLength(12);
  });

  it('applies retina, translation and rotation to the actual vertices', () => {
    expect(transformPoint([0, 2, -2, 0, 100, 40], 3, 5)).toEqual([90, 46]);
  });
});

function triangleArea(vertices: [number, number][]) {
  let area = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    const [a, b, c] = vertices.slice(i, i + 3);
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  return area;
}
it('strokes a closed rectangle as one non-overlapping ring with Canvas miters', () => {
  const mesh = strokePathTriangles(
    [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ],
    2,
    true
  );
  expect(triangleArea(mesh)).toBeCloseTo(120, 6);
  expect(Math.min(...mesh.map((p) => p[0]))).toBe(-1);
  expect(Math.max(...mesh.map((p) => p[0]))).toBe(21);
});
it('preserves square caps and round caps without overlapping alpha', () => {
  expect(
    triangleArea(
      strokePathTriangles(
        [
          [0, 0],
          [20, 0],
        ],
        2,
        false,
        'square'
      )
    )
  ).toBeCloseTo(44, 6);
  expect(
    triangleArea(
      strokePathTriangles(
        [
          [0, 0],
          [20, 0],
        ],
        2,
        false,
        'round'
      )
    )
  ).toBeCloseTo(40 + Math.PI, 0);
});

it.each([1, -1])(
  'preserves a short codon divider miter without overlapping translucent triangles (strand %s)',
  (strand) => {
    for (const height of [5.4, 7.1, 23.4]) {
      for (const depth of [0.6, 1.4, 4]) {
        const points: [number, number][] = [
          [100, 30],
          [100 + strand * depth, 30 + height / 2],
          [100, 30 + height],
        ];
        const width = 0.6;
        const mesh = strokePathTriangles(points, width);
        expect(mesh).toHaveLength(12);

        expect(triangleArea(mesh)).toBeCloseTo(width * 2 * Math.hypot(depth, height / 2), 8);
        const tipX = 100 + strand * depth;
        const miterOffset = ((width / 2) * Math.hypot(depth, height / 2)) / (height / 2);
        expect(
          mesh.some(([x, y]) => Math.abs(x - (tipX + miterOffset)) < 1e-8 && y === 30 + height / 2)
        ).toBe(true);
        expect(
          mesh.some(([x, y]) => Math.abs(x - (tipX - miterOffset)) < 1e-8 && y === 30 + height / 2)
        ).toBe(true);
      }
    }
  }
);
