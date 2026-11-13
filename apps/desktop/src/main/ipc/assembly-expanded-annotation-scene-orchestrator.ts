import { realpath } from 'node:fs/promises';

import type {
  AssemblyAnnotationSceneCacheRevision,
  AssemblyAnnotationSceneMissResult,
  AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import { assemblyAnnotationSceneScopeMatchesChromosomes } from '../../shared/indexed-genome';
import type {
  ExpandedAnnotationSceneBroadCompanionReceiptV1,
  ExpandedAnnotationSceneWorkerJob,
  ExpandedAnnotationSceneInventoryWorkerResult,
  ExpandedAnnotationSceneWorkerResult,
  ExpandedAnnotationSceneWorkerSetJob,
  ExpandedAnnotationSceneWorkerSetResult,
} from './assembly-expanded-annotation-scene-compiler';
import { expandedAnnotationSceneAuthorizedInputPaths } from './assembly-expanded-annotation-scene-compiler';

const DEFAULT_ANNOTATION_SCENE_PREPARE_TIMEOUT_MS = 300_000;
const DEFAULT_ANNOTATION_SCENE_SET_PREPARE_TIMEOUT_MS = 1_800_000;
const inFlightExpandedSceneBuilds = new Map<string, Promise<ExpandedAnnotationSceneWorkerResult>>();

interface ExpandedAnnotationSceneOrchestratorDeps {
  assertSafePath: (path: string) => Promise<void>;
  runtimeSourceBuildFingerprint: string;
  realpathImpl?: typeof realpath;
  compileInWorker?: (
    job: ExpandedAnnotationSceneWorkerJob,
    options?: { signal?: AbortSignal }
  ) => Promise<ExpandedAnnotationSceneWorkerResult>;
  compileSetInWorker?: (
    job: ExpandedAnnotationSceneWorkerSetJob,
    options?: { signal?: AbortSignal }
  ) => Promise<ExpandedAnnotationSceneWorkerSetResult>;
  inventoryInWorker?: (
    job: ExpandedAnnotationSceneWorkerJob,
    options?: { signal?: AbortSignal }
  ) => Promise<ExpandedAnnotationSceneInventoryWorkerResult>;
  workerTimeoutMs?: number;
}

async function compileSetWithDefaultWorker(
  job: ExpandedAnnotationSceneWorkerSetJob,
  options?: { signal?: AbortSignal }
): Promise<ExpandedAnnotationSceneWorkerSetResult> {
  const { compileExpandedAnnotationSceneSetInDedicatedWorker } =
    await import('./assembly-expanded-annotation-scene-worker-factory');
  return compileExpandedAnnotationSceneSetInDedicatedWorker(job, options);
}

async function inventoryWithDefaultWorker(
  job: ExpandedAnnotationSceneWorkerJob,
  options?: { signal?: AbortSignal }
): Promise<ExpandedAnnotationSceneInventoryWorkerResult> {
  const { readExpandedAnnotationSceneTrackInventoryInDedicatedWorker } =
    await import('./assembly-expanded-annotation-scene-worker-factory');
  return readExpandedAnnotationSceneTrackInventoryInDedicatedWorker(job, options);
}

export type ExpandedAnnotationScenePreparationOutcome =
  | (AssemblyAnnotationSceneCacheRevision & {
      status: 'committed';
      broadCompanion?: ExpandedAnnotationSceneBroadCompanionReceiptV1;
    })
  | (AssemblyAnnotationSceneCacheRevision & { status: 'reprobe'; reason: 'stale' })
  | (AssemblyAnnotationSceneCacheRevision & {
      status: 'unavailable';
      reason: 'source-unavailable';
    });

export function isFullAssemblyAnnotationSceneRequest(
  request: AssemblyAnnotationSceneReadRequest
): boolean {
  if (
    !assemblyAnnotationSceneScopeMatchesChromosomes(request.scope, request.chromosomes) ||
    request.scope.kind !== 'complete-assembly' ||
    request.artifact.trackType.trim().length === 0 ||
    request.chromosomes.length === 0
  ) {
    return false;
  }
  const chromosomeNames = new Set<string>();
  let sourcedChromosomeCount = 0;
  for (let index = 0; index < request.chromosomes.length; index += 1) {
    const chromosome = request.chromosomes[index];
    if (
      !chromosome.chrom ||
      chromosomeNames.has(chromosome.chrom) ||
      !Number.isSafeInteger(chromosome.length) ||
      chromosome.length <= 0
    ) {
      return false;
    }
    chromosomeNames.add(chromosome.chrom);
    const coverage = request.scope.placements[index]?.annotationCoverage;
    if (coverage === 'unsourced') continue;
    if (coverage !== 'sourced' || chromosome.sourcePath == null || !chromosome.sourcePath.trim()) {
      return false;
    }
    sourcedChromosomeCount += 1;
  }
  return sourcedChromosomeCount > 0;
}

export const isFullGenomeExpandedAnnotationSceneRequest = isFullAssemblyAnnotationSceneRequest;

export async function readAssemblyAnnotationSceneTrackInventory(
  request: AssemblyAnnotationSceneReadRequest,
  revision: AssemblyAnnotationSceneCacheRevision,
  deps: ExpandedAnnotationSceneOrchestratorDeps
): Promise<ExpandedAnnotationSceneInventoryWorkerResult> {
  if (!isFullAssemblyAnnotationSceneRequest(request)) {
    return { status: 'features-cache-miss', trackTypes: [] };
  }
  const realpathImpl = deps.realpathImpl ?? realpath;
  const authorizedSourceRealPaths = await authorizeExpandedScenePaths(
    request,
    deps.assertSafePath,
    realpathImpl
  );
  const inventory = deps.inventoryInWorker ?? inventoryWithDefaultWorker;
  return inventory({
    request,
    authorizedMiss: {
      status: 'miss',
      ipcContractVersion: revision.ipcContractVersion,
      fingerprint: revision.fingerprint,
      sourceBuildFingerprint: revision.sourceBuildFingerprint,
    },
    runtimeSourceBuildFingerprint: deps.runtimeSourceBuildFingerprint,
    authorizedSourceRealPaths,
  });
}

function buildKey(
  request: AssemblyAnnotationSceneReadRequest,
  authorizedMiss: AssemblyAnnotationSceneMissResult
): string {
  return JSON.stringify({
    workspaceRoot: request.workspaceRoot,
    assemblyId: request.assemblyId,
    sourceFingerprint: authorizedMiss.fingerprint,
    compilerFingerprint: authorizedMiss.sourceBuildFingerprint,
    datasetContract: request.datasetContract,
    artifact: request.artifact,
    scope: request.scope,
  });
}

async function compileWithDefaultWorker(
  job: ExpandedAnnotationSceneWorkerJob,
  options?: { signal?: AbortSignal }
): Promise<ExpandedAnnotationSceneWorkerResult> {
  const { compileExpandedAnnotationSceneInDedicatedWorker } =
    await import('./assembly-expanded-annotation-scene-worker-factory');
  return compileExpandedAnnotationSceneInDedicatedWorker(job, options);
}

function getOrStartExpandedSceneBuild(
  request: AssemblyAnnotationSceneReadRequest,
  authorizedMiss: AssemblyAnnotationSceneMissResult,
  deps: ExpandedAnnotationSceneOrchestratorDeps
): Promise<ExpandedAnnotationSceneWorkerResult> {
  const key = buildKey(request, authorizedMiss);
  const existing = inFlightExpandedSceneBuilds.get(key);
  if (existing) return existing;

  const build = async (): Promise<ExpandedAnnotationSceneWorkerResult> => {
    const realpathImpl = deps.realpathImpl ?? realpath;
    const authorizedSourceRealPaths = await authorizeExpandedScenePaths(
      request,
      deps.assertSafePath,
      realpathImpl
    );
    const compileInWorker = deps.compileInWorker ?? compileWithDefaultWorker;
    const controller = new AbortController();
    const timeoutMs = deps.workerTimeoutMs ?? DEFAULT_ANNOTATION_SCENE_PREPARE_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`Annotation scene preparation exceeded ${timeoutMs} ms.`);
        error.name = 'TimeoutError';
        controller.abort();
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        compileInWorker(
          {
            request,
            authorizedMiss,
            runtimeSourceBuildFingerprint: deps.runtimeSourceBuildFingerprint,
            authorizedSourceRealPaths,
          },
          { signal: controller.signal }
        ),
        timedOut,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const promise = build().finally(() => {
    if (inFlightExpandedSceneBuilds.get(key) === promise) {
      inFlightExpandedSceneBuilds.delete(key);
    }
  });
  inFlightExpandedSceneBuilds.set(key, promise);
  return promise;
}

export async function prepareAssemblyAnnotationSceneOnMiss(
  request: AssemblyAnnotationSceneReadRequest,
  authorizedMiss: AssemblyAnnotationSceneMissResult,
  deps: ExpandedAnnotationSceneOrchestratorDeps
): Promise<ExpandedAnnotationScenePreparationOutcome> {
  const revision = {
    ipcContractVersion: authorizedMiss.ipcContractVersion,
    fingerprint: authorizedMiss.fingerprint,
    sourceBuildFingerprint: authorizedMiss.sourceBuildFingerprint,
  };
  if (!isFullAssemblyAnnotationSceneRequest(request)) {
    return { ...revision, status: 'unavailable', reason: 'source-unavailable' };
  }
  const result = await getOrStartExpandedSceneBuild(request, authorizedMiss, deps);
  if (result.status === 'committed') return { ...revision, status: 'committed' };
  if (result.status === 'stale') return { ...revision, status: 'reprobe', reason: 'stale' };
  return { ...revision, status: 'unavailable', reason: 'source-unavailable' };
}

export async function prepareAssemblyAnnotationSceneSetOnMiss(
  entries: readonly Readonly<{
    request: AssemblyAnnotationSceneReadRequest;
    miss: AssemblyAnnotationSceneMissResult;
  }>[],
  deps: ExpandedAnnotationSceneOrchestratorDeps
): Promise<readonly ExpandedAnnotationScenePreparationOutcome[]> {
  if (entries.length === 0) return [];
  for (const { request } of entries) {
    if (!isFullAssemblyAnnotationSceneRequest(request)) {
      throw new Error('Annotation scene product set contains an invalid assembly request.');
    }
  }
  const realpathImpl = deps.realpathImpl ?? realpath;
  const first = entries[0];
  const authorizedSourceRealPaths = await authorizeExpandedScenePaths(
    first.request,
    deps.assertSafePath,
    realpathImpl
  );
  const jobs: ExpandedAnnotationSceneWorkerJob[] = entries.map(({ request, miss }) => ({
    request,
    authorizedMiss: miss,
    runtimeSourceBuildFingerprint: deps.runtimeSourceBuildFingerprint,
    authorizedSourceRealPaths,
  }));
  const compileSet = deps.compileSetInWorker ?? compileSetWithDefaultWorker;
  const controller = new AbortController();
  const timeoutMs = deps.workerTimeoutMs ?? DEFAULT_ANNOTATION_SCENE_SET_PREPARE_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Annotation scene-set preparation exceeded ${timeoutMs} ms.`);
      error.name = 'TimeoutError';
      controller.abort();
      reject(error);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      compileSet({ jobs }, { signal: controller.signal }),
      timedOut,
    ]);
    if (result.results.length !== entries.length) {
      throw new Error('Annotation scene-set worker returned an incomplete result inventory.');
    }
    return result.results.map((workerResult, index) => {
      const miss = entries[index].miss;
      const revision = {
        ipcContractVersion: miss.ipcContractVersion,
        fingerprint: miss.fingerprint,
        sourceBuildFingerprint: miss.sourceBuildFingerprint,
      };
      if (workerResult.status === 'committed') {
        return {
          ...revision,
          status: 'committed' as const,
          ...(workerResult.broadCompanion ? { broadCompanion: workerResult.broadCompanion } : {}),
        };
      }
      if (workerResult.status === 'stale') {
        return { ...revision, status: 'reprobe' as const, reason: 'stale' as const };
      }
      return {
        ...revision,
        status: 'unavailable' as const,
        reason: 'source-unavailable' as const,
      };
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function authorizeExpandedScenePaths(
  request: AssemblyAnnotationSceneReadRequest,
  assertSafePath: (path: string) => Promise<void>,
  realpathImpl: (path: string) => Promise<string>
): Promise<ExpandedAnnotationSceneWorkerJob['authorizedSourceRealPaths']> {
  return Promise.all(
    expandedAnnotationSceneAuthorizedInputPaths(request).map(async (inputPath) => {
      await assertSafePath(inputPath);
      return { inputPath, realPath: await realpathImpl(inputPath) };
    })
  );
}

export async function compileFullGenomeExpandedAnnotationSceneOnMiss(
  request: AssemblyAnnotationSceneReadRequest,
  authorizedMiss: AssemblyAnnotationSceneMissResult,
  deps: ExpandedAnnotationSceneOrchestratorDeps
): Promise<ExpandedAnnotationScenePreparationOutcome> {
  try {
    return await prepareAssemblyAnnotationSceneOnMiss(request, authorizedMiss, deps);
  } catch (error) {
    console.error('[assembly-annotation-scene] scene compilation failed', {
      assemblyId: request.assemblyId,
      trackType: request.artifact.trackType,
      requestedIsoformMode: request.requestedPolicy.isoformMode,
      requestedLaneLimit: request.requestedPolicy.laneLimit,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return {
      ipcContractVersion: authorizedMiss.ipcContractVersion,
      fingerprint: authorizedMiss.fingerprint,
      sourceBuildFingerprint: authorizedMiss.sourceBuildFingerprint,
      status: 'unavailable',
      reason: 'source-unavailable',
    };
  }
}
