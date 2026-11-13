import { useEffect, useMemo, useState } from 'react';

import type { Genome } from '@waypoint/genome-renderer';
import type {
  AssemblyAnnotationSceneHitResult,
  AssemblyAnnotationSceneMissResult,
  AssemblyAnnotationScenePrepareResult,
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSceneReadResult,
  AssemblyAnnotationSceneSourceRequest,
  AssemblyReferenceAssetGenerationV1,
} from '../../../shared/indexed-genome';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
  assemblyAnnotationSceneScopeMatchesChromosomes,
} from '../../../shared/indexed-genome';
import { platform } from '../../../platform';
import {
  ASSEMBLY_ANNOTATION_DATASET_VERSION,
  deriveAssemblyPrepackedAnnotationSceneDescriptor,
  type AssemblyPrepackedAnnotationSceneDescriptor,
  type AssemblyPrepackedAnnotationScenePolicy,
} from '../assembly-annotation-product-descriptor';

export {
  ASSEMBLY_ANNOTATION_DATASET_VERSION,
  deriveAssemblyPrepackedAnnotationSceneDescriptor,
  type AssemblyPrepackedAnnotationSceneDescriptor,
  type AssemblyPrepackedAnnotationScenePolicy,
  type DeriveAssemblyPrepackedAnnotationSceneDescriptorInput,
} from '../assembly-annotation-product-descriptor';

export type AssemblyPrepackedAnnotationSceneCachePhase =
  | 'probing'
  | 'probe-result-received'
  | 'preparing'
  | 'prepare-result-received'
  | 'reprobing'
  | 'retry-wait'
  | 'complete'
  | 'error';

export type AssemblyPrepackedAnnotationSceneCacheOrigin =
  | 'pending'
  | 'durable-hit'
  | 'prepared-after-miss'
  | 'miss'
  | 'error';

export interface AssemblyPrepackedAnnotationSceneCacheLifecycleEvent {
  phase: AssemblyPrepackedAnnotationSceneCachePhase;
  at: number;
  probe?: 'initial' | 'reprobe';
  attempt?: number;
  outcome?:
    | AssemblyAnnotationSceneReadResult['status']
    | AssemblyAnnotationScenePrepareResult['status']
    | 'empty'
    | 'invalid-result'
    | 'exception';
  reason?: string;
  fingerprint?: string;
  sourceBuildFingerprint?: string;
}

export interface AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt {
  currentPhase: AssemblyPrepackedAnnotationSceneCachePhase;
  origin: AssemblyPrepackedAnnotationSceneCacheOrigin;
  initialProbe: 'pending' | 'hit' | 'miss' | 'empty';
  terminalResult: 'pending' | 'hit' | 'miss' | 'error';
  preparationAttempts: number;
  startedAt: number;
  preparationReadyObservedAt: number | null;
  completedAt: number | null;
  history: readonly AssemblyPrepackedAnnotationSceneCacheLifecycleEvent[];
}

export type AssemblyPrepackedAnnotationSceneCacheState =
  | { status: 'not-applicable'; descriptor: null; result: null; error: null }
  | {
      status: 'loading';
      descriptor: AssemblyPrepackedAnnotationSceneDescriptor;
      result: null;
      error: null;
      lifecycle: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt;
    }
  | {
      status: 'hit';
      descriptor: AssemblyPrepackedAnnotationSceneDescriptor;
      result: AssemblyAnnotationSceneHitResult;
      error: null;
      lifecycle: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt;
    }
  | {
      status: 'miss';
      descriptor: AssemblyPrepackedAnnotationSceneDescriptor;
      result: AssemblyAnnotationSceneMissResult;
      error: null;
      lifecycle: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt;
    }
  | {
      status: 'error';
      descriptor: AssemblyPrepackedAnnotationSceneDescriptor;
      result: null;
      error: unknown;
      lifecycle: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt;
    };

type AnnotationSourcePlacementProvenance = NonNullable<
  Genome['annotationSourcePlacementProvenance']
>;

