import {
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  resolveAnnotationTrackIdentity,
} from '@waypoint/genome-renderer';
import { compiledBroadSurfaceOwnsViewportV2 } from '@waypoint/genome-renderer/pure';

import {
  assemblyAnnotationSceneGenomeIdentityV1,
  assemblyAnnotationSceneScopeMatchesChromosomes,
  type AssemblyAnnotationSceneSourceRequest,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyReferenceAssetGenerationV1,
} from '../../../shared/indexed-genome';
import type { AnnotationSearchReveal } from '../annotation-search-reveal';
import type { IndexedGenomeAnnotationMapperPolicy } from './AssemblyCompiledAnnotationTrack';
import type { FilteredRendererFeatureResult } from './indexed-genome-legacy-adapter';
import type { SequenceViewportRange } from './indexed-sequence-window-policy';
import { sameAnnotationMapperPolicy } from './useIndexedAnnotationMapperPolicy';
import type { AssemblyOverviewTextureStatus } from './useAssemblyOverviewTexture';

export const EMPTY_FILTERED_RENDERER_FEATURES: FilteredRendererFeatureResult = Object.freeze({
  features: [],
  droppedCount: 0,
  typeFilteredCount: 0,
});

export type RetainedAssemblyAnnotationSourceIdentity = {
  sourceScopeKey: string;
  sourceIdentity: string | null;
};

export function firstPresent<T>(
  primary: T | null | undefined,
  secondary: T | null | undefined,
  fallback: T
): T {
  return primary ?? secondary ?? fallback;
}

export function admittedAnnotationSceneSourceIdentity(
  request: object | null | undefined
): string | null {
  if (!request || !('datasetContract' in request)) return null;
  return assemblyAnnotationSceneGenomeIdentityV1(
    request as Pick<AssemblyAnnotationSceneReadRequest, 'datasetContract'>
  );
}

export function descriptorAnnotationSourceIdentity(
  admittedSourceIdentity: string | null,
  descriptorSourceIdentity: string | null | undefined
): string | null {
  const trimmed = descriptorSourceIdentity?.trim();
  return admittedSourceIdentity ?? (trimmed ? trimmed : null);
}

export function admittedAnnotationSourceFingerprint(cache: {
  status: string;
  result?: { fingerprint?: string } | null;
}): string | null {
  return cache.status === 'hit' ? (cache.result?.fingerprint ?? null) : null;
}

export function nextRetainedAnnotationSourceIdentity(
  annotationSourceScopeKey: string | null,
  descriptorSourceIdentity: string | null,
  retained: RetainedAssemblyAnnotationSourceIdentity | null
): {
  retained: RetainedAssemblyAnnotationSourceIdentity | null;
  stableIdentity: string | null;
} {
  if (!annotationSourceScopeKey) {
    return { retained: null, stableIdentity: null };
  }
  if (descriptorSourceIdentity) {
    return {
      retained: {
        sourceScopeKey: annotationSourceScopeKey,
        sourceIdentity: descriptorSourceIdentity,
      },
      stableIdentity: descriptorSourceIdentity,
    };
  }
  if (retained?.sourceScopeKey === annotationSourceScopeKey) {
    return { retained, stableIdentity: retained.sourceIdentity };
  }
  return {
    retained: { sourceScopeKey: annotationSourceScopeKey, sourceIdentity: null },
    stableIdentity: null,
  };
}

export function isCompiledBroadOwnedAssembly(
  rendererAssembly: object | null | undefined,
  compiledBroadSurfaceRequirement: object | null | undefined
): boolean {
  return Boolean(rendererAssembly && compiledBroadSurfaceRequirement);
}

export function isIndexedGenomeAssemblyRoutingEnabled(
  rendererAssembly: object | null | undefined,
  assemblySessionConfigs: ReadonlyArray<unknown> | undefined
): boolean {
  return Boolean(rendererAssembly && assemblySessionConfigs && assemblySessionConfigs.length > 0);
}

