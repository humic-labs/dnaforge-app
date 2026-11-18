import { expectToastCall } from '../../test/toast-assertions';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import type { DesktopAuthState } from '../../shared/auth-types';
import type { WorkspaceSyncUploadPreviewOk } from '../../shared/workspace-sync-ipc';

const h = vi.hoisted(() => ({
  enabled: true,
  cloudSyncEnabled: true,
  state: { status: 'signed-out' } as DesktopAuthState,
  startSignIn: vi.fn(),
  signOut: vi.fn(),
  init: vi.fn(),
  folders: [
    { path: '/workspace/project', name: 'Project', addedAt: 1 },
    { path: '/workspace/dev-assets', name: 'Dev Assets', addedAt: 2, pinned: true },
  ],
  activeWorkspaceFile: '/workspace/project/project.waypoint-workspace',
  selectedPath: '/workspace/project',
  addFolder: vi.fn(),
  revealPath: vi.fn(),
  addToast: vi.fn(),
  db: {
    select: vi.fn(),
  },
  clipboard: {
    writeText: vi.fn(),
  },
  cloudSync: {
    backupWorkspace: vi.fn(),
    shareWorkspace: vi.fn(),
    restoreSnapshot: vi.fn(),
    getStatus: vi.fn(),
    subscribeStatus: vi.fn(),
    setEnabled: vi.fn(),
    forceSync: vi.fn(),
    copyShareLink: vi.fn(),
    listSyncedProjects: vi.fn(),
    openSyncedProject: vi.fn(),
    previewUpload: vi.fn().mockResolvedValue({
      ok: true,
      workspaceUuid: 'workspace-a',
      includedFiles: [
        { relativePath: 'plasmid.gb', name: 'plasmid.gb', kind: 'genbank', sizeBytes: 128 },
      ],
      includedFileCount: 1,
      includedBytes: 128,
      excludedSummary: { ignoredCount: 0 },
      limits: { maxFileBytes: 32 * 1024 * 1024, maxBundleBytes: 256 * 1024 * 1024, maxFiles: 2000 },
    } satisfies WorkspaceSyncUploadPreviewOk),
    resolveConflict: vi.fn(),
    deleteCloudCopy: vi.fn(),
    listOrganizations: vi.fn().mockResolvedValue({ ok: true, organizations: [] }),
    createOrganization: vi.fn(),
    updateOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
    listOrganizationDirectory: vi.fn().mockResolvedValue({
      ok: false,
      code: 'NOT_IMPLEMENTED',
      message: 'n/a',
    }),
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
}));

vi.mock('./useDesktopSignInEnabled', () => ({ useDesktopSignInEnabled: () => h.enabled }));
vi.mock('./useWorkspaceCloudSyncEnabled', () => ({
  useWorkspaceCloudSyncEnabled: () => h.cloudSyncEnabled,
}));
vi.mock('../../components/confirm-dialog-store', () => ({
  confirmDialog: vi.fn(async () => true),
}));
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({
      state: h.state,
      init: h.init,
      startSignIn: h.startSignIn,
      signOut: h.signOut,
    }),
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      folders: h.folders,
      activeWorkspaceFile: h.activeWorkspaceFile,
      selectedPath: h.selectedPath,
      addFolder: h.addFolder,
      revealPath: h.revealPath,
    }),
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: (selector: (s: unknown) => unknown) =>
    selector({
      addToast: h.addToast,
    }),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ cloudSync: h.cloudSync, db: h.db, clipboard: h.clipboard }),
}));

import { AccountActivityButton } from './AccountActivityButton';
import {
  openProjectSharing,
  subscribeOrganizationsSettings,
  subscribeSettingsEntry,
} from './cloud-surface-store';

async function openCloudBackup(): Promise<void> {
  fireEvent.click(screen.getByTestId('account-button'));
  fireEvent.click(screen.getByTestId('account-cloud-backup'));
  expect(await screen.findByTestId('account-cloud-backup-modal')).toBeTruthy();
}

