import { realpath } from 'node:fs/promises';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyProteinSearchMissResult,
  AssemblyProteinSearchPrepareResult,
} from '../../shared/indexed-genome';
import type {
  AssemblyProteinSearchWorkerJob,
  AssemblyProteinSearchWorkerResult,
} from './assembly-protein-search-build';
import type { ProteinSearchCompilerWorkV1 } from './assembly-protein-search-compiler';
import { resolveAssemblyProteinSearchSourceRevisionV1 } from './assembly-protein-search-source';
import { SharedCancellableTaskRegistry } from './shared-cancellable-task-registry';

const DEFAULT_PROTEIN_SEARCH_PREPARE_TIMEOUT_MS = 300_000;
const inFlightBuilds = new SharedCancellableTaskRegistry<AssemblyProteinSearchWorkerResult>();

interface AssemblyProteinSearchOrchestratorDeps {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly realpathImpl?: (path: string) => Promise<string>;
  readonly compileInWorker?: (
    job: AssemblyProteinSearchWorkerJob,
    options?: { signal?: AbortSignal }
  ) => Promise<AssemblyProteinSearchWorkerResult>;
  readonly workerTimeoutMs?: number;
  readonly reportQuarantine?: (work: ProteinSearchCompilerWorkV1) => void;
}

async function compileWithDefaultWorker(
  job: AssemblyProteinSearchWorkerJob,
  options?: { signal?: AbortSignal }
): Promise<AssemblyProteinSearchWorkerResult> {
  const { compileAssemblyProteinSearchInDedicatedWorker } =
    await import('./assembly-expanded-annotation-scene-worker-factory');
  return compileAssemblyProteinSearchInDedicatedWorker(job, options);
}

export async function prepareAssemblyProteinSearchOnMiss(
  request: AssemblyAnnotationSceneReadRequest,
  miss: AssemblyProteinSearchMissResult,
  deps: AssemblyProteinSearchOrchestratorDeps,
  options: { readonly signal?: AbortSignal } = {}
): Promise<AssemblyProteinSearchPrepareResult> {
  throwIfAborted(options.signal);
  const key = JSON.stringify([
    request.workspaceRoot,
    request.assemblyId,
    request.datasetContract,
    request.scope,
    request.chromosomes,
    miss.fingerprint,
  ]);
  const settled = await inFlightBuilds.run(key, options.signal, (controller) =>
    startBuild(request, miss, deps, controller)
  );
  if (settled.status === 'committed') {
    return { status: 'ready', fingerprint: miss.fingerprint };
  }
  if (settled.status === 'stale') {
    return { status: 'unavailable', reason: 'stale' };
  }
  return { status: 'unavailable', reason: 'source-unavailable' };
}

function startBuild(
  request: AssemblyAnnotationSceneReadRequest,
  miss: AssemblyProteinSearchMissResult,
  deps: AssemblyProteinSearchOrchestratorDeps,
  controller: AbortController
): Promise<AssemblyProteinSearchWorkerResult> {
  const build = async (): Promise<AssemblyProteinSearchWorkerResult> => {
    throwIfAborted(controller.signal);
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(request, {
      assertSafePath: deps.assertSafePath,
    });
    throwIfAborted(controller.signal);
    if (!revision) {
      return unavailableWorkerResult();
    }
    if (revision.fingerprint !== miss.fingerprint) {
      return { ...unavailableWorkerResult(), status: 'stale' };
    }
    const resolveRealpath = deps.realpathImpl ?? realpath;
    const authorizedSourceRealPaths: Array<{ inputPath: string; realPath: string }> = [];
    for (const entry of revision.sourceContinuity) {
      throwIfAborted(controller.signal);
      await deps.assertSafePath(entry.sourcePath);
      authorizedSourceRealPaths.push({
        inputPath: entry.sourcePath,
        realPath: await resolveRealpath(entry.sourcePath),
      });
    }
    const compile = deps.compileInWorker ?? compileWithDefaultWorker;
    const abortBuild = (error: Error): void => {
      if (!controller.signal.aborted) controller.abort(error);
    };
    const timeoutMs = deps.workerTimeoutMs ?? DEFAULT_PROTEIN_SEARCH_PREPARE_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    timeout = setTimeout(() => {
      const error = new Error(`Protein search preparation exceeded ${timeoutMs} ms.`);
      error.name = 'TimeoutError';
      abortBuild(error);
    }, timeoutMs);
    try {
      let result: AssemblyProteinSearchWorkerResult;
      try {
        result = await compile(
          {
            request,
            expectedSourceFingerprint: miss.fingerprint,
            resolvedChromosomes: revision.chromosomes.map(({ chromosome, manifest }) => ({
              chrom: chromosome.chrom,
              manifest,
            })),
            authorizedSourceRealPaths,
          },
          { signal: controller.signal }
        );
        throwIfAborted(controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        throw error;
      }
      if (result.status === 'committed' && result.work.quarantinedIsoformCount > 0) {
        (deps.reportQuarantine ?? reportProteinSearchQuarantine)(result.work);
      }
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  return build();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Protein search preparation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function unavailableWorkerResult(): AssemblyProteinSearchWorkerResult {
  return {
    status: 'features-cache-miss',
    featureCount: 0,
    byteCount: 0,
    work: {
      transcriptCount: 0,
      sourceTranslationCount: 0,
      derivedTranslationCount: 0,
      skippedEmptyTranslationCount: 0,
      quarantinedIsoformCount: 0,
      quarantinedIsoforms: [],
      quarantineDiagnosticsTruncated: false,
    },
  };
}

function reportProteinSearchQuarantine(work: ProteinSearchCompilerWorkV1): void {
  // eslint-disable-next-line no-console
  console.warn('[assembly-protein-search] quarantined malformed CDS isoforms', work);
}
