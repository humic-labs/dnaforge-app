import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  selectWorkspaceRows: vi.fn(),
  beginWorkspaceMutation: vi.fn(),
  endWorkspaceMutation: vi.fn(),
  reconcileWorkspaceRoot: vi.fn(),
  reconcileWorkspaceEntities: vi.fn(),
  execute: vi.fn(),
  reconcileAcceptedScientificProjections: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    shell: { execute: mocks.execute },
    db: {
      select: mocks.selectWorkspaceRows,
    },
    fs: {
      exists: mocks.exists,
      beginWorkspaceMutation: mocks.beginWorkspaceMutation,
      endWorkspaceMutation: mocks.endWorkspaceMutation,
    },
  }),
}));

vi.mock('./workspace-reconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-reconcile')>()),
  reconcileWorkspaceRoot: mocks.reconcileWorkspaceRoot,
}));

vi.mock('../db/entity-substrate/reconcile-entities', () => ({
  reconcileWorkspaceEntities: mocks.reconcileWorkspaceEntities,
}));
vi.mock('./reconcile-scientific-projections', () => ({
  reconcileAcceptedScientificProjections: mocks.reconcileAcceptedScientificProjections,
}));

import {
  acquireWorkspaceMutationShared,
  acquireWorkspaceSyncMutationLease,
} from '../main/workspace-sync-mutation-lease';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertRendererDatabaseStatementAllowed,
} from '../main/workspace-sync-database-fence';
import { createTestDb } from '../main/__tests__/test-db';
import { reconcileMountedWorkspaceRoot } from './mounted-workspace-reconcile';
import type { WorkspaceReconcileResult } from './workspace-reconcile';

function workspaceReconcileResult(
  root: string,
  errors: WorkspaceReconcileResult['errors'] = [],
  primerArtifactErrors: WorkspaceReconcileResult['primerArtifactErrors'] = []
): WorkspaceReconcileResult {
  return {
    scanned: 1,
    registered: 1,
    repaired: 0,
    missing: 0,
    externalMovesRelinked: 0,
    externalMovesAmbiguous: 0,
    primerArtifactsDiscovered: 0,
    primerArtifactsReconciled: 0,
    primerArtifactErrors,
    entityArtifactCandidatePaths: [`${root}/notes/retried.notebook/meta.json`],
    errors,
  };
}

