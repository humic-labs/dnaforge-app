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

import type { PileupAlternateColumn } from '@waypoint/genome-data';

import {
  BP_COORDINATE_CHUNK_SIZE,
  bpCoordinateChunk,
  bpCoordinateDelta,
} from '../overview/bp-coordinate-packing';
import type { PathMapper } from '../shared/path-types';
import { destroyLayerShader } from '../shared/pixi-shader-lifecycle';
import { pileupExactReadZoomAlpha } from './pileup-exact-read-zoom';

const CORNERS = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
const INSTANCE_FLOATS = 4;

const VERTEX_SHADER = `
precision highp float;
attribute vec2 aCorner;
attribute float aBpChunk;
attribute float aBpDelta;
attribute float aLengthBp;
attribute float aStrength;
uniform float uXScale;
uniform float uXOrigin;
uniform float uBpOriginChunk;
uniform float uBpOriginDelta;
uniform vec2 uViewportSize;
uniform float uGuideTopPx;
uniform float uGuideHeightPx;
uniform float uAlpha;
varying vec4 vColor;
const float BP_CHUNK_SIZE = ${BP_COORDINATE_CHUNK_SIZE}.0;
void main() {
  float bpRel =
    (aBpChunk - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpDelta - uBpOriginDelta);
  float x1 = uXScale * bpRel + uXOrigin;
  float rawWidth = max(uXScale * aLengthBp, 1.0);
  float width = min(rawWidth, max(2.0, uXScale));
  float screenX = x1 + aCorner.x * width;
  float screenY = uGuideTopPx + aCorner.y * uGuideHeightPx;
  vec2 viewport = max(uViewportSize, vec2(1.0));
  gl_Position = vec4(
    (screenX / viewport.x) * 2.0 - 1.0,
    1.0 - (screenY / viewport.y) * 2.0,
    0.0,
    1.0
  );
  vColor = vec4(0.96, 0.42, 0.08, uAlpha * mix(0.55, 1.0, aStrength));
}
`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec4 vColor;
void main() {
  gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
}
`;

function pileupGlobalGuideGlProgram(): GlProgram {
  return GlProgram.from({
    name: 'pileup-global-alternate-guides',
    vertex: VERTEX_SHADER,
    fragment: FRAGMENT_SHADER,
  });
}

interface GuideUniforms {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uViewportSize: Float32Array;
  uGuideTopPx: number;
  uGuideHeightPx: number;
  uAlpha: number;
}

export class PileupGlobalGuideLayer {
  readonly container = new Container();
  private readonly cornerBuffer: PixiBuffer;
  private readonly instanceBuffer: PixiBuffer;
  private readonly geometry: Geometry;
  private readonly shader: Shader;
  private readonly mesh: Mesh<Geometry, Shader>;
  private columnsRef: ReadonlyArray<PileupAlternateColumn> | null = null;
  private capacity = 0;
  private instanceData = new Float32Array(0);
  private bufferGrowCount = 0;
  private buildCount = 0;
  private lastTopPx = 0;
  private lastViewportHeightPx = 0;
  private lastAlpha = 0;

  static gpuProgram(): GlProgram {
    return pileupGlobalGuideGlProgram();
  }

  constructor(label = 'pileup-global-alternate-guides') {
    this.container.label = label;
    this.container.eventMode = 'none';
    this.cornerBuffer = new PixiBuffer({
      data: CORNERS,
      usage: BufferUsage.VERTEX,
      label: 'pileup-global-guide-corners',
      shrinkToFit: false,
    });
    this.instanceBuffer = new PixiBuffer({
      data: this.instanceData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: 'pileup-global-guide-instances',
      shrinkToFit: false,
    });
    const instance = (floatOffset: number) => ({
      buffer: this.instanceBuffer,
      format: 'float32' as const,
      stride: INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      offset: floatOffset * Float32Array.BYTES_PER_ELEMENT,
      instance: true,
    });
    this.geometry = new Geometry({
      attributes: {
        aCorner: { buffer: this.cornerBuffer, format: 'float32x2' },
        aBpChunk: instance(0),
        aBpDelta: instance(1),
        aLengthBp: instance(2),
        aStrength: instance(3),
      },
      topology: 'triangle-list',
      instanceCount: 0,
    });
    this.shader = new Shader({
      glProgram: pileupGlobalGuideGlProgram(),
      resources: {
        pileupGlobalGuideUniforms: {
          uXScale: { value: 1, type: 'f32' },
          uXOrigin: { value: 0, type: 'f32' },
          uBpOriginChunk: { value: 0, type: 'f32' },
          uBpOriginDelta: { value: 0, type: 'f32' },
          uViewportSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uGuideTopPx: { value: 0, type: 'f32' },
          uGuideHeightPx: { value: 1, type: 'f32' },
          uAlpha: { value: 0, type: 'f32' },
        },
      },
    });
    this.mesh = new Mesh<Geometry, Shader>({
      geometry: this.geometry,
      shader: this.shader,
      state: State.for2d(),
    });
    this.mesh.eventMode = 'none';
    this.container.addChild(this.mesh);
  }

  paint(input: {
    readonly columns: ReadonlyArray<PileupAlternateColumn>;
    readonly pathMapper: PathMapper;
    readonly viewportStartBp: number;
    readonly viewportWidthPx: number;
    readonly viewportHeightPx: number;
    readonly guideTopPx?: number;
    readonly guideHeightPx?: number;
  }): void {
    if (input.columns !== this.columnsRef) this.rebuild(input.columns);
    const opacity = pileupExactReadZoomAlpha(input.pathMapper.pixelsPerBp);
    const visible = this.geometry.instanceCount > 0 && opacity > 0;
    this.container.visible = visible;
    if (!visible) return;

    const uniforms = (
      this.shader.resources.pileupGlobalGuideUniforms as {
        uniforms: GuideUniforms;
      }
    ).uniforms;
    uniforms.uXScale = input.pathMapper.pixelsPerBp;
    uniforms.uXOrigin = input.pathMapper.bpLeftX(input.viewportStartBp);
    uniforms.uBpOriginChunk = bpCoordinateChunk(input.viewportStartBp);
    uniforms.uBpOriginDelta = bpCoordinateDelta(input.viewportStartBp);
    uniforms.uViewportSize[0] = input.viewportWidthPx;
    uniforms.uViewportSize[1] = input.viewportHeightPx;
    const guideTopPx = input.guideTopPx ?? 0;
    const guideHeightPx = input.guideHeightPx ?? input.viewportHeightPx;
    uniforms.uGuideTopPx = guideTopPx;
    uniforms.uGuideHeightPx = guideHeightPx;
    uniforms.uAlpha = opacity * 0.1;
    this.lastTopPx = guideTopPx;
    this.lastViewportHeightPx = guideHeightPx;
    this.lastAlpha = uniforms.uAlpha;
  }

  diagnostics(): {
    columnCount: number;
    instanceCount: number;
    bufferCapacity: number;
    bufferGrowCount: number;
    buildCount: number;
    visible: boolean;
    topPx: number;
    bottomPx: number;
    alpha: number;
    positions: number[];
  } {
    return {
      columnCount: this.columnsRef?.length ?? 0,
      instanceCount: this.geometry.instanceCount,
      bufferCapacity: this.capacity,
      bufferGrowCount: this.bufferGrowCount,
      buildCount: this.buildCount,
      visible: this.container.visible,
      topPx: this.lastTopPx,
      bottomPx: this.lastTopPx + this.lastViewportHeightPx,
      alpha: this.lastAlpha,
      positions: this.columnsRef?.slice(0, 64).map((column) => column.pos) ?? [],
    };
  }

  destroy(): void {
    this.mesh.destroy();
    this.geometry.destroy(true);
    destroyLayerShader(this.shader);
    this.container.destroy();
  }

  private rebuild(columns: ReadonlyArray<PileupAlternateColumn>): void {
    this.ensureCapacity(columns.length);
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index]!;
      const offset = index * INSTANCE_FLOATS;
      this.instanceData[offset] = bpCoordinateChunk(column.pos);
      this.instanceData[offset + 1] = bpCoordinateDelta(column.pos);
      this.instanceData[offset + 2] = Math.max(1, column.length);
      this.instanceData[offset + 3] = Math.min(1, Math.max(0, column.weightedFraction));
    }
    this.geometry.instanceCount = columns.length;
    if (columns.length > 0) this.instanceBuffer.update();
    this.columnsRef = columns;
    this.buildCount += 1;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) return;
    let capacity = 64;
    while (capacity < required) capacity *= 2;
    this.capacity = capacity;
    this.instanceData = new Float32Array(capacity * INSTANCE_FLOATS);
    this.instanceBuffer.data = this.instanceData;
    this.bufferGrowCount += 1;
  }
}
