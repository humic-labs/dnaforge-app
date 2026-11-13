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

import type { PileupRecord } from '@waypoint/genome-data';

import {
  LINEAR_SEQUENCE_GLYPH_CONTRACT,
  LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
} from '../shared/linear-sequence-glyph';
import {
  BP_COORDINATE_CHUNK_SIZE,
  bpCoordinateChunk,
  bpCoordinateDelta,
} from '../overview/bp-coordinate-packing';
import { destroyLayerShader } from '../shared/pixi-shader-lifecycle';
import {
  buildPileupReadDifferenceMarks,
  pileupDifferenceColor,
  type PileupReadDifferenceMark,
} from './pileup-read-glyphs';
import type { TrackPaintArgs } from './types';

const CORNERS = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
const INSTANCE_FLOATS = 12;

export const PILEUP_DIFFERENCE_VERTEX_SHADER = `
precision highp float;
attribute vec2 aCorner;
attribute float aBpChunk;
attribute float aBpDelta;
attribute float aBpLength;
attribute float aTopPx;
attribute float aHeightPx;
attribute float aMinWidthPx;
attribute float aCenterAtStart;
attribute vec4 aColor;
uniform float uXScale;
uniform float uXOrigin;
uniform float uBpOriginChunk;
uniform float uBpOriginDelta;
uniform vec2 uViewportSize;
uniform float uScreenYOrigin;
uniform float uLayerAlpha;
varying vec4 vColor;
const float BP_CHUNK_SIZE = ${BP_COORDINATE_CHUNK_SIZE}.0;
void main() {
  float bpRel =
    (aBpChunk - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpDelta - uBpOriginDelta);
  float rawX1 = uXScale * bpRel + uXOrigin;
  float rawX2 = rawX1 + uXScale * aBpLength;
  float rawCenter = mix((rawX1 + rawX2) * 0.5, rawX1, aCenterAtStart);
  float widthPx = max(abs(rawX2 - rawX1), aMinWidthPx);
  float x1 = rawCenter - widthPx * 0.5;
  float x2 = rawCenter + widthPx * 0.5;
  float screenX = mix(x1, x2, aCorner.x);
  float screenY = uScreenYOrigin + aTopPx + aCorner.y * aHeightPx;
  vec2 viewport = max(uViewportSize, vec2(1.0));
  gl_Position = vec4(
    (screenX / viewport.x) * 2.0 - 1.0,
    1.0 - (screenY / viewport.y) * 2.0,
    0.0,
    1.0
  );
  vColor = aColor;
}
`;

export const PILEUP_DIFFERENCE_FRAGMENT_SHADER = `
precision highp float;
varying vec4 vColor;
uniform float uLayerAlpha;
void main() {
  float alpha = vColor.a * uLayerAlpha;
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}
`;

function pileupReadDifferenceGlProgram(): GlProgram {
  return GlProgram.from({
    name: 'pileup-instanced-read-differences',
    vertex: PILEUP_DIFFERENCE_VERTEX_SHADER,
    fragment: PILEUP_DIFFERENCE_FRAGMENT_SHADER,
  });
}

interface DifferenceUniforms {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uViewportSize: Float32Array;
  uScreenYOrigin: number;
  uLayerAlpha: number;
}

export interface PileupReadDifferenceLayerPaint {
  readonly records: ReadonlyArray<PileupRecord> | null;
  readonly rows: Int32Array | null;
  readonly rowHeightPx: number;
  readonly readRowsTopPx: number;
  readonly exactRowsVisible: boolean;
  readonly layerAlpha: number;
  readonly args: TrackPaintArgs;
}

export interface PileupReadDifferenceLayerDiagnostics {
  readonly glyphContract: typeof LINEAR_SEQUENCE_GLYPH_CONTRACT;
  readonly glyphRasterSize: typeof LINEAR_SEQUENCE_GLYPH_RASTER_SIZE;
  readonly glyphCount: 0;
  readonly markCount: number;
  readonly instanceCount: number;
  readonly bufferCapacity: number;
  readonly bufferGrowCount: number;
  readonly buildCount: number;
  readonly hitTestCandidateCount: number;
  readonly visible: boolean;
  readonly alpha: number;
  readonly screenTopPx: number;
}

function nextCapacity(required: number): number {
  let capacity = 64;
  while (capacity < required) capacity *= 2;
  return capacity;
}

export function pileupReadBodyVerticalGeometry(
  rowTopPx: number,
  rowPitchPx: number
): { topPx: number; heightPx: number } {
  const heightPx = Math.max(0, rowPitchPx - 1);
  return {
    topPx: rowTopPx + (rowPitchPx - heightPx) * 0.5,
    heightPx,
  };
}

