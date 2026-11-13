import type { Worker } from 'node:worker_threads';

import type { NativeExportDecoderWorkerResponse } from './native-export-decoder-worker-entry';
import {
  NATIVE_EXPORT_DECODER_WORKER_JOB_SCHEMA,
  NATIVE_EXPORT_DECODER_WORKER_RESULT_SCHEMA,
  runNativeExportDecoderWorkerJob,
} from './native-export-decoder-worker-job';
import type {
  DecodedLocalNativeExportEvidence,
  DecodeLocalBenchlingNativeExportInput,
  NativeExportDecodeProgressListener,
} from './native-export-decoder';

export async function decodeLocalNativeExportInDedicatedWorker(
  input: DecodeLocalBenchlingNativeExportInput,
  createWorker?: () => Worker,
  onProgress?: NativeExportDecodeProgressListener
): Promise<DecodedLocalNativeExportEvidence> {
  const job = { schema: NATIVE_EXPORT_DECODER_WORKER_JOB_SCHEMA, input } as const;
  if (!createWorker && process.env.VITEST) {
    return (await runNativeExportDecoderWorkerJob(job, onProgress)).decoded;
  }
  const worker = createWorker ? createWorker() : await createPackagedWorker();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
    };
    const finish = (
      outcome:
        | { kind: 'resolve'; value: DecodedLocalNativeExportEvidence }
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
    const onMessage = (message: NativeExportDecoderWorkerResponse): void => {
      if (message?.type === 'progress') {
        const { completed, total } = message.progress ?? {};
        if (
          !Number.isSafeInteger(completed) ||
          !Number.isSafeInteger(total) ||
          completed < 0 ||
          total <= 0 ||
          completed > total
        ) {
          finish({
            kind: 'reject',
            error: new Error('Native export decoder worker sent invalid progress.'),
          });
          return;
        }
        onProgress?.({ completed, total });
        return;
      }
      if (
        message?.type === 'result' &&
        message.result?.schema === NATIVE_EXPORT_DECODER_WORKER_RESULT_SCHEMA &&
        Array.isArray(message.result.decoded?.sourceObjects) &&
        Array.isArray(message.result.decoded?.entries)
      ) {
        finish({ kind: 'resolve', value: message.result.decoded });
        return;
      }
      if (message?.type === 'error') {
        const error = new Error(message.error.message) as Error & {
          code?: string;
          entryPath?: string;
        };
        error.name = message.error.name;
        error.code = message.error.code;
        error.entryPath = message.error.entryPath;
        finish({ kind: 'reject', error });
        return;
      }
      finish({
        kind: 'reject',
        error: new Error('Native export decoder worker sent an invalid response.'),
      });
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void =>
      finish({
        kind: 'reject',
        error: new Error(`Native export decoder worker exited early (code ${code}).`),
      });
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage(job);
  });
}

async function createPackagedWorker(): Promise<Worker> {
  const module = await import('./native-export-decoder-worker-entry?nodeWorker');
  return module.default({});
}
