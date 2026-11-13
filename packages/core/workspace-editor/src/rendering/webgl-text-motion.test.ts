import { describe, expect, it, vi } from 'vitest';
import { WebGLDrawingContext } from './webgl-drawing-context';

function textContext() {
  const ctx = Object.create(WebGLDrawingContext.prototype) as WebGLDrawingContext;
  const atlas = {
    size: 2048,
    measure: vi.fn(() => ({
      width: 120,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 120,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    })),
    get: vi.fn(() => ({
      texture: {},
      layer: 0,
      x: 0,
      y: 0,
      width: 240,
      height: 24,
      left: 0,
      top: -10,
    })),
  };
  const quad = vi.fn();
  Object.assign(ctx, {
    canvas: { width: 2000, height: 1000 },
    atlas,
    state: {
      transform: [2, 0, 0, 2, 0, 0],
      font: '500 10px Inter',
      textAlign: 'center',
      textBaseline: 'middle',
      fillStyle: '#FFFFFF',
    },
    morphShape: (points: number[][]) => ({ points }),
    useTexture: vi.fn(),
    quad,
  });
  return { ctx, atlas, quad };
}

describe('continuous GPU text motion', () => {
  it('reuses one label raster across fractional movement without snapping the vertices', () => {
    const { ctx, atlas, quad } = textContext();
    for (let i = 0; i < 64; i++) ctx.fillText('INS | exon 1 (263 bp)', 300 + i / 64, 100 + i / 16);
    const rasterKeys = new Set(atlas.get.mock.calls.map((args) => JSON.stringify(args)));
    expect(rasterKeys.size).toBe(1);
    expect(quad.mock.calls[1][0][0][0] - quad.mock.calls[0][0][0][0]).toBeCloseTo(2 / 64, 7);
    expect(quad.mock.calls[1][0][0][1] - quad.mock.calls[0][0][0][1]).toBeCloseTo(2 / 16, 7);
  });

  it('retains exact font and retina size as distinct raster identities', () => {
    const { ctx, atlas } = textContext();
    ctx.fillText('INS', 300, 100);
    ctx.font = '500 11px Inter';
    ctx.fillText('INS', 300, 100);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillText('INS', 300, 100);
    expect(new Set(atlas.get.mock.calls.map((args) => JSON.stringify(args))).size).toBe(3);
  });

  it('preserves glyph placement and UVs under a full affine transform with a width limit', () => {
    const { ctx, atlas, quad } = textContext();
    ctx.setTransform(1.2, 1.6, -0.75, 1.25, 40, 20);
    ctx.fillText('INS', 300, 100, 60);

    expect(atlas.get).toHaveBeenCalledWith('INS', '500 10px Inter', 2, 'middle', 0);
    expect(quad).toHaveBeenCalledExactlyOnceWith(
      [
        [296.5, 564.5],
        [368.5, 660.5],
        [359.5, 675.5],
        [287.5, 579.5],
      ],
      [0, 0, 0.1171875, 0.01171875],
      '#FFFFFF',
      577,
      0
    );
  });
});