export class PileupReadDifferenceLayer {
  private readonly container: Container;
  private readonly cornerBuffer: PixiBuffer;
  private readonly instanceBuffer: PixiBuffer;
  private readonly geometry: Geometry;
  private readonly shader: Shader;
  private readonly mesh: Mesh<Geometry, Shader>;
  private capacity = 0;
  private instanceData = new Float32Array(0);
  private residentMarks: PileupReadDifferenceMark[] = [];
  private rowMarkOffsets = new Int32Array(0);
  private recordsRef: ReadonlyArray<PileupRecord> | null = null;
  private rowsRef: Int32Array | null = null;
  private rowHeightPx = 0;
  private readRowsTopPx = 0;
  private bufferGrowCount = 0;
  private buildCount = 0;
  private lastHitTestCandidateCount = 0;
  private lastAlpha = 0;
  private lastScreenTopPx = 0;

  static gpuProgram(): GlProgram {
    return pileupReadDifferenceGlProgram();
  }

  constructor(container: Container) {
    this.container = container;
    this.cornerBuffer = new PixiBuffer({
      data: CORNERS,
      usage: BufferUsage.VERTEX,
      label: 'pileup-read-difference-corners',
      shrinkToFit: false,
    });
    this.instanceBuffer = new PixiBuffer({
      data: this.instanceData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: 'pileup-read-difference-instances',
      shrinkToFit: false,
    });
    const instance = (floatOffset: number, format: 'float32' | 'float32x4') => ({
      buffer: this.instanceBuffer,
      format,
      stride: INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      offset: floatOffset * Float32Array.BYTES_PER_ELEMENT,
      instance: true,
    });
    this.geometry = new Geometry({
      attributes: {
        aCorner: { buffer: this.cornerBuffer, format: 'float32x2' },
        aBpChunk: instance(0, 'float32'),
        aBpDelta: instance(1, 'float32'),
        aBpLength: instance(2, 'float32'),
        aTopPx: instance(3, 'float32'),
        aHeightPx: instance(4, 'float32'),
        aMinWidthPx: instance(5, 'float32'),
        aCenterAtStart: instance(6, 'float32'),
        aColor: instance(7, 'float32x4'),
      },
      topology: 'triangle-list',
      instanceCount: 0,
    });
    this.shader = new Shader({
      glProgram: pileupReadDifferenceGlProgram(),
      resources: {
        pileupDifferenceUniforms: {
          uXScale: { value: 1, type: 'f32' },
          uXOrigin: { value: 0, type: 'f32' },
          uBpOriginChunk: { value: 0, type: 'f32' },
          uBpOriginDelta: { value: 0, type: 'f32' },
          uViewportSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uScreenYOrigin: { value: 0, type: 'f32' },
          uLayerAlpha: { value: 0, type: 'f32' },
        },
      },
    });
    this.mesh = new Mesh<Geometry, Shader>({
      geometry: this.geometry,
      shader: this.shader,
      state: State.for2d(),
    });
    this.mesh.label = 'pileup-instanced-read-differences';
    this.mesh.eventMode = 'none';
    this.mesh.visible = false;
  }

  paint(input: PileupReadDifferenceLayerPaint): void {
    const { args, records, rows } = input;
    if (
      !input.exactRowsVisible ||
      !records ||
      !rows ||
      rows.length !== records.length ||
      records.length === 0 ||
      input.layerAlpha <= 0
    ) {
      this.mesh.visible = false;
      this.lastAlpha = 0;
      return;
    }

    const viewStart = args.viewportBpRange.start;
    const identityChanged =
      records !== this.recordsRef ||
      rows !== this.rowsRef ||
      input.rowHeightPx !== this.rowHeightPx ||
      input.readRowsTopPx !== this.readRowsTopPx;
    if (identityChanged) this.rebuild(input);

    const uniforms = (
      this.shader.resources.pileupDifferenceUniforms as {
        uniforms: DifferenceUniforms;
      }
    ).uniforms;
    uniforms.uXScale = args.pathMapper.pixelsPerBp;
    uniforms.uXOrigin = args.pathMapper.bpLeftX(viewStart);
    uniforms.uBpOriginChunk = bpCoordinateChunk(viewStart);
    uniforms.uBpOriginDelta = bpCoordinateDelta(viewStart);
    uniforms.uViewportSize[0] = args.viewportWidthPx;
    uniforms.uViewportSize[1] = args.viewportHeightPx;
    uniforms.uScreenYOrigin = args.containerTopPx;
    uniforms.uLayerAlpha = Math.min(1, Math.max(0, input.layerAlpha));
    this.lastAlpha = uniforms.uLayerAlpha;
    this.lastScreenTopPx = args.containerTopPx + input.readRowsTopPx;

    this.mesh.visible = this.geometry.instanceCount > 0;
    if (
      this.mesh.visible &&
      this.container.children[this.container.children.length - 1] !== this.mesh
    ) {
      this.container.addChild(this.mesh);
    }
  }

