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

import type { PileupReferenceInterval } from '@waypoint/genome-data';

import {
  BP_COORDINATE_CHUNK_SIZE,
  bpCoordinateChunk,
  bpCoordinateDelta,
  unpackBpCoordinate,
} from '../overview/bp-coordinate-packing';
import type { PathMapper } from '../shared/path-types';
import type { WebGLRenderTheme } from '../shared/theme';
import { destroyLayerShader } from '../shared/pixi-shader-lifecycle';

const CORNERS = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
const INSTANCE_FLOATS = 4;
const MOTION_PERIOD_MS = 1_100;
const SIGNAL_RAIL_MOTION_PERIOD_MS = 2_000;
export type PendingIntervalAppearance = 'read-pending' | 'signal-pending';

export const PENDING_INTERVAL_BAND_HEIGHT_PX = 6;
export const PENDING_SIGNAL_RAIL_HEIGHT_PX = 4;
export const PENDING_INTERVAL_RENDER_OWNER = 'pileup-pending-reference-motion' as const;

const VERTEX_SHADER = `
precision highp float;
attribute vec2 aCorner;
attribute vec4 aBpRange;
uniform float uXScale;
uniform float uXOrigin;
uniform float uBpOriginChunk;
uniform float uBpOriginDelta;
uniform vec2 uViewportSize;
uniform float uBandTopPx;
uniform float uBandHeightPx;
varying float vScreenX;
varying float vBandY;
const float BP_CHUNK_SIZE = ${BP_COORDINATE_CHUNK_SIZE}.0;
void main() {
  float startRel =
    (aBpRange.x - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpRange.y - uBpOriginDelta);
  float endRel =
    (aBpRange.z - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpRange.w - uBpOriginDelta);
  float startX = uXScale * startRel + uXOrigin;
  float endX = uXScale * endRel + uXOrigin;
  float screenX = mix(startX, endX, aCorner.x);
  float screenY = uBandTopPx + aCorner.y * uBandHeightPx;
  vec2 viewport = max(uViewportSize, vec2(1.0));
  gl_Position = vec4(
    (screenX / viewport.x) * 2.0 - 1.0,
    1.0 - (screenY / viewport.y) * 2.0,
    0.0,
    1.0
  );
  vScreenX = screenX;
  vBandY = aCorner.y;
}
`;

const FRAGMENT_SHADER = `
precision highp float;
varying float vScreenX;
varying float vBandY;
uniform vec3 uPendingColor;
uniform float uMotionPhase;
uniform float uSignalRail;
uniform float uBandHeightPx;
uniform vec2 uViewportSize;
uniform vec3 uLoadingBaseColor;
uniform vec3 uLoadingPulseColor;
void main() {
  if (uSignalRail > 0.5) {
    // Mark only the missing genomic span with a flat line. The moving head
    // indicates activity without fabricating a data-shaped histogram.
    float yPx = vBandY * uBandHeightPx;
    float rail = 1.0 - smoothstep(0.65, 1.8, abs(yPx - uBandHeightPx * 0.5));
    float headX = uMotionPhase * (uViewportSize.x + 160.0) - 80.0;
    float head = 1.0 - smoothstep(0.0, 80.0, abs(vScreenX - headX));
    float alpha = rail * (0.72 + 0.28 * head);
    if (alpha <= 0.01) discard;
    vec3 color = mix(uLoadingBaseColor, uLoadingPulseColor, head);
    gl_FragColor = vec4(color * alpha, alpha);
    return;
  }
  float centerLine = 1.0 - smoothstep(0.22, 0.5, abs(vBandY - 0.5));
  float moving = fract((vScreenX + uMotionPhase * 48.0) / 14.0);
  float dash = 1.0 - smoothstep(0.46, 0.64, moving);
  float alpha = centerLine * dash * 0.72;
  if (alpha <= 0.01) discard;
  gl_FragColor = vec4(uPendingColor * alpha, alpha);
}
`;

function pendingIntervalGlProgram(): GlProgram {
  return GlProgram.from({
    name: PENDING_INTERVAL_RENDER_OWNER,
    vertex: VERTEX_SHADER,
    fragment: FRAGMENT_SHADER,
  });
}

