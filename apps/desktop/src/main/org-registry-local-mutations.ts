import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LIMS_REGISTRATION_STATUSES, limsEntityFromRow, type LimsEntity } from '../shared/lims';
import { parseLimsEntitySnapshot } from '../shared/lims-entity-snapshot';
import {
  canonicalNativeMutationRequest,
  nativeMutationRequestBytes,
  NATIVE_MUTATION_REQUEST_VERSION,
} from './native-mutation-request';
import { getEntityRowById, insertAuditEvent, updateLimsEntityInsideTx } from './lims-engine-core';
import { archiveLimsEntityInsideTx, restoreLimsEntityInsideTx } from './lims-entity-lifecycle';
import { getActiveStoredSession } from './auth/session-store';
import {
  assertOrgRegistryRecordMutationAccount,
  captureOrgRegistryRecordPublicationInTx,
  markOrgRegistryRecordPublicationReadyInTx,
  orgRegistryDatabasePublicationDigest,
  orgRegistryRecordPublicationAuthority,
  readOrgRegistryRecordReview,
  prepareOrgRegistryRecordResolutionInTx,
  captureOrgRegistryRecordResolutionPublicationInTx,
  settleOrgRegistryRecordResolutionInTx,
  type OrgRegistryRecordReview,
} from './org-registry-record-sync';

export async function readRegisteredRecordMutationAccount(
  db: Database.Database,
  entityIds: string[],
  context: {
    runDatabase: <T>(work: () => T) => T;
    getActiveAccountId?: () => Promise<string | null>;
  }
): Promise<string | null> {
  const enrolled = context.runDatabase(() =>
    entityIds.some((id) =>
      Boolean(db.prepare('SELECT 1 FROM org_registry_local_records WHERE entity_id=?').get(id))
    )
  );
  if (!enrolled) return null;
  const accountId = context.getActiveAccountId
    ? await context.getActiveAccountId()
    : ((await getActiveStoredSession())?.accountId ?? null);
  context.runDatabase(() => {
    for (const entityId of entityIds)
      assertOrgRegistryRecordMutationAccount(db, { entityId, accountId });
  });
  return accountId;
}

export function settleDatabaseRegisteredRecordInTx(
  db: Database.Database,
  input: { entity: LimsEntity; accountId: string | null; operationId: string }
): void {
  const publicationDigest = orgRegistryDatabasePublicationDigest(input.entity);
  const now = Date.now();
  captureOrgRegistryRecordPublicationInTx(db, { ...input, publicationDigest, now });
  markOrgRegistryRecordPublicationReadyInTx(db, {
    operationId: input.operationId,
    entityId: input.entity.id,
    publicationDigest,
    now,
  });
}

export type RegisteredRecordResolutionIdentity = {
  accountId: string;
  orgId: string;
  entityId: string;
  resolutionId: string;
  operationId: string;
  choice: 'use_remote' | 'keep_saved';
  sourceRevision: string;
};
export type RegisteredRecordResolutionRequest = RegisteredRecordResolutionIdentity & {
  review: OrgRegistryRecordReview;
};
export type VerifiedRegisteredRecordResolution = RegisteredRecordResolutionIdentity & {
  verifiedAccessGeneration: string;
};
export type RegisteredRecordResolutionPublicationResult = { entity: LimsEntity; replayed: boolean };

export function registeredRecordResolutionSourceRevision(
  reviewSourceRevision: string,
  fileSha256: string | null
): string {
  return createHash('sha256')
    .update(canonicalNativeMutationRequest({ review: reviewSourceRevision, file: fileSha256 }))
    .digest('hex');
}

export function registeredSpecializedRecordFingerprint(
  authority: 'primer_artifact' | 'sequence_package',
  owner: { home: unknown; files: unknown },
  digest: string
): string {
  return createHash('sha256')
    .update(canonicalNativeMutationRequest({ authority, owner, digest }))
    .digest('hex');
}

