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
  prepareSharedPixiGpuPrograms,
  type PixiGpuProgramPreparationRenderer,
} from '../shared/pixi-gpu-program-preparation';
import type { ViewerRenderContract } from './viewer-render-contract';
import { bpCoordinateChunk, bpCoordinateDelta } from './bp-coordinate-packing';
import {
  featureIndexForPartitionInstance,
  planTranscriptPartitionSubmissions,
  type GpuReadyPartitionedTranscriptScene,
  type TranscriptInstancePartition,
} from './partitioned-transcript-scene';
import { retainedSubpixelOpacityPolicy } from './retained-subpixel-aa';
import {
  TRANSCRIPT_FRAGMENT_SHADER,
  POLICY_TRANSCRIPT_VERTEX_SHADER,
  TRANSCRIPT_VERTEX_SHADER,
  type RetainedLinearTranscriptUniforms,
} from './retained-linear-transcript-layer';
import {
  ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT,
  ANNOTATION_POLICY_GPU_MAX_EXACT_LANE,
  validateAnnotationPolicyGpuInstanceDataV1,
  type AnnotationPolicyGpuTrackLaneMaximaV1,
  type AnnotationPolicyGpuRuntimeV1,
} from './annotation-policy-gpu-instances-v1';
import {
  assertAnnotationPolicyDirectSubmissionBankV1,
  directFineTileInstanceCountForLaneLimitV1,
  directSubmissionInstanceCountForLaneLimitV1,
  type AnnotationPolicyDirectFineTileBankV1,
  type AnnotationPolicyDirectSubmissionBankV1,
  type AnnotationPolicyDirectSubmissionModeV1,
  type AnnotationPolicyDirectSubmissionPartitionV1,
} from './annotation-policy-direct-submission-bank-v1';
import {
  assertAnnotationPolicyDirectFineIndexV1,
  materializeAnnotationPolicyDirectFineTileV1,
  type AnnotationPolicyDirectFineIndexV1,
} from './annotation-policy-direct-fine-index-v1';
import {
  TRANSCRIPT_GLYPH_INSTANCE_CORNERS,
  TRANSCRIPT_GLYPH_INSTANCE_LAYOUT,
} from './transcript-glyph-instances';
import {
  FINE_TRANSCRIPT_VIEW_SPAN_BP,
  fineTranscriptInstanceViewRange,
  packedTranscriptPrimitiveStartBp,
  planFineTranscriptViews,
  type FineTranscriptInstanceViewRange,
} from './fine-transcript-view-planner';
import {
  isTrustedPartitionedTranscriptRendererAdmissionV4,
  type TrustedPartitionedTranscriptRendererAdmissionBindingV4,
  type PartitionedTranscriptSceneRoleSidecarV1,
  type TrustedPartitionedTranscriptRendererAdmissionV4,
} from './partitioned-transcript-scene-binary-v4';
import {
  isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1,
  type TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1,
  type TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1,
} from './partitioned-transcript-scene-detail-packet-v1';
import { indexedAnnotationRuntimeThemeUniforms } from '../shared/annotation-runtime-theme';
import type { WebGLThemeMode } from '../shared/theme';
import {
  ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1,
  markAnnotationRoleCodedInstancesV1,
  packAnnotationRolePaletteVec4ArrayV1,
  type AnnotationColorRoleKeyV1,
  type AnnotationRolePaletteOverridesV1,
} from '../../../annotation-role-palette';

export const PARTITIONED_TRANSCRIPT_SEMANTIC_OWNER =
  'prepacked-partitioned-vector-surface' as const;

export interface PartitionedInstancedTranscriptLayerOptions {
  rendererKind: 'webgl' | 'webgpu' | 'canvas';
  trackType?: string;
  artifactGeneration?: string | number;
  maxFineViews?: number;
  policyGpuInstanceData?: Float32Array;
  submissionBank?: AnnotationPolicyDirectSubmissionBankV1;
  submissionFineIndices?: Readonly<{
    expanded: AnnotationPolicyDirectFineIndexV1;
    canonical: AnnotationPolicyDirectFineIndexV1;
  }>;
  colorRoles?: PartitionedTranscriptSceneRoleSidecarV1;
}

export interface PartitionedTranscriptRolePaletteDebug {
  readonly roleCoded: boolean;
  readonly roleCount: number;
  readonly theme: WebGLThemeMode | null;
  readonly overriddenRoleCount: number;
}

const trustedV4LayerOptions = new WeakSet<PartitionedInstancedTranscriptLayerOptions>();
const trustedDetailPacketLayerOptions = new WeakSet<PartitionedInstancedTranscriptLayerOptions>();

function partitionedTranscriptGlProgram(policyEnabled: boolean): GlProgram {
  return GlProgram.from({
    name: 'partitioned-instanced-transcript-bodies',
    vertex: policyEnabled ? POLICY_TRANSCRIPT_VERTEX_SHADER : TRANSCRIPT_VERTEX_SHADER,
    fragment: TRANSCRIPT_FRAGMENT_SHADER,
  });
}

export interface PartitionedTranscriptAdmissionValidationDebug {
  readonly trustedV4Admission: boolean;
  readonly trustedDetailPacketAdmission: boolean;
  readonly directFineIndexValidationCount: number;
  readonly directFineIndexRecordScanCardinality: number;
}

interface PartitionView {
  partition: TranscriptInstancePartition;
  geometry: Geometry;
  mesh: Mesh<Geometry, Shader>;
  mode: AnnotationPolicyDirectSubmissionModeV1 | null;
  featureIndices: Uint32Array;
  bankPartition: AnnotationPolicyDirectSubmissionPartitionV1 | null;
  ownedInstanceBuffer: PixiBuffer | null;
}

interface PendingDirectCoarseView {
  mode: AnnotationPolicyDirectSubmissionModeV1;
  partition: AnnotationPolicyDirectSubmissionPartitionV1;
}

interface FinePartitionView {
  range: FineTranscriptInstanceViewRange;
  geometry: Geometry | null;
  mesh: Mesh<Geometry, Shader> | null;
  mode: AnnotationPolicyDirectSubmissionModeV1 | null;
  featureIndices: Uint32Array;
  featureIndexBase: number;
  directTile: AnnotationPolicyDirectFineTileBankV1 | null;
  ownedInstanceBuffer: PixiBuffer | null;
  lastUsed: number;
}

export interface PartitionedTranscriptGpuPreparationRenderer {
  shader: {
    bind(shader: Shader, skipSync?: boolean): void;
    resetState(): void;
  };
  geometry: {
    bind(geometry: Geometry, program: GlProgram): void;
    resetState(): void;
  };
}

export interface PartitionedTranscriptViewDebug {
  key: string;
  firstInstance: number;
  instanceCount: number;
  visible: boolean;
  instanceBaseByteOffset: number;
  ownedInstanceBufferByteLength: number | null;
  attributeByteOffsets: Record<string, number>;
  viewKind?: 'coarse' | 'fine';
}

export interface PartitionedTranscriptFineViewDebug {
  presentationMode: 'hidden' | 'coarse' | 'fine';
  coarseVisible: boolean;
  fineVisibleCount: number;
  requiredFineCount: number;
  fineViewBuildCount: number;
  fineViewReuseCount: number;
  fineViewEvictionCount: number;
  fineViewFallbackCount: number;
  fineViewCacheSize: number;
  artifactGeneration: string;
}

export const PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP = FINE_TRANSCRIPT_VIEW_SPAN_BP * 8;

export interface PartitionedTranscriptSubmissionDebug {
  readonly directBankEnabled: boolean;
  readonly activeMode: AnnotationPolicyDirectSubmissionModeV1 | null;
  readonly actualSubmittedInstanceCount: number;
  readonly actualSubmittedVertexCount: number;
  readonly hiddenByIsoformMembershipInstanceCount: number;
  readonly hiddenByLaneCapInstanceCount: number;
  readonly visibleDrawCount: number;
}

