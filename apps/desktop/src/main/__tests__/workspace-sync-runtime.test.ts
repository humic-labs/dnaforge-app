import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import {
  workspaceSyncBundleHashInput,
  workspaceSyncManifestHashInput,
  type WorkspaceSyncBundleV1,
  type WorkspaceSyncManifestV1,
} from '@waypoint/share-bundle';

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
import type { DesktopSyncWorkspaceSummaryResponse } from '../workspace-sync-projects';
import { setDirtyState } from '../dirty-state-cache';
import { enqueueWorkspaceSyncJob } from '../workspace-sync-queue';
import { WorkspaceSyncRuntime, type WorkspaceSyncRuntimeWatcher } from '../workspace-sync-runtime';
import {
  __resetWorkspaceSyncObservationForTests,
  bindWorkspaceSyncObservationSink,
  type WorkspaceSyncObservation,
} from '../workspace-sync-observation';
import {
  readPendingWorkspaceSyncRendererRefresh,
  recordPendingWorkspaceSyncRendererRefresh,
} from '../workspace-sync-renderer-refresh-pending';
import { hasWorkspaceSyncMutationLeaseForTest } from '../workspace-sync-mutation-lease';
import { createTestDb } from './test-db';
import { prepareWorkspaceSyncProjection } from '../workspace-sync-projection';
import {
  ManagedWorkspaceSyncWatcher,
  type ManagedWorkspaceSyncChangeEvent,
} from '../workspace-sync-watcher';

const CONTENT_A = 'a'.repeat(64);
const BASE_CONTENT = 'b'.repeat(64);
const execFileAsync = promisify(execFile);

