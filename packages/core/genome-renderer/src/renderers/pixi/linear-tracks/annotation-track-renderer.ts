import { TRACK_DEFAULT_COLORS } from '@waypoint/sequence-utils';
import { SEQUENCE_LABEL_FONT_FAMILY } from '@waypoint/platform';
import {
  Container,
  Buffer as PixiBuffer,
  BufferUsage,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  State,
  TextStyle,
} from 'pixi.js';

import { destroyLayerShader } from '../shared/pixi-shader-lifecycle';
import { TextPool } from '../shared/text-pool';

import type { AnnotationRecord } from '@waypoint/genome-data';

import {
  BP_COORDINATE_CHUNK_SIZE,
  bpCoordinateChunk,
  bpCoordinateDelta,
} from '../overview/bp-coordinate-packing';
import { retainedSubpixelOpacityPolicy } from '../overview/retained-subpixel-aa';
import { webglAnnotationColorForMode } from '../shared/theme';
import { buildAnnotationRecordVertices } from './annotation-record-vertices';
import { assignAnnotationLanes, type AnnotationLaneAssignment } from './annotation-track-draw-ops';
import { hitTestIntervalTrack } from './interval-hit-test';
import { planBoundedIntervalLabels } from './interval-label-layout';
import { normalizeTrackColor, trackMaxRows, trackRowHeightPx } from './track-presentation';
import type {
  PixiLinearTrackRenderer,
  TrackHitResult,
  TrackHoverArgs,
  TrackMeasureContentArgs,
  TrackMountArgs,
  TrackPaintArgs,
} from './types';

const DEFAULT_LANE_HEIGHT_PX = 8;
const DEFAULT_MAX_LANES = 32;
let intervalLabelStyleInstance: TextStyle | null = null;
function intervalLabelStyle(): TextStyle {
  intervalLabelStyleInstance ??= new TextStyle({
    fontFamily: SEQUENCE_LABEL_FONT_FAMILY,
    fontSize: 7,
    fontWeight: '500',
    lineHeight: 8,
    fill: 0xffffff,
  });
  return intervalLabelStyleInstance;
}

export const ANNOTATION_VERTEX_SHADER = `
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

uniform float uXScale;
uniform float uXOrigin;
uniform float uBpOriginChunk;
uniform float uBpOriginDelta;
uniform float uY0;
uniform vec2 uViewportSize;
uniform float uSubpixelMinWidthPx;
uniform vec3 uTrackColor;
uniform float uUseTrackColor;
// Shared shader hook for framebuffer orientation. Annotation and pileup tracks
// render directly to screen and use +1.
uniform float uYFlip;
// Pixi's MeshPipe supplies this local uniform from DisplayObject tint/alpha.
// Custom shaders must consume it explicitly; otherwise mesh.alpha updates
// diagnostics and scene graph state but does not change rendered pixels.
uniform vec4 uColor;

varying vec4 vColor;
varying float vSubpixelActualWidth;
varying float vScreenX;
varying float vScreenY;

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
  vec2 clip = vec2((screen.x / viewport.x) * 2.0 - 1.0, (1.0 - (screen.y / viewport.y) * 2.0) * uYFlip);
  gl_Position = vec4(clip, 0.0, 1.0);
  // Pixi's local uColor is premultiplied: rgb already includes object alpha.
  // Use uColor.a for opacity, but unpremultiply rgb for tint so changing
  // mesh.alpha does not change the feature hue/saturation before compositing.
  vec3 tint = uColor.a > 0.0001 ? uColor.rgb / uColor.a : vec3(1.0);
  vec3 featureRgb = mix(aColor.rgb, uTrackColor, clamp(uUseTrackColor, 0.0, 1.0));
  vColor = vec4(featureRgb * tint, aColor.a * uColor.a);
  vSubpixelActualWidth = actualWidth;
  vScreenX = screen.x;
  vScreenY = screen.y;
}
`;