export interface PartitionedTranscriptPresentationLayoutDebug {
  readonly screenAnchorYCssPx: number;
  readonly viewportWidthCssPx: number;
  readonly viewportHeightCssPx: number;
}

export const PARTITIONED_TRANSCRIPT_POLICY_TRANSACTION_V1 =
  'partitioned-transcript-policy-transaction.v1' as const;

export interface PartitionedTranscriptPolicyTransactionV1 {
  readonly contract: typeof PARTITIONED_TRANSCRIPT_POLICY_TRANSACTION_V1;
  readonly transactionId: number;
  readonly submission: PartitionedTranscriptSubmissionDebug;
}

interface PartitionedTranscriptPolicyStateCheckpoint {
  readonly runtime: AnnotationPolicyGpuRuntimeV1 | null;
  readonly updateCount: number;
  readonly uniforms: Readonly<{
    isoformMode: number;
    laneLimit: number;
  }> | null;
  readonly views: ReadonlyArray<
    Readonly<{
      view: PartitionView;
      visible: boolean;
      instanceCount: number;
    }>
  >;
  readonly fineViews: ReadonlyArray<
    Readonly<{
      view: FinePartitionView;
      visible: boolean | null;
      instanceCount: number | null;
      lastUsed: number;
    }>
  >;
  readonly fineClock: number;
  readonly activePresentationMode: 'coarse' | 'fine';
  readonly requiredFineCount: number;
  readonly fineViewFallbackCount: number;
  readonly submission: PartitionedTranscriptSubmissionDebug;
}

interface AnnotationPolicyShaderUniforms {
  uPolicyIsoformMode: number;
  uPolicyLaneLimit: number;
}

export class PartitionedInstancedTranscriptLayer {
  readonly semanticOwnerId = PARTITIONED_TRANSCRIPT_SEMANTIC_OWNER;
  readonly container: Container;

  private readonly scene: GpuReadyPartitionedTranscriptScene;
  private readonly cornerBuffer: PixiBuffer;
  private readonly instanceBuffer: PixiBuffer;
  private readonly canonicalInstanceBuffer: PixiBuffer | null;
  private readonly policyBuffer: PixiBuffer | null;
  private readonly submissionBank: AnnotationPolicyDirectSubmissionBankV1 | null;
  private readonly submissionFineIndices: Readonly<{
    expanded: AnnotationPolicyDirectFineIndexV1;
    canonical: AnnotationPolicyDirectFineIndexV1;
  }> | null;
  private readonly policyTrackLaneMaxima: AnnotationPolicyGpuTrackLaneMaximaV1 | null;
  private readonly viewportUniform = new Float32Array(2);
  private readonly shader: Shader;
  private readonly views: PartitionView[];
  private readonly pendingDirectCoarseViews: ReadonlyArray<PendingDirectCoarseView>;
  private pendingDirectCoarseViewCursor = 0;
  private readonly fineViews = new Map<string, FinePartitionView>();
  private readonly artifactGeneration: string;
  private readonly maxFineViews: number;
  private readonly trackType: string;
  private fineClock = 0;
  private activePresentationMode: 'coarse' | 'fine' = 'coarse';
  private requiredFineCount = 0;
  private fineViewBuildCount = 0;
  private fineViewReuseCount = 0;
  private fineViewEvictionCount = 0;
  private fineViewFallbackCount = 0;
  private gpuResourcesPrepared = false;
  private policyUpdateCount = 0;
  private policyRuntime: AnnotationPolicyGpuRuntimeV1 | null = null;
  private viewportStartBp: number | null = null;
  private viewportEndBp: number | null = null;
  private submissionDebug: PartitionedTranscriptSubmissionDebug = {
    directBankEnabled: false,
    activeMode: null,
    actualSubmittedInstanceCount: 0,
    actualSubmittedVertexCount: 0,
    hiddenByIsoformMembershipInstanceCount: 0,
    hiddenByLaneCapInstanceCount: 0,
    visibleDrawCount: 0,
  };
  private policyTransactionId = 0;
  private activePolicyTransaction: PartitionedTranscriptPolicyTransactionV1 | null = null;
  private readonly policyTransactionCheckpoints = new WeakMap<
    PartitionedTranscriptPolicyTransactionV1,
    PartitionedTranscriptPolicyStateCheckpoint
  >();
  private destroyed = false;
  private readonly roleTable: readonly AnnotationColorRoleKeyV1[] | null;
  private rolePaletteOverrides: AnnotationRolePaletteOverridesV1 | undefined;
  private rolePaletteTheme: WebGLThemeMode | null = null;
  private readonly admissionValidationDebug: PartitionedTranscriptAdmissionValidationDebug;

  static prepareGpuPrograms(renderer: PixiGpuProgramPreparationRenderer): void {
    prepareSharedPixiGpuPrograms(renderer, [
      partitionedTranscriptGlProgram(false),
      partitionedTranscriptGlProgram(true),
    ]);
  }

  static fromValidatedV4(
    binding: TrustedPartitionedTranscriptRendererAdmissionBindingV4,
    options: PartitionedInstancedTranscriptLayerOptions,
    capability: TrustedPartitionedTranscriptRendererAdmissionV4
  ): PartitionedInstancedTranscriptLayer {
    if (
      !options.submissionBank ||
      !options.submissionFineIndices ||
      options.submissionBank !== binding.submissionBank ||
      options.submissionFineIndices !== binding.submissionFineIndices ||
      !isTrustedPartitionedTranscriptRendererAdmissionV4(capability, binding)
    ) {
      throw new Error('partitioned transcript trusted-v4 admission capability mismatch');
    }
    const trustedOptions = { ...options };
    trustedV4LayerOptions.add(trustedOptions);
    return new PartitionedInstancedTranscriptLayer(binding.scene, trustedOptions);
  }

  static fromValidatedDetailPacket(
    binding: TrustedPartitionedTranscriptSceneDetailPacketAdmissionBindingV1,
    options: PartitionedInstancedTranscriptLayerOptions,
    capability: TrustedPartitionedTranscriptSceneDetailPacketAdmissionV1
  ): PartitionedInstancedTranscriptLayer {
    if (
      !options.submissionBank ||
      !options.submissionFineIndices ||
      options.submissionBank !== binding.submissionBank ||
      options.submissionFineIndices !== binding.submissionFineIndices ||
      !isTrustedPartitionedTranscriptSceneDetailPacketAdmissionV1(capability, binding)
    ) {
      throw new Error('partitioned transcript trusted-detail admission capability mismatch');
    }
    const trustedOptions = { ...options };
    trustedDetailPacketLayerOptions.add(trustedOptions);
    return new PartitionedInstancedTranscriptLayer(binding.scene, trustedOptions);
  }

