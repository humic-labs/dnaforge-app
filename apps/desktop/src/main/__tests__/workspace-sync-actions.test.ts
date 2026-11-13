import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { openWorkspaceSyncProject } from '../workspace-sync-projects';
import type { resolveWorkspaceSyncConflict } from '../workspace-sync-conflicts';

const actionBoundaryMocks = vi.hoisted(() => ({
  listWorkspaceSyncProjects: vi.fn(),
  openWorkspaceSyncProject: vi.fn<typeof openWorkspaceSyncProject>(),
  resolveWorkspaceSyncConflict: vi.fn<typeof resolveWorkspaceSyncConflict>(),
  managedRootDir: vi.fn(() => '/managed-root'),
  createOrganizationRegistryActionHandlers: vi.fn(() => ({
    getOrganizationRegistry: vi.fn(),
    syncOrganizationRegistry: vi.fn(),
    mutateOrganizationRegistry: vi.fn(),
    configureOrganizationRegistry: vi.fn(),
    getOrganizationRegistrySyncHealth: vi.fn(),
    getOrganizationDeletionImpact: vi.fn(),
    resolveOrganizationRegistryConflict: vi.fn(),
  })),
}));

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

vi.mock('@sentry/electron/main', () => ({
  captureMessage: vi.fn(),
}));

vi.mock('../desktop-sync-client', () => ({
  createDesktopSyncClient: vi.fn(() => ({
    requestJson: vi.fn(),
  })),
}));

vi.mock('../workspace-sync-projects', () => ({
  listWorkspaceSyncProjects: actionBoundaryMocks.listWorkspaceSyncProjects,
  openWorkspaceSyncProject: actionBoundaryMocks.openWorkspaceSyncProject,
}));

vi.mock('../workspace-sync-conflicts', () => ({
  resolveWorkspaceSyncConflict: actionBoundaryMocks.resolveWorkspaceSyncConflict,
}));

vi.mock('../ipc/workspace-git', () => ({
  managedRootDir: actionBoundaryMocks.managedRootDir,
}));

vi.mock('../org-registry-actions', () => ({
  createOrganizationRegistryActionHandlers:
    actionBoundaryMocks.createOrganizationRegistryActionHandlers,
}));

import { ensureSchema } from '../schema';
import {
  createWorkspaceSyncActionHandlers,
  createWorkspaceSyncClaimClient,
  forceWorkspaceSync,
  setWorkspaceSyncEnabled,
  withWorkspaceSyncReplacementSourceQuiesced,
  type WorkspaceSyncActionRuntime,
} from '../workspace-sync-actions';
import { createTestDb } from './test-db';
import type { StoredSession } from '../auth/session-store';
import type { DesktopSyncClient } from '../desktop-sync-client';

