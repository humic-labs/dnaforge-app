import { preferCurrentThread } from './thread-scheduling.cjs';
import { parentPort } from 'node:worker_threads';

import {
  runHostedNativeRegexWorkerJob,
  type HostedNativeRegexWorkerJob,
  type HostedNativeRegexWorkerResult,
} from './hosted-native-regex-worker-job';

preferCurrentThread('userInitiated');

export type HostedNativeRegexWorkerResponse =
  | Readonly<{ type: 'result'; result: HostedNativeRegexWorkerResult }>
  | Readonly<{ type: 'error'; error: { name: string; message: string } }>;

if (!parentPort) throw new Error('Hosted native regex worker started without a parent port.');

parentPort.once('message', (job: HostedNativeRegexWorkerJob) => {
  try {
    post({ type: 'result', result: runHostedNativeRegexWorkerJob(job) });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    post({ type: 'error', error: { name: normalized.name, message: normalized.message } });
  }
});

function post(response: HostedNativeRegexWorkerResponse): void {
  parentPort?.postMessage(response);
}