export const ANNOTATION_FRAGMENT_SHADER = `
precision highp float;

varying vec4 vColor;
varying float vSubpixelActualWidth;
varying float vScreenX;
varying float vScreenY;

uniform float uSubpixelMinWidthPx;
uniform float uSubpixelAlphaGamma;
uniform float uSubpixelMinAlphaScale;
uniform vec2 uViewportSize;
uniform float uLoadingMotionActive;
uniform float uLoadingMotionPhase;
uniform float uLoadingMotionStyle;
uniform float uHorizontalExcludeActive;
uniform vec2 uHorizontalExcludePx;

// Replaces the prior binary-jump formula and remains the single annotation
// lane-contract AA policy for subpixel-width marks.
//
//   alpha = minAlpha + (1 - minAlpha) * min(actualWidthPx, 1)^gamma
//
// C0-continuous everywhere; C1 at actualWidth=0 for gamma>=1.
float subpixelAlphaScale() {
  float actualWidth = max(0.0, vSubpixelActualWidth);
  if (actualWidth <= 0.0) return 0.0;
  float minWidth = max(0.001, uSubpixelMinWidthPx);
  float ratio = clamp(actualWidth / minWidth, 0.0, 1.0);
  float gamma = max(0.01, uSubpixelAlphaGamma);
  float minAlpha = clamp(uSubpixelMinAlphaScale, 0.0, 1.0);
  return minAlpha + (1.0 - minAlpha) * pow(ratio, gamma);
}

float loadingHash(vec2 value) {
  vec2 hashed = fract(value * vec2(123.34, 456.21));
  hashed += dot(hashed, hashed + 45.32);
  return fract(hashed.x * hashed.y);
}

float cyclicPulse(float phase, float center, float width) {
  float d = abs(fract(phase - center + 0.5) - 0.5);
  return 1.0 - smoothstep(0.0, width, d);
}

void main() {
  if (
    uHorizontalExcludeActive > 0.5 &&
    vScreenX >= uHorizontalExcludePx.x &&
    vScreenX <= uHorizontalExcludePx.y
  ) discard;
  float alpha = vColor.a * subpixelAlphaScale();
  vec3 color = vColor.rgb;
  if (uLoadingMotionActive > 0.5) {
    float phase = fract(uLoadingMotionPhase);
    float style = floor(uLoadingMotionStyle + 0.5);
    float tau = 6.28318530718;
    float whiten = 0.0;
    float shade = 0.0;
    float alphaScale = 1.0;
    float shapeMask = 1.0;

    if (style < 0.5) {
      // 1. Soft sweep — the original broad traveling sheen.
      float wave = 0.5 + 0.5 * sin(vScreenX * 0.08 - phase * tau);
      float pulse = 0.5 + 0.5 * sin(phase * tau);
      whiten = (0.035 + smoothstep(0.35, 1.0, wave) * 0.145) * (0.85 + pulse * 0.15);
    } else if (style < 1.5) {
      // 2. Gentle pulse — the complete histogram breathes as one shape.
      float pulse = 0.5 + 0.5 * sin(phase * tau - 1.57079632679);
      whiten = 0.025 + pulse * 0.16;
      alphaScale = 0.9 + pulse * 0.1;
    } else if (style < 2.5) {
      // 3. Narrow scanner — one crisp highlight crosses the shape.
      float center = -80.0 + phase * (uViewportSize.x + 160.0);
      float band = 1.0 - smoothstep(0.0, 28.0, abs(vScreenX - center));
      whiten = 0.025 + band * 0.3;
    } else if (style < 3.5) {
      // 4. Twin scanners — two compact highlights half a cycle apart.
      float span = uViewportSize.x + 120.0;
      float first = -60.0 + phase * span;
      float second = -60.0 + fract(phase + 0.5) * span;
      float band = max(
        1.0 - smoothstep(0.0, 34.0, abs(vScreenX - first)),
        1.0 - smoothstep(0.0, 34.0, abs(vScreenX - second))
      );
      whiten = 0.02 + band * 0.23;
    } else if (style < 4.5) {
      // Alternate the histogram's own blue with a slightly lighter tint of
      // that blue. Keep both bands opaque so the canvas background never
      // becomes a white/dark stripe. The symmetric transition gives them equal
      // thickness without jagged one-pixel diagonal edges.
      float diagonal =
        ((vScreenX + vScreenY * 0.68 - phase * 24.0) / 6.0) * tau;
      whiten = (1.0 - smoothstep(-0.22, 0.22, sin(diagonal))) * 0.18;
    } else if (style < 5.5) {
      // 6. Comet trail — a bright head pulls a fading wake across the data.
      float head = -100.0 + phase * (uViewportSize.x + 200.0);
      float behind = head - vScreenX;
      float headGlow = 1.0 - smoothstep(0.0, 20.0, abs(behind));
      float trail = step(0.0, behind) * (1.0 - smoothstep(0.0, 180.0, behind));
      whiten = 0.02 + headGlow * 0.28 + trail * 0.12;
    } else if (style < 6.5) {
      // 7. Sparkle field — small deterministic glints change each time slice.
      vec2 cell = floor(vec2(vScreenX / 10.0, vScreenY / 8.0));
      float tick = floor(phase * 20.0);
      float noise = loadingHash(cell + vec2(tick * 0.73, tick * 1.31));
      float sparkle = smoothstep(0.9, 1.0, noise);
      float twinkle = 0.5 + 0.5 * sin(phase * tau * 5.0 + noise * tau);
      whiten = 0.015 + sparkle * twinkle * 0.34;
    } else if (style < 7.5) {
      // 8. Concentric ripple — rings travel outward inside the shape.
      vec2 centered = vec2(
        vScreenX - uViewportSize.x * 0.5,
        mod(vScreenY, 180.0) - 90.0
      );
      float radialWave = 0.5 + 0.5 * cos(length(centered) * 0.075 - phase * tau * 3.0);
      whiten = 0.02 + smoothstep(0.72, 1.0, radialWave) * 0.2;
    } else if (style < 8.5) {
      // 9. Flowing current — a directional light/dark current moves diagonally.
      float flow = sin(vScreenX * 0.035 + vScreenY * 0.025 - phase * tau * 2.0);
      whiten = 0.035 + max(0.0, flow) * 0.13;
      shade = max(0.0, -flow) * 0.07;
    } else if (style < 9.5) {
      // 10. Double heartbeat — two quick whole-shape pulses per cycle.
      float beat = max(cyclicPulse(phase, 0.18, 0.07), cyclicPulse(phase, 0.36, 0.05) * 0.78);
      whiten = 0.015 + beat * 0.24;
      alphaScale = 0.87 + beat * 0.13;
    } else {
      // 11. Falling glints — sparse vertical streaks fall through the shape.
      float column = floor(vScreenX / 16.0);
      float enabled = step(0.58, loadingHash(vec2(column, 3.0)));
      float offset = loadingHash(vec2(column, 9.0));
      float fall = abs(fract(vScreenY / 72.0 - phase * 2.0 + offset) - 0.5);
      float streak = 1.0 - smoothstep(0.025, 0.13, fall);
      whiten = 0.02 + enabled * streak * 0.28;
    }

    color = mix(color, vec3(1.0), clamp(whiten, 0.0, 0.42));
    color *= 1.0 - clamp(shade, 0.0, 0.16);
    alpha *= clamp(alphaScale, 0.72, 1.0) * shapeMask;
  }
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

type AnnotationUniforms = {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uY0: number;
  uViewportSize: Float32Array;
  uSubpixelMinWidthPx: number;
  uSubpixelAlphaGamma: number;
  uSubpixelMinAlphaScale: number;
  uLoadingMotionActive: number;
  uLoadingMotionPhase: number;
  uLoadingMotionStyle: number;
  uHorizontalExcludeActive: number;
  uHorizontalExcludePx: Float32Array;
  uTrackColor: Float32Array;
  uUseTrackColor: number;
  uYFlip: number;
};

interface MeshState {
  mesh: Mesh<Geometry, Shader>;
  geometry: Geometry;
  shader: Shader;
  buffers: PixiBuffer[];
  viewportUniform: Float32Array;
  trackColorUniform: Float32Array;
  vertexCount: number;
}

interface ContainerState {
  container: Container;
  cachedRecordsRef: ReadonlyArray<AnnotationRecord> | null;
  cachedAssignment: AnnotationLaneAssignment | null;
  cachedRowHeightPx: number;
  cachedMaxRows: number;
  displayColor: string | null;
  geometryBuildCount: number;
  meshState: MeshState | null;
  labelPool: TextPool | null;
  labelCount: number;
}

export interface AnnotationTrackDiagnostics {
  recordCount: number;
  visibleRecordCount: number;
  droppedRecordCount: number;
  lanesUsed: number;
  maxLanes: number;
  vertexCount: number;
  overflow: boolean;
  utilizationFraction: number;
  displayColor: string | null;
  geometryBuildCount: number;
  labelCount: number;
  labelLimit: number;
}

export interface AnnotationTrackData {
  records: ReadonlyArray<AnnotationRecord>;
}

export interface PixiAnnotationTrackRendererOptions {
  type: string;
  maxLabels?: number;
}

export { computeAnnotationDrawOps } from './annotation-track-draw-ops';
export type { AnnotationDrawOp, BpToX } from './annotation-track-draw-ops';

export class PixiAnnotationTrackRenderer implements PixiLinearTrackRenderer<AnnotationTrackData> {
  readonly type: string;
  private readonly maxLabels: number;
  private containerState = new WeakMap<Container, ContainerState>();
  private assignmentCache = new WeakMap<
    ReadonlyArray<AnnotationRecord>,
    Map<number, AnnotationLaneAssignment>
  >();

  constructor(options: PixiAnnotationTrackRendererOptions) {
    this.type = options.type;
    this.maxLabels = options.maxLabels ?? 0;
    if (!Number.isSafeInteger(this.maxLabels) || this.maxLabels < 0) {
      throw new Error('PixiAnnotationTrackRenderer maxLabels must be a non-negative integer.');
    }
  }

  mount(_args: TrackMountArgs): Container {
    const container = new Container();
    container.eventMode = 'none';
    const labelPool = this.maxLabels > 0 ? new TextPool(container, intervalLabelStyle()) : null;
    this.containerState.set(container, {
      container,
      cachedRecordsRef: null,
      cachedAssignment: null,
      cachedRowHeightPx: DEFAULT_LANE_HEIGHT_PX,
      cachedMaxRows: DEFAULT_MAX_LANES,
      displayColor: null,
      geometryBuildCount: 0,
      meshState: null,
      labelPool,
      labelCount: 0,
    });
    return container;
  }

  measureContentHeight(args: TrackMeasureContentArgs<AnnotationTrackData>): number {
    const records = args.data?.records ?? [];
    if (records.length === 0) return 0;
    const rowHeightPx = trackRowHeightPx(args.presentation, DEFAULT_LANE_HEIGHT_PX);
    const maxRows = trackMaxRows(args.presentation, DEFAULT_MAX_LANES);
    return this.assignmentFor(records, args.chromosome.length, maxRows).numLanes * rowHeightPx;
  }

  paint(args: TrackPaintArgs<AnnotationTrackData>): void {
    const state = this.containerState.get(args.container);
    if (!state) return;

    const rowHeightPx = trackRowHeightPx(args.presentation, DEFAULT_LANE_HEIGHT_PX);
    const maxRows = trackMaxRows(args.presentation, DEFAULT_MAX_LANES);
    const displayColor = normalizeTrackColor(args.presentation.color);
    state.displayColor = displayColor;

    if (!args.data || args.data.records.length === 0) {
      if (state.meshState) state.meshState.mesh.visible = false;
      state.labelPool?.reset();
      state.labelCount = 0;
      state.cachedRecordsRef = args.data?.records ?? null;
      state.cachedAssignment = args.data
        ? this.assignmentFor(args.data.records, args.chromosome.length, maxRows)
        : null;
      state.cachedRowHeightPx = rowHeightPx;
      state.cachedMaxRows = maxRows;
      return;
    }

    const records = args.data.records;

    const assignmentChanged =
      state.cachedRecordsRef !== records ||
      state.cachedAssignment === null ||
      state.cachedMaxRows !== maxRows;
    const rowHeightChanged = state.cachedRowHeightPx !== rowHeightPx;
    if (assignmentChanged) {
      state.cachedAssignment = this.assignmentFor(records, args.chromosome.length, maxRows);
      state.cachedRecordsRef = records;
    }
    const assignment = state.cachedAssignment;
    if (!assignment) return;
    if (assignmentChanged || rowHeightChanged || !state.meshState) {
      this.rebuildMesh(state, records, assignment, rowHeightPx);
    }
    state.cachedRowHeightPx = rowHeightPx;
    state.cachedMaxRows = maxRows;

    if (state.meshState && state.meshState.vertexCount > 0) {
      this.applyCamera(state, args);
      state.meshState.mesh.visible = true;
    }
    this.syncLabels(state, args, records, assignment, rowHeightPx);
  }

  hitTest(args: TrackHoverArgs): TrackHitResult | null {
    const state = this.containerState.get(args.container);
    if (!state?.cachedRecordsRef || !state.cachedAssignment) return null;
    return hitTestIntervalTrack({
      pointer: args,
      records: state.cachedRecordsRef,
      assignment: state.cachedAssignment,
      rowHeightPx: state.cachedRowHeightPx,
      nameOf: (record) => record.name,
    });
  }

  unmount(container: Container): void {
    const state = this.containerState.get(container);
    if (state) {
      state.labelPool?.destroy();
      this.disposeMesh(state);
    }
    this.containerState.delete(container);
    container.destroy({ children: true });
  }

  getDiagnostics(container: Container): AnnotationTrackDiagnostics | null {
    const state = this.containerState.get(container);
    if (!state) return null;
    const records = state.cachedRecordsRef;
    const assignment = state.cachedAssignment;
    const recordCount = records?.length ?? 0;
    const droppedRecordCount = assignment?.droppedCount ?? 0;
    const lanesUsed = assignment?.numLanes ?? 0;
    const visibleRecordCount = Math.max(0, recordCount - droppedRecordCount);
    const vertexCount = state.meshState?.vertexCount ?? 0;
    return {
      recordCount,
      visibleRecordCount,
      droppedRecordCount,
      lanesUsed,
      maxLanes: state.cachedMaxRows,
      vertexCount,
      overflow: droppedRecordCount > 0,
      utilizationFraction: state.cachedMaxRows > 0 ? lanesUsed / state.cachedMaxRows : 0,
      displayColor: state.displayColor,
      geometryBuildCount: state.geometryBuildCount,
      labelCount: state.labelCount,
      labelLimit: this.maxLabels,
    };
  }

  private assignmentFor(
    records: ReadonlyArray<AnnotationRecord>,
    chromosomeLength: number,
    maxRows: number
  ): AnnotationLaneAssignment {
    let byMaxRows = this.assignmentCache.get(records);
    if (!byMaxRows) {
      byMaxRows = new Map();
      this.assignmentCache.set(records, byMaxRows);
    }
    let assignment = byMaxRows.get(maxRows);
    if (!assignment) {
      assignment = assignAnnotationLanes(records, chromosomeLength, maxRows);
      byMaxRows.set(maxRows, assignment);
    }
    return assignment;
  }

  private rebuildMesh(
    state: ContainerState,
    records: ReadonlyArray<AnnotationRecord>,
    assignment: AnnotationLaneAssignment,
    rowHeightPx: number
  ): void {
    this.disposeMesh(state);

    const vertices = buildAnnotationRecordVertices(records, new Int16Array(assignment.lanes), {
      laneHeightPx: rowHeightPx,
      defaultColor: TRACK_DEFAULT_COLORS.annotationFallback,
    });
    if (vertices.visibleRecordCount === 0) {
      state.meshState = null;
      return;
    }

    const mk = (data: Float32Array, label: string): PixiBuffer =>
      new PixiBuffer({
        data,
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        label,
        shrinkToFit: false,
      });
    const bpStartChunk = mk(vertices.bpStartChunk, 'annotation-bp-start-chunk');
    const bpStartDelta = mk(vertices.bpStartDelta, 'annotation-bp-start-delta');
    const bpEndChunk = mk(vertices.bpEndChunk, 'annotation-bp-end-chunk');
    const bpEndDelta = mk(vertices.bpEndDelta, 'annotation-bp-end-delta');
    const offsetBuf = mk(vertices.offsetCenter, 'annotation-offset');
    const halfHBuf = mk(vertices.halfH, 'annotation-halfh');
    const xSideBuf = mk(vertices.xSide, 'annotation-x-side');
    const ySideBuf = mk(vertices.ySide, 'annotation-y-side');
    const colorBuf = mk(vertices.color, 'annotation-color');

    const geometry = new Geometry({
      attributes: {
        aBpStartChunk: { buffer: bpStartChunk, format: 'float32' },
        aBpStartDelta: { buffer: bpStartDelta, format: 'float32' },
        aBpEndChunk: { buffer: bpEndChunk, format: 'float32' },
        aBpEndDelta: { buffer: bpEndDelta, format: 'float32' },
        aOffsetCenter: { buffer: offsetBuf, format: 'float32' },
        aHalfH: { buffer: halfHBuf, format: 'float32' },
        aXSide: { buffer: xSideBuf, format: 'float32' },
        aYSide: { buffer: ySideBuf, format: 'float32' },
        aColor: { buffer: colorBuf, format: 'float32x4' },
      },
      topology: 'triangle-list',
    });

    const viewportUniform = new Float32Array([1, 1]);
    const trackColorUniform = new Float32Array([1, 1, 1]);
    const horizontalExcludeUniform = new Float32Array([0, 0]);
    const subpixel = retainedSubpixelOpacityPolicy();
    const shader = new Shader({
      glProgram: GlProgram.from({
        name: 'annotation-track-mesh',
        vertex: ANNOTATION_VERTEX_SHADER,
        fragment: ANNOTATION_FRAGMENT_SHADER,
      }),
      resources: {
        annotationUniforms: {
          uXScale: { value: 1, type: 'f32' },
          uXOrigin: { value: 0, type: 'f32' },
          uBpOriginChunk: { value: 0, type: 'f32' },
          uBpOriginDelta: { value: 0, type: 'f32' },
          uY0: { value: 0, type: 'f32' },
          uViewportSize: { value: viewportUniform, type: 'vec2<f32>' },
          uSubpixelMinWidthPx: { value: subpixel.minWidthPx, type: 'f32' },
          uSubpixelAlphaGamma: { value: subpixel.alphaGamma, type: 'f32' },
          uSubpixelMinAlphaScale: { value: subpixel.minAlphaScale, type: 'f32' },
          uLoadingMotionActive: { value: 0, type: 'f32' },
          uLoadingMotionPhase: { value: 0, type: 'f32' },
          uLoadingMotionStyle: { value: 0, type: 'f32' },
          uHorizontalExcludeActive: { value: 0, type: 'f32' },
          uHorizontalExcludePx: { value: horizontalExcludeUniform, type: 'vec2<f32>' },
          uTrackColor: { value: trackColorUniform, type: 'vec3<f32>' },
          uUseTrackColor: { value: 0, type: 'f32' },
          uYFlip: { value: 1, type: 'f32' },
        },
      },
    });

    const mesh = new Mesh<Geometry, Shader>({
      geometry,
      shader,
      state: State.for2d(),
    });
    mesh.eventMode = 'none';
    mesh.visible = false;
    if (state.labelPool) state.container.addChildAt(mesh, 0);
    else state.container.addChild(mesh);
    state.geometryBuildCount += 1;

    state.meshState = {
      mesh,
      geometry,
      shader,
      buffers: [
        bpStartChunk,
        bpStartDelta,
        bpEndChunk,
        bpEndDelta,
        offsetBuf,
        halfHBuf,
        xSideBuf,
        ySideBuf,
        colorBuf,
      ],
      viewportUniform,
      trackColorUniform,
      vertexCount: vertices.visibleRecordCount * 6,
    };
  }

  private applyCamera(state: ContainerState, args: TrackPaintArgs<AnnotationTrackData>): void {
    const meshState = state.meshState;
    if (!meshState) return;
    const viewStartBp = args.viewportBpRange.start;
    const pixelsPerBp = args.pathMapper.pixelsPerBp;
    const xOrigin = args.pathMapper.bpLeftX(viewStartBp);
    const u = (meshState.shader.resources.annotationUniforms as { uniforms: AnnotationUniforms })
      .uniforms;
    u.uXScale = pixelsPerBp;
    u.uXOrigin = xOrigin;
    u.uBpOriginChunk = bpCoordinateChunk(viewStartBp);
    u.uBpOriginDelta = bpCoordinateDelta(viewStartBp);
    u.uY0 = args.containerTopPx;
    const subpixel = retainedSubpixelOpacityPolicy();
    u.uSubpixelMinWidthPx = subpixel.minWidthPx;
    u.uSubpixelAlphaGamma = subpixel.alphaGamma;
    u.uSubpixelMinAlphaScale = subpixel.minAlphaScale;
    const displayColor = normalizeTrackColor(args.presentation.color);
    if (displayColor !== null) {
      const themed = webglAnnotationColorForMode(
        Number.parseInt(displayColor.slice(1), 16),
        args.theme.mode
      );
      meshState.trackColorUniform[0] = ((themed >> 16) & 0xff) / 255;
      meshState.trackColorUniform[1] = ((themed >> 8) & 0xff) / 255;
      meshState.trackColorUniform[2] = (themed & 0xff) / 255;
    }
    u.uUseTrackColor = displayColor === null ? 0 : 1;
    state.displayColor = displayColor;
    u.uYFlip = 1;
    meshState.viewportUniform[0] = args.viewportWidthPx;
    meshState.viewportUniform[1] = args.viewportHeightPx;
  }

  private syncLabels(
    state: ContainerState,
    args: TrackPaintArgs<AnnotationTrackData>,
    records: ReadonlyArray<AnnotationRecord>,
    assignment: AnnotationLaneAssignment,
    rowHeightPx: number
  ): void {
    const pool = state.labelPool;
    if (!pool) {
      state.labelCount = 0;
      return;
    }
    pool.reset();
    const labels = planBoundedIntervalLabels({
      records,
      laneAssignments: assignment.lanes,
      viewportBpRange: args.viewportBpRange,
      viewportWidthPx: args.viewportWidthPx,
      bpToX: (bp) => args.pathMapper.bpLeftX(bp),
      rowHeightPx,
      trackHeightPx: args.layoutEntry.height,
      maxLabels: this.maxLabels,
      estimatedCharacterWidthPx: 6,
      labelForRecord: (record) => record.name,
      strandForRecord: (record) => record.strand,
      isDensityRecord: (record) => Boolean(record.extra?.dnaforgeDensity),
    });
    for (const label of labels) {
      const text = pool.acquire();
      if (text.text !== label.text) text.text = label.text;
      text.position.set(label.x, label.y);
      text.tint = intervalLabelTint(records[label.recordIndex], state.displayColor);
      text.alpha = 0.95;
    }
    state.labelCount = labels.length;
  }

  private disposeMesh(state: ContainerState): void {
    const meshState = state.meshState;
    if (!meshState) return;
    if (meshState.mesh.parent) meshState.mesh.parent.removeChild(meshState.mesh);
    meshState.mesh.destroy();
    meshState.geometry.destroy(true);
    destroyLayerShader(meshState.shader);
    state.meshState = null;
  }
}

function intervalLabelTint(record: AnnotationRecord, displayColor: string | null): number {
  const background =
    displayColor === null
      ? (record.color ?? TRACK_DEFAULT_COLORS.annotationFallback)
      : Number.parseInt(displayColor.slice(1), 16);
  const red = (background >> 16) & 0xff;
  const green = (background >> 8) & 0xff;
  const blue = background & 0xff;
  const luminance = (red * 299 + green * 587 + blue * 114) / 255_000;
  return luminance > 0.58 ? 0x0f172a : 0xffffff;
}
