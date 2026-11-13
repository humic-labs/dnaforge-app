import { expect, it, vi } from 'vitest';
import { WebGLDrawingContext } from './webgl-drawing-context';
import { drawCodonLetters, type CodonCellRenderData } from '../codon-rendering';

function context(morph: boolean, fontSensitive = false) {
  const ctx = Object.create(WebGLDrawingContext.prototype) as WebGLDrawingContext;
  const texture = {};
  const atlas = {
    size: 2048,
    generation: 0,
    measure: vi.fn((text: string, font: string) => ({
      width: fontSensitive
        ? Number(font.match(/([\d.]+)px/)![1]) * (text === 'pAzF' ? 2 : 0.75)
        : 10.25,
      actualBoundingBoxLeft: 1,
      actualBoundingBoxRight: 10,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 3,
    })),
    get: vi.fn((_text: string, font: string) => ({
      texture,
      layer: 2,
      x: 32,
      y: 64,
      width: fontSensitive ? Number(font.match(/([\d.]+)px/)![1]) * 2 : 22,
      height: fontSensitive ? Number(font.match(/([\d.]+)px/)![1]) * 2 + 4 : 26,
      left: -1,
      top: -9,
    })),
  };
  Object.assign(ctx, {
    canvas: { width: 2000, height: 1000 },
    atlas,
    state: {
      transform: [2, 0, 0, 2, 17.25, -400.5],
      font: '500 10.25px Inter',
      textAlign: 'center',
      textBaseline: 'middle',
      fillStyle: '#56789A',
      globalAlpha: 0.6,
      dash: [],
      clips: [],
    },
    vertices: new Float32Array(65532 * 9),
    vertexCount: 0,
    colors: new Map(),
    useTexture: vi.fn(),
  });
  if (morph) ctx.setRowMorphBands({ natural: [0, 10, 30, 50], painted: [0, 10, 22, 50] }, 220);
  return { ctx, atlas };
}

function vertices(ctx: WebGLDrawingContext) {
  const raw = ctx as unknown as { vertices: Float32Array; vertexCount: number };
  return [...raw.vertices.subarray(0, raw.vertexCount * 9)];
}

function vertexBits(ctx: WebGLDrawingContext) {
  const raw = ctx as unknown as { vertices: Float32Array; vertexCount: number };
  return new Uint32Array(raw.vertices.buffer, raw.vertices.byteOffset, raw.vertexCount * 9);
}

it('prepares repeated codon labels per exact font while preserving ordinary glyph bytes and live colors', () => {
  for (const morph of [false, true])
    for (const direction of [1, -1] as const) {
      const { ctx: actual, atlas } = context(morph, true),
        { ctx: expected } = context(morph, true);
      Object.defineProperty(expected, 'prepareRepeatedText', { value: undefined });
      const prepared = vi.spyOn(actual, 'prepareRepeatedText');
      const cells: CodonCellRenderData[] = Array.from({ length: 24 }, (_, i) => ({
        codonX: 100.125 + i * 24.375,
        visibleWidth: i % 5 === 0 ? (i % 2 === 0 ? 20 : 26) : 24.375,
        leftEdge: 'chevron',
        rightEdge: 'chevron',
        aa: i % 3 === 0 ? '*' : 'M',
        renderLetter: i !== 7,
        ...(i % 5 === 0
          ? { display: { short: 'X', full: 'pAzF', kind: 'residue' as const } }
          : i % 5 === 1
            ? { display: { short: 'X', full: '?', kind: 'unassigned' as const } }
            : {}),
      }));
      drawCodonLetters(actual, cells, 232, 14, 3, direction, '#112233', 10.25, 'Inter');
      drawCodonLetters(expected, cells, 232, 14, 3, direction, '#112233', 10.25, 'Inter');
      expect(vertices(actual)).toEqual(vertices(expected));
      expect(prepared).toHaveBeenCalled();
      expect(prepared.mock.calls.length).toBeLessThan(8);
      expect(atlas.get.mock.calls.length).toBe(prepared.mock.calls.length);
      const residueFonts = new Set(
        atlas.get.mock.calls.filter(([text]) => text === 'pAzF').map(([, font]) => font)
      );
      expect(residueFonts.size).toBe(2);
      expect(actual.font).toBe(expected.font);
      expect(actual.fillStyle).toBe(expected.fillStyle);
    }
});

