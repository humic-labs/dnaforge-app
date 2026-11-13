import { preferCurrentThread } from '../thread-scheduling.cjs';
import { parentPort } from 'node:worker_threads';

import {
  runNativeExportDecoderWorkerJob,
  type NativeExportDecoderWorkerJob,
  type NativeExportDecoderWorkerResult,
} from './native-export-decoder-worker-job';
import type { NativeExportDecodeProgress } from './native-export-decoder';

preferCurrentThread('userInitiated');

export type NativeExportDecoderWorkerResponse =
  | Readonly<{ type: 'result'; result: NativeExportDecoderWorkerResult }>
  | Readonly<{ type: 'progress'; progress: NativeExportDecodeProgress }>
  | Readonly<{
      type: 'error';
      error: { name: string; message: string; code?: string; entryPath?: string };
    }>;

if (!parentPort) throw new Error('Native export decoder worker started without a parent port.');

parentPort.once('message', async (job: NativeExportDecoderWorkerJob) => {
  try {
    post({
      type: 'result',
      result: await runNativeExportDecoderWorkerJob(job, (progress) =>
        post({ type: 'progress', progress })
      ),
    });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const details = normalized as Error & { code?: unknown; entryPath?: unknown };
    post({
      type: 'error',
      error: {
        name: normalized.name,
        message: normalized.message,
        ...(typeof details.code === 'string' ? { code: details.code } : {}),
        ...(typeof details.entryPath === 'string' ? { entryPath: details.entryPath } : {}),
      },
    });
  }
});

function post(response: NativeExportDecoderWorkerResponse): void {
  parentPort?.postMessage(response);
}
