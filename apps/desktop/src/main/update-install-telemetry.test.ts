import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AnalyticsOutboxAuthority, OptionalTelemetryOrigin } from './analytics-outbox';
import { ANALYTICS_CONSENT_VERSION } from '@waypoint/analytics-policy';
import { createTestDb } from './__tests__/test-db';
import {
  listPendingAnalyticsOutboxEvents,
  purgeAnalyticsOutbox,
  drainAnalyticsOutbox,
} from './analytics-outbox';
import {
  createUpdateInstallMeasurement,
  parseUpdateInstallMeasurement,
  recordUpdateInstallMeasurement as recordCommittedInstallMeasurement,
  type UpdateInstallMeasurementReceipt,
  reconcileUpdateInstallTelemetryReceipt,
  isUpdateDownloadMeasurementPermitted,
  recordUpdateDownloadMeasurement,
} from './update-install-telemetry';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
import { UpdateDownloadEpisodes } from './update-download-episode';

let activeDatabase: Database.Database;
let currentOrigin: OptionalTelemetryOrigin | null;
let committedIntent: UpdateInstallMeasurementReceipt | null = null;
let afterReceiptRead: (() => void) | undefined;
const authority: AnalyticsOutboxAuthority = {
  origin: {
    consentScope: '55700000-0000-4000-8000-000000000001',
    contextId: '55700000-0000-4000-8000-000000000002',
    processId: '55700000-0000-4000-8000-000000000003',
    classification: 'private',
  },
  context: {
    distinctId: '55700000-0000-4000-8000-000000000004',
    sessionId: '55700000-0000-4000-8000-000000000005',
    kind: 'anonymous',
    generation: 1,
  },
  runtimeProperties: { telemetry_actor: 'dev' },
};

vi.mock('./analytics', async () => {
  const { putOriginBoundAnalyticsOutboxEvent } =
    await vi.importActual<typeof import('./analytics-outbox')>('./analytics-outbox');
  const enqueue = (
    origin: OptionalTelemetryOrigin,
    event: Parameters<typeof putOriginBoundAnalyticsOutboxEvent>[1]
  ) => {
    const admissible = () =>
      currentOrigin !== null &&
      origin.consentScope === currentOrigin.consentScope &&
      origin.contextId === currentOrigin.contextId &&
      origin.classification === currentOrigin.classification;
    return (
      admissible() &&
      putOriginBoundAnalyticsOutboxEvent(
        activeDatabase,
        event,
        { ...authority, origin },
        admissible
      )
    );
  };
  return {
    captureOptionalTelemetryOrigin: () => currentOrigin,
    enqueueOptionalAnalyticsEvent: enqueue,
    enqueueOptionalAnalyticsEventFromReceipt: (
      read: () => {
        origin: OptionalTelemetryOrigin;
        event: Parameters<typeof putOriginBoundAnalyticsOutboxEvent>[1];
      } | null
    ) => {
      const first = read();
      afterReceiptRead?.();
      const second = read();
      return (
        first !== null &&
        second !== null &&
        JSON.stringify(first) === JSON.stringify(second) &&
        enqueue(first.origin, first.event)
      );
    },
  };
});

function recordUpdateInstallMeasurement(
  db: Database.Database,
  input: UpdateInstallMeasurementReceipt,
  acceptedNow = false
) {
  committedIntent = JSON.parse(JSON.stringify(input)) as UpdateInstallMeasurementReceipt;
  recordCommittedInstallMeasurement(db, input, acceptedNow, () => committedIntent);
}

