import { join } from 'node:path';
import { stageSavedFileMembers } from './saved-file-sources';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  parseEntityArtifact,
  serializeEntityArtifact,
  type EntityArtifactV2,
} from '../shared/entity-artifact';
import { entityArtifactProjectionFingerprint } from '../shared/entity-artifact-projection';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../shared/path-boundary';
import { isEntityRecordArtifactProjection } from '../shared/registry-file-types';
import {
  limsEntityFromRow,
  type LimsEntity,
  type LimsEntityActionInput,
  type LimsUpdateEntityInput,
  type LimsRevertEntityResult,
  type LimsUndoImportBatchInput,
  type LimsUndoImportBatchResult,
} from '../shared/lims';
import { parseLimsEntitySnapshot } from '../shared/lims-entity-snapshot';
import { getEntityRowById, insertAuditEvent, updateLimsEntityInsideTx } from './lims-engine-core';
import {
  getLimsRegistryPreviewInDb,
  registrySchemaSnapshotForEntity,
} from './lims-registry-projection';
import { assertRelationshipSchemaSnapshotsMatchInDb } from './relationship-schema-snapshot';
import {
  archiveLimsEntityInsideTx,
  restoreLimsEntityInsideTx,
  revertLimsEntityInsideTx,
} from './lims-entity-lifecycle';
import {
  publishNativeCatalogBytes,
  pruneCompletedNativeCatalogPublication,
  readNativeCatalogPublicationBase,
} from './native-catalog-publication';
import { materializeLimsGitReadableExportInDb } from './lims-git-export';
import {
  nativeMutationRequestBytes,
  NATIVE_MUTATION_REQUEST_VERSION,
} from './native-mutation-request';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { verifyLimsAuditHashChainInDb } from './lims-projection-rebuild';
import { prepareLimsImportBatchUndoInDb, undoLimsImportBatchInDb } from './lims-import';
import {
  readRegisteredRecordMutationAccount,
  settleDatabaseRegisteredRecordInTx,
  applyReviewedRegisteredRecordInTx,
  assertRegisteredRecordResolutionAccessInDb,
  registeredRecordResolutionIdentity,
  registeredRecordResolutionRequestHash,
  registeredRecordResolutionSourceRevision,
  type RegisteredRecordResolutionIdentity,
  type RegisteredRecordResolutionRequest,
  type RegisteredRecordResolutionPublicationResult,
  type VerifiedRegisteredRecordResolution,
} from './org-registry-local-mutations';
import {
  captureOrgRegistryRecordPublicationInTx,
  markOrgRegistryRecordPublicationReadyInTx,
  prepareOrgRegistryRecordResolutionInTx,
  captureOrgRegistryRecordResolutionPublicationInTx,
  settleOrgRegistryRecordResolutionInTx,
  readOrgRegistryRecordResolutionRetryReview,
} from './org-registry-record-sync';
import {
  requestedEntityFieldTargetIds,
  prepareEntityArtifactFieldUpdate,
  applyEntityArtifactFieldLinksInsideTx,
} from './entity-artifact-field-links';
import { schemaFieldRelationships } from '../shared/entity-field-relationships';

type Context = {
  db: Database.Database;
  runDatabase: <T>(work: () => T) => T;
  getActiveAccountId?: () => Promise<string | null>;
};

const registeredMutationAccount = (input: Context, entityIds: string[]) =>
  readRegisteredRecordMutationAccount(input.db, entityIds, input);

const REQUIRED = 'entity_artifact_publication_required';
const COMPLETE = 'entity_artifact_publication_complete';
const intentKey = (id: string) => `entity-artifact-edit:${id}`;
const completeKey = (id: string) => `entity-artifact-edit-complete:${id}`;
const publicationId = (id: string) => `entity-artifact:${id}`;
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

export function hasEntityArtifactAuthority(db: Database.Database, id: string): boolean {
  const row = db.prepare('SELECT fields FROM lims_entity WHERE id=?').get(id) as
    | { fields: string }
    | undefined;
  return row !== undefined && isEntityRecordArtifactProjection(JSON.parse(row.fields));
}

export function resolveEntityArtifactAuthority(
  db: Database.Database,
  entity: Pick<LimsEntity, 'id' | 'workspaceId' | 'fields'>
) {
  const binding = db
    .prepare(
      `SELECT f.path,w.id,w.path AS root FROM catalog_entity_files f
    JOIN workspaces w ON w.id=f.workspace_id WHERE f.entity_id=? AND f.status='current'`
    )
    .get(entity.id) as { path: string; id: number; root: string } | undefined;
  const workspace =
    binding ??
    (db.prepare('SELECT id,path AS root FROM workspaces WHERE id=?').get(entity.workspaceId) as
      | { id: number; root: string }
      | undefined);
  const metadata = entity.fields.artifact;
  if (
    !workspace ||
    !metadata ||
    typeof metadata !== 'object' ||
    !('relativePath' in metadata) ||
    typeof metadata.relativePath !== 'string'
  )
    throw new Error('Registry record has no owning project file.');
  const relativePath = binding
    ? pathRelativeToBoundary(binding.path, workspace.root)
    : metadata.relativePath;
  if (!relativePath || !isSafeWorkspaceRelativePath(relativePath))
    throw new Error('Registry record file escapes its owning project.');
  if (entity.workspaceId !== workspace.id)
    throw new Error(
      'Registry file and projection ownership disagree; reconcile the project before editing.'
    );
  return { workspaceId: workspace.id, workspacePath: workspace.root, relativePath };
}

