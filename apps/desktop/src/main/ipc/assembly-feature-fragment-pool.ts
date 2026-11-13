import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import type {
  ExpandedAnnotationSceneWorkerJob,
  FeatureCacheFragmentsV1,
} from './assembly-expanded-annotation-scene-compiler';

type FragmentResponse =
  | { result: FeatureCacheFragmentsV1 }
  | { error: { name: string; message: string } };

export async function buildFeatureCacheFragmentsInThreadsV1(
  entryPath: string,
  job: ExpandedAnnotationSceneWorkerJob,
  threadCount = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))
): Promise<FeatureCacheFragmentsV1> {
  const chromosomes = job.request.chromosomes;
  const groups = Array.from(
    { length: Math.max(1, Math.min(threadCount, chromosomes.length)) },
    () => ({ load: 0, indexes: [] as number[] })
  );
  const bySize = chromosomes
    .map((_, index) => index)
    .sort((left, right) => chromosomes[right].length - chromosomes[left].length);
  for (const index of bySize) {
    const lightest = groups.reduce((min, group) => (group.load < min.load ? group : min));
    lightest.indexes.push(index);
    lightest.load += chromosomes[index].length;
  }
  const results = await Promise.all(
    groups.map((group) =>
      runGroup(
        entryPath,
        job,
        group.indexes.sort((a, b) => a - b)
      )
    )
  );
  return mergeFeatureCacheFragmentsV1(job, results);
}

export function mergeFeatureCacheFragmentsV1(
  job: ExpandedAnnotationSceneWorkerJob,
  results: readonly FeatureCacheFragmentsV1[]
): FeatureCacheFragmentsV1 {
  const fragmentByChrom = new Map<string, string>();
  const trackTypes = new Set<string>();
  let featureCount = 0;
  for (const result of results) {
    if (result.status !== 'ready') return { status: 'miss' };
    for (const [chrom, fragment] of result.fragments) fragmentByChrom.set(chrom, fragment);
    for (const trackType of result.trackTypes) trackTypes.add(trackType);
    featureCount += result.featureCount;
  }
  const fragments = job.request.chromosomes.map((chromosome) => {
    const fragment = fragmentByChrom.get(chromosome.chrom);
    if (fragment === undefined) {
      throw new Error('Feature fragment workers returned an incomplete chromosome set.');
    }
    return [chromosome.chrom, fragment] as const;
  });
  return { status: 'ready', fragments, trackTypes: [...trackTypes], featureCount };
}

function runGroup(
  entryPath: string,
  job: ExpandedAnnotationSceneWorkerJob,
  indexes: readonly number[]
): Promise<FeatureCacheFragmentsV1> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(entryPath);
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      void worker.terminate().finally(outcome);
    };
    worker.once('message', (response: FragmentResponse) => {
      if ('error' in response) {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        finish(() => reject(error));
      } else {
        finish(() => resolve(response.result));
      }
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`Feature fragment worker exited early (code ${code}).`)))
    );
    worker.postMessage({ job, indexes });
  });
}
