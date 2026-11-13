import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  resolveWorkspaceSyncBundleLimits,
  workspaceSyncBundleHashInput,
  type WorkspaceSyncBundleV1,
} from '@waypoint/share-bundle';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { enqueueWorkspaceSyncJob, type WorkspaceSyncQueueJob } from './workspace-sync-queue';
import type { WorkspaceSyncSnapshot } from './workspace-sync-snapshotter';
import type { WorkspaceSyncRecoveryCandidateIntent } from './workspace-sync-recovery-candidate';
import {
  ensureWorkspaceSyncRecoveryCandidateIntent,
  readWorkspaceSyncRecoveryCandidateIntent,
  recordWorkspaceSyncRecoveryCandidateReceipt,
  recordWorkspaceSyncUploadSnapshot,
} from './workspace-sync-upload-snapshots';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import {
  acceptWorkspaceSyncRecoveryTelemetry,
  configureWorkspaceSyncRecoveryTelemetry,
  publishWorkspaceSyncRecoveryTelemetry,
  purgeWorkspaceSyncRecoveryTelemetry,
  settleWorkspaceSyncRecoveryTelemetry,
  WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX,
  type WorkspaceSyncRecoveryTelemetryEvent,
} from './workspace-sync-recovery-telemetry';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

const ORIGIN: OptionalTelemetryOrigin = {
  consentScope: '11111111-1111-4111-8111-111111111111',
  contextId: '22222222-2222-4222-8222-222222222222',
  processId: '33333333-3333-4333-8333-333333333333',
  classification: 'synthetic',
};
const PRIVATE_CONTENT = 'LOCUS       RECOVERY_PRIVATE\nORIGIN\n        1 acgt\n//\n';

