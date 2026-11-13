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
import type { ViewerRenderContract } from './viewer-render-contract';
import { packTranscriptGlyphVertices, type DirectionalBlock } from './transcript-glyph-vertices';
import { retainedSubpixelOpacityPolicy } from './retained-subpixel-aa';
import {
  BP_COORDINATE_CHUNK_SIZE,
  bpCoordinateChunk,
  bpCoordinateDelta,
} from './bp-coordinate-packing';
import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_LANE_STEP_PX,
} from './prepacked-annotation-scene';
import { INDEXED_ANNOTATION_RUNTIME_THEME_GLSL } from '../shared/annotation-runtime-theme';
import { ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1 } from '../../../annotation-role-palette';

export {
  buildTranscriptGlyphBlocks,
  packTranscriptGlyphVertices,
  type DirectionalBlock,
  type TranscriptGlyphContext,
  type TranscriptGlyphFeature,
} from './transcript-glyph-vertices';

const transcriptPackDiagnostics = {
  count: 0,
  blocks: 0,
  durationMs: 0,
};

const DOUBLE_DRAW_TEST_SENTINEL_KEY = ['annotation', 'double-draw', 'sentinel', 'v1'].join(':');

export type RetainedLinearTranscriptPackDebugSnapshot = Readonly<{
  count: number;
  blocks: number;
  durationMs: number;
}>;

export type ForcedLinearTranscriptPresentationTestState = Readonly<{
  presenting: boolean;
  retainedBlockCount: number;
  sentinelResident: boolean;
}>;

export function getRetainedLinearTranscriptPackDebugSnapshot(): RetainedLinearTranscriptPackDebugSnapshot {
  return { ...transcriptPackDiagnostics };
}

