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
  normalizeQuantitativeTrackPresentation,
  resolveQuantitativeDisplayRange,
  type PeakRecord,
  type QuantitativeBin,
  type ResolvedQuantitativeDisplayRange,
} from '@waypoint/genome-data';

import {
  BP_COORDINATE_CHUNK_SIZE,
  bpCoordinateChunk,
  bpCoordinateDelta,
} from '../overview/bp-coordinate-packing';
import { retainedSubpixelOpacityPolicy } from '../overview/retained-subpixel-aa';
import { webglAnnotationColorForMode } from '../shared/theme';
import { destroyLayerShader } from '../shared/pixi-shader-lifecycle';
import {
  buildQuantitativeTrackVertices,
  type QuantitativeRenderMode,
} from './quantitative-track-vertices';
import type { PixiLinearTrackRenderer, TrackMountArgs, TrackPaintArgs } from './types';
import { normalizeTrackColor } from './track-presentation';

const DEFAULT_SIGNAL_COLOR = 0x2563eb;
const DEFAULT_PEAK_COLOR = 0x7c3aed;
const CLIPPED_MARKER_STYLE = 'same-hue-cap' as const;
const CLIPPED_MARKER_THICKNESS_PX = 2;
const CLIPPED_MARKER_DARKEN_FACTOR = 0.62;

const QUANTITATIVE_VERTEX_SHADER = `
precision highp float;
attribute float aBpStartChunk;
attribute float aBpStartDelta;
attribute float aBpEndChunk;
attribute float aBpEndDelta;
attribute float aValue;
attribute float aXSide;
attribute float aYSide;
attribute vec4 aColor;
uniform float uXScale;
uniform float uXOrigin;
uniform float uBpOriginChunk;
uniform float uBpOriginDelta;
uniform float uTrackTop;
uniform float uTrackHeight;
uniform float uMinValue;
uniform float uMaxValue;
uniform float uTransformMode;
uniform vec2 uViewportSize;
uniform float uSubpixelMinWidthPx;
uniform vec4 uTrackColor;
uniform float uUseTrackColor;
varying vec4 vColor;
varying float vSubpixelActualWidth;
varying float vClipped;
varying float vScreenY;
varying float vEndpointY;
const float BP_CHUNK_SIZE = ${BP_COORDINATE_CHUNK_SIZE}.0;
void main() {
  float startRel = (aBpStartChunk - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpStartDelta - uBpOriginDelta);
  float endRel = (aBpEndChunk - uBpOriginChunk) * BP_CHUNK_SIZE +
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
  float transformedValue = uTransformMode > 0.5 ? log(1.0 + max(0.0, aValue)) : aValue;
  float range = max(0.000001, uMaxValue - uMinValue);
  float zeroY = uTrackTop + (uMaxValue - clamp(0.0, uMinValue, uMaxValue)) / range * uTrackHeight;
  float valueY = uTrackTop + (uMaxValue - clamp(transformedValue, uMinValue, uMaxValue)) / range * uTrackHeight;
  vec2 screen = vec2(mix(x1, x2, aXSide), mix(zeroY, valueY, aYSide));
  vec2 viewport = max(uViewportSize, vec2(1.0, 1.0));
  vec2 clip = vec2((screen.x / viewport.x) * 2.0 - 1.0, 1.0 - (screen.y / viewport.y) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vColor = mix(aColor, uTrackColor, uUseTrackColor);
  vSubpixelActualWidth = actualWidth;
  vClipped = transformedValue < uMinValue || transformedValue > uMaxValue ? 1.0 : 0.0;
  vScreenY = screen.y;
  vEndpointY = valueY;
}
`;

const QUANTITATIVE_FRAGMENT_SHADER = `
precision highp float;
varying vec4 vColor;
varying float vSubpixelActualWidth;
varying float vClipped;
varying float vScreenY;
varying float vEndpointY;
uniform float uSubpixelMinWidthPx;
uniform float uSubpixelAlphaGamma;
uniform float uSubpixelMinAlphaScale;
void main() {
  float actualWidth = max(0.0, vSubpixelActualWidth);
  if (actualWidth <= 0.0) discard;
  float ratio = clamp(actualWidth / max(0.001, uSubpixelMinWidthPx), 0.0, 1.0);
  float alphaScale = uSubpixelMinAlphaScale +
    (1.0 - uSubpixelMinAlphaScale) * pow(ratio, max(0.01, uSubpixelAlphaGamma));
  float endpointDistancePx = abs(vScreenY - vEndpointY);
  float clippedCap = vClipped > 0.5
    ? 1.0 - smoothstep(1.0, ${CLIPPED_MARKER_THICKNESS_PX.toFixed(1)}, endpointDistancePx)
    : 0.0;
  vec4 displayColor = vec4(
    mix(vColor.rgb, vColor.rgb * ${CLIPPED_MARKER_DARKEN_FACTOR.toFixed(2)}, clippedCap),
    vColor.a
  );
  float displayAlpha = displayColor.a * alphaScale;
  gl_FragColor = vec4(displayColor.rgb * displayAlpha, displayAlpha);
}
`;