const REMOTE_WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const REMOTE_WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('workspace sync product actions', () => {
  let db: Database.Database;
  let runtime: WorkspaceSyncActionRuntime;
  let statusPublisher: { invalidate: ReturnType<typeof vi.fn> };
  let claimWorkspace: ReturnType<typeof vi.fn>;
  let activeSession: StoredSession | null;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    ensureSchema(db, ':memory:');
    runtime = {
      ensureWatchingWorkspace: vi.fn(async () => undefined),
      stopWatchingWorkspace: vi.fn(),
      pauseWorkspace: vi.fn(),
      resumeWorkspace: vi.fn(),
      flushWorkspace: vi.fn(async () => ({ status: 'uploaded' })),
      waitForIdle: vi.fn(async () => undefined),
    };
    statusPublisher = { invalidate: vi.fn() };
    claimWorkspace = vi.fn(async (request) => ({
      remoteWorkspaceId: REMOTE_WORKSPACE_A,
      clientWorkspaceId: request.clientWorkspaceId,
      claimedByAccountId: request.ownerAccountId,
      owner: request.ownerOrgId
        ? { kind: 'org' as const, orgId: request.ownerOrgId }
        : { kind: 'personal' as const, accountId: request.ownerAccountId },
      remoteLatestVersionId: null,
      remoteLatestVersionNumber: null,
      remoteLatestContentSha256: null,
    }));
    activeSession = session();
    seedWorkspace(db);
  });

  it('enables sync by claiming, binding, watching, and flushing the managed workspace', async () => {
    await expect(setWorkspaceSyncEnabled(db, 'workspace-a', true, deps())).resolves.toEqual({
      ok: true,
    });

    expect(claimWorkspace).toHaveBeenCalledWith({
      clientWorkspaceId: 'workspace-a',
      displayName: 'Project A',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
    });
    expect(binding()).toMatchObject({
      workspace_uuid: 'workspace-a',
      owner_account_id: 'account-a',
      remote_workspace_id: REMOTE_WORKSPACE_A,
      enabled: 1,
    });
    expect(runtime.ensureWatchingWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.flushWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(statusPublisher.invalidate).toHaveBeenCalledWith('workspace-a', 'binding_changed');
    expect(statusPublisher.invalidate).toHaveBeenCalledWith('workspace-a', 'queue_changed');
  });

  it('retains committed native enablement when the initial upload fails', async () => {
    vi.mocked(runtime.flushWorkspace).mockResolvedValueOnce({
      status: 'failed',
      errorCode: 'QUOTA_EXCEEDED',
    });
    await expect(setWorkspaceSyncEnabled(db, 'workspace-a', true, deps())).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('QUOTA_EXCEEDED'),
    });
    expect(binding()).toMatchObject({ enabled: 1, remote_workspace_id: REMOTE_WORKSPACE_A });
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('_workspace_sync_enablement_v1:workspace-a') as { value: string };
    expect(JSON.parse(row.value)).toMatchObject({
      format: 'workspace-sync-enablement',
      workspaceUuid: 'workspace-a',
      episodes: [
        {
          operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          parentOperationId: null,
        },
      ],
    });
  });

  it('includes the organization Registry actions in the production cloud-sync handler set', () => {
    const handlers = createWorkspaceSyncActionHandlers(db, deps());

    expect(actionBoundaryMocks.createOrganizationRegistryActionHandlers).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ getActiveSession: expect.any(Function) })
    );
    expect(handlers).toEqual(
      expect.objectContaining({
        getOrganizationRegistry: expect.any(Function),
        syncOrganizationRegistry: expect.any(Function),
        mutateOrganizationRegistry: expect.any(Function),
        configureOrganizationRegistry: expect.any(Function),
        getOrganizationRegistrySyncHealth: expect.any(Function),
        getOrganizationDeletionImpact: expect.any(Function),
        resolveOrganizationRegistryConflict: expect.any(Function),
      })
    );
  });

  it('pauses and drains the source workspace around an atomic replacement', async () => {
    let releaseIdle!: () => void;
    vi.mocked(runtime.waitForIdle).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseIdle = resolve))
    );
    const operation = vi.fn(async () => 'replaced');

    const replacement = withWorkspaceSyncReplacementSourceQuiesced(
      runtime,
      'workspace-a',
      operation
    );
    expect(runtime.pauseWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.stopWatchingWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.waitForIdle).toHaveBeenCalledWith('workspace-a');
    expect(operation).not.toHaveBeenCalled();

    releaseIdle();
    await expect(replacement).resolves.toBe('replaced');
    expect(operation).toHaveBeenCalledOnce();
    expect(runtime.stopWatchingWorkspace).toHaveBeenCalledTimes(2);
    expect(runtime.resumeWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.ensureWatchingWorkspace).toHaveBeenCalledWith('workspace-a');
  });

  it('wires source quiescing through the production open-project handler', async () => {
    const events: string[] = [];
    vi.mocked(runtime.pauseWorkspace).mockImplementation(() => events.push('pause'));
    vi.mocked(runtime.stopWatchingWorkspace).mockImplementation(() => events.push('stop'));
    vi.mocked(runtime.waitForIdle).mockImplementation(async () => {
      events.push('idle');
    });
    vi.mocked(runtime.resumeWorkspace).mockImplementation(() => events.push('resume'));
    vi.mocked(runtime.ensureWatchingWorkspace).mockImplementation(async () => {
      events.push('watch');
    });
    actionBoundaryMocks.openWorkspaceSyncProject.mockImplementationOnce(async (_db, input) => {
      if (!input.withReplacementSourceQuiesced) {
        throw new Error('Missing replacement-source quiescer.');
      }
      await input.withReplacementSourceQuiesced('workspace-a', async () => {
        events.push('operation');
        return { ok: true as const, workspaceUuid: 'workspace-a' };
      });
      return { ok: true, workspaceUuid: 'workspace-a' };
    });

    const handlers = createWorkspaceSyncActionHandlers(db, deps());
    await expect(handlers.openSyncedProject?.(REMOTE_WORKSPACE_A)).resolves.toEqual({
      ok: true,
      workspaceUuid: 'workspace-a',
    });

    expect(events).toEqual(['pause', 'stop', 'idle', 'stop', 'operation', 'resume', 'watch']);
    expect(actionBoundaryMocks.openWorkspaceSyncProject).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        remoteWorkspaceId: REMOTE_WORKSPACE_A,
        managedRootDir: '/managed-root',
        withReplacementSourceQuiesced: expect.any(Function),
      })
    );
  });

  it('wires source quiescing through the production conflict-resolution handler', async () => {
    const events: string[] = [];
    vi.mocked(runtime.pauseWorkspace).mockImplementation(() => events.push('pause'));
    vi.mocked(runtime.stopWatchingWorkspace).mockImplementation(() => events.push('stop'));
    vi.mocked(runtime.waitForIdle).mockImplementation(async () => {
      events.push('idle');
    });
    vi.mocked(runtime.resumeWorkspace).mockImplementation(() => events.push('resume'));
    vi.mocked(runtime.ensureWatchingWorkspace).mockImplementation(async () => {
      events.push('watch');
    });
    actionBoundaryMocks.resolveWorkspaceSyncConflict.mockImplementationOnce(async (_db, input) => {
      if (!input.withReplacementSourceQuiesced) {
        throw new Error('Missing replacement-source quiescer.');
      }
      await input.withReplacementSourceQuiesced('workspace-a', async () => {
        events.push('operation');
        return {
          ok: true as const,
          resolution: 'use_remote' as const,
          workspaceUuid: 'workspace-a',
        };
      });
      return { ok: true, resolution: 'use_remote', workspaceUuid: 'workspace-a' };
    });

    const handlers = createWorkspaceSyncActionHandlers(db, deps());
    await expect(handlers.resolveConflict?.('workspace-a', 'use_remote')).resolves.toEqual({
      ok: true,
      resolution: 'use_remote',
      workspaceUuid: 'workspace-a',
    });

    expect(events).toEqual(['pause', 'stop', 'idle', 'stop', 'operation', 'resume', 'watch']);
    expect(actionBoundaryMocks.resolveWorkspaceSyncConflict).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceUuid: 'workspace-a',
        resolution: 'use_remote',
        managedRootDir: '/managed-root',
        withReplacementSourceQuiesced: expect.any(Function),
      })
    );
  });

  it('restores the source watcher when production replacement returns an error', async () => {
    actionBoundaryMocks.openWorkspaceSyncProject.mockImplementationOnce(async (_db, input) => {
      if (!input.withReplacementSourceQuiesced) {
        throw new Error('Missing replacement-source quiescer.');
      }
      return input.withReplacementSourceQuiesced('workspace-a', async () => ({
        ok: false,
        code: 'INVALID_REQUEST' as const,
        message: 'replacement failed',
      }));
    });

    const handlers = createWorkspaceSyncActionHandlers(db, deps());
    await expect(handlers.openSyncedProject?.(REMOTE_WORKSPACE_A)).resolves.toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'replacement failed',
    });

    expect(runtime.ensureWatchingWorkspace).toHaveBeenCalledOnce();
    expect(runtime.ensureWatchingWorkspace).toHaveBeenCalledWith('workspace-a');
  });

  it('surfaces a watcher warning when a failed replacement cannot restore automatic backup', async () => {
    actionBoundaryMocks.openWorkspaceSyncProject.mockImplementationOnce(async (_db, input) => {
      if (!input.withReplacementSourceQuiesced) {
        throw new Error('Missing replacement-source quiescer.');
      }
      return input.withReplacementSourceQuiesced('workspace-a', async () => ({
        ok: false,
        code: 'INVALID_REQUEST' as const,
        message: 'replacement failed',
      }));
    });
    vi.mocked(runtime.ensureWatchingWorkspace).mockRejectedValueOnce(
      new Error('watcher unavailable')
    );

    const handlers = createWorkspaceSyncActionHandlers(db, deps());
    await expect(handlers.openSyncedProject?.(REMOTE_WORKSPACE_A)).rejects.toThrow(
      'automatic backup could not start'
    );

    expect(runtime.resumeWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.ensureWatchingWorkspace).toHaveBeenCalledWith('workspace-a');
  });

  it('keeps a successful open result and returns a warning when watcher startup fails', async () => {
    actionBoundaryMocks.openWorkspaceSyncProject.mockResolvedValueOnce({
      ok: true,
      workspaceUuid: 'workspace-a',
    });
    vi.mocked(runtime.ensureWatchingWorkspace).mockRejectedValueOnce(
      new Error('watcher unavailable')
    );

    const handlers = createWorkspaceSyncActionHandlers(db, deps());
    await expect(handlers.openSyncedProject?.(REMOTE_WORKSPACE_A)).resolves.toEqual({
      ok: true,
      workspaceUuid: 'workspace-a',
      warnings: [expect.stringContaining('automatic backup could not start')],
    });
    expect(statusPublisher.invalidate).toHaveBeenCalledWith('workspace-a', 'binding_changed');
  });

  it('keeps a successful use-remote result and returns a warning when watcher startup fails', async () => {
    actionBoundaryMocks.resolveWorkspaceSyncConflict.mockResolvedValueOnce({
      ok: true,
      resolution: 'use_remote',
      workspaceUuid: 'workspace-a',
    });
    vi.mocked(runtime.ensureWatchingWorkspace).mockRejectedValueOnce(
      new Error('watcher unavailable')
    );

    const handlers = createWorkspaceSyncActionHandlers(db, deps());
    await expect(handlers.resolveConflict?.('workspace-a', 'use_remote')).resolves.toEqual({
      ok: true,
      resolution: 'use_remote',
      workspaceUuid: 'workspace-a',
      warnings: [expect.stringContaining('automatic backup could not start')],
    });
    expect(statusPublisher.invalidate).toHaveBeenCalledWith('workspace-a', 'binding_changed');
  });

  it('refuses to enable sync when no desktop auth session is active', async () => {
    activeSession = null;

    await expect(setWorkspaceSyncEnabled(db, 'workspace-a', true, deps())).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('Sign in'),
    });

    expect(claimWorkspace).not.toHaveBeenCalled();
    expect(runtime.flushWorkspace).not.toHaveBeenCalled();
  });

  it('disables sync by canceling pending uploads and stopping the watcher', async () => {
    seedBinding(db, { enabled: true });
    db.prepare(
      `INSERT INTO workspace_sync_queue (
        id, workspace_id, operation, status, created_at, updated_at
      ) VALUES ('queue-a', 1, 'upload', 'pending', 100, 100)`
    ).run();
    db.prepare(
      `INSERT INTO workspace_sync_queue (
        id, workspace_id, operation, status, next_attempt_at, created_at, updated_at
      ) VALUES ('queue-uncertain', 1, 'upload', 'retry_wait', 200, 100, 100)`
    ).run();
    vi.mocked(runtime.waitForIdle).mockImplementationOnce(async () => {
      expect(binding()).toMatchObject({ enabled: 1 });
      expect(queue('queue-a')).toMatchObject({ status: 'canceled' });
    });

    await expect(setWorkspaceSyncEnabled(db, 'workspace-a', false, deps())).resolves.toEqual({
      ok: true,
    });

    expect(binding()).toMatchObject({ enabled: 0 });
    expect(queue('queue-a')).toMatchObject({
      status: 'canceled',
      error_code: 'SYNC_DISABLED',
      locked_at: null,
    });
    expect(queue('queue-uncertain')).toMatchObject({
      status: 'retry_wait',
      next_attempt_at: 200,
    });
    expect(runtime.stopWatchingWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.pauseWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.waitForIdle).toHaveBeenCalledWith('workspace-a');
    expect(runtime.resumeWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(statusPublisher.invalidate).toHaveBeenCalledWith('workspace-a', 'binding_changed');
  });

  it('force-sync requires an enabled binding owned by the active account', async () => {
    seedBinding(db, { enabled: false });

    await expect(forceWorkspaceSync(db, 'workspace-a', deps())).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Turn on auto sync'),
    });

    db.prepare(`DELETE FROM workspace_sync_bindings`).run();
    seedBinding(db, { enabled: true, ownerAccountId: 'account-b' });

    await expect(forceWorkspaceSync(db, 'workspace-a', deps())).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('different signed-in account'),
    });
    expect(runtime.flushWorkspace).not.toHaveBeenCalled();
  });

  it('keeps pending server verification incomplete and explains automatic retry', async () => {
    seedBinding(db, { enabled: true });
    vi.mocked(runtime.flushWorkspace).mockResolvedValueOnce({
      status: 'retry_wait',
      errorCode: 'IN_PROGRESS',
    });
    await expect(forceWorkspaceSync(db, 'workspace-a', deps())).resolves.toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'Sync is still in progress. DNAForge will retry automatically.',
    });
    expect(runtime.flushWorkspace).toHaveBeenCalledWith('workspace-a', { force: true });
  });

  it('force-sync flushes an enabled binding and reports queue failures', async () => {
    seedBinding(db, { enabled: true });
    vi.mocked(runtime.flushWorkspace).mockResolvedValueOnce({
      status: 'failed',
      errorCode: 'QUOTA_EXCEEDED',
    });

    await expect(forceWorkspaceSync(db, 'workspace-a', deps())).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('QUOTA_EXCEEDED'),
    });

    expect(runtime.ensureWatchingWorkspace).toHaveBeenCalledWith('workspace-a');
    expect(runtime.flushWorkspace).toHaveBeenCalledWith('workspace-a', { force: true });
    expect(statusPublisher.invalidate).toHaveBeenCalledWith('workspace-a', 'queue_changed');
  });

  it('sends the initiating account as the pinned request identity and returns the server-confirmed owner', async () => {
    const requestJson = vi.fn(async () => serverClaim({ accountId: 'account-b' }));
    const client = { requestJson } as unknown as DesktopSyncClient;
    const claimClient = createWorkspaceSyncClaimClient('device-a', client);

    await expect(
      claimClient.claimWorkspace({
        clientWorkspaceId: 'workspace-a',
        displayName: 'Project A',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
      })
    ).resolves.toEqual({
      remoteWorkspaceId: REMOTE_WORKSPACE_A,
      clientWorkspaceId: 'workspace-a',
      claimedByAccountId: 'account-b',
      owner: { kind: 'personal', accountId: 'account-b' },
      remoteLatestVersionId: null,
      remoteLatestVersionNumber: null,
      remoteLatestContentSha256: null,
    });

    expect(requestJson).toHaveBeenCalledWith(
      '/api/desktop-sync/workspaces/claim',
      expect.objectContaining({
        method: 'POST',
        expectedAccountId: 'account-a',
        idempotencyKey: 'claim:workspace-a:account-a',
        body: expect.objectContaining({
          clientWorkspaceId: 'workspace-a',
          deviceId: 'device-a',
          owner: { kind: 'personal' },
        }),
      })
    );
  });

  it.each([
    {
      label: 'workspace',
      response: serverClaim({ accountId: 'account-a', clientWorkspaceId: 'workspace-b' }),
    },
    {
      label: 'status',
      response: serverClaim({ accountId: 'account-a', status: 'ready' }),
    },
  ])('rejects a claim response with mismatched $label correlation', async ({ response }) => {
    const requestJson = vi.fn(async () => response);
    const client = { requestJson } as unknown as DesktopSyncClient;
    const claimClient = createWorkspaceSyncClaimClient('device-a', client);

    await expect(
      claimClient.claimWorkspace({
        clientWorkspaceId: 'workspace-a',
        displayName: 'Project A',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
      })
    ).rejects.toThrow(/claim response/i);
  });

  it('rejects a claim response without server-confirmed owner evidence', async () => {
    const client = {
      requestJson: vi.fn(async () => ({
        status: 'created',
        workspaceId: REMOTE_WORKSPACE_A,
        ownerKind: 'personal',
        clientWorkspaceId: 'workspace-a',
      })),
    } as unknown as DesktopSyncClient;
    const claimClient = createWorkspaceSyncClaimClient('device-a', client);

    await expect(
      claimClient.claimWorkspace({
        clientWorkspaceId: 'workspace-a',
        displayName: 'Project A',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
      })
    ).rejects.toThrow(/claim response/i);
  });

  it('rejects a claim response whose remote workspace id is not a UUID', async () => {
    const client = {
      requestJson: vi.fn(async () =>
        serverClaim({ accountId: 'account-a', workspaceId: 'not-a-uuid' })
      ),
    } as unknown as DesktopSyncClient;
    const claimClient = createWorkspaceSyncClaimClient('device-a', client);

    await expect(
      claimClient.claimWorkspace({
        clientWorkspaceId: 'workspace-a',
        displayName: 'Project A',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
      })
    ).rejects.toThrow(/claim response/i);
  });

  function deps() {
    return {
      runtime,
      statusPublisher,
      getActiveSession: async () => activeSession,
      claimClient: { claimWorkspace },
      nowMs: () => 1000,
    };
  }

  function binding(): Record<string, unknown> {
    return db
      .prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_uuid = 'workspace-a'`)
      .get() as Record<string, unknown>;
  }

  function queue(id: string): Record<string, unknown> {
    return db.prepare(`SELECT * FROM workspace_sync_queue WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >;
  }
});

