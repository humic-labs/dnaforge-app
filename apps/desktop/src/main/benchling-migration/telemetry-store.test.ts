import { describe, expect, it, vi } from 'vitest';
import type { FileMigrationScope, MigrationRun } from '../../shared/benchling-migration';
import { createTestDb } from '../__tests__/test-db';
import {
  listPendingAnalyticsOutboxEvents,
  putOriginBoundAnalyticsOutboxEvent,
  type CommittedOptionalAnalyticsReceipt,
} from '../analytics-outbox';
import { transitionMigrationRun } from './state-machine';
import { MigrationStore } from './store';
import { reconcileBenchlingMigrationTelemetryOutbox } from './telemetry-outbox';

function run(): MigrationRun & { scope: FileMigrationScope } {
  return {
    version: 1,
    id: 'private-run-id',
    workspaceId: 'private-workspace-id',
    workspacePath: '/Users/scientist/Private Project/repo',
    displayName: 'Private Project',
    scope: {
      version: 1,
      kind: 'file',
      source: {
        id: 'seq_private',
        url: 'https://private.benchling.com/private/seq_private',
        objectType: 'dna_sequence',
      },
    },
    binding: null,
    state: 'draft',
    resumeState: null,
    attempt: 0,
    converterVersions: { app: '1' },
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    startedAt: null,
    unlockedAt: null,
    lastError: null,
  };
}

function scalarProperties(properties: object): Record<string, string | number | boolean> {
  const scalars: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(properties)) {
    const value: unknown = entry;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`Analytics outbox property ${key} is not scalar.`);
    }
    scalars[key] = value;
  }
  return scalars;
}

function createOutboxDb() {
  const db = createTestDb();
  db.exec(`CREATE TABLE analytics_event_outbox (
    event_id TEXT PRIMARY KEY NOT NULL,
    event_name TEXT NOT NULL,
    payload_schema_version INTEGER NOT NULL,
    reference_kind TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    properties_json TEXT NOT NULL CHECK(json_valid(properties_json)),
    created_at_ms INTEGER NOT NULL,
    send_attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at_ms INTEGER,
    sent_at_ms INTEGER,
    origin_json TEXT
  )`);
  return db;
}