export function activeAnnotationSourcePlacementProvenance(
  cache: AssemblyPrepackedAnnotationSceneCacheState
): AnnotationSourcePlacementProvenance | null {
  if (cache.status !== 'hit') return null;
  const sourceFingerprint = cache.result?.fingerprint;
  const placementFingerprint = cache.descriptor?.placementFingerprint;
  if (
    typeof sourceFingerprint !== 'string' ||
    !/^[0-9a-f]{24}$/.test(sourceFingerprint) ||
    typeof placementFingerprint !== 'string' ||
    !/^ap1:[0-9a-f]{24}$/.test(placementFingerprint)
  ) {
    return null;
  }
  return {
    contract: 'validated-annotation-source-placement.v1',
    sourceFingerprint,
    placementFingerprint,
  };
}

export const NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE: AssemblyPrepackedAnnotationSceneCacheState =
  {
    status: 'not-applicable',
    descriptor: null,
    result: null,
    error: null,
  };

export function assemblyPrepackedAnnotationSceneCacheOwnerKey(
  cache: AssemblyPrepackedAnnotationSceneCacheState
): string | null {
  if (cache.status !== 'hit') return null;
  return assemblyAnnotationSceneInteractionOwnerKeyV3({
    sourceFingerprint: cache.result.fingerprint,
    scenePayloadSha256: cache.result.manifest.integrity.payloadSha256,
    sceneArtifactKey: cache.result.artifact.artifactKey,
  });
}

export function assemblyReferenceAssetGenerationKey(
  generation: AssemblyReferenceAssetGenerationV1 | null | undefined
): string {
  return generation
    ? [
        generation.contract,
        generation.sourceFingerprint,
        generation.inventoryFingerprint,
        generation.themeMode,
      ].join('\u0000')
    : 'no-asset-generation';
}

interface AnnotationSceneReadTask {
  controller: AbortController;
  promise: Promise<AssemblyAnnotationSceneReadResult | null>;
  subscribers: Set<AbortSignal>;
  settled: boolean;
}

const readTasks = new Map<string, AnnotationSceneReadTask>();
const MAX_PREPARATION_ATTEMPTS = 3;
const PREPARATION_RETRY_DELAYS_MS = [0, 25] as const;

export function resetAssemblyPrepackedAnnotationSceneCacheTasksForTest(): void {
  for (const task of readTasks.values()) task.controller.abort();
  readTasks.clear();
}

function readOnce(
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor,
  signal: AbortSignal,
  assetGeneration: AssemblyReferenceAssetGenerationV1 | null,
  requiredInteractionOwnerKey: string | null
): Promise<AssemblyAnnotationSceneReadResult | null> {
  if (signal.aborted) return Promise.reject(annotationSceneReadAbortError());
  const taskKey = [
    descriptor.runtimeCacheKey,
    assemblyReferenceAssetGenerationKey(assetGeneration),
    requiredInteractionOwnerKey ?? 'no-required-interaction-owner',
  ].join('\n');
  let task = readTasks.get(taskKey);
  if (!task) {
    const controller = new AbortController();
    task = {
      controller,
      promise: platform().genome.readAssemblyAnnotationScene(descriptor.request, {
        signal: controller.signal,
        retainedAssetGeneration: assetGeneration,
        retainedInteractionOwnerKey: requiredInteractionOwnerKey,
      }),
      subscribers: new Set(),
      settled: false,
    };
    readTasks.set(taskKey, task);
  }
  const activeTask = task;
  const cleanup = () => {
    activeTask.settled = true;
    if (readTasks.get(taskKey) === activeTask) {
      readTasks.delete(taskKey);
    }
  };
  void activeTask.promise.then(cleanup, cleanup);
  return subscribeToAnnotationSceneRead(taskKey, activeTask, signal);
}

function subscribeToAnnotationSceneRead(
  runtimeCacheKey: string,
  task: AnnotationSceneReadTask,
  signal: AbortSignal
): Promise<AssemblyAnnotationSceneReadResult | null> {
  task.subscribers.add(signal);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (
      outcome:
        | { kind: 'resolve'; value: AssemblyAnnotationSceneReadResult | null }
        | { kind: 'reject'; error: unknown }
    ) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      task.subscribers.delete(signal);
      if (!task.settled && task.subscribers.size === 0 && readTasks.get(runtimeCacheKey) === task) {
        readTasks.delete(runtimeCacheKey);
        task.controller.abort();
      }
      if (outcome.kind === 'resolve') resolve(outcome.value);
      else reject(outcome.error);
    };
    const onAbort = () => finish({ kind: 'reject', error: annotationSceneReadAbortError() });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void task.promise.then(
      (value) => finish({ kind: 'resolve', value }),
      (error) => finish({ kind: 'reject', error })
    );
  });
}

