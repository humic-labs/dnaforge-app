import type {
  AnnotationFlatPresentationSnapshot,
  AnnotationPresentationSnapshot,
  AnnotationPresentationSnapshotApplyResult,
  AnnotationResidentPagePublication,
  AnnotationResidentPagePublicationApplyResult,
  Genome,
} from '../../types';
import {
  annotationCodonCarrierSignatures,
  PixiLinearRenderer,
  type GenomeWideTextureExtractResult,
} from './linear-renderer';
import { IndexedAnnotationOverlay } from './overlays/annotation-overlay';
import type { AnnotationPresentationPolicyCommitDispositionV1 } from './overlays/annotation-overlay';
import type { ForcedLinearTranscriptPresentationTestState } from './overview/retained-linear-transcript-layer';
import type {
  CompiledBroadSurfaceAdmissionProvenanceV1,
  CompiledBroadSurfaceManifestV2,
} from './overview/bounded-annotation-broad-surface';
import type { CompiledBroadSurfaceCellAdmissionResultV2 } from './overview/compiled-broad-surface-pixi-presenter';
import type { PrebuiltGenomeWideTextureMeta } from './overview/genome-wide-texture-cache-layer';
import type { AnnotationSidecarRasterExternalSources } from './overview/annotation-sidecar-raster-presenter';
import type {
  PrepackedAnnotationSceneBuildOptions,
  PrepackedAnnotationSceneLoadInput,
  PrepackedAnnotationSceneOwnerSnapshot,
} from './overview/prepacked-annotation-scene';
import type { AnnotationPolicyGpuRuntimeV1 } from './overview/annotation-policy-gpu-instances-v1';
import type {
  CompiledBroadAnnotationInteractionAuthoritySnapshotV1,
  CompiledBroadAnnotationInteractionLoadInputV1,
  CompiledBroadSurfaceDemandV2,
  CompiledBroadSurfaceRequirementV1,
  CompiledBroadSurfaceSourcePlacementAuthorityV1,
  CompiledBroadSurfaceRgbaCellAdmissionInputV2,
  CompiledBroadSurfaceRgbaCellAdmissionResultV2,
  CompiledBroadSurfaceResidentLeaseReconcileResultV1,
  CompiledBroadSurfaceRuntimeDiagnosticsV2,
  CompiledBroadSurfaceTextureCellAdmissionInputV2,
  CompiledBroadSurfaceTransparentCellAdmissionInputV2,
  PrepackedAnnotationFinePreparationResult,
} from './overlays/annotation-overlay';

export class IndexedPixiLinearRenderer extends PixiLinearRenderer {
  protected override readonly defaultCdsSizing = 'cohesive';
  constructor() {
    super({ overlay: new IndexedAnnotationOverlay() });
  }

  private get indexedOverlay(): IndexedAnnotationOverlay {
    return this.annotationOverlay as IndexedAnnotationOverlay;
  }

  buildAndExtractGenomeWideTexturePng(): Promise<GenomeWideTextureExtractResult | null> {
    return this.indexedOverlay.buildAndExtractGenomeWideTexturePng();
  }

  async buildAndExtractGenomeWideTextureForGenome(
    precomputeGenome: Genome
  ): Promise<GenomeWideTextureExtractResult | null> {
    if (!this.genome || !this.getState) return null;
    const visibleGenome = this.genome;
    const visibleState = { ...this.getState() };
    const precomputeState = {
      ...visibleState,
      viewOffset: 0,
      zoom: 1,
      viewportRange: [0, precomputeGenome.length] as [number, number],
    };

    try {
      await this.loadGenome(precomputeGenome);
      this.render(precomputeState);
      return await this.buildAndExtractGenomeWideTexturePng();
    } finally {
      await this.loadGenome(visibleGenome);
      this.render(visibleState);
    }
  }

  loadPrebuiltGenomeWideTexture(image: ImageBitmap, meta: PrebuiltGenomeWideTextureMeta): void {
    this.indexedOverlay.loadPrebuiltGenomeWideTexture(image, meta);
  }

