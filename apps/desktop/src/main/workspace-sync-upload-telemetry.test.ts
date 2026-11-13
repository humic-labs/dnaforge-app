import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
import type { WorkspaceSyncQueueJob } from './workspace-sync-queue';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import {
  acceptWorkspaceSyncUploadTelemetry,
  configureWorkspaceSyncUploadTelemetry,
  publishWorkspaceSyncUploadTelemetry,
  readWorkspaceSyncUploadTelemetryOperation,
  settleWorkspaceSyncUploadTelemetry,
  WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX,
  type WorkspaceSyncUploadTelemetryEvent,
} from './workspace-sync-upload-telemetry';

const ORIGIN: OptionalTelemetryOrigin = {
  consentScope: '11111111-1111-4111-8111-111111111111',
  contextId: '22222222-2222-4222-8222-222222222222',
  processId: '33333333-3333-4333-8333-333333333333',
  classification: 'synthetic',
};
const JOB: WorkspaceSyncQueueJob = {
  acceptedOperationId: '55555555-5555-4555-8555-555555555555',
  acceptedOperationStartedAt: 100,
  id: 'native-job-a',
  workspaceId: 1,
  operation: 'upload',
  status: 'pending',
  idempotencyKey: 'private-content-derived-key',
  baseRemoteVersionId: 'private-remote',
  localHeadSha: 'private-head',
  bundleContentSha256: 'private-content',
  attemptCount: 0,
  nextAttemptAt: null,
  lockedAt: null,
  lockedByDeviceId: null,
  errorCode: null,
  errorMessage: null,
  createdAt: 100,
  updatedAt: 100,
};

