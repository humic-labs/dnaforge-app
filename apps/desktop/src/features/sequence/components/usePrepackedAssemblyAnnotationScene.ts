import { useEffect, useState } from 'react';

import type { PrepackedAnnotationSceneLoadInput } from '@waypoint/genome-renderer';
import { unpackPartitionedTranscriptSceneBinaryV4 } from '@waypoint/genome-renderer/pure';
import type { UnpackedPartitionedTranscriptSceneBinaryV4 } from '@waypoint/genome-renderer/pure';
import { platform } from '../../../platform';
import { shouldEnableTestBridge } from '../../../lib/test-bridge-gate';
import { assemblyAnnotationSceneInteractionOwnerKeyV3 } from '../../../shared/indexed-genome';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import type {
  AssemblyPrepackedAnnotationSceneCacheState,
  AssemblyPrepackedAnnotationSceneDescriptor,
  AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt,
  AssemblyPrepackedAnnotationScenePolicy,
} from './useAssemblyPrepackedAnnotationSceneCache';

export type PrepackedAssemblyAnnotationSceneReadiness =
  | 'not-applicable'
  | 'waiting-features'
  | 'waiting-renderer'
  | 'waiting-policy'
  | 'loading-hit'
  | 'loaded-hit'
  | 'ineligible'
  | 'error';

type PrepackedRenderer = {
  loadPrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean;
  preparePrepackedAnnotationScene?(input: PrepackedAnnotationSceneLoadInput): boolean;
  activatePrepackedAnnotationScene?(ownerKey: string): boolean;
  updatePrepackedAnnotationPolicy?(policy: {
    isoformMode: 'canonical' | 'expanded';
    laneLimit: number | null;
  }): boolean;
  getPrepackedAnnotationSceneOwnerSnapshot?(): {
    ownerKey: string | null;
    ownerGeneration: number;
    loaded: boolean;
    status: string;
    gpuPrepared: boolean;
    metadata: PrepackedAnnotationSceneLoadInput['metadata'] | null;
    runtimePolicy?: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null } | null;
    policyGeneration?: number;
  };
  getCurrentPathMapper?(): unknown;
};

interface PreparedScene {
  input: PrepackedAnnotationSceneLoadInput;
  origin: 'hit' | 'built';
}

interface PreparationTask {
  promise: Promise<PreparedScene | null>;
  subscribers: Set<() => boolean>;
}

type RendererReadyUnpackedSceneV4 = UnpackedPartitionedTranscriptSceneBinaryV4 &
  Partial<{
    rendererAdmissionCapability: NonNullable<
      PrepackedAnnotationSceneLoadInput['trustedRendererAdmissionV4']
    >;
    rendererAdmissionProvenance: NonNullable<
      PrepackedAnnotationSceneLoadInput['trustedRendererAdmissionProvenanceV4']
    >;
    rendererAdmissionLoadIdentity: NonNullable<
      PrepackedAnnotationSceneLoadInput['trustedRendererAdmissionLoadIdentityV4']
    >;
  }>;

type RendererSceneUnpackV4 = (
  manifest: Parameters<typeof unpackPartitionedTranscriptSceneBinaryV4>[0],
  payload: Parameters<typeof unpackPartitionedTranscriptSceneBinaryV4>[1]
) => Promise<RendererReadyUnpackedSceneV4>;

const preparationTasks = new Map<string, PreparationTask>();
const preparedScenes = new Map<string, PreparedScene>();
const MAX_PREPARED_SCENES = 1;

export function resetPrepackedAssemblyAnnotationSceneTasksForTest(): void {
  preparationTasks.clear();
  preparedScenes.clear();
}

export interface ExecutePrepackedAssemblyAnnotationSceneInput {
  cache: Exclude<
    AssemblyPrepackedAnnotationSceneCacheState,
    { status: 'not-applicable' | 'loading' }
  >;
  renderer: PrepackedRenderer;
  effectiveLayerTypes: readonly string[];
  requestedPolicy?: AssemblyPrepackedAnnotationScenePolicy;
  activateOwner?: boolean;
  isCurrent: () => boolean;
  readUnpacked?: typeof unpackPartitionedTranscriptSceneBinaryV4;
}

function requestedPolicyForExecution(
  input: ExecutePrepackedAssemblyAnnotationSceneInput
): AssemblyPrepackedAnnotationScenePolicy {
  return (
    input.requestedPolicy ?? {
      trackType: input.cache.descriptor.artifact.trackType,
      isoformMode: input.cache.descriptor.request.requestedPolicy.isoformMode,
      laneLimit: input.cache.descriptor.request.requestedPolicy.laneLimit,
    }
  );
}

