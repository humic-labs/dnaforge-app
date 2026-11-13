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
import type { WebGLThemeMode } from '../shared/theme';
import type { ViewerRenderContract } from './viewer-render-contract';
import type { OverviewBin } from '../overlays/annotation-overview-cache';
import { buildLinearFeatureQuadVertices } from './retained-linear-feature-vertices';
import { retainedSubpixelOpacityPolicy } from './retained-subpixel-aa';
import {
  BP_COORDINATE_CHUNK_SIZE,
  bpCoordinateChunk,
  bpCoordinateDelta,
} from './bp-coordinate-packing';

export {
  buildLinearFeatureQuadVertices,
  type LinearFeatureQuadVertices,
} from './retained-linear-feature-vertices';

const RETAINED_LINEAR_VERTEX_SHADER = `
precision highp float;

attribute float aBpStartChunk;
attribute float aBpStartDelta;
attribute float aBpEndChunk;
attribute float aBpEndDelta;
attribute float aOffsetCenter;
attribute float aHalfH;
attribute float aXSide;
attribute float aYSide;
attribute vec4 aColor;

uniform float uXScale;   // pixels per bp (contract.pixelsPerBp)
uniform float uXOrigin;  // screen x at uBpOrigin*
uniform float uBpOriginChunk;
uniform float uBpOriginDelta;
uniform float uY0;       // screen y at offsetPx=0 (contract.projectY(0))
uniform vec2 uViewportSize;
uniform float uSubpixelMinWidthPx;

varying vec4 vColor;
varying float vSubpixelActualWidth;

const float BP_CHUNK_SIZE = ${BP_COORDINATE_CHUNK_SIZE}.0;

void main() {
  float startRel =
    (aBpStartChunk - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpStartDelta - uBpOriginDelta);
  float endRel =
    (aBpEndChunk - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpEndDelta - uBpOriginDelta);
  float x1 = uXScale * startRel + uXOrigin;
  float x2 = uXScale * endRel + uXOrigin;
  float actualWidth = max(0.0, x2 - x1);
  float stableWidth = max(actualWidth, max(0.0, uSubpixelMinWidthPx));
  if (stableWidth > actualWidth) {
    float midX = (x1 + x2) * 0.5;
    x1 = midX - stableWidth * 0.5;
    x2 = midX + stableWidth * 0.5;
  }
  vec2 screen = vec2(mix(x1, x2, aXSide), uY0 + aOffsetCenter + aYSide * aHalfH);
  vec2 viewport = max(uViewportSize, vec2(1.0, 1.0));
  vec2 clip = vec2((screen.x / viewport.x) * 2.0 - 1.0, 1.0 - (screen.y / viewport.y) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vColor = aColor;
  vSubpixelActualWidth = actualWidth;
}
`;

const RETAINED_LINEAR_FRAGMENT_SHADER = `
precision highp float;

varying vec4 vColor;
varying float vSubpixelActualWidth;

uniform float uSubpixelMinWidthPx;
uniform float uSubpixelAlphaGamma;
uniform float uSubpixelMinAlphaScale;

float subpixelAlphaScale() {
  float actualWidth = max(0.0, vSubpixelActualWidth);
  if (actualWidth <= 0.0) return 0.0;
  float minWidth = max(0.0, uSubpixelMinWidthPx);
  if (actualWidth >= minWidth) return 1.0;
  float supportWidth = max(actualWidth, max(minWidth, 0.000001));
  float coverage = clamp(actualWidth / supportWidth, 0.0, 1.0);
  float gamma = max(0.01, uSubpixelAlphaGamma);
  float minAlpha = clamp(uSubpixelMinAlphaScale, 0.0, 1.0);
  return min(1.0, max(minAlpha, pow(coverage, gamma)));
}

void main() {
  float alpha = vColor.a * subpixelAlphaScale();
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}
`;

export type RetainedLinearUniforms = {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uY0: number;
  uViewportSize: Float32Array;
  uSubpixelMinWidthPx: number;
  uSubpixelAlphaGamma: number;
  uSubpixelMinAlphaScale: number;
};