function portableState(entity: LimsEntity) {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    fields: entity.fields,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
    schemaRevisionId: entity.schemaRevisionId,
    archived: entity.tombstone,
  };
}

function settlePublishedProjection(
  db: Database.Database,
  entity: LimsEntity,
  relativePath: string
) {
  const workspace = db
    .prepare('SELECT repo_uuid FROM workspaces WHERE id=?')
    .get(entity.workspaceId) as { repo_uuid: string | null } | undefined;
  if (!workspace || entity.workspaceId === null)
    throw new Error('Published Registry record owner is unavailable.');
  const fingerprint = entityArtifactProjectionFingerprint(portableState(entity));
  const scope = workspaceScopeKey(workspace.repo_uuid, entity.workspaceId);
  const workspaceKeys = [`scope:${scope}`, `workspace:${entity.workspaceId}`];
  const settle = db.prepare(`INSERT INTO entity_projection_sources
    (adapter_kind,entity_id,workspace_key,relative_path,projection_version,synchronized_fingerprint,synchronized_at)
    VALUES ('lims-entity',?,?,?,?,?,?)
    ON CONFLICT(adapter_kind,entity_id,workspace_key,relative_path,projection_version)
    DO UPDATE SET synchronized_fingerprint=excluded.synchronized_fingerprint,
                  synchronized_at=excluded.synchronized_at
    WHERE entity_projection_sources.synchronized_fingerprint <> excluded.synchronized_fingerprint`);
  for (const workspaceKey of workspaceKeys) {
    settle.run(
      entity.id,
      workspaceKey,
      relativePath.replace(/\\/g, '/'),
      1,
      fingerprint,
      Date.now()
    );
  }
}

export async function assertEntityArtifactProjectionMatchesFile(
  input: Context & {
    input: LimsUpdateEntityInput | LimsEntityActionInput;
    action: 'update' | 'archive' | 'restore';
  }
): Promise<void> {
  const current = input.runDatabase(() =>
    limsEntityFromRow(getEntityRowById(input.db, input.input.id))
  );
  const update = input.action === 'update' ? (input.input as LimsUpdateEntityInput) : null;
  const target = {
    ...current,
    ...(update?.workspaceId !== undefined ? { workspaceId: update.workspaceId } : {}),
    fields: update?.fields
      ? update.replaceFields
        ? update.fields
        : { ...current.fields, ...update.fields }
      : current.fields,
  };
  const owner = input.runDatabase(() => resolveEntityArtifactAuthority(input.db, target));
  const bytes = await readNativeCatalogPublicationBase({
    ...owner,
    operationId: `projection-read:${input.input.operationId ?? current.id}`,
  });
  if (!bytes) throw new Error('Authoritative Registry record file is missing.');
  const file = parseEntityArtifact(bytes.toString('utf8'));
  const snapshot =
    file.schema === ENTITY_ARTIFACT_CURRENT_SCHEMA
      ? file.schemaSnapshot
      : (file.schemaSnapshot ??
        input.runDatabase(() => getLimsRegistryPreviewInDb(input.db, { entityId: current.id }))
          ?.schemaSnapshot);
  const requestedSnapshot =
    update?.projectionSchema?.schemaSnapshot ??
    input.runDatabase(() => getLimsRegistryPreviewInDb(input.db, { entityId: current.id }))
      ?.schemaSnapshot;
  if (
    !snapshot ||
    !requestedSnapshot ||
    !isDeepStrictEqual(
      { ...snapshot, description: snapshot.description ?? null },
      { ...requestedSnapshot, description: requestedSnapshot.description ?? null }
    ) ||
    file.id !== current.id ||
    file.kind !== (update?.projectionSchema?.kind ?? current.kind) ||
    file.name !== (update?.name ?? current.name) ||
    !isDeepStrictEqual(file.fields, target.fields) ||
    file.registrationStatus !== (update?.registrationStatus ?? current.registrationStatus) ||
    file.domainStatus !==
      (update?.domainStatus === undefined ? current.domainStatus : update.domainStatus) ||
    (input.action !== 'update' &&
      (file.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA ||
        file.archived !== (input.action === 'archive')))
  ) {
    throw new Error('Derived Registry projection does not match its authoritative file.');
  }
}