export interface QuantitativeTrackData {
  readonly records: ReadonlyArray<QuantitativeBin | PeakRecord>;
}

export interface PixiQuantitativeTrackRendererOptions {
  readonly type: string;
  readonly mode?: QuantitativeRenderMode;
  readonly defaultColor?: number;
}

interface QuantitativeUniforms {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uTrackTop: number;
  uTrackHeight: number;
  uMinValue: number;
  uMaxValue: number;
  uTransformMode: number;
  uViewportSize: Float32Array;
  uSubpixelMinWidthPx: number;
  uSubpixelAlphaGamma: number;
  uSubpixelMinAlphaScale: number;
  uTrackColor: Float32Array;
  uUseTrackColor: number;
}

interface QuantitativeContainerState {
  readonly mesh: Mesh<Geometry, Shader>;
  readonly geometry: Geometry;
  readonly shader: Shader;
  readonly buffers: ReadonlyArray<PixiBuffer>;
  readonly viewport: Float32Array;
  readonly trackColor: Float32Array;
  recordsRef: QuantitativeTrackData['records'] | null;
  geometryThemeMode: 'light' | 'dark' | null;
  displayColorThemeMode: 'light' | 'dark' | null;
  displayColor: string | null;
  geometryBuildCount: number;
  smoothingSigmaBins: number;
  presentedIntervals: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly value: number;
  }>;
  minValue: number;
  maxValue: number;
  barCount: number;
  minRecordSpanBp: number;
  maxRecordSpanBp: number;
  maxRecordWidthPx: number;
  resolvedRange: ResolvedQuantitativeDisplayRange | null;
  rangeError: string | null;
}

export class PixiQuantitativeTrackRenderer implements PixiLinearTrackRenderer<QuantitativeTrackData> {
  readonly type: string;
  private readonly mode: QuantitativeRenderMode;
  private readonly defaultColor: number;
  private readonly states = new WeakMap<Container, QuantitativeContainerState>();

  private get surfaceKind(): 'continuous-fill' | 'discrete-mark' {
    return this.mode === 'signal' ? 'continuous-fill' : 'discrete-mark';
  }

  constructor(options: PixiQuantitativeTrackRendererOptions) {
    this.type = options.type;
    this.mode = options.mode ?? 'signal';
    this.defaultColor =
      options.defaultColor ?? (this.mode === 'peak' ? DEFAULT_PEAK_COLOR : DEFAULT_SIGNAL_COLOR);
  }

  mount(_args: TrackMountArgs): Container {
    const container = new Container();
    container.eventMode = 'none';
    const makeBuffer = (label: string) =>
      new PixiBuffer({
        data: new Float32Array(0),
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        label,
        shrinkToFit: false,
      });
    const buffers = [
      makeBuffer('quantitative-bp-start-chunk'),
      makeBuffer('quantitative-bp-start-delta'),
      makeBuffer('quantitative-bp-end-chunk'),
      makeBuffer('quantitative-bp-end-delta'),
      makeBuffer('quantitative-value'),
      makeBuffer('quantitative-x-side'),
      makeBuffer('quantitative-y-side'),
      makeBuffer('quantitative-color'),
    ];
    const geometry = new Geometry({
      attributes: {
        aBpStartChunk: { buffer: buffers[0], format: 'float32' },
        aBpStartDelta: { buffer: buffers[1], format: 'float32' },
        aBpEndChunk: { buffer: buffers[2], format: 'float32' },
        aBpEndDelta: { buffer: buffers[3], format: 'float32' },
        aValue: { buffer: buffers[4], format: 'float32' },
        aXSide: { buffer: buffers[5], format: 'float32' },
        aYSide: { buffer: buffers[6], format: 'float32' },
        aColor: { buffer: buffers[7], format: 'float32x4' },
      },
      topology: 'triangle-list',
    });
    const viewport = new Float32Array([1, 1]);
    const trackColor = new Float32Array([1, 1, 1, 0.9]);
    const subpixel = retainedSubpixelOpacityPolicy(this.surfaceKind);
    const shader = new Shader({
      glProgram: GlProgram.from({
        name: `quantitative-${this.mode}`,
        vertex: QUANTITATIVE_VERTEX_SHADER,
        fragment: QUANTITATIVE_FRAGMENT_SHADER,
      }),
      resources: {
        quantitativeUniforms: {
          uXScale: { value: 1, type: 'f32' },
          uXOrigin: { value: 0, type: 'f32' },
          uBpOriginChunk: { value: 0, type: 'f32' },
          uBpOriginDelta: { value: 0, type: 'f32' },
          uTrackTop: { value: 0, type: 'f32' },
          uTrackHeight: { value: 1, type: 'f32' },
          uMinValue: { value: 0, type: 'f32' },
          uMaxValue: { value: 1, type: 'f32' },
          uTransformMode: { value: 0, type: 'f32' },
          uViewportSize: { value: viewport, type: 'vec2<f32>' },
          uSubpixelMinWidthPx: { value: subpixel.minWidthPx, type: 'f32' },
          uSubpixelAlphaGamma: { value: subpixel.alphaGamma, type: 'f32' },
          uSubpixelMinAlphaScale: { value: subpixel.minAlphaScale, type: 'f32' },
          uTrackColor: { value: trackColor, type: 'vec4<f32>' },
          uUseTrackColor: { value: 0, type: 'f32' },
        },
      },
    });
    const mesh = new Mesh({ geometry, shader, state: State.for2d() });
    mesh.eventMode = 'none';
    mesh.visible = false;
    container.addChild(mesh);
    this.states.set(container, {
      mesh,
      geometry,
      shader,
      buffers,
      viewport,
      trackColor,
      recordsRef: null,
      geometryThemeMode: null,
      displayColorThemeMode: null,
      displayColor: null,
      geometryBuildCount: 0,
      smoothingSigmaBins: 0,
      presentedIntervals: [],
      minValue: 0,
      maxValue: 1,
      barCount: 0,
      minRecordSpanBp: 0,
      maxRecordSpanBp: 0,
      maxRecordWidthPx: 0,
      resolvedRange: null,
      rangeError: null,
    });
    return container;
  }