function buildTranscriptVertexShader(policyProjection: boolean): string {
  const policyAttributes = policyProjection
    ? `
attribute vec4 aPolicyLanes; // expanded, expandedTrack, canonical, canonicalTrack`
    : '';
  const policyUniforms = policyProjection
    ? `
uniform float uPolicyIsoformMode; // 0 expanded | 1 canonical
uniform float uPolicyLaneLimit;   // -1 unlimited | positive track-local cap`
    : '';
  const policySelection = policyProjection
    ? `
  float canonicalWeight = step(0.5, uPolicyIsoformMode);
  float policyTrackLane = mix(
    aPolicyLanes.y,
    aPolicyLanes.w,
    canonicalWeight
  );
  policyVisible = step(-0.5, policyTrackLane);
  if (uPolicyLaneLimit >= 0.0) {
    policyVisible *= 1.0 - step(uPolicyLaneLimit, policyTrackLane);
  }
  resolvedOffsetCenter = -${PREPACKED_ANNOTATION_BAR_HEIGHT_PX / 2}.0 -
    policyTrackLane * ${PREPACKED_ANNOTATION_LANE_STEP_PX}.0;`
    : '';
  const policyClip = policyProjection
    ? `
  if (policyVisible < 0.5) gl_Position = vec4(2.0, 2.0, 0.0, 1.0);`
    : '';

  return `
precision highp float;

attribute float aBpStartChunk;
attribute float aBpStartDelta;
attribute float aBpEndChunk;
attribute float aBpEndDelta;
attribute float aOffsetCenter;
attribute float aHalfH;
attribute float aDirSign;   // 0 plain rect | +1 fwd arrow | -1 rev arrow
attribute float aCdsFade;
attribute float aCorner;    // pentagon corner 0..4
attribute vec4 aColor;${policyAttributes}

uniform float uXScale;
uniform float uXOrigin;
uniform float uBpOriginChunk;
uniform float uBpOriginDelta;
uniform float uY0;
uniform float uCdsDetail;
uniform vec2 uViewportSize;
uniform float uSubpixelMinWidthPx;${policyUniforms}
uniform float uAnnotationThemeDark;
uniform float uAnnotationTranscriptPalette;
uniform float uAnnotationRnaPalette;
// Role-coded glyphs (negative red) take their theme colour from this palette.
uniform vec4 uRolePalette[${ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1}];

varying vec4 vColor;
varying float vSubpixelActualWidth;

const float RATIO = 0.6;       // ARROW_HEIGHT_RATIO (theme.ts)
const float ARROW_MAX = 8.0;   // ARROW_MAX_WIDTH (theme.ts)
const float BP_CHUNK_SIZE = ${BP_COORDINATE_CHUNK_SIZE}.0;
${INDEXED_ANNOTATION_RUNTIME_THEME_GLSL}

float relativeBp(float chunk, float delta) {
  return (chunk - uBpOriginChunk) * BP_CHUNK_SIZE + (delta - uBpOriginDelta);
}

void main() {
  float startRel = relativeBp(aBpStartChunk, aBpStartDelta);
  float endRel = relativeBp(aBpEndChunk, aBpEndDelta);
  float x1 = uXScale * startRel + uXOrigin;
  float x2 = uXScale * endRel + uXOrigin;
  float actualWidth = max(0.0, x2 - x1);
  float stableWidth = max(actualWidth, max(0.0, uSubpixelMinWidthPx));
  float midX = (x1 + x2) * 0.5;
  if (stableWidth > actualWidth) {
    x1 = midX - stableWidth * 0.5;
    x2 = midX + stableWidth * 0.5;
  }
  float policyVisible = 1.0;
  float resolvedOffsetCenter = aOffsetCenter;${policySelection}
  float cy = uY0 + resolvedOffsetCenter;
  float hh = aHalfH;

  float aw = 0.0;
  if (aDirSign != 0.0) {
    float segPx = actualWidth;                     // parts ordered s<e
    float awc = min(min(2.0 * hh * RATIO, segPx * 0.3), ARROW_MAX);
    if (segPx > awc * 2.0) aw = awc;               // else 0 → rectangle
  }

  int c = int(aCorner + 0.5);
  vec2 pos;
  if (aDirSign < 0.0) {
    // reverse: [x1+aw,cy-hh][x2,cy-hh][x2,cy+hh][x1+aw,cy+hh][x1,cy]
    if (c == 0) pos = vec2(x1 + aw, cy - hh);
    else if (c == 1) pos = vec2(x2, cy - hh);
    else if (c == 2) pos = vec2(x2, cy + hh);
    else if (c == 3) pos = vec2(x1 + aw, cy + hh);
    else pos = vec2(x1, cy);
  } else {
    // forward (also the aw=0 rectangle case for dirSign 0):
    // [x1,cy-hh][x2-aw,cy-hh][x2,cy][x2-aw,cy+hh][x1,cy+hh]
    if (c == 0) pos = vec2(x1, cy - hh);
    else if (c == 1) pos = vec2(x2 - aw, cy - hh);
    else if (c == 2) pos = vec2(x2, cy);
    else if (c == 3) pos = vec2(x2 - aw, cy + hh);
    else pos = vec2(x1, cy + hh);
  }

  vec2 vp = max(uViewportSize, vec2(1.0, 1.0));
  vec2 clip = vec2((pos.x / vp.x) * 2.0 - 1.0, 1.0 - (pos.y / vp.y) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);${policyClip}
  float fade = clamp(1.0 - aCdsFade * uCdsDetail, 0.0, 1.0);
  vec3 rgb = aColor.r < -0.5
    ? uRolePalette[int(clamp(-aColor.r - 1.0, 0.0, ${ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1 - 1}.0) + 0.5)].rgb
    : indexedAnnotationRuntimeThemeColor(
        aColor.rgb,
        uAnnotationThemeDark,
        uAnnotationTranscriptPalette,
        uAnnotationRnaPalette
      );
  vColor = vec4(rgb, aColor.a * fade * policyVisible);
  vSubpixelActualWidth = actualWidth;
}
`;
}

export const TRANSCRIPT_VERTEX_SHADER = buildTranscriptVertexShader(false);
export const POLICY_TRANSCRIPT_VERTEX_SHADER = buildTranscriptVertexShader(true);