describe('committed native recovery telemetry receipts', () => {
  let db: Database.Database;
  let job: WorkspaceSyncQueueJob;
  let snapshot: WorkspaceSyncSnapshot;
  let origin: OptionalTelemetryOrigin | null;
  let account: string | null;
  let events: Map<string, WorkspaceSyncRecoveryTelemetryEvent>;
  let readers: Array<() => WorkspaceSyncRecoveryTelemetryEvent | null>;
  let capture: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id,name,path,repo_uuid,created_at,last_opened_at)
      VALUES (1,'Project A','/managed/workspace-a/repo','workspace-a',1,1)`
    ).run();
    job = enqueueWorkspaceSyncJob(db, {
      id: 'native-recovery-job',
      workspaceId: 1,
      operation: 'upload',
      nowMs: 10,
    });
    snapshot = testSnapshot(PRIVATE_CONTENT);
    recordWorkspaceSyncUploadSnapshot(db, { jobId: job.id, snapshot, nowMs: 10 });
    origin = ORIGIN;
    account = 'account-a';
    events = new Map();
    readers = [];
    capture = vi.fn(() => origin);
    configureWorkspaceSyncRecoveryTelemetry({
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
    configureWorkspaceSyncRecoveryTelemetry(null);
    db.close();
  });

  function accept(at = 100): WorkspaceSyncRecoveryCandidateIntent {
    return db.transaction(() => {
      const before = readWorkspaceSyncRecoveryCandidateIntent(db, job.id);
      const intent = ensureWorkspaceSyncRecoveryCandidateIntent(db, {
        jobId: job.id,
        ownerAccountId: 'account-a',
        remoteWorkspaceId: 'private-remote',
        localHeadSha: 'private-head',
        snapshotContentSha256: snapshot.contentSha256,
        requestSha256: 'a'.repeat(64),
        uploadIdempotencyKey: 'private-request-key',
        nowMs: at,
      });
      acceptWorkspaceSyncRecoveryTelemetry(db, {
        job,
        intent,
        previousOperationId: before?.acceptedOperationId ?? null,
        nowMs: at,
      });
      return intent;
    })();
  }

  function retain(
    intent: WorkspaceSyncRecoveryCandidateIntent,
    at = 200
  ): WorkspaceSyncRecoveryCandidateIntent {
    return db.transaction(() => {
      recordWorkspaceSyncRecoveryCandidateReceipt(db, {
        jobId: job.id,
        intent,
        nowMs: at,
        receipt: {
          id: '44444444-4444-4444-8444-444444444444',
          accountId: 'account-a',
          baseVersionId: null,
          contentSha256: snapshot.contentSha256,
          requestSha256: intent.requestSha256,
          reason: 'dirty',
          coverage: 'captured-bytes',
          createdAt: '2026-11-02T00:00:00.000Z',
          expiresAt: '2026-11-09T00:00:00.000Z',
        },
      });
      const current = readWorkspaceSyncRecoveryCandidateIntent(db, job.id);
      if (!current) throw new Error('Expected the committed native recovery acknowledgement.');
      settleWorkspaceSyncRecoveryTelemetry(db, { job, intent: current });
      return current;
    })();
  }

  function stages() {
    return [...events.values()].map((value) => value.event.properties.recovery_stage);
  }

  it('publishes native acceptance and first retained acknowledgement with original identity, origin and clocks', () => {
    const intent = accept();
    expect(events.size).toBe(0);
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(stages()).toEqual(['accepted']);
    origin = { ...ORIGIN, processId: '55555555-5555-4555-8555-555555555555' };
    retain(intent);
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(stages()).toEqual(['accepted', 'retained']);
    const [accepted, terminal] = [...events.values()];
    expect(accepted?.event.properties).toMatchObject({
      operation_id: intent.acceptedOperationId,
      origin_started_at_ms: 100,
      occurred_at_ms: 100,
    });
    expect(terminal?.event.properties).toMatchObject({
      operation_id: intent.acceptedOperationId,
      origin_started_at_ms: 100,
      occurred_at_ms: 200,
    });
    expect(terminal?.origin).toEqual(ORIGIN);
    expect(accepted?.event.eventId).not.toBe(terminal?.event.eventId);
    expect(capture).toHaveBeenCalledOnce();
    const wire = JSON.stringify([...events.values()]);
    for (const value of [
      'native-recovery-job',
      'account-a',
      'private-remote',
      'private-head',
      'private-request-key',
      snapshot.contentSha256,
      'a'.repeat(64),
      PRIVATE_CONTENT,
    ])
      expect(wire).not.toContain(value);
  });

  it('rejects publication until the native transaction and database fence release', async () => {
    db.transaction(() => {
      accept();
      publishWorkspaceSyncRecoveryTelemetry(db, job.id);
      expect(events.size).toBe(0);
    })();
    const release = await acquireWorkspaceSyncDatabaseFence(db);
    try {
      publishWorkspaceSyncRecoveryTelemetry(db, job.id);
      expect(events.size).toBe(0);
    } finally {
      release();
    }
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(stages()).toEqual(['accepted']);
  });

  it('leaves no native intent or optional receipt after native transaction rollback', () => {
    expect(() =>
      db.transaction(() => {
        accept();
        throw new Error('native rollback');
      })()
    ).toThrow('native rollback');
    expect(readWorkspaceSyncRecoveryCandidateIntent(db, job.id)).toBeNull();
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(events.size).toBe(0);
  });

  it('does not adopt later consent when an accepted native intent is reused at the same clock', () => {
    origin = null;
    const first = accept();
    origin = ORIGIN;
    expect(accept()).toEqual(first);
    retain(first);
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(events.size).toBe(0);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('preserves mandatory native acceptance and retention when optional SQLite persistence is refused', () => {
    let faults = 0;
    db.function('witness_optional_recovery_refusal', () => {
      faults += 1;
      return 1;
    });
    db.exec(`CREATE TRIGGER refuse_recovery_telemetry BEFORE INSERT ON settings
      WHEN substr(NEW.key,1,${WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX.length}) = '${WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX}'
      BEGIN SELECT witness_optional_recovery_refusal(); SELECT RAISE(ABORT,'optional refused'); END;`);
    const intent = accept();
    expect(faults).toBe(1);
    expect(retain(intent)).toMatchObject({
      acceptedOperationId: intent.acceptedOperationId,
      retainedAtMs: 200,
    });
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(events.size).toBe(0);
  });

  it('uses the original native acknowledgement clock after optional terminal persistence is retried', () => {
    const intent = accept();
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(stages()).toEqual(['accepted']);
    let faults = 0;
    db.function('witness_optional_recovery_terminal_refusal', () => {
      faults += 1;
      return 1;
    });
    db.exec(`CREATE TRIGGER refuse_recovery_terminal BEFORE UPDATE ON settings
      WHEN substr(NEW.key,1,${WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX.length}) = '${WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX}'
      BEGIN SELECT witness_optional_recovery_terminal_refusal(); SELECT RAISE(ABORT,'optional refused'); END;`);
    retain(intent);
    expect(faults).toBe(1);
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(stages()).toEqual(['accepted']);
    db.exec('DROP TRIGGER refuse_recovery_terminal');
    retain(intent, 600);
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(stages()).toEqual(['accepted', 'retained']);
    expect([...events.values()][1]?.event.properties.occurred_at_ms).toBe(200);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('records a distinct native renewal with the prior operation as parent', () => {
    const first = accept();
    retain(first);
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    const renewalAt = Date.parse('2026-11-09T00:00:00.001Z');
    const next = accept(renewalAt);
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(stages()).toEqual(['accepted', 'retained', 'accepted']);
    expect([...events.values()][2]?.event.properties).toMatchObject({
      operation_id: next.acceptedOperationId,
      parent_action_id: first.acceptedOperationId,
      origin_started_at_ms: renewalAt,
      occurred_at_ms: renewalAt,
    });
    expect(next.acceptedOperationId).not.toBe(first.acceptedOperationId);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('does not backfill later origin after optional accepted persistence fails and the native intent is reused at the same clock', () => {
    let faults = 0;
    db.function('witness_optional_recovery_acceptance_failure', () => {
      faults += 1;
      return 1;
    });
    db.exec(`CREATE TRIGGER refuse_recovery_acceptance BEFORE INSERT ON settings
      WHEN substr(NEW.key,1,${WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX.length}) = '${WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX}'
      BEGIN SELECT witness_optional_recovery_acceptance_failure(); SELECT RAISE(ABORT,'optional refused'); END;`);
    const first = accept();
    expect(faults).toBe(1);
    db.exec('DROP TRIGGER refuse_recovery_acceptance');
    origin = { ...ORIGIN, processId: '99999999-9999-4999-8999-999999999999' };
    expect(accept()).toEqual(first);
    retain(first);
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(events.size).toBe(0);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('keeps a legacy native recovery intent unqualified instead of minting an optional identity', () => {
    origin = null;
    accept();
    db.prepare(
      `UPDATE workspace_sync_upload_snapshots SET bundle_json = json_remove(bundle_json, '$.recoveryCandidate.acceptedOperationId', '$.recoveryCandidate.parentAcceptedOperationId') WHERE job_id = ?`
    ).run(job.id);
    const legacy = readWorkspaceSyncRecoveryCandidateIntent(db, job.id);
    if (!legacy) throw new Error('Expected the retained legacy intent shape.');
    origin = ORIGIN;
    db.transaction(() =>
      acceptWorkspaceSyncRecoveryTelemetry(db, {
        job,
        intent: legacy,
        previousOperationId: null,
        nowMs: 100,
      })
    )();
    expect(retain(legacy)).toMatchObject({
      acceptedOperationId: null,
      createdAtMs: 100,
      retainedAtMs: 200,
    });
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(events.size).toBe(0);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('does not reconstruct a missing native retention clock from acknowledgement replay', () => {
    const intent = accept();
    db.transaction(() =>
      recordWorkspaceSyncRecoveryCandidateReceipt(db, {
        jobId: job.id,
        intent,
        nowMs: 200,
        receipt: {
          id: '44444444-4444-4444-8444-444444444444',
          accountId: 'account-a',
          baseVersionId: null,
          contentSha256: snapshot.contentSha256,
          requestSha256: intent.requestSha256,
          reason: 'dirty',
          coverage: 'captured-bytes',
          createdAt: '2026-11-02T00:00:00.000Z',
          expiresAt: '2026-11-09T00:00:00.000Z',
        },
      })
    )();
    db.prepare(
      `UPDATE workspace_sync_upload_snapshots SET bundle_json = json_remove(bundle_json, '$.recoveryCandidate.retainedAtMs') WHERE job_id = ?`
    ).run(job.id);
    expect(retain(intent, 600).retainedAtMs).toBeNull();
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(stages()).toEqual(['accepted']);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('retires committed readers on account change and purges only its exact receipt prefix', () => {
    accept();
    publishWorkspaceSyncRecoveryTelemetry(db, job.id);
    expect(stages()).toEqual(['accepted']);
    account = 'account-b';
    expect(readers[0]?.()).toBeNull();
    const neighbor = WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX.slice(0, -1) + 'X:keep';
    db.prepare('INSERT INTO settings(key,value,updated_at)VALUES(?,?,?)').run(
      neighbor,
      'preserve',
      1
    );
    db.prepare('INSERT INTO settings(key,value,updated_at)VALUES(?,?,?)').run(
      '_cloud_backup_telemetry_receipt_v2:keep',
      'preserve upload',
      1
    );
    purgeWorkspaceSyncRecoveryTelemetry(db);
    expect(
      db
        .prepare('SELECT key FROM settings WHERE key = ?')
        .get(WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX + job.id)
    ).toBeUndefined();
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(neighbor)).toEqual({
      value: 'preserve',
    });
    expect(
      db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('_cloud_backup_telemetry_receipt_v2:keep')
    ).toEqual({ value: 'preserve upload' });
  });
});

function testSnapshot(content: string): WorkspaceSyncSnapshot {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const bundle: WorkspaceSyncBundleV1 = {
    schemaVersion: 1,
    capturedAt: '2026-08-25T00:00:00.000Z',
    workspace: { id: 'workspace-a', name: 'Project A' },
    files: [
      {
        id: 'file-a',
        relativePath: 'design.gb',
        name: 'design.gb',
        kind: 'genbank',
        contentType: 'text/plain',
        sizeBytes,
        sha256: sha256(content),
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
    limits: resolveWorkspaceSyncBundleLimits(),
    provenance: {
      source: 'dnaforge-desktop',
      appVersion: '0.8.1',
      contentSha256: '0'.repeat(64),
    },
  };
  const contentSha256 = sha256(workspaceSyncBundleHashInput(bundle));
  bundle.provenance.contentSha256 = contentSha256;
  return {
    workspaceId: 1,
    workspaceUuid: 'workspace-a',
    repoPath: '/managed/workspace-a/repo',
    bundle,
    contentSha256,
    bundleSizeBytes: Buffer.byteLength(JSON.stringify(bundle), 'utf8'),
    includedFileCount: 1,
    includedBytes: sizeBytes,
    excludedSummary: bundle.excludedSummary,
    statusExcludedSummary: {
      unsupportedCount: 0,
      privateRawDataCount: 0,
      referencePointerCount: 0,
      fileTooLargeCount: 0,
      bundleTooLargeCount: 0,
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
