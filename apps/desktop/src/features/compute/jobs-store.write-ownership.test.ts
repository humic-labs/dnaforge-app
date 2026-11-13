import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComputeJobRecord, ComputeJobsSnapshot } from '../../shared/compute-jobs-ipc';

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  listJobsSnapshot: vi.fn(),
  recordJobIntent: vi.fn(),
  markJobSubmitted: vi.fn(),
  markJobFailed: vi.fn(),
  markJobCanceled: vi.fn(),
  markJobImported: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({ compute: mocks }),
}));

import { useComputeJobsStore } from './jobs-store';

const NOW = Date.UTC(2026, 8, 15, 22, 0, 0);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function job(overrides: Partial<ComputeJobRecord> = {}): ComputeJobRecord {
  return {
    id: 'compute-local-1',
    provider: 'tamarind',
    toolId: 'esmfold',
    label: 'Hosted folding proof',
    settingsHash: 'settings-hash',
    settings: {},
    remoteId: 'provider-job-1',
    state: 'submitted',
    providerState: 'QUEUED',
    costEstimate: null,
    costEstimateUnit: null,
    costActual: null,
    costActualUnit: null,
    workspaceRoot: '/workspace',
    importedPaths: [],
    lastError: null,
    pollCount: 0,
    nextPollAt: null,
    createdAt: new Date(NOW - 10_000).toISOString(),
    updatedAt: new Date(NOW - 1_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  useComputeJobsStore.getState().resetForTests();

  mocks.listJobsSnapshot.mockImplementation(async ({ historyLimit }: { historyLimit: number }) => {
    const jobs = (await mocks.listJobs({ limit: historyLimit })) as ComputeJobRecord[];
    const activeCount = jobs.filter((row) =>
      ['intent', 'submitted', 'queued', 'running'].includes(row.state)
    ).length;
    return {
      jobs,
      jobCount: jobs.length,
      activeCount,
      terminalCount: jobs.length - activeCount,
      activeComplete: true,
      historyComplete: true,
      historyLimit,
    };
  });
});

describe('same-job write acknowledgement ownership', () => {
  it('keeps the later cancel acknowledgement when a submitted acknowledgement arrives last', async () => {
    const submitted = deferred<ComputeJobRecord>();
    mocks.markJobSubmitted.mockReturnValueOnce(submitted.promise);
    const first = useComputeJobsStore.getState().markSubmitted('compute-local-1', 'provider-job-1');
    mocks.markJobCanceled.mockResolvedValueOnce(
      job({ state: 'canceled', providerState: 'Stopped' })
    );
    await useComputeJobsStore.getState().markCanceled('compute-local-1', 'Stopped');
    submitted.resolve(job());
    await first;
    expect(useComputeJobsStore.getState().jobs).toEqual([
      job({ state: 'canceled', providerState: 'Stopped' }),
    ]);
  });

  it('retains an earlier successful acknowledgement when a later mutation fails', async () => {
    const submitted = deferred<ComputeJobRecord>();
    mocks.markJobSubmitted.mockReturnValueOnce(submitted.promise);
    const first = useComputeJobsStore.getState().markSubmitted('compute-local-1', 'provider-job-1');
    mocks.markJobCanceled.mockRejectedValueOnce(new Error('native disconnected'));
    await expect(
      useComputeJobsStore.getState().markCanceled('compute-local-1', 'Stopped')
    ).rejects.toThrow('native disconnected');
    submitted.resolve(job());
    await first;
    expect(useComputeJobsStore.getState().jobs).toEqual([job()]);
  });

  it('does not discard a different job acknowledgement when another job settles first', async () => {
    const submitted = deferred<ComputeJobRecord>();
    mocks.markJobSubmitted.mockReturnValueOnce(submitted.promise);
    const first = useComputeJobsStore.getState().markSubmitted('compute-local-1', 'provider-job-1');
    const other = job({ id: 'compute-local-2', state: 'canceled' });
    mocks.markJobCanceled.mockResolvedValueOnce(other);
    await useComputeJobsStore.getState().markCanceled(other.id, 'Stopped');
    submitted.resolve(job());
    await first;
    expect(useComputeJobsStore.getState().jobs).toEqual([job(), other]);
  });
});