type LevelMesh = {
  mesh: Mesh<Geometry, Shader>;
  geometry: Geometry;
  shader: Shader;
  viewportUniform: Float32Array;
  buffers: PixiBuffer[];
  count: number;
};

export class RetainedLinearFeatureLayer {
  readonly container = new Container();

  private readonly pool = new Map<string, LevelMesh>();
  private static readonly POOL_MAX = 48;
  private currentKey = '';
  retainedInstanceCount = 0;
  private camXScale = 1;
  private camXOrigin = 0;
  private camBpOriginChunk = 0;
  private camBpOriginDelta = 0;
  private camY0 = 0;
  private camW = 1;
  private camH = 1;

  constructor() {
    this.container.eventMode = 'none';
  }

  private buildLevel(
    key: string,
    bins: OverviewBin[],
    themeMode: WebGLThemeMode | undefined
  ): LevelMesh {
    const v = buildLinearFeatureQuadVertices(bins, themeMode);
    const mk = (data: Float32Array, label: string) =>
      new PixiBuffer({
        data,
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        label,
        shrinkToFit: false,
      });
    const bpStartChunkBuffer = mk(v.bpStartChunk, 'retained-linear-feature-bp-start-chunk');
    const bpStartDeltaBuffer = mk(v.bpStartDelta, 'retained-linear-feature-bp-start-delta');
    const bpEndChunkBuffer = mk(v.bpEndChunk, 'retained-linear-feature-bp-end-chunk');
    const bpEndDeltaBuffer = mk(v.bpEndDelta, 'retained-linear-feature-bp-end-delta');
    const offsetBuffer = mk(v.offsetCenter, 'retained-linear-feature-offset');
    const halfHBuffer = mk(v.halfH, 'retained-linear-feature-halfh');
    const xSideBuffer = mk(v.xSide, 'retained-linear-feature-x-side');
    const ySideBuffer = mk(v.ySide, 'retained-linear-feature-y-side');
    const colorBuffer = mk(v.color, 'retained-linear-feature-color');
    const geometry = new Geometry({
      attributes: {
        aBpStartChunk: { buffer: bpStartChunkBuffer, format: 'float32' },
        aBpStartDelta: { buffer: bpStartDeltaBuffer, format: 'float32' },
        aBpEndChunk: { buffer: bpEndChunkBuffer, format: 'float32' },
        aBpEndDelta: { buffer: bpEndDeltaBuffer, format: 'float32' },
        aOffsetCenter: { buffer: offsetBuffer, format: 'float32' },
        aHalfH: { buffer: halfHBuffer, format: 'float32' },
        aXSide: { buffer: xSideBuffer, format: 'float32' },
        aYSide: { buffer: ySideBuffer, format: 'float32' },
        aColor: { buffer: colorBuffer, format: 'float32x4' },
      },
      topology: 'triangle-list',
    });
    const viewportUniform = new Float32Array([this.camW, this.camH]);
    const subpixel = retainedSubpixelOpacityPolicy();
    const shader = new Shader({
      glProgram: GlProgram.from({
        name: 'retained-linear-feature-bodies',
        vertex: RETAINED_LINEAR_VERTEX_SHADER,
        fragment: RETAINED_LINEAR_FRAGMENT_SHADER,
      }),
      resources: {
        linearUniforms: {
          uXScale: { value: this.camXScale, type: 'f32' },
          uXOrigin: { value: this.camXOrigin, type: 'f32' },
          uBpOriginChunk: { value: this.camBpOriginChunk, type: 'f32' },
          uBpOriginDelta: { value: this.camBpOriginDelta, type: 'f32' },
          uY0: { value: this.camY0, type: 'f32' },
          uViewportSize: { value: viewportUniform, type: 'vec2<f32>' },
          uSubpixelMinWidthPx: { value: subpixel.minWidthPx, type: 'f32' },
          uSubpixelAlphaGamma: { value: subpixel.alphaGamma, type: 'f32' },
          uSubpixelMinAlphaScale: { value: subpixel.minAlphaScale, type: 'f32' },
        },
      },
    });
    const mesh = new Mesh({ geometry, shader, state: State.for2d() });
    mesh.eventMode = 'none';
    mesh.visible = false;
    this.container.addChild(mesh);
    const entry: LevelMesh = {
      mesh,
      geometry,
      shader,
      viewportUniform,
      buffers: [
        bpStartChunkBuffer,
        bpStartDeltaBuffer,
        bpEndChunkBuffer,
        bpEndDeltaBuffer,
        offsetBuffer,
        halfHBuffer,
        xSideBuffer,
        ySideBuffer,
        colorBuffer,
      ],
      count: bins.length,
    };
    if (this.pool.size >= RetainedLinearFeatureLayer.POOL_MAX) {
      const oldest = this.pool.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.disposeLevel(oldest);
    }
    this.pool.set(key, entry);
    return entry;
  }