  constructor(
    scene: GpuReadyPartitionedTranscriptScene,
    options: PartitionedInstancedTranscriptLayerOptions
  ) {
    if (options.rendererKind !== 'webgl') {
      throw new Error(
        `PartitionedInstancedTranscriptLayer requires WebGL; ${options.rendererKind} has no safe shared-buffer base-instance path`
      );
    }
    const artifactGeneration = String(options.artifactGeneration ?? 'anonymous-buffer-generation');
    if (artifactGeneration.length === 0) {
      throw new Error('partitioned transcript artifact generation must be nonempty');
    }
    const maxFineViews = options.maxFineViews ?? 64;
    if (!Number.isSafeInteger(maxFineViews) || maxFineViews <= 0) {
      throw new Error('partitioned transcript fine-view budget must be a positive integer');
    }
    const trustedV4Admission = trustedV4LayerOptions.has(options);
    const trustedDetailPacketAdmission = trustedDetailPacketLayerOptions.has(options);
    const trustedDirectBankAdmission = trustedV4Admission || trustedDetailPacketAdmission;
    assertSceneRanges(scene);
    if ((options.submissionBank === undefined) !== (options.submissionFineIndices === undefined)) {
      throw new Error(
        'annotation direct submission bank and fine indices must be supplied together'
      );
    }
    if (options.submissionBank && options.submissionFineIndices) {
      assertAnnotationPolicyDirectSubmissionBankV1(scene, options.submissionBank);
      if (!trustedDirectBankAdmission) {
        assertAnnotationPolicyDirectFineIndexV1(
          options.submissionBank.expanded,
          options.submissionFineIndices.expanded
        );
        assertAnnotationPolicyDirectFineIndexV1(
          options.submissionBank.canonical,
          options.submissionFineIndices.canonical
        );
      }
    }
    this.admissionValidationDebug = {
      trustedV4Admission,
      trustedDetailPacketAdmission,
      directFineIndexValidationCount:
        options.submissionFineIndices && !trustedDirectBankAdmission ? 2 : 0,
      directFineIndexRecordScanCardinality:
        options.submissionFineIndices && !trustedDirectBankAdmission
          ? options.submissionFineIndices.expanded.bankRecordIndices.length +
            options.submissionFineIndices.canonical.bankRecordIndices.length
          : 0,
    };
    this.policyTrackLaneMaxima = options.policyGpuInstanceData
      ? validateAnnotationPolicyGpuInstanceDataV1(
          options.policyGpuInstanceData,
          scene.featureIndices.length
        )
      : options.submissionBank
        ? {
            expanded: options.submissionBank.expanded.maxTrackLane,
            canonical: options.submissionBank.canonical.maxTrackLane,
          }
        : null;
    this.scene = scene;
    this.submissionBank = options.submissionBank ?? null;
    this.submissionFineIndices = options.submissionFineIndices ?? null;
    this.artifactGeneration = artifactGeneration;
    this.maxFineViews = maxFineViews;
    this.trackType = options.trackType ?? '';
    this.roleTable = markRoleCodedBanks(options.submissionBank, options.colorRoles);
    this.container = new Container();
    this.container.eventMode = 'none';
    this.cornerBuffer = new PixiBuffer({
      data: TRANSCRIPT_GLYPH_INSTANCE_CORNERS,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.STATIC,
      label: 'partitioned-transcript-static-corners',
      shrinkToFit: false,
    });
    this.instanceBuffer = new PixiBuffer({
      data: options.submissionBank
        ? options.submissionBank.expanded.packedInstanceData
        : scene.packedInstanceData,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.STATIC,
      label: options.submissionBank
        ? 'partitioned-transcript-bank-expanded-instances'
        : 'partitioned-transcript-shared-instances',
      shrinkToFit: false,
    });
    this.canonicalInstanceBuffer = options.submissionBank
      ? new PixiBuffer({
          data: options.submissionBank.canonical.packedInstanceData,
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.STATIC,
          label: 'partitioned-transcript-bank-canonical-instances',
          shrinkToFit: false,
        })
      : null;
    this.policyBuffer =
      options.policyGpuInstanceData && !options.submissionBank
        ? new PixiBuffer({
            data: options.policyGpuInstanceData,
            usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.STATIC,
            label: 'partitioned-transcript-shared-policy-instances',
            shrinkToFit: false,
          })
        : null;
    this.policyRuntime =
      this.policyBuffer || this.submissionBank
        ? {
            isoformMode: 'expanded',
            laneLimit: null,
          }
        : null;
    this.shader = this.createShader(this.policyBuffer !== null);
    this.syncRolePalette('light');
    const directCoarseViews = this.submissionBank
      ? (['expanded', 'canonical'] as const).flatMap((mode) =>
          this.submissionBank![mode].partitions.map((partition) => ({ mode, partition }))
        )
      : [];
    this.pendingDirectCoarseViews = trustedDetailPacketAdmission ? directCoarseViews : [];
    this.views = trustedDetailPacketAdmission
      ? []
      : this.submissionBank
        ? directCoarseViews.map(({ mode, partition }) =>
            this.createDirectCoarseView(mode, partition)
          )
        : scene.partitions.map((partition) => {
            const geometry = this.createPartitionGeometry(partition);
            const mesh = new Mesh({ geometry, shader: this.shader, state: State.for2d() });
            mesh.eventMode = 'none';
            mesh.visible = false;
            this.container.addChild(mesh);
            return {
              partition,
              geometry,
              mesh,
              mode: null,
              featureIndices: scene.featureIndices,
              bankPartition: null,
              ownedInstanceBuffer: null,
            };
          });
    this.submissionDebug = {
      ...this.submissionDebug,
      directBankEnabled: this.submissionBank !== null,
      activeMode: this.submissionBank ? 'expanded' : null,
    };
  }

  get isPresenting(): boolean {
    return (
      this.container.visible &&
      (this.views.some(({ mesh, geometry }) => mesh.visible && geometry.instanceCount > 0) ||
        [...this.fineViews.values()].some(
          ({ mesh, geometry }) => mesh?.visible === true && (geometry?.instanceCount ?? 0) > 0
        ))
    );
  }

  get isGpuPrepared(): boolean {
    return this.gpuResourcesPrepared;
  }

  get isCoarseFallbackPrepared(): boolean {
    return this.pendingDirectCoarseViewCursor >= this.pendingDirectCoarseViews.length;
  }

  requiresFinePresentationForViewport(viewportStartBp: number, viewportEndBp: number): boolean {
    const visibleBp = viewportEndBp - viewportStartBp;
    return (
      this.submissionBank !== null &&
      Number.isFinite(visibleBp) &&
      visibleBp > 0 &&
      visibleBp <= FINE_TRANSCRIPT_VIEW_SPAN_BP
    );
  }

  get isFinePresentationExact(): boolean {
    return this.activePresentationMode === 'fine';
  }

  areFineViewsPrewarmed(viewportStartBp: number, viewportEndBp: number, haloTiles = 1): boolean {
    const plan = planFineTranscriptViews(
      this.scene,
      viewportStartBp,
      viewportEndBp,
      haloTiles,
      FINE_TRANSCRIPT_VIEW_SPAN_BP,
      this.submissionFineIndices?.expanded.tileCount
    );
    const modes: ReadonlyArray<AnnotationPolicyDirectSubmissionModeV1 | null> = this.submissionBank
      ? ['expanded', 'canonical']
      : [null];
    return plan.prewarmTileIndices.every((tileIndex) =>
      modes.every((mode) => this.fineViews.has(this.fineViewCacheKey(tileIndex, mode)))
    );
  }

  updateAnnotationPolicy(runtime: AnnotationPolicyGpuRuntimeV1): void {
    this.assertAlive();
    if ((!this.policyBuffer && !this.submissionBank) || !this.policyRuntime) {
      throw new Error('partitioned transcript layer has no runtime policy plane');
    }
    const next: AnnotationPolicyGpuRuntimeV1 = { ...runtime };
    validatePolicyRuntime(next);
    if (this.policyBuffer) {
      const uniforms = (
        this.shader.resources.transcriptUniforms as {
          uniforms: RetainedLinearTranscriptUniforms & AnnotationPolicyShaderUniforms;
        }
      ).uniforms;
      uniforms.uPolicyIsoformMode = next.isoformMode === 'canonical' ? 1 : 0;
      uniforms.uPolicyLaneLimit = next.laneLimit ?? -1;
    }
    this.policyRuntime = next;
    this.policyUpdateCount += 1;
    if (this.submissionBank && this.viewportStartBp !== null && this.viewportEndBp !== null) {
      this.applyDirectBankVisibleRange(this.viewportStartBp, this.viewportEndBp);
    }
  }

