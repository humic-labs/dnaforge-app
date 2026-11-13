import type { Worker } from 'node:worker_threads';

import type {
  AssemblyCompiledBroadRasterWorkerJobV1,
  AssemblyCompiledBroadRasterWorkerResultV1,
} from './assembly-compiled-broad-raster-worker-job';

export type AssemblyCompiledBroadRasterWorkerRequestV1 = Readonly<{
  type: 'prepare';
  job: AssemblyCompiledBroadRasterWorkerJobV1;
}>;

export type AssemblyCompiledBroadRasterWorkerResponseV1 =
  | Readonly<{ type: 'result'; result: AssemblyCompiledBroadRasterWorkerResultV1 }>
  | Readonly<{ type: 'error'; error: { name: string; message: string } }>;

interface AssemblyCompiledBroadRasterWorkerClientOptionsV1 {
  readonly createWorker: () => Worker;
  readonly signal?: AbortSignal;
}

function abortError(): Error {
  const error = new Error('Compiled broad raster preparation was aborted.');
  error.name = 'AbortError';
  return error;
}

function structuredWorkerError(error: { name: string; message: string }): Error {
  const reconstructed = new Error(error.message);
  reconstructed.name = error.name;
  return reconstructed;
}

export function runAssemblyCompiledBroadRasterWorkerV1(
  job: AssemblyCompiledBroadRasterWorkerJobV1,
  options: AssemblyCompiledBroadRasterWorkerClientOptionsV1
): Promise<AssemblyCompiledBroadRasterWorkerResultV1> {
  const worker = options.createWorker();
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (
      outcome:
        | { kind: 'resolve'; value: AssemblyCompiledBroadRasterWorkerResultV1 }
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
    const onMessage = (message: AssemblyCompiledBroadRasterWorkerResponseV1): void => {
      if (message?.type === 'result') {
        finish({ kind: 'resolve', value: message.result });
      } else if (message?.type === 'error') {
        finish({ kind: 'reject', error: structuredWorkerError(message.error) });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Compiled broad raster worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void => {
      finish({
        kind: 'reject',
        error: new Error(`Compiled broad raster worker exited before completion (code ${code}).`),
      });
    };
    const onAbort = (): void => finish({ kind: 'reject', error: abortError() });

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    const request: AssemblyCompiledBroadRasterWorkerRequestV1 = { type: 'prepare', job };
    worker.postMessage(request);
  });
}
