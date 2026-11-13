import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSession } from './auth/session-store';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false, getPath: () => '/tmp' },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('./auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://web.test',
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));

import { createTestDb } from './__tests__/test-db';
import { createDesktopSyncClient } from './desktop-sync-client';
import { ensureSchema } from './schema';
import {
  createWorkspaceSyncAccessClient,
  inviteWorkspaceSyncCollaborator,
  listWorkspaceSyncAccess,
  resendWorkspaceSyncInvite,
  revokeWorkspaceSyncInvite,
  setWorkspaceSyncAccess,
  type WorkspaceSyncAccessActionDeps,
} from './workspace-sync-access';
import { readWorkspaceSyncAccessBinding } from './workspace-sync-access-record';
import { enqueueWorkspaceSyncJob } from './workspace-sync-queue';

describe('shared-project access action refusals', () => {
  let db: Database.Database;
  const session: StoredSession = {
    accountId: 'account-me',
    desktopSessionId: 'synthetic-session',
    accessToken: 'synthetic-access-token',
    accessTokenExpiresAt: '2030-01-01T00:00:00Z',
    refreshToken: 'synthetic-refresh-token',
    channel: 'dev',
    updatedAt: 1,
  };

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
      VALUES (1, 'Shared A', '/managed/workspace-a/repo', 'workspace-a', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_owner_account_id, remote_workspace_id,
      enabled, access_role, access_source, shared_with_others, created_at, updated_at
    ) VALUES (1, 'workspace-a', 'account-me', 'account-owner', 'remote-a',
      1, 'editor', 'direct', 1, 1, 1)`
    ).run();
    enqueueWorkspaceSyncJob(db, {
      id: 'pending-upload',
      workspaceId: 1,
      operation: 'upload',
      localHeadSha: 'local-head',
      nowMs: 10,
    });
  });

  afterEach(() => db.close());

  function dependencies(status: 403 | 404) {
    const fetchResponse = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND',
            message: 'Access denied.',
          }),
          { status, headers: { 'Content-Type': 'application/json' } }
        )
    );
    const deps: WorkspaceSyncAccessActionDeps = {
      client: createWorkspaceSyncAccessClient(
        createDesktopSyncClient({
          baseUrl: 'https://web.test',
          fetch: fetchResponse,
          getActiveStoredSession: async () => session,
          nowMs: () => 20,
        })
      ),
      getActiveSession: async () => session,
      nowMs: () => 20,
    };
    return { deps, fetchResponse };
  }

  const managementActions = [
    {
      name: 'change a grant',
      run: (deps: WorkspaceSyncAccessActionDeps) =>
        setWorkspaceSyncAccess(
          db,
          'workspace-a',
          { subject: { kind: 'account', accountId: 'account-me' }, role: 'manager' },
          deps
        ),
    },
    {
      name: 'invite a collaborator',
      run: (deps: WorkspaceSyncAccessActionDeps) =>
        inviteWorkspaceSyncCollaborator(
          db,
          'workspace-a',
          { email: 'synthetic@example.test', role: 'editor' },
          deps
        ),
    },
    {
      name: 'revoke an invitation',
      run: (deps: WorkspaceSyncAccessActionDeps) =>
        revokeWorkspaceSyncInvite(db, 'workspace-a', 'invite-a', deps),
    },
    {
      name: 'resend an invitation',
      run: (deps: WorkspaceSyncAccessActionDeps) =>
        resendWorkspaceSyncInvite(db, 'workspace-a', 'invite-a', deps),
    },
  ];

  it.each(managementActions)('keeps read access when forbidden to $name', async ({ run }) => {
    const { deps, fetchResponse } = dependencies(403);
    expect.soft(await run(deps)).toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'You do not have permission to do that on this project.',
    });
    expect(fetchResponse).toHaveBeenCalledTimes(1);
    expect(fetchResponse.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-access-token' }),
    });
    expect.soft(readWorkspaceSyncAccessBinding(db, 'workspace-a')).toMatchObject({
      enabled: 1,
      detached_reason: null,
      access_role: 'editor',
    });
    expect(
      db
        .prepare('SELECT status, error_code FROM workspace_sync_queue WHERE id = ?')
        .get('pending-upload')
    ).toEqual({ status: 'pending', error_code: null });
  });

  it.each(managementActions)(
    'keeps access when the target is missing while trying to $name',
    async ({ run }) => {
      const { deps, fetchResponse } = dependencies(404);
      fetchResponse.mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Invitation not found.' }), {
          status: 404,
        })
      );
      fetchResponse.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: 'remote-a',
            displayName: 'Shared A',
            viewer: {
              role: 'manager',
              sources: [{ kind: 'direct', role: 'manager', orgId: null }],
            },
            owner: {
              kind: 'personal',
              accountId: 'account-owner',
              email: 'owner@example.test',
              displayName: null,
            },
            canManage: true,
            admins: [],
            grants: [],
            invites: [],
          }),
          { status: 200 }
        )
      );
      expect.soft(await run(deps)).toMatchObject({ ok: false });
      expect
        .soft(readWorkspaceSyncAccessBinding(db, 'workspace-a'))
        .toMatchObject({ enabled: 1, detached_reason: null });
      expect.soft(fetchResponse).toHaveBeenCalledTimes(2);
      expect(
        db
          .prepare('SELECT status, error_code FROM workspace_sync_queue WHERE id = ?')
          .get('pending-upload')
      ).toEqual({ status: 'pending', error_code: null });
    }
  );

  it.each([200, 403, 404])(
    'does not apply a stale read %s to a replacement project',
    async (status) => {
      const { deps, fetchResponse } = dependencies(403);
      fetchResponse.mockImplementationOnce(async () => {
        db.prepare("UPDATE workspaces SET repo_uuid = 'replacement-project' WHERE id = 1").run();
        db.prepare(
          `UPDATE workspace_sync_bindings SET workspace_uuid = 'replacement-project',
        access_role = 'viewer' WHERE workspace_id = 1`
        ).run();
        return new Response(
          JSON.stringify(
            status === 200
              ? {
                  workspaceId: 'remote-a',
                  displayName: 'Old project',
                  viewer: {
                    role: 'manager',
                    sources: [{ kind: 'direct', role: 'manager', orgId: null }],
                  },
                  owner: {
                    kind: 'personal',
                    accountId: 'account-owner',
                    email: 'owner@example.test',
                    displayName: null,
                  },
                  canManage: true,
                  admins: [],
                  grants: [],
                  invites: [],
                }
              : { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND' }
          ),
          { status }
        );
      });
      expect
        .soft(await listWorkspaceSyncAccess(db, 'workspace-a', deps))
        .toMatchObject({ ok: false });
      expect.soft(readWorkspaceSyncAccessBinding(db, 'replacement-project')).toMatchObject({
        enabled: 1,
        detached_reason: null,
        access_role: 'viewer',
        remote_workspace_id: 'remote-a',
      });
      expect(
        db.prepare('SELECT status FROM workspace_sync_queue WHERE id = ?').get('pending-upload')
      ).toEqual({ status: 'pending' });
    }
  );

  it('keeps the binding when read revalidation cannot reach the server', async () => {
    const { deps, fetchResponse } = dependencies(404);
    fetchResponse.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 })
    );
    fetchResponse.mockRejectedValueOnce(new TypeError('Synthetic network failure'));
    expect(
      await revokeWorkspaceSyncInvite(db, 'workspace-a', 'missing-invite', deps)
    ).toMatchObject({ ok: false, message: 'You appear to be offline. Try again when connected.' });
    expect(readWorkspaceSyncAccessBinding(db, 'workspace-a')).toMatchObject({
      enabled: 1,
      detached_reason: null,
    });
    expect(
      db.prepare('SELECT status FROM workspace_sync_queue WHERE id = ?').get('pending-upload')
    ).toEqual({ status: 'pending' });
  });

  it.each([403, 404] as const)(
    'detaches and parks uploads when reading is denied with %s',
    async (status) => {
      const { deps } = dependencies(status);
      expect(await listWorkspaceSyncAccess(db, 'workspace-a', deps)).toMatchObject({ ok: false });
      expect(readWorkspaceSyncAccessBinding(db, 'workspace-a')).toMatchObject({
        enabled: 0,
        detached_reason: 'access_removed',
      });
      expect(
        db.prepare('SELECT status FROM workspace_sync_queue WHERE id = ?').get('pending-upload')
      ).toEqual({ status: 'blocked' });
    }
  );

  it.each(managementActions)(
    'detaches after read access also confirms the project is unavailable while trying to $name',
    async ({ run }) => {
      const { deps } = dependencies(404);
      expect(await run(deps)).toMatchObject({ ok: false });
      expect(readWorkspaceSyncAccessBinding(db, 'workspace-a')).toMatchObject({
        enabled: 0,
        detached_reason: 'access_removed',
      });
    }
  );
});