interface PendingIntervalUniforms {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uViewportSize: Float32Array;
  uBandTopPx: number;
  uBandHeightPx: number;
  uPendingColor: Float32Array;
  uMotionPhase: number;
  uSignalRail: number;
  uLoadingBaseColor: Float32Array;
  uLoadingPulseColor: Float32Array;
}

export interface PackedPendingReferenceIntervals {
  readonly intervals: ReadonlyArray<{ readonly startBp: number; readonly endBp: number }>;
  readonly instanceData: Float32Array;
}

export function uncoveredPendingReferenceIntervals(
  intervals: ReadonlyArray<PileupReferenceInterval>,
  loadedRanges: ReadonlyArray<{ startBp: number; endBp: number }>
): PileupReferenceInterval[] {
  return intervals.flatMap((interval) => {
    if (interval.state !== 'pending') return [];
    let pieces = [{ startBp: interval.startBp, endBp: interval.endBp }];
    for (const loaded of loadedRanges) {
      pieces = pieces.flatMap((piece) => {
        if (loaded.endBp <= piece.startBp || loaded.startBp >= piece.endBp) return [piece];
        return [
          { startBp: piece.startBp, endBp: Math.min(piece.endBp, loaded.startBp) },
          { startBp: Math.max(piece.startBp, loaded.endBp), endBp: piece.endBp },
        ].filter((range) => range.endBp > range.startBp);
      });
    }
    return pieces
      .filter((range) => range.endBp > range.startBp)
      .map((range) => ({ ...range, state: 'pending' as const }));
  });
}

export function packPendingReferenceIntervals(
  source: ReadonlyArray<PileupReferenceInterval>
): PackedPendingReferenceIntervals {
  const intervals = source.flatMap((interval) =>
    interval.state === 'pending' && interval.endBp > interval.startBp
      ? [{ startBp: interval.startBp, endBp: interval.endBp }]
      : []
  );
  const instanceData = new Float32Array(intervals.length * INSTANCE_FLOATS);
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index]!;
    const offset = index * INSTANCE_FLOATS;
    instanceData[offset] = bpCoordinateChunk(interval.startBp);
    instanceData[offset + 1] = bpCoordinateDelta(interval.startBp);
    instanceData[offset + 2] = bpCoordinateChunk(interval.endBp);
    instanceData[offset + 3] = bpCoordinateDelta(interval.endBp);
  }
  return { intervals, instanceData };
}

export class PileupPendingIntervalLayer {
  private readonly container: Container;
  private readonly cornerBuffer: PixiBuffer;
  private readonly instanceBuffer: PixiBuffer;
  private readonly geometry: Geometry;
  private readonly shader: Shader;
  private readonly mesh: Mesh<Geometry, Shader>;
  private intervalSignature = '';
  private instanceData = new Float32Array(0);
  private capacity = 0;
  private pendingIntervals: PackedPendingReferenceIntervals['intervals'] = [];
  private geometryBuildCount = 0;
  private bufferUploadCount = 0;
  private cameraUniformUpdateCount = 0;
  private projectedIntervalsPx: Array<{ left: number; right: number }> = [];
  private bandTopPx = 0;
  private bandHeightPx = PENDING_INTERVAL_BAND_HEIGHT_PX;
  private appearance: PendingIntervalAppearance = 'read-pending';
  private loadingColors = { base: 0xc9e6f8, pulse: 0x2b91d1 };
  private motionPhase = 0;

