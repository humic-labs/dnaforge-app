import type { Worker } from 'node:worker_threads';
import { defineBlob } from '@waypoint/workspace-revisions';
import { parseScientificCloudHistory } from '@waypoint/scientific-objects';
import type {
  ScientificHistoryWorkerJob,
  ScientificHistoryWorkerResponse,
  ScientificHistoryWorkerResult,
} from './scientific-history-worker-job';

const MAX_SCIENTIFIC_HISTORY_WORKER_MS = 120_000;
interface ScientificHistoryWorkerOptions {
  readonly signal?: AbortSignal;

  readonly beforeCommit?: () => Promise<void>;
  readonly loadWorker?: () => Promise<Worker>;

  readonly timeoutMs?: number;
}

async function createPackagedWorker(): Promise<Worker> {
  const module = await import('./scientific-history-worker-entry?nodeWorker');
  return module.default({});
}

export async function runScientificHistoryInDedicatedWorker(
  job: ScientificHistoryWorkerJob,
  options: ScientificHistoryWorkerOptions = {}
): Promise<ScientificHistoryWorkerResult> {
  if (job.kind === 'install' && !options.beforeCommit)
    throw new Error('Scientific history installation requires a live native authorization check.');
  if (options.signal?.aborted) throw stoppedError();
  const worker = await (options.loadWorker ?? createPackagedWorker)();
  return new Promise((resolve, reject) => {
    let settled = false,
      prepared = false;
    const timer = setTimeout(
      () =>
        void finish(new Error('Scientific history validation exceeded its execution deadline.')),
      Math.max(
        1,
        Math.min(
          options.timeoutMs ?? MAX_SCIENTIFIC_HISTORY_WORKER_MS,
          MAX_SCIENTIFIC_HISTORY_WORKER_MS
        )
      )
    );
    timer.unref?.();
    async function finish(outcome: Error | ScientificHistoryWorkerResult): Promise<void> {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      await worker.terminate().catch(() => undefined);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    }
    async function onMessage(message: ScientificHistoryWorkerResponse): Promise<void> {
      try {
        if (message?.type === 'prepared') {
          if (job.kind !== 'install' || prepared || typeof message.challenge !== 'string')
            throw new Error('Scientific history worker sent an invalid preparation.');
          prepared = true;
          await options.beforeCommit!();
          if (!settled && !options.signal?.aborted)
            worker.postMessage({ type: 'commit', challenge: message.challenge });
          return;
        }
        if (message?.type === 'error') {
          const error = new Error(message.error.message);
          error.name = message.error.name;
          await finish(error);
          return;
        }
        if (message?.type !== 'result' || !message.result)
          throw new Error('Scientific history worker sent an invalid result.');
        const result = message.result;
        if (job.kind === 'export') {
          if (
            result.kind !== 'exported' ||
            !(result.archive instanceof Uint8Array) ||
            !Array.isArray(result.blobs)
          )
            throw new Error('Scientific history export worker returned another job.');
          const descriptor = parseScientificCloudHistory(result.descriptor);
          const blob = defineBlob(result.archive);
          if (
            blob.hash !== descriptor.archive.hash ||
            blob.byteLength !== descriptor.archive.byteLength
          )
            throw new Error('Scientific history worker archive differs from its descriptor.');
        } else if (!prepared || result.kind !== 'installed')
          throw new Error('Scientific history installation was not admitted by its native owner.');
        await finish(result);
      } catch (error) {
        await finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const onError = (error: Error) => void finish(error);
    const onExit = (code: number) =>
      void finish(new Error(`Scientific history worker exited before acknowledgement (${code}).`));
    const onAbort = () => void finish(stoppedError());
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    try {
      worker.postMessage(job);
    } catch (error) {
      void finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
function stoppedError(): Error {
  const error = new Error('Scientific history transfer was stopped.');
  error.name = 'AbortError';
  return error;
}
