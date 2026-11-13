import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineScientificDocument } from '@waypoint/scientific-objects';
import {
  parseOperationId,
  parseResourceId,
  parseWorkspacePath,
} from '@waypoint/workspace-revisions';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', isPackaged: false },
  dialog: { showErrorBox: vi.fn() },
  shell: { trashItem: (path: string) => rm(path, { recursive: true }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./auth/auth-config', () => ({
  getWebBaseUrl: () => 'https://web.test',
  getAuthChannel: () => 'dev',
  getRedirectScheme: () => 'dnaforge-dev',
}));

import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { ScientificObjectStore } from './scientific-object-store';
import { materializeScientificWorkspace } from './scientific-object-materializer';
import {
  ScientificCloudTransferUnsupportedError,
  assertScientificCloudTransferSupported,
  assertScientificWorkspaceLocalOnly,
} from './scientific-cloud-admission';
import { ensureWorkspaceSyncBinding } from './workspace-sync-binding';
import {
  buildWorkspaceSyncRecoveryCapture,
  buildWorkspaceSyncSnapshot,
  buildWorkspaceSyncUploadCapture,
} from './workspace-sync-snapshotter';
import {
  applyLatestToExistingManagedRepo,
  type DesktopSyncMaterializableVersion,
} from './workspace-sync-projects';
import { rehydrateWorkspaceSyncState } from './workspace-sync-restore';
import { enqueueWorkspaceSyncJob } from './workspace-sync-queue';
import { WorkspaceSyncUploadWorker } from './workspace-sync-upload-worker';
import { recordWorkspaceSyncUploadSnapshot } from './workspace-sync-upload-snapshots';
import { commitAllIfDirty, initManagedRepo } from './workspace-git';

const remoteId = '11111111-1111-4111-8111-111111111111';
const remoteVersion = '22222222-2222-4222-8222-222222222222';
const workspaceUuid = 'scientific-cloud-pressure';
const cleanups: (() => void)[] = [];
const tables = [
  'scientific_revision_records',
  'scientific_revision_refs',
  'scientific_revision_blobs',
  'scientific_materialization_jobs',
] as const;

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const must = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

async function fixture() {
  const file = createFileTestDb('scientific-cloud-pressure');
  cleanups.push(file.cleanup);
  ensureSchema(file.db, file.dbPath);
  const root = join(file.tmpDir, 'project');
  await mkdir(root);
  await writeFile(join(root, 'template.fasta'), '>template\nACGTACGT\n');
  await initManagedRepo(root);
  const head = await commitAllIfDirty(root, 'Original file-based project');
  if (!head) throw new Error('Fixture Git head');
  const workspaceId = Number(
    file.db
      .prepare('INSERT INTO workspaces (name, path, repo_uuid, created_at) VALUES (?, ?, ?, 1)')
      .run('Cloud pressure', root, workspaceUuid).lastInsertRowid
  );
  const store = new ScientificObjectStore(file.db, workspaceId);
  return { ...file, root, head, workspaceId, store };
}

function submission() {
  const defined = defineScientificDocument({
    formatVersion: 1,
    kind: 'primer',
    name: 'PCR primer',
    molecule: 'DNA',
    bases: 'ACGT',
    modifications: [],
    fields: {},
  });
  return {
    operationId: must(parseOperationId('accept-primer')),
    expectedHead: null,
    mutations: [
      {
        kind: 'create-resource' as const,
        resourceId: must(parseResourceId('primer')),
        path: must(parseWorkspacePath('primers/primer.json')),
        state: defined.state,
        origin: { kind: 'created' as const },
      },
    ],
    blobs: [new TextEncoder().encode(defined.text)],
  };
}

function accept(f: Awaited<ReturnType<typeof fixture>>) {
  const result = f.store.submit(submission());
  if (result.kind !== 'changed') throw new Error('Fixture scientific acceptance');
  return result;
}