export async function readCheckedEntityArtifactSnapshot(
  input: Context & { entityId: string; operationId?: string }
) {
  const { current, owner, schemaSnapshot } = input.runDatabase(() => {
    const current = limsEntityFromRow(getEntityRowById(input.db, input.entityId));
    const owner = resolveEntityArtifactAuthority(input.db, current);
    assertEntityArtifactPublicationsSettled(input.db, owner.workspacePath);
    return {
      current,
      owner,
      schemaSnapshot: registrySchemaSnapshotForEntity(input.db, current),
    };
  });
  const beforeBytes = await readNativeCatalogPublicationBase({
    ...owner,
    operationId: input.operationId ?? `entity-artifact-review:${current.id}`,
  });
  if (!beforeBytes) throw new Error('Authoritative Registry record file is missing.');
  const doc = parseEntityArtifact(beforeBytes.toString('utf8'));
  input.runDatabase(() =>
    assertRelationshipSchemaSnapshotsMatchInDb(input.db, doc.relationshipSchemaSnapshots)
  );
  const before: EntityArtifactV2 =
    doc.schema === ENTITY_ARTIFACT_CURRENT_SCHEMA
      ? doc
      : {
          ...doc,
          schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
          schemaRevisionId: (doc.schemaSnapshot ?? schemaSnapshot).schemaRevisionId,
          schemaSnapshot: doc.schemaSnapshot ?? schemaSnapshot,
          archived: doc.archived ?? current.tombstone,
        };
  if (
    !isDeepStrictEqual(
      portableState(current),
      portableState({ ...current, ...before, tombstone: before.archived })
    ) ||
    !isDeepStrictEqual(
      { ...before.schemaSnapshot, description: before.schemaSnapshot.description ?? null },
      { ...schemaSnapshot, description: schemaSnapshot.description ?? null }
    )
  ) {
    throw new Error(
      'Registry file and projection disagree; preserve both versions and reconcile before editing.'
    );
  }
  input.runDatabase(() => {
    assertEntityArtifactPublicationsSettled(input.db, owner.workspacePath);
    const latest = limsEntityFromRow(getEntityRowById(input.db, current.id));
    if (
      !isDeepStrictEqual(latest, current) ||
      !isDeepStrictEqual(resolveEntityArtifactAuthority(input.db, latest), owner) ||
      !isDeepStrictEqual(registrySchemaSnapshotForEntity(input.db, latest), schemaSnapshot)
    ) {
      throw new Error('Registry record changed while its saved file was read; review it again.');
    }
  });
  return {
    current,
    owner,
    beforeBytes,
    before,
    fileSchema: doc.schema,
    sha256: createHash('sha256').update(beforeBytes).digest('hex'),
  };
}

async function prepareArtifactPublication(
  input: Context & { entityId: string; operationId: string }
) {
  const owner = input.runDatabase(() =>
    resolveEntityArtifactAuthority(
      input.db,
      limsEntityFromRow(getEntityRowById(input.db, input.entityId))
    )
  );
  input.runDatabase(() => assertArtifactOwnerWritable(input.db, owner.workspaceId));
  await recoverEntityArtifactPublications({ ...input, workspacePath: owner.workspacePath });
  return readCheckedEntityArtifactSnapshot({
    ...input,
    operationId: publicationId(input.operationId),
  });
}

function enqueueArtifactPublicationInsideTx(
  input: Context & {
    prepared: Awaited<ReturnType<typeof prepareArtifactPublication>>;
    result: LimsEntity;
    operationId: string;
    requestHash: string;
    actor?: string | null;
    accountId: string | null;
    relationships?: EntityArtifactV2['relationships'];

    resolution?: RegisteredRecordResolutionIdentity;
  }
) {
  const { prepared, result, operationId, requestHash } = input;
  const { owner, before, beforeBytes } = prepared;
  if (result.workspaceId !== owner.workspaceId)
    throw new Error('A record edit cannot move its owning project.');
  if (!isDeepStrictEqual(result.fields.artifact, prepared.current.fields.artifact)) {
    throw new Error(
      'A record edit cannot change its authoritative file locator. Move the file through workspace operations.'
    );
  }
  const afterPreview = getLimsRegistryPreviewInDb(input.db, { entityId: prepared.current.id });
  if (!afterPreview) throw new Error('Updated record schema is unavailable.');
  const after: EntityArtifactV2 = {
    ...before,
    ...portableState(result),
    schemaRevisionId: afterPreview.schemaSnapshot.schemaRevisionId,
    schemaSnapshot: afterPreview.schemaSnapshot,
    ...(input.relationships ? { relationships: input.relationships } : {}),
  };
  const afterBytes = serializeEntityArtifact(after);
  insertAuditEvent(input.db, {
    eventType: REQUIRED,
    operationId,
    idempotencyKey: intentKey(operationId),
    subjectTable: 'lims_entity',
    subjectId: prepared.current.id,
    workspaceId: owner.workspaceId,
    actor: input.actor ?? 'local-user',
    payload: {
      schema: 'dnaforge.entity-artifact-publication.v1',
      ...owner,
      requestHash,
      requestHashVersion: NATIVE_MUTATION_REQUEST_VERSION,
      beforeBytes: beforeBytes.toString('utf8'),
      afterBytes,
      result,
      changed: result.eventSeq !== prepared.current.eventSeq,
      ...(input.resolution
        ? { organizationResolution: registeredRecordResolutionIdentity(input.resolution) }
        : {}),
    },
  });
  input.db
    .prepare(
      'INSERT INTO native_catalog_publication_outbox(operation_id,workspace_id) VALUES (?,?)'
    )
    .run(operationId, owner.workspaceId);
  if (input.resolution) {
    if (
      input.accountId !== input.resolution.accountId ||
      operationId !== input.resolution.operationId ||
      result.id !== input.resolution.entityId
    )
      throw new Error('This publication does not match the private resolution context.');
    captureOrgRegistryRecordResolutionPublicationInTx(input.db, {
      accountId: input.resolution.accountId,
      resolutionId: input.resolution.resolutionId,
      operationId,
      entity: result,
      publicationDigest: { authority: 'entity_artifact', sha256: digest(afterBytes) },
      now: Date.now(),
    });
  } else if (result.eventSeq !== prepared.current.eventSeq) {
    captureOrgRegistryRecordPublicationInTx(input.db, {
      accountId: input.accountId,
      operationId,
      entity: result,
      publicationDigest: { authority: 'entity_artifact', sha256: digest(afterBytes) },
      now: Date.now(),
    });
  }
  return result;
}

