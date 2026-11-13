import { create } from 'zustand';

import { platform } from '../../platform';
import type {
  ComputeImportDetails,
  ComputeJobIntentInput,
  ComputeJobIntentReceipt,
  ComputeJobRecord,
  ComputeJobsListOptions,
  ComputeJobsSnapshot,
} from '../../shared/compute-jobs-ipc';

export type { ComputeJobRecord, ComputeJobState } from '../../shared/compute-jobs-ipc';

export interface ComputeJobsState {
  jobs: ComputeJobRecord[];
  loading: boolean;
  error: string | null;

  observedAtMs: number | null;

  collectionStale: boolean;

  coverage: Omit<ComputeJobsSnapshot, 'jobs'> | null;
  refresh(options?: ComputeJobsListOptions): Promise<void>;
  recordIntent(input: ComputeJobIntentInput): Promise<ComputeJobIntentReceipt>;
  markSubmitted(id: string, remoteId: string): Promise<ComputeJobRecord | null>;
  markFailed(id: string, error: string): Promise<ComputeJobRecord | null>;
  markSubmissionUnknown(id: string, error: string): Promise<ComputeJobRecord | null>;
  markCanceled(id: string, providerState: string): Promise<ComputeJobRecord | null>;
  markImported(
    id: string,
    paths: string[],
    details?: ComputeImportDetails | null
  ): Promise<ComputeJobRecord | null>;
  invalidateRuntime(): void;
  resetForTests(): void;
}

function upsert(jobs: ComputeJobRecord[], job: ComputeJobRecord | null): ComputeJobRecord[] {
  if (!job) return jobs;
  return [job, ...jobs.filter((j) => j.id !== job.id)];
}

export const useComputeJobsStore = create<ComputeJobsState>((set) => {
  let runtimeGeneration = 0;
  let requestSequence = 0;
  let pendingWrites = 0;
  const acknowledgedWrites = new Map<string, number>();

  let collectionLimit = 200;

  const write = async <T extends ComputeJobRecord | null>(
    operation: () => Promise<T>
  ): Promise<T> => {
    const runtime = runtimeGeneration;
    pendingWrites += 1;
    const request = ++requestSequence;
    set({ loading: false, collectionStale: true });
    let job: T;
    try {
      job = await operation();
    } catch (error) {
      if (runtime === runtimeGeneration) {
        pendingWrites -= 1;
        requestSequence += 1;
        set({ loading: false, collectionStale: true });
      }
      throw error;
    }
    if (runtime === runtimeGeneration) {
      pendingWrites -= 1;
      requestSequence += 1;
      const accepted = job && request > (acknowledgedWrites.get(job.id) ?? -1);
      if (job && accepted) acknowledgedWrites.set(job.id, request);
      set((state) => ({
        jobs: accepted ? upsert(state.jobs, job) : state.jobs,
        loading: false,
        collectionStale: true,
        ...(accepted ? { error: null, observedAtMs: Date.now() } : {}),
      }));
    }
    return job;
  };

  return {
    jobs: [],
    loading: false,
    error: null,
    observedAtMs: null,
    collectionStale: true,
    coverage: null,

    async refresh(options) {
      const runtime = runtimeGeneration;
      const request = ++requestSequence;
      const scoped = options?.proteinSequence !== undefined || Boolean(options?.states?.length);
      const requestedLimit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
      if (!scoped && Number.isFinite(requestedLimit)) {
        collectionLimit = Math.max(collectionLimit, requestedLimit);
      }
      const query = {
        ...options,
        ...(options?.states ? { states: [...options.states] } : {}),
        limit: Number.isFinite(requestedLimit) && !scoped ? collectionLimit : requestedLimit,
      };
      set({ loading: true });
      try {
        const snapshot = scoped
          ? null
          : await platform().compute.listJobsSnapshot({ historyLimit: query.limit });
        const jobs = snapshot ? snapshot.jobs : await platform().compute.listJobs(query);
        if (runtime !== runtimeGeneration || request !== requestSequence) return;
        if (pendingWrites > 0) {
          set({ loading: false, collectionStale: true });
          return;
        }
        acknowledgedWrites.clear();
        if (scoped) {
          const ids = new Set(jobs.map((job) => job.id));
          set((state) => ({
            jobs: [...jobs, ...state.jobs.filter((job) => !ids.has(job.id))],
            loading: false,
            collectionStale: true,
            coverage: null,
            observedAtMs: Date.now(),
          }));
        } else {
          const { jobs: _jobs, ...coverage } = snapshot!;
          set({
            jobs,
            coverage,
            loading: false,
            error: null,
            collectionStale: false,
            observedAtMs: Date.now(),
          });
        }
      } catch (error) {
        if (runtime !== runtimeGeneration || request !== requestSequence) return;
        set({
          loading: false,
          collectionStale: true,
          error: error instanceof Error ? error.message : 'Could not load compute jobs.',
        });
      }
    },

    async markSubmissionUnknown(id, error) {
      return write(() => platform().compute.markJobSubmissionUnknown(id, error));
    },

    async recordIntent(input) {
      return write(() => platform().compute.recordJobIntent(input));
    },

    async markSubmitted(id, remoteId) {
      return write(() => platform().compute.markJobSubmitted(id, remoteId));
    },

    async markFailed(id, error) {
      return write(() => platform().compute.markJobFailed(id, error));
    },

    async markCanceled(id, providerState) {
      return write(() => platform().compute.markJobCanceled(id, providerState));
    },

    async markImported(id, paths, details) {
      return write(() => platform().compute.markJobImported(id, paths, details));
    },

    invalidateRuntime() {
      runtimeGeneration += 1;
      requestSequence += 1;
      pendingWrites = 0;
      acknowledgedWrites.clear();
      set({ loading: false, error: null, collectionStale: true });
    },

    resetForTests() {
      runtimeGeneration += 1;
      requestSequence += 1;
      pendingWrites = 0;
      acknowledgedWrites.clear();
      collectionLimit = 200;
      set({
        jobs: [],
        loading: false,
        error: null,
        observedAtMs: null,
        collectionStale: true,
        coverage: null,
      });
    },
  };
});
