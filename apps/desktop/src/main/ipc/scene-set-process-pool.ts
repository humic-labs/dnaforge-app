import { availableParallelism } from 'node:os';

import type {
  ExpandedAnnotationSceneWorkerJob,
  ExpandedAnnotationSceneWorkerSetJob,
  ExpandedAnnotationSceneWorkerSetResult,
} from './assembly-expanded-annotation-scene-compiler';
import type {
  ExpandedAnnotationSceneWorkerRequest,
  ExpandedAnnotationSceneWorkerResponse,
} from './assembly-expanded-annotation-scene-worker-client';
import type { DedicatedWorkerLikeV1 } from './process-worker';

export async function compileSceneSetOnProcessPoolV1(
  job: ExpandedAnnotationSceneWorkerSetJob,
  options: {
    readonly createProcess: () => DedicatedWorkerLikeV1;
    readonly processCount?: number;
    readonly signal?: AbortSignal;
  }
): Promise<ExpandedAnnotationSceneWorkerSetResult> {
  const count = Math.max(
    1,
    Math.min(options.processCount ?? defaultSceneSetProcessCount(), job.jobs.length)
  );
  const parseTrackTypes = job.jobs.map((entry) => entry.request.artifact.trackType);
  const queue = job.jobs
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => sceneTrackWeight(right.entry) - sceneTrackWeight(left.entry));
  const results: ExpandedAnnotationSceneWorkerSetResult['results'][number][] = [];
  const heaviest = count > 1 ? queue[0] : undefined;
  const processes = Array.from({ length: count }, () => options.createProcess());
  try {
    await Promise.all(
      processes.map(async (worker) => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          if (options.signal?.aborted) throw abortError();
          const slice = await runSetSlice(worker, {
            jobs: [next.entry],
            parseTrackTypes:
              next === heaviest ? [next.entry.request.artifact.trackType] : parseTrackTypes,
          });
          if (slice.results.length !== 1) {
            throw new Error('Scene-set slice returned an incomplete result inventory.');
          }
          results[next.index] = slice.results[0];
        }
      })
    );
  } finally {
    queue.length = 0;
    await Promise.all(processes.map((worker) => worker.terminate()));
  }
  return { results };
}

function defaultSceneSetProcessCount(): number {
  return Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2.5)));
}

const HEAVY_SCENE_TRACKS: readonly string[] = [
  'mRNA',
  'transcript',
  'lnc_RNA',
  'match',
  'biological_region',
  'cDNA_match',
];

function sceneTrackWeight(job: ExpandedAnnotationSceneWorkerJob): number {
  const rank = HEAVY_SCENE_TRACKS.indexOf(job.request.artifact.trackType);
  return rank < 0 ? 0 : HEAVY_SCENE_TRACKS.length - rank;
}

function runSetSlice(
  worker: DedicatedWorkerLikeV1,
  job: ExpandedAnnotationSceneWorkerSetJob
): Promise<ExpandedAnnotationSceneWorkerSetResult> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeListener('message', onMessage);
      worker.removeListener('exit', onExit);
      worker.removeListener('error', onError);
    };
    const onMessage = (message: ExpandedAnnotationSceneWorkerResponse) => {
      cleanup();
      if (message?.type === 'set-result') {
        resolve(message.result);
      } else if (message?.type === 'error') {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        reject(error);
      } else {
        reject(new Error('Scene-set job process sent an invalid response.'));
      }
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Scene-set job process exited before completion (code ${code}).`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    worker.on('message', onMessage);
    worker.on('exit', onExit);
    worker.on('error', onError);
    worker.postMessage({ type: 'compile-set', job } satisfies ExpandedAnnotationSceneWorkerRequest);
  });
}

function abortError(): Error {
  const error = new Error('Expanded annotation scene compilation was aborted.');
  error.name = 'AbortError';
  return error;
}
