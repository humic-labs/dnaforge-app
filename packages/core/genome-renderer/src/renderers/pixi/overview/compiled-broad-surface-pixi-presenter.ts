import {
  packAnnotationRolePaletteMat4V1,
  type AnnotationColorRoleKeyV1,
  type AnnotationRolePaletteOverridesV1,
} from '../../../annotation-role-palette';
import {
  BufferImageSource,
  Buffer as PixiBuffer,
  BufferUsage,
  Container,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  State,
  Texture as PixiTexture,
  type Texture,
} from 'pixi.js';

import {
  broadSurfaceLodMixV2,
  broadSurfaceMipRoleV2,
  broadSurfaceNativeLevelPositionV2,
  compiledBroadSurfaceCellIdV2,
  exactBroadSurfaceTilePlacementV2,
  isAdmittedBroadSurfacePresentationPlanV2,
  type BroadSurfaceIsoformModeV2,
  type BroadSurfaceMipRoleV2,
  type BroadSurfacePresentationPlanV2,
  type CompiledBroadSurfaceManifestV2,
  type ExactBroadSurfaceTilePlacementV2,
} from './bounded-annotation-broad-surface';
import type { ViewerRenderContract } from './viewer-render-contract';
import {
  INDEXED_ANNOTATION_RUNTIME_THEME_GLSL,
  indexedAnnotationRuntimeThemeUniforms,
} from '../shared/annotation-runtime-theme';
import type { WebGLThemeMode } from '../shared/theme';

export const COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2 =
  'compiled-broad-surface-pixi-presenter.v2' as const;
export const STAGED_COMPILED_BROAD_SURFACE_PIXI_PRESENTATION_V2 =
  'staged-compiled-broad-surface-pixi-presentation.v2' as const;

export const COMPILED_BROAD_SURFACE_VERTEX_SHADER_V2 = `
precision highp float;
attribute vec2 aPosition;
uniform vec4 uRectPx;
uniform vec2 uViewportPx;
varying vec2 vUnitPosition;

void main() {
  vec2 viewport = max(vec2(1.0), uViewportPx);
  vec2 screen = uRectPx.xy + aPosition * uRectPx.zw;
  vec2 clip = vec2(
    (screen.x / viewport.x) * 2.0 - 1.0,
    1.0 - (screen.y / viewport.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vUnitPosition = aPosition;
}
`;

export const COMPILED_BROAD_SURFACE_FRAGMENT_SHADER_V2 = `
precision highp float;
uniform sampler2D uFinerTexture;
uniform sampler2D uCoarserTexture;
uniform vec4 uFinerUvRect;
uniform vec4 uCoarserUvRect;
uniform float uLodMix;
uniform float uAnnotationThemeDark;
uniform float uAnnotationTranscriptPalette;
uniform float uAnnotationRnaPalette;
varying vec2 vUnitPosition;
${INDEXED_ANNOTATION_RUNTIME_THEME_GLSL}

vec4 indexedAnnotationRuntimeThemePremultiplied(vec4 canonical) {
  if (uAnnotationThemeDark < 0.5 || canonical.a <= 0.000001) return canonical;
  vec3 straightRgb = canonical.rgb / canonical.a;
  vec3 themed = indexedAnnotationRuntimeThemeColor(
    straightRgb,
    uAnnotationThemeDark,
    uAnnotationTranscriptPalette,
    uAnnotationRnaPalette
  );
  return vec4(themed * canonical.a, canonical.a);
}

void main() {
  vec2 finerUv = mix(uFinerUvRect.xy, uFinerUvRect.zw, vUnitPosition);
  vec2 coarserUv = mix(uCoarserUvRect.xy, uCoarserUvRect.zw, vUnitPosition);
  vec4 finer = indexedAnnotationRuntimeThemePremultiplied(texture2D(uFinerTexture, finerUv));
  vec4 coarser = indexedAnnotationRuntimeThemePremultiplied(texture2D(uCoarserTexture, coarserUv));
  gl_FragColor = mix(finer, coarser, clamp(uLodMix, 0.0, 1.0));
}
`;

export const COMPILED_BROAD_SURFACE_ROLE_WEIGHT_FRAGMENT_SHADER_V1 = `
precision highp float;
uniform sampler2D uFinerTexture;
uniform sampler2D uCoarserTexture;
uniform vec4 uFinerUvRect;
uniform vec4 uCoarserUvRect;
uniform float uLodMix;
uniform mat4 uRolePalette;
varying vec2 vUnitPosition;

vec4 rolePremultiplied(vec4 weights) {
  return vec4((uRolePalette * weights).rgb, min(1.0, dot(weights, vec4(1.0))));
}

void main() {
  vec2 finerUv = mix(uFinerUvRect.xy, uFinerUvRect.zw, vUnitPosition);
  vec2 coarserUv = mix(uCoarserUvRect.xy, uCoarserUvRect.zw, vUnitPosition);
  vec4 weights = mix(
    texture2D(uFinerTexture, finerUv),
    texture2D(uCoarserTexture, coarserUv),
    clamp(uLodMix, 0.0, 1.0)
  );
  gl_FragColor = rolePremultiplied(weights);
}
`;

const QUAD_POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
const EMPTY_CELL_IDS = Object.freeze([]) as readonly string[];
const EMPTY_MIP_WEIGHTS = Object.freeze([]) as readonly number[];

export interface CompiledBroadSurfaceDecodedCellTextureV2 {
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly level: number;
  readonly tileX: number;
  readonly laneSlabIndex: number;
  readonly texture: Texture;
}

export interface CompiledBroadSurfaceTransparentCellV2 {
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly level: number;
  readonly tileX: number;
  readonly laneSlabIndex: number;
}

export interface CompiledBroadSurfaceRgbaTextureV2 {
  readonly source: BufferImageSource;
  readonly texture: Texture;
  readonly explicitCopyByteLength: 0;
  readonly uploadByteLength: number;
}

export function createCompiledBroadSurfaceRgbaTextureV2(input: {
  readonly manifest: CompiledBroadSurfaceManifestV2;
  readonly premultipliedRgba: Uint8Array;
  readonly label: string;
}): CompiledBroadSurfaceRgbaTextureV2 {
  const expectedWidth =
    input.manifest.broadTilePhysicalWidthPx + input.manifest.broadTileXGuardPhysicalPx * 2;
  const expectedHeight = input.manifest.laneSlabRowCount * input.manifest.laneRowTextureStridePx;
  if (
    !(input.premultipliedRgba instanceof Uint8Array) ||
    input.premultipliedRgba.byteLength !== expectedWidth * expectedHeight * 4
  ) {
    throw new Error('compiled-broad-surface-rgba-byte-length-mismatch');
  }
  const source = new BufferImageSource({
    resource: input.premultipliedRgba,
    width: expectedWidth,
    height: expectedHeight,
    resolution: 1,
    format: 'rgba8unorm',
    alphaMode: 'premultiplied-alpha',
    scaleMode: 'linear',
    autoGenerateMipmaps: false,
    autoGarbageCollect: false,
    dynamic: false,
    label: input.label,
  });
  return Object.freeze({
    source,
    texture: new PixiTexture({ source, dynamic: false }),
    explicitCopyByteLength: 0,
    uploadByteLength: input.premultipliedRgba.byteLength,
  });
}

export type CompiledBroadSurfaceCellAdmissionResultV2 = Readonly<
  | { status: 'admitted' | 'already-resident'; cellId: string }
  | { status: 'rejected'; cellId: string | null; reason: string }
>;

export interface StagedCompiledBroadSurfacePixiPresentationV2 {
  readonly contract: typeof STAGED_COMPILED_BROAD_SURFACE_PIXI_PRESENTATION_V2;
  readonly stageId: number;
  readonly manifestFingerprint: string;
  readonly trackId: string;
  readonly isoformMode: BroadSurfaceIsoformModeV2;
  readonly laneLimit: number | null;
  readonly residentCellIds: readonly string[];
  readonly submittedCellIds: readonly string[];
}

export type CompiledBroadSurfaceStageResultV2 = Readonly<
  | { status: 'staged'; receipt: StagedCompiledBroadSurfacePixiPresentationV2 }
  | { status: 'already-active' }
  | { status: 'missing-cells'; missingCellIds: readonly string[] }
  | { status: 'rejected'; reason: string }
>;

export interface CompiledBroadSurfacePixiCameraV2 {
  readonly plan: BroadSurfacePresentationPlanV2;
  readonly contract: ViewerRenderContract;
  readonly trackTopCssPx: number;
  readonly viewportCssWidthPx: number;
  readonly viewportCssHeightPx: number;
  readonly themeMode: WebGLThemeMode;
  readonly rolePalette?: AnnotationRolePaletteOverridesV1;
}