export async function publishReviewedEntityArtifactResolution(
  input: Context & {
    request: RegisteredRecordResolutionRequest;
    verifiedAccessGeneration: string;
  }
): Promise<RegisteredRecordResolutionPublicationResult> {
  const identity = registeredRecordResolutionIdentity(input.request);
  const access = { ...identity, verifiedAccessGeneration: input.verifiedAccessGeneration };
  const resumed = await resumeReviewedEntityArtifactResolution({ ...input, resolution: access });
  if (resumed) return resumed;
  if ((await registeredMutationAccount(input, [identity.entityId])) !== identity.accountId)
    throw new Error(
      'Sign in with the account that approved this record change before publishing it.'
    );
  input.runDatabase(() => {
    const scoped = assertRegisteredRecordResolutionAccessInDb(input.db, access);
    if (scoped.binding.authority !== 'entity_artifact')
      throw new Error('This record must resolve through its database publication owner.');
    assertArtifactOwnerWritable(input.db, scoped.binding.workspaceId);
  });

  const prepared = await readCheckedEntityArtifactSnapshot({
    ...input,
    entityId: identity.entityId,
    operationId: publicationId(identity.operationId),
  });
  if (
    registeredRecordResolutionSourceRevision(
      input.request.review.sourceRevision,
      prepared.sha256
    ) !== identity.sourceRevision
  )
    throw Object.assign(
      new Error('The saved record changed after review. Review its versions again.'),
      { code: 'REVIEW_CHANGED' }
    );
  if ((await registeredMutationAccount(input, [identity.entityId])) !== identity.accountId)
    throw new Error('The active account changed while this record was being checked.');
  const result = input.runDatabase(() =>
    input.db.transaction(() => {
      assertRegisteredRecordResolutionAccessInDb(input.db, access);
      if (
        !isDeepStrictEqual(
          limsEntityFromRow(getEntityRowById(input.db, identity.entityId)),
          prepared.current
        )
      )
        throw new Error('The saved record changed before its reviewed edit could commit.');
      prepareOrgRegistryRecordResolutionInTx(input.db, {
        ...identity,
        review: input.request.review,
        publicationOperationId: identity.operationId,
        now: Date.now(),
      });
      const entity = applyReviewedRegisteredRecordInTx(input.db, input.request);
      enqueueArtifactPublicationInsideTx({
        ...input,
        prepared,
        result: entity,
        operationId: identity.operationId,
        requestHash: registeredRecordResolutionRequestHash(identity),
        accountId: identity.accountId,
        resolution: identity,
        actor: 'local-user',
      });
      return entity;
    })()
  );
  await recoverEntityArtifactPublications({
    ...input,
    workspacePath: prepared.owner.workspacePath,
    onlyOperationId: identity.operationId,
    resolution: access,
  });
  return { entity: result, replayed: false };
}

export function readReviewedEntityArtifactResolutionIdentity(
  db: Database.Database,
  input: {
    accountId: string;
    orgId: string;
    entityId: string;
    resolutionId: string;
    operationId: string;
    verifiedAccessGeneration: string;
  }
): RegisteredRecordResolutionIdentity | null {
  const intent = readIntent(db, input.operationId);
  if (!intent) return null;
  const resolution = intent.resolution;
  if (
    !resolution ||
    resolution.accountId !== input.accountId ||
    resolution.orgId !== input.orgId ||
    resolution.entityId !== input.entityId ||
    resolution.resolutionId !== input.resolutionId ||
    resolution.operationId !== input.operationId
  )
    throw new Error('The saved resolution belongs to a different record or account.');
  const current = readOrgRegistryRecordResolutionRetryReview(db, {
    accountId: resolution.accountId,
    orgId: resolution.orgId,
    entityId: resolution.entityId,
    expectedAccessGeneration: input.verifiedAccessGeneration,
  });
  if (!current) throw new Error('The registered record’s organization connection is unavailable.');
  return resolution;
}

export async function resumeReviewedEntityArtifactResolution(
  input: Context & {
    resolution: VerifiedRegisteredRecordResolution;
  }
): Promise<RegisteredRecordResolutionPublicationResult | null> {
  const identity = registeredRecordResolutionIdentity(input.resolution);
  const intent = input.runDatabase(() => readIntent(input.db, identity.operationId));
  if (!intent) return null;
  if (
    !intent.resolution ||
    !isDeepStrictEqual(intent.resolution, identity) ||
    intent.requestHash !==
      registeredRecordResolutionRequestHash(identity, intent.requestHashVersion)
  )
    throw new Error('This resolution operation was reused with a different request or choice.');
  await assertResolutionRecoveryAccess(input, intent);
  await recoverEntityArtifactPublications({
    ...input,
    workspacePath: intent.workspacePath,
    onlyOperationId: identity.operationId,
  });
  input.runDatabase(() => {
    assertRegisteredRecordResolutionAccessInDb(input.db, input.resolution);
    const row = input.db
      .prepare(
        `SELECT status FROM org_registry_record_resolutions
      WHERE resolution_id=? AND account_id=? AND org_id=? AND entity_id=? AND publication_operation_id=?`
      )
      .get(
        identity.resolutionId,
        identity.accountId,
        identity.orgId,
        identity.entityId,
        identity.operationId
      ) as { status: string } | undefined;
    if (row?.status !== 'settled')
      throw new Error('The reviewed record publication still needs recovery.');
  });
  return { entity: intent.result, replayed: true };
}

