import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandlers, mockSenderSend, mockUnsubscribe } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockSenderSend: vi.fn(),
  mockUnsubscribe: vi.fn(),
}));

const {
  mockListWorkspaceSyncProjects,
  mockOpenWorkspaceSyncProject,
  mockResolveWorkspaceSyncConflict,
  mockGetDb,
  mockManagedRootDir,
  mockRecoverScientificCloudDrafts,
} = vi.hoisted(() => ({
  mockListWorkspaceSyncProjects: vi.fn(),
  mockOpenWorkspaceSyncProject: vi.fn(),
  mockResolveWorkspaceSyncConflict: vi.fn(),
  mockGetDb: vi.fn(() => ({ db: true })),
  mockManagedRootDir: vi.fn(() => '/managed-root'),
  mockRecoverScientificCloudDrafts: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../scientific-cloud-recovery-actions', () => ({
  recoverScientificCloudDrafts: mockRecoverScientificCloudDrafts,
}));

vi.mock('../workspace-sync-share', () => ({
  copyWorkspaceSyncShareLink: vi.fn(),
}));

vi.mock('../workspace-sync-projects', () => ({
  listWorkspaceSyncProjects: mockListWorkspaceSyncProjects,
  openWorkspaceSyncProject: mockOpenWorkspaceSyncProject,
}));

vi.mock('../workspace-sync-history', () => ({
  listWorkspaceSyncHistory: vi.fn(),
}));

vi.mock('../workspace-sync-conflicts', () => ({
  resolveWorkspaceSyncConflict: mockResolveWorkspaceSyncConflict,
}));

vi.mock('../auth/controller', () => ({
  getAuthState: vi.fn(() => ({
    status: 'signed-in',
    session: { accountId: 'account-a' },
  })),
}));

vi.mock('../ipc/database', () => ({
  getDb: mockGetDb,
}));

vi.mock('../ipc/workspace-git', () => ({
  managedRootDir: mockManagedRootDir,
}));

vi.mock('../workspace-git', () => ({ resolveHeadCommitSync: vi.fn() }));
vi.mock('../workspace-sync-snapshotter', () => ({
  previewWorkspaceSyncUpload: vi.fn(),
  WorkspaceSyncSnapshotError: class WorkspaceSyncSnapshotError extends Error {},
}));

import { registerWorkspaceSyncHandlers } from '../ipc/workspace-sync';
import { workspaceSyncNotImplemented } from '../../shared/workspace-sync-ipc';
import type { WorkspaceSyncStatusPublisher } from '../workspace-sync-status';
import type { WorkspaceSyncStatusEvent } from '../../shared/workspace-sync-ipc';

const status = {
  workspaceUuid: 'repo-uuid-a',
  syncAxis: 'local_only' as const,
  bufferAxis: 'clean' as const,
  canDisplayPlainSynced: false,
  shared: false,
  accessRole: null,
  accessSource: null,
  blockers: ['missing_remote_binding' as const],
  excludedAuthoritativeState: [],
  excludedSummary: null,
  terminalErrorCode: null,
  terminalErrorMessage: null,
};

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({ sender: { send: mockSenderSend } }, ...args);
}

function publisher(): WorkspaceSyncStatusPublisher {
  return {
    getStatus: vi.fn(() => status),
    subscribe: vi.fn(
      (workspaceUuid: string | null, listener: (event: WorkspaceSyncStatusEvent) => void) => {
        listener({
          workspaceUuid,
          status,
          reason: 'subscribe',
          sequence: 1,
          emittedAt: 123,
        });
        return mockUnsubscribe;
      }
    ),
    invalidate: vi.fn(() => status),
  };
}

