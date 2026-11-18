import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  organizationInventoryCanonicalJson,
  organizationInventoryRequestSha256,
  inventoryTableSha256,
  parseOrganizationInventoryRequestEnvelope,
  parseOrganizationInventoryDisposition,
  type InventoryOrganizationTarget,
  type OrganizationInventoryRequestEnvelope,
  type OrganizationInventoryDisposition,
  type InventoryTableSha256,
} from '@waypoint/domain-services';
import { readOrganizationInventoryProjection } from './organization-inventory-cache';

export type OrganizationInventoryActionEnvelope = Extract<
  OrganizationInventoryRequestEnvelope,
  { purpose: 'action' }
>;
export type OrganizationInventoryActionDisposition = Extract<
  OrganizationInventoryDisposition,
  { kind: 'action-accepted' | 'action-refused' }
>;
export interface OrganizationInventoryAttemptScope {
  readonly accountId: string;
  readonly target: InventoryOrganizationTarget;
}
export interface OrganizationInventoryAttemptKey extends OrganizationInventoryAttemptScope {
  readonly operationId: string;
  readonly requestSha256: InventoryTableSha256;
}
export interface OrganizationInventoryStoredAttempt {
  readonly key: OrganizationInventoryAttemptKey;
  readonly previewHandleId: string;
  readonly request: OrganizationInventoryActionEnvelope;
  readonly requestText: string;
  readonly requestSha256: InventoryTableSha256;
  readonly originalDesktopSessionId: string;
  readonly createdAt: number;
  readonly sendState: 'never-sent' | 'may-have-sent';
  readonly disposition: OrganizationInventoryActionDisposition | null;
  readonly dispositionText: string | null;
  readonly dispositionSha256: InventoryTableSha256 | null;
  readonly projectionConfirmedRevision: number | null;
}
export class OrganizationInventoryAttemptConflictError extends Error {
  readonly code = 'ORGANIZATION_INVENTORY_ATTEMPT_CONFLICT';
  constructor(
    readonly reason:
      | 'operation-id'
      | 'preview-handle'
      | 'unresolved-target'
      | 'request-digest'
      | 'disposition'
      | 'projection'
  ) {
    super(`Organization inventory attempt conflict: ${reason}.`);
    this.name = 'OrganizationInventoryAttemptConflictError';
  }
}
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const id = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => v.trim() === v && !v.includes('\0'));
const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sha = z.custom<InventoryTableSha256>(
  (v) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v)
);
const scopeSchema = z
  .object({
    accountId: uuid,
    target: z
      .object({ kind: z.literal('organization-inventory'), orgId: uuid, inventoryId: uuid })
      .strict(),
  })
  .strict();
const keySchema = scopeSchema.extend({ operationId: id, requestSha256: sha }).strict();
const rowSchema = z
  .object({
    account_id: uuid,
    org_id: uuid,
    inventory_id: uuid,
    operation_id: id,
    purpose: z.literal('action'),
    preview_handle_id: id,
    request_text: z.string(),
    request_sha256: sha,
    original_desktop_session_id: uuid,
    created_at: safe,
    send_state: z.enum(['never-sent', 'may-have-sent']),
    disposition_kind: z.enum(['action-accepted', 'action-refused']).nullable(),
    disposition_text: z.string().nullable(),
    disposition_sha256: sha.nullable(),
    projection_confirmed_revision: safe.nullable(),
  })
  .strict();
const equal = (a: unknown, b: unknown) =>
  organizationInventoryCanonicalJson(a) === organizationInventoryCanonicalJson(b);