export function suppliedOrLocalAnnotationMapperPolicy<T>(
  controlled: T | undefined,
  uncontrolled: T
): T {
  return controlled ?? uncontrolled;
}

export function compiledBroadMaxSupportedFiniteLaneLimit(
  compiledBroadSurfaceRequirement: object | null | undefined
): number | null {
  return compiledBroadSurfaceRequirement ? COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 : null;
}

export function pendingAnnotationTargetCache<TPolicy, TCache>(
  pendingAnnotationMapperPolicy: { policy: TPolicy } | null,
  cacheForAnnotationPolicy: (policy: TPolicy) => TCache
): TCache | null {
  return pendingAnnotationMapperPolicy
    ? cacheForAnnotationPolicy(pendingAnnotationMapperPolicy.policy)
    : null;
}

export function isExactMrnaLayerContract(
  compiledBroadSurfaceRequirement: object | null | undefined,
  rendererEffectiveVisibleLayerTypes: readonly string[]
): boolean {
  return (
    !compiledBroadSurfaceRequirement &&
    rendererEffectiveVisibleLayerTypes.length === 1 &&
    rendererEffectiveVisibleLayerTypes[0] === 'mRNA'
  );
}

export function compiledResidentOwnerReadinessScopeKey(input: {
  identityKey: string | null | undefined;
  sourceScopeKey: string | null;
  runtimeCacheKey: string | null | undefined;
  assetGenerationKey: string;
  rendererReadyEpoch: number;
  rendererGenomeCommitEpoch: number;
}): string {
  return [
    input.identityKey ?? 'not-compiled',
    input.sourceScopeKey ?? 'no-source-scope',
    input.runtimeCacheKey ?? 'no-scene-descriptor',
    input.assetGenerationKey,
    input.rendererReadyEpoch,
    input.rendererGenomeCommitEpoch,
  ].join('\n');
}

export function compiledBroadSelectedTargetRosterKey(
  ready: boolean,
  receipts: ReadonlyArray<{
    trackType: string;
    receipt: { targetIdentityKey: string | null } | null;
  }>
): string | null {
  return ready
    ? receipts
        .map(({ trackType, receipt }) => `${trackType}:${receipt!.targetIdentityKey}`)
        .join('\n')
    : null;
}

export function overviewAnnotationAuthorityComplete(
  overviewFeaturesComplete: boolean,
  assemblyColdInteractionReady: boolean
): boolean {
  return overviewFeaturesComplete || assemblyColdInteractionReady;
}

export function viewerDevicePixelRatio(
  win: { devicePixelRatio?: number } | undefined = typeof window === 'undefined'
    ? undefined
    : window
): number {
  if (!win) return 1;
  return Math.max(1, win.devicePixelRatio || 1);
}

export function compiledBroadOwnsSceneViewport(input: {
  requirement: { broadCorridorFinestSpanBp: number } | null;
  sceneViewportRange: SequenceViewportRange | null;
  containerWidth: number;
}): boolean {
  return Boolean(
    input.requirement &&
    input.sceneViewportRange &&
    compiledBroadSurfaceOwnsViewportV2({
      broadCorridorFinestSpanBp: input.requirement.broadCorridorFinestSpanBp,
      viewportSpanBp: input.sceneViewportRange.end - input.sceneViewportRange.start,
      viewportCssWidthPx: Math.max(1, input.containerWidth),
      devicePixelRatio: viewerDevicePixelRatio(),
    })
  );
}

export function residentCoordinatePagesCoverSceneViewport(
  sceneViewportRange: SequenceViewportRange | null,
  coverage: ReadonlyArray<{ startBp: number; endBp: number }>
): boolean {
  return Boolean(
    sceneViewportRange &&
    coverage.some(
      (item) => item.startBp <= sceneViewportRange.start && item.endBp >= sceneViewportRange.end
    )
  );
}

