import {
  compileAnnotationDataAppearanceV1,
  type AnnotationDataAppearanceV1,
  type SourceAnnotationAliasBindingV1,
} from '@waypoint/genome-renderer/pure';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { platform } from '../../../platform';
import { rendererInteractionQuietDelayMs } from '../../../lib/renderer-interaction-activity';
import type {
  AssemblyAnnotationRuntimePolicy,
  AssemblyReferenceAssetGenerationV1,
} from '../../../shared/indexed-genome';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import {
  assemblyReferenceAssetGenerationKey,
  type AssemblyPrepackedAnnotationSceneCacheState,
} from './useAssemblyPrepackedAnnotationSceneCache';
import {
  AssemblyCompiledBroadRasterLoaderV1,
  assemblyCompiledBroadRasterCommandKeyV1,
  type AssemblyCompiledBroadRasterLoaderDiagnosticsV1,
  type AssemblyCompiledBroadRasterPolicyControlsReadinessV1,
  type AssemblyCompiledBroadRasterPolicyCommitReceiptV1,
  type AssemblyCompiledBroadRasterReadinessV1,
  type AssemblyCompiledBroadRasterReadinessReceiptV1,
  type AssemblyCompiledBroadRasterLoaderTargetV1,
  type CompiledBroadRasterRendererV1,
} from './assembly-compiled-broad-raster-loader';

export interface UseAssemblyCompiledBroadRasterSurfaceOptions {
  readonly enabled: boolean;
  readonly annotationColorsByIdentity?: ReadonlyMap<string, string>;
  readonly prepareAnnotationAliases?: boolean;
  readonly missingAnnotationColor?: string;
  readonly themeMode?: 'light' | 'dark';
  readonly cache: AssemblyPrepackedAnnotationSceneCacheState;
  readonly assetGeneration?: AssemblyReferenceAssetGenerationV1 | null;
  readonly assemblyRequirement: Readonly<{
    identityKey: string;
    genomeLengthBp: number;
  }> | null;
  readonly policy: AssemblyAnnotationRuntimePolicy;
  readonly policyRequestId?: number | null;
  readonly rendererReadyEpoch: number;
  readonly rendererGenomeCommitEpoch: number;
  readonly webglRef: {
    readonly current: Pick<
      IndexedGenomeTileNativeMapHandle,
      'getLinearRenderer' | 'requestRender' | 'schedulePostPresentWork'
    > | null;
  };
  readonly recordEvent: (event: string, detail?: Record<string, unknown>) => void;
  readonly onPolicyCommitted?: (receipt: AssemblyCompiledBroadRasterPolicyCommitReceiptV1) => void;
}

export function activeAssemblyCompiledBroadRasterTargetV1(
  cache: AssemblyPrepackedAnnotationSceneCacheState,
  policy: AssemblyAnnotationRuntimePolicy,
  policyRequestId: number | null = null,
  assetGeneration: AssemblyReferenceAssetGenerationV1 | null = null,
  appearance?: AnnotationDataAppearanceV1
): AssemblyCompiledBroadRasterLoaderTargetV1 | null {
  const descriptor = cache.descriptor;
  if (!descriptor || !descriptor.request || !Array.isArray(descriptor.request.chromosomes)) {
    return null;
  }
  let genomeLengthBp = 0;
  for (const chromosome of descriptor.request.chromosomes) {
    if (!Number.isSafeInteger(chromosome.length) || chromosome.length <= 0) return null;
    genomeLengthBp += chromosome.length;
    if (!Number.isSafeInteger(genomeLengthBp)) return null;
  }
  if (genomeLengthBp <= 0) return null;
  return {
    identityKey: [
      'assembly-compiled-broad-raster-target.v2',
      descriptor.runtimeCacheKey,
      descriptor.sourceIdentity,
      descriptor.placementFingerprint,
      descriptor.artifact.artifactKey,
      ...(appearance ? [appearance.fingerprint] : []),
    ].join('\n'),
    genomeIdentity: descriptor.sourceIdentity,
    genomeLengthBp,
    placementFingerprint: descriptor.placementFingerprint,
    sceneRequest: descriptor.request,
    ...(appearance ? { appearance } : {}),
    artifact: descriptor.artifact,
    expectedAssetGeneration: assetGeneration ? { ...assetGeneration } : null,
    policy: { ...policy },
    policyRequestId,
  };
}

