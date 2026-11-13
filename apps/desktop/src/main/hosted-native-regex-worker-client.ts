import type { Worker } from 'node:worker_threads';

import type { HostedNativeRegexWorkerResponse } from './hosted-native-regex-worker-entry';
import {
  type HostedNativeRegexWorkerJob,
  type HostedNativeRegexWorkerResult,
} from './hosted-native-regex-worker-job';

const MAX_REGEX_EXECUTION_MS = 1_000;

interface HostedNativeRegexWorkerOptions {
  readonly createWorker?: () => Worker;
  readonly loadWorker?: () => Promise<Worker>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function stoppedError(): Error {
  const error = new Error('Hosted native text search was stopped.');
  error.name = 'AbortError';
  return error;
}

function validateResult(
  result: HostedNativeRegexWorkerResult,
  job: HostedNativeRegexWorkerJob
): HostedNativeRegexWorkerResult {
  const authorizedPaths = new Set(job.files.map((file) => file.path));
  if (
    !result ||
    !Array.isArray(result.matches) ||
    result.matches.length > job.limit ||
    typeof result.truncated !== 'boolean' ||
    !result.matches.every(
      (match) =>
        match &&
        authorizedPaths.has(match.path) &&
        Number.isSafeInteger(match.line) &&
        match.line > 0 &&
        typeof match.text === 'string' &&
        match.text.length <= 16 * 1024
    )
  ) {
    throw new Error('Hosted native regex worker sent an invalid result.');
  }
  return result;
}

async function createPackagedWorker(): Promise<Worker> {
  const module = await import('./hosted-native-regex-worker-entry?nodeWorker');
  return module.default({});
}

export async function searchHostedTextInDedicatedWorker(
  job: HostedNativeRegexWorkerJob,
  options: HostedNativeRegexWorkerOptions = {}
): Promise<HostedNativeRegexWorkerResult> {
  const worker = options.createWorker
    ? options.createWorker()
    : await (options.loadWorker ?? createPackagedWorker)();
  const timeoutMs = Math.max(
    1,
    Math.min(options.timeoutMs ?? MAX_REGEX_EXECUTION_MS, MAX_REGEX_EXECUTION_MS)
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish({
        kind: 'reject',
        error: new Error('The search pattern exceeded the safe execution time.'),
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
    const finish = (
      outcome:
        | { kind: 'resolve'; value: HostedNativeRegexWorkerResult }
        | { kind: 'reject'; error: Error }
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => undefined);
      if (outcome.kind === 'resolve') resolve(outcome.value);
      else reject(outcome.error);
    };
    const onMessage = (message: HostedNativeRegexWorkerResponse): void => {
      if (message?.type === 'result') {
        try {
          finish({ kind: 'resolve', value: validateResult(message.result, job) });
        } catch (error) {
          finish({
            kind: 'reject',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      } else if (message?.type === 'error') {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        finish({ kind: 'reject', error });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Hosted native regex worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void =>
      finish({
        kind: 'reject',
        error: new Error(`Hosted native regex worker exited early (code ${code}).`),
      });
    const onAbort = (): void => finish({ kind: 'reject', error: stoppedError() });

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    worker.postMessage(job);
  });
}
