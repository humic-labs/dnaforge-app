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
import {
  INDEXED_ANNOTATION_COLOR_BASIS_THEME,
  indexedAnnotationRuntimeThemeUniforms,
} from '../shared/annotation-runtime-theme';

import type { AnnotationResidentPageRecord } from '../../../annotation-resident-page-store';
import type { AnnotationTrackLayoutPlan } from '../../../geometry/annotation-track-layout-plan';
import type { WebGLThemeMode } from '../shared/theme';
import {
  compileResidentAnnotationPageBundle,
  type CompiledTranscriptPageBundle,
} from './compile-transcript-page-bundle';
import { bpCoordinateChunk, bpCoordinateDelta } from './bp-coordinate-packing';
import type { PrepackedAnnotationInteractionIndexV2 } from './prepacked-annotation-interaction-index-v2';
import { retainedSubpixelOpacityPolicy } from './retained-subpixel-aa';
import {
  TRANSCRIPT_FRAGMENT_SHADER,
  TRANSCRIPT_VERTEX_SHADER,
  type RetainedLinearTranscriptUniforms,
} from './retained-linear-transcript-layer';
import {
  TRANSCRIPT_GLYPH_INSTANCE_CORNERS,
  TRANSCRIPT_GLYPH_INSTANCE_LAYOUT,
} from './transcript-glyph-instances';
import type { TranscriptInstancePartition } from './partitioned-transcript-scene';
import type { ViewerRenderContract } from './viewer-render-contract';

export const RESIDENT_ANNOTATION_PAGE_SEMANTIC_OWNER =
  'resident-annotation-page-vector-surface' as const;

export interface ResidentAnnotationPageGpuVariant {
  readonly themeMode: WebGLThemeMode;
  readonly contextGeneration: number;
}

export interface CompileResidentAnnotationPageArtifactOptions extends ResidentAnnotationPageGpuVariant {
  readonly genomeLengthBp: number;
  readonly annotationBarHeightPx: number;
  readonly partitionSpanBp: number;
  readonly laneContractIdentity: string;
}

export interface ResidentAnnotationPageCpuArtifact {
  readonly gpuIdentityKey: string;
  readonly pageIdentityKey: string;
  readonly sourceIdentity: string;
  readonly policyKey: string;
  readonly pageKey: string;
  readonly contentRevision: string;
  readonly trackId: string;
  readonly trackOrder: number;
  readonly laneCapacity: number;
  readonly ownerStartBp: number;
  readonly ownerEndBp: number;
  readonly maxFeatureEndBp: number;
  readonly themeMode: WebGLThemeMode;
  readonly contextGeneration: number;
  readonly laneContractIdentity: string;
  readonly bundle: CompiledTranscriptPageBundle;
  readonly cpuByteSize: number;
  readonly gpuByteSize: number;
  readonly interactionIndex: PrepackedAnnotationInteractionIndexV2;
  readonly exactReady: boolean;
  readonly authorityStatus: 'page-local-exact' | 'shared-scene-required' | 'unsupported';
}

export interface ResidentAnnotationPageGpuPrepareRenderer {
  shader: {
    bind(shader: Shader): void;
    resetState(): void;
  };
  geometry: {
    bind(geometry: Geometry, program: GlProgram): void;
    resetState(): void;
  };
}

export interface ResidentAnnotationPageGpuBankOptions {
  readonly laneContractIdentity: string;
  readonly maxGpuPages?: number;
  readonly maxGpuBytes?: number;
  readonly telemetryLimit?: number;
  readonly now?: () => number;
}

export type ResidentAnnotationPageGpuPrepareResult =
  | {
      readonly status: 'prepared' | 'reused';
      readonly gpuIdentityKey: string;
      readonly empty: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly gpuIdentityKey: string;
      readonly reason: 'missing-cpu-artifact' | 'incomplete-page' | 'lane-contract-mismatch';
    };

