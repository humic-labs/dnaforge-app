import { useCallback, useEffect, useState } from 'react';

import {
  assemblyCompiledBroadRasterFinestSpanBpV1,
  type AssemblyAnnotationSceneSourceRequest,
  type AssemblyReferenceAssetGenerationV1,
} from '../../../shared/indexed-genome';

import type { LaneLimit } from './indexed-genome-legacy-adapter';
import type { TranscriptDisplayMode } from './isoform-collapse';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import {
  assemblyPrepackedAnnotationSceneCacheOwnerKey,
  NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE,
  type AssemblyPrepackedAnnotationSceneCacheState,
  useAssemblyPrepackedAnnotationSceneCache,
} from './useAssemblyPrepackedAnnotationSceneCache';
import {
  type PrepackedAssemblyAnnotationSceneReadiness,
  usePrepackedAssemblyAnnotationScene,
} from './usePrepackedAssemblyAnnotationScene';
import {
  type AssemblyCompiledBroadInteractionReadiness,
  useAssemblyCompiledBroadInteraction,
} from './useAssemblyCompiledBroadInteraction';
import {
  assemblyAnnotationBroadHandoffSpanBpV1,
  assemblyAnnotationDetailPrefetchTriggerSpanBpV1,
  assemblyAnnotationDetailUsesWholeSceneV1,
  type AssemblyAnnotationViewportDetailReadiness,
  useAssemblyAnnotationViewportDetail,
} from './useAssemblyAnnotationViewportDetail';
import {
  useAssemblyCompiledBroadRasterSurface,
  type UseAssemblyCompiledBroadRasterSurfaceOptions,
} from './useAssemblyCompiledBroadRasterSurface';
import type {
  AssemblyCompiledBroadRasterLoaderDiagnosticsV1,
  AssemblyCompiledBroadRasterPolicyCommitReceiptV1,
  AssemblyCompiledBroadRasterReadinessV1,
} from './assembly-compiled-broad-raster-loader';

export interface IndexedGenomeAnnotationMapperPolicy {
  isoformMode: TranscriptDisplayMode;
  laneLimit: LaneLimit;
}

export interface CompiledBroadTrackReadinessReceipt {
  readonly annotationSourceBinding?:
    | import('@waypoint/genome-renderer/pure').SourceAnnotationAliasBindingV1
    | null;
  readonly sourceAnnotationAliasesAvailable?: boolean;
  readonly readiness: AssemblyCompiledBroadRasterReadinessV1;
  readonly targetIdentityKey: string | null;
  readonly readinessTargetIdentityKey: string | null;
  readonly readinessRendererMatchesCurrent: boolean;
  readonly validatedSourceFingerprint: string | null;
  readonly interactionReadiness: PrepackedAssemblyAnnotationSceneReadiness;
  readonly interactionOwnerKey: string | null;
  readonly ownerReadinessScopeKey: string;
  readonly interactionCacheStatus: AssemblyPrepackedAnnotationSceneCacheState['status'];
  readonly interactionCacheOrigin:
    | 'pending'
    | 'durable-hit'
    | 'prepared-after-miss'
    | 'miss'
    | 'error'
    | null;
  readonly interactionCacheInitialProbe: 'pending' | 'hit' | 'miss' | 'empty' | null;
  readonly interactionCacheCompletedAt: number | null;
  readonly interactionSourceIdentity: string | null;
  readonly interactionArtifactKey: string | null;
  readonly interactionPayloadBytes: number | null;
  readonly compactInteractionStatus: AssemblyCompiledBroadInteractionReadiness;
  readonly compactInteractionOwnerKey: string | null;
  readonly compactInteractionStartedAt: number | null;
  readonly compactInteractionReadCompletedAt: number | null;
  readonly compactInteractionPreparedAt: number | null;
  readonly compactInteractionCompletedAt: number | null;
  readonly compactInteractionAuthorityKind: 'portable' | 'local' | null;
  readonly compactInteractionOrigin: 'durable-hit' | 'prepared-after-miss' | null;
  readonly compactInteractionPayloadBytes: number | null;
  readonly compactInteractionAuthorityPresent: boolean;
  readonly compactInteractionGenomeLengthBp: number | null;
  readonly compactInteractionError: string | null;
  readonly viewportDetailStatus: AssemblyAnnotationViewportDetailReadiness;
  readonly viewportDetailCoverageStartBp: number | null;
  readonly viewportDetailCoverageEndBp: number | null;
  readonly viewportDetailPayloadBytes: number | null;
  readonly viewportDetailError: string | null;
}

