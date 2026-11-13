import type { Worker } from 'node:worker_threads';

import type {
  PortablePreparedReferenceSearchAdmissionWorkerJobV1,
  PortablePreparedReferenceSearchAdmissionWorkerResultV1,
} from './portable-prepared-reference-search-admission-worker-job';

type WorkerResponse =
  | Readonly<{ type: 'result'; result: PortablePreparedReferenceSearchAdmissionWorkerResultV1 }>
  | Readonly<{ type: 'error'; error: { name: string; message: string } }>;

export function admitPortablePreparedReferenceSearchInDedicatedWorkerV1(
  job: PortablePreparedReferenceSearchAdmissionWorkerJobV1,
  createWorker?: () => Worker
): Promise<PortablePreparedReferenceSearchAdmissionWorkerResultV1> {
  return createPortableSearchAdmissionWorker(createWorker).then((worker) =>
    runPortableSearchAdmissionWorker(job, worker)
  );
}

async function createPortableSearchAdmissionWorker(createWorker?: () => Worker): Promise<Worker> {
  if (createWorker) return createWorker();
  const module =
    await import('./portable-prepared-reference-search-admission-worker-entry?nodeWorker');
  return module.default({});
}

function runPortableSearchAdmissionWorker(
  job: PortablePreparedReferenceSearchAdmissionWorkerJobV1,
  worker: Worker
): Promise<PortablePreparedReferenceSearchAdmissionWorkerResultV1> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    const finish = (
      outcome:
        | { kind: 'resolve'; value: PortablePreparedReferenceSearchAdmissionWorkerResultV1 }
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
      if (message?.type === 'result') {
        finish({ kind: 'resolve', value: message.result });
      } else if (message?.type === 'error') {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        finish({ kind: 'reject', error });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Portable search admission worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void => {
      finish({
        kind: 'reject',
        error: new Error(`Portable search admission worker exited early (code ${code}).`),
      });
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage(job);
  });
}
