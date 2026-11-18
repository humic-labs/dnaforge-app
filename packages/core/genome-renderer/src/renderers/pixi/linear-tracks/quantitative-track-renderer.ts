import { SCIENTIFIC_COLOR_PALETTES, TRACK_DEFAULT_COLORS } from '@waypoint/sequence-utils';
import {
  Buffer as PixiBuffer,
  BufferUsage,
  Container,
  Geometry,
  Graphics,
  Text,
  GlProgram,
  Mesh,
  Shader,
  State,
} from 'pixi.js';

import {
  normalizeQuantitativeTrackPresentation,
  resolveQuantitativeDisplayRange,
  type PeakRecord,
  type QuantitativeColorPalette,
  type QuantitativeGraph,
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
import type {
  PixiLinearTrackRenderer,
  TrackMountArgs,
  TrackPaintArgs,
  TrackHoverArgs,
  TrackHitResult,
} from './types';
import { normalizeTrackColor } from './track-presentation';

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
uniform float uGraphMode;
uniform vec3 uPaletteLow;
uniform vec3 uPaletteMid;
uniform vec3 uPaletteHigh;
uniform vec2 uViewportSize;
uniform float uSubpixelMinWidthPx;
uniform vec4 uTrackColor;
uniform float uUseTrackColor;
varying vec4 vColor;
varying vec2 vPointUV;
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
  if (uGraphMode > 1.5) {
    float pointY = clamp(valueY, uTrackTop + 3.0, uTrackTop + uTrackHeight - 3.0);
    screen = vec2((x1 + x2) * 0.5 + (aXSide - 0.5) * 6.0, pointY + (aYSide - 0.5) * 6.0);
  } else if (uGraphMode > 0.5) {
    screen.y = uTrackTop + aYSide * uTrackHeight;
  }
  vPointUV = vec2(aXSide, aYSide) * 2.0 - 1.0;
  vec2 viewport = max(uViewportSize, vec2(1.0, 1.0));
  vec2 clip = vec2((screen.x / viewport.x) * 2.0 - 1.0, 1.0 - (screen.y / viewport.y) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vColor = mix(aColor, uTrackColor, uUseTrackColor);
  if (uGraphMode > 0.5 && uGraphMode < 1.5) {
    float t = clamp((transformedValue - uMinValue) / range, 0.0, 1.0);
    vec3 mappedColor = t < 0.5 ? mix(uPaletteLow, uPaletteMid, t * 2.0) : mix(uPaletteMid, uPaletteHigh, (t - 0.5) * 2.0);
    vColor = vec4(mappedColor, 1.0);
  }
  vSubpixelActualWidth = actualWidth;
  vClipped = transformedValue < uMinValue || transformedValue > uMaxValue ? 1.0 : 0.0;
  vScreenY = screen.y;
  vEndpointY = valueY;
}
`;

const QUANTITATIVE_FRAGMENT_SHADER = `
precision highp float;
uniform float uGraphMode;
varying vec4 vColor;
varying vec2 vPointUV;
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
  if (uGraphMode > 1.5) {
    float radius = length(vPointUV);
    if (radius > 1.0) discard;
    alphaScale = 1.0 - smoothstep(0.72, 1.0, radius);
  }
  float endpointDistancePx = abs(vScreenY - vEndpointY);
  float clippedCap = vClipped > 0.5 && uGraphMode < 0.5
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
  uGraphMode: number;
  uPaletteLow: Float32Array;
  uPaletteMid: Float32Array;
  uPaletteHigh: Float32Array;
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
  readonly hover: Graphics;
  readonly tooltip: Text;
  hoverPointer: { x: number; y: number } | null;
  graph: QuantitativeGraph;
  palette: QuantitativeColorPalette;
  hovered: { start: number; end: number; rawValue: number; presentedValue: number } | null;
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
    readonly rawValue: number;
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
      options.defaultColor ??
      (this.mode === 'peak'
        ? TRACK_DEFAULT_COLORS.peak
        : TRACK_DEFAULT_COLORS.quantitativeFallback);
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
          uGraphMode: { value: 0, type: 'f32' },
          uPaletteLow: { value: new Float32Array(3), type: 'vec3<f32>' },
          uPaletteMid: { value: new Float32Array(3), type: 'vec3<f32>' },
          uPaletteHigh: { value: new Float32Array(3), type: 'vec3<f32>' },
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
    const hover = new Graphics();
    const tooltip = new Text({ text: '', style: { fontFamily: 'system-ui', fontSize: 11 } });
    tooltip.visible = false;
    container.addChild(mesh, hover, tooltip);
    this.states.set(container, {
      mesh,
      geometry,
      shader,
      buffers,
      viewport,
      trackColor,
      hover,
      tooltip,
      hoverPointer: null,
      graph: 'bar',
      palette: 'viridis',
      hovered: null,
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
    state.tooltip.style.fill = args.theme.text;
    const records = args.data?.records ?? [];
    if (records.length === 0) {
      this.clearHover(args.container);
      state.mesh.visible = false;
      state.recordsRef = records;
      state.presentedIntervals = [];
      state.resolvedRange = null;
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
      state.graph = presentation.graph;
      state.palette = presentation.palette ?? 'viridis';
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
    uniforms.uGraphMode = state.graph === 'bar' ? 0 : state.graph === 'band' ? 1 : 2;
    const colors = SCIENTIFIC_COLOR_PALETTES[state.palette].colors;
    for (const [index, target] of [
      uniforms.uPaletteLow,
      uniforms.uPaletteMid,
      uniforms.uPaletteHigh,
    ].entries()) {
      const rgb = Number.parseInt(colors[index].slice(1), 16);
      target[0] = ((rgb >> 16) & 255) / 255;
      target[1] = ((rgb >> 8) & 255) / 255;
      target[2] = (rgb & 255) / 255;
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
    const subpixel = retainedSubpixelOpacityPolicy(
      state.graph === 'points' ? 'discrete-mark' : this.surfaceKind
    );
    uniforms.uSubpixelMinWidthPx = subpixel.minWidthPx;
    uniforms.uSubpixelAlphaGamma = subpixel.alphaGamma;
    uniforms.uSubpixelMinAlphaScale = subpixel.minAlphaScale;
    state.viewport[0] = args.viewportWidthPx;
    state.viewport[1] = args.viewportHeightPx;
    state.mesh.visible = state.barCount > 0;
    const pointer = state.hoverPointer;
    if (pointer) this.updateHover({ ...args, localX: pointer.x, localY: pointer.y });
  }

  private hit(args: TrackHoverArgs) {
    const state = this.states.get(args.container);
    if (!state?.mesh.visible || !state.resolvedRange) return null;
    const range = state.resolvedRange;
    const height = Math.max(1, args.layoutEntry.height - 4);
    const y = (value: number) => {
      const transformed = range.transform === 'log1p' ? Math.log1p(Math.max(0, value)) : value;
      return (
        2 +
        ((range.displayMax - Math.max(range.displayMin, Math.min(range.displayMax, transformed))) /
          (range.displayMax - range.displayMin)) *
          height
      );
    };
    for (let index = state.presentedIntervals.length - 1; index >= 0; index -= 1) {
      const record = state.presentedIntervals[index];
      if (record.end <= args.viewportBpRange.start || record.start >= args.viewportBpRange.end)
        continue;
      const left = args.pathMapper.bpLeftX(record.start);
      const right = args.pathMapper.bpLeftX(record.end);
      const valueY = y(record.value);
      if (state.graph === 'points') {
        const cx = (left + right) / 2,
          cy = Math.max(5, Math.min(height - 1, valueY));
        if (Math.hypot(args.localX - cx, args.localY - cy) <= 5)
          return { record, left: cx - 3, top: cy - 3, width: 6, height: 6 };
      } else {
        const top = state.graph === 'band' ? 2 : Math.min(y(0), valueY);
        const bottom = state.graph === 'band' ? 2 + height : Math.max(y(0), valueY);
        if (
          args.localX >= left - 1 &&
          args.localX < right + 1 &&
          args.localY >= top - 2 &&
          args.localY <= bottom + 2
        )
          return {
            record,
            left,
            top,
            width: Math.max(1, right - left),
            height: Math.max(1, bottom - top),
          };
      }
    }
    return null;
  }

  hitTest(args: TrackHoverArgs): TrackHitResult | null {
    const hit = this.hit(args);
    return hit
      ? {
          kind: 'select-bp-range',
          startBp: hit.record.start,
          endBp: hit.record.end,
          chromosomeId: args.chromosome.id,
          name: String(hit.record.rawValue),
        }
      : null;
  }

  updateHover(args: TrackHoverArgs): void {
    const state = this.states.get(args.container);
    if (!state) return;
    this.clearHover(args.container);
    state.hoverPointer = { x: args.localX, y: args.localY };
    const hit = this.hit(args);
    if (!hit) return;
    const { record } = hit;
    state.hovered = {
      start: record.start,
      end: record.end,
      rawValue: record.rawValue,
      presentedValue: record.value,
    };
    state.hover
      .rect(hit.left, hit.top, hit.width, hit.height)
      .stroke({ color: 0x64748b, width: 1 });
    const format = (value: number) => Number(value.toPrecision(5)).toLocaleString();
    state.tooltip.text = `${format(record.rawValue)} · ${args.chromosome.displayName}:${(record.start + 1).toLocaleString()}–${record.end.toLocaleString()}${Math.abs(record.value - record.rawValue) > 1e-9 ? ` · smoothed ${format(record.value)}` : ''}`;
    state.tooltip.position.set(
      Math.max(8, Math.min(args.localX + 8, args.viewportWidthPx - state.tooltip.width - 8)),
      Math.max(2, Math.min(args.localY + 8, args.layoutEntry.height - 16))
    );
    state.tooltip.visible = true;
  }

  clearHover(container: Container): void {
    const state = this.states.get(container);
    if (!state) return;
    state.hover.clear();
    state.tooltip.visible = false;
    state.hovered = null;
    state.hoverPointer = null;
  }

  getDiagnostics(container: Container): object | null {
    const state = this.states.get(container);
    return state
      ? {
          mode: this.mode,
          graph: state.graph,
          palette: state.palette,
          hovered: state.hovered,
          surfaceKind: state.graph === 'points' ? 'discrete-mark' : this.surfaceKind,
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
