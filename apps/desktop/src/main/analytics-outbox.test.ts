import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import {
  ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
  drainAnalyticsOutbox,
  listPendingAnalyticsOutboxEvents,
  putAnalyticsOutboxEvent,
  putOriginBoundAnalyticsOutboxEvent,
  type AnalyticsOutboxAuthority,
  type AnalyticsOutboxInput,
  type AnalyticsOutboxDelivery,
} from './analytics-outbox';

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
function bound(db: ReturnType<typeof createOutboxDb>, input: AnalyticsOutboxInput) {
  expect(putOriginBoundAnalyticsOutboxEvent(db, input, authority, () => true)).toBe(true);
}
function delivery(accept: boolean, at: number, emit = vi.fn()): AnalyticsOutboxDelivery {
  return {
    origin: authority.origin,
    admissible: () => true,
    deliver: async (events, begin) => {
      const offered = events.filter((event) => begin(event.eventId, at));
      for (const event of offered) emit(event.eventName, event.properties);
      return accept ? offered.map((event) => event.eventId) : [];
    },
  };
}

describe('durable analytics outbox', () => {
  function input(): AnalyticsOutboxInput {
    const id = randomUUID();
    return {
      eventId: id,
      eventName: 'benchling_migration_run_disposition_changed',
      payloadSchemaVersion: 1,
      referenceKind: 'benchling_migration_disposition',
      referenceId: id,
      properties: { $insert_id: id, prior_outcome: 'failed', disposition: 'discarded' },
      createdAtMs: 100,
    };
  }

  it('quarantines legacy optional rows, including already-SENT rows, without upgrading their origin', async () => {
    const db = createOutboxDb();
    try {
      const event = input();
      putAnalyticsOutboxEvent(db, event);
      expect(putOriginBoundAnalyticsOutboxEvent(db, event, authority, () => true)).toBe(false);
      const send = vi.fn(async () => [event.eventId]);
      expect(
        await drainAnalyticsOutbox(db, {
          origin: authority.origin,
          admissible: () => true,
          deliver: send,
        })
      ).toEqual({ attempted: 0, sent: 0, pending: 1 });
      expect(send).not.toHaveBeenCalled();
      db.prepare('UPDATE analytics_event_outbox SET sent_at_ms = 300').run();
      expect(putOriginBoundAnalyticsOutboxEvent(db, event, authority, () => true)).toBe(false);
      expect(db.prepare('SELECT origin_json FROM analytics_event_outbox').get()).toEqual({
        origin_json: null,
      });
    } finally {
      db.close();
    }
  });

  it('requires current authority even for an equal SENT row and rejects immutable mismatches', () => {
    const db = createOutboxDb();
    try {
      const event = input();
      bound(db, event);
      db.prepare('UPDATE analytics_event_outbox SET sent_at_ms = 300').run();
      const before = db.prepare('SELECT * FROM analytics_event_outbox').get();
      expect(putOriginBoundAnalyticsOutboxEvent(db, event, authority, () => true)).toBe(true);
      expect(putOriginBoundAnalyticsOutboxEvent(db, event, authority, () => false)).toBe(false);
      expect(
        putOriginBoundAnalyticsOutboxEvent(
          db,
          { ...event, createdAtMs: 200 },
          authority,
          () => true
        )
      ).toBe(false);
      expect(
        putOriginBoundAnalyticsOutboxEvent(
          db,
          { ...event, properties: { disposition: 'changed' } },
          authority,
          () => true
        )
      ).toBe(false);
      expect(db.prepare('SELECT * FROM analytics_event_outbox').get()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('rolls back a new row if final admission closes after its insert', () => {
    const db = createOutboxDb();
    try {
      const event = input();
      let checks = 0;
      expect(putOriginBoundAnalyticsOutboxEvent(db, event, authority, () => ++checks < 3)).toBe(
        false
      );
      expect(checks).toBe(3);
      expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
        n: 0,
      });
    } finally {
      db.close();
    }
  });

  it('selects current rows before the batch limit despite legacy, malformed and old-context rows', async () => {
    const db = createOutboxDb();
    try {
      for (let n = 0; n < 105; n++) putAnalyticsOutboxEvent(db, { ...input(), createdAtMs: n });
      const corrupt = input();
      putAnalyticsOutboxEvent(db, corrupt);
      db.prepare('UPDATE analytics_event_outbox SET origin_json = ? WHERE event_id = ?').run(
        '{broken',
        corrupt.eventId
      );
      const retired = input();
      expect(
        putOriginBoundAnalyticsOutboxEvent(
          db,
          retired,
          { ...authority, origin: { ...authority.origin, contextId: randomUUID() } },
          () => true
        )
      ).toBe(true);
      const current = { ...input(), createdAtMs: 1000 };
      bound(db, current);
      expect(await drainAnalyticsOutbox(db, delivery(true, 2000), () => 2001, 1)).toEqual({
        attempted: 1,
        sent: 1,
        pending: 107,
      });
      expect(
        db.prepare('SELECT event_id FROM analytics_event_outbox WHERE sent_at_ms IS NOT NULL').all()
      ).toEqual([{ event_id: current.eventId }]);
    } finally {
      db.close();
    }
  });

  it('marks only exact attempted acknowledged IDs, retaining partial/unrelated rows as pending', async () => {
    const db = createOutboxDb();
    try {
      const events = [input(), input(), input()];
      events.forEach((event) => bound(db, event));
      const result = await drainAnalyticsOutbox(
        db,
        {
          origin: authority.origin,
          admissible: () => true,
          deliver: async (offered, begin) => {
            offered.forEach((event) => begin(event.eventId, 200));
            return [events[0]!.eventId, randomUUID()];
          },
        },
        () => 300
      );
      expect(result).toEqual({ attempted: 3, sent: 1, pending: 2 });
      expect(
        db
          .prepare(
            'SELECT event_id, last_attempt_at_ms, sent_at_ms FROM analytics_event_outbox WHERE sent_at_ms IS NOT NULL'
          )
          .all()
      ).toEqual([{ event_id: events[0]!.eventId, last_attempt_at_ms: 200, sent_at_ms: 300 }]);
    } finally {
      db.close();
    }
  });

  it('rechecks authority after async delivery and never turns an in-flight revoke into SENT', async () => {
    const db = createOutboxDb();
    try {
      const event = input();
      bound(db, event);
      let current = true;
      expect(
        await drainAnalyticsOutbox(
          db,
          {
            origin: authority.origin,
            admissible: () => current,
            deliver: async (_events, begin) => {
              expect(begin(event.eventId, 200)).toBe(true);
              await Promise.resolve();
              current = false;
              return [event.eventId];
            },
          },
          () => 300
        )
      ).toEqual({ attempted: 1, sent: 0, pending: 1 });
      expect(listPendingAnalyticsOutboxEvents(db)[0]).toMatchObject({
        createdAtMs: 100,
        lastAttemptAtMs: 200,
        sentAtMs: null,
      });
    } finally {
      db.close();
    }
  });

  it('preserves a raw delivery failure and pending row without inventing acknowledgment', async () => {
    const db = createOutboxDb();
    try {
      const event = input();
      bound(db, event);
      const failure = Object.freeze(new Error('controlled transport refusal'));
      await expect(
        drainAnalyticsOutbox(db, {
          origin: authority.origin,
          admissible: () => true,
          deliver: async (_events, begin) => {
            begin(event.eventId, 200);
            throw failure;
          },
        })
      ).rejects.toBe(failure);
      expect(listPendingAnalyticsOutboxEvents(db)[0]).toMatchObject({
        sendAttempts: 1,
        sentAtMs: null,
      });
    } finally {
      db.close();
    }
  });
  it('keeps a rejected send pending and marks the same stable event sent after retry', async () => {
    const db = createOutboxDb();
    const eventId = randomUUID();
    bound(db, {
      eventId,
      eventName: 'benchling_migration_run_disposition_changed',
      payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
      referenceKind: 'benchling_migration_disposition',
      referenceId: eventId,
      properties: {
        $insert_id: eventId,
        prior_outcome: 'failed',
        disposition: 'discarded',
      },
      createdAtMs: 100,
    });

    await expect(drainAnalyticsOutbox(db, delivery(false, 200), () => 200)).resolves.toEqual({
      attempted: 1,
      sent: 0,
      pending: 1,
    });
    const emit = vi.fn(() => true);
    await expect(drainAnalyticsOutbox(db, delivery(true, 300, emit), () => 300)).resolves.toEqual({
      attempted: 1,
      sent: 1,
      pending: 0,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare('SELECT send_attempts, last_attempt_at_ms, sent_at_ms FROM analytics_event_outbox')
        .get()
    ).toEqual({ send_attempts: 2, last_attempt_at_ms: 300, sent_at_ms: 300 });
    expect(listPendingAnalyticsOutboxEvents(db)).toEqual([]);
    db.close();
  });

  it('does not mark accepted events sent until delivery is confirmed', async () => {
    const db = createOutboxDb();
    const eventId = randomUUID();
    bound(db, {
      eventId,
      eventName: 'benchling_migration_run_disposition_changed',
      payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
      referenceKind: 'benchling_migration_disposition',
      referenceId: eventId,
      properties: { $insert_id: eventId, prior_outcome: 'failed', disposition: 'discarded' },
      createdAtMs: 100,
    });

    await expect(drainAnalyticsOutbox(db, delivery(false, 200), () => 200)).resolves.toEqual({
      attempted: 1,
      sent: 0,
      pending: 1,
    });
    expect(listPendingAnalyticsOutboxEvents(db)[0]).toMatchObject({
      eventId,
      sendAttempts: 1,
      sentAtMs: null,
    });
    db.close();
  });

  it('is idempotent for an identical event and rejects payload mutation under one ID', () => {
    const db = createOutboxDb();
    const eventId = randomUUID();
    const event = {
      eventId,
      eventName: 'benchling_migration_run_disposition_changed' as const,
      payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
      referenceKind: 'benchling_migration_disposition' as const,
      referenceId: eventId,
      properties: { $insert_id: eventId, prior_outcome: 'failed', disposition: 'discarded' },
      createdAtMs: 100,
    };
    putAnalyticsOutboxEvent(db, event);
    putAnalyticsOutboxEvent(db, event);
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_event_outbox').get()).toEqual({
      count: 1,
    });
    expect(() =>
      putAnalyticsOutboxEvent(db, {
        ...event,
        properties: { ...event.properties, prior_outcome: 'succeeded' },
      })
    ).toThrow('immutable');
    db.close();
  });
});