export function isIndexedGenomeAnnotationOwnerPending(input: {
  annotationsVisible: boolean;
  compiledBroadSurfaceRequirement: object | null | undefined;
  sceneViewportRange: SequenceViewportRange | null;
  compiledBroadOwnsSceneViewport: boolean;
  compiledResidentSceneCoversViewport: boolean;
  residentCoordinatePagesCoverSceneViewport: boolean;
}): boolean {
  return (
    input.annotationsVisible &&
    Boolean(input.compiledBroadSurfaceRequirement && input.sceneViewportRange) &&
    !input.compiledBroadOwnsSceneViewport &&
    !input.compiledResidentSceneCoversViewport &&
    !input.residentCoordinatePagesCoverSceneViewport
  );
}

export function createIndexedGenomeViewerInstanceId(
  cryptoObj: Crypto | undefined = typeof crypto === 'undefined' ? undefined : crypto
): string {
  return cryptoObj && 'randomUUID' in cryptoObj
    ? cryptoObj.randomUUID()
    : `indexed-genome-${Math.random().toString(36).slice(2)}`;
}

export function stickyTrue(previous: boolean, next: boolean): boolean {
  return next ? true : previous;
}

export function stickyActivatedTick(hasBeenActive: boolean): number {
  return hasBeenActive ? 1 : 0;
}

export function laneAssemblyId(
  trackAssemblyId: string | undefined,
  rendererAssemblyId: string | undefined,
  manifestChrom: string
): string {
  return trackAssemblyId ?? rendererAssemblyId ?? manifestChrom;
}

export function assemblyDisplayName(
  assemblyDefinitionDisplayName: string | undefined,
  rendererAssemblyDisplayName: string | undefined,
  fallback: string
): string {
  return assemblyDefinitionDisplayName ?? rendererAssemblyDisplayName ?? fallback;
}

export function isPendingAnnotationRasterReady(input: {
  pendingAnnotationMapperPolicy: {
    requestId: number;
    policy: IndexedGenomeAnnotationMapperPolicy;
  } | null;
  annotationMapperPolicyRasterPreparation:
    | {
        requestId: number;
        policy: IndexedGenomeAnnotationMapperPolicy;
        status: 'loading' | 'ready' | 'miss' | 'error';
      }
    | null
    | undefined;
}): boolean {
  const pending = input.pendingAnnotationMapperPolicy;
  const preparation = input.annotationMapperPolicyRasterPreparation;
  return (
    pending !== null &&
    preparation !== null &&
    preparation !== undefined &&
    preparation.status === 'ready' &&
    pending.requestId === preparation.requestId &&
    sameAnnotationMapperPolicy(pending.policy, preparation.policy)
  );
}

export function atomicAnnotationRasterRequest<T>(
  compiledBroadSurfaceRequirement: object | null | undefined,
  annotationRasterPolicyGateEnabled: boolean,
  pendingAnnotationRasterReady: boolean,
  pendingAnnotationMapperPolicy: T
): T | null {
  return !compiledBroadSurfaceRequirement &&
    annotationRasterPolicyGateEnabled &&
    pendingAnnotationRasterReady
    ? pendingAnnotationMapperPolicy
    : null;
}

export function compiledBroadOverviewTexture<T>(
  compiledBroadSurfaceRequirement: object | null | undefined,
  overviewTexture: T
): T | null {
  return compiledBroadSurfaceRequirement ? null : overviewTexture;
}

export function compiledBroadOverviewTextureStatus(
  compiledBroadSurfaceRequirement: object | null | undefined,
  overviewTextureStatus: AssemblyOverviewTextureStatus
): AssemblyOverviewTextureStatus {
  return compiledBroadSurfaceRequirement ? 'not-applicable' : overviewTextureStatus;
}

export function compiledBroadRasterThemeMode(
  themeMode: 'light' | 'dark' | undefined
): 'light' | 'dark' {
  return themeMode ?? 'light';
}

