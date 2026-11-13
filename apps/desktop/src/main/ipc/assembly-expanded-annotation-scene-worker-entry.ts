import { preferCurrentThread } from '../thread-scheduling.cjs';
import { realpath } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { parentPort } from 'node:worker_threads';

import {
  BROAD_RASTER_SHARD_ENTRY_ENV,
  FEATURE_FRAGMENT_ENTRY_ENV,
  SEARCH_CHROMOSOME_ENTRY_ENV,
} from './process-worker';
import { buildFeatureCacheFragmentsInThreadsV1 } from './assembly-feature-fragment-pool';
import { createBroadRasterShardPoolV1 } from './compiled-broad-raster-shard-pool';
import {
  compileSearchChromosomesInWorkersV1,
  type PairedSearchChromosomeResultV1,
  type SearchJobPairV1,
} from './assembly-search-chromosome-pool';
import { encodeBroadRasterCellsInShardsV1 } from './compiled-broad-raster-shards';
import {
  compileAndCommitExpandedAnnotationSceneWorkerJob,
  compileAndPublishBroadRasterArtifactForPackedScene,
  compileAndCommitExpandedAnnotationSceneWorkerSetJob,
  createAuthorizedExpandedAnnotationSourcePathGuard,
  readExpandedAnnotationSceneTrackInventoryWorkerJob,
} from './assembly-expanded-annotation-scene-compiler';
import { compileAndCommitAssemblyAnnotationSearchWorkerJob } from './assembly-annotation-search-compiler';
import { compileAndCommitAssemblyProteinSearchWorkerJob } from './assembly-protein-search-build';
import type {
  ExpandedAnnotationSceneWorkerRequest,
  ExpandedAnnotationSceneWorkerResponse,
} from './assembly-expanded-annotation-scene-worker-client';
import {
  writeAssemblyOverviewFeaturesCache,
  writeAssemblyOverviewFeaturesCacheFromFragmentsV1,
} from './assembly-overview-features-cache';
import { referencePreparationTiming } from '../reference-assets/reference-prep-timing';

preferCurrentThread('userInitiated');

const port = parentPort
  ? {
      once: (listener: (request: ExpandedAnnotationSceneWorkerRequest) => void) =>
        parentPort?.once('message', listener),
      postMessage: (response: ExpandedAnnotationSceneWorkerResponse) =>
        parentPort?.postMessage(response),
    }
  : process.send
    ? {
        once: (listener: (request: ExpandedAnnotationSceneWorkerRequest) => void) =>
          process.on('message', listener),
        postMessage: (response: ExpandedAnnotationSceneWorkerResponse) => process.send?.(response),
      }
    : null;
if (!port) {
  throw new Error('Expanded annotation scene worker started without a parent port.');
}

port.once((request) => {
  void handleRequest(request);
});

const searchChromosomeEntry = process.env[SEARCH_CHROMOSOME_ENTRY_ENV];
let sharedRasterShardPool: ReturnType<typeof createBroadRasterShardPoolV1> | null = null;
function rasterShardPool(): ReturnType<typeof createBroadRasterShardPoolV1> | Promise<null> {
  const shardEntry = process.env[BROAD_RASTER_SHARD_ENTRY_ENV];
  if (!shardEntry) return Promise.resolve(null);
  sharedRasterShardPool ??= createBroadRasterShardPoolV1(shardEntry);
  return sharedRasterShardPool;
}
const parsedFeatures = parentPort ? undefined : new Map();

