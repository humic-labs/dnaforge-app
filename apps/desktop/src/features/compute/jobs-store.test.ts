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

describe('useComputeJobsStore observation receipt', () => {
  it('retains native totals and all active rows beyond the terminal page through smaller Settings reads', async () => {
    const native: ComputeJobsSnapshot = {
      jobs: [
        job({ id: 'new-terminal', state: 'completed' }),
        job({ id: 'old-active', state: 'running' }),
      ],
      jobCount: 206,
      activeCount: 1,
      terminalCount: 205,
      activeComplete: true,
      historyComplete: false,
      historyLimit: 200,
    };
    mocks.listJobsSnapshot.mockResolvedValueOnce(native).mockResolvedValueOnce(native);
    await useComputeJobsStore.getState().refresh({ limit: 200 });
    await useComputeJobsStore.getState().refresh({ limit: 1 });
    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: native.jobs,
      coverage: { jobCount: 206, activeCount: 1, terminalCount: 205, historyComplete: false },
      collectionStale: false,
    });
    expect(mocks.listJobsSnapshot).toHaveBeenLastCalledWith({ historyLimit: 200 });
  });

  it('keeps last native counts unavailable across a runtime failure, then reconciles valid later native changes', async () => {
    const native: ComputeJobsSnapshot = {
      jobs: [job({ state: 'running' })],
      jobCount: 206,
      activeCount: 1,
      terminalCount: 205,
      activeComplete: true,
      historyComplete: false,
      historyLimit: 200,
    };
    mocks.listJobsSnapshot.mockResolvedValueOnce(native);
    await useComputeJobsStore.getState().refresh();
    useComputeJobsStore.getState().invalidateRuntime();
    mocks.listJobsSnapshot.mockRejectedValueOnce(new Error('reconnecting'));
    await useComputeJobsStore.getState().refresh();
    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: native.jobs,
      coverage: { activeCount: 1, terminalCount: 205 },
      collectionStale: true,
      observedAtMs: NOW,
      error: 'reconnecting',
    });
    mocks.listJobsSnapshot.mockResolvedValueOnce({
      ...native,
      jobs: [job({ state: 'completed' })],
      activeCount: 0,
      terminalCount: 206,
    });
    await useComputeJobsStore.getState().refresh();
    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ state: 'completed' })],
      coverage: { activeCount: 0, terminalCount: 206 },
      collectionStale: false,
      error: null,
    });
  });

  it('keeps a cancel acknowledgment and newer native list when the older list returns last', async () => {
    const old = deferred<ComputeJobRecord[]>();
    mocks.listJobs.mockReturnValueOnce(old.promise);
    const a = useComputeJobsStore.getState().refresh({ limit: 200 });
    mocks.markJobCanceled.mockResolvedValueOnce(
      job({ state: 'canceled', providerState: 'Stopped' })
    );
    await useComputeJobsStore.getState().markCanceled('compute-local-1', 'Stopped');
    const acknowledgmentNeedsRead = useComputeJobsStore.getState().collectionStale;
    vi.setSystemTime(NOW + 1000);
    mocks.listJobs.mockResolvedValueOnce([job({ state: 'canceled', providerState: 'Stopped' })]);
    await useComputeJobsStore.getState().refresh({ limit: 200 });
    old.resolve([job({ state: 'running' })]);
    await a;
    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ state: 'canceled' })],
      observedAtMs: NOW + 1000,
      collectionStale: false,
    });
    expect(acknowledgmentNeedsRead).toBe(true);
  });

  it('does not let a pre-import native list remove acknowledged imported paths', async () => {
    const old = deferred<ComputeJobRecord[]>();
    mocks.listJobs.mockReturnValueOnce(old.promise);
    const a = useComputeJobsStore.getState().refresh();
    const imported = job({ state: 'imported', importedPaths: ['/synthetic/result.cif'] });
    mocks.markJobImported.mockResolvedValueOnce(imported);
    await useComputeJobsStore.getState().markImported(imported.id, imported.importedPaths);
    old.resolve([job({ state: 'completed' })]);
    await a;
    expect(useComputeJobsStore.getState().jobs).toEqual([imported]);
    expect(useComputeJobsStore.getState()).toMatchObject({ collectionStale: true, loading: false });
  });

  it('does not publish a list while an actual write acknowledgment is pending', async () => {
    mocks.listJobs.mockResolvedValueOnce([job()]);
    await useComputeJobsStore.getState().refresh();
    const ack = deferred<ComputeJobRecord | null>();
    mocks.markJobCanceled.mockReturnValueOnce(ack.promise);
    const write = useComputeJobsStore.getState().markCanceled('compute-local-1', 'Stopped');
    mocks.listJobs.mockResolvedValueOnce([job({ state: 'running' })]);
    await useComputeJobsStore.getState().refresh();
    expect(useComputeJobsStore.getState().jobs[0].state).toBe('submitted');
    expect(useComputeJobsStore.getState().collectionStale).toBe(true);
    ack.resolve(job({ state: 'canceled' }));
    await write;
    expect(useComputeJobsStore.getState().jobs[0].state).toBe('canceled');
  });

  it('accepts a valid later native update instead of pinning the local acknowledgment forever', async () => {
    mocks.markJobSubmitted.mockResolvedValueOnce(job({ state: 'submitted' }));
    await useComputeJobsStore.getState().markSubmitted('compute-local-1', 'provider-job-1');
    mocks.listJobs.mockResolvedValueOnce([
      job({ state: 'running', pollCount: 3, updatedAt: new Date(NOW + 1).toISOString() }),
    ]);
    await useComputeJobsStore.getState().refresh();
    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ state: 'running', pollCount: 3 })],
      collectionStale: false,
    });
  });

  it('ignores an older failure after a newer successful collection', async () => {
    const old = deferred<ComputeJobRecord[]>();
    mocks.listJobs
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([job({ state: 'completed' })]);
    const a = useComputeJobsStore.getState().refresh();
    await useComputeJobsStore.getState().refresh();
    old.reject(new Error('obsolete failure'));
    await a;
    expect(useComputeJobsStore.getState()).toMatchObject({
      error: null,
      collectionStale: false,
      jobs: [expect.objectContaining({ state: 'completed' })],
    });
  });

  it('does not clear the newer failure or stamp an older success current', async () => {
    mocks.listJobs.mockResolvedValueOnce([job()]);
    await useComputeJobsStore.getState().refresh();
    const old = deferred<ComputeJobRecord[]>();
    mocks.listJobs
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error('current failure'));
    const a = useComputeJobsStore.getState().refresh();
    vi.setSystemTime(NOW + 2000);
    await useComputeJobsStore.getState().refresh();
    old.resolve([job({ state: 'completed' })]);
    await a;
    expect(useComputeJobsStore.getState()).toMatchObject({
      error: 'current failure',
      observedAtMs: NOW,
      collectionStale: true,
      jobs: [expect.objectContaining({ state: 'submitted' })],
    });
  });

  it('keeps the latest loading owner when an older read fails', async () => {
    const a = deferred<ComputeJobRecord[]>();
    const b = deferred<ComputeJobRecord[]>();
    mocks.listJobs.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = useComputeJobsStore.getState().refresh();
    const second = useComputeJobsStore.getState().refresh();
    a.reject(new Error('old failure'));
    await first;
    expect(useComputeJobsStore.getState().loading).toBe(true);
    b.resolve([job()]);
    await second;
    expect(useComputeJobsStore.getState().loading).toBe(false);
  });

  it('retires old success and failure callbacks across reset and runtime replacement', async () => {
    const old = deferred<ComputeJobRecord[]>();
    mocks.listJobs.mockReturnValueOnce(old.promise);
    const a = useComputeJobsStore.getState().refresh();
    useComputeJobsStore.getState().resetForTests();
    old.resolve([job()]);
    await a;
    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: [],
      observedAtMs: null,
      collectionStale: true,
    });
    const failed = deferred<ComputeJobRecord[]>();
    mocks.listJobs.mockReturnValueOnce(failed.promise);
    const b = useComputeJobsStore.getState().refresh();
    useComputeJobsStore.getState().invalidateRuntime();
    mocks.listJobs.mockResolvedValueOnce([job({ id: 'new-runtime' })]);
    await useComputeJobsStore.getState().refresh();
    failed.reject(new Error('old runtime'));
    await b;
    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ id: 'new-runtime' })],
      error: null,
      collectionStale: false,
    });
  });

  it('does not apply a pre-reset write receipt to the new runtime mirror', async () => {
    const ack = deferred<ComputeJobRecord | null>();
    mocks.markJobSubmitted.mockReturnValueOnce(ack.promise);
    const pending = useComputeJobsStore.getState().markSubmitted('compute-local-1', 'remote');
    useComputeJobsStore.getState().resetForTests();
    mocks.listJobs.mockResolvedValueOnce([job({ id: 'new-runtime' })]);
    await useComputeJobsStore.getState().refresh();
    const actual = job();
    ack.resolve(actual);
    expect(await pending).toBe(actual);
    expect(useComputeJobsStore.getState().jobs.map((j) => j.id)).toEqual(['new-runtime']);
    expect(useComputeJobsStore.getState().collectionStale).toBe(false);
  });

  it('keeps the shared native read width when Settings asks for fewer rows', async () => {
    const rows = [job(), job({ id: 'older-active', state: 'running' })];
    mocks.listJobs.mockImplementation((options: { limit: number }) =>
      Promise.resolve(rows.slice(0, options.limit))
    );
    await useComputeJobsStore.getState().refresh({ limit: 200 });
    await useComputeJobsStore.getState().refresh({ limit: 1 });
    expect(mocks.listJobs).toHaveBeenLastCalledWith({ limit: 200 });
    expect(useComputeJobsStore.getState().jobs).toEqual(rows);
    expect(useComputeJobsStore.getState().collectionStale).toBe(false);
  });

  it('does not let an overlapping smaller Settings response replace a later Jobs collection', async () => {
    const small = deferred<ComputeJobRecord[]>();
    mocks.listJobs.mockReturnValueOnce(small.promise);
    const settings = useComputeJobsStore.getState().refresh({ limit: 1 });
    const rows = [job({ state: 'completed' }), job({ id: 'still-active', state: 'running' })];
    mocks.listJobs.mockResolvedValueOnce(rows);
    await useComputeJobsStore.getState().refresh({ limit: 200 });
    small.resolve([job()]);
    await settings;
    expect(useComputeJobsStore.getState().jobs).toEqual(rows);
    expect(useComputeJobsStore.getState().collectionStale).toBe(false);
    expect(mocks.listJobs.mock.calls.map(([options]) => options.limit)).toEqual([200, 200]);
  });

  it('merges a scoped native result without deleting other rows or claiming a complete current collection', async () => {
    mocks.listJobs.mockResolvedValueOnce([job(), job({ id: 'other' })]);
    await useComputeJobsStore.getState().refresh();
    mocks.listJobs.mockResolvedValueOnce([job({ state: 'running' })]);
    await useComputeJobsStore.getState().refresh({ states: ['running'], limit: 1 });
    expect(useComputeJobsStore.getState().jobs.map((j) => j.id)).toEqual([
      'compute-local-1',
      'other',
    ]);
    expect(useComputeJobsStore.getState().collectionStale).toBe(true);
    expect(useComputeJobsStore.getState().coverage).toBeNull();
    mocks.listJobs.mockResolvedValueOnce([job({ state: 'completed' })]);
    await useComputeJobsStore.getState().refresh();
    expect(useComputeJobsStore.getState().jobs).toEqual([job({ state: 'completed' })]);
    expect(useComputeJobsStore.getState().collectionStale).toBe(false);
  });

  it('preserves the real write rejection and keeps the last native rows pending reconciliation', async () => {
    mocks.listJobs.mockResolvedValueOnce([job()]);
    await useComputeJobsStore.getState().refresh();
    const failure = new Error('native write failed');
    mocks.markJobCanceled.mockRejectedValueOnce(failure);
    await expect(
      useComputeJobsStore.getState().markCanceled('compute-local-1', 'Stopped')
    ).rejects.toBe(failure);
    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: [job()],
      observedAtMs: NOW,
      collectionStale: true,
    });
  });
  it('records when the main-process registry was successfully observed', async () => {
    mocks.listJobs.mockResolvedValueOnce([job()]);

    await useComputeJobsStore.getState().refresh({ limit: 200 });

    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ id: 'compute-local-1' })],
      loading: false,
      error: null,
      observedAtMs: NOW,
    });
  });

  it('retains the last rows and observation time when a later refresh fails', async () => {
    mocks.listJobs.mockResolvedValueOnce([job()]);
    await useComputeJobsStore.getState().refresh({ limit: 200 });
    vi.setSystemTime(NOW + 30_000);
    mocks.listJobs.mockRejectedValueOnce(new Error('registry unavailable'));

    await useComputeJobsStore.getState().refresh({ limit: 200 });

    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ id: 'compute-local-1' })],
      loading: false,
      error: 'registry unavailable',
      observedAtMs: NOW,
    });
  });

  it('mirrors a provider-confirmed cancellation into the observed registry state', async () => {
    mocks.markJobCanceled.mockResolvedValueOnce(
      job({ state: 'canceled', providerState: 'Stopped' })
    );

    await useComputeJobsStore.getState().markCanceled('compute-local-1', 'Stopped');

    expect(mocks.markJobCanceled).toHaveBeenCalledWith('compute-local-1', 'Stopped');
    expect(useComputeJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ state: 'canceled', providerState: 'Stopped' })],
      error: null,
      observedAtMs: NOW,
    });
  });
});