export function retainCompiledBroadTrackMountTypes(
  current: { scopeKey: string; trackTypes: Set<string> },
  scopeKey: string,
  visibleLayerTypes: readonly string[],
  bootstrapTrackType: string | null
): { scopeKey: string; trackTypes: Set<string> } {
  const next =
    current.scopeKey === scopeKey ? current : { scopeKey, trackTypes: new Set<string>() };
  for (const trackType of visibleLayerTypes) {
    next.trackTypes.add(trackType);
  }
  if (!bootstrapTrackType) return next;
  const mountedBootstrap = resolveAnnotationTrackIdentity(
    bootstrapTrackType,
    next.trackTypes,
    (mountedTrackType) => mountedTrackType
  );
  if (mountedBootstrap.status === 'missing') {
    next.trackTypes.add(bootstrapTrackType);
  }
  return next;
}

export function pendingAnnotationRasterCommitted(input: {
  compiledBroadSurfaceRequirement: object | null | undefined;
  annotationRasterPolicyGateEnabled: boolean;
  pendingAnnotationMapperPolicy: {
    requestId: number;
    policy: IndexedGenomeAnnotationMapperPolicy;
  } | null;
  annotationRasterAtomicCommit: {
    status: string;
    requestId: number | null;
    policy: IndexedGenomeAnnotationMapperPolicy | null;
  };
}): boolean {
  const pending = input.pendingAnnotationMapperPolicy;
  const commit = input.annotationRasterAtomicCommit;
  return (
    !input.compiledBroadSurfaceRequirement &&
    (!input.annotationRasterPolicyGateEnabled ||
      (pending !== null &&
        commit.status === 'committed' &&
        commit.requestId === pending.requestId &&
        commit.policy !== null &&
        sameAnnotationMapperPolicy(commit.policy, pending.policy)))
  );
}

export function presentationAnnotationMapperPolicy<T>(
  pendingAnnotationMapperPolicy: { policy: T } | null,
  pendingAnnotationRasterCommitted: boolean,
  annotationMapperPolicy: T
): T {
  return pendingAnnotationMapperPolicy && pendingAnnotationRasterCommitted
    ? pendingAnnotationMapperPolicy.policy
    : annotationMapperPolicy;
}

export function presentationCacheForCompiledBroad<T>(
  compiledBroadSurfaceRequirement: object | null | undefined,
  prepackedAnnotationSceneCache: T,
  notApplicableCache: T
): T {
  return compiledBroadSurfaceRequirement ? notApplicableCache : prepackedAnnotationSceneCache;
}

export function presentationPolicyRequestId(
  pendingAnnotationRasterCommitted: boolean,
  pendingAnnotationMapperPolicy: { requestId: number } | null
): number | null {
  return pendingAnnotationRasterCommitted
    ? (pendingAnnotationMapperPolicy?.requestId ?? null)
    : null;
}

export function prepackedSceneEffectiveLayerTypes(
  mrnaLayerVisible: boolean,
  rendererEffectiveVisibleLayerTypes: readonly string[]
): readonly string[] {
  return mrnaLayerVisible ? ['mRNA'] : rendererEffectiveVisibleLayerTypes;
}

export function livePresentedPrepackedOwnerMatch<TOwner, TMatch>(
  presentedPrepackedAnnotationOwner: TOwner | null,
  match: (owner: TOwner) => TMatch
): TMatch | null {
  return presentedPrepackedAnnotationOwner ? match(presentedPrepackedAnnotationOwner) : null;
}

export function isActivePrepackedMrnaPresentation(input: {
  livePresentedPrepackedOwnerMatch: boolean | null;
  exactActive: boolean;
}): boolean {
  return input.livePresentedPrepackedOwnerMatch !== false && input.exactActive;
}

export function presentedPrepackedReceipt<T>(owner: { receipt: T } | null | undefined): T | null {
  return owner?.receipt ?? null;
}

export function presentedPrepackedRendererEpoch(
  owner: { rendererEpoch: number } | null | undefined
): number | null {
  return owner?.rendererEpoch ?? null;
}

export function annotationPreparationUiState(
  transactionStatus: string,
  pendingAnnotationMapperPolicy: object | null
): 'error' | 'preparing' | 'idle' {
  return transactionStatus === 'failed'
    ? 'error'
    : pendingAnnotationMapperPolicy
      ? 'preparing'
      : 'idle';
}