function annotationSceneReadAbortError(): Error {
  const error = new Error('Annotation scene read was aborted.');
  error.name = 'AbortError';
  return error;
}

function annotationSceneRevisionKey(
  value: Pick<AssemblyAnnotationSceneMissResult, 'fingerprint' | 'sourceBuildFingerprint'>
): string {
  return `${value.fingerprint}\n${value.sourceBuildFingerprint}`;
}

async function waitForAnnotationSceneRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw annotationSceneReadAbortError();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(annotationSceneReadAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function prepareAnnotationSceneThroughValidatedProbeLoop(
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor,
  initialMiss: AssemblyAnnotationSceneMissResult,
  assetGeneration: AssemblyReferenceAssetGenerationV1 | null,
  requiredInteractionOwnerKey: string | null,
  signal: AbortSignal,
  observe: (event: Omit<AssemblyPrepackedAnnotationSceneCacheLifecycleEvent, 'at'>) => void
): Promise<AssemblyAnnotationSceneReadResult | null> {
  const genomePlatform = platform().genome as {
    prepareAssemblyAnnotationScene?: (
      request: AssemblyAnnotationSceneReadRequest
    ) => Promise<AssemblyAnnotationScenePrepareResult>;
  };
  const prepare = genomePlatform.prepareAssemblyAnnotationScene;
  if (typeof prepare !== 'function') return initialMiss;

  let current: AssemblyAnnotationSceneReadResult | null = initialMiss;
  let lastRevision = annotationSceneRevisionKey(initialMiss);
  for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt += 1) {
    if (!current || current.status !== 'miss') return current;
    if (signal.aborted) throw annotationSceneReadAbortError();

    observe({ phase: 'preparing', attempt: attempt + 1 });
    const preparation = await prepare.call(genomePlatform, descriptor.request);
    if (signal.aborted) throw annotationSceneReadAbortError();
    observe({
      phase: 'prepare-result-received',
      attempt: attempt + 1,
      outcome: preparation.status,
      reason: 'reason' in preparation ? preparation.reason : undefined,
      fingerprint: 'fingerprint' in preparation ? preparation.fingerprint : undefined,
      sourceBuildFingerprint:
        'sourceBuildFingerprint' in preparation ? preparation.sourceBuildFingerprint : undefined,
    });
    if (preparation.status === 'failed' && preparation.reason === 'invalid-request') {
      throw new Error(`annotation scene preparation ${preparation.reason}: ${preparation.message}`);
    }
    if (preparation.status === 'unavailable' && preparation.reason === 'source-unavailable') {
      return current;
    }

    observe({ phase: 'reprobing', probe: 'reprobe', attempt: attempt + 1 });
    current = await readOnce(descriptor, signal, assetGeneration, requiredInteractionOwnerKey);
    observe(annotationSceneProbeResultEvent(current, 'reprobe', attempt + 1));
    if (current?.status === 'hit') return current;
    if (!current || current.status !== 'miss') return current;

    const nextRevision = annotationSceneRevisionKey(current);
    const revisionChanged = nextRevision !== lastRevision;
    lastRevision = nextRevision;
    const retryableFailure =
      preparation.status === 'failed' &&
      (preparation.reason === 'timeout' || preparation.reason === 'compile-failed');
    const retryableStale = preparation.status === 'unavailable' && preparation.reason === 'stale';
    if (attempt + 1 < MAX_PREPARATION_ATTEMPTS) {
      if (revisionChanged || retryableFailure || retryableStale || preparation.status === 'ready') {
        observe({ phase: 'retry-wait', attempt: attempt + 1 });
        await waitForAnnotationSceneRetry(PREPARATION_RETRY_DELAYS_MS[attempt] ?? 0, signal);
        continue;
      }
    }
    break;
  }

  throw new Error(
    `annotation scene preparation exhausted ${MAX_PREPARATION_ATTEMPTS} validated attempts`
  );
}

