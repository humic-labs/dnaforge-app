import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { ensureSchema } from '../schema';
import {
  WorkspaceSyncBindingError,
  ensureWorkspaceSyncBinding,
  readWorkspaceSyncBinding,
  type WorkspaceSyncClaimClient,
} from '../workspace-sync-binding';
import { createTestDb } from './test-db';

const REMOTE_WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const REMOTE_WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('workspace sync identity binding', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
  });

  it('records native enablement episodes at commit and links only accepted reenables', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });
    const key = '_workspace_sync_enablement_v1:workspace-a';
    const readNative = (): unknown => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row ? JSON.parse(row.value) : null;
    };
    let releaseClaim = (): void => {};
    const pendingClaim = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const responseClient = claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_A });
    const time = vi.spyOn(Date, 'now').mockReturnValue(500);
    const operationIdPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    try {
      const accepted = ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 100,
        claimClient: {
          claimWorkspace: async (request) => {
            await pendingClaim;
            return responseClient.claimWorkspace(request);
          },
        },
      });
      expect(readNative()).toBeNull();
      time.mockReturnValue(900);
      releaseClaim();
      await accepted;
      const first = readNative();
      expect(first).toEqual({
        format: 'workspace-sync-enablement',
        schemaVersion: 1,
        workspaceUuid: 'workspace-a',
        episodes: [
          {
            ownerAccountId: 'account-a',
            ownerOrgId: null,
            remoteWorkspaceId: REMOTE_WORKSPACE_A,
            operationId: expect.stringMatching(operationIdPattern),
            parentOperationId: null,
            startedAtMs: 900,
          },
        ],
      });
      const firstId = db
        .prepare(
          "SELECT json_extract(value, '$.episodes[0].operationId') AS id FROM settings WHERE key = ?"
        )
        .get(key) as { id: string };
      const repeatedClaim = claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_B });
      time.mockReturnValue(1100);
      await ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 1100,
        claimClient: repeatedClaim,
      });
      expect(readNative()).toEqual(first);
      db.prepare('UPDATE workspace_sync_bindings SET enabled = 0 WHERE workspace_uuid = ?').run(
        'workspace-a'
      );
      time.mockReturnValue(1500);
      await ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 1400,
        claimClient: repeatedClaim,
      });
      expect(readNative()).toMatchObject({
        episodes: [
          { operationId: firstId.id, parentOperationId: null, startedAtMs: 900 },
          {
            operationId: expect.stringMatching(operationIdPattern),
            parentOperationId: firstId.id,
            startedAtMs: 1500,
          },
        ],
      });
      const reenabledId = db
        .prepare(
          "SELECT json_extract(value, '$.episodes[1].operationId') AS id FROM settings WHERE key = ?"
        )
        .get(key) as { id: string };
      expect(reenabledId.id).not.toBe(firstId.id);
      expect(repeatedClaim.claimWorkspace).not.toHaveBeenCalled();
    } finally {
      time.mockRestore();
    }
  });

  it('does not invent a native enablement episode for an already-enabled legacy binding', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
        workspace_id, workspace_uuid, owner_account_id, owner_org_id,
        remote_workspace_id, enabled, created_at, updated_at
      ) VALUES (1, 'workspace-a', 'account-a', NULL, ?, 1, 100, 100)`
    ).run(REMOTE_WORKSPACE_A);
    const claim = claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_B });
    await ensureWorkspaceSyncBinding(db, {
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 200,
      claimClient: claim,
    });
    expect(
      db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('_workspace_sync_enablement_v1:workspace-a')
    ).toBeUndefined();
    expect(claim.claimWorkspace).not.toHaveBeenCalled();
  });

  it('claims and persists a remote workspace for a managed repo_uuid', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });
    const claim = claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_A });

    const result = await ensureWorkspaceSyncBinding(db, {
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 100,
      claimClient: claim,
    });

    expect(result).toMatchObject({
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      remoteWorkspaceId: REMOTE_WORKSPACE_A,
      enabled: true,
      createdAt: 100,
      updatedAt: 100,
      didClaimRemote: true,
    });
    expect(claim.claimWorkspace).toHaveBeenCalledWith({
      clientWorkspaceId: 'workspace-a',
      displayName: 'Lab A',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
    });
    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toMatchObject({
      remoteWorkspaceId: REMOTE_WORKSPACE_A,
    });
  });

  it('survives restart by reusing the existing binding without a second remote claim', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });
    const firstClaim = claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_A });
    await ensureWorkspaceSyncBinding(db, {
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 100,
      claimClient: firstClaim,
    });

    const secondClaim = claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_B });
    const result = await ensureWorkspaceSyncBinding(db, {
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 200,
      claimClient: secondClaim,
    });

    expect(result).toMatchObject({
      remoteWorkspaceId: REMOTE_WORKSPACE_A,
      didClaimRemote: false,
      updatedAt: 100,
    });
    expect(secondClaim.claimWorkspace).not.toHaveBeenCalled();
  });

  it('reenables an existing remote binding without a second remote claim', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });
    await ensureWorkspaceSyncBinding(db, {
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 100,
      claimClient: claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_A }),
    });
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET enabled = 0,
           updated_at = 150
       WHERE workspace_uuid = 'workspace-a'`
    ).run();

    const secondClaim = claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_B });
    const result = await ensureWorkspaceSyncBinding(db, {
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 200,
      claimClient: secondClaim,
    });

    expect(result).toMatchObject({
      remoteWorkspaceId: REMOTE_WORKSPACE_A,
      enabled: true,
      didClaimRemote: false,
      updatedAt: 200,
    });
    expect(secondClaim.claimWorkspace).not.toHaveBeenCalled();
  });

  it('refuses to reuse a local repo_uuid binding under a different active account', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });
    await ensureWorkspaceSyncBinding(db, {
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 100,
      claimClient: claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_A }),
    });

    await expect(
      ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-b',
        ownerOrgId: null,
        nowMs: 200,
        claimClient: claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_B }),
      })
    ).rejects.toMatchObject({
      code: 'OWNER_MISMATCH',
      message: expect.stringContaining('workspace-a'),
    });
  });

  it('persists org binding scope and rejects claim responses that do not match the requested owner', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });

    await expect(
      ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: 'org-a',
        nowMs: 100,
        claimClient: claimClient({
          remoteWorkspaceId: REMOTE_WORKSPACE_A,
          ownerAccountId: 'account-a',
          ownerOrgId: 'org-b',
        }),
      })
    ).rejects.toMatchObject({ code: 'CLAIM_OWNER_MISMATCH' });
    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toBeNull();

    await expect(
      ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: 'org-a',
        nowMs: 100,
        claimClient: claimClient({
          remoteWorkspaceId: REMOTE_WORKSPACE_A,
          ownerAccountId: 'account-a',
          ownerOrgId: null,
        }),
      })
    ).rejects.toMatchObject({ code: 'CLAIM_OWNER_MISMATCH' });
    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toBeNull();

    const result = await ensureWorkspaceSyncBinding(db, {
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: 'org-a',
      nowMs: 200,
      claimClient: claimClient({
        remoteWorkspaceId: REMOTE_WORKSPACE_A,
        ownerAccountId: 'account-a',
        ownerOrgId: 'org-a',
      }),
    });

    expect(result).toMatchObject({
      ownerAccountId: 'account-a',
      ownerOrgId: 'org-a',
      remoteWorkspaceId: REMOTE_WORKSPACE_A,
      didClaimRemote: true,
    });
  });

  it('rejects non-managed, archived, trashed, and unknown workspaces before remote claim', async () => {
    seedWorkspace(db, { id: 1, repoUuid: null, path: '/legacy', name: 'Legacy' });
    seedWorkspace(db, { id: 2, repoUuid: 'archived-a', name: 'Archived', archivedAt: 10 });
    seedWorkspace(db, { id: 3, repoUuid: 'trashed-a', name: 'Trashed', trashedAt: 10 });
    const claim = claimClient({ remoteWorkspaceId: REMOTE_WORKSPACE_A });

    for (const workspaceUuid of ['legacy', 'archived-a', 'trashed-a', 'missing-a']) {
      await expect(
        ensureWorkspaceSyncBinding(db, {
          workspaceUuid,
          ownerAccountId: 'account-a',
          ownerOrgId: null,
          nowMs: 100,
          claimClient: claim,
        })
      ).rejects.toBeInstanceOf(WorkspaceSyncBindingError);
    }

    expect(claim.claimWorkspace).not.toHaveBeenCalled();
  });

  it('rejects a server-confirmed claimant that differs from the initiating account', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });

    await expect(
      ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 100,
        claimClient: claimClient({
          remoteWorkspaceId: REMOTE_WORKSPACE_B,
          claimedByAccountId: 'account-b',
          ownerAccountId: 'account-a',
        }),
      })
    ).rejects.toMatchObject({
      code: 'CLAIM_OWNER_MISMATCH',
      message: expect.stringContaining('workspace-a'),
    });

    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toBeNull();
  });

  it('rejects a server-confirmed personal owner that differs from the initiating account', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });

    await expect(
      ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 100,
        claimClient: claimClient({
          remoteWorkspaceId: REMOTE_WORKSPACE_B,
          claimedByAccountId: 'account-b',
          ownerAccountId: 'account-b',
        }),
      })
    ).rejects.toMatchObject({ code: 'CLAIM_OWNER_MISMATCH' });

    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toBeNull();
  });

  it('rejects a personal owner that differs from the initiating account even when the claimant matches', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });

    await expect(
      ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 100,
        claimClient: claimClient({
          remoteWorkspaceId: REMOTE_WORKSPACE_B,
          claimedByAccountId: 'account-a',
          ownerAccountId: 'account-b',
        }),
      })
    ).rejects.toMatchObject({ code: 'CLAIM_OWNER_MISMATCH' });

    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toBeNull();
  });

  it('rejects an org claim the server confirmed under a personal owner', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });

    await expect(
      ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 100,
        claimClient: claimClient({
          remoteWorkspaceId: REMOTE_WORKSPACE_A,
          ownerAccountId: 'account-a',
          ownerOrgId: 'org-a',
        }),
      })
    ).rejects.toMatchObject({ code: 'CLAIM_OWNER_MISMATCH' });

    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toBeNull();
  });

  it('rejects a claim whose local workspace correlation does not match before storing a binding', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });

    await expect(
      ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 100,
        claimClient: claimClient({
          remoteWorkspaceId: REMOTE_WORKSPACE_A,
          clientWorkspaceId: 'workspace-b',
        }),
      })
    ).rejects.toMatchObject({ code: 'CLAIM_RESPONSE_INVALID' });

    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toBeNull();
  });

  it('rejects a malformed claimed workspace id before storing a binding', async () => {
    seedWorkspace(db, { id: 1, repoUuid: 'workspace-a', name: 'Lab A' });

    await expect(
      ensureWorkspaceSyncBinding(db, {
        workspaceUuid: 'workspace-a',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 100,
        claimClient: claimClient({ remoteWorkspaceId: 'not-a-uuid' }),
      })
    ).rejects.toMatchObject({ code: 'CLAIM_RESPONSE_INVALID' });

    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toBeNull();
  });
});

