import { expect, it, vi } from 'vitest';
import { RetainedWebGLBatches } from './retained-webgl-batches';

function setup() {
  const gl = {
    ARRAY_BUFFER: 1,
    FLOAT: 2,
    DYNAMIC_DRAW: 3,
    STREAM_DRAW: 6,
    TEXTURE_2D_ARRAY: 4,
    TRIANGLES: 5,
    createBuffer: vi.fn(() => ({})),
    createVertexArray: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bindVertexArray: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    bufferData: vi.fn(),
    bufferSubData: vi.fn(),
    bindTexture: vi.fn(),
    drawArrays: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteVertexArray: vi.fn(),
  };
  const batches = new RetainedWebGLBatches(gl as unknown as WebGL2RenderingContext);
  const texture = {} as WebGLTexture;
  return { gl, batches, texture };
}

it('never overwrites GPU storage still used by a preceding draw', () => {
  const { gl, batches, texture } = setup();
  const busy = new Set<object>();
  const bound = () => gl.bindBuffer.mock.calls.at(-1)![1];
  let overwrites = 0;
  gl.drawArrays.mockImplementation(() => busy.add(bound()));
  gl.bufferData.mockImplementation(() => busy.delete(bound()));
  gl.bufferSubData.mockImplementation(() => {
    if (busy.has(bound())) overwrites++;
  });
  for (const value of [1, 2, 2, 3]) {
    batches.beginFrame();
    batches.draw('scientific', new Float32Array(27).fill(value), texture);
    batches.endFrame();
  }
  expect(overwrites).toBe(0);
  expect(gl.bufferSubData).not.toHaveBeenCalled();
  expect(gl.bufferData).toHaveBeenCalledTimes(3);
  for (const [, data, usage] of gl.bufferData.mock.calls) {
    expect(data).toBeInstanceOf(Float32Array);
    expect(usage).toBe(gl.STREAM_DRAW);
  }
  expect(gl.createBuffer).toHaveBeenCalledTimes(1);
  expect(gl.createVertexArray).toHaveBeenCalledTimes(1);
});

it('retains unchanged scientific uploads while selection geometry changes', () => {
  const { gl, batches, texture } = setup();
  const glyphs = new Float32Array(27).fill(7);
  for (let frame = 0; frame < 24; frame++) {
    batches.beginFrame();
    batches.draw('selection', new Float32Array(27).fill(frame), texture);
    batches.draw('scientific', glyphs, texture);
    batches.endFrame();
  }
  expect(
    gl.bufferData.mock.calls.filter((call) => call[1][0] === 7 && call[1] === glyphs)
  ).toHaveLength(1);
  expect(gl.drawArrays).toHaveBeenCalledTimes(48);
  expect(gl.createBuffer).toHaveBeenCalledTimes(2);
});

it('uploads changed glyph positions, colors or UVs and grows the buffer safely', () => {
  const { gl, batches, texture } = setup();
  const data = new Float32Array(27).fill(1);
  for (const index of [0, 2, 4]) {
    batches.beginFrame();
    data[index]++;
    batches.draw('scientific', data, texture);
    batches.endFrame();
  }
  batches.beginFrame();
  batches.draw('scientific', new Float32Array(54), texture);
  batches.endFrame();
  expect(gl.bufferSubData).not.toHaveBeenCalled();
  expect(gl.bufferData).toHaveBeenCalledTimes(4);
  expect(gl.drawArrays).toHaveBeenLastCalledWith(gl.TRIANGLES, 0, 6);
});

it('releases batches no longer in the current viewport and all resources on disposal', () => {
  const { gl, batches, texture } = setup();
  batches.beginFrame();
  batches.draw('scientific', new Float32Array(27), texture);
  batches.draw('scientific', new Float32Array(27), texture);
  batches.endFrame();
  batches.beginFrame();
  batches.draw('scientific', new Float32Array(27), texture);
  batches.endFrame();
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);
  expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
  batches.dispose();
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
  expect(gl.deleteVertexArray).toHaveBeenCalledTimes(2);
});

it('reuses CPU capacity and GPU objects while streaming changing vertex counts', () => {
  const { gl, batches, texture } = setup();
  const allocations = new Set<Float32Array>();
  for (let frame = 0; frame < 32; frame++) {
    const data = new Float32Array((2000 - (frame % 11)) * 27).fill(frame);
    batches.beginFrame();
    batches.draw('scientific', data, texture);
    batches.endFrame();
    const resident = (
      batches as unknown as {
        batches: Map<string, { data: Float32Array }>;
      }
    ).batches.get('scientific:0')!;
    allocations.add(resident.data);
    expect([...resident.data.subarray(0, data.length)]).toEqual([...data]);
    expect(gl.drawArrays).toHaveBeenLastCalledWith(gl.TRIANGLES, 0, data.length / 9);
  }
  expect(allocations.size).toBe(1);
  expect(gl.createBuffer).toHaveBeenCalledTimes(1);
  expect(gl.createVertexArray).toHaveBeenCalledTimes(1);
  expect(gl.bufferData).toHaveBeenCalledTimes(32);
  expect(gl.bufferSubData).not.toHaveBeenCalled();
  for (let i = 0; i < gl.bufferData.mock.calls.length; i++) {
    const data = gl.bufferData.mock.calls[i][1] as Float32Array;
    expect(data.length).toBe((2000 - (i % 11)) * 27);
  }
});

it('retains the exact nine-float layout and explicit atlas layer without changing vertex count', () => {
  const { gl, batches, texture } = setup();
  const data = new Float32Array(27);
  data[8] = data[17] = data[26] = 3;
  batches.beginFrame();
  batches.draw('scientific', data, texture);
  expect(gl.vertexAttribPointer.mock.calls).toEqual([
    [0, 2, gl.FLOAT, false, 36, 0],
    [1, 2, gl.FLOAT, false, 36, 8],
    [2, 4, gl.FLOAT, false, 36, 16],
    [3, 1, gl.FLOAT, false, 36, 32],
  ]);
  expect(gl.bindTexture).toHaveBeenCalledWith(gl.TEXTURE_2D_ARRAY, texture);
  expect(gl.drawArrays).toHaveBeenCalledWith(gl.TRIANGLES, 0, 3);
  expect(gl.bufferData.mock.calls[0][1]).toEqual(data);
});
