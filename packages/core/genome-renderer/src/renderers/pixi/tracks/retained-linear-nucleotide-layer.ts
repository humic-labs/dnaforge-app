import {
  Buffer as PixiBuffer,
  BufferUsage,
  Container,
  DynamicBitmapFont,
  Geometry,
  GlProgram,
  Mesh,
  type Renderer,
  RendererType,
  Shader,
  State,
  TextStyle,
  type TextureSource,
} from 'pixi.js';

import { IUPAC_COMPLEMENT, complementTable, type NucleicAcid } from '@waypoint/sequence-utils';
import { SEQUENCE_EDIT_MARKUP } from '@waypoint/sequence-utils/sequence-edit-markup';

import type { LinearSequencePresentation, SequenceWindow } from '../../../types';
import {
  BP_COORDINATE_CHUNK_SIZE,
  bpCoordinateChunk,
  bpCoordinateDelta,
} from '../overview/bp-coordinate-packing';
import {
  prepareSharedPixiGpuPrograms,
  type PixiGpuProgramPreparationRenderer,
} from '../shared/pixi-gpu-program-preparation';
import { destroyLayerShader } from '../shared/pixi-shader-lifecycle';
import {
  LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL,
  LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
  type LinearSequenceGlyphVerticalMetrics,
} from '../shared/linear-sequence-glyph';
import { SEQUENCE_FONT_FAMILY, type WebGLRenderTheme } from '../shared/theme';

const CORNERS = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
const INSTANCE_FLOATS = 15;
const MAX_BASES = 3_000;
const MAX_INSTANCES = MAX_BASES * 2;
const GLYPH_PADDING_PX = 4;
const DRAWABLE_SEQUENCE_CHARACTERS = [
  ...new Set(
    Object.keys(IUPAC_COMPLEMENT)
      .filter((character) => character.trim().length > 0)
      .map((character) => character.toLowerCase())
  ),
].sort();

export const RETAINED_LINEAR_NUCLEOTIDE_OWNER = 'retained-linear-nucleotide-instances-v1' as const;
export const RETAINED_LINEAR_NUCLEOTIDE_GPU_OWNERSHIP_CONTRACT =
  'retained-linear-nucleotide-gpu-ownership.v1' as const;