export function registeredRecordResolutionIdentity(
  value: unknown
): RegisteredRecordResolutionIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Registered record resolution identity is invalid.');
  const object = value as Record<string, unknown>;
  for (const key of [
    'accountId',
    'orgId',
    'entityId',
    'resolutionId',
    'operationId',
    'sourceRevision',
  ] as const) {
    const entry = object[key];
    if (typeof entry !== 'string' || !entry || entry.trim() !== entry)
      throw new Error('Registered record resolution identity is incomplete.');
  }
  if (
    (object.choice !== 'use_remote' && object.choice !== 'keep_saved') ||
    !/^[a-f0-9]{64}$/.test(String(object.sourceRevision)) ||
    String(object.operationId).length > 200
  )
    throw new Error('Registered record resolution choice or source revision is invalid.');
  return {
    accountId: object.accountId as string,
    orgId: object.orgId as string,
    entityId: object.entityId as string,
    resolutionId: object.resolutionId as string,
    operationId: object.operationId as string,
    choice: object.choice,
    sourceRevision: object.sourceRevision as string,
  };
}

export function registeredRecordResolutionRequestHash(
  identity: RegisteredRecordResolutionIdentity,
  version: unknown = NATIVE_MUTATION_REQUEST_VERSION
): string {
  return createHash('sha256')
    .update(
      nativeMutationRequestBytes(
        {
          action: 'resolve-organization-record',
          resolution: registeredRecordResolutionIdentity(identity),
        },
        version
      )
    )
    .digest('hex');
}

export function assertRegisteredRecordResolutionAccessInDb(
  db: Database.Database,
  input: VerifiedRegisteredRecordResolution
) {
  const identity = registeredRecordResolutionIdentity(input);
  if (!input.verifiedAccessGeneration)
    throw new Error('Verify current organization access before finishing this record change.');
  assertOrgRegistryRecordMutationAccount(db, {
    entityId: identity.entityId,
    accountId: identity.accountId,
  });
  const current = readOrgRegistryRecordReview(db, {
    accountId: identity.accountId,
    orgId: identity.orgId,
    entityId: identity.entityId,
    expectedAccessGeneration: input.verifiedAccessGeneration,
  });
  if (!current) throw new Error('The registered record’s organization connection is unavailable.');
  return current;
}

export function applyReviewedRegisteredRecordInTx(
  db: Database.Database,
  input: RegisteredRecordResolutionRequest
): LimsEntity {
  if (!db.inTransaction)
    throw new Error('Registered record resolution requires the owning transaction.');
  const current = limsEntityFromRow(getEntityRowById(db, input.entityId));
  const desired =
    input.choice === 'use_remote'
      ? { ...input.review.canonical, archived: input.review.canonical.archivedAt != null }
      : input.review.local;
  if (
    desired.id !== current.id ||
    typeof desired.name !== 'string' ||
    !desired.fields ||
    typeof desired.fields !== 'object' ||
    Array.isArray(desired.fields) ||
    !LIMS_REGISTRATION_STATUSES.some((status) => status === desired.registrationStatus) ||
    (desired.domainStatus !== null && typeof desired.domainStatus !== 'string') ||
    typeof desired.archived !== 'boolean'
  )
    throw new Error('The approved record version is incomplete. Review its versions again.');
  const fields = desired.fields as Record<string, unknown>;
  if (!isDeepStrictEqual(fields.artifact, current.fields.artifact))
    throw new Error(
      'The organization version has different saved-file information. Its record location must be reconciled before applying it.'
    );

  let result = updateLimsEntityInsideTx(db, {
    id: current.id,
    name: desired.name,
    fields,
    replaceFields: true,
    registrationStatus: desired.registrationStatus as LimsEntity['registrationStatus'],
    domainStatus: desired.domainStatus as string | null,
    expectedEventSeq: input.review.localEventSeq!,
    operationId: input.operationId,
    actor: 'local-user',
  });
  if (result.tombstone !== desired.archived) {
    const action = {
      id: result.id,
      expectedEventSeq: result.eventSeq!,
      operationId: input.operationId,
      actor: 'local-user',
    };
    result = desired.archived
      ? archiveLimsEntityInsideTx(db, action)
      : restoreLimsEntityInsideTx(db, action).entity;
  }
  if (
    result.workspaceId !== current.workspaceId ||
    result.kind !== current.kind ||
    result.schemaRevisionId !== current.schemaRevisionId ||
    !isDeepStrictEqual(result.fields.artifact, current.fields.artifact)
  )
    throw new Error('The reviewed record edit changed its saved authority.');
  return result;
}

