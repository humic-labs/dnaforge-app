import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
import { ensureSchema } from './schema';
import { deleteWorkspaceSyncCloudCopy } from './workspace-sync-delete';
import { ensureWorkspaceSyncBinding, readWorkspaceSyncBinding } from './workspace-sync-binding';
import {
  readWorkspaceSyncEnablement,
  WORKSPACE_SYNC_ENABLEMENT_PREFIX,
} from './workspace-sync-enablement';
import {
  acceptWorkspaceSyncEnablementTelemetry,
  configureWorkspaceSyncEnablementTelemetry,
  publishWorkspaceSyncEnablementTelemetry,
  purgeWorkspaceSyncEnablementTelemetry,
  WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX,
  type WorkspaceSyncEnablementTelemetryEvent,
} from './workspace-sync-enablement-telemetry';
import { createFileTestDb, createTestDb, openReadonlyFileTestDb } from './__tests__/test-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

const REMOTE = '44444444-4444-4444-8444-444444444444';
const ORIGIN: OptionalTelemetryOrigin = {
  consentScope: '11111111-1111-4111-8111-111111111111',
  contextId: '22222222-2222-4222-8222-222222222222',
  processId: '33333333-3333-4333-8333-333333333333',
  classification: 'synthetic',
};

describe('committed native cloud backup enablement', () => {
  let db: Database.Database;
  let account: string | null;
  let origin: OptionalTelemetryOrigin | null;
  let capture: ReturnType<typeof vi.fn>;
  let readers: Array<() => WorkspaceSyncEnablementTelemetryEvent | null>;
  let events: Map<string, WorkspaceSyncEnablementTelemetryEvent>;

  function seed(target: Database.Database): void {
    target
      .prepare(
        `INSERT INTO workspaces (id,name,path,repo_uuid,created_at,last_opened_at)
       VALUES (1,'PRIVATE_PROJECT_NAME','/private/managed/project','workspace-a',1,1)`
      )
      .run();
  }

  function enable(target = db, remoteWorkspaceId = REMOTE) {
    return ensureWorkspaceSyncBinding(target, {
      workspaceUuid: 'workspace-a',
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      nowMs: 500,
      claimClient: {
        claimWorkspace: async (request) => ({
          clientWorkspaceId: request.clientWorkspaceId,
          remoteWorkspaceId,
          claimedByAccountId: request.ownerAccountId,
          owner: { kind: 'personal', accountId: request.ownerAccountId },
        }),
      },
    });
  }

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    seed(db);
    account = 'account-a';
    origin = ORIGIN;
    readers = [];
    events = new Map();
    capture = vi.fn(() => origin);
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    configureWorkspaceSyncEnablementTelemetry({
      captureOrigin: capture,
      currentAccountId: () => account,
      openCommittedDatabase: (source) => openReadonlyFileTestDb(source.name),
      publish: (reader) => {
        readers.push(reader);
        const value = reader();
        if (!value) return false;
        events.set(value.event.eventId, structuredClone(value));
        return true;
      },
    });
  });

  afterEach(() => {
    configureWorkspaceSyncEnablementTelemetry(null);
    db.close();
    vi.restoreAllMocks();
  });

  it('publishes one stable enabled event from the committed native episode without private data', async () => {
    await enable();
    expect(events.size).toBe(0);
    const native = readWorkspaceSyncEnablement(db, 'workspace-a');
    expect(native?.episodes).toHaveLength(1);
    const operationId = native?.episodes[0]?.operationId;
    publishWorkspaceSyncEnablementTelemetry(db);
    publishWorkspaceSyncEnablementTelemetry(db);
    expect(events.size).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect([...events.values()][0]).toEqual({
      origin: ORIGIN,
      event: {
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        eventName: 'workspace_backup_enabled',
        payloadSchemaVersion: 1,
        referenceKind: 'workspace_sync_enablement',
        referenceId: operationId,
        createdAtMs: 1000,
        properties: {
          feature_area: 'workspace',
          operation_id: operationId,
          origin_started_at_ms: 1000,
          occurred_at_ms: 1000,
        },
      },
    });
    await enable();
    publishWorkspaceSyncEnablementTelemetry(db);
    expect(events.size).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('keeps native identity without consent and never backfills a reused binding', async () => {
    origin = null;
    await enable();
    const native = readWorkspaceSyncEnablement(db, 'workspace-a');
    expect(native?.episodes).toHaveLength(1);
    origin = ORIGIN;
    const operationId = native?.episodes[0]?.operationId;
    if (!operationId) throw new Error('Expected the native enablement fixture.');
    acceptWorkspaceSyncEnablementTelemetry(db, { workspaceUuid: 'workspace-a', operationId });
    await enable();
    publishWorkspaceSyncEnablementTelemetry(db);
    expect(events.size).toBe(0);
    expect(readWorkspaceSyncEnablement(db, 'workspace-a')).toEqual(native);
  });

  it('shares one native episode across concurrent claims for the same binding', async () => {
    await Promise.all([enable(), enable()]);
    expect(readWorkspaceSyncEnablement(db, 'workspace-a')?.episodes).toHaveLength(1);
    publishWorkspaceSyncEnablementTelemetry(db);
    expect(events.size).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('publishes a linked reenable with its own native acceptance clock', async () => {
    await enable();
    publishWorkspaceSyncEnablementTelemetry(db);
    const first = readWorkspaceSyncEnablement(db, 'workspace-a')?.episodes[0];
    if (!first) throw new Error('Expected the first native enablement fixture.');
    db.prepare('UPDATE workspace_sync_bindings SET enabled = 0 WHERE workspace_uuid = ?').run(
      'workspace-a'
    );
    vi.mocked(Date.now).mockReturnValue(2000);
    await enable();
    publishWorkspaceSyncEnablementTelemetry(db);
    const native = readWorkspaceSyncEnablement(db, 'workspace-a');
    expect(native?.episodes).toHaveLength(2);
    expect(events.size).toBe(2);
    const reenabled = [...events.values()].find(
      (value) => value.event.properties.operation_id !== first.operationId
    );
    expect(reenabled?.event.createdAtMs).toBe(2000);
    expect(reenabled?.event.properties).toEqual({
      feature_area: 'workspace',
      operation_id: native?.episodes[1]?.operationId,
      parent_action_id: first.operationId,
      origin_started_at_ms: 2000,
      occurred_at_ms: 2000,
    });
  });

  it('preserves historical ownership when enabling a replacement cloud binding after deletion', async () => {
    await enable();
    const first = readWorkspaceSyncEnablement(db, 'workspace-a')?.episodes[0];
    if (!first) throw new Error('Expected the original native enablement fixture.');
    await expect(
      deleteWorkspaceSyncCloudCopy(db, {
        workspaceUuid: 'workspace-a',
        nowMs: () => 1500,
        runtime: {
          pauseWorkspace: vi.fn(),
          resumeWorkspace: vi.fn(),
          stopWatchingWorkspace: vi.fn(),
          waitForIdle: vi.fn(async () => undefined),
        },
        client: {
          deleteCloudCopy: async () => ({
            status: 'deleted',
            workspaceId: REMOTE,
            localSync: { shouldPause: true, clearRemoteBinding: true },
            shares: { revoked: 0, alreadyInactive: 0 },
            storage: { objectsRemoved: 0 },
            versions: { readyDeleted: 0, rowsRemoved: 0 },
            quota: { releasedBytes: 0 },
          }),
        },
      })
    ).resolves.toMatchObject({ ok: true });
    vi.mocked(Date.now).mockReturnValue(2000);
    const replacement = '55555555-5555-4555-8555-555555555555';
    await expect(enable(db, replacement)).resolves.toMatchObject({
      enabled: true,
      remoteWorkspaceId: replacement,
    });
    const history = readWorkspaceSyncEnablement(db, 'workspace-a');
    expect(history?.episodes).toHaveLength(2);
    expect(history?.episodes[0]).toEqual(first);
    expect(history?.episodes[0]).toMatchObject({
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      remoteWorkspaceId: REMOTE,
    });
    expect(history?.episodes[1]).toMatchObject({
      ownerAccountId: 'account-a',
      ownerOrgId: null,
      remoteWorkspaceId: replacement,
      parentOperationId: first.operationId,
      startedAtMs: 2000,
    });
  });

  it('does not publish under a write transaction or a different active account', async () => {
    await enable();
    db.transaction(() => publishWorkspaceSyncEnablementTelemetry(db))();
    expect(readers).toHaveLength(0);
    account = 'account-b';
    publishWorkspaceSyncEnablementTelemetry(db);
    expect(events.size).toBe(0);
    account = 'account-a';
    publishWorkspaceSyncEnablementTelemetry(db);
    expect(events.size).toBe(1);
    const reader = readers.at(-1);
    configureWorkspaceSyncEnablementTelemetry(null);
    expect(reader?.()).toBeNull();
  });

  it('purges optional origins while preserving the native binding episode', async () => {
    await enable();
    const native = readWorkspaceSyncEnablement(db, 'workspace-a');
    purgeWorkspaceSyncEnablementTelemetry(db);
    await enable();
    publishWorkspaceSyncEnablementTelemetry(db);
    expect(events.size).toBe(0);
    expect(readWorkspaceSyncEnablement(db, 'workspace-a')).toEqual(native);
    expect(
      db
        .prepare('SELECT key FROM settings WHERE substr(key,1,?) = ?')
        .all(
          WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX.length,
          WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX
        )
    ).toEqual([]);
  });

  it('rolls back the binding when native episode storage cannot commit', async () => {
    db.exec(`CREATE TRIGGER refuse_native_enablement BEFORE INSERT ON settings
      WHEN NEW.key = '${WORKSPACE_SYNC_ENABLEMENT_PREFIX}workspace-a'
      BEGIN SELECT RAISE(ABORT, 'native fixture storage failure'); END`);
    await expect(enable()).rejects.toThrow('native fixture storage failure');
    expect(readWorkspaceSyncBinding(db, { workspaceUuid: 'workspace-a' })).toBeNull();
    expect(readWorkspaceSyncEnablement(db, 'workspace-a')).toBeNull();
    publishWorkspaceSyncEnablementTelemetry(db);
    expect(events.size).toBe(0);
  });

  it('keeps enablement successful when optional origin capture fails', async () => {
    capture.mockImplementation(() => {
      throw new Error('optional fixture failure');
    });
    await expect(enable()).resolves.toMatchObject({ enabled: true });
    expect(readWorkspaceSyncEnablement(db, 'workspace-a')?.episodes).toHaveLength(1);
    publishWorkspaceSyncEnablementTelemetry(db);
    expect(events.size).toBe(0);
  });

  it('reads committed WAL data through the readonly owner during a concurrent write', async () => {
    const file = createFileTestDb('enablement-committed');
    try {
      ensureSchema(file.db, file.dbPath);
      seed(file.db);
      await enable(file.db);
      publishWorkspaceSyncEnablementTelemetry(file.db);
      const reader = readers[0];
      if (!reader) throw new Error('Expected the committed reader fixture.');
      expect(() =>
        file.db.transaction(() => {
          file.db
            .prepare(
              `UPDATE settings SET value = json_set(value, '$.origin.classification', 'private')
               WHERE substr(key,1,?) = ?`
            )
            .run(
              WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX.length,
              WORKSPACE_SYNC_ENABLEMENT_TELEMETRY_PREFIX
            );
          expect(reader()?.origin.classification).toBe('synthetic');
          throw new Error('rollback fixture write');
        })()
      ).toThrow('rollback fixture write');
      expect(reader()?.origin.classification).toBe('synthetic');
    } finally {
      file.cleanup();
    }
  });
});
