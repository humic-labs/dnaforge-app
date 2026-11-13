import { preferCurrentThread } from '../thread-scheduling.cjs';
import { parentPort } from 'node:worker_threads';

import {
  runLocalProjectionWorkerJob,
  type LocalProjectionWorkerJob,
  type LocalProjectionWorkerResult,
} from './local-projection-worker-job';

preferCurrentThread('userInitiated');

type WorkerResponse =
  | Readonly<{ type: 'result'; result: LocalProjectionWorkerResult }>
  | Readonly<{ type: 'error'; error: { name: string; message: string } }>;

if (!parentPort) throw new Error('Local projection worker started without a parent port.');

parentPort.once('message', (job: LocalProjectionWorkerJob) => {
  try {
    post({ type: 'result', result: runLocalProjectionWorkerJob(job) });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    post({ type: 'error', error: { name: normalized.name, message: normalized.message } });
  }
});

function post(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}
