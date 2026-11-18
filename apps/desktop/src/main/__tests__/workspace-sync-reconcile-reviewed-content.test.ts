// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { workspaceSyncBundleHashInput, type WorkspaceSyncBundle } from '@waypoint/share-bundle';
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
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { ensureSchema } from '../schema';
import { reconcileWorkspaceBundles } from '../workspace-sync-reconcile';
import {
  resolveWorkspaceSyncMergeConflict,
  type WorkspaceSyncReconcileDeps,
} from '../workspace-sync-reconcile-runtime';
import { buildWorkspaceSyncSnapshot } from '../workspace-sync-snapshotter';
import { recordWorkspaceSyncReplicaFiles } from '../workspace-sync-replica-files';
import { createTestDb } from './test-db';

const WORKSPACE = '8a4d99e9-2347-4d04-a447-d3070f7a7f9a';
const BASE_ID = '54a53fed-2b63-44c8-a26e-b0fb7e1788d2';
const REMOTE_ID = '6e7b6d60-e681-4f5b-89fd-6fb9d7e48b6e';
const PRODUCT = 'sequences/construct/construct.gb';
const MARKER = 'sequences/construct/.forge/plasmid.json';

function genbank(bases: string): string {
  return `LOCUS       construct 8 bp DNA circular\nFEATURES             Location/Qualifiers\n     CDS             1..6\n                     /label="reporter"\nORIGIN\n        1 ${bases}\n//\n`;
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function response(bundle: WorkspaceSyncBundle, id = REMOTE_ID) {
  return {
    workspaceId: WORKSPACE,
    version: {
      id,
      versionNumber: id === BASE_ID ? 1 : 2,
      contentSha256: bundle.provenance.contentSha256,
      sizeBytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
      fileCount: bundle.files.length,
      createdAt: '2026-10-05T00:00:00.000Z',
      createdBy: null,
    },
    bundle,
  };
}

describe('a conflict choice authorizes only the exact package contents reviewed', () => {
  let db: Database.Database;
  let repo: string;
  let userData: string;
  let base: WorkspaceSyncBundle;
  let remote: WorkspaceSyncBundle;
  let choices: Record<string, 'theirs'>;

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    repo = mkdtempSync(join(tmpdir(), 'dnaforge-reviewed-package-'));
    userData = mkdtempSync(join(tmpdir(), 'dnaforge-reviewed-cache-'));
    vi.mocked(app.getPath).mockReturnValue(userData);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'sequences/construct/.forge'), { recursive: true });
    writeFileSync(
      join(repo, MARKER),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'construct-stable-id',
          name: 'Construct',
          product: { file: 'construct.gb' },
          updatedAt: '2026-10-05T00:00:00.000Z',
        })
      )
    );
    writeFileSync(join(repo, PRODUCT), genbank('acgtacgt'));
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
        })
      ).bundle;
    base = await snapshot();
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Common package');
    const baseHead = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, PRODUCT), genbank('ccccacgt'));
    const local = await snapshot();
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'My reviewed package');
    const localHead = git(repo, 'rev-parse', 'HEAD');
    remote = structuredClone(base);
    const product = remote.files.find((file) => file.relativePath === PRODUCT)!;
    product.content = genbank('ttttacgt');
    product.sha256 = digest(product.content);
    product.sizeBytes = Buffer.byteLength(product.content, 'utf8');
    remote.provenance.contentSha256 = digest(workspaceSyncBundleHashInput(remote));
    const conflict = reconcileWorkspaceBundles({ workspaceId: WORKSPACE, base, local, remote });
    expect(conflict.kind).toBe('conflicts');
    if (conflict.kind !== 'conflicts') throw new Error('Expected package conflict');
    choices = Object.fromEntries(conflict.conflicts.map((item) => [item.resourceId, 'theirs']));
    db.prepare(
      `INSERT INTO workspace_sync_bindings (
                  workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
                  remote_latest_version_id, remote_latest_version_number, last_acked_local_head_sha,
                  created_at, updated_at
                ) VALUES (1, 'workspace-a', 'account-a', ?, 1, ?, 1, ?, 1, 1)`
    ).run(WORKSPACE, BASE_ID, baseHead);
    recordWorkspaceSyncReplicaFiles(db, {
      workspaceUuid: 'workspace-a',
      remoteWorkspaceId: WORKSPACE,
      remoteVersionId: BASE_ID,
      paths: base.files.map((file) => file.relativePath),
      nowMs: 1,
    });
    db.prepare(
      `INSERT INTO workspace_sync_merge_conflicts (
                  id, workspace_id, workspace_uuid, base_remote_version_id, remote_version_id,
                  remote_version_number, local_head_sha, status, conflicts_json, payload_json,
                  created_at, updated_at
                ) VALUES ('reviewed-conflict', 1, 'workspace-a', ?, ?, 2, ?, 'open', '[]', ?, 1, 1)`
    ).run(
      BASE_ID,
      REMOTE_ID,
      localHead,
      JSON.stringify({
        base,
        local,
        remote,
        remoteVersion: response(remote).version,
        localAuthorLabel: 'Me',
        remoteAuthorLabel: 'Collaborator',
      })
    );
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  });

  function deps(onDownload?: () => void): WorkspaceSyncReconcileDeps {
    let ids = 0;
    return {
      appVersion: '1.0.0',
      nowMs: () => 2_000,
      createId: () => `new-record-${++ids}`,
      getActiveSession: async () => ({ accountId: 'account-a', email: 'me@example.com' }) as never,
      withWorkspaceQuiesced: async (_uuid, operation) => operation(),
      client: {
        listWorkspaces: async () => [
          {
            workspaceId: WORKSPACE,
            clientWorkspaceId: 'workspace-a',
            displayName: 'Shared',
            owner: { kind: 'personal', accountId: 'account-a' },
            latest: {
              versionId: REMOTE_ID,
              versionNumber: 2,
              contentSha256: remote.provenance.contentSha256,
            },
            storageBytesUsed: 512,
            versionCount: 2,
            updatedAt: '2026-10-05T00:00:00.000Z',
            lastSeenAt: '2026-10-05T00:00:00.000Z',
            deviceId: 'other-device',
          },
        ],
        downloadLatest: async () => {
          onDownload?.();
          return response(remote);
        },
        downloadVersion: async (_workspace: string, id: string) => response(base, id),
      } as never,
    };
  }

  it.each(['before resolve', 'during download'] as const)(
    'asks again when the chosen package changes %s instead of silently discarding its new bases',
    async (when) => {
      const newest = genbank('ggggacgt');
      const change = () => writeFileSync(join(repo, PRODUCT), newest);
      if (when === 'before resolve') change();
      let changedDuringDownload = false;
      const dependencies = deps(
        when === 'during download'
          ? () => {
              if (!changedDuringDownload) {
                changedDuringDownload = true;
                change();
              }
            }
          : undefined
      );

      const result = await resolveWorkspaceSyncMergeConflict(
        db,
        'workspace-a',
        {
          conflictId: 'reviewed-conflict',
          choices,
        },
        dependencies
      );

      expect(result).toMatchObject({ ok: true, outcome: 'conflicts' });
      if (!result.ok || result.outcome !== 'conflicts') return;
      expect(result.conflict.conflictId).not.toBe('reviewed-conflict');
      expect(result.conflict.items[0]?.resourceId).toBe('seq:construct-stable-id');
      expect(result.conflict.items[0]?.local?.sequence).toMatchObject({
        productPath: 'construct.gb',
        baseCount: 8,
        topology: 'circular',
        annotationCount: 1,
        inspectionUnavailableReason: null,
      });
      expect(git(repo, 'show', `HEAD:${PRODUCT}`)).toBe(newest.trim());
      expect(git(repo, 'status', '--porcelain')).toBe('');
    }
  );

  it('reuses an unchanged package choice when only an unrelated file changed', async () => {
    const notes = 'New unrelated experiment notes\n';
    writeFileSync(join(repo, 'notes.txt'), notes);
    const result = await resolveWorkspaceSyncMergeConflict(
      db,
      'workspace-a',
      {
        conflictId: 'reviewed-conflict',
        choices,
      },
      deps()
    );
    expect(result).toMatchObject({ ok: true, outcome: 'merged' });
    expect(git(repo, 'show', `HEAD:${PRODUCT}`)).toBe(genbank('ttttacgt').trim());
    expect(git(repo, 'show', 'HEAD:notes.txt')).toBe(notes.trim());
  });
});
