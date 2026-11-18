// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import {
  workspaceSyncManifestHashInput,
  type WorkspaceSyncBundle,
  type WorkspaceSyncManifestV1,
} from '@waypoint/share-bundle';
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

import { app } from 'electron';
import {
  buildNotebookPackageMetadata,
  serializeNotebookPackageMetadata,
} from '../../db/notebook-package';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import type { StoredSession } from '../auth/session-store';
import { DesktopSyncClientError, type DesktopSyncClient } from '../desktop-sync-client';
import { ensureSchema } from '../schema';
import { workspaceSyncBlobPath } from '../workspace-sync-blob-cache';
import { workspaceSyncManifestFromBundle } from '../workspace-sync-manifest-upload';
import { createWorkspaceSyncProjectsClient } from '../workspace-sync-projects';
import { reconcileWorkspaceSyncConflict } from '../workspace-sync-reconcile-runtime';
import { recordWorkspaceSyncReplicaFiles } from '../workspace-sync-replica-files';
import { buildWorkspaceSyncSnapshot } from '../workspace-sync-snapshotter';
import { createTestDb } from './test-db';

const WORKSPACE = '8a4d99e9-2347-4d04-a447-d3070f7a7f9a';
const BASE_ID = '54a53fed-2b63-44c8-a26e-b0fb7e1788d2';
const LATEST_ID = '6e7b6d60-e681-4f5b-89fd-6fb9d7e48b6e';
const API = `/api/desktop-sync/workspaces/${WORKSPACE}`;

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function writeJourneyProject(repo: string): void {
  mkdirSync(join(repo, 'pUC19/.forge'), { recursive: true });
  writeFileSync(
    join(repo, 'pUC19/.forge/plasmid.json'),
    serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'puc19-stable-id',
        name: 'pUC19',
        product: { file: 'pUC19.gb' },
        updatedAt: '2026-10-27T00:00:00.000Z',
      })
    )
  );
  writeFileSync(
    join(repo, 'pUC19/pUC19.gb'),
    readFileSync(join(__dirname, '../../../../../test-fixtures/sequences/circular/pUC19.gb'))
  );
  mkdirSync(join(repo, 'Large attachments/.forge'), { recursive: true });
  mkdirSync(join(repo, 'Large attachments/assets'), { recursive: true });
  writeFileSync(
    join(repo, 'Large attachments/.forge/notebook.json'),
    serializeNotebookPackageMetadata(
      buildNotebookPackageMetadata({
        id: 'large-attachments',
        title: 'Large attachments',
        markdownFileName: 'Large attachments.md',
        updatedAt: '2026-10-27T00:00:00.000Z',
      })
    )
  );
  writeFileSync(
    join(repo, 'Large attachments/Large attachments.md'),
    serializeNotebookMarkdown({
      identity: { id: 'large-attachments', title: 'Large attachments', formatVersion: 2 },
      content: { type: 'doc', content: [] },
    }).markdown
  );
  writeFileSync(
    join(repo, 'Large attachments/assets/model.bin'),
    Buffer.from([0, 1, 2, 3, 255, 254, 253])
  );
}

function manifestDetail(versionId: string, versionNumber: number, bundle: WorkspaceSyncBundle) {
  const manifest: WorkspaceSyncManifestV1 = workspaceSyncManifestFromBundle(bundle);
  return {
    workspaceId: WORKSPACE,
    version: {
      id: versionId,
      versionNumber,
      representation: 'manifest_v1',
      manifestSchemaVersion: 1,
      contentSha256: createHash('sha256')
        .update(workspaceSyncManifestHashInput(manifest), 'utf8')
        .digest('hex'),
      sizeBytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
      fileCount: manifest.files.length,
      createdAt: '2026-10-27T00:00:00.000Z',
      finalizedAt: '2026-10-27T00:00:01.000Z',
      createdBy: null,
    },
    manifest,
    resourceIdentities: manifest.files.map((file) => ({
      path: file.path,
      resourceId: `cccccccc-cccc-4ccc-8ccc-${createHash('sha256').update(file.path).digest('hex').slice(0, 12)}`,
    })),
  };
}

function manifestRestoreRequired(): DesktopSyncClientError {
  return new DesktopSyncClientError(
    'MANIFEST_RESTORE_REQUIRED',
    'This version requires manifest download and restore support.',
    { status: 409, retryable: false, terminal: false }
  );
}

