import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type Database from 'better-sqlite3';

import { SHARE_LINEAGE_RELATIVE_PATH } from '../../shared/share-lineage';
import { computeLimsAuditHash, LIMS_LOCAL_CLIENT_ID } from '../lims-engine-core';
import {
  assertLimsSafetyNotQuarantined,
  describeLimsSafetyAccessState,
  LimsSafetyQuarantinedError,
  readLimsSafetyQuarantineState,
  reconcileLegacyLimsSafetyQuarantine,
} from '../lims-safety-quarantine';
import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';

const testRoots: string[] = [];
const LEGACY_EVENT_CREATED_AT_MS = Date.parse('2026-07-08T00:00:00.000Z');
const LEGACY_ACTIVATION_AT_MS = LEGACY_EVENT_CREATED_AT_MS + 1_000;

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy LIMS activation quarantine', () => {
  it.each(['cloud_restore', 'share_import'] as const)(
    'detects exact historical %s activation, persists a receipt, and blocks LIMS',
    (evidenceKind) => {
      const db = currentDb();
      const root = tempRoot(`lims-quarantine-${evidenceKind}-`);
      const workspaceId = insertWorkspace(db, root);
      const event = legacyExportEvent(77);
      writeLegacyLog(root, event);
      if (evidenceKind === 'cloud_restore') {
        insertCompletedRestore(db, workspaceId);
      } else {
        writeShareLineage(root);
      }
      insertHistoricallyRestoredAudit(db, event, workspaceId);
      markLegacyCandidate(db, workspaceId);

      expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toMatchObject({
        status: 'quarantined',
        evidenceKind,
        evidenceWorkspaceId: workspaceId,
        detectedAt: 1_730_000_000_000,
      });
      expect(() => assertLimsSafetyNotQuarantined(db)).toThrow(LimsSafetyQuarantinedError);
      expect(() =>
        db
          .prepare(
            `INSERT INTO lims_id_scheme
             (kind, prefix, pad_width, next_seq, enabled, updated_at)
             VALUES ('canary', 'CAN', 3, 1, 1, 1)`
          )
          .run()
      ).toThrow('LIMS_SAFETY_QUARANTINED');

      rmSync(join(root, '.waypoint'), { recursive: true, force: true });
      expect(reconcileLegacyLimsSafetyQuarantine(db, 1_740_000_000_000)).toEqual(
        readLimsSafetyQuarantineState(db)
      );
      db.close();
    }
  );

  it.each(['restoring', 'failed'] as const)(
    'detects a historical cloud restore that crashed with a %s lock',
    (restoreStatus) => {
      const db = currentDb();
      const root = tempRoot(`lims-quarantine-${restoreStatus}-lock-`);
      const workspaceId = insertWorkspace(db, root);
      const event = legacyExportEvent(78);
      writeLegacyLog(root, event);
      insertRestoreLock(db, workspaceId, restoreStatus);
      insertHistoricallyRestoredAudit(db, event, workspaceId);
      markLegacyCandidate(db, workspaceId);

      expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toMatchObject({
        status: 'quarantined',
        evidenceKind: 'cloud_restore',
        evidenceWorkspaceId: workspaceId,
      });
      db.close();
    }
  );

  it('does not quarantine a legacy-marked workspace whose local audit identity is different', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-no-match-');
    const workspaceId = insertWorkspace(db, root);
    const event = legacyExportEvent(88);
    writeLegacyLog(root, event);
    writeShareLineage(root);
    insertHistoricallyRestoredAudit(
      db,
      { ...event, payload: { workspaceId: 88, canary: 'DIFFERENT_LOCAL_EVENT' } },
      workspaceId
    );
    markLegacyCandidate(db, workspaceId);

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toBeNull();
    expect(readLimsSafetyQuarantineState(db)).toBeNull();
    expect(
      db
        .prepare(`SELECT 1 FROM lims_safety_legacy_scan_candidates WHERE workspace_id = ?`)
        .get(workspaceId)
    ).toBeUndefined();
    expect(() => assertLimsSafetyNotQuarantined(db)).not.toThrow();
    db.close();
  });

  it.each(['cloud_restore', 'share_import'] as const)(
    'keeps a historical %s candidate unresolved when only an untrusted future event timestamp distinguishes it',
    (evidenceKind) => {
      const db = currentDb();
      const root = tempRoot(`lims-quarantine-post-activation-${evidenceKind}-`);
      const workspaceId = insertWorkspace(db, root);
      const event = {
        ...legacyExportEvent(workspaceId),
        createdAt: new Date(LEGACY_ACTIVATION_AT_MS + 1_000).toISOString(),
        createdAtMs: LEGACY_ACTIVATION_AT_MS + 1_000,
      };
      writeLegacyLog(root, event);
      if (evidenceKind === 'cloud_restore') {
        insertCompletedRestore(db, workspaceId);
      } else {
        writeShareLineage(root);
      }
      insertHistoricallyRestoredAudit(db, event, workspaceId);
      markLegacyCandidate(db, workspaceId);

      expect(reconcileLegacyLimsSafetyQuarantine(db, 1_830_000_000_000)).toEqual({
        status: 'unresolved',
        pendingCandidateCount: 1,
      });
      expect(readLimsSafetyQuarantineState(db)).toBeNull();
      expect(
        db
          .prepare(`SELECT 1 FROM lims_safety_legacy_scan_candidates WHERE workspace_id = ?`)
          .get(workspaceId)
      ).toEqual({ 1: 1 });
      expect(() => assertLimsSafetyNotQuarantined(db)).toThrow(LimsSafetyQuarantinedError);
      db.close();
    }
  );

  it('keeps share evidence unresolved when its activation timestamp is missing', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-share-ambiguous-activation-');
    const workspaceId = insertWorkspace(db, root);
    const event = legacyExportEvent(workspaceId);
    writeLegacyLog(root, event);
    writeShareLineage(root, null);
    insertHistoricallyRestoredAudit(db, event, workspaceId);
    markLegacyCandidate(db, workspaceId);

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_830_000_000_000)).toEqual({
      status: 'unresolved',
      pendingCandidateCount: 1,
    });
    expect(readLimsSafetyQuarantineState(db)).toBeNull();
    db.close();
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a symlinked legacy export outside the managed workspace',
    () => {
      const db = currentDb();
      const root = tempRoot('lims-quarantine-symlink-root-');
      const outside = tempRoot('lims-quarantine-symlink-outside-');
      const workspaceId = insertWorkspace(db, root);
      const event = legacyExportEvent(99);
      writeLegacyLog(outside, event);
      writeShareLineage(root);
      insertHistoricallyRestoredAudit(db, event, workspaceId);
      markLegacyCandidate(db, workspaceId);
      symlinkSync(join(outside, '.waypoint'), join(root, '.waypoint'), 'dir');

      expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toEqual({
        status: 'unresolved',
        pendingCandidateCount: 1,
      });
      expect(readLimsSafetyQuarantineState(db)).toBeNull();
      expect(() => assertLimsSafetyNotQuarantined(db)).toThrow(LimsSafetyQuarantinedError);
      expect(
        db
          .prepare(`SELECT 1 FROM lims_safety_legacy_scan_candidates WHERE workspace_id = ?`)
          .get(workspaceId)
      ).toEqual({ 1: 1 });
      db.close();
    }
  );

  it('keeps a vulnerable candidate blocked when its retained log is missing', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-missing-log-');
    const workspaceId = insertWorkspace(db, root);
    insertCompletedRestore(db, workspaceId);
    markLegacyCandidate(db, workspaceId);

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toEqual({
      status: 'unresolved',
      pendingCandidateCount: 1,
    });
    expect(() => assertLimsSafetyNotQuarantined(db)).toThrow(LimsSafetyQuarantinedError);
    db.close();
  });

  it.each(['cloud_restore', 'share_import'] as const)(
    'clears a historical %s candidate whose exact retained manifest proves zero events',
    (evidenceKind) => {
      const db = currentDb();
      const root = tempRoot(`lims-quarantine-zero-events-${evidenceKind}-`);
      const workspaceId = insertWorkspace(db, root);
      writeZeroEventManifest(root);
      if (evidenceKind === 'cloud_restore') {
        insertCompletedRestore(db, workspaceId);
      } else {
        writeShareLineage(root);
      }
      markLegacyCandidate(db, workspaceId);

      expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toBeNull();
      expect(
        db
          .prepare(`SELECT 1 FROM lims_safety_legacy_scan_candidates WHERE workspace_id = ?`)
          .get(workspaceId)
      ).toBeUndefined();
      expect(() => assertLimsSafetyNotQuarantined(db)).not.toThrow();
      db.close();
    }
  );

  it.each([
    ['malformed', '{not-json'],
    ['nonzero', { version: 1, exportedThroughEventSeq: 1, updatedAt: '2026-07-08T00:00:00Z' }],
    ['unsupported', { version: 2, exportedThroughEventSeq: 0, updatedAt: '' }],
    ['inexact', { version: 1, exportedThroughEventSeq: 0 }],
  ] as const)('keeps a zero-log candidate blocked with a %s manifest', (_case, manifest) => {
    const db = currentDb();
    const root = tempRoot(`lims-quarantine-zero-log-${_case}-`);
    const workspaceId = insertWorkspace(db, root);
    writeLimsManifest(root, manifest);
    insertCompletedRestore(db, workspaceId);
    markLegacyCandidate(db, workspaceId);

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toEqual({
      status: 'unresolved',
      pendingCandidateCount: 1,
    });
    expect(() => assertLimsSafetyNotQuarantined(db)).toThrow(LimsSafetyQuarantinedError);
    db.close();
  });

  it('does not label an unchanged null-workspace event as proven contamination', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-null-workspace-');
    const workspaceId = insertWorkspace(db, root);
    const event = legacyNullWorkspaceExportEvent();
    writeLegacyLog(root, event);
    writeShareLineage(root);
    insertHistoricallyRestoredAudit(db, event, workspaceId);
    markLegacyCandidate(db, workspaceId);

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toEqual({
      status: 'unresolved',
      pendingCandidateCount: 1,
    });
    expect(readLimsSafetyQuarantineState(db)).toBeNull();
    db.close();
  });

  it('does not block LIMS when ordinary project deletion nulls hashed workspace provenance', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-orphaned-workspace-');
    const workspaceId = insertWorkspace(db, root);
    insertHistoricallyRestoredAudit(db, legacyExportEvent(99), workspaceId);

    db.prepare(
      `UPDATE lims_safety_legacy_scan_state
       SET status = 'completed', completed_at = 1
       WHERE id = 1`
    ).run();
    db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);
    db.prepare(
      `UPDATE lims_safety_legacy_scan_state
       SET status = 'pending', completed_at = NULL
       WHERE id = 1`
    ).run();

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toBeNull();
    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_740_000_000_000)).toBeNull();
    expect(readLimsSafetyQuarantineState(db)).toBeNull();
    expect(() => assertLimsSafetyNotQuarantined(db)).not.toThrow();
    expect(() => ensureSchema(db, ':memory:')).not.toThrow();
    expect(() => assertLimsSafetyNotQuarantined(db)).not.toThrow();
    db.close();
  });

  it('repairs the persisted ordinary-deletion false-positive from an older build', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-old-deletion-receipt-');
    const workspaceId = insertWorkspace(db, root);
    insertHistoricallyRestoredAudit(db, legacyExportEvent(99), workspaceId);
    db.prepare(
      `UPDATE lims_safety_legacy_scan_state
       SET status = 'completed', completed_at = 1
       WHERE id = 1`
    ).run();
    db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);
    db.prepare(
      `UPDATE lims_safety_legacy_scan_state
       SET status = 'pending',
           unresolved_reason = 'lims_audit_workspace_provenance_ambiguous',
           unresolved_evidence_json = '{"legacy":true}',
           unresolved_detected_at = 1,
           completed_at = NULL
       WHERE id = 1`
    ).run();

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toBeNull();
    expect(
      db
        .prepare(
          `SELECT status, unresolved_reason, unresolved_evidence_json,
                  unresolved_detected_at
           FROM lims_safety_legacy_scan_state WHERE id = 1`
        )
        .get()
    ).toEqual({
      status: 'completed',
      unresolved_reason: null,
      unresolved_evidence_json: null,
      unresolved_detected_at: null,
    });
    expect(() => assertLimsSafetyNotQuarantined(db)).not.toThrow();
    db.close();
  });

  it('quarantines a true hash mismatch while workspace provenance still exists', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-audit-integrity-');
    const workspaceId = insertWorkspace(db, root);
    insertHistoricallyRestoredAudit(db, legacyExportEvent(99), workspaceId, 'f'.repeat(64));

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toMatchObject({
      status: 'quarantined',
      reason: 'lims_audit_hash_chain_invalid',
      evidenceKind: 'audit_integrity',
      evidenceWorkspaceId: 0,
    });
    expect(() => ensureSchema(db, ':memory:')).not.toThrow();
    expect(() => assertLimsSafetyNotQuarantined(db)).toThrow(LimsSafetyQuarantinedError);
    db.close();
  });

  it('repairs an already-current pending database and reinstalls every write guard', () => {
    const db = currentDb();

    db.prepare(
      `UPDATE lims_safety_legacy_scan_state
       SET status = 'pending', completed_at = NULL
       WHERE id = 1`
    ).run();

    expect(() => ensureSchema(db, ':memory:')).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lims_id_scheme
           (kind, prefix, pad_width, next_seq, enabled, updated_at)
           VALUES ('second-launch-canary', 'SLC', 3, 1, 1, 1)`
        )
        .run()
    ).toThrow('LIMS_SAFETY_QUARANTINED');
    db.close();
  });

  it('does not block on a deleted project whose old event contains a nested project ID', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-orphaned-nested-workspace-');
    const workspaceId = insertWorkspace(db, root);
    const event = {
      ...legacyNullWorkspaceExportEvent(),
      payload: { workspaceId: 404, canary: 'INSTALLATION_GLOBAL_CANARY' },
    };
    insertHistoricallyRestoredAudit(db, event, workspaceId);

    db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toBeNull();
    expect(readLimsSafetyQuarantineState(db)).toBeNull();
    expect(() => assertLimsSafetyNotQuarantined(db)).not.toThrow();
    db.close();
  });

  it('clears an unavailable ordinary project even when healthy audit events reference it', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-missing-ordinary-workspace-');
    const workspaceId = insertWorkspace(db, root);
    insertHistoricallyRestoredAudit(db, legacyExportEvent(workspaceId), workspaceId);
    markLegacyCandidate(db, workspaceId);
    rmSync(root, { recursive: true, force: true });

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toBeNull();
    expect(
      db.prepare(`SELECT status FROM lims_safety_legacy_scan_state WHERE id = 1`).get()
    ).toEqual({ status: 'completed' });
    db.close();
  });

  it('does not quarantine an export the historical importer rejected for duplicate identities', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-duplicate-export-');
    const workspaceId = insertWorkspace(db, root);
    const event = legacyExportEvent(55);
    writeLegacyEvents(root, [event, event]);
    writeShareLineage(root);
    insertHistoricallyRestoredAudit(db, event, workspaceId);
    markLegacyCandidate(db, workspaceId);

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toBeNull();
    expect(readLimsSafetyQuarantineState(db)).toBeNull();
    db.close();
  });

  it('uses the historical actor fallback when legacy actor text is absent', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-actor-fallback-');
    const workspaceId = insertWorkspace(db, root);
    const event = {
      ...legacyExportEvent(55),
      actor: { clientId: null, userId: 'source-user', legacy: null },
    };
    writeLegacyLog(root, event);
    writeShareLineage(root);
    insertHistoricallyRestoredAudit(db, event, workspaceId);
    markLegacyCandidate(db, workspaceId);

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toMatchObject({
      status: 'quarantined',
      evidenceKind: 'share_import',
      evidenceWorkspaceId: workspaceId,
    });
    db.close();
  });

  it('does not let an earlier incomplete identity hide a later importer conflict', () => {
    const db = currentDb();
    const root = tempRoot('lims-quarantine-conflict-after-gap-');
    const workspaceId = insertWorkspace(db, root);
    const first = legacyExportEvent(55);
    const second = {
      ...legacyExportEvent(55),
      eventId: 'legacy-event-2',
      eventSeq: 2,
      idempotencyKey: 'legacy-event-idempotency-2',
      operationId: 'legacy-operation-2',
    };
    writeLegacyEvents(root, [first, second]);
    writeShareLineage(root);
    insertHistoricallyRestoredAudit(
      db,
      { ...second, idempotencyKey: 'different-stored-idempotency-key' },
      workspaceId
    );
    markLegacyCandidate(db, workspaceId);

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000)).toBeNull();
    expect(readLimsSafetyQuarantineState(db)).toBeNull();
    db.close();
  });

  it('rotates a bounded scan across unresolved candidates between launches', () => {
    const db = currentDb();
    const workspaceIds = Array.from({ length: 3 }, (_, index) => {
      const root = tempRoot(`lims-quarantine-budget-${index}-`);
      const workspaceId = insertWorkspace(db, root);
      writeLegacyLog(root, {
        ...legacyExportEvent(70 + index),
        eventId: `budget-event-${index}`,
        idempotencyKey: `budget-key-${index}`,
      });
      writeShareLineage(root);
      markLegacyCandidate(db, workspaceId);
      return workspaceId;
    });

    expect(reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_000, 1)).toEqual({
      status: 'unresolved',
      pendingCandidateCount: 3,
    });
    expect(readLegacyScanCursor(db)).toBe(workspaceIds[0]);

    reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_001, 1);
    expect(readLegacyScanCursor(db)).toBe(workspaceIds[1]);

    reconcileLegacyLimsSafetyQuarantine(db, 1_730_000_000_002, 1);
    expect(readLegacyScanCursor(db)).toBe(workspaceIds[2]);
    db.close();
  });

  it('installs write guards for every LIMS data table and operation', () => {
    const db = currentDb();
    const triggers = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE 'guard_lims_quarantine_%'`
      )
      .all() as Array<{ name: string }>;
    expect(triggers).toHaveLength(21);
    expect(new Set(triggers.map((row) => row.name)).size).toBe(21);
    db.close();
  });

  it.each([
    ['cloud_restore', 'older cloud or shared-project restore'],
    ['share_import', 'older cloud or shared-project restore'],
    ['audit_integrity', 'audit chain no longer matches'],
  ] as const)('describes %s evidence without overstating what it proves', (evidenceKind, text) => {
    const message = describeLimsSafetyAccessState({
      status: 'quarantined',
      reason: 'test-reason',
      evidenceKind,
      evidenceWorkspaceId: 1,
      detectedAt: 1,
    });

    expect(message.summary).toContain(text);
    if (evidenceKind === 'audit_integrity') {
      expect(message.summary).toContain('not proof');
      expect(message.summary).not.toContain('found registry data that an older');
    }
  });
});

