import type Database from 'better-sqlite3';
import { acceptIdentityContext, type AnalyticsIdentityContext } from '@waypoint/analytics-policy';
import { isAllowedClosedBetaEvent, type ClosedBetaEvent } from '../shared/analytics-allowlist';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
export type { OptionalTelemetryOrigin } from '../shared/analytics-types';

export const ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION = 1 as const;

export type AnalyticsOutboxReferenceKind =
  | 'updater_operation'
  | 'ai_turn_terminal'
  | 'benchling_migration_attempt'
  | 'benchling_migration_issue'
  | 'benchling_migration_disposition'
  | 'feedback_stage'
  | 'updater_outcome'
  | 'skill_operation'
  | 'renderer_workflow'
  | 'table_notebook_revision'
  | 'workspace_sync_upload'
  | 'workspace_sync_restore'
  | 'workspace_sync_enablement'
  | 'workspace_sync_recovery';

export type AnalyticsOutboxAuthority = Readonly<{
  origin: OptionalTelemetryOrigin;
  context: AnalyticsIdentityContext;
  runtimeProperties: Readonly<Record<string, string | number | boolean>>;
  wireContext?: AnalyticsIdentityContext;
}>;

export type AnalyticsOutboxEvent = Readonly<{
  eventId: string;
  eventName: ClosedBetaEvent;
  payloadSchemaVersion: typeof ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION;
  referenceKind: AnalyticsOutboxReferenceKind;

  referenceId: string;
  properties: Readonly<Record<string, string | number | boolean>>;
  createdAtMs: number;
  sendAttempts: number;
  lastAttemptAtMs: number | null;
  sentAtMs: number | null;
  authority: AnalyticsOutboxAuthority | null;
}>;

export type AnalyticsOutboxInput<
  Properties extends object = Record<string, string | number | boolean>,
> = Omit<
  AnalyticsOutboxEvent,
  'properties' | 'sendAttempts' | 'lastAttemptAtMs' | 'sentAtMs' | 'authority'
> & { properties: Readonly<Properties> };

