import type { Worker } from 'node:worker_threads';

import {
  portablePreparedReferenceSceneAdmissionWorkerContractV1,
  type PortablePreparedReferenceSceneAdmissionWorkerJobV1,
  type PortablePreparedReferenceSceneAdmissionWorkerResultV1,
} from './portable-prepared-reference-scene-admission-worker-job';

type WorkerResponse =
  | Readonly<{ type: 'result'; result: PortablePreparedReferenceSceneAdmissionWorkerResultV1 }>
  | Readonly<{ type: 'error'; error: { name: string; message: string } }>;

export function admitPortablePreparedReferenceSceneInDedicatedWorkerV1(
  job: PortablePreparedReferenceSceneAdmissionWorkerJobV1,
  createWorker?: () => Worker
): Promise<PortablePreparedReferenceSceneAdmissionWorkerResultV1> {
  return createPortableSceneAdmissionWorker(createWorker).then((worker) =>
    runPortableSceneAdmissionWorker(job, worker)
  );
}

async function createPortableSceneAdmissionWorker(createWorker?: () => Worker): Promise<Worker> {
  if (createWorker) return createWorker();
  const module =
    await import('./portable-prepared-reference-scene-admission-worker-entry?nodeWorker');
  return module.default({});
}

function runPortableSceneAdmissionWorker(
  job: PortablePreparedReferenceSceneAdmissionWorkerJobV1,
  worker: Worker
): Promise<PortablePreparedReferenceSceneAdmissionWorkerResultV1> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    const finish = (
      outcome:
        | { kind: 'resolve'; value: PortablePreparedReferenceSceneAdmissionWorkerResultV1 }
        | { kind: 'reject'; error: Error }
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outcome.kind === 'resolve') resolve(outcome.value);
      else reject(outcome.error);
      void worker.terminate().catch(() => undefined);
    };
    const onMessage = (message: WorkerResponse): void => {
      if (message?.type === 'result') {
        const result = message.result;
        const isRangeCatalog = 'projection' in result && result.projection === 'range-catalog';
        const baseIsValid =
          result?.contract === portablePreparedReferenceSceneAdmissionWorkerContractV1() &&
          (isRangeCatalog ||
            ('validatedPayload' in result &&
              result.validatedPayload instanceof Uint8Array &&
              result.validatedPayload.byteLength === result.byteCount));
        const projectionIsValid =
          job.projection === 'admit-persisted-compiled-broad-interaction'
            ? 'projection' in result &&
              result.projection === 'persisted-compiled-broad-interaction' &&
              result.byteCount === job.manifest.byteLength &&
              result.payloadSha256 === job.expectedPayloadSha256 &&
              result.manifest?.integrity?.payloadSha256 === job.expectedPayloadSha256 &&
              result.manifest?.sourceScene?.payloadSha256 ===
                job.manifest.sourceScene.payloadSha256 &&
              result.manifest?.sourceScene?.contractSha256 ===
                job.manifest.sourceScene.contractSha256
            : job.projection === 'range-catalog'
              ? isRangeCatalog &&
                result.sourceByteCount === job.manifest.byteLength &&
                result.sourcePayloadSha256 === job.expectedPayloadSha256 &&
                result.sourceContractSha256 === job.expectedProjectionContractSha256 &&
                result.rangeCatalog?.sourceScene?.byteLength === job.manifest.byteLength &&
                result.rangeCatalog.sourceScene.payloadSha256 === job.expectedPayloadSha256 &&
                result.rangeCatalog.sourceScene.contractSha256 ===
                  job.expectedProjectionContractSha256
              : job.projection === 'compiled-broad-interaction'
                ? 'projection' in result &&
                  result.projection === 'compiled-broad-interaction' &&
                  result.sourceByteCount === job.manifest.byteLength &&
                  result.sourcePayloadSha256 === job.expectedPayloadSha256 &&
                  result.manifest?.sourceScene?.byteLength === job.manifest.byteLength &&
                  result.manifest.sourceScene.payloadSha256 === job.expectedPayloadSha256 &&
                  result.manifest.sourceScene.contractSha256 ===
                    job.expectedProjectionContractSha256 &&
                  result.manifest.datasetContract?.datasetId ===
                    job.projectionDatasetContract?.datasetId &&
                  result.manifest.datasetContract?.datasetVersion ===
                    job.projectionDatasetContract?.datasetVersion &&
                  result.manifest.datasetContract?.sourceSha256 ===
                    job.projectionDatasetContract?.sourceSha256 &&
                  result.manifest.byteLength === result.byteCount &&
                  result.manifest.integrity?.payloadSha256 === result.payloadSha256
                : !('projection' in result) &&
                  result.byteCount === job.manifest.byteLength &&
                  result.payloadSha256 === job.expectedPayloadSha256;
        if (!baseIsValid || !projectionIsValid) {
          finish({
            kind: 'reject',
            error: new Error('Portable scene admission worker sent an invalid result.'),
          });
          return;
        }
        finish({ kind: 'resolve', value: result });
      } else if (message?.type === 'error') {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        finish({ kind: 'reject', error });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Portable scene admission worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void => {
      finish({
        kind: 'reject',
        error: new Error(`Portable scene admission worker exited early (code ${code}).`),
      });
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage(job);
  });
}
