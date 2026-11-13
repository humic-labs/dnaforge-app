import {
  BufferImageSource,
  Buffer as PixiBuffer,
  BufferUsage,
  Container,
  Geometry,
  GlProgram,
  Mesh,
  type Renderer,
  Shader,
  State,
} from 'pixi.js';

import type { CoverageGpuAtlas } from '@waypoint/genome-data';

import { COVERAGE_GPU_ATLAS_MAX_CHROMOSOMES, coverageGpuAtlasEligible } from './coverage-gpu-atlas';
import { PILEUP_COVERAGE_ALPHA, PILEUP_COVERAGE_SMOOTH_KERNEL } from './pileup-coverage-resample';
import {
  prepareSharedPixiGpuPrograms,
  type PixiGpuProgramPreparationRenderer,
} from '../shared/pixi-gpu-program-preparation';
import { destroyLayerShader } from '../shared/pixi-shader-lifecycle';

const QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
const SMOOTH_WEIGHTS = new Float32Array(PILEUP_COVERAGE_SMOOTH_KERNEL);
export const COVERAGE_GPU_ATLAS_RENDER_OWNER = 'coverage-gpu-atlas-fill' as const;

function coverageGpuAtlasGlProgram(): GlProgram {
  return GlProgram.from({
    name: COVERAGE_GPU_ATLAS_RENDER_OWNER,
    vertex: COVERAGE_GPU_ATLAS_VERTEX_SHADER,
    fragment: COVERAGE_GPU_ATLAS_FRAGMENT_SHADER,
  });
}

type ObservedGpuTextureBacking = {
  readonly width?: number;
  readonly height?: number;
  readonly texture?: unknown;
};

type ObservableBufferImageSource = BufferImageSource & {
  readonly _gpuData: Record<number, ObservedGpuTextureBacking | undefined>;
};

type ObservableWebGlProgramData = {
  readonly program?: unknown;
};

type ObservableWebGlRenderer = {
  readonly gl?: {
    readonly LINK_STATUS?: number;
    readonly getProgramParameter?: (program: unknown, parameter: number) => unknown;
    readonly isContextLost?: () => boolean;
  };
  readonly shader?: {
    readonly _programDataHash?: Record<number, ObservableWebGlProgramData | undefined> | null;
  };
};