export function useAssemblyPrepackedAnnotationSceneCache(input: {
  enabled?: boolean;
  interactionPayloadEnabled?: boolean;
  prepareProductOnly?: boolean;
  prepareOnMiss?: boolean;
  preparationGeneration?: number;
  requiredInteractionOwnerKey?: string | null;
  assetGeneration?: AssemblyReferenceAssetGenerationV1 | null;
  request: AssemblyAnnotationSceneSourceRequest | null | undefined;
  themeMode: 'light' | 'dark';
  policy: AssemblyPrepackedAnnotationScenePolicy;
}): AssemblyPrepackedAnnotationSceneCacheState {
  const [state, setState] = useState<{
    requestIdentity: string | null;
    value: AssemblyPrepackedAnnotationSceneCacheState;
  }>({
    requestIdentity: null,
    value: NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE,
  });
  const policy = useMemo<AssemblyPrepackedAnnotationScenePolicy>(
    () => ({
      trackType: input.policy.trackType.trim(),
      isoformMode: input.policy.isoformMode,
      laneLimit: input.policy.laneLimit,
    }),
    [input.policy.isoformMode, input.policy.laneLimit, input.policy.trackType]
  );
  const enabled = input.enabled ?? true;
  const interactionPayloadEnabled = input.interactionPayloadEnabled ?? true;
  const assetGenerationKey = assemblyReferenceAssetGenerationKey(input.assetGeneration);
  const stableAssetGeneration = useMemo<AssemblyReferenceAssetGenerationV1 | null>(
    () => (input.assetGeneration ? { ...input.assetGeneration } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assetGenerationKey]
  );
  const identity = useMemo(
    () =>
      enabled && input.request
        ? [
            input.request.assemblyId,
            input.request.workspaceRoot,
            input.request.scope.kind,
            input.request.datasetVersion ?? ASSEMBLY_ANNOTATION_DATASET_VERSION,
            input.request.expectedAssetGeneration
              ? assemblyReferenceAssetGenerationKey(input.request.expectedAssetGeneration)
              : 'no-expected-asset-generation',
            ...input.request.scope.placements.map(
              (placement, index) =>
                `${index}|${placement.chrom}|${placement.length}|${placement.annotationCoverage}`
            ),
            ...input.request.chromosomes.map(
              (chromosome, index) =>
                `${index}|${chromosome.chrom}|${chromosome.length}|${chromosome.sourcePath ?? ''}`
            ),
            input.themeMode,
            policy.trackType,
            input.prepareOnMiss ? 'prepare-on-miss' : 'probe-only',
            input.prepareProductOnly ? 'product-only' : 'interaction-capable',
            input.preparationGeneration ?? 0,
            input.requiredInteractionOwnerKey ?? 'no-required-interaction-owner',
            assetGenerationKey,
          ].join('\n')
        : null,
    [
      enabled,
      input.preparationGeneration,
      input.prepareOnMiss,
      input.prepareProductOnly,
      input.requiredInteractionOwnerKey,
      assetGenerationKey,
      input.request,
      input.themeMode,
      policy.trackType,
    ]
  );
  const stableRequest = useMemo<AssemblyAnnotationSceneSourceRequest | null>(
    () =>
      enabled && input.request
        ? {
            assemblyId: input.request.assemblyId,
            workspaceRoot: input.request.workspaceRoot,
            scope: {
              kind: input.request.scope.kind,
              placements: input.request.scope.placements.map((placement) => ({ ...placement })),
            },
            chromosomes: input.request.chromosomes.map((chromosome) => ({ ...chromosome })),
            ...(input.request.datasetVersion
              ? { datasetVersion: input.request.datasetVersion }
              : {}),
            ...(input.request.expectedAssetGeneration
              ? { expectedAssetGeneration: { ...input.request.expectedAssetGeneration } }
              : {}),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity]
  );

  useEffect(() => {
    if (!stableRequest || identity === null) {
      setState({
        requestIdentity: null,
        value: NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE,
      });
      return;
    }
    let cancelled = false;
    const readController = new AbortController();
    void (async () => {
      let lifecycle = beginAnnotationSceneCacheLifecycle();
      try {
        const descriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
          request: stableRequest,
          themeMode: input.themeMode,
          policy,
        });
        if (cancelled) return;
        setState({
          requestIdentity: identity,
          value: { status: 'loading', descriptor, result: null, error: null, lifecycle },
        });
        if (!interactionPayloadEnabled || input.prepareProductOnly) return;
        const observe = (
          event: Omit<AssemblyPrepackedAnnotationSceneCacheLifecycleEvent, 'at'>
        ) => {
          lifecycle = appendAnnotationSceneCacheLifecycleEvent(lifecycle, event);
          if (!cancelled) {
            setState({
              requestIdentity: identity,
              value: { status: 'loading', descriptor, result: null, error: null, lifecycle },
            });
          }
        };
        const requiredInteractionOwnerKey = input.requiredInteractionOwnerKey ?? null;
        let wireResult = await readOnce(
          descriptor,
          readController.signal,
          stableAssetGeneration,
          requiredInteractionOwnerKey
        );
        observe(annotationSceneProbeResultEvent(wireResult, 'initial'));
        if (wireResult?.status === 'miss' && input.prepareOnMiss) {
          wireResult = await prepareAnnotationSceneThroughValidatedProbeLoop(
            descriptor,
            wireResult,
            stableAssetGeneration,
            requiredInteractionOwnerKey,
            readController.signal,
            observe
          );
        }
        if (cancelled) return;
        const validationFailure = annotationSceneReadResultValidationFailure(
          wireResult,
          descriptor,
          input.requiredInteractionOwnerKey ?? null
        );
        const result = validationFailure === null ? wireResult : null;
        lifecycle = result
          ? completeAnnotationSceneCacheLifecycle(lifecycle, result.status)
          : failAnnotationSceneCacheLifecycle(lifecycle, 'invalid-result');
        setState(
          result
            ? {
                requestIdentity: identity,
                value:
                  result.status === 'hit'
                    ? { status: 'hit', descriptor, result, error: null, lifecycle }
                    : { status: 'miss', descriptor, result, error: null, lifecycle },
              }
            : {
                requestIdentity: identity,
                value: {
                  status: 'error',
                  descriptor,
                  result: null,
                  error: new Error(
                    `annotation scene probe failed validation: ${validationFailure ?? 'unknown'}`
                  ),
                  lifecycle,
                },
              }
        );
      } catch (error) {
        if (cancelled) return;
        const descriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
          request: stableRequest,
          themeMode: input.themeMode,
          policy,
        }).catch(() => null);
        if (!descriptor || cancelled) return;
        lifecycle = failAnnotationSceneCacheLifecycle(lifecycle, 'exception');
        setState({
          requestIdentity: identity,
          value: { status: 'error', descriptor, result: null, error, lifecycle },
        });
      }
    })();
    return () => {
      cancelled = true;
      readController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    identity,
    input.prepareOnMiss,
    input.prepareProductOnly,
    interactionPayloadEnabled,
    stableAssetGeneration,
    stableRequest,
    input.themeMode,
  ]);

  return state.requestIdentity === identity
    ? state.value
    : NOT_APPLICABLE_ASSEMBLY_PREPACKED_ANNOTATION_SCENE_CACHE;
}