function databaseBusyFailure(
  db: ReturnType<typeof createTestDb>,
  path: string
): { path: string; message: string } {
  try {
    assertRendererDatabaseStatementAllowed(db);
  } catch (error) {
    return { path, message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error('Expected the workspace sync database fence to reject the renderer statement.');
}

describe('reconcileMountedWorkspaceRoot', () => {
  const mutationReleases = new Map<string, () => void>();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reconcileAcceptedScientificProjections.mockResolvedValue({ paths: [], resourceIds: [] });
    mocks.exists.mockResolvedValue(true);
    mocks.selectWorkspaceRows.mockResolvedValue([]);
    mocks.execute.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    mocks.beginWorkspaceMutation.mockImplementation(async (workspaceRoot: string) => {
      const token = crypto.randomUUID();
      mutationReleases.set(token, await acquireWorkspaceMutationShared(workspaceRoot));
      return token;
    });
    mocks.endWorkspaceMutation.mockImplementation(async (token: string) => {
      mutationReleases.get(token)?.();
      mutationReleases.delete(token);
    });
  });

  afterEach(() => {
    for (const release of mutationReleases.values()) release();
    mutationReleases.clear();
  });

  describe('Registry projection history', () => {
    let root: string;
    const runGit = (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'fixture-reconcile-history-'));
      runGit(['init', '--quiet']);
      runGit(['config', 'user.name', 'DNAForge Test']);
      runGit(['config', 'user.email', 'test@dnaforge.invalid']);
      mkdirSync(join(root, '.waypoint/lims/log'), { recursive: true });
      writeFileSync(join(root, '.waypoint/lims/manifest.json'), '{"revision":1}\n');
      writeFileSync(join(root, '.waypoint/lims/log/history.jsonl'), '{"saved":1}\n');
      runGit(['add', '.']);
      runGit(['commit', '--quiet', '-m', 'Saved sequence before reconstruction']);
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it.each([true, false])(
      'captures completed Registry projections in project history only when local healing is enabled (%s)',
      async (healManagedHead) => {
        mocks.reconcileWorkspaceRoot.mockResolvedValue(workspaceReconcileResult(root));
        mocks.reconcileWorkspaceEntities.mockImplementation(async () => {
          writeFileSync(join(root, '.waypoint/lims/manifest.json'), '{"revision":2}\n');
          writeFileSync(join(root, '.waypoint/lims/log/history.jsonl'), '{"saved":2}\n');
          writeFileSync(join(root, 'unrelated.txt'), 'Keep this outside the projection commit.');
          return { scanned: 1, reconciled: 1, conflicts: 0, errors: [] };
        });
        mocks.execute.mockImplementation(async (command, args, cwd, mutationToken) => {
          expect(command).toBe('git');
          expect(cwd).toBe(root);
          expect(mutationReleases.has(mutationToken)).toBe(true);
          return {
            code: 0,
            stdout: execFileSync('git', args, { cwd: root, encoding: 'utf8' }),
            stderr: '',
          };
        });

        await reconcileMountedWorkspaceRoot(root, { healManagedHead });

        expect(runGit(['show', 'HEAD:.waypoint/lims/manifest.json'])).toBe(
          healManagedHead ? '{"revision":2}' : '{"revision":1}'
        );
        expect(runGit(['show', 'HEAD:.waypoint/lims/log/history.jsonl'])).toBe(
          healManagedHead ? '{"saved":2}' : '{"saved":1}'
        );
        expect(runGit(['ls-files', '--', 'unrelated.txt'])).toBe('');
        expect(mutationReleases.size).toBe(0);
        if (healManagedHead) {
          expect(runGit(['status', '--porcelain'])).toBe('?? unrelated.txt');
        } else {
          expect(mocks.execute).not.toHaveBeenCalled();
        }
      }
    );
  });

  it('does not admit a replica until catalog and entity projections both finish', async () => {
    const root = `/tmp/mounted-workspace-${crypto.randomUUID()}`;
    const result = workspaceReconcileResult(root);
    result.entityArtifactCandidatePaths = [`${root}/notes/experiment.notebook/meta.json`];
    mocks.reconcileWorkspaceRoot.mockResolvedValue(result);
    let finishEntities: (() => void) | undefined;
    mocks.reconcileWorkspaceEntities.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishEntities = () =>
            resolve({ scanned: 1, reconciled: 1, skipped: 0, conflicts: 0, errors: [] });
        })
    );

    const reconciling = reconcileMountedWorkspaceRoot(root, {
      waitForMutationAvailability: true,
    });
    await vi.waitFor(() => expect(mocks.reconcileWorkspaceEntities).toHaveBeenCalledOnce());

    let replicaEntered = false;
    const replica = acquireWorkspaceSyncMutationLease(root).then((release) => {
      replicaEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(replicaEntered).toBe(false);

    finishEntities?.();
    await expect(reconciling).resolves.toMatchObject({
      result: { registered: 1 },
      entityResult: { reconciled: 1 },
    });
    const releaseReplica = await replica;
    expect(replicaEntered).toBe(true);
    releaseReplica();

    expect(mocks.reconcileWorkspaceRoot).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ mutationToken: expect.any(String) })
    );
    expect(mocks.reconcileWorkspaceEntities).toHaveBeenCalledWith(root, {
      signal: undefined,
      candidatePaths: [`${root}/notes/experiment.notebook/meta.json`],
      mutationToken: expect.any(String),
      acceptedPaths: [],
    });
  });

  it('reconstructs accepted native records before file adapters and retains the same mutation authority', async () => {
    const root = `/tmp/mounted-workspace-${crypto.randomUUID()}`;
    mocks.reconcileWorkspaceRoot.mockResolvedValue(workspaceReconcileResult(root));
    mocks.reconcileAcceptedScientificProjections.mockResolvedValue({
      paths: [`${root}/child.entity.json`],
      resourceIds: ['child'],
    });
    mocks.reconcileWorkspaceEntities.mockResolvedValue({
      scanned: 1,
      reconciled: 1,
      conflicts: 0,
      errors: [],
    });
    await reconcileMountedWorkspaceRoot(root, { mutationToken: 'caller-token' });
    expect(mocks.reconcileAcceptedScientificProjections).toHaveBeenCalledWith(root, 'caller-token');
    expect(mocks.reconcileWorkspaceEntities).toHaveBeenCalledWith(
      root,
      expect.objectContaining({
        mutationToken: 'caller-token',
        acceptedPaths: [`${root}/child.entity.json`],
      })
    );
    expect(mocks.reconcileAcceptedScientificProjections.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reconcileWorkspaceEntities.mock.invocationCallOrder[0]
    );
    mocks.reconcileAcceptedScientificProjections.mockRejectedValue(
      new Error('accepted projection unavailable')
    );
    mocks.reconcileWorkspaceEntities.mockClear();
    await expect(
      reconcileMountedWorkspaceRoot(root, { mutationToken: 'caller-token', strict: true })
    ).rejects.toThrow(/accepted projection unavailable/iu);
    expect(mocks.reconcileWorkspaceEntities).not.toHaveBeenCalled();
  });

  it('forwards a caller-owned mutation token and strict projection options', async () => {
    const root = `/tmp/mounted-workspace-${crypto.randomUUID()}`;
    mocks.reconcileWorkspaceRoot.mockResolvedValue(workspaceReconcileResult(root));
    mocks.reconcileWorkspaceEntities.mockResolvedValue({
      scanned: 1,
      reconciled: 1,
      conflicts: 0,
      errors: [],
    });

    await expect(
      reconcileMountedWorkspaceRoot(root, {
        mutationToken: 'caller-token',
        healManagedHead: true,
        strict: true,
        waitForMutationAvailability: true,
      })
    ).resolves.toMatchObject({ entityResult: { reconciled: 1 } });

    expect(mocks.beginWorkspaceMutation).not.toHaveBeenCalled();
    expect(mocks.reconcileWorkspaceRoot).toHaveBeenCalledWith(root, {
      signal: undefined,
      mutationToken: 'caller-token',
      healManagedHead: true,
      strict: true,
      acceptedPaths: [],
      acceptedResourceIds: [],
    });
    expect(mocks.reconcileWorkspaceEntities).toHaveBeenCalledWith(root, {
      signal: undefined,
      candidatePaths: [`${root}/notes/retried.notebook/meta.json`],
      mutationToken: 'caller-token',
      acceptedPaths: [],
    });
  });

  it('rejects required reconstruction when file and app content remain in conflict', async () => {
    const root = `/tmp/mounted-workspace-${crypto.randomUUID()}`;
    mocks.reconcileWorkspaceRoot.mockResolvedValue(workspaceReconcileResult(root));
    mocks.reconcileWorkspaceEntities.mockResolvedValue({
      scanned: 1,
      reconciled: 0,
      conflicts: 1,
      conflictDetails: [
        { id: 'record-1', path: `${root}/sample.entity.json`, reason: 'both-changed' },
      ],
      errors: [],
    });
    await expect(reconcileMountedWorkspaceRoot(root, { strict: true })).rejects.toThrow(
      /sample\.entity\.json.*conflict/i
    );
    expect(mocks.endWorkspaceMutation).toHaveBeenCalledOnce();
  });

  it('retries workspace B after workspace A releases the global database fence', async () => {
    const db = createTestDb();
    const workspaceA = `/tmp/syncing-workspace-${crypto.randomUUID()}`;
    const workspaceB = `/tmp/mounted-workspace-${crypto.randomUUID()}`;
    const releaseWorkspaceAFence = await acquireWorkspaceSyncDatabaseFence(db);
    let notifyFirstAttempt: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      notifyFirstAttempt = resolve;
    });
    const result = workspaceReconcileResult(workspaceB);
    mocks.reconcileWorkspaceRoot.mockImplementation(async (rootPath: string) => {
      expect(rootPath).toBe(workspaceB);
      notifyFirstAttempt?.();
      assertRendererDatabaseStatementAllowed(db);
      return result;
    });
    mocks.reconcileWorkspaceEntities.mockResolvedValue({
      scanned: 1,
      reconciled: 1,
      skipped: 0,
      conflicts: 0,
      errors: [],
    });

    try {
      const mountingWorkspaceB = reconcileMountedWorkspaceRoot(workspaceB, {
        waitForMutationAvailability: true,
      });
      await firstAttempt;
      expect(mocks.reconcileWorkspaceRoot).toHaveBeenCalledOnce();
      expect(mocks.reconcileWorkspaceEntities).not.toHaveBeenCalled();

      releaseWorkspaceAFence();
      await expect(mountingWorkspaceB).resolves.toMatchObject({
        result: { registered: 1 },
        entityResult: { reconciled: 1 },
      });

      expect(workspaceA).not.toBe(workspaceB);
      expect(mocks.reconcileWorkspaceRoot).toHaveBeenCalledTimes(2);
      expect(mocks.beginWorkspaceMutation).toHaveBeenCalledTimes(2);
      expect(mocks.endWorkspaceMutation).toHaveBeenCalledTimes(2);
    } finally {
      releaseWorkspaceAFence();
      db.close();
    }
  });

  it('retries when workspace A fences SQLite during workspace B catalog projection', async () => {
    const db = createTestDb();
    const workspaceB = `/tmp/mounted-workspace-${crypto.randomUUID()}`;
    let releaseWorkspaceAFence: (() => void) | undefined;
    let notifyCatalogFailure: (() => void) | undefined;
    const catalogFailureReturned = new Promise<void>((resolve) => {
      notifyCatalogFailure = resolve;
    });
    mocks.reconcileWorkspaceRoot.mockImplementation(async () => {
      if (!releaseWorkspaceAFence) {
        releaseWorkspaceAFence = await acquireWorkspaceSyncDatabaseFence(db);
        const failure = databaseBusyFailure(db, `${workspaceB}/sequence.gb`);
        notifyCatalogFailure?.();
        return workspaceReconcileResult(workspaceB, [failure]);
      }
      return workspaceReconcileResult(workspaceB);
    });
    mocks.reconcileWorkspaceEntities.mockResolvedValue({
      scanned: 1,
      reconciled: 1,
      conflicts: 0,
      errors: [],
    });

    try {
      const mountingWorkspaceB = reconcileMountedWorkspaceRoot(workspaceB, {
        waitForMutationAvailability: true,
      });
      await catalogFailureReturned;
      expect(mocks.reconcileWorkspaceEntities).not.toHaveBeenCalled();

      releaseWorkspaceAFence?.();
      await expect(mountingWorkspaceB).resolves.toMatchObject({
        result: { registered: 1, errors: [] },
        entityResult: { reconciled: 1 },
      });
      expect(mocks.reconcileWorkspaceRoot).toHaveBeenCalledTimes(2);
      expect(mocks.reconcileWorkspaceEntities).toHaveBeenCalledOnce();
    } finally {
      releaseWorkspaceAFence?.();
      db.close();
    }
  });

  it('retries the whole mount when workspace A fences SQLite during entity projection', async () => {
    const db = createTestDb();
    const workspaceB = `/tmp/mounted-workspace-${crypto.randomUUID()}`;
    let releaseWorkspaceAFence: (() => void) | undefined;
    let notifyEntityFailure: (() => void) | undefined;
    const entityFailureReturned = new Promise<void>((resolve) => {
      notifyEntityFailure = resolve;
    });
    mocks.reconcileWorkspaceRoot.mockImplementation(async () =>
      workspaceReconcileResult(workspaceB)
    );
    mocks.reconcileWorkspaceEntities.mockImplementation(async () => {
      if (!releaseWorkspaceAFence) {
        releaseWorkspaceAFence = await acquireWorkspaceSyncDatabaseFence(db);
        const failure = databaseBusyFailure(db, `${workspaceB}/notes/retried.notebook/meta.json`);
        notifyEntityFailure?.();
        return { scanned: 1, reconciled: 0, conflicts: 0, errors: [failure] };
      }
      return { scanned: 1, reconciled: 1, conflicts: 0, errors: [] };
    });

    try {
      const mountingWorkspaceB = reconcileMountedWorkspaceRoot(workspaceB, {
        waitForMutationAvailability: true,
      });
      await entityFailureReturned;
      expect(mocks.reconcileWorkspaceEntities).toHaveBeenCalledOnce();

      releaseWorkspaceAFence?.();
      await expect(mountingWorkspaceB).resolves.toMatchObject({
        result: { registered: 1 },
        entityResult: { reconciled: 1, errors: [] },
      });
      expect(mocks.reconcileWorkspaceRoot).toHaveBeenCalledTimes(2);
      expect(mocks.reconcileWorkspaceEntities).toHaveBeenCalledTimes(2);
    } finally {
      releaseWorkspaceAFence?.();
      db.close();
    }
  });

  it('retries an unmanaged mount when startup registration temporarily owns the workspace', async () => {
    const root = `/tmp/unmanaged-workspace-${crypto.randomUUID()}`;
    mocks.exists.mockResolvedValue(false);
    mocks.reconcileWorkspaceRoot.mockResolvedValue(workspaceReconcileResult(root));
    mocks.reconcileWorkspaceEntities
      .mockResolvedValueOnce({
        scanned: 1,
        reconciled: 0,
        conflicts: 0,
        errors: [
          {
            path: `${root}/notes/retried.notebook/meta.json`,
            message:
              "Error invoking remote method 'fs:migrateNotebookPackageAtPath': Error: WORKSPACE_SYNC_MUTATION_BUSY: another workspace mutation is active.",
          },
        ],
      })
      .mockResolvedValueOnce({
        scanned: 1,
        reconciled: 1,
        conflicts: 0,
        errors: [],
      });

    await expect(
      reconcileMountedWorkspaceRoot(root, { waitForMutationAvailability: true })
    ).resolves.toMatchObject({
      result: { registered: 1 },
      entityResult: { reconciled: 1, errors: [] },
    });

    expect(mocks.reconcileWorkspaceRoot).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileWorkspaceEntities).toHaveBeenCalledTimes(2);
    expect(mocks.beginWorkspaceMutation).not.toHaveBeenCalled();
  });
});