  commitPrebuiltGenomeWideTexturePolicy(
    image: ImageBitmap,
    meta: PrebuiltGenomeWideTextureMeta,
    policy: AnnotationPolicyGpuRuntimeV1
  ): boolean {
    const committed = this.indexedOverlay.commitPrebuiltGenomeWideTexturePolicy(
      image,
      meta,
      policy
    );
    if (committed) {
      this.recordRendererContentOperation('prepackedPolicyUpdate');
      this.syncAnnotationLaneEnvelopeFromOverlay();
    }
    return committed;
  }

  clearPrebuiltGenomeWideTexture(): void {
    this.indexedOverlay.clearPrebuiltGenomeWideTexture();
  }

  isPrebuiltGenomeWideTextureLoaded(): boolean {
    return this.indexedOverlay.isPrebuiltGenomeWideTextureLoaded();
  }

  loadCompiledBroadSurfaceManifest(
    manifest: CompiledBroadSurfaceManifestV2,
    provenance: CompiledBroadSurfaceAdmissionProvenanceV1
  ): boolean {
    const loaded = this.indexedOverlay.loadCompiledBroadSurfaceManifest(manifest, provenance);
    if (loaded) this.syncAnnotationLaneEnvelopeFromOverlay();
    return loaded;
  }

  loadCompiledBroadAnnotationInteraction(
    input: CompiledBroadAnnotationInteractionLoadInputV1
  ): CompiledBroadAnnotationInteractionLoadInputV1 | null {
    return this.indexedOverlay.loadCompiledBroadAnnotationInteraction(input);
  }

  admitCompiledBroadSurfaceSourcePlacementAuthority(
    authority: CompiledBroadSurfaceSourcePlacementAuthorityV1
  ): boolean {
    return this.indexedOverlay.admitCompiledBroadSurfaceSourcePlacementAuthority(authority);
  }

  requireCompiledBroadSurface(requirement: CompiledBroadSurfaceRequirementV1): boolean {
    return this.indexedOverlay.requireCompiledBroadSurface(requirement);
  }

  admitCompiledBroadSurfaceCellTexture(
    input: CompiledBroadSurfaceTextureCellAdmissionInputV2
  ): CompiledBroadSurfaceCellAdmissionResultV2 {
    return this.indexedOverlay.admitCompiledBroadSurfaceCellTexture(input);
  }

  admitCompiledBroadSurfaceRgbaCell(
    input: CompiledBroadSurfaceRgbaCellAdmissionInputV2
  ): CompiledBroadSurfaceRgbaCellAdmissionResultV2 {
    return this.indexedOverlay.admitCompiledBroadSurfaceRgbaCell(input);
  }

  admitCompiledBroadSurfaceTransparentCell(
    input: CompiledBroadSurfaceTransparentCellAdmissionInputV2
  ): CompiledBroadSurfaceRgbaCellAdmissionResultV2 {
    return this.indexedOverlay.admitCompiledBroadSurfaceTransparentCell(input);
  }

  getCompiledBroadSurfaceDemand(
    policy?: AnnotationPolicyGpuRuntimeV1,
    manifestFingerprint?: string
  ): CompiledBroadSurfaceDemandV2 {
    return this.indexedOverlay.getCompiledBroadSurfaceDemand(policy, manifestFingerprint);
  }

  isCompiledBroadSurfaceDemandRefreshRequired(
    policy: AnnotationPolicyGpuRuntimeV1,
    manifestFingerprint: string
  ): boolean {
    return this.indexedOverlay.isCompiledBroadSurfaceDemandRefreshRequired(
      policy,
      manifestFingerprint
    );
  }

  reconcileCompiledBroadSurfaceResidentLeases(
    demandLeaseIds: readonly string[]
  ): CompiledBroadSurfaceResidentLeaseReconcileResultV1 {
    return this.indexedOverlay.reconcileCompiledBroadSurfaceResidentLeases(demandLeaseIds);
  }