function annotationSceneProbeResultEvent(
  result: AssemblyAnnotationSceneReadResult | null,
  probe: 'initial' | 'reprobe',
  attempt?: number
): Omit<AssemblyPrepackedAnnotationSceneCacheLifecycleEvent, 'at'> {
  return {
    phase: 'probe-result-received',
    probe,
    attempt,
    outcome: result?.status ?? 'empty',
    fingerprint: result?.fingerprint,
    sourceBuildFingerprint: result?.sourceBuildFingerprint,
  };
}

function beginAnnotationSceneCacheLifecycle(): AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt {
  const startedAt = performance.now();
  return {
    currentPhase: 'probing',
    origin: 'pending',
    initialProbe: 'pending',
    terminalResult: 'pending',
    preparationAttempts: 0,
    startedAt,
    preparationReadyObservedAt: null,
    completedAt: null,
    history: [{ phase: 'probing', probe: 'initial', at: startedAt }],
  };
}

function appendAnnotationSceneCacheLifecycleEvent(
  receipt: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt,
  event: Omit<AssemblyPrepackedAnnotationSceneCacheLifecycleEvent, 'at'>
): AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt {
  const at = performance.now();
  const initialProbe =
    event.phase === 'probe-result-received' && event.probe === 'initial'
      ? event.outcome === 'hit' || event.outcome === 'miss'
        ? event.outcome
        : 'empty'
      : receipt.initialProbe;
  return {
    ...receipt,
    currentPhase: event.phase,
    initialProbe,
    preparationAttempts:
      event.phase === 'preparing' && event.attempt != null
        ? Math.max(receipt.preparationAttempts, event.attempt)
        : receipt.preparationAttempts,
    preparationReadyObservedAt:
      event.phase === 'prepare-result-received' && event.outcome === 'ready'
        ? at
        : receipt.preparationReadyObservedAt,
    history: [...receipt.history, { ...event, at }],
  };
}