describe('Benchling migration telemetry durability', () => {
  it('publishes one committed start, terminal and issue with the original clocks and shared attempt', () => {
    const origin = {
      consentScope: '11111111-1111-4111-8111-111111111111',
      contextId: '22222222-2222-4222-8222-222222222222',
      processId: '33333333-3333-4333-8333-333333333333',
      classification: 'synthetic' as const,
    };
    const localDb = createTestDb();
    const store = new MigrationStore(localDb, false, {}, { captureOrigin: () => origin });
    const globalDb = createOutboxDb();
    const telemetry = {
      publish<Properties extends object>(
        readCommitted: () => CommittedOptionalAnalyticsReceipt<Properties> | null
      ) {
        const receipt = readCommitted();
        return receipt
          ? putOriginBoundAnalyticsOutboxEvent(
              globalDb,
              { ...receipt.event, properties: scalarProperties(receipt.event.properties) },
              {
                origin: receipt.origin,
                context: {
                  distinctId: '55555555-5555-4555-8555-555555555555',
                  sessionId: '66666666-6666-4666-8666-666666666666',
                  kind: 'anonymous',
                  generation: 1,
                },
                runtimeProperties: {},
              },
              () => true
            )
          : false;
      },
    };
    const initial = run();
    store.saveRun(initial);
    const active = store.getActiveMigrationTelemetryAttempt(initial.id);
    if (!active) throw new Error('Accepted import has no telemetry identity.');
    reconcileBenchlingMigrationTelemetryOutbox(store, globalDb, initial.id, telemetry);
    store.saveRun(
      transitionMigrationRun(initial, 'failed', '2026-09-02T10:00:03.000Z', {
        code: 'validation_failed',
        message: 'Private provider payload and sequence ACTG failed.',
        blocking: true,
      })
    );
    reconcileBenchlingMigrationTelemetryOutbox(store, globalDb, initial.id, telemetry);
    reconcileBenchlingMigrationTelemetryOutbox(store, globalDb, initial.id, telemetry);
    const events = listPendingAnalyticsOutboxEvents(globalDb);
    expect(events.map((event) => event.eventName).sort()).toEqual([
      'benchling_migration_attempt_finished',
      'benchling_migration_attempt_started',
      'benchling_migration_issue_summary',
    ]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
    expect(events.every((event) => event.authority?.origin.contextId === origin.contextId)).toBe(
      true
    );
    expect(
      events.every((event) => event.properties.attempt_correlation_id === active.attemptId)
    ).toBe(true);
    expect(events.find((event) => event.eventName.endsWith('_started'))?.createdAtMs).toBe(
      Date.parse(initial.createdAt)
    );
    expect(events.find((event) => event.eventName.endsWith('_finished'))?.createdAtMs).toBe(
      Date.parse('2026-09-02T10:00:03.000Z')
    );
    const wireProperties = JSON.stringify(events.map((event) => event.properties));
    for (const forbidden of [
      'ACTG',
      initial.id,
      initial.workspaceId,
      initial.workspacePath,
      initial.displayName,
      initial.scope.source.id,
      initial.scope.source.url,
      origin.consentScope,
      origin.contextId,
      origin.processId,
    ]) {
      if (forbidden) expect(wireProperties).not.toContain(forbidden);
    }
    store.ensureMigrationTelemetryAttempt({
      runId: initial.id,
      sourceAttemptReference: 'initial_import:1',
      operation: 'initial_import',
      startedAt: '2026-09-02T10:00:04.000Z',
    });
    reconcileBenchlingMigrationTelemetryOutbox(store, globalDb, initial.id, telemetry);
    const retry = listPendingAnalyticsOutboxEvents(globalDb).find(
      (event) => event.properties.retry_parent_attempt_id === active.attemptId
    );
    expect(retry?.eventName).toBe('benchling_migration_attempt_started');
    expect(retry?.properties.attempt_correlation_id).not.toBe(active.attemptId);
    store.close();
    localDb.close();
    globalDb.close();
  });

  it.each(['no consent', 'legacy'])(
    'does not adopt later authority for an accepted attempt with %s',
    (mode) => {
      const db = createTestDb();
      const initial = run();
      const first = new MigrationStore(
        db,
        false,
        {},
        mode === 'legacy' ? null : { captureOrigin: () => null }
      );
      first.saveRun(initial);
      first.close();
      const captureOrigin = vi.fn(() => ({
        consentScope: '11111111-1111-4111-8111-111111111111',
        contextId: '22222222-2222-4222-8222-222222222222',
        processId: '33333333-3333-4333-8333-333333333333',
        classification: 'synthetic' as const,
      }));
      const reopened = new MigrationStore(db, false, {}, { captureOrigin });
      reopened.saveRun(
        transitionMigrationRun(initial, 'failed', '2026-09-02T10:00:03.000Z', {
          code: 'validation_failed',
          message: 'Controlled failure after context changed.',
          blocking: true,
        })
      );
      const globalDb = createOutboxDb();
      const delivered: CommittedOptionalAnalyticsReceipt<object>[] = [];
      reconcileBenchlingMigrationTelemetryOutbox(reopened, globalDb, initial.id, {
        publish(read) {
          const receipt = read();
          if (receipt) delivered.push(receipt);
          return receipt !== null;
        },
      });
      expect(captureOrigin).not.toHaveBeenCalled();
      expect(delivered).toEqual([]);
      reopened.close();
      db.close();
      globalDb.close();
    }
  );

  it('keeps acceptance and attempt atomic and refuses publication before commit', () => {
    const db = createTestDb();
    const store = new MigrationStore(db, false, {}, { captureOrigin: () => null });
    const initial = run();
    expect(() =>
      db.transaction(() => {
        store.saveRun(initial);
        expect(store.listMigrationTelemetryAcceptances(initial.id)).toEqual([]);
        throw new Error('Controlled acceptance rollback.');
      })()
    ).toThrow('Controlled acceptance rollback.');
    expect(store.getRun()).toBeNull();
    expect(store.listMigrationTelemetryAcceptances(initial.id)).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM migration_telemetry_attempt').get()).toEqual({
      n: 0,
    });
    store.close();
    db.close();
  });

  it('does not count adoption of an existing project as an initial import', () => {
    const db = createTestDb();
    const captureOrigin = vi.fn(() => null);
    const store = new MigrationStore(db, false, {}, { captureOrigin });
    store.saveRun({ ...run(), workspaceOrigin: { kind: 'adopted_existing', workspaceDbId: 1 } });
    expect(store.getActiveMigrationTelemetryAttempt('private-run-id')).toBeNull();
    expect(store.listMigrationTelemetryAcceptances('private-run-id')).toEqual([]);
    expect(captureOrigin).not.toHaveBeenCalled();
    store.close();
    db.close();
  });

  it('freezes analytics authority at accepted start instead of terminal publication', () => {
    const origin = {
      consentScope: '11111111-1111-4111-8111-111111111111',
      contextId: '22222222-2222-4222-8222-222222222222',
      processId: '33333333-3333-4333-8333-333333333333',
      classification: 'synthetic' as const,
    };
    const captureOrigin = vi.fn(() => origin);
    const db = createTestDb();
    const store = new MigrationStore(db, false, {}, { captureOrigin });
    const initial = run();
    store.saveRun(initial);
    expect(captureOrigin).toHaveBeenCalledOnce();
    const active = store.getActiveMigrationTelemetryAttempt(initial.id, 'initial_import');
    if (!active) throw new Error('Accepted import has no durable telemetry identity.');
    const accepted = store.getMigrationTelemetryAcceptance(active.attemptId);
    expect(accepted).toMatchObject({
      attemptId: active.attemptId,
      origin,
      startedAt: initial.createdAt,
      parentAttemptId: null,
    });
    captureOrigin.mockReturnValue({ ...origin, contextId: '44444444-4444-4444-8444-444444444444' });
    store.saveRun(
      transitionMigrationRun(initial, 'failed', '2026-09-02T10:00:03.000Z', {
        code: 'validation_failed',
        message: 'Controlled validation failure.',
        blocking: true,
      })
    );
    expect(captureOrigin).toHaveBeenCalledOnce();
    expect(store.getMigrationTelemetryAcceptance(active.attemptId)).toEqual(accepted);
    const retry = store.ensureMigrationTelemetryAttempt({
      runId: initial.id,
      sourceAttemptReference: 'initial_import:1',
      operation: 'initial_import',
      startedAt: '2026-09-02T10:00:04.000Z',
    });
    expect(retry.attemptId).not.toBe(active.attemptId);
    expect(store.getMigrationTelemetryAcceptance(retry.attemptId)).toMatchObject({
      parentAttemptId: active.attemptId,
      origin: { contextId: '44444444-4444-4444-8444-444444444444' },
    });
    store.close();
    db.close();
  });

  it('persists one immutable terminal receipt and allocates monotonic attempt sequences', () => {
    const db = createTestDb();
    const store = new MigrationStore(db);
    const initial = run();
    store.saveRun(initial);
    const active = store.getActiveMigrationTelemetryAttempt(initial.id, 'initial_import');
    expect(active).toMatchObject({
      runId: initial.id,
      operation: 'initial_import',
      sourceAttemptReference: 'initial_import:0',
      attemptSequence: 1,
    });

    const failed = transitionMigrationRun(initial, 'failed', '2026-09-02T10:00:03.000Z', {
      code: 'validation_failed',
      message: 'Private provider payload and sequence ACTG failed.',
      blocking: true,
    });
    store.saveRun(failed);
    store.saveRun(failed);
    const receipts = store.listMigrationTelemetryTerminalReceipts(initial.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      identity: { attemptId: active?.attemptId, terminalEventId: active?.terminalEventId },
      outcome: 'failed',
      terminalStage: 'intake',
      primaryIssueCode: 'validation_failed',
    });
    expect(JSON.stringify(receipts)).not.toContain('ACTG');
    expect(() =>
      store.putMigrationTelemetryTerminalReceipt({
        ...receipts[0],
        terminalStage: 'unknown',
      })
    ).toThrow('immutable');

    const retry = store.ensureMigrationTelemetryAttempt({
      runId: initial.id,
      sourceAttemptReference: 'initial_import:1',
      operation: 'initial_import',
      startedAt: '2026-09-02T10:00:04.000Z',
    });
    expect(retry.attemptSequence).toBe(2);
    expect(retry.attemptId).not.toBe(active?.attemptId);
    store.close();
  });

  it('reconciles unbound terminal and issue receipts idempotently', () => {
    const localDb = createTestDb();
    const store = new MigrationStore(localDb);
    const initial = run();
    store.saveRun(initial);
    store.saveRun(
      transitionMigrationRun(initial, 'failed', '2026-09-02T10:00:03.000Z', {
        code: 'validation_failed',
        message: 'Private filename and provider body.',
        blocking: true,
      })
    );
    const globalDb = createOutboxDb();

    expect(reconcileBenchlingMigrationTelemetryOutbox(store, globalDb, initial.id)).toEqual({
      attempts: 1,
      issues: 1,
    });
    reconcileBenchlingMigrationTelemetryOutbox(store, globalDb, initial.id);

    const events = listPendingAnalyticsOutboxEvents(globalDb);
    expect(events.map((event) => event.eventName).sort()).toEqual(
      ['benchling_migration_attempt_finished', 'benchling_migration_issue_summary'].sort()
    );
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
    expect(events.map((event) => event.authority)).toEqual([null, null]);
    expect(events.map((event) => event.sentAtMs)).toEqual([null, null]);
    const egress = JSON.stringify(events.map((event) => event.properties));
    for (const forbidden of [
      'private-run-id',
      'private-workspace-id',
      'Private Project',
      '/Users/scientist',
      'private.benchling.com',
      'seq_private',
      'Private filename',
    ]) {
      expect(egress).not.toContain(forbidden);
    }
    store.close();
    globalDb.close();
  });
});