const SIGNED_IN: DesktopAuthState = {
  status: 'signed-in',
  session: {
    accountId: 'a',
    desktopSessionId: 's',
    email: 'me@example.com',
    channel: 'stable',
    accessTokenExpiresAt: '2030-01-01T00:00:00Z',
  },
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.enabled = true;
  h.cloudSyncEnabled = true;
  h.state = { status: 'signed-out' };
  h.folders = [
    { path: '/workspace/project', name: 'Project', addedAt: 1 },
    { path: '/workspace/dev-assets', name: 'Dev Assets', addedAt: 2, pinned: true },
  ];
  h.activeWorkspaceFile = '/workspace/project/project.waypoint-workspace';
  h.selectedPath = '/workspace/project';
  h.cloudSync.backupWorkspace.mockResolvedValue({
    snapshot: { fileCount: 2, displayName: 'Project' },
  });
  h.cloudSync.shareWorkspace.mockResolvedValue({
    snapshot: { fileCount: 2, displayName: 'Project' },
    share: { url: 'https://dnaforge.com/d/share?token=tok' },
  });
  h.cloudSync.restoreSnapshot.mockResolvedValue({
    snapshot: { displayName: 'Project' },
    workspace: { repoPath: '/managed/restored', displayName: 'Project restored' },
  });
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
  h.cloudSync.setEnabled.mockResolvedValue({ ok: false, code: 'NOT_IMPLEMENTED' });
  h.cloudSync.forceSync.mockResolvedValue({ ok: false, code: 'NOT_IMPLEMENTED' });
  h.cloudSync.copyShareLink.mockResolvedValue({
    ok: true,
    url: 'https://dnaforge.com/d/sync-share',
    versionId: 'version-a',
  });
  h.clipboard.writeText.mockResolvedValue(undefined);
  h.cloudSync.listSyncedProjects.mockResolvedValue([]);
  h.cloudSync.listOrganizations.mockResolvedValue({ ok: true, organizations: [] });
  h.cloudSync.listAccess.mockResolvedValue({ ok: false, code: 'NOT_IMPLEMENTED', message: 'n/a' });
  h.cloudSync.getMergeConflict.mockResolvedValue({ ok: true, conflict: null });
  h.cloudSync.openSyncedProject.mockResolvedValue({ ok: true, workspaceUuid: 'workspace-a' });
  h.cloudSync.resolveConflict.mockResolvedValue({ ok: true, resolution: 'keep_local' });
  h.cloudSync.deleteCloudCopy.mockResolvedValue({
    ok: true,
    remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
    sharesRevoked: 1,
    objectsRemoved: 1,
    readyVersionsDeleted: 1,
  });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('AccountActivityButton (bottom-left auth entry)', () => {
  it('renders nothing when the feature flag is off', () => {
    h.enabled = false;
    const { container } = render(<AccountActivityButton />);
    expect(container.firstChild).toBeNull();
  });

  it('signed-out → clicking the profile icon opens a popover (NOT the picker)', () => {
    render(<AccountActivityButton />);
    expect(screen.queryByTestId('account-menu')).toBeNull();
    fireEvent.click(screen.getByTestId('account-button'));
    expect(h.startSignIn).not.toHaveBeenCalled();
    expect(screen.getByTestId('account-menu')).toBeTruthy();
    expect(screen.getByTestId('account-email').textContent).toContain('Not signed in');
    expect(screen.queryByTestId('account-sync-status')).toBeNull();
    expect(screen.queryByTestId('account-cloud-backup')).toBeNull();
    expect(screen.queryByTestId('account-cloud-backup-scope')).toBeNull();
    expect(screen.queryByTestId('account-settings')).toBeNull();
    expect(screen.queryByText('Account settings')).toBeNull();
    expect(screen.getByTestId('account-avatar')).toBeTruthy();
  });

  it('signed-in → Account settings opens Settings, not a modal', () => {
    const open = vi.fn();
    const unsub = subscribeSettingsEntry(open);
    h.state = SIGNED_IN;
    render(<AccountActivityButton />);
    fireEvent.click(screen.getByTestId('account-button'));
    const settings = screen.getByTestId('account-settings') as HTMLButtonElement;
    expect(settings.disabled).toBe(false);
    fireEvent.click(settings);
    expect(open).toHaveBeenCalledWith('account');
    expect(screen.queryByTestId('account-settings-modal')).toBeNull();
    unsub();
  });

  it('signed-out → Sign in (inside the popover) starts the flow', () => {
    render(<AccountActivityButton />);
    fireEvent.click(screen.getByTestId('account-button'));
    expect(screen.getByTestId('account-sign-in')).toHaveTextContent('Sign in');
    fireEvent.click(screen.getByTestId('account-sign-in'));
    expect(h.startSignIn).toHaveBeenCalled();
  });

  it('in-flow → the Sign in action is disabled (busy)', () => {
    h.state = { status: 'awaiting-confirmation' };
    render(<AccountActivityButton />);
    fireEvent.click(screen.getByTestId('account-button'));
    expect((screen.getByTestId('account-sign-in') as HTMLButtonElement).disabled).toBe(true);
  });

  it('signed-in → profile button opens a menu with the identity + Sign out', () => {
    h.state = SIGNED_IN;
    render(<AccountActivityButton />);
    expect(screen.queryByTestId('account-menu')).toBeNull();

    fireEvent.click(screen.getByTestId('account-button'));
    expect(screen.getByTestId('account-menu')).toBeTruthy();
    expect(screen.getByTestId('account-email').textContent).toContain('me@example.com');
    expect(screen.getByTestId('account-cloud-backup')).toBeTruthy();
    expect(screen.queryByTestId('account-sync-status')).toBeNull();
    expect(screen.queryByTestId('account-cloud-backup-modal')).toBeNull();
    expect(screen.queryByText('Cloud projects')).toBeNull();
    expect(screen.queryByTestId('account-cloud-backup-scope')).toBeNull();
    expect(screen.queryByTestId('account-backup-now')).toBeNull();
    expect(screen.queryByTestId('account-share-workspace')).toBeNull();
    expect(screen.queryByTestId('account-restore-latest')).toBeNull();
    expect(screen.queryByText('Create manual snapshot')).toBeNull();
    expect(screen.queryByText('Auto sync')).toBeNull();
    expect(screen.queryByText('Synced projects')).toBeNull();

    fireEvent.click(screen.getByTestId('account-sign-out'));
    expect(h.signOut).toHaveBeenCalled();
  });

  it('signed-in → Cloud backup opens a modal with the file list and actions', async () => {
    h.state = SIGNED_IN;
    render(<AccountActivityButton />);
    await openCloudBackup();
    expect(screen.getByTestId('account-sync-status')).toBeTruthy();
    expect(await screen.findByText('plasmid.gb')).toBeTruthy();
    expect(screen.getByText('Cloud projects')).toBeTruthy();
    expect(screen.getByTestId('account-enable-sync')).toBeTruthy();
  });

  it('signed-in → Organizations opens organization settings, not a modal', () => {
    const open = vi.fn();
    const unsub = subscribeOrganizationsSettings(open);
    h.state = SIGNED_IN;
    render(<AccountActivityButton />);
    fireEvent.click(screen.getByTestId('account-button'));
    fireEvent.click(screen.getByTestId('account-manage-orgs'));
    expect(open).toHaveBeenCalled();
    expect(screen.queryByTestId('account-cloud-backup-modal')).toBeNull();
    unsub();
  });

  it('signed-in without cloud sync still offers Organizations', () => {
    h.cloudSyncEnabled = false;
    h.state = SIGNED_IN;
    render(<AccountActivityButton />);
    fireEvent.click(screen.getByTestId('account-button'));
    expect(screen.getByTestId('account-manage-orgs')).toBeTruthy();
    expect(screen.queryByTestId('account-cloud-backup')).toBeNull();
    expect(screen.queryByTestId('account-people-sharing')).toBeNull();
  });

  it('signed-in → account menu has Organizations and Cloud backup, not People & sharing', async () => {
    h.state = SIGNED_IN;
    render(<AccountActivityButton />);
    fireEvent.click(screen.getByTestId('account-button'));
    expect(screen.getByTestId('account-manage-orgs')).toBeTruthy();
    expect(screen.getByTestId('account-cloud-backup')).toBeTruthy();
    expect(screen.queryByTestId('account-people-sharing')).toBeNull();
    expect(screen.queryByText('People & sharing')).toBeNull();
    fireEvent.click(screen.getByTestId('account-cloud-backup'));
    expect(await screen.findByTestId('account-cloud-backup-modal')).toBeTruthy();
    expect(screen.getByText('Cloud backup')).toBeTruthy();
    expect(screen.queryByTestId('shared-project-people')).toBeNull();
  });

  it('Share on the project opens this-project access, not the account menu', async () => {
    h.state = SIGNED_IN;
    render(<AccountActivityButton />);
    act(() => {
      openProjectSharing();
    });
    expect(await screen.findByTestId('project-sharing-modal')).toBeTruthy();
    expect(screen.getByText('This project')).toBeTruthy();
    expect(screen.queryByTestId('account-people-sharing')).toBeNull();
    expect(screen.getByTestId('shared-project-people')).toBeTruthy();
    expect(screen.queryByTestId('account-cloud-backup-modal')).toBeNull();
  });

  it('signed-in title falls back to displayName/Signed in when no email', async () => {
    h.state = {
      status: 'signed-in',
      session: {
        accountId: 'a',
        desktopSessionId: 's',
        displayName: 'Ada',
        channel: 'stable',
        accessTokenExpiresAt: '2030-01-01T00:00:00Z',
      },
    };
    render(<AccountActivityButton />);
    fireEvent.click(screen.getByTestId('account-button'));
    expect(screen.getByTestId('account-email').textContent).toContain('Ada');
  });

  it('signed-in → cloud backup controls use the managed repo UUID, never the folder path', async () => {
    h.state = SIGNED_IN;
    render(<AccountActivityButton />);
    await openCloudBackup();

    await screen.findByText('Up to date');
    expect(h.db.select).toHaveBeenCalledWith(expect.stringContaining('SELECT repo_uuid'), [
      '/workspace/project',
    ]);
    expect(h.cloudSync.getStatus).toHaveBeenCalledWith('repo-uuid-a');
    expect(h.cloudSync.subscribeStatus).toHaveBeenCalledWith('repo-uuid-a', expect.any(Function));

    fireEvent.click(screen.getByTestId('account-sync-now'));
    await waitFor(() => expect(h.cloudSync.forceSync).toHaveBeenCalledWith('repo-uuid-a'));
    expect(h.cloudSync.forceSync).not.toHaveBeenCalledWith('/workspace/project');

    fireEvent.click(screen.getByTestId('account-copy-sync-link'));
    await waitFor(() => expect(h.cloudSync.copyShareLink).toHaveBeenCalledWith('repo-uuid-a'));
    await waitFor(() =>
      expect(h.clipboard.writeText).toHaveBeenCalledWith('https://dnaforge.com/d/sync-share')
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('signed-in → cloud backup follows the selected managed root in a multi-root workspace', async () => {
    h.state = SIGNED_IN;
    h.folders = [
      { path: '/workspace/other', name: 'Other', addedAt: 1 },
      { path: '/workspace/managed', name: 'Managed', addedAt: 2 },
    ];
    h.selectedPath = '/workspace/managed/pUC19.gb';

    render(<AccountActivityButton />);
    await openCloudBackup();

    await screen.findByText('Up to date');
    expect(h.db.select).toHaveBeenCalledWith(expect.stringContaining('SELECT repo_uuid'), [
      '/workspace/managed',
    ]);
    expect(h.db.select).not.toHaveBeenCalledWith(expect.stringContaining('SELECT repo_uuid'), [
      '/workspace/other',
    ]);
  });

  it('signed-in → Remove cloud copy uses the managed repo UUID after confirmation', async () => {
    h.state = SIGNED_IN;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<AccountActivityButton />);
    await openCloudBackup();

    await screen.findByText('Up to date');
    fireEvent.click(screen.getByTestId('account-delete-cloud-copy'));

    await waitFor(() => expect(h.cloudSync.deleteCloudCopy).toHaveBeenCalledWith('repo-uuid-a'));
    expect(h.cloudSync.deleteCloudCopy).not.toHaveBeenCalledWith('/workspace/project');
    expect(confirmSpy).toHaveBeenCalled();
    expectToastCall(h.addToast, 'Cloud copy removed. This project is now local only.', 'success');

    confirmSpy.mockRestore();
  });

  it('signed-in → canceling Remove cloud copy does not call IPC', async () => {
    h.state = SIGNED_IN;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<AccountActivityButton />);
    await openCloudBackup();

    await screen.findByText('Up to date');
    fireEvent.click(screen.getByTestId('account-delete-cloud-copy'));

    expect(h.cloudSync.deleteCloudCopy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('signed-in → non-managed workspaces render local-only backup state', async () => {
    h.state = SIGNED_IN;
    h.db.select.mockResolvedValueOnce([]);
    render(<AccountActivityButton />);
    await openCloudBackup();

    await screen.findByText('Local only');
    expect(h.cloudSync.getStatus).not.toHaveBeenCalled();
    expect((screen.getByTestId('account-sync-now') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('account-enable-sync') as HTMLButtonElement).disabled).toBe(true);
  });

  it('signed-in → conflict controls resolve by managed repo UUID after explicit confirmation', async () => {
    h.state = SIGNED_IN;
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
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<AccountActivityButton />);
    await openCloudBackup();

    await screen.findByText('Backup conflict');
    fireEvent.click(screen.getByTestId('account-resolve-keep-local'));

    await waitFor(() =>
      expect(h.cloudSync.resolveConflict).toHaveBeenCalledWith('repo-uuid-a', 'keep_local')
    );
    expect(h.cloudSync.resolveConflict).not.toHaveBeenCalledWith(
      '/workspace/project',
      'keep_local'
    );
    expect(confirmSpy).toHaveBeenCalled();
    expectToastCall(h.addToast, 'Local changes queued for backup.', 'success');

    confirmSpy.mockRestore();
  });

  it('signed-in → canceling conflict replacement does not call IPC', async () => {
    h.state = SIGNED_IN;
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
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<AccountActivityButton />);
    await openCloudBackup();

    await screen.findByText('Backup conflict');
    fireEvent.click(screen.getByTestId('account-resolve-keep-local'));

    expect(h.cloudSync.resolveConflict).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('signed-in → lists cloud projects and opens one by remote workspace id', async () => {
    h.state = SIGNED_IN;
    h.cloudSync.listSyncedProjects.mockResolvedValueOnce([
      {
        remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
        displayName: 'Project A',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        latestVersionId: '54a53fed-2b63-44c8-a26e-b0fb7e1788d2',
        latestVersionNumber: 3,
        updatedAt: 1783468800000,
      },
    ]);
    render(<AccountActivityButton />);
    await openCloudBackup();

    const openProjectButton = await screen.findByTestId('account-open-synced-project');
    expect(openProjectButton.textContent).toContain('Project A');
    expect(openProjectButton.textContent).toContain('v3');

    fireEvent.click(openProjectButton);

    await waitFor(() =>
      expect(h.cloudSync.openSyncedProject).toHaveBeenCalledWith(
        '8a4d99e9-2347-4d04-a447-d3070f7a7f9a'
      )
    );
    expect(h.cloudSync.openSyncedProject).not.toHaveBeenCalledWith('/workspace/project');
    expect(h.db.select).toHaveBeenCalledWith(expect.stringContaining('SELECT path, name'), [
      'workspace-a',
    ]);
    expect(h.addFolder).toHaveBeenCalledWith('/managed/workspace-a/repo', 'Project A');
    expect(h.revealPath).toHaveBeenCalledWith('/managed/workspace-a/repo');
    expectToastCall(h.addToast, 'Opened Project A.', 'success');
  });

  it('signed-in → shows exclusion aggregates when present on status', async () => {
    h.state = SIGNED_IN;
    h.cloudSync.getStatus.mockResolvedValue({
      workspaceUuid: 'repo-uuid-a',
      syncAxis: 'dirty_pending',
      bufferAxis: 'clean',
      canDisplayPlainSynced: false,
      blockers: ['excluded_authoritative_state'],
      excludedAuthoritativeState: [],
      excludedSummary: { privateRawDataCount: 2, unsupportedCount: 1 },
      terminalErrorCode: null,
      terminalErrorMessage: null,
    });
    render(<AccountActivityButton />);
    await openCloudBackup();
    await screen.findByText('Some files stay local');
    expect(screen.getByTestId('account-cloud-backup-exclusions').textContent).toContain(
      'Left local: 2 raw/sequencing, 1 unsupported type.'
    );
  });
});
