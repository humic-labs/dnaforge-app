import { SEQUENCE_VERTEX_BYTES, SEQUENCE_VERTEX_FLOATS } from './webgl-vertex-layout';

export class RetainedWebGLBatches {
  private readonly batches = new Map<
    string,
    { buffer: WebGLBuffer; vao: WebGLVertexArrayObject; data: Float32Array; length: number }
  >();
  private readonly ordinals = new Map<string, number>();
  private readonly used = new Set<string>();

  constructor(private readonly gl: WebGL2RenderingContext) {}

  beginFrame(): void {
    this.ordinals.clear();
    this.used.clear();
  }

  draw(layer: string, data: Float32Array, texture: WebGLTexture): void {
    const gl = this.gl;
    const ordinal = this.ordinals.get(layer) ?? 0;
    this.ordinals.set(layer, ordinal + 1);
    const key = `${layer}:${ordinal}`;
    this.used.add(key);
    let batch = this.batches.get(key);
    if (!batch) {
      const buffer = gl.createBuffer();
      const vao = gl.createVertexArray();
      if (!buffer || !vao) {
        if (buffer) gl.deleteBuffer(buffer);
        if (vao) gl.deleteVertexArray(vao);
        throw new Error('Unable to retain sequence GPU geometry');
      }
      batch = { buffer, vao, data: new Float32Array(0), length: 0 };
      this.batches.set(key, batch);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      for (const [attribute, size, offset] of [
        [0, 2, 0],
        [1, 2, 8],
        [2, 4, 16],
        [3, 1, 32],
      ]) {
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, SEQUENCE_VERTEX_BYTES, offset);
      }
    }
    gl.bindVertexArray(batch.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
    if (batch.data.length < data.length) {
      const capacity = Math.max(data.length, batch.data.length * 2);
      batch.data = new Float32Array(capacity);
      batch.length = -1;
    }
    let changed = batch.length !== data.length;
    for (let i = 0; !changed && i < data.length; i++) changed = batch.data[i] !== data[i];
    if (changed) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      batch.data.set(data);
      batch.length = data.length;
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / SEQUENCE_VERTEX_FLOATS);
  }

  endFrame(): void {
    for (const [key, batch] of this.batches) {
      if (this.used.has(key)) continue;
      this.gl.deleteBuffer(batch.buffer);
      this.gl.deleteVertexArray(batch.vao);
      this.batches.delete(key);
    }
  }

  dispose(): void {
    for (const batch of this.batches.values()) {
      this.gl.deleteBuffer(batch.buffer);
      this.gl.deleteVertexArray(batch.vao);
    }
    this.batches.clear();
    this.beginFrame();
  }
}