  getCompiledBroadSurfaceDiagnostics(): CompiledBroadSurfaceRuntimeDiagnosticsV2 | null {
    return this.indexedOverlay.getCompiledBroadSurfaceDiagnostics();
  }

  clearCompiledBroadSurfaceManifest(manifestFingerprint?: string): void {
    this.indexedOverlay.clearCompiledBroadSurfaceManifest(manifestFingerprint);
  }

  clearCompiledBroadSurfaceRequirement(): void {
    this.indexedOverlay.clearCompiledBroadSurfaceRequirement();
  }

  installSidecarRasterSource(sources: AnnotationSidecarRasterExternalSources): void {
    this.indexedOverlay.installSidecarRasterSource(sources);
  }

  clearSidecarRasterSource(): void {
    this.indexedOverlay.clearSidecarRasterSource();
  }

  setSidecarRasterVisibleTypes(types: readonly string[]): void {
    this.indexedOverlay.setSidecarRasterVisibleTypes(types);
  }

  getSidecarRasterVisibleTypes(): readonly string[] {
    return this.indexedOverlay.getSidecarRasterVisibleTypes();
  }

  setSidecarRasterLaneLimit(laneLimit: number): void {
    this.indexedOverlay.setSidecarRasterLaneLimit(laneLimit);
  }

  getSidecarRasterLaneLimit(): number {
    return this.indexedOverlay.getSidecarRasterLaneLimit();
  }

  getSidecarRasterAvailableTypes(): readonly string[] {
    return this.indexedOverlay.getSidecarRasterAvailableTypes();
  }

  loadPrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean {
    this.recordRendererContentOperation('prepackedLoad');
    const loaded = this.indexedOverlay.loadPrepackedAnnotationScene(input);
    if (loaded) this.syncAnnotationLaneEnvelopeFromOverlay();
    return loaded;
  }

  preparePrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean {
    this.recordRendererContentOperation('prepackedPrepare');
    const prepared = this.indexedOverlay.preparePrepackedAnnotationScene(input);
    if (prepared) this.syncAnnotationLaneEnvelopeFromOverlay();
    return prepared;
  }

  preparePrepackedAnnotationFineViews(
    viewportStartBp: number,
    viewportEndBp: number,
    themeMode = this.getState?.().themeMode ?? 'light'
  ): PrepackedAnnotationFinePreparationResult {
    return this.indexedOverlay.preparePrepackedAnnotationFineViews(
      viewportStartBp,
      viewportEndBp,
      themeMode
    );
  }

  admitPrepackedAnnotationViewportDetailRoster(
    viewportStartBp: number,
    viewportEndBp: number,
    themeMode = this.getState?.().themeMode ?? 'light'
  ): boolean {
    return this.indexedOverlay.admitPrepackedAnnotationViewportDetailRoster(
      viewportStartBp,
      viewportEndBp,
      themeMode
    );
  }

  releaseForcedDoubleDrawForTest(): ForcedLinearTranscriptPresentationTestState {
    return this.indexedOverlay.releaseForcedDoubleDrawForTest();
  }

  activatePrepackedAnnotationScene(ownerKey: string): boolean {
    this.recordRendererContentOperation('prepackedActivate');
    const activated = this.indexedOverlay.activatePrepackedAnnotationScene(ownerKey);
    if (activated) this.syncAnnotationLaneEnvelopeFromOverlay();
    return activated;
  }

  updatePrepackedAnnotationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean {
    this.recordRendererContentOperation('prepackedPolicyUpdate');
    const updated = this.indexedOverlay.updatePrepackedAnnotationPolicy(policy);
    if (!updated) return false;
    this.syncAnnotationLaneEnvelopeFromOverlay();
    return true;
  }

  updateAnnotationPresentationPolicy(policy: AnnotationPolicyGpuRuntimeV1): boolean {
    this.recordRendererContentOperation('prepackedPolicyUpdate');
    const updated = this.indexedOverlay.updateAnnotationPresentationPolicy(policy);
    if (!updated) return false;
    this.syncAnnotationLaneEnvelopeFromOverlay();
    return true;
  }