export function AssemblyCompiledAnnotationTrack({
  trackType,
  annotationColorsByIdentity,
  prepareAnnotationAliases,
  missingAnnotationColor,
  selected,
  seedCache,
  assetGeneration,
  productPublicationReady,
  sourceRequest,
  interactionPayloadEnabled,
  interactionPreparationGeneration,
  themeMode,
  assemblyRequirement,
  surfacePolicy,
  interactionPolicy,
  policyRequestId,
  rendererReadyEpoch,
  rendererGenomeCommitEpoch,
  rendererAdmissionEpoch,
  webglRef,
  recordEvent,
  registerCameraNotifier,
  registerPolicyRefresher,
  registerDiagnostics,
  overviewFeaturesComplete,
  onPolicyCommitted,
  onPolicyUnavailable,
  onReadinessChanged,
  onDetailRendererAdmission,
  readinessGeneration,
  ownerReadinessScopeKey,
  viewportCssWidthPx,
}: Readonly<{
  trackType: string;
  annotationColorsByIdentity?: ReadonlyMap<string, string>;
  prepareAnnotationAliases?: boolean;
  missingAnnotationColor?: string;
  selected: boolean;
  seedCache: AssemblyPrepackedAnnotationSceneCacheState;
  assetGeneration: AssemblyReferenceAssetGenerationV1 | null;
  productPublicationReady: boolean;
  sourceRequest: AssemblyAnnotationSceneSourceRequest | null;
  interactionPayloadEnabled: boolean;
  interactionPreparationGeneration: number;
  themeMode: 'light' | 'dark';
  assemblyRequirement: UseAssemblyCompiledBroadRasterSurfaceOptions['assemblyRequirement'];
  surfacePolicy: IndexedGenomeAnnotationMapperPolicy;
  interactionPolicy: IndexedGenomeAnnotationMapperPolicy;
  policyRequestId: number | null;
  rendererReadyEpoch: number;
  rendererGenomeCommitEpoch: number;
  rendererAdmissionEpoch: number;
  webglRef: {
    readonly current: Pick<
      IndexedGenomeTileNativeMapHandle,
      'getLinearRenderer' | 'requestRender' | 'schedulePostPresentWork' | 'getViewportRange'
    > | null;
  };
  recordEvent: UseAssemblyCompiledBroadRasterSurfaceOptions['recordEvent'];
  registerCameraNotifier: (
    notifier: (
      reason: 'scroll' | 'zoom',
      viewportRange?: Readonly<{ start: number; end: number }>
    ) => void
  ) => () => void;
  registerPolicyRefresher: (trackType: string, refresher: () => void) => () => void;
  registerDiagnostics: (
    trackType: string,
    getDiagnostics: () => AssemblyCompiledBroadRasterLoaderDiagnosticsV1 | null
  ) => () => void;
  overviewFeaturesComplete: boolean;
  onPolicyCommitted: (
    trackType: string,
    receipt: AssemblyCompiledBroadRasterPolicyCommitReceiptV1
  ) => void;
  onPolicyUnavailable: (requestId: number, trackType: string) => void;
  onReadinessChanged: (trackType: string, receipt: CompiledBroadTrackReadinessReceipt) => void;
  onDetailRendererAdmission: () => void;
  readinessGeneration: string;
  ownerReadinessScopeKey: string;
  viewportCssWidthPx: number;
}>): null {
  const seedTrackType = seedCache.descriptor?.artifact?.trackType ?? null;
  const usesSeedCache = seedTrackType === trackType;
  const [expectedInteractionOwnerKey, setExpectedInteractionOwnerKey] = useState<string | null>(
    null
  );
  const seedInteractionOwnerKey = assemblyPrepackedAnnotationSceneCacheOwnerKey(seedCache);
  const seedInteractionMatchesRaster =
    expectedInteractionOwnerKey !== null && seedInteractionOwnerKey === expectedInteractionOwnerKey;
  const derivedInteractionRequired =
    !usesSeedCache || (expectedInteractionOwnerKey !== null && !seedInteractionMatchesRaster);
  const completeAssemblyDetailEnabled = sourceRequest?.scope.kind === 'complete-assembly';
  const detailGenomeLengthBp = sourceRequest
    ? sourceRequest.chromosomes.reduce((total, chromosome) => total + chromosome.length, 0)
    : null;
  const derivedSurfaceCache = useAssemblyPrepackedAnnotationSceneCache({
    enabled: selected && !usesSeedCache && Boolean(sourceRequest),
    interactionPayloadEnabled: false,
    prepareOnMiss: false,
    prepareProductOnly: true,
    assetGeneration,
    request: sourceRequest,
    themeMode,
    policy: {
      trackType,
      isoformMode: interactionPolicy.isoformMode,
      laneLimit: interactionPolicy.laneLimit,
    },
  });
  const surfaceCache = selected
    ? usesSeedCache
      ? seedCache
      : derivedSurfaceCache
    : NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE;
  const recordTrackEvent = useCallback(
    (event: string, detail?: Record<string, unknown>) =>
      recordEvent(event, { ...detail, trackType }),
    [recordEvent, trackType]
  );
  const activePolicyRequestId = selected ? policyRequestId : null;
  const cacheTrackType = usesSeedCache && seedTrackType ? seedTrackType : trackType;
  const {
    notifyCameraChanged,
    refreshPolicy,
    getDiagnostics,
    readiness,
    readinessTargetIdentityKey,
    readinessRendererMatchesCurrent,
    validatedSourceFingerprint,
    admittedBroadCorridorFinestSpanBp,
    targetIdentityKey,
    expectedInteractionOwnerKey: readyInteractionOwnerKey,
    policyFailureRequestId,
    annotationSourceBinding,
  } = useAssemblyCompiledBroadRasterSurface({
    enabled: selected,
    annotationColorsByIdentity,
    prepareAnnotationAliases,
    missingAnnotationColor,
    themeMode,
    cache: surfaceCache,
    assetGeneration,
    assemblyRequirement,
    policy: surfacePolicy,
    policyRequestId: activePolicyRequestId,
    rendererReadyEpoch,
    rendererGenomeCommitEpoch,
    webglRef,
    recordEvent: recordTrackEvent,
    onPolicyCommitted: (receipt) => onPolicyCommitted(trackType, receipt),
  });
  useEffect(() => {
    setExpectedInteractionOwnerKey((current) =>
      current === readyInteractionOwnerKey ? current : readyInteractionOwnerKey
    );
  }, [readyInteractionOwnerKey]);
  useEffect(
    () => registerCameraNotifier(notifyCameraChanged),
    [notifyCameraChanged, registerCameraNotifier]
  );
  useEffect(
    () => registerPolicyRefresher(trackType, refreshPolicy),
    [refreshPolicy, registerPolicyRefresher, trackType]
  );
  useEffect(
    () => registerDiagnostics(trackType, getDiagnostics),
    [getDiagnostics, registerDiagnostics, trackType]
  );
  useEffect(() => {
    if (activePolicyRequestId === null || policyFailureRequestId !== activePolicyRequestId) return;
    onPolicyUnavailable(policyFailureRequestId, trackType);
  }, [activePolicyRequestId, onPolicyUnavailable, policyFailureRequestId, trackType]);
  const compactInteraction = useAssemblyCompiledBroadInteraction({
    enabled: selected,
    publicationReady: productPublicationReady,
    descriptor: surfaceCache.descriptor,
    expectedInteractionOwnerKey,
    rendererReadyEpoch,
    rendererGenomeCommitEpoch,
    webglRef,
  });
  const effectiveInteractionOwnerKey = expectedInteractionOwnerKey ?? compactInteraction.ownerKey;
  const detailHandoffInput =
    assemblyRequirement && detailGenomeLengthBp
      ? {
          genomeLengthBp: detailGenomeLengthBp,
          broadCorridorFinestSpanBp:
            admittedBroadCorridorFinestSpanBp ??
            assemblyCompiledBroadRasterFinestSpanBpV1(detailGenomeLengthBp),
          viewportCssWidthPx,
          devicePixelRatio:
            typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1),
        }
      : undefined;
  const detailBroadHandoffSpanBp = detailHandoffInput
    ? assemblyAnnotationBroadHandoffSpanBpV1(detailHandoffInput)
    : undefined;
  const detailPrefetchTriggerSpanBp = detailHandoffInput
    ? assemblyAnnotationDetailPrefetchTriggerSpanBpV1(detailHandoffInput)
    : undefined;
  const wholeSceneExactDetail = assemblyAnnotationDetailUsesWholeSceneV1({
    completeAssemblyDetailEnabled,
    genomeLengthBp: detailGenomeLengthBp,
    broadHandoffSpanBp: detailBroadHandoffSpanBp,
  });
  const handleDetailRendererAdmission = useCallback(() => {
    onDetailRendererAdmission();
    refreshPolicy();
  }, [onDetailRendererAdmission, refreshPolicy]);
  const viewportDetail = useAssemblyAnnotationViewportDetail({
    enabled: selected && completeAssemblyDetailEnabled && !wholeSceneExactDetail,
    descriptor: surfaceCache.descriptor,
    expectedInteractionOwnerKey: effectiveInteractionOwnerKey,
    interactionAuthority: compactInteraction.authority,
    policy: {
      isoformMode: interactionPolicy.isoformMode,
      laneLimit: interactionPolicy.laneLimit,
    },
    detailPrefetchTriggerSpanBp,
    detailBroadHandoffSpanBp,
    onRendererAdmission: handleDetailRendererAdmission,
    recordEvent: recordTrackEvent,
    rendererReadyEpoch,
    rendererGenomeCommitEpoch,
    rendererAdmissionEpoch,
    webglRef,
  });
  const derivedInteractionCache = useAssemblyPrepackedAnnotationSceneCache({
    enabled:
      selected &&
      derivedInteractionRequired &&
      expectedInteractionOwnerKey !== null &&
      Boolean(sourceRequest) &&
      (wholeSceneExactDetail ||
        !completeAssemblyDetailEnabled ||
        viewportDetail.receipt.status === 'unavailable'),
    interactionPayloadEnabled,
    preparationGeneration: interactionPreparationGeneration,
    prepareOnMiss: false,
    prepareProductOnly: false,
    requiredInteractionOwnerKey: expectedInteractionOwnerKey,
    assetGeneration,
    request: sourceRequest,
    themeMode,
    policy: {
      trackType,
      isoformMode: interactionPolicy.isoformMode,
      laneLimit: interactionPolicy.laneLimit,
    },
  });
  const interactionCache =
    selected && expectedInteractionOwnerKey !== null
      ? usesSeedCache &&
        seedInteractionMatchesRaster &&
        (wholeSceneExactDetail || !completeAssemblyDetailEnabled)
        ? seedCache
        : derivedInteractionCache
      : NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE;
  const legacyPrepackedReadiness = usePrepackedAssemblyAnnotationScene({
    cache: interactionCache,
    overviewFeaturesComplete,
    effectiveLayerTypes: [cacheTrackType],
    requestedPolicy: {
      trackType: cacheTrackType,
      isoformMode: interactionPolicy.isoformMode,
      laneLimit: interactionPolicy.laneLimit,
    },
    activateOwner: false,
    publishBridge: false,
    readinessGeneration: `${readinessGeneration}:${trackType}`,
    readinessScopeKey: ownerReadinessScopeKey,
    rendererReadyEpoch,
    rendererGenomeCommitEpoch,
    webglRef,
  });
  const prepackedReadiness: PrepackedAssemblyAnnotationSceneReadiness =
    completeAssemblyDetailEnabled &&
    !wholeSceneExactDetail &&
    viewportDetail.receipt.status !== 'unavailable'
      ? viewportDetail.receipt.status === 'loaded'
        ? 'loaded-hit'
        : viewportDetail.receipt.status === 'error'
          ? 'error'
          : 'loading-hit'
      : legacyPrepackedReadiness;
  useEffect(() => {
    if (interactionCache.status !== 'error') return;
    console.error(`[annotation-product:${trackType}]`, interactionCache.error);
  }, [interactionCache, trackType]);
  useEffect(
    () => registerCameraNotifier(viewportDetail.notifyCameraChanged),
    [registerCameraNotifier, viewportDetail.notifyCameraChanged]
  );
  useEffect(() => {
    if (compactInteraction.status !== 'error') return;
    const error = compactInteraction.error;
    console.error(`[annotation-compact-interaction:${trackType}]`, {
      name: error instanceof Error ? error.name : null,
      message: error instanceof Error ? error.message : String(error),
      code:
        error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : null,
    });
  }, [compactInteraction, trackType]);
  useEffect(() => {
    onReadinessChanged(
      trackType,
      selected
        ? {
            readiness,
            sourceAnnotationAliasesAvailable: annotationSourceBinding !== null,
            annotationSourceBinding,
            targetIdentityKey,
            readinessTargetIdentityKey,
            readinessRendererMatchesCurrent,
            validatedSourceFingerprint,
            interactionReadiness: prepackedReadiness,
            interactionOwnerKey: effectiveInteractionOwnerKey,
            ownerReadinessScopeKey,
            interactionCacheStatus: interactionCache.status,
            interactionCacheOrigin:
              interactionCache.status === 'not-applicable'
                ? null
                : (interactionCache.lifecycle?.origin ?? null),
            interactionCacheInitialProbe:
              interactionCache.status === 'not-applicable'
                ? null
                : (interactionCache.lifecycle?.initialProbe ?? null),
            interactionCacheCompletedAt:
              interactionCache.status === 'not-applicable'
                ? null
                : (interactionCache.lifecycle?.completedAt ?? null),
            interactionSourceIdentity: interactionCache.descriptor?.sourceIdentity ?? null,
            interactionArtifactKey: interactionCache.descriptor?.artifact.artifactKey ?? null,
            interactionPayloadBytes:
              interactionCache.status === 'hit' ? interactionCache.result.payload.byteLength : null,
            compactInteractionStatus: compactInteraction.status,
            compactInteractionOwnerKey: compactInteraction.ownerKey,
            compactInteractionStartedAt: compactInteraction.startedAt,
            compactInteractionReadCompletedAt: compactInteraction.readCompletedAt,
            compactInteractionPreparedAt: compactInteraction.preparedAt,
            compactInteractionCompletedAt: compactInteraction.completedAt,
            compactInteractionAuthorityKind: compactInteraction.authorityKind,
            compactInteractionOrigin: compactInteraction.origin,
            compactInteractionPayloadBytes: compactInteraction.payloadBytes,
            compactInteractionAuthorityPresent: compactInteraction.authority !== null,
            compactInteractionGenomeLengthBp:
              compactInteraction.authority?.metadata.genomeLengthBp ?? null,
            compactInteractionError:
              compactInteraction.error instanceof Error
                ? compactInteraction.error.message
                : compactInteraction.error === null
                  ? null
                  : String(compactInteraction.error),
            viewportDetailStatus: viewportDetail.receipt.status,
            viewportDetailCoverageStartBp: viewportDetail.receipt.coverageStartBp,
            viewportDetailCoverageEndBp: viewportDetail.receipt.coverageEndBp,
            viewportDetailPayloadBytes: viewportDetail.receipt.payloadBytes,
            viewportDetailError:
              viewportDetail.receipt.error instanceof Error
                ? viewportDetail.receipt.error.message
                : viewportDetail.receipt.error === null
                  ? null
                  : String(viewportDetail.receipt.error),
          }
        : {
            readiness: 'idle',
            targetIdentityKey: null,
            readinessTargetIdentityKey: null,
            readinessRendererMatchesCurrent: false,
            validatedSourceFingerprint: null,
            interactionReadiness: 'not-applicable',
            interactionOwnerKey: null,
            ownerReadinessScopeKey,
            interactionCacheStatus: 'not-applicable',
            interactionCacheOrigin: null,
            interactionCacheInitialProbe: null,
            interactionCacheCompletedAt: null,
            interactionSourceIdentity: null,
            interactionArtifactKey: null,
            interactionPayloadBytes: null,
            compactInteractionStatus: 'not-applicable',
            compactInteractionOwnerKey: null,
            compactInteractionStartedAt: null,
            compactInteractionReadCompletedAt: null,
            compactInteractionPreparedAt: null,
            compactInteractionCompletedAt: null,
            compactInteractionAuthorityKind: null,
            compactInteractionOrigin: null,
            compactInteractionPayloadBytes: null,
            compactInteractionAuthorityPresent: false,
            compactInteractionGenomeLengthBp: null,
            compactInteractionError: null,
            viewportDetailStatus: 'not-applicable',
            viewportDetailCoverageStartBp: null,
            viewportDetailCoverageEndBp: null,
            viewportDetailPayloadBytes: null,
            viewportDetailError: null,
          }
    );
  }, [
    annotationSourceBinding,
    compactInteraction,
    surfaceCache,
    effectiveInteractionOwnerKey,
    interactionCache,
    onReadinessChanged,
    ownerReadinessScopeKey,
    prepackedReadiness,
    readiness,
    readinessRendererMatchesCurrent,
    validatedSourceFingerprint,
    readinessTargetIdentityKey,
    selected,
    targetIdentityKey,
    trackType,
    viewportDetail.receipt,
  ]);
  useEffect(() => {
    recordEvent('annotation-track-prepacked-readiness', {
      trackType,
      readiness: prepackedReadiness,
      cacheStatus: interactionCache.status,
      compactInteractionStatus: compactInteraction.status,
      compactInteractionPayloadBytes: compactInteraction.payloadBytes,
      compactInteractionStartedAt: compactInteraction.startedAt,
      compactInteractionReadCompletedAt: compactInteraction.readCompletedAt,
      compactInteractionPreparedAt: compactInteraction.preparedAt,
      compactInteractionCompletedAt: compactInteraction.completedAt,
      descriptorTrackType: interactionCache.descriptor?.artifact.trackType ?? null,
      hasInteractionPayload: interactionCache.status === 'hit',
      cacheError:
        interactionCache.status === 'error'
          ? interactionCache.error instanceof Error
            ? interactionCache.error.message
            : String(interactionCache.error)
          : null,
    });
  }, [compactInteraction, interactionCache, prepackedReadiness, recordEvent, trackType]);
  return null;
}