export function pendingAnnotationMapperPolicyValue<T>(
  pending: { policy: T } | null | undefined,
  fallback: T
): T {
  return pending?.policy ?? fallback;
}

export function pendingAnnotationMapperPolicyRequestId(
  pending: { requestId: number } | null | undefined
): number | null {
  return pending?.requestId ?? null;
}

export function shouldClearCompatibilityProjection(
  compiledBroadOwnsAssembly: boolean,
  compatibilityProjection: object | null
): boolean {
  return compiledBroadOwnsAssembly && compatibilityProjection !== null;
}

export function compatibilityProjectionFields<
  T extends {
    resolverOutput?: T['resolverOutput'];
    annotationIndex?: T['annotationIndex'];
    annotationViewportResolvedFeaturesByGeneration?: T['annotationViewportResolvedFeaturesByGeneration'];
    annotationOverviewGlyphPayload?: T['annotationOverviewGlyphPayload'];
    annotationOverviewGlyphPayloadByteCount?: number;
    activeTileNativeScene?: T['activeTileNativeScene'];
    tileNativeRendererGenome?: T['tileNativeRendererGenome'];
    activeFilteredRendererFeatures?: FilteredRendererFeatureResult | null;
    invariantViolations?: T['invariantViolations'];
  },
>(
  compiledBroadOwnsAssembly: boolean,
  projection: T | null
): {
  resolverOutput: T['resolverOutput'] | null;
  annotationIndex: T['annotationIndex'] | null;
  annotationViewportResolvedFeaturesByGeneration: T['annotationViewportResolvedFeaturesByGeneration'];
  annotationOverviewGlyphPayload: T['annotationOverviewGlyphPayload'] | null;
  annotationOverviewGlyphPayloadByteCount: number;
  activeTileNativeScene: T['activeTileNativeScene'] | null;
  tileNativeRendererGenome: T['tileNativeRendererGenome'] | null;
  activeFilteredRendererFeatures: FilteredRendererFeatureResult | null;
  invariantViolations: NonNullable<T['invariantViolations']> | [];
} {
  return {
    resolverOutput: projection?.resolverOutput ?? null,
    annotationIndex: projection?.annotationIndex ?? null,
    annotationViewportResolvedFeaturesByGeneration:
      projection?.annotationViewportResolvedFeaturesByGeneration,
    annotationOverviewGlyphPayload: projection?.annotationOverviewGlyphPayload ?? null,
    annotationOverviewGlyphPayloadByteCount:
      projection?.annotationOverviewGlyphPayloadByteCount ?? 0,
    activeTileNativeScene: projection?.activeTileNativeScene ?? null,
    tileNativeRendererGenome: projection?.tileNativeRendererGenome ?? null,
    activeFilteredRendererFeatures: compiledBroadOwnsAssembly
      ? EMPTY_FILTERED_RENDERER_FEATURES
      : (projection?.activeFilteredRendererFeatures ?? null),
    invariantViolations: projection?.invariantViolations ?? [],
  };
}

export function retainedAssemblyAnnotationTrackTypes(
  retained: { key: string | null; types: string[] },
  contractKey: string | null
): string[] {
  return retained.key === contractKey ? retained.types : [];
}

export function rendererAnnotationSearchFocusForMap<T>(
  rendererAssembly: object | null | undefined,
  rendererAnnotationSearchFocusFeature: object | null | undefined,
  rendererAnnotationSearchFocus: T
): T | null {
  return rendererAssembly || rendererAnnotationSearchFocusFeature
    ? rendererAnnotationSearchFocus
    : null;
}

export function sceneAnnotationViewportTileForAssembly<T>(
  rendererAssembly: object | null | undefined,
  annotationViewportTile: T
): T | null {
  return rendererAssembly ? null : annotationViewportTile;
}

