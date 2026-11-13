import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reconcileMountedWorkspaceRoot: vi.fn(),
  migrateDatabaseOnlyNotebooksForWorkspace: vi.fn(),
  recordWorkspaceIndex: vi.fn(),
  notifyGitStatusChanged: vi.fn(),
  reportPrimerReconcileFailures: vi.fn(),
  reportEntityReconcileConflicts: vi.fn(),
  isBrowserOnly: vi.fn(() => false),
}));

vi.mock('./mounted-workspace-reconcile', () => ({
  reconcileMountedWorkspaceRoot: mocks.reconcileMountedWorkspaceRoot,
}));
vi.mock('../db/workspace-artifacts', () => ({
  migrateDatabaseOnlyNotebooksForWorkspace: mocks.migrateDatabaseOnlyNotebooksForWorkspace,
}));
vi.mock('../db/workspace-catalog', () => ({
  findWorkspaceRootForPath: (folders: Array<{ path: string }>, path: string | null) =>
    folders.find((folder) => path?.startsWith(`${folder.path}/`))?.path ?? null,
}));
vi.mock('../features/workspace-loader/workspace-telemetry', () => ({
  recordWorkspaceIndex: mocks.recordWorkspaceIndex,
  captureProjectLifecycle: vi.fn(),
  observeProjectLifecyclePhase: vi.fn(),
}));
vi.mock('../hooks/useGitStatus', () => ({
  notifyGitStatusChanged: mocks.notifyGitStatusChanged,
}));
vi.mock('../utils/environment', () => ({ isBrowserOnly: mocks.isBrowserOnly }));
vi.mock('./workspace-reconcile-report', () => ({
  reportPrimerReconcileFailures: mocks.reportPrimerReconcileFailures,
  reportEntityReconcileConflicts: mocks.reportEntityReconcileConflicts,
}));

import { useWorkspaceStore } from '../stores/workspaceStore';
import type { MountedWorkspaceReconcileResult } from './mounted-workspace-reconcile';
import {
  registerWorkspaceDisplayParticipant,
  workspaceDisplayParticipantCount,
} from './workspace-display-participants';
import {
  armWorkspaceOperationFailure,
  disarmWorkspaceOperationFailure,
  workspaceOperationFailureState,
} from './workspace-operation-test-injection';
import { waitForWorkspaceReconcileIdle } from './workspace-reconcile-lifecycle';
import {
  WORKSPACE_RECONCILED_EVENT,
  type WorkspaceReconciledEventDetail,
} from './workspace-reconciled-event';
import {
  reconcileWorkspaceAfterFilesChanged,
  reconcileWorkspaceOnMount,
  resolveReconcileWorkspaceRoot,
  runWorkspaceReconcileOperation,
  WorkspaceDisplayDeliveryError,
} from './workspace-operations';

const ROOT = '/Users/test/lab-workspace';

