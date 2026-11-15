import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

vi.mock('@sentry/electron/main', () => ({
  captureMessage: vi.fn(),
}));

vi.mock('../auth/auth-config', () => ({
  getWebBaseUrl: vi.fn(() => 'https://web.test'),
  getAuthChannel: vi.fn(() => 'dev'),
  getRedirectScheme: vi.fn(() => 'dnaforge-dev'),
}));

vi.mock('../auth/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/session-store')>();
  return {
    ...actual,
    getActiveStoredSession: vi.fn(async () => ({ accountId: 'account-a' })),
  };
});

import { ensureSchema } from '../schema';
import { readWorkspaceSyncStatus } from '../workspace-sync-status';
import {
  resolveWorkspaceSyncConflict,
  type WorkspaceSyncConflictClient,
} from '../workspace-sync-conflicts';
import {
  __resetWorkspaceSyncObservationForTests,
  bindWorkspaceSyncObservationSink,
  type WorkspaceSyncObservation,
} from '../workspace-sync-observation';
import { createTestDb } from './test-db';

const REMOTE_WORKSPACE_ID = '8a4d99e9-2347-4d04-a447-d3070f7a7f9a';
const REMOTE_BASE_ID = '54a53fed-2b63-44c8-a26e-b0fb7e1788d2';
const REMOTE_LATEST_ID = '6e7b6d60-e681-4f5b-89fd-6fb9d7e48b6e';
const BASE_CONTENT = 'b'.repeat(64);