export async function executePrepackedAssemblyAnnotationScene(
  input: ExecutePrepackedAssemblyAnnotationSceneInput
): Promise<PreparedScene | null> {
  if (
    !isExactTrackContract(
      input.effectiveLayerTypes,
      requestedPolicyForExecution(input).trackType
    ) ||
    !input.isCurrent()
  )
    return null;
  if (input.cache.status === 'error') return null;
  if (input.cache.status === 'miss') return null;
  const descriptor = input.cache.descriptor;
  const completedPreparationKey = validatedPreparationKey(input.cache);
  if (!completedPreparationKey) return null;
  const taskKey = completedPreparationKey;
  const completed = completedPreparationKey ? preparedScenes.get(completedPreparationKey) : null;
  if (completed) {
    if (!input.isCurrent()) return null;
    return publishPreparedHit(input, completed);
  }
  let task = preparationTasks.get(taskKey);
  if (!task) {
    const subscribers = new Set<() => boolean>([input.isCurrent]);
    const created: PreparationTask = {
      promise: Promise.resolve(null),
      subscribers,
    };
    const anyCurrent = () => [...subscribers].some((isCurrent) => isCurrent());
    let trustedScene: RendererReadyUnpackedSceneV4 | null = null;
    if (!input.readUnpacked && input.cache.status === 'hit' && input.cache.result) {
      const genomePlatform = platform().genome;
      const getTrustedScene = genomePlatform.getTrustedAssemblyAnnotationScene;
      if (typeof getTrustedScene === 'function') {
        trustedScene = getTrustedScene.call(genomePlatform, input.cache.result);
        if (trustedScene) {
          recordPreparationTrace(descriptor.sceneKey, 'transport-materialized-scene-received');
        }
      }
    }
    created.promise = prepareScene({
      cache: input.cache,
      descriptor,
      anyCurrent,
      requestedPolicy: requestedPolicyForExecution(input),
      trusted: trustedScene,
      unpack: input.readUnpacked ?? unpackPartitionedTranscriptSceneBinaryV4,
    }).then((prepared) => {
      if (prepared && completedPreparationKey) {
        rememberPreparedScene(completedPreparationKey, prepared);
      }
      return prepared;
    });
    task = created;
    preparationTasks.set(taskKey, created);
    const cleanup = () => {
      if (preparationTasks.get(taskKey) === created) {
        preparationTasks.delete(taskKey);
      }
    };
    void created.promise.then(cleanup, cleanup);
  } else {
    task.subscribers.add(input.isCurrent);
  }
  try {
    const prepared = await task.promise;
    if (!prepared) return null;
    if (!input.isCurrent()) return null;
    if (completedPreparationKey) rememberPreparedScene(completedPreparationKey, prepared);
    return publishPreparedHit(input, prepared);
  } finally {
    task.subscribers.delete(input.isCurrent);
  }
}

export function hasPreparedPrepackedAssemblyAnnotationScene(
  cache: Exclude<
    AssemblyPrepackedAnnotationSceneCacheState,
    { status: 'not-applicable' | 'loading' }
  >
): boolean {
  const key = validatedPreparationKey(cache);
  return key !== null && preparedScenes.has(key);
}

function publishPreparedHit(
  input: ExecutePrepackedAssemblyAnnotationSceneInput,
  prepared: PreparedScene
): PreparedScene | null {
  if (!input.isCurrent()) return null;
  recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-admit-start');
  const requestedPolicy = requestedPolicyForExecution(input);
  const runtimePolicy = {
    isoformMode: requestedPolicy.isoformMode,
    laneLimit: requestedPolicy.laneLimit,
  } as const;
  if (input.activateOwner === false) {
    const prepare = input.renderer.preparePrepackedAnnotationScene;
    if (typeof prepare !== 'function' || !prepare.call(input.renderer, prepared.input)) {
      recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-prepare-failed');
      return null;
    }
    recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-prepare-complete');
    return prepared;
  }
  const currentOwner = input.renderer.getPrepackedAnnotationSceneOwnerSnapshot?.();
  if (
    currentOwner?.loaded &&
    currentOwner.gpuPrepared &&
    currentOwner.ownerKey === prepared.input.ownerKey
  ) {
    if (
      currentOwner.runtimePolicy?.isoformMode === runtimePolicy.isoformMode &&
      currentOwner.runtimePolicy?.laneLimit === runtimePolicy.laneLimit
    ) {
      recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-owner-reused');
      return prepared;
    }
    const update = input.renderer.updatePrepackedAnnotationPolicy;
    const updated = typeof update === 'function' && update.call(input.renderer, runtimePolicy);
    recordPreparationTrace(
      input.cache.descriptor.sceneKey,
      updated ? 'renderer-policy-admit-complete' : 'renderer-policy-admit-failed'
    );
    return updated ? prepared : null;
  }
  const loadInput =
    prepared.input.runtimePolicy?.isoformMode === runtimePolicy.isoformMode &&
    prepared.input.runtimePolicy?.laneLimit === runtimePolicy.laneLimit
      ? prepared.input
      : { ...prepared.input, runtimePolicy };
  if (currentOwner?.loaded && currentOwner.ownerKey !== loadInput.ownerKey) {
    const prepare = input.renderer.preparePrepackedAnnotationScene;
    const activate = input.renderer.activatePrepackedAnnotationScene;
    if (typeof prepare !== 'function' || typeof activate !== 'function') return null;
    if (!prepare.call(input.renderer, loadInput)) {
      recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-prepare-failed');
      return null;
    }
    recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-prepare-complete');
    if (!activate.call(input.renderer, loadInput.ownerKey)) {
      recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-activate-failed');
      return null;
    }
    recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-admit-complete');
    return loadInput === prepared.input ? prepared : { ...prepared, input: loadInput };
  }
  if (!input.renderer.loadPrepackedAnnotationScene(loadInput)) {
    recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-admit-failed');
    return null;
  }
  recordPreparationTrace(input.cache.descriptor.sceneKey, 'renderer-admit-complete');
  return loadInput === prepared.input ? prepared : { ...prepared, input: loadInput };
}

