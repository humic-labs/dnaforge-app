import type { Worker } from 'node:worker_threads';

import {
  LOCAL_PROJECTION_WORKER_RESULT_SCHEMA,
  runLocalProjectionWorkerJob,
  type LocalProjectionWorkerJob,
  type LocalProjectionWorkerResult,
} from './local-projection-worker-job';

type WorkerResponse =
  | Readonly<{ type: 'result'; result: LocalProjectionWorkerResult }>
  | Readonly<{ type: 'error'; error: { name: string; message: string } }>;

export async function buildLocalProjectionPlansInDedicatedWorker(
  job: LocalProjectionWorkerJob,
  createWorker?: () => Worker
): Promise<LocalProjectionWorkerResult> {
  const immutableJob = snapshotWorkerJob(job);
  if (!createWorker && process.env.VITEST) return runLocalProjectionWorkerJob(immutableJob);
  const worker = createWorker ? createWorker() : await createPackagedWorker();
  return runWorker(immutableJob, worker);
}

function snapshotWorkerJob(job: LocalProjectionWorkerJob): LocalProjectionWorkerJob {
  const snapshot = structuredClone(job);
  Object.freeze(snapshot.sourceObjects);
  Object.freeze(snapshot.resolutions);
  for (const allocation of snapshot.allocations) Object.freeze(allocation);
  Object.freeze(snapshot.allocations);
  return Object.freeze(snapshot);
}

async function createPackagedWorker(): Promise<Worker> {
  const module = await import('./local-projection-worker-entry?nodeWorker');
  return module.default({});
}

function runWorker(
  job: LocalProjectionWorkerJob,
  worker: Worker
): Promise<LocalProjectionWorkerResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    const finish = (
      outcome:
        | { kind: 'resolve'; value: LocalProjectionWorkerResult }
        | { kind: 'reject'; error: Error }
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker
        .terminate()
        .catch(() => undefined)
        .then(() => {
          if (outcome.kind === 'resolve') resolve(outcome.value);
          else reject(outcome.error);
        });
    };
    const onMessage = (message: WorkerResponse): void => {
      if (
        message?.type === 'result' &&
        message.result.schema === LOCAL_PROJECTION_WORKER_RESULT_SCHEMA
      ) {
        finish({ kind: 'resolve', value: message.result });
      } else if (message?.type === 'error') {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        finish({ kind: 'reject', error });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Local projection worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void =>
      finish({
        kind: 'reject',
        error: new Error(`Local projection worker exited early (code ${code}).`),
      });
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage(job);
  });
}