  constructor(container: Container) {
    this.container = container;
    this.cornerBuffer = new PixiBuffer({
      data: CORNERS,
      usage: BufferUsage.VERTEX,
      label: 'pileup-pending-interval-corners',
      shrinkToFit: false,
    });
    this.instanceBuffer = new PixiBuffer({
      data: this.instanceData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: 'pileup-pending-interval-instances',
      shrinkToFit: false,
    });
    const instance = (offsetFloats: number) => ({
      buffer: this.instanceBuffer,
      format: 'float32x4' as const,
      stride: INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      offset: offsetFloats * Float32Array.BYTES_PER_ELEMENT,
      instance: true,
    });
    this.geometry = new Geometry({
      attributes: {
        aCorner: { buffer: this.cornerBuffer, format: 'float32x2' },
        aBpRange: instance(0),
      },
      topology: 'triangle-list',
      instanceCount: 0,
    });
    this.shader = new Shader({
      glProgram: pendingIntervalGlProgram(),
      resources: {
        pendingIntervalUniforms: {
          uXScale: { value: 1, type: 'f32' },
          uXOrigin: { value: 0, type: 'f32' },
          uBpOriginChunk: { value: 0, type: 'f32' },
          uBpOriginDelta: { value: 0, type: 'f32' },
          uViewportSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uBandTopPx: { value: 0, type: 'f32' },
          uBandHeightPx: { value: PENDING_INTERVAL_BAND_HEIGHT_PX, type: 'f32' },
          uPendingColor: {
            value: new Float32Array([0.22, 0.66, 0.96]),
            type: 'vec3<f32>',
          },
          uMotionPhase: { value: 0, type: 'f32' },
          uSignalRail: { value: 0, type: 'f32' },
          uLoadingBaseColor: { value: new Float32Array(3), type: 'vec3<f32>' },
          uLoadingPulseColor: { value: new Float32Array(3), type: 'vec3<f32>' },
        },
      },
    });
    this.mesh = new Mesh<Geometry, Shader>({
      geometry: this.geometry,
      shader: this.shader,
      state: State.for2d(),
    });
    this.mesh.label = PENDING_INTERVAL_RENDER_OWNER;
    this.mesh.eventMode = 'none';
    this.mesh.visible = false;
    this.container.addChild(this.mesh);
  }

  static gpuProgram(): GlProgram {
    return pendingIntervalGlProgram();
  }