function rememberPreparedScene(preparationKey: string, prepared: PreparedScene): void {
  preparedScenes.delete(preparationKey);
  preparedScenes.set(preparationKey, prepared);
  while (preparedScenes.size > MAX_PREPARED_SCENES) {
    const oldest = preparedScenes.keys().next().value as string | undefined;
    if (!oldest) break;
    preparedScenes.delete(oldest);
  }
}

function validatedPreparationKey(
  cache: Exclude<
    AssemblyPrepackedAnnotationSceneCacheState,
    { status: 'not-applicable' | 'loading' }
  >
): string | null {
  if (cache.status !== 'hit' || !cache.result) return null;
  const provenance = [
    'validated-hit',
    cache.result.manifest.integrity.payloadSha256,
    cache.result.manifest.integrity.contractSha256,
    String(cache.result.byteCount),
  ];
  return [
    'assembly-annotation-scene-preparation.v1',
    cache.descriptor.runtimeCacheKey,
    ...provenance,
    cache.result.fingerprint,
    cache.result.sourceBuildFingerprint,
  ].join('\n');
}

async function prepareScene(input: {
  cache: Exclude<
    AssemblyPrepackedAnnotationSceneCacheState,
    { status: 'not-applicable' | 'loading' }
  >;
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor;
  anyCurrent: () => boolean;
  requestedPolicy: AssemblyPrepackedAnnotationScenePolicy;
  unpack: RendererSceneUnpackV4;
  trusted: RendererReadyUnpackedSceneV4 | null;
}): Promise<PreparedScene | null> {
  const metadata = metadataFor(input.descriptor);
  if (input.cache.status === 'hit' && input.cache.result) {
    let direct: RendererReadyUnpackedSceneV4;
    if (input.trusted) {
      direct = input.trusted;
    } else {
      recordPreparationTrace(input.descriptor.sceneKey, 'materialize-start', {
        mode: 'renderer-decode',
      });
      direct = await input.unpack(input.cache.result.manifest, input.cache.result.payload);
      recordPreparationTrace(input.descriptor.sceneKey, 'materialize-complete', {
        mode: 'renderer-decode',
        payloadBytes: input.cache.result.payload.byteLength,
      });
    }
    if (!input.anyCurrent()) return null;
    const loadInput = directLoadInput(
      direct,
      metadata,
      input.requestedPolicy,
      assemblyPrepackedAnnotationSceneOwnerKey({
        fingerprint: input.cache.result.fingerprint,
        payloadSha256: input.cache.result.manifest.integrity.payloadSha256,
        artifactKey: input.descriptor.artifact.artifactKey,
      })
    );
    return {
      input: loadInput,
      origin: input.cache.lifecycle.origin === 'prepared-after-miss' ? 'built' : 'hit',
    };
  }

  return null;
}

function directLoadInput(
  direct: RendererReadyUnpackedSceneV4,
  metadata: PrepackedAnnotationSceneLoadInput['metadata'],
  requestedPolicy: AssemblyPrepackedAnnotationScenePolicy,
  ownerKey: string
): PrepackedAnnotationSceneLoadInput {
  return {
    ownerKey,
    scene: {
      primitives: [],
      featureFamilyIndices: direct.featureFamilyIndices,
      families: direct.families,
    },
    gpuReadyScene: direct.scene,
    interactionIndex: direct.interactionIndex,
    policyProjection: direct.policyProjection,
    submissionBank: direct.submissionBank,
    submissionFineIndices: direct.submissionFineIndices,
    ...(direct.rendererAdmissionCapability &&
    direct.rendererAdmissionProvenance &&
    direct.rendererAdmissionLoadIdentity
      ? {
          trustedRendererAdmissionV4: direct.rendererAdmissionCapability,
          trustedRendererAdmissionProvenanceV4: direct.rendererAdmissionProvenance,
          trustedRendererAdmissionLoadIdentityV4: direct.rendererAdmissionLoadIdentity,
        }
      : {}),
    runtimePolicy: {
      isoformMode: requestedPolicy.isoformMode,
      laneLimit: requestedPolicy.laneLimit,
    },
    metadata,
  };
}