  beginAnnotationPolicyTransaction(
    runtime: AnnotationPolicyGpuRuntimeV1
  ): PartitionedTranscriptPolicyTransactionV1 | null {
    if (this.activePolicyTransaction || this.destroyed) return null;
    const checkpoint = this.capturePolicyStateCheckpoint();
    try {
      this.updateAnnotationPolicy(runtime);
    } catch {
      this.restorePolicyStateCheckpoint(checkpoint);
      return null;
    }
    const receipt = Object.freeze({
      contract: PARTITIONED_TRANSCRIPT_POLICY_TRANSACTION_V1,
      transactionId: ++this.policyTransactionId,
      submission: this.getSubmissionDebug(),
    });
    this.activePolicyTransaction = receipt;
    this.policyTransactionCheckpoints.set(receipt, checkpoint);
    return receipt;
  }

  canCommitAnnotationPolicyTransaction(receipt: PartitionedTranscriptPolicyTransactionV1): boolean {
    return (
      !this.destroyed &&
      this.activePolicyTransaction === receipt &&
      this.policyTransactionCheckpoints.has(receipt)
    );
  }

  commitAnnotationPolicyTransaction(receipt: PartitionedTranscriptPolicyTransactionV1): void {
    if (!this.canCommitAnnotationPolicyTransaction(receipt)) {
      throw new Error('partitioned transcript policy transaction receipt is not active');
    }
    this.policyTransactionCheckpoints.delete(receipt);
    this.activePolicyTransaction = null;
  }

  rollbackAnnotationPolicyTransaction(receipt: PartitionedTranscriptPolicyTransactionV1): boolean {
    if (this.activePolicyTransaction !== receipt) return false;
    const checkpoint = this.policyTransactionCheckpoints.get(receipt);
    if (!checkpoint) return false;
    this.restorePolicyStateCheckpoint(checkpoint);
    this.policyTransactionCheckpoints.delete(receipt);
    this.activePolicyTransaction = null;
    return true;
  }

  private capturePolicyStateCheckpoint(): PartitionedTranscriptPolicyStateCheckpoint {
    const uniforms = this.policyBuffer
      ? (
          this.shader.resources.transcriptUniforms as {
            uniforms: RetainedLinearTranscriptUniforms & AnnotationPolicyShaderUniforms;
          }
        ).uniforms
      : null;
    return {
      runtime: this.policyRuntime ? { ...this.policyRuntime } : null,
      updateCount: this.policyUpdateCount,
      uniforms: uniforms
        ? {
            isoformMode: uniforms.uPolicyIsoformMode,
            laneLimit: uniforms.uPolicyLaneLimit,
          }
        : null,
      views: this.views.map((view) => ({
        view,
        visible: view.mesh.visible,
        instanceCount: view.geometry.instanceCount,
      })),
      fineViews: [...this.fineViews.values()].map((view) => ({
        view,
        visible: view.mesh?.visible ?? null,
        instanceCount: view.geometry?.instanceCount ?? null,
        lastUsed: view.lastUsed,
      })),
      fineClock: this.fineClock,
      activePresentationMode: this.activePresentationMode,
      requiredFineCount: this.requiredFineCount,
      fineViewFallbackCount: this.fineViewFallbackCount,
      submission: { ...this.submissionDebug },
    };
  }

  private restorePolicyStateCheckpoint(
    checkpoint: PartitionedTranscriptPolicyStateCheckpoint
  ): void {
    if (checkpoint.uniforms && this.policyBuffer) {
      const uniforms = (
        this.shader.resources.transcriptUniforms as {
          uniforms: RetainedLinearTranscriptUniforms & AnnotationPolicyShaderUniforms;
        }
      ).uniforms;
      uniforms.uPolicyIsoformMode = checkpoint.uniforms.isoformMode;
      uniforms.uPolicyLaneLimit = checkpoint.uniforms.laneLimit;
    }
    this.policyRuntime = checkpoint.runtime ? { ...checkpoint.runtime } : null;
    this.policyUpdateCount = checkpoint.updateCount;
    for (const { view, visible, instanceCount } of checkpoint.views) {
      view.geometry.instanceCount = instanceCount;
      view.mesh.visible = visible;
    }
    for (const { view, visible, instanceCount, lastUsed } of checkpoint.fineViews) {
      if (view.geometry && instanceCount !== null) view.geometry.instanceCount = instanceCount;
      if (view.mesh && visible !== null) view.mesh.visible = visible;
      view.lastUsed = lastUsed;
    }
    this.fineClock = checkpoint.fineClock;
    this.activePresentationMode = checkpoint.activePresentationMode;
    this.requiredFineCount = checkpoint.requiredFineCount;
    this.fineViewFallbackCount = checkpoint.fineViewFallbackCount;
    this.submissionDebug = { ...checkpoint.submission };
  }

  getAnnotationPolicyDebug(): {
    enabled: boolean;
    updateCount: number;
    runtime: AnnotationPolicyGpuRuntimeV1 | null;
    glyphBufferIdentity: Float32Array;
    policyBufferIdentity: Float32Array | null;
  } {
    return {
      enabled: this.policyBuffer !== null || this.submissionBank !== null,
      updateCount: this.policyUpdateCount,
      runtime: this.policyRuntime ? { ...this.policyRuntime } : null,
      glyphBufferIdentity: this.scene.packedInstanceData,
      policyBufferIdentity: this.policyBuffer ? (this.policyBuffer.data as Float32Array) : null,
    };
  }

  getSubmissionDebug(): PartitionedTranscriptSubmissionDebug {
    return { ...this.submissionDebug };
  }

  getPresentationLayoutDebug(): PartitionedTranscriptPresentationLayoutDebug {
    const uniforms = (
      this.shader.resources.transcriptUniforms as {
        uniforms: RetainedLinearTranscriptUniforms;
      }
    ).uniforms;
    return {
      screenAnchorYCssPx: uniforms.uY0,
      viewportWidthCssPx: this.viewportUniform[0],
      viewportHeightCssPx: this.viewportUniform[1],
    };
  }

  getAdmissionValidationDebug(): PartitionedTranscriptAdmissionValidationDebug {
    return { ...this.admissionValidationDebug };
  }

  setRolePaletteOverrides(overrides: AnnotationRolePaletteOverridesV1 | undefined): void {
    this.assertAlive();
    this.rolePaletteOverrides = overrides;
    const theme = this.rolePaletteTheme;
    this.rolePaletteTheme = null;
    if (theme) this.syncRolePalette(theme);
  }

  getRolePaletteDebug(): PartitionedTranscriptRolePaletteDebug {
    return {
      roleCoded: this.roleTable !== null,
      roleCount: this.roleTable?.length ?? 0,
      theme: this.rolePaletteTheme,
      overriddenRoleCount: this.roleTable
        ? this.roleTable.filter((role) => this.rolePaletteOverrides?.[role] !== undefined).length
        : 0,
    };
  }

  private syncRolePalette(theme: WebGLThemeMode): void {
    if (!this.roleTable || this.rolePaletteTheme === theme) return;
    const uniforms = (
      this.shader.resources.transcriptUniforms as {
        uniforms: RetainedLinearTranscriptUniforms & { uRolePalette: Float32Array };
      }
    ).uniforms;
    uniforms.uRolePalette.set(
      packAnnotationRolePaletteVec4ArrayV1(this.roleTable, theme, this.rolePaletteOverrides)
    );
    this.rolePaletteTheme = theme;
  }

  getAnnotationPolicyTrackLaneMaxima(): AnnotationPolicyGpuTrackLaneMaximaV1 | null {
    return this.policyTrackLaneMaxima;
  }