export function useAssemblyCompiledBroadRasterSurface({
  enabled,
  annotationColorsByIdentity,
  prepareAnnotationAliases = false,
  missingAnnotationColor,
  themeMode = 'light',
  cache,
  assetGeneration = null,
  assemblyRequirement,
  policy,
  policyRequestId = null,
  rendererReadyEpoch,
  rendererGenomeCommitEpoch,
  webglRef,
  recordEvent,
  onPolicyCommitted,
}: UseAssemblyCompiledBroadRasterSurfaceOptions): {
  notifyCameraChanged: () => void;
  refreshPolicy: () => void;
  getDiagnostics: () => AssemblyCompiledBroadRasterLoaderDiagnosticsV1 | null;
  readiness: AssemblyCompiledBroadRasterReadinessV1;
  readinessTargetIdentityKey: string | null;
  readinessRendererMatchesCurrent: boolean;
  targetIdentityKey: string | null;
  expectedInteractionOwnerKey: string | null;
  validatedSourceFingerprint: string | null;
  admittedBroadCorridorFinestSpanBp: number | null;
  policyControlsReadiness: AssemblyCompiledBroadRasterPolicyControlsReadinessV1;
  policyFailureRequestId: number | null;
  annotationSourceBinding: SourceAnnotationAliasBindingV1 | null;
} {
  const aliasScene = cache.status === 'hit' ? cache.result : null;
  const aliasKey = aliasScene
    ? `${cache.descriptor?.runtimeCacheKey}\n${cache.descriptor?.artifact.artifactKey}\n${aliasScene.manifest.integrity.payloadSha256}\n${aliasScene.manifest.integrity.contractSha256}\n${assemblyReferenceAssetGenerationKey(assetGeneration)}`
    : null;
  const [preparedAliases, setPreparedAliases] = useState<{
    key: string;
    binding: SourceAnnotationAliasBindingV1;
  } | null>(null);
  useEffect(() => {
    if (
      !enabled ||
      !prepareAnnotationAliases ||
      !aliasKey ||
      !aliasScene ||
      aliasScene.manifest.sourceAnnotationAliases ||
      !cache.descriptor
    )
      return;
    let current = true;
    const request = cache.descriptor.request;
    void compileAnnotationDataAppearanceV1({ colors: [], themeMode })
      .then((appearance) =>
        platform().genome.prepareAssemblyAnnotationAppearanceV1({
          contract: 'assembly-compiled-broad-raster-wire.v1',
          scene: {
            ...request,
            ...(assetGeneration ? { expectedAssetGeneration: assetGeneration } : {}),
          },
          appearance,
          prepareAliasesOnly: true,
        })
      )
      .then((result) => {
        if (
          current &&
          result.status === 'ready' &&
          result.sourceBinding.payloadSha256 === aliasScene.manifest.integrity.payloadSha256 &&
          result.sourceBinding.contractSha256 === aliasScene.manifest.integrity.contractSha256
        )
          setPreparedAliases({ key: aliasKey, binding: result.sourceBinding });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [enabled, prepareAnnotationAliases, aliasKey, themeMode]);
  const annotationSourceBinding = useMemo(
    () =>
      aliasScene?.manifest.sourceAnnotationAliases
        ? {
            payloadSha256: aliasScene.manifest.integrity.payloadSha256,
            contractSha256: aliasScene.manifest.integrity.contractSha256,
            aliases: aliasScene.manifest.sourceAnnotationAliases,
          }
        : preparedAliases?.key === aliasKey
          ? preparedAliases.binding
          : null,
    [aliasScene, aliasKey, preparedAliases]
  );
  const [appearanceState, setAppearanceState] = useState<{
    colors: ReadonlyMap<string, string>;
    missingColor: string | undefined;
    theme: 'light' | 'dark';
    appearance: AnnotationDataAppearanceV1;
  } | null>(null);
  useEffect(() => {
    if (!annotationColorsByIdentity) return;
    let current = true;
    const rgb = (value: string) => {
      if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('Annotation data color is invalid.');
      return Number.parseInt(value.slice(1), 16);
    };
    void compileAnnotationDataAppearanceV1({
      colors: [...annotationColorsByIdentity].map(([id, color]) => [id, rgb(color)] as const),
      ...(missingAnnotationColor ? { missingColor: rgb(missingAnnotationColor) } : {}),
      themeMode,
    })
      .then((appearance) => {
        if (current)
          setAppearanceState({
            colors: annotationColorsByIdentity,
            missingColor: missingAnnotationColor,
            theme: themeMode,
            appearance,
          });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [annotationColorsByIdentity, missingAnnotationColor, themeMode]);
  const appearance =
    annotationColorsByIdentity &&
    appearanceState?.colors === annotationColorsByIdentity &&
    appearanceState.missingColor === missingAnnotationColor &&
    appearanceState.theme === themeMode
      ? appearanceState.appearance
      : undefined;
  const policyIsoformMode = policy.isoformMode;
  const policyLaneLimit = policy.laneLimit;
  const target =
    annotationColorsByIdentity && !appearance
      ? null
      : activeAssemblyCompiledBroadRasterTargetV1(
          cache,
          {
            isoformMode: policyIsoformMode,
            laneLimit: policyLaneLimit,
          },
          policyRequestId,
          assetGeneration,
          appearance
        );
  const targetRef = useRef(target);
  targetRef.current = target;
  const targetIdentityKey = target?.identityKey ?? null;
  const assetGenerationKey = assemblyReferenceAssetGenerationKey(assetGeneration);
  const [readinessReceipt, setReadinessReceipt] =
    useState<AssemblyCompiledBroadRasterReadinessReceiptV1>({
      readiness: 'idle',
      commandKey: null,
      commandRenderer: null,
      targetIdentityKey: null,
      renderer: null,
      expectedInteractionOwnerKey: null,
      validatedSourceFingerprint: null,
      admittedBroadCorridorFinestSpanBp: null,
    });
  const [policyControlsReadiness, setPolicyControlsReadiness] =
    useState<AssemblyCompiledBroadRasterPolicyControlsReadinessV1>('idle');
  const recordEventRef = useRef(recordEvent);
  recordEventRef.current = recordEvent;
  const onPolicyCommittedRef = useRef(onPolicyCommitted);
  onPolicyCommittedRef.current = onPolicyCommitted;
  const webglRefRef = useRef(webglRef);
  webglRefRef.current = webglRef;
  const loaderRef = useRef<AssemblyCompiledBroadRasterLoaderV1 | null>(null);
  useLayoutEffect(() => {
    const loader = new AssemblyCompiledBroadRasterLoaderV1({
      prepareAppearance: (request) =>
        platform().genome.prepareAssemblyAnnotationAppearanceV1(request),
      readManifest: (request) =>
        platform().genome.readAssemblyCompiledBroadRasterManifestV1(request),
      readCells: (request) => platform().genome.readAssemblyCompiledBroadRasterCellsV1(request),
      getRenderer: () =>
        (webglRefRef.current.current?.getLinearRenderer?.() as CompiledBroadRasterRendererV1 | null) ??
        null,
      getRendererPresentationLifecycle: () => {
        const handle = webglRefRef.current.current;
        const renderer =
          (handle?.getLinearRenderer?.() as CompiledBroadRasterRendererV1 | null) ?? null;
        if (!handle || !renderer) return null;
        return {
          renderer,
          requestRender: () => handle.requestRender(),
          schedulePostPresentWork: (work) => handle.schedulePostPresentWork(work),
        };
      },
      requestRender: () => webglRefRef.current.current?.requestRender?.(),
      schedulePostPresentWork: (work) =>
        webglRefRef.current.current?.schedulePostPresentWork?.(work),
      rendererInteractionQuietDelayMs,
      recordEvent: (event, detail) => recordEventRef.current(event, detail),
      onReadinessChange: (receipt) => {
        if (loaderRef.current !== loader) return;
        setReadinessReceipt((current) =>
          current.readiness === receipt.readiness &&
          current.commandKey === receipt.commandKey &&
          current.commandRenderer === receipt.commandRenderer &&
          current.targetIdentityKey === receipt.targetIdentityKey &&
          current.renderer === receipt.renderer &&
          current.expectedInteractionOwnerKey === receipt.expectedInteractionOwnerKey &&
          current.validatedSourceFingerprint === receipt.validatedSourceFingerprint &&
          current.admittedBroadCorridorFinestSpanBp === receipt.admittedBroadCorridorFinestSpanBp
            ? current
            : receipt
        );
      },
      onPolicyControlsReadinessChange: (next) => {
        if (loaderRef.current === loader) setPolicyControlsReadiness(next);
      },
      onPolicyCommitted: (receipt) => {
        if (loaderRef.current === loader) onPolicyCommittedRef.current?.(receipt);
      },
    });
    loaderRef.current = loader;
    return () => {
      if (loaderRef.current === loader) loaderRef.current = null;
      loader.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    const loader = loaderRef.current;
    if (!loader || !enabled || !assemblyRequirement || rendererReadyEpoch <= 0) return;
    loader.armRequirement(assemblyRequirement);
  }, [assemblyRequirement, enabled, rendererReadyEpoch]);

  useEffect(() => {
    const loader = loaderRef.current;
    const currentTarget = targetRef.current;
    if (!loader) return;
    if (!enabled || !assemblyRequirement || rendererReadyEpoch <= 0) {
      loader.pause();
      return;
    }
    if (!currentTarget) return;
    void loader.reconcile(currentTarget);
  }, [
    assemblyRequirement,
    enabled,
    policyIsoformMode,
    policyLaneLimit,
    policyRequestId,
    rendererGenomeCommitEpoch,
    rendererReadyEpoch,
    assetGenerationKey,
    targetIdentityKey,
  ]);

  const notifyCameraChanged = useCallback(() => {
    loaderRef.current?.signalCameraChanged();
  }, []);
  const refreshPolicy = useCallback(() => {
    void loaderRef.current?.refreshDemand(false);
  }, []);
  const getDiagnostics = useCallback(() => loaderRef.current?.diagnostics() ?? null, []);
  const currentRenderer =
    (webglRef.current?.getLinearRenderer?.() as CompiledBroadRasterRendererV1 | null) ?? null;
  return {
    annotationSourceBinding,
    notifyCameraChanged,
    refreshPolicy,
    getDiagnostics,
    readiness: readinessReceipt.readiness,
    readinessTargetIdentityKey: readinessReceipt.targetIdentityKey,
    readinessRendererMatchesCurrent:
      readinessReceipt.renderer !== null && readinessReceipt.renderer === currentRenderer,
    targetIdentityKey,
    expectedInteractionOwnerKey: readinessReceipt.expectedInteractionOwnerKey,
    validatedSourceFingerprint: readinessReceipt.validatedSourceFingerprint,
    admittedBroadCorridorFinestSpanBp: readinessReceipt.admittedBroadCorridorFinestSpanBp,
    policyControlsReadiness,
    policyFailureRequestId:
      enabled &&
      assemblyRequirement !== null &&
      rendererReadyEpoch > 0 &&
      target !== null &&
      currentRenderer !== null &&
      readinessReceipt.commandRenderer === currentRenderer &&
      readinessReceipt.commandKey === assemblyCompiledBroadRasterCommandKeyV1(target) &&
      (readinessReceipt.readiness === 'error' || readinessReceipt.readiness === 'unavailable')
        ? policyRequestId
        : null,
  };
}