  paint(args: TrackPaintArgs<QuantitativeTrackData>): void {
    const state = this.states.get(args.container);
    if (!state) return;
    const records = args.data?.records ?? [];
    if (records.length === 0) {
      state.mesh.visible = false;
      state.recordsRef = records;
      state.barCount = 0;
      state.minValue = 0;
      state.maxValue = 0;
      state.minRecordSpanBp = 0;
      state.maxRecordSpanBp = 0;
      return;
    }
    const displayColor = normalizeTrackColor(args.presentation.color);
    let smoothingSigmaBins: number;
    try {
      const presentation = normalizeQuantitativeTrackPresentation(args.presentation.quantitative);
      smoothingSigmaBins = this.mode === 'signal' ? (presentation.smoothingSigmaBins ?? 0) : 0;
    } catch (error) {
      state.resolvedRange = null;
      state.rangeError = error instanceof Error ? error.message : String(error);
      state.mesh.visible = false;
      return;
    }
    if (
      state.recordsRef !== records ||
      state.smoothingSigmaBins !== smoothingSigmaBins ||
      (displayColor === null && state.geometryThemeMode !== args.theme.mode)
    ) {
      const vertices = buildQuantitativeTrackVertices({
        records,
        mode: this.mode,
        smoothingSigmaBins,
        defaultColor: webglAnnotationColorForMode(this.defaultColor, args.theme.mode),
      });
      const data = [
        vertices.bpStartChunk,
        vertices.bpStartDelta,
        vertices.bpEndChunk,
        vertices.bpEndDelta,
        vertices.value,
        vertices.xSide,
        vertices.ySide,
        vertices.color,
      ];
      for (let index = 0; index < state.buffers.length; index += 1) {
        state.buffers[index].data = data[index];
      }
      state.recordsRef = records;
      state.geometryThemeMode = args.theme.mode;
      state.geometryBuildCount += 1;
      state.smoothingSigmaBins = smoothingSigmaBins;
      state.presentedIntervals = vertices.presentedIntervals;
      state.minValue = vertices.minValue;
      state.maxValue = vertices.maxValue;
      state.barCount = vertices.barCount;
      let minRecordSpanBp = Number.POSITIVE_INFINITY;
      let maxRecordSpanBp = 0;
      for (const record of records) {
        const spanBp = record.end - record.start;
        if (!Number.isFinite(spanBp) || spanBp <= 0) continue;
        minRecordSpanBp = Math.min(minRecordSpanBp, spanBp);
        maxRecordSpanBp = Math.max(maxRecordSpanBp, spanBp);
      }
      state.minRecordSpanBp = Number.isFinite(minRecordSpanBp) ? minRecordSpanBp : 0;
      state.maxRecordSpanBp = maxRecordSpanBp;
    }
    const uniforms = (
      state.shader.resources.quantitativeUniforms as { uniforms: QuantitativeUniforms }
    ).uniforms;
    let resolvedRange: ResolvedQuantitativeDisplayRange;
    try {
      const visibleValues = {
        forEach(visit: (value: number) => void) {
          for (const record of state.presentedIntervals) {
            if (
              record.end <= args.viewportBpRange.start ||
              record.start >= args.viewportBpRange.end
            )
              continue;
            visit(record.value);
          }
        },
      };
      resolvedRange = resolveQuantitativeDisplayRange({
        presentation: args.presentation.quantitative,
        sourceSummary: args.presentation.quantitativeSourceSummary,
        visibleValues,
      });
    } catch (error) {
      state.resolvedRange = null;
      state.rangeError = error instanceof Error ? error.message : String(error);
      state.mesh.visible = false;
      return;
    }
    state.resolvedRange = resolvedRange;
    state.rangeError = null;
    if (state.displayColor !== displayColor || state.displayColorThemeMode !== args.theme.mode) {
      if (displayColor !== null) {
        const themed = webglAnnotationColorForMode(
          Number.parseInt(displayColor.slice(1), 16),
          args.theme.mode
        );
        state.trackColor[0] = ((themed >> 16) & 0xff) / 255;
        state.trackColor[1] = ((themed >> 8) & 0xff) / 255;
        state.trackColor[2] = (themed & 0xff) / 255;
        state.trackColor[3] = 0.9;
      }
      state.displayColor = displayColor;
      state.displayColorThemeMode = args.theme.mode;
    }
    uniforms.uUseTrackColor = displayColor === null ? 0 : 1;
    const originBp = args.viewportBpRange.start;
    uniforms.uXScale = args.pathMapper.pixelsPerBp;
    state.maxRecordWidthPx = state.maxRecordSpanBp * args.pathMapper.pixelsPerBp;
    uniforms.uXOrigin = args.pathMapper.bpLeftX(originBp);
    uniforms.uBpOriginChunk = bpCoordinateChunk(originBp);
    uniforms.uBpOriginDelta = bpCoordinateDelta(originBp);
    uniforms.uTrackTop = args.containerTopPx + 2;
    uniforms.uTrackHeight = Math.max(1, args.layoutEntry.height - 4);
    uniforms.uMinValue = resolvedRange.displayMin;
    uniforms.uMaxValue = resolvedRange.displayMax;
    uniforms.uTransformMode = resolvedRange.transform === 'log1p' ? 1 : 0;
    const subpixel = retainedSubpixelOpacityPolicy(this.surfaceKind);
    uniforms.uSubpixelMinWidthPx = subpixel.minWidthPx;
    uniforms.uSubpixelAlphaGamma = subpixel.alphaGamma;
    uniforms.uSubpixelMinAlphaScale = subpixel.minAlphaScale;
    state.viewport[0] = args.viewportWidthPx;
    state.viewport[1] = args.viewportHeightPx;
    state.mesh.visible = state.barCount > 0;
  }