interface LegacyEventFixture {
  schema: 'waypoint.lims.event.v1';
  eventId: string;
  eventSeq: number;
  schemaVersion: number;
  idempotencyKey: string;
  operationId: string;
  eventType: string;
  actor: { clientId: string | null; userId: string | null; legacy: string | null };
  createdAt: string;
  createdAtMs: number;
  subjectType: string;
  subjectId: string;
  batchId: null;
  workspaceId: number | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  payload: Record<string, unknown>;
  prevHash: null;
  hash: string;
}

function currentDb(): Database.Database {
  const db = createTestDb();
  ensureSchema(db, ':memory:');
  return db;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  testRoots.push(root);
  return root;
}

function insertWorkspace(db: Database.Database, root: string): number {
  const workspaceId = Number(
    db
      .prepare(
        `INSERT INTO workspaces (name, path, repo_uuid, created_at, last_opened_at)
         VALUES ('Historical workspace', ?, ?, 1, 1)`
      )
      .run(root, `historical-repo:${root}`).lastInsertRowid
  );
  return workspaceId;
}

function markLegacyCandidate(db: Database.Database, workspaceId: number): void {
  db.prepare(
    `UPDATE lims_safety_legacy_scan_state
     SET status = 'pending', completed_at = NULL
     WHERE id = 1`
  ).run();
  db.prepare(`INSERT INTO lims_safety_legacy_scan_candidates (workspace_id) VALUES (?)`).run(
    workspaceId
  );
}