function database() {
  const db = createTestDb();
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE analytics_event_outbox (event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL,
      payload_schema_version INTEGER NOT NULL, reference_kind TEXT NOT NULL, reference_id TEXT NOT NULL,
      properties_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, send_attempts INTEGER NOT NULL,
      last_attempt_at_ms INTEGER, sent_at_ms INTEGER, origin_json TEXT);`);
  const put = db.prepare('INSERT INTO settings VALUES (?, ?, ?)');
  put.run('analytics_consent', 'true', 100);
  put.run('analytics_consent_version', String(ANALYTICS_CONSENT_VERSION), 100);
  activeDatabase = db;
  currentOrigin = authority.origin;
  committedIntent = null;
  afterReceiptRead = undefined;
  return db;
}

describe('durable updater accepted-intent measurement', () => {
  it('keeps a sent same-consent download origin through marker reconstruction', async () => {
    const db = database();
    const episodes = new UpdateDownloadEpisodes(db);
    expect(episodes.begin('controlled-bytes', '1.0.0', 1000)).toBe(true);
    const operationId = episodes.operationId!;
    expect(
      recordUpdateDownloadMeasurement(db, 'app_update_download_started', {
        operation_id: operationId,
        occurred_at_ms: 1000,
        version: '2.0.0',
      })
    ).toBe(true);
    expect(episodes.complete('controlled-bytes', '1.0.0', 1125)).toMatchObject({
      download_duration_ms: 125,
    });
    await drainAnalyticsOutbox(
      db,
      {
        origin: authority.origin,
        admissible: () => true,
        deliver: async (events, begin) =>
          events.filter((event) => begin(event.eventId, 1200)).map((event) => event.eventId),
      },
      () => 1200
    );
    const reopened = new UpdateDownloadEpisodes(db);
    expect(reopened.begin('controlled-bytes', '1.0.0', 5000)).toBe(false);
    expect(reopened.complete('controlled-bytes', '1.0.0', 5000)).toBeNull();
    expect(isUpdateDownloadMeasurementPermitted(db, reopened.operationId)).toBe(true);
    const measurement = createUpdateInstallMeasurement(
      db,
      undefined,
      undefined,
      reopened.operationId
    );
    expect(measurement.downloadOperationId).toBe(operationId);
    recordUpdateInstallMeasurement(
      db,
      { fromVersion: '1.0.0', targetVersion: '2.0.0', attemptedAt: 5000, measurement },
      true
    );
    expect(listPendingAnalyticsOutboxEvents(db)[0].properties.download_operation_id).toBe(
      operationId
    );
    db.close();
  });

  it('does not serialize a stale parsed download parent, even when purge and regrant share a timestamp', () => {
    const db = database();
    const episodes = new UpdateDownloadEpisodes(db);
    episodes.begin('controlled-bytes', '1.0.0', 1000);
    const operationId = episodes.operationId!;
    recordUpdateDownloadMeasurement(db, 'app_update_download_started', {
      operation_id: operationId,
      occurred_at_ms: 1000,
    });
    const old = createUpdateInstallMeasurement(db, undefined, undefined, operationId);
    expect(old.downloadOperationId).toBe(operationId);
    purgeAnalyticsOutbox(db);
    expect(isUpdateDownloadMeasurementPermitted(db, operationId)).toBe(false);
    expect(
      createUpdateInstallMeasurement(db, undefined, undefined, operationId)
    ).not.toHaveProperty('downloadOperationId');
    const parsed = parseUpdateInstallMeasurement(JSON.parse(JSON.stringify(old)))!;
    recordUpdateInstallMeasurement(
      db,
      { fromVersion: '1.0.0', targetVersion: '2.0.0', attemptedAt: 2000, measurement: parsed },
      true
    );
    expect(listPendingAnalyticsOutboxEvents(db)).toHaveLength(1);
    expect(listPendingAnalyticsOutboxEvents(db)[0].properties).not.toHaveProperty(
      'download_operation_id'
    );
    expect(JSON.stringify(listPendingAnalyticsOutboxEvents(db))).not.toContain(operationId);
    db.close();
  });

  it('retains original start/terminal clocks and one terminal through repeated restart reconciliation', () => {
    const db = database();
    const measurement = createUpdateInstallMeasurement(db);
    const intent = { fromVersion: '1.0.0', targetVersion: '2.0.0', attemptedAt: 1000, measurement };
    recordUpdateInstallMeasurement(db, intent, true);
    measurement.terminal = { outcome: 'failed', occurredAtMs: 2000, code: 'same_version_relaunch' };
    const reopened = {
      ...intent,
      measurement: parseUpdateInstallMeasurement(JSON.parse(JSON.stringify(measurement))),
    };
    recordUpdateInstallMeasurement(db, reopened);
    recordUpdateInstallMeasurement(db, reopened);
    const rows = listPendingAnalyticsOutboxEvents(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.createdAtMs)).toEqual([1000, 2000]);
    expect(rows[0].properties).toMatchObject({
      operation_id: measurement.operationId,
      action_phase: 'start',
      origin_started_at_ms: 1000,
    });
    expect(rows[1].properties).toMatchObject({
      operation_id: measurement.operationId,
      action_phase: 'error',
      outcome: 'failed',
      occurred_at_ms: 2000,
      error_code: 'same_version_relaunch',
    });
    for (const row of rows)
      expect(sanitizeClosedBetaProperties(row.properties)).toEqual(row.properties);
    expect(JSON.stringify(rows.map((row) => row.properties))).not.toMatch(
      /distinct_id|session_id|person_id|account_id|path|message/
    );
    db.close();
  });

  it('does not recreate a purged start after opt-out and a later grant, even with the same timestamp', () => {
    const db = database();
    const intent = {
      fromVersion: '1.0.0',
      targetVersion: '2.0.0',
      attemptedAt: 1000,
      measurement: createUpdateInstallMeasurement(db),
    };
    recordUpdateInstallMeasurement(db, intent, true);
    purgeAnalyticsOutbox(db);
    intent.measurement.terminal = {
      outcome: 'succeeded',
      occurredAtMs: 2000,
      code: 'version_advanced',
    };
    recordUpdateInstallMeasurement(db, intent);
    expect(listPendingAnalyticsOutboxEvents(db)).toEqual([]);
    db.close();
  });

  it('keeps a never-consented intent out of the outbox after consent changes', () => {
    const db = database();
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('false', 'analytics_consent');
    const intent = {
      fromVersion: '1.0.0',
      targetVersion: '2.0.0',
      attemptedAt: 1000,
      measurement: createUpdateInstallMeasurement(db),
    };
    recordUpdateInstallMeasurement(db, intent, true);
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('true', 'analytics_consent');
    recordUpdateInstallMeasurement(db, intent);
    expect(listPendingAnalyticsOutboxEvents(db)).toEqual([]);
    db.close();
  });

  it('gives an actual retry a new identity and retains its safe parent', () => {
    const db = database();
    const first = createUpdateInstallMeasurement(db);
    const retry = createUpdateInstallMeasurement(db, undefined, first.operationId);
    recordUpdateInstallMeasurement(
      db,
      { fromVersion: '1.0.0', targetVersion: '2.0.0', attemptedAt: 1000, measurement: retry },
      true
    );
    expect(retry.operationId).not.toBe(first.operationId);
    expect(listPendingAnalyticsOutboxEvents(db)[0].properties).toMatchObject({
      retry_parent_attempt_id: first.operationId,
    });
    expect(
      parseUpdateInstallMeasurement({ ...retry, parentAttemptId: '/private/identity' })
    ).toBeUndefined();
    expect(
      parseUpdateInstallMeasurement({
        ...retry,
        terminal: { outcome: 'failed', occurredAtMs: 1000, code: '/private/native-error' },
      })
    ).toBeUndefined();
    db.close();
  });
  it('keeps legacy product intents valid but does not invent an optional origin', () => {
    const db = database();
    const measured = createUpdateInstallMeasurement(db);
    const { telemetryOrigin: _origin, ...legacy } = measured;
    const parsed = parseUpdateInstallMeasurement(legacy);
    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty('telemetryOrigin');
    recordUpdateInstallMeasurement(
      db,
      {
        fromVersion: '1.0.0',
        targetVersion: '2.0.0',
        attemptedAt: 1000,
        measurement: parsed,
      },
      true
    );
    expect(listPendingAnalyticsOutboxEvents(db)).toEqual([]);
    db.close();
  });

  it('refuses a missing or superseded committed file and a receipt changed during admission', () => {
    const db = database();
    const input = {
      fromVersion: '1.0.0',
      targetVersion: '2.0.0',
      attemptedAt: 1000,
      measurement: createUpdateInstallMeasurement(db),
    };
    recordCommittedInstallMeasurement(db, input, true);
    recordCommittedInstallMeasurement(db, input, true, () => null);
    committedIntent = { ...input, attemptedAt: 1001 };
    recordCommittedInstallMeasurement(db, input, true, () => committedIntent);
    committedIntent = JSON.parse(JSON.stringify(input)) as UpdateInstallMeasurementReceipt;
    afterReceiptRead = () => {
      committedIntent = null;
    };
    recordCommittedInstallMeasurement(db, input, true, () => committedIntent);
    expect(listPendingAnalyticsOutboxEvents(db)).toEqual([]);
    db.close();
  });

  it('does not correlate an old accepted row after the consent/context nonce rotates', () => {
    const db = database();
    const input = {
      fromVersion: '1.0.0',
      targetVersion: '2.0.0',
      attemptedAt: 1000,
      measurement: createUpdateInstallMeasurement(db),
    };
    recordUpdateInstallMeasurement(db, input, true);
    currentOrigin = { ...authority.origin, contextId: '55700000-0000-4000-8000-000000000009' };
    input.measurement.terminal = {
      outcome: 'failed',
      occurredAtMs: 2000,
      code: 'same_version_relaunch',
    };
    recordUpdateInstallMeasurement(db, input);
    expect(listPendingAnalyticsOutboxEvents(db)).toHaveLength(1);
    expect(listPendingAnalyticsOutboxEvents(db)[0].properties.action_phase).toBe('start');
    db.close();
  });

  it('repairs a committed startup terminal after product-file consumption and delayed context acceptance', () => {
    const db = database();
    const input = {
      fromVersion: '1.0.0',
      targetVersion: '2.0.0',
      attemptedAt: 1000,
      measurement: createUpdateInstallMeasurement(db),
    };
    recordUpdateInstallMeasurement(db, input, true);
    input.measurement.terminal = {
      outcome: 'succeeded',
      occurredAtMs: 2000,
      code: 'version_advanced',
    };
    currentOrigin = null;
    recordUpdateInstallMeasurement(db, input);
    committedIntent = null;
    expect(listPendingAnalyticsOutboxEvents(db)).toHaveLength(1);
    currentOrigin = authority.origin;
    reconcileUpdateInstallTelemetryReceipt(db);
    reconcileUpdateInstallTelemetryReceipt(db);
    const rows = listPendingAnalyticsOutboxEvents(db);
    expect(rows).toHaveLength(2);
    expect(rows[1].eventId).toBe(input.measurement.terminalEventId);
    expect(rows[1].createdAtMs).toBe(2000);
    expect(rows[1].properties).toMatchObject({
      operation_id: input.measurement.operationId,
      origin_started_at_ms: 1000,
      occurred_at_ms: 2000,
      outcome: 'succeeded',
      action_phase: 'commit',
    });
    expect(
      db
        .prepare("SELECT key FROM settings WHERE key LIKE '_update_install_telemetry_receipt_v1:%'")
        .all()
    ).toEqual([]);
    db.close();
  });

  it('retains independent committed terminals and refuses row-only purge or rotated-scope revival', () => {
    const db = database();
    const inputs = [1000, 1100].map((attemptedAt) => ({
      fromVersion: '1.0.0',
      targetVersion: '2.0.0',
      attemptedAt,
      measurement: createUpdateInstallMeasurement(db),
    }));
    for (const input of inputs) recordUpdateInstallMeasurement(db, input, true);
    currentOrigin = null;
    for (const input of inputs) {
      input.measurement.terminal = {
        outcome: 'failed',
        occurredAtMs: input.attemptedAt + 500,
        code: 'same_version_relaunch',
      };
      recordUpdateInstallMeasurement(db, input);
    }
    expect(
      db
        .prepare("SELECT key FROM settings WHERE key LIKE '_update_install_telemetry_receipt_v1:%'")
        .all()
    ).toHaveLength(2);
    purgeAnalyticsOutbox(db);
    currentOrigin = { ...authority.origin, consentScope: '55700000-0000-4000-8000-000000000009' };
    reconcileUpdateInstallTelemetryReceipt(db);
    expect(listPendingAnalyticsOutboxEvents(db)).toEqual([]);
    db.close();
  });
});
