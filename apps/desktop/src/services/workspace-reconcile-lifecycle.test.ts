// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  runTrackedWorkspaceReconcile,
  waitForWorkspaceReconcileIdle,
} from './workspace-reconcile-lifecycle';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe('workspace reconciliation lifecycle', () => {
  it('serializes same-root work while allowing unrelated roots to reconcile independently', async () => {
    const first = deferred();
    const second = deferred();
    const unrelated = deferred();
    const starts: string[] = [];
    const firstRun = runTrackedWorkspaceReconcile('/workspace', () => {
      starts.push('first');
      return first.promise;
    });
    const secondRun = runTrackedWorkspaceReconcile('/workspace', () => {
      starts.push('second');
      return second.promise;
    });
    const unrelatedRun = runTrackedWorkspaceReconcile('/other', () => {
      starts.push('unrelated');
      return unrelated.promise;
    });
    const idle = vi.fn();
    const waiting = waitForWorkspaceReconcileIdle('/workspace').then(idle);

    await Promise.resolve();
    await Promise.resolve();
    expect(starts).toEqual(['first', 'unrelated']);

    first.resolve();
    await firstRun;
    await Promise.resolve();
    expect(starts).toEqual(['first', 'unrelated', 'second']);
    expect(idle).not.toHaveBeenCalled();

    second.resolve();
    await secondRun;
    await waiting;
    expect(idle).toHaveBeenCalledOnce();

    unrelated.resolve();
    await unrelatedRun;
  });

  it('removes a failed reconciliation from the idle barrier without hiding its error', async () => {
    const failure = new Error('reconcile failed');
    await expect(
      runTrackedWorkspaceReconcile('/failed-workspace', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    await expect(waitForWorkspaceReconcileIdle('/failed-workspace')).resolves.toBeUndefined();
  });

  it('lets a lease-holding operation bypass the order queue while the idle barrier still covers it', async () => {
    const root = '/lease-holder-workspace';
    const blockedPredecessor = deferred();
    const starts: string[] = [];
    const queued = runTrackedWorkspaceReconcile(root, () => {
      starts.push('token-less');
      return blockedPredecessor.promise;
    });
    const nested = runTrackedWorkspaceReconcile(
      root,
      async () => {
        starts.push('nested');
        return 'nested-done';
      },
      { ordered: false }
    );
    const idle = vi.fn();
    const waiting = waitForWorkspaceReconcileIdle(root).then(idle);

    await expect(nested).resolves.toBe('nested-done');
    expect(starts).toHaveLength(2);
    expect(starts).toEqual(expect.arrayContaining(['token-less', 'nested']));
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();

    const later = runTrackedWorkspaceReconcile(root, async () => {
      starts.push('later');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(starts).not.toContain('later');

    blockedPredecessor.resolve();
    await queued;
    await later;
    await waiting;
    expect(starts.at(-1)).toBe('later');
    expect(idle).toHaveBeenCalledOnce();
  });

  it('runs queued work after an earlier same-root failure', async () => {
    const calls: string[] = [];
    const first = runTrackedWorkspaceReconcile('/workspace', async () => {
      calls.push('failed');
      throw new Error('first failed');
    });
    const second = runTrackedWorkspaceReconcile('/workspace', async () => {
      calls.push('recovered');
      return 'ok';
    });

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('ok');
    expect(calls).toEqual(['failed', 'recovered']);
  });
});
