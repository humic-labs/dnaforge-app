import { userMessage } from '@waypoint/user-messages';
import { expectToastCall, normalizeToastCalls } from '../../test/toast-assertions';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act, cleanup } from '@testing-library/react';
import { useEffect } from 'react';
import type {
  WorkspaceSyncActionOk,
  WorkspaceSyncReconcileResult,
  WorkspaceSyncActionError,
  WorkspaceSyncMergeConflictView,
  WorkspaceSyncProjectSummary,
  WorkspaceSyncOrganizationSummary,
  WorkspaceSyncAccessListing,
  WorkspaceSyncAccessListingResult,
} from '../../shared/workspace-sync-ipc';
import type {
  CloudWorkspaceController,
  CloudWorkspaceControllerInput,
} from './useCloudWorkspaceController';

const h = vi.hoisted(() => ({
  folders: [{ path: '/workspace/project', name: 'Project', addedAt: 1 }] as Array<{
    path: string;
    name: string;
    addedAt: number;
    pinned?: boolean;
  }>,
  selectedPath: '/workspace/project' as string | null,
  addFolder: vi.fn(),
  revealPath: vi.fn(),
  addToast: vi.fn(),
  editModeActive: false,
  confirmDialog: vi.fn(async () => true),
  db: { select: vi.fn() },
  cloudSync: {
    getStatus: vi.fn(),
    subscribeStatus: vi.fn(),
    previewUpload: vi.fn(),
    listSyncedProjects: vi.fn(),
    setEnabled: vi.fn(),
    forceSync: vi.fn(),
    copyShareLink: vi.fn(),
    openSyncedProject: vi.fn(),
    recoverScientificDrafts: vi.fn(),
    resolveConflict: vi.fn(),
    deleteCloudCopy: vi.fn(),
    listOrganizations: vi.fn().mockResolvedValue({ ok: true, organizations: [] }),
    createOrganization: vi.fn(),
    updateOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
    listOrganizationDirectory: vi.fn(),
    inviteOrganizationMember: vi.fn(),
    revokeOrganizationInvite: vi.fn(),
    changeOrganizationMemberRole: vi.fn(),
    removeOrganizationMember: vi.fn(),
    transferOrganizationOwnership: vi.fn(),
    listOrganizationAudit: vi.fn(),
    listAccess: vi.fn().mockResolvedValue({ ok: false, code: 'NOT_IMPLEMENTED', message: 'n/a' }),
    setAccess: vi.fn(),
    inviteCollaborator: vi.fn(),
    revokeInvite: vi.fn(),
    resendInvite: vi.fn(),
    reconcile: vi.fn(),
    getMergeConflict: vi.fn().mockResolvedValue({ ok: true, conflict: null }),
    resolveMergeConflict: vi.fn(),
  },
  clipboard: {
    writeText: vi.fn(),
  },
}));

vi.mock('../../platform', () => ({
  platform: () => ({ cloudSync: h.cloudSync, db: h.db, clipboard: h.clipboard }),
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      folders: h.folders,
      selectedPath: h.selectedPath,
      addFolder: h.addFolder,
      revealPath: h.revealPath,
    }),
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: (selector: (s: unknown) => unknown) => selector({ addToast: h.addToast }),
}));
vi.mock('../../stores/sequence-edit-mode-store', () => ({
  useSequenceEditModeStore: { getState: () => ({ active: h.editModeActive }) },
}));
vi.mock('../../components/confirm-dialog-store', () => ({
  confirmDialog: (...args: unknown[]) => h.confirmDialog(...args),
}));

import { useCloudWorkspaceController } from './useCloudWorkspaceController';

let current: CloudWorkspaceController | null = null;

function Harness(props: CloudWorkspaceControllerInput) {
  const controller = useCloudWorkspaceController(props);
  useEffect(() => {
    current = controller;
  });
  return null;
}

it('recovers into an isolated profile after confirmation and reports captured drafts honestly', async () => {
  h.cloudSync.getStatus.mockResolvedValue({
    ...(await h.cloudSync.getStatus()),
    workspaceUuid: 'repo-uuid-a',
    syncAxis: 'conflict',
    bufferAxis: 'clean',
    recoveryCandidate: {
      representation: 'scientific_manifest_v1',
      candidateId: '31da3243-0000-4000-8000-000000000003',
    },
  });
  h.cloudSync.recoverScientificDrafts.mockResolvedValue({
    ok: true,
    workspaceUuid: 'recovered-uuid',
    profilePath: '/private/recovery/profile',
    projectPath: '/private/recovery/profile/managed/repo',
    draftsPath: '/private/recovered-drafts',
    changedDraftFiles: 2,
    coverage: 'incomplete',
    missingPaths: ['missing.json'],
  });
  const harness = renderController();
  await waitFor(() => expect(current?.syncStatus?.recoveryCandidate).toBeDefined());
  await act(async () => current!.recoverScientificDrafts());
  expect(h.confirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Recover saved history and drafts' })
  );
  expect(h.cloudSync.recoverScientificDrafts).toHaveBeenCalledWith(
    'repo-uuid-a',
    '31da3243-0000-4000-8000-000000000003'
  );
  expect(h.addFolder).not.toHaveBeenCalled();
  expect(h.revealPath).not.toHaveBeenCalled();
  expect(h.addToast).toHaveBeenCalledWith(
    expect.stringContaining('This capture omitted some files'),
    expect.anything()
  );
  expect(harness.onProjectOpened).not.toHaveBeenCalled();
  expect(current?.commandInFlight).toBe(false);
  harness.unmount();
});