async function assertResolutionRecoveryAccess(
  input: Context & { resolution?: VerifiedRegisteredRecordResolution },
  intent: NonNullable<ReturnType<typeof readIntent>>
): Promise<VerifiedRegisteredRecordResolution> {
  if (
    !intent.resolution ||
    !input.resolution ||
    !isDeepStrictEqual(registeredRecordResolutionIdentity(input.resolution), intent.resolution)
  )
    throw new Error(
      'This reviewed record change is saved locally and still requires verified organization access to finish.'
    );
  if ((await registeredMutationAccount(input, [intent.result.id])) !== intent.resolution.accountId)
    throw new Error(
      'Sign in with the account that approved this record change before recovering it.'
    );
  input.runDatabase(() => assertRegisteredRecordResolutionAccessInDb(input.db, input.resolution!));
  return input.resolution;
}

export async function mutateEntityArtifact(
  input: Context & {
    action: 'update' | 'archive' | 'restore' | 'revert';
    input: LimsUpdateEntityInput | LimsEntityActionInput;
  }
): Promise<LimsRevertEntityResult> {
  const { operationId, expectedEventSeq } = input.input;
  if (
    !operationId ||
    operationId.length > 200 ||
    !Number.isSafeInteger(expectedEventSeq) ||
    Number(expectedEventSeq) < 1
  ) {
    throw new Error(
      'Refresh this record before changing it; its operation ID and current edit version are required.'
    );
  }
  const targetIds =
    input.action === 'update'
      ? requestedEntityFieldTargetIds(input.input as LimsUpdateEntityInput)
      : input.action === 'revert'
        ? input.runDatabase(() => {
            const prior = input.db
              .prepare(
                `SELECT before FROM lims_audit WHERE subject_id=? AND subject_table='lims_entity'
            AND event_type IN ('entity_updated','entity_reverted','entity_archived','entity_restored','entity_tombstoned')
            AND before IS NOT NULL ORDER BY event_seq DESC LIMIT 1`
              )
              .get(input.input.id) as { before: string } | undefined;
            if (!prior) return [];
            const entity = parseLimsEntitySnapshot(JSON.parse(prior.before));
            const schema = getLimsRegistryPreviewInDb(input.db, {
              entityId: input.input.id,
            })?.schemaSnapshot;
            return entity && schema
              ? schemaFieldRelationships(entity.id, schema.fields, entity.fields).map(
                  (link) => link.toEntityId
                )
              : [];
          })
        : [];
  const guardedEntityIds = [input.input.id, ...targetIds];
  const accountId = await registeredMutationAccount(input, guardedEntityIds);
  const prior = input.runDatabase(() => readIntent(input.db, operationId));
  const requestHash = digest(
    nativeMutationRequestBytes(
      { action: input.action, input: input.input },
      prior?.requestHashVersion ?? NATIVE_MUTATION_REQUEST_VERSION
    )
  );
  if (prior) {
    if (prior.requestHash !== requestHash || prior.result.id !== input.input.id)
      throw new Error('Record edit operation was reused with a different request.');
    const currentOwner = input.runDatabase(() =>
      resolveEntityArtifactAuthority(
        input.db,
        limsEntityFromRow(getEntityRowById(input.db, input.input.id))
      )
    );
    if (currentOwner.workspaceId !== prior.workspaceId) {
      throw new Error('Record ownership changed after this edit. Refresh it before retrying.');
    }
    await recoverEntityArtifactPublications({ ...input, workspacePath: prior.workspacePath });
    return { entity: prior.result, reverted: prior.changed };
  }
  const prepared = await prepareArtifactPublication({
    ...input,
    entityId: input.input.id,
    operationId,
  });
  const { current, owner } = prepared;
  if (current.eventSeq !== expectedEventSeq)
    throw new Error('Registry record changed; refresh it before saving.');
  if ((await registeredMutationAccount(input, guardedEntityIds)) !== accountId)
    throw new Error(
      'The active account changed while preparing this record save. Review it and retry.'
    );
  const result = input.runDatabase(() =>
    input.db.transaction(() => {
      const live = limsEntityFromRow(getEntityRowById(input.db, current.id));
      if (live.eventSeq !== expectedEventSeq)
        throw new Error('Registry record changed; refresh it before saving.');
      if (input.action === 'update' && live.tombstone)
        throw new Error('Restore this record before editing it.');
      const changed =
        input.action === 'update'
          ? {
              entity: updateLimsEntityInsideTx(
                input.db,
                prepareEntityArtifactFieldUpdate(
                  input.db,
                  prepared.before,
                  input.input as LimsUpdateEntityInput
                )
              ),
              reverted: true,
            }
          : input.action === 'archive'
            ? { entity: archiveLimsEntityInsideTx(input.db, input.input), reverted: true }
            : input.action === 'restore'
              ? { entity: restoreLimsEntityInsideTx(input.db, input.input).entity, reverted: true }
              : revertLimsEntityInsideTx(input.db, input.input);
      enqueueArtifactPublicationInsideTx({
        ...input,
        prepared,
        accountId,
        result: changed.entity,
        operationId,
        requestHash,
        actor: input.input.actor,
        relationships: applyEntityArtifactFieldLinksInsideTx(
          input.db,
          prepared.before,
          changed.entity,
          operationId,
          accountId
        ),
      });
      return changed;
    })()
  );
  await recoverEntityArtifactPublications({ ...input, workspacePath: owner.workspacePath });
  return result;
}