export interface CompiledBroadSurfacePresentedQuadDiagnosticsV2 {
  readonly finerCellId: string;
  readonly coarserCellId: string;
  readonly laneSlabIndex: number;
  readonly visibleLaneRowCount: number;
  readonly destinationStartBp: number;
  readonly destinationEndBpExclusive: number;
  readonly destinationTopCssPx: number;
  readonly destinationHeightCssPx: number;
  readonly finerUvRect: readonly [number, number, number, number];
  readonly coarserUvRect: readonly [number, number, number, number];
}

export interface CompiledBroadSurfacePixiDiagnosticsV2 {
  readonly contract: typeof COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2;
  readonly manifestFingerprint: string;
  readonly trackId: string;
  readonly presenting: boolean;
  readonly holdingLastGood: boolean;
  readonly runtimeThemeMode: WebGLThemeMode;
  readonly activeIsoformMode: BroadSurfaceIsoformModeV2 | null;
  readonly activeLaneLimit: number | null;
  readonly activeLevelIds: readonly string[];
  readonly activeMipWeights: readonly number[];
  readonly activeLevels: readonly {
    readonly role: BroadSurfaceMipRoleV2;
    readonly level: number;
    readonly tileSpanBp: number;
    readonly sampleWeight: number;
    readonly projectedTilePhysicalWidthPx: number;
    readonly rasterMagnificationX: number;
  }[];
  readonly maxQualifiedRasterMagnificationX: number;
  readonly residentCellIds: readonly string[];
  readonly activeResidentCellIds: readonly string[];
  readonly submittedCellIds: readonly string[];
  readonly missingCellIds: readonly string[];
  readonly presentedQuads: readonly CompiledBroadSurfacePresentedQuadDiagnosticsV2[];
  readonly broadVectorSubmissionCount: 0;
  readonly runtimeCellCompileCount: 0;
  readonly runtimeDurableWriteCount: 0;
  readonly textureAdmissionCount: number;
  readonly transparentCellAdmissionCount: number;
  readonly residentTextureCellCount: number;
  readonly residentTransparentCellCount: number;
  readonly residentCellHighWater: number;
  readonly residentTextureCellHighWater: number;
  readonly cellEvictionCount: number;
  readonly stagedSceneBuildCount: number;
  readonly atomicCommitCount: number;
  readonly cameraTransformUpdateCount: number;
  readonly quadPoolCapacity: number;
  readonly meshCreationCount: number;
  readonly shaderCreationCount: number;
  readonly geometryCreationCount: 1;
  readonly lastFailure: string | null;
}

export interface CompiledBroadSurfacePixiReadinessDiagnosticsV2 {
  readonly contract: typeof COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2;
  readonly manifestFingerprint: string;
  readonly trackId: string;
  readonly presenting: boolean;
  readonly holdingLastGood: boolean;
  readonly runtimeThemeMode: WebGLThemeMode;
  readonly activeIsoformMode: BroadSurfaceIsoformModeV2 | null;
  readonly activeLaneLimit: number | null;
  readonly activeResidentCellCount: number;
  readonly submittedCellCount: number;
  readonly missingCellCount: number;
  readonly presentedQuadCount: number;
  readonly runtimeCellCompileCount: 0;
  readonly runtimeDurableWriteCount: 0;
  readonly textureAdmissionCount: number;
  readonly transparentCellAdmissionCount: number;
  readonly residentTextureCellCount: number;
  readonly residentTransparentCellCount: number;
  readonly lastFailure: string | null;
}

export interface CompiledBroadSurfacePixiColdGestureSnapshotV2 {
  readonly activeLevelIds: readonly string[];
  readonly activeMipWeights: readonly number[];
  readonly activeResidentCellIds: readonly string[];
  readonly submittedCellIds: readonly string[];
  readonly runtimeCellCompileCount: 0;
  readonly runtimeDurableWriteCount: 0;
}

type CellTextureRecord = Readonly<{
  cellId: string;
  isoformMode: BroadSurfaceIsoformModeV2;
  level: number;
  tileX: number;
  laneSlabIndex: number;
  texture: Texture;
  invalidate: () => void;
}>;

type BroadSurfaceShaderUniforms = {
  uRectPx: Float32Array;
  uViewportPx: Float32Array;
  uFinerUvRect: Float32Array;
  uCoarserUvRect: Float32Array;
  uLodMix: number;
  uAnnotationThemeDark: number;
  uAnnotationTranscriptPalette: number;
  uAnnotationRnaPalette: number;
  uRolePalette: Float32Array;
};

type ImmutableTexturePairBinding = Readonly<{
  key: string;
  finerCellId: string;
  coarserCellId: string;
  shader: Shader;
  uniforms: BroadSurfaceShaderUniforms;
}>;

type PresentedQuad = {
  readonly mesh: Mesh<Geometry, Shader>;
  readonly placeholderBinding: ImmutableTexturePairBinding;
  binding: ImmutableTexturePairBinding;
  shader: Shader;
  uniforms: BroadSurfaceShaderUniforms;
  finerCellId: string;
  coarserCellId: string;
  laneSlabIndex: number;
  visibleLaneRowCount: number;
  placement: ExactBroadSurfaceTilePlacementV2 | null;
  finerUvRect: readonly [number, number, number, number];
  coarserUvRect: readonly [number, number, number, number];
};

type QuadBank = {
  readonly root: Container;
  readonly slots: readonly PresentedQuad[];
  readonly bindings: Map<string, ImmutableTexturePairBinding>;
};

type PreparedScene = {
  readonly receipt: StagedCompiledBroadSurfacePixiPresentationV2;
  readonly root: Container;
  readonly plan: BroadSurfacePresentationPlanV2;
  readonly residentCellIds: readonly string[];
  readonly submittedCellIds: readonly string[];
  readonly residentRecords: ReadonlyMap<string, CellTextureRecord>;
  readonly transparentCellIds: ReadonlySet<string>;
  readonly quads: readonly PresentedQuad[];
  readonly bank: QuadBank;
};

type PreparedStagedCameraCommit = Readonly<{
  readonly camera: Omit<CompiledBroadSurfacePixiCameraV2, 'plan'>;
  readonly viewportCssWidthPx: number;
  readonly viewportCssHeightPx: number;
  readonly trackTopCssPx: number;
  readonly coarserWeight: number;
  readonly projectedQuads: readonly Readonly<{
    readonly quad: PresentedQuad;
    readonly xStart: number;
    readonly xEnd: number;
  }>[];
}>;

type StagedPresentationCommitPreflight = Readonly<
  | {
      status: 'ready';
      staged: PreparedScene;
      plan: BroadSurfacePresentationPlanV2;
      preparedCamera: PreparedStagedCameraCommit | null;
    }
  | {
      status: 'rejected';
      reason: string | null;
      discardStaged: boolean;
    }
>;

export class CompiledBroadSurfacePixiPresenterV2 {
  readonly container = new Container();

  readonly #manifest: CompiledBroadSurfaceManifestV2;
  readonly #geometry: Geometry;
  readonly #program: GlProgram;
  readonly #quadBanks: readonly [QuadBank, QuadBank];
  #quadPoolCapacity = 0;
  #corridorViewportPhysicalWidthHighWater = 0;
  #corridorLaneRowHighWater = 0;
  readonly #cells = new Map<string, CellTextureRecord>();
  readonly #transparentCellIds = new Set<string>();
  #staged: PreparedScene | null = null;
  #active: PreparedScene | null = null;
  #activePlan: BroadSurfacePresentationPlanV2 | null = null;
  #activeLodMix = 0;
  #runtimeThemeMode: WebGLThemeMode = 'light';
  #activeTopologyCoversLastCamera = false;
  #lastCamera: Omit<CompiledBroadSurfacePixiCameraV2, 'plan'> | null = null;
  #hidden = false;
  #holdingLastGood = false;
  #missingCellIds: readonly string[] = Object.freeze([]);
  #lastFailure: string | null = null;
  #stageId = 0;
  #textureAdmissionCount = 0;
  #transparentCellAdmissionCount = 0;
  #residentCellHighWater = 0;
  #residentTextureCellHighWater = 0;
  #cellEvictionCount = 0;
  #stagedSceneBuildCount = 0;
  #atomicCommitCount = 0;
  #cameraTransformUpdateCount = 0;
  #shaderCreationCount = 0;
  #destroyed = false;

  readonly #roleTable: readonly AnnotationColorRoleKeyV1[] | null;
  readonly #rolePalettes = new Map<WebGLThemeMode, Float32Array>();
  #rolePaletteOverrides: AnnotationRolePaletteOverridesV1 | undefined;

