// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { workspaceSyncBundleHashInput, type WorkspaceSyncBundleV1 } from '@waypoint/share-bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: vi.fn(() => 'https://web.test'),
  getAuthChannel: vi.fn(() => 'dev'),
  getRedirectScheme: vi.fn(() => 'dnaforge-dev'),
}));

import { ensureSchema } from '../schema';
import {
  resolveWorkspaceSyncMergeConflict,
  type WorkspaceSyncReconcileDeps,
} from '../workspace-sync-reconcile-runtime';
import { reconcileWorkspaceBundles } from '../workspace-sync-reconcile';
import { buildWorkspaceSyncSnapshot } from '../workspace-sync-snapshotter';
import { commitAllIfDirty } from '../workspace-git';
import { createTestDb } from './test-db';

const REMOTE_WORKSPACE_ID = '8a4d99e9-2347-4d04-a447-d3070f7a7f9a';
const REMOTE_BASE_ID = '54a53fed-2b63-44c8-a26e-b0fb7e1788d2';
const REMOTE_LATEST_ID = '6e7b6d60-e681-4f5b-89fd-6fb9d7e48b6e';
const BASE_CLOUD = 'LOCUS       cloud   10 bp    DNA     circular\nORIGIN\n1 acgtacgtac\n//\n';
const REMOTE_CLOUD = 'LOCUS       cloud   10 bp    DNA     circular\nORIGIN\n1 ttttacgtac\n//\n';
const LOCAL_ONLY = 'LOCUS       mine    10 bp    DNA     linear\nORIGIN\n1 ggggcccc\n//\n';
const OFFLINE_EDIT = 'LOCUS       offline 10 bp    DNA     linear\nORIGIN\n1 aaaacccc\n//\n';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bundle(files: Record<string, string>): WorkspaceSyncBundleV1 {
  const value: WorkspaceSyncBundleV1 = {
    schemaVersion: 1,
    capturedAt: '2026-07-08T00:00:00.000Z',
    workspace: { id: 'workspace-a', name: 'Shared Project' },
    files: Object.entries(files).map(([relativePath, content]) => ({
      id: `file:${relativePath}`,
      relativePath,
      name: relativePath.split('/').pop()!,
      kind: 'genbank',
      contentType: 'text/plain',
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256Hex(content),
      content,
    })),
    excludedSummary: {
      unsupported: { count: 0, bytesApprox: 0 },
      'private-raw-data': { count: 0, bytesApprox: 0 },
      'reference-pointer': { count: 0, bytesApprox: 0 },
      'file-too-large': { count: 0, bytesApprox: 0 },
      'bundle-too-large': { count: 0, bytesApprox: 0 },
    },
    limits: { maxFileBytes: 2 * 1024 * 1024, maxBundleBytes: 10 * 1024 * 1024, maxFiles: 500 },
    provenance: { source: 'dnaforge-desktop', appVersion: '0.9.7', contentSha256: '0'.repeat(64) },
  };
  value.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(value));
  return value;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