function readLegacyScanCursor(db: Database.Database): number {
  return (
    db
      .prepare(`SELECT last_workspace_id FROM lims_safety_legacy_scan_state WHERE id = 1`)
      .get() as { last_workspace_id: number }
  ).last_workspace_id;
}

function insertCompletedRestore(db: Database.Database, workspaceId: number): void {
  insertRestoreLock(db, workspaceId, 'completed');
}

function insertRestoreLock(
  db: Database.Database,
  workspaceId: number,
  status: 'restoring' | 'failed' | 'completed'
): void {
  db.prepare(
    `INSERT INTO workspace_sync_restore_locks (
       workspace_id, lock_id, source_remote_version_id, status,
       started_at, expires_at, completed_at
     ) VALUES (?, ?, 'remote-version-old', ?, ?, ?, ?)`
  ).run(
    workspaceId,
    `restore-${workspaceId}`,
    status,
    LEGACY_ACTIVATION_AT_MS - 1_000,
    LEGACY_ACTIVATION_AT_MS + 1_000,
    status === 'completed' ? LEGACY_ACTIVATION_AT_MS : null
  );
}

function writeShareLineage(
  root: string,
  importedAtMs: number | null = LEGACY_ACTIVATION_AT_MS
): void {
  const path = join(root, ...SHARE_LINEAGE_RELATIVE_PATH.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      ...(importedAtMs === null ? {} : { importedAt: new Date(importedAtMs).toISOString() }),
    })}\n`,
    'utf8'
  );
}

function writeLegacyLog(root: string, event: LegacyEventFixture): void {
  writeLegacyEvents(root, [event]);
}

function writeZeroEventManifest(root: string): void {
  writeLimsManifest(root, {
    version: 1,
    exportedThroughEventSeq: 0,
    updatedAt: '2026-07-08T00:00:00.000Z',
  });
}

function writeLimsManifest(root: string, manifest: object | string): void {
  const path = join(root, '.waypoint', 'lims', 'manifest.json');
  mkdirSync(dirname(path), { recursive: true });
  const content = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  writeFileSync(path, `${content}\n`, 'utf8');
}

function writeLegacyEvents(root: string, events: readonly LegacyEventFixture[]): void {
  const path = join(root, '.waypoint', 'lims', 'log', '2026-07.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

function legacyExportEvent(sourceWorkspaceId: number): LegacyEventFixture {
  return {
    schema: 'waypoint.lims.event.v1',
    eventId: 'legacy-event-1',
    eventSeq: 1,
    schemaVersion: 1,
    idempotencyKey: 'legacy-event-idempotency-1',
    operationId: 'legacy-operation-1',
    eventType: 'entity_registered',
    actor: { clientId: 'source-client', userId: 'source-user', legacy: 'source-actor' },
    createdAt: '2026-07-08T00:00:00.000Z',
    createdAtMs: LEGACY_EVENT_CREATED_AT_MS,
    subjectType: 'lims_entity',
    subjectId: 'legacy-entity-1',
    batchId: null,
    workspaceId: sourceWorkspaceId,
    before: { workspaceId: sourceWorkspaceId, value: 'before' },
    after: { workspace_id: sourceWorkspaceId, value: 'after' },
    payload: {
      workspaceId: sourceWorkspaceId,
      canary: 'INSTALLATION_GLOBAL_CANARY',
    },
    prevHash: null,
    hash: '0'.repeat(64),
  };
}

function legacyNullWorkspaceExportEvent(): LegacyEventFixture {
  return {
    ...legacyExportEvent(1),
    workspaceId: null,
    before: { value: 'before' },
    after: { value: 'after' },
    payload: { canary: 'INSTALLATION_GLOBAL_CANARY' },
  };
}

function insertHistoricallyRestoredAudit(
  db: Database.Database,
  event: LegacyEventFixture,
  workspaceId: number,
  hashOverride?: string
): void {
  db.prepare(
    `UPDATE lims_safety_legacy_scan_state
     SET status = 'completed', completed_at = 1
     WHERE id = 1`
  ).run();
  const restoredWorkspaceId = event.workspaceId === null ? null : workspaceId;
  const before = remapWorkspaceIds(event.before, workspaceId);
  const after = remapWorkspaceIds(event.after, workspaceId);
  const payload = remapWorkspaceIds(event.payload, workspaceId);
  const restoredHash = computeLimsAuditHash({
    id: event.eventId,
    event_seq: event.eventSeq,
    schema_version: event.schemaVersion,
    idempotency_key: event.idempotencyKey,
    operation_id: event.operationId,
    event_type: event.eventType,
    subject_table: event.subjectType,
    subject_id: event.subjectId,
    batch_id: event.batchId,
    actor: event.actor.legacy ?? event.actor.userId,
    actor_client_id: event.actor.clientId ?? LIMS_LOCAL_CLIENT_ID,
    actor_user_id: event.actor.userId ?? event.actor.legacy ?? event.actor.userId,
    workspace_id: restoredWorkspaceId,
    before,
    after,
    payload,
    prev_hash: null,
    tombstone: 0,
    created_at: event.createdAtMs,
  });
  db.prepare(
    `INSERT INTO lims_audit (
       id, event_seq, schema_version, idempotency_key, operation_id,
       event_type, subject_table, subject_id, batch_id, actor,
       actor_client_id, actor_user_id, workspace_id, before, after, payload,
       prev_hash, hash, tombstone, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)`
  ).run(
    event.eventId,
    event.eventSeq,
    event.schemaVersion,
    event.idempotencyKey,
    event.operationId,
    event.eventType,
    event.subjectType,
    event.subjectId,
    event.batchId,
    event.actor.legacy ?? event.actor.userId,
    event.actor.clientId ?? LIMS_LOCAL_CLIENT_ID,
    event.actor.userId ?? event.actor.legacy ?? event.actor.userId,
    restoredWorkspaceId,
    JSON.stringify(before),
    JSON.stringify(after),
    JSON.stringify(payload),
    hashOverride ?? restoredHash,
    event.createdAtMs
  );
  db.prepare(
    `UPDATE lims_safety_legacy_scan_state
     SET status = 'pending', completed_at = NULL
     WHERE id = 1`
  ).run();
}

function remapWorkspaceIds(value: unknown, workspaceId: number): unknown {
  if (Array.isArray(value)) return value.map((entry) => remapWorkspaceIds(entry, workspaceId));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      (key === 'workspaceId' || key === 'workspace_id') && typeof nested === 'number'
        ? workspaceId
        : remapWorkspaceIds(nested, workspaceId),
    ])
  );
}