  commitAnnotationPresentationPolicy(
    policy: AnnotationPolicyGpuRuntimeV1
  ): AnnotationPresentationPolicyCommitDispositionV1 {
    this.recordRendererContentOperation('prepackedPolicyUpdate');
    const disposition = this.indexedOverlay.commitAnnotationPresentationPolicy(policy);
    if (disposition.status !== 'committed') return disposition;
    this.syncAnnotationLaneEnvelopeFromOverlay();
    return disposition;
  }

  clearPrepackedAnnotationScene(): void {
    this.recordRendererContentOperation('prepackedRetire');
    this.indexedOverlay.clearPrepackedAnnotationScene();
    this.syncAnnotationLaneEnvelopeFromOverlay();
  }

  getPrepackedAnnotationSceneOwnerSnapshot(): PrepackedAnnotationSceneOwnerSnapshot {
    return this.indexedOverlay.getPrepackedAnnotationSceneOwnerSnapshot();
  }

  getAnnotationBodyPresentationAuthoritySnapshot() {
    return this.indexedOverlay.getAnnotationBodyPresentationAuthoritySnapshot();
  }

  getCompiledBroadAnnotationInteractionAuthoritySnapshot(): CompiledBroadAnnotationInteractionAuthoritySnapshotV1 {
    return this.indexedOverlay.getCompiledBroadAnnotationInteractionAuthoritySnapshot();
  }

  buildAndLoadPrepackedAnnotationScene(
    options: PrepackedAnnotationSceneBuildOptions
  ): PrepackedAnnotationSceneLoadInput | null {
    this.recordRendererContentOperation('prepackedLoad');
    const input = this.indexedOverlay.buildAndLoadPrepackedAnnotationScene(options);
    if (input) this.syncAnnotationLaneEnvelopeFromOverlay();
    return input;
  }

  setAnnotationPresentationSnapshot(
    snapshot: AnnotationPresentationSnapshot
  ): AnnotationPresentationSnapshotApplyResult {
    return this.applyAnnotationOnlyPublication(() =>
      this.indexedOverlay.setAnnotationPresentationSnapshot(snapshot)
    );
  }

  setAnnotationFlatPresentationSnapshot(
    snapshot: AnnotationFlatPresentationSnapshot
  ): AnnotationPresentationSnapshotApplyResult {
    return this.applyAnnotationOnlyPublication(() =>
      this.indexedOverlay.setAnnotationFlatPresentationSnapshot(snapshot)
    );
  }

  ingestAnnotationResidentPages(
    publication: AnnotationResidentPagePublication
  ): AnnotationResidentPagePublicationApplyResult {
    return this.applyAnnotationOnlyPublication(() =>
      this.indexedOverlay.ingestAnnotationResidentPages(publication)
    );
  }

  private applyAnnotationOnlyPublication(
    apply: () => AnnotationPresentationSnapshotApplyResult
  ): AnnotationPresentationSnapshotApplyResult {
    this.recordRendererContentOperation('annotationSnapshotAttempt');
    if (!this.genome) return { status: 'rejected', reason: 'no-genome' };
    const result = apply();
    if (result.status !== 'applied') return result;
    this.recordRendererContentOperation('annotationSnapshotApply');
    this.syncAnnotationLaneEnvelopeFromOverlay();
    const nextFeatures = this.indexedOverlay.getAnnotationPresentationFeatures();
    const nextSignatures = annotationCodonCarrierSignatures(nextFeatures);
    for (const [featureId, previousSignature] of this.annotationCodonCarrierSignatures) {
      if (nextSignatures.get(featureId) !== previousSignature) this.codonCache.delete(featureId);
    }
    this.annotationFeatures = nextFeatures;
    this.annotationCodonCarrierSignatures = nextSignatures;
    this.annotationHasDirectionalCds = nextSignatures.size > 0;
    this.annotationResidentFeatureSelectionKey = null;
    return result;
  }
}