export function assemblyPrepackedAnnotationSceneOwnerKey(input: {
  fingerprint: string;
  payloadSha256: string;
  artifactKey: string;
}): string {
  const ownerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
    sourceFingerprint: input.fingerprint,
    scenePayloadSha256: input.payloadSha256,
    sceneArtifactKey: input.artifactKey,
  });
  if (!ownerKey) throw new Error('prepacked annotation scene owner provenance is incomplete');
  return ownerKey;
}

export interface PrepackedAssemblyAnnotationScenePresentationReceipt {
  requestId: number | null;
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor;
  ownerKey: string;
  metadata: PrepackedAnnotationSceneLoadInput['metadata'];
  runtimePolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
  origin: PreparedScene['origin'];
}

export interface ScopedPrepackedAssemblyAnnotationSceneReadiness {
  readonly requestId: number | null;
  readonly readinessScopeKey: string;
  readonly status: PrepackedAssemblyAnnotationSceneReadiness;
}

export function scopedPrepackedAssemblyAnnotationSceneReadiness(input: {
  readonly state: ScopedPrepackedAssemblyAnnotationSceneReadiness;
  readonly currentRequestId: number | null;
  readonly currentReadinessScopeKey: string;
}): PrepackedAssemblyAnnotationSceneReadiness {
  return input.state.requestId === input.currentRequestId &&
    input.state.readinessScopeKey === input.currentReadinessScopeKey
    ? input.state.status
    : 'loading-hit';
}