export type ResidentAnnotationPageGpuTelemetryEvent = Readonly<{
  type:
    | 'cpu-build'
    | 'cpu-reuse'
    | 'gpu-prepare'
    | 'gpu-reuse'
    | 'gpu-eviction'
    | 'context-reset'
    | 'visibility-batch'
    | 'camera-update'
    | 'reject';
  cause: string;
  gpuIdentityKey: string | null;
  pageKey: string | null;
  trackId: string | null;
  durationMs: number;
  byteSize: number;
  gpuPageCount: number;
  gpuByteCount: number;
}>;

interface PagePartitionView {
  partition: TranscriptInstancePartition;
  geometry: Geometry;
  mesh: Mesh<Geometry, Shader>;
}

interface PreparedPage {
  artifact: ResidentAnnotationPageCpuArtifact;
  container: Container | null;
  instanceBuffer: PixiBuffer | null;
  views: PagePartitionView[];
  lastUsed: number;
}

interface TrackGpuOwner {
  trackId: string;
  viewportUniform: Float32Array;
  shader: Shader;
  cameraWriteCount: number;
}

export interface ResidentAnnotationPageGpuPageDebug {
  readonly gpuIdentityKey: string;
  readonly pageKey: string;
  readonly trackId: string;
  readonly empty: boolean;
  readonly visible: boolean;
  readonly instanceBufferIdentity: object | null;
  readonly interactionIndex: PrepackedAnnotationInteractionIndexV2;
  readonly instanceCount: number;
  readonly partitionCount: number;
}

export interface ResidentAnnotationPageGpuBankDebugSnapshot {
  readonly cpuArtifactCount: number;
  readonly gpuPageCount: number;
  readonly gpuByteCount: number;
  readonly gpuPrepareCount: number;
  readonly gpuUploadCount: number;
  readonly gpuEvictionCount: number;
  readonly visibilityBatchChanges: number;
  readonly cameraUpdates: number;
  readonly trackUniformWrites: number;
  readonly staticCornerBufferCreates: number;
  readonly trackShaderCreates: number;
  readonly activeContextGeneration: number | null;
  readonly visiblePageKeys: ReadonlyArray<string>;
}

export class ResidentAnnotationPageGpuBank {
  readonly semanticOwnerId = RESIDENT_ANNOTATION_PAGE_SEMANTIC_OWNER;
  readonly container = new Container();
  readonly laneContractIdentity: string;
  readonly maxGpuPages: number;
  readonly maxGpuBytes: number;

  private readonly now: () => number;
  private readonly telemetryLimit: number;
  private readonly cpuArtifacts = new Map<string, ResidentAnnotationPageCpuArtifact>();
  private readonly preparedPages = new Map<string, PreparedPage>();
  private readonly trackOwners = new Map<string, TrackGpuOwner>();
  private readonly visiblePins = new Set<string>();
  private readonly selectedPins = new Set<string>();
  private readonly swapPins = new Set<string>();
  private readonly visiblePageKeys = new Set<string>();
  private readonly telemetry: ResidentAnnotationPageGpuTelemetryEvent[] = [];
  private staticCornerBuffer: PixiBuffer | null = null;
  private activeContextGeneration: number | null = null;
  private gpuBytes = 0;
  private clock = 0;
  private gpuPrepareCount = 0;
  private gpuUploadCount = 0;
  private gpuEvictionCount = 0;
  private visibilityBatchChanges = 0;
  private cameraUpdates = 0;
  private trackUniformWrites = 0;
  private staticCornerBufferCreates = 0;
  private trackShaderCreates = 0;
  private destroyed = false;