  getDiagnostics(container: Container): object | null {
    const state = this.states.get(container);
    return state
      ? {
          mode: this.mode,
          surfaceKind: this.surfaceKind,
          recordCount: state.recordsRef?.length ?? 0,
          barCount: state.barCount,
          minValue: state.minValue,
          maxValue: state.maxValue,
          minRecordSpanBp: state.minRecordSpanBp,
          maxRecordSpanBp: state.maxRecordSpanBp,
          maxRecordWidthPx: state.maxRecordWidthPx,
          subpixelMinWidthPx: retainedSubpixelOpacityPolicy(this.surfaceKind).minWidthPx,
          subpixelMinAlphaScale: retainedSubpixelOpacityPolicy(this.surfaceKind).minAlphaScale,
          displayColor: state.displayColor,
          geometryBuildCount: state.geometryBuildCount,
          smoothingSigmaBins: state.smoothingSigmaBins,
          scaleMode: state.resolvedRange?.mode ?? null,
          scaleTransform: state.resolvedRange?.transform ?? null,
          scaleSource: state.resolvedRange?.source ?? null,
          displayMin: state.resolvedRange?.rawMin ?? null,
          displayMax: state.resolvedRange?.rawMax ?? null,
          clippedLowCount: state.resolvedRange?.clippedLowCount ?? 0,
          clippedHighCount: state.resolvedRange?.clippedHighCount ?? 0,
          clippedMarkerStyle: CLIPPED_MARKER_STYLE,
          clippedMarkerThicknessPx: CLIPPED_MARKER_THICKNESS_PX,
          rangeError: state.rangeError,
        }
      : null;
  }

  unmount(container: Container): void {
    const state = this.states.get(container);
    if (!state) return;
    this.states.delete(container);
    state.mesh.destroy();
    state.geometry.destroy(true);
    destroyLayerShader(state.shader);
    container.destroy({ children: true });
  }
}