export async function undoImportBatchWithEntityArtifacts(
  input: Context & { input: LimsUndoImportBatchInput }
): Promise<LimsUndoImportBatchResult> {
  const batchId = input.input.batchId.trim();
  const operationId = (id: string) => `import-undo:${digest(JSON.stringify([batchId, id]))}`;
  const completed = input.runDatabase(() => {
    const undone = input.db
      .prepare(
        "SELECT payload FROM lims_audit WHERE batch_id=? AND event_type='import_batch_undone' AND tombstone=0"
      )
      .get(batchId) as { payload: string } | undefined;
    if (!undone) return null;
    const created = input.db
      .prepare(
        "SELECT DISTINCT subject_id FROM lims_audit WHERE batch_id=? AND event_type='entity_registered' AND subject_table='lims_entity'"
      )
      .all(batchId) as { subject_id: string }[];
    const intents = created.flatMap((row) => {
      const intent = readIntent(input.db, operationId(row.subject_id));
      return intent ? [intent] : [];
    });

    if (intents.length === 0) return null;
    for (const intent of intents) {
      const owner = resolveEntityArtifactAuthority(
        input.db,
        limsEntityFromRow(getEntityRowById(input.db, intent.result.id))
      );
      if (owner.workspaceId !== intent.workspaceId)
        throw new Error('Imported record ownership changed after Undo; refresh before retrying.');
    }
    const payload: unknown = JSON.parse(undone.payload);
    if (!payload || typeof payload !== 'object') throw new Error('Import Undo receipt is invalid.');
    const counts = [
      'tombstonedEntities',
      'tombstonedLinks',
      'skippedEntities',
      'skippedLinks',
    ] as const;
    for (const key of counts) {
      if (
        !(key in payload) ||
        !Number.isSafeInteger(Reflect.get(payload, key)) ||
        Number(Reflect.get(payload, key)) < 0
      )
        throw new Error('Import Undo receipt is invalid.');
    }
    return {
      roots: [...new Set(intents.map((intent) => intent.workspacePath))],
      result: {
        batchId,
        tombstonedEntities: Number(Reflect.get(payload, 'tombstonedEntities')),
        tombstonedLinks: Number(Reflect.get(payload, 'tombstonedLinks')),
        skippedEntities: Number(Reflect.get(payload, 'skippedEntities')),
        skippedLinks: Number(Reflect.get(payload, 'skippedLinks')),
      },
    };
  });
  if (completed) {
    for (const workspacePath of completed.roots)
      await recoverEntityArtifactPublications({ ...input, workspacePath });
    return completed.result;
  }
  const candidates = input.runDatabase(() => {
    const plan = prepareLimsImportBatchUndoInDb(input.db, input.input);
    if (!verifyLimsAuditHashChainInDb(input.db).ok)
      throw new Error('Registry history integrity check failed; import Undo was refused.');
    return plan.entityRows.filter((row) => !row.tombstone);
  });
  const accountId = await registeredMutationAccount(
    input,
    candidates.map((row) => row.id)
  );
  const prepared: Awaited<ReturnType<typeof prepareArtifactPublication>>[] = [];
  for (const candidate of candidates.filter((row) =>
    hasEntityArtifactAuthority(input.db, row.id)
  )) {
    prepared.push(
      await prepareArtifactPublication({
        ...input,
        entityId: candidate.id,
        operationId: operationId(candidate.id),
      })
    );
  }
  if (
    (await registeredMutationAccount(
      input,
      candidates.map((row) => row.id)
    )) !== accountId
  )
    throw new Error('The active account changed while preparing import Undo. Review it and retry.');
  const result = input.runDatabase(() =>
    input.db.transaction(() => {
      for (const source of prepared) {
        if (
          !isDeepStrictEqual(
            limsEntityFromRow(getEntityRowById(input.db, source.current.id)),
            source.current
          )
        )
          throw new Error('Imported record changed; refresh before Undo.');
      }
      const undone = undoLimsImportBatchInDb(input.db, input.input);
      for (const candidate of candidates.filter(
        (row) => !hasEntityArtifactAuthority(input.db, row.id)
      )) {
        const after = limsEntityFromRow(getEntityRowById(input.db, candidate.id));
        if (after.eventSeq !== candidate.event_seq) {
          settleDatabaseRegisteredRecordInTx(input.db, {
            entity: after,
            accountId,
            operationId: operationId(candidate.id),
          });
        }
      }
      for (const source of prepared) {
        enqueueArtifactPublicationInsideTx({
          ...input,
          prepared: source,
          accountId,
          result: limsEntityFromRow(getEntityRowById(input.db, source.current.id)),
          operationId: operationId(source.current.id),
          requestHash: digest(
            nativeMutationRequestBytes(
              {
                action: 'undo-import',
                batchId,
                entityId: source.current.id,
              },
              NATIVE_MUTATION_REQUEST_VERSION
            )
          ),
          actor: input.input.actor,
        });
      }
      return undone;
    })()
  );
  for (const workspacePath of new Set(prepared.map((source) => source.owner.workspacePath)))
    await recoverEntityArtifactPublications({ ...input, workspacePath });
  return result;
}

function pending(db: Database.Database, workspacePath: string) {
  const rows = db
    .prepare(
      `SELECT r.operation_id,r.payload FROM native_catalog_publication_outbox o
    JOIN lims_audit r ON r.operation_id=o.operation_id AND r.event_type=?
    ORDER BY r.event_seq`
    )
    .all(REQUIRED) as { operation_id: string; payload: string }[];
  return rows.filter((row) => {
    const intent = readIntent(db, row.operation_id);
    return (
      intent &&
      workspaceMutationRootIdentity(intent.workspacePath) ===
        workspaceMutationRootIdentity(workspacePath)
    );
  });
}

export function assertEntityArtifactPublicationsSettled(
  db: Database.Database,
  workspacePath: string
): void {
  if (pending(db, workspacePath).length)
    throw new Error(
      'Registry record has a pending file save. Recover it before copying or syncing this project.'
    );
}

