import { fork, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';

import type { AssemblyAnnotationSearchWorkerJob } from './assembly-annotation-search-compiler';
import type { AssemblyProteinSearchWorkerJob } from './assembly-protein-search-build';

export interface SearchJobPairV1 {
  readonly annotation: AssemblyAnnotationSearchWorkerJob;
  readonly protein: AssemblyProteinSearchWorkerJob;
}

export type SearchJobV1 =
  | AssemblyAnnotationSearchWorkerJob
  | AssemblyProteinSearchWorkerJob
  | SearchJobPairV1;

type SearchChromosomeOutcomeV1<T> = { value: T } | { error: { name: string; message: string } };

export interface PairedSearchChromosomeResultV1 {
  readonly annotation: SearchChromosomeOutcomeV1<unknown>;
  readonly protein: SearchChromosomeOutcomeV1<unknown>;
}

export type SearchChromosomeKindV1 = 'annotation' | 'protein' | 'both';

export interface SearchChromosomeRequestV1 {
  readonly id: number;
  readonly kind: SearchChromosomeKindV1;
  readonly jobKey: string;
  readonly job?: SearchJobV1;
  readonly index: number;
}

type SearchChromosomeResponse =
  | { id: number; result: unknown }
  | { id: number; error: { name: string; message: string } };

export async function compileSearchChromosomesInWorkersV1<T>(
  entryPath: string,
  kind: SearchChromosomeKindV1,
  job: SearchJobV1,
  indexes: readonly number[],
  onChromosome?: (index: number) => void,
  workerCount = Math.max(1, Math.min(6, Math.floor(availableParallelism() / 3)))
): Promise<T[]> {
  if (indexes.length === 0) return [];
  const workers: ChildProcess[] = Array.from(
    { length: Math.min(workerCount, indexes.length) },
    () =>
      fork(entryPath, [], {
        execPath: process.execPath,
        execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
  );
  const jobKey = `${kind}:${Date.now()}:${Math.random()}`;
  const primed = new Set<ChildProcess>();
  const results = new Map<number, T>();
  const chromosomes = ('request' in job ? job : job.annotation).request.chromosomes;
  const queue = [...indexes].sort(
    (left, right) => chromosomes[right].length - chromosomes[left].length
  );
  let nextId = 0;
  try {
    await Promise.all(
      workers.map(async (worker) => {
        for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
          const id = nextId++;
          const request: SearchChromosomeRequestV1 = {
            id,
            kind,
            jobKey,
            index,
            ...(primed.has(worker) ? {} : { job }),
          };
          primed.add(worker);
          results.set(index, await runOne<T>(worker, request));
          onChromosome?.(index);
        }
      })
    );
  } finally {
    for (const worker of workers) worker.kill();
  }
  return indexes.map((index) => results.get(index) as T);
}

function runOne<T>(worker: ChildProcess, request: SearchChromosomeRequestV1): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (response: SearchChromosomeResponse) => {
      if (response.id !== request.id) return;
      cleanup();
      if ('error' in response) {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        reject(error);
      } else {
        resolve(response.result as T);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Search chromosome process exited (${code ?? signal}).`));
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.send(request);
  });
}
