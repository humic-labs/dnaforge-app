import { expect, it, vi } from 'vitest';
import { WebGLDrawingContext } from './webgl-drawing-context';

it('uploads each ordinary and stencil batch before submitting its draw', () => {
  const operations: string[] = [];
  const uploads: number[][] = [];
  const gl = {
    ARRAY_BUFFER: 1,
    STREAM_DRAW: 2,
    TEXTURE_2D_ARRAY: 3,
    TRIANGLES: 4,
    isContextLost: () => false,
    useProgram: vi.fn(),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bindTexture: vi.fn(),
    bufferData: vi.fn((_target, data: Float32Array) => {
      operations.push('upload');
      uploads.push([...data]);
    }),
    bufferSubData: vi.fn((_target, _offset, data: Float32Array) => {
      operations.push('upload');
      uploads.push([...data]);
    }),
    drawArrays: vi.fn(() => {
      operations.push('draw');
    }),
  };
  const ctx = Object.create(WebGLDrawingContext.prototype) as WebGLDrawingContext;
  const vertices = new Float32Array(128);
  Object.assign(ctx, {
    gl,
    vertices,
    geometryLayer: null,
    batchTexture: {},
    atlas: { uploadPending: vi.fn() },
    drawCalls: 0,
    frameVertices: 0,
  });
  for (const value of [1, 2, 3]) {
    vertices.fill(value);
    Object.assign(ctx, { vertexCount: 3 });
    ctx.flush();
  }
  expect(operations).toEqual(['upload', 'draw', 'upload', 'draw', 'upload', 'draw']);
  expect(uploads).toEqual([1, 2, 3].map((value) => Array(27).fill(value)));
  expect(gl.drawArrays.mock.calls).toEqual(Array(3).fill([gl.TRIANGLES, 0, 3]));
  expect(gl.bufferData.mock.calls.length + gl.bufferSubData.mock.calls.length).toBe(3);
});