const DATABASE_RESOLUTION_APPLIED = 'org_registry_record_resolution_applied';
const databaseResolutionKey = (operationId: string) =>
  `org-registry-record-resolution:${operationId}`;

export function resolveDatabaseRegisteredRecordInTx(
  db: Database.Database,
  input: {
    request: RegisteredRecordResolutionRequest;
    verifiedAccessGeneration: string;
  }
): RegisteredRecordResolutionPublicationResult {
  if (!db.inTransaction)
    throw new Error('Database record resolution requires the owning transaction.');
  const identity = registeredRecordResolutionIdentity(input.request);
  const scoped = assertRegisteredRecordResolutionAccessInDb(db, {
    ...identity,
    verifiedAccessGeneration: input.verifiedAccessGeneration,
  });
  const current = limsEntityFromRow(getEntityRowById(db, identity.entityId));
  if (
    orgRegistryRecordPublicationAuthority(db, current) !== 'database' ||
    scoped.binding.authority !== 'database'
  )
    throw new Error('This saved record must resolve through its file publication owner.');
  const prior = db
    .prepare('SELECT payload FROM lims_audit WHERE idempotency_key=? AND event_type=?')
    .get(databaseResolutionKey(identity.operationId), DATABASE_RESOLUTION_APPLIED) as
    | { payload: string }
    | undefined;
  if (prior) {
    const value: unknown = JSON.parse(prior.payload);
    if (
      !value ||
      typeof value !== 'object' ||
      !('schema' in value) ||
      value.schema !== 'dnaforge.org-registry-record-resolution.v1' ||
      !('resolution' in value) ||
      !('requestHash' in value) ||
      !('result' in value) ||
      !isDeepStrictEqual(registeredRecordResolutionIdentity(value.resolution), identity) ||
      value.requestHash !==
        registeredRecordResolutionRequestHash(
          identity,
          'requestHashVersion' in value ? value.requestHashVersion : undefined
        )
    )
      throw new Error('The resolution operation was reused with a different request.');
    const entity = parseLimsEntitySnapshot(value.result);
    if (entity.id !== identity.entityId || entity.workspaceId !== current.workspaceId)
      throw new Error('The recorded resolution belongs to a different saved record.');
    return { entity, replayed: true };
  }
  if (
    registeredRecordResolutionSourceRevision(input.request.review.sourceRevision, null) !==
    identity.sourceRevision
  )
    throw Object.assign(
      new Error('The approved record source changed. Review its versions again.'),
      { code: 'REVIEW_CHANGED' }
    );
  prepareOrgRegistryRecordResolutionInTx(db, {
    ...identity,
    review: input.request.review,
    publicationOperationId: identity.operationId,
    now: Date.now(),
  });
  const entity = applyReviewedRegisteredRecordInTx(db, input.request);
  const publicationDigest = orgRegistryDatabasePublicationDigest(entity);
  const publication = {
    accountId: identity.accountId,
    resolutionId: identity.resolutionId,
    operationId: identity.operationId,
    entity,
    publicationDigest,
    now: Date.now(),
  };
  captureOrgRegistryRecordResolutionPublicationInTx(db, publication);
  settleOrgRegistryRecordResolutionInTx(db, {
    ...publication,
    verifiedAccessGeneration: input.verifiedAccessGeneration,
  });
  insertAuditEvent(db, {
    eventType: DATABASE_RESOLUTION_APPLIED,
    operationId: identity.operationId,
    idempotencyKey: databaseResolutionKey(identity.operationId),
    subjectTable: 'lims_entity',
    subjectId: entity.id,
    workspaceId: entity.workspaceId,
    actor: 'local-user',
    payload: {
      schema: 'dnaforge.org-registry-record-resolution.v1',
      resolution: identity,
      requestHash: registeredRecordResolutionRequestHash(identity),
      requestHashVersion: NATIVE_MUTATION_REQUEST_VERSION,
      result: entity,
    },
  });
  return { entity, replayed: false };
}