export function sceneAnnotationViewportTilesForAssembly<T>(
  rendererAssembly: object | null | undefined,
  annotationViewportTiles: T[]
): T[] {
  return rendererAssembly ? [] : annotationViewportTiles;
}

export function annotationPresentationSourceIdentity(input: {
  compiledBroadOwnsAssembly: boolean;
  stableAnnotationSourceIdentity: string | null;
  annotationSourceScopeKey: string | null;
  rendererAssemblyId: string | undefined;
  tileNativeRendererGenome: { sourceIdentity?: string; name: string } | null;
}): string | null {
  if (input.compiledBroadOwnsAssembly) {
    return (
      input.stableAnnotationSourceIdentity ??
      input.annotationSourceScopeKey ??
      input.rendererAssemblyId ??
      null
    );
  }
  return input.tileNativeRendererGenome
    ? (input.tileNativeRendererGenome.sourceIdentity ?? input.tileNativeRendererGenome.name)
    : null;
}

export function annotationPresentationPolicyKey(
  rendererAssembly: object | null | undefined,
  assemblyAnnotationSourcePageStreamKey: string | null
): string | null {
  return rendererAssembly ? assemblyAnnotationSourcePageStreamKey : null;
}

export function assemblyShellAnnotationSourcePlacementProvenance<T>(
  compiledBroadSurfaceRequirement: object | null | undefined,
  annotationSourcePlacementProvenance: T
): T | null {
  return compiledBroadSurfaceRequirement ? null : annotationSourcePlacementProvenance;
}

export function rendererGenomeForMap<T>(
  rendererAssembly: object | null | undefined,
  assemblyRendererGenomeShell: T | null,
  tileNativeRendererGenome: T | null
): T | null {
  return rendererAssembly ? assemblyRendererGenomeShell : tileNativeRendererGenome;
}

export function rendererGenomeSourceIdentity(
  genome: { sourceIdentity?: string; name: string } | null
): string | null {
  return genome ? (genome.sourceIdentity ?? genome.name) : null;
}

export function annotationPresentationSnapshotForMap<
  T extends { sourceIdentity: string; genomeLengthBp: number },
>(
  compiledBroadOwnsAssembly: boolean,
  snapshot: T | null | undefined,
  rendererGenomeSourceIdentityValue: string | null,
  rendererGenomeLength: number | undefined
): T | undefined {
  return !compiledBroadOwnsAssembly &&
    snapshot?.sourceIdentity === rendererGenomeSourceIdentityValue &&
    snapshot.genomeLengthBp === rendererGenomeLength
    ? snapshot
    : undefined;
}

export function annotationResidentPagePublicationForMap<
  T extends { sourceIdentity: string; genomeLengthBp: number },
>(
  publication: T | null | undefined,
  rendererGenomeSourceIdentityValue: string | null,
  rendererGenomeLength: number | undefined
): T | undefined {
  return publication?.sourceIdentity === rendererGenomeSourceIdentityValue &&
    publication.genomeLengthBp === rendererGenomeLength
    ? publication
    : undefined;
}

export function prepackedAnnotationLayoutOwnerKey(
  activePrepackedMrnaPresentation: boolean,
  presentedPrepackedAnnotationOwner: { receipt: { ownerKey: string } } | null
): string | null {
  return activePrepackedMrnaPresentation && presentedPrepackedAnnotationOwner
    ? `prepacked-owner:${presentedPrepackedAnnotationOwner.receipt.ownerKey}`
    : null;
}

export function indexedGenomeViewerIsDeferred(input: {
  stateKind: string;
  rendererAssembly: object | null | undefined;
  assemblyRendererGenomeShell: object | null | undefined;
  tileNativeRendererGenome: object | null | undefined;
  activeFilteredRendererFeatures: object | null | undefined;
  activeTileNativeScene: object | null | undefined;
}): boolean {
  if (input.stateKind !== 'ready') return true;
  if (input.rendererAssembly) return !input.assemblyRendererGenomeShell;
  return (
    !input.tileNativeRendererGenome ||
    !input.activeFilteredRendererFeatures ||
    !input.activeTileNativeScene
  );
}