const VERTEX_SHADER = `
precision highp float;
attribute vec2 aCorner;
attribute float aBpChunk;
attribute float aBpDelta;
attribute float aStrand;
attribute vec4 aLocalRect;
attribute vec4 aUvRect;
attribute vec4 aMarkup;
uniform float uXScale;
uniform float uXOrigin;
uniform float uBpOriginChunk;
uniform float uBpOriginDelta;
uniform float uForwardY;
uniform float uReverseY;
uniform float uDisplayScale;
uniform vec2 uViewportSize;
varying vec2 vUv;
varying float vStrand;
varying vec4 vMarkup;
const float BP_CHUNK_SIZE = ${BP_COORDINATE_CHUNK_SIZE}.0;
void main() {
  float bpRel =
    (aBpChunk - uBpOriginChunk) * BP_CHUNK_SIZE +
    (aBpDelta - uBpOriginDelta);
  float centerX = uXOrigin + bpRel * uXScale + uXScale * 0.5;
  float centerY = mix(uForwardY, uReverseY, aStrand);
  vec2 local = vec2(
    mix(aLocalRect.x, aLocalRect.z, aCorner.x),
    mix(aLocalRect.y, aLocalRect.w, aCorner.y)
  ) * uDisplayScale;
  vec2 screen = vec2(centerX, centerY) + local;
  vec2 viewport = max(uViewportSize, vec2(1.0));
  gl_Position = vec4(
    (screen.x / viewport.x) * 2.0 - 1.0,
    1.0 - (screen.y / viewport.y) * 2.0,
    0.0,
    1.0
  );
  vUv = vec2(
    mix(aUvRect.x, aUvRect.z, aCorner.x),
    mix(aUvRect.y, aUvRect.w, aCorner.y)
  );
  vStrand = aStrand;
  vMarkup = aMarkup;
}
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D uGlyphAtlas;
uniform vec3 uForwardColor;
uniform vec3 uReverseColor;
uniform float uLayerAlpha;
varying vec2 vUv;
varying float vStrand;
varying vec4 vMarkup;
void main() {
  float coverage = texture2D(uGlyphAtlas, vUv).a;
  if (coverage <= 0.0) discard;
  bool marked = vMarkup.a > 0.0;
  vec3 color = marked ? vMarkup.rgb : mix(uForwardColor, uReverseColor, vStrand);
  float alpha = coverage * uLayerAlpha * (marked ? vMarkup.a : 1.0);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

function nucleotideGlProgram(): GlProgram {
  return GlProgram.from({
    name: RETAINED_LINEAR_NUCLEOTIDE_OWNER,
    vertex: VERTEX_SHADER,
    fragment: FRAGMENT_SHADER,
  });
}

interface GlyphAtlasEntry {
  readonly localLeft: number;
  readonly localTop: number;
  readonly localRight: number;
  readonly localBottom: number;
  readonly uvLeft: number;
  readonly uvTop: number;
  readonly uvRight: number;
  readonly uvBottom: number;
}

export interface LinearNucleotideGlyphAtlas {
  readonly source: TextureSource;
  readonly fontFamily: typeof SEQUENCE_FONT_FAMILY;
  readonly glyphs: ReadonlyMap<string, GlyphAtlasEntry>;
  readonly glyphCoordinateScale: number;
  readonly glyphGeometryFontSizePx: number;
  readonly atlasMeasurementFontSizePx: number;
  verticalMetrics(): LinearSequenceGlyphVerticalMetrics;
  dispose(): void;
}

interface NucleotideUniforms {
  uXScale: number;
  uXOrigin: number;
  uBpOriginChunk: number;
  uBpOriginDelta: number;
  uForwardY: number;
  uReverseY: number;
  uDisplayScale: number;
  uViewportSize: Float32Array;
  uForwardColor: Float32Array;
  uReverseColor: Float32Array;
  uLayerAlpha: number;
}

interface GpuOwner {
  readonly instanceData: Float32Array;
  readonly cornerBuffer: PixiBuffer;
  readonly instanceBuffer: PixiBuffer;
  readonly geometry: Geometry;
  readonly shader: Shader;
  readonly mesh: Mesh<Geometry, Shader>;
  readonly viewportUniform: Float32Array;
  readonly forwardColorUniform: Float32Array;
  readonly reverseColorUniform: Float32Array;
  sequence: string | undefined;
  sequenceWindow: SequenceWindow | undefined;
  alignedQuery: string | undefined;
  nucleotideChanges: LinearSequencePresentation['nucleotideChanges'];
  showSecondaryRow: boolean;
  startBp: number;
  endBp: number;
  forwardBases: string;
  reverseBases: string;
  displayFontSizePx: number;
}

interface BufferUploadRenderer {
  readonly buffer: { updateBuffer(buffer: PixiBuffer): unknown };
}

function releaseOwnerContent(owner: GpuOwner): void {
  owner.mesh.visible = false;
  owner.geometry.instanceCount = 0;
  owner.sequence = undefined;
  owner.sequenceWindow = undefined;
  owner.alignedQuery = undefined;
  owner.nucleotideChanges = undefined;
  owner.showSecondaryRow = true;
  owner.startBp = 0;
  owner.endBp = 0;
  owner.forwardBases = '';
  owner.reverseBases = '';
  owner.displayFontSizePx = 0;
}

export interface RetainedLinearNucleotidePaint {
  readonly viewStartBp: number;
  readonly pixelsPerBp: number;
  readonly forwardY: number;
  readonly reverseY: number;
  readonly displayFontSize: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly alpha: number;
}

export interface RetainedLinearNucleotideDiagnostics {
  readonly renderOwner: typeof RETAINED_LINEAR_NUCLEOTIDE_OWNER | null;
  readonly meshCount: number;
  readonly instanceCount: number;
  readonly retainedBaseCount: number;
  readonly startBp: number | null;
  readonly endBp: number | null;
  readonly contentBuildCount: number;
  readonly cameraUniformUpdateCount: number;
  readonly bufferCapacity: typeof MAX_INSTANCES;
  readonly fontFamily: typeof SEQUENCE_FONT_FAMILY;
  readonly visible: boolean;
}

export interface RetainedLinearNucleotideGpuOwnershipAudit {
  readonly contract: typeof RETAINED_LINEAR_NUCLEOTIDE_GPU_OWNERSHIP_CONTRACT;
  readonly owner: 'nucleotide';
  readonly supported: boolean;
  readonly renderOwner: typeof RETAINED_LINEAR_NUCLEOTIDE_OWNER | null;
  readonly requiredGlyphCount: number;
  readonly meshCount: number;
  readonly instanceCount: number;
  readonly retainedBaseCount: number;
  readonly bufferCapacity: typeof MAX_INSTANCES;
  readonly expectedBufferByteLength: number;
  readonly gpuBufferByteLength: number | null;
  readonly bufferResident: boolean;
  readonly bufferSynchronized: boolean;
  readonly textureResident: boolean;
  readonly textureResourceLive: boolean;
  readonly textureAutoGarbageCollect: boolean;
  readonly shaderProgramOwned: boolean;
  readonly atlasBound: boolean;
  readonly meshAttached: boolean;
  readonly meshVisible: boolean;
  readonly projectionViewportWidthPx: number;
  readonly projectionViewportHeightPx: number;
  readonly rendererViewportWidthPx: number;
  readonly rendererViewportHeightPx: number;
  readonly glyphGeometryFontSizePx: number;
  readonly displayScale: number;
  readonly displayFontSizePx: number;
}

function sameSequenceWindow(
  left: SequenceWindow | undefined,
  right: SequenceWindow | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.startBp === right.startBp &&
      left.bases === right.bases)
  );
}

function colorInto(target: Float32Array, color: number): void {
  target[0] = ((color >> 16) & 0xff) / 255;
  target[1] = ((color >> 8) & 0xff) / 255;
  target[2] = (color & 0xff) / 255;
}

function createGlyphAtlas(renderer: Renderer): LinearNucleotideGlyphAtlas {
  const font = new DynamicBitmapFont({
    style: new TextStyle({
      fontFamily: SEQUENCE_FONT_FAMILY,
      fontSize: LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
      lineHeight: LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
      fill: LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL,
    }),
    resolution: Math.max(1, renderer.resolution),
    padding: GLYPH_PADDING_PX,
    skipKerning: true,
    overrideFill: true,
    overrideSize: false,
    textureSize: 256,
    textureStyle: { scaleMode: 'linear' },
  });
  try {
    const characters = DRAWABLE_SEQUENCE_CHARACTERS.join('');
    font.ensureCharacters(characters);
    const page = font.pages[0];
    if (font.pages.length !== 1 || !page) {
      throw new Error('Retained nucleotide atlas exceeded its single-page contract');
    }
    const source = page.texture.source;
    const raster = page.canvasAndContext;
    if (!raster) throw new Error('Retained nucleotide atlas has no raster canvas');
    source.autoGarbageCollect = false;
    const glyphs = new Map<string, GlyphAtlasEntry>();
    const glyphCoordinateScale =
      LINEAR_SEQUENCE_GLYPH_RASTER_SIZE / Math.max(1, font.baseMeasurementFontSize);
    const measurementLineHeight = font.lineHeight / Math.max(glyphCoordinateScale, 0.0001);
    let linePositionYShift = Math.max(0, (measurementLineHeight - font.fontMetrics.fontSize) / 2);
    if (linePositionYShift - font.baseLineOffset < 0) linePositionYShift = 0;
    for (const character of characters) {
      const charData = font.chars[character];
      const texture = charData?.texture;
      if (!charData || !texture || texture.source !== source) {
        throw new Error(`Retained nucleotide atlas is missing ${character}`);
      }
      const anchorWidth = charData.xAdvance;
      const anchorHeight = measurementLineHeight + font.baseLineOffset;
      const localLeft = -anchorWidth * 0.5 + Math.round(charData.xOffset);
      const localTop =
        -anchorHeight * 0.5 +
        Math.round(font.baseLineOffset + charData.yOffset + linePositionYShift);
      glyphs.set(character, {
        localLeft,
        localTop,
        localRight: localLeft + texture.orig.width,
        localBottom: localTop + texture.orig.height,
        uvLeft: texture.uvs.x0,
        uvTop: texture.uvs.y0,
        uvRight: texture.uvs.x2,
        uvBottom: texture.uvs.y2,
      });
    }
    let verticalMetrics: LinearSequenceGlyphVerticalMetrics | undefined;
    return {
      source,
      fontFamily: SEQUENCE_FONT_FAMILY,
      glyphs,
      glyphCoordinateScale,
      glyphGeometryFontSizePx: LINEAR_SEQUENCE_GLYPH_RASTER_SIZE,
      atlasMeasurementFontSizePx: font.baseMeasurementFontSize,
      verticalMetrics: () => {
        if (verticalMetrics) return verticalMetrics;
        const canvas = raster.canvas;
        const pixels = raster.context.getImageData(0, 0, canvas.width, canvas.height).data;
        const inkBounds = (glyph: GlyphAtlasEntry) => {
          const yOrigin = glyph.uvTop * canvas.height;
          const yScale =
            (glyph.localBottom - glyph.localTop) / ((glyph.uvBottom - glyph.uvTop) * canvas.height);
          let top = Infinity;
          let bottom = -Infinity;
          for (let y = Math.floor(yOrigin); y < Math.ceil(glyph.uvBottom * canvas.height); y++) {
            for (
              let x = Math.floor(glyph.uvLeft * canvas.width);
              x < Math.ceil(glyph.uvRight * canvas.width);
              x++
            ) {
              if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
              top = Math.min(top, y);
              bottom = Math.max(bottom, y + 1);
            }
          }
          if (!Number.isFinite(top) || !Number.isFinite(bottom))
            throw new Error('Nucleotide atlas has no visible glyph ink');
          return {
            top: (glyph.localTop + (top - yOrigin) * yScale) * glyphCoordinateScale,
            bottom: (glyph.localTop + (bottom - yOrigin) * yScale) * glyphCoordinateScale,
          };
        };
        const letters = [...glyphs]
          .filter(([character]) => /^[a-z]$/.test(character))
          .map(([, glyph]) => inkBounds(glyph));
        const body = inkBounds(glyphs.get('a')!);
        verticalMetrics = {
          top: Math.min(...letters.map((letter) => letter.top)),
          bottom: Math.max(...letters.map((letter) => letter.bottom)),
          strikeY: (body.top + body.bottom) / 2,
        };
        return verticalMetrics;
      },
      dispose: () => font.destroy(),
    };
  } catch (error) {
    font.destroy();
    throw error;
  }
}

function createOwner(atlas: LinearNucleotideGlyphAtlas): GpuOwner {
  const instanceData = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
  let cornerBuffer: PixiBuffer | null = null;
  let instanceBuffer: PixiBuffer | null = null;
  let geometry: Geometry | null = null;
  let shader: Shader | null = null;
  let mesh: Mesh<Geometry, Shader> | null = null;
  try {
    cornerBuffer = new PixiBuffer({
      data: CORNERS,
      usage: BufferUsage.VERTEX,
      label: 'retained-linear-nucleotide-corners',
      shrinkToFit: false,
    });
    const allocatedInstanceBuffer = new PixiBuffer({
      data: instanceData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: 'retained-linear-nucleotide-instances',
      shrinkToFit: false,
    });
    instanceBuffer = allocatedInstanceBuffer;
    const instance = (floatOffset: number, format: 'float32' | 'float32x4') => ({
      buffer: allocatedInstanceBuffer,
      format,
      stride: INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      offset: floatOffset * Float32Array.BYTES_PER_ELEMENT,
      instance: true,
    });
    geometry = new Geometry({
      attributes: {
        aCorner: { buffer: cornerBuffer, format: 'float32x2' },
        aBpChunk: instance(0, 'float32'),
        aBpDelta: instance(1, 'float32'),
        aStrand: instance(2, 'float32'),
        aLocalRect: instance(3, 'float32x4'),
        aUvRect: instance(7, 'float32x4'),
        aMarkup: instance(11, 'float32x4'),
      },
      topology: 'triangle-list',
      instanceCount: 0,
    });
    const viewportUniform = new Float32Array([1, 1]);
    const forwardColorUniform = new Float32Array([0, 0, 0]);
    const reverseColorUniform = new Float32Array([0, 0, 0]);
    shader = new Shader({
      glProgram: nucleotideGlProgram(),
      resources: {
        uGlyphAtlas: atlas.source,
        nucleotideUniforms: {
          uXScale: { value: 1, type: 'f32' },
          uXOrigin: { value: 0, type: 'f32' },
          uBpOriginChunk: { value: 0, type: 'f32' },
          uBpOriginDelta: { value: 0, type: 'f32' },
          uForwardY: { value: 0, type: 'f32' },
          uReverseY: { value: 0, type: 'f32' },
          uDisplayScale: { value: 1, type: 'f32' },
          uViewportSize: { value: viewportUniform, type: 'vec2<f32>' },
          uForwardColor: { value: forwardColorUniform, type: 'vec3<f32>' },
          uReverseColor: { value: reverseColorUniform, type: 'vec3<f32>' },
          uLayerAlpha: { value: 0, type: 'f32' },
        },
      },
    });
    mesh = new Mesh<Geometry, Shader>({ geometry, shader, state: State.for2d() });
    mesh.label = RETAINED_LINEAR_NUCLEOTIDE_OWNER;
    mesh.eventMode = 'none';
    mesh.visible = false;
    return {
      instanceData,
      cornerBuffer,
      instanceBuffer,
      geometry,
      shader,
      mesh,
      viewportUniform,
      forwardColorUniform,
      reverseColorUniform,
      sequence: undefined,
      sequenceWindow: undefined,
      alignedQuery: undefined,
      nucleotideChanges: undefined,
      showSecondaryRow: true,
      startBp: 0,
      endBp: 0,
      forwardBases: '',
      reverseBases: '',
      displayFontSizePx: 0,
    };
  } catch (error) {
    mesh?.destroy({ texture: false, textureSource: false });
    if (geometry) geometry.destroy(true);
    else {
      cornerBuffer?.destroy();
      instanceBuffer?.destroy();
    }
    if (shader) destroyLayerShader(shader);
    throw error;
  }
}

function destroyGpuOwner(owner: GpuOwner): void {
  releaseOwnerContent(owner);
  if (owner.mesh.parent) owner.mesh.parent.removeChild(owner.mesh);
  owner.mesh.destroy({ texture: false, textureSource: false });
  owner.geometry.destroy(true);
  destroyLayerShader(owner.shader);
}

function sourceBaseAt(
  sequence: string | undefined,
  sequenceWindow: SequenceWindow | undefined,
  bp: number
): string | undefined {
  if (sequenceWindow) {
    const index = bp - sequenceWindow.startBp;
    return index >= 0 && index < sequenceWindow.bases.length
      ? sequenceWindow.bases[index]
      : undefined;
  }
  return sequence && bp >= 0 && bp < sequence.length ? sequence[bp] : undefined;
}

function atlasCharacter(sourceBase: string | undefined, atlas: LinearNucleotideGlyphAtlas): string {
  const candidate = sourceBase?.slice(0, 1).toLowerCase() ?? 'n';
  return atlas.glyphs.has(candidate) ? candidate : 'n';
}

function writeInstance(
  target: Float32Array,
  instanceIndex: number,
  bp: number,
  strand: 0 | 1,
  glyph: GlyphAtlasEntry,
  glyphCoordinateScale: number,
  markup?: { readonly color: number; readonly alpha: number }
): void {
  const offset = instanceIndex * INSTANCE_FLOATS;
  target[offset] = bpCoordinateChunk(bp);
  target[offset + 1] = bpCoordinateDelta(bp);
  target[offset + 2] = strand;
  target[offset + 3] = glyph.localLeft * glyphCoordinateScale;
  target[offset + 4] = glyph.localTop * glyphCoordinateScale;
  target[offset + 5] = glyph.localRight * glyphCoordinateScale;
  target[offset + 6] = glyph.localBottom * glyphCoordinateScale;
  target[offset + 7] = glyph.uvLeft;
  target[offset + 8] = glyph.uvTop;
  target[offset + 9] = glyph.uvRight;
  target[offset + 10] = glyph.uvBottom;
  target[offset + 11] = markup ? ((markup.color >> 16) & 255) / 255 : 0;
  target[offset + 12] = markup ? ((markup.color >> 8) & 255) / 255 : 0;
  target[offset + 13] = markup ? (markup.color & 255) / 255 : 0;
  target[offset + 14] = markup?.alpha ?? 0;
}

function glyphInstanceSignature(glyph: GlyphAtlasEntry, glyphCoordinateScale: number): string {
  return [
    glyph.localLeft * glyphCoordinateScale,
    glyph.localTop * glyphCoordinateScale,
    glyph.localRight * glyphCoordinateScale,
    glyph.localBottom * glyphCoordinateScale,
    glyph.uvLeft,
    glyph.uvTop,
    glyph.uvRight,
    glyph.uvBottom,
  ]
    .map(Math.fround)
    .join(',');
}

function instanceGlyphSignature(data: Float32Array, offset: number): string {
  return Array.from(data.subarray(offset + 3, offset + 11)).join(',');
}

function indexAtlasGlyphSignatures(atlas: LinearNucleotideGlyphAtlas): ReadonlyMap<string, string> {
  const glyphBySignature = new Map<string, string>();
  for (const [character, glyph] of atlas.glyphs) {
    const signature = glyphInstanceSignature(glyph, atlas.glyphCoordinateScale);
    if (glyphBySignature.has(signature)) {
      throw new Error('Retained nucleotide atlas contains an ambiguous glyph record');
    }
    glyphBySignature.set(signature, character);
  }
  return glyphBySignature;
}

function allocateLayerResources(atlas: LinearNucleotideGlyphAtlas): {
  readonly glyphByInstanceSignature: ReadonlyMap<string, string>;
  readonly owners: readonly [GpuOwner, GpuOwner];
} {
  const allocatedOwners: GpuOwner[] = [];
  try {
    const glyphByInstanceSignature = indexAtlasGlyphSignatures(atlas);
    const firstOwner = createOwner(atlas);
    allocatedOwners.push(firstOwner);
    const secondOwner = createOwner(atlas);
    allocatedOwners.push(secondOwner);
    return {
      glyphByInstanceSignature,
      owners: [firstOwner, secondOwner],
    };
  } catch (error) {
    for (const owner of allocatedOwners) destroyGpuOwner(owner);
    atlas.dispose();
    throw error;
  }
}

export class RetainedLinearNucleotideLayer {
  readonly container = new Container();

  private readonly atlas: LinearNucleotideGlyphAtlas;
  private readonly glyphByInstanceSignature: ReadonlyMap<string, string>;
  private readonly owners: readonly [GpuOwner, GpuOwner];
  private activeOwnerIndex: 0 | 1 = 0;
  private complement: Readonly<Record<string, string>> = complementTable('dna');
  private preparedOwnerIndex: 0 | 1 = 1;
  private prepared = false;
  private contentBuildCount = 0;
  private cameraUniformUpdateCount = 0;
  private theme: WebGLRenderTheme;
  private destroyed = false;

  static isSupported(renderer: Renderer | undefined): boolean {
    if (!renderer) return false;
    const candidate = renderer as Renderer & Partial<BufferUploadRenderer>;
    return (
      renderer.type === RendererType.WEBGL &&
      typeof candidate.buffer?.updateBuffer === 'function' &&
      typeof renderer.texture?.initSource === 'function'
    );
  }

  static prepareProgram(renderer: Renderer | undefined): void {
    if (!RetainedLinearNucleotideLayer.isSupported(renderer)) return;
    prepareSharedPixiGpuPrograms(renderer as Renderer & PixiGpuProgramPreparationRenderer, [
      nucleotideGlProgram(),
    ]);
  }

  constructor(
    private readonly renderer: Renderer,
    theme: WebGLRenderTheme,
    atlas: LinearNucleotideGlyphAtlas = createGlyphAtlas(renderer)
  ) {
    if (!RetainedLinearNucleotideLayer.isSupported(renderer)) {
      atlas.dispose();
      this.container.destroy();
      throw new Error('Retained linear nucleotide rendering requires WebGL buffer ownership');
    }
    const resources = allocateLayerResources(atlas);
    this.theme = theme;
    this.atlas = atlas;
    this.glyphByInstanceSignature = resources.glyphByInstanceSignature;
    this.owners = resources.owners;
    try {
      this.container.eventMode = 'none';
      this.container.addChild(this.owners[0].mesh, this.owners[1].mesh);
      RetainedLinearNucleotideLayer.prepareProgram(renderer);
      renderer.texture.initSource(atlas.source);
      this.applyTheme(theme);
    } catch (error) {
      for (const owner of this.owners) destroyGpuOwner(owner);
      this.container.destroy();
      this.atlas.dispose();
      throw error;
    }
  }

  prepare(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    startBp: number,
    endBp: number,
    presentation?: LinearSequencePresentation
  ): boolean {
    this.assertAlive();
    const sourceStart = sequenceWindow?.startBp ?? 0;
    const sourceEnd = sequenceWindow
      ? sequenceWindow.startBp + sequenceWindow.bases.length
      : (sequence?.length ?? sourceStart);
    if (presentation?.alignedQuery !== undefined && presentation.alignedQuery.length < sourceEnd) {
      throw new Error('The aligned sequence row must cover every presented sequence column.');
    }
    const boundedStart = Math.max(sourceStart, Math.max(0, Math.floor(startBp)));
    const boundedEnd = Math.max(
      boundedStart,
      Math.min(sourceEnd, Math.max(boundedStart, Math.ceil(endBp)))
    );
    if (boundedEnd - boundedStart > MAX_BASES) {
      throw new Error('Retained nucleotide content exceeds its fixed base capacity');
    }
    if (
      this.ownerCovers(
        this.owners[this.activeOwnerIndex],
        sequence,
        sequenceWindow,
        {
          startBp: boundedStart,
          endBp: boundedEnd,
        },
        presentation
      )
    ) {
      return false;
    }
    const preparedOwner = this.owners[this.preparedOwnerIndex];
    if (
      this.prepared &&
      this.ownerCovers(
        preparedOwner,
        sequence,
        sequenceWindow,
        {
          startBp: boundedStart,
          endBp: boundedEnd,
        },
        presentation
      )
    ) {
      return false;
    }
    releaseOwnerContent(preparedOwner);
    this.prepared = false;

    try {
      let instanceCount = 0;
      const forwardBases: string[] = [];
      const reverseBases: string[] = [];
      const showSecondaryRow =
        presentation?.alignedQuery !== undefined || presentation?.showReverseComplement !== false;
      for (let bp = boundedStart; bp < boundedEnd; bp += 1) {
        const sourceBase = sourceBaseAt(sequence, sequenceWindow, bp);
        if (sourceBase === undefined) continue;
        const forward = atlasCharacter(sourceBase, this.atlas);
        const reverse = atlasCharacter(
          presentation?.alignedQuery?.[bp] ?? this.complement[sourceBase] ?? 'n',
          this.atlas
        );

        const forwardGlyph = this.atlas.glyphs.get(forward);
        const reverseGlyph = this.atlas.glyphs.get(reverse);
        if (!forwardGlyph || !reverseGlyph) {
          throw new Error('Retained nucleotide atlas lost its canonical fallback glyph');
        }
        const change = presentation?.nucleotideChanges?.find(
          (range) => bp >= range.start && bp < range.end
        );
        const markup = change
          ? (change.style ?? SEQUENCE_EDIT_MARKUP[change.kind]).text
          : undefined;
        writeInstance(
          preparedOwner.instanceData,
          instanceCount++,
          bp,
          0,
          forwardGlyph,
          this.atlas.glyphCoordinateScale,
          markup
        );
        if (showSecondaryRow) {
          writeInstance(
            preparedOwner.instanceData,
            instanceCount++,
            bp,
            1,
            reverseGlyph,
            this.atlas.glyphCoordinateScale,
            markup
          );
        }
        forwardBases.push(forward);
        if (showSecondaryRow) reverseBases.push(reverse);
      }
      preparedOwner.geometry.instanceCount = instanceCount;
      preparedOwner.instanceBuffer.update();
      (this.renderer as Renderer & BufferUploadRenderer).buffer.updateBuffer(
        preparedOwner.instanceBuffer
      );
      preparedOwner.sequence = sequence;
      preparedOwner.sequenceWindow = sequenceWindow;
      preparedOwner.alignedQuery = presentation?.alignedQuery;
      preparedOwner.nucleotideChanges = presentation?.nucleotideChanges;
      preparedOwner.showSecondaryRow = showSecondaryRow;
      preparedOwner.startBp = boundedStart;
      preparedOwner.endBp = boundedEnd;
      preparedOwner.forwardBases = forwardBases.join('');
      preparedOwner.reverseBases = reverseBases.join('');
      this.prepared = true;
      this.contentBuildCount += 1;
      return true;
    } catch (error) {
      releaseOwnerContent(preparedOwner);
      throw error;
    }
  }

  presentPrepared(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    requestedRange: { readonly startBp: number; readonly endBp: number },
    presentation?: LinearSequencePresentation
  ): boolean {
    this.assertAlive();
    const active = this.owners[this.activeOwnerIndex];
    if (this.ownerCovers(active, sequence, sequenceWindow, requestedRange, presentation))
      return true;
    const preparedOwner = this.owners[this.preparedOwnerIndex];
    if (
      !this.prepared ||
      !this.ownerCovers(preparedOwner, sequence, sequenceWindow, requestedRange, presentation)
    ) {
      return false;
    }
    active.mesh.visible = false;
    const previousActive = this.activeOwnerIndex;
    this.activeOwnerIndex = this.preparedOwnerIndex;
    this.preparedOwnerIndex = previousActive;
    releaseOwnerContent(this.owners[this.preparedOwnerIndex]);
    this.prepared = false;
    return true;
  }

  paint(input: RetainedLinearNucleotidePaint): void {
    this.assertAlive();
    const owner = this.owners[this.activeOwnerIndex];
    const uniforms = (owner.shader.resources.nucleotideUniforms as { uniforms: NucleotideUniforms })
      .uniforms;
    uniforms.uXScale = input.pixelsPerBp;
    uniforms.uXOrigin = 0;
    uniforms.uBpOriginChunk = bpCoordinateChunk(input.viewStartBp);
    uniforms.uBpOriginDelta = bpCoordinateDelta(input.viewStartBp);
    uniforms.uForwardY = input.forwardY;
    uniforms.uReverseY = input.reverseY;
    uniforms.uDisplayScale = input.displayFontSize / Math.max(1, LINEAR_SEQUENCE_GLYPH_RASTER_SIZE);
    owner.displayFontSizePx = input.displayFontSize;
    owner.viewportUniform[0] = Math.max(1, this.renderer.screen.width);
    owner.viewportUniform[1] = Math.max(1, this.renderer.screen.height);
    uniforms.uLayerAlpha = Math.max(0, Math.min(1, input.alpha));
    owner.mesh.visible = owner.geometry.instanceCount > 0 && uniforms.uLayerAlpha > 0;
    this.cameraUniformUpdateCount += 1;
  }

  setNucleicAcid(acid: NucleicAcid): void {
    this.complement = complementTable(acid);
    this.clear();
  }

  setTheme(theme: WebGLRenderTheme): void {
    this.assertAlive();
    this.theme = theme;
    this.applyTheme(theme);
  }

  hide(): void {
    if (this.destroyed) return;
    this.owners[this.activeOwnerIndex].mesh.visible = false;
  }

  clear(): void {
    if (this.destroyed) return;
    for (const owner of this.owners) {
      releaseOwnerContent(owner);
    }
    this.prepared = false;
  }

  covers(
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    requestedRange: { readonly startBp: number; readonly endBp: number },
    presentation?: LinearSequencePresentation
  ): boolean {
    return this.ownerCovers(
      this.owners[this.activeOwnerIndex],
      sequence,
      sequenceWindow,
      requestedRange,
      presentation
    );
  }

  baseAt(bp: number, strand: 'forward' | 'reverse'): string | undefined {
    const owner = this.owners[this.activeOwnerIndex];
    const baseIndex = bp - owner.startBp;
    if (
      !Number.isSafeInteger(baseIndex) ||
      baseIndex < 0 ||
      baseIndex >= owner.forwardBases.length
    ) {
      return undefined;
    }
    const strandValue = strand === 'forward' ? 0 : 1;
    if (strandValue === 1 && !owner.showSecondaryRow) return undefined;
    const instanceIndex = baseIndex * (owner.showSecondaryRow ? 2 : 1) + strandValue;
    if (instanceIndex >= owner.geometry.instanceCount) return undefined;
    const offset = instanceIndex * INSTANCE_FLOATS;
    if (
      owner.instanceData[offset] !== Math.fround(bpCoordinateChunk(bp)) ||
      owner.instanceData[offset + 1] !== Math.fround(bpCoordinateDelta(bp)) ||
      owner.instanceData[offset + 2] !== strandValue
    ) {
      return undefined;
    }
    return this.glyphByInstanceSignature.get(instanceGlyphSignature(owner.instanceData, offset));
  }

  sample(strand: 'forward' | 'reverse', limit = 24): Array<{ bp: number; text: string }> {
    const owner = this.owners[this.activeOwnerIndex];
    const result: Array<{ bp: number; text: string }> = [];
    const count = Math.min(owner.forwardBases.length, Math.max(0, limit));
    for (let index = 0; index < count; index += 1) {
      const bp = owner.startBp + index;
      const text = this.baseAt(bp, strand);
      if (text !== undefined) result.push({ bp, text });
    }
    return result;
  }

  glyphVerticalMetrics(): LinearSequenceGlyphVerticalMetrics {
    return this.atlas.verticalMetrics();
  }

  diagnostics(): RetainedLinearNucleotideDiagnostics {
    const owner = this.owners[this.activeOwnerIndex];
    const visible = owner.mesh.visible && owner.mesh.parent === this.container;
    return {
      renderOwner: visible ? RETAINED_LINEAR_NUCLEOTIDE_OWNER : null,
      meshCount: visible ? 1 : 0,
      instanceCount: owner.geometry.instanceCount,
      retainedBaseCount: owner.forwardBases.length,
      startBp: owner.forwardBases.length > 0 ? owner.startBp : null,
      endBp: owner.forwardBases.length > 0 ? owner.endBp : null,
      contentBuildCount: this.contentBuildCount,
      cameraUniformUpdateCount: this.cameraUniformUpdateCount,
      bufferCapacity: MAX_INSTANCES,
      fontFamily: this.atlas.fontFamily,
      visible,
    };
  }

  gpuOwnershipAudit(
    requiredGlyphCount = this.owners[this.activeOwnerIndex].geometry.instanceCount
  ): RetainedLinearNucleotideGpuOwnershipAudit {
    const owner = this.owners[this.activeOwnerIndex];
    const uniforms = (owner.shader.resources.nucleotideUniforms as { uniforms: NucleotideUniforms })
      .uniforms;
    const rendererUid = this.renderer.uid;
    const gpuBuffer = owner.instanceBuffer._gpuData[rendererUid];
    const gpuTexture = this.atlas.source._gpuData[rendererUid];
    const bufferResident =
      gpuBuffer !== undefined && 'buffer' in gpuBuffer && gpuBuffer.buffer !== null;
    const gpuBufferByteLength =
      gpuBuffer !== undefined && 'byteLength' in gpuBuffer ? gpuBuffer.byteLength : null;
    const bufferSynchronized =
      gpuBuffer !== undefined &&
      'updateID' in gpuBuffer &&
      gpuBuffer.updateID === owner.instanceBuffer._updateID;
    const textureResident =
      gpuTexture !== undefined && 'texture' in gpuTexture && gpuTexture.texture !== null;
    const meshAttached = owner.mesh.parent === this.container;
    const meshVisible = owner.mesh.visible === true;
    const rendererViewportWidthPx = Math.max(1, this.renderer.screen.width);
    const rendererViewportHeightPx = Math.max(1, this.renderer.screen.height);

    return {
      contract: RETAINED_LINEAR_NUCLEOTIDE_GPU_OWNERSHIP_CONTRACT,
      owner: 'nucleotide',
      supported: !this.destroyed && this.renderer.type === RendererType.WEBGL,
      renderOwner: meshAttached && meshVisible ? RETAINED_LINEAR_NUCLEOTIDE_OWNER : null,
      requiredGlyphCount,
      meshCount: meshAttached && meshVisible ? 1 : 0,
      instanceCount: owner.geometry.instanceCount,
      retainedBaseCount: owner.forwardBases.length,
      bufferCapacity: MAX_INSTANCES,
      expectedBufferByteLength: owner.instanceData.byteLength,
      gpuBufferByteLength,
      bufferResident,
      bufferSynchronized,
      textureResident,
      textureResourceLive: this.atlas.source.resource != null,
      textureAutoGarbageCollect: this.atlas.source.autoGarbageCollect,
      shaderProgramOwned: owner.shader.glProgram === nucleotideGlProgram(),
      atlasBound: owner.shader.resources.uGlyphAtlas === this.atlas.source,
      meshAttached,
      meshVisible,
      projectionViewportWidthPx: owner.viewportUniform[0] ?? 0,
      projectionViewportHeightPx: owner.viewportUniform[1] ?? 0,
      rendererViewportWidthPx,
      rendererViewportHeightPx,
      glyphGeometryFontSizePx: this.atlas.glyphGeometryFontSizePx,
      displayScale: uniforms.uDisplayScale,
      displayFontSizePx: owner.displayFontSizePx,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const owner of this.owners) destroyGpuOwner(owner);
    this.container.destroy();
    this.atlas.dispose();
  }

  private ownerCovers(
    owner: GpuOwner,
    sequence: string | undefined,
    sequenceWindow: SequenceWindow | undefined,
    requestedRange: { readonly startBp: number; readonly endBp: number },
    presentation?: LinearSequencePresentation
  ): boolean {
    return (
      owner.geometry.instanceCount > 0 &&
      owner.sequence === sequence &&
      sameSequenceWindow(owner.sequenceWindow, sequenceWindow) &&
      owner.alignedQuery === presentation?.alignedQuery &&
      owner.nucleotideChanges === presentation?.nucleotideChanges &&
      owner.showSecondaryRow ===
        (presentation?.alignedQuery !== undefined ||
          presentation?.showReverseComplement !== false) &&
      owner.startBp <= requestedRange.startBp &&
      owner.endBp >= requestedRange.endBp
    );
  }

  private applyTheme(theme: WebGLRenderTheme): void {
    for (const owner of this.owners) {
      colorInto(owner.forwardColorUniform, theme.text);
      colorInto(owner.reverseColorUniform, theme.textMuted);
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Retained nucleotide layer is already destroyed');
  }
}