function seedWorkspace(
  db: Database.Database,
  input: {
    id: number;
    repoUuid: string | null;
    name: string;
    path?: string;
    archivedAt?: number | null;
    trashedAt?: number | null;
  }
): void {
  db.prepare(
    `INSERT INTO workspaces (
      id, name, path, repo_uuid, origin_path, archived_at, trashed_at, created_at, last_opened_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.name,
    input.path ?? `/managed/${input.repoUuid ?? input.id}/repo`,
    input.repoUuid,
    `/origin/${input.name}`,
    input.archivedAt ?? null,
    input.trashedAt ?? null,
    1,
    1
  );
}

function claimClient(result: {
  remoteWorkspaceId: string;
  clientWorkspaceId?: string;
  claimedByAccountId?: string;
  ownerAccountId?: string;
  ownerOrgId?: string | null;
}): WorkspaceSyncClaimClient {
  return {
    claimWorkspace: vi.fn(async (request) => {
      const ownerAccountId = result.ownerAccountId ?? request.ownerAccountId;
      const ownerOrgId = result.ownerOrgId === undefined ? request.ownerOrgId : result.ownerOrgId;
      return {
        remoteWorkspaceId: result.remoteWorkspaceId,
        clientWorkspaceId: result.clientWorkspaceId ?? request.clientWorkspaceId,
        claimedByAccountId: result.claimedByAccountId ?? ownerAccountId,
        owner: ownerOrgId
          ? { kind: 'org' as const, orgId: ownerOrgId }
          : { kind: 'personal' as const, accountId: ownerAccountId },
        remoteLatestVersionId: null,
        remoteLatestVersionNumber: null,
        remoteLatestContentSha256: null,
      };
    }),
  };
}
