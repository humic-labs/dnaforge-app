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

import { destroyLayerShader } from '../shared/pixi-shader-lifecycle';
import { webglAnnotationColorForMode, type WebGLThemeMode } from '../shared/theme';
import type { StadiumRetainedCameraParams } from '../shared/path-mapper';
import type { OverviewBin } from '../overlays/annotation-overview-cache';
import type { RetainedOverviewAnnotationStyle } from '../overlays/annotation-lod-policy';

const RETAINED_OVERVIEW_VERTEX_SHADER = `
precision highp float;

attribute float aBp;
attribute float aNormalOffset;
attribute vec4 aColor;

uniform float uGenomeLength;
uniform float uViewOffset;
uniform float uZoom;
uniform float uOffsetScale;
uniform vec4 uDims;      // width, height, radius, straightLength
uniform vec2 uOrigin;    // world origin offset before zoom
uniform vec2 uStagePos;  // screen translation after zoom
uniform vec2 uViewportSize;

varying vec4 vColor;

const float PI = 3.141592653589793;

float wrap01(float value) {
  return mod(mod(value, 1.0) + 1.0, 1.0);
}

vec3 stadiumPoint(float bp) {
  float radius = uDims.z;
  float straightLength = uDims.w;
  float totalLength = max(1.0, 2.0 * straightLength + 2.0 * PI * radius);
  float capLength = PI * radius;
  float topEnd = straightLength / totalLength;
  float rightCapEnd = (straightLength + capLength) / totalLength;
  float bottomEnd = (2.0 * straightLength + capLength) / totalLength;
  float pos = wrap01((bp - uViewOffset * uGenomeLength) / max(1.0, uGenomeLength));
  float leftCenterX = radius;
  float rightCenterX = radius + straightLength;
  float centerY = radius;

  if (straightLength > 0.0 && pos < topEnd) {
    float t = pos / max(topEnd, 0.000001);
    return vec3(leftCenterX + t * straightLength, 0.0, 0.0);
  }

  if (pos < rightCapEnd) {
    float denom = max(rightCapEnd - topEnd, 0.000001);
    float t = topEnd > 0.0 ? (pos - topEnd) / denom : pos / max(rightCapEnd, 0.000001);
    float angle = -PI * 0.5 + t * PI;
    return vec3(
      rightCenterX + radius * cos(angle),
      centerY + radius * sin(angle),
      angle + PI * 0.5
    );
  }

  if (straightLength > 0.0 && pos < bottomEnd) {
    float t = (pos - rightCapEnd) / max(bottomEnd - rightCapEnd, 0.000001);
    return vec3(rightCenterX - t * straightLength, 2.0 * radius, PI);
  }

  float t = bottomEnd < 1.0 ? (pos - bottomEnd) / max(1.0 - bottomEnd, 0.000001) : 0.0;
  float angle = PI * 0.5 + t * PI;
  return vec3(
    leftCenterX + radius * cos(angle),
    centerY + radius * sin(angle),
    angle + PI * 0.5
  );
}

void main() {
  vec3 point = stadiumPoint(aBp);
  vec2 screen = (uOrigin + point.xy) * uZoom + uStagePos;
  vec2 normal = vec2(-sin(point.z), cos(point.z));
  screen += normal * aNormalOffset * uOffsetScale;

  vec2 viewport = max(uViewportSize, vec2(1.0, 1.0));
  vec2 clip = vec2((screen.x / viewport.x) * 2.0 - 1.0, 1.0 - (screen.y / viewport.y) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vColor = aColor;
}
`;

const RETAINED_OVERVIEW_FRAGMENT_SHADER = `
precision mediump float;

varying vec4 vColor;

void main() {
  gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
}
`;

export type RetainedOverviewUniforms = {
  uGenomeLength: number;
  uViewOffset: number;
  uZoom: number;
  uOffsetScale: number;
  uDims: Float32Array;
  uOrigin: Float32Array;
  uStagePos: Float32Array;
  uViewportSize: Float32Array;
};

function overviewAlphaForStyle(bin: OverviewBin, style: RetainedOverviewAnnotationStyle): number {
  if (style === 'retained') return bin.alpha;
  const coverage = Math.max(0, Math.min(1, bin.coverageRatio || 0));
  return bin.alpha * Math.sqrt(coverage);
}

export interface RetainedOverviewVertexBuffers {
  readonly bps: Float32Array;
  readonly normalOffsets: Float32Array;
  readonly colors: Float32Array;
}

export function buildRetainedOverviewVertexBuffers(
  bins: readonly OverviewBin[],
  style: RetainedOverviewAnnotationStyle,
  themeMode: WebGLThemeMode | undefined
): RetainedOverviewVertexBuffers {
  const vertexCount = bins.length * 6;
  const bps = new Float32Array(vertexCount);
  const normalOffsets = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 4);
  let vertex = 0;
  let colorIndex = 0;
  for (const bin of bins) {
    const color = webglAnnotationColorForMode(bin.color, themeMode);
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    const a = overviewAlphaForStyle(bin, style);
    const outerOffset = bin.offset - bin.halfHeight;
    const innerOffset = bin.offset + bin.halfHeight;
    const { startBp, endBp } = bin;
    bps[vertex] = startBp;
    normalOffsets[vertex++] = outerOffset;
    bps[vertex] = endBp;
    normalOffsets[vertex++] = outerOffset;
    bps[vertex] = endBp;
    normalOffsets[vertex++] = innerOffset;
    bps[vertex] = startBp;
    normalOffsets[vertex++] = outerOffset;
    bps[vertex] = endBp;
    normalOffsets[vertex++] = innerOffset;
    bps[vertex] = startBp;
    normalOffsets[vertex++] = innerOffset;
    for (let corner = 0; corner < 6; corner++) {
      colors[colorIndex++] = r;
      colors[colorIndex++] = g;
      colors[colorIndex++] = b;
      colors[colorIndex++] = a;
    }
  }
  return { bps, normalOffsets, colors };
}

