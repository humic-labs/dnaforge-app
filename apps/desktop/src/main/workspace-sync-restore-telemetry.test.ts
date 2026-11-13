import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
import { ensureSchema } from './schema';
import { createFileTestDb, openReadonlyFileTestDb } from './__tests__/test-db';
import {
  acceptWorkspaceSyncRestoreTelemetry as accept,
  configureWorkspaceSyncRestoreTelemetry as configure,
  publishWorkspaceSyncRestoreTelemetry as publish,
  purgeWorkspaceSyncRestoreTelemetry as purge,
  settleWorkspaceSyncRestoreTelemetry as settle,
  WORKSPACE_SYNC_RESTORE_RECEIPT_PREFIX as PREFIX,
  type WorkspaceSyncRestoreTelemetryEvent,
} from './workspace-sync-restore-telemetry';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
const LOCK = '44444444-4444-4444-8444-444444444444';
const VERSION = '55555555-5555-4555-8555-555555555555';
const ORIGIN: OptionalTelemetryOrigin = {
  consentScope: randomUUID(),
  contextId: randomUUID(),
  processId: randomUUID(),
  classification: 'synthetic',
};

describe('committed native restore telemetry', () => {
  let file: ReturnType<typeof createFileTestDb>;
  let db: Database.Database;
  let account: string | null;
  let origin: OptionalTelemetryOrigin | null;
  let events: Map<string, WorkspaceSyncRestoreTelemetryEvent>;
  let readers: Array<() => WorkspaceSyncRestoreTelemetryEvent | null>;
  function begin() {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO workspace_sync_restore_locks (workspace_id,lock_id,source_remote_version_id,remote_workspace_id,owner_account_id,status,started_at,expires_at) VALUES (1,?,?,?,'account-a','restoring',100,1000)`
      ).run(LOCK, VERSION, 'private-remote');
      accept(db, LOCK);
    })();
  }
  function finish(status: 'completed' | 'failed' = 'completed', now = 150) {
    db.transaction(() => {
      db.prepare(
        'UPDATE workspace_sync_restore_locks SET status=?,completed_at=?,error_message=? WHERE lock_id=?'
      ).run(
        status,
        now,
        status === 'failed' ? 'PRIVATE_SCIENCE /private/project token=SECRET' : null,
        LOCK
      );
      settle(db, LOCK);
    })();
  }
  function values() {
    return [...events.values()];
  }
  beforeEach(() => {
    file = createFileTestDb('restore-committed');
    db = file.db;
    ensureSchema(db, file.dbPath);
    db.prepare(
      `INSERT INTO workspaces (id,name,path,repo_uuid,created_at,last_opened_at) VALUES (1,'PRIVATE_PROJECT','/private/project','private-workspace',1,1)`
    ).run();
    account = 'account-a';
    origin = ORIGIN;
    events = new Map();
    readers = [];
    configure({
      captureOrigin: () => origin,
      currentAccountId: () => account,
      openCommittedDatabase: (source) => openReadonlyFileTestDb(source.name),
      publish: (reader) => {
        readers.push(reader);
        const value = reader();
        if (!value) return false;
        events.set(value.event.eventId, value);
        return true;
      },
    });
  });
  afterEach(() => {
    configure(null);
    file.cleanup();
    vi.restoreAllMocks();
  });

  it('reads two stable committed stages with native clocks and no project or account data', () => {
    begin();
    publish(db);
    finish();
    publish(db);
    publish(db);
    expect(values().map((v) => v.event.properties.sync_stage)).toEqual(['accepted', 'restored']);
    expect(values().map((v) => v.event.createdAtMs)).toEqual([100, 150]);
    expect(new Set(values().map((v) => v.event.eventId)).size).toBe(2);
    for (const value of values()) {
      expect(value.origin).toEqual(ORIGIN);
      expect(value.event.referenceKind).toBe('workspace_sync_restore');
      expect(value.event.properties).toMatchObject({
        sync_operation: 'restore',
        operation_id: LOCK,
        origin_started_at_ms: 100,
      });
    }
    expect(JSON.stringify(values())).not.toMatch(
      /PRIVATE|private-project|private-remote|private-workspace|account-a|sourceVersionId|ownerAccountId/
    );
    expect(JSON.stringify(values())).not.toContain(VERSION);
  });
  it('rolls optional receipt and native acceptance back together', () => {
    expect(() =>
      db.transaction(() => {
        begin();
        throw new Error('rollback');
      })()
    ).toThrow('rollback');
    publish(db);
    expect(values()).toEqual([]);
    expect(db.prepare('SELECT 1 FROM workspace_sync_restore_locks').get()).toBeUndefined();
  });
  it('isolates optional storage refusal from native acceptance and completion', () => {
    db.exec(
      `CREATE TRIGGER refuse_restore_metrics BEFORE INSERT ON settings WHEN substr(NEW.key,1,${PREFIX.length})='${PREFIX}' BEGIN SELECT RAISE(ABORT,'optional fixture refusal'); END`
    );
    expect(begin).not.toThrow();
    expect(finish).not.toThrow();
    publish(db);
    expect(values()).toEqual([]);
    expect(db.prepare('SELECT status FROM workspace_sync_restore_locks').get()).toEqual({
      status: 'completed',
    });
  });
  it('does not backfill consent after native acceptance', () => {
    origin = null;
    begin();
    origin = ORIGIN;
    finish();
    publish(db);
    expect(values()).toEqual([]);
  });
  it('does not accept origins outside the native write transaction', () => {
    origin = null;
    begin();
    origin = ORIGIN;
    accept(db, LOCK);
    finish();
    publish(db);
    expect(values()).toEqual([]);
  });
  it('refuses current writes and reads the prior committed WAL receipt through a separate connection', () => {
    begin();
    db.transaction(() => publish(db))();
    expect(readers).toEqual([]);
    publish(db);
    const read = readers[0];
    expect(read).toBeDefined();
    expect(() =>
      db.transaction(() => {
        db.prepare(
          "UPDATE settings SET value=json_set(value,'$.attempts[0].origin.classification','private') WHERE key=?"
        ).run(PREFIX + LOCK);
        expect(read()?.origin.classification).toBe('synthetic');
        throw new Error('rollback private fixture');
      })()
    ).toThrow('rollback private fixture');
    expect(read()?.origin.classification).toBe('synthetic');
  });
  it('rejects another account and retired adapters, and purges exact optional receipts without native loss', () => {
    begin();
    publish(db);
    const read = readers[0];
    const native = db.prepare('SELECT * FROM workspace_sync_restore_locks').get();
    account = 'account-b';
    expect(read?.()).toBeNull();
    account = 'account-a';
    const neighbor = PREFIX.replace('v1:', 'v10:') + 'preserved';
    db.prepare('INSERT INTO settings VALUES (?,?,?)').run(neighbor, 'preserved', 1);
    purge(db);
    expect(read?.()).toBeNull();
    expect(db.prepare('SELECT * FROM workspace_sync_restore_locks').get()).toEqual(native);
    expect(db.prepare('SELECT value FROM settings WHERE key=?').get(neighbor)).toEqual({
      value: 'preserved',
    });
    configure(null);
    expect(read?.()).toBeNull();
  });
  it('keeps one sanitized failure terminal and links a new native retry without relabeling the original', () => {
    begin();
    finish('failed');
    publish(db);
    const first = values();
    expect(first.map((v) => v.event.properties.sync_stage)).toEqual(['accepted', 'failed']);
    expect(first[1].event.properties.error_code).toBe('other');
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|SECRET|token|private\/project/);
    db.transaction(() => {
      db.prepare(
        "UPDATE workspace_sync_restore_locks SET status='restoring',started_at=200,completed_at=NULL,error_message=NULL WHERE lock_id=?"
      ).run(LOCK);
      accept(db, LOCK);
    })();
    finish('completed', 250);
    publish(db);
    publish(db);
    expect(values()).toHaveLength(4);
    expect(values().slice(0, 2)).toEqual(first);
    const retry = values()[2].event.properties;
    expect(retry.operation_id).not.toBe(LOCK);
    expect(retry.parent_action_id).toBe(LOCK);
    expect(retry.origin_started_at_ms).toBe(200);
    expect(values()[3].event.createdAtMs).toBe(250);
  });
  it('refuses a terminal from another accepted version or original clock', () => {
    begin();
    db.prepare('UPDATE workspace_sync_restore_locks SET source_remote_version_id=?').run(
      randomUUID()
    );
    finish();
    publish(db);
    expect(values().map((v) => v.event.properties.sync_stage)).toEqual(['accepted']);
  });
  it('refuses malformed persisted lineage without replacing it with a later origin', () => {
    begin();
    const key = PREFIX + LOCK;
    db.prepare(
      "UPDATE settings SET value=json_set(value,'$.attempts[0].parentOperationId',?) WHERE key=?"
    ).run(LOCK, key);
    const corrupted = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    db.transaction(() => accept(db, LOCK))();
    finish();
    publish(db);
    expect(values()).toEqual([]);
    expect(db.prepare('SELECT value FROM settings WHERE key=?').get(key)).toEqual(corrupted);
  });
});