function shaderProgramName(shader: Shader | null): string | null {
  const match = shader?.glProgram?.fragment?.match(/^#define SHADER_NAME ([^\n]+)/);
  return match?.[1] ?? null;
}

export const COVERAGE_GPU_ATLAS_VERTEX_SHADER = `
precision highp float;
attribute vec2 aPosition;
attribute vec4 aChromosome; // global start/end, base bin count, first mip row
uniform vec2 uViewportSize;
uniform vec2 uViewBpRange;
uniform float uBandTopPx;
uniform float uBandHeightPx;
varying float vBandY;
varying vec4 vChromosome;
varying float vGenomeBp;
varying float vScreenX;
void main() {
  vec2 viewport = max(vec2(1.0), uViewportSize);
  float span = max(1.0, uViewBpRange.y - uViewBpRange.x);
  float bp = mix(aChromosome.x, aChromosome.y, aPosition.x);
  float screenX = ((bp - uViewBpRange.x) / span) * viewport.x;
  float screenY = uBandTopPx + aPosition.y * uBandHeightPx;
  vec2 clip = vec2((screenX / viewport.x) * 2.0 - 1.0, 1.0 - (screenY / viewport.y) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vBandY = aPosition.y;
  vChromosome = aChromosome;
  vGenomeBp = bp;
  vScreenX = screenX;
}
`;

export const COVERAGE_GPU_ATLAS_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D uCoverageAtlas;
uniform vec2 uViewportSize;
uniform vec2 uAtlasSize;
uniform vec2 uViewBpRange;
uniform float uBaseBinSizeBp;
uniform vec4 uDepthScale; // p50, p95, p99, max
uniform float uCutoffDepth;
uniform float uMaxFill;
uniform float uBandHeightPx;
uniform float uCoverageResolution;
uniform vec3 uCoverageColor;
uniform float uAlpha;
uniform float uHorizontalExcludeActive;
uniform vec2 uHorizontalExcludePx;
varying float vBandY;
varying vec4 vChromosome;
varying float vGenomeBp;
varying float vScreenX;

float fetchDepth(vec4 chrom, float bp, float level) {
  float factor = exp2(level);
  float binSize = uBaseBinSizeBp * factor;
  float count = ceil(chrom.z / factor);
  float clampedBp = clamp(bp, chrom.x, chrom.y - 0.0001);
  float position = (clampedBp - chrom.x) / binSize - 0.5;
  float index0 = floor(position);
  float fraction = position - index0;
  if (index0 < 0.0) {
    index0 = 0.0;
    fraction = 0.0;
  } else if (index0 >= count - 1.0) {
    index0 = count - 1.0;
    fraction = 0.0;
  }
  float index1 = min(count - 1.0, index0 + 1.0);
  float row = chrom.w + level;
  vec2 uv0 = vec2((index0 + 0.5) / uAtlasSize.x, (row + 0.5) / uAtlasSize.y);
  vec2 uv1 = vec2((index1 + 0.5) / uAtlasSize.x, (row + 0.5) / uAtlasSize.y);
  return mix(texture2D(uCoverageAtlas, uv0).r, texture2D(uCoverageAtlas, uv1).r, fraction);
}

void main() {
  if (
    uHorizontalExcludeActive > 0.5 &&
    vScreenX >= uHorizontalExcludePx.x &&
    vScreenX <= uHorizontalExcludePx.y
  ) discard;
  float viewSpan = max(1.0, uViewBpRange.y - uViewBpRange.x);
  float bp = vGenomeBp;
  vec4 chrom = vChromosome;
  float bpPerPixel = viewSpan / max(1.0, uViewportSize.x);
  float physical = max(1.0, bpPerPixel / uBaseBinSizeBp);
  float maxLevel = ceil(log2(max(1.0, chrom.z)));
  float continuousLevel = clamp(log2(physical), 0.0, maxLevel);
  float level0 = floor(continuousLevel);
  float level1 = min(maxLevel, level0 + 1.0);
  float mipMix = fract(continuousLevel);
  float depth0 = 0.0;
  float depth1 = 0.0;
  depth0 += fetchDepth(chrom, bp - 2.0 * bpPerPixel, level0) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[0]};
  depth0 += fetchDepth(chrom, bp - bpPerPixel, level0) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[1]};
  depth0 += fetchDepth(chrom, bp, level0) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[2]};
  depth0 += fetchDepth(chrom, bp + bpPerPixel, level0) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[3]};
  depth0 += fetchDepth(chrom, bp + 2.0 * bpPerPixel, level0) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[4]};
  depth1 += fetchDepth(chrom, bp - 2.0 * bpPerPixel, level1) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[0]};
  depth1 += fetchDepth(chrom, bp - bpPerPixel, level1) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[1]};
  depth1 += fetchDepth(chrom, bp, level1) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[2]};
  depth1 += fetchDepth(chrom, bp + bpPerPixel, level1) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[3]};
  depth1 += fetchDepth(chrom, bp + 2.0 * bpPerPixel, level1) * ${PILEUP_COVERAGE_SMOOTH_KERNEL[4]};
  float depth = mix(depth0, depth1, mipMix);
  if (depth <= 0.0) discard;

  float manualCutoff = max(1.0, uCutoffDepth);
  float fill;
  if (uCutoffDepth > 0.0) {
    // A manual per-track cutoff is the Y-axis maximum: it maps to full
    // height and deeper values clip. Updating it changes uniforms only.
    fill = uMaxFill * clamp(log(1.0 + depth) / log(1.0 + manualCutoff), 0.0, 1.0);
  } else {
    float knee = max(1.0, uDepthScale.z);
    if (depth <= knee) {
      fill = uMaxFill * 0.55 * clamp(depth / knee, 0.0, 1.0);
    } else {
      float maximum = max(knee + 1.0, uDepthScale.w);
      float t = clamp(log(depth / knee) / log(maximum / knee), 0.0, 1.0);
      fill = uMaxFill * clamp(0.55 + 0.45 * t, 0.0, 1.0);
    }
  }
  // Analytic one-framebuffer-pixel coverage at the silhouette boundary.
  // A binary discard here quantizes a smoothly panning height field to whole
  // rows and makes the top edge visibly vibrate. Interior pixels remain exact.
  float edgeDistancePx = (fill - vBandY) * uBandHeightPx * uCoverageResolution;
  float edgeCoverage = clamp(edgeDistancePx + 0.5, 0.0, 1.0);
  if (edgeCoverage <= 0.0) discard;
  float edgeAlpha = uAlpha * edgeCoverage;
  gl_FragColor = vec4(uCoverageColor * edgeAlpha, edgeAlpha);
}
`;

type AtlasUniforms = {
  uViewportSize: Float32Array;
  uBandTopPx: number;
  uBandHeightPx: number;
  uAtlasSize: Float32Array;
  uViewBpRange: Float32Array;
  uBaseBinSizeBp: number;
  uDepthScale: Float32Array;
  uCutoffDepth: number;
  uMaxFill: number;
  uCoverageResolution: number;
  uCoverageColor: Float32Array;
  uAlpha: number;
  uHorizontalExcludeActive: number;
  uHorizontalExcludePx: Float32Array;
};

export interface CoverageGpuAtlasLayerPaint {
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
  readonly bandTopPx: number;
  readonly bandHeightPx: number;
  readonly maxFill: number;
  readonly cutoffDepth: number;
  readonly color: number;
  readonly allowHandoffHold?: boolean;
  readonly renderer?: Renderer;
}

export interface CoverageGpuAtlasLayerDiagnostics {
  readonly authorityKey: string | null;
  readonly textureResourceCreateCount: number;
  readonly gpuTextureResourceCreateCount: number;
  readonly gpuTextureUploadCount: number;
  readonly gpuTextureUploadComplete: boolean;
  readonly textureResourceUid: number | null;
  readonly shaderTextureResourceUid: number | null;
  readonly shaderTextureResourceBound: boolean;
  readonly geometryBuildCount: number;
  readonly cameraUniformUpdateCount: number;
  readonly renderOwner: string | null;
  readonly shaderProgramName: string | null;
  readonly shaderProgramKey: number | null;
  readonly shaderProgramCompiled: boolean;
  readonly active: boolean;
  readonly baseBinSizeBp: number;
  readonly depthMax: number;
  readonly textureWidth: number;
  readonly textureHeight: number;
}

export class CoverageGpuAtlasLayer {
  private readonly container: Container;
  private atlas: CoverageGpuAtlas | null = null;
  private source: BufferImageSource | null = null;
  private geometry: Geometry | null = null;
  private shader: Shader | null = null;
  private mesh: Mesh<Geometry, Shader> | null = null;
  private textureResourceCreateCount = 0;
  private gpuTextureResourceCreateCount = 0;
  private gpuTextureUploadCount = 0;
  private geometryBuildCount = 0;
  private cameraUniformUpdateCount = 0;
  private renderer: Renderer | null = null;
  private linkedProgramReceipt: {
    readonly renderer: Renderer;
    readonly gl: NonNullable<ObservableWebGlRenderer['gl']>;
    readonly programKey: number;
  } | null = null;
  private uploadObservationSource: BufferImageSource | null = null;
  private readonly observedGpuBackings = new WeakSet<object>();
  private readonly observedUploadedGpuBackings = new WeakSet<object>();

  constructor(container: Container) {
    this.container = container;
  }

  static gpuProgram(): GlProgram {
    return coverageGpuAtlasGlProgram();
  }

  static prepareGpuProgram(renderer: PixiGpuProgramPreparationRenderer): void {
    prepareSharedPixiGpuPrograms(renderer, [CoverageGpuAtlasLayer.gpuProgram()]);
  }

  syncAtlas(atlas: CoverageGpuAtlas | null | undefined): boolean {
    if (!atlas) {
      this.clear();
      return false;
    }
    this.validateAtlas(atlas);
    if (this.atlas?.authorityKey === atlas.authorityKey) return false;
    this.destroyResources();

    const source = new BufferImageSource({
      resource: atlas.data,
      width: atlas.textureWidth,
      height: atlas.textureHeight,
      format: 'r32float',
      scaleMode: 'nearest',
      alphaMode: 'no-premultiply-alpha',
      autoGarbageCollect: false,
      label: `coverage-atlas:${atlas.authorityKey}`,
    });
    const positions = new Float32Array(QUAD.length * atlas.chromosomes.length);
    const chromosomeMeta = new Float32Array(atlas.chromosomes.length * 6 * 4);
    for (let index = 0; index < atlas.chromosomes.length; index += 1) {
      positions.set(QUAD, index * QUAD.length);
      const chrom = atlas.chromosomes[index]!;
      for (let vertex = 0; vertex < 6; vertex += 1) {
        const offset = (index * 6 + vertex) * 4;
        chromosomeMeta[offset] = chrom.globalStartBp;
        chromosomeMeta[offset + 1] = chrom.globalEndBp;
        chromosomeMeta[offset + 2] = chrom.baseBinCount;
        chromosomeMeta[offset + 3] = chrom.rowStart;
      }
    }
    const position = new PixiBuffer({
      data: positions,
      usage: BufferUsage.VERTEX,
      label: 'coverage-atlas-chromosome-quads',
      shrinkToFit: false,
    });
    const chromosome = new PixiBuffer({
      data: chromosomeMeta,
      usage: BufferUsage.VERTEX,
      label: 'coverage-atlas-chromosome-meta',
      shrinkToFit: false,
    });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: position, format: 'float32x2' },
        aChromosome: { buffer: chromosome, format: 'float32x4' },
      },
      topology: 'triangle-list',
    });
    const viewport = new Float32Array(2);
    const atlasSize = new Float32Array([atlas.textureWidth, atlas.textureHeight]);
    const view = new Float32Array(2);
    const pct = atlas.depthPercentiles;
    const depthScale = new Float32Array([pct.p50, pct.p95, pct.p99, pct.max]);
    const color = new Float32Array(3);
    const horizontalExclude = new Float32Array(2);
    const shader = new Shader({
      glProgram: coverageGpuAtlasGlProgram(),
      resources: {
        uCoverageAtlas: source,
        coverageAtlasUniforms: {
          uViewportSize: { value: viewport, type: 'vec2<f32>' },
          uBandTopPx: { value: 0, type: 'f32' },
          uBandHeightPx: { value: 1, type: 'f32' },
          uAtlasSize: { value: atlasSize, type: 'vec2<f32>' },
          uViewBpRange: { value: view, type: 'vec2<f32>' },
          uBaseBinSizeBp: { value: atlas.baseBinSizeBp, type: 'f32' },
          uDepthScale: { value: depthScale, type: 'vec4<f32>' },
          uCutoffDepth: { value: pct.p99, type: 'f32' },
          uMaxFill: { value: 1, type: 'f32' },
          uCoverageResolution: { value: 1, type: 'f32' },
          uCoverageColor: { value: color, type: 'vec3<f32>' },
          uAlpha: { value: PILEUP_COVERAGE_ALPHA, type: 'f32' },
          uHorizontalExcludeActive: { value: 0, type: 'f32' },
          uHorizontalExcludePx: { value: horizontalExclude, type: 'vec2<f32>' },
        },
      },
    });
    const mesh = new Mesh<Geometry, Shader>({ geometry, shader, state: State.for2d() });
    mesh.label = COVERAGE_GPU_ATLAS_RENDER_OWNER;
    mesh.eventMode = 'none';
    mesh.visible = false;
    this.container.addChildAt(mesh, 0);
    this.atlas = atlas;
    this.source = source;
    this.geometry = geometry;
    this.shader = shader;
    this.mesh = mesh;
    this.textureResourceCreateCount += 1;
    this.geometryBuildCount += 1;
    return true;
  }

  paint(input: CoverageGpuAtlasLayerPaint): boolean {
    const atlas = this.atlas;
    const mesh = this.mesh;
    const shader = this.shader;
    if (input.renderer) {
      if (this.renderer !== input.renderer) this.linkedProgramReceipt = null;
      this.renderer = input.renderer;
      this.observeGpuBacking();
    }
    if (!atlas || !mesh || !shader || input.bandHeightPx <= 0) {
      if (mesh) mesh.visible = false;
      return false;
    }
    const span = input.viewportEndBp - input.viewportStartBp;
    if (!input.allowHandoffHold && !coverageGpuAtlasEligible(atlas, span, input.viewportWidthPx)) {
      mesh.visible = false;
      return false;
    }
    const u = (shader.resources.coverageAtlasUniforms as { uniforms: AtlasUniforms }).uniforms;
    u.uViewportSize[0] = input.viewportWidthPx;
    u.uViewportSize[1] = input.viewportHeightPx;
    u.uViewBpRange[0] = input.viewportStartBp;
    u.uViewBpRange[1] = input.viewportEndBp;
    u.uBandTopPx = input.bandTopPx;
    u.uBandHeightPx = input.bandHeightPx;
    u.uCutoffDepth = input.cutoffDepth;
    u.uMaxFill = Math.max(0, Math.min(1, input.maxFill));
    u.uCoverageResolution =
      input.renderer && Number.isFinite(input.renderer.resolution) && input.renderer.resolution > 0
        ? input.renderer.resolution
        : 1;
    u.uCoverageColor[0] = ((input.color >> 16) & 0xff) / 255;
    u.uCoverageColor[1] = ((input.color >> 8) & 0xff) / 255;
    u.uCoverageColor[2] = (input.color & 0xff) / 255;
    mesh.visible = true;
    this.cameraUniformUpdateCount += 1;
    return true;
  }

  setAlpha(alpha: number): void {
    if (this.mesh) this.mesh.alpha = alpha;
  }

  setHorizontalExclusion(rangePx: readonly [number, number] | null): void {
    if (!this.shader) return;
    const uniforms = (this.shader.resources.coverageAtlasUniforms as { uniforms: AtlasUniforms })
      .uniforms;
    uniforms.uHorizontalExcludeActive = rangePx ? 1 : 0;
    uniforms.uHorizontalExcludePx[0] = rangePx?.[0] ?? 0;
    uniforms.uHorizontalExcludePx[1] = rangePx?.[1] ?? 0;
  }

  setVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible;
  }

  diagnostics(): CoverageGpuAtlasLayerDiagnostics {
    this.observeGpuBacking();
    const source = this.source;
    const shader = this.shader;
    const mesh = this.mesh;
    const shaderTexture = shader?.resources.uCoverageAtlas;
    const backing = this.currentGpuBacking();
    const uploadComplete = this.isCompletedGpuUpload(backing, source);
    const shaderLinked = this.isRendererProgramLinked(shader);
    return {
      authorityKey: this.atlas?.authorityKey ?? null,
      textureResourceCreateCount: this.textureResourceCreateCount,
      gpuTextureResourceCreateCount: this.gpuTextureResourceCreateCount,
      gpuTextureUploadCount: this.gpuTextureUploadCount,
      gpuTextureUploadComplete: uploadComplete,
      textureResourceUid: source?.uid ?? null,
      shaderTextureResourceUid:
        shaderTexture && typeof shaderTexture === 'object' && 'uid' in shaderTexture
          ? Number(shaderTexture.uid)
          : null,
      shaderTextureResourceBound: source !== null && shaderTexture === source,
      geometryBuildCount: this.geometryBuildCount,
      cameraUniformUpdateCount: this.cameraUniformUpdateCount,
      renderOwner:
        mesh?.visible === true && mesh.parent === this.container ? mesh.label || null : null,
      shaderProgramName: shaderProgramName(shader),
      shaderProgramKey:
        shaderLinked && Number.isSafeInteger(shader?.glProgram?._key)
          ? shader!.glProgram._key
          : null,
      shaderProgramCompiled: shaderLinked,
      active: mesh?.visible === true,
      baseBinSizeBp: this.atlas?.baseBinSizeBp ?? 0,
      depthMax: this.atlas?.depthPercentiles.max ?? 0,
      textureWidth: this.atlas?.textureWidth ?? 0,
      textureHeight: this.atlas?.textureHeight ?? 0,
    };
  }

  private isRendererProgramLinked(shader: Shader | null): boolean {
    const renderer = this.renderer as (Renderer & ObservableWebGlRenderer) | null;
    const programKey = shader?.glProgram?._key;
    if (!renderer || !Number.isSafeInteger(programKey)) return false;

    const gl = renderer.gl;
    const cached = this.linkedProgramReceipt;
    if (cached?.renderer === renderer && cached.gl === gl && cached.programKey === programKey) {
      try {
        if (gl?.isContextLost?.() === true) {
          this.linkedProgramReceipt = null;
          return false;
        }
      } catch {
        this.linkedProgramReceipt = null;
        return false;
      }
      return true;
    }

    const programData = renderer.shader?._programDataHash?.[programKey!];
    const webGlProgram = programData?.program;
    if (
      webGlProgram == null ||
      typeof gl?.LINK_STATUS !== 'number' ||
      typeof gl.getProgramParameter !== 'function'
    ) {
      return false;
    }
    try {
      if (gl.isContextLost?.() === true) return false;
      const linked = gl.getProgramParameter(webGlProgram, gl.LINK_STATUS) === true;
      if (linked) {
        this.linkedProgramReceipt = { renderer, gl, programKey: programKey! };
      }
      return linked;
    } catch {
      return false;
    }
  }

  private currentGpuBacking(): ObservedGpuTextureBacking | null {
    const source = this.source as ObservableBufferImageSource | null;
    const renderer = this.renderer;
    if (!source || !renderer || !Number.isSafeInteger(renderer.uid)) return null;
    return source._gpuData?.[renderer.uid] ?? null;
  }

  private isCompletedGpuUpload(
    backing: ObservedGpuTextureBacking | null,
    source: BufferImageSource | null
  ): boolean {
    return (
      backing != null &&
      backing.texture != null &&
      source != null &&
      backing.width === source.width &&
      backing.height === source.height
    );
  }

  private observeGpuBacking(): void {
    const source = this.source;
    const backing = this.currentGpuBacking();
    if (!backing || !source) return;
    if (!this.observedGpuBackings.has(backing)) {
      this.observedGpuBackings.add(backing);
      this.gpuTextureResourceCreateCount += 1;
    }
    if (
      this.isCompletedGpuUpload(backing, source) &&
      !this.observedUploadedGpuBackings.has(backing)
    ) {
      this.observedUploadedGpuBackings.add(backing);
      this.gpuTextureUploadCount += 1;
    }
    if (this.uploadObservationSource !== source) {
      this.uploadObservationSource?.off('update', this.observeCompletedGpuReupload, this);
      this.uploadObservationSource = source;
      source.on('update', this.observeCompletedGpuReupload, this);
    }
  }

  private observeCompletedGpuReupload(source: BufferImageSource): void {
    if (
      source === this.source &&
      this.uploadObservationSource === source &&
      this.isCompletedGpuUpload(this.currentGpuBacking(), source)
    ) {
      this.gpuTextureUploadCount += 1;
    }
  }

  destroy(): void {
    this.destroyResources();
    this.atlas = null;
  }

  private clear(): void {
    this.destroyResources();
    this.atlas = null;
  }

  private destroyResources(): void {
    const mesh = this.mesh;
    const geometry = this.geometry;
    const shader = this.shader;
    const source = this.source;
    this.uploadObservationSource?.off('update', this.observeCompletedGpuReupload, this);
    this.uploadObservationSource = null;
    this.linkedProgramReceipt = null;
    this.mesh = null;
    this.geometry = null;
    this.shader = null;
    this.source = null;
    if (mesh?.parent) mesh.parent.removeChild(mesh);
    mesh?.destroy({ texture: false, textureSource: false });
    geometry?.destroy(true);
    if (shader) destroyLayerShader(shader);
    source?.destroy();
  }

  private validateAtlas(atlas: CoverageGpuAtlas): void {
    const expectedAuthorityKey = JSON.stringify([
      'coverage-gpu-atlas.v1',
      atlas.sourceIdentity,
      atlas.assemblyFingerprint,
      atlas.statistic,
      atlas.payloadRevision,
    ]);
    if (
      atlas.contract !== 'coverage-gpu-atlas.v1' ||
      atlas.authorityKey.length === 0 ||
      atlas.sourceIdentity.length === 0 ||
      atlas.assemblyFingerprint.length === 0 ||
      atlas.statistic.length === 0 ||
      atlas.payloadRevision.length === 0 ||
      atlas.chromosomes.length === 0 ||
      atlas.chromosomes.length > COVERAGE_GPU_ATLAS_MAX_CHROMOSOMES ||
      atlas.textureWidth <= 0 ||
      atlas.textureHeight <= 0 ||
      atlas.data.length !== atlas.textureWidth * atlas.textureHeight
    ) {
      throw new Error('coverage GPU atlas layer rejected mismatched or incomplete authority');
    }
    if (atlas.authorityKey !== expectedAuthorityKey || atlas.assemblyStartBp !== 0) {
      throw new Error('coverage GPU atlas layer rejected mismatched or incomplete authority');
    }
    let expectedStart = 0;
    for (const chromosome of atlas.chromosomes) {
      if (
        chromosome.globalStartBp !== expectedStart ||
        chromosome.globalEndBp <= chromosome.globalStartBp ||
        chromosome.baseBinCount !==
          Math.ceil((chromosome.globalEndBp - chromosome.globalStartBp) / atlas.baseBinSizeBp) ||
        chromosome.rowStart < 0 ||
        chromosome.rowCount <= 0 ||
        chromosome.rowStart + chromosome.rowCount > atlas.textureHeight
      ) {
        throw new Error('coverage GPU atlas layer rejected mismatched or incomplete authority');
      }
      expectedStart = chromosome.globalEndBp;
    }
    if (expectedStart !== atlas.assemblyEndBp) {
      throw new Error('coverage GPU atlas layer rejected mismatched or incomplete authority');
    }
  }
}

export const COVERAGE_GPU_ATLAS_SMOOTH_WEIGHTS = SMOOTH_WEIGHTS;