function serverClaim(input: {
  accountId: string;
  clientWorkspaceId?: string;
  status?: string;
  workspaceId?: string;
}): Record<string, unknown> {
  return {
    status: input.status ?? 'created',
    workspaceId: input.workspaceId ?? REMOTE_WORKSPACE_A,
    ownerKind: 'personal',
    clientWorkspaceId: input.clientWorkspaceId ?? 'workspace-a',
    owner: { kind: 'personal', accountId: input.accountId },
    claimedBy: { accountId: input.accountId },
  };
}

function seedWorkspace(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (1, 'Project A', '/managed/workspace-a/repo', 'workspace-a', 100, 100)`
  ).run();
}

function seedBinding(
  db: Database.Database,
  input: { enabled: boolean; ownerAccountId?: string }
): void {
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
      enabled, created_at, updated_at
    ) VALUES (1, 'workspace-a', ?, ?, ?, 100, 100)`
  ).run(input.ownerAccountId ?? 'account-a', REMOTE_WORKSPACE_A, input.enabled ? 1 : 0);
}

function session(): StoredSession {
  return {
    accountId: 'account-a',
    desktopSessionId: 'desktop-session-a',
    accessToken: 'access-token-a',
    accessTokenExpiresAt: '2026-07-09T12:00:00.000Z',
    refreshToken: 'refresh-token-a',
    email: 'a@example.com',
    displayName: 'A',
    channel: 'dev',
    updatedAt: 100,
  };
}
