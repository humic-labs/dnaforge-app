import { userMessage } from '@waypoint/user-messages';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rename as renameFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import type Database from 'better-sqlite3';
import {
  parseWorkspaceSyncManifest,
  decodeBundleFileContent,
  workspaceSyncBundleHashInput,
  workspaceSyncManifestHashInput,
  type WorkspaceSyncBundle,
  type WorkspaceSyncBundleV1,
  type WorkspaceSyncBundleV2,
  type WorkspaceSyncManifestV1,
} from '@waypoint/share-bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';

const workspaceSyncTestTimeoutMs = 35_000;
vi.setConfig({ testTimeout: workspaceSyncTestTimeoutMs });

const journalIoFault = vi.hoisted(() => ({
  failSqliteCommit: false,
  durabilityEvents: [] as string[],
}));

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

vi.mock('../database-recovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database-recovery')>();
  const { readFileSync: readFile } = await import('node:fs');
  return {
    ...actual,
    flushFileAndParentDirectoryRequired: (path: string): void => {
      if (path.includes('replica-pull-journal.json.next-')) {
        const phase = /"phase":\s*"([^"]+)"/.exec(readFile(path, 'utf8'))?.[1];
        if (phase) journalIoFault.durabilityEvents.push(`journal:${phase}`);
      }
      if (
        journalIoFault.failSqliteCommit &&
        path.includes('replica-pull-journal.json.next-') &&
        readFile(path, 'utf8').includes('"phase": "sqlite_committed"')
      ) {
        throw new Error('injected SQLite-commit journal flush failure');
      }
      actual.flushFileAndParentDirectoryRequired(path);
    },
  };
});

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
import {
  applyLatestToExistingManagedRepo,
  createWorkspaceSyncProjectsClient,
  flushFreshRestoreDurably,
  listWorkspaceSyncProjects,
  materializeDesktopSyncVersionBundle,
  materializeWorkspaceSyncBundleFiles,
  openWorkspaceSyncProject as openWorkspaceSyncProjectImpl,
  type OpenWorkspaceSyncProjectInput,
  reconcileInterruptedWorkspaceRestores,
  type WorkspaceSyncProjectsClient,
} from '../workspace-sync-projects';
import {
  commitAllIfDirty,
  hasWorkingChanges,
  resolveHeadCommit,
  resolveHeadCommitSync,
} from '../workspace-git';
import { materializeLimsGitReadableExportInDb } from '../lims-git-export';
import {
  reconstructFileBackedRegistryEntity,
  reconstructFileBackedRegistryRelationships,
} from '../file-backed-registry-mutation';
import { queryLimsEntitiesInDb } from '../lims';
import { initPlatform } from '../../platform';
import { sequencePackageEntityAdapter } from '../../db/entity-substrate/sequence-package-adapter';
import { reconcileEntitySnapshot } from '../../db/entity-substrate/adapter';
import { readWorkspaceSyncStatus } from '../workspace-sync-status';
import { workspaceSyncBlobPath } from '../workspace-sync-blob-cache';
import * as independentCopy from '../workspace-git/copy-independent-file';
import {
  readWorkspaceSyncReplicaFiles,
  recordWorkspaceSyncReplicaFiles,
} from '../workspace-sync-replica-files';
import {
  buildWorkspaceSyncSnapshot,
  previewWorkspaceSyncUpload,
} from '../workspace-sync-snapshotter';
import { WorkspaceSyncUploadWorker } from '../workspace-sync-upload-worker';
import type { WorkspaceSyncStoragePolicy } from '@waypoint/share-bundle';
import { hasWorkspaceSyncMutationLeaseForTest } from '../workspace-sync-mutation-lease';
import { reconcileInterruptedReplicaPulls } from '../workspace-sync-replica-journal';
import { readPendingWorkspaceSyncRendererRefresh } from '../workspace-sync-renderer-refresh-pending';
import { notifyRendererDatabaseStatementSettled } from '../workspace-sync-database-fence';
import { DesktopSyncClientError, type DesktopSyncClient } from '../desktop-sync-client';
import { readWorkspaceSyncCapturePolicy } from '../workspace-sync-storage-policy';
import {
  HOSTED_RESOURCE_BINDINGS_PATH,
  parseHostedResourceBindings,
} from '../../shared/hosted-resource-bindings';
import { createTestDb } from './test-db';
import { getDirtyState, setDirtyState } from '../dirty-state-cache';
import {
  configureWorkspaceSyncRestoreTelemetry,
  publishWorkspaceSyncRestoreTelemetry,
  type WorkspaceSyncRestoreTelemetryEvent,
} from '../workspace-sync-restore-telemetry';
import {
  buildNotebookPackageDocument,
  buildNotebookPackageMetadata,
  serializeNotebookPackageDocument,
  serializeNotebookPackageMetadata,
} from '../../db/notebook-package';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import {
  __resetWorkspaceSyncObservationForTests,
  bindWorkspaceSyncObservationSink,
  type WorkspaceSyncObservation,
} from '../workspace-sync-observation';

const REMOTE_WORKSPACE_ID = '8a4d99e9-2347-4d04-a447-d3070f7a7f9a';
const REMOTE_VERSION_ID = '54a53fed-2b63-44c8-a26e-b0fb7e1788d2';
const HOSTED_RESOURCE_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const RESTORE_STORAGE_POLICY: WorkspaceSyncStoragePolicy = {
  schemaVersion: 1,
  policyKey: 'restored-replica',
  revision: 7,
  maxFileBytes: 5 * 1024 ** 3,
  maxProjectBytes: 50 * 1024 ** 3,
  maxFiles: 2000,
  storageQuotaBytes: 100 * 1024 ** 3,
};

function openWorkspaceSyncProject(db: Database.Database, input: OpenWorkspaceSyncProjectInput) {
  return openWorkspaceSyncProjectImpl(db, {
    getActiveAccountId: () => 'account-a',
    ...input,
  });
}

