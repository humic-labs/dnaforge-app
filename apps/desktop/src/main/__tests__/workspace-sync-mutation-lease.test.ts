import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceMutationCapabilityRegistry } from '../ipc/workspace-mutation-capability';

import {
  MAX_WORKSPACE_MUTATION_WAITERS_PER_ROOT,
  acquireWorkspaceMutationShared,
  acquireWorkspaceSyncMutationLease,
  acquireWorkspaceSyncReplicaApplyLease,
  assertWorkspaceMutationLease,
  findKnownWorkspaceRoot,
  hasWorkspaceSyncMutationLeaseForTest,
  isWorkspaceSyncReplicaApplying,
  tryAcquireWorkspaceMutationShared,
  subscribeWorkspaceMutationReleased,
  workspaceMutationRootIdentity,
  waitForWorkspaceMutationShared,
  withKnownWorkspacePathMutation,
} from '../workspace-sync-mutation-lease';

const temporaryRoots: string[] = [];

function fakeDb(paths: string[]): Database.Database {
  return {
    prepare: () => ({ all: () => paths.map((path) => ({ path })) }),
  } as unknown as Database.Database;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace sync mutation lease', () => {
  it('notifies only after the outer capability and its borrowed operations release the owning lease', async () => {
    const root = `/tmp/dnaforge-publication-release-${crypto.randomUUID()}`;
    const identity = workspaceMutationRootIdentity(root);
    const observed: string[] = [];
    const unsubscribe = subscribeWorkspaceMutationReleased((path) => {
      observed.push(path);
    });
    const capabilities = new WorkspaceMutationCapabilityRegistry();
    const release = await acquireWorkspaceMutationShared(root);
    const token = capabilities.issue(17, identity, release);
    try {
      await capabilities.runWithToken(token, 17, identity, async () => undefined);
      expect(observed).toEqual([]);
      let complete!: () => void;
      const blocked = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const borrowing = capabilities.runWithToken(token, 17, identity, async () => {
        await blocked;
      });
      capabilities.release(token, 17);
      expect(observed).toEqual([]);
      complete();
      await borrowing;
      expect(observed).toEqual([identity]);
      release();
      expect(observed).toEqual([identity]);
    } finally {
      capabilities.releaseOwner(17);
      release();
      unsubscribe();
    }
  });

  it('reports only an acquired replica lease, scoped to its canonical workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-replica-status-'));
    temporaryRoots.push(root);
    const project = join(root, 'project');
    const alias = join(root, 'alias');
    mkdirSync(project);
    symlinkSync(project, alias);
    const releaseWriter = await acquireWorkspaceMutationShared(project);
    const queuedReplica = acquireWorkspaceSyncReplicaApplyLease(alias);
    expect(isWorkspaceSyncReplicaApplying(project)).toBe(false);
    releaseWriter();

    const releaseReplica = await queuedReplica;
    try {
      expect(() => assertWorkspaceMutationLease(releaseReplica, project)).not.toThrow();
      expect(isWorkspaceSyncReplicaApplying(project)).toBe(true);
      expect(isWorkspaceSyncReplicaApplying(alias)).toBe(true);
      expect(isWorkspaceSyncReplicaApplying(join(root, 'other-project'))).toBe(false);
    } finally {
      releaseReplica();
    }
    expect(isWorkspaceSyncReplicaApplying(project)).toBe(false);
    expect(() => assertWorkspaceMutationLease(releaseReplica, project)).toThrow(
      'WORKSPACE_MUTATION_LEASE_INVALID'
    );
  });

  it('does not mistake another exclusive operation for replica replacement or clear a newer lease', async () => {
    const root = `/tmp/dnaforge-replica-release-${crypto.randomUUID()}`;
    const releaseOther = await acquireWorkspaceSyncMutationLease(root);
    expect(isWorkspaceSyncReplicaApplying(root)).toBe(false);
    releaseOther();
    const releaseFirst = await acquireWorkspaceSyncReplicaApplyLease(root);
    releaseFirst();
    const releaseSecond = await acquireWorkspaceSyncReplicaApplyLease(root);
    try {
      releaseFirst();
      expect(isWorkspaceSyncReplicaApplying(root)).toBe(true);
    } finally {
      releaseSecond();
    }
    expect(isWorkspaceSyncReplicaApplying(root)).toBe(false);
  });

  it('maps aliased database rows to one physical project regardless of row order', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-project-owner-'));
    temporaryRoots.push(root);
    const project = join(root, 'project');
    const aliasA = join(root, 'alias-a');
    const aliasB = join(root, 'alias-b');
    mkdirSync(project);
    symlinkSync(project, aliasA);
    symlinkSync(project, aliasB);
    const file = join(project, 'sequence.gb');
    writeFileSync(file, 'LOCUS');

    const physicalProject = realpathSync(project);
    expect(findKnownWorkspaceRoot(fakeDb([aliasA, aliasB]), file)).toBe(physicalProject);
    expect(findKnownWorkspaceRoot(fakeDb([aliasB, aliasA]), file)).toBe(physicalProject);
  });

  it('keeps aliased project mutations behind the physical project sync lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dnaforge-project-lease-'));
    temporaryRoots.push(root);
    const project = join(root, 'project');
    const aliasA = join(root, 'alias-a');
    const aliasB = join(root, 'alias-b');
    mkdirSync(project);
    symlinkSync(project, aliasA);
    symlinkSync(project, aliasB);
    const file = join(project, 'sequence.gb');
    writeFileSync(file, 'LOCUS');

    const releaseSync = await acquireWorkspaceSyncMutationLease(project);
    let mutationEntered = false;
    const mutation = withKnownWorkspacePathMutation(fakeDb([aliasB, aliasA]), [file], async () => {
      mutationEntered = true;
    });

    await Promise.resolve();
    expect(mutationEntered).toBe(false);
    releaseSync();
    await mutation;
    expect(mutationEntered).toBe(true);
  });

  it('fails fast when a workspace mutation, sync lease, or earlier waiter exists', async () => {
    const root = `/tmp/dnaforge-workspace-try-${crypto.randomUUID()}`;
    const releaseMutation = await acquireWorkspaceMutationShared(root);
    expect(tryAcquireWorkspaceMutationShared(root)).toBeNull();

    const waitingSync = acquireWorkspaceSyncMutationLease(root);
    expect(tryAcquireWorkspaceMutationShared(root)).toBeNull();

    releaseMutation();
    const releaseSync = await waitingSync;
    expect(tryAcquireWorkspaceMutationShared(root)).toBeNull();
    releaseSync();

    const release = tryAcquireWorkspaceMutationShared(root);
    expect(release).toBeTypeOf('function');
    release?.();
  });

  it('waits for an active workspace writer before granting replica exclusivity', async () => {
    const root = '/tmp/dnaforge-workspace-a/repo';
    const releaseWriter = await acquireWorkspaceMutationShared(root);
    let pullEntered = false;
    const pulling = acquireWorkspaceSyncMutationLease(root).then((release) => {
      pullEntered = true;
      return release;
    });

    await Promise.resolve();
    expect(pullEntered).toBe(false);
    releaseWriter();
    const releasePull = await pulling;
    expect(pullEntered).toBe(true);
    releasePull();
  });

  it('queues a same-workspace mutation during a pull but permits another workspace', async () => {
    const rootA = '/tmp/dnaforge-workspace-a/repo';
    const rootB = '/tmp/dnaforge-workspace-b/repo';
    const releasePull = await acquireWorkspaceSyncMutationLease(rootA);
    expect(hasWorkspaceSyncMutationLeaseForTest(rootA)).toBe(true);

    let writerAEntered = false;
    const writerA = acquireWorkspaceMutationShared(rootA).then((release) => {
      writerAEntered = true;
      return release;
    });
    const releaseWriterB = await acquireWorkspaceMutationShared(rootB);

    await Promise.resolve();
    expect(writerAEntered).toBe(false);
    releaseWriterB();
    releasePull();
    const releaseWriterA = await writerA;
    expect(writerAEntered).toBe(true);
    releaseWriterA();
  });

  it('gives a queued pull priority before a later foreground mutation', async () => {
    const root = '/tmp/dnaforge-workspace-c/repo';
    const releaseFirstWriter = await acquireWorkspaceMutationShared(root);
    const order: string[] = [];
    const pull = acquireWorkspaceSyncMutationLease(root).then((release) => {
      order.push('pull');
      return release;
    });
    const laterWriter = acquireWorkspaceMutationShared(root).then((release) => {
      order.push('later-writer');
      return release;
    });

    releaseFirstWriter();
    const releasePull = await pull;
    expect(order).toEqual(['pull']);
    releasePull();
    releasePull();
    const releaseLaterWriter = await laterWriter;
    expect(order).toEqual(['pull', 'later-writer']);
    releaseLaterWriter();
  });

  it('serializes concurrent renderer mutations in the same workspace', async () => {
    const root = '/tmp/dnaforge-workspace-d/repo';
    const releaseFirstMutation = await acquireWorkspaceMutationShared(root);
    let nextMutationEntered = false;
    const nextMutation = acquireWorkspaceMutationShared(root).then((release) => {
      nextMutationEntered = true;
      return release;
    });

    await Promise.resolve();
    expect(nextMutationEntered).toBe(false);

    releaseFirstMutation();
    const releaseNextMutation = await nextMutation;
    expect(nextMutationEntered).toBe(true);
    releaseNextMutation();
  });

  it('queues passive reconciliation without admitting two renderer mutations together', async () => {
    const root = '/tmp/dnaforge-workspace-e/repo';
    const releaseFirstMutation = await acquireWorkspaceMutationShared(root);
    let firstReconcileEntered = false;
    let secondReconcileEntered = false;
    const firstReconcile = waitForWorkspaceMutationShared(root).then((release) => {
      firstReconcileEntered = true;
      return release;
    });
    const secondReconcile = waitForWorkspaceMutationShared(root).then((release) => {
      secondReconcileEntered = true;
      return release;
    });

    releaseFirstMutation();
    const releaseFirstReconcile = await firstReconcile;
    expect(firstReconcileEntered).toBe(true);
    expect(secondReconcileEntered).toBe(false);

    releaseFirstReconcile();
    const releaseSecondReconcile = await secondReconcile;
    expect(secondReconcileEntered).toBe(true);
    releaseSecondReconcile();
  });

  it('removes an abandoned passive reconciliation wait when its renderer aborts', async () => {
    const root = `/tmp/dnaforge-workspace-abort-${crypto.randomUUID()}`;
    const releasePull = await acquireWorkspaceSyncMutationLease(root);
    const controller = new AbortController();
    const waiting = waitForWorkspaceMutationShared(root, { signal: controller.signal });

    controller.abort();
    await expect(waiting).rejects.toThrow('WORKSPACE_MUTATION_WAIT_ABORTED');
    releasePull();

    const releaseNext = await acquireWorkspaceMutationShared(root);
    releaseNext();
  });

  it('bounds queued mutation waits for one workspace', async () => {
    const root = `/tmp/dnaforge-workspace-cap-${crypto.randomUUID()}`;
    const releasePull = await acquireWorkspaceSyncMutationLease(root);
    const controllers = Array.from(
      { length: MAX_WORKSPACE_MUTATION_WAITERS_PER_ROOT },
      () => new AbortController()
    );
    const waits = controllers.map((controller) =>
      waitForWorkspaceMutationShared(root, { signal: controller.signal })
    );

    await expect(waitForWorkspaceMutationShared(root)).rejects.toThrow(
      'WORKSPACE_MUTATION_WAIT_QUEUE_FULL'
    );
    for (const controller of controllers) controller.abort();
    const results = await Promise.allSettled(waits);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    releasePull();
  });
});