describe('workspace sync conflict resolution', () => {
  let db: Database.Database;
  let managedRoot: string;
  let client: WorkspaceSyncConflictClient;
  let listWorkspaces = vi.fn<WorkspaceSyncConflictClient['listWorkspaces']>();
  let downloadLatest = vi.fn<WorkspaceSyncConflictClient['downloadLatest']>();

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    managedRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-conflict-'));
    listWorkspaces = vi.fn<WorkspaceSyncConflictClient['listWorkspaces']>(async () => [
      remoteSummary(),
    ]);
    downloadLatest = vi.fn<WorkspaceSyncConflictClient['downloadLatest']>(async () =>
      latestResponse(validBundle())
    );
    client = { listWorkspaces, downloadLatest };
    seedConflictedWorkspace(db);
  });

  afterEach(() => {
    rmSync(managedRoot, { recursive: true, force: true });
  });

  it('keep_local rebases the pending upload onto the current remote latest without clearing local changes', async () => {
    await expect(
      resolveWorkspaceSyncConflict(db, {
        workspaceUuid: 'workspace-a',
        resolution: 'keep_local',
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2000,
        createJobId: () => 'rebase-a',
        getCurrentLocalHeadSha: () => 'head-local',
      })
    ).resolves.toEqual({ ok: true, resolution: 'keep_local' });

    expect(downloadLatest).toHaveBeenCalledWith(REMOTE_WORKSPACE_ID);
    expect(queueRow(db, 'conflict-a')).toMatchObject({
      status: 'canceled',
      error_code: 'CONFLICT_RESOLVED_KEEP_LOCAL',
    });
    expect(queueRow(db, 'rebase-a')).toMatchObject({
      status: 'pending',
      operation: 'upload',
      idempotency_key: `upload:workspace-a:${REMOTE_LATEST_ID}:head-local`,
      base_remote_version_id: REMOTE_LATEST_ID,
      local_head_sha: 'head-local',
    });
    expect(bindingRow(db, 'workspace-a')).toMatchObject({
      remote_workspace_id: REMOTE_WORKSPACE_ID,
      remote_latest_version_id: REMOTE_LATEST_ID,
      remote_latest_version_number: 5,
      last_acked_local_head_sha: 'head-base',
      last_downloaded_at: 2000,
    });
    expect(latestVersionRow(db, 1)).toMatchObject({
      remote_version_id: REMOTE_LATEST_ID,
      version_number: 5,
      local_head_sha: null,
      is_latest: 1,
    });

    const status = readWorkspaceSyncStatus(db, {
      workspaceUuid: 'workspace-a',
      getActiveAccountId: () => 'account-a',
      getCurrentLocalHeadSha: () => 'head-local',
      nowMs: () => 2000,
    });
    expect(status.syncAxis).toBe('queued');
    expect(status.blockers).not.toContain('conflict');
    expect(status.canDisplayPlainSynced).toBe(false);
  });

  it('rolls back conflict cancellation when replacement enqueue fails', async () => {
    const tables = ['workspace_sync_queue', 'workspace_sync_bindings', 'workspace_sync_versions'];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    db.exec(`CREATE TRIGGER reject_replacement_queue BEFORE INSERT ON workspace_sync_queue
      WHEN NEW.id = 'replacement-refused'
      BEGIN SELECT RAISE(ABORT, 'replacement enqueue refused'); END`);

    await expect(
      resolveWorkspaceSyncConflict(db, {
        workspaceUuid: 'workspace-a',
        resolution: 'keep_local',
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2000,
        createJobId: () => 'replacement-refused',
        getCurrentLocalHeadSha: () => 'head-local',
      })
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('replacement enqueue refused'),
    });

    expect(
      tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    ).toEqual(before);
  });

  it('reports conflict resolution outcomes without names or ids', async () => {
    const observations: WorkspaceSyncObservation[] = [];
    bindWorkspaceSyncObservationSink((observation) => observations.push(observation));
    try {
      const input = {
        workspaceUuid: 'workspace-a',
        resolution: 'keep_local' as const,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2000,
        createJobId: () => 'rebase-a',
        getCurrentLocalHeadSha: () => 'head-local',
      };
      await expect(resolveWorkspaceSyncConflict(db, input)).resolves.toMatchObject({ ok: true });
      await expect(resolveWorkspaceSyncConflict(db, input)).resolves.toMatchObject({ ok: false });
      expect(observations).toEqual([
        {
          feature_area: 'workspace',
          sync_operation: 'conflict_resolve',
          sync_outcome: 'kept_local',
          duration_ms: 0,
        },
        {
          feature_area: 'workspace',
          sync_operation: 'conflict_resolve',
          sync_outcome: 'failed',
          error_code: 'other',
          duration_ms: 0,
        },
      ]);
      expect(JSON.stringify(observations)).not.toMatch(/workspace-a|remote|head-local/);
    } finally {
      __resetWorkspaceSyncObservationForTests();
    }
  });

  it('refuses to roll a conflict binding backward when latest download metadata regresses', async () => {
    const bundle = validBundle();
    downloadLatest.mockResolvedValueOnce({
      ...latestResponse(bundle),
      version: {
        ...latestResponse(bundle).version,
        id: 'remote-regressed',
        versionNumber: 3,
      },
    });

    await expect(
      resolveWorkspaceSyncConflict(db, {
        workspaceUuid: 'workspace-a',
        resolution: 'keep_local',
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2000,
        getCurrentLocalHeadSha: () => 'head-local',
      })
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('older'),
    });

    expect(bindingRow(db, 'workspace-a')).toMatchObject({
      remote_latest_version_id: REMOTE_BASE_ID,
      remote_latest_version_number: 4,
    });
  });

  it('use_remote preserves the active workspace identity and archives the conflicted local copy', async () => {
    seedMergeConflict(db, 'merge-conflict-success');
    seedGraph(db);
    db.prepare(
      `INSERT INTO catalog_entities
      (id, type, name, locator, storage_type, workspace_id, created_at, updated_at)
      VALUES ('local-placement', 'sequence', 'Local design', 'entity://sequence/local-placement', 'file', 1, 1000, 1000)`
    ).run();
    db.prepare(
      `INSERT INTO catalog_workspace_placements
      (entity_id, workspace_id, parent_relative_path, display_name,
       normalized_sibling_name, presentation_kind, status, created_at, updated_at)
      VALUES ('local-placement', 1, '', 'Local design', 'local design', 'sequence', 'active', 1000, 1000)`
    ).run();
    await expect(
      resolveWorkspaceSyncConflict(db, {
        workspaceUuid: 'workspace-a',
        resolution: 'use_remote',
        managedRootDir: managedRoot,
        client,
        nowMs: () => 3000,
        createWorkspaceUuid: () => 'workspace-cloud',
        createRestoreLockId: () => 'restore-cloud',
        withReplacementSourceQuiesced: async (_workspaceUuid, operation) => operation(),
        getActiveAccountId: () => 'account-a',
      })
    ).resolves.toEqual({
      ok: true,
      resolution: 'use_remote',
      workspaceUuid: 'workspace-cloud',
    });

    expect(queueRow(db, 'conflict-a')).toMatchObject({
      status: 'canceled',
      error_code: 'CONFLICT_RESOLVED_USE_REMOTE',
    });
    expect(bindingRow(db, 'workspace-a')).toBeUndefined();
    expect(bindingRow(db, 'workspace-cloud')).toMatchObject({
      workspace_id: 1,
      remote_workspace_id: REMOTE_WORKSPACE_ID,
      remote_latest_version_id: REMOTE_LATEST_ID,
      last_acked_local_head_sha: expect.any(String),
    });
    const placement = db
      .prepare(
        `SELECT p.workspace_id, e.workspace_id AS entity_workspace_id
      FROM catalog_workspace_placements p JOIN catalog_entities e ON e.id = p.entity_id
      WHERE p.entity_id = 'local-placement'`
      )
      .get() as { workspace_id: number; entity_workspace_id: number };
    expect(placement).toEqual({
      workspace_id: expect.any(Number),
      entity_workspace_id: expect.any(Number),
    });
    expect(placement).not.toMatchObject({ workspace_id: 1 });
    expect(db.prepare('SELECT workspace_id FROM graph_nodes ORDER BY id').all()).toEqual([
      { workspace_id: placement.workspace_id },
      { workspace_id: placement.workspace_id },
    ]);
    expect(
      db.prepare('SELECT workspace_id, source_node_id, target_node_id FROM graph_edges').get()
    ).toEqual({ workspace_id: placement.workspace_id, source_node_id: 10, target_node_id: 11 });
    expect(
      db
        .prepare(
          `SELECT workspace_id, workspace_uuid, status
           FROM workspace_sync_merge_conflicts WHERE id = 'merge-conflict-success'`
        )
        .get()
    ).toEqual({
      workspace_id: placement.workspace_id,
      workspace_uuid: 'workspace-a',
      status: 'open',
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
      FROM catalog_workspace_placements p JOIN catalog_entities e ON e.id = p.entity_id
      WHERE p.workspace_id != e.workspace_id`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const cloudRepo = join(managedRoot, 'workspace-cloud', 'repo');
    expect(existsSync(join(cloudRepo, '.git'))).toBe(true);
    expect(existsSync(join(cloudRepo, 'designs', 'cloud.gb'))).toBe(false);
    expect(readFileSync(join(cloudRepo, 'designs', 'cloud', 'cloud.gb'), 'utf8')).toContain(
      'LOCUS'
    );
    expect(
      JSON.parse(
        readFileSync(join(cloudRepo, 'designs', 'cloud', '.forge', 'plasmid.json'), 'utf8')
      )
    ).toMatchObject({
      schema: 'waypoint.sequence.v1',
      product: { file: 'cloud.gb' },
    });
    expect(restoreLockRow(db, 'workspace-cloud')).toMatchObject({
      lock_id: 'restore-cloud',
      source_remote_version_id: REMOTE_LATEST_ID,
      status: 'completed',
      completed_at: 3000,
    });
  });

  it('refuses idempotency conflicts through the stale-base resolver without mutating state', async () => {
    db.prepare(
      `UPDATE workspace_sync_queue
       SET error_code = 'IDEMPOTENCY_CONFLICT',
           error_message = 'Idempotency key was reused.'
       WHERE id = 'conflict-a'`
    ).run();

    await expect(
      resolveWorkspaceSyncConflict(db, {
        workspaceUuid: 'workspace-a',
        resolution: 'keep_local',
        managedRootDir: managedRoot,
        client,
        nowMs: () => 4000,
        createJobId: () => 'rebase-a',
        getCurrentLocalHeadSha: () => 'head-local',
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('No stale-base sync conflict'),
    });

    expect(queueRow(db, 'conflict-a')).toMatchObject({
      status: 'failed',
      error_code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(bindingRow(db, 'workspace-a')).toMatchObject({
      remote_latest_version_id: REMOTE_BASE_ID,
      last_acked_local_head_sha: 'head-base',
    });
    expect(queueRow(db, 'rebase-a')).toBeUndefined();
  });

  it('restores the local conflict binding if opening the cloud copy fails', async () => {
    listWorkspaces.mockResolvedValueOnce([]);

    await expect(
      resolveWorkspaceSyncConflict(db, {
        workspaceUuid: 'workspace-a',
        resolution: 'use_remote',
        managedRootDir: managedRoot,
        client,
        nowMs: () => 5000,
        createWorkspaceUuid: () => 'workspace-cloud',
        withReplacementSourceQuiesced: async (_workspaceUuid, operation) => operation(),
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
    });

    expect(bindingRow(db, 'workspace-a')).toMatchObject({
      remote_workspace_id: REMOTE_WORKSPACE_ID,
      enabled: 1,
      remote_latest_version_id: REMOTE_BASE_ID,
      remote_latest_version_number: 4,
      remote_latest_content_sha256: BASE_CONTENT,
      last_acked_local_head_sha: 'head-base',
    });
    expect(queueRow(db, 'conflict-a')).toMatchObject({
      status: 'failed',
      error_code: 'CONFLICT',
      error_message: 'Latest version changed.',
    });
    expect(bindingRow(db, 'workspace-cloud')).toBeUndefined();
  });

  it('keeps the old conflict binding if the atomic replacement cutover fails', async () => {
    seedMergeConflict(db, 'merge-conflict-rollback');
    seedGraph(db);
    const graphBefore = ['graph_nodes', 'graph_edges'].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    );
    db.exec(
      `CREATE TRIGGER fail_replacement_binding
       BEFORE UPDATE OF workspace_uuid ON workspace_sync_bindings
       WHEN NEW.workspace_uuid = 'workspace-cloud'
       BEGIN
         SELECT RAISE(ABORT, 'injected replacement finalization failure');
       END`
    );

    await expect(
      resolveWorkspaceSyncConflict(db, {
        workspaceUuid: 'workspace-a',
        resolution: 'use_remote',
        managedRootDir: managedRoot,
        client,
        nowMs: () => 6000,
        createWorkspaceUuid: () => 'workspace-cloud',
        createRestoreLockId: () => 'restore-cloud',
        withReplacementSourceQuiesced: async (_workspaceUuid, operation) => operation(),
        getActiveAccountId: () => 'account-a',
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('injected replacement finalization failure'),
    });

    expect(bindingRow(db, 'workspace-a')).toMatchObject({
      remote_workspace_id: REMOTE_WORKSPACE_ID,
      enabled: 1,
      remote_latest_version_id: REMOTE_BASE_ID,
      remote_latest_version_number: 4,
      remote_latest_content_sha256: BASE_CONTENT,
      last_acked_local_head_sha: 'head-base',
    });
    expect(queueRow(db, 'conflict-a')).toMatchObject({
      status: 'failed',
      error_code: 'CONFLICT',
      error_message: 'Latest version changed.',
    });
    expect(bindingRow(db, 'workspace-cloud')).toBeUndefined();
    expect(restoreLockRow(db, 'workspace-cloud')).toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('injected replacement finalization failure'),
    });
    expect(
      db
        .prepare(
          `SELECT workspace_id, workspace_uuid, status
           FROM workspace_sync_merge_conflicts WHERE id = 'merge-conflict-rollback'`
        )
        .get()
    ).toEqual({ workspace_id: 1, workspace_uuid: 'workspace-a', status: 'open' });
    expect(
      ['graph_nodes', 'graph_edges'].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
      )
    ).toEqual(graphBefore);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

function seedGraph(db: Database.Database): void {
  db.exec(`
    INSERT INTO graph_nodes (id, workspace_id, name, file_path, length, created_at)
    VALUES (10, 1, 'Source', '/managed/local/repo/source.gb', 100, 1),
           (11, 1, 'Product', '/managed/local/repo/product.gb', 100, 1);
    INSERT INTO graph_edges (id, workspace_id, source_node_id, target_node_id, method, created_at)
    VALUES (20, 1, 10, 11, 'gibson', 1);
  `);
}

function seedMergeConflict(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO workspace_sync_merge_conflicts (
      id, workspace_id, workspace_uuid, remote_version_id, status,
      conflicts_json, payload_json, created_at, updated_at
    ) VALUES (?, 1, 'workspace-a', ?, 'open', '[]', '{}', 1, 1)`
  ).run(id, REMOTE_LATEST_ID);
}

function seedConflictedWorkspace(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (1, 'Local Project', '/managed/local/repo', 'workspace-a', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
      remote_latest_version_id, remote_latest_version_number, remote_latest_content_sha256,
      last_acked_local_head_sha, created_at, updated_at
    ) VALUES (1, 'workspace-a', 'account-a', ?, 1, ?, 4, ?, 'head-base', 1, 1)`
  ).run(REMOTE_WORKSPACE_ID, REMOTE_BASE_ID, BASE_CONTENT);
  db.prepare(
    `INSERT INTO workspace_sync_versions (
      id, workspace_id, remote_version_id, version_number, content_sha256,
      local_head_sha, file_count, size_bytes, status, is_latest, created_at, updated_at
    ) VALUES (?, 1, ?, 4, ?, 'head-base', 1, 100, 'ready', 1, 1, 1)`
  ).run(REMOTE_BASE_ID, REMOTE_BASE_ID, BASE_CONTENT);
  db.prepare(
    `INSERT INTO workspace_sync_queue (
      id, workspace_id, operation, status, idempotency_key, base_remote_version_id,
      local_head_sha, attempt_count, locked_at, locked_by_device_id,
      error_code, error_message, created_at, updated_at
    ) VALUES (
      'conflict-a', 1, 'upload', 'failed', ?, ?, 'head-local', 1, NULL, NULL,
      'CONFLICT', 'Latest version changed.', 1000, 1000
    )`
  ).run(`upload:workspace-a:${REMOTE_BASE_ID}:head-local`, REMOTE_BASE_ID);
}

function remoteSummary() {
  return {
    workspaceId: REMOTE_WORKSPACE_ID,
    clientWorkspaceId: 'workspace-a',
    displayName: 'Cloud Project',
    owner: { kind: 'personal' as const, accountId: 'account-a' },
    latest: {
      versionId: REMOTE_LATEST_ID,
      versionNumber: 5,
      contentSha256: validBundle().provenance.contentSha256,
    },
    storageBytesUsed: 512,
    versionCount: 5,
    updatedAt: '2026-07-08T00:00:00.000Z',
    lastSeenAt: '2026-07-08T00:00:00.000Z',
    deviceId: 'device-a',
  };
}

function latestResponse(bundle: WorkspaceSyncBundleV1) {
  return {
    workspaceId: REMOTE_WORKSPACE_ID,
    version: {
      id: REMOTE_LATEST_ID,
      versionNumber: 5,
      contentSha256: bundle.provenance.contentSha256,
      sizeBytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
      fileCount: bundle.files.length,
      createdAt: '2026-07-08T00:00:00.000Z',
    },
    bundle,
  };
}

function validBundle(): WorkspaceSyncBundleV1 {
  const content = 'LOCUS       cloud              2686 bp    DNA     circular\nORIGIN\n//\n';
  const fileSha = sha256Hex(content);
  const bundle: WorkspaceSyncBundleV1 = {
    schemaVersion: 1,
    capturedAt: '2026-07-08T00:00:00.000Z',
    workspace: { id: 'workspace-a', name: 'Cloud Project' },
    files: [
      {
        id: 'file-cloud',
        relativePath: 'designs/cloud.gb',
        name: 'cloud.gb',
        kind: 'genbank',
        contentType: 'text/plain',
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        sha256: fileSha,
        content,
      },
    ],
    excludedSummary: {
      unsupported: { count: 0, bytesApprox: 0 },
      'private-raw-data': { count: 0, bytesApprox: 0 },
      'reference-pointer': { count: 0, bytesApprox: 0 },
      'file-too-large': { count: 0, bytesApprox: 0 },
      'bundle-too-large': { count: 0, bytesApprox: 0 },
    },
    limits: {
      maxFileBytes: 2 * 1024 * 1024,
      maxBundleBytes: 10 * 1024 * 1024,
      maxFiles: 500,
    },
    provenance: {
      source: 'dnaforge-desktop',
      appVersion: '0.4.0',
      contentSha256: '0'.repeat(64),
    },
  };
  bundle.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(bundle));
  return bundle;
}

function queueRow(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM workspace_sync_queue WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function bindingRow(db: Database.Database, workspaceUuid: string): Record<string, unknown> {
  return db
    .prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_uuid = ?`)
    .get(workspaceUuid) as Record<string, unknown>;
}

function latestVersionRow(db: Database.Database, workspaceId: number): Record<string, unknown> {
  return db
    .prepare(`SELECT * FROM workspace_sync_versions WHERE workspace_id = ? AND is_latest = 1`)
    .get(workspaceId) as Record<string, unknown>;
}

function restoreLockRow(db: Database.Database, workspaceUuid: string): Record<string, unknown> {
  return db
    .prepare(
      `SELECT rl.*
       FROM workspace_sync_restore_locks rl
       JOIN workspaces w ON w.id = rl.workspace_id
       WHERE w.repo_uuid = ?`
    )
    .get(workspaceUuid) as Record<string, unknown>;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