export async function recoverEntityArtifactPublications(
  input: Context & {
    workspacePath: string;
    onlyOperationId?: string;
    resolution?: VerifiedRegisteredRecordResolution;
  }
): Promise<void> {
  const rows = input
    .runDatabase(() => pending(input.db, input.workspacePath))
    .filter(
      (row) => input.onlyOperationId === undefined || row.operation_id === input.onlyOperationId
    );
  if (rows.length && !input.runDatabase(() => verifyLimsAuditHashChainInDb(input.db).ok)) {
    throw new Error('Registry history integrity check failed; file recovery was refused.');
  }
  for (const row of rows) {
    const intent = input.runDatabase(() => readIntent(input.db, row.operation_id));
    if (!intent) throw new Error('Registry record publication intent is missing.');
    if (intent.resolution) await assertResolutionRecoveryAccess(input, intent);
    input.runDatabase(() => assertArtifactOwnerWritable(input.db, intent.workspaceId));
    const completed = input.runDatabase(() =>
      input.db
        .prepare('SELECT 1 FROM lims_audit WHERE idempotency_key=? AND event_type=?')
        .get(completeKey(row.operation_id), COMPLETE)
    );
    if (!completed) {
      input.runDatabase(() => {
        const current = limsEntityFromRow(getEntityRowById(input.db, intent.result.id));
        const owner = resolveEntityArtifactAuthority(input.db, current);
        if (
          !isDeepStrictEqual(current, intent.result) ||
          owner.workspacePath !== intent.workspacePath ||
          owner.relativePath !== intent.relativePath
        )
          throw new Error(
            'Registry record changed after its save committed; later data was preserved.'
          );
      });
      const owner = { workspaceId: intent.workspaceId, entityId: intent.result.id, path: join(intent.workspacePath, intent.relativePath) };
      const [retainPrior, retainPublished] = await Promise.all([intent.beforeBytes, intent.afterBytes].map(
        text => stageSavedFileMembers(input.db, {...owner, members: [{relativePath: '', bytes: Buffer.from(text)}]})
      ));
      input.runDatabase(retainPrior);
      await publishNativeCatalogBytes({
        workspacePath: intent.workspacePath,
        relativePath: intent.relativePath,
        operationId: publicationId(row.operation_id),
        beforeBytes: Buffer.from(intent.beforeBytes),
        afterBytes: Buffer.from(intent.afterBytes),
      });
      input.runDatabase(() => {
        input.db.transaction(() => {
          const current = limsEntityFromRow(getEntityRowById(input.db, intent.result.id));
          if (!isDeepStrictEqual(current, intent.result)) {
            throw new Error(
              'Registry record changed during publication; later data was preserved.'
            );
          }
          retainPublished();
          settlePublishedProjection(input.db, current, intent.relativePath);
          insertAuditEvent(input.db, {
            eventType: COMPLETE,
            operationId: row.operation_id,
            idempotencyKey: completeKey(row.operation_id),
            subjectTable: 'lims_entity',
            subjectId: intent.result.id,
            workspaceId: intent.workspaceId,
            actor: 'artifact-publication',
          });
        })();
      });
    }
    if (intent.resolution) await assertResolutionRecoveryAccess(input, intent);
    await pruneCompletedNativeCatalogPublication({
      workspacePath: intent.workspacePath,
      relativePath: intent.relativePath,
      operationId: publicationId(row.operation_id),
    });
    input.runDatabase(() =>
      materializeLimsGitReadableExportInDb(input.db, {
        workspaceId: intent.workspaceId,
        durable: true,
      })
    );
    if (intent.resolution) {
      const bytes = await readNativeCatalogPublicationBase({
        workspacePath: intent.workspacePath,
        relativePath: intent.relativePath,
        operationId: publicationId(row.operation_id),
      });
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest(intent.afterBytes))
        throw new Error(
          'The published record changed before its reviewed resolution settled. Its recovery intent was retained.'
        );
      await assertResolutionRecoveryAccess(input, intent);
    }
    input.runDatabase(() =>
      input.db.transaction(() => {
        if (intent.resolution) {
          if (!input.resolution)
            throw new Error(
              'Verified organization access is required to finish this record publication.'
            );
          assertRegisteredRecordResolutionAccessInDb(input.db, input.resolution);
          settleOrgRegistryRecordResolutionInTx(input.db, {
            accountId: intent.resolution.accountId,
            resolutionId: intent.resolution.resolutionId,
            operationId: row.operation_id,
            entity: intent.result,
            publicationDigest: { authority: 'entity_artifact', sha256: digest(intent.afterBytes) },
            verifiedAccessGeneration: input.resolution.verifiedAccessGeneration,
            now: Date.now(),
          });
        } else
          markOrgRegistryRecordPublicationReadyInTx(input.db, {
            operationId: row.operation_id,
            entityId: intent.result.id,
            publicationDigest: { authority: 'entity_artifact', sha256: digest(intent.afterBytes) },
            now: Date.now(),
          });
        input.db
          .prepare('DELETE FROM native_catalog_publication_outbox WHERE operation_id=?')
          .run(row.operation_id);
      })()
    );
  }
}

function assertArtifactOwnerWritable(db: Database.Database, workspaceId: number): void {
  const access = db
    .prepare('SELECT access_mode,archived_at,trashed_at FROM workspaces WHERE id=?')
    .get(workspaceId) as
    | { access_mode: string; archived_at: number | null; trashed_at: number | null }
    | undefined;
  if (
    !access ||
    access.access_mode !== 'writable' ||
    access.archived_at !== null ||
    access.trashed_at !== null
  ) {
    throw new Error(
      'The project that owns this record must be active and writable before its file can change.'
    );
  }
}