it.each([false, true])(
  'repeated text preserves exact glyph coverage, UVs and live color through row clipping: %s',
  (morph) => {
    for (const align of ['left', 'center', 'right'] as const)
      for (const maxWidth of [undefined, 6]) {
        const { ctx: actual, atlas } = context(morph),
          { ctx: expected } = context(morph);
        actual.textAlign = expected.textAlign = align;
        const paint = actual.prepareRepeatedText('A', 238, maxWidth);
        expect(paint).toBeTypeOf('function');
        for (const [i, x] of [100.125, 143.75, 272.625].entries()) {
          actual.globalAlpha = expected.globalAlpha = 0.4 + i / 5;
          actual.fillStyle = expected.fillStyle = i % 2 ? '#FF6600' : '#112233';
          paint!(x);
          expected.fillText('A', x, 238, maxWidth);
        }
        expect(vertices(actual)).toEqual(vertices(expected));
        expect(atlas.measure).toHaveBeenCalledTimes(1);
        expect(atlas.get).toHaveBeenCalledTimes(1);
      }
  }
);

it('preserves color bits through unchanged solids, alpha-only changes and signed zero', () => {
  const { ctx: actual } = context(true),
    { ctx: expected } = context(true);
  const paint = actual.prepareRepeatedText('A', 238, 6)!;
  const styles: [string, number][] = [
    ['rgb(0, 34, 51)', 0.4],
    ['rgb(0, 34, 51)', 0.4],
    ['rgb(0, 34, 51)', 0.65],
    ['rgb(-0, 34, 51)', 0.65],
    ['rgb(-0, 34, 51)', -0],
    ['rgb(0, 34, 51)', 0],
    ['rgb(0, 34, 51)', 0.65],
  ];
  for (const [i, [fill, alpha]] of styles.entries()) {
    actual.fillStyle = expected.fillStyle = fill;
    actual.globalAlpha = expected.globalAlpha = alpha;
    const x = 100.125 + i * 32.5;
    paint(x);
    expected.fillText('A', x, 238, 6);
  }
  expect(vertexBits(actual)).toEqual(vertexBits(expected));
});

it('preserves interleaved glyph bits through solid, gradient and solid paints with canceling X', () => {
  const { ctx: actual, atlas: actualAtlas } = context(false),
    { ctx: expected, atlas: expectedAtlas } = context(false);
  const y = 238 + 2 ** -20;
  const baseRun = actualAtlas.get();
  const glyphs = [
    {
      text: 'A',
      y,
      font: '500 10.25px Inter',
      run: { ...baseRun, x: 32 + 1 / 7, y: 64 + 1 / 11 },
    },
    {
      text: 'G',
      y: y + 7.25,
      font: '600 11.25px Inter',
      run: { ...baseRun, layer: 3, x: 96 + 1 / 13, y: 128 + 1 / 17 },
    },
  ];
  for (const ctx of [actual, expected]) ctx.setTransform(2, 0, 0, 2, 16777216.25, -400.5);
  const painters = glyphs.map((glyph) => {
    actual.font = glyph.font;
    actualAtlas.get.mockReturnValue(glyph.run);
    return actual.prepareRepeatedText(glyph.text, glyph.y)!;
  });
  for (const [i, x] of [-8388544, -8388543.875, -8388536.25].entries()) {
    for (const ctx of [actual, expected]) {
      ctx.globalAlpha = 0.35 + i / 8;
      if (i === 1) {
        const gradient = ctx.createLinearGradient(x, y - 12, x, y + 12);
        gradient.addColorStop(0, '#123456');
        gradient.addColorStop(1, '#FEDCBA');
        ctx.fillStyle = gradient;
      } else ctx.fillStyle = i === 0 ? '#336699' : 'rgba(220, 30, 70, 0.45)';
    }
    for (const [index, glyph] of glyphs.entries()) {
      painters[index](x);
      expected.font = glyph.font;
      expectedAtlas.get.mockReturnValue(glyph.run);
      expected.fillText(glyph.text, x, glyph.y);
      expect(vertexBits(actual)).toEqual(vertexBits(expected));
    }
  }
  expect(vertices(actual)).toHaveLength(6 * 6 * 9);

  expect(vertices(actual).filter((_, i) => i % 9 === 0)).toContain(116.25);
});