  constructor(options: ResidentAnnotationPageGpuBankOptions) {
    if (
      typeof options.laneContractIdentity !== 'string' ||
      options.laneContractIdentity.trim().length === 0
    ) {
      throw new Error('resident annotation GPU bank requires a lane contract identity');
    }
    const maxGpuPages = options.maxGpuPages ?? 256;
    const maxGpuBytes = options.maxGpuBytes ?? 128 * 1024 * 1024;
    const telemetryLimit = options.telemetryLimit ?? 512;
    if (!Number.isSafeInteger(maxGpuPages) || maxGpuPages <= 0) {
      throw new Error('resident annotation GPU page budget must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxGpuBytes) || maxGpuBytes <= 0) {
      throw new Error('resident annotation GPU byte budget must be a positive safe integer');
    }
    if (!Number.isSafeInteger(telemetryLimit) || telemetryLimit < 0) {
      throw new Error('resident annotation GPU telemetry limit must be nonnegative');
    }
    this.laneContractIdentity = options.laneContractIdentity;
    this.maxGpuPages = maxGpuPages;
    this.maxGpuBytes = maxGpuBytes;
    this.telemetryLimit = telemetryLimit;
    this.now =
      options.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
    this.container.eventMode = 'none';
    this.container.visible = false;
  }

  static gpuIdentityKey(
    record: Pick<AnnotationResidentPageRecord, 'identityKey'>,
    variant: ResidentAnnotationPageGpuVariant & { laneContractIdentity: string }
  ): string {
    return framedKey([
      record.identityKey,
      String(variant.contextGeneration),
      variant.laneContractIdentity,
    ]);
  }

  compilePage(
    record: AnnotationResidentPageRecord,
    options: CompileResidentAnnotationPageArtifactOptions
  ): ResidentAnnotationPageCpuArtifact {
    this.assertAlive();
    const startedAt = this.now();
    if (options.laneContractIdentity !== this.laneContractIdentity) {
      this.recordTelemetry('reject', 'lane-contract-mismatch', null, 0, this.now() - startedAt);
      throw new Error('resident annotation page lane contract does not match GPU bank authority');
    }
    if (!Number.isSafeInteger(options.contextGeneration) || options.contextGeneration < 0) {
      throw new Error('resident annotation page context generation must be a nonnegative integer');
    }
    if (!Number.isSafeInteger(options.genomeLengthBp) || options.genomeLengthBp <= 0) {
      throw new Error('resident annotation page requires the full positive genome length');
    }
    const gpuIdentityKey = ResidentAnnotationPageGpuBank.gpuIdentityKey(record, options);
    const cached = this.cpuArtifacts.get(gpuIdentityKey);
    if (cached) {
      this.recordTelemetry('cpu-reuse', 'identity-hit', cached, 0, this.now() - startedAt);
      return cached;
    }
    const bundle = compileResidentAnnotationPageBundle({
      ownerKey: gpuIdentityKey,
      features: record.page.features,
      genomeIdentity: record.sourceIdentity,
      genomeLengthBp: options.genomeLengthBp,
      themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
      annotationBarHeightPx: options.annotationBarHeightPx,
      partitionSpanBp: options.partitionSpanBp,
      laneCapacity: record.page.laneCapacity,
      laneContractIdentity: options.laneContractIdentity,
    });
    const cpuByteSize = compiledBundleCpuBytes(bundle);
    const sharedSceneRequired = isTranscriptTrackId(record.page.trackId);
    const authorityStatus =
      bundle.status === 'incomplete'
        ? 'unsupported'
        : sharedSceneRequired
          ? 'shared-scene-required'
          : 'page-local-exact';
    const artifact: ResidentAnnotationPageCpuArtifact = Object.freeze({
      gpuIdentityKey,
      pageIdentityKey: record.identityKey,
      sourceIdentity: record.sourceIdentity,
      policyKey: record.policyKey,
      pageKey: record.pageKey,
      contentRevision: record.contentRevision,
      trackId: record.page.trackId,
      trackOrder: record.page.trackOrder,
      laneCapacity: record.page.laneCapacity,
      ownerStartBp: record.page.ownerStartBp,
      ownerEndBp: record.page.ownerEndBp,
      maxFeatureEndBp: record.page.maxFeatureEndBp,
      themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
      contextGeneration: options.contextGeneration,
      laneContractIdentity: options.laneContractIdentity,
      bundle,
      cpuByteSize,
      gpuByteSize: bundle.gpuReadyScene.packedInstanceData.byteLength,
      interactionIndex: bundle.interactionIndex,
      exactReady:
        authorityStatus === 'page-local-exact' &&
        (bundle.status === 'compiled' || bundle.status === 'empty'),
      authorityStatus,
    });
    this.cpuArtifacts.set(gpuIdentityKey, artifact);
    this.recordTelemetry(
      'cpu-build',
      authorityStatus,
      artifact,
      cpuByteSize,
      this.now() - startedAt
    );
    return artifact;
  }

  preparePage(
    gpuIdentityKey: string,
    renderer: ResidentAnnotationPageGpuPrepareRenderer
  ): ResidentAnnotationPageGpuPrepareResult {
    this.assertAlive();
    const startedAt = this.now();
    const artifact = this.cpuArtifacts.get(gpuIdentityKey);
    if (!artifact) {
      this.recordTelemetry('reject', 'missing-cpu-artifact', null, 0, this.now() - startedAt);
      return { status: 'rejected', gpuIdentityKey, reason: 'missing-cpu-artifact' };
    }
    if (artifact.laneContractIdentity !== this.laneContractIdentity) {
      this.recordTelemetry('reject', 'lane-contract-mismatch', artifact, 0, this.now() - startedAt);
      return { status: 'rejected', gpuIdentityKey, reason: 'lane-contract-mismatch' };
    }
    if (!artifact.exactReady) {
      this.recordTelemetry('reject', 'incomplete-page', artifact, 0, this.now() - startedAt);
      return { status: 'rejected', gpuIdentityKey, reason: 'incomplete-page' };
    }
    if (
      this.activeContextGeneration !== null &&
      this.activeContextGeneration !== artifact.contextGeneration
    ) {
      this.resetGpuContext(artifact.contextGeneration, 'context-generation-change');
    } else if (this.activeContextGeneration === null) {
      this.activeContextGeneration = artifact.contextGeneration;
    }
    const existing = this.preparedPages.get(gpuIdentityKey);
    if (existing) {
      existing.lastUsed = ++this.clock;
      this.recordTelemetry('gpu-reuse', 'identity-hit', artifact, 0, this.now() - startedAt);
      return {
        status: 'reused',
        gpuIdentityKey,
        empty: artifact.bundle.status === 'empty',
      };
    }
    if (artifact.bundle.status === 'empty') {
      this.preparedPages.set(gpuIdentityKey, {
        artifact,
        container: null,
        instanceBuffer: null,
        views: [],
        lastUsed: ++this.clock,
      });
      this.recordTelemetry('gpu-prepare', 'valid-empty', artifact, 0, this.now() - startedAt);
      return { status: 'prepared', gpuIdentityKey, empty: true };
    }

    const track = this.ensureTrackOwner(artifact.trackId);
    const cornerBuffer = this.ensureStaticCornerBuffer();
    const instanceBuffer = new PixiBuffer({
      data: artifact.bundle.gpuReadyScene.packedInstanceData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.STATIC,
      label: `resident-annotation-page-instances:${gpuIdentityKey}`,
      shrinkToFit: false,
    });
    const pageContainer = new Container();
    pageContainer.eventMode = 'none';
    pageContainer.visible = false;
    const state = State.for2d();
    const views = artifact.bundle.gpuReadyScene.partitions.map((partition) => {
      const geometry = createPartitionGeometry(partition, cornerBuffer, instanceBuffer);
      const mesh = new Mesh({ geometry, shader: track.shader, state });
      mesh.eventMode = 'none';
      mesh.visible = true;
      pageContainer.addChild(mesh);
      return { partition, geometry, mesh };
    });
    try {
      renderer.shader.bind(track.shader);
      for (const { geometry } of views) renderer.geometry.bind(geometry, track.shader.glProgram);
    } catch (error) {
      for (const { mesh, geometry } of views) {
        pageContainer.removeChild(mesh);
        mesh.destroy();
        geometry.destroy(false);
      }
      instanceBuffer.destroy();
      pageContainer.destroy();
      throw error;
    } finally {
      renderer.geometry.resetState();
      renderer.shader.resetState();
    }
    this.container.addChild(pageContainer);
    this.preparedPages.set(gpuIdentityKey, {
      artifact,
      container: pageContainer,
      instanceBuffer,
      views,
      lastUsed: ++this.clock,
    });
    this.gpuBytes += artifact.gpuByteSize;
    this.gpuPrepareCount += 1;
    this.gpuUploadCount += 1;
    this.recordTelemetry(
      'gpu-prepare',
      'explicit-prepare',
      artifact,
      artifact.gpuByteSize,
      this.now() - startedAt
    );
    this.enforceGpuBudget('prepare');
    return { status: 'prepared', gpuIdentityKey, empty: false };
  }

  setPins(input: {
    readonly visible?: Iterable<string>;
    readonly selected?: Iterable<string>;
    readonly swap?: Iterable<string>;
  }): number {
    replaceSet(this.visiblePins, input.visible ?? []);
    replaceSet(this.selectedPins, input.selected ?? []);
    replaceSet(this.swapPins, input.swap ?? []);
    return this.enforceGpuBudget('pin-update');
  }

  setVisiblePages(gpuIdentityKeys: Iterable<string>): boolean {
    this.assertAlive();
    const startedAt = this.now();
    const next = [...new Set(gpuIdentityKeys)].sort((left, right) => left.localeCompare(right));
    for (const key of next) {
      const prepared = this.preparedPages.get(key);
      if (!prepared || !prepared.artifact.exactReady) {
        this.recordTelemetry(
          'reject',
          'visibility-page-not-ready',
          prepared?.artifact ?? null,
          0,
          this.now() - startedAt
        );
        return false;
      }
    }
    const current = [...this.visiblePageKeys].sort((left, right) => left.localeCompare(right));
    if (arraysEqual(current, next)) return true;
    const visible = new Set(next);
    for (const [key, page] of this.preparedPages) {
      if (page.container) page.container.visible = visible.has(key);
      if (visible.has(key)) page.lastUsed = ++this.clock;
    }
    replaceSet(this.visiblePageKeys, next);
    this.container.visible = next.length > 0;
    this.visibilityBatchChanges += 1;
    this.recordTelemetry('visibility-batch', 'page-boundary', null, 0, this.now() - startedAt);
    return true;
  }

  updateCamera(input: {
    readonly contract: ViewerRenderContract;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly cdsDetail?: number;
    readonly themeMode?: WebGLThemeMode;
    readonly layoutPlan: AnnotationTrackLayoutPlan;
    readonly annotationStackBaseOffsetPx?: number;
  }): void {
    this.assertAlive();
    const startedAt = this.now();
    const stackBase = input.annotationStackBaseOffsetPx ?? 0;
    if (!Number.isFinite(stackBase)) throw new Error('annotation stack base offset must be finite');
    for (const track of this.trackOwners.values()) {
      const layout = input.layoutPlan.getTrack(track.trackId);
      if (!layout) throw new Error(`annotation layout is missing track ${track.trackId}`);
      const uniforms = (
        track.shader.resources.transcriptUniforms as {
          uniforms: RetainedLinearTranscriptUniforms;
        }
      ).uniforms;
      const originBp = input.contract.xOriginBp ?? 0;
      uniforms.uXScale = input.contract.pixelsPerBp;
      uniforms.uXOrigin = input.contract.projectX(originBp);
      uniforms.uBpOriginChunk = bpCoordinateChunk(originBp);
      uniforms.uBpOriginDelta = bpCoordinateDelta(originBp);
      uniforms.uY0 = input.contract.projectY(stackBase + layout.baseOffsetPx);
      uniforms.uCdsDetail = Math.max(0, Math.min(1, input.cdsDetail ?? 0));
      const runtimeTheme = indexedAnnotationRuntimeThemeUniforms(track.trackId, input.themeMode);
      uniforms.uAnnotationThemeDark = runtimeTheme.themeDark;
      uniforms.uAnnotationTranscriptPalette = runtimeTheme.transcriptPalette;
      uniforms.uAnnotationRnaPalette = runtimeTheme.rnaPalette;
      track.viewportUniform[0] = input.viewportWidth;
      track.viewportUniform[1] = input.viewportHeight;
      track.cameraWriteCount += 1;
      this.trackUniformWrites += 1;
    }
    this.cameraUpdates += 1;
    this.recordTelemetry('camera-update', 'uniform-only', null, 0, this.now() - startedAt);
  }

  getInteractionIndex(gpuIdentityKey: string): PrepackedAnnotationInteractionIndexV2 | null {
    const page = this.preparedPages.get(gpuIdentityKey);
    if (!page) return null;
    page.lastUsed = ++this.clock;
    return page.artifact.interactionIndex;
  }

  getPageDebug(gpuIdentityKey: string): ResidentAnnotationPageGpuPageDebug | null {
    const page = this.preparedPages.get(gpuIdentityKey);
    if (!page) return null;
    return {
      gpuIdentityKey,
      pageKey: page.artifact.pageKey,
      trackId: page.artifact.trackId,
      empty: page.artifact.bundle.status === 'empty',
      visible: this.visiblePageKeys.has(gpuIdentityKey),
      instanceBufferIdentity: page.instanceBuffer,
      interactionIndex: page.artifact.interactionIndex,
      instanceCount: page.artifact.bundle.gpuReadyScene.featureIndices.length,
      partitionCount: page.views.length,
    };
  }

  getTrackUniforms(trackId: string): Readonly<RetainedLinearTranscriptUniforms> | null {
    const track = this.trackOwners.get(trackId);
    if (!track) return null;
    return (
      track.shader.resources.transcriptUniforms as {
        uniforms: RetainedLinearTranscriptUniforms;
      }
    ).uniforms;
  }

  getTelemetry(): ReadonlyArray<ResidentAnnotationPageGpuTelemetryEvent> {
    return [...this.telemetry];
  }

  getDebugSnapshot(): ResidentAnnotationPageGpuBankDebugSnapshot {
    return {
      cpuArtifactCount: this.cpuArtifacts.size,
      gpuPageCount: this.gpuResourcePageCount(),
      gpuByteCount: this.gpuBytes,
      gpuPrepareCount: this.gpuPrepareCount,
      gpuUploadCount: this.gpuUploadCount,
      gpuEvictionCount: this.gpuEvictionCount,
      visibilityBatchChanges: this.visibilityBatchChanges,
      cameraUpdates: this.cameraUpdates,
      trackUniformWrites: this.trackUniformWrites,
      staticCornerBufferCreates: this.staticCornerBufferCreates,
      trackShaderCreates: this.trackShaderCreates,
      activeContextGeneration: this.activeContextGeneration,
      visiblePageKeys: [...this.visiblePageKeys].sort((left, right) => left.localeCompare(right)),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyAllGpuPages('destroy');
    this.destroySharedContextResources();
    this.cpuArtifacts.clear();
    this.container.destroy();
  }

  private ensureStaticCornerBuffer(): PixiBuffer {
    if (this.staticCornerBuffer) return this.staticCornerBuffer;
    this.staticCornerBuffer = new PixiBuffer({
      data: TRANSCRIPT_GLYPH_INSTANCE_CORNERS,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.STATIC,
      label: 'resident-annotation-global-static-corners',
      shrinkToFit: false,
    });
    this.staticCornerBufferCreates += 1;
    return this.staticCornerBuffer;
  }

  private ensureTrackOwner(trackId: string): TrackGpuOwner {
    const existing = this.trackOwners.get(trackId);
    if (existing) return existing;
    const viewportUniform = new Float32Array(2);
    const subpixel = retainedSubpixelOpacityPolicy();
    const runtimeTheme = indexedAnnotationRuntimeThemeUniforms(trackId, 'light');
    const shader = new Shader({
      glProgram: GlProgram.from({
        name: `resident-annotation-page:${trackId}`,
        vertex: TRANSCRIPT_VERTEX_SHADER,
        fragment: TRANSCRIPT_FRAGMENT_SHADER,
      }),
      resources: {
        transcriptUniforms: {
          uSubpixelMinWidthPx: { value: subpixel.minWidthPx, type: 'f32' },
          uSubpixelAlphaGamma: { value: subpixel.alphaGamma, type: 'f32' },
          uSubpixelMinAlphaScale: { value: subpixel.minAlphaScale, type: 'f32' },
          uXScale: { value: 1, type: 'f32' },
          uXOrigin: { value: 0, type: 'f32' },
          uBpOriginChunk: { value: 0, type: 'f32' },
          uBpOriginDelta: { value: 0, type: 'f32' },
          uY0: { value: 0, type: 'f32' },
          uCdsDetail: { value: 0, type: 'f32' },
          uAnnotationThemeDark: { value: runtimeTheme.themeDark, type: 'f32' },
          uAnnotationTranscriptPalette: {
            value: runtimeTheme.transcriptPalette,
            type: 'f32',
          },
          uAnnotationRnaPalette: { value: runtimeTheme.rnaPalette, type: 'f32' },
          uViewportSize: { value: viewportUniform, type: 'vec2<f32>' },
        },
      },
    });
    const owner = { trackId, viewportUniform, shader, cameraWriteCount: 0 };
    this.trackOwners.set(trackId, owner);
    this.trackShaderCreates += 1;
    return owner;
  }

  private resetGpuContext(nextGeneration: number, cause: string): void {
    this.destroyAllGpuPages(cause);
    this.destroySharedContextResources();
    this.activeContextGeneration = nextGeneration;
    this.recordTelemetry('context-reset', cause, null, 0, 0);
  }

  private destroyAllGpuPages(cause: string): void {
    for (const key of [...this.preparedPages.keys()]) this.destroyPreparedPage(key, cause, false);
    this.visiblePageKeys.clear();
    this.container.visible = false;
  }

  private destroySharedContextResources(): void {
    for (const owner of this.trackOwners.values()) destroyLayerShader(owner.shader);
    this.trackOwners.clear();
    this.staticCornerBuffer?.destroy();
    this.staticCornerBuffer = null;
  }

  private destroyPreparedPage(key: string, cause: string, recordEviction: boolean): void {
    const page = this.preparedPages.get(key);
    if (!page) return;
    this.preparedPages.delete(key);
    this.visiblePageKeys.delete(key);
    if (page.container) {
      if (page.container.parent === this.container) this.container.removeChild(page.container);
      for (const { mesh, geometry } of page.views) {
        page.container.removeChild(mesh);
        mesh.destroy();
        geometry.destroy(false);
      }
      page.instanceBuffer?.destroy();
      page.container.destroy();
      this.gpuBytes -= page.artifact.gpuByteSize;
    }
    if (recordEviction) {
      this.gpuEvictionCount += 1;
      this.recordTelemetry('gpu-eviction', cause, page.artifact, page.artifact.gpuByteSize, 0);
    }
  }

  private enforceGpuBudget(cause: string): number {
    let evicted = 0;
    while (this.gpuResourcePageCount() > this.maxGpuPages || this.gpuBytes > this.maxGpuBytes) {
      const candidate = [...this.preparedPages.entries()]
        .filter(
          ([key, page]) =>
            page.instanceBuffer !== null &&
            !this.visiblePins.has(key) &&
            !this.selectedPins.has(key) &&
            !this.swapPins.has(key)
        )
        .sort(
          (left, right) => left[1].lastUsed - right[1].lastUsed || left[0].localeCompare(right[0])
        )[0];
      if (!candidate) break;
      this.destroyPreparedPage(candidate[0], cause, true);
      evicted += 1;
    }
    return evicted;
  }

  private gpuResourcePageCount(): number {
    let count = 0;
    for (const page of this.preparedPages.values()) if (page.instanceBuffer) count += 1;
    return count;
  }

  private recordTelemetry(
    type: ResidentAnnotationPageGpuTelemetryEvent['type'],
    cause: string,
    artifact: ResidentAnnotationPageCpuArtifact | null,
    byteSize: number,
    durationMs: number
  ): void {
    if (this.telemetryLimit === 0) return;
    this.telemetry.push(
      Object.freeze({
        type,
        cause,
        gpuIdentityKey: artifact?.gpuIdentityKey ?? null,
        pageKey: artifact?.pageKey ?? null,
        trackId: artifact?.trackId ?? null,
        durationMs: Math.max(0, durationMs),
        byteSize,
        gpuPageCount: this.gpuResourcePageCount(),
        gpuByteCount: this.gpuBytes,
      })
    );
    if (this.telemetry.length > this.telemetryLimit) {
      this.telemetry.splice(0, this.telemetry.length - this.telemetryLimit);
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('resident annotation GPU bank is destroyed');
  }
}

function createPartitionGeometry(
  partition: TranscriptInstancePartition,
  cornerBuffer: PixiBuffer,
  instanceBuffer: PixiBuffer
): Geometry {
  const base = partition.firstInstance * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes;
  const instanceAttribute = (floatOffset: number, format: 'float32' | 'float32x4') => ({
    buffer: instanceBuffer,
    format,
    stride: TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes,
    offset: base + floatOffset * Float32Array.BYTES_PER_ELEMENT,
    instance: true,
  });
  return new Geometry({
    attributes: {
      aCorner: { buffer: cornerBuffer, format: 'float32' },
      aBpStartChunk: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk, 'float32'),
      aBpStartDelta: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta, 'float32'),
      aBpEndChunk: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk, 'float32'),
      aBpEndDelta: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta, 'float32'),
      aOffsetCenter: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter, 'float32'),
      aHalfH: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH, 'float32'),
      aDirSign: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.dirSign, 'float32'),
      aCdsFade: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.cdsFade, 'float32'),
      aColor: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color, 'float32x4'),
    },
    topology: 'triangle-list',
    instanceCount: partition.instanceCount,
  });
}

