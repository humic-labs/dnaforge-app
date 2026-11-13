import {
  Buffer as PixiBuffer,
  BufferUsage,
  Container,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  State,
} from 'pixi.js';

import {
  BP_COORDINATE_CHUNK_SIZE,
  bpCoordinateChunk,
  bpCoordinateDelta,
} from '../overview/bp-coordinate-packing';
import { destroyLayerShader } from '../shared/pixi-shader-lifecycle';
import { PILEUP_COVERAGE_ALPHA } from './pileup-coverage-resample';

const CORNERS = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
const INSTANCE_STRIDE_FLOATS = 6;
const INSTANCE_STRIDE_BYTES = INSTANCE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

export const COVERAGE_SIGNAL_INSTANCED_RENDER_OWNER = 'coverage-signal-instanced-fill' as const;

export function coverageSignalInstancedPresentationAlpha(transitionAlpha: number): number {
  return PILEUP_COVERAGE_ALPHA * Math.max(0, Math.min(1, transitionAlpha));
}

export interface CoverageSignalInstanceUpdate {
  readonly viewStartBp: number;
  readonly viewEndBp: number;
  readonly segmentHeights: Float32Array;
  readonly color: number;
}

export interface CoverageSignalCamera {
  readonly viewStartBp: number;
  readonly pixelsPerBp: number;
  readonly xOrigin: number;
  readonly y0: number;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
}

export interface CoverageSignalInstancedDiagnostics {
  readonly active: boolean;
  readonly instanceCount: number;
  readonly instanceCapacity: number;
  readonly geometryBuildCount: number;
  readonly bufferUploadCount: number;
  readonly cameraUniformUpdateCount: number;
  readonly renderOwner: string | null;
}

type CoverageSignalUniforms = {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uY0: number;
  uViewportSize: Float32Array;
  uCoverageColor: Float32Array;
  uAlpha: number;
  uHorizontalExcludeActive: number;
  uHorizontalExcludePx: Float32Array;
};

export const COVERAGE_SIGNAL_INSTANCED_VERTEX_SHADER = `
precision highp float;
attribute vec2 aCorner;
attribute vec4 aBpRange;
attribute vec2 aHeightRange;
uniform float uXScale;
uniform float uXOrigin;
uniform float uBpOriginChunk;
uniform float uBpOriginDelta;
uniform float uY0;
uniform vec2 uViewportSize;
varying float vScreenX;
const float BP_CHUNK_SIZE = ${BP_COORDINATE_CHUNK_SIZE}.0;
void main() {
  float startRel =
    (aBpRange.x - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpRange.y - uBpOriginDelta);
  float endRel =
    (aBpRange.z - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpRange.w - uBpOriginDelta);
  float x = mix(uXScale * startRel + uXOrigin, uXScale * endRel + uXOrigin, aCorner.x);
  float top = mix(aHeightRange.x, aHeightRange.y, aCorner.x);
  float y = uY0 + (aCorner.y > 0.5 ? top : 0.0);
  vec2 viewport = max(uViewportSize, vec2(1.0));
  vec2 clip = vec2((x / viewport.x) * 2.0 - 1.0, 1.0 - (y / viewport.y) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vScreenX = x;
}
`;

export const COVERAGE_SIGNAL_INSTANCED_FRAGMENT_SHADER = `
precision highp float;
uniform vec3 uCoverageColor;
uniform float uAlpha;
uniform float uHorizontalExcludeActive;
uniform vec2 uHorizontalExcludePx;
varying float vScreenX;
void main() {
  if (
    uHorizontalExcludeActive > 0.5 &&
    vScreenX >= uHorizontalExcludePx.x &&
    vScreenX <= uHorizontalExcludePx.y
  ) discard;
  float alpha = uAlpha;
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(uCoverageColor * alpha, alpha);
}
`;

function coverageSignalInstancedGlProgram(): GlProgram {
  return GlProgram.from({
    name: COVERAGE_SIGNAL_INSTANCED_RENDER_OWNER,
    vertex: COVERAGE_SIGNAL_INSTANCED_VERTEX_SHADER,
    fragment: COVERAGE_SIGNAL_INSTANCED_FRAGMENT_SHADER,
  });
}