describe('resolving a shared-project merge conflict ', () => {
  let db: Database.Database;
  let temporaryRoot: string;
  let repo: string;
  let localHead: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    temporaryRoot = mkdtempSync(join(tmpdir(), 'dnaforge-merge-resolve-'));
    repo = join(temporaryRoot, 'workspace');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'designs'));
    writeFileSync(join(repo, 'designs/cloud.gb'), BASE_CLOUD);
    writeFileSync(join(repo, 'designs/mine.gb'), LOCAL_ONLY);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'local state the conflict was recorded against');
    localHead = git(repo, 'rev-parse', 'HEAD');

    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Shared Project', ?, 'workspace-a', 1, 1)`
    ).run(repo);
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
        workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
        remote_latest_version_id, remote_latest_version_number,
        last_acked_local_head_sha, created_at, updated_at
      ) VALUES (1, 'workspace-a', 'account-a', ?, 1, ?, 4, ?, 1, 1)`
    ).run(REMOTE_WORKSPACE_ID, REMOTE_BASE_ID, localHead);
    const base = bundle({ 'designs/cloud.gb': BASE_CLOUD });
    const local = bundle({ 'designs/cloud.gb': BASE_CLOUD, 'designs/mine.gb': LOCAL_ONLY });
    const remote = bundle({ 'designs/cloud.gb': REMOTE_CLOUD });
    db.prepare(
      `INSERT INTO workspace_sync_merge_conflicts (
        id, workspace_id, workspace_uuid, base_remote_version_id, remote_version_id,
        remote_version_number, local_head_sha, status, conflicts_json, payload_json,
        created_at, updated_at
      ) VALUES ('conflict-1', 1, 'workspace-a', ?, ?, 5, ?, 'open', '[]', ?, 1, 1)`
    ).run(
      REMOTE_BASE_ID,
      REMOTE_LATEST_ID,
      localHead,
      JSON.stringify({
        base,
        local,
        remote,
        remoteVersion: latestResponse(remote).version,
        localAuthorLabel: 'Me',
        remoteAuthorLabel: 'Collaborator',
      })
    );
  });

  afterEach(() => {
    db.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function latestResponse(value: WorkspaceSyncBundleV1) {
    return {
      workspaceId: REMOTE_WORKSPACE_ID,
      version: {
        id: REMOTE_LATEST_ID,
        versionNumber: 5,
        contentSha256: value.provenance.contentSha256,
        sizeBytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
        fileCount: value.files.length,
        createdAt: '2026-07-08T00:00:00.000Z',
        createdBy: null,
      },
      bundle: value,
    };
  }

  function deps(): WorkspaceSyncReconcileDeps {
    const remote = bundle({ 'designs/cloud.gb': REMOTE_CLOUD });
    return {
      appVersion: '0.9.7',
      nowMs: () => 2_000,
      createId: () => 'job-1',
      getActiveSession: async () => ({ accountId: 'account-a', email: 'me@example.com' }) as never,
      withWorkspaceQuiesced: async (_uuid, operation) => operation(),
      client: {
        listWorkspaces: async () => [
          {
            workspaceId: REMOTE_WORKSPACE_ID,
            clientWorkspaceId: 'workspace-a',
            displayName: 'Shared Project',
            owner: { kind: 'personal', accountId: 'account-a' },
            latest: {
              versionId: REMOTE_LATEST_ID,
              versionNumber: 5,
              contentSha256: remote.provenance.contentSha256,
            },
            storageBytesUsed: 512,
            versionCount: 5,
            updatedAt: '2026-07-08T00:00:00.000Z',
            lastSeenAt: '2026-07-08T00:00:00.000Z',
            deviceId: 'device-b',
          },
        ],
        downloadLatest: async () => latestResponse(remote),
      } as never,
    };
  }

  it('saves an offline edit the watcher had not committed yet, then starts over instead of refusing', async () => {
    writeFileSync(join(repo, 'designs/offline.gb'), OFFLINE_EDIT);

    const result = await resolveWorkspaceSyncMergeConflict(
      db,
      'workspace-a',
      { conflictId: 'conflict-1', choices: {} },
      deps()
    );

    expect(result.ok ? '' : result.message).not.toMatch(/unacknowledged changes/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'show', 'HEAD:designs/offline.gb')).toBe(OFFLINE_EDIT.trim());
    const row = db
      .prepare(`SELECT status FROM workspace_sync_merge_conflicts WHERE id = 'conflict-1'`)
      .get() as { status: string };
    expect(row.status).toBe('superseded');
  });

  it('starts over when the local copy changes while resolve waits on the network', async () => {
    const racing = deps();
    const client = racing.client as unknown as {
      downloadLatest: () => Promise<unknown>;
    };
    const download = client.downloadLatest;
    client.downloadLatest = async () => {
      writeFileSync(join(repo, 'designs/offline.gb'), OFFLINE_EDIT);
      return download();
    };

    const result = await resolveWorkspaceSyncMergeConflict(
      db,
      'workspace-a',
      { conflictId: 'conflict-1', choices: {} },
      racing
    );

    expect(result.ok ? '' : result.message).not.toMatch(/unacknowledged changes/);
    const row = db
      .prepare(`SELECT status FROM workspace_sync_merge_conflicts WHERE id = 'conflict-1'`)
      .get() as { status: string };
    expect(row.status).toBe('superseded');
  });

  it("the live scenario: keeps the user's choice when an unsaved offline edit makes it start over", async () => {
    const snap = async () =>
      (await buildWorkspaceSyncSnapshot(db, { workspaceUuid: 'workspace-a', appVersion: '0.9.7' }))
        .bundle;
    const commitAll = (message: string) =>
      commitAllIfDirty(repo, message, { author: { name: 'Test', email: 'test@example.com' } });
    const base = await snap();
    await commitAll('base, packaged by the app');
    const cloudPath = base.files.find((file) =>
      file.relativePath.endsWith('cloud.gb')
    )!.relativePath;
    const LOCAL_CLOUD = BASE_CLOUD.replace('acgtacgtac', 'ccccacgtac');
    writeFileSync(join(repo, cloudPath), LOCAL_CLOUD);
    await commitAll('this computer edits cloud.gb');
    const local = await snap();
    await commitAll('after the snapshot');
    const editedHead = git(repo, 'rev-parse', 'HEAD');
    const remote = structuredClone(base) as typeof base;
    const remoteFile = remote.files.find((file) => file.relativePath === cloudPath)!;
    remoteFile.content = REMOTE_CLOUD;
    remoteFile.sha256 = sha256Hex(REMOTE_CLOUD);
    remoteFile.sizeBytes = Buffer.byteLength(REMOTE_CLOUD, 'utf8');
    remote.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(remote));

    const outcome = reconcileWorkspaceBundles({
      workspaceId: REMOTE_WORKSPACE_ID,
      base,
      local,
      remote,
      localAuthorLabel: 'Me',
      remoteAuthorLabel: 'Collaborator',
    });
    expect(outcome.kind).toBe('conflicts');
    if (outcome.kind !== 'conflicts') return;
    const choices = Object.fromEntries(
      outcome.conflicts.map((item) => [item.resourceId, 'theirs' as const])
    );
    db.prepare(`DELETE FROM workspace_sync_merge_conflicts`).run();
    db.prepare(
      `INSERT INTO workspace_sync_merge_conflicts (
        id, workspace_id, workspace_uuid, base_remote_version_id, remote_version_id,
        remote_version_number, local_head_sha, status, conflicts_json, payload_json,
        created_at, updated_at
      ) VALUES ('conflict-2', 1, 'workspace-a', ?, ?, 5, ?, 'open', '[]', ?, 1, 1)`
    ).run(
      REMOTE_BASE_ID,
      REMOTE_LATEST_ID,
      editedHead,
      JSON.stringify({
        base,
        local,
        remote,
        remoteVersion: latestResponse(remote as never).version,
        localAuthorLabel: 'Me',
        remoteAuthorLabel: 'Collaborator',
      })
    );
    writeFileSync(join(repo, 'designs/offline.gb'), OFFLINE_EDIT);
    const live = deps();
    const client = live.client as unknown as {
      listWorkspaces: () => Promise<Array<{ latest: Record<string, unknown> }>>;
      downloadLatest: () => Promise<unknown>;
      downloadVersion: (workspaceId: string, versionId: string) => Promise<unknown>;
    };
    const list = client.listWorkspaces;
    client.listWorkspaces = async () =>
      (await list()).map((entry) => ({
        ...entry,
        latest: { ...entry.latest, contentSha256: remote.provenance.contentSha256 },
      }));
    client.downloadLatest = async () => latestResponse(remote as never);
    client.downloadVersion = async (_workspaceId, versionId) => ({
      ...latestResponse(base as never),
      version: { ...latestResponse(base as never).version, id: versionId, versionNumber: 4 },
    });

    const result = await resolveWorkspaceSyncMergeConflict(
      db,
      'workspace-a',
      { conflictId: 'conflict-2', choices },
      live
    );

    expect(result).toMatchObject({ ok: true, outcome: 'merged' });
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const tree = git(repo, 'ls-tree', '-r', '--name-only', 'HEAD');
    const cloudFinal = tree.split('\n').find((path) => path.endsWith('cloud.gb'))!;
    expect(git(repo, 'show', `HEAD:${cloudFinal}`)).toBe(REMOTE_CLOUD.trim());
    const offlinePath = tree.split('\n').find((path) => path.endsWith('offline.gb'))!;
    expect(git(repo, 'show', `HEAD:${offlinePath}`)).toBe(OFFLINE_EDIT.trim());
  });
});