export interface CommittedOptionalAnalyticsReceipt<Properties extends object> {
  origin: OptionalTelemetryOrigin;
  event: AnalyticsOutboxInput<Properties>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REFERENCE_RE = /^[a-z][a-z0-9_]{0,63}$/u;

export function putAnalyticsOutboxEvent<Properties extends object>(
  db: Database.Database,
  input: AnalyticsOutboxInput<Properties>
): void {
  assertValidInput(input);
  const serialized = JSON.stringify(input.properties);
  const existing = db
    .prepare(
      `SELECT event_name, payload_schema_version, reference_kind, reference_id,
              properties_json, created_at_ms
         FROM analytics_event_outbox
        WHERE event_id = ?`
    )
    .get(input.eventId) as
    | {
        event_name: string;
        payload_schema_version: number;
        reference_kind: string;
        reference_id: string;
        properties_json: string;
        created_at_ms: number;
      }
    | undefined;
  if (existing) {
    if (
      existing.event_name !== input.eventName ||
      existing.payload_schema_version !== input.payloadSchemaVersion ||
      existing.reference_kind !== input.referenceKind ||
      existing.reference_id !== input.referenceId ||
      existing.properties_json !== serialized ||
      existing.created_at_ms !== input.createdAtMs
    ) {
      throw new Error(`Analytics outbox event ${input.eventId} is immutable.`);
    }
    return;
  }
  db.prepare(
    `INSERT INTO analytics_event_outbox
       (event_id, event_name, payload_schema_version, reference_kind, reference_id,
        properties_json, created_at_ms, send_attempts, last_attempt_at_ms, sent_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`
  ).run(
    input.eventId,
    input.eventName,
    input.payloadSchemaVersion,
    input.referenceKind,
    input.referenceId,
    serialized,
    input.createdAtMs
  );
}

export function getAnalyticsOutboxEvent(
  db: Database.Database,
  eventId: string
): AnalyticsOutboxEvent | null {
  const row = db.prepare('SELECT * FROM analytics_event_outbox WHERE event_id = ?').get(eventId) as
    | Record<string, unknown>
    | undefined;
  return row ? parseRow(row) : null;
}

export function putOriginBoundAnalyticsOutboxEvent(
  db: Database.Database,
  input: AnalyticsOutboxInput,
  authority: AnalyticsOutboxAuthority,
  admissible: (authority: AnalyticsOutboxAuthority) => boolean
): boolean {
  assertValidInput(input);
  const serializedAuthority = serializeAuthority(authority);
  const admissionClosed = Symbol('optional outbox admission closed');
  try {
    return db.transaction(() => {
      if (!admissible(authority)) return false;
      const existing = getAnalyticsOutboxEvent(db, input.eventId);
      if (existing) {
        if (!existing.authority || serializeAuthority(existing.authority) !== serializedAuthority)
          return false;
        if (
          existing.eventName !== input.eventName ||
          existing.payloadSchemaVersion !== input.payloadSchemaVersion ||
          existing.referenceKind !== input.referenceKind ||
          existing.referenceId !== input.referenceId ||
          existing.createdAtMs !== input.createdAtMs ||
          canonicalProperties(existing.properties) !== canonicalProperties(input.properties)
        )
          return false;
        return admissible(existing.authority);
      }
      if (!admissible(authority)) return false;
      db.prepare(
        `INSERT INTO analytics_event_outbox
      (event_id,event_name,payload_schema_version,reference_kind,reference_id,properties_json,
       created_at_ms,send_attempts,last_attempt_at_ms,sent_at_ms,origin_json)
      VALUES (?,?,?,?,?,?,?,0,NULL,NULL,?)`
      ).run(
        input.eventId,
        input.eventName,
        input.payloadSchemaVersion,
        input.referenceKind,
        input.referenceId,
        canonicalProperties(input.properties),
        input.createdAtMs,
        serializedAuthority
      );
      if (!admissible(authority)) throw admissionClosed;
      return true;
    })();
  } catch (error) {
    if (error === admissionClosed) return false;
    throw error;
  }
}

function canonicalProperties(value: object): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  );
}

function serializeAuthority(authority: AnalyticsOutboxAuthority): string {
  const { origin, context, wireContext } = authority;
  if (
    ![origin.consentScope, origin.contextId, origin.processId].every((id) => UUID_RE.test(id)) ||
    !['synthetic', 'private', 'unknown', 'eligible_release'].includes(origin.classification) ||
    !acceptIdentityContext(null, context) ||
    (wireContext && !acceptIdentityContext(null, wireContext))
  ) {
    throw new Error('Analytics outbox original authority is invalid.');
  }
  for (const [key, value] of Object.entries(authority.runtimeProperties)) {
    if (
      !/^[a-z$][a-z0-9_]{0,63}$/u.test(key) ||
      [
        '$insert_id',
        'emitted_at_ms',
        'occurred_at_ms',
        'origin_started_at_ms',
        'feedback_origin',
        'sent_at_ms',
        'acknowledged_at_ms',
      ].includes(key) ||
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (typeof value === 'string' && value.length > 512)
    )
      throw new Error('Invalid original runtime properties.');
  }
  return JSON.stringify({
    origin: {
      consentScope: origin.consentScope,
      contextId: origin.contextId,
      processId: origin.processId,
      classification: origin.classification,
    },
    context: {
      distinctId: context.distinctId,
      sessionId: context.sessionId,
      kind: context.kind,
      generation: context.generation,
      ...(context.rendererInstanceId ? { rendererInstanceId: context.rendererInstanceId } : {}),
    },
    runtimeProperties: JSON.parse(canonicalProperties(authority.runtimeProperties)) as Record<
      string,
      unknown
    >,
    ...(wireContext
      ? {
          wireContext: {
            distinctId: wireContext.distinctId,
            sessionId: wireContext.sessionId,
            kind: wireContext.kind,
            generation: wireContext.generation,
          },
        }
      : {}),
  });
}

