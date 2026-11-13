import { preferCurrentThread } from '../thread-scheduling.cjs';
import { parentPort } from 'node:worker_threads';

import {
  runPortablePreparedReferenceSearchAdmissionWorkerJobV1,
  type PortablePreparedReferenceSearchAdmissionWorkerJobV1,
  type PortablePreparedReferenceSearchAdmissionWorkerResultV1,
} from './portable-prepared-reference-search-admission-worker-job';

preferCurrentThread('userInitiated');

type WorkerResponse =
  | Readonly<{ type: 'result'; result: PortablePreparedReferenceSearchAdmissionWorkerResultV1 }>
  | Readonly<{ type: 'error'; error: { name: string; message: string } }>;

if (!parentPort) {
  throw new Error('Portable search admission worker started without a parent port.');
}

parentPort.once('message', (job: PortablePreparedReferenceSearchAdmissionWorkerJobV1) => {
  void runPortablePreparedReferenceSearchAdmissionWorkerJobV1(job).then(
    (result) => post({ type: 'result', result }),
    (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      post({ type: 'error', error: { name: normalized.name, message: normalized.message } });
    }
  );
});

function post(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}