const RETAINED_OVERVIEW_BUILT_BUFFER_KEEP = 3;

export class RetainedOverviewAnnotationLayer {
  readonly container = new Container();
  private readonly builtBuffers = new Map<string, RetainedOverviewVertexBuffers>();

  private readonly bpBuffer = new PixiBuffer({
    data: new Float32Array(0),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    label: 'retained-overview-annotation-bp',
    shrinkToFit: false,
  });
  private readonly normalOffsetBuffer = new PixiBuffer({
    data: new Float32Array(0),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    label: 'retained-overview-annotation-normal-offset',
    shrinkToFit: false,
  });
  private readonly colorBuffer = new PixiBuffer({
    data: new Float32Array(0),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    label: 'retained-overview-annotation-color',
    shrinkToFit: false,
  });

  private readonly dimsUniform = new Float32Array(4);
  private readonly originUniform = new Float32Array(2);
  private readonly stagePosUniform = new Float32Array(2);
  private readonly viewportUniform = new Float32Array(2);
  private readonly geometry = new Geometry({
    attributes: {
      aBp: { buffer: this.bpBuffer, format: 'float32' },
      aNormalOffset: { buffer: this.normalOffsetBuffer, format: 'float32' },
      aColor: { buffer: this.colorBuffer, format: 'float32x4' },
    },
    topology: 'triangle-list',
  });
  private readonly shader = new Shader({
    glProgram: GlProgram.from({
      name: 'retained-overview-annotation-bodies',
      vertex: RETAINED_OVERVIEW_VERTEX_SHADER,
      fragment: RETAINED_OVERVIEW_FRAGMENT_SHADER,
    }),
    resources: {
      overviewUniforms: {
        uGenomeLength: { value: 1, type: 'f32' },
        uViewOffset: { value: 0, type: 'f32' },
        uZoom: { value: 1, type: 'f32' },
        uOffsetScale: { value: 1, type: 'f32' },
        uDims: { value: this.dimsUniform, type: 'vec4<f32>' },
        uOrigin: { value: this.originUniform, type: 'vec2<f32>' },
        uStagePos: { value: this.stagePosUniform, type: 'vec2<f32>' },
        uViewportSize: { value: this.viewportUniform, type: 'vec2<f32>' },
      },
    },
  });
  private readonly mesh = new Mesh({
    geometry: this.geometry,
    shader: this.shader,
    state: State.for2d(),
  });

  private dataKey = '';
  retainedInstanceCount = 0;

  constructor() {
    this.container.eventMode = 'none';
    this.mesh.eventMode = 'none';
    this.mesh.visible = false;
    this.container.addChild(this.mesh);
  }

  syncData(
    key: string,
    bins: OverviewBin[],
    style: RetainedOverviewAnnotationStyle,
    themeMode: WebGLThemeMode | undefined
  ): boolean {
    if (this.dataKey === key) return false;

    let built = this.builtBuffers.get(key);
    if (!built) {
      built = buildRetainedOverviewVertexBuffers(bins, style, themeMode);
      this.builtBuffers.set(key, built);
      while (this.builtBuffers.size > RETAINED_OVERVIEW_BUILT_BUFFER_KEEP) {
        const oldest = this.builtBuffers.keys().next().value;
        if (oldest === undefined) break;
        this.builtBuffers.delete(oldest);
      }
    } else {
      this.builtBuffers.delete(key);
      this.builtBuffers.set(key, built);
    }
    const { bps, normalOffsets, colors } = built;

    this.dataKey = key;
    this.retainedInstanceCount = bins.length;
    this.bpBuffer.data = bps;
    this.normalOffsetBuffer.data = normalOffsets;
    this.colorBuffer.data = colors;
    this.mesh.visible = bins.length > 0;
    return true;
  }

  updateCamera(camera: StadiumRetainedCameraParams): void {
    const uniforms = (
      this.shader.resources.overviewUniforms as { uniforms: RetainedOverviewUniforms }
    ).uniforms;
    uniforms.uGenomeLength = camera.genomeLength;
    uniforms.uViewOffset = camera.viewOffset;
    uniforms.uZoom = camera.zoom;
    uniforms.uOffsetScale = camera.offsetScale;
    this.dimsUniform[0] = camera.dims.width;
    this.dimsUniform[1] = camera.dims.height;
    this.dimsUniform[2] = camera.dims.radius;
    this.dimsUniform[3] = camera.dims.straightLength;
    this.originUniform[0] = camera.ox;
    this.originUniform[1] = camera.oy;
    this.stagePosUniform[0] = camera.stagePosX;
    this.stagePosUniform[1] = camera.stagePosY;
    this.viewportUniform[0] = camera.viewportWidth;
    this.viewportUniform[1] = camera.viewportHeight;
    this.mesh.visible = this.retainedInstanceCount > 0;
  }

  setAlpha(alpha: number): void {
    this.container.alpha = Math.max(0, Math.min(1, alpha));
  }

  hide(): void {
    this.mesh.visible = false;
  }

  resetData(): void {
    this.builtBuffers.clear();
    this.dataKey = '';
    this.retainedInstanceCount = 0;
    this.bpBuffer.data = new Float32Array(0);
    this.normalOffsetBuffer.data = new Float32Array(0);
    this.colorBuffer.data = new Float32Array(0);
    this.hide();
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.geometry.destroy(true);
    destroyLayerShader(this.shader);
  }
}