export function listPendingAnalyticsOutboxEvents(
  db: Database.Database,
  limit = 100
): AnalyticsOutboxEvent[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Analytics outbox read limit must be between 1 and 1000.');
  }
  const rows = db
    .prepare(
      `SELECT event_id, event_name, payload_schema_version, reference_kind, reference_id,
              properties_json, created_at_ms, send_attempts, last_attempt_at_ms, sent_at_ms, origin_json
         FROM analytics_event_outbox
        WHERE sent_at_ms IS NULL
        ORDER BY created_at_ms, event_id
        LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(parseRow);
}

export interface AnalyticsOutboxDelivery {
  origin: OptionalTelemetryOrigin;
  admissible(event: AnalyticsOutboxEvent): boolean;
  deliver(
    events: readonly AnalyticsOutboxEvent[],
    beginAttempt: (eventId: string, atMs: number) => boolean
  ): Promise<readonly string[]>;
}

export async function drainAnalyticsOutbox(
  db: Database.Database,
  delivery: AnalyticsOutboxDelivery,
  nowMs = Date.now,
  limit = 100
): Promise<{ attempted: number; sent: number; pending: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    throw new Error('Invalid outbox drain limit.');
  const rows = db
    .prepare(
      `WITH pending AS (
      SELECT *, CASE WHEN json_valid(origin_json) THEN origin_json ELSE NULL END AS valid_origin
      FROM analytics_event_outbox WHERE sent_at_ms IS NULL
    ) SELECT * FROM pending
    WHERE json_extract(valid_origin, '$.origin.consentScope') = ?
      AND json_extract(valid_origin, '$.origin.contextId') = ?
      AND json_extract(valid_origin, '$.origin.classification') = ?
    ORDER BY created_at_ms,event_id LIMIT ?`
    )
    .all(
      delivery.origin.consentScope,
      delivery.origin.contextId,
      delivery.origin.classification,
      limit
    ) as Record<string, unknown>[];
  const events = rows
    .map(parseRow)
    .filter((event) => event.authority !== null && delivery.admissible(event));
  const attempted = new Set<string>();
  const acknowledged =
    events.length === 0
      ? []
      : await delivery.deliver(events, (id, atMs) => {
          const event = events.find((candidate) => candidate.eventId === id);
          if (!event || !Number.isSafeInteger(atMs) || atMs < 0 || !delivery.admissible(event))
            return false;
          const current = getAnalyticsOutboxEvent(db, id);
          if (!current || current.sentAtMs !== null || !sameImmutableEvent(current, event))
            return false;
          const result = db
            .prepare(
              `UPDATE analytics_event_outbox
      SET send_attempts = send_attempts + 1, last_attempt_at_ms = ?
      WHERE event_id = ? AND sent_at_ms IS NULL`
            )
            .run(atMs, id);
          if (result.changes !== 1) return false;
          attempted.add(id);
          return true;
        });
  let sent = 0;
  db.transaction(() => {
    for (const id of new Set(acknowledged)) {
      const event = events.find((candidate) => candidate.eventId === id);
      if (!event || !attempted.has(id) || !delivery.admissible(event)) continue;
      const current = getAnalyticsOutboxEvent(db, id);
      if (!current || !sameImmutableEvent(current, event) || !delivery.admissible(current))
        continue;
      sent += db
        .prepare(
          `UPDATE analytics_event_outbox SET sent_at_ms = ?
        WHERE event_id = ? AND sent_at_ms IS NULL`
        )
        .run(nowMs(), id).changes;
    }
  })();
  const remaining = db
    .prepare('SELECT COUNT(*) AS count FROM analytics_event_outbox WHERE sent_at_ms IS NULL')
    .get() as { count: number };
  return { attempted: attempted.size, sent, pending: remaining.count };
}

function sameImmutableEvent(a: AnalyticsOutboxEvent, b: AnalyticsOutboxEvent): boolean {
  return (
    a.eventId === b.eventId &&
    a.eventName === b.eventName &&
    a.payloadSchemaVersion === b.payloadSchemaVersion &&
    a.referenceKind === b.referenceKind &&
    a.referenceId === b.referenceId &&
    a.createdAtMs === b.createdAtMs &&
    canonicalProperties(a.properties) === canonicalProperties(b.properties) &&
    (a.authority ? serializeAuthority(a.authority) : null) ===
      (b.authority ? serializeAuthority(b.authority) : null)
  );
}

export function purgeAnalyticsOutbox(db: Database.Database): void {
  db.prepare('DELETE FROM analytics_event_outbox').run();
}

function assertValidInput<Properties extends object>(
  input: AnalyticsOutboxInput<Properties>
): void {
  if (!UUID_RE.test(input.eventId)) throw new Error('Analytics outbox event ID must be a UUID.');
  if (!isAllowedClosedBetaEvent(input.eventName)) {
    throw new Error(`Analytics outbox event ${input.eventName} is not registered.`);
  }
  if (input.payloadSchemaVersion !== ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION) {
    throw new Error('Analytics outbox payload schema version is unsupported.');
  }
  if (!REFERENCE_RE.test(input.referenceKind)) {
    throw new Error('Analytics outbox reference kind is invalid.');
  }
  if (
    typeof input.referenceId !== 'string' ||
    input.referenceId.length < 1 ||
    input.referenceId.length > 512
  ) {
    throw new Error('Analytics outbox reference ID is invalid.');
  }
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) {
    throw new Error('Analytics outbox creation time is invalid.');
  }
  for (const [key, value] of Object.entries(input.properties)) {
    if (!/^[a-z$][a-z0-9_]{0,63}$/u.test(key)) {
      throw new Error(`Analytics outbox property key ${key} is invalid.`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`Analytics outbox property ${key} is not scalar.`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`Analytics outbox property ${key} is not finite.`);
    }
    if (typeof value === 'string' && value.length > 512) {
      throw new Error(`Analytics outbox property ${key} is too long.`);
    }
  }
}

function parseRow(row: Record<string, unknown>): AnalyticsOutboxEvent {
  const eventName = String(row.event_name);
  if (!isAllowedClosedBetaEvent(eventName)) {
    throw new Error(`Analytics outbox event ${eventName} is no longer registered.`);
  }
  const properties: unknown = JSON.parse(String(row.properties_json));
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('Analytics outbox properties are invalid.');
  }
  const candidate = {
    eventId: String(row.event_id),
    eventName,
    payloadSchemaVersion: Number(row.payload_schema_version) as 1,
    referenceKind: String(row.reference_kind) as AnalyticsOutboxReferenceKind,
    referenceId: String(row.reference_id),
    properties: properties as Record<string, string | number | boolean>,
    createdAtMs: Number(row.created_at_ms),
    sendAttempts: Number(row.send_attempts),
    lastAttemptAtMs: row.last_attempt_at_ms === null ? null : Number(row.last_attempt_at_ms),
    sentAtMs: row.sent_at_ms === null ? null : Number(row.sent_at_ms),
    authority: row.origin_json == null ? null : parseAuthority(String(row.origin_json)),
  };
  assertValidInput(candidate);
  if (
    !Number.isSafeInteger(candidate.sendAttempts) ||
    candidate.sendAttempts < 0 ||
    (candidate.lastAttemptAtMs !== null &&
      (!Number.isSafeInteger(candidate.lastAttemptAtMs) || candidate.lastAttemptAtMs < 0)) ||
    (candidate.sentAtMs !== null &&
      (!Number.isSafeInteger(candidate.sentAtMs) || candidate.sentAtMs < 0))
  ) {
    throw new Error('Analytics outbox delivery state is invalid.');
  }
  return candidate;
}

function parseAuthority(json: string): AnalyticsOutboxAuthority {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid local analytics authority.');
  const authority = parsed as AnalyticsOutboxAuthority;
  serializeAuthority(authority);
  Object.freeze(authority.origin);
  Object.freeze(authority.context);
  Object.freeze(authority.runtimeProperties);
  if (authority.wireContext) Object.freeze(authority.wireContext);
  return Object.freeze(authority);
}