export function usePrepackedAssemblyAnnotationScene(input: {
  cache: AssemblyPrepackedAnnotationSceneCacheState;
  overviewFeaturesComplete: boolean;
  effectiveLayerTypes: readonly string[];
  requestedPolicy: AssemblyPrepackedAnnotationScenePolicy;
  activateOwner?: boolean;
  requestId?: number | null;
  publishBridge?: boolean;
  onPresented?: (receipt: PrepackedAssemblyAnnotationScenePresentationReceipt) => void;
  readinessGeneration: string;
  readinessScopeKey: string;
  rendererReadyEpoch?: number;
  rendererGenomeCommitEpoch?: number;
  webglRef: {
    readonly current:
      | (Pick<IndexedGenomeTileNativeMapHandle, 'getLinearRenderer'> &
          Partial<Pick<IndexedGenomeTileNativeMapHandle, 'requestRender'>>)
      | null;
  };
}): PrepackedAssemblyAnnotationSceneReadiness {
  const currentRequestId = input.requestId ?? null;
  const [readinessState, setReadinessState] =
    useState<ScopedPrepackedAssemblyAnnotationSceneReadiness>({
      requestId: currentRequestId,
      readinessScopeKey: input.readinessScopeKey,
      status: 'not-applicable',
    });
  const effectiveLayerTypesKey = input.effectiveLayerTypes.join('\u0000');
  const descriptor = input.cache.descriptor;
  const requestedPolicyMatchesDescriptor =
    descriptor != null && scenePolicyMatches(descriptor, input.requestedPolicy);
  const publishBridge = input.publishBridge ?? true;

  useEffect(() => {
    const attemptRequestId = currentRequestId;
    const attemptReadinessScopeKey = input.readinessScopeKey;
    const setAttemptReadiness = (status: PrepackedAssemblyAnnotationSceneReadiness) =>
      setReadinessState({
        requestId: attemptRequestId,
        readinessScopeKey: attemptReadinessScopeKey,
        status,
      });
    const onPresented = input.onPresented;
    if (!descriptor) {
      setAttemptReadiness('not-applicable');
      if (publishBridge) publishReadiness(input.readinessGeneration, 'not-applicable', null);
      return;
    }
    if (!requestedPolicyMatchesDescriptor) {
      setAttemptReadiness('waiting-policy');
      if (publishBridge) publishReadiness(input.readinessGeneration, 'waiting-policy', descriptor);
      return;
    }
    if (!isExactTrackContract(input.effectiveLayerTypes, input.requestedPolicy.trackType)) {
      setAttemptReadiness('ineligible');
      if (publishBridge) publishReadiness(input.readinessGeneration, 'ineligible', descriptor);
      return;
    }
    if (input.cache.status === 'error') {
      setAttemptReadiness('error');
      if (publishBridge) {
        publishReadiness(
          input.readinessGeneration,
          'error',
          descriptor,
          input.cache.error ?? undefined
        );
      }
      return;
    }
    if (input.cache.status === 'miss' && descriptor.request.scope?.kind === 'complete-assembly') {
      const error = new Error(
        'Full-assembly annotation scenes must be prepared from validated source data before renderer publication.'
      );
      setAttemptReadiness('error');
      if (publishBridge) {
        publishReadiness(input.readinessGeneration, 'error', descriptor, error);
      }
      return;
    }
    const retainedPreparedScene =
      input.cache.status !== 'loading' && hasPreparedPrepackedAssemblyAnnotationScene(input.cache);
    if (input.cache.status !== 'hit' && !retainedPreparedScene && !input.overviewFeaturesComplete) {
      setAttemptReadiness('waiting-features');
      if (publishBridge) {
        publishReadiness(input.readinessGeneration, 'waiting-features', descriptor);
      }
      return;
    }
    if (input.cache.status === 'loading') {
      setAttemptReadiness('loading-hit');
      if (publishBridge) publishReadiness(input.readinessGeneration, 'loading-hit', descriptor);
      return;
    }
    const resolvedCache = input.cache as Exclude<
      AssemblyPrepackedAnnotationSceneCacheState,
      { status: 'not-applicable' | 'loading' }
    >;

    let cancelled = false;
    let rafId = 0;
    const isCurrent = () => !cancelled;
    const attempt = () => {
      if (cancelled) return;
      const renderer = input.webglRef.current?.getLinearRenderer?.() as
        | PrepackedRenderer
        | null
        | undefined;
      if (!renderer || !rendererHasLayout(renderer)) {
        setAttemptReadiness('waiting-renderer');
        if (publishBridge) {
          publishReadiness(input.readinessGeneration, 'waiting-renderer', descriptor);
        }
        return;
      }
      const pendingStatus = 'loading-hit';
      setAttemptReadiness(pendingStatus);
      if (publishBridge) publishReadiness(input.readinessGeneration, pendingStatus, descriptor);
      void executePrepackedAssemblyAnnotationScene({
        cache: resolvedCache,
        renderer,
        effectiveLayerTypes: input.effectiveLayerTypes,
        isCurrent,
        requestedPolicy: input.requestedPolicy,
        activateOwner: input.activateOwner,
      })
        .then((prepared) => {
          if (cancelled) return;
          if (!prepared) {
            const status = rendererSceneStatus(renderer);
            if (status === 'genome-mismatch' || status === 'not-loaded') {
              setAttemptReadiness('waiting-renderer');
              if (publishBridge) {
                publishReadiness(input.readinessGeneration, 'waiting-renderer', descriptor);
              }
              return;
            }
            setAttemptReadiness('ineligible');
            if (publishBridge) {
              publishReadiness(
                input.readinessGeneration,
                'ineligible',
                descriptor,
                undefined,
                renderer,
                resolvedCache.status,
                resolvedCache.lifecycle,
                resolvedCache.status === 'hit' ? resolvedCache.result.payload.byteLength : undefined
              );
            }
            return;
          }
          const status = 'loaded-hit';
          input.webglRef.current?.requestRender?.();
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            if (cancelled) return;
            const currentRenderer = input.webglRef.current?.getLinearRenderer?.();
            if (
              currentRenderer !== renderer ||
              (input.activateOwner !== false &&
                !exactPresentedOwnerMatches(renderer, prepared.input, input.requestedPolicy))
            ) {
              setAttemptReadiness('waiting-renderer');
              if (publishBridge) {
                publishReadiness(
                  input.readinessGeneration,
                  'waiting-renderer',
                  descriptor,
                  undefined,
                  renderer,
                  resolvedCache.status,
                  resolvedCache.lifecycle
                );
              }
              return;
            }
            setAttemptReadiness(status);
            if (publishBridge) {
              publishReadiness(
                input.readinessGeneration,
                status,
                descriptor,
                undefined,
                renderer,
                resolvedCache.status,
                resolvedCache.lifecycle,
                resolvedCache.status === 'hit' ? resolvedCache.result.payload.byteLength : undefined
              );
            }
            onPresented?.({
              requestId: attemptRequestId,
              descriptor,
              ownerKey: prepared.input.ownerKey,
              metadata: prepared.input.metadata,
              runtimePolicy: {
                isoformMode: input.requestedPolicy.isoformMode,
                laneLimit: input.requestedPolicy.laneLimit,
              },
              origin: prepared.origin,
            });
          });
        })
        .catch((error) => {
          if (cancelled) return;
          setAttemptReadiness('error');
          if (publishBridge) {
            publishReadiness(input.readinessGeneration, 'error', descriptor, error);
          }
        });
    };
    attempt();
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [
    input.cache.descriptor?.sceneKey,
    input.cache.result,
    input.cache.status,
    effectiveLayerTypesKey,
    input.overviewFeaturesComplete,
    input.onPresented,
    input.readinessGeneration,
    input.readinessScopeKey,
    input.rendererGenomeCommitEpoch,
    input.rendererReadyEpoch,
    currentRequestId,
    input.requestedPolicy.isoformMode,
    input.requestedPolicy.laneLimit,
    input.requestedPolicy.trackType,
    input.activateOwner,
    requestedPolicyMatchesDescriptor,
    publishBridge,
  ]);

  useEffect(() => {
    if (!publishBridge) return;
    return () => clearPrepackedAssemblyAnnotationSceneReadiness(input.readinessGeneration);
  }, [input.readinessGeneration, publishBridge]);

  const readiness = scopedPrepackedAssemblyAnnotationSceneReadiness({
    state: readinessState,
    currentRequestId,
    currentReadinessScopeKey: input.readinessScopeKey,
  });
  return descriptor && !requestedPolicyMatchesDescriptor ? 'waiting-policy' : readiness;
}