  prepareGpuResources(renderer: PartitionedTranscriptGpuPreparationRenderer): void {
    this.assertAlive();
    if (this.gpuResourcesPrepared) return;
    renderer.shader.bind(this.shader, true);
    try {
      for (const { geometry } of this.views)
        renderer.geometry.bind(geometry, this.shader.glProgram);
      this.gpuResourcesPrepared = true;
    } finally {
      renderer.geometry.resetState();
      renderer.shader.resetState();
    }
  }

  prepareNextCoarseFallbackView(
    renderer: PartitionedTranscriptGpuPreparationRenderer,
    deadlineMs = Number.POSITIVE_INFINITY
  ): boolean {
    this.assertAlive();
    if (!this.gpuResourcesPrepared) {
      throw new Error('partitioned transcript GPU resources must be prepared first');
    }
    const plan = this.pendingDirectCoarseViews[this.pendingDirectCoarseViewCursor];
    if (!plan) return false;
    if (performance.now() >= deadlineMs) return false;
    let view: PartitionView | null = null;
    try {
      view = this.createDirectCoarseView(plan.mode, plan.partition, true);
      renderer.shader.bind(this.shader, true);
      renderer.geometry.bind(view.geometry, this.shader.glProgram);
      this.views.push(view);
      this.pendingDirectCoarseViewCursor += 1;
      return true;
    } catch (error) {
      if (view) {
        this.container.removeChild(view.mesh);
        view.mesh.destroy();
        view.geometry.destroy(false);
        view.ownedInstanceBuffer?.destroy();
      }
      throw error;
    } finally {
      renderer.geometry.resetState();
      renderer.shader.resetState();
    }
  }

  updateVisibleRange(
    viewportStartBp: number,
    viewportEndBp: number
  ): TranscriptInstancePartition[] {
    this.assertAlive();
    this.viewportStartBp = viewportStartBp;
    this.viewportEndBp = viewportEndBp;
    if (this.submissionBank) {
      return this.applyDirectBankVisibleRange(viewportStartBp, viewportEndBp);
    }
    const visibleBp = viewportEndBp - viewportStartBp;
    if (visibleBp > 0 && visibleBp <= FINE_TRANSCRIPT_VIEW_SPAN_BP) {
      const plan = planFineTranscriptViews(
        this.scene,
        viewportStartBp,
        viewportEndBp,
        1,
        FINE_TRANSCRIPT_VIEW_SPAN_BP,
        this.submissionFineIndices?.expanded.tileCount
      );
      this.requiredFineCount = plan.requiredTileIndices.length;
      if (
        plan.requiredTileIndices.every((tileIndex) =>
          this.fineViews.has(this.fineViewCacheKey(tileIndex, null))
        )
      ) {
        const required = new Set(
          plan.requiredTileIndices.map((tileIndex) => this.fineViewCacheKey(tileIndex, null))
        );
        for (const view of this.views) view.mesh.visible = false;
        for (const [key, fine] of this.fineViews) {
          if (fine.mesh) fine.mesh.visible = required.has(key);
          if (required.has(key)) fine.lastUsed = ++this.fineClock;
        }
        this.activePresentationMode = 'fine';
        const submissions = plan.requiredTileIndices.flatMap((tileIndex) => {
          const fine = this.fineViews.get(this.fineViewCacheKey(tileIndex, null))!;
          if (fine.range.instanceCount === 0) return [];
          const first = fine.range.firstInstance;
          const minStartBp = packedTranscriptPrimitiveStartBp(this.scene, first);
          return [
            {
              key: this.fineViewKey(tileIndex),
              partitionIndex: tileIndex,
              startBp: fine.range.startBp,
              endBpExclusive: fine.range.endBpExclusive,
              firstInstance: first,
              instanceCount: fine.range.instanceCount,
              minStartBp,
              maxEndBp: viewportEndBp,
            },
          ];
        });
        this.refreshFallbackSubmissionDebug();
        return submissions;
      }
      this.fineViewFallbackCount += 1;
    } else {
      this.requiredFineCount = 0;
    }
    for (const fine of this.fineViews.values()) if (fine.mesh) fine.mesh.visible = false;
    const submissions = planTranscriptPartitionSubmissions(
      this.scene,
      viewportStartBp,
      viewportEndBp
    );
    const visible = new Set(submissions.map(({ key }) => key));
    for (const view of this.views) view.mesh.visible = visible.has(view.partition.key);
    this.activePresentationMode = 'coarse';
    this.refreshFallbackSubmissionDebug();
    return submissions;
  }

  private applyDirectBankVisibleRange(
    viewportStartBp: number,
    viewportEndBp: number
  ): TranscriptInstancePartition[] {
    const runtime = this.policyRuntime!;
    const mode = runtime.isoformMode;
    const visibleBp = viewportEndBp - viewportStartBp;
    if (visibleBp > 0 && visibleBp <= FINE_TRANSCRIPT_VIEW_SPAN_BP) {
      const plan = planFineTranscriptViews(
        this.scene,
        viewportStartBp,
        viewportEndBp,
        1,
        FINE_TRANSCRIPT_VIEW_SPAN_BP,
        this.submissionFineIndices?.expanded.tileCount
      );
      this.requiredFineCount = plan.requiredTileIndices.length;
      const requiredKeys = plan.requiredTileIndices.map((tileIndex) =>
        this.fineViewCacheKey(tileIndex, mode)
      );
      if (requiredKeys.every((key) => this.fineViews.has(key))) {
        const required = new Set(requiredKeys);
        for (const view of this.views) view.mesh.visible = false;
        let actual = 0;
        let membershipHidden = 0;
        let laneHidden = 0;
        let drawCount = 0;
        for (const [key, fine] of this.fineViews) {
          const isRequired = required.has(key);
          if (fine.mesh && fine.geometry) {
            const count = fine.directTile
              ? directFineTileInstanceCountForLaneLimitV1(fine.directTile, runtime.laneLimit)
              : 0;
            fine.geometry.instanceCount = count;
            fine.mesh.visible = isRequired && count > 0;
            if (fine.mesh.visible) drawCount++;
            if (isRequired && fine.directTile) {
              actual += count;
              membershipHidden += fine.directTile.hiddenByIsoformMembershipInstanceCount;
              laneHidden += fine.directTile.featureIndices.length - count;
            }
          } else if (isRequired && fine.directTile) {
            membershipHidden += fine.directTile.hiddenByIsoformMembershipInstanceCount;
          }
          if (isRequired) fine.lastUsed = ++this.fineClock;
        }
        this.activePresentationMode = 'fine';
        this.setSubmissionDebug(mode, actual, membershipHidden, laneHidden, drawCount);
        return plan.requiredTileIndices.flatMap((tileIndex) => {
          const fine = this.fineViews.get(this.fineViewCacheKey(tileIndex, mode))!;
          const count = fine.geometry?.instanceCount ?? 0;
          if (count === 0) return [];
          return [
            {
              key: this.fineViewKey(tileIndex, mode),
              partitionIndex: tileIndex,
              startBp: fine.range.startBp,
              endBpExclusive: fine.range.endBpExclusive,
              firstInstance: 0,
              instanceCount: count,
              minStartBp: fine.range.startBp,
              maxEndBp: viewportEndBp,
            },
          ];
        });
      }
      this.fineViewFallbackCount += 1;
    } else {
      this.requiredFineCount = 0;
    }

    for (const fine of this.fineViews.values()) if (fine.mesh) fine.mesh.visible = false;
    const sourceSubmissions = planTranscriptPartitionSubmissions(
      this.scene,
      viewportStartBp,
      viewportEndBp
    );
    const selected = new Set(sourceSubmissions.map(({ partitionIndex }) => partitionIndex));
    let actual = 0;
    let membershipHidden = 0;
    let laneHidden = 0;
    let drawCount = 0;
    const submissions: TranscriptInstancePartition[] = [];
    for (const view of this.views) {
      const partition = view.bankPartition;
      if (!partition || view.mode !== mode || !selected.has(partition.partitionIndex)) {
        view.mesh.visible = false;
        continue;
      }
      const count = directSubmissionInstanceCountForLaneLimitV1(partition, runtime.laneLimit);
      view.geometry.instanceCount = count;
      view.mesh.visible = count > 0;
      actual += count;
      membershipHidden += partition.hiddenByIsoformMembershipInstanceCount;
      laneHidden += partition.instanceCount - count;
      if (count > 0) {
        drawCount++;
        submissions.push({ ...partition, instanceCount: count });
      }
    }
    this.activePresentationMode = 'coarse';
    this.setSubmissionDebug(mode, actual, membershipHidden, laneHidden, drawCount);
    return submissions;
  }

