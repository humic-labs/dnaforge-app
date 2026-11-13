// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../services/sidecar-session', () => ({
  configureSidecarApiClient: mocks.configure,
}));

vi.mock('@waypoint/api-client', () => ({
  listAgentJobsOperationsAgentJobsGet: mocks.list,
  cancelAgentJobOperationsAgentJobsJobIdDelete: mocks.cancel,
}));

import { useAgentJobsStore } from './agent-jobs-store';

const NOW = Date.UTC(2026, 8, 16, 8, 0, 0);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function collection(
  jobs: Array<Record<string, unknown>>,
  active = 1,
  terminal = 0,
  complete = true
) {
  return {
    status: 200,
    data: {
      jobs,
      job_count: active + terminal,
      active_count: active,
      terminal_count: terminal,
      history_complete: complete,
    },
  };
}
const JOB = {
  id: 'action-1',
  tool_name: 'analysis.long',
  duration: 'long-running' as const,
  pool: 'cpu_slow',
  state: 'running' as const,
  cancelable: true,
  can_cancel: true,
  requested_at: new Date(NOW - 10_000).toISOString(),
  completed_at: null,
  error_code: null,
  agent_identity: { id: 'agent-1', label: 'Research CLI', kind: 'cli' },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.configure.mockResolvedValue(undefined);
  useAgentJobsStore.getState().resetForTests();
});