describe('workspace sync list/open projects', () => {
  let db: Database.Database;
  let managedRoot: string;
  let client: WorkspaceSyncProjectsClient;
  let listWorkspaces: ReturnType<typeof vi.fn>;
  let downloadLatest: ReturnType<typeof vi.fn>;
  let previousMaxFileBytes: string | undefined;
  let syncObservations: WorkspaceSyncObservation[];

  beforeEach(() => {
    syncObservations = [];
    bindWorkspaceSyncObservationSink((observation) => syncObservations.push(observation));
    journalIoFault.failSqliteCommit = false;
    journalIoFault.durabilityEvents.length = 0;
    db = createTestDb();
    ensureSchema(db, ':memory:');
    managedRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-open-'));
    listWorkspaces = vi.fn(async () => [remoteSummary()]);
    downloadLatest = vi.fn(async () => latestResponse(validBundle()));
    client = { listWorkspaces, downloadLatest };
    previousMaxFileBytes = process.env.DNAFORGE_SYNC_MAX_FILE_BYTES;
  });

  afterEach(() => {
    __resetWorkspaceSyncObservationForTests();
    vi.mocked(app.getPath).mockReturnValue('/tmp');
    journalIoFault.failSqliteCommit = false;
    journalIoFault.durabilityEvents.length = 0;
    if (previousMaxFileBytes === undefined) {
      delete process.env.DNAFORGE_SYNC_MAX_FILE_BYTES;
    } else {
      process.env.DNAFORGE_SYNC_MAX_FILE_BYTES = previousMaxFileBytes;
    }
    rmSync(managedRoot, { recursive: true, force: true });
  });

  it('publishes accepted and restored receipts from the native restore transaction', async () => {
    const events = new Map<string, WorkspaceSyncRestoreTelemetryEvent>();
    const origin = {
      consentScope: randomUUID(),
      contextId: randomUUID(),
      processId: randomUUID(),
      classification: 'synthetic' as const,
    };
    configureWorkspaceSyncRestoreTelemetry({
      captureOrigin: () => origin,
      currentAccountId: () => 'account-a',
      publish: (read) => {
        const receipt = read();
        if (!receipt) return false;
        events.set(receipt.event.eventId, receipt);
        return true;
      },
    });
    try {
      const opened = await openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        createWorkspaceUuid: () => 'workspace-stage-receipts',
      });
      expect(opened).toMatchObject({ ok: true });
      const native = db
        .prepare('SELECT lock_id,started_at,completed_at,status FROM workspace_sync_restore_locks')
        .get() as { lock_id: string; started_at: number; completed_at: number; status: string };
      expect(native.status).toBe('completed');
      publishWorkspaceSyncRestoreTelemetry(db);
      publishWorkspaceSyncRestoreTelemetry(db);
      expect([...events.values()].map((value) => value.event.properties.sync_stage)).toEqual([
        'accepted',
        'restored',
      ]);
      expect([...events.values()].map((value) => value.event.createdAtMs)).toEqual([
        native.started_at,
        native.completed_at,
      ]);
      for (const value of events.values()) {
        expect(value.origin).toEqual(origin);
        expect(value.event.referenceId).toBe(native.lock_id);
        expect(value.event.properties).toMatchObject({
          sync_operation: 'restore',
          operation_id: native.lock_id,
          origin_started_at_ms: native.started_at,
        });
      }
      expect(JSON.stringify([...events.values()])).not.toContain(managedRoot);
      expect(JSON.stringify([...events.values()])).not.toContain(REMOTE_VERSION_ID);
      expect(JSON.stringify([...events.values()])).not.toContain('account-a');
    } finally {
      configureWorkspaceSyncRestoreTelemetry(null);
    }
  });

  it('lists remote desktop-sync projects as renderer-safe summaries', async () => {
    await expect(listWorkspaceSyncProjects(client)).resolves.toEqual([
      {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        displayName: 'Project A',
        ownerAccountId: 'account-a',
        ownerOrgId: null,
        ownerDisplayName: 'Personal',
        accessRole: 'owner',
        accessSource: 'owner',
        accessOrgId: null,
        latestVersionId: REMOTE_VERSION_ID,
        latestVersionNumber: 3,
        updatedAt: Date.parse('2026-07-08T00:00:00.000Z'),
      },
    ]);

    expect(listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('retains the trusted policy when restoring a replica before its first offline capture', async () => {
    const policy = RESTORE_STORAGE_POLICY;
    const readStoragePolicy = vi.fn(async () => policy);
    Object.assign(client, { readStoragePolicy });
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        createWorkspaceUuid: () => 'workspace-a',
      })
    ).resolves.toMatchObject({ ok: true, workspaceUuid: 'workspace-a' });
    expect(readStoragePolicy).toHaveBeenCalledWith(REMOTE_WORKSPACE_ID, 'account-a');
    const readOffline = vi.fn(async () => {
      throw new DesktopSyncClientError('NETWORK', 'Offline', { retryable: true, terminal: false });
    });
    await expect(
      readWorkspaceSyncCapturePolicy(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        expectedAccountId: 'account-a',
        readPolicy: readOffline,
      })
    ).resolves.toEqual(policy);
    expect(readOffline).toHaveBeenCalledOnce();
    expect(await hasWorkingChanges(join(managedRoot, 'workspace-a', 'repo'))).toBe(false);
  });

  it('refuses a revoked restore and removes its cached capture allowance before installing files', async () => {
    const policy = RESTORE_STORAGE_POLICY;
    await readWorkspaceSyncCapturePolicy(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      expectedAccountId: 'account-a',
      readPolicy: async () => policy,
    });
    Object.assign(client, {
      readStoragePolicy: async () => {
        throw new DesktopSyncClientError('SESSION_REVOKED', 'Session revoked', {
          retryable: false,
          terminal: true,
        });
      },
    });
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        createWorkspaceUuid: () => 'workspace-a',
      })
    ).resolves.toMatchObject({ ok: false, message: 'Session revoked' });
    expect(syncObservations).toEqual([
      {
        feature_area: 'workspace',
        sync_operation: 'restore',
        sync_outcome: 'failed',
        error_code: 'session_revoked',
        duration_ms: expect.any(Number),
      },
    ]);
    expect(downloadLatest).not.toHaveBeenCalled();
    expect(existsSync(join(managedRoot, 'workspace-a', 'repo'))).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM workspace_sync_bindings').get()).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM settings WHERE key LIKE 'workspace_sync_storage_policy:%'"
        )
        .get()
    ).toEqual({ n: 0 });
  });

  it('opens a fresh synced project by materializing the latest bundle into a managed repo', async () => {
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    expect(existsSync(join(repoPath, '.git'))).toBe(true);
    expect(existsSync(join(repoPath, 'designs', 'pUC19.gb'))).toBe(false);
    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain('LOCUS');
    expect(
      JSON.parse(readFileSync(join(repoPath, 'designs', 'pUC19', '.forge', 'plasmid.json'), 'utf8'))
    ).toMatchObject({
      schema: 'waypoint.sequence.v1',
      kind: 'sequence',
      product: { file: 'pUC19.gb' },
    });
    expect(readFileSync(join(repoPath, '.dnaforge-workspace.json'), 'utf8')).toContain(
      REMOTE_WORKSPACE_ID
    );
    expect(readFileSync(join(repoPath, 'Lab notes', 'assets', 'model.bin'))).toEqual(
      Buffer.from([0xff, 0x00, 0x80])
    );

    expect(workspaceRow(db)).toMatchObject({
      name: 'Project A',
      path: repoPath,
      repo_uuid: 'workspace-a',
      origin_path: null,
      last_opened_at: 1000,
    });
    expect(bindingRow(db)).toMatchObject({
      workspace_uuid: 'workspace-a',
      owner_account_id: 'account-a',
      owner_org_id: null,
      remote_workspace_id: REMOTE_WORKSPACE_ID,
      enabled: 1,
      remote_latest_version_id: REMOTE_VERSION_ID,
      remote_latest_version_number: 3,
      last_downloaded_at: 1000,
    });
    expect(latestVersionRow(db)).toMatchObject({
      remote_version_id: REMOTE_VERSION_ID,
      version_number: 3,
      status: 'ready',
      is_latest: 1,
    });
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      source_remote_version_id: REMOTE_VERSION_ID,
      status: 'completed',
      started_at: 1000,
      expires_at: 601000,
      completed_at: 1000,
    });
    expect(syncObservations).toEqual([
      expect.objectContaining({
        feature_area: 'workspace',
        sync_operation: 'restore',
        sync_outcome: 'restored',
        duration_ms: 0,
        is_shared: false,
        file_count_bucket: expect.any(String),
        size_bucket: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(syncObservations)).not.toMatch(/Project A|workspace-a|pUC19/);
  });

  it.each([false, true])(
    'records the current native clock after the restore durability boundary fails=%s',
    async (fail) => {
      let clock = 1000;
      await expect(
        openWorkspaceSyncProject(db, {
          remoteWorkspaceId: REMOTE_WORKSPACE_ID,
          managedRootDir: managedRoot,
          client,
          nowMs: () => clock,
          createRestoreLockId: () => 'causal-restore-clock',
          durability: {
            flushFile: async () => undefined,
            flushDirectory: async () => undefined,
            flushGitCommit: async () => {
              expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
                lock_id: 'causal-restore-clock',
                owner_account_id: 'account-a',
                source_remote_version_id: REMOTE_VERSION_ID,
                status: 'restoring',
                started_at: 1000,
                completed_at: null,
              });
              expect(bindingRowByUuid(db, 'workspace-a')).toBeUndefined();
              clock = 5000;
              if (fail) throw new Error('causal durability failure');
            },
          },
        })
      ).resolves.toMatchObject({ ok: !fail });
      expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
        lock_id: 'causal-restore-clock',
        owner_account_id: 'account-a',
        source_remote_version_id: REMOTE_VERSION_ID,
        status: fail ? 'failed' : 'completed',
        started_at: 1000,
        completed_at: 5000,
      });
      if (fail) expect(bindingRowByUuid(db, 'workspace-a')).toBeUndefined();
      else {
        expect(bindingRow(db).remote_latest_version_id).toBe(REMOTE_VERSION_ID);
        expect(latestVersionRow(db).remote_version_id).toBe(REMOTE_VERSION_ID);
      }
    }
  );

  it('still opens a historical v1 sync bundle', async () => {
    const bundle = validBundleV1();
    listWorkspaces.mockResolvedValueOnce([remoteSummary(bundle)]);
    downloadLatest.mockResolvedValueOnce(latestResponse(bundle));

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1025,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    expect(existsSync(join(managedRoot, 'workspace-a', 'repo', 'Lab notes.wpnote.json'))).toBe(
      true
    );
  });

  it('keeps restore acknowledgement current when Registry projections are reconciled on mount', async () => {
    const manifest = hostedManifest();
    listWorkspaces.mockResolvedValueOnce([hostedRemoteSummary(manifest)]);
    downloadLatest.mockRejectedValueOnce(manifestRestoreRequired());
    client = {
      listWorkspaces,
      downloadLatest,
      downloadManifestVersion: async () => hostedManifestLatest(manifest),
      downloadManifestFile: async () => new Response(hostedSequenceBytes()),
    };
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const acknowledgedHead = bindingRow(db).last_acked_local_head_sha;
    expect(await resolveHeadCommit(repoPath)).toBe(acknowledgedHead);

    materializeLimsGitReadableExportInDb(db, { workspaceRoot: repoPath });
    expect(await commitAllIfDirty(repoPath, 'reconcile: capture Registry projections')).toBeNull();
    expect(await resolveHeadCommit(repoPath)).toBe(acknowledgedHead);

    const sequencePath = join(repoPath, 'sequences', 'pUC19.gb');
    writeFileSync(
      sequencePath,
      `${readFileSync(sequencePath, 'utf8')}\nCOMMENT     Unacknowledged local sequence edit\n`
    );
    expect(await commitAllIfDirty(repoPath, 'Edit restored sequence')).not.toBeNull();
    expect(
      readWorkspaceSyncStatus(db, {
        workspaceUuid: 'workspace-a',
        getActiveAccountId: () => 'account-a',
        getCurrentLocalHeadSha: (workspace) => resolveHeadCommitSync(workspace.path),
      }).blockers
    ).toContain('local_head_mismatch');
  });

  it.each([false, true])(
    'keeps the restore acknowledgement current after managed-package reconstruction with received Registry exports=%s',
    async (includeLegacyExports) => {
      const sourceDb = createTestDb();
      ensureSchema(sourceDb, ':memory:');
      const sourceManagedRoot = join(managedRoot, 'source-profile');
      mkdirSync(sourceManagedRoot);
      let incoming: WorkspaceSyncBundle;
      const legacyFiles = new Map<string, Uint8Array>();
      try {
        const sourceClient = {
          listWorkspaces: async () => [remoteSummary()],
          downloadLatest: async () => latestResponse(validBundle()),
        };
        await expect(
          openWorkspaceSyncProject(sourceDb, {
            remoteWorkspaceId: REMOTE_WORKSPACE_ID,
            managedRootDir: sourceManagedRoot,
            client: sourceClient,
            nowMs: () => 1000,
          })
        ).resolves.toMatchObject({ ok: true, workspaceUuid: 'workspace-a' });
        await reconstructManagedSequenceRegistry(
          sourceDb,
          join(sourceManagedRoot, 'workspace-a', 'repo')
        );
        if (includeLegacyExports) {
          const sourceRepo = join(sourceManagedRoot, 'workspace-a', 'repo');
          const exported = materializeLimsGitReadableExportInDb(sourceDb, {
            workspaceRoot: sourceRepo,
          });
          for (const path of [
            join(sourceRepo, '.waypoint', 'lims', 'manifest.json'),
            exported.oligosCsvPath,
            ...exported.logFiles,
          ]) {
            legacyFiles.set(relative(sourceRepo, path).split(sep).join('/'), readFileSync(path));
          }
        }
        const snapshot = await buildWorkspaceSyncSnapshot(sourceDb, {
          workspaceUuid: 'workspace-a',
          appVersion: '0.4.0',
          capturedAt: new Date('2026-07-09T00:00:00.000Z'),
        });
        incoming = {
          ...snapshot.bundle,
          files: snapshot.bundle.files.filter(
            (file) => includeLegacyExports || !file.relativePath.startsWith('.waypoint/lims/')
          ),
          provenance: { ...snapshot.bundle.provenance, contentSha256: '0'.repeat(64) },
        };
        incoming.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(incoming));
      } finally {
        sourceDb.close();
      }
      const parsedManifest = parseWorkspaceSyncManifest({
        schemaVersion: 1,
        files: [
          ...incoming.files.map((file) => ({
            path: file.relativePath,
            contentSha256: file.sha256,
            sizeBytes: file.sizeBytes,
            contentType: file.contentType,
          })),
          ...[...legacyFiles].map(([path, content]) => ({
            path,
            contentSha256: createHash('sha256').update(content).digest('hex'),
            sizeBytes: content.byteLength,
            contentType: 'application/octet-stream',
          })),
        ],
      });
      if (!parsedManifest.ok) throw new Error(parsedManifest.errors.join('; '));
      const manifest = parsedManifest.manifest;
      const files = new Map([
        ...incoming.files.map((file): [string, Uint8Array] => [
          file.relativePath,
          Uint8Array.from(decodeBundleFileContent(file)),
        ]),
        ...legacyFiles,
      ]);
      listWorkspaces.mockResolvedValueOnce([hostedRemoteSummary(manifest)]);
      downloadLatest.mockRejectedValueOnce(manifestRestoreRequired());
      client = {
        listWorkspaces,
        downloadLatest,
        downloadManifestVersion: async () => ({
          ...hostedManifestLatest(manifest),
          resourceIdentities: manifest.files.map((file) => ({
            path: file.path,
            resourceId: randomUUID(),
          })),
        }),
        downloadManifestFile: async (_workspaceId, _versionId, file) => {
          const content = files.get(file.path);
          if (!content) throw new Error('The captured managed-project file is missing.');
          return new Response(content);
        },
      };
      const opened = await openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2000,
      });
      expect(opened, JSON.stringify(opened)).toMatchObject({
        ok: true,
        workspaceUuid: 'workspace-a',
      });
      const repoPath = join(managedRoot, 'workspace-a', 'repo');
      const acknowledgedHead = bindingRow(db).last_acked_local_head_sha;

      expect((await reconstructManagedSequenceRegistry(db, repoPath)).outcome).toBe('created');
      const auditCount = db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get();
      expect((await reconstructManagedSequenceRegistry(db, repoPath)).outcome).toBe('in-sync');
      expect(db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get()).toEqual(auditCount);
      for (const [path, bytes] of files) {
        expect(readFileSync(join(repoPath, path)), path).toEqual(Buffer.from(bytes));
      }
      expect([...files.keys()].some((path) => path.startsWith('.waypoint/lims/'))).toBe(
        includeLegacyExports
      );
      expect(
        await commitAllIfDirty(repoPath, 'reconcile: capture Registry projections')
      ).toBeNull();
      expect(await resolveHeadCommit(repoPath)).toBe(acknowledgedHead);
      expect(bindingRow(db).last_acked_local_head_sha).toBe(acknowledgedHead);
    }
  );

  it('keeps generated Registry projections outside received replica-file authority', async () => {
    const manifest = hostedManifest();
    listWorkspaces.mockResolvedValueOnce([hostedRemoteSummary(manifest)]);
    downloadLatest.mockRejectedValueOnce(manifestRestoreRequired());
    client = {
      listWorkspaces,
      downloadLatest,
      downloadManifestVersion: async () => hostedManifestLatest(manifest),
      downloadManifestFile: async () => new Response(hostedSequenceBytes()),
    };
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });
    expect(
      existsSync(join(managedRoot, 'workspace-a', 'repo', '.waypoint', 'lims', 'manifest.json'))
    ).toBe(true);
    const receivedPaths = readWorkspaceSyncReplicaFiles(db, {
      workspaceUuid: 'workspace-a',
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      remoteVersionId: REMOTE_VERSION_ID,
    });
    expect(receivedPaths).toEqual(expect.arrayContaining(['sequences/pUC19.gb']));
    expect(receivedPaths).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.waypoint\/lims\//u)])
    );
  });

  it('opens a manifest-backed project by streaming verified files into the managed restore', async () => {
    const manifest = hostedManifest();
    const latest = hostedManifestLatest(manifest);
    listWorkspaces.mockResolvedValueOnce([hostedRemoteSummary(manifest)]);
    downloadLatest.mockRejectedValueOnce(manifestRestoreRequired());
    const downloadManifestVersion = vi.fn(async () => latest);
    const downloadManifestFile = vi.fn(async (_workspaceId, _versionId, file) => {
      expect(file.path).toBe('sequences/pUC19.gb');
      return new Response(hostedSequenceBytes());
    });
    client = { listWorkspaces, downloadLatest, downloadManifestVersion, downloadManifestFile };

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1100,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    expect(existsSync(join(repoPath, '.git'))).toBe(true);
    expect(readFileSync(join(repoPath, 'sequences', 'pUC19.gb'), 'utf8')).toBe(
      hostedSequenceBytes()
    );
    expect(existsSync(join(repoPath, 'sequences', 'pUC19', 'pUC19.gb'))).toBe(false);
    expect(
      parseHostedResourceBindings(
        readFileSync(join(repoPath, HOSTED_RESOURCE_BINDINGS_PATH), 'utf8')
      )
    ).toMatchObject({
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      remoteVersionId: REMOTE_VERSION_ID,
      resources: [
        {
          resourceId: HOSTED_RESOURCE_ID,
          path: 'sequences/pUC19.gb',
          contentSha256: sha256Hex(hostedSequenceBytes()),
        },
      ],
    });
    expect(bindingRow(db)).toMatchObject({
      workspace_uuid: 'workspace-a',
      remote_workspace_id: REMOTE_WORKSPACE_ID,
      remote_latest_version_id: REMOTE_VERSION_ID,
      remote_latest_version_number: 3,
    });
    expect(downloadManifestVersion).toHaveBeenCalledWith(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID);
    expect(downloadManifestFile).toHaveBeenCalledOnce();
  });

  it.each(['complete', 'interrupted'])(
    'records a restore intent before the real projects client downloads manifest files (%s)',
    async (transfer) => {
      const manifest = hostedManifest();
      const latest = hostedManifestLatest(manifest);
      const requestJson = vi.fn(async (path: string) => {
        if (path === '/api/desktop-sync/workspaces?format=paged-v1&limit=200') {
          return {
            format: 'paged-v1',
            workspaces: [hostedRemoteSummary(manifest)],
            hasMore: false,
            nextCursor: null,
          };
        }
        if (path.endsWith('/storage-policy')) return RESTORE_STORAGE_POLICY;
        if (path.endsWith('/latest')) throw manifestRestoreRequired();
        if (path.endsWith('/latest/manifest')) return latest;
        throw new Error(`Unexpected projects request: ${path}`);
      });
      let interruptNextDownload = transfer === 'interrupted';
      const requestStream = vi.fn(async () => {
        expect(restoreLockRow(db, 'workspace-a')).toMatchObject({ status: 'restoring' });
        if (interruptNextDownload) {
          interruptNextDownload = false;
          throw new Error('File transfer interrupted.');
        }
        return new Response(hostedSequenceBytes());
      });
      const realClient = createWorkspaceSyncProjectsClient({
        requestJson,
        requestStream,
        getAccountId: async () => 'account-a',
      } as DesktopSyncClient);

      const restore = () =>
        openWorkspaceSyncProject(db, {
          remoteWorkspaceId: REMOTE_WORKSPACE_ID,
          managedRootDir: managedRoot,
          client: realClient,
          nowMs: () => 1100,
        });
      if (transfer === 'interrupted') {
        await expect(restore()).resolves.toMatchObject({
          ok: false,
          message: 'File transfer interrupted.',
        });
        expect(restoreLockRow(db, 'workspace-a')).toMatchObject({ status: 'failed' });
        expect(bindingRowByUuid(db, 'workspace-a')).toBeUndefined();
      }
      await expect(restore()).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

      const repoPath = join(managedRoot, 'workspace-a', 'repo');
      expect(readFileSync(join(repoPath, 'sequences/pUC19.gb'), 'utf8')).toBe(
        hostedSequenceBytes()
      );
      expect(
        parseHostedResourceBindings(
          readFileSync(join(repoPath, HOSTED_RESOURCE_BINDINGS_PATH), 'utf8')
        )
      ).toMatchObject({
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        remoteVersionId: REMOTE_VERSION_ID,
        resources: [
          expect.objectContaining({ resourceId: HOSTED_RESOURCE_ID, path: 'sequences/pUC19.gb' }),
        ],
      });
      expect(requestStream).toHaveBeenCalledTimes(transfer === 'interrupted' ? 2 : 1);
    }
  );

  it.each([
    ['UTF-8', 'Project notes\nα-factor\n'],
    ['UTF-8 with BOM', '\uFEFFProject notes\nα-factor\n'],
  ])(
    'materializes private manifest notes and images without changing their bytes: %s',
    async (_encoding, notesText) => {
      const notes = Buffer.from(notesText, 'utf8');
      const image = readFileSync(join(__dirname, '../../../../../test-fixtures/images/sample.png'));
      const contents = new Map([
        ['sequences/pUC19.gb', Buffer.from(hostedSequenceBytes(), 'utf8')],
        ['notes.txt', notes],
        ['preview.png', image],
      ]);
      const manifest = hostedManifest();
      manifest.files.push(
        ...[
          { path: 'notes.txt', bytes: notes, contentType: 'text/plain' },
          { path: 'preview.png', bytes: image, contentType: 'image/png' },
        ].map(({ path, bytes, contentType }) => ({
          path,
          sizeBytes: bytes.byteLength,
          contentSha256: createHash('sha256').update(bytes).digest('hex'),
          contentType,
        }))
      );
      const bundle = await materializeDesktopSyncVersionBundle({
        remote: hostedRemoteSummary(manifest),
        latest: hostedManifestLatest(manifest),
        downloadManifestFile: vi.fn(
          async (_workspace, _version, file) => new Response(contents.get(file.path)!)
        ),
      });
      expect(bundle.files.find((file) => file.relativePath === 'notes.txt')).toMatchObject({
        kind: 'workspace-resource',
        contentType: 'text/plain',
        encoding: 'blob',
        content: '',
      });
      expect(bundle.files.find((file) => file.relativePath === 'preview.png')).toMatchObject({
        kind: 'workspace-resource',
        contentType: 'image/png',
        encoding: 'blob',
      });
      const destination = mkdtempSync(join(tmpdir(), 'dnaforge-mixed-manifest-'));
      try {
        await materializeWorkspaceSyncBundleFiles(destination, bundle);
        for (const [path, bytes] of contents)
          expect(readFileSync(join(destination, path))).toEqual(bytes);
      } finally {
        rmSync(destination, { recursive: true, force: true });
      }
    }
  );

  it('materializes manifest files through the bounded response stream', async () => {
    const manifest = hostedManifest();
    const latest = hostedManifestLatest(manifest);
    const remote = hostedRemoteSummary(manifest);
    const response = new Response(hostedSequenceBytes(), {
      headers: { 'content-type': 'application/genbank' },
    });
    Object.defineProperty(response, 'arrayBuffer', {
      value: () => {
        throw new Error('manifest materialization must not call Response.arrayBuffer().');
      },
    });

    await expect(
      materializeDesktopSyncVersionBundle({
        remote,
        latest,
        downloadManifestFile: vi.fn(async () => response),
      })
    ).resolves.toMatchObject({
      schemaVersion: 3,
      files: [
        {
          relativePath: 'sequences/pUC19.gb',
          content: '',
          encoding: 'blob',
          sizeBytes: Buffer.byteLength(hostedSequenceBytes(), 'utf8'),
          sha256: sha256Hex(hostedSequenceBytes()),
        },
      ],
    });
  });

  it('refuses to commit a manifest restore when streamed bytes do not match the accepted digest', async () => {
    const manifest = hostedManifest();
    listWorkspaces.mockResolvedValueOnce([hostedRemoteSummary(manifest)]);
    downloadLatest.mockRejectedValueOnce(manifestRestoreRequired());
    client = {
      listWorkspaces,
      downloadLatest,
      downloadManifestVersion: vi.fn(async () => hostedManifestLatest(manifest)),
      downloadManifestFile: vi.fn(async () => new Response('tampered-bytes')),
    };

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1110,
        createRestoreLockId: () => 'lock-manifest-mismatch',
      })
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('integrity verification'),
    });

    expect(bindingRowByUuid(db, 'workspace-a')).toBeUndefined();
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      lock_id: 'lock-manifest-mismatch',
      status: 'failed',
      completed_at: 1110,
    });
  });

  it('does not invent a local restore when this DNAForge build cannot read manifests', async () => {
    listWorkspaces.mockResolvedValueOnce([hostedRemoteSummary()]);
    downloadLatest.mockRejectedValueOnce(manifestRestoreRequired());
    client = { listWorkspaces, downloadLatest };

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1120,
      })
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('cannot restore manifest-backed projects'),
    });
    expect(existsSync(join(managedRoot, 'workspace-a'))).toBe(false);
  });

  it('waits for an open database transaction before planning filesystem work', async () => {
    db.exec('BEGIN');
    const opening = openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1050,
    });

    await Promise.resolve();
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(readdirSync(managedRoot)).toEqual([]);

    db.exec('ROLLBACK');
    notifyRendererDatabaseStatementSettled(db);
    await expect(opening).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });
  });

  it('serializes duplicate opens so only one restore writer and finalizer can run', async () => {
    let releaseDownload!: (value: ReturnType<typeof latestResponse>) => void;
    downloadLatest.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof latestResponse>>((resolveDownload) => {
          releaseDownload = resolveDownload;
        })
    );

    const first = openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1100,
    });
    await vi.waitFor(() => expect(downloadLatest).toHaveBeenCalledOnce());
    const second = openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1200,
    });

    await Promise.resolve();
    expect(listWorkspaces).toHaveBeenCalledOnce();
    releaseDownload(latestResponse(validBundle()));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, workspaceUuid: 'workspace-a' },
      { ok: true, workspaceUuid: 'workspace-a' },
    ]);
    expect(downloadLatest).toHaveBeenCalledOnce();
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE repo_uuid = 'workspace-a'`).get()
    ).toEqual({ count: 1 });
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({ status: 'completed' });
  });

  it('scavenges a completed restore recovery copy on the next existing-project open', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1250,
      createRestoreLockId: () => 'lock-completed-recovery',
    });
    const workspacePath = join(managedRoot, 'workspace-a');
    const recoveryPath = `${workspacePath}.restore-recovery-lock-completed-recovery`;
    cpSync(workspacePath, recoveryPath, { recursive: true });
    expect(existsSync(recoveryPath)).toBe(true);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1260,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    expect(existsSync(recoveryPath)).toBe(false);
    expect(downloadLatest).toHaveBeenCalledOnce();
  });

  it('keeps a restore hidden and retryable when its filesystem durability barrier fails', async () => {
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1300,
        createRestoreLockId: () => 'lock-durability-failure',
        durability: {
          flushFile: async () => undefined,
          flushDirectory: async () => undefined,
          flushGitCommit: async () => {
            throw new Error('injected restore durability failure');
          },
        },
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'injected restore durability failure',
    });

    expect(bindingRowByUuid(db, 'workspace-a')).toBeUndefined();
    expect(workspaceRowByUuid(db, 'workspace-a')).toMatchObject({ archived_at: 1300 });
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      status: 'failed',
      error_message: 'injected restore durability failure',
    });

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1400,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });
    expect(bindingRowByUuid(db, 'workspace-a')).toMatchObject({
      remote_workspace_id: REMOTE_WORKSPACE_ID,
    });
    expect(workspaceRowByUuid(db, 'workspace-a')).toMatchObject({ archived_at: null });
  });

  it('flushes fresh-restore directory chains once for 2,000 files in one directory', async () => {
    const managedRootRealPath = realpathSync(managedRoot);
    const workspacePath = join(managedRootRealPath, 'durability-scale');
    const repoPath = join(workspacePath, 'repo');
    const filesRoot = join(repoPath, 'designs');
    mkdirSync(filesRoot, { recursive: true });
    const operationPaths = Array.from({ length: 2000 }, (_, index) => {
      const relativePath = `designs/design-${index}.wpdesign.json`;
      writeFileSync(join(repoPath, relativePath), `{"index":${index}}\n`, 'utf8');
      return relativePath;
    });
    const fileBarriers: string[] = [];
    const directoryBarriers: string[] = [];
    const gitBarriers: string[] = [];

    await flushFreshRestoreDurably({
      durability: {
        flushFile: async (path) => {
          fileBarriers.push(path);
        },
        flushDirectory: async (path) => {
          directoryBarriers.push(path);
        },
        flushGitCommit: async (path) => {
          gitBarriers.push(path);
        },
      },
      managedRootRealPath,
      workspacePath,
      repoPath,
      localHeadSha: 'a'.repeat(40),
      operationPaths,
    });

    expect(fileBarriers).toHaveLength(2000);
    expect(gitBarriers).toEqual([repoPath]);
    expect(directoryBarriers).toEqual([filesRoot, repoPath, workspacePath, managedRootRealPath]);
  });

  it('rejects a fresh restore when the bundle provenance hash does not match its bytes', async () => {
    const tamperedBundle = validBundle();
    tamperedBundle.provenance.contentSha256 = 'f'.repeat(64);
    downloadLatest.mockResolvedValueOnce(latestResponse(tamperedBundle));

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      })
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('hash'),
    });

    expect(existsSync(join(managedRoot, 'workspace-a'))).toBe(false);
  });

  it('applies a newer remote bundle over files in an existing clean managed repo', async () => {
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const excludedLocalPath = join(repoPath, 'sample.fastq');
    const excludedLocalContent = '@read\nACGT\n+\n!!!!\n';
    writeFileSync(excludedLocalPath, excludedLocalContent, 'utf8');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare clean replica pull fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = ?
       WHERE workspace_id = 1`
    ).run(previousHead);
    db.prepare(
      `UPDATE workspace_sync_versions
       SET local_head_sha = ?
       WHERE workspace_id = 1 AND is_latest = 1`
    ).run(previousHead);
    const marker = 'REMOTE_REPLICA_PULL_APPLIED';
    const newerBundle = withUpdatedGenBank(snapshot.bundle, marker);
    const newerVersionId = 'f4737ab5-af63-48ec-9db5-fc0f51c56d4b';

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: {
          ...remoteSummary(),
          latest: {
            versionId: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        latest: {
          ...latestResponse(newerBundle),
          version: {
            ...latestResponse(newerBundle).version,
            id: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
      })
    ).resolves.toBeUndefined();

    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain(marker);
    expect(readFileSync(excludedLocalPath, 'utf8')).toBe(excludedLocalContent);
    expect(await resolveHeadCommit(repoPath)).not.toBe(previousHead);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(bindingRow(db)).toMatchObject({
      remote_latest_version_id: newerVersionId,
      remote_latest_version_number: 4,
      remote_latest_content_sha256: newerBundle.provenance.contentSha256,
      last_downloaded_at: 2000,
    });
    expect(latestVersionRow(db)).toMatchObject({
      remote_version_id: newerVersionId,
      version_number: 4,
      status: 'ready',
      is_latest: 1,
    });
  });

  describe('cold cache manifest return', () => {
    async function prepareColdCacheReturnFixture() {
      vi.mocked(app.getPath).mockReturnValue(join(managedRoot, 'user-data'));
      await openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      });
      const repoPath = join(managedRoot, 'workspace-a', 'repo');
      const assetPath = 'Lab notes/assets/model.bin';
      const originalBytes = Buffer.alloc(2 * 1024 * 1024, 0x81);
      writeFileSync(join(repoPath, assetPath), originalBytes);
      const snapshot = await buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-a',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-10-06T00:00:00.000Z'),
      });
      const previousHead =
        (await commitAllIfDirty(repoPath, 'Prepare cold-cache owner return')) ??
        (await resolveHeadCommit(repoPath));
      db.prepare(
        `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
      ).run(previousHead);
      const contents = new Map(
        snapshot.bundle.files.map((file) => [
          file.relativePath,
          readFileSync(join(repoPath, file.relativePath)),
        ])
      );
      return { repoPath, assetPath, originalBytes, snapshot, previousHead, contents };
    }

    let fixture: Awaited<ReturnType<typeof prepareColdCacheReturnFixture>>;

    beforeEach(async () => {
      fixture = await prepareColdCacheReturnFixture();
    }, workspaceSyncTestTimeoutMs);

    it.each(['unchanged', 'different bytes', 'unaccepted path', 'concurrent write'] as const)(
      'handles %s attachments during a cold cache manifest return',
      async (scenario) => {
        const { repoPath, assetPath, originalBytes, snapshot, previousHead, contents } = fixture;
        const expectedAssetBytes =
          scenario === 'different bytes' ? Buffer.alloc(originalBytes.length, 0x82) : originalBytes;
        contents.set(assetPath, expectedAssetBytes);
        const sequencePath = 'designs/pUC19/pUC19.gb';
        contents.set(
          sequencePath,
          Buffer.from(
            `${contents.get(sequencePath)!.toString('utf8')}\nCOMMENT     COLD_CACHE_RETURN\n`
          )
        );
        const parsed = parseWorkspaceSyncManifest({
          schemaVersion: 1,
          files: snapshot.bundle.files.map((file) => ({
            path: file.relativePath,
            contentSha256: createHash('sha256')
              .update(contents.get(file.relativePath)!)
              .digest('hex'),
            sizeBytes: contents.get(file.relativePath)!.length,
            contentType: file.contentType,
          })),
        });
        if (!parsed.ok) throw new Error(parsed.errors.join('; '));
        rmSync(join(managedRoot, 'user-data', 'workspace-sync', 'blobs'), {
          recursive: true,
          force: true,
        });
        if (scenario === 'unaccepted path') {
          const identity = {
            workspaceUuid: 'workspace-a',
            remoteWorkspaceId: REMOTE_WORKSPACE_ID,
            remoteVersionId: REMOTE_VERSION_ID,
          };
          recordWorkspaceSyncReplicaFiles(db, {
            ...identity,
            paths: readWorkspaceSyncReplicaFiles(db, identity)!.filter(
              (path) => path !== assetPath
            ),
            nowMs: 1000,
          });
        }
        const newerVersionId = '7979fccb-b776-413d-9452-0c1c9f7e026b';
        const latest = hostedManifestLatest(parsed.manifest);
        latest.version.id = newerVersionId;
        latest.version.versionNumber = 4;
        const remote = hostedRemoteSummary(parsed.manifest);
        remote.latest.versionId = newerVersionId;
        remote.latest.versionNumber = 4;
        const downloadManifestFile = vi.fn(
          async (_workspace: string, _version: string, file: { path: string }) => {
            if (
              file.path === assetPath &&
              (scenario === 'unchanged' || scenario === 'concurrent write')
            ) {
              throw Object.assign(
                new Error('Unchanged attachment required a duplicate allocation'),
                {
                  code: 'ENOSPC',
                }
              );
            }
            return new Response(new Uint8Array(contents.get(file.path)!));
          }
        );
        const onReplicaApplied = vi.fn(async () => undefined);
        let concurrentBytes: Buffer | undefined;
        const copy = independentCopy.copyStableFileSync;
        const copySpy =
          scenario === 'concurrent write'
            ? vi
                .spyOn(independentCopy, 'copyStableFileSync')
                .mockImplementation((source, destination) => {
                  copy(source, destination);
                  if (source === join(realpathSync(repoPath), assetPath)) {
                    concurrentBytes = Buffer.alloc(originalBytes.length, 0x83);
                    writeFileSync(source, concurrentBytes);
                  }
                })
            : undefined;
        const apply = applyLatestToExistingManagedRepo(db, {
          workspaceId: 1,
          workspaceUuid: 'workspace-a',
          repoPath,
          remote,
          latest,
          downloadManifestFile,
          expectedLocalHeadSha: previousHead!,
          expectedRemoteVersionId: REMOTE_VERSION_ID,
          nowMs: 2000,
          onReplicaApplied,
        });
        try {
          if (scenario === 'concurrent write' || scenario === 'unaccepted path') {
            await expect(apply).rejects.toThrow(
              scenario === 'concurrent write'
                ? 'file changed during capture'
                : /excluded|local file|outside|conflict/i
            );
            expect(
              readFileSync(join(repoPath, assetPath)).equals(concurrentBytes ?? originalBytes)
            ).toBe(true);
            expect(readFileSync(join(repoPath, sequencePath), 'utf8')).not.toContain(
              'COLD_CACHE_RETURN'
            );
            expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
            expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
            expect(onReplicaApplied).not.toHaveBeenCalled();
            if (scenario === 'unaccepted path') {
              expect(downloadManifestFile.mock.calls.map((call) => call[2].path)).toContain(
                assetPath
              );
            }
            return;
          }
          await apply;
        } finally {
          copySpy?.mockRestore();
        }
        if (scenario === 'unchanged') {
          expect(downloadManifestFile.mock.calls.map((call) => call[2].path)).not.toContain(
            assetPath
          );
        } else {
          expect(downloadManifestFile.mock.calls.map((call) => call[2].path)).toContain(assetPath);
        }
        const asset = parsed.manifest.files.find((file) => file.path === assetPath)!;
        const cachedPath = await workspaceSyncBlobPath(asset.contentSha256);
        expect(readFileSync(cachedPath).equals(expectedAssetBytes)).toBe(true);
        expect(statSync(cachedPath).size).toBe(asset.sizeBytes);
        expect(createHash('sha256').update(readFileSync(cachedPath)).digest('hex')).toBe(
          asset.contentSha256
        );
        expect(statSync(cachedPath).ino).not.toBe(statSync(join(repoPath, assetPath)).ino);
        expect(readFileSync(join(repoPath, assetPath)).equals(expectedAssetBytes)).toBe(true);
        expect(readFileSync(join(repoPath, sequencePath), 'utf8')).toContain('COLD_CACHE_RETURN');
        expect(await hasWorkingChanges(repoPath)).toBe(false);
        expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: newerVersionId });
        expect(onReplicaApplied).toHaveBeenCalledOnce();
        expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();
      }
    );
  });

  it('blocks a real replica apply when a new script draft becomes dirty during preparation', async () => {
    const previousDirtyState = getDirtyState();
    setDirtyState({ hasDirtyWork: false, details: '' });
    try {
      const originalBundle = validBundle();
      downloadLatest.mockResolvedValueOnce(latestResponse(originalBundle));
      await openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      });
      const repoPath = join(managedRoot, 'workspace-a', 'repo');
      const snapshot = await buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-a',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-10-06T00:00:00.000Z'),
      });
      const readOriginalFiles = () =>
        snapshot.bundle.files.map((file) => {
          const path = join(repoPath, file.relativePath);
          return {
            path: file.relativePath,
            bytes: readFileSync(path).toString('base64'),
            mtimeNs: statSync(path, { bigint: true }).mtimeNs.toString(),
          };
        });
      const originalFiles = readOriginalFiles();
      const originalHead = await resolveHeadCommit(repoPath);
      if (!originalHead) throw new Error('Restored replica has no Git head');
      const originalBinding = bindingRowByUuid(db, 'workspace-a');
      const originalVersion = latestVersionRow(db);
      const scriptPath = join(repoPath, 'analyses', 'run.py');
      const newerBundle = withUpdatedGenBank(snapshot.bundle, 'UNSAVED_SCRIPT_PULL_REFUSED');
      const newerVersionId = '244e4bfc-8b54-407a-8547-3f50574e61bb';
      const onReplicaPreparing = vi.fn(async () => {
        setDirtyState({ hasDirtyWork: true, details: '1 text file', dirtyFilePaths: [scriptPath] });
        return 'script-draft-preparation';
      });
      const onReplicaAborted = vi.fn(async () => {});

      await expect(
        applyLatestToExistingManagedRepo(db, {
          workspaceId: 1,
          workspaceUuid: 'workspace-a',
          repoPath,
          remote: newerRemote(newerBundle, newerVersionId),
          latest: newerLatest(newerBundle, newerVersionId),
          expectedLocalHeadSha: originalHead,
          expectedRemoteVersionId: REMOTE_VERSION_ID,
          nowMs: 2000,
          onReplicaPreparing,
          onReplicaAborted,
        })
      ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });

      expect(onReplicaPreparing).toHaveBeenCalledOnce();
      expect(onReplicaAborted).toHaveBeenCalledOnce();
      expect(readOriginalFiles()).toEqual(originalFiles);
      expect(await resolveHeadCommit(repoPath)).toBe(originalHead);
      expect(await hasWorkingChanges(repoPath)).toBe(false);
      expect(bindingRowByUuid(db, 'workspace-a')).toEqual(originalBinding);
      expect(latestVersionRow(db)).toEqual(originalVersion);
      expect(getDirtyState()).toMatchObject({ hasDirtyWork: true, dirtyFilePaths: [scriptPath] });
      expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();
      expect(hasWorkspaceSyncMutationLeaseForTest(repoPath)).toBe(false);
    } finally {
      setDirtyState(previousDirtyState);
    }
  });

  it('receives a remote edit over an existing read-only attachment', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const attachmentPath = join(repoPath, 'Lab notes', 'assets', 'model.bin');
    const originalBytes = readFileSync(attachmentPath);
    chmodSync(attachmentPath, 0o400);
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-10-06T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare read-only attachment return')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const marker = 'READ_ONLY_ATTACHMENT_RETURN';
    const newerBundle = withUpdatedGenBank(snapshot.bundle, marker);
    const newerVersionId = '244e4bfc-8b54-407a-8547-3f50574e61bb';

    await applyLatestToExistingManagedRepo(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath,
      remote: newerRemote(newerBundle, newerVersionId),
      latest: newerLatest(newerBundle, newerVersionId),
      expectedLocalHeadSha: previousHead!,
      expectedRemoteVersionId: REMOTE_VERSION_ID,
      nowMs: 2000,
    });

    expect(readFileSync(attachmentPath)).toEqual(originalBytes);
    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain(marker);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: newerVersionId });
  });

  it.each(['file', 'directory'] as const)(
    'restores every moved attachment when its backup %s flush fails',
    async (failedBarrier) => {
      await openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      });
      const repoPath = join(managedRoot, 'workspace-a', 'repo');
      const attachmentPath = join(repoPath, 'Lab notes', 'assets', 'model.bin');
      const originalBytes = readFileSync(attachmentPath);
      const snapshot = await buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-a',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-10-06T00:00:00.000Z'),
      });
      const previousHead =
        (await commitAllIfDirty(repoPath, 'Prepare failed backup flush')) ??
        (await resolveHeadCommit(repoPath));
      db.prepare(
        `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
      ).run(previousHead);
      const newerBundle = withUpdatedGenBank(snapshot.bundle, 'FAILED_RETURN_MUST_NOT_APPLY');
      const newerVersionId = '7e69966d-94d9-45fb-baf1-0b3bb0419be5';
      let failed = false;
      const failBackupFlush = async (path: string, barrier: 'file' | 'directory') => {
        if (
          !failed &&
          barrier === failedBarrier &&
          path.includes(join('.backup', 'Lab notes', 'assets'))
        ) {
          failed = true;
          throw new Error('injected attachment backup flush failure');
        }
      };

      await expect(
        applyLatestToExistingManagedRepo(db, {
          workspaceId: 1,
          workspaceUuid: 'workspace-a',
          repoPath,
          remote: newerRemote(newerBundle, newerVersionId),
          latest: newerLatest(newerBundle, newerVersionId),
          expectedLocalHeadSha: previousHead!,
          expectedRemoteVersionId: REMOTE_VERSION_ID,
          nowMs: 2000,
          durability: {
            flushFile: (path) => failBackupFlush(path, 'file'),
            flushDirectory: (path) => failBackupFlush(path, 'directory'),
            flushGitCommit: async () => undefined,
          },
        })
      ).rejects.toThrow('injected attachment backup flush failure');

      expect(failed).toBe(true);
      expect(readFileSync(attachmentPath)).toEqual(originalBytes);
      expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
      expect(await hasWorkingChanges(repoPath)).toBe(false);
      expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
      expect(
        readdirSync(join(managedRoot, 'workspace-a')).filter((path) =>
          path.startsWith('.dnaforge-sync-pull-')
        )
      ).toEqual([]);
    }
  );

  it('advances replica journal phases only after file and Git durability barriers', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare durability barrier fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'DURABILITY_BARRIER_APPLIED');
    const newerVersionId = '1ee0b017-242c-41df-a974-7e4f9c4fcf02';

    await applyLatestToExistingManagedRepo(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath,
      remote: newerRemote(newerBundle, newerVersionId),
      latest: newerLatest(newerBundle, newerVersionId),
      expectedLocalHeadSha: previousHead!,
      expectedRemoteVersionId: REMOTE_VERSION_ID,
      nowMs: 2000,
      durability: {
        flushFile: async (path) => {
          journalIoFault.durabilityEvents.push(`file:${path}`);
        },
        flushDirectory: async (path) => {
          journalIoFault.durabilityEvents.push(`directory:${path}`);
        },
        flushGitCommit: async () => {
          journalIoFault.durabilityEvents.push('git:commit');
        },
      },
    });

    const filesInstalled = journalIoFault.durabilityEvents.indexOf('journal:files_installed');
    const gitCommitted = journalIoFault.durabilityEvents.indexOf('journal:git_committed');
    const lastFileBarrier = journalIoFault.durabilityEvents.reduce(
      (last, event, index) => (event.startsWith('file:') ? index : last),
      -1
    );
    const lastDirectoryBarrier = journalIoFault.durabilityEvents.reduce(
      (last, event, index) => (event.startsWith('directory:') ? index : last),
      -1
    );
    const gitBarrier = journalIoFault.durabilityEvents.indexOf('git:commit');

    expect(lastFileBarrier).toBeGreaterThanOrEqual(0);
    expect(lastDirectoryBarrier).toBeGreaterThanOrEqual(0);
    expect(filesInstalled).toBeGreaterThan(lastFileBarrier);
    expect(filesInstalled).toBeGreaterThan(lastDirectoryBarrier);
    expect(gitBarrier).toBeGreaterThan(filesInstalled);
    expect(gitCommitted).toBeGreaterThan(gitBarrier);
  });

  it.each(['archived_at', 'trashed_at'] as const)(
    'refuses to commit a selected pull after the workspace gains %s',
    async (lifecycleColumn) => {
      await openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      });
      const repoPath = join(managedRoot, 'workspace-a', 'repo');
      const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
      const productBefore = readFileSync(productPath, 'utf8');
      const snapshot = await buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-a',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-07-09T00:00:00.000Z'),
      });
      const previousHead = await resolveHeadCommit(repoPath);
      db.prepare(
        `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
      ).run(previousHead);
      db.prepare(`UPDATE workspaces SET ${lifecycleColumn} = ? WHERE id = 1`).run(1500);
      const newerBundle = withUpdatedGenBank(
        snapshot.bundle,
        'MUST_NOT_APPLY_TO_INACTIVE_WORKSPACE'
      );
      const newerVersionId = 'cb79d0f2-f7f9-44f1-aa98-4909383deec5';

      await expect(
        applyLatestToExistingManagedRepo(db, {
          workspaceId: 1,
          workspaceUuid: 'workspace-a',
          repoPath,
          remote: newerRemote(newerBundle, newerVersionId),
          latest: newerLatest(newerBundle, newerVersionId),
          expectedLocalHeadSha: previousHead!,
          expectedRemoteVersionId: REMOTE_VERSION_ID,
          nowMs: 2000,
        })
      ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });

      expect(readFileSync(productPath, 'utf8')).toBe(productBefore);
      expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
      expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
    }
  );

  it('removes syncable files deleted remotely while preserving excluded local-only data', async () => {
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const excludedLocalPath = join(repoPath, 'sample.fastq');
    const excludedLocalContent = '@read\nACGT\n+\n!!!!\n';
    writeFileSync(excludedLocalPath, excludedLocalContent, 'utf8');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare remote deletion fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = ?
       WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withOnlyReplacementGenBank(snapshot.bundle);
    const newerVersionId = '056b9d91-b7ee-405f-a0ba-a88e9ed15837';
    const onReplicaApplied = vi.fn(async () => {
      expect(hasWorkspaceSyncMutationLeaseForTest(repoPath)).toBe(true);
    });

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: {
          ...remoteSummary(),
          latest: {
            versionId: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        latest: {
          ...latestResponse(newerBundle),
          version: {
            ...latestResponse(newerBundle).version,
            id: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        onReplicaApplied,
      })
    ).resolves.toBeUndefined();

    expect(existsSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'))).toBe(false);
    expect(existsSync(join(repoPath, 'designs', 'pUC19', '.forge', 'plasmid.json'))).toBe(false);
    expect(
      readFileSync(join(repoPath, 'designs', 'replacement', 'replacement.gb'), 'utf8')
    ).toContain('replacement');
    expect(readFileSync(excludedLocalPath, 'utf8')).toBe(excludedLocalContent);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(hasWorkspaceSyncMutationLeaseForTest(repoPath)).toBe(false);
    expect(onReplicaApplied).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        workspaceUuid: 'workspace-a',
        workspaceRoot: repoPath,
        remoteVersionId: newerVersionId,
        changedPaths: expect.arrayContaining([
          join(repoPath, 'designs', 'replacement', 'replacement.gb'),
        ]),
        deletedPaths: expect.arrayContaining([join(repoPath, 'designs', 'pUC19', 'pUC19.gb')]),
      })
    );
  });

  it('warns after an existing replica pulls a historical bundle with inert LIMS files', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare legacy LIMS pull fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withLegacyLimsExport(snapshot.bundle);
    const newerVersionId = 'c94f26c4-17aa-4cf4-9fda-bdbcd70c5ae5';
    const onReplicaApplied = vi.fn(async () => undefined);

    await applyLatestToExistingManagedRepo(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath,
      remote: newerRemote(newerBundle, newerVersionId),
      latest: newerLatest(newerBundle, newerVersionId),
      expectedLocalHeadSha: previousHead!,
      expectedRemoteVersionId: REMOTE_VERSION_ID,
      nowMs: 2000,
      onReplicaApplied,
    });

    expect(onReplicaApplied).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        warnings: [userMessage('sync.legacyDataKept')],
      })
    );
    expect(existsSync(join(repoPath, '.waypoint', 'lims', 'manifest.json'))).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM lims_audit`).get()).toEqual({ count: 0 });
  });

  it('withholds plain synced while incoming replica files are being installed', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    let currentHead =
      (await commitAllIfDirty(repoPath, 'Prepare incoming status fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(currentHead);
    const status = () =>
      readWorkspaceSyncStatus(db, {
        workspaceUuid: 'workspace-a',
        getActiveAccountId: () => 'account-a',
        getCurrentLocalHeadSha: () => currentHead,
        getExcludedSummary: () => ({
          unsupportedCount: 0,
          privateRawDataCount: 0,
          referencePointerCount: 0,
          fileTooLargeCount: 0,
          bundleTooLargeCount: 0,
        }),
        nowMs: () => 2000,
      });
    expect(status().canDisplayPlainSynced).toBe(true);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'INCOMING_STATUS_WINNER');
    const newerVersionId = '0c7cdb42-5011-4e49-a172-782e7c6833a5';
    let observedReplacement = false;

    await applyLatestToExistingManagedRepo(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath,
      remote: newerRemote(newerBundle, newerVersionId),
      latest: newerLatest(newerBundle, newerVersionId),
      expectedLocalHeadSha: currentHead!,
      expectedRemoteVersionId: REMOTE_VERSION_ID,
      nowMs: 2000,
      installFile: async (sourcePath, destinationPath) => {
        if (destinationPath.endsWith(join('designs', 'pUC19', 'pUC19.gb'))) {
          observedReplacement = true;
          expect(existsSync(destinationPath)).toBe(false);
          expect(status()).toMatchObject({
            syncAxis: 'restoring',
            canDisplayPlainSynced: false,
          });
        }
        await renameFile(sourcePath, destinationPath);
      },
    });

    expect(observedReplacement).toBe(true);
    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain(
      'INCOMING_STATUS_WINNER'
    );
    currentHead = await resolveHeadCommit(repoPath);
    expect(status().canDisplayPlainSynced).toBe(true);
  });

  it('keeps prepared and applied notebook authority in workspace-scoped projection ids', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare scoped notebook authority fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'SCOPED_NOTEBOOK_AUTHORITY');
    const newerVersionId = '24bb047e-f19a-4faf-82aa-c9ab3a97af6a';
    let preparedNotebookIds: readonly string[] | null = null;

    await applyLatestToExistingManagedRepo(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath,
      remote: newerRemote(newerBundle, newerVersionId),
      latest: newerLatest(newerBundle, newerVersionId),
      expectedLocalHeadSha: previousHead!,
      expectedRemoteVersionId: REMOTE_VERSION_ID,
      nowMs: 2000,
      onReplicaPreparing: async (notice) => {
        preparedNotebookIds = notice.affectedNotebookIds;
        return 'scoped-notebook-authority';
      },
      onReplicaApplied: async (_preparationId, notice) => {
        expect(notice.affectedNotebookIds).toEqual(preparedNotebookIds);
      },
    });

    expect(preparedNotebookIds).toEqual(['workspace-a::page-1']);
  });

  it('keeps an exact durable renderer refresh notice when post-commit hydration fails', async () => {
    const onReplicaAborted = vi.fn();
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare renderer refresh failure fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withAddedFile(
      withUpdatedGenBank(snapshot.bundle, 'REMOTE_COMMIT_SURVIVES_REFRESH_ERROR'),
      {
        id: 'remote-design-file',
        relativePath: 'designs/Remote Draft.wpdesign.json',
        kind: 'design',
        contentType: 'application/json',
        content: JSON.stringify({
          schema: 'waypoint.design.v1',
          kind: 'assembly-design',
          id: 'remote-design',
          name: 'Remote Draft',
          design: { id: 'remote-design', name: 'Remote Draft' },
        }),
      }
    );
    const newerVersionId = '57c3718c-ebf7-4d3c-9e1c-35885e7bdf54';

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        onReplicaPreparing: async () => 'post-commit-refresh',
        onReplicaAborted,
        onReplicaApplied: async () => {
          throw new Error('injected renderer hydration failure');
        },
      })
    ).rejects.toThrow('injected renderer hydration failure');
    expect(onReplicaAborted).toHaveBeenCalledWith(
      'post-commit-refresh',
      expect.objectContaining({ committed: true })
    );

    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain(
      'REMOTE_COMMIT_SURVIVES_REFRESH_ERROR'
    );
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: newerVersionId });
    await expect(reconcileInterruptedReplicaPulls(db)).resolves.toMatchObject({
      completed: 1,
      quarantined: [],
    });
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toMatchObject({
      workspaceId: 1,
      notice: {
        workspaceUuid: 'workspace-a',
        workspaceRoot: repoPath,
        remoteVersionId: newerVersionId,
        affectedDesignIds: ['remote-design'],
        deletedDesignIds: [],
      },
    });
  });

  it('refreshes the prepared renderer before a terminal journal write can fail', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare terminal journal failure fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'REMOTE_COMMIT_SURVIVES_JOURNAL_ERROR');
    const newerVersionId = '897dfcac-b5d6-4972-a08f-52e2ec80d77b';
    const onReplicaApplied = vi.fn(async () => {
      expect(hasWorkspaceSyncMutationLeaseForTest(repoPath)).toBe(true);
    });
    const onReplicaAborted = vi.fn();
    journalIoFault.failSqliteCommit = true;

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        onReplicaPreparing: async () => 'preparation-journal-failure',
        onReplicaApplied,
        onReplicaAborted,
      })
    ).rejects.toThrow('injected SQLite-commit journal flush failure');

    expect(onReplicaApplied).toHaveBeenCalledWith(
      'preparation-journal-failure',
      expect.objectContaining({
        workspaceUuid: 'workspace-a',
        workspaceRoot: repoPath,
        remoteVersionId: newerVersionId,
      })
    );
    expect(onReplicaAborted).not.toHaveBeenCalled();
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: newerVersionId });
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();
    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain(
      'REMOTE_COMMIT_SURVIVES_JOURNAL_ERROR'
    );
  });

  it('rolls the complete prior projection back when an incoming install fails mid-replacement', async () => {
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const markerPath = join(repoPath, '.dnaforge-workspace.json');
    const productBefore = readFileSync(productPath, 'utf8');
    const markerBefore = readFileSync(markerPath, 'utf8');
    const currentSnapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare replica rollback fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = ?
       WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withOnlyReplacementGenBank(currentSnapshot.bundle);
    const newerVersionId = 'd1091110-63c7-42f0-a017-9920fa9f97a0';
    let renameFailureInjected = false;

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: {
          ...remoteSummary(),
          latest: {
            versionId: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        latest: {
          ...latestResponse(newerBundle),
          version: {
            ...latestResponse(newerBundle).version,
            id: newerVersionId,
            versionNumber: 4,
          },
        },
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        installFile: async (sourcePath, destinationPath) => {
          if (
            !renameFailureInjected &&
            sourcePath.includes('.dnaforge-sync-pull-') &&
            !sourcePath.includes('.backup') &&
            destinationPath.endsWith(join('designs', 'replacement', 'replacement.gb'))
          ) {
            renameFailureInjected = true;
            throw Object.assign(new Error('injected replica install rename failure'), {
              code: 'EIO',
            });
          }
          await renameFile(sourcePath, destinationPath);
        },
      })
    ).rejects.toThrow('injected replica install rename failure');

    expect(renameFailureInjected).toBe(true);
    expect(readFileSync(productPath, 'utf8')).toBe(productBefore);
    expect(readFileSync(markerPath, 'utf8')).toBe(markerBefore);
    expect(existsSync(join(repoPath, 'designs', 'replacement.gb'))).toBe(false);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(bindingRow(db)).toMatchObject({
      remote_latest_version_id: REMOTE_VERSION_ID,
      remote_latest_version_number: 3,
    });
  });

  it('detects an external write through an open file while the current replica is moved to recovery', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const markerPath = join(repoPath, '.dnaforge-workspace.json');
    const markerBefore = readFileSync(markerPath, 'utf8');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare external-writer conflict fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'SHOULD_NOT_APPLY');
    const newerVersionId = '6fe5867e-2edb-43a5-aa09-6c8973f623cf';
    const externalEdit = '\nEXTERNAL_WRITE_THROUGH_OPEN_FILE\n';
    let mutationInjected = false;

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        renameFile: async (sourcePath, destinationPath) => {
          await renameFile(sourcePath, destinationPath);
          if (
            !mutationInjected &&
            sourcePath.endsWith(join('repo', '.dnaforge-workspace.json')) &&
            destinationPath.includes(`${join('.backup', '.dnaforge-workspace.json')}`)
          ) {
            mutationInjected = true;
            writeFileSync(destinationPath, `${markerBefore}${externalEdit}`, 'utf8');
          }
        },
      })
    ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });

    expect(mutationInjected).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).toBe(`${markerBefore}${externalEdit}`);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(await hasWorkingChanges(repoPath)).toBe(true);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
  });

  it('detects a binary backup mutation even when both byte strings decode to the same replacement text', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const binaryPath = join(repoPath, 'Lab notes', 'assets', 'model.bin');
    const originalBytes = Buffer.from([0xff, 0x00, 0x80]);
    const externallyMutatedBytes = Buffer.from([0xfe, 0x00, 0x80]);
    expect(readFileSync(binaryPath)).toEqual(originalBytes);
    expect(originalBytes.toString('utf8')).toBe(externallyMutatedBytes.toString('utf8'));

    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-08-27T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare binary conflict fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'BINARY_CONFLICT_SHOULD_NOT_APPLY');
    const newerVersionId = '2ab7bdc1-99cb-4e80-aafd-82d2cba4c520';
    let mutationInjected = false;

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        renameFile: async (sourcePath, destinationPath) => {
          await renameFile(sourcePath, destinationPath);
          if (
            !mutationInjected &&
            sourcePath.endsWith(join('Lab notes', 'assets', 'model.bin')) &&
            destinationPath.includes(join('.backup', 'Lab notes', 'assets', 'model.bin'))
          ) {
            mutationInjected = true;
            writeFileSync(destinationPath, externallyMutatedBytes);
          }
        },
      })
    ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });

    expect(mutationInjected).toBe(true);
    expect(readFileSync(binaryPath)).toEqual(externallyMutatedBytes);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
  });

  it('refuses to acknowledge installed bytes changed after the managed Git commit', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare installed-byte conflict fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'REMOTE_BYTES_MUST_NOT_BE_ACKED');
    const newerVersionId = '84dfaed6-c22f-4daf-8c84-575e1f86507b';
    const externalEdit = '\nLOCAL_WRITE_AFTER_REMOTE_COMMIT\n';
    let mutationInjected = false;

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        durability: {
          flushFile: async () => undefined,
          flushDirectory: async () => undefined,
          flushGitCommit: async () => {
            mutationInjected = true;
            writeFileSync(productPath, `${readFileSync(productPath, 'utf8')}${externalEdit}`);
          },
        },
      })
    ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });

    expect(mutationInjected).toBe(true);
    expect(readFileSync(productPath, 'utf8')).toContain(externalEdit.trim());
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(await hasWorkingChanges(repoPath)).toBe(true);
    expect(bindingRow(db)).toMatchObject({
      remote_latest_version_id: REMOTE_VERSION_ID,
      remote_latest_version_number: 3,
    });
  });

  it('pulls a newer version while retaining untracked local Registry bookkeeping', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare local Registry pull fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      'UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1'
    ).run(previousHead);
    const localPath = join(repoPath, '.waypoint', 'lims', 'manifest.json');
    mkdirSync(join(repoPath, '.waypoint', 'lims'), { recursive: true });
    const localBytes = '{"localRegistry":"retain these exact bytes"}\n';
    writeFileSync(localPath, localBytes);
    expect(await hasWorkingChanges(repoPath)).toBe(true);
    const updated = withUpdatedGenBank(snapshot.bundle, 'INCOMING_WITH_LOCAL_REGISTRY');
    const versionId = 'f4fc7f04-dc89-4d16-8d3b-56a8a4ce798e';

    await applyLatestToExistingManagedRepo(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath,
      remote: newerRemote(updated, versionId),
      latest: newerLatest(updated, versionId),
      expectedLocalHeadSha: previousHead!,
      expectedRemoteVersionId: REMOTE_VERSION_ID,
      nowMs: 2000,
    });

    expect(readFileSync(localPath, 'utf8')).toBe(localBytes);
    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain(
      'INCOMING_WITH_LOCAL_REGISTRY'
    );
    expect(bindingRow(db)).toMatchObject({
      remote_latest_version_id: versionId,
      last_acked_local_head_sha: await resolveHeadCommit(repoPath),
    });
    expect(await hasWorkingChanges(repoPath)).toBe(true);
  });

  it('preserves changed local Registry data when a historical incoming version would overwrite it', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare Registry collision fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      'UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1'
    ).run(previousHead);
    const localPath = join(repoPath, '.waypoint', 'lims', 'manifest.json');
    mkdirSync(join(repoPath, '.waypoint', 'lims'), { recursive: true });
    const localBytes = '{"localRegistry":"unpublished local data"}\n';
    writeFileSync(localPath, localBytes);
    const incoming = withLegacyLimsExport(snapshot.bundle);
    const versionId = '36c3ee02-e7c9-4666-81e4-8abbd1b3fbb5';
    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(incoming, versionId),
        latest: newerLatest(incoming, versionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
      })
    ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });
    expect(readFileSync(localPath, 'utf8')).toBe(localBytes);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
  });

  it('materializes a private notebook attachment as a verified blob reference', async () => {
    const notebookId = 'b5972262-6b7a-4e70-9f15-b161401e2763';
    const contents = new Map<string, Buffer>([
      [
        'Large attachments/.forge/notebook.json',
        Buffer.from(
          JSON.stringify({
            schema: 'waypoint.notebook.v1',
            kind: 'notebook',
            formatVersion: 2,
            authority: {
              type: 'markdown',
              path: 'Large attachments.md',
              codec: 'dnaforge.notebook-markdown.v1',
            },
            payloads: { blocksDirectory: 'blocks', schema: 'waypoint.notebook.block.v1' },
            id: notebookId,
            title: 'Large attachments',
            content: { type: 'doc', content: [] },
            updatedAt: '2026-10-05T00:00:00.000Z',
            storage: { type: 'database', table: 'pages', id: notebookId },
          })
        ),
      ],
      ['Large attachments/Large attachments.md', Buffer.from('# Large attachments\n')],
      ['Large attachments/assets/model-0.bin', Buffer.alloc(512 * 1024 + 7, 0x81)],
    ]);
    const parsed = parseWorkspaceSyncManifest({
      schemaVersion: 1,
      files: [...contents].map(([path, bytes]) => ({
        path,
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        contentType: path.endsWith('.json')
          ? 'application/json'
          : path.endsWith('.md')
            ? 'text/markdown'
            : 'application/octet-stream',
      })),
    });
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const bundle = await materializeDesktopSyncVersionBundle({
      remote: hostedRemoteSummary(parsed.manifest),
      latest: hostedManifestLatest(parsed.manifest),
      downloadManifestFile: async (_workspace, _version, file) => {
        const bytes = contents.get(file.path)!;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(bytes.subarray(0, Math.ceil(bytes.length / 2))));
              controller.enqueue(new Uint8Array(bytes.subarray(Math.ceil(bytes.length / 2))));
              controller.close();
            },
          })
        );
      },
    });
    const asset = bundle.files.find((file) => file.relativePath.endsWith('model-0.bin'));
    expect(bundle.schemaVersion).toBe(3);
    expect(asset).toMatchObject({
      kind: 'notebook',
      encoding: 'blob',
      content: '',
      sizeBytes: 512 * 1024 + 7,
    });
    expect(readFileSync(await workspaceSyncBlobPath(asset!.sha256!))).toEqual(
      contents.get('Large attachments/assets/model-0.bin')
    );
  });

  it('refuses a newer remote bundle when the existing repo has uncommitted local changes', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const expectedLocalHeadSha = await resolveHeadCommit(repoPath);
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const localMarker = 'LOCAL_UNCOMMITTED_EDIT';
    writeFileSync(productPath, `${readFileSync(productPath, 'utf8')}\n${localMarker}\n`, 'utf8');
    const markerBefore = readFileSync(join(repoPath, '.dnaforge-workspace.json'), 'utf8');

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: remoteSummary(),
        latest: latestResponse(validBundle()),
        expectedLocalHeadSha: expectedLocalHeadSha!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
      })
    ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });

    expect(readFileSync(productPath, 'utf8')).toContain(localMarker);
    expect(readFileSync(join(repoPath, '.dnaforge-workspace.json'), 'utf8')).toBe(markerBefore);
    expect(bindingRow(db)).toMatchObject({
      remote_latest_version_id: REMOTE_VERSION_ID,
      remote_latest_version_number: 3,
      last_downloaded_at: 1000,
    });
  });

  it('rejects a symlinked replacement target before changing any existing repo file', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const outsidePath = join(managedRoot, 'outside.gb');
    const outsideContent = 'OUTSIDE_SENTINEL';
    writeFileSync(outsidePath, outsideContent, 'utf8');
    symlinkSync(outsidePath, join(repoPath, 'designs', 'pUC19.gb'));
    const expectedLocalHeadSha =
      (await commitAllIfDirty(repoPath, 'Add malicious replacement link', {
        forceInclude: ['designs/pUC19.gb'],
      })) ?? (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = ?
       WHERE workspace_id = 1`
    ).run(expectedLocalHeadSha);
    const markerBefore = readFileSync(join(repoPath, '.dnaforge-workspace.json'), 'utf8');
    const newerBundle = withUpdatedGenBank(validBundle(), 'REMOTE_SYMLINK_GUARD');
    const newerVersionId = 'd2a2d8c1-a41c-4a51-8054-7f8ea91fbf75';

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: {
          ...remoteSummary(),
          latest: {
            versionId: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        latest: {
          ...latestResponse(newerBundle),
          version: {
            ...latestResponse(newerBundle).version,
            id: newerVersionId,
            versionNumber: 4,
          },
        },
        expectedLocalHeadSha: expectedLocalHeadSha!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
      })
    ).rejects.toThrow();

    expect(readFileSync(outsidePath, 'utf8')).toBe(outsideContent);
    expect(readFileSync(join(repoPath, '.dnaforge-workspace.json'), 'utf8')).toBe(markerBefore);
  });

  it('does not create outside directories through a preexisting symlink ancestor', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-outside-'));
    const displacedDesigns = mkdtempSync(join(tmpdir(), 'dnaforge-sync-displaced-'));
    rmSync(displacedDesigns, { recursive: true, force: true });
    renameSync(join(repoPath, 'designs'), displacedDesigns);
    symlinkSync(outsideRoot, join(repoPath, 'designs'), 'dir');
    const expectedLocalHeadSha =
      (await commitAllIfDirty(repoPath, 'Commit hostile directory ancestor', {
        forceInclude: ['designs'],
      })) ?? (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(expectedLocalHeadSha);
    const newerBundle = withUpdatedGenBank(validBundle(), 'REMOTE_MUST_STAY_INSIDE_REPO');
    const newerVersionId = '53e87cb8-cfda-4c41-b8df-04d16f944358';

    try {
      await expect(
        applyLatestToExistingManagedRepo(db, {
          workspaceId: 1,
          workspaceUuid: 'workspace-a',
          repoPath,
          remote: newerRemote(newerBundle, newerVersionId),
          latest: newerLatest(newerBundle, newerVersionId),
          expectedLocalHeadSha: expectedLocalHeadSha!,
          expectedRemoteVersionId: REMOTE_VERSION_ID,
          nowMs: 2000,
        })
      ).rejects.toThrow();

      expect(readdirSync(outsideRoot)).toEqual([]);
      expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
      rmSync(displacedDesigns, { recursive: true, force: true });
    }
  });

  it('rejects a remote notebook whose destination crosses a local symlink ancestor', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-notebook-outside-'));
    symlinkSync(outsideRoot, join(repoPath, 'notes'), 'dir');
    const expectedLocalHeadSha =
      (await commitAllIfDirty(repoPath, 'Commit notebook directory link', {
        forceInclude: ['notes'],
      })) ?? (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(expectedLocalHeadSha);
    const content = JSON.stringify({
      schema: 'waypoint.notebook.v1',
      kind: 'notebook',
      id: 'page-remote-symlink',
      title: 'Remote notes',
      content: { type: 'doc', content: [] },
      updatedAt: '2026-08-26T00:00:00.000Z',
      storage: { type: 'database', table: 'pages', id: 'page-remote-symlink' },
    });
    const newerBundle = withAddedFile(validBundle(), {
      id: 'remote-notebook',
      relativePath: 'notes/remote.wpnote.json',
      kind: 'notebook',
      contentType: 'application/json',
      content,
    });
    const newerVersionId = '7bce8806-57ae-4907-b8ae-750ca62f0e2e';

    try {
      await expect(
        applyLatestToExistingManagedRepo(db, {
          workspaceId: 1,
          workspaceUuid: 'workspace-a',
          repoPath,
          remote: newerRemote(newerBundle, newerVersionId),
          latest: newerLatest(newerBundle, newerVersionId),
          expectedLocalHeadSha: expectedLocalHeadSha!,
          expectedRemoteVersionId: REMOTE_VERSION_ID,
          nowMs: 2000,
        })
      ).rejects.toThrow('directory chain contains');

      expect(readdirSync(outsideRoot)).toEqual([]);
      expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('revalidates directory ancestors after renderer preparation and before replacement', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const expectedLocalHeadSha =
      (await commitAllIfDirty(repoPath, 'Prepare ancestor revalidation fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(expectedLocalHeadSha);
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-outside-'));
    const displacedDesigns = mkdtempSync(join(tmpdir(), 'dnaforge-sync-displaced-'));
    rmSync(displacedDesigns, { recursive: true, force: true });
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'REMOTE_POST_PREFLIGHT_GUARD');
    const newerVersionId = '51232389-50e0-4d93-8243-bdfe4283865b';

    try {
      await expect(
        applyLatestToExistingManagedRepo(db, {
          workspaceId: 1,
          workspaceUuid: 'workspace-a',
          repoPath,
          remote: newerRemote(newerBundle, newerVersionId),
          latest: newerLatest(newerBundle, newerVersionId),
          expectedLocalHeadSha: expectedLocalHeadSha!,
          expectedRemoteVersionId: REMOTE_VERSION_ID,
          nowMs: 2000,
          onReplicaPreparing: async () => {
            renameSync(join(repoPath, 'designs'), displacedDesigns);
            symlinkSync(outsideRoot, join(repoPath, 'designs'), 'dir');
            return 'preparation-a';
          },
        })
      ).rejects.toThrow('directory chain contains');

      expect(readdirSync(outsideRoot)).toEqual([]);
      expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
      rmSync(displacedDesigns, { recursive: true, force: true });
    }
  });

  it('does not recreate an included file deleted during renderer preparation', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare concurrent deletion fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'REMOTE_MUST_NOT_RECREATE_DELETION');
    const newerVersionId = 'ad033a02-5117-4498-a44c-6626dbb4f2f4';

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        onReplicaPreparing: async () => {
          rmSync(productPath);
          return 'preparation-concurrent-delete';
        },
      })
    ).rejects.toThrow('deleted while the remote replica was staged');

    expect(existsSync(productPath)).toBe(false);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
  });

  it.each([false, true])(
    'refuses to overwrite an excluded local file when the remote includes the same path (allowance increased: %s)',
    async (increaseAllowance) => {
      await openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      });
      const repoPath = join(managedRoot, 'workspace-a', 'repo');
      const collisionPath = join(repoPath, 'designs', 'collision.gb');
      const localContent = `LOCUS       local-large       5000 bp    DNA     linear\n${'A'.repeat(5000)}\n//\n`;
      writeFileSync(collisionPath, localContent, 'utf8');
      let expectedLocalHeadSha =
        (await commitAllIfDirty(repoPath, 'Add size-excluded local design')) ??
        (await resolveHeadCommit(repoPath));
      process.env.DNAFORGE_SYNC_MAX_FILE_BYTES = '4096';
      const currentSnapshot = await buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-a',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-07-09T00:00:00.000Z'),
      });
      expect(currentSnapshot.bundle.excludedSummary['file-too-large'].count).toBeGreaterThanOrEqual(
        1
      );
      if (increaseAllowance) delete process.env.DNAFORGE_SYNC_MAX_FILE_BYTES;
      expectedLocalHeadSha =
        (await commitAllIfDirty(repoPath, 'Acknowledge classified local replica')) ??
        (await resolveHeadCommit(repoPath));
      db.prepare(
        `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
      ).run(expectedLocalHeadSha);
      const newerBundle = withAddedGenBank(
        currentSnapshot.bundle,
        'designs/collision.gb',
        'LOCUS       remote-small       12 bp    DNA     linear\nORIGIN\n//\n'
      );
      const newerVersionId = '2133c49a-36dc-49f9-ae39-bcc1a154dacf';

      await expect(
        applyLatestToExistingManagedRepo(db, {
          workspaceId: 1,
          workspaceUuid: 'workspace-a',
          repoPath,
          remote: {
            ...remoteSummary(),
            latest: {
              versionId: newerVersionId,
              versionNumber: 4,
              contentSha256: newerBundle.provenance.contentSha256,
            },
          },
          latest: {
            ...latestResponse(newerBundle),
            version: {
              ...latestResponse(newerBundle).version,
              id: newerVersionId,
              versionNumber: 4,
              contentSha256: newerBundle.provenance.contentSha256,
            },
          },
          expectedLocalHeadSha: expectedLocalHeadSha!,
          expectedRemoteVersionId: REMOTE_VERSION_ID,
          nowMs: 2000,
        })
      ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });

      expect(readFileSync(collisionPath, 'utf8')).toBe(localContent);
      expect(await resolveHeadCommit(repoPath)).toBe(expectedLocalHeadSha);
      expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
    }
  );

  it('updates already accepted files even when a downgraded policy excludes them from new uploads', async () => {
    const initialBundle = withUpdatedGenBank(validBundle(), 'A'.repeat(5000));
    downloadLatest.mockResolvedValue(latestResponse(initialBundle));
    listWorkspaces.mockResolvedValue([
      {
        ...remoteSummary(),
        latest: {
          ...remoteSummary().latest,
          contentSha256: initialBundle.provenance.contentSha256,
        },
      },
    ]);
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const policy: WorkspaceSyncStoragePolicy = {
      schemaVersion: 1,
      policyKey: 'downgraded',
      revision: 2,
      maxFileBytes: 4096,
      maxProjectBytes: 1024 * 1024,
      maxFiles: 2000,
      storageQuotaBytes: 2 * 1024 * 1024,
    };
    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-a',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-07-09T00:00:00.000Z'),
        directStorage: true,
        storagePolicy: policy,
      })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    db.prepare("DELETE FROM settings WHERE key LIKE 'workspace_sync_replica_files:%'").run();
    const readVersionPaths = vi.fn(async () =>
      snapshot.bundle.files.map((file) => file.relativePath)
    );
    const createVersion = vi.fn();
    const worker = new WorkspaceSyncUploadWorker(db, {
      deviceId: 'downgrade-test',
      appVersion: '0.4.0',
      getActiveAccountId: () => 'account-a',
      getCurrentLocalHeadSha: () => resolveHeadCommit(repoPath),
      client: { readStoragePolicy: async () => policy, readVersionPaths, createVersion },
    });
    await expect(worker.flushWorkspace('workspace-a', { force: true })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(readVersionPaths).toHaveBeenCalledWith(
      REMOTE_WORKSPACE_ID,
      REMOTE_VERSION_ID,
      'account-a'
    );
    expect(createVersion).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM settings WHERE key LIKE 'workspace_sync_replica_files:%'"
        )
        .get()
    ).toMatchObject({ n: 1 });
    const expectedLocalHeadSha =
      (await commitAllIfDirty(repoPath, 'Classify after downgrade')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      'UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1'
    ).run(expectedLocalHeadSha);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'HISTORICAL_FILE_STILL_SYNCS');
    const versionId = '2c337b9e-c759-4d4c-a50d-a692560e3db1';
    await applyLatestToExistingManagedRepo(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath,
      remote: newerRemote(newerBundle, versionId),
      latest: newerLatest(newerBundle, versionId),
      expectedLocalHeadSha: expectedLocalHeadSha!,
      expectedRemoteVersionId: REMOTE_VERSION_ID,
      nowMs: 2000,
    });
    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain(
      'HISTORICAL_FILE_STILL_SYNCS'
    );
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: versionId });
  });

  it('recovers accepted file ownership for an older local profile before applying a remote version', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    db.prepare("DELETE FROM settings WHERE key LIKE 'workspace_sync_replica_files:%'").run();
    const readVersionPaths = vi.fn(async () =>
      snapshot.bundle.files.map((file) => file.relativePath)
    );
    const expectedLocalHeadSha =
      (await commitAllIfDirty(repoPath, 'Classify older profile')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      'UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1'
    ).run(expectedLocalHeadSha);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'OLDER_PROFILE_SAFE_PULL');
    const versionId = '2c337b9e-c759-4d4c-a50d-a692560e3db2';
    await applyLatestToExistingManagedRepo(db, {
      workspaceId: 1,
      workspaceUuid: 'workspace-a',
      repoPath,
      remote: newerRemote(newerBundle, versionId),
      latest: newerLatest(newerBundle, versionId),
      expectedLocalHeadSha: expectedLocalHeadSha!,
      expectedRemoteVersionId: REMOTE_VERSION_ID,
      nowMs: 2000,
      client: { ...client, readVersionPaths },
    });
    expect(readVersionPaths).toHaveBeenCalledExactlyOnceWith(
      REMOTE_WORKSPACE_ID,
      REMOTE_VERSION_ID
    );
    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain(
      'OLDER_PROFILE_SAFE_PULL'
    );
    expect(
      db
        .prepare(
          "SELECT count(*) AS total FROM settings WHERE key LIKE 'workspace_sync_replica_files:%'"
        )
        .get()
    ).toEqual({ total: 1 });
  });

  it.each([
    {
      label: 'remote version id',
      seed: () => seedExistingRemoteVersion(db, '40000000-0000-4000-8000-000000000004'),
    },
    {
      label: 'local version primary key',
      seed: () => seedRemoteVersionPrimaryKeyCollision(db, '40000000-0000-4000-8000-000000000004'),
    },
  ])('rejects a cross-workspace $label collision before changing files', async ({ seed }) => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const productBefore = readFileSync(productPath, 'utf8');
    const previousHead = await resolveHeadCommit(repoPath);
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    seed();
    const newerBundle = withUpdatedGenBank(validBundle(), 'CROSS_WORKSPACE_COLLISION');
    const newerVersionId = '40000000-0000-4000-8000-000000000004';

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: {
          ...remoteSummary(),
          latest: {
            versionId: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        latest: {
          ...latestResponse(newerBundle),
          version: {
            ...latestResponse(newerBundle).version,
            id: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
      })
    ).rejects.toThrow('already linked');

    expect(readFileSync(productPath, 'utf8')).toBe(productBefore);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
  });

  it('rolls files, Git, and SQLite back when final acknowledgement fails', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const markerPath = join(repoPath, '.dnaforge-workspace.json');
    const productBefore = readFileSync(productPath, 'utf8');
    const markerBefore = readFileSync(markerPath, 'utf8');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare finalization rollback fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    db.exec(
      `CREATE TRIGGER fail_workspace_sync_ack
       BEFORE UPDATE OF remote_latest_version_id ON workspace_sync_bindings
       BEGIN SELECT RAISE(ABORT, 'injected final acknowledgement failure'); END`
    );
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'FINAL_ACK_ROLLBACK');
    const newerVersionId = '70a2536f-40b8-4a68-811d-c34972f468b5';

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: {
          ...remoteSummary(),
          latest: {
            versionId: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        latest: {
          ...latestResponse(newerBundle),
          version: {
            ...latestResponse(newerBundle).version,
            id: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
      })
    ).rejects.toThrow('injected final acknowledgement failure');

    expect(readFileSync(productPath, 'utf8')).toBe(productBefore);
    expect(readFileSync(markerPath, 'utf8')).toBe(markerBefore);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(bindingRow(db)).toMatchObject({
      remote_latest_version_id: REMOTE_VERSION_ID,
      remote_latest_version_number: 3,
    });
    expect(
      db.prepare(`SELECT id FROM workspace_sync_versions WHERE id = ?`).get(newerVersionId)
    ).toBeUndefined();
  });

  it('treats staging cleanup failure as an orphan cleanup problem after a successful apply', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare cleanup-failure success fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'CLEANUP_FAILURE_AFTER_COMMIT');
    const newerVersionId = '2bbed34c-5b1a-459d-8d05-50575e5d38c0';
    const cleanupStaging = vi.fn(async () => {
      throw Object.assign(new Error('injected staging cleanup failure'), { code: 'EBUSY' });
    });

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        cleanupStaging,
      })
    ).resolves.toBeUndefined();

    expect(cleanupStaging).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(repoPath, 'designs', 'pUC19', 'pUC19.gb'), 'utf8')).toContain(
      'CLEANUP_FAILURE_AFTER_COMMIT'
    );
    expect(await resolveHeadCommit(repoPath)).not.toBe(previousHead);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: newerVersionId });
  });

  it('restores files and Git even when staging cleanup also fails during rollback', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const productBefore = readFileSync(productPath, 'utf8');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare cleanup-failure rollback fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    db.exec(
      `CREATE TRIGGER fail_workspace_sync_cleanup_rollback
       BEFORE UPDATE OF remote_latest_version_id ON workspace_sync_bindings
       BEGIN SELECT RAISE(ABORT, 'injected acknowledgement failure before cleanup'); END`
    );
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'CLEANUP_FAILURE_DURING_ROLLBACK');
    const newerVersionId = '66a752e7-89c4-4eaa-8e93-44dc8d650e37';
    const cleanupStaging = vi.fn(async () => {
      throw Object.assign(new Error('injected rollback cleanup failure'), { code: 'EBUSY' });
    });

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        cleanupStaging,
      })
    ).rejects.toThrow('injected acknowledgement failure before cleanup');

    expect(cleanupStaging).toHaveBeenCalledTimes(1);
    expect(readFileSync(productPath, 'utf8')).toBe(productBefore);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
  });

  it('preserves a size-excluded pre-existing package product when final acknowledgement rolls back', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    writeFileSync(productPath, `${readFileSync(productPath, 'utf8')}${'N'.repeat(8192)}`, 'utf8');
    const productBefore = readFileSync(productPath, 'utf8');
    process.env.DNAFORGE_SYNC_MAX_FILE_BYTES = '4096';
    writeFileSync(join(repoPath, 'designs', 'tiny.fa'), '>x\nA\n', 'utf8');
    await expect(
      buildWorkspaceSyncSnapshot(db, {
        workspaceUuid: 'workspace-a',
        appVersion: '0.4.0',
        capturedAt: new Date('2026-07-09T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    const preview = await previewWorkspaceSyncUpload(db, {
      workspaceUuid: 'workspace-a',
      storagePolicy: {
        schemaVersion: 1,
        policyKey: 'rollback-fixture',
        revision: 1,
        maxFileBytes: 4096,
        maxProjectBytes: 1024 * 1024,
        maxFiles: 2000,
        storageQuotaBytes: 2 * 1024 * 1024,
      },
    });
    expect(preview.excludedSummary['file-too-large'].count).toBeGreaterThan(0);
    expect(preview.includedFiles.map((file) => file.relativePath)).not.toContain(
      'designs/pUC19/pUC19.gb'
    );
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Acknowledge size-excluded package fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    db.exec(
      `CREATE TRIGGER fail_workspace_sync_excluded_product_ack
       BEFORE UPDATE OF remote_latest_version_id ON workspace_sync_bindings
       BEGIN SELECT RAISE(ABORT, 'injected excluded-product acknowledgement failure'); END`
    );
    const newerBundle = withOnlyReplacementGenBank(validBundle());
    const newerVersionId = '1ee7b1a4-d11e-443f-8aee-fdf4c820b325';

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
      })
    ).rejects.toThrow('injected excluded-product acknowledgement failure');

    expect(readFileSync(productPath, 'utf8')).toBe(productBefore);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
  });

  it('rolls the replica back if sync is disabled during the file replacement', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const productBefore = readFileSync(productPath, 'utf8');
    const snapshot = await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare disable-during-pull fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const newerBundle = withUpdatedGenBank(snapshot.bundle, 'DISABLED_DURING_PULL');
    const newerVersionId = '1d23f59e-6f0d-4a74-a5dd-5502d7d827bd';
    let disabled = false;

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: {
          ...remoteSummary(),
          latest: {
            versionId: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        latest: {
          ...latestResponse(newerBundle),
          version: {
            ...latestResponse(newerBundle).version,
            id: newerVersionId,
            versionNumber: 4,
          },
        },
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
        installFile: async (sourcePath, destinationPath) => {
          expect(hasWorkspaceSyncMutationLeaseForTest()).toBe(true);
          if (!disabled && sourcePath.includes('.dnaforge-sync-pull-')) {
            disabled = true;
            db.prepare(
              `UPDATE workspace_sync_bindings SET enabled = 0 WHERE workspace_id = 1`
            ).run();
          }
          await renameFile(sourcePath, destinationPath);
        },
      })
    ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });

    expect(disabled).toBe(true);
    expect(hasWorkspaceSyncMutationLeaseForTest()).toBe(false);
    expect(readFileSync(productPath, 'utf8')).toBe(productBefore);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(await hasWorkingChanges(repoPath)).toBe(false);
    expect(bindingRow(db)).toMatchObject({
      enabled: 0,
      remote_latest_version_id: REMOTE_VERSION_ID,
      remote_latest_version_number: 3,
    });
  });

  it('rejects a semantically malformed staged projection before changing live files', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const markerPath = join(repoPath, '.dnaforge-workspace.json');
    const productBefore = readFileSync(productPath, 'utf8');
    const markerBefore = readFileSync(markerPath, 'utf8');
    await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare malformed-projection fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const malformedPath = '.waypoint/lims/log/2026-08.jsonl';
    const newerBundle = withAddedFile(validBundle(), {
      id: 'malformed-lims-log',
      relativePath: malformedPath,
      kind: 'lims-audit-log',
      content: '{not-json}\n',
    });
    const newerVersionId = '62a71a32-21bb-41c3-a220-49736cdaf8b3';

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: {
          ...remoteSummary(),
          latest: {
            versionId: newerVersionId,
            versionNumber: 4,
            contentSha256: newerBundle.provenance.contentSha256,
          },
        },
        latest: {
          ...latestResponse(newerBundle),
          version: {
            ...latestResponse(newerBundle).version,
            id: newerVersionId,
            versionNumber: 4,
          },
        },
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
      })
    ).rejects.toThrow();

    expect(readFileSync(productPath, 'utf8')).toBe(productBefore);
    expect(readFileSync(markerPath, 'utf8')).toBe(markerBefore);
    expect(existsSync(join(repoPath, malformedPath))).toBe(false);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
  });

  it('rejects malformed notebook metadata instead of silently dropping the remote notebook', async () => {
    await openWorkspaceSyncProject(db, {
      remoteWorkspaceId: REMOTE_WORKSPACE_ID,
      managedRootDir: managedRoot,
      client,
      nowMs: () => 1000,
    });
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    const productPath = join(repoPath, 'designs', 'pUC19', 'pUC19.gb');
    const productBefore = readFileSync(productPath, 'utf8');
    await buildWorkspaceSyncSnapshot(db, {
      workspaceUuid: 'workspace-a',
      appVersion: '0.4.0',
      capturedAt: new Date('2026-07-09T00:00:00.000Z'),
    });
    const previousHead =
      (await commitAllIfDirty(repoPath, 'Prepare malformed-notebook fixture')) ??
      (await resolveHeadCommit(repoPath));
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ? WHERE workspace_id = 1`
    ).run(previousHead);
    const malformedPath = 'notes/attacker-controlled.wpnote.json';
    const newerBundle = withAddedFile(validBundle(), {
      id: 'malformed-notebook',
      relativePath: malformedPath,
      kind: 'notebook',
      contentType: 'application/json',
      content: '{"id":',
    });
    const newerVersionId = '39a94787-683c-48c7-b339-57400cae4fd6';

    await expect(
      applyLatestToExistingManagedRepo(db, {
        workspaceId: 1,
        workspaceUuid: 'workspace-a',
        repoPath,
        remote: newerRemote(newerBundle, newerVersionId),
        latest: newerLatest(newerBundle, newerVersionId),
        expectedLocalHeadSha: previousHead!,
        expectedRemoteVersionId: REMOTE_VERSION_ID,
        nowMs: 2000,
      })
    ).rejects.toThrow('notebook metadata is invalid');

    expect(readFileSync(productPath, 'utf8')).toBe(productBefore);
    expect(existsSync(join(repoPath, malformedPath))).toBe(false);
    expect(await resolveHeadCommit(repoPath)).toBe(previousHead);
    expect(bindingRow(db)).toMatchObject({ remote_latest_version_id: REMOTE_VERSION_ID });
  });

  it('reuses an existing local binding instead of downloading or duplicating a project', async () => {
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    writeFileSync(
      join(repoPath, '.dnaforge-workspace.json'),
      JSON.stringify({ schema: 1, workspaceUuid: 'workspace-a', originPath: null })
    );
    seedExistingSyncedWorkspace(db, repoPath);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2000,
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    expect(downloadLatest).not.toHaveBeenCalled();
    expect(workspaceRow(db)).toMatchObject({ last_opened_at: 2000 });
  });

  it('does not repair a healthy binding when its last-opened database write fails', async () => {
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    writeFileSync(
      join(repoPath, '.dnaforge-workspace.json'),
      JSON.stringify({ schema: 1, workspaceUuid: 'workspace-a', originPath: null })
    );
    seedExistingSyncedWorkspace(db, repoPath);
    db.exec(
      `CREATE TRIGGER fail_last_opened_update
       BEFORE UPDATE OF last_opened_at ON workspaces
       BEGIN SELECT RAISE(ABORT, 'injected last-opened failure'); END`
    );

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2010,
      })
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('injected last-opened failure'),
    });

    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(downloadLatest).not.toHaveBeenCalled();
    expect(bindingRowByUuid(db, 'workspace-a')).toMatchObject({
      remote_workspace_id: REMOTE_WORKSPACE_ID,
      enabled: 1,
    });
  });

  it('atomically repairs a saved cloud binding whose local repo has disappeared', async () => {
    seedExistingSyncedWorkspace(db, join(managedRoot, 'workspace-a', 'repo'));
    db.prepare(
      `INSERT INTO workspace_sync_merge_conflicts (
         id, workspace_id, workspace_uuid, remote_version_id, status,
         conflicts_json, payload_json, created_at, updated_at
       ) VALUES ('conflict-a', 1, 'workspace-a', ?, 'open', '[]', '{}', 1, 1)`
    ).run(REMOTE_VERSION_ID);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2000,
        createWorkspaceUuid: () => 'workspace-b',
        withReplacementSourceQuiesced: async (_workspaceUuid, operation) => operation(),
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-b' });

    expect(listWorkspaces).toHaveBeenCalledOnce();
    expect(downloadLatest).toHaveBeenCalledOnce();
    expect(workspaceRowByUuid(db, 'workspace-a')).toMatchObject({ archived_at: 2000 });
    expect(bindingRowByUuid(db, 'workspace-a')).toBeUndefined();
    expect(bindingRowByUuid(db, 'workspace-b')).toMatchObject({
      workspace_id: 1,
      remote_workspace_id: REMOTE_WORKSPACE_ID,
      enabled: 1,
    });
    const archivedWorkspace = workspaceRowByUuid(db, 'workspace-a');
    expect(
      db
        .prepare(`SELECT workspace_id FROM workspace_sync_merge_conflicts WHERE id = ?`)
        .get('conflict-a')
    ).toEqual({ workspace_id: archivedWorkspace.id });
    expect(existsSync(join(managedRoot, 'workspace-b', 'repo', '.git'))).toBe(true);
  });
  it('preserves pending publication and refuses replacement before download', async () => {
    seedExistingSyncedWorkspace(db, join(managedRoot, 'workspace-a', 'repo'));
    db.prepare(
      'INSERT INTO native_catalog_publication_outbox(operation_id, workspace_id) VALUES (?, 1)'
    ).run('publication-1');
    const tables = ['workspaces', 'workspace_sync_bindings', 'native_catalog_publication_outbox'];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2000,
        createWorkspaceUuid: () => 'workspace-b',
        withReplacementSourceQuiesced: async (_id, operation) => operation(),
      })
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/preserve.*pending publication/i),
    });
    expect(downloadLatest).not.toHaveBeenCalled();
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(existsSync(join(managedRoot, 'workspace-b'))).toBe(false);
  });

  it('quarantines a saved binding whose local marker belongs to another workspace', async () => {
    const repoPath = join(managedRoot, 'workspace-a', 'repo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    writeFileSync(
      join(repoPath, '.dnaforge-workspace.json'),
      JSON.stringify({ schema: 1, workspaceUuid: 'workspace-z', originPath: null })
    );
    seedExistingSyncedWorkspace(db, repoPath);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 2000,
        createWorkspaceUuid: () => 'workspace-b',
      })
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('invalid local workspace marker'),
    });

    expect(readFileSync(join(repoPath, '.dnaforge-workspace.json'), 'utf8')).toContain(
      'workspace-z'
    );
    expect(workspaceRowByUuid(db, 'workspace-a')).toMatchObject({ archived_at: null });
    expect(bindingRowByUuid(db, 'workspace-a')).toMatchObject({
      remote_workspace_id: REMOTE_WORKSPACE_ID,
    });
    expect(bindingRowByUuid(db, 'workspace-b')).toBeUndefined();
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(downloadLatest).not.toHaveBeenCalled();
  });

  it('refuses to open a remote project that is not visible in the synced project list', async () => {
    listWorkspaces.mockResolvedValueOnce([]);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 1000,
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('not available'),
    });

    expect(downloadLatest).not.toHaveBeenCalled();
  });

  it('allocates a fresh managed workspace id when the remote client id collides locally', async () => {
    const existingRepo = join(managedRoot, 'workspace-a', 'repo');
    seedExistingLocalWorkspace(db, existingRepo);
    const bundle = validBundle();
    downloadLatest.mockResolvedValueOnce(latestResponse(bundle));

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 3000,
        createWorkspaceUuid: () => 'workspace-b',
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-b' });

    const restoredRepo = join(managedRoot, 'workspace-b', 'repo');
    expect(existsSync(join(restoredRepo, '.git'))).toBe(true);
    expect(workspaceRowByUuid(db, 'workspace-a')).toMatchObject({ path: existingRepo });
    expect(workspaceRowByUuid(db, 'workspace-b')).toMatchObject({
      name: 'Project A',
      path: restoredRepo,
      repo_uuid: 'workspace-b',
    });
    expect(bindingRowByUuid(db, 'workspace-b')).toMatchObject({
      remote_workspace_id: REMOTE_WORKSPACE_ID,
    });
    expect(
      JSON.parse(readFileSync(join(restoredRepo, '.dnaforge-workspace.json'), 'utf8'))
    ).toMatchObject({ workspaceUuid: 'workspace-b' });
  });

  it('refuses duplicate remote version bindings before writing restored files', async () => {
    seedExistingRemoteVersion(db, REMOTE_VERSION_ID);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 4000,
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('already linked'),
    });

    expect(existsSync(join(managedRoot, 'workspace-a', 'repo'))).toBe(false);
  });

  it('rejects unsafe bundle paths before creating a local workspace shell', async () => {
    const bundle = validBundle();
    bundle.files[0] = {
      ...bundle.files[0],
      relativePath: '../escape.gb',
      name: 'escape.gb',
    };
    downloadLatest.mockResolvedValueOnce(latestResponse(bundle));

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 4250,
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('relativePath is unsafe'),
    });

    expect(existsSync(join(managedRoot, 'escape.gb'))).toBe(false);
    expect(workspaceRowByUuid(db, 'workspace-a')).toBeUndefined();
  });

  it('retires a failed restore with a symlinked path and succeeds with a fresh identity', async () => {
    const escapeRoot = mkdtempSync(join(tmpdir(), 'dnaforge-sync-escape-'));
    writeFileSync(join(escapeRoot, 'foreign-sentinel.txt'), 'FOREIGN_CONTENT', 'utf8');
    symlinkSync(escapeRoot, join(managedRoot, 'workspace-a'), 'dir');

    try {
      await expect(
        openWorkspaceSyncProject(db, {
          remoteWorkspaceId: REMOTE_WORKSPACE_ID,
          managedRootDir: managedRoot,
          client,
          nowMs: () => 4500,
          createRestoreLockId: () => 'lock-poisoned-path',
        })
      ).resolves.toMatchObject({
        ok: false,
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('already exists'),
      });

      expect(existsSync(join(escapeRoot, 'repo', 'designs', 'pUC19.gb'))).toBe(false);
      expect(workspaceRowByUuid(db, 'workspace-a')).toMatchObject({ archived_at: 4500 });
      expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
        lock_id: 'lock-poisoned-path',
        status: 'failed',
        error_message: expect.stringContaining('already exists'),
      });

      await expect(
        openWorkspaceSyncProject(db, {
          remoteWorkspaceId: REMOTE_WORKSPACE_ID,
          managedRootDir: managedRoot,
          client,
          nowMs: () => 5000,
          createWorkspaceUuid: () => 'workspace-b',
          createRestoreLockId: () => 'lock-fresh-path',
        })
      ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-b' });

      expect(realpathSync(join(managedRoot, 'workspace-a'))).toBe(realpathSync(escapeRoot));
      expect(readFileSync(join(escapeRoot, 'foreign-sentinel.txt'), 'utf8')).toBe(
        'FOREIGN_CONTENT'
      );
      expect(existsSync(join(escapeRoot, 'repo'))).toBe(false);
      expect(workspaceRowByUuid(db, 'workspace-a')).toMatchObject({ archived_at: 4500 });
      expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
        lock_id: 'lock-poisoned-path',
        status: 'canceled',
        completed_at: 5000,
        error_message: expect.stringContaining('Unusable restore path was retired'),
      });
      expect(workspaceRowByUuid(db, 'workspace-b')).toMatchObject({ archived_at: null });
      expect(restoreLockRow(db, 'workspace-b')).toMatchObject({
        lock_id: 'lock-fresh-path',
        status: 'completed',
      });
      expect(bindingRowByUuid(db, 'workspace-b')).toMatchObject({
        remote_workspace_id: REMOTE_WORKSPACE_ID,
      });
    } finally {
      rmSync(escapeRoot, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe restore lock id before reserving a managed path', async () => {
    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 4750,
        createRestoreLockId: () => '../../outside',
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('lock id is invalid'),
    });

    expect(workspaceRowByUuid(db, 'workspace-a')).toBeUndefined();
    expect(readdirSync(managedRoot)).toEqual([]);
  });

  it.each(['CON', 'con.txt', 'LPT1', 'workspace:one', 'workspace.'])(
    'rejects non-portable remote client workspace id %s before writing files',
    async (clientWorkspaceId) => {
      listWorkspaces.mockResolvedValueOnce([{ ...remoteSummary(), clientWorkspaceId }]);

      await expect(
        openWorkspaceSyncProject(db, {
          remoteWorkspaceId: REMOTE_WORKSPACE_ID,
          managedRootDir: managedRoot,
          client,
          nowMs: () => 4800,
        })
      ).resolves.toMatchObject({
        ok: false,
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('invalid local workspace id'),
      });

      expect(readdirSync(managedRoot)).toEqual([]);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM workspaces`).get()).toEqual({ count: 0 });
    }
  );

  it('marks the restore lock failed if a late database write rejects after files are restored', async () => {
    seedRemoteVersionPrimaryKeyCollision(db, REMOTE_VERSION_ID);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 5000,
        createRestoreLockId: () => 'lock-late-failure',
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
    });

    expect(existsSync(join(managedRoot, 'workspace-a', 'repo', '.git'))).toBe(true);
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      lock_id: 'lock-late-failure',
      source_remote_version_id: REMOTE_VERSION_ID,
      status: 'failed',
      started_at: 5000,
      completed_at: 5000,
    });
    expect(bindingRowByUuid(db, 'workspace-a')).toBeUndefined();

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 5500,
      })
    ).resolves.toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(
      readdirSync(managedRoot).filter((name) => name.startsWith('workspace-a.restore-recovery-'))
    ).toEqual(['workspace-a.restore-recovery-lock-late-failure']);

    db.prepare(`DELETE FROM workspace_sync_versions WHERE id = ?`).run(REMOTE_VERSION_ID);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 6000,
        createWorkspaceUuid: () => 'workspace-b',
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM workspaces WHERE repo_uuid = 'workspace-a'`).get()
    ).toEqual({ count: 1 });
    expect(workspaceRowByUuid(db, 'workspace-b')).toBeUndefined();
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      lock_id: 'lock-late-failure',
      source_remote_version_id: REMOTE_VERSION_ID,
      status: 'completed',
      started_at: 6000,
      completed_at: 6000,
    });
    expect(bindingRowByUuid(db, 'workspace-a')).toMatchObject({
      remote_workspace_id: REMOTE_WORKSPACE_ID,
    });
    expect(
      readdirSync(managedRoot).filter((name) => name.startsWith('workspace-a.restore-recovery-'))
    ).toEqual([]);
  });

  it('retries the persisted restore intent when a crash happened before path reservation', async () => {
    db.prepare(
      `INSERT INTO workspaces (
         id, name, path, repo_uuid, created_at, last_opened_at, archived_at
       ) VALUES (1, 'Project A', ?, 'workspace-a', 5000, 5000, 5000)`
    ).run(join(managedRoot, 'workspace-a', 'repo'));
    db.prepare(
      `INSERT INTO workspace_sync_restore_locks (
        workspace_id, lock_id, source_remote_version_id,
        remote_workspace_id, owner_account_id, owner_org_id, status,
        started_at, expires_at, completed_at, error_message
      ) VALUES (1, 'lock-before-reservation', ?, ?, 'account-a', NULL, 'failed', 5000, 9000, 5000,
                'Interrupted before managed path reservation.')`
    ).run(REMOTE_VERSION_ID, REMOTE_WORKSPACE_ID);
    expect(existsSync(join(managedRoot, 'workspace-a'))).toBe(false);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 7000,
        createWorkspaceUuid: () => 'workspace-b',
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    expect(workspaceRowByUuid(db, 'workspace-b')).toBeUndefined();
    expect(existsSync(join(managedRoot, 'workspace-a', 'repo', '.git'))).toBe(true);
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      lock_id: 'lock-before-reservation',
      status: 'completed',
      completed_at: 7000,
    });
  });

  it('lets another organization member resume the same failed restore intent', async () => {
    listWorkspaces.mockResolvedValueOnce([orgRemoteSummary()]);
    db.prepare(
      `INSERT INTO workspaces (
         id, name, path, repo_uuid, created_at, last_opened_at, archived_at
       ) VALUES (1, 'Organization Project', ?, 'workspace-a', 5000, 5000, 5000)`
    ).run(join(managedRoot, 'workspace-a', 'repo'));
    db.prepare(
      `INSERT INTO workspace_sync_restore_locks (
        workspace_id, lock_id, source_remote_version_id,
        remote_workspace_id, owner_account_id, owner_org_id, status,
        started_at, expires_at, completed_at, error_message
      ) VALUES (1, 'lock-org-before-reservation', ?, ?, 'account-a', 'org-a', 'failed',
                5000, 9000, 5000, 'Member A crashed before path reservation.')`
    ).run(REMOTE_VERSION_ID, REMOTE_WORKSPACE_ID);

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        getActiveAccountId: async () => 'account-b',
        nowMs: () => 7000,
        createWorkspaceUuid: () => 'workspace-b',
      })
    ).resolves.toEqual({ ok: true, workspaceUuid: 'workspace-a' });

    expect(workspaceRowByUuid(db, 'workspace-b')).toBeUndefined();
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      lock_id: 'lock-org-before-reservation',
      owner_account_id: 'account-b',
      owner_org_id: 'org-a',
      status: 'completed',
      completed_at: 7000,
    });
    expect(bindingRowByUuid(db, 'workspace-a')).toMatchObject({
      owner_account_id: 'account-b',
      owner_org_id: 'org-a',
      remote_workspace_id: REMOTE_WORKSPACE_ID,
    });
  });

  it('marks interrupted restore intents reusable before renderer work can start', () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
       VALUES (1, 'Project A', ?, 'workspace-a', 1, 1)`
    ).run(join(managedRoot, 'workspace-a', 'repo'));
    db.prepare(
      `INSERT INTO workspace_sync_restore_locks (
        workspace_id, lock_id, source_remote_version_id, status,
        started_at, expires_at, completed_at, error_message
      ) VALUES (1, 'lock-interrupted', ?, 'restoring', 5000, 9000, NULL, NULL)`
    ).run(REMOTE_VERSION_ID);

    expect(reconcileInterruptedWorkspaceRestores(db, 6000)).toBe(1);
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      lock_id: 'lock-interrupted',
      status: 'failed',
      completed_at: 6000,
      error_message: expect.stringContaining('Interrupted restore'),
    });
    expect(reconcileInterruptedWorkspaceRestores(db, 7000)).toBe(0);
  });

  it('archives a legacy failed restore shell so active-workspace consumers cannot surface it', () => {
    db.prepare(
      `INSERT INTO workspaces (
         id, name, path, repo_uuid, created_at, last_opened_at, archived_at
       ) VALUES (1, 'Legacy failed shell', ?, 'workspace-a', 4000, 4000, NULL)`
    ).run(join(managedRoot, 'workspace-a', 'repo'));
    db.prepare(
      `INSERT INTO workspace_sync_restore_locks (
        workspace_id, lock_id, source_remote_version_id, status,
        started_at, expires_at, completed_at, error_message
      ) VALUES (1, 'lock-legacy-failed', ?, 'failed', 4000, 5000, 4500, 'old failure')`
    ).run(REMOTE_VERSION_ID);

    expect(reconcileInterruptedWorkspaceRestores(db, 7000)).toBe(1);
    expect(workspaceRowByUuid(db, 'workspace-a')).toMatchObject({ archived_at: 7000 });
    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      status: 'failed',
      error_message: 'old failure',
    });
    expect(reconcileInterruptedWorkspaceRestores(db, 8000)).toBe(0);
  });

  it('rolls back notebook projections when a later restored notebook has a corrupt payload graph', async () => {
    const bundle = validBundle();
    addNotebookWithMissingPayload(bundle);
    listWorkspaces.mockResolvedValueOnce([remoteSummary(bundle)]);
    downloadLatest.mockResolvedValueOnce(latestResponse(bundle));

    await expect(
      openWorkspaceSyncProject(db, {
        remoteWorkspaceId: REMOTE_WORKSPACE_ID,
        managedRootDir: managedRoot,
        client,
        nowMs: () => 5500,
        createRestoreLockId: () => 'lock-corrupt-notebook',
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('.forge/blocks/'),
    });

    expect(restoreLockRow(db, 'workspace-a')).toMatchObject({
      lock_id: 'lock-corrupt-notebook',
      status: 'failed',
      completed_at: 5500,
    });
    expect(bindingRowByUuid(db, 'workspace-a')).toBeUndefined();
    expect(countRows(db, 'pages')).toBe(0);
    expect(countRows(db, 'catalog_entities')).toBe(0);
  });
});

function remoteSummary(bundle: WorkspaceSyncBundle = validBundle()) {
  return {
    workspaceId: REMOTE_WORKSPACE_ID,
    clientWorkspaceId: 'workspace-a',
    displayName: 'Project A',
    owner: { kind: 'personal' as const, accountId: 'account-a' },
    latest: {
      versionId: REMOTE_VERSION_ID,
      versionNumber: 3,
      contentSha256: bundle.provenance.contentSha256,
    },
    storageBytesUsed: 512,
    versionCount: 3,
    updatedAt: '2026-07-08T00:00:00.000Z',
    lastSeenAt: '2026-07-08T00:00:00.000Z',
    deviceId: 'device-a',
  };
}

function orgRemoteSummary() {
  return {
    ...remoteSummary(),
    displayName: 'Organization Project',
    owner: { kind: 'org' as const, orgId: 'org-a' },
  };
}

function latestResponse(bundle: WorkspaceSyncBundle) {
  return {
    workspaceId: REMOTE_WORKSPACE_ID,
    version: {
      id: REMOTE_VERSION_ID,
      versionNumber: 3,
      contentSha256: bundle.provenance.contentSha256,
      sizeBytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
      fileCount: bundle.files.length,
      createdAt: '2026-07-08T00:00:00.000Z',
    },
    bundle,
  };
}

function hostedSequenceBytes(): string {
  return 'LOCUS       pUC19              2686 bp    DNA     circular\nORIGIN\n//\n';
}

async function reconstructManagedSequenceRegistry(db: Database.Database, repoPath: string) {
  const packageRoot = join(repoPath, 'designs', 'pUC19');
  const markerPath = join(packageRoot, '.forge', 'plasmid.json');
  const marker = readFileSync(markerPath, 'utf8');
  const workspace = db
    .prepare<[string], { id: number }>('SELECT id FROM workspaces WHERE path = ?')
    .get(repoPath);
  if (!workspace) throw new Error('The managed project is missing.');
  const bridge = await initPlatform();
  const spies = [
    vi
      .spyOn(bridge.fs, 'readTextFile')
      .mockImplementation(async (path) => readFileSync(path, 'utf8')),
    vi.spyOn(bridge.fs, 'stat').mockImplementation(async (path) => {
      const file = statSync(path);
      const precise = statSync(path, { bigint: true });
      return {
        canonicalPath: realpathSync(path),
        size: file.size,
        isDirectory: file.isDirectory(),
        isFile: file.isFile(),
        mtime: file.mtimeMs,
        ctime: file.ctimeMs,
        mtimeNs: precise.mtimeNs.toString(),
        ctimeNs: precise.ctimeNs.toString(),
      };
    }),
    vi
      .spyOn(bridge.lims, 'queryEntities')
      .mockImplementation(async (input) => queryLimsEntitiesInDb(db, input)),
    vi.spyOn(bridge.lims, 'registerEntity').mockImplementation(async (input) => {
      const entity = await reconstructFileBackedRegistryEntity(
        db,
        { action: 'register', input },
        (work) => work()
      );
      if (!entity) throw new Error('The package has no verified file projection owner.');
      return entity;
    }),
    vi.spyOn(bridge.lims, 'updateEntity').mockImplementation(async (input) => {
      const entity = await reconstructFileBackedRegistryEntity(
        db,
        { action: 'update', input },
        (work) => work()
      );
      if (!entity) throw new Error('The package has no verified file projection owner.');
      return entity;
    }),
    vi.spyOn(bridge.lims, 'replaceOutgoingRelationships').mockImplementation(async (input) => {
      const result = await reconstructFileBackedRegistryRelationships(db, input, (work) => work());
      if (!result) throw new Error('The package has no verified relationship source.');
      return result;
    }),
  ];
  try {
    const context = {
      workspaceRoot: repoPath,
      workspaceId: workspace.id,
      workspaceScope: 'workspace-a',
    };
    const parseSource = sequencePackageEntityAdapter.parseSource;
    if (!parseSource) throw new Error('The managed sequence source parser is missing.');
    const parsed = await parseSource(marker, markerPath, statSync(markerPath).mtimeMs, context);
    const result = await reconcileEntitySnapshot(
      sequencePackageEntityAdapter,
      parsed,
      markerPath,
      context,
      {
        synchronizationStore: { read: async () => null, settle: async () => {} },
      }
    );
    expect(['created', 'updated-from-file', 'in-sync']).toContain(result.outcome);
    await sequencePackageEntityAdapter.reconcileRelationships?.(
      parsed.document,
      result.id,
      markerPath,
      context
    );
    return result;
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
  }
}

function hostedManifest(): WorkspaceSyncManifestV1 {
  const content = hostedSequenceBytes();
  const parsed = parseWorkspaceSyncManifest({
    schemaVersion: 1,
    files: [
      {
        path: 'sequences/pUC19.gb',
        contentSha256: sha256Hex(content),
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        contentType: 'application/genbank',
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.manifest;
}

function hostedManifestLatest(manifest: WorkspaceSyncManifestV1 = hostedManifest()) {
  const contentSha256 = createHash('sha256')
    .update(workspaceSyncManifestHashInput(manifest), 'utf8')
    .digest('hex');
  return {
    workspaceId: REMOTE_WORKSPACE_ID,
    version: {
      id: REMOTE_VERSION_ID,
      versionNumber: 3,
      representation: 'manifest_v1' as const,
      manifestSchemaVersion: 1 as const,
      contentSha256,
      sizeBytes: manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
      fileCount: manifest.files.length,
      createdAt: '2026-07-08T00:00:00.000Z',
      finalizedAt: '2026-07-08T00:00:01.000Z',
    },
    manifest,
    resourceIdentities: manifest.files.map((file) => ({
      path: file.path,
      resourceId: HOSTED_RESOURCE_ID,
    })),
  };
}

function hostedRemoteSummary(manifest: WorkspaceSyncManifestV1 = hostedManifest()) {
  const latest = hostedManifestLatest(manifest);
  return {
    ...remoteSummary(),
    latest: {
      versionId: REMOTE_VERSION_ID,
      versionNumber: 3,
      contentSha256: latest.version.contentSha256,
    },
  };
}

function manifestRestoreRequired(): DesktopSyncClientError {
  return new DesktopSyncClientError(
    'MANIFEST_RESTORE_REQUIRED',
    'This version requires manifest download and restore support.',
    { status: 409, retryable: false, terminal: false }
  );
}

function newerRemote(bundle: WorkspaceSyncBundle, versionId: string) {
  return {
    ...remoteSummary(),
    latest: {
      versionId,
      versionNumber: 4,
      contentSha256: bundle.provenance.contentSha256,
    },
  };
}

function newerLatest(bundle: WorkspaceSyncBundle, versionId: string) {
  return {
    ...latestResponse(bundle),
    version: {
      ...latestResponse(bundle).version,
      id: versionId,
      versionNumber: 4,
      contentSha256: bundle.provenance.contentSha256,
    },
  };
}

function validBundleV1(): WorkspaceSyncBundleV1 {
  const legacyNotebook = serializeNotebookPackageDocument(
    buildNotebookPackageDocument({
      id: 'legacy-page',
      title: 'Legacy cloud note',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'restored' }] }],
      },
      updatedAt: '2026-07-08T00:00:00.000Z',
    })
  );
  const bundle: WorkspaceSyncBundleV1 = {
    schemaVersion: 1,
    capturedAt: '2026-07-08T00:00:00.000Z',
    workspace: { id: 'workspace-a', name: 'Project A' },
    files: [
      {
        id: 'legacy-notebook',
        relativePath: 'Lab notes.wpnote.json',
        name: 'Lab notes.wpnote.json',
        kind: 'notebook',
        contentType: 'application/json',
        sizeBytes: Buffer.byteLength(legacyNotebook, 'utf8'),
        sha256: sha256Hex(legacyNotebook),
        content: legacyNotebook,
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
      appVersion: '0.3.0',
      contentSha256: '0'.repeat(64),
    },
  };
  bundle.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(bundle));
  return bundle;
}

function validBundle(): WorkspaceSyncBundleV2 {
  const content = 'LOCUS       pUC19              2686 bp    DNA     circular\nORIGIN\n//\n';
  const fileSha = sha256Hex(content);
  const canonical = serializeNotebookMarkdown({
    identity: { id: 'page-1', title: 'Lab notes', formatVersion: 2 },
    content: { type: 'doc', content: [] },
  });
  const metadata = serializeNotebookPackageMetadata(
    buildNotebookPackageMetadata({
      id: 'page-1',
      title: 'Lab notes',
      markdownFileName: 'Lab notes.md',
      updatedAt: '2026-08-25T00:00:00.000Z',
    })
  );
  const bundle: WorkspaceSyncBundleV2 = {
    schemaVersion: 2,
    capturedAt: '2026-07-08T00:00:00.000Z',
    workspace: { id: 'workspace-a', name: 'Project A' },
    files: [
      {
        id: 'file-a',
        relativePath: 'designs/pUC19.gb',
        name: 'pUC19.gb',
        kind: 'genbank',
        contentType: 'text/plain',
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        sha256: fileSha,
        content,
      },
      {
        id: 'notebook-metadata',
        relativePath: 'Lab notes/.forge/notebook.json',
        name: 'notebook.json',
        kind: 'notebook',
        contentType: 'application/json',
        sizeBytes: Buffer.byteLength(metadata, 'utf8'),
        sha256: sha256Hex(metadata),
        content: metadata,
      },
      {
        id: 'notebook-markdown',
        relativePath: 'Lab notes/Lab notes.md',
        name: 'Lab notes.md',
        kind: 'notebook',
        contentType: 'text/markdown',
        sizeBytes: Buffer.byteLength(canonical.markdown, 'utf8'),
        sha256: sha256Hex(canonical.markdown),
        content: canonical.markdown,
      },
      {
        id: 'binary-asset',
        relativePath: 'Lab notes/assets/model.bin',
        name: 'model.bin',
        kind: 'notebook',
        contentType: 'application/octet-stream',
        sizeBytes: 3,
        sha256: 'ef192b7af54e943f206ab27075ec1805384c972c9959fc5820f1fa7d5268fcef',
        content: '/wCA',
        encoding: 'base64',
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

function withUpdatedGenBank<T extends WorkspaceSyncBundle>(bundle: T, marker: string): T {
  const files = bundle.files.map((file) => {
    if (file.kind !== 'genbank') return { ...file };
    const content = `${file.content.trimEnd()}\nCOMMENT     ${marker}\n`;
    return {
      ...file,
      content,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256Hex(content),
    };
  });
  const updated: T = {
    ...bundle,
    capturedAt: '2026-07-09T00:00:00.000Z',
    files,
    provenance: {
      ...bundle.provenance,
      contentSha256: '0'.repeat(64),
    },
  };
  updated.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(updated));
  return updated;
}

function withOnlyReplacementGenBank<T extends WorkspaceSyncBundle>(bundle: T): T {
  const content = 'LOCUS       replacement         42 bp    DNA     circular\nORIGIN\n//\n';
  const replacement: T = {
    ...bundle,
    capturedAt: '2026-07-10T00:00:00.000Z',
    files: [
      {
        id: 'replacement-file',
        relativePath: 'designs/replacement.gb',
        name: 'replacement.gb',
        kind: 'genbank',
        contentType: 'text/plain',
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        sha256: sha256Hex(content),
        content,
      },
    ],
    provenance: {
      ...bundle.provenance,
      contentSha256: '0'.repeat(64),
    },
  };
  replacement.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(replacement));
  return replacement;
}

function withLegacyLimsExport<T extends WorkspaceSyncBundle>(bundle: T): T {
  const content = '{"schemaVersion":1,"historical":true}\n';
  const updated: T = {
    ...bundle,
    capturedAt: '2026-07-10T00:00:00.000Z',
    files: [
      ...bundle.files.map((file) => ({ ...file })),
      {
        id: 'legacy-lims-manifest',
        relativePath: '.waypoint/lims/manifest.json',
        name: 'manifest.json',
        kind: 'lims-manifest',
        contentType: 'application/json',
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        sha256: sha256Hex(content),
        content,
      },
    ],
    provenance: {
      ...bundle.provenance,
      contentSha256: '0'.repeat(64),
    },
  };
  updated.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(updated));
  return updated;
}

function withAddedGenBank<T extends WorkspaceSyncBundle>(
  bundle: T,
  relativePath: string,
  content: string
): T {
  const name = relativePath.split('/').at(-1) ?? 'remote.gb';
  const updated: T = {
    ...bundle,
    capturedAt: '2026-07-11T00:00:00.000Z',
    files: [
      ...bundle.files.map((file) => ({ ...file })),
      {
        id: 'added-remote-file',
        relativePath,
        name,
        kind: 'genbank',
        contentType: 'text/plain',
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        sha256: sha256Hex(content),
        content,
      },
    ],
    provenance: { ...bundle.provenance, contentSha256: '0'.repeat(64) },
  };
  updated.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(updated));
  return updated;
}

function withAddedFile<T extends WorkspaceSyncBundle>(
  bundle: T,
  input: {
    id: string;
    relativePath: string;
    kind: WorkspaceSyncBundle['files'][number]['kind'];
    contentType?: string;
    content: string;
  }
): T {
  const updated: T = {
    ...bundle,
    capturedAt: '2026-07-12T00:00:00.000Z',
    files: [
      ...bundle.files.map((file) => ({ ...file })),
      {
        id: input.id,
        relativePath: input.relativePath,
        name: input.relativePath.split('/').at(-1) ?? input.id,
        kind: input.kind,
        contentType: input.contentType ?? 'application/jsonl',
        sizeBytes: Buffer.byteLength(input.content, 'utf8'),
        sha256: sha256Hex(input.content),
        content: input.content,
      },
    ],
    provenance: { ...bundle.provenance, contentSha256: '0'.repeat(64) },
  };
  updated.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(updated));
  return updated;
}

function addNotebookWithMissingPayload(bundle: WorkspaceSyncBundleV2): void {
  const canonical = serializeNotebookMarkdown({
    identity: { id: 'page-corrupt', title: 'Z corrupt', formatVersion: 2 },
    content: {
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table',
            version: 1,
            refId: 'missing-table',
            data: { columnLabels: ['Sample'], cells: [[{ value: 'A', type: 'text' }]] },
          },
        },
      ],
    },
  });
  const metadata = serializeNotebookPackageMetadata(
    buildNotebookPackageMetadata({
      id: 'page-corrupt',
      title: 'Z corrupt',
      markdownFileName: 'Z corrupt.md',
      updatedAt: '2026-08-25T00:00:00.000Z',
    })
  );
  bundle.files.push(
    {
      id: 'corrupt-notebook-metadata',
      relativePath: 'Z corrupt/.forge/notebook.json',
      name: 'notebook.json',
      kind: 'notebook',
      contentType: 'application/json',
      sizeBytes: Buffer.byteLength(metadata, 'utf8'),
      sha256: sha256Hex(metadata),
      content: metadata,
    },
    {
      id: 'corrupt-notebook-markdown',
      relativePath: 'Z corrupt/Z corrupt.md',
      name: 'Z corrupt.md',
      kind: 'notebook',
      contentType: 'text/markdown',
      sizeBytes: Buffer.byteLength(canonical.markdown, 'utf8'),
      sha256: sha256Hex(canonical.markdown),
      content: canonical.markdown,
    }
  );
  bundle.provenance.contentSha256 = sha256Hex(workspaceSyncBundleHashInput(bundle));
}

function seedExistingSyncedWorkspace(db: Database.Database, path: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (1, 'Project A', ?, 'workspace-a', 1, 1)`
  ).run(path);
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id, enabled,
      remote_latest_version_id, remote_latest_version_number, remote_latest_content_sha256,
      last_acked_local_head_sha, created_at, updated_at
    ) VALUES (1, 'workspace-a', 'account-a', ?, 1, ?, 3, ?, 'head-a', 1, 1)`
  ).run(REMOTE_WORKSPACE_ID, REMOTE_VERSION_ID, validBundle().provenance.contentSha256);
}

function seedExistingLocalWorkspace(db: Database.Database, path: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (1, 'Local Project', ?, 'workspace-a', 1, 1)`
  ).run(path);
}