export function packCoverageSignalInstances(
  target: Float32Array,
  input: Pick<CoverageSignalInstanceUpdate, 'viewStartBp' | 'viewEndBp' | 'segmentHeights'>
): number {
  const count = input.segmentHeights.length;
  if (!(input.viewEndBp > input.viewStartBp)) {
    throw new Error('coverage signal instances require a positive bp range');
  }
  if (target.length < count * INSTANCE_STRIDE_FLOATS) {
    throw new Error('coverage signal instance target is smaller than the requested column count');
  }
  const columnBp = (input.viewEndBp - input.viewStartBp) / Math.max(1, count);
  for (let column = 0; column < count; column += 1) {
    const startBp = input.viewStartBp + column * columnBp;
    const endBp = column === count - 1 ? input.viewEndBp : startBp + columnBp;
    const height = input.segmentHeights[column] ?? 0;
    const leftHeight =
      column > 0 ? ((input.segmentHeights[column - 1] ?? 0) + height) * 0.5 : height;
    const rightHeight =
      column < count - 1 ? ((input.segmentHeights[column + 1] ?? 0) + height) * 0.5 : height;
    const offset = column * INSTANCE_STRIDE_FLOATS;
    target[offset] = bpCoordinateChunk(startBp);
    target[offset + 1] = bpCoordinateDelta(startBp);
    target[offset + 2] = bpCoordinateChunk(endBp);
    target[offset + 3] = bpCoordinateDelta(endBp);
    target[offset + 4] = leftHeight;
    target[offset + 5] = rightHeight;
  }
  return count;
}

export class CoverageSignalInstancedLayer {
  private readonly container: Container;
  private data: Float32Array | null = null;
  private cornerBuffer: PixiBuffer | null = null;
  private instanceBuffer: PixiBuffer | null = null;
  private geometry: Geometry | null = null;
  private shader: Shader | null = null;
  private mesh: Mesh<Geometry, Shader> | null = null;
  private instanceCapacity = 0;
  private instanceCount = 0;
  private geometryBuildCount = 0;
  private bufferUploadCount = 0;
  private cameraUniformUpdateCount = 0;

  constructor(container: Container) {
    this.container = container;
  }

  static gpuProgram(): GlProgram {
    return coverageSignalInstancedGlProgram();
  }

  update(input: CoverageSignalInstanceUpdate): boolean {
    const count = input.segmentHeights.length;
    if (count === 0) {
      this.setVisible(false);
      this.instanceCount = 0;
      if (this.geometry) this.geometry.instanceCount = 0;
      return false;
    }
    this.ensureCapacity(count);
    packCoverageSignalInstances(this.data!, input);
    this.geometry!.instanceCount = count;
    this.instanceCount = count;
    this.instanceBuffer!.update();
    this.bufferUploadCount += 1;
    const uniforms = this.uniforms();
    uniforms.uCoverageColor[0] = ((input.color >> 16) & 0xff) / 255;
    uniforms.uCoverageColor[1] = ((input.color >> 8) & 0xff) / 255;
    uniforms.uCoverageColor[2] = (input.color & 0xff) / 255;
    this.mesh!.visible = true;
    return true;
  }

  applyCamera(input: CoverageSignalCamera): void {
    if (!this.mesh || !this.shader) return;
    const uniforms = this.uniforms();
    uniforms.uXScale = input.pixelsPerBp;
    uniforms.uXOrigin = input.xOrigin;
    uniforms.uBpOriginChunk = bpCoordinateChunk(input.viewStartBp);
    uniforms.uBpOriginDelta = bpCoordinateDelta(input.viewStartBp);
    uniforms.uY0 = input.y0;
    uniforms.uViewportSize[0] = input.viewportWidthPx;
    uniforms.uViewportSize[1] = input.viewportHeightPx;
    this.cameraUniformUpdateCount += 1;
  }

  setAlpha(alpha: number): void {
    if (this.shader) this.uniforms().uAlpha = coverageSignalInstancedPresentationAlpha(alpha);
  }

  setHorizontalExclusion(rangePx: readonly [number, number] | null): void {
    if (!this.shader) return;
    const uniforms = this.uniforms();
    uniforms.uHorizontalExcludeActive = rangePx ? 1 : 0;
    uniforms.uHorizontalExcludePx[0] = rangePx?.[0] ?? 0;
    uniforms.uHorizontalExcludePx[1] = rangePx?.[1] ?? 0;
  }

  setVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible && this.instanceCount > 0;
  }

  diagnostics(): CoverageSignalInstancedDiagnostics {
    return {
      active: this.mesh?.visible === true,
      instanceCount: this.instanceCount,
      instanceCapacity: this.instanceCapacity,
      geometryBuildCount: this.geometryBuildCount,
      bufferUploadCount: this.bufferUploadCount,
      cameraUniformUpdateCount: this.cameraUniformUpdateCount,
      renderOwner:
        this.mesh?.visible === true && this.mesh.parent === this.container
          ? this.mesh.label || null
          : null,
    };
  }

  destroy(): void {
    this.destroyResources();
    this.data = null;
    this.instanceCapacity = 0;
    this.instanceCount = 0;
  }

  private ensureCapacity(required: number): void {
    if (this.mesh && required <= this.instanceCapacity) return;
    const nextCapacity = Math.max(
      required,
      this.instanceCapacity > 0 ? this.instanceCapacity * 2 : 1
    );
    this.destroyResources();
    this.instanceCapacity = nextCapacity;
    this.data = new Float32Array(nextCapacity * INSTANCE_STRIDE_FLOATS);
    const cornerBuffer = new PixiBuffer({
      data: CORNERS,
      usage: BufferUsage.VERTEX,
      label: 'coverage-signal-corners',
      shrinkToFit: false,
    });
    const instanceBuffer = new PixiBuffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: 'coverage-signal-instances',
      shrinkToFit: false,
    });
    const instanceAttribute = (offsetFloats: number, format: 'float32x2' | 'float32x4') => ({
      buffer: instanceBuffer,
      format,
      stride: INSTANCE_STRIDE_BYTES,
      offset: offsetFloats * Float32Array.BYTES_PER_ELEMENT,
      instance: true,
    });
    const geometry = new Geometry({
      attributes: {
        aCorner: { buffer: cornerBuffer, format: 'float32x2' },
        aBpRange: instanceAttribute(0, 'float32x4'),
        aHeightRange: instanceAttribute(4, 'float32x2'),
      },
      topology: 'triangle-list',
      instanceCount: 0,
    });
    const viewport = new Float32Array([1, 1]);
    const color = new Float32Array([0, 0, 0]);
    const horizontalExclude = new Float32Array([0, 0]);
    const shader = new Shader({
      glProgram: coverageSignalInstancedGlProgram(),
      resources: {
        coverageSignalUniforms: {
          uXScale: { value: 1, type: 'f32' },
          uXOrigin: { value: 0, type: 'f32' },
          uBpOriginChunk: { value: 0, type: 'f32' },
          uBpOriginDelta: { value: 0, type: 'f32' },
          uY0: { value: 0, type: 'f32' },
          uViewportSize: { value: viewport, type: 'vec2<f32>' },
          uCoverageColor: { value: color, type: 'vec3<f32>' },
          uAlpha: { value: PILEUP_COVERAGE_ALPHA, type: 'f32' },
          uHorizontalExcludeActive: { value: 0, type: 'f32' },
          uHorizontalExcludePx: { value: horizontalExclude, type: 'vec2<f32>' },
        },
      },
    });
    const mesh = new Mesh<Geometry, Shader>({ geometry, shader, state: State.for2d() });
    mesh.label = COVERAGE_SIGNAL_INSTANCED_RENDER_OWNER;
    mesh.eventMode = 'none';
    mesh.visible = false;
    this.container.addChildAt(mesh, 0);
    this.cornerBuffer = cornerBuffer;
    this.instanceBuffer = instanceBuffer;
    this.geometry = geometry;
    this.shader = shader;
    this.mesh = mesh;
    this.geometryBuildCount += 1;
  }

  private uniforms(): CoverageSignalUniforms {
    return (
      this.shader!.resources.coverageSignalUniforms as {
        uniforms: CoverageSignalUniforms;
      }
    ).uniforms;
  }

  private destroyResources(): void {
    if (this.mesh?.parent) this.mesh.parent.removeChild(this.mesh);
    this.mesh?.destroy();
    this.geometry?.destroy(true);
    if (this.shader) destroyLayerShader(this.shader);
    this.mesh = null;
    this.geometry = null;
    this.shader = null;
    this.cornerBuffer = null;
    this.instanceBuffer = null;
  }
}
