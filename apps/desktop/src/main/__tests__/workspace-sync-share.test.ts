import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.0.0'), isPackaged: false, getPath: vi.fn(() => '/tmp') },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

vi.mock('@sentry/electron/main', () => ({
  captureMessage: vi.fn(),
}));

vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: vi.fn(() => 'https://web.test'),
  getAuthChannel: vi.fn(() => 'dev'),
  getRedirectScheme: vi.fn(() => 'dnaforge-dev'),
}));

import { ensureSchema } from '../schema';
import {
  copyWorkspaceSyncShareLink,
  DesktopSyncShareClientError,
  type WorkspaceSyncShareClient,
} from '../workspace-sync-share';
import { createTestDb } from './test-db';

const REMOTE_WORKSPACE_ID = '8a4d99e9-2347-4d04-a447-d3070f7a7f9a';
const REMOTE_VERSION_A = '54a53fed-2b63-44c8-a26e-b0fb7e1788d2';
const REMOTE_VERSION_B = '618e7310-6426-4bfe-9f94-c3519fe55458';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('workspace sync share links', () => {
  let db: Database.Database;
  let client: WorkspaceSyncShareClient;
  let createPinnedShare: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    createPinnedShare = vi.fn(async () => ({
      workspaceId: REMOTE_WORKSPACE_ID,
      revisionPolicy: 'pinned_version' as const,
      pinnedVersion: {
        id: REMOTE_VERSION_A,
        versionNumber: 2,
        contentSha256: HASH_A,
        sizeBytes: 512,
        fileCount: 3,
        createdAt: '2026-07-08T00:00:00.000Z',
      },
      share: {
        id: 'share-a',
        shortId: 'abc123',
        linkToken: 'token-a',
        url: 'https://dnaforge.com/d/abc123#token=token-a',
        scopeMode: 'public_link',
        displayLabel: null,
        expiresAt: null,
        createdAt: '2026-07-08T00:00:00.000Z',
      },
      short_id: 'abc123',
      link_token: 'token-a',
      url: 'https://dnaforge.com/d/abc123#token=token-a',
    }));
    client = { createPinnedShare };

    seedSyncedWorkspace(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      remoteLatestVersionId: REMOTE_VERSION_A,
      remoteLatestVersionNumber: 2,
      remoteLatestContentSha256: HASH_A,
      lastAckedLocalHeadSha: 'head-a',
    });
    seedReadyVersion(db, {
      id: REMOTE_VERSION_A,
      workspaceId: 1,
      versionNumber: 2,
      contentSha256: HASH_A,
      localHeadSha: 'head-a',
      isLatest: true,
    });
  });

  it('copies a pinned link for the latest ready uploaded version of a clean workspace', async () => {
    await expect(
      copyWorkspaceSyncShareLink(db, {
        workspaceUuid: 'workspace-a',
        client,
        getCurrentLocalHeadSha: () => 'head-a',
        hasWorkingChanges: () => false,
      })
    ).resolves.toEqual({
      ok: true,
      url: 'https://dnaforge.com/d/abc123#token=token-a',
      versionId: REMOTE_VERSION_A,
      versionNumber: 2,
      shortId: 'abc123',
      contentSha256: HASH_A,
    });

    expect(createPinnedShare).toHaveBeenCalledWith({
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      ownerAccountId: 'account-a',
      expectedLatestVersionId: REMOTE_VERSION_A,
    });
  });

  it('shares an acknowledged native HEAD with only local Registry exports, while protecting actual edits and staged ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-share-registry-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'Native share fixture');
      git('config', 'user.email', '23063109+pnciaccia@users.noreply.github.com');
      writeFileSync(join(root, 'shared.txt'), 'accepted shared bytes\n');
      git('add', 'shared.txt');
      git('commit', '-q', '-m', 'Accepted shared content');
      const head = git('rev-parse', 'HEAD');
      db.prepare('UPDATE workspaces SET path = ? WHERE id = 1').run(root);
      db.prepare(
        'UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1'
      ).run(head);
      db.prepare(
        'UPDATE workspace_sync_versions SET local_head_sha = ? WHERE workspace_id = 1'
      ).run(head);
      const projection = join(root, '.waypoint', 'lims', 'log');
      mkdirSync(projection, { recursive: true });
      const exportPath = join(projection, '2026-10.jsonl');
      const exportBytes = '{"localRegistryProjection":"retain exact bytes"}\n';
      writeFileSync(exportPath, exportBytes);
      expect(git('status', '--porcelain')).not.toBe('');
      await expect(
        copyWorkspaceSyncShareLink(db, { workspaceUuid: 'workspace-a', client })
      ).resolves.toMatchObject({ ok: true, versionId: REMOTE_VERSION_A });
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(readFileSync(exportPath, 'utf8')).toBe(exportBytes);
      writeFileSync(join(root, 'shared.txt'), 'real unsynced change\n');
      await expect(
        copyWorkspaceSyncShareLink(db, { workspaceUuid: 'workspace-a', client })
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('Sync this project'),
      });
      writeFileSync(join(root, 'shared.txt'), 'accepted shared bytes\n');
      git('add', '-f', '.waypoint/lims/log/2026-10.jsonl');
      await expect(
        copyWorkspaceSyncShareLink(db, { workspaceUuid: 'workspace-a', client })
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('Sync this project'),
      });
      expect(createPinnedShare).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed instead of sharing a stale uploaded version when local HEAD moved', async () => {
    await expect(
      copyWorkspaceSyncShareLink(db, {
        workspaceUuid: 'workspace-a',
        client,
        getCurrentLocalHeadSha: () => 'head-b',
        hasWorkingChanges: () => false,
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('Sync this project before sharing'),
    });

    expect(createPinnedShare).not.toHaveBeenCalled();
  });

  it('fails closed when the managed repo has uncommitted working-tree changes', async () => {
    await expect(
      copyWorkspaceSyncShareLink(db, {
        workspaceUuid: 'workspace-a',
        client,
        getCurrentLocalHeadSha: () => 'head-a',
        hasWorkingChanges: () => true,
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('Sync this project before sharing'),
    });

    expect(createPinnedShare).not.toHaveBeenCalled();
  });

  it('can run an injected sync-first step and then pin the refreshed latest version', async () => {
    let currentHead = 'head-b';
    createPinnedShare.mockImplementationOnce(async () => ({
      workspaceId: REMOTE_WORKSPACE_ID,
      revisionPolicy: 'pinned_version' as const,
      pinnedVersion: {
        id: REMOTE_VERSION_B,
        versionNumber: 3,
        contentSha256: HASH_B,
        sizeBytes: 768,
        fileCount: 4,
        createdAt: '2026-07-08T00:01:00.000Z',
      },
      share: {
        id: 'share-b',
        shortId: 'def456',
        linkToken: 'token-b',
        url: 'https://dnaforge.com/d/def456#token=token-b',
        scopeMode: 'public_link',
        displayLabel: null,
        expiresAt: null,
        createdAt: '2026-07-08T00:01:00.000Z',
      },
      short_id: 'def456',
      link_token: 'token-b',
      url: 'https://dnaforge.com/d/def456#token=token-b',
    }));

    await expect(
      copyWorkspaceSyncShareLink(db, {
        workspaceUuid: 'workspace-a',
        client,
        getCurrentLocalHeadSha: () => currentHead,
        hasWorkingChanges: () => currentHead !== 'head-b',
        syncBeforeShare: async () => {
          db.prepare(
            `UPDATE workspace_sync_versions SET is_latest = 0 WHERE workspace_id = 1`
          ).run();
          seedReadyVersion(db, {
            id: REMOTE_VERSION_B,
            workspaceId: 1,
            versionNumber: 3,
            contentSha256: HASH_B,
            localHeadSha: 'head-b',
            isLatest: true,
          });
          db.prepare(
            `UPDATE workspace_sync_bindings
             SET remote_latest_version_id = ?, remote_latest_version_number = ?,
                 remote_latest_content_sha256 = ?, last_acked_local_head_sha = ?,
                 updated_at = ?
             WHERE workspace_id = ?`
          ).run(REMOTE_VERSION_B, 3, HASH_B, 'head-b', 2, 1);
          currentHead = 'head-b';
        },
      })
    ).resolves.toEqual({
      ok: true,
      url: 'https://dnaforge.com/d/def456#token=token-b',
      versionId: REMOTE_VERSION_B,
      versionNumber: 3,
      shortId: 'def456',
      contentSha256: HASH_B,
    });

    expect(createPinnedShare).toHaveBeenCalledWith({
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      ownerAccountId: 'account-a',
      expectedLatestVersionId: REMOTE_VERSION_B,
    });
  });

  it('refuses unbound or not-yet-uploaded workspaces before calling the server', async () => {
    db.prepare(`DELETE FROM workspace_sync_versions`).run();

    await expect(
      copyWorkspaceSyncShareLink(db, {
        workspaceUuid: 'workspace-a',
        client,
        getCurrentLocalHeadSha: () => 'head-a',
        hasWorkingChanges: () => false,
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('No synced version is available'),
    });

    expect(createPinnedShare).not.toHaveBeenCalled();
  });

  it('maps server drift or authorization failures into action errors', async () => {
    createPinnedShare.mockRejectedValueOnce(
      new DesktopSyncShareClientError('CONFLICT', 'Latest sync version changed.')
    );

    await expect(
      copyWorkspaceSyncShareLink(db, {
        workspaceUuid: 'workspace-a',
        client,
        getCurrentLocalHeadSha: () => 'head-a',
        hasWorkingChanges: () => false,
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'Latest sync version changed.',
    });
  });
});

function seedSyncedWorkspace(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceUuid: string;
    remoteWorkspaceId: string | null;
    remoteLatestVersionId: string | null;
    remoteLatestVersionNumber: number | null;
    remoteLatestContentSha256: string | null;
    lastAckedLocalHeadSha: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    input.workspaceId,
    'Project A',
    `/managed/${input.workspaceUuid}/repo`,
    input.workspaceUuid,
    1,
    1
  );
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
      enabled, remote_latest_version_id, remote_latest_version_number,
      remote_latest_content_sha256, last_acked_local_head_sha, created_at, updated_at
    ) VALUES (?, ?, 'account-a', ?, 1, ?, ?, ?, ?, 1, 1)`
  ).run(
    input.workspaceId,
    input.workspaceUuid,
    input.remoteWorkspaceId,
    input.remoteLatestVersionId,
    input.remoteLatestVersionNumber,
    input.remoteLatestContentSha256,
    input.lastAckedLocalHeadSha
  );
}

function seedReadyVersion(
  db: Database.Database,
  input: {
    id: string;
    workspaceId: number;
    versionNumber: number;
    contentSha256: string;
    localHeadSha: string | null;
    isLatest: boolean;
  }
): void {
  db.prepare(
    `INSERT INTO workspace_sync_versions (
      id, workspace_id, remote_version_id, version_number, content_sha256,
      local_head_sha, file_count, size_bytes, status, is_latest, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 512, 'ready', ?, 1, 1)`
  ).run(
    input.id,
    input.workspaceId,
    input.id,
    input.versionNumber,
    input.contentSha256,
    input.localHeadSha,
    input.isLatest ? 1 : 0
  );
}