it.each(['x', 'y', 'u', 'v'] as const)(
  'preserves ordinary emitted bits with an exceptional %s coordinate',
  (field) => {
    const { ctx: actual, atlas: actualAtlas } = context(false),
      { ctx: expected, atlas: expectedAtlas } = context(false);
    const run = actualAtlas.get();
    if (field === 'u') run.x = Infinity;
    if (field === 'v') run.y = -Infinity;
    actualAtlas.get.mockReturnValue(run);
    expectedAtlas.get.mockReturnValue(run);
    for (const ctx of [actual, expected])
      ctx.setTransform(2, 0, 0, 2, field === 'x' ? NaN : 17.25, -400.5);
    const y = field === 'y' ? NaN : 238;
    const paint = actual.prepareRepeatedText('A', y)!;
    paint(100.125);
    expected.fillText('A', 100.125, y);
    expect(vertexBits(actual)).toHaveLength(6 * 9);
    expect(vertexBits(actual)).toEqual(vertexBits(expected));
  }
);

it('uses the general text route for rotated placements', () => {
  const { ctx } = context(false);
  ctx.rotate(0.1);
  expect(ctx.prepareRepeatedText('A', 238)).toBeNull();
});

it('refreshes a reused atlas layer while retaining the prepared font and transformed glyph placement', () => {
  const { ctx, atlas } = context(false);
  const paint = ctx.prepareRepeatedText('A', 238)!;
  paint(100);
  const before = vertices(ctx);
  (ctx as unknown as { vertexCount: number }).vertexCount = 0;
  atlas.get.mockReturnValue({
    texture: {},
    layer: 3,
    x: 96,
    y: 96,
    width: 22,
    height: 26,
    left: -1,
    top: -9,
  });
  atlas.generation++;
  ctx.font = '500 99px Other';
  ctx.setTransform(4, 0, 0, 4, 700, 800);
  paint(100);
  const after = vertices(ctx);
  expect(atlas.get.mock.calls.at(-1)).toEqual(['A', '500 10.25px Inter', 2, 'middle', 0]);
  for (let vertex = 0; vertex < before.length; vertex += 9) {
    for (const field of [0, 1, 4, 5, 6, 7])
      expect(after[vertex + field]).toBe(before[vertex + field]);
    expect(after[vertex + 2] - before[vertex + 2]).toBeCloseTo(64 / 2048, 7);
    expect(after[vertex + 3] - before[vertex + 3]).toBeCloseTo(32 / 2048, 7);
    expect(after[vertex + 8]).toBe(3);
  }
  paint(120);
  expect(vertices(ctx)[after.length] - after[0]).toBe(40);
});

it.each([65529, 65532])(
  'preserves clipped text bytes and live colors with %i vertices already in the batch',
  (initialCount) => {
    const { ctx: actual } = context(true),
      { ctx: expected } = context(true);
    const capture = (ctx: WebGLDrawingContext) => {
      const raw = ctx as unknown as { vertices: Float32Array; vertexCount: number };
      raw.vertexCount = initialCount;
      raw.vertices.fill(0.375, 65526 * 9, initialCount * 9);
      const chunks: Float32Array[] = [];
      ctx.flush = () => {
        chunks.push(raw.vertices.slice(chunks.length ? 0 : 65526 * 9, raw.vertexCount * 9));
        raw.vertexCount = 0;
      };
      return chunks;
    };
    const actualChunks = capture(actual),
      expectedChunks = capture(expected);
    const paint = actual.prepareRepeatedText('A', 238, 6)!;
    for (const [i, x] of [100.125, 143.75, 272.625].entries()) {
      actual.globalAlpha = expected.globalAlpha = 0.4 + i / 5;
      actual.fillStyle = expected.fillStyle = i % 2 ? '#FF6600' : '#112233';
      paint(x);
      expected.fillText('A', x, 238, 6);
    }
    actual.flush();
    expected.flush();
    expect(actualChunks).toHaveLength(2);
    expect(actualChunks).toEqual(expectedChunks);
  }
);
