import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SequenceEditTransitionOperation } from '@waypoint/sequence-utils';
import {
  SEQUENCE_EDIT_TRANSITION_EVENT_TYPE,
  SEQUENCE_EDIT_TRANSITION_SCHEMA,
  type SequenceEditTransitionEventV1,
} from '../shared/sequence-edit-lineage';

export const MAX_SEQUENCE_EDIT_TRANSITIONS = 1_024;
export const MAX_SEQUENCE_EDIT_OPERATIONS = 100_000;

export interface StoredSequenceEditTransition {
  id: string;
  createdAt: number;
  event: SequenceEditTransitionEventV1;
}

export interface ResolvedSequenceEditLineage {
  exact: boolean;
  transitions: StoredSequenceEditTransition[];
}

export interface ZeroCoordinateSequenceEditAdvance {
  db: Database.Database;
  entityId: string;
  actionId: string;
  beforeFileSha256: string;
  afterFileSha256: string;
  beforeTargetDocumentRevision: string;
  afterTargetDocumentRevision: string;
  inputRevision: string;
  topology: 'linear' | 'circular';
  sequenceLength: number;
  eventId?: string;
  createdAt?: number;
}

interface EventRow {
  id: string;
  payload: string | null;
  created_at: number;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export function appendSequenceEditTransition(input: {
  db: Database.Database;
  entityId: string;
  event: SequenceEditTransitionEventV1;
  eventId?: string;
  actor?: string;
  summary?: string;
  createdAt?: number;
}): StoredSequenceEditTransition {
  const payload = JSON.stringify(input.event);
  if (payload.length > 1_000_000) {
    throw new Error('The sequence edit-lineage event exceeds its bounded payload size.');
  }
  const event = parseSequenceEditTransition(payload);
  const stored = {
    id: input.eventId ?? randomUUID(),
    createdAt: input.createdAt ?? Date.now(),
    event,
  };
  input.db
    .prepare(
      `INSERT INTO catalog_entity_events
       (id,entity_id,event_type,actor,summary,payload,created_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      stored.id,
      input.entityId,
      SEQUENCE_EDIT_TRANSITION_EVENT_TYPE,
      input.actor ?? 'user',
      input.summary ?? 'Saved sequence edit transition',
      payload,
      stored.createdAt
    );
  return stored;
}

export function appendZeroCoordinateSequenceEditAdvance(
  input: ZeroCoordinateSequenceEditAdvance
): StoredSequenceEditTransition {
  if (!identifier(input.actionId) || !nonnegativeInteger(input.sequenceLength)) {
    throw new Error('The annotation lineage advance is malformed.');
  }
  const parent = findCurrentSequenceEditHead(input.db, input.entityId, input.beforeFileSha256);
  return appendSequenceEditTransition({
    db: input.db,
    entityId: input.entityId,
    eventId: input.eventId,
    createdAt: input.createdAt,
    summary: 'Applied annotations without changing sequence coordinates',
    event: {
      schema: SEQUENCE_EDIT_TRANSITION_SCHEMA,
      parentEventId: parent?.id ?? null,
      draftLineageId: `native-annotation-action:${input.actionId}`,
      beforeFileSha256: input.beforeFileSha256,
      afterFileSha256: input.afterFileSha256,
      beforeTargetDocumentRevision: input.beforeTargetDocumentRevision,
      afterTargetDocumentRevision: input.afterTargetDocumentRevision,
      beforeInputRevision: input.inputRevision,
      afterInputRevision: input.inputRevision,
      beforeTopology: input.topology,
      afterTopology: input.topology,
      transition: {
        beforeLength: input.sequenceLength,
        afterLength: input.sequenceLength,
        operations: [],
      },
    },
  });
}

export function readSequenceEditTransitions(
  db: Database.Database,
  entityId: string,
  limit = MAX_SEQUENCE_EDIT_TRANSITIONS + 1
): StoredSequenceEditTransition[] {
  const rows = db
    .prepare(
      `SELECT id,payload,created_at
       FROM catalog_entity_events
       WHERE entity_id=? AND event_type=?
       ORDER BY rowid DESC
       LIMIT ?`
    )
    .all(entityId, SEQUENCE_EDIT_TRANSITION_EVENT_TYPE, limit) as EventRow[];
  return rows.flatMap((row) => {
    if (typeof row.payload !== 'string') return [];
    try {
      return [
        { id: row.id, createdAt: row.created_at, event: parseSequenceEditTransition(row.payload) },
      ];
    } catch {
      return [];
    }
  });
}

export function findCurrentSequenceEditHead(
  db: Database.Database,
  entityId: string,
  currentFileSha256: string
): StoredSequenceEditTransition | null {
  const matches = readSequenceEditTransitions(db, entityId).filter(
    (stored) => stored.event.afterFileSha256 === currentFileSha256
  );
  if (matches.length > 1) {
    throw new Error('The saved sequence has ambiguous edit-lineage heads.');
  }
  return matches[0] ?? null;
}

export function resolveSequenceEditLineage(input: {
  db: Database.Database;
  entityId: string;
  currentFileSha256: string;
  analyzedInputRevision: string;
  currentInputRevision: string;
}): ResolvedSequenceEditLineage {
  if (input.currentInputRevision === input.analyzedInputRevision) {
    return { exact: true, transitions: [] };
  }
  const events = readSequenceEditTransitions(input.db, input.entityId);
  if (events.length > MAX_SEQUENCE_EDIT_TRANSITIONS) {
    throw new Error('The saved edit history is too long to verify safely.');
  }
  const heads = events.filter((stored) => stored.event.afterFileSha256 === input.currentFileSha256);
  if (heads.length !== 1) {
    throw new Error(
      heads.length === 0
        ? 'No verified saved edit history reaches the current document.'
        : 'The current document has ambiguous saved edit history.'
    );
  }
  const byId = new Map(events.map((event) => [event.id, event]));
  const reverse: StoredSequenceEditTransition[] = [];
  const visited = new Set<string>();
  let cursor: StoredSequenceEditTransition | undefined = heads[0];
  while (cursor) {
    if (visited.has(cursor.id)) throw new Error('The saved edit history contains a cycle.');
    visited.add(cursor.id);
    reverse.push(cursor);
    if (!cursor.event.parentEventId) break;
    const parent = byId.get(cursor.event.parentEventId);
    if (!parent) throw new Error('The saved edit history is incomplete.');
    assertConnected(parent, cursor);
    cursor = parent;
  }
  const chain = reverse.reverse();
  const revisions = [
    chain[0].event.beforeInputRevision,
    ...chain.map((item) => item.event.afterInputRevision),
  ];
  const groups: Array<{ revision: string; first: number; last: number }> = [];
  for (const [index, revision] of revisions.entries()) {
    const previous = groups[groups.length - 1];
    if (previous?.revision === revision) previous.last = index;
    else groups.push({ revision, first: index, last: index });
  }
  const analyzedGroups = groups.filter((group) => group.revision === input.analyzedInputRevision);
  if (analyzedGroups.length !== 1) {
    throw new Error(
      analyzedGroups.length === 0
        ? 'The analyzed revision is not present in the current saved edit history.'
        : 'The analyzed revision occurs in ambiguous saved edit epochs.'
    );
  }
  if (revisions[revisions.length - 1] !== input.currentInputRevision) {
    throw new Error('The saved edit history does not describe the current sequence revision.');
  }
  const transitions = chain.slice(analyzedGroups[0].last);
  const operationCount = transitions.reduce(
    (count, item) => count + item.event.transition.operations.length,
    0
  );
  if (operationCount > MAX_SEQUENCE_EDIT_OPERATIONS) {
    throw new Error('The saved edit history has too many coordinate operations.');
  }
  return { exact: false, transitions };
}

export function parseSequenceEditTransition(payload: string): SequenceEditTransitionEventV1 {
  const value: unknown = JSON.parse(payload);
  if (!isRecord(value) || value.schema !== SEQUENCE_EDIT_TRANSITION_SCHEMA) {
    throw new Error('The sequence edit-lineage event has an unsupported schema.');
  }
  if (
    !nullableIdentifier(value.parentEventId) ||
    !identifier(value.draftLineageId) ||
    !hash(value.beforeFileSha256) ||
    !hash(value.afterFileSha256) ||
    !revision(value.beforeTargetDocumentRevision) ||
    !revision(value.afterTargetDocumentRevision) ||
    !revision(value.beforeInputRevision) ||
    !revision(value.afterInputRevision) ||
    !topology(value.beforeTopology) ||
    !topology(value.afterTopology) ||
    !isRecord(value.transition) ||
    !nonnegativeInteger(value.transition.beforeLength) ||
    !nonnegativeInteger(value.transition.afterLength) ||
    !Array.isArray(value.transition.operations) ||
    value.transition.operations.length > MAX_SEQUENCE_EDIT_OPERATIONS
  ) {
    throw new Error('The sequence edit-lineage event is malformed.');
  }
  const operations = value.transition.operations.map(parseOperation);
  return {
    schema: SEQUENCE_EDIT_TRANSITION_SCHEMA,
    parentEventId: value.parentEventId,
    draftLineageId: value.draftLineageId,
    beforeFileSha256: value.beforeFileSha256,
    afterFileSha256: value.afterFileSha256,
    beforeTargetDocumentRevision: value.beforeTargetDocumentRevision,
    afterTargetDocumentRevision: value.afterTargetDocumentRevision,
    beforeInputRevision: value.beforeInputRevision,
    afterInputRevision: value.afterInputRevision,
    beforeTopology: value.beforeTopology,
    afterTopology: value.afterTopology,
    transition: {
      beforeLength: value.transition.beforeLength,
      afterLength: value.transition.afterLength,
      operations,
    },
  };
}

function parseOperation(value: unknown): SequenceEditTransitionOperation {
  if (!isRecord(value)) throw new Error('The sequence edit operation is malformed.');
  if (value.kind === 'insert') {
    if (!nonnegativeInteger(value.at) || !positiveInteger(value.length)) {
      throw new Error('The sequence insertion is malformed.');
    }
    return { kind: 'insert', at: value.at, length: value.length };
  }
  if (value.kind === 'delete' || value.kind === 'substitute') {
    if (
      !nonnegativeInteger(value.start) ||
      !positiveInteger(value.end) ||
      value.end <= value.start
    ) {
      throw new Error('The sequence edit range is malformed.');
    }
    return { kind: value.kind, start: value.start, end: value.end };
  }
  throw new Error('The sequence edit operation kind is unsupported.');
}

function assertConnected(
  parent: StoredSequenceEditTransition,
  child: StoredSequenceEditTransition
): void {
  if (
    child.event.beforeFileSha256 !== parent.event.afterFileSha256 ||
    child.event.beforeTargetDocumentRevision !== parent.event.afterTargetDocumentRevision ||
    child.event.beforeInputRevision !== parent.event.afterInputRevision ||
    child.event.beforeTopology !== parent.event.afterTopology ||
    child.event.transition.beforeLength !== parent.event.transition.afterLength
  ) {
    throw new Error('The saved edit history contains a disconnected transition.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function nullableIdentifier(value: unknown): value is string | null {
  return value === null || identifier(value);
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function revision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function topology(value: unknown): value is 'linear' | 'circular' {
  return value === 'linear' || value === 'circular';
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