  hitTest(input: {
    readonly localX: number;
    readonly localY: number;
    readonly pathMapper: TrackPaintArgs['pathMapper'];
  }): PileupReadDifferenceMark | null {
    this.lastHitTestCandidateCount = 0;
    if (!this.mesh.visible || input.pathMapper.pixelsPerBp <= 0) return null;
    const row = Math.floor((input.localY - this.readRowsTopPx) / this.rowHeightPx);
    if (row < 0 || row + 1 >= this.rowMarkOffsets.length) return null;
    const start = this.rowMarkOffsets[row]!;
    const end = this.rowMarkOffsets[row + 1]!;
    this.lastHitTestCandidateCount = end - start;
    for (let index = end - 1; index >= start; index -= 1) {
      const mark = this.residentMarks[index]!;
      const x = input.pathMapper.bpLeftX(mark.bp);
      if (mark.event.kind === 'ins') {
        if (Math.abs(input.localX - x) <= 3) return mark;
        continue;
      }
      const width = Math.max(1, input.pathMapper.pixelsPerBp * mark.length);
      if (input.localX >= x && input.localX <= x + width) return mark;
    }
    return null;
  }

  diagnostics(): PileupReadDifferenceLayerDiagnostics {
    return {
      glyphContract: LINEAR_SEQUENCE_GLYPH_CONTRACT,
      glyphRasterSize: LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
      glyphCount: 0,
      markCount: this.residentMarks.length,
      instanceCount: this.geometry.instanceCount,
      bufferCapacity: this.capacity,
      bufferGrowCount: this.bufferGrowCount,
      buildCount: this.buildCount,
      hitTestCandidateCount: this.lastHitTestCandidateCount,
      visible: this.mesh.visible,
      alpha: this.lastAlpha,
      screenTopPx: this.lastScreenTopPx,
    };
  }

  destroy(): void {
    if (this.mesh.parent) this.mesh.parent.removeChild(this.mesh);
    this.mesh.destroy();
    this.geometry.destroy(true);
    destroyLayerShader(this.shader);
  }

  private rebuild(input: PileupReadDifferenceLayerPaint): void {
    const { records, rows } = input;
    if (!records || !rows) return;
    this.residentMarks = buildPileupReadDifferenceMarks({
      records,
      rows,
    });
    this.residentMarks.sort(
      (left, right) =>
        left.row - right.row || left.bp - right.bp || left.recordIndex - right.recordIndex
    );
    const maxRow = this.residentMarks[this.residentMarks.length - 1]?.row ?? -1;
    this.rowMarkOffsets = new Int32Array(maxRow + 2);
    let markIndex = 0;
    for (let row = 0; row <= maxRow; row += 1) {
      this.rowMarkOffsets[row] = markIndex;
      while (markIndex < this.residentMarks.length && this.residentMarks[markIndex]!.row === row) {
        markIndex += 1;
      }
    }
    if (this.rowMarkOffsets.length > 0) {
      this.rowMarkOffsets[this.rowMarkOffsets.length - 1] = this.residentMarks.length;
    }
    this.lastHitTestCandidateCount = 0;
    this.ensureCapacity(this.residentMarks.length);
    for (let index = 0; index < this.residentMarks.length; index += 1) {
      this.writeInstance(index, this.residentMarks[index]!, input);
    }
    this.geometry.instanceCount = this.residentMarks.length;
    if (this.residentMarks.length > 0) this.instanceBuffer.update();
    this.recordsRef = records;
    this.rowsRef = rows;
    this.rowHeightPx = input.rowHeightPx;
    this.readRowsTopPx = input.readRowsTopPx;
    this.buildCount += 1;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) return;
    this.capacity = nextCapacity(required);
    this.instanceData = new Float32Array(this.capacity * INSTANCE_FLOATS);
    this.instanceBuffer.data = this.instanceData;
    this.bufferGrowCount += 1;
  }

  private writeInstance(
    instanceIndex: number,
    mark: PileupReadDifferenceMark,
    input: PileupReadDifferenceLayerPaint
  ): void {
    const offset = instanceIndex * INSTANCE_FLOATS;
    const rowTop = input.readRowsTopPx + mark.row * input.rowHeightPx;
    const readBody = pileupReadBodyVerticalGeometry(rowTop, input.rowHeightPx);
    const alpha = 1;
    const color = pileupDifferenceColor(input.args.theme.mode);
    let bpLength = mark.length;
    let topPx = readBody.topPx;
    let heightPx = readBody.heightPx;
    let minWidthPx = 0;
    let centerAtStart = 0;

    if (mark.event.kind === 'ins') {
      bpLength = 0;
      minWidthPx = 2;
      centerAtStart = 1;
    } else if (mark.event.kind === 'del') {
      topPx = rowTop + Math.max(0, (input.rowHeightPx - 1) * 0.5);
      heightPx = 1;
      minWidthPx = 1;
    } else {
      bpLength = 1;
      minWidthPx = 1;
    }

    this.instanceData[offset] = bpCoordinateChunk(mark.bp);
    this.instanceData[offset + 1] = bpCoordinateDelta(mark.bp);
    this.instanceData[offset + 2] = bpLength;
    this.instanceData[offset + 3] = topPx;
    this.instanceData[offset + 4] = heightPx;
    this.instanceData[offset + 5] = minWidthPx;
    this.instanceData[offset + 6] = centerAtStart;
    this.instanceData[offset + 7] = color[0];
    this.instanceData[offset + 8] = color[1];
    this.instanceData[offset + 9] = color[2];
    this.instanceData[offset + 10] = alpha;
    this.instanceData[offset + 11] = 0;
  }
}