  prewarmFineViews(
    viewportStartBp: number,
    viewportEndBp: number,
    renderer: PartitionedTranscriptGpuPreparationRenderer,
    haloTiles = 1,
    deadlineMs = Number.POSITIVE_INFINITY
  ): { built: number; reused: number; evicted: number; requiredFineCount: number } {
    this.assertAlive();
    if (!this.gpuResourcesPrepared) {
      throw new Error('partitioned transcript coarse GPU resources must be prepared first');
    }
    const plan = planFineTranscriptViews(
      this.scene,
      viewportStartBp,
      viewportEndBp,
      haloTiles,
      FINE_TRANSCRIPT_VIEW_SPAN_BP,
      this.submissionFineIndices?.expanded.tileCount
    );
    const requests: Array<{
      tileIndex: number;
      mode: AnnotationPolicyDirectSubmissionModeV1 | null;
    }> = [];
    for (const tileIndex of plan.prewarmTileIndices) {
      if (this.submissionBank) {
        requests.push({ tileIndex, mode: 'expanded' }, { tileIndex, mode: 'canonical' });
      } else {
        requests.push({ tileIndex, mode: null });
      }
    }
    let built = 0;
    let reused = 0;
    const created: Array<{ key: string; view: FinePartitionView }> = [];
    let shaderBound = false;
    try {
      for (const { tileIndex, mode } of requests) {
        const key = this.fineViewCacheKey(tileIndex, mode);
        const existing = this.fineViews.get(key);
        if (existing) {
          existing.lastUsed = ++this.fineClock;
          reused += 1;
          continue;
        }
        if (performance.now() >= deadlineMs) break;
        const directTile =
          mode && this.submissionBank && this.submissionFineIndices
            ? materializeAnnotationPolicyDirectFineTileV1(
                this.submissionBank[mode],
                this.submissionFineIndices[mode],
                tileIndex
              )
            : null;
        const range = directTile?.range ?? fineTranscriptInstanceViewRange(this.scene, tileIndex);
        const instanceCount = directTile ? directTile.featureIndices.length : range.instanceCount;
        let ownedInstanceBuffer: PixiBuffer | null = null;
        let geometry: Geometry | null = null;
        let mesh: Mesh<Geometry, Shader> | null = null;
        if (instanceCount > 0) {
          const buffer = directTile
            ? (ownedInstanceBuffer = new PixiBuffer({
                data: directTile.packedInstanceData,
                usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.STATIC,
                label: `partitioned-transcript-bank-fine-${mode}-${tileIndex}`,
                shrinkToFit: false,
              }))
            : this.instanceBuffer;
          geometry = this.createInstanceRangeGeometry(
            buffer,
            directTile ? 0 : range.firstInstance,
            instanceCount,
            !directTile && this.policyBuffer !== null
          );
          mesh = new Mesh({ geometry, shader: this.shader, state: State.for2d() });
          mesh.eventMode = 'none';
          mesh.visible = false;
          this.container.addChild(mesh);
          if (!shaderBound) {
            renderer.shader.bind(this.shader, true);
            shaderBound = true;
          }
          renderer.geometry.bind(geometry, this.shader.glProgram);
        }
        const fine: FinePartitionView = {
          range,
          geometry,
          mesh,
          mode,
          featureIndices: directTile?.featureIndices ?? this.scene.featureIndices,
          featureIndexBase: directTile ? 0 : range.firstInstance,
          directTile,
          ownedInstanceBuffer,
          lastUsed: ++this.fineClock,
        };
        this.fineViews.set(key, fine);
        created.push({ key, view: fine });
        built += 1;
      }
    } catch (error) {
      for (const { key, view: fine } of created) {
        this.fineViews.delete(key);
        if (fine.mesh) {
          this.container.removeChild(fine.mesh);
          fine.mesh.destroy();
        }
        fine.geometry?.destroy(false);
        fine.ownedInstanceBuffer?.destroy();
      }
      throw error;
    } finally {
      if (shaderBound) {
        renderer.geometry.resetState();
        renderer.shader.resetState();
      }
    }
    this.fineViewBuildCount += built;
    this.fineViewReuseCount += reused;
    const protectedKeys = new Set(
      requests.map(({ tileIndex, mode }) => this.fineViewCacheKey(tileIndex, mode))
    );
    const evicted = this.evictFineViewsToLimit(protectedKeys);
    return { built, reused, evicted, requiredFineCount: plan.requiredTileIndices.length };
  }

  updateCamera(
    contract: ViewerRenderContract,
    viewportWidth: number,
    viewportHeight: number,
    cdsDetail = 0,
    annotationTrackBasePx = 0,
    themeMode: WebGLThemeMode = 'light',
    rolePalette?: AnnotationRolePaletteOverridesV1
  ): void {
    this.assertAlive();
    if (!Number.isFinite(annotationTrackBasePx)) {
      throw new Error('partitioned transcript annotation track base must be finite');
    }
    const uniforms = (
      this.shader.resources.transcriptUniforms as {
        uniforms: RetainedLinearTranscriptUniforms;
      }
    ).uniforms;
    const originBp = contract.xOriginBp ?? 0;
    uniforms.uXScale = contract.pixelsPerBp;
    uniforms.uXOrigin = contract.projectX(originBp);
    uniforms.uBpOriginChunk = bpCoordinateChunk(originBp);
    uniforms.uBpOriginDelta = bpCoordinateDelta(originBp);
    uniforms.uY0 = contract.projectY(annotationTrackBasePx);
    uniforms.uCdsDetail = Math.max(0, Math.min(1, cdsDetail));
    const runtimeTheme = indexedAnnotationRuntimeThemeUniforms(this.trackType, themeMode);
    uniforms.uAnnotationThemeDark = runtimeTheme.themeDark;
    uniforms.uAnnotationTranscriptPalette = runtimeTheme.transcriptPalette;
    uniforms.uAnnotationRnaPalette = runtimeTheme.rnaPalette;
    if (rolePalette !== this.rolePaletteOverrides) this.setRolePaletteOverrides(rolePalette);
    this.syncRolePalette(themeMode);
    const subpixel = retainedSubpixelOpacityPolicy();
    uniforms.uSubpixelMinWidthPx = subpixel.minWidthPx;
    uniforms.uSubpixelAlphaGamma = subpixel.alphaGamma;
    uniforms.uSubpixelMinAlphaScale = subpixel.minAlphaScale;
    this.viewportUniform[0] = viewportWidth;
    this.viewportUniform[1] = viewportHeight;
  }

