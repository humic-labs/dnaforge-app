import type {
  AssemblyAnnotationSearchWorkerJob,
  AssemblyAnnotationSearchWorkerProgress,
  AssemblyAnnotationSearchWorkerResult,
} from './assembly-annotation-search-compiler';
import type {
  AssemblyProteinSearchWorkerJob,
  AssemblyProteinSearchWorkerResult,
} from './assembly-protein-search-build';
import type { SearchJobPairV1 } from './assembly-search-chromosome-pool';
import type { PairedSearchWorkerResultV1 } from './assembly-expanded-annotation-scene-worker-client';

interface AnnotationBuildOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AssemblyAnnotationSearchWorkerProgress) => void;
}
interface ProteinBuildOptions {
  signal?: AbortSignal;
}

export type SearchBuildSideV1 = 'annotation' | 'protein';

export interface SearchBuildPairingV1 {
  readonly annotation: (
    job: AssemblyAnnotationSearchWorkerJob,
    options?: AnnotationBuildOptions
  ) => Promise<AssemblyAnnotationSearchWorkerResult>;
  readonly protein: (
    job: AssemblyProteinSearchWorkerJob,
    options?: ProteinBuildOptions
  ) => Promise<AssemblyProteinSearchWorkerResult>;
  release(side: SearchBuildSideV1): void;
}

export interface SearchBuildRunnersV1 {
  readonly annotation: (
    job: AssemblyAnnotationSearchWorkerJob,
    options?: AnnotationBuildOptions
  ) => Promise<AssemblyAnnotationSearchWorkerResult>;
  readonly protein: (
    job: AssemblyProteinSearchWorkerJob,
    options?: ProteinBuildOptions
  ) => Promise<AssemblyProteinSearchWorkerResult>;
  readonly both: (
    job: SearchJobPairV1,
    options: AnnotationBuildOptions
  ) => Promise<PairedSearchWorkerResultV1>;
}

interface Waiting<Job, Options, Result> {
  readonly job: Job;
  readonly options: Options | undefined;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
}

type Slot<Job, Options, Result> = Waiting<Job, Options, Result> | 'released' | undefined;

export function createSearchBuildPairingV1(runners: SearchBuildRunnersV1): SearchBuildPairingV1 {
  let annotation: Slot<
    AssemblyAnnotationSearchWorkerJob,
    AnnotationBuildOptions,
    AssemblyAnnotationSearchWorkerResult
  >;
  let protein: Slot<
    AssemblyProteinSearchWorkerJob,
    ProteinBuildOptions,
    AssemblyProteinSearchWorkerResult
  >;
  let started = false;

  const start = (): void => {
    if (started || annotation === undefined || protein === undefined) return;
    started = true;
    const a = annotation === 'released' ? null : annotation;
    const p = protein === 'released' ? null : protein;
    const runAlone = (): void => {
      if (a) runners.annotation(a.job, a.options).then(a.resolve, a.reject);
      if (p) runners.protein(p.job, p.options).then(p.resolve, p.reject);
    };
    if (!a || !p || JSON.stringify(a.job.request) !== JSON.stringify(p.job.request)) {
      runAlone();
      return;
    }
    const signals = [a.options?.signal, p.options?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    runners
      .both(
        { annotation: a.job, protein: p.job },
        {
          ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
          ...(a.options?.onProgress ? { onProgress: a.options.onProgress } : {}),
        }
      )
      .then(
        (result) => {
          settle(result.annotation, a);
          settle(result.protein, p);
        },
        (error: unknown) => {
          a.reject(error);
          p.reject(error);
        }
      );
  };

  return {
    annotation: (job, options) =>
      new Promise((resolve, reject) => {
        if (annotation !== undefined) {
          reject(new Error('Annotation search was already submitted to this pairing.'));
          return;
        }
        annotation = { job, options, resolve, reject };
        start();
      }),
    protein: (job, options) =>
      new Promise((resolve, reject) => {
        if (protein !== undefined) {
          reject(new Error('Protein search was already submitted to this pairing.'));
          return;
        }
        protein = { job, options, resolve, reject };
        start();
      }),
    release(side) {
      if (side === 'annotation' && annotation === undefined) annotation = 'released';
      if (side === 'protein' && protein === undefined) protein = 'released';
      start();
    },
  };
}

function settle<Result>(
  outcome: { value: Result } | { error: { name: string; message: string } },
  waiting: Pick<Waiting<unknown, unknown, Result>, 'resolve' | 'reject'>
): void {
  if ('value' in outcome) {
    waiting.resolve(outcome.value);
    return;
  }
  const error = new Error(outcome.error.message);
  error.name = outcome.error.name;
  waiting.reject(error);
}