describe('committed native upload telemetry receipts', () => {
  let db: Database.Database;
  let origin: OptionalTelemetryOrigin | null;
  let account: string | null;
  let events: Map<string, WorkspaceSyncUploadTelemetryEvent>;
  let capture: ReturnType<typeof vi.fn>;
  let readers: Array<() => WorkspaceSyncUploadTelemetryEvent | null>;

  beforeEach(() => {
    JOB.acceptedOperationId = '55555555-5555-4555-8555-555555555555';
    JOB.acceptedOperationStartedAt = 100;
    db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    origin = ORIGIN;
    account = 'account-a';
    events = new Map();
    readers = [];
    capture = vi.fn(() => origin);
    configureWorkspaceSyncUploadTelemetry({
      captureOrigin: capture,
      currentAccountId: () => account,
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
    configureWorkspaceSyncUploadTelemetry(null);
    db.close();
  });

  function accept(retry = false, at = 100): void {
    const parentOperationId = retry ? JOB.acceptedOperationId : null;
    if (retry) {
      JOB.acceptedOperationId = randomUUID();
      JOB.acceptedOperationStartedAt = at;
    }
    db.transaction(() =>
      acceptWorkspaceSyncUploadTelemetry(db, {
        job: JOB,
        ownerAccountId: 'account-a',
        nowMs: at,
        retry,
        parentOperationId,
      })
    )();
  }

  function settle(outcome: 'uploaded' | 'unchanged' | 'failed', at = 200): void {
    db.transaction(() =>
      settleWorkspaceSyncUploadTelemetry(db, {
        job: JOB,
        operationId: readWorkspaceSyncUploadTelemetryOperation(db, JOB),
        outcome,
        nowMs: at,
        errorCode: 'VALIDATION',
      })
    )();
  }

  it('publishes only committed original stages after the native fence is released', async () => {
    const release = await acquireWorkspaceSyncDatabaseFence(db);
    db.transaction(() => {
      acceptWorkspaceSyncUploadTelemetry(db, {
        job: JOB,
        ownerAccountId: 'account-a',
        nowMs: 100,
        retry: false,
      });
      publishWorkspaceSyncUploadTelemetry(db);
      expect(events.size).toBe(0);
    })();
    publishWorkspaceSyncUploadTelemetry(db);
    expect(events.size).toBe(0);
    release();
    publishWorkspaceSyncUploadTelemetry(db);
    expect(events.size).toBe(1);
    const accepted = [...events.values()][0]!;
    expect(accepted).toMatchObject({
      origin: ORIGIN,
      event: {
        eventName: 'workspace_sync_stage',
        referenceKind: 'workspace_sync_upload',
        createdAtMs: 100,
        properties: {
          feature_area: 'workspace',
          sync_operation: 'upload',
          sync_stage: 'accepted',
          origin_started_at_ms: 100,
          occurred_at_ms: 100,
        },
      },
    });
    expect(JSON.stringify(accepted)).not.toMatch(
      /private-content|private-head|private-remote|account-a|native-job-a/
    );
    expect(capture).toHaveBeenCalledOnce();
    settle('uploaded');
    publishWorkspaceSyncUploadTelemetry(db, JOB.id);
    const terminal = [...events.values()].find(
      (row) => row.event.properties.sync_stage === 'uploaded'
    );
    expect(terminal).toMatchObject({
      origin: ORIGIN,
      event: {
        createdAtMs: 200,
        properties: {
          operation_id: accepted.event.properties.operation_id,
          origin_started_at_ms: 100,
          occurred_at_ms: 200,
        },
      },
    });
    expect(terminal?.event.eventId).not.toBe(accepted.event.eventId);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('rolls optional accepted state back with a failed native transaction', () => {
    expect(() =>
      db.transaction(() => {
        acceptWorkspaceSyncUploadTelemetry(db, {
          job: JOB,
          ownerAccountId: 'account-a',
          nowMs: 100,
          retry: false,
        });
        throw new Error('native transaction refused');
      })()
    ).toThrow('native transaction refused');
    publishWorkspaceSyncUploadTelemetry(db);
    expect(events.size).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 });
  });

  it('isolates optional SQLite write failure while the mandatory transaction commits', () => {
    db.exec(
      `CREATE TABLE mandatory (value TEXT); CREATE TRIGGER optional_failure BEFORE INSERT ON settings WHEN substr(NEW.key,1,${WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX.length}) = '${WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX}' BEGIN SELECT RAISE(ABORT,'optional write refused'); END;`
    );
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO mandatory VALUES (?)').run('accepted');
        acceptWorkspaceSyncUploadTelemetry(db, {
          job: JOB,
          ownerAccountId: 'account-a',
          nowMs: 100,
          retry: false,
        });
        db.prepare('INSERT INTO mandatory VALUES (?)').run('completed');
      })()
    ).not.toThrow();
    expect(db.prepare('SELECT value FROM mandatory ORDER BY rowid').all()).toEqual([
      { value: 'accepted' },
      { value: 'completed' },
    ]);
    publishWorkspaceSyncUploadTelemetry(db);
    expect(events.size).toBe(0);
  });

  it('reuses acceptance across replay and freezes a terminal before a distinct explicit retry', () => {
    accept();
    publishWorkspaceSyncUploadTelemetry(db);
    const first = [...events.values()][0]!;
    origin = { ...ORIGIN, processId: '44444444-4444-4444-8444-444444444444' };
    accept(false, 150);
    settle('failed', 200);
    settle('uploaded', 250);
    publishWorkspaceSyncUploadTelemetry(db);
    expect(events.size).toBe(2);
    expect([...events.values()].map((row) => row.event.properties.sync_stage)).toEqual([
      'accepted',
      'failed',
    ]);
    expect(capture).toHaveBeenCalledOnce();
    accept(true, 300);
    settle('uploaded', 400);
    publishWorkspaceSyncUploadTelemetry(db);
    const accepted = [...events.values()].filter(
      (row) => row.event.properties.sync_stage === 'accepted'
    );
    expect(accepted).toHaveLength(2);
    expect(accepted[1]?.event.properties).toMatchObject({
      parent_action_id: first.event.properties.operation_id,
      origin_started_at_ms: 300,
    });
    expect(accepted[1]?.event.properties.operation_id).not.toBe(
      first.event.properties.operation_id
    );
    expect(
      [...events.values()].find((row) => row.event.properties.sync_stage === 'uploaded')
    ).toMatchObject({
      origin,
      event: { properties: { origin_started_at_ms: 300, occurred_at_ms: 400 } },
    });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(JOB.createdAt).toBe(100);
  });

  it('does not invent acceptance at terminal or attach a later opt-in to a reused job', () => {
    origin = null;
    accept();
    origin = ORIGIN;
    settle('uploaded');
    publishWorkspaceSyncUploadTelemetry(db);
    expect(events.size).toBe(0);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('rejects foreign-account replay and changed or removed committed rows', () => {
    accept();
    account = 'account-b';
    publishWorkspaceSyncUploadTelemetry(db);
    expect(events.size).toBe(0);
    account = 'account-a';
    publishWorkspaceSyncUploadTelemetry(db);
    expect(events.size).toBe(1);
    const reader = readers.at(-1)!;
    expect(reader()).not.toBeNull();
    db.prepare('UPDATE settings SET value = ?').run('{"schemaVersion":999}');
    expect(reader()).toBeNull();
    db.prepare('DELETE FROM settings').run();
    expect(reader()).toBeNull();
  });

  it('witnesses the refused optional SQLite insert while preserving native writes', () => {
    let faults = 0;
    db.function('witness_optional_failure', () => {
      faults += 1;
      return 1;
    });
    db.exec(
      `CREATE TABLE mandatory_witness (value TEXT); CREATE TRIGGER reject_receipt_witness BEFORE INSERT ON settings WHEN substr(NEW.key,1,${WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX.length}) = '${WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX}' BEGIN SELECT witness_optional_failure(); SELECT RAISE(ABORT,'receipt insert refused'); END;`
    );
    db.transaction(() => {
      db.prepare('INSERT INTO mandatory_witness VALUES (?)').run('before');
      acceptWorkspaceSyncUploadTelemetry(db, {
        job: JOB,
        ownerAccountId: 'account-a',
        nowMs: 100,
        retry: false,
      });
      db.prepare('INSERT INTO mandatory_witness VALUES (?)').run('after');
    })();
    expect(faults).toBe(1);
    expect(capture).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT value FROM mandatory_witness ORDER BY rowid').all()).toEqual([
      { value: 'before' },
      { value: 'after' },
    ]);
    publishWorkspaceSyncUploadTelemetry(db);
    expect(events.size).toBe(0);
  });

  it('replays positively witnessed committed stages after optional publisher failure without recapturing origin', () => {
    accept();
    expect(capture).toHaveBeenCalledOnce();
    let faults = 0;
    configureWorkspaceSyncUploadTelemetry({
      captureOrigin: () => {
        throw new Error('replay cannot capture a later origin');
      },
      currentAccountId: () => account,
      publish: (reader) => {
        expect(reader()?.event.properties.sync_stage).toBe('accepted');
        faults += 1;
        throw new Error('optional outbox unavailable');
      },
    });
    expect(() => publishWorkspaceSyncUploadTelemetry(db)).not.toThrow();
    expect(faults).toBe(1);
    settle('uploaded', 200);
    configureWorkspaceSyncUploadTelemetry({
      captureOrigin: () => {
        throw new Error('replay cannot capture a later origin');
      },
      currentAccountId: () => account,
      publish: (reader) => {
        const value = reader();
        expect(value).not.toBeNull();
        if (value) events.set(value.event.eventId, value);
        return value !== null;
      },
    });
    publishWorkspaceSyncUploadTelemetry(db);
    expect([...events.values()].map((row) => row.event.properties.sync_stage)).toEqual([
      'accepted',
      'uploaded',
    ]);
    expect(
      [...events.values()].every(
        (row) =>
          row.origin.contextId === ORIGIN.contextId &&
          row.event.properties.origin_started_at_ms === 100
      )
    ).toBe(true);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('refuses an older accepted operation callback after the native job receives an explicit retry', () => {
    accept();
    publishWorkspaceSyncUploadTelemetry(db);
    const oldOperation = [...events.values()][0]!.event.properties.operation_id;
    settle('failed', 200);
    accept(true, 300);
    publishWorkspaceSyncUploadTelemetry(db);
    expect([...events.values()].map((row) => row.event.properties.sync_stage)).toEqual([
      'accepted',
      'failed',
      'accepted',
    ]);
    db.transaction(() =>
      settleWorkspaceSyncUploadTelemetry(db, {
        job: JOB,
        operationId: oldOperation,
        outcome: 'uploaded',
        nowMs: 400,
      })
    )();
    publishWorkspaceSyncUploadTelemetry(db);
    expect([...events.values()].map((row) => row.event.properties.sync_stage)).toEqual([
      'accepted',
      'failed',
      'accepted',
    ]);
  });

  it.each(['operation_uuid', 'stage_clock', 'private_error'] as const)(
    'refuses committed readback after %s corruption with a prior positive stage witness',
    (fault) => {
      accept();
      settle('failed');
      publishWorkspaceSyncUploadTelemetry(db);
      expect(events.size).toBe(2);
      const held = readers.at(-1)!;
      expect(held()?.event.properties.sync_stage).toBe('failed');
      const operationId = [...events.values()][0]!.event.properties.operation_id;
      const [before, after] =
        fault === 'operation_uuid'
          ? [operationId, 'private-operation-identity']
          : fault === 'stage_clock'
            ? ['"occurredAtMs":200', '"occurredAtMs":-1']
            : ['"errorCode":"validation"', '"errorCode":"/private/scientific-content.gb"'];
      const changed = db
        .prepare('UPDATE settings SET value = replace(value,?,?) WHERE key = ?')
        .run(before, after, WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX + JOB.id);
      expect(changed.changes).toBe(1);
      expect(held()).toBeNull();
      publishWorkspaceSyncUploadTelemetry(db);
      expect(events.size).toBe(2);
      expect(JSON.stringify([...events.values()])).not.toContain('/private/scientific-content.gb');
    }
  );

  it('contains optional capture and publisher faults', () => {
    configureWorkspaceSyncUploadTelemetry({
      currentAccountId: () => account,
      captureOrigin: () => {
        throw new Error('optional capture unavailable');
      },
      publish: () => {
        throw new Error('optional publisher unavailable');
      },
    });
    expect(() => accept()).not.toThrow();
    expect(() => publishWorkspaceSyncUploadTelemetry(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 });
  });
});