function durableResult(root: string, visibleFileCount = 7): MountedWorkspaceReconcileResult {
  return {
    result: {
      scanned: 9,
      visibleFileCount,
      registered: 2,
      repaired: 0,
      missing: 0,
      externalMovesRelinked: 0,
      externalMovesAmbiguous: 0,
      primerArtifactsDiscovered: 0,
      primerArtifactsReconciled: 0,
      primerArtifactErrors: [],
      entityArtifactCandidatePaths: [`${root}/notes/a.notebook/meta.json`],
      errors: [],
    },
    entityResult: { scanned: 1, reconciled: 1, skipped: 0, conflicts: 0, errors: [] },
  } as unknown as MountedWorkspaceReconcileResult;
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

describe('workspace operation owner', () => {
  const reconciledEvents: WorkspaceReconciledEventDetail[] = [];
  const onReconciled = (event: Event): void => {
    reconciledEvents.push((event as CustomEvent<WorkspaceReconciledEventDetail>).detail);
  };
  const unregisterParticipants: Array<() => void> = [];
  let revealPath: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    disarmWorkspaceOperationFailure();
    mocks.isBrowserOnly.mockReturnValue(false);
    reconciledEvents.length = 0;
    window.addEventListener(WORKSPACE_RECONCILED_EVENT, onReconciled);
    revealPath = vi.fn();
    useWorkspaceStore.setState({
      folders: [{ path: ROOT, name: 'lab-workspace', addedAt: 1 }],
      fileTreeRefreshToken: 0,
      revealPath: revealPath as unknown as (path: string) => void,
    });
    mocks.reconcileMountedWorkspaceRoot.mockImplementation(async (root: string) =>
      durableResult(root)
    );
    mocks.migrateDatabaseOnlyNotebooksForWorkspace.mockResolvedValue({
      migrated: [],
      recovered: [],
      failed: [],
    });
  });

  afterEach(() => {
    window.removeEventListener(WORKSPACE_RECONCILED_EVENT, onReconciled);
    for (const unregister of unregisterParticipants.splice(0)) unregister();
    disarmWorkspaceOperationFailure();
    vi.restoreAllMocks();
  });

  function participant(impl: Parameters<typeof registerWorkspaceDisplayParticipant>[0]) {
    unregisterParticipants.push(registerWorkspaceDisplayParticipant(impl));
  }

  const baseInput = {
    workspaceRoot: ROOT,
    strict: true,
    catalogSource: 'head' as const,
    healManagedHead: true,
    displayDelivery: 'optional' as const,
  };

  it('runs durable reconstruction with the caller context and completes without any window listener', async () => {
    expect(workspaceDisplayParticipantCount()).toBe(0);
    const result = await runWorkspaceReconcileOperation({
      ...baseInput,
      operationId: 'assembly-finalization:construct-1',
      mutationToken: 'token-1',
      filesChanged: { revealPath: `${ROOT}/assemblies/pkg`, notifyGitStatus: true },
    });

    expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledWith(ROOT, {
      signal: undefined,
      mutationToken: 'token-1',
      healManagedHead: true,
      strict: true,
      waitForMutationAvailability: true,
    });
    expect(result).toMatchObject({
      operationId: 'assembly-finalization:construct-1',
      workspaceRoot: ROOT,
      durable: { result: { registered: 2 } },
      display: { state: 'completed', participants: 0 },
    });
    expect(mocks.recordWorkspaceIndex).toHaveBeenCalledWith(ROOT, 7);
    expect(mocks.reportPrimerReconcileFailures).toHaveBeenCalledWith(ROOT, result.durable.result);
    expect(mocks.reportEntityReconcileConflicts).toHaveBeenCalledWith(
      ROOT,
      result.durable.entityResult
    );
    expect(mocks.notifyGitStatusChanged).toHaveBeenCalledWith(ROOT);
    expect(reconciledEvents).toEqual([{ path: null, workspaceRoot: ROOT }]);
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(1);
    expect(revealPath).toHaveBeenCalledWith(`${ROOT}/assemblies/pkg`);

    expect(revealPath.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.reconcileMountedWorkspaceRoot.mock.invocationCallOrder[0]
    );
  });

  it('mints a workspace-reconcile id when the caller supplies none and hands it to participants', async () => {
    const seen: string[] = [];
    participant(async ({ operationId }) => {
      seen.push(operationId);
    });
    const result = await runWorkspaceReconcileOperation(baseInput);
    expect(result.operationId).toMatch(/^workspace-reconcile:/);
    expect(seen).toEqual([result.operationId]);
  });

  it('does not touch the file tree, Git status, or reveal when the operation is not a file change', async () => {
    await runWorkspaceReconcileOperation({ ...baseInput, strict: false, healManagedHead: false });
    expect(mocks.notifyGitStatusChanged).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(0);
    expect(revealPath).not.toHaveBeenCalled();
    expect(reconciledEvents).toHaveLength(1);
  });

  it('refreshes Git status only when the caller did not already do so', async () => {
    await runWorkspaceReconcileOperation({ ...baseInput, filesChanged: { revealPath: null } });
    expect(mocks.notifyGitStatusChanged).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(1);
  });

  it('waits for a required display participant before completing', async () => {
    const reload = deferred<void>();
    const seen: string[] = [];
    participant(async ({ workspaceRoot, operationId }) => {
      seen.push(`${operationId}@${workspaceRoot}`);
      await reload.promise;
    });
    let settled = false;
    const operation = runWorkspaceReconcileOperation({
      ...baseInput,
      operationId: 'replica-refresh:delivery-1',
      mutationToken: 'main-token',
      healManagedHead: false,
      displayDelivery: 'required',
      filesChanged: {},
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(seen).toEqual([`replica-refresh:delivery-1@${ROOT}`]));
    await Promise.resolve();
    expect(settled).toBe(false);
    reload.resolve();
    await expect(operation).resolves.toMatchObject({
      display: { state: 'completed', participants: 1 },
    });
  });

  it('rejects a required delivery when a participant fails, keeping the durable result attached', async () => {
    participant(async () => {
      throw new Error('registry query failed');
    });
    const failure = await runWorkspaceReconcileOperation({
      ...baseInput,
      operationId: 'replica-refresh:delivery-2',
      mutationToken: 'main-token',
      healManagedHead: false,
      displayDelivery: 'required',
      filesChanged: {},
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkspaceDisplayDeliveryError);
    const typed = failure as WorkspaceDisplayDeliveryError;
    expect(typed.message).toContain('registry query failed');
    expect(typed.operationId).toBe('replica-refresh:delivery-2');
    expect(typed.durable.result.registered).toBe(2);
    expect(typed.errors).toHaveLength(1);

    expect(reconciledEvents).toHaveLength(1);
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(1);
  });

  it('reports an optional display failure in the result instead of failing the operation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    participant(async () => {
      throw new Error('registry view offline');
    });
    const result = await runWorkspaceReconcileOperation({
      ...baseInput,
      operationId: 'assembly-finalization:construct-2',
      mutationToken: 'token-2',
      filesChanged: { revealPath: `${ROOT}/pkg` },
    });
    expect(result.display).toEqual({
      state: 'failed',
      participants: 1,
      errors: [expect.objectContaining({ message: 'registry view offline' })],
    });
    expect(result.durable.result.registered).toBe(2);
    expect(revealPath).toHaveBeenCalledWith(`${ROOT}/pkg`);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('display participant(s) could not refresh'),
      expect.any(Array)
    );
  });

  it('propagates a reconstruction failure before any notification or display work', async () => {
    const participantRan = vi.fn();
    participant(async () => participantRan());
    mocks.reconcileMountedWorkspaceRoot.mockRejectedValueOnce(
      new Error('catalog projection failed')
    );
    await expect(
      runWorkspaceReconcileOperation({ ...baseInput, filesChanged: { revealPath: `${ROOT}/pkg` } })
    ).rejects.toThrow('catalog projection failed');
    expect(participantRan).not.toHaveBeenCalled();
    expect(reconciledEvents).toHaveLength(0);
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(0);
    expect(revealPath).not.toHaveBeenCalled();
    expect(mocks.recordWorkspaceIndex).not.toHaveBeenCalled();
  });

  it('refuses stale completion when the caller is superseded after durable reconstruction', async () => {
    let superseded = false;
    participant(async ({ assertCurrent }) => {
      superseded = true;
      expect(() => assertCurrent()).toThrow('Workspace refresh was superseded.');
    });
    await expect(
      runWorkspaceReconcileOperation({
        ...baseInput,
        mutationToken: 'main-token',
        assertCurrent: () => {
          if (superseded) throw new Error('Workspace refresh was superseded.');
        },
        healManagedHead: false,
        displayDelivery: 'required',
        filesChanged: { revealPath: `${ROOT}/pkg` },
      })
    ).rejects.toThrow('Workspace refresh was superseded.');
    expect(revealPath).not.toHaveBeenCalled();
  });

  it('does not notify, refresh, or reveal when the workspace is retired while reconstruction runs', async () => {
    const controller = new AbortController();
    const blocked = deferred<MountedWorkspaceReconcileResult>();
    mocks.reconcileMountedWorkspaceRoot.mockImplementationOnce(() => blocked.promise);
    const ran = vi.fn();
    participant(async () => ran());
    const operation = runWorkspaceReconcileOperation({
      ...baseInput,
      signal: controller.signal,
      filesChanged: { revealPath: `${ROOT}/x` },
    });
    await vi.waitFor(() => expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledOnce());
    controller.abort(new Error('workspace closed'));
    blocked.resolve(durableResult(ROOT));
    await expect(operation).rejects.toThrow('workspace closed');
    expect(reconciledEvents).toHaveLength(0);
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(0);
    expect(mocks.recordWorkspaceIndex).not.toHaveBeenCalled();
    expect(ran).not.toHaveBeenCalled();
    expect(revealPath).not.toHaveBeenCalled();
  });

  it('refuses to start when the caller is already superseded or aborted', async () => {
    await expect(
      runWorkspaceReconcileOperation({
        ...baseInput,
        assertCurrent: () => {
          throw new Error('already superseded');
        },
        filesChanged: { notifyGitStatus: true },
      })
    ).rejects.toThrow('already superseded');
    const controller = new AbortController();
    controller.abort(new Error('workspace closed'));
    await expect(
      runWorkspaceReconcileOperation({ ...baseInput, signal: controller.signal })
    ).rejects.toThrow('workspace closed');
    expect(mocks.reconcileMountedWorkspaceRoot).not.toHaveBeenCalled();
    expect(mocks.notifyGitStatusChanged).not.toHaveBeenCalled();
  });

  it('does not queue a lease-holding operation behind token-less work for the same root', async () => {
    const blocked = deferred<MountedWorkspaceReconcileResult>();
    mocks.reconcileMountedWorkspaceRoot
      .mockImplementationOnce(() => blocked.promise)
      .mockImplementation(async (root: string) => durableResult(root));
    const tokenLess = runWorkspaceReconcileOperation({ ...baseInput, strict: false });
    await vi.waitFor(() => expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledOnce());

    const nested = runWorkspaceReconcileOperation({
      ...baseInput,
      mutationToken: 'held-by-finalization',
    });
    await expect(nested).resolves.toMatchObject({ display: { state: 'completed' } });
    expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledTimes(2);

    let idle = false;
    const idleWait = waitForWorkspaceReconcileIdle(ROOT).then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    blocked.resolve(durableResult(ROOT));
    await tokenLess;
    await idleWait;
    expect(idle).toBe(true);
  });

  it('orders token-less operations per root and lets unrelated roots proceed', async () => {
    const first = deferred<MountedWorkspaceReconcileResult>();
    const starts: string[] = [];
    mocks.reconcileMountedWorkspaceRoot.mockImplementation((root: string) => {
      starts.push(root);
      return root === ROOT && starts.filter((r) => r === ROOT).length === 1
        ? first.promise
        : Promise.resolve(durableResult(root));
    });
    const a1 = runWorkspaceReconcileOperation({ ...baseInput, strict: false });
    const a2 = runWorkspaceReconcileOperation({ ...baseInput, strict: false });
    const other = runWorkspaceReconcileOperation({
      ...baseInput,
      workspaceRoot: '/Users/test/other',
      strict: false,
    });
    await other;
    expect(starts).toEqual([ROOT, '/Users/test/other']);
    first.resolve(durableResult(ROOT));
    await Promise.all([a1, a2]);
    expect(starts).toEqual([ROOT, '/Users/test/other', ROOT]);
  });

  it('keeps display delivery outside the per-root slot so it never blocks the next same-root rebuild', async () => {
    const reload = deferred<void>();
    participant(async () => reload.promise);
    const first = runWorkspaceReconcileOperation({ ...baseInput, strict: false });
    await vi.waitFor(() => expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledOnce());

    const second = runWorkspaceReconcileOperation({ ...baseInput, strict: false });
    await vi.waitFor(() => expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledTimes(2));
    await waitForWorkspaceReconcileIdle(ROOT);
    reload.resolve();
    await Promise.all([first, second]);
  });

  it('mounts a root as one tracked operation: migration, then reconstruction, with no tree refresh', async () => {
    const result = await reconcileWorkspaceOnMount(ROOT);
    expect(mocks.migrateDatabaseOnlyNotebooksForWorkspace).toHaveBeenCalledWith(ROOT);
    expect(mocks.migrateDatabaseOnlyNotebooksForWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reconcileMountedWorkspaceRoot.mock.invocationCallOrder[0]
    );

    expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledWith(ROOT, {
      signal: undefined,
      mutationToken: undefined,
      healManagedHead: true,
      strict: false,
      waitForMutationAvailability: true,
    });
    expect(result.operationId).toMatch(/^workspace-mount:/);
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(0);
    expect(mocks.notifyGitStatusChanged).not.toHaveBeenCalled();
    expect(reconciledEvents).toEqual([{ path: null, workspaceRoot: ROOT }]);
  });

  it('keeps per-notebook materialization failures internal and continues reconstruction', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = { id: 'workspace-scoped-page', message: 'package write failed' };
    mocks.migrateDatabaseOnlyNotebooksForWorkspace.mockResolvedValueOnce({
      migrated: [],
      recovered: [],
      failed: [failure],
    });

    await expect(reconcileWorkspaceOnMount(ROOT)).resolves.toMatchObject({
      operationId: expect.stringMatching(/^workspace-mount:/),
    });

    expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('source rows remain intact and a later mount will retry'),
      [failure]
    );
  });

  it('rejects a mount whose notebook migration fails and never starts reconstruction', async () => {
    mocks.migrateDatabaseOnlyNotebooksForWorkspace.mockRejectedValueOnce(
      new Error('migration table locked')
    );
    await expect(reconcileWorkspaceOnMount(ROOT)).rejects.toThrow('migration table locked');
    expect(mocks.reconcileMountedWorkspaceRoot).not.toHaveBeenCalled();
    expect(reconciledEvents).toHaveLength(0);
    await expect(waitForWorkspaceReconcileIdle(ROOT)).resolves.toBeUndefined();
  });

  it('applies the file-change defaults: best effort, heal, optional display, reveal, no Git notify', async () => {
    await reconcileWorkspaceAfterFilesChanged({ workspaceRoot: ROOT, revealPath: `${ROOT}/x.gb` });
    expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ strict: false, healManagedHead: true })
    );
    expect(revealPath).toHaveBeenCalledWith(`${ROOT}/x.gb`);
    expect(mocks.notifyGitStatusChanged).not.toHaveBeenCalled();
  });

  it('forwards strict and Git-status intent from the file-change entry point', async () => {
    await reconcileWorkspaceAfterFilesChanged({
      workspaceRoot: ROOT,
      strict: true,
      notifyGitStatus: true,
    });
    expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ strict: true })
    );
    expect(mocks.notifyGitStatusChanged).toHaveBeenCalledWith(ROOT);
  });

  it('normalizes a trailing separator so one root never forks the lifecycle registry', async () => {
    const result = await runWorkspaceReconcileOperation({
      ...baseInput,
      workspaceRoot: `${ROOT}/`,
    });
    expect(result.workspaceRoot).toBe(ROOT);
    expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledWith(ROOT, expect.anything());
    expect(reconciledEvents).toEqual([{ path: null, workspaceRoot: ROOT }]);
  });

  it('resolves the owning root for a changed path, refreshing only the tree when none is mounted', () => {
    expect(resolveReconcileWorkspaceRoot(undefined, `${ROOT}/plasmids/a.gb`)).toBe(ROOT);
    expect(resolveReconcileWorkspaceRoot(ROOT, null)).toBe(ROOT);
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(0);
    expect(resolveReconcileWorkspaceRoot(null, '/elsewhere/b.gb')).toBeNull();
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(1);
    mocks.isBrowserOnly.mockReturnValue(true);
    expect(resolveReconcileWorkspaceRoot(ROOT, null)).toBeNull();
    expect(useWorkspaceStore.getState().fileTreeRefreshToken).toBe(1);
  });

  it('injects one bounded reconstruction failure at the dependency call site, then recovers', async () => {
    armWorkspaceOperationFailure({ stage: 'reconstruction', workspaceRoot: `${ROOT}/` });
    await expect(runWorkspaceReconcileOperation(baseInput)).rejects.toThrow(
      'Injected workspace reconstruction failure'
    );
    expect(mocks.reconcileMountedWorkspaceRoot).not.toHaveBeenCalled();
    expect(workspaceOperationFailureState()).toEqual({
      stage: 'reconstruction',
      workspaceRoot: ROOT,
      pending: false,
      hits: 1,
    });
    await expect(runWorkspaceReconcileOperation(baseInput)).resolves.toMatchObject({
      display: { state: 'completed' },
    });
  });

  it('injects a display failure that keeps every participant from running and fails a required delivery', async () => {
    const ran = vi.fn();
    participant(async () => ran());
    armWorkspaceOperationFailure({ stage: 'display' });
    await expect(
      runWorkspaceReconcileOperation({
        ...baseInput,
        mutationToken: 'main-token',
        healManagedHead: false,
        displayDelivery: 'required',
        filesChanged: {},
      })
    ).rejects.toBeInstanceOf(WorkspaceDisplayDeliveryError);
    expect(mocks.reconcileMountedWorkspaceRoot).toHaveBeenCalledOnce();
    expect(ran).not.toHaveBeenCalled();
  });
});