export const TRANSCRIPT_FRAGMENT_SHADER = `
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

export type RetainedLinearTranscriptUniforms = {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uY0: number;
  uCdsDetail: number;
  uViewportSize: Float32Array;
  uSubpixelMinWidthPx: number;
  uSubpixelAlphaGamma: number;
  uSubpixelMinAlphaScale: number;
  uAnnotationThemeDark: number;
  uAnnotationTranscriptPalette: number;
  uAnnotationRnaPalette: number;
};

export class RetainedLinearTranscriptLayer {
  readonly container = new Container();

  private readonly bpStartChunkBuffer = mkBuf('retained-linear-transcript-bp-start-chunk');
  private readonly bpStartDeltaBuffer = mkBuf('retained-linear-transcript-bp-start-delta');
  private readonly bpEndChunkBuffer = mkBuf('retained-linear-transcript-bp-end-chunk');
  private readonly bpEndDeltaBuffer = mkBuf('retained-linear-transcript-bp-end-delta');
  private readonly offsetBuffer = mkBuf('retained-linear-transcript-offset');
  private readonly halfHBuffer = mkBuf('retained-linear-transcript-halfh');
  private readonly dirSignBuffer = mkBuf('retained-linear-transcript-dir');
  private readonly cdsFadeBuffer = mkBuf('retained-linear-transcript-cds-fade');
  private readonly cornerBuffer = mkBuf('retained-linear-transcript-corner');
  private readonly colorBuffer = mkBuf('retained-linear-transcript-color');

  private readonly viewportUniform = new Float32Array(2);
  private readonly geometry = new Geometry({
    attributes: {
      aBpStartChunk: { buffer: this.bpStartChunkBuffer, format: 'float32' },
      aBpStartDelta: { buffer: this.bpStartDeltaBuffer, format: 'float32' },
      aBpEndChunk: { buffer: this.bpEndChunkBuffer, format: 'float32' },
      aBpEndDelta: { buffer: this.bpEndDeltaBuffer, format: 'float32' },
      aOffsetCenter: { buffer: this.offsetBuffer, format: 'float32' },
      aHalfH: { buffer: this.halfHBuffer, format: 'float32' },
      aDirSign: { buffer: this.dirSignBuffer, format: 'float32' },
      aCdsFade: { buffer: this.cdsFadeBuffer, format: 'float32' },
      aCorner: { buffer: this.cornerBuffer, format: 'float32' },
      aColor: { buffer: this.colorBuffer, format: 'float32x4' },
    },
    topology: 'triangle-list',
  });
  private readonly shader = new Shader({
    glProgram: GlProgram.from({
      name: 'retained-linear-transcript-bodies',
      vertex: TRANSCRIPT_VERTEX_SHADER,
      fragment: TRANSCRIPT_FRAGMENT_SHADER,
    }),
    resources: {
      transcriptUniforms: {
        ...(() => {
          const subpixel = retainedSubpixelOpacityPolicy();
          return {
            uSubpixelMinWidthPx: { value: subpixel.minWidthPx, type: 'f32' as const },
            uSubpixelAlphaGamma: { value: subpixel.alphaGamma, type: 'f32' as const },
            uSubpixelMinAlphaScale: { value: subpixel.minAlphaScale, type: 'f32' as const },
          };
        })(),
        uXScale: { value: 1, type: 'f32' },
        uXOrigin: { value: 0, type: 'f32' },
        uBpOriginChunk: { value: 0, type: 'f32' },
        uBpOriginDelta: { value: 0, type: 'f32' },
        uY0: { value: 0, type: 'f32' },
        uCdsDetail: { value: 0, type: 'f32' },
        uAnnotationThemeDark: { value: 0, type: 'f32' },
        uAnnotationTranscriptPalette: { value: 0, type: 'f32' },
        uAnnotationRnaPalette: { value: 0, type: 'f32' },
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
  private featureColorSpans: Float64Array | null = null;
  private featureColors: ReadonlyMap<number, number> | undefined;
  private forcedTestSentinelResident = false;
  retainedBlockCount = 0;

  get isPresenting(): boolean {
    return this.mesh.visible && this.retainedBlockCount > 0;
  }

  constructor() {
    this.container.eventMode = 'none';
    this.mesh.eventMode = 'none';
    this.mesh.visible = false;
    this.container.addChild(this.mesh);
  }

  syncData(key: string, blocks: ReadonlyArray<DirectionalBlock>): boolean {
    if (this.dataKey === key) return false;

    const packStart = typeof performance !== 'undefined' ? performance.now() : 0;
    const v = packTranscriptGlyphVertices(blocks);
    transcriptPackDiagnostics.count += 1;
    transcriptPackDiagnostics.blocks = blocks.length;
    transcriptPackDiagnostics.durationMs =
      typeof performance !== 'undefined'
        ? Math.round((performance.now() - packStart) * 100) / 100
        : 0;
    if (typeof globalThis !== 'undefined') {
      const g = globalThis as typeof globalThis & {
        __webglTranscriptPackCount?: number;
        __webglTranscriptPackBlocks?: number;
        __webglTranscriptPackMs?: number;
      };

      g.__webglTranscriptPackCount = transcriptPackDiagnostics.count;
      g.__webglTranscriptPackBlocks = transcriptPackDiagnostics.blocks;
      g.__webglTranscriptPackMs = transcriptPackDiagnostics.durationMs;
    }
    this.dataKey = key;
    this.forcedTestSentinelResident = key === DOUBLE_DRAW_TEST_SENTINEL_KEY;
    this.retainedBlockCount = blocks.length;
    this.bpStartChunkBuffer.data = v.bpStartChunk;
    this.bpStartDeltaBuffer.data = v.bpStartDelta;
    this.bpEndChunkBuffer.data = v.bpEndChunk;
    this.bpEndDeltaBuffer.data = v.bpEndDelta;
    this.offsetBuffer.data = v.offsetCenter;
    this.halfHBuffer.data = v.halfH;
    this.dirSignBuffer.data = v.dirSign;
    this.cdsFadeBuffer.data = v.cdsFade;
    this.cornerBuffer.data = v.corner;
    this.colorBuffer.data = v.color;
    this.featureColors = undefined;
    this.featureColorSpans = blocks.some((block) => block.featureId !== undefined)
      ? new Float64Array(blocks.length * 4)
      : null;
    if (this.featureColorSpans) {
      let vertex = 0;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const end = vertex + (block.dirSign === 0 ? 6 : 9);
        this.featureColorSpans.set([block.featureId ?? NaN, vertex, end, block.color], i * 4);
        vertex = end;
      }
    }
    this.mesh.visible = blocks.length > 0;
    return true;
  }

  setFeatureColors(colors: ReadonlyMap<number, number> | undefined): void {
    if (colors === this.featureColors) return;
    this.featureColors = colors;
    const spans = this.featureColorSpans;
    if (!spans) return;
    const data = this.colorBuffer.data as Float32Array;
    for (let i = 0; i < spans.length; i += 4) {
      const color = colors?.get(spans[i]) ?? spans[i + 3];
      const r = ((color >> 16) & 0xff) / 255;
      const g = ((color >> 8) & 0xff) / 255;
      const b = (color & 0xff) / 255;
      for (let vertex = spans[i + 1]; vertex < spans[i + 2]; vertex++) {
        const offset = vertex * 4;
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
      }
    }
    this.colorBuffer.update();
  }

  updateCamera(
    contract: ViewerRenderContract,
    viewportWidth: number,
    viewportHeight: number,
    cdsDetail = 0
  ): void {
    const u = (
      this.shader.resources.transcriptUniforms as { uniforms: RetainedLinearTranscriptUniforms }
    ).uniforms;
    const originBp = contract.xOriginBp ?? 0;
    u.uXScale = contract.pixelsPerBp;
    u.uXOrigin = contract.projectX(originBp);
    u.uBpOriginChunk = bpCoordinateChunk(originBp);
    u.uBpOriginDelta = bpCoordinateDelta(originBp);
    u.uY0 = contract.projectY(0);
    u.uCdsDetail = Math.max(0, Math.min(1, cdsDetail));
    const subpixel = retainedSubpixelOpacityPolicy();
    u.uSubpixelMinWidthPx = subpixel.minWidthPx;
    u.uSubpixelAlphaGamma = subpixel.alphaGamma;
    u.uSubpixelMinAlphaScale = subpixel.minAlphaScale;
    this.viewportUniform[0] = viewportWidth;
    this.viewportUniform[1] = viewportHeight;
    this.mesh.visible = this.retainedBlockCount > 0;
  }

  setAlpha(alpha: number): void {
    this.container.alpha = Math.max(0, Math.min(1, alpha));
  }

  hide(): void {
    this.mesh.visible = false;
  }

  forcePresentForTest(): void {
    if (this.retainedBlockCount <= 0) {
      this.syncData(DOUBLE_DRAW_TEST_SENTINEL_KEY, [
        {
          startBp: 0,
          endBp: 4_000_000_000,
          offsetCenter: 0,
          halfH: 7,
          color: 0xff00ff,
          role: 'source:ff00ff',
          alpha: 1,
          cdsFade: 0,
          dirSign: 0,
        },
      ]);
    }
    this.mesh.visible = true;
  }

  releaseForcedPresentationForTest(): ForcedLinearTranscriptPresentationTestState {
    if (this.forcedTestSentinelResident) {
      this.resetData();
    } else {
      this.hide();
    }
    return {
      presenting: this.isPresenting,
      retainedBlockCount: this.retainedBlockCount,
      sentinelResident: this.forcedTestSentinelResident,
    };
  }

  resetData(): void {
    this.dataKey = '';
    this.featureColors = undefined;
    this.featureColorSpans = null;
    this.forcedTestSentinelResident = false;
    this.retainedBlockCount = 0;
    for (const b of [
      this.bpStartChunkBuffer,
      this.bpStartDeltaBuffer,
      this.bpEndChunkBuffer,
      this.bpEndDeltaBuffer,
      this.offsetBuffer,
      this.halfHBuffer,
      this.dirSignBuffer,
      this.cdsFadeBuffer,
      this.cornerBuffer,
      this.colorBuffer,
    ]) {
      b.data = new Float32Array(0);
    }
    this.hide();
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.geometry.destroy(true);
    destroyLayerShader(this.shader);
  }
}

function mkBuf(label: string): PixiBuffer {
  return new PixiBuffer({
    data: new Float32Array(0),
    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    label,
    shrinkToFit: false,
  });
}