  private disposeLevel(key: string): void {
    const e = this.pool.get(key);
    if (!e) return;
    this.container.removeChild(e.mesh);
    e.mesh.destroy();
    e.geometry.destroy(true);
    destroyLayerShader(e.shader);
    this.pool.delete(key);
  }

  syncData(key: string, bins: OverviewBin[], themeMode: WebGLThemeMode | undefined): boolean {
    if (this.currentKey === key) return false;

    const prev = this.pool.get(this.currentKey);
    if (prev) prev.mesh.visible = false;

    let entry = this.pool.get(key);
    const built = !entry;
    if (!entry) entry = this.buildLevel(key, bins, themeMode);

    this.currentKey = key;
    this.retainedInstanceCount = entry.count;
    this.applyCamera(entry);
    entry.mesh.visible = entry.count > 0;
    return built;
  }

  private applyCamera(e: LevelMesh): void {
    const u = (e.shader.resources.linearUniforms as { uniforms: RetainedLinearUniforms }).uniforms;
    u.uXScale = this.camXScale;
    u.uXOrigin = this.camXOrigin;
    u.uBpOriginChunk = this.camBpOriginChunk;
    u.uBpOriginDelta = this.camBpOriginDelta;
    u.uY0 = this.camY0;
    const subpixel = retainedSubpixelOpacityPolicy();
    u.uSubpixelMinWidthPx = subpixel.minWidthPx;
    u.uSubpixelAlphaGamma = subpixel.alphaGamma;
    u.uSubpixelMinAlphaScale = subpixel.minAlphaScale;
    e.viewportUniform[0] = this.camW;
    e.viewportUniform[1] = this.camH;
  }

  updateCamera(
    contract: ViewerRenderContract,
    viewportWidth: number,
    viewportHeight: number
  ): void {
    const originBp = contract.xOriginBp ?? 0;
    this.camXScale = contract.pixelsPerBp;
    this.camXOrigin = contract.projectX(originBp);
    this.camBpOriginChunk = bpCoordinateChunk(originBp);
    this.camBpOriginDelta = bpCoordinateDelta(originBp);
    this.camY0 = contract.projectY(0);
    this.camW = viewportWidth;
    this.camH = viewportHeight;
    const e = this.pool.get(this.currentKey);
    if (e) {
      this.applyCamera(e);
      e.mesh.visible = e.count > 0;
    }
  }

  get isPresenting(): boolean {
    const e = this.pool.get(this.currentKey);
    return (e?.mesh.visible ?? false) && (e?.count ?? 0) > 0;
  }

  setAlpha(alpha: number): void {
    this.container.alpha = Math.max(0, Math.min(1, alpha));
  }

  hide(): void {
    const e = this.pool.get(this.currentKey);
    if (e) e.mesh.visible = false;
  }

  resetData(): void {
    for (const key of [...this.pool.keys()]) this.disposeLevel(key);
    this.currentKey = '';
    this.retainedInstanceCount = 0;
  }

  destroy(): void {
    for (const key of [...this.pool.keys()]) this.disposeLevel(key);
    this.container.destroy({ children: true });
  }
}