function scenePolicyMatches(
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor,
  requested: AssemblyPrepackedAnnotationScenePolicy
): boolean {
  return descriptor.artifact.trackType === requested.trackType;
}

function metadataFor(
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor
): PrepackedAnnotationSceneLoadInput['metadata'] {
  return {
    genomeIdentity: descriptor.sourceIdentity,
    genomeLengthBp: descriptor.request.chromosomes.reduce((sum, chrom) => sum + chrom.length, 0),
    partitionSpanBp: descriptor.artifact.partitionSpanBp,
    artifactKey: descriptor.artifact.artifactKey,
    themeMode: descriptor.artifact.themeMode,
    trackType: descriptor.artifact.trackType,
    annotationBarHeightPx: descriptor.artifact.annotationBarHeightPx,
    laneAlgorithmToken: descriptor.artifact
      .laneAlgorithmToken as PrepackedAnnotationSceneLoadInput['metadata']['laneAlgorithmToken'],
    mapperContractToken: descriptor.artifact
      .mapperContractToken as PrepackedAnnotationSceneLoadInput['metadata']['mapperContractToken'],
    geometryContractToken: descriptor.artifact
      .geometryContractToken as PrepackedAnnotationSceneLoadInput['metadata']['geometryContractToken'],
    interactionContractToken: descriptor.artifact
      .interactionContractToken as PrepackedAnnotationSceneLoadInput['metadata']['interactionContractToken'],
  };
}

function isExactTrackContract(layerTypes: readonly string[], trackType: string): boolean {
  return layerTypes.length === 1 && layerTypes[0] === trackType;
}

function rendererHasLayout(renderer: PrepackedRenderer): boolean {
  return renderer.getCurrentPathMapper?.() != null;
}

function rendererSceneStatus(renderer: PrepackedRenderer): string | null {
  const status = renderer.getPrepackedAnnotationSceneOwnerSnapshot?.()?.status;
  return typeof status === 'string' ? status : null;
}

function exactPresentedOwnerMatches(
  renderer: PrepackedRenderer,
  expected: PrepackedAnnotationSceneLoadInput,
  requestedPolicy: AssemblyPrepackedAnnotationScenePolicy
): boolean {
  const owner = renderer.getPrepackedAnnotationSceneOwnerSnapshot?.();
  const actual = owner?.metadata;
  const wanted = expected.metadata;
  return Boolean(
    owner?.loaded &&
    owner.gpuPrepared &&
    owner.ownerKey === expected.ownerKey &&
    actual &&
    actual.genomeIdentity === wanted.genomeIdentity &&
    actual.genomeLengthBp === wanted.genomeLengthBp &&
    actual.partitionSpanBp === wanted.partitionSpanBp &&
    actual.artifactKey === wanted.artifactKey &&
    actual.themeMode === wanted.themeMode &&
    actual.trackType === wanted.trackType &&
    actual.annotationBarHeightPx === wanted.annotationBarHeightPx &&
    actual.laneAlgorithmToken === wanted.laneAlgorithmToken &&
    actual.mapperContractToken === wanted.mapperContractToken &&
    actual.geometryContractToken === wanted.geometryContractToken &&
    actual.interactionContractToken === wanted.interactionContractToken &&
    owner.runtimePolicy?.isoformMode === requestedPolicy.isoformMode &&
    owner.runtimePolicy?.laneLimit === requestedPolicy.laneLimit
  );
}