function renderController(overrides: Partial<CloudWorkspaceControllerInput> = {}) {
  const onProjectOpened = overrides.onProjectOpened ?? vi.fn();
  const props: CloudWorkspaceControllerInput = {
    menuOpen: true,
    signedIn: true,
    cloudSyncEnabled: true,
    onProjectOpened,
    ...overrides,
  };
  const utils = render(<Harness {...props} />);
  return {
    onProjectOpened,
    unmount: utils.unmount,

    rerender: () => utils.rerender(<Harness {...props} />),
    setMenuOpen: (menuOpen: boolean) => utils.rerender(<Harness {...props} menuOpen={menuOpen} />),
    setCloudSyncEnabled: (cloudSyncEnabled: boolean) =>
      utils.rerender(<Harness {...props} cloudSyncEnabled={cloudSyncEnabled} />),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

const ownershipProject: WorkspaceSyncProjectSummary = {
  remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9b',
  displayName: 'Current synthetic project',
  ownerAccountId: 'synthetic-account',
  ownerOrgId: null,
  latestVersionId: 'synthetic-version',
  latestVersionNumber: 1,
  updatedAt: 1,
};

type DeferredCommandResult =
  | (WorkspaceSyncActionOk & {
      workspaceUuid?: string;
      resolution?: 'use_remote';
      outcome?: 'no_remote_change';
    })
  | WorkspaceSyncActionError;

beforeEach(() => {
  cleanup();
  current = null;
  vi.clearAllMocks();
  h.folders = [{ path: '/workspace/project', name: 'Project', addedAt: 1 }];
  h.selectedPath = '/workspace/project';
  h.editModeActive = false;
  h.confirmDialog.mockResolvedValue(true);
  h.db.select.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT repo_uuid')) return [{ repo_uuid: 'repo-uuid-a' }];
    if (sql.includes('SELECT path, name')) {
      return [{ path: '/managed/workspace-a/repo', name: 'Project A' }];
    }
    return [];
  });
  h.cloudSync.getStatus.mockResolvedValue({
    workspaceUuid: 'repo-uuid-a',
    syncAxis: 'idle_synced',
    bufferAxis: 'clean',
    canDisplayPlainSynced: true,
    blockers: [],
    excludedAuthoritativeState: [],
    excludedSummary: null,
    terminalErrorCode: null,
    terminalErrorMessage: null,
  });
  h.cloudSync.subscribeStatus.mockReturnValue(() => {});
  h.cloudSync.previewUpload.mockResolvedValue({
    ok: true,
    workspaceUuid: 'repo-uuid-a',
    includedFiles: [],
    includedFileCount: 0,
    includedBytes: 0,
    excludedSummary: null,
    limits: { maxFileBytes: 1, maxBundleBytes: 1, maxFiles: 1 },
  });
  h.cloudSync.listSyncedProjects.mockResolvedValue([]);
  h.cloudSync.listOrganizations.mockResolvedValue({ ok: true, organizations: [] });
  h.cloudSync.listAccess.mockResolvedValue({ ok: false, code: 'NOT_IMPLEMENTED', message: 'n/a' });
  h.cloudSync.getMergeConflict.mockResolvedValue({ ok: true, conflict: null });
  h.cloudSync.forceSync.mockResolvedValue({ ok: true });
  h.cloudSync.copyShareLink.mockResolvedValue({
    ok: true,
    url: 'https://dnaforge.com/d/sync-share',
    versionId: 'v-a',
  });
  h.cloudSync.resolveConflict.mockResolvedValue({ ok: true, resolution: 'keep_local' });
  h.cloudSync.deleteCloudCopy.mockResolvedValue({ ok: true });
  h.cloudSync.openSyncedProject.mockResolvedValue({ ok: true, workspaceUuid: 'workspace-a' });
  h.clipboard.writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('useCloudWorkspaceController', () => {
  it('resolves the managed repo UUID and subscribes/preview/list against it when active', async () => {
    renderController();
    await waitFor(() => expect(h.cloudSync.getStatus).toHaveBeenCalledWith('repo-uuid-a'));
    expect(h.db.select).toHaveBeenCalledWith(expect.stringContaining('SELECT repo_uuid'), [
      '/workspace/project',
    ]);
    expect(h.cloudSync.subscribeStatus).toHaveBeenCalledWith('repo-uuid-a', expect.any(Function));
    expect(h.cloudSync.previewUpload).toHaveBeenCalledWith('repo-uuid-a', {
      owner: { kind: 'personal' },
    });
    expect(h.cloudSync.listSyncedProjects).toHaveBeenCalled();
    expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a');
  });

  it('requests a new preview when the storage owner changes to an organization', async () => {
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    const orgId = 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
    act(() => current?.setOwnerChoice({ kind: 'org', orgId }));
    await waitFor(() =>
      expect(h.cloudSync.previewUpload).toHaveBeenLastCalledWith('repo-uuid-a', {
        owner: { kind: 'org', orgId },
      })
    );
  });

  it('performs ZERO sync calls when cloudSyncEnabled is false (plan D7)', async () => {
    renderController({ cloudSyncEnabled: false });

    await act(async () => {
      await Promise.resolve();
    });
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.cloudSync.getStatus).not.toHaveBeenCalled();
    expect(h.cloudSync.subscribeStatus).not.toHaveBeenCalled();
    expect(h.cloudSync.previewUpload).not.toHaveBeenCalled();
    expect(h.cloudSync.listSyncedProjects).not.toHaveBeenCalled();
    expect(current?.syncWorkspaceUuid).toBeNull();
    expect(current?.syncedProjects).toEqual([]);
  });

  it('performs ZERO sync calls when the popover is closed', async () => {
    renderController({ menuOpen: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.cloudSync.getStatus).not.toHaveBeenCalled();
    expect(h.cloudSync.listSyncedProjects).not.toHaveBeenCalled();
  });

  it('enable keeps a new project private after organizations load', async () => {
    const orgId = 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
    let resolveList: (value: {
      ok: true;
      organizations: Array<{
        orgId: string;
        slug: string;
        displayName: string;
        role: 'owner';
        canCreateManagedProjects: true;
        isAdministrator: true;
      }>;
    }) => void = () => {};
    const listPromise = new Promise<Parameters<typeof resolveList>[0]>((resolve) => {
      resolveList = resolve;
    });
    h.cloudSync.listOrganizations.mockReturnValue(listPromise);
    h.cloudSync.setEnabled.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    expect(current?.ownerChoice).toEqual({ kind: 'personal' });

    const enabling = act(async () => {
      await current!.runAutoSyncAction('enable');
    });
    resolveList({
      ok: true,
      organizations: [
        {
          orgId,
          slug: 'acme',
          displayName: 'Acme',
          role: 'owner',
          canCreateManagedProjects: true,
          isAdministrator: true,
        },
      ],
    });
    await enabling;

    expect(h.cloudSync.setEnabled).toHaveBeenCalledWith('repo-uuid-a', true, {
      owner: { kind: 'personal' },
    });
    confirm.mockRestore();
  });

  it('runAutoSyncAction("force") calls forceSync by managed UUID and toasts', async () => {
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    await act(async () => {
      await current!.runAutoSyncAction('force');
    });
    expect(h.cloudSync.forceSync).toHaveBeenCalledWith('repo-uuid-a');
    expect(h.cloudSync.forceSync).not.toHaveBeenCalledWith('/workspace/project');
    expectToastCall(h.addToast, 'Sync requested.', 'success');
  });

  it('runAutoSyncAction("share") confirms, copies the link, and writes the clipboard', async () => {
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    await act(async () => {
      await current!.runAutoSyncAction('share');
    });
    expect(h.confirmDialog).toHaveBeenCalled();
    expect(h.cloudSync.copyShareLink).toHaveBeenCalledWith('repo-uuid-a');
    expect(h.clipboard.writeText).toHaveBeenCalledWith('https://dnaforge.com/d/sync-share');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('runAutoSyncAction("share") is blocked while sequence edit mode is active', async () => {
    h.editModeActive = true;
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    await act(async () => {
      await current!.runAutoSyncAction('share');
    });
    expect(h.cloudSync.copyShareLink).not.toHaveBeenCalled();
  });

  it('runConflictResolution("keep_local") confirms then resolves by managed UUID', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    await act(async () => {
      await current!.runConflictResolution('keep_local');
    });
    expect(confirmSpy).toHaveBeenCalled();
    expect(h.cloudSync.resolveConflict).toHaveBeenCalledWith('repo-uuid-a', 'keep_local');
    expectToastCall(h.addToast, 'Local changes queued for backup.', 'success');
    confirmSpy.mockRestore();
  });

  it('openSyncedProject opens by remote id, mounts the workspace, and closes the popover', async () => {
    const { onProjectOpened } = renderController();
    await waitFor(() => expect(current).not.toBeNull());
    await act(async () => {
      await current!.openSyncedProject({
        remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
        displayName: 'Project A',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        latestVersionId: 'v-a',
        latestVersionNumber: 3,
        updatedAt: 1,
      });
    });
    expect(h.cloudSync.openSyncedProject).toHaveBeenCalledWith(
      '8a4d99e9-2347-4d04-a447-d3070f7a7f9a'
    );
    expect(h.addFolder).toHaveBeenCalledWith('/managed/workspace-a/repo', 'Project A');
    expect(h.revealPath).toHaveBeenCalledWith('/managed/workspace-a/repo');
    expect(onProjectOpened).toHaveBeenCalled();
  });

  it('shows every warning instead of a success toast when a cloud project opens with multiple risks', async () => {
    h.cloudSync.openSyncedProject.mockResolvedValueOnce({
      ok: true,
      workspaceUuid: 'workspace-a',
      warnings: [userMessage('sync.legacyDataKept'), userMessage('sync.backupNotStarted')],
    });
    renderController();
    await waitFor(() => expect(current).not.toBeNull());

    await act(async () => {
      await current!.openSyncedProject({
        remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
        displayName: 'Project A',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        latestVersionId: 'v-a',
        latestVersionNumber: 3,
        updatedAt: 1,
      });
    });

    expectToastCall(h.addToast, userMessage('sync.legacyDataKept'), 'warning');
    expectToastCall(h.addToast, userMessage('sync.backupNotStarted'), 'warning');
    expect(h.addToast).not.toHaveBeenCalledWith('Opened Project A.', 'success');
  });

  it('unsubscribes the status subscription on unmount', async () => {
    const unsubscribe = vi.fn();
    h.cloudSync.subscribeStatus.mockReturnValue(unsubscribe);
    const { unmount } = renderController();
    await waitFor(() =>
      expect(h.cloudSync.subscribeStatus).toHaveBeenCalledWith('repo-uuid-a', expect.any(Function))
    );
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('drops a late status response that lands after the controller goes inactive', async () => {
    let resolveStatus: (value: unknown) => void = () => {};
    h.cloudSync.getStatus.mockImplementation(
      () =>
        new Promise((res) => {
          resolveStatus = res;
        })
    );
    const { setCloudSyncEnabled } = renderController();
    await waitFor(() => expect(h.cloudSync.getStatus).toHaveBeenCalledWith('repo-uuid-a'));

    setCloudSyncEnabled(false);
    await act(async () => {
      resolveStatus({
        workspaceUuid: 'repo-uuid-a',
        syncAxis: 'conflict',
        bufferAxis: 'clean',
        canDisplayPlainSynced: false,
        blockers: ['conflict'],
        excludedAuthoritativeState: [],
        excludedSummary: null,
        terminalErrorCode: null,
        terminalErrorMessage: null,
      });
    });

    expect(current?.syncStatus).toBeNull();
  });

  it('drops a command status refresh when the selected workspace changed mid-flight', async () => {
    h.folders = [
      { path: '/workspace/project', name: 'Project', addedAt: 1 },
      { path: '/workspace/other', name: 'Other', addedAt: 2 },
    ];
    h.selectedPath = '/workspace/project';
    h.db.select.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT repo_uuid')) {
        return params?.[0] === '/workspace/other'
          ? [{ repo_uuid: 'repo-uuid-b' }]
          : [{ repo_uuid: 'repo-uuid-a' }];
      }
      return [{ path: '/managed/workspace-a/repo', name: 'Project A' }];
    });

    const { rerender } = renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));

    const pending: Record<string, (value: unknown) => void> = {};
    h.cloudSync.getStatus.mockImplementation(
      (uuid: string) =>
        new Promise((res) => {
          pending[uuid] = res;
        })
    );

    const inFlight = current!.runAutoSyncAction('force');
    await waitFor(() => expect(pending['repo-uuid-a']).toBeTypeOf('function'));

    h.selectedPath = '/workspace/other';
    rerender();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-b'));

    await act(async () => {
      pending['repo-uuid-a']({
        workspaceUuid: 'repo-uuid-a',
        syncAxis: 'conflict',
        bufferAxis: 'clean',
        canDisplayPlainSynced: false,
        blockers: ['conflict'],
        excludedAuthoritativeState: [],
        excludedSummary: null,
        terminalErrorCode: null,
        terminalErrorMessage: null,
      });
      await inFlight;
    });

    expect(current?.syncWorkspaceUuid).toBe('repo-uuid-b');
    expect(current?.syncStatus?.syncAxis).not.toBe('conflict');
  });

  it('reports UNKNOWN (not local-only) and toasts when the repo-uuid query fails', async () => {
    h.db.select.mockRejectedValueOnce(new Error('db offline'));
    renderController();
    await waitFor(() =>
      expectToastCall(h.addToast, userMessage('notice.could-not-load-sync-status'), 'error')
    );
    expect(current?.syncWorkspaceUuid).toBeNull();
    expect(h.cloudSync.getStatus).not.toHaveBeenCalled();
    expect(current?.syncDisplay.label).toBe('Status unavailable');
    expect(current?.syncDisplay.canDeleteCloudCopy).toBe(false);
  });

  it('reports UNKNOWN (not local-only) and toasts when the status request fails', async () => {
    h.cloudSync.getStatus.mockRejectedValueOnce(new Error('status boom'));
    renderController();
    await waitFor(() =>
      expectToastCall(h.addToast, userMessage('notice.could-not-load-sync-status'), 'error')
    );
    expect(current?.syncDisplay.label).toBe('Status unavailable');
    expect(current?.syncDisplay.canDeleteCloudCopy).toBe(false);
  });

  it('still reports a genuinely unmanaged project as local-only', () => {
    h.db.select.mockResolvedValueOnce([]);
    renderController();
    return waitFor(() => expect(current?.syncDisplay.label).toBe('Local only'));
  });

  it('records a preview error when previewUpload rejects', async () => {
    h.cloudSync.previewUpload.mockRejectedValueOnce(new Error('preview boom'));
    renderController();
    await waitFor(() =>
      expect(current?.uploadPreviewError).toBe(
        userMessage('failure.could-not-preview-cloud-backup-contents')
      )
    );
    expect(current?.uploadPreview).toBeNull();
  });

  it('records a preview error when previewUpload returns a not-ok result', async () => {
    h.cloudSync.previewUpload.mockResolvedValueOnce({ ok: false, message: 'bundle too large' });
    renderController();
    await waitFor(() => expect(current?.uploadPreviewError).toBe(userMessage('account.failed')));
    expect(current?.uploadPreview).toBeNull();
  });

  it('records a projects error and clears loading when listSyncedProjects rejects', async () => {
    h.cloudSync.listSyncedProjects.mockRejectedValueOnce(new Error('list boom'));
    renderController();
    await waitFor(() =>
      expect(current?.syncedProjectsError).toBe(
        userMessage('failure.could-not-load-cloud-projects')
      )
    );
    expect(current?.syncedProjects).toEqual([]);
    expect(current?.syncedProjectsLoading).toBe(false);
  });

  it('never surfaces the Electron IPC wrapper for a missing_token failure', async () => {
    h.cloudSync.listSyncedProjects.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'cloudSync:listSyncedProjects': DesktopSyncClientError: missing_token"
      )
    );
    renderController();
    await waitFor(() =>
      expect(current?.syncedProjectsError).toBe(
        'Could not load cloud projects. Sign out and sign in again.'
      )
    );
    expect(current?.syncedProjectsError).not.toMatch(/invoking remote method/i);
    expect(current?.syncedProjectsError).not.toMatch(/missing_token/);
  });

  it('releases a stuck command lock when the popover closes', async () => {
    h.cloudSync.forceSync.mockImplementation(() => new Promise(() => {}));
    const { setCloudSyncEnabled } = renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));

    void current!.runAutoSyncAction('force');
    await waitFor(() => expect(current?.commandInFlight).toBe(true));

    setCloudSyncEnabled(false);
    await waitFor(() => expect(current?.commandInFlight).toBe(false));
    expect(current?.syncBusy).toBeNull();
  });

  it('refuses a second command while one is already running', async () => {
    let release: (value: unknown) => void = () => {};
    h.cloudSync.forceSync.mockImplementation(
      () =>
        new Promise((res) => {
          release = res;
        })
    );
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));

    const first = current!.runAutoSyncAction('force');
    await waitFor(() => expect(h.cloudSync.forceSync).toHaveBeenCalledTimes(1));

    await current!.runAutoSyncAction('force');
    expect(h.cloudSync.forceSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ ok: true });
      await first;
    });
  });

  it('blocks opening a project while a sync command is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    h.cloudSync.forceSync.mockImplementation(
      () =>
        new Promise((res) => {
          release = res;
        })
    );
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));

    const first = current!.runAutoSyncAction('force');
    await waitFor(() => expect(current?.commandInFlight).toBe(true));

    await current!.openSyncedProject({
      remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
      displayName: 'Project A',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      latestVersionId: 'v-a',
      latestVersionNumber: 3,
      updatedAt: 1,
    });
    expect(h.cloudSync.openSyncedProject).not.toHaveBeenCalled();
    expect(h.addFolder).not.toHaveBeenCalled();

    await act(async () => {
      release({ ok: true });
      await first;
    });
  });

  it('does NOT claim the link was copied when the clipboard write fails', async () => {
    h.clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    h.cloudSync.copyShareLink.mockResolvedValueOnce({
      ok: true,
      url: 'https://dnaforge.com/d/sync-share',
      versionNumber: 4,
    });
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    await act(async () => {
      await current!.runAutoSyncAction('share');
    });

    const [message, tone] = normalizeToastCalls(h.addToast).at(-1)!;
    expect(message).not.toContain('copied.');

    expect(message).toContain('https://dnaforge.com/d/sync-share');
    expect(tone).toBe('warning');
  });

  it('reports success only when the clipboard write actually succeeded', async () => {
    h.cloudSync.copyShareLink.mockResolvedValueOnce({
      ok: true,
      url: 'https://dnaforge.com/d/sync-share',
      versionNumber: 4,
    });
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    await act(async () => {
      await current!.runAutoSyncAction('share');
    });
    const [message, tone] = normalizeToastCalls(h.addToast).at(-1)!;
    expect(message).toContain('copied');
    expect(tone).toBe('success');
  });

  it('maps NOT_IMPLEMENTED to an info toast and skips the status refresh', async () => {
    h.cloudSync.forceSync.mockResolvedValueOnce({ ok: false, code: 'NOT_IMPLEMENTED' });
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    h.cloudSync.getStatus.mockClear();
    await act(async () => {
      await current!.runAutoSyncAction('force');
    });
    expectToastCall(h.addToast, 'Cloud backup action is not available yet.', 'info');
    expect(h.cloudSync.getStatus).not.toHaveBeenCalled();
  });

  it('maps storage failure codes without forwarding the server message', async () => {
    h.cloudSync.forceSync.mockResolvedValueOnce({
      ok: false,
      code: 'QUOTA_EXCEEDED',
      message: 'Storage full.',
    });
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    await act(async () => {
      await current!.runAutoSyncAction('force');
    });
    expectToastCall(h.addToast, userMessage('sync.storageLimitReached'), 'error');
    expect(JSON.stringify(h.addToast.mock.calls)).not.toContain('Storage full.');
  });

  it('runConflictResolution("use_remote") opens the cloud copy and closes the popover', async () => {
    h.cloudSync.resolveConflict.mockResolvedValueOnce({
      ok: true,
      resolution: 'use_remote',
      workspaceUuid: 'workspace-a',
    });
    const { onProjectOpened } = renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    await act(async () => {
      await current!.runConflictResolution('use_remote');
    });
    expect(h.cloudSync.resolveConflict).toHaveBeenCalledWith('repo-uuid-a', 'use_remote');
    expect(h.db.select).toHaveBeenCalledWith(expect.stringContaining('SELECT path, name'), [
      'workspace-a',
    ]);
    expect(h.addFolder).toHaveBeenCalledWith('/managed/workspace-a/repo', 'Project A');
    expect(h.revealPath).toHaveBeenCalledWith('/managed/workspace-a/repo');
    expectToastCall(h.addToast, 'Opened Project A.', 'success');
    expect(onProjectOpened).toHaveBeenCalled();
  });

  it('shows every warning after resolving a conflict with the cloud copy', async () => {
    h.cloudSync.resolveConflict.mockResolvedValueOnce({
      ok: true,
      resolution: 'use_remote',
      workspaceUuid: 'workspace-a',
      warnings: [userMessage('sync.legacyDataKept'), userMessage('sync.backupNotStarted')],
    });
    renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));

    await act(async () => {
      await current!.runConflictResolution('use_remote');
    });

    expectToastCall(h.addToast, userMessage('sync.legacyDataKept'), 'warning');
    expectToastCall(h.addToast, userMessage('sync.backupNotStarted'), 'warning');
    expect(h.addToast).not.toHaveBeenCalledWith('Opened Project A.', 'success');
  });

  it('runConflictResolution("use_remote") toasts when the local workspace row is missing', async () => {
    h.cloudSync.resolveConflict.mockResolvedValueOnce({
      ok: true,
      resolution: 'use_remote',
      workspaceUuid: 'workspace-a',
    });
    h.db.select.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT repo_uuid')) return [{ repo_uuid: 'repo-uuid-a' }];
      return [];
    });
    const { onProjectOpened } = renderController();
    await waitFor(() => expect(current?.syncWorkspaceUuid).toBe('repo-uuid-a'));
    await act(async () => {
      await current!.runConflictResolution('use_remote');
    });
    expectToastCall(
      h.addToast,
      'Cloud project opened but the local project record was not found.',
      'error'
    );
    expect(h.addFolder).not.toHaveBeenCalled();
    expect(onProjectOpened).not.toHaveBeenCalled();
  });

  it('re-reads status when use_remote resolved remotely but the local step failed', async () => {
    h.cloudSync.getStatus.mockResolvedValue({
      workspaceUuid: 'repo-uuid-a',
      syncAxis: 'conflict',
      bufferAxis: 'clean',
      canDisplayPlainSynced: false,
      blockers: ['conflict'],
      excludedAuthoritativeState: [],
      excludedSummary: null,
      terminalErrorCode: null,
      terminalErrorMessage: null,
    });
    h.cloudSync.resolveConflict.mockResolvedValueOnce({
      ok: true,
      resolution: 'use_remote',
      workspaceUuid: 'workspace-a',
    });

    h.db.select.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT repo_uuid')) return [{ repo_uuid: 'repo-uuid-a' }];
      return [];
    });

    renderController();
    await waitFor(() => expect(current?.syncStatus?.syncAxis).toBe('conflict'));

    h.cloudSync.getStatus.mockResolvedValue({
      workspaceUuid: 'repo-uuid-a',
      syncAxis: 'idle_synced',
      bufferAxis: 'clean',
      canDisplayPlainSynced: true,
      blockers: [],
      excludedAuthoritativeState: [],
      excludedSummary: null,
      terminalErrorCode: null,
      terminalErrorMessage: null,
    });

    await act(async () => {
      await current!.runConflictResolution('use_remote');
    });

    expectToastCall(
      h.addToast,
      'Cloud project opened but the local project record was not found.',
      'error'
    );

    expect(current?.syncStatus?.syncAxis).not.toBe('conflict');
  });

  it('openSyncedProject toasts and resets when the local workspace row is missing', async () => {
    h.db.select.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT repo_uuid')) return [{ repo_uuid: 'repo-uuid-a' }];
      return [];
    });
    const { onProjectOpened } = renderController();
    await waitFor(() => expect(current).not.toBeNull());
    await act(async () => {
      await current!.openSyncedProject({
        remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
        displayName: 'Project A',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        latestVersionId: 'v-a',
        latestVersionNumber: 3,
        updatedAt: 1,
      });
    });
    expectToastCall(
      h.addToast,
      'Cloud project opened but the local project record was not found.',
      'error'
    );
    expect(current?.openingRemoteWorkspaceId).toBeNull();
    expect(onProjectOpened).not.toHaveBeenCalled();
  });

  it('ignores a pending reconcile conflict after the active workspace changes without closing', async () => {
    const pending = deferred<WorkspaceSyncReconcileResult>();
    h.folders.push({ path: '/workspace/other', name: 'Other', addedAt: 2 });
    h.db.select.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.includes('SELECT repo_uuid')
        ? [{ repo_uuid: params?.[0] === '/workspace/other' ? 'repo-uuid-b' : 'repo-uuid-a' }]
        : []
    );
    h.cloudSync.reconcile.mockReturnValueOnce(pending.promise);
    const ui = renderController();
    await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
    const initialStatus = current!.syncStatus!;
    h.cloudSync.getStatus.mockImplementation(async (workspaceUuid: string) => ({
      ...initialStatus,
      workspaceUuid,
    }));
    let first: Promise<void> | undefined;
    act(() => {
      first = current!.runReconcile();
    });
    await waitFor(() => expect(h.cloudSync.reconcile).toHaveBeenCalledWith('repo-uuid-a'));
    h.selectedPath = '/workspace/other';
    ui.rerender();
    await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-b'));
    const toastCalls = h.addToast.mock.calls.length;
    try {
      await act(async () => {
        pending.resolve({
          ok: true,
          outcome: 'conflicts',
          conflict: {
            conflictId: 'synthetic-workspace-a-conflict',
            workspaceUuid: 'repo-uuid-a',
            remoteVersionId: 'synthetic-version',
            remoteVersionNumber: 1,
            remoteAuthor: null,
            baseVersionId: null,
            createdAt: 1,
            items: [],
          },
        });
        await first;
      });
      expect(current?.mergeConflict).toBeNull();
      expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-b');
      expect(h.addToast).toHaveBeenCalledTimes(toastCalls);
      await act(async () => {
        await current!.runAutoSyncAction('force');
      });
      expect(h.cloudSync.forceSync).toHaveBeenLastCalledWith('repo-uuid-b');
      expect(current?.commandInFlight).toBe(false);
    } finally {
      await act(async () => {
        pending.resolve({ ok: true, outcome: 'no_remote_change' });
        await first;
      });
    }
  });

  describe('command completion ownership after close and reopen', () => {
    const families = ['force', 'open', 'people', 'reconcile', 'merge', 'conflict'] as const;
    for (const family of families) {
      for (const settlement of ['resolve', 'refuse', 'reject'] as const) {
        it.each(['same', 'new'] as const)(
          `${family} ${settlement} cannot release a newer command in the %s workspace`,
          async (workspace) => {
            const old = deferred<DeferredCommandResult>();
            const next = deferred<DeferredCommandResult>();
            const success: DeferredCommandResult = {
              ok: true,
              workspaceUuid: 'synthetic-restored',
              resolution: 'use_remote',
              outcome: 'no_remote_change',
            };
            const conflict: WorkspaceSyncMergeConflictView = {
              conflictId: 'synthetic-conflict',
              workspaceUuid: 'repo-uuid-a',
              remoteVersionId: 'synthetic-version',
              remoteVersionNumber: 1,
              remoteAuthor: null,
              baseVersionId: null,
              createdAt: 1,
              items: [],
            };
            h.cloudSync.getMergeConflict.mockImplementation(async (uuid: string) => ({
              ok: true,
              conflict: { ...conflict, workspaceUuid: uuid },
            }));
            switch (family) {
              case 'force':
                h.cloudSync.forceSync.mockImplementationOnce(() => old.promise);
                break;
              case 'open':
                h.cloudSync.openSyncedProject.mockImplementationOnce(() => old.promise);
                break;
              case 'people':
                h.cloudSync.revokeInvite.mockImplementationOnce(() => old.promise);
                break;
              case 'reconcile':
                h.cloudSync.reconcile.mockImplementationOnce(() => old.promise);
                break;
              case 'merge':
                h.cloudSync.resolveMergeConflict.mockImplementationOnce(() => old.promise);
                break;
              case 'conflict':
                h.cloudSync.resolveConflict.mockImplementationOnce(() => old.promise);
                break;
            }
            const ui = renderController();
            await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
            await waitFor(() =>
              expect(current?.mergeConflict?.conflictId).toBe(conflict.conflictId)
            );
            const initialStatus = current!.syncStatus!;
            let first = Promise.resolve();
            let second = Promise.resolve();
            try {
              act(() => {
                switch (family) {
                  case 'force':
                    first = current!.runAutoSyncAction('force');
                    break;
                  case 'open':
                    first = current!.openSyncedProject(ownershipProject);
                    break;
                  case 'people':
                    first = current!.revokeInvite('synthetic-invite');
                    break;
                  case 'reconcile':
                    first = current!.runReconcile();
                    break;
                  case 'merge':
                    first = current!.resolveMergeConflict({});
                    break;
                  case 'conflict':
                    first = current!.runConflictResolution('use_remote');
                    break;
                }
              });
              await waitFor(() => expect(current?.commandInFlight).toBe(true));
              act(() => ui.setMenuOpen(false));
              await waitFor(() => expect(current?.commandInFlight).toBe(false));
              const uuid = workspace === 'new' ? 'repo-uuid-b' : 'repo-uuid-a';
              h.folders.push({ path: '/workspace/next', name: 'Next', addedAt: 2 });
              h.selectedPath = workspace === 'new' ? '/workspace/next' : '/workspace/project';
              h.db.select.mockImplementation(async (sql: string, params?: unknown[]) => {
                if (sql.includes('SELECT repo_uuid'))
                  return [
                    {
                      repo_uuid: params?.[0] === '/workspace/next' ? 'repo-uuid-b' : 'repo-uuid-a',
                    },
                  ];
                return [{ path: '/managed/current/repo', name: 'Current synthetic project' }];
              });
              h.cloudSync.getStatus.mockImplementation(async (target: string) => ({
                ...initialStatus,
                workspaceUuid: target,
              }));
              act(() => ui.setMenuOpen(true));
              await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe(uuid));
              if (family === 'force')
                h.cloudSync.openSyncedProject.mockImplementationOnce(() => next.promise);
              else h.cloudSync.forceSync.mockImplementationOnce(() => next.promise);
              act(() => {
                second =
                  family === 'force'
                    ? current!.openSyncedProject(ownershipProject)
                    : current!.runAutoSyncAction('force');
              });
              await waitFor(() => expect(current?.commandInFlight).toBe(true));
              const forceCalls = h.cloudSync.forceSync.mock.calls.length;
              const openCalls = h.cloudSync.openSyncedProject.mock.calls.length;
              const statusCalls = h.cloudSync.getStatus.mock.calls.length;
              const lookupCalls = h.db.select.mock.calls.length;
              const toastCalls = h.addToast.mock.calls.length;
              await act(async () => {
                if (settlement === 'resolve') old.resolve(success);
                else if (settlement === 'refuse')
                  old.resolve({
                    ok: false,
                    code: 'INVALID_REQUEST',
                    message: 'Controlled stale action refusal',
                  });
                else old.reject(new Error('Controlled stale command failure'));
                await first;
              });
              expect(current?.commandInFlight).toBe(true);
              expect(current?.syncBusy).toBe(family === 'force' ? null : 'force');
              expect(current?.openingRemoteWorkspaceId).toBe(
                family === 'force' ? ownershipProject.remoteWorkspaceId : null
              );
              expect(current?.syncStatus?.workspaceUuid).toBe(uuid);
              expect(h.cloudSync.getStatus).toHaveBeenCalledTimes(statusCalls);
              expect(h.db.select).toHaveBeenCalledTimes(lookupCalls);
              expect(h.addToast).toHaveBeenCalledTimes(toastCalls);
              expect(h.addFolder).not.toHaveBeenCalled();
              expect(h.revealPath).not.toHaveBeenCalled();
              expect(ui.onProjectOpened).not.toHaveBeenCalled();
              await act(async () => {
                await Promise.all([
                  current!.runAutoSyncAction('force'),
                  current!.openSyncedProject(ownershipProject),
                ]);
              });
              expect(h.cloudSync.forceSync).toHaveBeenCalledTimes(forceCalls);
              expect(h.cloudSync.openSyncedProject).toHaveBeenCalledTimes(openCalls);
              await act(async () => {
                next.resolve(success);
                await second;
              });
              expect(current?.commandInFlight).toBe(false);
              expect(current?.syncBusy).toBeNull();
              expect(current?.openingRemoteWorkspaceId).toBeNull();
              if (family === 'force') {
                expect(ui.onProjectOpened).toHaveBeenCalledTimes(1);
                expect(h.addFolder).toHaveBeenCalledWith(
                  '/managed/current/repo',
                  'Current synthetic project'
                );
              } else expectToastCall(h.addToast, 'Sync requested.', 'success');
              await act(async () => {
                await current!.runAutoSyncAction('force');
              });
              expect(h.cloudSync.forceSync).toHaveBeenCalledTimes(forceCalls + 1);
            } finally {
              await act(async () => {
                old.resolve(success);
                next.resolve(success);
                await Promise.all([first, second]);
              });
            }
          }
        );
      }
    }

    for (const settlement of ['resolve', 'reject'] as const) {
      it.each(['same', 'new'] as const)(
        `a stale command status ${settlement} cannot paint or release the %s workspace's newer request`,
        async (workspace) => {
          const oldRead = deferred<NonNullable<CloudWorkspaceController['syncStatus']>>();
          const next = deferred<WorkspaceSyncActionOk>();
          const ui = renderController();
          await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
          const initialStatus = current!.syncStatus!;
          const reads = h.cloudSync.getStatus.mock.calls.length;
          h.cloudSync.getStatus.mockImplementationOnce(() => oldRead.promise);
          let first = Promise.resolve();
          let second = Promise.resolve();
          try {
            act(() => {
              first = current!.runAutoSyncAction('force');
            });
            await waitFor(() => expect(h.cloudSync.getStatus).toHaveBeenCalledTimes(reads + 1));
            act(() => ui.setMenuOpen(false));
            const uuid = workspace === 'new' ? 'repo-uuid-b' : 'repo-uuid-a';
            h.folders.push({ path: '/workspace/next', name: 'Next', addedAt: 2 });
            h.selectedPath = workspace === 'new' ? '/workspace/next' : '/workspace/project';
            h.db.select.mockImplementation(async (sql: string, params?: unknown[]) =>
              sql.includes('SELECT repo_uuid')
                ? [{ repo_uuid: params?.[0] === '/workspace/next' ? 'repo-uuid-b' : 'repo-uuid-a' }]
                : []
            );
            h.cloudSync.getStatus.mockImplementation(async (target: string) => ({
              ...initialStatus,
              workspaceUuid: target,
            }));
            act(() => ui.setMenuOpen(true));
            await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe(uuid));
            h.cloudSync.forceSync.mockImplementationOnce(() => next.promise);
            act(() => {
              second = current!.runAutoSyncAction('force');
            });
            const forceCalls = h.cloudSync.forceSync.mock.calls.length;
            const toastCalls = h.addToast.mock.calls.length;
            await act(async () => {
              if (settlement === 'resolve')
                oldRead.resolve({ ...initialStatus, syncAxis: 'conflict', blockers: ['conflict'] });
              else oldRead.reject(new Error('Controlled old status read failure'));
              await first;
            });
            expect(current?.syncStatus?.workspaceUuid).toBe(uuid);
            expect(current?.syncStatus?.syncAxis).toBe('idle_synced');
            expect(current?.syncBusy).toBe('force');
            expect(current?.commandInFlight).toBe(true);
            expect(h.addToast).toHaveBeenCalledTimes(toastCalls);
            await act(async () => {
              await Promise.all([
                current!.runAutoSyncAction('force'),
                current!.openSyncedProject(ownershipProject),
              ]);
            });
            expect(h.cloudSync.forceSync).toHaveBeenCalledTimes(forceCalls);
            expect(h.cloudSync.openSyncedProject).not.toHaveBeenCalled();
            await act(async () => {
              next.resolve({ ok: true });
              await second;
            });
            expect(current?.commandInFlight).toBe(false);
          } finally {
            await act(async () => {
              oldRead.resolve(initialStatus);
              next.resolve({ ok: true });
              await Promise.all([first, second]);
            });
          }
        }
      );
    }

    it.each(['resolve', 'reject'] as const)(
      'ignores a stale project lookup %s after a new backup starts',
      async (settlement) => {
        const lookup = deferred<Array<{ path: string; name: string }>>();
        const next = deferred<WorkspaceSyncActionOk>();
        const ui = renderController();
        await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
        h.db.select.mockImplementationOnce(() => lookup.promise);
        let first = Promise.resolve();
        let second = Promise.resolve();
        try {
          act(() => {
            first = current!.openSyncedProject(ownershipProject);
          });
          await waitFor(() =>
            expect(h.db.select).toHaveBeenLastCalledWith(
              expect.stringContaining('SELECT path, name'),
              ['workspace-a']
            )
          );
          act(() => ui.setMenuOpen(false));
          act(() => ui.setMenuOpen(true));
          await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
          h.cloudSync.forceSync.mockImplementationOnce(() => next.promise);
          act(() => {
            second = current!.runAutoSyncAction('force');
          });
          const toastCalls = h.addToast.mock.calls.length;
          await act(async () => {
            if (settlement === 'resolve')
              lookup.resolve([{ path: '/managed/old/repo', name: 'Old synthetic project' }]);
            else lookup.reject(new Error('Controlled old project lookup failure'));
            await first;
          });
          expect(current?.commandInFlight).toBe(true);
          expect(current?.syncBusy).toBe('force');
          expect(h.addFolder).not.toHaveBeenCalled();
          expect(h.revealPath).not.toHaveBeenCalled();
          expect(ui.onProjectOpened).not.toHaveBeenCalled();
          expect(h.addToast).toHaveBeenCalledTimes(toastCalls);
          const forceCalls = h.cloudSync.forceSync.mock.calls.length;
          await act(async () => {
            await current!.openSyncedProject(ownershipProject);
            await current!.runAutoSyncAction('force');
          });
          expect(h.cloudSync.openSyncedProject).toHaveBeenCalledTimes(1);
          expect(h.cloudSync.forceSync).toHaveBeenCalledTimes(forceCalls);
          await act(async () => {
            next.resolve({ ok: true });
            await second;
          });
          expect(current?.commandInFlight).toBe(false);
        } finally {
          await act(async () => {
            lookup.resolve([]);
            next.resolve({ ok: true });
            await Promise.all([first, second]);
          });
        }
      }
    );

    it.each(['resolve', 'reject'] as const)(
      'does not enable after a stale organization lookup %s',
      async (settlement) => {
        const initialOrganizations = deferred<{
          ok: true;
          organizations: WorkspaceSyncOrganizationSummary[];
        }>();
        const commandOrganizations = deferred<{
          ok: true;
          organizations: WorkspaceSyncOrganizationSummary[];
        }>();
        const next = deferred<WorkspaceSyncActionOk>();
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        let first = Promise.resolve();
        let second = Promise.resolve();
        h.cloudSync.listOrganizations
          .mockImplementationOnce(() => initialOrganizations.promise)
          .mockImplementationOnce(() => commandOrganizations.promise);
        try {
          const ui = renderController();
          await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
          act(() => {
            first = current!.runAutoSyncAction('enable');
          });
          await waitFor(() => expect(h.cloudSync.listOrganizations).toHaveBeenCalledTimes(2));
          expect(current?.syncBusy).toBe('enable');
          act(() => ui.setMenuOpen(false));
          act(() => ui.setMenuOpen(true));
          await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
          await waitFor(() => expect(h.cloudSync.listOrganizations).toHaveBeenCalledTimes(3));
          h.cloudSync.forceSync.mockImplementationOnce(() => next.promise);
          act(() => {
            second = current!.runAutoSyncAction('force');
          });
          const toastCalls = h.addToast.mock.calls.length;
          await act(async () => {
            initialOrganizations.resolve({ ok: true, organizations: [] });
            if (settlement === 'resolve')
              commandOrganizations.resolve({ ok: true, organizations: [] });
            else commandOrganizations.reject(new Error('Controlled stale organization failure'));
            await first;
          });
          expect(h.cloudSync.setEnabled).not.toHaveBeenCalled();
          expect(current?.syncBusy).toBe('force');
          expect(current?.commandInFlight).toBe(true);
          expect(h.addToast).toHaveBeenCalledTimes(toastCalls);
          await act(async () => {
            await Promise.all([
              current!.runAutoSyncAction('force'),
              current!.openSyncedProject(ownershipProject),
            ]);
          });
          expect(h.cloudSync.forceSync).toHaveBeenCalledTimes(1);
          expect(h.cloudSync.openSyncedProject).not.toHaveBeenCalled();
          await act(async () => {
            next.resolve({ ok: true });
            await second;
          });
          expect(current?.commandInFlight).toBe(false);
        } finally {
          try {
            await act(async () => {
              initialOrganizations.resolve({ ok: true, organizations: [] });
              commandOrganizations.resolve({ ok: true, organizations: [] });
              next.resolve({ ok: true });
              await Promise.all([first, second]);
            });
          } finally {
            confirm.mockRestore();
          }
        }
      }
    );

    it.each(['resolve', 'reject'] as const)(
      'does not create a share after a stale confirmation %s',
      async (settlement) => {
        const confirmation = deferred<boolean>();
        const next = deferred<WorkspaceSyncActionOk>();
        const ui = renderController();
        await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
        h.confirmDialog.mockImplementationOnce(() => confirmation.promise);
        let first = Promise.resolve();
        let second = Promise.resolve();
        try {
          act(() => {
            first = current!.runAutoSyncAction('share');
          });
          await waitFor(() => expect(h.confirmDialog).toHaveBeenCalledTimes(1));
          expect(current?.syncBusy).toBe('share');
          act(() => ui.setMenuOpen(false));
          act(() => ui.setMenuOpen(true));
          await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
          h.cloudSync.forceSync.mockImplementationOnce(() => next.promise);
          act(() => {
            second = current!.runAutoSyncAction('force');
          });
          const toastCalls = h.addToast.mock.calls.length;
          await act(async () => {
            if (settlement === 'resolve') confirmation.resolve(true);
            else confirmation.reject(new Error('Controlled stale confirmation failure'));
            await first;
          });
          expect(h.cloudSync.copyShareLink).not.toHaveBeenCalled();
          expect(h.clipboard.writeText).not.toHaveBeenCalled();
          expect(current?.syncBusy).toBe('force');
          expect(current?.commandInFlight).toBe(true);
          expect(h.addToast).toHaveBeenCalledTimes(toastCalls);
          await act(async () => {
            await Promise.all([
              current!.runAutoSyncAction('force'),
              current!.openSyncedProject(ownershipProject),
            ]);
          });
          expect(h.cloudSync.forceSync).toHaveBeenCalledTimes(1);
          expect(h.cloudSync.openSyncedProject).not.toHaveBeenCalled();
          await act(async () => {
            next.resolve({ ok: true });
            await second;
          });
          expect(current?.commandInFlight).toBe(false);
        } finally {
          await act(async () => {
            confirmation.resolve(true);
            next.resolve({ ok: true });
            await Promise.all([first, second]);
          });
        }
      }
    );

    it.each(['resolve', 'refuse', 'reject'] as const)(
      'preserves current access loading after a stale people refresh %s',
      async (settlement) => {
        const oldAccess = deferred<WorkspaceSyncAccessListingResult>();
        const currentAccess = deferred<WorkspaceSyncAccessListingResult>();
        const next = deferred<WorkspaceSyncActionOk>();
        const listing: WorkspaceSyncAccessListing = {
          workspaceId: 'synthetic-old-workspace',
          displayName: 'Old access list',
          viewer: { role: 'owner', sources: [] },
          canManage: true,
          owner: {
            kind: 'org',
            orgId: 'synthetic-org',
            slug: 'synthetic-org',
            displayName: 'Synthetic organization',
          },
          admins: [],
          grants: [],
          invites: [],
        };
        const freshListing = {
          ...listing,
          workspaceId: 'synthetic-current-workspace',
          displayName: 'Current access list',
        };
        const ui = renderController();
        await waitFor(() => expect(current?.syncStatus?.workspaceUuid).toBe('repo-uuid-a'));
        await waitFor(() => expect(current?.accessLoading).toBe(false));
        const accessCalls = h.cloudSync.listAccess.mock.calls.length;
        h.cloudSync.listAccess.mockImplementationOnce(() => oldAccess.promise);
        h.cloudSync.revokeInvite.mockResolvedValueOnce({ ok: true });
        let first = Promise.resolve();
        let second = Promise.resolve();
        try {
          act(() => {
            first = current!.revokeInvite('synthetic-invite');
          });
          await waitFor(() =>
            expect(h.cloudSync.listAccess).toHaveBeenCalledTimes(accessCalls + 1)
          );
          expect(current?.accessLoading).toBe(true);
          act(() => ui.setMenuOpen(false));
          h.cloudSync.listAccess.mockImplementationOnce(() => currentAccess.promise);
          act(() => ui.setMenuOpen(true));
          await waitFor(() =>
            expect(h.cloudSync.listAccess).toHaveBeenCalledTimes(accessCalls + 2)
          );
          expect(current?.accessLoading).toBe(true);
          h.cloudSync.forceSync.mockImplementationOnce(() => next.promise);
          act(() => {
            second = current!.runAutoSyncAction('force');
          });
          const toastCalls = h.addToast.mock.calls.length;
          await act(async () => {
            if (settlement === 'resolve') oldAccess.resolve({ ok: true, listing });
            else if (settlement === 'refuse')
              oldAccess.resolve({
                ok: false,
                code: 'INVALID_REQUEST',
                message: 'Controlled old access refusal',
              });
            else oldAccess.reject(new Error('Controlled old access refresh failure'));
            await first;
          });
          expect(current?.access).toBeNull();
          expect(current?.accessError).toBeNull();
          expect(current?.accessLoading).toBe(true);
          expect(current?.syncBusy).toBe('force');
          expect(current?.commandInFlight).toBe(true);
          expect(h.addToast).toHaveBeenCalledTimes(toastCalls);
          await act(async () => {
            await Promise.all([
              current!.runAutoSyncAction('force'),
              current!.openSyncedProject(ownershipProject),
            ]);
          });
          expect(h.cloudSync.forceSync).toHaveBeenCalledTimes(1);
          expect(h.cloudSync.openSyncedProject).not.toHaveBeenCalled();
          await act(async () => {
            currentAccess.resolve({ ok: true, listing: freshListing });
          });
          expect(current?.access).toEqual(freshListing);
          expect(current?.accessLoading).toBe(false);
          await act(async () => {
            next.resolve({ ok: true });
            await second;
          });
          expect(current?.commandInFlight).toBe(false);
        } finally {
          await act(async () => {
            oldAccess.resolve({ ok: true, listing });
            currentAccess.resolve({ ok: true, listing: freshListing });
            next.resolve({ ok: true });
            await Promise.all([first, second]);
          });
        }
      }
    );
  });
});