  featureIndexFor(partitionKey: string, localInstanceIndex: number): number | null {
    const mode = this.submissionBank ? (this.policyRuntime?.isoformMode ?? null) : null;
    const fine = [...this.fineViews.values()].find(
      (candidate) =>
        candidate.mode === mode &&
        this.fineViewKey(candidate.range.tileIndex, candidate.mode) === partitionKey
    );
    if (fine) {
      const count = fine.geometry?.instanceCount ?? 0;
      if (
        !Number.isInteger(localInstanceIndex) ||
        localInstanceIndex < 0 ||
        localInstanceIndex >= count
      ) {
        return null;
      }
      return fine.featureIndices[fine.featureIndexBase + localInstanceIndex] ?? null;
    }
    const view = this.views.find(
      (candidate) => candidate.partition.key === partitionKey && candidate.mode === mode
    );
    if (!view || localInstanceIndex >= view.geometry.instanceCount) return null;
    if (!view.bankPartition) {
      return featureIndexForPartitionInstance(this.scene, view.partition, localInstanceIndex);
    }
    if (!Number.isInteger(localInstanceIndex) || localInstanceIndex < 0) return null;
    return view.featureIndices[view.partition.firstInstance + localInstanceIndex] ?? null;
  }

  setAlpha(alpha: number): void {
    this.container.alpha = Math.max(0, Math.min(1, alpha));
  }

  hide(): void {
    this.container.visible = false;
  }

  show(): void {
    this.container.visible = true;
  }

  getDebugViews(): PartitionedTranscriptViewDebug[] {
    const coarse = this.views.map(({ partition, geometry, mesh, ownedInstanceBuffer }) => ({
      key: partition.key,
      firstInstance: partition.firstInstance,
      instanceCount: geometry.instanceCount,
      visible: this.container.visible && mesh.visible,
      instanceBaseByteOffset: ownedInstanceBuffer
        ? 0
        : partition.firstInstance * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes,
      ownedInstanceBufferByteLength: ownedInstanceBuffer?.data.byteLength ?? null,
      attributeByteOffsets: Object.fromEntries(
        Object.entries(geometry.attributes)
          .filter(([, attribute]) => attribute.instance)
          .map(([name, attribute]) => [name, attribute.offset ?? 0])
      ),
      viewKind: 'coarse' as const,
    }));
    const fine = [...this.fineViews.values()]
      .filter(
        (view): view is FinePartitionView & { geometry: Geometry; mesh: Mesh<Geometry, Shader> } =>
          view.geometry !== null && view.mesh !== null
      )
      .map(({ range, geometry, mesh, mode, directTile }) => ({
        key: this.fineViewKey(range.tileIndex, mode),
        firstInstance: directTile ? 0 : range.firstInstance,
        instanceCount: geometry.instanceCount,
        visible: this.container.visible && mesh.visible,
        instanceBaseByteOffset:
          (directTile ? 0 : range.firstInstance) * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes,
        ownedInstanceBufferByteLength: directTile?.packedInstanceData.byteLength ?? null,
        attributeByteOffsets: Object.fromEntries(
          Object.entries(geometry.attributes)
            .filter(([, attribute]) => attribute.instance)
            .map(([name, attribute]) => [name, attribute.offset ?? 0])
        ),
        viewKind: 'fine' as const,
      }));
    return [...coarse, ...fine];
  }

  getFineViewDebug(): PartitionedTranscriptFineViewDebug {
    const fineVisibleCount = [...this.fineViews.values()].filter(
      ({ mesh, geometry }) =>
        this.container.visible && mesh?.visible === true && (geometry?.instanceCount ?? 0) > 0
    ).length;
    const coarseVisible =
      this.container.visible &&
      this.views.some(({ mesh, geometry }) => mesh.visible && geometry.instanceCount > 0);
    return {
      presentationMode: this.container.visible ? this.activePresentationMode : 'hidden',
      coarseVisible,
      fineVisibleCount,
      requiredFineCount: this.requiredFineCount,
      fineViewBuildCount: this.fineViewBuildCount,
      fineViewReuseCount: this.fineViewReuseCount,
      fineViewEvictionCount: this.fineViewEvictionCount,
      fineViewFallbackCount: this.fineViewFallbackCount,
      fineViewCacheSize: this.fineViews.size,
      artifactGeneration: this.artifactGeneration,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const fine of this.fineViews.values()) {
      if (fine.mesh) {
        this.container.removeChild(fine.mesh);
        fine.mesh.destroy();
      }
      fine.geometry?.destroy(false);
      fine.ownedInstanceBuffer?.destroy();
    }
    this.fineViews.clear();
    for (const { mesh, geometry, ownedInstanceBuffer } of this.views) {
      this.container.removeChild(mesh);
      mesh.destroy();
      geometry.destroy(false);
      ownedInstanceBuffer?.destroy();
    }
    destroyLayerShader(this.shader);
    this.cornerBuffer.destroy();
    this.instanceBuffer.destroy();
    this.canonicalInstanceBuffer?.destroy();
    this.policyBuffer?.destroy();
    this.container.destroy();
    this.gpuResourcesPrepared = false;
  }

  private createPartitionGeometry(partition: TranscriptInstancePartition): Geometry {
    return this.createInstanceRangeGeometry(
      this.instanceBuffer,
      partition.firstInstance,
      partition.instanceCount,
      this.policyBuffer !== null
    );
  }

  private createDirectCoarseView(
    mode: AnnotationPolicyDirectSubmissionModeV1,
    partition: AnnotationPolicyDirectSubmissionPartitionV1,
    ownPartitionBuffer = false
  ): PartitionView {
    const modeBank = this.submissionBank?.[mode];
    if (!modeBank) {
      throw new Error('partitioned transcript direct coarse view requires a submission bank');
    }
    const sharedBuffer = mode === 'expanded' ? this.instanceBuffer : this.canonicalInstanceBuffer;
    if (!sharedBuffer) {
      throw new Error('partitioned transcript direct coarse view buffer is unavailable');
    }
    const floatsPerInstance =
      TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes / Float32Array.BYTES_PER_ELEMENT;
    const ownedInstanceBuffer = ownPartitionBuffer
      ? new PixiBuffer({
          data: modeBank.packedInstanceData.subarray(
            partition.firstInstance * floatsPerInstance,
            (partition.firstInstance + partition.instanceCount) * floatsPerInstance
          ),
          usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | BufferUsage.STATIC,
          label: `partitioned-transcript-bank-coarse-${mode}-${partition.key}`,
          shrinkToFit: false,
        })
      : null;
    let geometry: Geometry | null = null;
    try {
      geometry = this.createInstanceRangeGeometry(
        ownedInstanceBuffer ?? sharedBuffer,
        ownedInstanceBuffer ? 0 : partition.firstInstance,
        partition.instanceCount,
        false
      );
      const mesh = new Mesh({ geometry, shader: this.shader, state: State.for2d() });
      mesh.eventMode = 'none';
      mesh.visible = false;
      this.container.addChild(mesh);
      return {
        partition,
        geometry,
        mesh,
        mode,
        featureIndices: modeBank.featureIndices,
        bankPartition: partition,
        ownedInstanceBuffer,
      };
    } catch (error) {
      geometry?.destroy(false);
      ownedInstanceBuffer?.destroy();
      throw error;
    }
  }