  paint(input: {
    readonly intervals: ReadonlyArray<PileupReferenceInterval>;
    readonly pathMapper: PathMapper;
    readonly viewportWidthPx: number;
    readonly viewportHeightPx: number;
    readonly bandTopPx: number;
    readonly bandHeightPx?: number;
    readonly appearance?: PendingIntervalAppearance;
    readonly theme: WebGLRenderTheme;
    readonly nowMs?: number;
    readonly visible?: boolean;
  }): void {
    const signature = input.intervals
      .filter((interval) => interval.state === 'pending')
      .map((interval) => `${interval.startBp}:${interval.endBp}`)
      .join('|');
    if (signature !== this.intervalSignature) {
      this.rebuild(input.intervals, signature);
    }
    this.bandTopPx = input.bandTopPx;
    this.appearance = input.appearance ?? 'read-pending';
    this.bandHeightPx = Math.max(0, input.bandHeightPx ?? PENDING_INTERVAL_BAND_HEIGHT_PX);
    this.loadingColors =
      input.theme.mode === 'dark'
        ? { base: 0x24445e, pulse: 0x63b8ed }
        : { base: 0xc9e6f8, pulse: 0x2b91d1 };
    this.projectedIntervalsPx = this.pendingIntervals.map((interval) => ({
      left: input.pathMapper.bpLeftX(interval.startBp),
      right: input.pathMapper.bpLeftX(interval.endBp),
    }));
    const visible =
      input.visible !== false && this.geometry.instanceCount > 0 && this.bandHeightPx > 0;
    this.mesh.visible = visible;
    if (!visible) return;

    const uniforms = this.uniforms();
    const viewportStartBp = input.pathMapper.viewStartBp;
    uniforms.uXScale = input.pathMapper.pixelsPerBp;
    uniforms.uXOrigin = input.pathMapper.bpLeftX(viewportStartBp);
    uniforms.uBpOriginChunk = bpCoordinateChunk(viewportStartBp);
    uniforms.uBpOriginDelta = bpCoordinateDelta(viewportStartBp);
    uniforms.uViewportSize[0] = input.viewportWidthPx;
    uniforms.uViewportSize[1] = input.viewportHeightPx;
    uniforms.uBandTopPx = input.bandTopPx;
    uniforms.uBandHeightPx = this.bandHeightPx;
    uniforms.uSignalRail = this.appearance === 'signal-pending' ? 1 : 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const shift = (2 - channel) * 8;
      uniforms.uLoadingBaseColor[channel] = ((this.loadingColors.base >> shift) & 0xff) / 255;
      uniforms.uLoadingPulseColor[channel] = ((this.loadingColors.pulse >> shift) & 0xff) / 255;
    }
    const color = input.theme.mode === 'dark' ? 0x7dd3fc : 0x0284c7;
    uniforms.uPendingColor[0] = ((color >> 16) & 0xff) / 255;
    uniforms.uPendingColor[1] = ((color >> 8) & 0xff) / 255;
    uniforms.uPendingColor[2] = (color & 0xff) / 255;
    const now = input.nowMs ?? performance.now();
    const period =
      this.appearance === 'signal-pending' ? SIGNAL_RAIL_MOTION_PERIOD_MS : MOTION_PERIOD_MS;
    this.motionPhase = (((now % period) + period) % period) / period;
    uniforms.uMotionPhase = this.motionPhase;
    this.cameraUniformUpdateCount += 1;
  }

  hasMotion(): boolean {
    return this.mesh.visible && this.geometry.instanceCount > 0;
  }

  diagnostics(): {
    readonly pendingIntervalCount: number;
    readonly geometryBuildCount: number;
    readonly bufferUploadCount: number;
    readonly cameraUniformUpdateCount: number;
    readonly bandTopPx: number;
    readonly bandHeightPx: number;
    readonly appearance: PendingIntervalAppearance;
    readonly loadingColors: { readonly base: number; readonly pulse: number };
    readonly motionPhase: number;
    readonly projectedIntervalsPx: ReadonlyArray<{ readonly left: number; readonly right: number }>;
    readonly visible: boolean;
    readonly intervals: ReadonlyArray<{ readonly startBp: number; readonly endBp: number }>;
  } {
    return {
      pendingIntervalCount: this.geometry.instanceCount,
      geometryBuildCount: this.geometryBuildCount,
      bufferUploadCount: this.bufferUploadCount,
      cameraUniformUpdateCount: this.cameraUniformUpdateCount,
      bandTopPx: this.bandTopPx,
      bandHeightPx: this.bandHeightPx,
      appearance: this.appearance,
      loadingColors: this.loadingColors,
      motionPhase: this.motionPhase,
      projectedIntervalsPx: this.projectedIntervalsPx,
      visible: this.mesh.visible,
      intervals: this.pendingIntervals,
    };
  }

  destroy(): void {
    this.mesh.destroy();
    this.geometry.destroy(true);
    destroyLayerShader(this.shader);
  }

  private rebuild(intervals: ReadonlyArray<PileupReferenceInterval>, signature: string): void {
    const packed = packPendingReferenceIntervals(intervals);
    this.ensureCapacity(packed.intervals.length);
    this.instanceData.fill(0);
    this.instanceData.set(packed.instanceData);
    this.geometry.instanceCount = packed.intervals.length;
    if (packed.intervals.length > 0) {
      this.instanceBuffer.update();
      this.bufferUploadCount += 1;
      this.geometryBuildCount += 1;
    }
    this.pendingIntervals = packed.intervals;
    this.intervalSignature = signature;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) return;
    let capacity = Math.max(4, this.capacity);
    while (capacity < required) capacity *= 2;
    this.capacity = capacity;
    this.instanceData = new Float32Array(capacity * INSTANCE_FLOATS);
    this.instanceBuffer.data = this.instanceData;
  }

  private uniforms(): PendingIntervalUniforms {
    return (
      this.shader.resources.pendingIntervalUniforms as {
        uniforms: PendingIntervalUniforms;
      }
    ).uniforms;
  }
}

export function unpackPendingReferenceInterval(
  instanceData: Float32Array,
  index: number
): { startBp: number; endBp: number } {
  const offset = index * INSTANCE_FLOATS;
  return {
    startBp: unpackBpCoordinate(instanceData[offset]!, instanceData[offset + 1]!),
    endBp: unpackBpCoordinate(instanceData[offset + 2]!, instanceData[offset + 3]!),
  };
}