describe('workspace sync runtime', () => {
  let db: Database.Database;
  let seedRoot: string;
  let fixtureRoot: string;
  let workspacePath: string;
  let nowMs: number;
  let createVersion: ReturnType<typeof vi.fn>;
  let snapshotWorkspace: ReturnType<typeof vi.fn>;
  let uploadSnapshotFixture: ReturnType<typeof validUploadSnapshot>;
  let watcher: WorkspaceSyncRuntimeWatcher;
  let interval: { callback: () => void | Promise<void>; ms: number; cleared: boolean } | null;
  let activeAccountId: string | null;
  const runtimes: WorkspaceSyncRuntime[] = [];
  let syncObservations: WorkspaceSyncObservation[];

  beforeAll(async () => {
    seedRoot = mkdtempSync(join(tmpdir(), 'ws-sync-runtime-seed-'));
    await execFileAsync('git', ['init'], { cwd: seedRoot });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: seedRoot });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: seedRoot });
    writeFileSync(join(seedRoot, 'README.md'), 'seed\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: seedRoot });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: seedRoot });
  });

  afterAll(() => {
    rmSync(seedRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    __resetWorkspaceSyncObservationForTests();
    for (const runtime of runtimes.splice(0)) await runtime.stop();
    db.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    syncObservations = [];
    bindWorkspaceSyncObservationSink((observation) => syncObservations.push(observation));
    setDirtyState({ hasDirtyWork: false, details: '' });
    db = createTestDb();
    ensureSchema(db, ':memory:');
    fixtureRoot = mkdtempSync(join(tmpdir(), 'ws-sync-runtime-'));
    workspacePath = join(fixtureRoot, 'workspace');

    cpSync(seedRoot, workspacePath, { recursive: true, force: false, errorOnExist: true });
    nowMs = 100;
    uploadSnapshotFixture = validUploadSnapshot('workspace-a', 'head-a');
    createVersion = vi.fn(async () =>
      readyVersion(
        'remote-version-a',
        2,
        uploadSnapshotFixture.contentSha256,
        uploadSnapshotFixture.bundleSizeBytes,
        uploadSnapshotFixture.includedFileCount
      )
    );
    snapshotWorkspace = vi.fn(async () => uploadSnapshotFixture);
    activeAccountId = 'account-a';
    watcher = {
      ensureWatching: vi.fn(async () => undefined),
      stopAll: vi.fn(),
    };
    interval = null;
    seedSyncWorkspace(db, workspacePath);
  });

  it('keeps startup upload work queued until the renderer is ready and then delivers once', async () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:head-a',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });
    let ready = false;
    const runtime = makeRuntime({ isRendererReady: () => ready });
    await expect(runtime.start()).resolves.toMatchObject({ drain: { processed: 0 } });
    expect(snapshotWorkspace).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
    expect(queueRow(db, 'queue-a').status).toBe('pending');
    await expect(runtime.runDueUploads()).resolves.toMatchObject({ processed: 0 });
    ready = true;
    await expect(runtime.runDueUploads()).resolves.toMatchObject({ processed: 1, uploaded: 1 });
    expect(createVersion).toHaveBeenCalledOnce();
    expect(queueRow(db, 'queue-a').status).toBe('succeeded');
  });

  it('retains coalesced watcher edits before readiness even after the fingerprint advances', async () => {
    let ready = false;
    let changed: ((event: ManagedWorkspaceSyncChangeEvent) => void) | undefined;
    const pendingTimers: Array<() => void | Promise<void>> = [];
    const emitChanged = vi
      .spyOn(ManagedWorkspaceSyncWatcher.prototype, 'ensureWatching')
      .mockImplementation(async function (
        this: ManagedWorkspaceSyncWatcher,
        workspaceUuid: string
      ) {
        const deps: unknown = Reflect.get(this, 'deps');
        if (
          !deps ||
          typeof deps !== 'object' ||
          !('onWorkspaceChanged' in deps) ||
          typeof deps.onWorkspaceChanged !== 'function'
        ) {
          throw Error('Real workspace watcher has no change callback');
        }
        const onWorkspaceChanged = deps.onWorkspaceChanged;
        changed = (event) => onWorkspaceChanged(event);
        return {
          workspaceUuid,
          workspaceId: 1,
          repoPath: workspacePath,
          nativeWatchActive: false,
          pollFallbackActive: false,
          reused: false,
        };
      });
    const runtime = makeRuntime({
      isRendererReady: () => ready,
      realWatcher: true,
      setDebounceTimer: (callback) => {
        pendingTimers.push(callback);
        return callback;
      },
    });
    try {
      await runtime.start();
      expect(changed).toBeDefined();
      const event: ManagedWorkspaceSyncChangeEvent = {
        workspaceUuid: 'workspace-a',
        workspaceId: 1,
        repoPath: workspacePath,
        reason: 'poll_changed',
        emittedAt: nowMs,
      };
      changed?.(event);
      changed?.(event);
      expect(snapshotWorkspace).not.toHaveBeenCalled();
      expect(db.prepare('SELECT count(*) AS count FROM workspace_sync_queue').get()).toEqual({
        count: 0,
      });
      ready = true;
      await runtime.runDueUploads();
      expect(pendingTimers).toHaveLength(1);

      ready = false;
      await pendingTimers.shift()?.();
      expect(snapshotWorkspace).not.toHaveBeenCalled();
      expect(createVersion).not.toHaveBeenCalled();
      ready = true;
      await runtime.runDueUploads();
      expect(pendingTimers).toHaveLength(1);
      await pendingTimers.shift()?.();
      await runtime.waitForIdle();
      expect(createVersion).toHaveBeenCalledOnce();
      await runtime.runDueUploads();
      expect(createVersion).toHaveBeenCalledOnce();
    } finally {
      emitChanged.mockRestore();
    }
  });

  it('does not turn a reconstructed local Registry export into an unacknowledged shared edit', async () => {
    prepareWorkspaceSyncProjection(db, { workspaceId: 1, workspaceRoot: workspacePath });
    execFileSync('git', ['add', '-A'], { cwd: workspacePath });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'Accepted native projection'], {
      cwd: workspacePath,
    });
    const acceptedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspacePath,
      encoding: 'utf8',
    }).trim();
    db.prepare('UPDATE workspace_sync_bindings SET last_acked_local_head_sha = ?').run(
      acceptedHead
    );
    const exportDirectory = join(workspacePath, '.waypoint/lims/log');
    mkdirSync(exportDirectory, { recursive: true });
    const localExport = '{"localRegistryProjection":"preserve exact bytes"}\n';
    writeFileSync(join(exportDirectory, '2026-10.jsonl'), localExport);

    const runtime = makeRuntime({
      getCurrentLocalHeadSha: () =>
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: workspacePath,
          encoding: 'utf8',
        }).trim(),
    });
    await expect(runtime.flushWorkspace('workspace-a')).resolves.toEqual({ status: 'idle' });
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: workspacePath,
        encoding: 'utf8',
      }).trim()
    ).toBe(acceptedHead);
    expect(readFileSync(join(exportDirectory, '2026-10.jsonl'), 'utf8')).toBe(localExport);
    expect(bindingState(db).last_acked_local_head_sha).toBe(acceptedHead);
    expect(queueCount(db)).toBe(0);
    expect(snapshotWorkspace).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('retries the same durable offline upload after a runtime restart when backoff is due', async () => {
    createVersion.mockRejectedValueOnce(
      Object.assign(new Error('offline'), { code: 'NETWORK', retryable: true })
    );
    const beforeRestart = makeRuntime();

    await beforeRestart.flushWorkspace('workspace-a');

    expect(queueRow(db, 'queue-a')).toMatchObject({
      status: 'retry_wait',
      next_attempt_at: 5100,
      attempt_count: 1,
      error_code: 'NETWORK',
    });
    beforeRestart.stop();

    nowMs = 5100;
    const afterRestart = makeRuntime();
    await afterRestart.start();

    expect(queueCount(db)).toBe(1);
    expect(createVersion).toHaveBeenCalledTimes(2);
    expect(queueRow(db, 'queue-a')).toMatchObject({
      status: 'succeeded',
      attempt_count: 2,
      locked_at: null,
      locked_by_device_id: null,
    });
    expect(bindingState(db)).toMatchObject({
      remote_latest_version_id: 'remote-version-a',
      last_acked_local_head_sha: 'head-a',
    });
    expect(syncObservations).toEqual([
      expect.objectContaining({
        feature_area: 'workspace',
        sync_operation: 'upload',
        sync_outcome: 'retry_wait',
        error_code: 'network',
        sync_attempt_count: 1,
        is_first_upload: false,
      }),
      expect.objectContaining({
        sync_operation: 'upload',
        sync_outcome: 'uploaded',
        sync_attempt_count: 2,
        duration_ms: expect.any(Number),
      }),
    ]);
    expect(JSON.stringify(syncObservations)).not.toMatch(/workspace-a|remote-version|head-a/);
  });

  it.each([
    { runtimeDevice: 'device-a', recovered: 1, status: 'succeeded' },
    { runtimeDevice: 'device-b', recovered: 0, status: 'running' },
  ])(
    'startup recovers a recent upload only for admitted $runtimeDevice',
    async ({ runtimeDevice, recovered, status }) => {
      enqueueWorkspaceSyncJob(db, {
        id: 'queue-a',
        workspaceId: 1,
        operation: 'upload',
        idempotencyKey: 'upload:workspace-a:remote-base-a:head-a',
        baseRemoteVersionId: 'remote-base-a',
        localHeadSha: 'head-a',
        nowMs: 100,
      });
      db.prepare(
        `UPDATE workspace_sync_queue SET status = 'running', attempt_count = 1,
      locked_at = 100, locked_by_device_id = ?, updated_at = 100 WHERE id = 'queue-a'`
      ).run('device-a');
      nowMs = 101;
      const runtime = makeRuntime({ staleLockMs: 30_000, deviceId: runtimeDevice });
      const result = await runtime.start();
      expect(result.recovery.staleReclaimed).toBe(recovered);
      expect(createVersion).toHaveBeenCalledTimes(recovered);
      expect(queueRow(db, 'queue-a').status).toBe(status);
    }
  );

  it('reclaims a stale running upload lock on startup before retrying due work', async () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:head-a',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'running',
           attempt_count = 1,
           locked_at = 100,
           locked_by_device_id = 'device-a',
           updated_at = 100
       WHERE id = 'queue-a'`
    ).run();
    nowMs = 1000;
    const runtime = makeRuntime({ staleLockMs: 500 });

    const result = await runtime.start();

    expect(result.recovery).toMatchObject({ staleReclaimed: 1 });
    expect(createVersion).toHaveBeenCalledTimes(1);
    expect(queueRow(db, 'queue-a')).toMatchObject({
      status: 'succeeded',
      attempt_count: 2,
      locked_at: null,
      locked_by_device_id: null,
      error_code: null,
    });
  });

  it('does not reclaim an active upload after its durable lock crosses the stale threshold', async () => {
    let releaseUpload: (() => void) | undefined;
    createVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () =>
            resolve(
              readyVersion(
                'remote-version-a',
                2,
                uploadSnapshotFixture.contentSha256,
                uploadSnapshotFixture.bundleSizeBytes,
                uploadSnapshotFixture.includedFileCount
              )
            );
        })
    );
    const runtime = makeRuntime({ staleLockMs: 500 });
    const upload = runtime.flushWorkspace('workspace-a');
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());

    nowMs = 1_000;
    await expect(runtime.runDueUploads()).resolves.toMatchObject({ processed: 0 });
    expect(createVersion).toHaveBeenCalledTimes(1);
    expect(queueRow(db, 'queue-a')).toMatchObject({
      status: 'running',
      attempt_count: 1,
      locked_at: 100,
    });

    invokeDeferred(releaseUpload);
    await expect(upload).resolves.toMatchObject({ status: 'uploaded' });
    expect(queueRow(db, 'queue-a')).toMatchObject({
      status: 'succeeded',
      attempt_count: 1,
    });
  });

  it('unblocks account-paused durable work after sign-in and uploads on the next retry tick', async () => {
    activeAccountId = null;
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-a',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:head-a',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-a',
      nowMs: 100,
    });
    const runtime = makeRuntime();

    await runtime.start();

    expect(queueRow(db, 'queue-a')).toMatchObject({
      status: 'blocked',
      error_code: 'ACCOUNT_PAUSED',
    });
    expect(createVersion).not.toHaveBeenCalled();

    activeAccountId = 'account-a';
    nowMs = 200;
    await interval?.callback();

    expect(queueRow(db, 'queue-a')).toMatchObject({
      status: 'succeeded',
      attempt_count: 1,
      error_code: null,
    });
    expect(createVersion).toHaveBeenCalledTimes(1);
  });

  it('keeps an unpublished zero-valued API claim eligible for its first upload', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings SET remote_latest_version_id = NULL,
       remote_latest_version_number = NULL, remote_latest_content_sha256 = NULL,
       last_acked_local_head_sha = NULL WHERE workspace_id = 1`
    ).run();
    const remote = newerRemoteSummary();
    remote.latest = { versionId: null, versionNumber: 0, contentSha256: null };
    remote.versionCount = 0;
    remote.storageBytesUsed = 0;
    const downloadLatest = vi.fn();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [remote],
        downloadLatest,
      },
    });
    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      pulled: 0,
      failed: 0,
      skipped: 1,
    });
    expect(downloadLatest).not.toHaveBeenCalled();
    expect(queueCount(db)).toBe(0);
  });

  it('reads the assigned policy through the production default capture before reading files', async () => {
    const readStoragePolicy = vi.fn(async () => {
      throw new Error('Assigned policy is unavailable.');
    });
    const workspaceUuid = '11111111-1111-4111-8111-111111111111';
    db.prepare('UPDATE workspaces SET repo_uuid = ? WHERE id = 1').run(workspaceUuid);
    db.prepare('UPDATE workspace_sync_bindings SET workspace_uuid = ? WHERE workspace_id = 1').run(
      workspaceUuid
    );
    const runtime = new WorkspaceSyncRuntime(db, {
      deviceId: 'device-a',
      appVersion: '0.4.0',
      watcher,
      getActiveAccountId: () => activeAccountId,
      getCurrentLocalHeadSha: () => 'head-a',
      commitWorkingTreeIfDirty: async () => null,
      client: { supportsManifest: true, readStoragePolicy, createVersion },
    });
    runtimes.push(runtime);
    await expect(runtime.flushWorkspace(workspaceUuid)).rejects.toThrow(
      'Assigned policy is unavailable.'
    );
    expect(readStoragePolicy).toHaveBeenCalledWith('remote-workspace-a', 'account-a');
    expect(createVersion).not.toHaveBeenCalled();
    expect(queueCount(db)).toBe(0);
  });

  it('delivers a private mixed-resource manifest through the metadata reader before replica installation', async () => {
    db.prepare(
      "UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1"
    ).run();
    const manifest: WorkspaceSyncManifestV1 = {
      schemaVersion: 1,
      files: [
        {
          path: 'notes.txt',
          contentSha256: '1'.repeat(64),
          sizeBytes: 48,
          contentType: 'text/plain',
        },
        {
          path: 'pUC19/pUC19.gb',
          contentSha256: '2'.repeat(64),
          sizeBytes: 8033,
          contentType: 'text/plain',
        },
        {
          path: 'preview.png',
          contentSha256: '3'.repeat(64),
          sizeBytes: 96,
          contentType: 'image/png',
        },
      ],
    };
    const digest = createHash('sha256')
      .update(workspaceSyncManifestHashInput(manifest))
      .digest('hex');
    const latest = {
      workspaceId: 'remote-workspace-a',
      version: {
        id: 'remote-version-b',
        versionNumber: 3,
        contentSha256: digest,
        representation: 'manifest_v1' as const,
        manifestSchemaVersion: 1 as const,
        sizeBytes: 8177,
        fileCount: 3,
        createdAt: '2026-07-08T00:00:00.000Z',
        finalizedAt: '2026-07-08T00:00:01.000Z',
      },
      manifest,
      resourceIdentities: manifest.files.map((file, index) => ({
        path: file.path,
        resourceId: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${index + 1}`,
      })),
    };
    const remote = newerRemoteSummary();
    remote.latest.contentSha256 = digest;
    const downloadLatest = vi.fn(async () => {
      throw new Error('Legacy bundle rejects notes and images.');
    });
    const downloadLatestForRestore = vi.fn(async () => latest);
    const downloadManifestFile = vi.fn();
    const applyRemoteLatest = vi.fn();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [remote],
        downloadLatest,
        downloadLatestForRestore,
        downloadManifestFile,
      },
      applyRemoteLatest,
    });
    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      pulled: 1,
      failed: 0,
    });
    expect(downloadLatestForRestore).toHaveBeenCalledWith(
      'remote-workspace-a',
      expect.any(AbortSignal)
    );
    expect(downloadLatest).not.toHaveBeenCalled();
    expect(downloadManifestFile).not.toHaveBeenCalled();
    expect(applyRemoteLatest).toHaveBeenCalledWith(
      expect.objectContaining({ latest, downloadManifestFile })
    );
  });

  it('admits an incoming version when only untracked local Registry bookkeeping changed', async () => {
    db.prepare(
      "UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1"
    ).run();
    mkdirSync(join(workspacePath, '.waypoint', 'lims'), { recursive: true });
    writeFileSync(join(workspacePath, '.waypoint', 'lims', 'manifest.json'), '{"local":true}\n');
    const applyRemoteLatest = vi.fn(async () => undefined);
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [newerRemoteSummary()],
        downloadLatest: async () => ({
          workspaceId: 'remote-workspace-a',
          version: {
            id: 'remote-version-b',
            versionNumber: 3,
            contentSha256: CONTENT_A,
            sizeBytes: 12,
            fileCount: 1,
            createdAt: '2026-07-08T00:00:00.000Z',
          },
          bundle: snapshot('workspace-a', CONTENT_A, 'head-a').bundle,
        }),
      },
      applyRemoteLatest,
    });
    await runtime.start();
    expect(applyRemoteLatest).toHaveBeenCalledOnce();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_sync_queue WHERE error_code = 'SYNC_CONFLICT'"
        )
        .get()
    ).toEqual({ count: 0 });
    expect(readFileSync(join(workspacePath, '.waypoint', 'lims', 'manifest.json'), 'utf8')).toBe(
      '{"local":true}\n'
    );
  });

  it('pulls a newer remote version onto a clean open workspace', async () => {
    const downloadLatest = vi.fn(async () => ({
      workspaceId: 'remote-workspace-a',
      version: {
        id: 'remote-version-b',
        versionNumber: 3,
        contentSha256: CONTENT_A,
        sizeBytes: 12,
        fileCount: 1,
        createdAt: '2026-07-08T00:00:00.000Z',
      },
      bundle: snapshot('workspace-a', CONTENT_A, 'head-a').bundle,
    }));
    const publishReplicaApplied = vi.fn(async () => undefined);
    const applyRemoteLatest = vi.fn(async (input) => {
      await input.onReplicaApplied?.(null, {
        workspaceUuid: input.workspaceUuid,
        workspaceRoot: input.repoPath,
        remoteVersionId: input.latest.version.id,
        changedPaths: [join(input.repoPath, 'design.gb')],
        deletedPaths: [],
        affectedNotebookIds: [],
        affectedDesignIds: [],
        deletedDesignIds: [],
      });
    });
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    ).run();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [
          {
            workspaceId: 'remote-workspace-a',
            clientWorkspaceId: 'workspace-a',
            displayName: 'Project A',
            owner: { kind: 'personal', accountId: 'account-a' },
            latest: {
              versionId: 'remote-version-b',
              versionNumber: 3,
              contentSha256: CONTENT_A,
            },
            storageBytesUsed: 12,
            versionCount: 2,
            updatedAt: '2026-07-08T00:00:00.000Z',
            lastSeenAt: '2026-07-08T00:00:00.000Z',
            deviceId: 'device-b',
          },
        ],
        downloadLatest,
      },
      applyRemoteLatest,
      publishReplicaApplied,
    });

    await runtime.start();

    expect(downloadLatest).toHaveBeenCalledWith('remote-workspace-a', expect.any(AbortSignal));
    expect(applyRemoteLatest).toHaveBeenCalledOnce();
    expect(applyRemoteLatest.mock.calls[0][0]).toMatchObject({
      workspaceUuid: 'workspace-a',
      latest: { version: { id: 'remote-version-b' } },
    });
    expect(publishReplicaApplied).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        workspaceUuid: 'workspace-a',
        remoteVersionId: 'remote-version-b',
      })
    );
    expect(syncObservations).toContainEqual({
      feature_area: 'workspace',
      sync_operation: 'pull',
      sync_outcome: 'pulled',
      is_shared: false,
      sync_access_role: expect.any(String),
      size_bucket: '1_10kb',
      file_count_bucket: '1',
      sync_representation: 'unknown',
    });
  });

  it.each([null, 'account-b'])(
    'never delivers account A screen state while signed in as %s',
    async (account) => {
      db.exec(
        `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
      );
      recordPendingWorkspaceSyncRendererRefresh(db, {
        workspaceId: 1,
        localHeadSha: 'head-a',
        nowMs: 90,
        notice: {
          workspaceUuid: 'workspace-a',
          workspaceRoot: workspacePath,
          remoteVersionId: 'remote-base-a',
          changedPaths: [],
          deletedPaths: [],
          affectedNotebookIds: [],
          affectedDesignIds: [],
          deletedDesignIds: [],
        },
      });
      activeAccountId = account;
      const prepareReplicaApply = vi.fn(async () => 'unexpected-delivery');
      const publishReplicaApplied = vi.fn(async () => undefined);
      const runtime = makeRuntime({ prepareReplicaApply, publishReplicaApplied });
      await runtime.pullNewerRemotes();
      expect(prepareReplicaApply).not.toHaveBeenCalled();
      expect(publishReplicaApplied).not.toHaveBeenCalled();
      expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).not.toBeNull();
    }
  );

  it('replays a durable committed renderer refresh before treating an equal remote as complete', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = 'remote-version-b',
           remote_latest_version_number = 3,
           remote_latest_content_sha256 = ?,
           last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run(CONTENT_A);
    recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId: 1,
      localHeadSha: 'head-a',
      notice: {
        workspaceUuid: 'workspace-a',
        workspaceRoot: workspacePath,
        remoteVersionId: 'remote-version-b',
        changedPaths: [join(workspacePath, 'design.gb')],
        deletedPaths: [],
        affectedNotebookIds: ['notebook-a'],
        affectedDesignIds: [],
        deletedDesignIds: [],
      },
      nowMs: 90,
    });
    const prepareReplicaApply = vi.fn(async () => {
      expect(hasWorkspaceSyncMutationLeaseForTest(workspacePath)).toBe(true);
      return 'renderer-replay-a';
    });
    const publishReplicaApplied = vi.fn(async () => {
      expect(hasWorkspaceSyncMutationLeaseForTest(workspacePath)).toBe(true);
    });
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [
          {
            ...newerRemoteSummary(),
            latest: {
              versionId: 'remote-version-b',
              versionNumber: 3,
              contentSha256: CONTENT_A,
            },
          },
        ],
        downloadLatest: vi.fn(),
      },
      prepareReplicaApply,
      publishReplicaApplied,
    });

    publishReplicaApplied.mockRejectedValueOnce(new Error('viewer acknowledgement interrupted'));
    await expect(runtime.resumeCommittedRendererRefresh('workspace-a')).rejects.toThrow(
      'viewer acknowledgement interrupted'
    );
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).not.toBeNull();
    await runtime.resumeCommittedRendererRefresh('workspace-a');
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      failed: 0,
      skipped: 1,
    });
    expect(prepareReplicaApply).toHaveBeenCalledWith({
      workspaceUuid: 'workspace-a',
      workspaceRoot: workspacePath,
      remoteVersionId: 'remote-version-b',
      affectedNotebookIds: ['notebook-a'],
      affectedDesignIds: [],
    });
    expect(publishReplicaApplied).toHaveBeenCalledWith(
      'renderer-replay-a',
      expect.objectContaining({ remoteVersionId: 'remote-version-b' })
    );
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();
  });

  it('uploads one local catch-up after a committed renderer refresh quarantine settles', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = 'remote-version-b',
           remote_latest_version_number = 3,
           remote_latest_content_sha256 = ?,
           last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run(CONTENT_A);
    recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId: 1,
      localHeadSha: 'head-a',
      notice: {
        workspaceUuid: 'workspace-a',
        workspaceRoot: workspacePath,
        remoteVersionId: 'remote-version-b',
        changedPaths: [join(workspacePath, 'design.gb')],
        deletedPaths: [],
        affectedNotebookIds: [],
        affectedDesignIds: [],
        deletedDesignIds: [],
      },
      nowMs: 90,
    });
    uploadSnapshotFixture = validUploadSnapshot('workspace-a', 'head-b');
    const runtime = makeRuntime({
      getCurrentLocalHeadSha: () => 'head-b',
      replicaClient: {
        listWorkspaces: async () => [
          {
            ...newerRemoteSummary(),
            latest: {
              versionId: 'remote-version-b',
              versionNumber: 3,
              contentSha256: CONTENT_A,
            },
          },
        ],
        downloadLatest: vi.fn(),
      },
      prepareReplicaApply: async () => 'renderer-replay-catch-up',
      publishReplicaApplied: vi.fn(async () => undefined),
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({ failed: 0 });
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());

    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();
    expect(createVersion).toHaveBeenCalledWith(
      expect.objectContaining({ baseVersionId: 'remote-version-b' }),
      expect.any(AbortSignal)
    );
  });

  it('does not clear a durable refresh when the renderer is unavailable on an equal-version poll', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = 'remote-version-b',
           remote_latest_version_number = 3,
           remote_latest_content_sha256 = ?,
           last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run(CONTENT_A);
    recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId: 1,
      localHeadSha: 'head-a',
      notice: {
        workspaceUuid: 'workspace-a',
        workspaceRoot: workspacePath,
        remoteVersionId: 'remote-version-b',
        changedPaths: [join(workspacePath, 'design.gb')],
        deletedPaths: [],
        affectedNotebookIds: [],
        affectedDesignIds: [],
        deletedDesignIds: [],
      },
      nowMs: 90,
    });
    const downloadLatest = vi.fn();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [
          {
            ...newerRemoteSummary(),
            latest: {
              versionId: 'remote-version-b',
              versionNumber: 3,
              contentSha256: CONTENT_A,
            },
          },
        ],
        downloadLatest,
      },
      prepareReplicaApply: async () => null,
      publishReplicaApplied: vi.fn(async () => undefined),
      createJobId: () => 'renderer-replay-failure',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      failed: 1,
      skipped: 0,
    });
    expect(downloadLatest).not.toHaveBeenCalled();
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).not.toBeNull();
    expect(
      db
        .prepare(
          `SELECT state, last_error_code FROM workspace_sync_renderer_deliveries WHERE workspace_id = 1`
        )
        .get()
    ).toEqual({
      state: 'pending',
      last_error_code: 'RENDERER_DELIVERY_FAILED',
    });
  });

  it('defers startup replay until the screen is ready and then settles without waiting for the remote polling interval', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET remote_latest_version_id = 'remote-version-b',
           remote_latest_version_number = 3,
           remote_latest_content_sha256 = ?,
           last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run(CONTENT_A);
    recordPendingWorkspaceSyncRendererRefresh(db, {
      workspaceId: 1,
      localHeadSha: 'head-a',
      notice: {
        workspaceUuid: 'workspace-a',
        workspaceRoot: workspacePath,
        remoteVersionId: 'remote-version-b',
        changedPaths: [],
        deletedPaths: [],
        affectedNotebookIds: [],
        affectedDesignIds: [],
        deletedDesignIds: [],
      },
      nowMs: 90,
    });
    let rendererReady = false;
    const prepareReplicaApply = vi.fn(async () => (rendererReady ? 'ready-screen-replay' : null));
    const publishReplicaApplied = vi.fn(async () => undefined);
    const listWorkspaces = vi.fn(async () => []);
    const runtime = makeRuntime({
      isRendererReady: () => rendererReady,
      prepareReplicaApply,
      publishReplicaApplied,
      replicaClient: { listWorkspaces, downloadLatest: vi.fn() },
    });

    await runtime.start();
    expect(prepareReplicaApply).not.toHaveBeenCalled();
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT state, last_error_code FROM workspace_sync_renderer_deliveries WHERE workspace_id = 1`
        )
        .get()
    ).toEqual({ state: 'pending', last_error_code: null });
    expect(createVersion).not.toHaveBeenCalled();

    rendererReady = true;
    await runtime.pullNewerRemotes();
    expect(nowMs).toBe(100);
    expect(publishReplicaApplied).toHaveBeenCalledOnce();
    expect(readPendingWorkspaceSyncRendererRefresh(db, 1)).toBeNull();
    expect(createVersion).not.toHaveBeenCalled();
  });

  it.each([2, 3])(
    'fails closed when remote version %i is non-newer but has a different id',
    async (versionNumber) => {
      const downloadLatest = vi.fn();
      const applyRemoteLatest = vi.fn();
      db.prepare(
        `UPDATE workspace_sync_bindings
       SET remote_latest_version_number = 3,
           last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
      ).run();
      const remote = newerRemoteSummary();
      remote.latest.versionNumber = versionNumber;
      const runtime = makeRuntime({
        replicaClient: {
          listWorkspaces: async () => [remote],
          downloadLatest,
        },
        applyRemoteLatest,
        createJobId: () => `pull-version-identity-conflict-${versionNumber}`,
      });

      const result = await runtime.pullNewerRemotes();

      expect(result).toMatchObject({ checked: 1, pulled: 0, failed: 1 });
      expect(downloadLatest).not.toHaveBeenCalled();
      expect(applyRemoteLatest).not.toHaveBeenCalled();
      expect(queueRow(db, `pull-version-identity-conflict-${versionNumber}`)).toMatchObject({
        operation: 'refresh',
        status: 'failed',
        error_code: 'REMOTE_PULL_INVALID',
      });
    }
  );

  it.each([
    { label: 'version number', versionNumber: 2, contentSha256: BASE_CONTENT },
    { label: 'content hash', versionNumber: 1, contentSha256: CONTENT_A },
  ])(
    'fails closed when a reused remote version id changes its $label',
    async ({ versionNumber, contentSha256 }) => {
      const downloadLatest = vi.fn();
      const applyRemoteLatest = vi.fn();
      const remote = newerRemoteSummary();
      remote.latest = {
        versionId: 'remote-base-a',
        versionNumber,
        contentSha256,
      };
      const runtime = makeRuntime({
        replicaClient: {
          listWorkspaces: async () => [remote],
          downloadLatest,
        },
        applyRemoteLatest,
        createJobId: () => `pull-reused-version-${versionNumber}-${contentSha256}`,
      });

      const result = await runtime.pullNewerRemotes();

      expect(result).toMatchObject({ checked: 1, pulled: 0, failed: 1, skipped: 0 });
      expect(downloadLatest).not.toHaveBeenCalled();
      expect(applyRemoteLatest).not.toHaveBeenCalled();
      expect(queueRow(db, `pull-reused-version-${versionNumber}-${contentSha256}`)).toMatchObject({
        operation: 'refresh',
        status: 'failed',
        error_code: 'REMOTE_PULL_INVALID',
      });
    }
  );

  it('does not inspect or pull a binding owned by another account', async () => {
    const downloadLatest = vi.fn(async () => ({
      workspaceId: 'remote-workspace-a',
      version: {
        id: 'remote-version-b',
        versionNumber: 3,
        contentSha256: CONTENT_A,
        sizeBytes: 12,
        fileCount: 0,
        createdAt: '2026-07-08T00:00:00.000Z',
      },
      bundle: snapshot('workspace-a', CONTENT_A, 'head-a').bundle,
    }));
    const applyRemoteLatest = vi.fn();
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET owner_account_id = 'account-b',
           last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [newerRemoteSummary()],
        downloadLatest,
      },
      applyRemoteLatest,
    });

    await expect(runtime.pullNewerRemotes()).resolves.toEqual({
      checked: 0,
      pulled: 0,
      conflicts: 0,
      failed: 0,
      skipped: 0,
    });
    expect(downloadLatest).not.toHaveBeenCalled();
    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueCount(db)).toBe(0);
  });

  it('abandons a pull when the active account changes while listing remotes', async () => {
    const downloadLatest = vi.fn();
    const applyRemoteLatest = vi.fn();
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => {
          activeAccountId = 'account-b';
          return [newerRemoteSummary()];
        },
        downloadLatest,
      },
      applyRemoteLatest,
    });

    await expect(runtime.pullNewerRemotes()).resolves.toEqual({
      checked: 0,
      pulled: 0,
      conflicts: 0,
      failed: 0,
      skipped: 0,
    });
    expect(downloadLatest).not.toHaveBeenCalled();
    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueCount(db)).toBe(0);
  });

  it('does not apply a downloaded remote after the active account changes', async () => {
    const downloadLatest = vi.fn(async () => {
      activeAccountId = 'account-b';
      return {
        workspaceId: 'remote-workspace-a',
        version: {
          id: 'remote-version-b',
          versionNumber: 3,
          contentSha256: CONTENT_A,
          sizeBytes: 12,
          fileCount: 0,
          createdAt: '2026-07-08T00:00:00.000Z',
        },
        bundle: snapshot('workspace-a', CONTENT_A, 'head-a').bundle,
      };
    });
    const applyRemoteLatest = vi.fn();
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [newerRemoteSummary()],
        downloadLatest,
      },
      applyRemoteLatest,
    });

    await expect(runtime.pullNewerRemotes()).resolves.toEqual({
      checked: 1,
      pulled: 0,
      conflicts: 0,
      failed: 0,
      skipped: 1,
    });
    expect(downloadLatest).toHaveBeenCalledWith('remote-workspace-a', expect.any(AbortSignal));
    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueCount(db)).toBe(0);
  });

  it.each([
    {
      label: 'personal account',
      bindingOrgId: null,
      remoteOwner: { kind: 'personal' as const, accountId: 'account-b' },
    },
    {
      label: 'organization',
      bindingOrgId: 'org-a',
      remoteOwner: { kind: 'org' as const, orgId: 'org-b' },
    },
  ])(
    'fails closed when a remote workspace changes its bound $label owner',
    async ({ label, bindingOrgId, remoteOwner }) => {
      const downloadLatest = vi.fn();
      const applyRemoteLatest = vi.fn();
      db.prepare(
        `UPDATE workspace_sync_bindings
         SET owner_org_id = @bindingOrgId
         WHERE workspace_id = 1`
      ).run({ bindingOrgId });
      const remote = newerRemoteSummary();
      remote.owner = remoteOwner;
      remote.latest = {
        versionId: 'remote-base-a',
        versionNumber: 1,
        contentSha256: BASE_CONTENT,
      };
      const runtime = makeRuntime({
        replicaClient: {
          listWorkspaces: async () => [remote],
          downloadLatest,
        },
        applyRemoteLatest,
        createJobId: () => `pull-owner-mismatch-${label}`,
      });

      await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
        checked: 1,
        pulled: 0,
        failed: 1,
        skipped: 0,
      });
      expect(downloadLatest).not.toHaveBeenCalled();
      expect(applyRemoteLatest).not.toHaveBeenCalled();
      expect(queueRow(db, `pull-owner-mismatch-${label}`)).toMatchObject({
        operation: 'refresh',
        status: 'failed',
        error_code: 'REMOTE_PULL_INVALID',
      });
    }
  );

  it('fails closed while a bound remote is missing and clears the error when it reappears', async () => {
    const recoveredRemote = newerRemoteSummary();
    recoveredRemote.latest = {
      versionId: 'remote-base-a',
      versionNumber: 1,
      contentSha256: BASE_CONTENT,
    };
    const listWorkspaces = vi
      .fn<() => Promise<ReturnType<typeof newerRemoteSummary>[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([recoveredRemote]);
    const runtime = makeRuntime({
      replicaClient: { listWorkspaces, downloadLatest: vi.fn() },
      createJobId: () => 'pull-missing-remote',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      failed: 1,
      skipped: 0,
    });
    expect(queueRow(db, 'pull-missing-remote')).toMatchObject({
      operation: 'refresh',
      status: 'failed',
      error_code: 'REMOTE_PULL_INVALID',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      failed: 0,
      skipped: 1,
    });
    expect(queueRow(db, 'pull-missing-remote')).toMatchObject({
      status: 'succeeded',
      error_code: null,
    });
  });

  it('persists a retryable failure when listing remote workspaces fails and clears it on recovery', async () => {
    const recoveredRemote = newerRemoteSummary();
    recoveredRemote.latest = {
      versionId: 'remote-base-a',
      versionNumber: 1,
      contentSha256: BASE_CONTENT,
    };
    const listWorkspaces = vi
      .fn<() => Promise<ReturnType<typeof newerRemoteSummary>[]>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('remote workspace listing unavailable'), {
          code: 'NETWORK',
          retryable: true,
        })
      )
      .mockResolvedValueOnce([recoveredRemote]);
    const runtime = makeRuntime({
      replicaClient: { listWorkspaces, downloadLatest: vi.fn() },
      createJobId: () => 'pull-list-error',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      failed: 1,
      skipped: 0,
    });
    expect(queueRow(db, 'pull-list-error')).toMatchObject({
      operation: 'refresh',
      status: 'retry_wait',
      error_code: 'NETWORK',
      base_remote_version_id: 'remote-base-a',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      failed: 0,
      skipped: 1,
    });
    expect(queueRow(db, 'pull-list-error')).toMatchObject({
      status: 'succeeded',
      error_code: null,
    });
  });

  it('preserves FEATURE_DISABLED when remote workspace listing is rollout-gated', async () => {
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => {
          throw Object.assign(new Error('rollout paused'), {
            code: 'FEATURE_DISABLED',
            retryable: true,
          });
        },
        downloadLatest: vi.fn(),
      },
      createJobId: () => 'pull-list-disabled',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      failed: 1,
    });
    expect(queueRow(db, 'pull-list-disabled')).toMatchObject({
      operation: 'refresh',
      status: 'retry_wait',
      error_code: 'FEATURE_DISABLED',
    });
  });

  it('preserves FEATURE_DISABLED when the latest-version download is rollout-gated', async () => {
    const applyRemoteLatest = vi.fn();
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [newerRemoteSummary()],
        downloadLatest: async () => {
          throw Object.assign(new Error('rollout paused'), {
            code: 'FEATURE_DISABLED',
            retryable: true,
          });
        },
      },
      applyRemoteLatest,
      createJobId: () => 'pull-download-disabled',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({
      checked: 1,
      pulled: 0,
      failed: 1,
    });
    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueRow(db, 'pull-download-disabled')).toMatchObject({
      operation: 'refresh',
      status: 'retry_wait',
      error_code: 'FEATURE_DISABLED',
    });
  });

  it('does not persist a remote-list failure after the active account changes', async () => {
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => {
          activeAccountId = 'account-b';
          throw Object.assign(new Error('remote workspace listing unavailable'), {
            code: 'NETWORK',
            retryable: true,
          });
        },
        downloadLatest: vi.fn(),
      },
      createJobId: () => 'cross-account-list-error',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toEqual({
      checked: 0,
      pulled: 0,
      conflicts: 0,
      failed: 0,
      skipped: 0,
    });
    expect(queueCount(db)).toBe(0);
  });

  it('rejects a download older than the remote summary before applying it', async () => {
    const downloadLatest = vi.fn(async () => ({
      workspaceId: 'remote-workspace-a',
      version: {
        id: 'remote-version-stale',
        versionNumber: 2,
        contentSha256: CONTENT_A,
        sizeBytes: 12,
        fileCount: 0,
        createdAt: '2026-07-08T00:00:00.000Z',
      },
      bundle: snapshot('workspace-a', CONTENT_A, 'head-a').bundle,
    }));
    const applyRemoteLatest = vi.fn();
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    ).run();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [newerRemoteSummary()],
        downloadLatest,
      },
      applyRemoteLatest,
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({ failed: 1, pulled: 0 });

    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueRow(db, 'queue-a')).toMatchObject({
      operation: 'refresh',
      status: 'failed',
      error_code: 'REMOTE_PULL_INVALID',
    });
    expect(bindingState(db)).toMatchObject({
      remote_latest_version_id: 'remote-base-a',
      remote_latest_version_number: 1,
    });

    downloadLatest.mockResolvedValueOnce({
      workspaceId: 'remote-workspace-a',
      version: {
        id: 'remote-version-b',
        versionNumber: 3,
        contentSha256: CONTENT_A,
        sizeBytes: 12,
        fileCount: 0,
        createdAt: '2026-07-08T00:00:00.000Z',
      },
      bundle: snapshot('workspace-a', CONTENT_A, 'head-a').bundle,
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({ failed: 0, pulled: 1 });
    expect(queueRow(db, 'queue-a')).toMatchObject({ status: 'succeeded', error_code: null });
  });

  it('polls remote replicas on a slower cadence than the five-second upload retry tick', async () => {
    const listWorkspaces = vi.fn(async () => []);
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces,
        downloadLatest: vi.fn(),
      },
    });

    await runtime.start();
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    nowMs = 5100;
    await interval?.callback();
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    nowMs = 30_100;
    await interval?.callback();
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('arms the retry poller before an initial remote listing stalls', async () => {
    let releaseList: (() => void) | undefined;
    const listWorkspaces = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          releaseList = () => resolve([]);
        })
    );
    const runtime = makeRuntime({
      replicaClient: { listWorkspaces, downloadLatest: vi.fn() },
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(listWorkspaces).toHaveBeenCalledOnce());

    expect(interval).toMatchObject({ ms: 1000, cleared: false });
    releaseList?.();
    await starting;
  });

  it('stops new work and waits for an in-flight pull before shutdown completes', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    ).run();
    let releaseApply: (() => void) | undefined;
    const applyRemoteLatest = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseApply = resolve;
        })
    );
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [newerRemoteSummary()],
        downloadLatest: async () => ({
          workspaceId: 'remote-workspace-a',
          version: {
            id: 'remote-version-b',
            versionNumber: 3,
            contentSha256: CONTENT_A,
            sizeBytes: 12,
            fileCount: 0,
            createdAt: '2026-07-08T00:00:00.000Z',
          },
          bundle: snapshot('workspace-a', CONTENT_A, 'head-a').bundle,
        }),
      },
      applyRemoteLatest,
    });
    const pulling = runtime.pullNewerRemotes();
    await vi.waitFor(() => expect(applyRemoteLatest).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(stopped).toBe(false);
    expect(watcher.stopAll).toHaveBeenCalledOnce();
    await expect(runtime.pullNewerRemotes()).resolves.toEqual({
      checked: 0,
      pulled: 0,
      conflicts: 0,
      failed: 0,
      skipped: 0,
    });

    releaseApply?.();
    await Promise.all([pulling, stopping]);
    expect(stopped).toBe(true);
  });

  it('aborts a stalled remote listing and does not apply after shutdown starts', async () => {
    let requestSignal: AbortSignal | undefined;
    const applyRemoteLatest = vi.fn();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: (signal?: AbortSignal) =>
          new Promise((_, reject) => {
            requestSignal = signal;
            signal?.addEventListener('abort', () => reject(new Error('listing aborted')), {
              once: true,
            });
          }),
        downloadLatest: vi.fn(),
      },
      applyRemoteLatest,
    });

    const pulling = runtime.pullNewerRemotes();
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    const stopping = runtime.stop();

    expect(requestSignal?.aborted).toBe(true);
    await Promise.all([pulling, stopping]);
    expect(applyRemoteLatest).not.toHaveBeenCalled();
  });

  it('aborts a stalled download and does not begin apply during shutdown', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    ).run();
    let requestSignal: AbortSignal | undefined;
    const applyRemoteLatest = vi.fn();
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [newerRemoteSummary()],
        downloadLatest: (_remoteWorkspaceId: string, signal?: AbortSignal) =>
          new Promise((_, reject) => {
            requestSignal = signal;
            signal?.addEventListener('abort', () => reject(new Error('download aborted')), {
              once: true,
            });
          }),
      },
      applyRemoteLatest,
    });

    const pulling = runtime.pullNewerRemotes();
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    const stopping = runtime.stop();

    expect(requestSignal?.aborted).toBe(true);
    await Promise.all([pulling, stopping]);
    expect(applyRemoteLatest).not.toHaveBeenCalled();
  });

  it('waits for startup to leave a paused watcher and cannot recreate it after stop', async () => {
    let releaseWatcher: (() => void) | undefined;
    const stopWatching = vi.fn();
    watcher.stopWatching = stopWatching;
    vi.mocked(watcher.ensureWatching).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseWatcher = () => resolve(undefined);
        })
    );
    const runtime = makeRuntime();
    const starting = runtime.start();
    await vi.waitFor(() => expect(watcher.ensureWatching).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    releaseWatcher?.();
    await Promise.all([starting, stopping]);
    expect(stopWatching).toHaveBeenCalledWith('workspace-a');
    expect(watcher.stopAll).toHaveBeenCalledTimes(2);
    await expect(runtime.ensureWatchingWorkspace('workspace-a')).resolves.toBeUndefined();
  });

  it.each(['idle', 'stop'] as const)(
    'keeps public watcher initialization owned until the %s barrier can drain',
    async (barrier) => {
      let releaseWatcher: (() => void) | undefined;
      vi.mocked(watcher.ensureWatching).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseWatcher = () => resolve(undefined);
          })
      );
      const runtime = makeRuntime();
      const initializing = runtime.ensureWatchingWorkspace('workspace-a');
      let settled = false;
      const draining = (
        barrier === 'stop' ? runtime.stop() : runtime.waitForIdle('workspace-a')
      ).then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const settledBeforeInitialization = settled;
      releaseWatcher?.();
      await Promise.all([initializing, draining]);
      expect(settledBeforeInitialization).toBe(false);
      expect(settled).toBe(true);
    }
  );

  it('keeps a workspace-scoped idle wait pending until startup drops a disabled watcher', async () => {
    let releaseWatcher: (() => void) | undefined;
    const stopWatching = vi.fn();
    watcher.stopWatching = stopWatching;
    vi.mocked(watcher.ensureWatching).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseWatcher = () => resolve(undefined);
        })
    );
    const runtime = makeRuntime();
    const starting = runtime.start();
    await vi.waitFor(() => expect(watcher.ensureWatching).toHaveBeenCalledOnce());

    db.prepare(`UPDATE workspace_sync_bindings SET enabled = 0 WHERE workspace_id = 1`).run();
    let idleSettled = false;
    const idle = runtime.waitForIdle('workspace-a').then(() => {
      idleSettled = true;
    });
    await Promise.resolve();
    expect(idleSettled).toBe(false);

    releaseWatcher?.();
    await expect(starting).resolves.toMatchObject({ watched: 0 });
    await idle;
    expect(stopWatching).toHaveBeenCalledWith('workspace-a');
    expect(idleSettled).toBe(true);
  });

  it('reconciles interrupted replica state before starting pollers or workspace watchers', async () => {
    let releaseRecovery: (() => void) | undefined;
    const reconcileReplicaPulls = vi.fn(
      () =>
        new Promise<{ recovered: number; completed: number }>((resolve) => {
          releaseRecovery = () => resolve({ recovered: 1, completed: 0 });
        })
    );
    const runtime = makeRuntime({ reconcileReplicaPulls });

    const preRendererRecovery = runtime.recoverReplicaPullsBeforeRenderer();
    const starting = runtime.start();
    await vi.waitFor(() => expect(reconcileReplicaPulls).toHaveBeenCalledOnce());
    expect(interval).toBeNull();
    expect(watcher.ensureWatching).not.toHaveBeenCalled();

    releaseRecovery?.();
    await Promise.all([preRendererRecovery, starting]);
    expect(reconcileReplicaPulls).toHaveBeenCalledOnce();
    expect(interval).toMatchObject({ ms: 1000, cleared: false });
    expect(watcher.ensureWatching).toHaveBeenCalledWith('workspace-a');
  });

  it('waits for standalone replica recovery before shutdown can close the database', async () => {
    let releaseRecovery: (() => void) | undefined;
    const reconcileReplicaPulls = vi.fn(
      () =>
        new Promise<{ recovered: number; completed: number }>((resolve) => {
          releaseRecovery = () => resolve({ recovered: 0, completed: 0 });
        })
    );
    const runtime = makeRuntime({ reconcileReplicaPulls });

    const recovering = runtime.recoverReplicaPullsBeforeRenderer();
    await vi.waitFor(() => expect(reconcileReplicaPulls).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    releaseRecovery?.();
    await Promise.all([recovering, stopping]);
    expect(stopped).toBe(true);
  });

  it('durably quarantines a failed replica recovery and skips its watcher and pull', async () => {
    const listWorkspaces = vi.fn(async () => []);
    const runtime = makeRuntime({
      reconcileReplicaPulls: async () => ({
        recovered: 0,
        completed: 0,
        quarantined: [
          {
            workspaceId: 1,
            workspaceUuid: 'workspace-a',
            workspacePath: '/managed/workspace-a',
            errorMessage: 'journal proof failed',
          },
        ],
      }),
      replicaClient: { listWorkspaces, downloadLatest: vi.fn() },
    });

    await runtime.recoverReplicaPullsBeforeRenderer();
    await runtime.start();

    const quarantine = db
      .prepare(
        `SELECT status, error_code, error_message
         FROM workspace_sync_queue
         WHERE workspace_id = 1 AND idempotency_key = 'replica-recovery:workspace-a'`
      )
      .get() as { status: string; error_code: string; error_message: string };
    expect(quarantine).toMatchObject({
      status: 'failed',
      error_code: 'REPLICA_RECOVERY_REQUIRED',
    });
    expect(quarantine.error_message).toContain('journal proof failed');
    expect(watcher.ensureWatching).not.toHaveBeenCalled();
    expect(listWorkspaces).not.toHaveBeenCalled();
  });

  it('keeps a failed package recovery quarantined across startup', async () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'package-recovery-quarantine',
      workspaceId: 1,
      operation: 'refresh',
      idempotencyKey: 'package-recovery:workspace-a:package-a',
      nowMs: 50,
    });
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'failed',
           error_code = 'PACKAGE_RECOVERY_REQUIRED',
           error_message = 'package rollback failed'
       WHERE id = 'package-recovery-quarantine'`
    ).run();
    const listWorkspaces = vi.fn(async () => []);
    const runtime = makeRuntime({
      reconcileReplicaPulls: async () => ({ recovered: 0, completed: 0, quarantined: [] }),
      replicaClient: { listWorkspaces, downloadLatest: vi.fn() },
    });

    await runtime.start();

    expect(queueRow(db, 'package-recovery-quarantine')).toMatchObject({
      status: 'failed',
      error_code: 'PACKAGE_RECOVERY_REQUIRED',
    });
    expect(watcher.ensureWatching).not.toHaveBeenCalled();
    expect(listWorkspaces).not.toHaveBeenCalled();
  });

  it('settles an old recovery quarantine and uploads one local catch-up after restart', async () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'old-recovery-quarantine',
      workspaceId: 1,
      operation: 'refresh',
      idempotencyKey: 'replica-recovery:workspace-a',
      nowMs: 50,
    });
    db.prepare(
      `UPDATE workspace_sync_queue
       SET status = 'failed',
           error_code = 'REPLICA_RECOVERY_REQUIRED',
           error_message = 'workspace root was temporarily unavailable'
       WHERE id = 'old-recovery-quarantine'`
    ).run();
    db.prepare(
      `UPDATE workspace_sync_bindings
       SET last_acked_local_head_sha = 'head-a'
       WHERE workspace_id = 1`
    ).run();
    uploadSnapshotFixture = validUploadSnapshot('workspace-a', 'head-b');
    let ready = false;
    const runtime = makeRuntime({
      reconcileReplicaPulls: async () => ({ recovered: 1, completed: 0, quarantined: [] }),
      getCurrentLocalHeadSha: () => 'head-b',
      isRendererReady: () => ready,
    });

    await runtime.start();
    expect(snapshotWorkspace).not.toHaveBeenCalled();
    expect(createVersion).not.toHaveBeenCalled();
    ready = true;
    await runtime.runDueUploads();
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());

    expect(queueRow(db, 'old-recovery-quarantine')).toMatchObject({
      status: 'succeeded',
      error_code: null,
      error_message: null,
    });
    expect(watcher.ensureWatching).toHaveBeenCalledWith('workspace-a');
    expect(createVersion).toHaveBeenCalledWith(
      expect.objectContaining({ baseVersionId: 'remote-base-a' }),
      expect.any(AbortSignal)
    );
  });

  it('waits for a manual upload before runtime shutdown completes', async () => {
    let releaseUpload: (() => void) | undefined;
    createVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () =>
            resolve(
              readyVersion(
                'remote-version-a',
                2,
                uploadSnapshotFixture.contentSha256,
                uploadSnapshotFixture.bundleSizeBytes,
                uploadSnapshotFixture.includedFileCount
              )
            );
        })
    );
    const runtime = makeRuntime();
    const flush = runtime.flushWorkspace('workspace-a');
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    releaseUpload?.();
    await Promise.all([flush, stopping]);
    expect(stopped).toBe(true);
  });

  it('finishes the active drain job but does not claim a later job after shutdown begins', async () => {
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-first',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:head-a',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-a',
      nowMs: 50,
    });
    enqueueWorkspaceSyncJob(db, {
      id: 'queue-later',
      workspaceId: 1,
      operation: 'upload',
      idempotencyKey: 'upload:workspace-a:remote-base-a:head-b',
      baseRemoteVersionId: 'remote-base-a',
      localHeadSha: 'head-b',
      nowMs: 60,
    });
    let releaseUpload: (() => void) | undefined;
    createVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpload = () =>
            resolve(
              readyVersion(
                'remote-version-a',
                2,
                uploadSnapshotFixture.contentSha256,
                uploadSnapshotFixture.bundleSizeBytes,
                uploadSnapshotFixture.includedFileCount
              )
            );
        })
    );
    const runtime = makeRuntime();
    const draining = runtime.runDueUploads();
    await vi.waitFor(() => expect(createVersion).toHaveBeenCalledOnce());

    const stopping = runtime.stop();
    releaseUpload?.();
    await Promise.all([draining, stopping]);

    expect(queueRow(db, 'queue-first')).toMatchObject({ status: 'succeeded' });
    expect(queueRow(db, 'queue-later')).toMatchObject({ status: 'pending', attempt_count: 0 });
    expect(createVersion).toHaveBeenCalledTimes(1);
  });

  it('tracks account lookup from poll admission through shutdown', async () => {
    let releaseAccountLookup: (() => void) | undefined;
    const getActiveAccountId = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          releaseAccountLookup = () => resolve('account-a');
        })
    );
    const runtime = makeRuntime({ getActiveAccountId });
    const due = runtime.runDueUploads();
    await vi.waitFor(() => expect(getActiveAccountId).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseAccountLookup?.();
    await Promise.all([due, stopping]);
    expect(stopped).toBe(true);
    expect(createVersion).not.toHaveBeenCalled();
    expect(() => queueCount(db)).not.toThrow();
  });

  it('does not overwrite unpushed local commits when remote is newer', async () => {
    const downloadLatest = vi.fn();
    const applyRemoteLatest = vi.fn();
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    ).run();
    const runtime = makeRuntime({
      getCurrentLocalHeadSha: () => 'head-dirty',
      replicaClient: {
        listWorkspaces: async () => [
          {
            workspaceId: 'remote-workspace-a',
            clientWorkspaceId: 'workspace-a',
            displayName: 'Project A',
            owner: { kind: 'personal', accountId: 'account-a' },
            latest: {
              versionId: 'remote-version-b',
              versionNumber: 3,
              contentSha256: CONTENT_A,
            },
            storageBytesUsed: 12,
            versionCount: 2,
            updatedAt: '2026-07-08T00:00:00.000Z',
            lastSeenAt: '2026-07-08T00:00:00.000Z',
            deviceId: 'device-b',
          },
        ],
        downloadLatest,
      },
      applyRemoteLatest,
      createJobId: () => 'pull-conflict-a',
    });

    await runtime.start();

    expect(downloadLatest).not.toHaveBeenCalled();
    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueRow(db, 'pull-conflict-a')).toMatchObject({
      status: 'failed',
      operation: 'refresh',
      error_code: 'SYNC_CONFLICT',
    });
  });

  it('does not overwrite uncommitted working-tree changes when HEAD still equals the ack', async () => {
    const downloadLatest = vi.fn();
    const applyRemoteLatest = vi.fn();
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    ).run();
    writeFileSync(join(workspacePath, 'README.md'), 'uncommitted local edit\n');
    const runtime = makeRuntime({
      replicaClient: {
        listWorkspaces: async () => [newerRemoteSummary()],
        downloadLatest,
      },
      applyRemoteLatest,
      createJobId: () => 'pull-conflict-uncommitted',
    });

    await runtime.start();

    expect(downloadLatest).not.toHaveBeenCalled();
    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueRow(db, 'pull-conflict-uncommitted')).toMatchObject({
      status: 'failed',
      operation: 'refresh',
      error_code: 'SYNC_CONFLICT',
    });
    expect(readFileSync(join(workspacePath, 'README.md'), 'utf8')).toBe('uncommitted local edit\n');
  });

  it('does not download a newer remote while a sequence has an unsaved renderer buffer', async () => {
    const downloadLatest = vi.fn();
    const applyRemoteLatest = vi.fn();
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    ).run();
    db.prepare(
      `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
       VALUES ('sequence-document-a', 'dna', 'Sequence', 'sequence://sequence-document-a', 'file', 'active', 1, 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO catalog_entity_files
       (id, entity_id, workspace_id, path, file_kind, status, created_at, updated_at)
       VALUES ('file-sequence-a', 'sequence-document-a', 1, ?, 'sequence', 'current', 1, 1)`
    ).run(join(workspacePath, 'README.md'));
    setDirtyState({
      hasDirtyWork: true,
      details: 'Unsaved sequence',
      dirtySequenceDocumentIds: ['sequence-document-a'],
    });
    const runtime = makeRuntime({
      replicaClient: { listWorkspaces: async () => [newerRemoteSummary()], downloadLatest },
      applyRemoteLatest,
      createJobId: () => 'pull-conflict-unsaved-sequence',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({ conflicts: 1, pulled: 0 });
    expect(downloadLatest).not.toHaveBeenCalled();
    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueRow(db, 'pull-conflict-unsaved-sequence')).toMatchObject({
      status: 'failed',
      error_code: 'SYNC_CONFLICT',
    });
  });

  it('abandons a downloaded remote when a notebook becomes unsaved before apply', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    ).run();
    db.prepare(
      `INSERT INTO pages (id, title, content, created_at, updated_at)
       VALUES ('page-a', 'Notebook', '{}', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
       VALUES ('page-a', 'notebook', 'Notebook', 'entity://page/page-a', 'database', 'active', 1, 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO catalog_entity_files
       (id, entity_id, workspace_id, path, file_kind, status, created_at, updated_at)
       VALUES ('file-page-a', 'page-a', 1, ?, 'waypoint-notebook', 'current', 1, 1)`
    ).run(join(workspacePath, 'Notebook'));
    const downloadLatest = vi.fn(async () => {
      setDirtyState({
        hasDirtyWork: true,
        details: 'Unsaved notebook',
        dirtyPageIds: ['page-a'],
      });
      return {
        workspaceId: 'remote-workspace-a',
        version: {
          id: 'remote-version-b',
          versionNumber: 3,
          contentSha256: CONTENT_A,
          sizeBytes: 12,
          fileCount: 0,
          createdAt: '2026-07-08T00:00:00.000Z',
        },
        bundle: snapshot('workspace-a', CONTENT_A, 'head-a').bundle,
      };
    });
    const applyRemoteLatest = vi.fn();
    const runtime = makeRuntime({
      replicaClient: { listWorkspaces: async () => [newerRemoteSummary()], downloadLatest },
      applyRemoteLatest,
      createJobId: () => 'pull-conflict-unsaved-notebook',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({ conflicts: 1, pulled: 0 });
    expect(downloadLatest).toHaveBeenCalledOnce();
    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueRow(db, 'pull-conflict-unsaved-notebook')).toMatchObject({
      status: 'failed',
      error_code: 'SYNC_CONFLICT',
    });
  });

  it('does not overwrite an unsaved script with a downloaded remote version', async () => {
    db.prepare(
      `UPDATE workspace_sync_bindings SET last_acked_local_head_sha = 'head-a' WHERE workspace_id = 1`
    ).run();
    const downloadLatest = vi.fn(async () => {
      setDirtyState({
        hasDirtyWork: true,
        details: '1 text file',
        dirtyFilePaths: [join(workspacePath, 'analyses', 'align', 'run.py')],
      });
      return {
        workspaceId: 'remote-workspace-a',
        version: {
          id: 'remote-version-b',
          versionNumber: 3,
          contentSha256: CONTENT_A,
          sizeBytes: 12,
          fileCount: 0,
          createdAt: '2026-07-08T00:00:00.000Z',
        },
        bundle: snapshot('workspace-a', CONTENT_A, 'head-a').bundle,
      };
    });
    const applyRemoteLatest = vi.fn();
    const runtime = makeRuntime({
      replicaClient: { listWorkspaces: async () => [newerRemoteSummary()], downloadLatest },
      applyRemoteLatest,
      createJobId: () => 'pull-conflict-unsaved-script',
    });

    await expect(runtime.pullNewerRemotes()).resolves.toMatchObject({ conflicts: 1, pulled: 0 });
    expect(applyRemoteLatest).not.toHaveBeenCalled();
    expect(queueRow(db, 'pull-conflict-unsaved-script')).toMatchObject({
      status: 'failed',
      error_code: 'SYNC_CONFLICT',
    });
  });

  it('publishes completion for watcher-driven uploads without a manual status refresh', async () => {
    const invalidate = vi.fn();
    const runtime = makeRuntime({ statusPublisher: { invalidate } });

    await runtime.flushWorkspace('workspace-a');

    expect(invalidate).toHaveBeenCalledWith('workspace-a', 'queue_changed');
  });

  function makeRuntime(
    options: {
      deviceId?: string;
      staleLockMs?: number;
      statusPublisher?: { invalidate: ReturnType<typeof vi.fn> };
      replicaClient?: ConstructorParameters<typeof WorkspaceSyncRuntime>[1]['replicaClient'];
      applyRemoteLatest?: ConstructorParameters<
        typeof WorkspaceSyncRuntime
      >[1]['applyRemoteLatest'];
      prepareReplicaApply?: ConstructorParameters<
        typeof WorkspaceSyncRuntime
      >[1]['prepareReplicaApply'];
      publishReplicaApplied?: ConstructorParameters<
        typeof WorkspaceSyncRuntime
      >[1]['publishReplicaApplied'];
      getCurrentLocalHeadSha?: () => string | null;
      createJobId?: () => string;
      reconcileReplicaPulls?: ConstructorParameters<
        typeof WorkspaceSyncRuntime
      >[1]['reconcileReplicaPulls'];
      getActiveAccountId?: ConstructorParameters<
        typeof WorkspaceSyncRuntime
      >[1]['getActiveAccountId'];
      isRendererReady?: () => boolean;
      realWatcher?: boolean;
      setDebounceTimer?: ConstructorParameters<typeof WorkspaceSyncRuntime>[1]['setDebounceTimer'];
    } = {}
  ): WorkspaceSyncRuntime {
    const runtime = new WorkspaceSyncRuntime(db, {
      deviceId: options.deviceId ?? 'device-a',
      appVersion: '0.4.0',
      getActiveAccountId: options.getActiveAccountId ?? (async () => activeAccountId),
      getCurrentLocalHeadSha: options.getCurrentLocalHeadSha ?? (() => 'head-a'),
      snapshotWorkspace,
      client: { createVersion },
      replicaClient: options.replicaClient,
      isRendererReady: options.isRendererReady,
      applyRemoteLatest: options.applyRemoteLatest,
      prepareReplicaApply: options.prepareReplicaApply,
      publishReplicaApplied: options.publishReplicaApplied,

      reconcileReplicaPulls:
        options.reconcileReplicaPulls ??
        (async () => ({ recovered: 0, completed: 0, quarantined: [] })),
      watcher: options.realWatcher ? undefined : watcher,
      statusPublisher: options.statusPublisher,
      nowMs: () => nowMs,
      retryBaseDelayMs: 5000,
      retryMaxDelayMs: 60_000,
      maxAttempts: 3,
      maxDrainJobs: 10,
      createJobId: options.createJobId ?? (() => 'queue-a'),
      pollIntervalMs: 1000,
      staleLockMs: options.staleLockMs ?? 30_000,
      setPollInterval: (callback, ms) => {
        interval = { callback, ms, cleared: false };
        return interval;
      },
      clearPollInterval: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
      setDebounceTimer:
        options.setDebounceTimer ??
        ((callback) => {
          void callback();
          return { immediate: true };
        }),
      clearDebounceTimer: vi.fn(),
    });
    runtimes.push(runtime);
    return runtime;
  }
});

function invokeDeferred(callback: (() => void) | undefined): void {
  if (!callback) throw new Error('Expected deferred callback to be registered');
  callback();
}

function seedSyncWorkspace(db: Database.Database, workspacePath: string): void {
  db.prepare(
    `INSERT INTO workspace_sync_device (id, device_id, created_at, updated_at)
     VALUES (1, 'device-a', 1, 1)`
  ).run();
  db.prepare(
    `INSERT INTO workspaces (id, name, path, repo_uuid, created_at, last_opened_at)
     VALUES (1, 'Project A', ?, 'workspace-a', 1, 1)`
  ).run(workspacePath);
  db.prepare(
    `INSERT INTO workspace_sync_bindings (
      workspace_id, workspace_uuid, owner_account_id, remote_workspace_id,
      enabled, remote_latest_version_id, remote_latest_version_number,
      remote_latest_content_sha256, created_at, updated_at
    ) VALUES (
      1, 'workspace-a', 'account-a', 'remote-workspace-a',
      1, 'remote-base-a', 1, ?, 1, 1
    )`
  ).run(BASE_CONTENT);
}

function snapshot(
  workspaceUuid: string,
  contentSha256: string,
  localHeadSha: string
): {
  localHeadSha: string;
  contentSha256: string;
  bundleSizeBytes: number;
  includedFileCount: number;
  bundle: WorkspaceSyncBundleV1;
  statusExcludedSummary: {
    unsupportedCount: number;
    privateRawDataCount: number;
    referencePointerCount: number;
    fileTooLargeCount: number;
    bundleTooLargeCount: number;
  };
} {
  return {
    localHeadSha,
    contentSha256,
    bundleSizeBytes: 123,
    includedFileCount: 1,
    bundle: {
      schemaVersion: 1,
      capturedAt: '2026-07-08T00:00:00.000Z',
      workspace: { id: workspaceUuid, name: 'Project A' },
      files: [],
      excludedSummary: {
        unsupported: { count: 0, bytesApprox: 0 },
        'private-raw-data': { count: 0, bytesApprox: 0 },
        'reference-pointer': { count: 0, bytesApprox: 0 },
        'file-too-large': { count: 0, bytesApprox: 0 },
        'bundle-too-large': { count: 0, bytesApprox: 0 },
      },
      limits: { maxFileBytes: 10, maxBundleBytes: 10, maxFiles: 10 },
      provenance: {
        source: 'dnaforge-desktop',
        appVersion: '0.4.0',
        contentSha256,
      },
    },
    statusExcludedSummary: {
      unsupportedCount: 0,
      privateRawDataCount: 0,
      referencePointerCount: 0,
      fileTooLargeCount: 0,
      bundleTooLargeCount: 0,
    },
  };
}

function validUploadSnapshot(
  workspaceUuid: string,
  localHeadSha: string
): ReturnType<typeof snapshot> {
  const result = snapshot(workspaceUuid, '0'.repeat(64), localHeadSha);
  const contentSha256 = createHash('sha256')
    .update(workspaceSyncBundleHashInput(result.bundle), 'utf8')
    .digest('hex');
  result.contentSha256 = contentSha256;
  result.bundle.provenance.contentSha256 = contentSha256;
  result.bundleSizeBytes = Buffer.byteLength(JSON.stringify(result.bundle), 'utf8');
  result.includedFileCount = result.bundle.files.length;
  return result;
}

function readyVersion(
  id: string,
  versionNumber: number,
  contentSha256: string,
  sizeBytes = 123,
  fileCount = 1
) {
  return {
    status: 'ready' as const,
    workspaceId: 'remote-workspace-a',
    version: {
      id,
      versionNumber,
      contentSha256,
      sizeBytes,
      fileCount,
      createdAt: '2026-07-08T00:00:00.000Z',
    },
  };
}

function newerRemoteSummary(): DesktopSyncWorkspaceSummaryResponse {
  return {
    workspaceId: 'remote-workspace-a',
    clientWorkspaceId: 'workspace-a',
    displayName: 'Project A',
    owner: { kind: 'personal' as const, accountId: 'account-a' },
    latest: {
      versionId: 'remote-version-b',
      versionNumber: 3,
      contentSha256: CONTENT_A,
    },
    storageBytesUsed: 12,
    versionCount: 2,
    updatedAt: '2026-07-08T00:00:00.000Z',
    lastSeenAt: '2026-07-08T00:00:00.000Z',
    deviceId: 'device-b',
  };
}

function queueRow(db: Database.Database, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspace_sync_queue WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
}

function queueCount(db: Database.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM workspace_sync_queue`).get() as { count: number }
  ).count;
}

function bindingState(db: Database.Database): Record<string, unknown> {
  return db.prepare(`SELECT * FROM workspace_sync_bindings WHERE workspace_id = 1`).get() as Record<
    string,
    unknown
  >;
}
