import { expect, it, vi } from 'vitest';
import { WebGLDrawingContext } from './webgl-drawing-context';

it.each([
  { painted: [0, 30, 50, 70], expectedY: [44, 48] },
  { painted: [0, 0, 20, 40], expectedY: [14, 18] },
])(
  'moves the stencil with its row while preserving its shape: $painted',
  ({ painted, expectedY }) => {
    const gl = {
      SCISSOR_TEST: 3089,
      STENCIL_TEST: 2960,
      STENCIL_BUFFER_BIT: 1024,
      EQUAL: 514,
      KEEP: 7680,
      INCR: 7682,
      enable: vi.fn(),
      disable: vi.fn(),
      scissor: vi.fn(),
      stencilMask: vi.fn(),
      clear: vi.fn(),
      stencilFunc: vi.fn(),
      stencilOp: vi.fn(),
      colorMask: vi.fn(),
    };
    const ctx = Object.create(WebGLDrawingContext.prototype) as WebGLDrawingContext;
    const vertices = new Float32Array(128 * 9);
    Object.assign(ctx, {
      gl,
      canvas: { width: 100, height: 100 },
      vertices,
      vertexCount: 0,
      colors: new Map(),
      atlas: { size: 2048, solidTexture: {} },
      flush: vi.fn(),
      useTexture: vi.fn(),
      state: {
        transform: [1, 0, 0, 1, 0, 0],
        globalAlpha: 1,
        clips: [],
        rowMorph: { natural: [0, 10, 30, 50], painted },
        rowMorphPadding: 2,
      },
      paths: [
        {
          points: [
            [10, 24],
            [20, 24],
            [20, 28],
            [10, 28],
          ],
          closed: true,
        },
      ],
    });
    ctx.clip();
    const count = (ctx as unknown as { vertexCount: number }).vertexCount;
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      expect(vertices[i * 9]).toBeGreaterThanOrEqual(10);
      expect(vertices[i * 9]).toBeLessThanOrEqual(20);
      expect(vertices[i * 9 + 1]).toBeGreaterThanOrEqual(expectedY[0]);
      expect(vertices[i * 9 + 1]).toBeLessThanOrEqual(expectedY[1]);
    }
    const ys = Array.from({ length: count }, (_, i) => vertices[i * 9 + 1]);
    expect(Math.min(...ys)).toBe(expectedY[0]);
    expect(Math.max(...ys)).toBe(expectedY[1]);
    expect(gl.stencilFunc).toHaveBeenLastCalledWith(gl.EQUAL, 1, 0xff);
    expect(gl.colorMask).toHaveBeenLastCalledWith(true, true, true, true);
    expect(gl.stencilMask).toHaveBeenLastCalledWith(0);
  }
);