  constructor(
    manifest: CompiledBroadSurfaceManifestV2,
    options: { readonly roleTable?: readonly AnnotationColorRoleKeyV1[] } = {}
  ) {
    compiledBroadSurfaceCellIdV2({
      manifest,
      isoformMode: 'canonical',
      level: 0,
      tileX: 0,
      laneSlabIndex: 0,
    });
    this.#manifest = manifest;
    this.#roleTable = options.roleTable ? [...options.roleTable] : null;
    this.#program = GlProgram.from(
      this.#roleTable
        ? {
            name: `${COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2}:role-weights`,
            vertex: COMPILED_BROAD_SURFACE_VERTEX_SHADER_V2,
            fragment: COMPILED_BROAD_SURFACE_ROLE_WEIGHT_FRAGMENT_SHADER_V1,
          }
        : {
            name: COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2,
            vertex: COMPILED_BROAD_SURFACE_VERTEX_SHADER_V2,
            fragment: COMPILED_BROAD_SURFACE_FRAGMENT_SHADER_V2,
          }
    );
    const positions = new PixiBuffer({
      data: QUAD_POSITIONS,
      usage: BufferUsage.VERTEX | BufferUsage.STATIC,
      label: 'compiled-broad-surface-unit-quad-v2',
      shrinkToFit: false,
    });
    this.#geometry = new Geometry({
      attributes: { aPosition: { buffer: positions, format: 'float32x2' } },
      topology: 'triangle-list',
    });
    this.container.eventMode = 'none';
    this.container.visible = false;
    this.container.label = COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2;
    this.#quadBanks = Object.freeze([this.#createQuadBank(0), this.#createQuadBank(1)]);
  }

  get isPresenting(): boolean {
    return (
      !this.#destroyed &&
      !this.#hidden &&
      this.container.visible &&
      (this.#active?.root.visible ?? false)
    );
  }

  get holdingLastGood(): boolean {
    return this.#holdingLastGood;
  }

  get runtimeThemeMode(): WebGLThemeMode {
    return this.#runtimeThemeMode;
  }

  get activePresentationPlan(): BroadSurfacePresentationPlanV2 | null {
    return this.#activePlan;
  }

  get activeTopologyCoversLastCamera(): boolean {
    return this.#activeTopologyCoversLastCamera;
  }

  get residentCellCount(): number {
    return this.#cells.size + this.#transparentCellIds.size;
  }

  get submittedCellCount(): number {
    return this.#active?.submittedCellIds.length ?? 0;
  }

  get missingCellCount(): number {
    return this.#missingCellIds.length;
  }

  get atomicCommitCount(): number {
    return this.#atomicCommitCount;
  }

  get meshCreationCount(): number {
    return this.#quadPoolCapacity * 2;
  }

  get shaderCreationCount(): number {
    return this.#shaderCreationCount;
  }

  get geometryCreationCount(): 1 {
    return 1;
  }

  hasResidentCell(cellId: string): boolean {
    return this.#cells.has(cellId) || this.#transparentCellIds.has(cellId);
  }

  activeResidentCellIds(): readonly string[] {
    return this.#active?.residentCellIds ?? EMPTY_CELL_IDS;
  }

  getColdGestureSnapshot(): CompiledBroadSurfacePixiColdGestureSnapshotV2 {
    const active = this.#active;
    const activePlan = this.#activePlan;
    if (!active || !activePlan) {
      return {
        activeLevelIds: EMPTY_CELL_IDS,
        activeMipWeights: EMPTY_MIP_WEIGHTS,
        activeResidentCellIds: EMPTY_CELL_IDS,
        submittedCellIds: EMPTY_CELL_IDS,
        runtimeCellCompileCount: 0,
        runtimeDurableWriteCount: 0,
      };
    }
    const activeLevelIds = Object.freeze(
      activePlan.activeLevels.map((level) => `${level.role}:L${level.level}`)
    );
    const activeMipWeights =
      activePlan.activeLevels.length === 1
        ? Object.freeze([1])
        : Object.freeze([1 - this.#activeLodMix, this.#activeLodMix]);
    return {
      activeLevelIds,
      activeMipWeights,
      activeResidentCellIds: active.residentCellIds,
      submittedCellIds: active.submittedCellIds,
      runtimeCellCompileCount: 0,
      runtimeDurableWriteCount: 0,
    };
  }

  admitCellTexture(
    input: CompiledBroadSurfaceDecodedCellTextureV2
  ): CompiledBroadSurfaceCellAdmissionResultV2 {
    if (this.#destroyed) return rejectedAdmission(null, 'presenter-destroyed');
    let cellId: string;
    try {
      cellId = compiledBroadSurfaceCellIdV2({
        manifest: this.#manifest,
        isoformMode: input.isoformMode,
        level: input.level,
        tileX: input.tileX,
        laneSlabIndex: input.laneSlabIndex,
      });
    } catch (error) {
      return rejectedAdmission(null, message(error));
    }
    const failure = this.#textureFailure(input.texture);
    if (failure) return rejectedAdmission(cellId, failure);
    const existing = this.#cells.get(cellId);
    if (this.#transparentCellIds.has(cellId)) {
      return rejectedAdmission(cellId, 'immutable-cell-address-conflict');
    }
    if (existing) {
      return existing.texture === input.texture
        ? Object.freeze({ status: 'already-resident', cellId })
        : rejectedAdmission(cellId, 'immutable-cell-address-conflict');
    }
    const invalidate = () => this.#invalidateCell(cellId);
    const texture = input.texture;
    texture.on('update', invalidate);
    texture.on('destroy', invalidate);
    texture.source.on('update', invalidate);
    texture.source.on('resize', invalidate);
    texture.source.on('destroy', invalidate);
    texture.source.on('styleChange', invalidate);
    texture.source.on('unload', invalidate);
    const record = Object.freeze({
      cellId,
      isoformMode: input.isoformMode,
      level: input.level,
      tileX: input.tileX,
      laneSlabIndex: input.laneSlabIndex,
      texture,
      invalidate,
    });
    this.#cells.set(cellId, record);
    this.#textureAdmissionCount += 1;
    this.#recordResidentHighWater();
    return Object.freeze({ status: 'admitted', cellId });
  }

  admitTransparentCell(
    input: CompiledBroadSurfaceTransparentCellV2
  ): CompiledBroadSurfaceCellAdmissionResultV2 {
    if (this.#destroyed) return rejectedAdmission(null, 'presenter-destroyed');
    let cellId: string;
    try {
      cellId = compiledBroadSurfaceCellIdV2({ manifest: this.#manifest, ...input });
    } catch (error) {
      return rejectedAdmission(null, message(error));
    }
    if (this.#cells.has(cellId)) {
      return rejectedAdmission(cellId, 'immutable-cell-address-conflict');
    }
    if (this.#transparentCellIds.has(cellId)) {
      return Object.freeze({ status: 'already-resident', cellId });
    }
    this.#transparentCellIds.add(cellId);
    this.#transparentCellAdmissionCount += 1;
    this.#recordResidentHighWater();
    return Object.freeze({ status: 'admitted', cellId });
  }

  reservePresentationCapacity(plan: BroadSurfacePresentationPlanV2): boolean {
    if (this.#destroyed || this.#planFailure(plan)) return false;
    const requiredCapacity =
      plan.activeLevels[0].visibleTilePlacements.length * plan.submittedLaneSlabIds.length;
    if (!Number.isSafeInteger(requiredCapacity) || requiredCapacity <= 0) return false;
    if (
      this.#corridorLaneRowHighWater > 0 &&
      plan.laneCrop.visibleLaneRowCount > this.#corridorLaneRowHighWater
    ) {
      return false;
    }
    if (requiredCapacity <= this.#quadPoolCapacity) return true;
    if (this.#corridorLaneRowHighWater > 0) return false;
    for (const bank of this.#quadBanks) this.#growQuadBank(bank, requiredCapacity);
    this.#quadPoolCapacity = requiredCapacity;
    return true;
  }

  reserveCorridorPresentationCapacity(input: {
    readonly viewportCssWidthPx: number;
    readonly devicePixelRatio: number;
    readonly maximumLaneLimit: number;
  }): boolean {
    if (this.#destroyed) return false;
    let viewportPhysicalWidthPx: number;
    let maximumLaneLimit: number;
    try {
      viewportPhysicalWidthPx =
        positiveFinite(input.viewportCssWidthPx, 'viewportCssWidthPx') *
        positiveFinite(input.devicePixelRatio, 'devicePixelRatio');
      maximumLaneLimit = positiveSafeInteger(input.maximumLaneLimit, 'maximumLaneLimit');
    } catch {
      return false;
    }
    this.#corridorViewportPhysicalWidthHighWater = Math.max(
      this.#corridorViewportPhysicalWidthHighWater,
      viewportPhysicalWidthPx
    );
    this.#corridorLaneRowHighWater = Math.max(
      this.#corridorLaneRowHighWater,
      Math.min(
        maximumLaneLimit,
        Math.max(this.#manifest.laneRowCounts.canonical, this.#manifest.laneRowCounts.expanded)
      )
    );
    const minimumProjectedFineTileWidthPx = this.#manifest.broadTilePhysicalWidthPx / 2;
    const maximumVisibleFineTileCount = Math.min(
      this.#manifest.levels[0].tileCount,
      Math.ceil(this.#corridorViewportPhysicalWidthHighWater / minimumProjectedFineTileWidthPx) + 2
    );
    const maximumLaneSlabCount = Math.ceil(
      this.#corridorLaneRowHighWater / this.#manifest.laneSlabRowCount
    );
    const requiredCapacity = maximumVisibleFineTileCount * maximumLaneSlabCount;
    if (!Number.isSafeInteger(requiredCapacity) || requiredCapacity <= 0) return false;
    if (requiredCapacity <= this.#quadPoolCapacity) return true;
    for (const bank of this.#quadBanks) this.#growQuadBank(bank, requiredCapacity);
    this.#quadPoolCapacity = requiredCapacity;
    return true;
  }

  evictCellsExcept(requestedCellIds: ReadonlySet<string>): readonly string[] {
    if (this.#destroyed) return Object.freeze([]);
    const keep = new Set(requestedCellIds);
    for (const cellId of this.#active?.residentCellIds ?? []) keep.add(cellId);
    for (const cellId of this.#staged?.residentCellIds ?? []) keep.add(cellId);
    const evicted: string[] = [];
    for (const [cellId, record] of this.#cells) {
      if (keep.has(cellId)) continue;
      this.#removeInvalidationListeners(record);
      this.#cells.delete(cellId);
      this.#evictTexturePairBindingsForCell(cellId);
      evicted.push(cellId);
    }
    for (const cellId of this.#transparentCellIds) {
      if (keep.has(cellId)) continue;
      this.#transparentCellIds.delete(cellId);
      this.#evictTexturePairBindingsForCell(cellId);
      evicted.push(cellId);
    }
    this.#cellEvictionCount += evicted.length;
    return Object.freeze(evicted);
  }

  stagePresentation(plan: BroadSurfacePresentationPlanV2): CompiledBroadSurfaceStageResultV2 {
    if (this.#destroyed)
      return Object.freeze({ status: 'rejected', reason: 'presenter-destroyed' });
    const planFailure = this.#planFailure(plan);
    if (planFailure) {
      this.#lastFailure = planFailure;
      this.#holdingLastGood = this.#active !== null;
      return Object.freeze({ status: 'rejected', reason: planFailure });
    }
    if (this.#active && this.#sceneMatchesPlan(this.#active, plan)) {
      this.#missingCellIds = Object.freeze([]);
      this.#lastFailure = null;
      this.#holdingLastGood = false;
      return Object.freeze({ status: 'already-active' });
    }
    const submittedCellIds = plan.activeSubmittedSurfaceCellIds;
    const missingCellIds = Object.freeze(
      submittedCellIds.filter((cellId) => !this.#isCellComplete(cellId))
    );
    if (missingCellIds.length > 0) {
      this.#discardStaged();
      this.#missingCellIds = missingCellIds;
      this.#lastFailure = 'required-raster-cells-missing';
      this.#holdingLastGood = this.#active !== null;
      return Object.freeze({ status: 'missing-cells', missingCellIds });
    }
    try {
      this.#discardStaged();
      const scene = this.#buildScene(plan, submittedCellIds);
      this.#staged = scene;
      this.#missingCellIds = Object.freeze([]);
      this.#lastFailure = null;
      this.#holdingLastGood = this.#active !== null;
      this.#stagedSceneBuildCount += 1;
      return Object.freeze({ status: 'staged', receipt: scene.receipt });
    } catch (error) {
      this.#discardStaged();
      const reason = message(error);
      this.#lastFailure = reason;
      this.#holdingLastGood = this.#active !== null;
      return Object.freeze({ status: 'rejected', reason });
    }
  }

  discardStagedPresentation(receipt: StagedCompiledBroadSurfacePixiPresentationV2): boolean {
    if (this.#destroyed || this.#staged?.receipt !== receipt) return false;
    this.#discardStaged();
    this.#holdingLastGood = this.#active !== null;
    return true;
  }

  canCommitStagedPresentation(
    receipt: StagedCompiledBroadSurfacePixiPresentationV2,
    camera?: CompiledBroadSurfacePixiCameraV2
  ): boolean {
    return this.#preflightStagedPresentationCommit(receipt, camera).status === 'ready';
  }

  commitStagedPresentation(
    receipt: StagedCompiledBroadSurfacePixiPresentationV2,
    camera?: CompiledBroadSurfacePixiCameraV2
  ): boolean {
    this.#activeTopologyCoversLastCamera = false;
    const preflight = this.#preflightStagedPresentationCommit(receipt, camera);
    if (preflight.status === 'rejected') {
      if (preflight.reason) this.#lastFailure = preflight.reason;
      if (preflight.discardStaged) {
        this.#holdingLastGood = this.#active !== null;
        this.#discardStaged();
      }
      return false;
    }

    const { staged, plan: committedPlan, preparedCamera } = preflight;
    if (camera && preparedCamera) {
      this.#lastCamera = preparedCamera.camera;
      this.#hidden = false;
    }
    if (preparedCamera) this.#applyPreparedStagedCameraCommit(preparedCamera);

    const previous = this.#active;
    staged.root.visible = false;
    this.container.addChild(staged.root);
    if (previous) previous.root.visible = false;
    staged.root.visible = !this.#hidden && this.#lastCamera !== null;
    this.#active = staged;
    this.#activePlan = committedPlan;
    this.#activeLodMix = this.#activePlan.lodMix;
    this.#staged = null;
    this.container.visible = staged.root.visible;
    this.#holdingLastGood = false;
    this.#lastFailure = null;
    this.#missingCellIds = Object.freeze([]);
    this.#atomicCommitCount += 1;
    this.#activeTopologyCoversLastCamera = this.#lastCamera !== null && !this.#hidden;
    if (previous) this.#releaseScene(previous);
    return true;
  }

  updateCamera(camera: CompiledBroadSurfacePixiCameraV2): boolean {
    this.#activeTopologyCoversLastCamera = false;
    if (this.#destroyed || !this.#active) return false;
    const value = cameraWithoutPlan(camera);
    this.#lastCamera = value;
    this.#hidden = false;
    if (!this.#sceneMatchesPlan(this.#active, camera.plan)) {
      this.#applyCamera(this.#active, this.#activePlan ?? this.#active.plan, value);
      this.#active.root.visible = true;
      this.container.visible = true;
      this.#holdingLastGood = true;
      this.#lastFailure = 'camera-plan-not-staged';
      return false;
    }
    this.#applyCamera(this.#active, camera.plan, value);
    this.#activePlan = camera.plan;
    this.#activeLodMix = camera.plan.lodMix;
    this.#active.root.visible = true;
    this.container.visible = true;
    this.#holdingLastGood = false;
    this.#lastFailure = null;
    if (this.#missingCellIds.length > 0) this.#missingCellIds = Object.freeze([]);
    this.#activeTopologyCoversLastCamera = true;
    return true;
  }

  updateCameraWithinActiveTopology(input: {
    readonly isoformMode: BroadSurfaceIsoformModeV2;
    readonly laneLimit: number | null;
    readonly viewportStartBp: number;
    readonly viewportEndBp: number;
    readonly devicePixelRatio: number;
    readonly contract: ViewerRenderContract;
    readonly trackTopCssPx: number;
    readonly viewportCssWidthPx: number;
    readonly viewportCssHeightPx: number;
    readonly themeMode: WebGLThemeMode;
    readonly rolePalette?: AnnotationRolePaletteOverridesV1;
  }): boolean {
    this.#activeTopologyCoversLastCamera = false;
    const scene = this.#active;
    const activePlan = this.#activePlan;
    if (
      this.#destroyed ||
      !scene ||
      !activePlan ||
      activePlan.isoformMode !== input.isoformMode ||
      activePlan.laneLimit !== input.laneLimit ||
      input.devicePixelRatio > this.#manifest.rasterDevicePixelRatio
    ) {
      return false;
    }
    let nativeLevelPosition: number | null;
    try {
      const spanBp = positiveFinite(input.viewportEndBp - input.viewportStartBp, 'viewportSpanBp');
      nativeLevelPosition = broadSurfaceNativeLevelPositionV2({
        manifest: this.#manifest,
        viewportSpanBp: spanBp,
        viewportPhysicalWidthPx:
          positiveFinite(input.viewportCssWidthPx, 'viewportCssWidthPx') *
          positiveFinite(input.devicePixelRatio, 'devicePixelRatio'),
      });
    } catch {
      return false;
    }
    if (nativeLevelPosition === null) return false;
    const firstRole = broadSurfaceMipRoleV2(nativeLevelPosition);
    const firstLevel =
      firstRole === 'single' ? Math.round(nativeLevelPosition) : Math.floor(nativeLevelPosition);
    const lodMix = broadSurfaceLodMixV2(this.#manifest, nativeLevelPosition);
    const expectedLevelCount = lodMix > 0 ? 2 : 1;
    if (activePlan.activeLevels.length !== expectedLevelCount) return false;
    for (let index = 0; index < expectedLevelCount; index += 1) {
      const expectedLevel = firstLevel + index;
      const expectedRole = index === 0 ? firstRole : 'coarser';
      const activeLevel = activePlan.activeLevels[index];
      const manifestLevel = this.#manifest.levels[expectedLevel];
      if (
        !manifestLevel ||
        activeLevel.level !== expectedLevel ||
        activeLevel.role !== expectedRole
      ) {
        return false;
      }
      const firstVisible = Math.min(
        manifestLevel.tileCount - 1,
        Math.max(0, Math.floor(input.viewportStartBp / manifestLevel.tileSpanBp))
      );
      const lastVisible = Math.min(
        manifestLevel.tileCount - 1,
        Math.max(firstVisible, Math.ceil(input.viewportEndBp / manifestLevel.tileSpanBp) - 1)
      );
      const placements = activeLevel.visibleTilePlacements;
      if (
        placements.length !== lastVisible - firstVisible + 1 ||
        placements[0]?.tileX !== firstVisible ||
        placements[placements.length - 1]?.tileX !== lastVisible
      ) {
        return false;
      }
    }
    this.#lastCamera = input;
    this.#hidden = false;
    this.#applyCameraWithLodMix(scene, lodMix, input);
    this.#activeLodMix = lodMix;
    scene.root.visible = true;
    this.container.visible = true;
    this.#holdingLastGood = false;
    this.#lastFailure = null;
    if (this.#missingCellIds.length > 0) this.#missingCellIds = Object.freeze([]);
    this.#activeTopologyCoversLastCamera = true;
    return true;
  }

  hide(): void {
    this.#activeTopologyCoversLastCamera = false;
    this.#hidden = true;
    if (this.#active) this.#active.root.visible = false;
    this.container.visible = false;
  }

  getReadinessDiagnostics(): CompiledBroadSurfacePixiReadinessDiagnosticsV2 {
    const active = this.#active;
    const activePlan = this.#activePlan;
    return Object.freeze({
      contract: COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2,
      manifestFingerprint: this.#manifest.manifestFingerprint,
      trackId: this.#manifest.trackId,
      presenting: this.isPresenting,
      holdingLastGood: this.#holdingLastGood,
      runtimeThemeMode: this.#runtimeThemeMode,
      activeIsoformMode: activePlan?.isoformMode ?? null,
      activeLaneLimit: activePlan?.laneLimit ?? null,
      activeResidentCellCount: active?.residentCellIds.length ?? 0,
      submittedCellCount: active?.submittedCellIds.length ?? 0,
      missingCellCount: this.#missingCellIds.length,
      presentedQuadCount: active?.quads.length ?? 0,
      runtimeCellCompileCount: 0,
      runtimeDurableWriteCount: 0,
      textureAdmissionCount: this.#textureAdmissionCount,
      transparentCellAdmissionCount: this.#transparentCellAdmissionCount,
      residentTextureCellCount: this.#cells.size,
      residentTransparentCellCount: this.#transparentCellIds.size,
      lastFailure: this.#lastFailure,
    });
  }

  diagnostics(): CompiledBroadSurfacePixiDiagnosticsV2 {
    const active = this.#active;
    const activePlan = this.#activePlan;
    return Object.freeze({
      contract: COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2,
      manifestFingerprint: this.#manifest.manifestFingerprint,
      trackId: this.#manifest.trackId,
      presenting: this.isPresenting,
      holdingLastGood: this.#holdingLastGood,
      runtimeThemeMode: this.#runtimeThemeMode,
      activeIsoformMode: activePlan?.isoformMode ?? null,
      activeLaneLimit: activePlan?.laneLimit ?? null,
      activeLevelIds: Object.freeze(
        activePlan?.activeLevels.map((level) => `${level.role}:L${level.level}`) ?? []
      ),
      activeMipWeights: Object.freeze(
        activePlan?.activeLevels.map((level) => level.sampleWeight) ?? []
      ),
      activeLevels: Object.freeze(
        activePlan?.activeLevels.map((level) =>
          Object.freeze({
            role: level.role,
            level: level.level,
            tileSpanBp: level.tileSpanBp,
            sampleWeight: level.sampleWeight,
            projectedTilePhysicalWidthPx: level.projectedTilePhysicalWidthPx,
            rasterMagnificationX: level.rasterMagnificationX,
          })
        ) ?? []
      ),
      maxQualifiedRasterMagnificationX: this.#manifest.maxQualifiedRasterMagnificationX,
      residentCellIds: Object.freeze([...this.#cells.keys(), ...this.#transparentCellIds].sort()),
      activeResidentCellIds: active?.residentCellIds ?? Object.freeze([]),
      submittedCellIds: active?.submittedCellIds ?? Object.freeze([]),
      missingCellIds: this.#missingCellIds,
      presentedQuads: Object.freeze(
        active?.quads.map((quad) =>
          Object.freeze({
            finerCellId: quad.finerCellId,
            coarserCellId: quad.coarserCellId,
            laneSlabIndex: quad.laneSlabIndex,
            visibleLaneRowCount: quad.visibleLaneRowCount,
            destinationStartBp: quad.placement?.destinationStartBp ?? 0,
            destinationEndBpExclusive: quad.placement?.destinationEndBpExclusive ?? 0,
            destinationTopCssPx: quad.uniforms.uRectPx[1],
            destinationHeightCssPx: quad.uniforms.uRectPx[3],
            finerUvRect: quad.finerUvRect,
            coarserUvRect: quad.coarserUvRect,
          })
        ) ?? []
      ),
      broadVectorSubmissionCount: 0,
      runtimeCellCompileCount: 0,
      runtimeDurableWriteCount: 0,
      textureAdmissionCount: this.#textureAdmissionCount,
      transparentCellAdmissionCount: this.#transparentCellAdmissionCount,
      residentTextureCellCount: this.#cells.size,
      residentTransparentCellCount: this.#transparentCellIds.size,
      residentCellHighWater: this.#residentCellHighWater,
      residentTextureCellHighWater: this.#residentTextureCellHighWater,
      cellEvictionCount: this.#cellEvictionCount,
      stagedSceneBuildCount: this.#stagedSceneBuildCount,
      atomicCommitCount: this.#atomicCommitCount,
      cameraTransformUpdateCount: this.#cameraTransformUpdateCount,
      quadPoolCapacity: this.#quadPoolCapacity,
      meshCreationCount: this.meshCreationCount,
      shaderCreationCount: this.shaderCreationCount,
      geometryCreationCount: this.geometryCreationCount,
      lastFailure: this.#lastFailure,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#activeTopologyCoversLastCamera = false;
    this.#discardStaged();
    if (this.#active) this.#releaseScene(this.#active);
    this.#active = null;
    this.#activePlan = null;
    this.#activeLodMix = 0;
    for (const record of this.#cells.values()) this.#removeInvalidationListeners(record);
    this.#cells.clear();
    this.#transparentCellIds.clear();
    for (const bank of this.#quadBanks) {
      for (const slot of bank.slots) {
        slot.mesh.destroy();
        slot.placeholderBinding.shader.destroy(false);
      }
      for (const binding of bank.bindings.values()) binding.shader.destroy(false);
      bank.bindings.clear();
      bank.root.destroy();
    }
    this.#geometry.destroy();
    this.container.destroy();
  }

  #textureFailure(texture: Texture): string | null {
    if (!texture?.isTexture || texture.destroyed || texture.source?.destroyed) {
      return 'decoded-cell-texture-is-not-live';
    }
    if (texture.dynamic) return 'decoded-cell-texture-is-mutable';
    const source = texture.source;
    const expectedWidth =
      this.#manifest.broadTilePhysicalWidthPx + this.#manifest.broadTileXGuardPhysicalPx * 2;
    const expectedHeight = this.#manifest.laneSlabRowCount * this.#manifest.laneRowTextureStridePx;
    if (
      source.resolution !== 1 ||
      source.width !== expectedWidth ||
      source.height !== expectedHeight ||
      source.pixelWidth !== expectedWidth ||
      source.pixelHeight !== expectedHeight
    ) {
      return 'decoded-cell-texture-physical-geometry-mismatch';
    }
    if (
      texture.frame.x !== 0 ||
      texture.frame.y !== 0 ||
      texture.frame.width !== source.width ||
      texture.frame.height !== source.height
    ) {
      return 'decoded-cell-texture-must-cover-full-cell-source';
    }
    return null;
  }

  #planFailure(plan: BroadSurfacePresentationPlanV2): string | null {
    if (!isAdmittedBroadSurfacePresentationPlanV2(plan)) {
      return 'broad-presentation-plan-is-not-admitted';
    }
    if (
      plan.manifestFingerprint !== this.#manifest.manifestFingerprint ||
      plan.artifactKey !== this.#manifest.artifactKey ||
      plan.trackId !== this.#manifest.trackId
    ) {
      return 'broad-presentation-plan-owner-mismatch';
    }
    return null;
  }

  #buildScene(
    plan: BroadSurfacePresentationPlanV2,
    submittedCellIds: readonly string[]
  ): PreparedScene {
    const bank = this.#inactiveQuadBank();
    const root = bank.root;
    root.visible = false;
    root.label = `compiled-broad-surface:${plan.trackId}:${plan.isoformMode}`;
    const residentRecords = new Map<string, CellTextureRecord>();
    const transparentCellIds = new Set<string>();
    for (const cellId of submittedCellIds) {
      const record = this.#cells.get(cellId);
      if (record) residentRecords.set(cellId, record);
      else if (this.#transparentCellIds.has(cellId)) transparentCellIds.add(cellId);
      else throw new Error(`required-raster-cell-disappeared:${cellId}`);
    }
    const finer = plan.activeLevels[0];
    const coarser = plan.activeLevels[1] ?? null;
    const maximumQuadCount = finer.visibleTilePlacements.length * plan.submittedLaneSlabIds.length;
    if (maximumQuadCount > bank.slots.length) {
      throw new Error('compiled broad surface quad pool capacity exceeded');
    }
    let quadIndex = 0;
    try {
      for (const placement of finer.visibleTilePlacements) {
        const coarserPlacement = coarser
          ? exactBroadSurfaceTilePlacementV2({
              manifest: this.#manifest,
              level: coarser.level,
              tileX: Math.floor(placement.nominalStartBp / coarser.tileSpanBp),
            })
          : placement;
        for (
          let laneSlabIndex = 0;
          laneSlabIndex < plan.submittedLaneSlabIds.length;
          laneSlabIndex += 1
        ) {
          const visibleLaneRowCount =
            laneSlabIndex === plan.laneCrop.finalSlabIndex
              ? plan.laneCrop.finalSlabVisibleRowCount
              : this.#manifest.laneSlabRowCount;
          const finerCellId = compiledBroadSurfaceCellIdV2({
            manifest: this.#manifest,
            isoformMode: plan.isoformMode,
            level: placement.level,
            tileX: placement.tileX,
            laneSlabIndex,
          });
          const coarserCellId = coarser
            ? compiledBroadSurfaceCellIdV2({
                manifest: this.#manifest,
                isoformMode: plan.isoformMode,
                level: coarserPlacement.level,
                tileX: coarserPlacement.tileX,
                laneSlabIndex,
              })
            : finerCellId;
          const finerRecord = residentRecords.get(finerCellId);
          const coarserRecord = residentRecords.get(coarserCellId);
          const finerTransparent = transparentCellIds.has(finerCellId);
          const coarserTransparent = transparentCellIds.has(coarserCellId);
          if ((!finerRecord && !finerTransparent) || (!coarserRecord && !coarserTransparent)) {
            throw new Error('visible-raster-cell-is-not-in-complete-resident-roster');
          }
          if (finerTransparent && coarserTransparent) continue;
          const finerUvRect = this.#finerUvRect(visibleLaneRowCount);
          const coarserUvRect = this.#coarserUvRect(
            placement,
            coarserPlacement,
            visibleLaneRowCount
          );
          const slot = bank.slots[quadIndex++];
          const binding = this.#texturePairBinding(
            bank,
            finerCellId,
            coarserCellId,
            finerRecord?.texture.source ?? PixiTexture.EMPTY.source,
            coarserRecord?.texture.source ?? PixiTexture.EMPTY.source
          );
          slot.mesh.shader = binding.shader;
          slot.binding = binding;
          slot.shader = binding.shader;
          slot.uniforms = binding.uniforms;
          slot.finerCellId = finerCellId;
          slot.coarserCellId = coarserCellId;
          slot.laneSlabIndex = laneSlabIndex;
          slot.visibleLaneRowCount = visibleLaneRowCount;
          slot.placement = placement;
          slot.finerUvRect = finerUvRect;
          slot.coarserUvRect = coarserUvRect;
          slot.uniforms.uFinerUvRect.set(finerUvRect);
          slot.uniforms.uCoarserUvRect.set(coarserUvRect);
          slot.uniforms.uLodMix = coarser?.sampleWeight ?? 0;
          slot.mesh.label = `${COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2}:${finerCellId}`;
          slot.mesh.visible = true;
        }
      }
    } catch (error) {
      this.#clearQuadBank(bank);
      throw error;
    }
    for (let index = quadIndex; index < bank.slots.length; index += 1) {
      bank.slots[index].mesh.visible = false;
    }
    const quads = bank.slots.slice(0, quadIndex);
    const receipt = Object.freeze({
      contract: STAGED_COMPILED_BROAD_SURFACE_PIXI_PRESENTATION_V2,
      stageId: ++this.#stageId,
      manifestFingerprint: plan.manifestFingerprint,
      trackId: plan.trackId,
      isoformMode: plan.isoformMode,
      laneLimit: plan.laneLimit,
      residentCellIds: submittedCellIds,
      submittedCellIds,
    });
    return {
      receipt,
      root,
      plan,
      residentCellIds: submittedCellIds,
      submittedCellIds,
      residentRecords,
      transparentCellIds,
      quads: Object.freeze(quads),
      bank,
    };
  }

  #createQuadBank(bankIndex: number): QuadBank {
    const root = new Container();
    root.eventMode = 'none';
    root.visible = false;
    root.label = `${COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2}:bank:${bankIndex}`;
    const slots: PresentedQuad[] = [];
    this.container.addChild(root);
    return { root, slots, bindings: new Map() };
  }

  #growQuadBank(bank: QuadBank, requiredCapacity: number): void {
    const slots = bank.slots as PresentedQuad[];
    for (let index = slots.length; index < requiredCapacity; index += 1) {
      const placeholderBinding = this.#createTexturePairBinding(
        `placeholder:${index}`,
        '',
        '',
        PixiTexture.EMPTY.source,
        PixiTexture.EMPTY.source
      );
      const mesh = new Mesh<Geometry, Shader>({
        geometry: this.#geometry,
        shader: placeholderBinding.shader,
        state: State.for2d(),
      });
      mesh.eventMode = 'none';
      mesh.visible = false;
      bank.root.addChild(mesh);
      slots.push({
        mesh,
        placeholderBinding,
        binding: placeholderBinding,
        shader: placeholderBinding.shader,
        uniforms: placeholderBinding.uniforms,
        finerCellId: '',
        coarserCellId: '',
        laneSlabIndex: 0,
        visibleLaneRowCount: 0,
        placement: null,
        finerUvRect: Object.freeze([0, 0, 0, 0]),
        coarserUvRect: Object.freeze([0, 0, 0, 0]),
      });
    }
  }

  #inactiveQuadBank(): QuadBank {
    const activeBank = this.#active?.bank ?? null;
    return activeBank === this.#quadBanks[0] ? this.#quadBanks[1] : this.#quadBanks[0];
  }

  #clearQuadBank(bank: QuadBank): void {
    bank.root.visible = false;
    for (const slot of bank.slots) {
      slot.mesh.visible = false;
      slot.placement = null;
      slot.finerCellId = '';
      slot.coarserCellId = '';
    }
  }

  #texturePairBinding(
    bank: QuadBank,
    finerCellId: string,
    coarserCellId: string,
    finerSource: Texture['source'],
    coarserSource: Texture['source']
  ): ImmutableTexturePairBinding {
    const key = `${finerCellId}\u0000${coarserCellId}`;
    const existing = bank.bindings.get(key);
    if (existing) return existing;
    const binding = this.#createTexturePairBinding(
      key,
      finerCellId,
      coarserCellId,
      finerSource,
      coarserSource
    );
    bank.bindings.set(key, binding);
    return binding;
  }

  #createTexturePairBinding(
    key: string,
    finerCellId: string,
    coarserCellId: string,
    finerSource: Texture['source'],
    coarserSource: Texture['source']
  ): ImmutableTexturePairBinding {
    const runtimeTheme = indexedAnnotationRuntimeThemeUniforms(this.#manifest.trackId, 'light');
    const uniforms: BroadSurfaceShaderUniforms = {
      uRectPx: new Float32Array(4),
      uViewportPx: new Float32Array(2),
      uFinerUvRect: new Float32Array(4),
      uCoarserUvRect: new Float32Array(4),
      uLodMix: 0,
      uAnnotationThemeDark: runtimeTheme.themeDark,
      uAnnotationTranscriptPalette: runtimeTheme.transcriptPalette,
      uAnnotationRnaPalette: runtimeTheme.rnaPalette,
      uRolePalette: new Float32Array(
        this.#rolePalette(this.#runtimeThemeMode, this.#rolePaletteOverrides)
      ),
    };
    const shader = new Shader({
      glProgram: this.#program,
      resources: {
        uFinerTexture: finerSource,
        uCoarserTexture: coarserSource,
        broadSurfaceUniforms: {
          uRectPx: { value: uniforms.uRectPx, type: 'vec4<f32>' },
          uViewportPx: { value: uniforms.uViewportPx, type: 'vec2<f32>' },
          uFinerUvRect: { value: uniforms.uFinerUvRect, type: 'vec4<f32>' },
          uCoarserUvRect: { value: uniforms.uCoarserUvRect, type: 'vec4<f32>' },
          uLodMix: { value: uniforms.uLodMix, type: 'f32' },
          uAnnotationThemeDark: { value: uniforms.uAnnotationThemeDark, type: 'f32' },
          uAnnotationTranscriptPalette: {
            value: uniforms.uAnnotationTranscriptPalette,
            type: 'f32',
          },
          uAnnotationRnaPalette: { value: uniforms.uAnnotationRnaPalette, type: 'f32' },
          ...(this.#roleTable
            ? { uRolePalette: { value: uniforms.uRolePalette, type: 'mat4x4<f32>' } }
            : {}),
        },
      },
    });
    this.#shaderCreationCount += 1;
    return Object.freeze({ key, finerCellId, coarserCellId, shader, uniforms });
  }

  #evictTexturePairBindingsForCell(cellId: string): void {
    for (const bank of this.#quadBanks) {
      for (const [key, binding] of bank.bindings) {
        if (binding.finerCellId !== cellId && binding.coarserCellId !== cellId) continue;
        for (const slot of bank.slots) {
          if (slot.binding !== binding) continue;
          slot.mesh.shader = slot.placeholderBinding.shader;
          slot.binding = slot.placeholderBinding;
          slot.shader = slot.placeholderBinding.shader;
          slot.uniforms = slot.placeholderBinding.uniforms;
        }
        binding.shader.destroy(false);
        bank.bindings.delete(key);
      }
    }
  }

  #finerUvRect(visibleLaneRowCount: number): readonly [number, number, number, number] {
    const storedWidth =
      this.#manifest.broadTilePhysicalWidthPx + this.#manifest.broadTileXGuardPhysicalPx * 2;
    const storedHeight = this.#manifest.laneSlabRowCount * this.#manifest.laneRowTextureStridePx;
    const contentStart = this.#manifest.broadTileXGuardPhysicalPx / storedWidth;
    const contentEnd =
      (this.#manifest.broadTileXGuardPhysicalPx + this.#manifest.broadTilePhysicalWidthPx) /
      storedWidth;
    const vEnd = (visibleLaneRowCount * this.#manifest.laneRowTextureStridePx) / storedHeight;
    return Object.freeze([contentStart, vEnd, contentEnd, 0]);
  }

  #coarserUvRect(
    finer: ExactBroadSurfaceTilePlacementV2,
    coarser: ExactBroadSurfaceTilePlacementV2,
    visibleLaneRowCount: number
  ): readonly [number, number, number, number] {
    const base = this.#finerUvRect(visibleLaneRowCount);
    const relativeStart =
      (finer.destinationStartBp - coarser.destinationStartBp) / coarser.destinationSpanBp;
    const relativeEnd =
      (finer.destinationEndBpExclusive - coarser.destinationStartBp) / coarser.destinationSpanBp;
    if (relativeStart < 0 || relativeEnd > 1 || relativeEnd <= relativeStart) {
      throw new Error('adjacent-mip-world-placement-is-not-dyadically-contained');
    }
    const contentWidth = base[2] - base[0];
    return Object.freeze([
      base[0] + relativeStart * contentWidth,
      base[1],
      base[0] + relativeEnd * contentWidth,
      base[3],
    ]);
  }

  #sceneMatchesPlan(scene: PreparedScene, plan: BroadSurfacePresentationPlanV2): boolean {
    if (this.#planFailure(plan)) return false;
    const active = scene.plan;
    if (
      active.isoformMode !== plan.isoformMode ||
      active.laneLimit !== plan.laneLimit ||
      !sameStrings(active.submittedLaneSlabIds, plan.submittedLaneSlabIds) ||
      active.activeLevels.length !== plan.activeLevels.length
    ) {
      return false;
    }
    for (let index = 0; index < active.activeLevels.length; index += 1) {
      const left = active.activeLevels[index];
      const right = plan.activeLevels[index];
      if (
        left.role !== right.role ||
        left.level !== right.level ||
        !sameStrings(left.visibleXTileIds, right.visibleXTileIds)
      ) {
        return false;
      }
    }
    return true;
  }

  #preflightStagedPresentationCommit(
    receipt: StagedCompiledBroadSurfacePixiPresentationV2,
    camera?: CompiledBroadSurfacePixiCameraV2
  ): StagedPresentationCommitPreflight {
    const staged = this.#staged;
    if (this.#destroyed || !staged || staged.receipt !== receipt) {
      return Object.freeze({ status: 'rejected', reason: null, discardStaged: false });
    }
    for (const [cellId, record] of staged.residentRecords) {
      if (this.#cells.get(cellId) !== record) {
        return Object.freeze({
          status: 'rejected',
          reason: 'staged-raster-cell-residency-changed',
          discardStaged: true,
        });
      }
    }
    for (const cellId of staged.transparentCellIds) {
      if (!this.#transparentCellIds.has(cellId)) {
        return Object.freeze({
          status: 'rejected',
          reason: 'staged-transparent-cell-residency-changed',
          discardStaged: true,
        });
      }
    }
    if (camera && !this.#sceneMatchesPlan(staged, camera.plan)) {
      return Object.freeze({
        status: 'rejected',
        reason: 'staged-camera-plan-mismatch',
        discardStaged: false,
      });
    }

    const committedPlan = camera?.plan ?? staged.plan;
    const cameraValue = camera ? cameraWithoutPlan(camera) : this.#lastCamera;
    try {
      return Object.freeze({
        status: 'ready',
        staged,
        plan: committedPlan,
        preparedCamera: cameraValue
          ? this.#prepareStagedCameraCommit(staged, committedPlan, cameraValue)
          : null,
      });
    } catch (error) {
      return Object.freeze({
        status: 'rejected',
        reason: `staged-camera-commit-failed:${message(error)}`,
        discardStaged: true,
      });
    }
  }

  #prepareStagedCameraCommit(
    scene: PreparedScene,
    plan: BroadSurfacePresentationPlanV2,
    camera: Omit<CompiledBroadSurfacePixiCameraV2, 'plan'>
  ): PreparedStagedCameraCommit {
    const viewportCssWidthPx = positiveFinite(camera.viewportCssWidthPx, 'viewportCssWidthPx');
    const viewportCssHeightPx = positiveFinite(camera.viewportCssHeightPx, 'viewportCssHeightPx');
    const trackTopCssPx = finite(camera.trackTopCssPx, 'trackTopCssPx');
    const projectedQuads = scene.quads.map((quad) => {
      const placement = quad.placement;
      if (!placement) throw new Error('compiled broad raster pooled quad is unconfigured');
      const xStart = finite(
        camera.contract.projectX(placement.destinationStartBp),
        'projected tile start'
      );
      const xEnd = finite(
        camera.contract.projectX(placement.destinationEndBpExclusive),
        'projected tile end'
      );
      if (xEnd <= xStart) throw new Error('projected broad raster tile is not forward');
      return Object.freeze({ quad, xStart, xEnd });
    });
    return Object.freeze({
      camera,
      viewportCssWidthPx,
      viewportCssHeightPx,
      trackTopCssPx,
      coarserWeight: plan.activeLevels[1]?.sampleWeight ?? 0,
      projectedQuads: Object.freeze(projectedQuads),
    });
  }

  #applyPreparedStagedCameraCommit(prepared: PreparedStagedCameraCommit): void {
    this.#runtimeThemeMode = prepared.camera.themeMode;
    for (const { quad, xStart, xEnd } of prepared.projectedQuads) {
      const rect = quad.uniforms.uRectPx;
      rect[0] = xStart;
      const firstLaneRow = quad.laneSlabIndex * this.#manifest.laneSlabRowCount;
      const highestVisibleLaneRow = firstLaneRow + quad.visibleLaneRowCount - 1;
      const asymmetricTailCorrectionCssPx =
        this.#manifest.laneRowTransparentTailGutterPx / this.#manifest.rasterDevicePixelRatio / 2;
      rect[1] =
        prepared.trackTopCssPx -
        highestVisibleLaneRow * this.#manifest.laneRowCssHeightPx -
        asymmetricTailCorrectionCssPx;
      rect[2] = xEnd - xStart;
      rect[3] = quad.visibleLaneRowCount * this.#manifest.laneRowCssHeightPx;
      quad.uniforms.uViewportPx[0] = prepared.viewportCssWidthPx;
      quad.uniforms.uViewportPx[1] = prepared.viewportCssHeightPx;
      quad.uniforms.uLodMix = prepared.coarserWeight;
      const runtimeTheme = indexedAnnotationRuntimeThemeUniforms(
        this.#manifest.trackId,
        prepared.camera.themeMode
      );
      quad.uniforms.uAnnotationThemeDark = runtimeTheme.themeDark;
      quad.uniforms.uAnnotationRnaPalette = runtimeTheme.rnaPalette;
      const shaderUniforms = (
        quad.shader.resources.broadSurfaceUniforms as { uniforms: BroadSurfaceShaderUniforms }
      ).uniforms;
      shaderUniforms.uLodMix = prepared.coarserWeight;
      shaderUniforms.uAnnotationThemeDark = runtimeTheme.themeDark;
      shaderUniforms.uAnnotationRnaPalette = runtimeTheme.rnaPalette;
      if (this.#roleTable) {
        shaderUniforms.uRolePalette.set(
          this.#rolePalette(prepared.camera.themeMode, prepared.camera.rolePalette)
        );
      }
    }
    this.#cameraTransformUpdateCount += 1;
  }

  #applyCamera(
    scene: PreparedScene,
    plan: BroadSurfacePresentationPlanV2,
    camera: Omit<CompiledBroadSurfacePixiCameraV2, 'plan'>
  ): void {
    this.#applyCameraWithLodMix(scene, plan.activeLevels[1]?.sampleWeight ?? 0, camera);
  }

  #applyCameraWithLodMix(
    scene: PreparedScene,
    coarserWeight: number,
    camera: Omit<CompiledBroadSurfacePixiCameraV2, 'plan'>
  ): void {
    this.#runtimeThemeMode = camera.themeMode;
    const width = positiveFinite(camera.viewportCssWidthPx, 'viewportCssWidthPx');
    const height = positiveFinite(camera.viewportCssHeightPx, 'viewportCssHeightPx');
    const trackTop = finite(camera.trackTopCssPx, 'trackTopCssPx');
    for (const quad of scene.quads) {
      const placement = quad.placement;
      if (!placement) throw new Error('compiled broad raster pooled quad is unconfigured');
      const xStart = finite(
        camera.contract.projectX(placement.destinationStartBp),
        'projected tile start'
      );
      const xEnd = finite(
        camera.contract.projectX(placement.destinationEndBpExclusive),
        'projected tile end'
      );
      if (xEnd <= xStart) throw new Error('projected broad raster tile is not forward');
      const rect = quad.uniforms.uRectPx;
      rect[0] = xStart;
      const firstLaneRow = quad.laneSlabIndex * this.#manifest.laneSlabRowCount;
      const highestVisibleLaneRow = firstLaneRow + quad.visibleLaneRowCount - 1;
      const asymmetricTailCorrectionCssPx =
        this.#manifest.laneRowTransparentTailGutterPx / this.#manifest.rasterDevicePixelRatio / 2;
      rect[1] =
        trackTop -
        highestVisibleLaneRow * this.#manifest.laneRowCssHeightPx -
        asymmetricTailCorrectionCssPx;
      rect[2] = xEnd - xStart;
      rect[3] = quad.visibleLaneRowCount * this.#manifest.laneRowCssHeightPx;
      quad.uniforms.uViewportPx[0] = width;
      quad.uniforms.uViewportPx[1] = height;
      quad.uniforms.uLodMix = coarserWeight;
      const runtimeTheme = indexedAnnotationRuntimeThemeUniforms(
        this.#manifest.trackId,
        camera.themeMode
      );
      quad.uniforms.uAnnotationThemeDark = runtimeTheme.themeDark;
      quad.uniforms.uAnnotationRnaPalette = runtimeTheme.rnaPalette;
      const shaderUniforms = (
        quad.shader.resources.broadSurfaceUniforms as { uniforms: BroadSurfaceShaderUniforms }
      ).uniforms;
      shaderUniforms.uLodMix = coarserWeight;
      shaderUniforms.uAnnotationThemeDark = runtimeTheme.themeDark;
      shaderUniforms.uAnnotationRnaPalette = runtimeTheme.rnaPalette;
      if (this.#roleTable) {
        shaderUniforms.uRolePalette.set(this.#rolePalette(camera.themeMode, camera.rolePalette));
      }
    }
    this.#cameraTransformUpdateCount += 1;
  }

  #rolePalette(
    theme: WebGLThemeMode,
    overrides: AnnotationRolePaletteOverridesV1 | undefined
  ): Float32Array {
    if (overrides !== this.#rolePaletteOverrides) {
      this.#rolePaletteOverrides = overrides;
      this.#rolePalettes.clear();
    }
    let palette = this.#rolePalettes.get(theme);
    if (!palette) {
      palette = this.#roleTable
        ? packAnnotationRolePaletteMat4V1(this.#roleTable, theme, overrides)
        : new Float32Array(16);
      this.#rolePalettes.set(theme, palette);
    }
    return palette;
  }

  #invalidateCell(cellId: string): void {
    const record = this.#cells.get(cellId);
    if (!record) return;
    this.#removeInvalidationListeners(record);
    this.#cells.delete(cellId);
    if (this.#staged?.residentRecords.get(cellId) === record) {
      this.#lastFailure = 'staged-raster-cell-invalidated';
      this.#discardStaged();
    }
    if (this.#active?.residentRecords.get(cellId) === record) {
      this.#lastFailure = 'active-raster-cell-invalidated';
      const active = this.#active;
      this.#active = null;
      this.#activePlan = null;
      this.#activeLodMix = 0;
      this.#releaseScene(active);
      this.container.visible = false;
      this.#holdingLastGood = false;
    }
    this.#evictTexturePairBindingsForCell(cellId);
  }

  #isCellComplete(cellId: string): boolean {
    return this.#cells.has(cellId) || this.#transparentCellIds.has(cellId);
  }

  #recordResidentHighWater(): void {
    this.#residentTextureCellHighWater = Math.max(
      this.#residentTextureCellHighWater,
      this.#cells.size
    );
    this.#residentCellHighWater = Math.max(
      this.#residentCellHighWater,
      this.#cells.size + this.#transparentCellIds.size
    );
  }

  #removeInvalidationListeners(record: CellTextureRecord): void {
    record.texture.off('update', record.invalidate);
    record.texture.off('destroy', record.invalidate);
    record.texture.source.off('update', record.invalidate);
    record.texture.source.off('resize', record.invalidate);
    record.texture.source.off('destroy', record.invalidate);
    record.texture.source.off('styleChange', record.invalidate);
    record.texture.source.off('unload', record.invalidate);
  }

  #discardStaged(): void {
    if (!this.#staged) return;
    const staged = this.#staged;
    this.#staged = null;
    this.#releaseScene(staged);
  }

  #releaseScene(scene: PreparedScene): void {
    this.#clearQuadBank(scene.bank);
  }
}

function cameraWithoutPlan(
  value: CompiledBroadSurfacePixiCameraV2
): Omit<CompiledBroadSurfacePixiCameraV2, 'plan'> {
  return Object.freeze({
    contract: value.contract,
    trackTopCssPx: value.trackTopCssPx,
    viewportCssWidthPx: value.viewportCssWidthPx,
    viewportCssHeightPx: value.viewportCssHeightPx,
    themeMode: value.themeMode,
    ...(value.rolePalette ? { rolePalette: value.rolePalette } : {}),
  });
}

function rejectedAdmission(
  cellId: string | null,
  reason: string
): CompiledBroadSurfaceCellAdmissionResultV2 {
  return Object.freeze({ status: 'rejected', cellId, reason });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
