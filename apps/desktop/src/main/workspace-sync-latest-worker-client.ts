import type { Worker } from 'node:worker_threads';

import type { ValidatedDesktopSyncLatestBundleEnvelope } from './workspace-sync-bundle-integrity';
import type { WorkspaceSyncLatestWorkerResponse } from './workspace-sync-latest-worker-entry';

interface WorkspaceSyncLatestWorkerOptions {
  readonly createWorker?: () => Worker;
  readonly loadWorker?: () => Promise<Worker>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const MAX_LATEST_WORKER_MS = 30_000;

function stoppedError(): Error {
  const error = new Error('Workspace sync latest parsing was stopped.');
  error.name = 'AbortError';
  return error;
}

async function createPackagedWorker(): Promise<Worker> {
  const module = await import('./workspace-sync-latest-worker-entry?nodeWorker');
  return module.default({});
}

export async function parseAndValidateDesktopSyncLatestInDedicatedWorker(
  bytes: Uint8Array,
  options: WorkspaceSyncLatestWorkerOptions = {}
): Promise<ValidatedDesktopSyncLatestBundleEnvelope> {
  const worker = options.createWorker
    ? options.createWorker()
    : await (options.loadWorker ?? createPackagedWorker)();
  const timeoutMs = Math.max(
    1,
    Math.min(options.timeoutMs ?? MAX_LATEST_WORKER_MS, MAX_LATEST_WORKER_MS)
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      void finish({
        kind: 'reject',
        error: new Error('Workspace sync latest parsing exceeded its execution deadline.'),
      });
    }, timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = async (
      outcome:
        | { kind: 'resolve'; latest: ValidatedDesktopSyncLatestBundleEnvelope }
        | { kind: 'reject'; error: Error }
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanup();
      await worker.terminate().catch(() => undefined);
      if (outcome.kind === 'resolve') resolve(outcome.latest);
      else reject(outcome.error);
    };
    const onMessage = (message: WorkspaceSyncLatestWorkerResponse): void => {
      if (message?.type === 'result') {
        void finish({ kind: 'resolve', latest: message.latest });
      } else if (message?.type === 'error') {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        void finish({ kind: 'reject', error });
      } else {
        void finish({
          kind: 'reject',
          error: new Error('Workspace sync latest worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => void finish({ kind: 'reject', error });
    const onExit = (code: number): void =>
      void finish({
        kind: 'reject',
        error: new Error(`Workspace sync latest worker exited early (code ${code}).`),
      });
    const onAbort = (): void => void finish({ kind: 'reject', error: stoppedError() });

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    const transferable =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : bytes.slice();
    try {
      worker.postMessage(transferable, [transferable.buffer]);
    } catch (error) {
      void finish({
        kind: 'reject',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  });
}