export async function retainHistoricalRegistryFileSources(db: Database.Database, input: {
  workspaceId: number | null;
  entityId: string;
  assertCurrent(): void;
}): Promise<void> {
  const events = db.prepare(`SELECT operation_id, created_at FROM lims_audit
    WHERE event_type=? AND subject_table='lims_entity' AND subject_id=? AND workspace_id IS ? ORDER BY event_seq DESC`).all(
    COMPLETE,input.entityId,input.workspaceId) as Array<{operation_id:string;created_at:number}>;
  if (!events.length) return;
  const exists = db.prepare(`SELECT 1 FROM retained_file_source_revisions WHERE workspace_id IS ? AND entity_id=? AND status='committed' AND json_extract(manifest_json,'$.members[0].sha256')=? LIMIT 1`);
  let verified=false;
  for (const event of events) {
    input.assertCurrent();
    const intent=readIntent(db,event.operation_id);
    if(!intent || intent.workspaceId!==input.workspaceId || intent.result.id!==input.entityId) throw new Error('The completed Registry publication and its source disagree.');
    for (const [bytes, historicalAt] of [[intent.afterBytes,event.created_at],[intent.beforeBytes,event.created_at-1]] as const) {
      if (exists.get(input.workspaceId,input.entityId,digest(bytes))) continue;
      if (!verified) {
        if (!verifyLimsAuditHashChainInDb(db).ok) throw new Error('Registry source history failed its integrity check.');
        verified=true;
      }
      const retain=await stageSavedFileMembers(db,{workspaceId:input.workspaceId,entityId:input.entityId,
        path:join(intent.workspacePath,intent.relativePath), historicalAt,
        members:[{relativePath:'',bytes:Buffer.from(bytes)}]});
      input.assertCurrent();
      retain();
    }
  }
}

function readIntent(db: Database.Database, operationId: string) {
  const row = db
    .prepare('SELECT payload FROM lims_audit WHERE idempotency_key=? AND event_type=?')
    .get(intentKey(operationId), REQUIRED) as { payload: string } | undefined;
  if (!row) return null;
  const value: unknown = JSON.parse(row.payload);
  if (
    !value ||
    typeof value !== 'object' ||
    !('schema' in value) ||
    value.schema !== 'dnaforge.entity-artifact-publication.v1' ||
    !('workspacePath' in value) ||
    typeof value.workspacePath !== 'string' ||
    !('relativePath' in value) ||
    typeof value.relativePath !== 'string' ||
    !isSafeWorkspaceRelativePath(value.relativePath) ||
    !('workspaceId' in value) ||
    typeof value.workspaceId !== 'number' ||
    !('beforeBytes' in value) ||
    typeof value.beforeBytes !== 'string' ||
    !('afterBytes' in value) ||
    typeof value.afterBytes !== 'string' ||
    !('requestHash' in value) ||
    typeof value.requestHash !== 'string' ||
    !('result' in value) ||
    !('changed' in value) ||
    typeof value.changed !== 'boolean'
  )
    throw new Error('Registry record publication intent is invalid.');
  const before = parseEntityArtifact(value.beforeBytes),
    after = parseEntityArtifact(value.afterBytes);
  const result = parseLimsEntitySnapshot(value.result);
  if (
    before.id !== result.id ||
    after.id !== result.id ||
    after.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA ||
    result.workspaceId !== value.workspaceId
  )
    throw new Error('Registry record publication identity is inconsistent.');
  const resolution =
    'organizationResolution' in value
      ? registeredRecordResolutionIdentity(value.organizationResolution)
      : null;
  if (
    resolution &&
    (resolution.operationId !== operationId ||
      resolution.entityId !== result.id ||
      value.requestHash !==
        registeredRecordResolutionRequestHash(
          resolution,
          'requestHashVersion' in value ? value.requestHashVersion : undefined
        ) ||
      !isDeepStrictEqual(
        portableState({ ...result, ...after, tombstone: after.archived }),
        portableState(result)
      ) ||
      !isDeepStrictEqual(before.fields.artifact, after.fields.artifact) ||
      !isDeepStrictEqual(before.relationships, after.relationships) ||
      before.kind !== after.kind ||
      (before.schema === ENTITY_ARTIFACT_CURRENT_SCHEMA &&
        (before.schemaRevisionId !== after.schemaRevisionId ||
          !isDeepStrictEqual(
            { ...before.schemaSnapshot, description: before.schemaSnapshot.description ?? null },
            { ...after.schemaSnapshot, description: after.schemaSnapshot.description ?? null }
          ))))
  )
    throw new Error(
      'The reviewed publication changed its record, saved location, schema or relationships.'
    );
  const workspace = db.prepare('SELECT path FROM workspaces WHERE id=?').get(value.workspaceId) as
    | { path: string }
    | undefined;
  if (!workspace) throw new Error('Registry record publication owning project is unavailable.');
  return {
    workspacePath: workspace.path,
    relativePath: value.relativePath,
    workspaceId: value.workspaceId,
    beforeBytes: value.beforeBytes,
    afterBytes: value.afterBytes,
    requestHash: value.requestHash,
    requestHashVersion: 'requestHashVersion' in value ? value.requestHashVersion : undefined,
    result,
    changed: value.changed,
    resolution,
  };
}
