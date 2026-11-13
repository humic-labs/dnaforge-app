import { realpath } from 'node:fs/promises';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSearchMissResult,
  AssemblyAnnotationSearchPrepareResult,
} from '../../shared/indexed-genome';
import type {
  AssemblyAnnotationSearchWorkerProgress,
  AssemblyAnnotationSearchWorkerJob,
  AssemblyAnnotationSearchWorkerResult,
} from './assembly-annotation-search-compiler';
import {
  indexedAnnotationSearchManifest,
  indexedQuartetPaths,
} from './assembly-annotation-search-compiler';
import { isFullAssemblyAnnotationSceneRequest } from './assembly-expanded-annotation-scene-orchestrator';
import { SharedCancellableTaskRegistry } from './shared-cancellable-task-registry';

const DEFAULT_ANNOTATION_SEARCH_PREPARE_TIMEOUT_MS = 300_000;
const inFlightSearchBuilds =
  new SharedCancellableTaskRegistry<AssemblyAnnotationSearchWorkerResult>();

interface AssemblyAnnotationSearchOrchestratorDeps {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly realpathImpl?: (path: string) => Promise<string>;
  readonly compileInWorker?: (
    job: AssemblyAnnotationSearchWorkerJob,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: AssemblyAnnotationSearchWorkerProgress) => void;
    }
  ) => Promise<AssemblyAnnotationSearchWorkerResult>;
  readonly workerTimeoutMs?: number;
}

async function compileWithDefaultWorker(
  job: AssemblyAnnotationSearchWorkerJob,
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: AssemblyAnnotationSearchWorkerProgress) => void;
  }
): Promise<AssemblyAnnotationSearchWorkerResult> {
  const { compileAssemblyAnnotationSearchInDedicatedWorker } =
    await import('./assembly-expanded-annotation-scene-worker-factory');
  return compileAssemblyAnnotationSearchInDedicatedWorker(job, options);
}

function buildKey(
  request: AssemblyAnnotationSceneReadRequest,
  miss: AssemblyAnnotationSearchMissResult
): string {
  return JSON.stringify({
    workspaceRoot: request.workspaceRoot,
    assemblyId: request.assemblyId,
    chromosomes: request.chromosomes,
    scope: request.scope,
    datasetContract: request.datasetContract,
    fingerprint: miss.fingerprint,
  });
}

async function getOrStartSearchBuild(
  request: AssemblyAnnotationSceneReadRequest,
  miss: AssemblyAnnotationSearchMissResult,
  deps: AssemblyAnnotationSearchOrchestratorDeps,
  options: { readonly signal?: AbortSignal }
): Promise<AssemblyAnnotationSearchWorkerResult> {
  throwIfAborted(options.signal);
  const key = buildKey(request, miss);
  return inFlightSearchBuilds.run(key, options.signal, async (controller) => {
    throwIfAborted(controller.signal);
    const realpathImpl = deps.realpathImpl ?? realpath;
    const authorizedSourceRealPaths: Array<{ inputPath: string; realPath: string }> = [];
    const authorizedInputs = new Set<string>();
    const authorizeInputPath = async (inputPath: string): Promise<void> => {
      if (authorizedInputs.has(inputPath)) return;
      await deps.assertSafePath(inputPath);
      const realPath = await realpathImpl(inputPath);
      authorizedInputs.add(inputPath);
      authorizedSourceRealPaths.push({ inputPath, realPath });
    };
    for (const chromosome of request.chromosomes) {
      throwIfAborted(controller.signal);
      const sourcePath = chromosome.sourcePath?.trim();
      if (!sourcePath) continue;
      const manifest = indexedAnnotationSearchManifest(chromosome);
      if (!manifest) {
        throw new Error(
          `Annotation search explicit indexed quartet is unavailable for ${chromosome.chrom}.`
        );
      }
      for (const inputPath of indexedQuartetPaths(manifest)) {
        await authorizeInputPath(inputPath);
      }
    }

    const compile = deps.compileInWorker ?? compileWithDefaultWorker;
    const abortBuild = (error: Error): void => {
      if (!controller.signal.aborted) controller.abort(error);
    };
    const timeoutMs = deps.workerTimeoutMs ?? DEFAULT_ANNOTATION_SEARCH_PREPARE_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let lastProgressSequence = 0;
    const armWatchdog = (): void => {
      if (controller.signal.aborted) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        const error = new Error(
          `Annotation search preparation made no progress for ${timeoutMs} ms.`
        );
        error.name = 'TimeoutError';
        abortBuild(error);
      }, timeoutMs);
    };
    armWatchdog();
    try {
      try {
        const result = await compile(
          {
            request,
            expectedSourceFingerprint: miss.fingerprint,
            authorizedSourceRealPaths,
          },
          {
            signal: controller.signal,
            onProgress: (progress) => {
              if (
                Number.isSafeInteger(progress.sequence) &&
                progress.sequence > lastProgressSequence
              ) {
                lastProgressSequence = progress.sequence;
                armWatchdog();
              }
            },
          }
        );
        throwIfAborted(controller.signal);
        return result;
      } catch (error) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        throw error;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });
}

export async function prepareAssemblyAnnotationSearchOnMiss(
  request: AssemblyAnnotationSceneReadRequest,
  miss: AssemblyAnnotationSearchMissResult,
  deps: AssemblyAnnotationSearchOrchestratorDeps,
  options: { readonly signal?: AbortSignal } = {}
): Promise<AssemblyAnnotationSearchPrepareResult> {
  if (!isFullAssemblyAnnotationSceneRequest(request)) {
    return { status: 'unavailable', reason: 'source-unavailable' };
  }
  const result = await getOrStartSearchBuild(request, miss, deps, options);
  if (result.status === 'committed') {
    return { status: 'ready', fingerprint: miss.fingerprint };
  }
  if (result.status === 'stale') return { status: 'unavailable', reason: 'stale' };
  return { status: 'unavailable', reason: 'source-unavailable' };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Annotation search preparation was cancelled.');
  error.name = 'AbortError';
  return error;
}