const sqlScope = (scope: OrganizationInventoryAttemptScope) => [
  scope.accountId,
  scope.target.orgId,
  scope.target.inventoryId,
];
export function createOrganizationInventoryAttemptTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS organization_inventory_attempt (
 account_id TEXT NOT NULL, org_id TEXT NOT NULL, inventory_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose='action'), preview_handle_id TEXT NOT NULL,
 request_text TEXT NOT NULL CHECK(length(CAST(request_text AS BLOB)) BETWEEN 1 AND 65536),
 request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=71),
 original_desktop_session_id TEXT NOT NULL, created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 send_state TEXT NOT NULL CHECK(send_state IN('never-sent','may-have-sent')),
 disposition_kind TEXT CHECK(disposition_kind IN('action-accepted','action-refused')),
 disposition_text TEXT, disposition_sha256 TEXT CHECK(disposition_sha256 IS NULL OR length(disposition_sha256)=71),
 projection_confirmed_revision INTEGER CHECK(projection_confirmed_revision BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(account_id,org_id,inventory_id,operation_id), UNIQUE(account_id,preview_handle_id),
 CHECK((disposition_kind IS NULL AND disposition_text IS NULL AND disposition_sha256 IS NULL)
 OR (disposition_kind IS NOT NULL AND disposition_text IS NOT NULL AND disposition_sha256 IS NOT NULL)),
 CHECK(projection_confirmed_revision IS NULL OR(disposition_kind IS NOT NULL AND disposition_kind='action-accepted'))
 );
 CREATE UNIQUE INDEX IF NOT EXISTS organization_inventory_attempt_unresolved
 ON organization_inventory_attempt(account_id,org_id,inventory_id) WHERE disposition_text IS NULL;
 CREATE INDEX IF NOT EXISTS organization_inventory_attempt_delivery
 ON organization_inventory_attempt(account_id,org_id,inventory_id)
 WHERE disposition_kind='action-accepted' AND projection_confirmed_revision IS NULL;`);
}
function actionEnvelope(value: unknown): OrganizationInventoryActionEnvelope {
  const request = parseOrganizationInventoryRequestEnvelope(value);
  if (request.purpose !== 'action') throw new TypeError('A retained action envelope is required.');
  return request;
}
function actionDisposition(value: unknown): OrganizationInventoryActionDisposition {
  const disposition = parseOrganizationInventoryDisposition(value);
  if (disposition.kind !== 'action-accepted' && disposition.kind !== 'action-refused')
    throw new TypeError('A terminal action disposition is required.');
  return disposition;
}
function verifyDisposition(
  attempt: OrganizationInventoryStoredAttempt,
  disposition: OrganizationInventoryActionDisposition
): void {
  const body = attempt.request.body;
  if (
    !equal(disposition.target, body.target) ||
    disposition.operationId !== body.operationId ||
    disposition.requestSha256 !== attempt.requestSha256 ||
    disposition.submitterAccountId !== attempt.key.accountId ||
    disposition.originClientId !== body.clientId
  )
    throw new OrganizationInventoryAttemptConflictError('disposition');
  if (
    disposition.kind === 'action-accepted' &&
    (disposition.baseRevision !== body.expectedRevision ||
      disposition.planDigest !== body.expectedPlanDigest ||
      disposition.accessGenerationAtDecision !== body.accessGeneration)
  )
    throw new OrganizationInventoryAttemptConflictError('disposition');
}
function decode(value: unknown): OrganizationInventoryStoredAttempt {
  const row = rowSchema.parse(value);
  const request = actionEnvelope(JSON.parse(row.request_text));
  if (
    organizationInventoryCanonicalJson(request) !== row.request_text ||
    organizationInventoryRequestSha256(request) !== row.request_sha256 ||
    request.body.operationId !== row.operation_id ||
    request.body.target.orgId !== row.org_id ||
    request.body.target.inventoryId !== row.inventory_id
  )
    throw new TypeError('Stored organization request does not match its canonical identity.');
  const disposition =
    row.disposition_text === null ? null : actionDisposition(JSON.parse(row.disposition_text));
  if (
    (disposition === null) !== (row.disposition_kind === null) ||
    (disposition === null) !== (row.disposition_sha256 === null)
  )
    throw new TypeError('Stored disposition fields disagree.');
  const attempt: OrganizationInventoryStoredAttempt = {
    key: {
      accountId: row.account_id,
      target: request.body.target,
      operationId: row.operation_id,
      requestSha256: row.request_sha256,
    },
    previewHandleId: row.preview_handle_id,
    request,
    requestText: row.request_text,
    requestSha256: row.request_sha256,
    originalDesktopSessionId: row.original_desktop_session_id,
    createdAt: row.created_at,
    sendState: row.send_state,
    disposition,
    dispositionText: row.disposition_text,
    dispositionSha256: row.disposition_sha256,
    projectionConfirmedRevision: row.projection_confirmed_revision,
  };
  if (disposition) {
    verifyDisposition(attempt, disposition);
    if (
      disposition.kind !== row.disposition_kind ||
      organizationInventoryCanonicalJson(disposition) !== row.disposition_text ||
      inventoryTableSha256(row.disposition_text!) !== row.disposition_sha256
    )
      throw new TypeError('Stored disposition integrity check failed.');
  }
  if (
    row.projection_confirmed_revision !== null &&
    (disposition?.kind !== 'action-accepted' ||
      row.projection_confirmed_revision < disposition.revision)
  )
    throw new TypeError('Stored delivery checkpoint does not confirm its acceptance.');
  return attempt;
}
function findOperation(
  db: Database.Database,
  scope: OrganizationInventoryAttemptScope,
  operationId: string
): OrganizationInventoryStoredAttempt | null {
  const row = db
    .prepare(
      'SELECT * FROM organization_inventory_attempt WHERE account_id=? AND org_id=? AND inventory_id=? AND operation_id=?'
    )
    .get(...sqlScope(scope), operationId);
  return row ? decode(row) : null;
}
export function readOrganizationInventoryAttempt(
  db: Database.Database,
  input: OrganizationInventoryAttemptKey
): OrganizationInventoryStoredAttempt | null {
  const key = keySchema.parse(input),
    attempt = findOperation(db, key, key.operationId);
  if (attempt && attempt.requestSha256 !== key.requestSha256)
    throw new OrganizationInventoryAttemptConflictError('request-digest');
  return attempt;
}
function requireAttempt(
  db: Database.Database,
  key: OrganizationInventoryAttemptKey
): OrganizationInventoryStoredAttempt {
  const attempt = readOrganizationInventoryAttempt(db, key);
  if (!attempt) throw new TypeError('The exact retained organization attempt was not found.');
  return attempt;
}
export function readOrganizationInventoryAttemptForHandle(
  db: Database.Database,
  input: OrganizationInventoryAttemptScope & { previewHandleId: string }
): OrganizationInventoryStoredAttempt | null {
  const scope = scopeSchema.parse({ accountId: input.accountId, target: input.target }),
    handle = id.parse(input.previewHandleId);
  const row = db
    .prepare(
      'SELECT * FROM organization_inventory_attempt WHERE account_id=? AND org_id=? AND inventory_id=? AND preview_handle_id=?'
    )
    .get(...sqlScope(scope), handle);
  return row ? decode(row) : null;
}
export function readBlockingOrganizationInventoryAttempt(
  db: Database.Database,
  input: OrganizationInventoryAttemptScope
): OrganizationInventoryStoredAttempt | null {
  const scope = scopeSchema.parse(input);
  const rows = [
    ...db
      .prepare(
        'SELECT * FROM organization_inventory_attempt WHERE account_id=? AND org_id=? AND inventory_id=? AND disposition_text IS NULL LIMIT 2'
      )
      .all(...sqlScope(scope)),
    ...db
      .prepare(
        "SELECT * FROM organization_inventory_attempt WHERE account_id=? AND org_id=? AND inventory_id=? AND disposition_kind='action-accepted' AND projection_confirmed_revision IS NULL LIMIT 2"
      )
      .all(...sqlScope(scope)),
  ];
  if (rows.length > 1)
    throw new TypeError('Multiple incomplete organization attempts conflict in one scope.');
  return rows.length ? decode(rows[0]) : null;
}
export function retainOrganizationInventoryAttempt(
  db: Database.Database,
  input: {
    accountId: string;
    originalDesktopSessionId: string;
    previewHandleId: string;
    request: OrganizationInventoryActionEnvelope;
    at: number;
  }
): OrganizationInventoryStoredAttempt {
  const request = actionEnvelope(input.request),
    requestText = organizationInventoryCanonicalJson(request),
    requestSha256 = organizationInventoryRequestSha256(request);
  const scope = scopeSchema.parse({ accountId: input.accountId, target: request.body.target }),
    originalSession = uuid.parse(input.originalDesktopSessionId),
    handle = id.parse(input.previewHandleId),
    at = safe.parse(input.at);
  return db
    .transaction(() => {
      const existing = findOperation(db, scope, request.body.operationId);
      if (existing) {
        if (
          existing.requestText !== requestText ||
          existing.previewHandleId !== handle ||
          existing.originalDesktopSessionId !== originalSession
        )
          throw new OrganizationInventoryAttemptConflictError('operation-id');
        return existing;
      }
      if (
        db
          .prepare(
            'SELECT 1 FROM organization_inventory_attempt WHERE account_id=? AND preview_handle_id=?'
          )
          .get(scope.accountId, handle)
      )
        throw new OrganizationInventoryAttemptConflictError('preview-handle');
      if (readBlockingOrganizationInventoryAttempt(db, scope))
        throw new OrganizationInventoryAttemptConflictError('unresolved-target');
      db.prepare(
        "INSERT INTO organization_inventory_attempt(account_id,org_id,inventory_id,operation_id,purpose,preview_handle_id,request_text,request_sha256,original_desktop_session_id,created_at,send_state) VALUES(?,?,?,?,'action',?,?,?,?,?,'never-sent')"
      ).run(
        ...sqlScope(scope),
        request.body.operationId,
        handle,
        requestText,
        requestSha256,
        originalSession,
        at
      );
      return requireAttempt(db, { ...scope, operationId: request.body.operationId, requestSha256 });
    })
    .immediate();
}
export function markOrganizationInventoryAttemptMayHaveSent(
  db: Database.Database,
  key: OrganizationInventoryAttemptKey
): {
  kind: 'claimed' | 'already-may-have-sent' | 'terminal';
  attempt: OrganizationInventoryStoredAttempt;
} {
  return db
    .transaction(() => {
      const attempt = requireAttempt(db, key);
      if (attempt.disposition) return { kind: 'terminal' as const, attempt };
      if (attempt.sendState === 'may-have-sent')
        return { kind: 'already-may-have-sent' as const, attempt };
      const result = db
        .prepare(
          "UPDATE organization_inventory_attempt SET send_state='may-have-sent' WHERE account_id=? AND org_id=? AND inventory_id=? AND operation_id=? AND request_sha256=? AND request_text=? AND send_state='never-sent' AND disposition_text IS NULL"
        )
        .run(...sqlScope(key), key.operationId, key.requestSha256, attempt.requestText);
      if (result.changes !== 1) throw new OrganizationInventoryAttemptConflictError('operation-id');
      return { kind: 'claimed' as const, attempt: requireAttempt(db, key) };
    })
    .immediate();
}
export function recordOrganizationInventoryAttemptDisposition(
  db: Database.Database,
  key: OrganizationInventoryAttemptKey,
  value: OrganizationInventoryActionDisposition
): OrganizationInventoryStoredAttempt {
  const disposition = actionDisposition(value),
    text = organizationInventoryCanonicalJson(disposition),
    digest = inventoryTableSha256(text);
  return db
    .transaction(() => {
      const attempt = requireAttempt(db, key);
      verifyDisposition(attempt, disposition);
      if (attempt.disposition) {
        if (attempt.dispositionText !== text || attempt.dispositionSha256 !== digest)
          throw new OrganizationInventoryAttemptConflictError('disposition');
        return attempt;
      }
      const result = db
        .prepare(
          'UPDATE organization_inventory_attempt SET disposition_kind=?,disposition_text=?,disposition_sha256=? WHERE account_id=? AND org_id=? AND inventory_id=? AND operation_id=? AND request_sha256=? AND request_text=? AND disposition_text IS NULL'
        )
        .run(
          disposition.kind,
          text,
          digest,
          ...sqlScope(key),
          key.operationId,
          key.requestSha256,
          attempt.requestText
        );
      if (result.changes !== 1) throw new OrganizationInventoryAttemptConflictError('disposition');
      return requireAttempt(db, key);
    })
    .immediate();
}
export function confirmOrganizationInventoryAttemptProjection(
  db: Database.Database,
  key: OrganizationInventoryAttemptKey
): { kind: 'confirmed' | 'pending'; attempt: OrganizationInventoryStoredAttempt } {
  return db
    .transaction(() => {
      const attempt = requireAttempt(db, key),
        disposition = attempt.disposition;
      if (disposition?.kind !== 'action-accepted')
        throw new TypeError('Only an accepted attempt has physical projection delivery.');
      const projection = readOrganizationInventoryProjection(db, key.accountId, key.target);
      if (!projection || projection.snapshot.header.revision < disposition.revision)
        return { kind: 'pending' as const, attempt };
      const header = projection.snapshot.header;
      if (
        header.revision === disposition.revision &&
        header.stateSha256 !== disposition.stateSha256
      )
        throw new OrganizationInventoryAttemptConflictError('projection');
      const revision = Math.max(attempt.projectionConfirmedRevision ?? 0, header.revision);
      if (revision !== attempt.projectionConfirmedRevision) {
        const result = db
          .prepare(
            'UPDATE organization_inventory_attempt SET projection_confirmed_revision=? WHERE account_id=? AND org_id=? AND inventory_id=? AND operation_id=? AND request_sha256=? AND request_text=? AND disposition_text=?'
          )
          .run(
            revision,
            ...sqlScope(key),
            key.operationId,
            key.requestSha256,
            attempt.requestText,
            attempt.dispositionText
          );
        if (result.changes !== 1) throw new OrganizationInventoryAttemptConflictError('projection');
      }
      return { kind: 'confirmed' as const, attempt: requireAttempt(db, key) };
    })
    .immediate();
}