function seedExistingRemoteVersion(db: Database.Database, remoteVersionId: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (2, 'Other Project', '/managed/other/repo', 'workspace-z', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO workspace_sync_versions (
      id, workspace_id, remote_version_id, version_number, content_sha256,
      file_count, size_bytes, status, is_latest, created_at, updated_at
    ) VALUES (?, 2, ?, 3, ?, 1, 100, 'ready', 1, 1, 1)`
  ).run(remoteVersionId, remoteVersionId, validBundle().provenance.contentSha256);
}

function seedRemoteVersionPrimaryKeyCollision(
  db: Database.Database,
  remoteVersionId: string
): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (2, 'Other Project', '/managed/other/repo', 'workspace-z', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO workspace_sync_versions (
      id, workspace_id, remote_version_id, version_number, content_sha256,
      file_count, size_bytes, status, is_latest, created_at, updated_at
    ) VALUES (?, 2, 'different-remote-version', 3, ?, 1, 100, 'ready', 1, 1, 1)`
  ).run(remoteVersionId, validBundle().provenance.contentSha256);
}

function workspaceRow(db: Database.Database): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspaces WHERE repo_uuid = 'workspace-a'`).get() as Record<
    string,
    unknown
  >;
}

function workspaceRowByUuid(db: Database.Database, workspaceUuid: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspaces WHERE repo_uuid = ?`).get(workspaceUuid) as Record<
    string,
    unknown
  >;
}

function bindingRow(db: Database.Database): Record<string, unknown> {
  return db
    .prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_uuid = 'workspace-a'`)
    .get() as Record<string, unknown>;
}

function bindingRowByUuid(db: Database.Database, workspaceUuid: string): Record<string, unknown> {
  return db
    .prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_uuid = ?`)
    .get(workspaceUuid) as Record<string, unknown>;
}

function latestVersionRow(db: Database.Database): Record<string, unknown> {
  return db
    .prepare(`SELECT * FROM workspace_sync_versions WHERE workspace_id = 1 AND is_latest = 1`)
    .get() as Record<string, unknown>;
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

function countRows(db: Database.Database, table: 'pages' | 'catalog_entities'): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