  private createInstanceRangeGeometry(
    instanceBuffer: PixiBuffer,
    firstInstance: number,
    instanceCount: number,
    policyEnabled: boolean
  ): Geometry {
    const base = firstInstance * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes;
    const instanceAttribute = (floatOffset: number, format: 'float32' | 'float32x4') => ({
      buffer: instanceBuffer,
      format,
      stride: TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes,
      offset: base + floatOffset * Float32Array.BYTES_PER_ELEMENT,
      instance: true,
    });
    const attributes = {
      aCorner: { buffer: this.cornerBuffer, format: 'float32' as const },
      aBpStartChunk: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk, 'float32'),
      aBpStartDelta: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta, 'float32'),
      aBpEndChunk: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk, 'float32'),
      aBpEndDelta: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta, 'float32'),
      aOffsetCenter: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter, 'float32'),
      aHalfH: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH, 'float32'),
      aDirSign: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.dirSign, 'float32'),
      aCdsFade: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.cdsFade, 'float32'),
      aColor: instanceAttribute(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color, 'float32x4'),
    };
    if (policyEnabled && this.policyBuffer) {
      const policyBase = firstInstance * ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideBytes;
      Object.assign(attributes, {
        aPolicyLanes: {
          buffer: this.policyBuffer,
          format: 'float32x4' as const,
          stride: ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.strideBytes,
          offset:
            policyBase +
            ANNOTATION_POLICY_GPU_INSTANCE_LAYOUT.expandedLane * Float32Array.BYTES_PER_ELEMENT,
          instance: true,
        },
      });
    }
    return new Geometry({
      attributes,
      topology: 'triangle-list',
      instanceCount,
    });
  }

  private fineViewCacheKey(
    tileIndex: number,
    mode: AnnotationPolicyDirectSubmissionModeV1 | null
  ): string {
    return `${tileIndex}:${mode ?? 'fallback'}`;
  }

  private fineViewKey(
    tileIndex: number,
    mode: AnnotationPolicyDirectSubmissionModeV1 | null = null
  ): string {
    const base = `${this.artifactGeneration.length}:${this.artifactGeneration}|fine-512k:${tileIndex}`;
    return mode ? `${base}|mode:${mode}` : base;
  }

  private evictFineViewsToLimit(protectedKeys: ReadonlySet<string>): number {
    let evicted = 0;
    while (this.fineViews.size > this.maxFineViews) {
      const candidate = [...this.fineViews.entries()]
        .filter(([key, fine]) => {
          if (protectedKeys.has(key)) return false;
          return fine.mesh?.visible !== true;
        })
        .sort(
          (left, right) => left[1].lastUsed - right[1].lastUsed || left[0].localeCompare(right[0])
        )[0];
      if (!candidate) break;
      const [key, fine] = candidate;
      this.fineViews.delete(key);
      if (fine.mesh) {
        this.container.removeChild(fine.mesh);
        fine.mesh.destroy();
      }
      fine.geometry?.destroy(false);
      fine.ownedInstanceBuffer?.destroy();
      this.fineViewEvictionCount += 1;
      evicted += 1;
    }
    return evicted;
  }

  private setSubmissionDebug(
    mode: AnnotationPolicyDirectSubmissionModeV1,
    actualSubmittedInstanceCount: number,
    hiddenByIsoformMembershipInstanceCount: number,
    hiddenByLaneCapInstanceCount: number,
    visibleDrawCount: number
  ): void {
    this.submissionDebug = {
      directBankEnabled: true,
      activeMode: mode,
      actualSubmittedInstanceCount,
      actualSubmittedVertexCount:
        actualSubmittedInstanceCount * TRANSCRIPT_GLYPH_INSTANCE_CORNERS.length,
      hiddenByIsoformMembershipInstanceCount,
      hiddenByLaneCapInstanceCount,
      visibleDrawCount,
    };
  }

  private refreshFallbackSubmissionDebug(): void {
    const visible = [
      ...this.views
        .filter(({ mesh }) => mesh.visible)
        .map(({ geometry }) => geometry.instanceCount),
      ...[...this.fineViews.values()]
        .filter(({ mesh }) => mesh?.visible === true)
        .map(({ geometry }) => geometry?.instanceCount ?? 0),
    ];
    const actualSubmittedInstanceCount = visible.reduce((sum, count) => sum + count, 0);
    this.submissionDebug = {
      directBankEnabled: false,
      activeMode: this.policyRuntime?.isoformMode ?? null,
      actualSubmittedInstanceCount,
      actualSubmittedVertexCount:
        actualSubmittedInstanceCount * TRANSCRIPT_GLYPH_INSTANCE_CORNERS.length,
      hiddenByIsoformMembershipInstanceCount: 0,
      hiddenByLaneCapInstanceCount: 0,
      visibleDrawCount: visible.filter((count) => count > 0).length,
    };
  }

  private createShader(policyEnabled: boolean): Shader {
    const subpixel = retainedSubpixelOpacityPolicy();
    const runtimeTheme = indexedAnnotationRuntimeThemeUniforms(this.trackType, 'light');
    return new Shader({
      glProgram: partitionedTranscriptGlProgram(policyEnabled),
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
          uRolePalette: {
            value: new Float32Array(ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1 * 4),
            type: 'vec4<f32>',
            size: ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1,
          },
          uViewportSize: { value: this.viewportUniform, type: 'vec2<f32>' },
          ...(policyEnabled
            ? {
                uPolicyIsoformMode: { value: 0, type: 'f32' },
                uPolicyLaneLimit: { value: -1, type: 'f32' },
              }
            : {}),
        },
      },
    });
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('PartitionedInstancedTranscriptLayer is destroyed');
  }
}

function assertSceneRanges(scene: GpuReadyPartitionedTranscriptScene): void {
  let expectedFirst = 0;
  let previousPartitionIndex = -1;
  for (const partition of scene.partitions) {
    if (
      partition.firstInstance !== expectedFirst ||
      partition.instanceCount <= 0 ||
      partition.partitionIndex <= previousPartitionIndex ||
      partition.startBp !== partition.partitionIndex * scene.partitionSpanBp
    ) {
      throw new Error('partition scene ranges must be positive, sorted, and contiguous');
    }
    expectedFirst += partition.instanceCount;
    previousPartitionIndex = partition.partitionIndex;
  }
  if (
    expectedFirst !== scene.featureIndices.length ||
    scene.packedInstanceData.byteLength !==
      expectedFirst * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes
  ) {
    throw new Error('partition scene ranges do not cover the immutable instance buffer exactly');
  }
}

function markRoleCodedBanks(
  bank: AnnotationPolicyDirectSubmissionBankV1 | undefined,
  roles: PartitionedTranscriptSceneRoleSidecarV1 | undefined
): readonly AnnotationColorRoleKeyV1[] | null {
  if (!bank || !roles) return null;
  const tableLength = roles.roleTable.length;
  if (tableLength === 0 || tableLength > ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1) return null;
  const fits = (indices: Uint8Array, records: number) =>
    indices.length === records && indices.every((index) => index < tableLength);
  if (
    !fits(roles.expandedRoleIndices, bank.expanded.featureIndices.length) ||
    !fits(roles.canonicalRoleIndices, bank.canonical.featureIndices.length)
  ) {
    return null;
  }
  const { strideFloats, color } = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT;
  markAnnotationRoleCodedInstancesV1(
    bank.expanded.packedInstanceData,
    roles.expandedRoleIndices,
    strideFloats,
    color
  );
  markAnnotationRoleCodedInstancesV1(
    bank.canonical.packedInstanceData,
    roles.canonicalRoleIndices,
    strideFloats,
    color
  );
  return [...roles.roleTable];
}

function validatePolicyRuntime(runtime: AnnotationPolicyGpuRuntimeV1): void {
  if (runtime.isoformMode !== 'canonical' && runtime.isoformMode !== 'expanded') {
    throw new Error('partitioned transcript annotation isoform mode is invalid');
  }
  if (
    runtime.laneLimit !== null &&
    (!Number.isSafeInteger(runtime.laneLimit) ||
      runtime.laneLimit <= 0 ||
      runtime.laneLimit > ANNOTATION_POLICY_GPU_MAX_EXACT_LANE)
  ) {
    throw new Error('partitioned transcript annotation lane limit is invalid');
  }
}
