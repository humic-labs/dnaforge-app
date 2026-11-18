import type { DedicatedWorkerLikeV1 } from './process-worker';
import type { SourceAnnotationAliasesV1 } from '@waypoint/genome-renderer/pure';
import type { SearchJobPairV1 } from './assembly-search-chromosome-pool';

import type {
  ExpandedAnnotationSceneWorkerJob,
  ExpandedAnnotationSceneInventoryWorkerResult,
  ExpandedAnnotationSceneWorkerResult,
  ExpandedAnnotationSceneWorkerSetJob,
  ExpandedAnnotationSceneWorkerSetResult,
} from './assembly-expanded-annotation-scene-compiler';
import type {
  AssemblyAnnotationSearchWorkerProgress,
  AssemblyAnnotationSearchWorkerJob,
  AssemblyAnnotationSearchWorkerResult,
} from './assembly-annotation-search-compiler';
import type {
  AssemblyProteinSearchWorkerJob,
  AssemblyProteinSearchWorkerResult,
} from './assembly-protein-search-build';

export type ExpandedAnnotationSceneWorkerRequest =
  | { type: 'compile'; job: ExpandedAnnotationSceneWorkerJob }
  | { type: 'inventory'; job: ExpandedAnnotationSceneWorkerJob }
  | { type: 'source-aliases'; job: ExpandedAnnotationSceneWorkerJob; expectedPayloadSha256: string }
  | { type: 'compile-set'; job: ExpandedAnnotationSceneWorkerSetJob }
  | { type: 'compile-search'; job: AssemblyAnnotationSearchWorkerJob }
  | { type: 'compile-protein-search'; job: AssemblyProteinSearchWorkerJob }
  | { type: 'compile-searches'; job: SearchJobPairV1 };

export type ExpandedAnnotationSceneWorkerResponse =
  | { type: 'result'; result: ExpandedAnnotationSceneWorkerResult }
  | { type: 'inventory-result'; result: ExpandedAnnotationSceneInventoryWorkerResult }
  | { type: 'source-aliases-result'; result: readonly SourceAnnotationAliasesV1[] }
  | { type: 'set-result'; result: ExpandedAnnotationSceneWorkerSetResult }
  | { type: 'search-progress'; progress: AssemblyAnnotationSearchWorkerProgress }
  | { type: 'search-result'; result: AssemblyAnnotationSearchWorkerResult }
  | { type: 'protein-search-result'; result: AssemblyProteinSearchWorkerResult }
  | { type: 'searches-result'; result: PairedSearchWorkerResultV1 }
  | { type: 'error'; error: { name: string; message: string } };

type WorkerOutcomeV1<T> = { value: T } | { error: { name: string; message: string } };

export interface PairedSearchWorkerResultV1 {
  readonly annotation: WorkerOutcomeV1<AssemblyAnnotationSearchWorkerResult>;
  readonly protein: WorkerOutcomeV1<AssemblyProteinSearchWorkerResult>;
}

interface ExpandedAnnotationSceneWorkerClientOptions {
  createWorker: () => DedicatedWorkerLikeV1;
  signal?: AbortSignal;
  onAnnotationSearchProgress?: (progress: AssemblyAnnotationSearchWorkerProgress) => void;
}

function abortError(): Error {
  const error = new Error('Expanded annotation scene compilation was aborted.');
  error.name = 'AbortError';
  return error;
}

function structuredWorkerError(error: { name: string; message: string }): Error {
  const reconstructed = new Error(error.message);
  reconstructed.name = error.name;
  return reconstructed;
}

export function runRetainedSourceAnnotationAliasesWorkerV1(
  job: ExpandedAnnotationSceneWorkerJob,
  expectedPayloadSha256: string,
  options: ExpandedAnnotationSceneWorkerClientOptions
): Promise<readonly SourceAnnotationAliasesV1[]> {
  const worker = options.createWorker();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: readonly SourceAnnotationAliasesV1[] } | { error: Error }) => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      options.signal?.removeEventListener('abort', onAbort);
      void worker
        .terminate()
        .catch(() => undefined)
        .then(() => {
          if ('error' in result) reject(result.error);
          else resolve(result.value);
        });
    };
    const onMessage = (message: ExpandedAnnotationSceneWorkerResponse) => {
      if (message?.type === 'source-aliases-result') finish({ value: message.result });
      else if (message?.type === 'error') finish({ error: structuredWorkerError(message.error) });
      else
        finish({ error: new Error('Retained annotation source worker sent an invalid response.') });
    };
    const onError = (error: Error) => finish({ error });
    const onExit = (code: number) =>
      finish({
        error: new Error(
          `Retained annotation source worker exited before completion (code ${code}).`
        ),
      });
    const onAbort = () => finish({ error: abortError() });
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else
      worker.postMessage({
        type: 'source-aliases',
        job,
        expectedPayloadSha256,
      } satisfies ExpandedAnnotationSceneWorkerRequest);
  });
}

