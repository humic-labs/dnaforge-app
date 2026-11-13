import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { WebGLDrawingContext } from './webgl-drawing-context';
import { buildCodonCellPath, type CodonEdge } from './canvas-primitives';
import type { Point } from './webgl-geometry';
import { drawRuler } from '../canvas-drawing-ruler';
import { DEFAULT_EDITOR_CONFIG, type LinePositions } from '../types';
import { fillCodonCells, type CodonCellRenderData } from '../codon-rendering';

it('preserves every shared-border vertex and color across ordering, clipping and sparse styles', () => {
  const results: Record<string, { vertexCount: number; sha256: string }> = {};
  for (const morph of [false, true])
    for (const direction of [1, -1] as const)
      for (const sparse of [false, true]) {
        const ctx = context(morph);
        const cell = (
          x: number,
          leftEdge: CodonEdge,
          rightEdge: CodonEdge
        ): CodonCellRenderData => ({
          codonX: x,
          visibleWidth: 24.35,
          leftEdge,
          rightEdge,
          aa: 'M',
          renderLetter: true,
        });
        const ordered = [
          cell(100, 'flat', 'chevron'),
          cell(124.35, 'chevron', 'chevron'),
          cell(148.7, 'chevron', 'chevron'),
          cell(173.05, 'chevron', 'flat'),
          cell(220, 'tip', 'flat'),
        ];

        const cells = [ordered[3], ordered[1], ordered[1], ordered[0], ordered[2], ordered[4]];
        if (direction === -1) cells.reverse();
        const before = cells.map((entry) => entry.codonX);
        fillCodonCells(
          ctx,
          cells,
          232,
          14,
          3,
          direction,
          '#3388CC',
          '#114455',
          0.3,
          0.4,
          (index) => {
            if (!sparse) return null;
            if (index === 1)
              return { fill: '#334455', alpha: 0.6, border: '#88BB99', borderAlpha: 0.2 };
            if (index === 2) return { fill: '#66CC99', alpha: 0.2, borderAlpha: -0 };
            if (index === 4) return { fill: 'rgba(20,30,40,0.5)', alpha: 0.9 };
            return null;
          },
          0.6,
          false,
          true
        );
        expect(cells.map((entry) => entry.codonX)).toEqual(before);
        const vertices: unknown = Reflect.get(ctx, 'vertices');
        const count: unknown = Reflect.get(ctx, 'vertexCount');
        if (!(vertices instanceof Float32Array) || typeof count !== 'number')
          throw new Error('Missing submitted GPU vertices');
        const bytes = Buffer.from(vertices.buffer, vertices.byteOffset, count * 9 * 4);
        results[`${morph}:${direction}:${sparse}`] = {
          vertexCount: count,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }

  expect(results).toMatchInlineSnapshot(`
    {
      "false:-1:false": {
        "sha256": "4fcc42beaee158cb8a5051d0a6ac1d63c67bf1204ccb74aeca86fa20b198e8eb",
        "vertexCount": 207,
      },
      "false:-1:true": {
        "sha256": "0218005a71e60fec426730f344cf12daea44f54398419d4c0a12164323d87cfe",
        "vertexCount": 279,
      },
      "false:1:false": {
        "sha256": "1b345fdea526d9645811676ff72c813852635c664513a3afe03a91943b28f92f",
        "vertexCount": 207,
      },
      "false:1:true": {
        "sha256": "9d1273a1e913734aff85270cf861feb672101fa68d5522877e5faccbd9a2f4cf",
        "vertexCount": 255,
      },
      "true:-1:false": {
        "sha256": "86990a8f87f9e7a1de3e674c5ab77dbced040492de3367a80108b49491ef1502",
        "vertexCount": 246,
      },
      "true:-1:true": {
        "sha256": "ade252467990c4beff15b0f8514aef9741e96b84db47598cd02bf31b6a962847",
        "vertexCount": 309,
      },
      "true:1:false": {
        "sha256": "777a067737a3177744ca07ce4134fd32b6657496b65710a0f51f0dce5edff0ac",
        "vertexCount": 243,
      },
      "true:1:true": {
        "sha256": "d48d97731701597007dfebe4ed32492892b6cee1c19874d20993255da4e99e40",
        "vertexCount": 285,
      },
    }
  `);
});

function context(morph: boolean) {
  const ctx = Object.create(WebGLDrawingContext.prototype) as WebGLDrawingContext;
  Object.assign(ctx, {
    atlas: { size: 2048, solidTexture: {} },
    state: {
      transform: [2, 0, 0, 2, 17.25, -400.5],
      fillStyle: '#56789A',
      strokeStyle: '#123456',
      globalAlpha: 0.6,
      lineWidth: 0.6,
      lineCap: 'butt',
      lineJoin: 'miter',
      dash: [],
      clips: [],
    },
    vertices: new Float32Array(65532 * 9),
    vertexCount: 0,
    colors: new Map(),
    useTexture: vi.fn(),
  });
  if (morph) ctx.setRowMorphBands({ natural: [0, 10, 30, 50], painted: [0, 10, 22, 50] }, 220);
  return ctx;
}

function submitted(ctx: WebGLDrawingContext): Point[][] {
  const raw = ctx as unknown as { vertices: Float32Array; vertexCount: number };
  const triangles: Point[][] = [];
  for (let i = 0; i < raw.vertexCount; i += 3)
    triangles.push(
      [0, 1, 2].map((n) => [raw.vertices[(i + n) * 9], raw.vertices[(i + n) * 9 + 1]])
    );
  return triangles;
}
function area(triangles: Point[][]) {
  return triangles.reduce(
    (sum, [a, b, c]) =>
      sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2,
    0
  );
}
function inside([a, b, c]: Point[], p: Point) {
  const side = (a: Point, b: Point) =>
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const sides = [side(a, b), side(b, c), side(c, a)];
  return sides.every((s) => s >= -0.005) || sides.every((s) => s <= 0.005);
}

it.each([false, true])(
  'prepares each ruler tick contour once while preserving circular labels and every vertex: %s',
  (morph) => {
    const actual = context(morph),
      expected = context(morph);
    const prepared = vi.spyOn(actual, 'prepareRepeatedPath');
    const strokes = vi.spyOn(actual, 'stroke');
    Object.defineProperty(expected, 'prepareRepeatedPath', { value: undefined });
    actual.fillText = vi.fn();
    expected.fillText = vi.fn();
    const rows = [
      { line: { startPos: 0, endPos: 600, sequence: 'A'.repeat(600) }, rulerY: 232 },
      {
        line: {
          startPos: 900,
          endPos: 100,
          originPosition: 100,
          sequence: 'A'.repeat(200),
        },
        rulerY: 246,
      },
    ] as unknown as LinePositions[];
    const config = { ...DEFAULT_EDITOR_CONFIG, charWidth: 3.5 };
    drawRuler(actual, rows, 20, config, 1000);
    drawRuler(expected, rows, 20, config, 1000);
    expect(actual.fillText).toHaveBeenCalledTimes(40);
    expect((actual.fillText as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      (expected.fillText as ReturnType<typeof vi.fn>).mock.calls
    );
    expect(submitted(actual)).toEqual(submitted(expected));
    expect(prepared).toHaveBeenCalledTimes(rows.length);
    expect(strokes).toHaveBeenCalledTimes(rows.length);
  }
);

it('submits rigid external stripe padding while annotation tracks grow', () => {
  const ctx = context(false);
  ctx.setRowMorphBands({ natural: [0, 16, 36], painted: [0, 34, 60] }, 220);
  ctx.fillRect(0, 220 - 32, 100, 36 + 32 + 12);
  const ys = submitted(ctx)
    .flat()
    .map((point) => point[1]);
  expect(Math.min(...ys)).toBeCloseTo((220 - 32) * 2 - 400.5, 5);
  expect(Math.max(...ys)).toBeCloseTo((220 + 60 + 12) * 2 - 400.5, 5);
});

it.each([false, true])(
  'reuses the exact cell fill and divider stroke, including track clipping: %s',
  (morph) => {
    for (const direction of [1, -1] as const)
      for (const width of [0.8, 3.5, 24])
        for (const edges of [
          ['flat', 'chevron'],
          ['chevron', 'chevron'],
          ['chevron', 'flat'],
          ['tip', 'flat'],
        ] as CodonEdge[][])
          for (const mode of ['fill', 'stroke'] as const) {
            const actual = context(morph),
              expected = context(morph);
            const points: Point[] = [];
            if (mode === 'fill')
              buildCodonCellPath(
                {
                  beginPath() {},
                  moveTo: (x, y) => points.push([x, y]),
                  lineTo: (x, y) => points.push([x, y]),
                  closePath() {},
                },
                0,
                232,
                width,
                14,
                3,
                direction,
                edges[0],
                edges[1]
              );
            else points.push([0, 232], [direction * 3, 239], [0, 246]);
            const paint = actual.prepareRepeatedPath(points, mode, mode === 'fill');
            expect(paint).toBeTypeOf('function');
            for (const x of [100, 124.35, 181.72]) {
              paint!(x);
              expected.beginPath();
              points.forEach(([px, py], i) =>
                i ? expected.lineTo(px + x, py) : expected.moveTo(px + x, py)
              );
              if (mode === 'fill') {
                expected.closePath();
                expected.fill();
              } else expected.stroke();
            }
            const a = submitted(actual),
              b = submitted(expected);
            expect(area(a)).toBeCloseTo(area(b), 2);
            for (const point of a.flat()) expect(b.some((t) => inside(t, point))).toBe(true);
            for (const point of b.flat()) expect(a.some((t) => inside(t, point))).toBe(true);
          }
  }
);

it('keeps rotated and dashed paths on the ordinary drawing route', () => {
  const ctx = context(false);
  ctx.rotate(0.5);
  expect(
    ctx.prepareRepeatedPath(
      [
        [0, 0],
        [2, 5],
        [0, 10],
      ],
      'stroke'
    )
  ).toBeNull();
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.setLineDash([3, 2]);
  expect(
    ctx.prepareRepeatedPath(
      [
        [0, 0],
        [2, 5],
        [0, 10],
      ],
      'stroke'
    )
  ).toBeNull();
});

it('preserves placement precision and live gradient colors for an affine repeated fill', () => {
  const actual = context(false),
    expected = context(false);
  const points: Point[] = [
    [0, 232],
    [8.125, 232],
    [3.25, 246],
  ];
  for (const ctx of [actual, expected]) ctx.setTransform(2, 0, 0.5, 2, 16777216.25, -400.5);
  const paint = actual.prepareRepeatedPath(points, 'fill', true)!;
  for (const [i, x] of [-8388608, -8388607.875, -8388600.25].entries()) {
    for (const ctx of [actual, expected]) {
      ctx.globalAlpha = 0.35 + i / 8;
      if (i === 1) {
        const gradient = ctx.createLinearGradient(-8388608, 232, -8388590, 246);
        gradient.addColorStop(0, '#123456');
        gradient.addColorStop(1, '#FEDCBA');
        ctx.fillStyle = gradient;
      } else ctx.fillStyle = i === 0 ? '#336699' : 'rgba(220, 30, 70, 0.45)';
    }
    paint(x);
    expected.beginPath();
    points.forEach(([px, py], index) =>
      index ? expected.lineTo(px + x, py) : expected.moveTo(px + x, py)
    );
    expected.closePath();
    expected.fill();
  }
  const dataOf = (ctx: WebGLDrawingContext) => {
    const raw = ctx as unknown as { vertices: Float32Array; vertexCount: number };
    return raw.vertices.subarray(0, raw.vertexCount * 9);
  };
  expect(dataOf(actual)).toEqual(dataOf(expected));

  expect(dataOf(actual).filter((_, i) => i % 9 === 0)).toContain(116.25);
});

it('preserves every prepared vertex and color when a codon strip crosses GPU batches', () => {
  const points: Point[] = [
    [0, 232],
    [8, 232],
    [11, 239],
    [8, 246],
    [0, 246],
    [3, 239],
  ];
  const reference = context(false);
  reference.prepareRepeatedPath(points, 'fill', true)!(0);
  const dataOf = (ctx: WebGLDrawingContext) =>
    ctx as unknown as {
      vertices: Float32Array;
      vertexCount: number;
    };
  const template = dataOf(reference).vertices.slice(0, dataOf(reference).vertexCount * 9);
  const ctx = context(false),
    raw = dataOf(ctx),
    chunks: Float32Array[] = [];
  ctx.flush = () => {
    chunks.push(raw.vertices.slice(0, raw.vertexCount * 9));
    raw.vertexCount = 0;
  };
  const paint = ctx.prepareRepeatedPath(points, 'fill', true)!;
  const expected = new Float32Array(template.length * 6000);
  for (let copy = 0; copy < 6000; copy++) {
    paint(copy * 4);
    const at = copy * template.length;
    expected.set(template, at);
    for (let vertex = 0; vertex < template.length; vertex += 9) expected[at + vertex] += copy * 8;
  }
  ctx.flush();
  expect(chunks.length).toBeGreaterThan(1);
  const actual = new Float32Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    actual.set(chunk, offset);
    offset += chunk.length;
  }

  expect(actual.length).toBe(expected.length);
  expect(
    Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(
      Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)
    )
  ).toBe(true);
});