describe('automatic merge of a manifest-backed shared project ', () => {
  let db: Database.Database;
  let repo: string;
  let uploaderCache: string;
  let reconcilerCache: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    repo = mkdtempSync(join(tmpdir(), 'dnaforge-manifest-merge-'));
    uploaderCache = mkdtempSync(join(tmpdir(), 'dnaforge-manifest-merge-uploader-'));
    reconcilerCache = mkdtempSync(join(tmpdir(), 'dnaforge-manifest-merge-reconciler-'));
    vi.mocked(app.getPath).mockReturnValue(uploaderCache);
  });

  afterEach(() => {
    db.close();
    for (const path of [repo, uploaderCache, reconcilerCache])
      rmSync(path, { recursive: true, force: true });
  });

  it('merges a collaborator-added text note with a local text note instead of rejecting the manifest', async () => {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeJourneyProject(repo);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Shared', ?, 'workspace-a', 1, 1)`
    ).run(repo);
    const snapshot = async () =>
      (
        await buildWorkspaceSyncSnapshot(db, {
          workspaceUuid: 'workspace-a',
          appVersion: '1.0.0',
          prepareProjection: false,
          directStorage: true,
        })
      ).bundle;
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Shared project');
    const baseHead = git(repo, 'rev-parse', 'HEAD');
    const base = await snapshot();
    writeFileSync(join(repo, 'note-member-a.txt'), 'Added by member A\n');
    const latest = await snapshot();
    rmSync(join(repo, 'note-member-a.txt'));
    writeFileSync(join(repo, 'note-member-b.txt'), 'Added by member B\n');
    expect(latest.files.map((file) => [file.relativePath, file.kind])).toContainEqual([
      'note-member-a.txt',
      'workspace-resource',
    ]);

    db.prepare(
      `INSERT INTO workspace_sync_bindings (
         workspace_id, workspace_uuid, owner_account_id, owner_org_id, remote_workspace_id,
         enabled, remote_latest_version_id, remote_latest_version_number,
         last_acked_local_head_sha, access_role, created_at, updated_at
       ) VALUES (1, 'workspace-a', 'account-a', 'org-lab', ?, 1, ?, 1, ?, 'editor', 1, 1)`
    ).run(WORKSPACE, BASE_ID, baseHead);
    recordWorkspaceSyncReplicaFiles(db, {
      workspaceUuid: 'workspace-a',
      remoteWorkspaceId: WORKSPACE,
      remoteVersionId: BASE_ID,
      paths: base.files.map((file) => file.relativePath),
      nowMs: 1,
    });

    const details = new Map([
      [BASE_ID, manifestDetail(BASE_ID, 1, base)],
      [LATEST_ID, manifestDetail(LATEST_ID, 2, latest)],
    ]);
    const uploaded = new Map<string, Buffer>();
    for (const file of [...base.files, ...latest.files]) {
      uploaded.set(
        file.sha256,
        file.encoding === 'blob'
          ? readFileSync(
              await workspaceSyncBlobPath(
                file.sha256,
                join(uploaderCache, 'workspace-sync', 'blobs')
              )
            )
          : Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
      );
    }
    const hosted: DesktopSyncClient = {
      requestJson: async <T>(path: string): Promise<T> => {
        if (path === `${API}/latest` || path === `${API}/versions/${BASE_ID}`)
          throw manifestRestoreRequired();
        if (path === `${API}/latest/manifest`) return details.get(LATEST_ID) as T;
        if (path === `${API}/versions/${BASE_ID}/manifest`) return details.get(BASE_ID) as T;
        throw new Error(`unexpected request ${path}`);
      },
      requestStream: async (path) => {
        const filePath = new URL(path, 'https://web.test').searchParams.get('path');
        const file = [...details.values()]
          .flatMap((detail) => detail.manifest.files)
          .find((candidate) => candidate.path === filePath);
        if (!file) throw new Error(`unexpected download ${path}`);
        return new Response(uploaded.get(file.contentSha256)!);
      },
      getAccountId: async () => 'account-a',
    };
    const transport = createWorkspaceSyncProjectsClient(hosted);
    vi.mocked(app.getPath).mockReturnValue(reconcilerCache);
    const session: StoredSession = {
      accountId: 'account-a',
      desktopSessionId: 'session-b',
      accessToken: 'access',
      accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
      refreshToken: 'refresh',
      email: 'b@example.com',
      channel: 'dev',
      updatedAt: 1,
    };

    const result = await reconcileWorkspaceSyncConflict(db, 'workspace-a', {
      appVersion: '1.0.0',
      nowMs: () => 2_000,
      createId: () => 'merged-upload',
      getActiveSession: async () => session,
      withWorkspaceQuiesced: async (_uuid, operation) => operation(),
      client: {
        ...transport,
        listWorkspaces: async () => [
          {
            workspaceId: WORKSPACE,
            clientWorkspaceId: 'workspace-a',
            displayName: 'Shared',
            owner: { kind: 'org', orgId: 'org-lab' },
            latest: {
              versionId: LATEST_ID,
              versionNumber: 2,
              contentSha256: details.get(LATEST_ID)!.version.contentSha256,
            },
            storageBytesUsed: 0,
            versionCount: 2,
            updatedAt: '2026-10-27T00:00:00.000Z',
            lastSeenAt: '2026-10-27T00:00:00.000Z',
            deviceId: 'member-a-device',
          },
        ],
      },
    });

    expect(result.ok ? result.outcome : result.message).toBe('merged');
    expect(git(repo, 'show', 'HEAD:note-member-a.txt')).toBe('Added by member A');
    expect(git(repo, 'show', 'HEAD:note-member-b.txt')).toBe('Added by member B');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(
      db
        .prepare(
          `SELECT base_remote_version_id FROM workspace_sync_queue
           WHERE id = 'merged-upload' AND operation = 'upload' AND status = 'pending'`
        )
        .get()
    ).toEqual({ base_remote_version_id: LATEST_ID });
  }, 30_000);
});