function compiledBundleCpuBytes(bundle: CompiledTranscriptPageBundle): number {
  const index = bundle.interactionIndex;
  return (
    bundle.gpuReadyScene.packedInstanceData.byteLength +
    bundle.gpuReadyScene.featureIndices.byteLength +
    index.featureRecordBytes.byteLength +
    index.intervalFeatureIndices.byteLength +
    index.rendererIdFeatureIndices.byteLength +
    index.canonicalIdentityFeatureIndices.byteLength +
    index.intervalSubtreeMaxEndBytes.byteLength +
    index.featurePrimitiveOffsets.byteLength +
    index.featurePrimitiveIndices.byteLength +
    index.stringBytes.byteLength
  );
}

function framedKey(parts: ReadonlyArray<string>): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function replaceSet(target: Set<string>, values: Iterable<string>): void {
  target.clear();
  for (const value of values) target.add(value);
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isTranscriptTrackId(trackId: string): boolean {
  return (
    trackId === 'mRNA' ||
    trackId === 'transcript' ||
    trackId === 'ncRNA' ||
    trackId === 'lncRNA' ||
    trackId === 'lnc_RNA' ||
    trackId === 'miRNA' ||
    trackId === 'snoRNA' ||
    trackId === 'snRNA' ||
    trackId === 'tRNA' ||
    trackId === 'rRNA'
  );
}