describe('workspace sync IPC contract', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    mockSenderSend.mockClear();
    mockUnsubscribe.mockClear();
    mockListWorkspaceSyncProjects.mockReset();
    mockOpenWorkspaceSyncProject.mockReset();
    mockResolveWorkspaceSyncConflict.mockReset();
    mockRecoverScientificCloudDrafts.mockReset();
    mockGetDb.mockClear();
    mockManagedRootDir.mockClear();
    mockGetDb.mockReturnValue({ db: true });
    mockManagedRootDir.mockReturnValue('/managed-root');
  });

  it('registers the workspace-scoped auto-sync channels exposed by preload', () => {
    registerWorkspaceSyncHandlers({ statusPublisher: publisher() });

    expect([...ipcHandlers.keys()].sort()).toEqual([
      'cloudSync:changeOrganizationMemberRole',
      'cloudSync:claimOrganizationRegistryEntity',
      'cloudSync:configureOrganizationRegistry',
      'cloudSync:copyShareLink',
      'cloudSync:createOrganization',
      'cloudSync:deleteCloudCopy',
      'cloudSync:deleteOrganization',
      'cloudSync:forceSync',
      'cloudSync:getMergeConflict',
      'cloudSync:getOrganizationDeletionImpact',
      'cloudSync:getOrganizationProvisioningStatus',
      'cloudSync:getOrganizationRegistry',
      'cloudSync:getOrganizationRegistryRecordDetails',
      'cloudSync:getOrganizationRegistryRecordSyncStatus',
      'cloudSync:getOrganizationRegistrySavedRecordReview',
      'cloudSync:getOrganizationRegistrySyncHealth',
      'cloudSync:getStatus',
      'cloudSync:inviteCollaborator',
      'cloudSync:inviteOrganizationMember',
      'cloudSync:listAccess',
      'cloudSync:listCachedOrganizationRegistries',
      'cloudSync:listOrganizationAudit',
      'cloudSync:listOrganizationDirectory',
      'cloudSync:listOrganizations',
      'cloudSync:listSyncedProjects',
      'cloudSync:listWorkspaceHistory',
      'cloudSync:mutateOrganizationRegistry',
      'cloudSync:openOrganizationProvisioningPortal',
      'cloudSync:openSyncedProject',
      'cloudSync:prepareOrganizationRegistryClaim',
      'cloudSync:previewUpload',
      'cloudSync:reconcile',
      'cloudSync:recoverScientificDrafts',
      'cloudSync:removeOrganizationMember',
      'cloudSync:resendInvite',
      'cloudSync:resendOrganizationInvite',
      'cloudSync:resolveConflict',
      'cloudSync:resolveMergeConflict',
      'cloudSync:resolveOrganizationRegistryConflict',
      'cloudSync:resolveOrganizationRegistrySavedRecord',
      'cloudSync:revokeInvite',
      'cloudSync:revokeOrganizationInvite',
      'cloudSync:setAccess',
      'cloudSync:setEnabled',
      'cloudSync:setOrganizationProvisioningGroupRole',
      'cloudSync:subscribeStatus',
      'cloudSync:syncOrganizationRegistry',
      'cloudSync:transferOrganizationOwnership',
      'cloudSync:unsubscribeStatus',
      'cloudSync:updateOrganization',
    ]);
  });

  it('reads cached Registry identities only through the trusted action without renderer account input', async () => {
    const result = {
      ok: true as const,
      accountId: 'trusted-account',
      organizationIds: ['trusted-org'],
    };
    const listCachedOrganizationRegistries = vi.fn(async () => result);
    registerWorkspaceSyncHandlers({
      statusPublisher: publisher(),
      actions: { listCachedOrganizationRegistries },
    });
    await expect(
      ipcHandlers.get('cloudSync:listCachedOrganizationRegistries')!(
        {},
        { accountId: 'other-account' }
      )
    ).resolves.toEqual(result);
    expect(listCachedOrganizationRegistries).toHaveBeenCalledExactlyOnceWith();
  });

  it('validates read-only accepted history pagination before calling its adapter', async () => {
    const listWorkspaceHistory = vi.fn(async () => ({
      workspaceId: '20000000-0000-4000-8000-000000000001',
      versions: [],
      nextBeforeVersionNumber: null,
    }));
    registerWorkspaceSyncHandlers({
      statusPublisher: publisher(),
      actions: { listWorkspaceHistory },
    });
    const remoteId = '20000000-0000-4000-8000-000000000001';
    await invoke('cloudSync:listWorkspaceHistory', remoteId, {
      limit: 25,
      beforeVersionNumber: 41,
    });
    expect(listWorkspaceHistory).toHaveBeenCalledWith(remoteId, {
      limit: 25,
      beforeVersionNumber: 41,
    });
    await expect(invoke('cloudSync:listWorkspaceHistory', '../other', {})).rejects.toThrow();
    await expect(
      invoke('cloudSync:listWorkspaceHistory', remoteId, { limit: 101 })
    ).rejects.toThrow();
    await expect(
      invoke('cloudSync:listWorkspaceHistory', remoteId, { beforeVersionNumber: -1 })
    ).rejects.toThrow();
    expect(listWorkspaceHistory).toHaveBeenCalledTimes(1);
  });

  it('validates and forwards organization Registry actions', async () => {
    const orgId = '20000000-0000-4000-8000-000000000001';
    const mutationId = '50000000-0000-4000-8000-000000000001';
    const getOrganizationRegistry = vi.fn(async () => ({ ok: true, registry: {} }) as never);
    const syncOrganizationRegistry = vi.fn(async () => ({ ok: true, registry: {} }) as never);
    const mutateOrganizationRegistry = vi.fn(async () => ({ ok: true, registry: {} }) as never);
    const configureOrganizationRegistry = vi.fn(async () => ({ ok: true, registry: {} }) as never);
    const getOrganizationRegistrySyncHealth = vi.fn(
      async () => ({ ok: true, health: {} }) as never
    );
    const getOrganizationDeletionImpact = vi.fn(async () => ({ ok: true, impact: {} }) as never);
    const resolveOrganizationRegistryConflict = vi.fn(
      async () => ({ ok: true, registry: {} }) as never
    );
    registerWorkspaceSyncHandlers({
      statusPublisher: publisher(),
      actions: {
        getOrganizationRegistry,
        syncOrganizationRegistry,
        mutateOrganizationRegistry,
        configureOrganizationRegistry,
        getOrganizationRegistrySyncHealth,
        getOrganizationDeletionImpact,
        resolveOrganizationRegistryConflict,
      },
    });

    await invoke('cloudSync:getOrganizationRegistry', orgId);
    await invoke('cloudSync:syncOrganizationRegistry', orgId);
    await invoke('cloudSync:mutateOrganizationRegistry', orgId, {
      mutationId,
      operation: 'entity.create',
      payload: { name: 'MG1655', entityKind: 'strain' },
    });
    await invoke('cloudSync:configureOrganizationRegistry', orgId, {
      defaultPrefix: 'REG',
      defaultPadWidth: 6,
      schemes: [],
    });
    await invoke('cloudSync:getOrganizationRegistrySyncHealth', orgId);
    await invoke('cloudSync:getOrganizationDeletionImpact', orgId);
    await invoke('cloudSync:resolveOrganizationRegistryConflict', orgId, {
      conflictId: '60000000-0000-4000-8000-000000000001',
      resolution: 'use_remote',
    });

    expect(getOrganizationRegistry).toHaveBeenCalledWith(orgId);
    expect(syncOrganizationRegistry).toHaveBeenCalledWith(orgId);
    expect(mutateOrganizationRegistry).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ mutationId, operation: 'entity.create' })
    );
    expect(configureOrganizationRegistry).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ defaultPrefix: 'REG' })
    );
    expect(getOrganizationRegistrySyncHealth).toHaveBeenCalledWith(orgId);
    expect(getOrganizationDeletionImpact).toHaveBeenCalledWith(orgId);
    expect(resolveOrganizationRegistryConflict).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ resolution: 'use_remote' })
    );

    await expect(invoke('cloudSync:syncOrganizationRegistry', '../org')).rejects.toThrow(
      'orgId must be a UUID'
    );
    await expect(
      invoke('cloudSync:mutateOrganizationRegistry', orgId, {
        mutationId,
        operation: 'entity.delete',
        payload: {},
      })
    ).rejects.toThrow('operation');
  });

  it('reads and subscribes to status by workspace UUID without accepting paths', async () => {
    const syncStatus = publisher();
    registerWorkspaceSyncHandlers({ statusPublisher: syncStatus });

    await expect(invoke('cloudSync:getStatus', 'repo-uuid-a')).resolves.toBe(status);
    expect(syncStatus.getStatus).toHaveBeenCalledWith('repo-uuid-a');

    await expect(
      invoke('cloudSync:subscribeStatus', {
        workspaceUuid: 'repo-uuid-a',
        subscriptionId: 'sub-a',
      })
    ).resolves.toEqual({ ok: true, subscriptionId: 'sub-a' });
    expect(mockSenderSend).toHaveBeenCalledWith('cloudSync:statusChanged', {
      workspaceUuid: 'repo-uuid-a',
      status,
      reason: 'subscribe',
      sequence: 1,
      emittedAt: 123,
    });

    await expect(invoke('cloudSync:unsubscribeStatus', 'sub-a')).resolves.toEqual({ ok: true });
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

    await expect(invoke('cloudSync:getStatus', '/tmp/workspace')).rejects.toThrow(
      'workspaceUuid must be a workspace UUID'
    );
    expect(syncStatus.getStatus).toHaveBeenCalledTimes(1);
  });

  it('validates action parameters before invoking action handlers', async () => {
    const notImplemented = async (action: string) => workspaceSyncNotImplemented(action);

    registerWorkspaceSyncHandlers({
      statusPublisher: publisher(),
      actions: {
        forceSync: () => notImplemented('forceSync'),
        setEnabled: () => notImplemented('setEnabled'),
        resolveConflict: () => notImplemented('resolveConflict'),
        deleteCloudCopy: () => notImplemented('deleteCloudCopy'),
        copyShareLink: () => notImplemented('copyShareLink'),
        listSyncedProjects: async () => [],
        openSyncedProject: () => notImplemented('openSyncedProject'),
      },
    });

    await expect(invoke('cloudSync:forceSync', 'repo-uuid-a')).resolves.toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    await expect(invoke('cloudSync:setEnabled', 'repo-uuid-a', true)).resolves.toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    await expect(
      invoke('cloudSync:resolveConflict', 'repo-uuid-a', 'keep_local')
    ).resolves.toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    await expect(invoke('cloudSync:deleteCloudCopy', 'repo-uuid-a')).resolves.toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    await expect(invoke('cloudSync:copyShareLink', 'repo-uuid-a')).resolves.toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    await expect(invoke('cloudSync:listSyncedProjects')).resolves.toEqual([]);
    await expect(
      invoke('cloudSync:openSyncedProject', 'remote-workspace-a')
    ).resolves.toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });

    await expect(invoke('cloudSync:forceSync', '../workspace')).rejects.toThrow(
      'workspaceUuid must be a workspace UUID'
    );
    await expect(invoke('cloudSync:setEnabled', 'repo-uuid-a', 'yes')).rejects.toThrow(
      'enabled must be a boolean'
    );
    await expect(invoke('cloudSync:openSyncedProject', '/tmp/remote')).rejects.toThrow(
      'remoteWorkspaceId must be a workspace UUID'
    );
  });

  it('wires default list/open project actions to the main-process sync project helper', async () => {
    const project = {
      remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
      displayName: 'Project A',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      latestVersionId: '54a53fed-2b63-44c8-a26e-b0fb7e1788d2',
      latestVersionNumber: 3,
      updatedAt: 1783468800000,
    };
    mockListWorkspaceSyncProjects.mockResolvedValueOnce([project]);
    mockOpenWorkspaceSyncProject.mockResolvedValueOnce({ ok: true, workspaceUuid: 'workspace-a' });

    registerWorkspaceSyncHandlers({ statusPublisher: publisher() });

    await expect(invoke('cloudSync:listSyncedProjects')).resolves.toEqual([project]);
    expect(mockListWorkspaceSyncProjects).toHaveBeenCalledTimes(1);

    await expect(
      invoke('cloudSync:openSyncedProject', '8a4d99e9-2347-4d04-a447-d3070f7a7f9a')
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });
    expect(mockOpenWorkspaceSyncProject).toHaveBeenCalledWith(
      { db: true },
      {
        remoteWorkspaceId: '8a4d99e9-2347-4d04-a447-d3070f7a7f9a',
        managedRootDir: '/managed-root',
      }
    );
  });

  it('validates recovery identities and keeps its database and paths under the main owner', async () => {
    const candidateId = '54a53fed-2b63-44c8-a26e-b0fb7e1788d2';
    mockRecoverScientificCloudDrafts.mockResolvedValueOnce({ ok: true });
    registerWorkspaceSyncHandlers({ statusPublisher: publisher() });

    await expect(
      invoke('cloudSync:recoverScientificDrafts', 'workspace-a', '/foreign/path')
    ).rejects.toThrow('candidateId');
    expect(mockRecoverScientificCloudDrafts).not.toHaveBeenCalled();
    await expect(
      invoke('cloudSync:recoverScientificDrafts', 'workspace-a', candidateId)
    ).resolves.toEqual({ ok: true });
    expect(mockRecoverScientificCloudDrafts).toHaveBeenCalledExactlyOnceWith(
      { db: true },
      { workspaceUuid: 'workspace-a', candidateId }
    );
  });

  it('wires default conflict resolution action to the main-process sync conflict helper', async () => {
    mockResolveWorkspaceSyncConflict.mockResolvedValueOnce({
      ok: true,
      resolution: 'keep_local',
    });

    registerWorkspaceSyncHandlers({ statusPublisher: publisher() });

    await expect(invoke('cloudSync:resolveConflict', 'repo-uuid-a', 'keep_local')).resolves.toEqual(
      { ok: true, resolution: 'keep_local' }
    );
    expect(mockResolveWorkspaceSyncConflict).toHaveBeenCalledWith(
      { db: true },
      {
        workspaceUuid: 'repo-uuid-a',
        resolution: 'keep_local',
        managedRootDir: '/managed-root',
      }
    );
  });

  it('refuses cloud deletion when no runtime-owned action handler was supplied', async () => {
    registerWorkspaceSyncHandlers({ statusPublisher: publisher() });

    await expect(invoke('cloudSync:deleteCloudCopy', 'repo-uuid-a')).resolves.toEqual({
      ok: false,
      code: 'NOT_IMPLEMENTED',
      message: 'deleteCloudCopy is not implemented yet.',
    });
  });
});
