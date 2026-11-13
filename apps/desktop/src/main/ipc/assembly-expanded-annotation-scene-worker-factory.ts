import createExpandedAnnotationSceneWorker from './assembly-expanded-annotation-scene-worker-entry?nodeWorker';
import sceneWorkerModulePath from './assembly-expanded-annotation-scene-worker-entry?modulePath';
import broadRasterShardEntryPath from './compiled-broad-raster-shard-worker-entry?modulePath';
import searchChromosomeEntryPath from './assembly-search-chromosome-process-entry?modulePath';
import featureFragmentEntryPath from './assembly-feature-fragment-worker-entry?modulePath';
import {
  BROAD_RASTER_SHARD_ENTRY_ENV,
  FEATURE_FRAGMENT_ENTRY_ENV,
  ProcessWorkerV1,
  SEARCH_CHROMOSOME_ENTRY_ENV,
} from './process-worker';

function createJobProcess(): ProcessWorkerV1 {
  return new ProcessWorkerV1(sceneWorkerModulePath, {
    [BROAD_RASTER_SHARD_ENTRY_ENV]: broadRasterShardEntryPath,
    [SEARCH_CHROMOSOME_ENTRY_ENV]: searchChromosomeEntryPath,
    [FEATURE_FRAGMENT_ENTRY_ENV]: featureFragmentEntryPath,
  });
}
import {
  runExpandedAnnotationSceneSetWorker,
  runExpandedAnnotationSceneInventoryWorker,
  runExpandedAnnotationSceneWorker,
  runAssemblyAnnotationSearchWorker,
  runAssemblyProteinSearchWorker,
  runAssemblySearchesWorker,
  type PairedSearchWorkerResultV1,
} from './assembly-expanded-annotation-scene-worker-client';
import type { SearchJobPairV1 } from './assembly-search-chromosome-pool';
import { compileSceneSetOnProcessPoolV1 } from './scene-set-process-pool';
import type {
  AssemblyAnnotationSearchWorkerProgress,
  AssemblyAnnotationSearchWorkerJob,
  AssemblyAnnotationSearchWorkerResult,
} from './assembly-annotation-search-compiler';
import type {
  AssemblyProteinSearchWorkerJob,
  AssemblyProteinSearchWorkerResult,
} from './assembly-protein-search-build';
import type {
  ExpandedAnnotationSceneWorkerJob,
  ExpandedAnnotationSceneInventoryWorkerResult,
  ExpandedAnnotationSceneWorkerResult,
  ExpandedAnnotationSceneWorkerSetJob,
  ExpandedAnnotationSceneWorkerSetResult,
} from './assembly-expanded-annotation-scene-compiler';

export function compileExpandedAnnotationSceneInDedicatedWorker(
  job: ExpandedAnnotationSceneWorkerJob,
  options?: { signal?: AbortSignal }
): Promise<ExpandedAnnotationSceneWorkerResult> {
  return runExpandedAnnotationSceneWorker(job, {
    createWorker: () => createExpandedAnnotationSceneWorker({}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export function compileExpandedAnnotationSceneSetInDedicatedWorker(
  job: ExpandedAnnotationSceneWorkerSetJob,
  options?: { signal?: AbortSignal }
): Promise<ExpandedAnnotationSceneWorkerSetResult> {
  if (job.jobs.length <= 1) {
    return runExpandedAnnotationSceneSetWorker(job, {
      createWorker: createJobProcess,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }
  return compileSceneSetOnProcessPoolV1(job, {
    createProcess: createJobProcess,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export function readExpandedAnnotationSceneTrackInventoryInDedicatedWorker(
  job: ExpandedAnnotationSceneWorkerJob,
  options?: { signal?: AbortSignal }
): Promise<ExpandedAnnotationSceneInventoryWorkerResult> {
  return runExpandedAnnotationSceneInventoryWorker(job, {
    createWorker: createJobProcess,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export function compileAssemblyAnnotationSearchInDedicatedWorker(
  job: AssemblyAnnotationSearchWorkerJob,
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: AssemblyAnnotationSearchWorkerProgress) => void;
  }
): Promise<AssemblyAnnotationSearchWorkerResult> {
  return runAssemblyAnnotationSearchWorker(job, {
    createWorker: createJobProcess,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.onProgress ? { onAnnotationSearchProgress: options.onProgress } : {}),
  });
}

export function compileAssemblyProteinSearchInDedicatedWorker(
  job: AssemblyProteinSearchWorkerJob,
  options?: { signal?: AbortSignal }
): Promise<AssemblyProteinSearchWorkerResult> {
  return runAssemblyProteinSearchWorker(job, {
    createWorker: createJobProcess,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export function compileAssemblySearchesInDedicatedWorker(
  job: SearchJobPairV1,
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: AssemblyAnnotationSearchWorkerProgress) => void;
  }
): Promise<PairedSearchWorkerResultV1> {
  return runAssemblySearchesWorker(job, {
    createWorker: createJobProcess,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.onProgress ? { onAnnotationSearchProgress: options.onProgress } : {}),
  });
}