describe('resident text placement and admission', () => {
  const placements: Array<{
    name: string;
    transform: [number, number, number, number, number, number];
    align: CanvasTextAlign;
    x: number;
    y: number;
    maxWidth?: number;
    repeated?: boolean;
    morphY?: number;
  }> = [
    {
      name: 'fractional center',
      transform: [2, 0, 0, 2, 0.125, 0.375],
      align: 'center',
      x: 300.25,
      y: 100.125,
    },
    {
      name: 'right aligned maxWidth',
      transform: [2, 0, 0, 2, 0, 0],
      align: 'right',
      x: 300,
      y: 100,
      maxWidth: 37.125,
    },
    {
      name: 'rotated and sheared',
      transform: [1.25, 0.75, -0.25, 1.5, 200, 80],
      align: 'end',
      x: 200,
      y: 100,
    },
    { name: 'flipped', transform: [-2, 0, 0, -2, 1800, 800], align: 'left', x: 200, y: 100 },
    { name: 'hidden above', transform: [2, 0, 0, 2, 0, 0], align: 'center', x: 300, y: -50 },
    {
      name: 'morph moves below',
      transform: [2, 0, 0, 2, 0, 0],
      align: 'center',
      x: 300,
      y: 100,
      morphY: 1500,
    },
    { name: 'offscreen ordinary X', transform: [2, 0, 0, 2, 0, 0], align: 'left', x: 2000, y: 100 },
    {
      name: 'repeated X exception',
      transform: [2, 0, 0, 2, 0, 0],
      align: 'left',
      x: 2000,
      y: 100,
      repeated: true,
    },
  ];

  it.each(placements)('preserves full geometry and admission for $name', (placement) => {
    const cold = textContext();
    const warm = textContext();
    const metrics = {
      width: 120.125,
      actualBoundingBoxLeft: 0.125,
      actualBoundingBoxRight: 119.875,
      actualBoundingBoxAscent: 7.125,
      actualBoundingBoxDescent: 2.875,
    };
    const run = cold.atlas.get();
    cold.atlas.get.mockClear();
    cold.atlas.measure.mockReturnValue(metrics);
    cold.atlas.get.mockReturnValue(run);
    warm.atlas.measure.mockReturnValue(metrics);
    warm.atlas.get.mockReturnValue(run);
    const peek = vi.fn(() => ({ run, metrics }));
    Object.assign(warm.atlas, { peekResidentText: peek });
    const emitters = [vi.fn(), vi.fn()];
    for (const [index, { ctx }] of [cold, warm].entries()) {
      ctx.setTransform(...placement.transform);
      ctx.textAlign = placement.align;
      const morphY = placement.morphY;
      if (morphY !== undefined)
        Object.assign(ctx, {
          morphShape: (points: number[][]) => ({ points: points.map(([x, y]) => [x, y + morphY]) }),
        });
      const encoder = ctx as unknown as {
        textQuads(
          text: string,
          x: number,
          y: number,
          maxWidth: number | undefined,
          repeated: boolean,
          emit: (...args: unknown[]) => void
        ): void;
      };
      encoder.textQuads(
        'INS',
        placement.x,
        placement.y,
        placement.maxWidth,
        !!placement.repeated,
        emitters[index]
      );
    }
    expect(emitters[1].mock.calls).toEqual(emitters[0].mock.calls);
    expect(warm.atlas.measure).not.toHaveBeenCalled();
    expect(warm.atlas.get).not.toHaveBeenCalled();
    expect(peek).toHaveBeenCalledWith(
      'INS',
      '500 10px Inter',
      Math.max(1, Math.hypot(...placement.transform.slice(0, 2))),
      'middle'
    );
    expect(cold.atlas.get.mock.calls.length).toBe(emitters[0].mock.calls.length);
    const hidden = ['hidden above', 'morph moves below', 'offscreen ordinary X'].includes(
      placement.name
    );
    expect(emitters[0].mock.calls.length).toBe(hidden ? 0 : 1);
  });

  it('keeps measure then admitted tile gets when tile zero is absent', () => {
    const { ctx, atlas } = textContext();
    const peek = vi.fn(() => undefined);
    Object.assign(atlas, { peekResidentText: peek });
    atlas.measure.mockReturnValue({
      width: 1600.125,
      actualBoundingBoxLeft: 0.125,
      actualBoundingBoxRight: 1600.125,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    });
    ctx.textAlign = 'left';
    ctx.fillText('INS', -1100, 100);
    expect(peek).toHaveBeenCalledOnce();
    expect(atlas.measure).toHaveBeenCalledOnce();
    expect(atlas.get.mock.calls).toEqual([['INS', '500 10px Inter', 2, 'middle', 1]]);
  });
});