export function runExpandedAnnotationSceneWorker(
  job: ExpandedAnnotationSceneWorkerJob,
  options: ExpandedAnnotationSceneWorkerClientOptions
): Promise<ExpandedAnnotationSceneWorkerResult> {
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
        | { kind: 'resolve'; value: ExpandedAnnotationSceneWorkerResult }
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

    const onMessage = (message: ExpandedAnnotationSceneWorkerResponse): void => {
      if (message?.type === 'result') {
        finish({ kind: 'resolve', value: message.result });
        return;
      }
      if (message?.type === 'error') {
        finish({ kind: 'reject', error: structuredWorkerError(message.error) });
        return;
      }
      finish({
        kind: 'reject',
        error: new Error('Expanded annotation scene worker sent an invalid response.'),
      });
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void => {
      finish({
        kind: 'reject',
        error: new Error(
          `Expanded annotation scene worker exited before completion (code ${code}).`
        ),
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
    const request: ExpandedAnnotationSceneWorkerRequest = { type: 'compile', job };
    worker.postMessage(request);
  });
}

export function runExpandedAnnotationSceneSetWorker(
  job: ExpandedAnnotationSceneWorkerSetJob,
  options: ExpandedAnnotationSceneWorkerClientOptions
): Promise<ExpandedAnnotationSceneWorkerSetResult> {
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
        | { kind: 'resolve'; value: ExpandedAnnotationSceneWorkerSetResult }
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
    const onMessage = (message: ExpandedAnnotationSceneWorkerResponse): void => {
      if (message?.type === 'set-result') {
        finish({ kind: 'resolve', value: message.result });
      } else if (message?.type === 'error') {
        finish({ kind: 'reject', error: structuredWorkerError(message.error) });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Expanded annotation scene-set worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void =>
      finish({
        kind: 'reject',
        error: new Error(
          `Expanded annotation scene-set worker exited before completion (code ${code}).`
        ),
      });
    const onAbort = (): void => finish({ kind: 'reject', error: abortError() });
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    worker.postMessage({ type: 'compile-set', job } satisfies ExpandedAnnotationSceneWorkerRequest);
  });
}

export function runExpandedAnnotationSceneInventoryWorker(
  job: ExpandedAnnotationSceneWorkerJob,
  options: ExpandedAnnotationSceneWorkerClientOptions
): Promise<ExpandedAnnotationSceneInventoryWorkerResult> {
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
        | { kind: 'resolve'; value: ExpandedAnnotationSceneInventoryWorkerResult }
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
    const onMessage = (message: ExpandedAnnotationSceneWorkerResponse): void => {
      if (message?.type === 'inventory-result') {
        finish({ kind: 'resolve', value: message.result });
      } else if (message?.type === 'error') {
        finish({ kind: 'reject', error: structuredWorkerError(message.error) });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Expanded annotation inventory worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void =>
      finish({
        kind: 'reject',
        error: new Error(`Expanded annotation inventory worker exited early (code ${code}).`),
      });
    const onAbort = (): void => finish({ kind: 'reject', error: abortError() });
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    worker.postMessage({ type: 'inventory', job } satisfies ExpandedAnnotationSceneWorkerRequest);
  });
}

export function runAssemblyAnnotationSearchWorker(
  job: AssemblyAnnotationSearchWorkerJob,
  options: ExpandedAnnotationSceneWorkerClientOptions
): Promise<AssemblyAnnotationSearchWorkerResult> {
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
        | { kind: 'resolve'; value: AssemblyAnnotationSearchWorkerResult }
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
    const onMessage = (message: ExpandedAnnotationSceneWorkerResponse): void => {
      if (message?.type === 'search-progress') {
        options.onAnnotationSearchProgress?.(message.progress);
      } else if (message?.type === 'search-result') {
        finish({ kind: 'resolve', value: message.result });
      } else if (message?.type === 'error') {
        finish({ kind: 'reject', error: structuredWorkerError(message.error) });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Assembly annotation search worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void =>
      finish({
        kind: 'reject',
        error: new Error(`Assembly annotation search worker exited early (code ${code}).`),
      });
    const onAbort = (): void => finish({ kind: 'reject', error: abortError() });
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    worker.postMessage({
      type: 'compile-search',
      job,
    } satisfies ExpandedAnnotationSceneWorkerRequest);
  });
}

export function runAssemblyProteinSearchWorker(
  job: AssemblyProteinSearchWorkerJob,
  options: ExpandedAnnotationSceneWorkerClientOptions
): Promise<AssemblyProteinSearchWorkerResult> {
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
        | { kind: 'resolve'; value: AssemblyProteinSearchWorkerResult }
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
    const onMessage = (message: ExpandedAnnotationSceneWorkerResponse): void => {
      if (message?.type === 'protein-search-result') {
        finish({ kind: 'resolve', value: message.result });
      } else if (message?.type === 'error') {
        finish({ kind: 'reject', error: structuredWorkerError(message.error) });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Assembly protein search worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void =>
      finish({
        kind: 'reject',
        error: new Error(`Assembly protein search worker exited early (code ${code}).`),
      });
    const onAbort = (): void => finish({ kind: 'reject', error: abortError() });
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    worker.postMessage({
      type: 'compile-protein-search',
      job,
    } satisfies ExpandedAnnotationSceneWorkerRequest);
  });
}

export function runAssemblySearchesWorker(
  job: SearchJobPairV1,
  options: ExpandedAnnotationSceneWorkerClientOptions
): Promise<PairedSearchWorkerResultV1> {
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
        | { kind: 'resolve'; value: PairedSearchWorkerResultV1 }
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
    const onMessage = (message: ExpandedAnnotationSceneWorkerResponse): void => {
      if (message?.type === 'search-progress') {
        options.onAnnotationSearchProgress?.(message.progress);
      } else if (message?.type === 'searches-result') {
        finish({ kind: 'resolve', value: message.result });
      } else if (message?.type === 'error') {
        finish({ kind: 'reject', error: structuredWorkerError(message.error) });
      } else {
        finish({
          kind: 'reject',
          error: new Error('Assembly search worker sent an invalid response.'),
        });
      }
    };
    const onError = (error: Error): void => finish({ kind: 'reject', error });
    const onExit = (code: number): void =>
      finish({
        kind: 'reject',
        error: new Error(`Assembly search worker exited early (code ${code}).`),
      });
    const onAbort = (): void => finish({ kind: 'reject', error: abortError() });
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    worker.postMessage({
      type: 'compile-searches',
      job,
    } satisfies ExpandedAnnotationSceneWorkerRequest);
  });
}