function authority(db: Database.Database, workspaceId: number): string {
  return JSON.stringify(
    tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ?`).all(workspaceId)
    )
  );
}

function bind(db: Database.Database, workspaceId: number, enabled = 1, owner = 'account-a') {
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
      remote_latest_version_id, remote_latest_version_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)`
  ).run(workspaceId, workspaceUuid, owner, remoteId, enabled, remoteVersion);
}

describe('scientific authority and file-only cloud transfer', () => {
  it('pins only confirmed scientific-format claims and continues to refuse file-only export', async () => {
    const f = await fixture();
    accept(f);
    const before = authority(f.db, f.workspaceId);
    const response = {
      remoteWorkspaceId: remoteId,
      clientWorkspaceId: workspaceUuid,
      claimedByAccountId: 'account-a',
      owner: { kind: 'personal' as const, accountId: 'account-a' },
    };
    const claimWorkspace = vi.fn(
      async (): Promise<typeof response & { scientificHistoryFormats?: number[] }> => response
    );
    const input = {
      workspaceUuid,
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 2,
      claimClient: { supportsScientificHistory: true, claimWorkspace },
    };
    await expect(ensureWorkspaceSyncBinding(f.db, input)).rejects.toThrow(/does not support/);
    expect(f.db.prepare('SELECT * FROM workspace_sync_bindings').all()).toEqual([]);
    expect(
      f.db.prepare('SELECT remote_workspace_id FROM scientific_workspace_identities').get()
    ).toEqual({ remote_workspace_id: null });
    claimWorkspace.mockResolvedValue({ ...response, scientificHistoryFormats: [1] });
    expect(await ensureWorkspaceSyncBinding(f.db, input)).toMatchObject({
      enabled: true,
      remoteWorkspaceId: remoteId,
    });
    expect(claimWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ scientificHistoryFormat: 1 })
    );
    expect(
      f.db.prepare('SELECT remote_workspace_id FROM scientific_workspace_identities').get()
    ).toEqual({ remote_workspace_id: remoteId });
    expect(authority(f.db, f.workspaceId)).toBe(before);
    expect(() => assertScientificCloudTransferSupported(f.db, f.workspaceId)).toThrow(
      ScientificCloudTransferUnsupportedError
    );
    expect(() => assertScientificWorkspaceLocalOnly(f.db, f.workspaceId)).not.toThrow();
  });

  it('confirms capability without erasing an existing or newly learned cloud base during the request', async () => {
    const f = await fixture();
    accept(f);
    bind(f.db, f.workspaceId, 0);
    const newer = '33333333-3333-4333-8333-333333333333';
    const digest = 'a'.repeat(64);
    const result = await ensureWorkspaceSyncBinding(f.db, {
      workspaceUuid,
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 3,
      claimClient: {
        supportsScientificHistory: true,
        claimWorkspace: async () => {
          f.db
            .prepare(
              'UPDATE workspace_sync_bindings SET remote_latest_version_id=?,remote_latest_version_number=2,remote_latest_content_sha256=?'
            )
            .run(newer, digest);
          return {
            remoteWorkspaceId: remoteId,
            clientWorkspaceId: workspaceUuid,
            claimedByAccountId: 'account-a',
            owner: { kind: 'personal' as const, accountId: 'account-a' },
            scientificHistoryFormats: [1],
            remoteLatestVersionId: null,
            remoteLatestVersionNumber: null,
            remoteLatestContentSha256: null,
          };
        },
      },
    });
    expect(result).toMatchObject({
      enabled: true,
      remoteLatestVersionId: newer,
      remoteLatestVersionNumber: 2,
      remoteLatestContentSha256: digest,
    });
  });

  it.each([0, 1])(
    'refuses enrollment atomically with a cloud binding enabled=%s',
    async (enabled) => {
      const f = await fixture();
      bind(f.db, f.workspaceId, enabled, 'different-account');
      const before = authority(f.db, f.workspaceId);
      expect(() => f.store.submit(submission())).toThrow(ScientificCloudTransferUnsupportedError);
      expect(authority(f.db, f.workspaceId)).toBe(before);
      expect(f.store.read().head).toBeNull();
      expect(await readFile(join(f.root, 'template.fasta'), 'utf8')).toBe('>template\nACGTACGT\n');
    }
  );

  it('allows local scientific authority and legacy cloud binding independently', async () => {
    const f = await fixture();
    expect(() => assertScientificWorkspaceLocalOnly(f.db, f.workspaceId)).not.toThrow();
    expect(() => assertScientificCloudTransferSupported(f.db, f.workspaceId)).not.toThrow();
    const claimWorkspace = vi.fn(async () => ({
      remoteWorkspaceId: remoteId,
      clientWorkspaceId: workspaceUuid,
      claimedByAccountId: 'account-a',
      owner: { kind: 'personal' as const, accountId: 'account-a' },
    }));
    expect(
      await ensureWorkspaceSyncBinding(f.db, {
        workspaceUuid,
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 2,
        claimClient: { claimWorkspace },
      })
    ).toMatchObject({ enabled: true, remoteWorkspaceId: remoteId });
    expect(claimWorkspace).toHaveBeenCalledTimes(1);
  });

  it('refuses new claims and re-enables before making a remote request', async () => {
    const f = await fixture();
    accept(f);
    const before = authority(f.db, f.workspaceId);
    const claimWorkspace = vi.fn();
    const claim = () =>
      ensureWorkspaceSyncBinding(f.db, {
        workspaceUuid,
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 2,
        claimClient: { claimWorkspace },
      });
    await expect(claim()).rejects.toThrow(ScientificCloudTransferUnsupportedError);
    bind(f.db, f.workspaceId, 0);
    await expect(claim()).rejects.toThrow(ScientificCloudTransferUnsupportedError);
    expect(claimWorkspace).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT enabled FROM workspace_sync_bindings').get()).toEqual({
      enabled: 0,
    });
    expect(authority(f.db, f.workspaceId)).toBe(before);
  });

  it('rechecks enrollment after an in-flight remote claim before storing the binding', async () => {
    const f = await fixture();
    await expect(
      ensureWorkspaceSyncBinding(f.db, {
        workspaceUuid,
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        nowMs: 2,
        claimClient: {
          claimWorkspace: async () => {
            accept(f);
            return {
              remoteWorkspaceId: remoteId,
              clientWorkspaceId: workspaceUuid,
              claimedByAccountId: 'account-a',
              owner: { kind: 'personal' as const, accountId: 'account-a' },
            };
          },
        },
      })
    ).rejects.toThrow(ScientificCloudTransferUnsupportedError);
    expect(f.db.prepare('SELECT * FROM workspace_sync_bindings').all()).toEqual([]);
    expect(f.store.read().head).not.toBeNull();
  });

  it.each(['pending', 'complete'] as const)(
    'refuses every file-only capture with %s delivery, including projection bypass and recovery',
    async (delivery) => {
      const f = await fixture();
      accept(f);
      if (delivery === 'complete')
        expect(await materializeScientificWorkspace(f.store)).toMatchObject({ kind: 'complete' });
      const before = authority(f.db, f.workspaceId);
      const input = {
        workspaceUuid,
        appVersion: '1.0.0',
        prepareProjection: false,
        captureSourceRoot: join(f.tmpDir, 'capture'),
      };
      await expect(buildWorkspaceSyncSnapshot(f.db, input)).rejects.toThrow(
        ScientificCloudTransferUnsupportedError
      );
      await expect(buildWorkspaceSyncUploadCapture(f.db, input)).rejects.toThrow(
        ScientificCloudTransferUnsupportedError
      );
      await expect(buildWorkspaceSyncRecoveryCapture(f.db, input)).rejects.toThrow(
        ScientificCloudTransferUnsupportedError
      );
      expect(authority(f.db, f.workspaceId)).toBe(before);
    }
  );

  it.each(tables)('refuses isolated or corrupt retained rows in %s', async (table) => {
    const f = await fixture();
    f.db.pragma('foreign_keys = OFF');
    switch (table) {
      case 'scientific_revision_records':
        f.db
          .prepare(
            `INSERT INTO ${table} VALUES (?, 'unsupported-record', 'operation-receipt', '{"formatVersion":999}')`
          )
          .run(f.workspaceId);
        break;
      case 'scientific_revision_refs':
        f.db.prepare(`INSERT INTO ${table} VALUES (?, 'accepted', NULL)`).run(f.workspaceId);
        break;
      case 'scientific_revision_blobs':
        f.db
          .prepare(`INSERT INTO ${table} VALUES (?, 'corrupt-hash', 3, ?)`)
          .run(f.workspaceId, Buffer.from('bad'));
        break;
      case 'scientific_materialization_jobs':
        f.db
          .prepare(
            `INSERT INTO ${table} (
            workspace_id, version_id, operation_id, payload_version, manifest_json,
            status, created_at, updated_at
          ) VALUES (?, 'missing-version', 'orphan-delivery', 1, '{"formatVersion":999}', 'pending', 1, 1)`
          )
          .run(f.workspaceId);
        break;
    }
    f.db.pragma('foreign_keys = ON');
    const before = authority(f.db, f.workspaceId);
    expect(() => assertScientificCloudTransferSupported(f.db, f.workspaceId)).toThrow(
      ScientificCloudTransferUnsupportedError
    );
    expect(authority(f.db, f.workspaceId)).toBe(before);
  });

  it('invalidates an immutable capture when scientific acceptance happens after its files are frozen', async () => {
    const f = await fixture();
    await expect(
      buildWorkspaceSyncUploadCapture(f.db, {
        workspaceUuid,
        appVersion: '1.0.0',
        captureSourceRoot: join(f.tmpDir, 'capture'),
        onSourcesFrozen: () => {
          accept(f);
        },
      })
    ).rejects.toThrow(ScientificCloudTransferUnsupportedError);
    expect(f.store.read().head).not.toBeNull();
    expect(await readFile(join(f.root, 'template.fasta'), 'utf8')).toBe('>template\nACGTACGT\n');
  });

  it('preserves history after deletion and restart instead of treating an empty live catalog as legacy', async () => {
    const f = await fixture();
    const accepted = accept(f);
    const entry = f.store.catalog().entries[0];
    f.store.submit({
      operationId: must(parseOperationId('delete-primer')),
      expectedHead: accepted.version.id,
      mutations: [
        {
          kind: 'delete-resource',
          resourceId: entry.resourceId,
          expectedRevision: entry.revisionId,
          expectedPath: must(parseWorkspacePath('primers/primer.json')),
        },
      ],
      blobs: [],
    });
    expect(await materializeScientificWorkspace(f.store)).toMatchObject({ kind: 'complete' });
    const before = authority(f.db, f.workspaceId);
    f.db.close();
    const reopened = openFileTestDb(f.dbPath);
    cleanups.push(() => reopened.close());
    expect(new ScientificObjectStore(reopened, f.workspaceId).catalog().entries[0].tombstone).toBe(
      true
    );
    expect(() => assertScientificCloudTransferSupported(reopened, f.workspaceId)).toThrow(
      ScientificCloudTransferUnsupportedError
    );
    expect(authority(reopened, f.workspaceId)).toBe(before);
  });

  it('refuses an incoming replica before downloads, filesystem installation or projection writes', async () => {
    const f = await fixture();
    accept(f);
    await materializeScientificWorkspace(f.store);
    bind(f.db, f.workspaceId);
    const before = authority(f.db, f.workspaceId);
    const downloadManifestFile = vi.fn();
    const onReplicaPreparing = vi.fn();
    const latest: DesktopSyncMaterializableVersion = {
      workspaceId: remoteId,
      version: {
        id: remoteVersion,
        versionNumber: 2,
        contentSha256: 'a'.repeat(64),
        sizeBytes: 3,
        fileCount: 1,
        createdAt: new Date(2).toISOString(),
        representation: 'manifest_v1',
        manifestSchemaVersion: 1,
        finalizedAt: new Date(2).toISOString(),
      },
      manifest: {
        schemaVersion: 1,
        files: [
          {
            path: 'template.fasta',
            contentSha256: 'b'.repeat(64),
            sizeBytes: 3,
            contentType: 'text/plain',
          },
        ],
      },
      resourceIdentities: [],
    };
    await expect(
      applyLatestToExistingManagedRepo(f.db, {
        workspaceId: f.workspaceId,
        workspaceUuid,
        repoPath: f.root,
        remote: {
          workspaceId: remoteId,
          clientWorkspaceId: workspaceUuid,
          displayName: 'Remote',
          owner: { kind: 'personal', accountId: 'account-a' },
          latest: { versionId: remoteVersion, versionNumber: 2, contentSha256: 'a'.repeat(64) },
          storageBytesUsed: 3,
          versionCount: 2,
          updatedAt: new Date(2).toISOString(),
          lastSeenAt: new Date(2).toISOString(),
          deviceId: 'remote-device',
        },
        latest,
        downloadManifestFile,
        expectedLocalHeadSha: f.head,
        expectedRemoteVersionId: remoteVersion,
        nowMs: 3,
        onReplicaPreparing,
      })
    ).rejects.toThrow(ScientificCloudTransferUnsupportedError);
    expect(downloadManifestFile).not.toHaveBeenCalled();
    expect(onReplicaPreparing).not.toHaveBeenCalled();
    expect(() =>
      rehydrateWorkspaceSyncState(f.db, {
        workspaceId: f.workspaceId,
        workspaceRoot: f.root,
        strict: true,
      })
    ).toThrow(ScientificCloudTransferUnsupportedError);
    expect(await readFile(join(f.root, 'template.fasta'), 'utf8')).toBe('>template\nACGTACGT\n');
    expect(authority(f.db, f.workspaceId)).toBe(before);
  });

  it('rejects a queued retry captured before enrollment without invoking upload or discarding its snapshot', async () => {
    const f = await fixture();
    const snapshot = await buildWorkspaceSyncSnapshot(f.db, { workspaceUuid, appVersion: '1.0.0' });
    accept(f);
    bind(f.db, f.workspaceId);
    f.db
      .prepare(
        'INSERT INTO workspace_sync_device (id, device_id, created_at, updated_at) VALUES (1, ?, 1, 1)'
      )
      .run('device-a');
    const job = enqueueWorkspaceSyncJob(f.db, {
      id: 'stale-file-only-capture',
      workspaceId: f.workspaceId,
      operation: 'upload',
      localHeadSha: f.head,
      baseRemoteVersionId: remoteVersion,
      nowMs: 2,
    });
    recordWorkspaceSyncUploadSnapshot(f.db, {
      jobId: job.id,
      snapshot,
      nowMs: 2,
    });
    const retained = f.db.prepare('SELECT * FROM workspace_sync_upload_snapshots').all();
    const before = authority(f.db, f.workspaceId);
    const createVersion = vi.fn();
    const snapshotWorkspace = vi.fn();
    const worker = new WorkspaceSyncUploadWorker(f.db, {
      deviceId: 'device-a',
      appVersion: '1.0.0',
      getActiveAccountId: () => 'account-a',
      getCurrentLocalHeadSha: () => f.head,
      snapshotWorkspace,
      client: { createVersion },
      nowMs: () => 3,
    });
    expect(await worker.runNext(job.id)).toMatchObject({
      status: 'failed',
      errorCode: 'SCIENTIFIC_CLOUD_TRANSFER_UNSUPPORTED',
    });
    expect(createVersion).not.toHaveBeenCalled();
    expect(snapshotWorkspace).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM workspace_sync_upload_snapshots').all()).toEqual(retained);
    expect(authority(f.db, f.workspaceId)).toBe(before);
  });
});