describe('useAgentJobsStore', () => {
  it('does not let the pre-Stop list replace its acknowledgment and newer collection/counts', async () => {
    const old = deferred<ReturnType<typeof collection>>();
    const entered = deferred<void>();
    mocks.list.mockImplementationOnce(() => {
      entered.resolve();
      return old.promise;
    });
    const a = useAgentJobsStore.getState().refresh();
    await entered.promise;
    mocks.cancel.mockResolvedValueOnce({ status: 204 });
    mocks.list.mockResolvedValueOnce(
      collection([{ ...JOB, state: 'canceled', can_cancel: false }], 0, 1, false)
    );
    vi.setSystemTime(NOW + 1000);
    await useAgentJobsStore.getState().cancel(JOB.id);
    old.resolve(collection([JOB]));
    await a;
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ state: 'canceled' })],
      activeCount: 0,
      terminalCount: 1,
      historyComplete: false,
      observedAtMs: NOW + 1000,
      collectionStale: false,
    });
  });

  it('does not infer terminal cancellation from204 and accepts a later genuine native terminal update', async () => {
    mocks.cancel.mockResolvedValueOnce({ status: 204 });
    mocks.list.mockResolvedValueOnce(collection([{ ...JOB, can_cancel: false }]));
    await useAgentJobsStore.getState().cancel(JOB.id);
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ state: 'running', can_cancel: false })],
      activeCount: 1,
      terminalCount: 0,
    });
    mocks.list.mockResolvedValueOnce(
      collection([{ ...JOB, state: 'canceled', can_cancel: false }], 0, 1)
    );
    await useAgentJobsStore.getState().refresh();
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ state: 'canceled' })],
      activeCount: 0,
      terminalCount: 1,
      collectionStale: false,
    });
  });

  it('leaves a failed post-ack refresh stale without converting the accepted Stop into terminal state', async () => {
    mocks.list.mockResolvedValueOnce(collection([JOB]));
    await useAgentJobsStore.getState().refresh();
    mocks.cancel.mockResolvedValueOnce({ status: 204 });
    mocks.list.mockRejectedValueOnce(new Error('post-ack read failed'));
    await useAgentJobsStore.getState().cancel(JOB.id);
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [JOB],
      activeCount: 1,
      terminalCount: 0,
      observedAtMs: NOW,
      collectionStale: true,
      error: 'post-ack read failed',
    });
  });

  it('ignores a collection received during a pending owner Stop call', async () => {
    mocks.list.mockResolvedValueOnce(collection([JOB]));
    await useAgentJobsStore.getState().refresh();
    const ack = deferred<{ status: number }>();
    const entered = deferred<void>();
    mocks.cancel.mockImplementationOnce(() => {
      entered.resolve();
      return ack.promise;
    });
    const stop = useAgentJobsStore.getState().cancel(JOB.id);
    await entered.promise;
    mocks.list.mockResolvedValueOnce(collection([{ ...JOB, state: 'canceled' }], 0, 1));
    await useAgentJobsStore.getState().refresh();
    expect(useAgentJobsStore.getState().jobs).toEqual([JOB]);
    expect(useAgentJobsStore.getState().collectionStale).toBe(true);
    mocks.list.mockResolvedValueOnce(collection([{ ...JOB, state: 'canceled' }], 0, 1));
    ack.resolve({ status: 204 });
    await stop;
    expect(useAgentJobsStore.getState().jobs[0].state).toBe('canceled');
  });

  it('ignores an older failure after a newer native collection has succeeded', async () => {
    const old = deferred<ReturnType<typeof collection>>();
    const entered = deferred<void>();
    mocks.list.mockImplementationOnce(() => {
      entered.resolve();
      return old.promise;
    });
    const a = useAgentJobsStore.getState().refresh();
    await entered.promise;
    mocks.list.mockResolvedValueOnce(
      collection([{ ...JOB, state: 'succeeded', can_cancel: false }], 0, 1)
    );
    await useAgentJobsStore.getState().refresh();
    old.reject(new Error('obsolete read'));
    await a;
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ state: 'succeeded' })],
      error: null,
      collectionStale: false,
    });
  });

  it('retains the newer failure and old rows when an obsolete native success arrives', async () => {
    mocks.list.mockResolvedValueOnce(collection([JOB]));
    await useAgentJobsStore.getState().refresh();
    const old = deferred<ReturnType<typeof collection>>();
    const entered = deferred<void>();
    mocks.list.mockImplementationOnce(() => {
      entered.resolve();
      return old.promise;
    });
    const a = useAgentJobsStore.getState().refresh();
    await entered.promise;
    mocks.list.mockRejectedValueOnce(new Error('current failure'));
    vi.setSystemTime(NOW + 500);
    await useAgentJobsStore.getState().refresh();
    old.resolve(collection([{ ...JOB, state: 'canceled' }], 0, 1));
    await a;
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [JOB],
      activeCount: 1,
      error: 'current failure',
      observedAtMs: NOW,
      collectionStale: true,
    });
  });

  it('retires pending native collections across both reset and runtime change', async () => {
    const old = deferred<ReturnType<typeof collection>>();
    const entered = deferred<void>();
    mocks.list.mockImplementationOnce(() => {
      entered.resolve();
      return old.promise;
    });
    const a = useAgentJobsStore.getState().refresh();
    await entered.promise;
    useAgentJobsStore.getState().resetForTests();
    old.resolve(collection([JOB]));
    await a;
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [],
      observedAtMs: null,
      collectionStale: true,
    });
    const late = deferred<ReturnType<typeof collection>>();
    const ready = deferred<void>();
    mocks.list.mockImplementationOnce(() => {
      ready.resolve();
      return late.promise;
    });
    const b = useAgentJobsStore.getState().refresh();
    await ready.promise;
    useAgentJobsStore.getState().invalidateRuntime();
    mocks.list.mockResolvedValueOnce(collection([{ ...JOB, id: 'new-runtime' }]));
    await useAgentJobsStore.getState().refresh();
    late.reject(new Error('old-runtime failure'));
    await b;
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ id: 'new-runtime' })],
      error: null,
      collectionStale: false,
    });
  });

  it('refuses to send Stop after its runtime changed during authority configuration', async () => {
    const configured = deferred<void>();
    mocks.configure.mockReturnValueOnce(configured.promise);
    const stop = useAgentJobsStore.getState().cancel(JOB.id);
    useAgentJobsStore.getState().invalidateRuntime();
    configured.resolve();
    await expect(stop).rejects.toThrow('Jobs runtime changed');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('does not publish or reconcile an old-runtime Stop acknowledgment into the new mirror', async () => {
    const ack = deferred<{ status: number }>();
    const entered = deferred<void>();
    mocks.cancel.mockImplementationOnce(() => {
      entered.resolve();
      return ack.promise;
    });
    const stop = useAgentJobsStore.getState().cancel(JOB.id);
    await entered.promise;
    useAgentJobsStore.getState().invalidateRuntime();
    mocks.list.mockResolvedValueOnce(collection([{ ...JOB, id: 'current-runtime' }]));
    await useAgentJobsStore.getState().refresh();
    ack.resolve({ status: 204 });
    await expect(stop).rejects.toThrow('Jobs runtime changed');
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ id: 'current-runtime' })],
      collectionStale: false,
    });
  });

  it('propagates a real Stop refusal without inventing cancellation or fresh coverage', async () => {
    mocks.list.mockResolvedValueOnce(collection([JOB]));
    await useAgentJobsStore.getState().refresh();
    const refusal = new Error('owner refused');
    mocks.cancel.mockRejectedValueOnce(refusal);
    await expect(useAgentJobsStore.getState().cancel(JOB.id)).rejects.toBe(refusal);
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [JOB],
      activeCount: 1,
      collectionStale: true,
    });
  });
  it('retains a successful collection receipt and its bounded history metadata', async () => {
    mocks.list.mockResolvedValue({
      status: 200,
      data: {
        jobs: [JOB],
        job_count: 1,
        active_count: 1,
        terminal_count: 0,
        history_complete: true,
      },
    });

    await useAgentJobsStore.getState().refresh();

    expect(mocks.configure).toHaveBeenCalledWith('Agent jobs');
    expect(mocks.list).toHaveBeenCalledWith({ limit: 200, offset: 0 });
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [JOB],
      jobCount: 1,
      activeCount: 1,
      terminalCount: 0,
      historyComplete: true,
      loading: false,
      error: null,
      observedAtMs: NOW,
    });
  });

  it('keeps the last receipt when refresh fails', async () => {
    mocks.list
      .mockResolvedValueOnce({
        status: 200,
        data: {
          jobs: [JOB],
          job_count: 1,
          active_count: 1,
          terminal_count: 0,
          history_complete: true,
        },
      })
      .mockRejectedValueOnce(new Error('agent jobs unavailable'));
    await useAgentJobsStore.getState().refresh();
    vi.setSystemTime(NOW + 30_000);

    await useAgentJobsStore.getState().refresh();

    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [JOB],
      error: 'agent jobs unavailable',
      observedAtMs: NOW,
    });
  });

  it('cancels through the agent owner and refreshes the collection receipt', async () => {
    mocks.cancel.mockResolvedValue({ status: 204, data: undefined });
    mocks.list.mockResolvedValue({
      status: 200,
      data: {
        jobs: [{ ...JOB, state: 'canceled', can_cancel: false }],
        job_count: 1,
        active_count: 0,
        terminal_count: 1,
        history_complete: true,
      },
    });

    await useAgentJobsStore.getState().cancel('action-1');

    expect(mocks.cancel).toHaveBeenCalledWith('action-1');
    expect(useAgentJobsStore.getState()).toMatchObject({
      jobs: [expect.objectContaining({ id: 'action-1', state: 'canceled' })],
      activeCount: 0,
      terminalCount: 1,
    });
  });
});