async function handleRequest(request: ExpandedAnnotationSceneWorkerRequest): Promise<void> {
  try {
    if (
      request?.type !== 'compile' &&
      request?.type !== 'compile-set' &&
      request?.type !== 'inventory' &&
      request?.type !== 'compile-search' &&
      request?.type !== 'compile-protein-search' &&
      request?.type !== 'compile-searches'
    ) {
      throw new Error('Expanded annotation scene worker received an invalid request.');
    }
    if (request.type === 'compile-set') {
      const first = request.job.jobs[0];
      if (!first) throw new Error('Expanded annotation scene worker received an empty set.');
      const assertSafePath = createAuthorizedExpandedAnnotationSourcePathGuard(
        first.authorizedSourceRealPaths,
        realpath
      );
      const pool = await rasterShardPool();
      const result = await compileAndCommitExpandedAnnotationSceneWorkerSetJob(request.job, {
        assertSafePath,
        writeFeaturesCache: writeAssemblyOverviewFeaturesCache,
        ...(parsedFeatures ? { parsedFeatures } : {}),
        ...(pool
          ? {
              compileBroadCompanion: (input) =>
                compileAndPublishBroadRasterArtifactForPackedScene(input, {
                  encodeBroadRasterCells: (cells) =>
                    encodeBroadRasterCellsInShardsV1(
                      { ...cells, shardCount: pool.shardCount },
                      pool.runShard
                    ),
                }),
            }
          : {}),
      });
      post({ type: 'set-result', result });
    } else if (request.type === 'inventory') {
      const assertSafePath = createAuthorizedExpandedAnnotationSourcePathGuard(
        request.job.authorizedSourceRealPaths,
        realpath
      );
      const fragmentEntry = process.env[FEATURE_FRAGMENT_ENTRY_ENV];
      const result = await readExpandedAnnotationSceneTrackInventoryWorkerJob(request.job, {
        assertSafePath,
        writeFeaturesCache: writeAssemblyOverviewFeaturesCache,
        ...(fragmentEntry
          ? {
              buildFeatureCacheFragments: (job) =>
                buildFeatureCacheFragmentsInThreadsV1(fragmentEntry, job),
              writeFeaturesCacheFragments: writeAssemblyOverviewFeaturesCacheFromFragmentsV1,
            }
          : {}),
      });
      post({ type: 'inventory-result', result });
    } else if (request.type === 'compile-search') {
      const assertSafePath = createAuthorizedExpandedAnnotationSourcePathGuard(
        request.job.authorizedSourceRealPaths,
        realpath
      );
      const result = await compileAndCommitAssemblyAnnotationSearchWorkerJob(request.job, {
        assertSafePath,
        ...(searchChromosomeEntry
          ? {
              compileChromosomes: (job, indexes, onChromosome) =>
                compileSearchChromosomesInWorkersV1(
                  searchChromosomeEntry,
                  'annotation',
                  job,
                  indexes,
                  onChromosome
                ),
            }
          : {}),
        onProgress: (progress) => post({ type: 'search-progress', progress }),
      });
      post({ type: 'search-result', result });
    } else if (request.type === 'compile-searches') {
      const { annotation, protein } = request.job;
      const timing = referencePreparationTiming('search-job');
      let annotationPhase = '';
      const paired = searchChromosomeEntry
        ? pairedSearchChromosomes(searchChromosomeEntry, request.job, () => timing('chromosomes'))
        : null;
      const [annotationResult, proteinResult] = await Promise.all([
        settleJob(() =>
          compileAndCommitAssemblyAnnotationSearchWorkerJob(annotation, {
            assertSafePath: createAuthorizedExpandedAnnotationSourcePathGuard(
              annotation.authorizedSourceRealPaths,
              realpath
            ),
            ...(paired
              ? {
                  compileChromosomes: (_job, indexes, onChromosome) =>
                    paired.select('annotation', indexes, onChromosome) as never,
                }
              : {}),
            onProgress: (progress) => {
              if (progress.phase !== annotationPhase) {
                annotationPhase = progress.phase;
                timing(`annotation ${progress.phase}`);
              }
              post({ type: 'search-progress', progress });
            },
          }).finally(() => timing('annotation committed'))
        ),
        settleJob(() =>
          compileAndCommitAssemblyProteinSearchWorkerJob(protein, {
            assertSafePath: createAuthorizedExpandedAnnotationSourcePathGuard(
              protein.authorizedSourceRealPaths,
              realpath
            ),
            ...(paired
              ? {
                  compileChromosomes: (_job, indexes) => paired.select('protein', indexes) as never,
                }
              : {}),
          }).finally(() => timing('protein committed'))
        ),
      ]);
      post({
        type: 'searches-result',
        result: { annotation: annotationResult, protein: proteinResult },
      });
    } else if (request.type === 'compile-protein-search') {
      const assertSafePath = createAuthorizedExpandedAnnotationSourcePathGuard(
        request.job.authorizedSourceRealPaths,
        realpath
      );
      const result = await compileAndCommitAssemblyProteinSearchWorkerJob(request.job, {
        assertSafePath,
        ...(searchChromosomeEntry
          ? {
              compileChromosomes: (job, indexes) =>
                compileSearchChromosomesInWorkersV1(searchChromosomeEntry, 'protein', job, indexes),
            }
          : {}),
      });
      post({ type: 'protein-search-result', result });
    } else {
      const assertSafePath = createAuthorizedExpandedAnnotationSourcePathGuard(
        request.job.authorizedSourceRealPaths,
        realpath
      );
      const result = await compileAndCommitExpandedAnnotationSceneWorkerJob(request.job, {
        assertSafePath,
        writeFeaturesCache: writeAssemblyOverviewFeaturesCache,
      });
      post({ type: 'result', result });
    }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    post({
      type: 'error',
      error: { name: normalized.name, message: normalized.message },
    });
  }
}

function pairedSearchChromosomes(entry: string, pair: SearchJobPairV1, onComplete: () => void) {
  let run: { indexes: string; results: Promise<PairedSearchChromosomeResultV1[]> } | null = null;
  const listeners = new Set<(index: number) => void>();
  return {
    async select(
      side: 'annotation' | 'protein',
      indexes: readonly number[],
      onChromosome?: (index: number) => void
    ): Promise<unknown[]> {
      if (onChromosome) listeners.add(onChromosome);
      const key = indexes.join(',');
      run ??= {
        indexes: key,
        results: compileSearchChromosomesInWorkersV1<PairedSearchChromosomeResultV1>(
          entry,
          'both',
          pair,
          indexes,
          (index) => {
            for (const listener of listeners) listener(index);
          },
          Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))
        ).finally(onComplete),
      };
      if (run.indexes !== key) {
        throw new Error('Paired search builds requested different chromosome sets.');
      }
      return (await run.results).map((chromosome) => {
        const outcome = chromosome[side];
        if ('error' in outcome) throw workerError(outcome.error);
        return outcome.value;
      });
    },
  };
}

async function settleJob<T>(
  run: () => Promise<T>
): Promise<{ value: T } | { error: { name: string; message: string } }> {
  try {
    return { value: await run() };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return { error: { name: normalized.name, message: normalized.message } };
  }
}

function workerError(error: { name: string; message: string }): Error {
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

function post(response: ExpandedAnnotationSceneWorkerResponse): void {
  port?.postMessage(response);
}