function completeAnnotationSceneCacheLifecycle(
  receipt: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt,
  terminalResult: 'hit' | 'miss'
): AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt {
  const at = performance.now();
  const origin: AssemblyPrepackedAnnotationSceneCacheOrigin =
    terminalResult === 'miss'
      ? 'miss'
      : receipt.initialProbe === 'miss' && receipt.preparationAttempts > 0
        ? 'prepared-after-miss'
        : 'durable-hit';
  return {
    ...receipt,
    currentPhase: 'complete',
    origin,
    terminalResult,
    completedAt: at,
    history: [...receipt.history, { phase: 'complete', at, outcome: terminalResult }],
  };
}

function failAnnotationSceneCacheLifecycle(
  receipt: AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt,
  outcome: 'invalid-result' | 'exception'
): AssemblyPrepackedAnnotationSceneCacheLifecycleReceipt {
  const at = performance.now();
  return {
    ...receipt,
    currentPhase: 'error',
    origin: 'error',
    terminalResult: 'error',
    completedAt: at,
    history: [...receipt.history, { phase: 'error', at, outcome }],
  };
}

function annotationSceneReadResultValidationFailure(
  value: AssemblyAnnotationSceneReadResult | null,
  descriptor: AssemblyPrepackedAnnotationSceneDescriptor,
  requiredInteractionOwnerKey: string | null
): string | null {
  if (!value) return 'empty-result';
  if (value.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT) {
    return 'ipc-contract';
  }
  if (!/^[0-9a-f]{24}$/.test(value.fingerprint)) return 'source-fingerprint';
  if (
    typeof value.sourceBuildFingerprint !== 'string' ||
    value.sourceBuildFingerprint.trim().length === 0
  ) {
    return 'source-build-fingerprint';
  }
  if (value.status === 'miss') return null;
  if (value.status !== 'hit') return 'status';
  if (value.artifact.artifactKey !== descriptor.artifact.artifactKey) return 'artifact-key';
  if (
    !assemblyAnnotationSceneScopeMatchesChromosomes(value.scope, descriptor.request.chromosomes)
  ) {
    return 'scope-chromosomes';
  }
  if (value.scope.kind !== descriptor.request.scope.kind) return 'scope-kind';
  if (
    value.scope.placements.some((placement, index) => {
      const expected = descriptor.request.scope.placements[index];
      return (
        placement.chrom !== expected?.chrom ||
        placement.length !== expected?.length ||
        placement.annotationCoverage !== expected?.annotationCoverage
      );
    })
  ) {
    return 'scope-placement';
  }
  if (!Number.isSafeInteger(value.byteCount) || value.byteCount < 0) return 'byte-count';
  if (!(value.payload instanceof Uint8Array)) return 'payload-type';
  if (value.payload.byteLength !== value.byteCount) return 'payload-length';
  if (value.manifest == null || typeof value.manifest !== 'object') return 'manifest';
  if (
    requiredInteractionOwnerKey !== null &&
    assemblyAnnotationSceneInteractionOwnerKeyV3({
      sourceFingerprint: value.fingerprint,
      scenePayloadSha256: value.manifest.integrity.payloadSha256,
      sceneArtifactKey: value.artifact.artifactKey,
    }) !== requiredInteractionOwnerKey
  ) {
    return 'interaction-owner';
  }
  return null;
}

export function shouldDeferGenomeWideFeaturesForPrepackedScene(
  sceneLookupApplicable: boolean,
  sceneStatus: AssemblyPrepackedAnnotationSceneCacheState['status'],
  exactPreparedOwnerRetained = false
): boolean {
  return (
    sceneLookupApplicable &&
    sceneStatus !== 'error' &&
    (sceneStatus !== 'miss' || exactPreparedOwnerRetained)
  );
}