type PrepackedSceneWindow = Window & {
  __dna708PrepackedSceneReadiness?: Record<string, unknown> & {
    runGeneration?: unknown;
    sceneKey?: unknown;
    preparationTimeline?: unknown;
  };
  __webglPrepackedAnnotationSceneOwnerSnapshot?: unknown;
};

function prepackedSceneWindow(): PrepackedSceneWindow {
  return window as PrepackedSceneWindow;
}

function publishReadiness(
  runGeneration: string,
  status: PrepackedAssemblyAnnotationSceneReadiness,
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor | null,
  error?: unknown,
  renderer?: PrepackedRenderer,
  cacheState?: string,
  cacheLifecycle?: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt,
  payloadBytes?: number
): void {
  if (
    typeof window === 'undefined' ||
    !shouldEnableTestBridge(import.meta.env) ||
    !('__dna708PrepackedSceneReadiness' in window || status !== 'not-applicable')
  ) {
    return;
  }
  const target = prepackedSceneWindow();
  const previous =
    target.__dna708PrepackedSceneReadiness &&
    typeof target.__dna708PrepackedSceneReadiness === 'object'
      ? (target.__dna708PrepackedSceneReadiness as Record<string, unknown>)
      : null;
  const now = performance.now();
  const sameScene =
    previous?.runGeneration === runGeneration &&
    previous?.sceneKey === (descriptor?.sceneKey ?? null);
  const loaded = status === 'loaded-hit';
  const builtAfterMiss = loaded && cacheLifecycle?.origin === 'prepared-after-miss';
  const publishedStatus = builtAfterMiss ? 'loaded-built' : status;
  const ownerSnapshot = renderer?.getPrepackedAnnotationSceneOwnerSnapshot?.() ?? null;
  const ownerOracle = readActivePrepackedAnnotationSceneOwnerOracle();
  const oracleMatchesOwner =
    ownerOracle?.verdict === 'exactly-one' &&
    ownerOracle.owner?.ownerKey != null &&
    ownerOracle.owner.ownerKey === ownerSnapshot?.ownerKey;
  const sameOwner =
    sameScene &&
    previous?.ownerKey === (ownerSnapshot?.ownerKey ?? null) &&
    previous?.ownerGeneration === (ownerSnapshot?.ownerGeneration ?? null);
  const priorTimeline =
    sameScene && Array.isArray(previous?.statusTimeline)
      ? ([...previous.statusTimeline] as Array<{ status: string; at: number }>)
      : [];
  if (priorTimeline[priorTimeline.length - 1]?.status !== publishedStatus) {
    priorTimeline.push({ status: publishedStatus, at: now });
  }
  target.__dna708PrepackedSceneReadiness = buildPrepackedSceneReadinessSnapshot({
    runGeneration,
    publishedStatus,
    descriptor,
    error,
    cacheState,
    cacheLifecycle,
    payloadBytes,
    previous,
    now,
    sameScene,
    loaded,
    builtAfterMiss,
    ownerSnapshot,
    ownerOracle,
    oracleMatchesOwner,
    sameOwner,
    priorTimeline,
  });
}