export function temporaryAnnotationRevealProps(
  reveal: AnnotationSearchReveal,
  onShowTrack: () => void
): { trackId: string; onShowTrack: () => void } | null {
  return reveal.kind === 'temporary' ? { trackId: reveal.trackId, onShowTrack } : null;
}

export function raiseSearchLaneLimitAction(
  laneLimit: number | null,
  maxSupportedFiniteLaneLimit: number | null
): boolean {
  return (
    laneLimit !== null &&
    (maxSupportedFiniteLaneLimit === null || laneLimit < maxSupportedFiniteLaneLimit)
  );
}

export function visibleAnnotationSearchFocusProps(
  reveal: AnnotationSearchReveal,
  laneLimit: number | null,
  maxSupportedFiniteLaneLimit: number | null,
  raiseSearchLaneLimitByOne: () => void
): {
  trackId: string;
  canonicalIdentity: string;
  onKeepAdditionalLane?: () => void;
} | null {
  if (reveal.kind !== 'visible') return null;
  return {
    trackId: reveal.trackId,
    canonicalIdentity: reveal.canonicalIdentity,
    onKeepAdditionalLane: raiseSearchLaneLimitAction(laneLimit, maxSupportedFiniteLaneLimit)
      ? raiseSearchLaneLimitByOne
      : undefined,
  };
}

export function indexedGenomeMapSequenceWindow<T>(
  assemblyRoutingEnabled: boolean,
  assemblySequenceWindow: T | null,
  sequenceWindow: T | null
): T | undefined {
  return (assemblyRoutingEnabled ? assemblySequenceWindow : sequenceWindow) ?? undefined;
}

export function indexedGenomeMapCanvasWidth(containerWidth: number): number {
  return containerWidth || 800;
}

export function annotationSummarySourceRecordCount(state: {
  sourceRecordCount?: number;
  tileFeatures: ReadonlyArray<unknown>;
}): number {
  return state.sourceRecordCount ?? state.tileFeatures.length;
}

export function compiledBroadRasterSourceRequest(input: {
  readonly annotationSceneSourceRequest: AssemblyAnnotationSceneSourceRequest | null;
  readonly descriptorRequest: AssemblyAnnotationSceneSourceRequest | null | undefined;
  readonly annotationAssetGeneration: AssemblyReferenceAssetGenerationV1 | null;
}): AssemblyAnnotationSceneSourceRequest | null {
  const request = input.annotationSceneSourceRequest ?? input.descriptorRequest ?? null;
  if (
    !request ||
    typeof request.assemblyId !== 'string' ||
    request.assemblyId.trim().length === 0 ||
    typeof request.workspaceRoot !== 'string' ||
    request.workspaceRoot.trim().length === 0 ||
    !assemblyAnnotationSceneScopeMatchesChromosomes(request.scope, request.chromosomes)
  ) {
    return null;
  }
  const expectedAssetGeneration =
    input.annotationAssetGeneration ?? request.expectedAssetGeneration;
  const datasetVersion = request.datasetVersion?.trim();
  return {
    assemblyId: request.assemblyId,
    workspaceRoot: request.workspaceRoot,
    scope: request.scope,
    chromosomes: request.chromosomes,
    ...(datasetVersion ? { datasetVersion } : {}),
    ...(expectedAssetGeneration ? { expectedAssetGeneration: { ...expectedAssetGeneration } } : {}),
  };
}

export function compiledBroadBootstrapTrackType(
  trackType: string | null | undefined,
  admittedTrackTypes: readonly string[] | undefined
): string | null {
  const candidate = trackType?.trim();
  if (!candidate) return null;
  if (!admittedTrackTypes) return candidate;
  return admittedTrackTypes.some((admitted) => admitted.trim() === candidate) ? candidate : null;
}

export function optionalRequirement<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export function optionalFiniteLaneLimit(value: number | null): number | undefined {
  return value ?? undefined;
}
