import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceSyncReconcileResult } from '../shared/workspace-sync-ipc';
import { WorkspaceSyncReconcileScheduler } from './workspace-sync-reconcile-scheduler';

const NOTHING: WorkspaceSyncReconcileResult = { ok: true, outcome: 'no_remote_change' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('WorkspaceSyncReconcileScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of signals for one project into a single run', async () => {
    const reconcile = vi.fn(async (_uuid: string) => NOTHING);
    const scheduler = new WorkspaceSyncReconcileScheduler({ reconcile, debounceMs: 100 });
    scheduler.schedule('a');
    scheduler.schedule('a');
    scheduler.schedule('a');
    await vi.advanceTimersByTimeAsync(99);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith('a');
  });

  it('keeps projects independent', async () => {
    const reconcile = vi.fn(async (_uuid: string) => NOTHING);
    const scheduler = new WorkspaceSyncReconcileScheduler({ reconcile, debounceMs: 10 });
    scheduler.schedule('a');
    scheduler.schedule('b');
    await vi.advanceTimersByTimeAsync(10);
    expect(reconcile.mock.calls.map(([uuid]) => uuid).sort()).toEqual(['a', 'b']);
  });

  it('joins an in-flight run and schedules exactly one follow-up', async () => {
    const first = deferred<WorkspaceSyncReconcileResult>();
    const reconcile = vi
      .fn<(uuid: string) => Promise<WorkspaceSyncReconcileResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(NOTHING);
    const settled: string[] = [];
    const scheduler = new WorkspaceSyncReconcileScheduler({
      reconcile,
      debounceMs: 10,
      onSettled: (uuid, result) => settled.push(`${uuid}:${result.ok ? 'ok' : result.code}`),
    });

    const running = scheduler.runNow('a');
    expect(scheduler.isRunning('a')).toBe(true);
    const joined = scheduler.runNow('a');
    scheduler.runNow('a');
    expect(joined).toBe(running);
    expect(reconcile).toHaveBeenCalledTimes(1);

    first.resolve(NOTHING);
    await running;
    await vi.advanceTimersByTimeAsync(10);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(settled).toEqual(['a:ok', 'a:ok']);
  });

  it('turns a thrown error into a failed result instead of an unhandled rejection', async () => {
    const reconcile = vi.fn(async () => {
      throw new Error('boom');
    });
    const settled: WorkspaceSyncReconcileResult[] = [];
    const scheduler = new WorkspaceSyncReconcileScheduler({
      reconcile,
      onSettled: (_uuid, result) => settled.push(result),
    });
    const result = await scheduler.runNow('a');
    expect(result).toEqual({ ok: false, code: 'INVALID_REQUEST', message: 'boom' });
    expect(settled).toEqual([result]);
    expect(scheduler.isRunning('a')).toBe(false);
  });

  it('drops pending timers and ignores new signals after stop', async () => {
    const reconcile = vi.fn(async (_uuid: string) => NOTHING);
    const scheduler = new WorkspaceSyncReconcileScheduler({ reconcile, debounceMs: 10 });
    scheduler.schedule('a');
    scheduler.stop();
    scheduler.schedule('b');
    await vi.advanceTimersByTimeAsync(50);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
