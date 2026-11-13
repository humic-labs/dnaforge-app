// @vitest-environment node
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { startPostHogTestCollector } from '../../../../tools/devops/analytics/posthog-test-collector.mjs';
import type { FeedbackReceipt, FeedbackTelemetryOrigin } from '../shared/feedback';

const state = vi.hoisted(() => ({
  profile: '',
  db: null as Database.Database | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => state.profile, isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('./ipc/database', () => ({
  getAnalyticsConsentStateFromDb: () => {
    const rows = state
      .db!.prepare(
        "SELECT key, value FROM settings WHERE key IN ('analytics_consent', 'analytics_consent_version', 'analytics_consent_basis')"
      )
      .all() as Array<{ key: string; value: string }>;
    const values = new Map(rows.map(({ key, value }) => [key, value]));
    return {
      consent: values.get('analytics_consent') ?? null,
      version: values.get('analytics_consent_version') ?? null,
      basis: values.get('analytics_consent_basis') ?? null,
    };
  },
  getDb: () => {
    if (!state.db) throw new Error('controlled fixture database unavailable');
    return state.db;
  },
}));

const IDENTITY = {
  distinctId: '57300000-0000-4000-8000-000000000011',
  sessionId: '57300000-0000-4000-8000-000000000012',
  kind: 'anonymous' as const,
  generation: 1,
};
const FEEDBACK_URL = 'http://127.0.0.1/contained-feedback-bridge';
const BODY = 'harmless private feedback bridge decoy';
interface SavedItem {
  submission_id: string;
  timestamp: string;
  message: string;
  telemetry: FeedbackTelemetryOrigin;
  payload_digest?: string;
  telemetry_receipts: Pick<FeedbackReceipt, 'stage' | 'reason' | 'occurredAtMs' | 'attempt'>[];
}
function items(): SavedItem[] {
  return JSON.parse(readFileSync(join(state.profile, 'pending-feedback.json'), 'utf8'));
}
function createOutbox(db: Database.Database) {
  db.exec(`CREATE TABLE analytics_event_outbox (
    event_id TEXT PRIMARY KEY,event_name TEXT,payload_schema_version INTEGER,reference_kind TEXT,
    reference_id TEXT,properties_json TEXT,created_at_ms INTEGER,send_attempts INTEGER,
    last_attempt_at_ms INTEGER,sent_at_ms INTEGER,origin_json TEXT)`);
}

async function fixture(
  body: (context: {
    start: (
      changedIdentity?: 'identity' | 'session',
      deferContext?: boolean
    ) => Promise<{
      analytics: typeof import('./analytics');
      queue: typeof import('./feedback-queue');
      context: typeof IDENTITY & { rendererInstanceId: string };
    }>;
    reopen: () => void;
    posts: () => number;
    accept: () => void;
    collector: Awaited<ReturnType<typeof startPostHogTestCollector>>;
  }) => Promise<void>,
  initiallyAccepted: boolean
) {
  vi.resetModules();
  const file = createFileTestDb('feedback-main-recovery');
  state.profile = file.tmpDir;
  state.db = file.db;
  let collector: Awaited<ReturnType<typeof startPostHogTestCollector>> | undefined;
  const actualFetch = globalThis.fetch;
  let postCount = 0;
  let accepted = initiallyAccepted;
  let current: typeof import('./analytics') | undefined;
  let queue: typeof import('./feedback-queue') | undefined;
  let primaryPresent = false;
  let primary: unknown;
  const remember = (error: unknown) => {
    if (!primaryPresent) {
      primaryPresent = true;
      primary = error;
    }
  };
  try {
    state.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
      INSERT INTO settings VALUES ('analytics_consent','true',0),('analytics_consent_version','3',0),
      ('analytics_consent_basis','explicit',0)`);
    const liveCollector = await startPostHogTestCollector({
      apiKey: 'phc_feedback_bridge_control',
    });
    collector = liveCollector;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (String(input) !== FEEDBACK_URL) return actualFetch(input, options);
      if (options?.method === 'GET') return Response.json({ protocol: 'dnaforge.feedback.v1' });
      postCount++;
      if (!accepted) throw new Error('contained offline feedback service');
      const payload = JSON.parse(String(options?.body));
      return Response.json({ submission_id: payload.submission_id });
    });
    const start = async (changedIdentity?: 'identity' | 'session', deferContext = false) => {
      state.handlers.clear();
      current = await import('./analytics');
      queue = await import('./feedback-queue');
      current.initAnalyticsMain(
        { POSTHOG_API_KEY: 'phc_feedback_bridge_control', POSTHOG_HOST: liveCollector.url },
        { consent: 'true', version: '3', basis: 'explicit' }
      );
      const context = {
        ...IDENTITY,
        rendererInstanceId: randomUUID(),
        ...(changedIdentity === 'identity' ? { distinctId: randomUUID() } : {}),
        ...(changedIdentity === 'session' ? { sessionId: randomUUID() } : {}),
      };
      if (!deferContext) expect(current.syncAnalyticsIdentityContext(context)).toBe(true);
      queue.configureFeedbackTelemetry({
        captureOrigin: current.captureFeedbackTelemetryOrigin,
        record: current.recordFeedbackTelemetry,
      });
      return { analytics: current, queue, context };
    };
    await body({
      start,
      collector: liveCollector,
      posts: () => postCount,
      accept: () => {
        accepted = true;
      },
      reopen: () => {
        state.db!.close();
        state.db = openFileTestDb(file.dbPath);
        createOutbox(state.db);
        vi.resetModules();
      },
    });
  } catch (error) {
    remember(error);
  } finally {
    try {
      queue?.configureFeedbackTelemetry(null);
    } catch (error) {
      remember(error);
    }
    try {
      await current?.shutdownAnalytics();
    } catch (error) {
      remember(error);
    }
    try {
      state.db?.close();
    } catch (error) {
      remember(error);
    }
    try {
      await collector?.close();
    } catch (error) {
      remember(error);
    }
    try {
      file.cleanup();
    } catch (error) {
      remember(error);
    }
    state.db = null;
    vi.unstubAllGlobals();
  }
  if (primaryPresent) throw primary;
}

describe('real Feedback producer → committed file → main SQLite → installed SDK', () => {
  it('automatically replays held receipts after real IPC context acceptance follows startup recovery', async () => {
    await fixture(async ({ start, reopen, posts, collector }) => {
      const first = await start();
      const id = randomUUID();
      expect(
        await first.queue.submitFeedback(
          { message: BODY, submission_id: id },
          FEEDBACK_URL,
          state.profile,
          () => 'synthetic-install'
        )
      ).toMatchObject({ success: true });
      const saved = structuredClone(items()[0]!);
      await first.analytics.shutdownAnalytics();
      reopen();
      const { analytics, queue, context } = await start(undefined, true);
      const feedback = await import('./ipc/feedback');
      feedback.registerFeedbackHandlers({
        captureOrigin: analytics.captureFeedbackTelemetryOrigin,
        record: analytics.recordFeedbackTelemetry,
      });
      await feedback.flushPendingFeedback(FEEDBACK_URL, state.profile);
      expect(items()[0]!.telemetry_receipts).toHaveLength(3);
      expect(state.db!.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
        n: 0,
      });
      const recover = vi.fn(() => queue.replayFeedbackTelemetry(state.profile));
      analytics.registerAnalyticsHandlers(undefined, recover);
      expect(recover).not.toHaveBeenCalled();
      const sync = state.handlers.get('analytics:syncContext')!;
      expect(await sync({}, context)).toMatchObject({ accepted: true });
      expect(recover).toHaveBeenCalledTimes(1);
      await analytics.drainMainAnalyticsOutbox();
      expect(items()).toEqual([]);
      expect(posts()).toBe(1);
      const wire = collector.eventsSince(0).filter((event) => event.event === 'feedback_stage');
      expect(wire).toHaveLength(3);
      for (const receipt of saved.telemetry_receipts) {
        const event = wire.find((event) => event.properties?.feedback_stage === receipt.stage)!;
        expect(event.properties?.occurred_at_ms).toBe(receipt.occurredAtMs);
        expect(event.distinct_id).toBe(saved.telemetry.metricId);
        expect(event.properties?.$session_id).toBe(saved.telemetry.processId);
        expect(event.properties?.feedback_origin).toBe('restored');
      }
      expect(await sync({}, context)).toMatchObject({ accepted: false });
      expect(recover).toHaveBeenCalledTimes(1);
    }, true);
  });
  it.each([true, false])(
    'repairs original committed receipts across reopen (initial backend accepted=%s)',
    async (initiallyAccepted) => {
      await fixture(async ({ start, reopen, accept, posts, collector }) => {
        let { analytics, queue } = await start();
        const id = randomUUID();
        const result = await queue.submitFeedback(
          { message: BODY, submission_id: id },
          FEEDBACK_URL,
          state.profile,
          () => 'synthetic-install'
        );
        expect(result).toMatchObject(
          initiallyAccepted ? { success: true } : { success: false, queued: true }
        );
        const saved = structuredClone(items()[0]!);
        expect(saved.telemetry.contextId).toBeDefined();
        expect(saved.telemetry_receipts.map((entry) => entry.stage)).toEqual(
          initiallyAccepted
            ? ['accepted_intent', 'durable_queue', 'backend_accepted']
            : ['accepted_intent', 'durable_queue', 'deferred']
        );
        expect(saved.message).toBe(initiallyAccepted ? '' : BODY);
        expect(collector.eventsSince(0)).toEqual([]);
        await analytics.shutdownAnalytics();
        reopen();
        accept();
        ({ analytics, queue } = await start());
        const currentOrigin = analytics.captureOptionalTelemetryOrigin()!;
        expect(currentOrigin.contextId).toBe(saved.telemetry.contextId);
        expect(currentOrigin.processId).not.toBe(saved.telemetry.processId);
        const firstReceipt = {
          origin: saved.telemetry,
          operationId: id,
          originalAtMs: Date.parse(saved.timestamp),
          ...saved.telemetry_receipts[0]!,
        };
        expect(analytics.recordFeedbackTelemetry(firstReceipt)).toBe(false);
        const capture = vi.fn(analytics.captureFeedbackTelemetryOrigin);
        queue.configureFeedbackTelemetry({
          captureOrigin: capture,
          record: analytics.recordFeedbackTelemetry,
        });
        await queue.drainFeedback(FEEDBACK_URL, state.profile);
        await analytics.drainMainAnalyticsOutbox();
        expect(capture).not.toHaveBeenCalled();
        expect(posts()).toBe(initiallyAccepted ? 1 : 2);
        expect(items()).toEqual([]);
        const rows = state
          .db!.prepare('SELECT * FROM analytics_event_outbox ORDER BY created_at_ms,event_id')
          .all() as {
          event_id: string;
          properties_json: string;
          origin_json: string;
          created_at_ms: number;
          last_attempt_at_ms: number;
          sent_at_ms: number;
        }[];
        expect(rows).toHaveLength(initiallyAccepted ? 3 : 5);
        const wire = collector.eventsSince(0).filter((event) => event.event === 'feedback_stage');
        expect(wire).toHaveLength(rows.length);
        for (const entry of saved.telemetry_receipts) {
          const row = rows.find(
            (candidate) => JSON.parse(candidate.properties_json).feedback_stage === entry.stage
          )!;
          expect(row.created_at_ms).toBe(entry.occurredAtMs);
        }
        for (const row of rows) {
          const authority = JSON.parse(row.origin_json);
          expect(authority.origin.processId).toBe(saved.telemetry.processId);
          expect(authority.origin.contextId).toBe(saved.telemetry.contextId);
          const event = wire.find((candidate) => candidate.uuid === row.event_id)!;
          expect(event.distinct_id).toBe(saved.telemetry.metricId);
          expect(event.properties?.$session_id).toBe(saved.telemetry.processId);
          expect(event.properties?.feedback_origin).toBe('restored');
          expect(event.properties?.origin_started_at_ms).toBe(Date.parse(saved.timestamp));
          expect(event.properties?.occurred_at_ms).toBe(row.created_at_ms);
          expect(event.properties?.emitted_at_ms).toBe(row.last_attempt_at_ms);
          expect(row.sent_at_ms).toBeGreaterThanOrEqual(row.last_attempt_at_ms);
          expect(Date.parse(String(event.timestamp))).toBe(row.created_at_ms);
        }
        const encoded = JSON.stringify(wire);
        for (const privateValue of [
          BODY,
          state.profile,
          saved.telemetry.consentScope,
          saved.telemetry.contextId,
          saved.payload_digest,
        ]) {
          if (privateValue) expect(encoded).not.toContain(privateValue);
        }
        expect(analytics.recordFeedbackTelemetry(firstReceipt)).toBe(true);
        await analytics.drainMainAnalyticsOutbox();
        expect(collector.eventsSince(0)).toHaveLength(rows.length);
        expect(
          analytics.syncAnalyticsIdentityContext({ ...IDENTITY, rendererInstanceId: randomUUID() })
        ).toBe(true);
        expect(analytics.captureOptionalTelemetryOrigin()!.contextId).not.toBe(
          saved.telemetry.contextId
        );
        expect(analytics.recordFeedbackTelemetry(firstReceipt)).toBe(false);
        await analytics.revokeMainAnalyticsConsent();
        expect(await analytics.grantMainAnalyticsConsent('explicit')).toBe(true);
        expect(analytics.syncAnalyticsIdentityContext(IDENTITY)).toBe(true);
        expect(analytics.recordFeedbackTelemetry(firstReceipt)).toBe(false);
        expect(state.db!.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual(
          { n: 0 }
        );
      }, initiallyAccepted);
    }
  );
  it.each(['identity', 'session'] as const)(
    'quarantines a completed old-context receipt after canonical %s changes without a new POST',
    async (changedIdentity) => {
      await fixture(async ({ start, reopen, posts, collector }) => {
        let { analytics, queue } = await start();
        await queue.submitFeedback(
          { message: BODY, submission_id: randomUUID() },
          FEEDBACK_URL,
          state.profile,
          () => 'synthetic-install'
        );
        const saved = structuredClone(items()[0]!);
        await analytics.shutdownAnalytics();
        reopen();
        ({ analytics, queue } = await start(changedIdentity));
        expect(analytics.captureOptionalTelemetryOrigin()!.contextId).not.toBe(
          saved.telemetry.contextId
        );
        await queue.drainFeedback(FEEDBACK_URL, state.profile);
        await analytics.drainMainAnalyticsOutbox();
        expect(posts()).toBe(1);
        expect(collector.eventsSince(0)).toEqual([]);
        expect(items()[0]!.telemetry).toEqual(saved.telemetry);
        expect(items()[0]!.message).toBe('');
        expect(state.db!.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual(
          {
            n: 0,
          }
        );
        await analytics.revokeMainAnalyticsConsent();
        expect(items()).toEqual([]);
      }, true);
    }
  );
  it('drains all original receipts from the bounded 50-item completed cache through exact successful batches', async () => {
    await fixture(async ({ start, reopen, posts, collector }) => {
      let { analytics, queue } = await start();
      for (let n = 0; n < 50; n++) {
        expect(
          await queue.submitFeedback(
            { message: BODY, submission_id: randomUUID() },
            FEEDBACK_URL,
            state.profile,
            () => 'synthetic-install'
          )
        ).toMatchObject({ success: true });
      }
      expect(items()).toHaveLength(50);
      expect(
        items().every((item) => item.message === '' && item.telemetry_receipts.length === 3)
      ).toBe(true);
      await analytics.shutdownAnalytics();
      reopen();
      ({ analytics, queue } = await start());
      await analytics.drainMainAnalyticsOutbox();
      await queue.drainFeedback(FEEDBACK_URL, state.profile);
      await analytics.drainMainAnalyticsOutbox();
      expect(items()).toEqual([]);
      expect(posts()).toBe(50);
      expect(
        state
          .db!.prepare(
            'SELECT COUNT(*) AS total,COUNT(sent_at_ms) AS acknowledged FROM analytics_event_outbox'
          )
          .get()
      ).toEqual({ total: 150, acknowledged: 150 });
      const events = collector.eventsSince(0).filter((event) => event.event === 'feedback_stage');
      expect(events).toHaveLength(150);
      expect(new Set(events.map((event) => event.uuid)).size).toBe(150);
      expect(JSON.stringify(events)).not.toContain(BODY);
    }, true);
  });
});