function buildPrepackedSceneReadinessSnapshot(args: {
  runGeneration: string;
  publishedStatus: PrepackedAssemblyAnnotationSceneReadiness | 'loaded-built';
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor | null;
  error?: unknown;
  cacheState?: string;
  cacheLifecycle?: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt;
  payloadBytes?: number;
  previous: Record<string, unknown> | null;
  now: number;
  sameScene: boolean;
  loaded: boolean;
  builtAfterMiss: boolean;
  ownerSnapshot: ReturnType<
    NonNullable<PrepackedRenderer['getPrepackedAnnotationSceneOwnerSnapshot']>
  > | null;
  ownerOracle: ReturnType<typeof readActivePrepackedAnnotationSceneOwnerOracle>;
  oracleMatchesOwner: boolean;
  sameOwner: boolean;
  priorTimeline: Array<{ status: string; at: number }>;
}): Record<string, unknown> {
  const {
    descriptor,
    previous,
    ownerSnapshot,
    ownerOracle,
    oracleMatchesOwner,
    loaded,
    builtAfterMiss,
    sameScene,
    sameOwner,
    cacheLifecycle,
  } = args;
  return {
    runGeneration: args.runGeneration,
    status: args.publishedStatus,
    sceneKey: descriptor?.sceneKey ?? null,
    sourceIdentity: descriptor?.sourceIdentity ?? null,
    artifactKey: descriptor?.artifact.artifactKey ?? null,
    themeMode: descriptor?.artifact.themeMode ?? null,
    trackType: descriptor?.artifact.trackType ?? null,
    isoformMode:
      ownerSnapshot?.runtimePolicy?.isoformMode ??
      descriptor?.request.requestedPolicy.isoformMode ??
      null,
    laneLimit:
      ownerSnapshot?.runtimePolicy?.laneLimit ??
      descriptor?.request.requestedPolicy.laneLimit ??
      null,
    webglInstanceId: oracleMatchesOwner ? ownerOracle?.instanceId : null,
    webglInstanceCreatedAt: oracleMatchesOwner ? ownerOracle?.instanceCreatedAt : null,
    ownerKey: ownerSnapshot?.ownerKey ?? null,
    ownerGeneration: ownerSnapshot?.ownerGeneration ?? null,
    policyGeneration: ownerSnapshot?.policyGeneration ?? null,
    ownerLoaded: ownerSnapshot?.loaded ?? false,
    ownerStatus: ownerSnapshot?.status ?? null,
    ownerGpuPrepared: ownerSnapshot?.gpuPrepared ?? false,
    origin: loaded ? (builtAfterMiss ? 'built' : 'hit') : null,
    cacheState: cacheLifecycle?.initialProbe ?? args.cacheState ?? null,
    cacheOrigin: cacheLifecycle?.origin ?? null,
    cacheLifecycle: cacheLifecycle ?? (sameScene ? (previous?.cacheLifecycle ?? null) : null),
    payloadBytes:
      Number.isSafeInteger(args.payloadBytes) && Number(args.payloadBytes) > 0
        ? args.payloadBytes
        : sameScene && previous !== null && Number.isSafeInteger(previous.payloadBytes)
          ? previous.payloadBytes
          : null,
    startedAt: sameScene && typeof previous?.startedAt === 'number' ? previous.startedAt : args.now,
    loadedAt:
      loaded && sameOwner && typeof previous?.loadedAt === 'number'
        ? previous.loadedAt
        : loaded
          ? args.now
          : null,
    writeCompletedAt: builtAfterMiss ? (cacheLifecycle?.completedAt ?? null) : null,
    updatedAt: args.now,
    statusTimeline: args.priorTimeline,
    preparationTimeline:
      sameScene && Array.isArray(previous?.preparationTimeline) ? previous.preparationTimeline : [],
    error:
      args.error instanceof Error
        ? args.error.message
        : args.error == null
          ? null
          : String(args.error),
  };
}

function recordPreparationTrace(
  sceneKey: string,
  phase: string,
  detail?: Record<string, number | string>
): void {
  if (typeof window === 'undefined' || !shouldEnableTestBridge(import.meta.env)) return;
  const target = prepackedSceneWindow();
  const readiness = target.__dna708PrepackedSceneReadiness;
  if (!readiness || readiness.sceneKey !== sceneKey) return;
  const timeline = Array.isArray(readiness.preparationTimeline)
    ? [...readiness.preparationTimeline]
    : [];
  timeline.push({ phase, at: performance.now(), ...(detail ?? {}) });
  readiness.preparationTimeline = timeline;
}

export type ActivePrepackedAnnotationSceneOwnerOracle = {
  verdict?: unknown;
  instanceId?: unknown;
  instanceCreatedAt?: unknown;
  visibleLiveInstanceCount?: unknown;
  candidateInstanceIds?: unknown;
  owner?: {
    ownerKey?: unknown;
    ownerGeneration?: unknown;
    loaded?: unknown;
    status?: unknown;
    gpuPrepared?: unknown;
    metadata?: unknown;
  } | null;
};

export function readActivePrepackedAnnotationSceneOwnerOracle(): ActivePrepackedAnnotationSceneOwnerOracle | null {
  if (typeof window === 'undefined') return null;
  const value = prepackedSceneWindow().__webglPrepackedAnnotationSceneOwnerSnapshot;
  try {
    const snapshot = typeof value === 'function' ? value() : value;
    return snapshot && typeof snapshot === 'object'
      ? (snapshot as ActivePrepackedAnnotationSceneOwnerOracle)
      : null;
  } catch {
    return null;
  }
}

function clearPrepackedAssemblyAnnotationSceneReadiness(runGeneration: string): void {
  if (typeof window === 'undefined' || !shouldEnableTestBridge(import.meta.env)) return;
  const target = prepackedSceneWindow();
  if (target.__dna708PrepackedSceneReadiness?.runGeneration === runGeneration) {
    delete target.__dna708PrepackedSceneReadiness;
  }
}

export function publishPrepackedAssemblyAnnotationSceneReadinessForTest(
  status: PrepackedAssemblyAnnotationSceneReadiness,
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor,
  runGeneration: string,
  renderer?: PrepackedRenderer,
  cacheState?: string
): void {
  publishReadiness(runGeneration, status, descriptor, undefined, renderer, cacheState);
}

export function clearPrepackedAssemblyAnnotationSceneReadinessForTest(runGeneration: string): void {
  clearPrepackedAssemblyAnnotationSceneReadiness(runGeneration);
}
