import type {
  PrimerArtifactRevisionChange,
  PrimerArtifactRevisionRequest,
  PrimerArtifactRevisionResult,
  PrimerArtifactRevisionState,
} from '../shared/primer-artifact-revision';
export type {
  PrimerArtifactRevisionChange,
  PrimerArtifactRevisionRequest,
  PrimerArtifactRevisionResult,
} from '../shared/primer-artifact-revision';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { limsEntityFromRow, type LimsEntity, type LimsEntityActionInput } from '../shared/lims';
import { parseLimsEntitySnapshot } from '../shared/lims-entity-snapshot';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import {
  addPrimerArtifactBinding,
  removePrimerArtifactBinding,
  replaceOwnedPrimerArtifactBindings,
  updatePrimerArtifactBinding,
  revisePrimerArtifactContent,
  parsePrimerArtifact,
  serializePrimerArtifact,
  type PrimerArtifactV1,
  type PrimerArtifactBindingV1,
} from '../shared/primers/primer-artifact';
import {
  primerArtifactRegistryProjection,
  primerArtifactLegacyProjection,
} from '../shared/primers/primer-artifact-projection';
import type { Primer } from '../shared/primers/types';
import { getEntityRowById, insertAuditEvent, updateLimsEntityInsideTx } from './lims-engine-core';
import {
  archiveLimsEntityInsideTx,
  restoreLimsEntityInsideTx,
  applySavedLimsEntityLifecycleInsideTx,
} from './lims-entity-lifecycle';
import {
  assertOrganizationSavedPrimerSnapshot,
  type OrganizationSavedPrimerSnapshot,
} from './org-registry-saved-primer-snapshot-contract';
import { verifyLimsAuditHashChainInDb } from './lims-projection-rebuild';
import {
  readCheckedPrimerArtifactSnapshot,
  readPrimerArtifactAuthority,
} from './primer-artifact-reader';
import {
  readPrimerArtifactBindings,
  assertPrimerBindingIdentitiesCurrent,
} from './primer-artifact-bindings';
import { replacePrimerLegacyProjectionInsideTx } from './primer-projection';
export { assertPrimerRegistryProjection } from './primer-projection';
import { readPrimerRelationshipAuthority } from './primer-registry-relationships';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { materializeLimsGitReadableExportInDb } from './lims-git-export';
import {
  publishNativeCatalogBytes,
  readNativeCatalogPublicationBase,
  pruneCompletedNativeCatalogPublication,
} from './native-catalog-publication';
import {
  nativeMutationRequestBytes,
  NATIVE_MUTATION_REQUEST_VERSION,
} from './native-mutation-request';
import {
  readRegisteredRecordMutationAccount,
  registeredRecordResolutionIdentity,
  registeredRecordResolutionRequestHash,
  registeredRecordResolutionSourceRevision,
  registeredSpecializedRecordFingerprint,
  assertRegisteredRecordResolutionAccessInDb,
  type RegisteredRecordResolutionIdentity,
  type RegisteredRecordResolutionRequest,
  type VerifiedRegisteredRecordResolution,
  type RegisteredRecordResolutionPublicationResult,
} from './org-registry-local-mutations';
import { readCheckedOrganizationRecordReview } from './org-registry-record-review';
import {
  captureOrgRegistryRecordPublicationInTx,
  prepareOrgRegistryRecordResolutionInTx,
  captureOrgRegistryRecordResolutionPublicationInTx,
  settleOrgRegistryRecordResolutionInTx,
  readOrgRegistryResolutionPublicationAdmissionInDb,
  readOrgRegistryRecordResolutionRetryReview,
  markOrgRegistryRecordPublicationReadyInTx,
  orgRegistryPrimerPublicationDigest,
  readOrgRegistryPublicationAdmissionInDb,
  type OrgRegistryRecordReview,
} from './org-registry-record-sync';

interface Context {
  db: Database.Database;
  runDatabase: <T>(work: () => T) => T;
  getActiveAccountId?: () => Promise<string | null>;

  organizationResolution?: VerifiedRegisteredRecordResolution;
}

export async function readPrimerArtifactRevisionStateInMain(
  input: Context & { entityId: string; getActiveAccountId: () => Promise<string | null> }
): Promise<PrimerArtifactRevisionState> {
  const { db, runDatabase, getActiveAccountId, entityId } = input;

  const enrolled = runDatabase(() =>
    db.prepare('SELECT 1 FROM org_registry_local_records WHERE entity_id=? LIMIT 1').get(entityId)
  );
  if (!enrolled) return { state: 'not_enrolled' };
  const accountId = await getActiveAccountId();
  const admission = runDatabase(() =>
    readOrgRegistryPublicationAdmissionInDb(db, { entityId: entityId, accountId })
  );
  if (
    !admission ||
    admission.bindings.some((binding) => binding.authorityKind !== 'primer_artifact')
  )
    throw new Error('This registered record is not owned by a saved primer file.');
  const context = { db, runDatabase, getActiveAccountId };
  const pending = await readPendingPrimerArtifactPublication({
    ...context,
    entityId: entityId,
  });
  if (pending) return { state: 'pending', ...pending };
  const snapshot = await readCheckedPrimerArtifactSnapshot({
    ...context,
    entityId: entityId,
  });
  if ((await getActiveAccountId()) !== accountId)
    throw new Error('The active account changed while reading the saved primer.');
  const current = runDatabase(() =>
    readOrgRegistryPublicationAdmissionInDb(db, { entityId: entityId, accountId })
  );
  if (
    !current ||
    !isDeepStrictEqual(current, admission) ||
    !isDeepStrictEqual(current.entity, snapshot.current) ||
    !Number.isSafeInteger(snapshot.current.eventSeq) ||
    Number(snapshot.current.eventSeq) < 1
  )
    throw new Error('The saved primer changed while its current revision was read.');
  return {
    state: 'ready',
    entity: snapshot.current,
    artifact: snapshot.before,
    expectedEventSeq: snapshot.current.eventSeq!,
    expectedContentHash: snapshot.sha256,
    workspaceId: snapshot.owner.workspaceId,
    relativePath: snapshot.owner.relativePath,
  };
}

function equivalentBinding(left: PrimerArtifactBindingV1, right: PrimerArtifactBindingV1): boolean {
  return (
    left.relation === right.relation &&
    left.target.documentId === right.target.documentId &&
    left.target.topology === right.target.topology &&
    left.target.length === right.target.length &&
    left.target.fileContentHash === right.target.fileContentHash &&
    left.target.normalizedSequenceHash === right.target.normalizedSequenceHash &&
    left.coordinates.system === right.coordinates.system &&
    left.coordinates.start === right.coordinates.start &&
    left.coordinates.end === right.coordinates.end &&
    left.coordinates.strand === right.coordinates.strand
  );
}

const REQUIRED = 'primer_artifact_publication_required';
const COMPLETE = 'primer_artifact_publication_complete';
const intentKey = (id: string) => `primer-artifact-edit:${id}`;
const completeKey = (id: string) => `primer-artifact-edit-complete:${id}`;
const publicationId = (id: string) => `primer-artifact:${id}`;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function assertWritableHome(db: Database.Database, workspaceId: number): void {
  const home = db
    .prepare('SELECT access_mode,archived_at,trashed_at FROM workspaces WHERE id=?')
    .get(workspaceId) as
    | { access_mode: string; archived_at: number | null; trashed_at: number | null }
    | undefined;
  if (
    !home ||
    home.access_mode !== 'writable' ||
    home.archived_at !== null ||
    home.trashed_at !== null
  )
    throw new Error(
      'The project that owns this primer must be active and writable before its file can change.'
    );
}
const account = (input: Context, id: string) =>
  readRegisteredRecordMutationAccount(input.db, [id], input);

function registeredBindings(
  db: Database.Database,
  entityId: string,
  accountId: string | null,
  resolution?: VerifiedRegisteredRecordResolution
) {
  if (resolution) {
    if (resolution.entityId !== entityId || resolution.accountId !== accountId)
      throw new Error('The primer publication belongs to another approved record or account.');
    return readOrgRegistryResolutionPublicationAdmissionInDb(db, resolution).bindings;
  }
  return readOrgRegistryPublicationAdmissionInDb(db, { entityId, accountId })?.bindings ?? [];
}
function workspaceUuid(db: Database.Database, workspaceId: number): string | null {
  const row = db.prepare('SELECT repo_uuid FROM workspaces WHERE id=?').get(workspaceId) as
    | { repo_uuid: string | null }
    | undefined;
  if (!row) throw new Error('The primer owning project is unavailable.');
  return row.repo_uuid;
}

function extensions(value: object, known: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)));
}
function preserveContentExtensions(
  before: PrimerArtifactV1,
  after: PrimerArtifactV1
): PrimerArtifactV1 {
  after.sequence = { ...before.sequence, ...after.sequence };
  after.computed = {
    ...extensions(before.computed, ['tmC', 'gcPercent', 'tmCalculation']),
    ...after.computed,
  };
  if (before.inventory && after.inventory)
    after.inventory = { ...before.inventory, ...after.inventory };
  if (before.oligo && after.oligo) {
    const original = before.oligo;
    after.oligo = {
      ...extensions(original, ['vendor', 'orderType', 'notation', 'modifications']),
      ...after.oligo,
      modifications: after.oligo.modifications.map((next) => {
        const previous = original.modifications.find(
          (item) =>
            item.chemistryId === next.chemistryId &&
            item.vendor === next.vendor &&
            item.vendorCode === next.vendorCode &&
            item.placement === next.placement &&
            isDeepStrictEqual(item.anchor, next.anchor)
        );
        return previous
          ? { ...previous, ...next, anchor: { ...previous.anchor, ...next.anchor } }
          : next;
      }),
    };
  }
  return parsePrimerArtifact(serializePrimerArtifact(after));
}
function revisedState(
  before: PrimerArtifactV1,
  current: LimsEntity,
  status: Primer['status']
): NonNullable<NonNullable<PrimerArtifactV1['entity']>['state']> {
  if (!['designed', 'ordered', 'received', 'verified', 'archived'].includes(status))
    throw new Error('Choose a supported primer status.');
  const priorState = before.entity?.state ?? {
    registrationStatus: current.registrationStatus,
    domainStatus: current.domainStatus,
    archived: current.tombstone,
    archivedAt: current.archivedAt,
    status:
      typeof current.fields.status === 'string' || current.fields.status === null
        ? current.fields.status
        : 'designed',
    source:
      typeof current.fields.source === 'string' || current.fields.source === null
        ? current.fields.source
        : before.metadata.source,
  };
  const archived = status === 'archived';
  return {
    ...priorState,
    status,
    domainStatus: status,
    archived,
    archivedAt: archived ? (priorState.archivedAt ?? Date.now()) : null,
  };
}
async function revisedArtifact(
  before: PrimerArtifactV1,
  current: LimsEntity,
  change: PrimerArtifactRevisionChange
): Promise<PrimerArtifactV1> {
  if (
    current.tombstone &&
    change.type !== 'restore' &&
    change.type !== 'archive' &&
    !(change.type === 'content' && change.content.status !== undefined)
  )
    throw new Error('Restore this primer before editing it.');
  if (change.type === 'content') {
    const { status, ...content } = change.content;
    return preserveContentExtensions(
      before,
      await revisePrimerArtifactContent(before, {
        ...content,
        actor: 'local-user',
        entitySchema: before.entity?.schema,
        entityState:
          status === undefined ? before.entity?.state : revisedState(before, current, status),
      })
    );
  }
  if (change.type === 'bindings_replace_owned') {
    const owned = new Set(change.ownedBindingIds);
    if (
      before.bindings.some(
        (binding) => owned.has(binding.id) && binding.target.documentId !== change.targetDocumentId
      ) ||
      change.bindings.some(
        (binding) => !owned.has(binding.id) || binding.target.documentId !== change.targetDocumentId
      )
    )
      throw new Error('The copied primer attachment belongs to another document.');
    return parsePrimerArtifact(
      serializePrimerArtifact(replaceOwnedPrimerArtifactBindings(before, owned, change.bindings))
    );
  }
  if (change.type === 'binding_add')
    return parsePrimerArtifact(
      serializePrimerArtifact(addPrimerArtifactBinding(before, change.binding))
    );
  if (change.type === 'binding_remove')
    return parsePrimerArtifact(
      serializePrimerArtifact(removePrimerArtifactBinding(before, change.bindingId))
    );
  if (change.type === 'binding_update') {
    const original = before.bindings.find((binding) => binding.id === change.bindingId);
    if (!original) throw new Error('The primer binding is unavailable.');
    const history = change.binding.history
      ? { ...original.history, ...change.binding.history }
      : original.history;
    const replacement = {
      ...extensions(original, [
        'id',
        'relation',
        'target',
        'coordinates',
        'source',
        'history',
        'alignment',
      ]),
      ...change.binding,
      target: { ...original.target, ...change.binding.target },
      coordinates: { ...original.coordinates, ...change.binding.coordinates },
      ...(history ? { history } : {}),
    };
    return parsePrimerArtifact(
      serializePrimerArtifact(updatePrimerArtifactBinding(before, change.bindingId, replacement))
    );
  }
  if (change.type !== 'archive' && change.type !== 'restore')
    throw new Error('Unknown primer revision command.');
  const status = change.type === 'archive' ? 'archived' : change.status;
  return preserveContentExtensions(
    before,
    await revisePrimerArtifactContent(before, {
      name: before.name,
      sequence: before.sequence.bases,
      actor: 'local-user',
      entitySchema: before.entity?.schema,
      entityState: revisedState(before, current, status),
    })
  );
}
function projected(artifact: PrimerArtifactV1) {
  return primerArtifactRegistryProjection(
    artifact,
    {
      mode: 'inline',
      bases: artifact.sequence.bases,
      topology: 'linear',
      length: artifact.sequence.length,
      contentHash: `sha256:${digest(artifact.sequence.bases)}`,
    },
    digest(serializePrimerArtifact(artifact))
  );
}
function assertRevisionIdentity(before: PrimerArtifactV1, after: PrimerArtifactV1): void {
  if (
    before.id !== after.id ||
    before.registry.entityId !== after.registry.entityId ||
    before.registry.kind !== after.registry.kind ||
    before.catalogNumber !== after.catalogNumber ||
    before.file.workspaceRelativePath !== after.file.workspaceRelativePath ||
    !isDeepStrictEqual(before.entity?.schema, after.entity?.schema) ||
    !isDeepStrictEqual(before.registryRelationships, after.registryRelationships) ||
    !isDeepStrictEqual(before.recovery, after.recovery) ||
    after.artifactRevision !== before.artifactRevision + 1
  ) {
    throw new Error(
      'A primer revision cannot change its identity, home, definition or retained relationship authority.'
    );
  }
}

function assertResolutionPrimerIdentity(before: PrimerArtifactV1, after: PrimerArtifactV1): void {
  if (
    before.id !== after.id ||
    before.registry.entityId !== after.registry.entityId ||
    before.registry.kind !== after.registry.kind ||
    before.catalogNumber !== after.catalogNumber ||
    before.file.workspaceRelativePath !== after.file.workspaceRelativePath ||
    !isDeepStrictEqual(before.entity?.schema, after.entity?.schema) ||
    !isDeepStrictEqual(before.registryRelationships, after.registryRelationships) ||
    !isDeepStrictEqual(before.recovery, after.recovery)
  )
    throw new Error(
      'The organization version changes this primer’s saved identity, location, definition or retained relationship authority.'
    );
}

function activePrimerStatus(value: unknown): Exclude<Primer['status'], 'archived'> | null {
  return value === 'designed' || value === 'ordered' || value === 'received' || value === 'verified'
    ? value
    : null;
}

export async function publishPrimerArtifactLifecycle(
  input: Context & { action: 'archive' | 'restore'; request: LimsEntityActionInput }
): Promise<PrimerArtifactRevisionResult> {
  const { request, action } = input;
  if (
    !uuid.test(request.id) ||
    !request.operationId ||
    !uuid.test(request.operationId) ||
    !Number.isSafeInteger(request.expectedEventSeq) ||
    Number(request.expectedEventSeq) < 1
  )
    throw new Error(
      'Refresh this saved primer before changing its archive state; its original action and edit version are required.'
    );
  const operationId = request.operationId;
  const expectedEventSeq = request.expectedEventSeq!;
  const prior = input.runDatabase(() => readIntent(input.db, operationId));
  if (prior) {
    if (prior.result.id !== request.id)
      throw new Error('Primer save operation was reused with a different record.');
    const status = activePrimerStatus(parsePrimerArtifact(prior.afterBytes).entity?.state?.status);
    if (action === 'restore' && !status)
      throw new Error(
        'Primer save operation was reused with a different action; retry its original change.'
      );
    return publishPrimerArtifactRevision({
      ...input,
      request: {
        entityId: request.id,
        operationId,
        expectedEventSeq,
        expectedContentHash: digest(Buffer.from(prior.beforeBytesBase64, 'base64')),
        change: action === 'archive' ? { type: 'archive' } : { type: 'restore', status: status! },
      },
    });
  }
  const accountId = await account(input, request.id);
  const admission = input.runDatabase(() =>
    readOrgRegistryPublicationAdmissionInDb(input.db, { entityId: request.id, accountId })
  );
  if (
    !admission ||
    admission.bindings.some((binding) => binding.authorityKind !== 'primer_artifact')
  )
    throw new Error('This registered record is not owned by a saved primer file.');
  const prepared = await readCheckedPrimerArtifactSnapshot({ ...input, entityId: request.id });
  if ((await account(input, request.id)) !== accountId)
    throw new Error('The active account changed while reviewing the primer archive state.');
  input.runDatabase(() => {
    const current = readOrgRegistryPublicationAdmissionInDb(input.db, {
      entityId: request.id,
      accountId,
    });
    if (
      !current ||
      !isDeepStrictEqual(current, admission) ||
      !isDeepStrictEqual(current.entity, prepared.current) ||
      prepared.current.eventSeq !== expectedEventSeq
    )
      throw new Error('The saved primer changed; review it before changing its archive state.');
  });
  if (prepared.current.tombstone === (action === 'archive'))
    return { entity: prepared.current, artifact: prepared.before, replayed: false, changed: false };
  let change: PrimerArtifactRevisionChange = { type: 'archive' };
  if (action === 'restore') {
    const previous = input.runDatabase(() => {
      if (!verifyLimsAuditHashChainInDb(input.db).ok)
        throw new Error('Registry history integrity check failed; primer Restore was refused.');
      const row = input.db
        .prepare(
          `SELECT operation_id FROM lims_audit WHERE subject_table='lims_entity'
         AND subject_id=? AND event_type=? ORDER BY event_seq DESC LIMIT 1`
        )
        .get(request.id, REQUIRED) as { operation_id: string } | undefined;
      return row ? readIntent(input.db, row.operation_id) : null;
    });
    const previousArtifact = previous
      ? parsePrimerArtifact(Buffer.from(previous.beforeBytesBase64, 'base64').toString('utf8'))
      : null;
    const status = previousArtifact
      ? activePrimerStatus(projected(previousArtifact).fields.status)
      : null;
    if (
      !previous ||
      !previousArtifact ||
      previousArtifact.entity?.state?.archived ||
      !status ||
      !isDeepStrictEqual(previous.result, prepared.current) ||
      !Buffer.from(previous.afterBytes).equals(prepared.beforeBytes)
    )
      throw new Error(
        'The primer’s prior status is unavailable. Open the primer editor and choose its restored status explicitly.'
      );
    change = { type: 'restore', status };
  }
  return publishPrimerArtifactRevision({
    ...input,
    request: {
      entityId: request.id,
      operationId,
      expectedEventSeq,
      expectedContentHash: prepared.sha256,
      change,
    },
  });
}

export async function publishPrimerArtifactRevision(
  input: Context & { request: PrimerArtifactRevisionRequest }
): Promise<PrimerArtifactRevisionResult> {
  const { request } = input;
  if (
    !uuid.test(request.entityId) ||
    !uuid.test(request.operationId) ||
    !Number.isSafeInteger(request.expectedEventSeq) ||
    request.expectedEventSeq < 1 ||
    !/^[a-f0-9]{64}$/.test(request.expectedContentHash)
  )
    throw new Error(
      'Refresh this saved primer before editing; its identity, edit version and saved-byte revision are required.'
    );

  const prior = input.runDatabase(() => readIntent(input.db, request.operationId));
  const requestHash = digest(
    nativeMutationRequestBytes(
      request,
      prior?.requestHashVersion ?? NATIVE_MUTATION_REQUEST_VERSION
    )
  );
  if (prior) {
    if (prior.requestHash !== requestHash || prior.result.id !== request.entityId)
      throw new Error('Primer save operation was reused with a different request.');
    await recoverPrimerArtifactPublications({
      ...input,
      workspaceId: prior.workspaceId,
      onlyOperationId: request.operationId,
    });
    await assertIntentCurrentAccess(input, prior);
    return {
      entity: prior.result,
      artifact: parsePrimerArtifact(prior.afterBytes),
      replayed: true,
      changed: true,
    };
  }
  const accountId = await account(input, request.entityId);
  const admittedBindings = input.runDatabase(() =>
    registeredBindings(input.db, request.entityId, accountId)
  );
  const prepared = await readCheckedPrimerArtifactSnapshot({
    ...input,
    entityId: request.entityId,
  });
  if (
    prepared.current.eventSeq !== request.expectedEventSeq ||
    prepared.sha256 !== request.expectedContentHash
  )
    throw new Error('The saved primer changed; review it before saving.');
  input.runDatabase(() => assertWritableHome(input.db, prepared.owner.workspaceId));
  const change = request.change;
  const duplicate =
    change.type === 'binding_add'
      ? prepared.before.bindings.find((binding) => equivalentBinding(binding, change.binding))
      : undefined;
  const missing =
    change.type === 'binding_remove' &&
    !prepared.before.bindings.some((binding) => binding.id === change.bindingId);
  const unchangedOwned =
    change.type === 'bindings_replace_owned' &&
    prepared.before.bindings.every(
      (binding) =>
        !change.ownedBindingIds.includes(binding.id) ||
        binding.target.documentId === change.targetDocumentId
    ) &&
    change.bindings.every(
      (binding) =>
        change.ownedBindingIds.includes(binding.id) &&
        binding.target.documentId === change.targetDocumentId
    ) &&
    isDeepStrictEqual(
      [
        ...prepared.before.bindings.filter(
          (binding) => !change.ownedBindingIds.includes(binding.id)
        ),
        ...change.bindings,
      ],
      prepared.before.bindings
    );
  if (duplicate || missing || unchangedOwned) {
    if ((await account(input, request.entityId)) !== accountId)
      throw new Error('The active account changed while reviewing this primer binding.');
    input.runDatabase(() => {
      assertWritableHome(input.db, prepared.owner.workspaceId);
      if (
        !isDeepStrictEqual(
          registeredBindings(input.db, request.entityId, accountId),
          admittedBindings
        )
      )
        throw new Error('The primer organization connection changed while reviewing this binding.');
      const current = limsEntityFromRow(getEntityRowById(input.db, request.entityId));
      if (
        !isDeepStrictEqual(current, prepared.current) ||
        !isDeepStrictEqual(readPrimerArtifactAuthority(input.db, current), prepared.owner)
      )
        throw new Error('The primer changed while reviewing this binding.');
    });
    return {
      entity: prepared.current,
      artifact: prepared.before,
      replayed: false,
      changed: false,
      unchangedReason: duplicate
        ? 'duplicate_binding'
        : missing
          ? 'missing_binding'
          : 'unchanged_owned_bindings',
      ...(duplicate ? { bindingId: duplicate.id } : {}),
    };
  }
  const after = await revisedArtifact(prepared.before, prepared.current, request.change);
  assertRevisionIdentity(prepared.before, after);
  if ((await account(input, request.entityId)) !== accountId)
    throw new Error(
      'The active account changed while preparing this primer save. Review it and retry.'
    );
  let afterBytes = serializePrimerArtifact(after);
  const result = input.runDatabase(() =>
    input.db.transaction(() => {
      assertWritableHome(input.db, prepared.owner.workspaceId);
      if (
        !isDeepStrictEqual(
          registeredBindings(input.db, request.entityId, accountId),
          admittedBindings
        )
      )
        throw new Error('The primer organization connection changed while preparing this save.');
      const live = limsEntityFromRow(getEntityRowById(input.db, request.entityId));
      if (
        !isDeepStrictEqual(live, prepared.current) ||
        !isDeepStrictEqual(readPrimerArtifactAuthority(input.db, live), prepared.owner)
      )
        throw new Error('The primer or its owning file changed before the save could commit.');
      let entity = live;
      if (entity.tombstone && !after.entity?.state?.archived)
        entity = restoreLimsEntityInsideTx(input.db, {
          id: entity.id,
          expectedEventSeq: entity.eventSeq ?? undefined,
          actor: 'local-user',
        }).entity;
      if (after.entity?.state?.archived && !entity.tombstone)
        entity = archiveLimsEntityInsideTx(input.db, {
          id: entity.id,
          expectedEventSeq: entity.eventSeq ?? undefined,
          actor: 'local-user',
        });

      if (after.entity?.state) after.entity.state.archivedAt = entity.archivedAt;
      afterBytes = serializePrimerArtifact(after);
      entity = updateLimsEntityInsideTx(input.db, {
        id: entity.id,
        expectedEventSeq: entity.eventSeq ?? undefined,
        name: after.name,
        ...projected(after),
        replaceFields: true,
        actor: 'local-user',
      });
      insertAuditEvent(input.db, {
        eventType: REQUIRED,
        operationId: request.operationId,
        idempotencyKey: intentKey(request.operationId),
        subjectTable: 'lims_entity',
        subjectId: entity.id,
        workspaceId: prepared.owner.workspaceId,
        actor: 'local-user',
        payload: {
          schema: 'dnaforge.primer-artifact-publication.v1',
          ...prepared.owner,
          accountId,
          workspaceUuid: workspaceUuid(input.db, prepared.owner.workspaceId),
          registeredBindings: registeredBindings(input.db, entity.id, accountId),
          requestHash,
          requestHashVersion: NATIVE_MUTATION_REQUEST_VERSION,
          beforeBytesBase64: prepared.beforeBytes.toString('base64'),
          afterBytes,
          result: entity,
        },
      });

      readIntent(input.db, request.operationId);
      input.db
        .prepare(
          'INSERT INTO native_catalog_publication_outbox(operation_id,workspace_id) VALUES(?,?)'
        )
        .run(request.operationId, prepared.owner.workspaceId);
      captureOrgRegistryRecordPublicationInTx(input.db, {
        accountId,
        operationId: request.operationId,
        entity,
        publicationDigest: orgRegistryPrimerPublicationDigest(afterBytes),
        now: Date.now(),
      });
      return entity;
    })()
  );
  await recoverPrimerArtifactPublications({
    ...input,
    workspaceId: prepared.owner.workspaceId,
    onlyOperationId: request.operationId,
  });
  return { entity: result, artifact: after, replayed: false, changed: true };
}

type Intent = NonNullable<ReturnType<typeof readIntent>>;
function verifiedIntentResolution(input: Context, intent: Intent) {
  if (!intent.organizationResolution) return undefined;
  const verified = input.organizationResolution;
  if (
    !verified ||
    !isDeepStrictEqual(registeredRecordResolutionIdentity(verified), intent.organizationResolution)
  )
    throw new Error(
      'Refresh current organization access and Retry the original reviewed primer change.'
    );
  return verified;
}
async function assertIntentCurrentAccess(input: Context, intent: Intent): Promise<void> {
  if ((await account(input, intent.result.id)) !== intent.accountId)
    throw new Error(
      'Sign in with the account that saved this primer before finishing its publication.'
    );
  input.runDatabase(() => {
    assertWritableHome(input.db, intent.workspaceId);
    if (
      workspaceUuid(input.db, intent.workspaceId) !== intent.workspaceUuid ||
      !isDeepStrictEqual(
        registeredBindings(
          input.db,
          intent.result.id,
          intent.accountId,
          verifiedIntentResolution(input, intent)
        ),
        intent.registeredBindings
      )
    )
      throw new Error(
        'The primer project identity or organization connection changed; its saved intent was preserved.'
      );
    const live = limsEntityFromRow(getEntityRowById(input.db, intent.result.id));
    const owner = readPrimerArtifactAuthority(input.db, live);
    if (
      owner.workspaceId !== intent.workspaceId ||
      owner.workspacePath !== intent.workspacePath ||
      owner.relativePath !== intent.relativePath ||
      owner.bindingId !== intent.bindingId ||
      live.schemaRevisionId !== intent.result.schemaRevisionId ||
      live.kind !== intent.result.kind
    )
      throw new Error(
        'The primer owning project, definition or file changed; its saved intent was preserved.'
      );
  });
}
function assertIntentProjectionCurrent(
  db: Database.Database,
  intent: Intent,
  context: Context
): void {
  if (
    workspaceUuid(db, intent.workspaceId) !== intent.workspaceUuid ||
    !isDeepStrictEqual(
      registeredBindings(
        db,
        intent.result.id,
        intent.accountId,
        verifiedIntentResolution(context, intent)
      ),
      intent.registeredBindings
    )
  )
    throw new Error(
      'The primer project identity or organization connection changed; its saved intent was preserved.'
    );
  const live = limsEntityFromRow(getEntityRowById(db, intent.result.id));
  if (!isDeepStrictEqual(live, intent.result))
    throw new Error('Primer changed after its save committed; later data was preserved.');
}
async function readExactPublishedBytes(intent: Intent, operationId: string): Promise<void> {
  const bytes = await readNativeCatalogPublicationBase({
    workspacePath: intent.workspacePath,
    relativePath: intent.relativePath,
    operationId: publicationId(operationId),
  });
  if (!bytes || !bytes.equals(Buffer.from(intent.afterBytes)))
    throw new Error(
      'The primer file changed before publication settled; both the saved file and intent were preserved.'
    );
}

export async function readPendingPrimerArtifactPublication(input: Context & { entityId: string }) {
  const rows = input.runDatabase(() =>
    input.db
      .prepare(
        `SELECT o.operation_id FROM native_catalog_publication_outbox o
    JOIN lims_audit a ON a.operation_id=o.operation_id AND a.event_type=?
    WHERE a.subject_table='lims_entity' AND a.subject_id=? ORDER BY a.event_seq`
      )
      .all(REQUIRED, input.entityId)
  ) as Array<{ operation_id: string }>;
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error('The primer has ambiguous pending publication history.');
  const operationId = rows[0].operation_id;
  const intent = input.runDatabase(() => readIntent(input.db, operationId));
  if (!intent || intent.result.id !== input.entityId)
    throw new Error('The pending primer publication identity is invalid.');
  if (intent.organizationResolution) return null;
  await assertIntentCurrentAccess(input, intent);
  input.runDatabase(() => assertIntentProjectionCurrent(input.db, intent, input));
  return {
    operationId,
    entityId: intent.result.id,
    workspaceId: intent.workspaceId,
    relativePath: intent.relativePath,
    name: intent.result.name,
    artifactRevision: parsePrimerArtifact(intent.afterBytes).artifactRevision,
  };
}

export async function resumePrimerArtifactPublication(
  input: Context & { entityId: string; operationId: string }
): Promise<PrimerArtifactRevisionResult> {
  if (!uuid.test(input.entityId) || !uuid.test(input.operationId))
    throw new Error('A saved primer and its original publication operation are required.');
  const intent = input.runDatabase(() => readIntent(input.db, input.operationId));
  if (!intent || intent.result.id !== input.entityId)
    throw new Error('The saved primer publication is unavailable.');
  await assertIntentCurrentAccess(input, intent);
  await recoverPrimerArtifactPublications({
    ...input,
    workspaceId: intent.workspaceId,
    onlyOperationId: input.operationId,
  });
  await assertIntentCurrentAccess(input, intent);
  return {
    entity: intent.result,
    artifact: parsePrimerArtifact(intent.afterBytes),
    replayed: true,
    changed: true,
  };
}

export async function recoverPrimerArtifactPublications(
  input: Context & { workspaceId: number; onlyOperationId?: string }
): Promise<void> {
  input.runDatabase(() => {
    if (input.db.inTransaction)
      throw new Error('Primer publication cannot join an open database transaction.');
  });
  const rows = input.runDatabase(() =>
    input.db
      .prepare(
        `SELECT o.operation_id FROM native_catalog_publication_outbox o
    JOIN lims_audit a ON a.operation_id=o.operation_id AND a.event_type=?
    WHERE o.workspace_id=? ORDER BY a.event_seq`
      )
      .all(REQUIRED, input.workspaceId)
  ) as Array<{ operation_id: string }>;
  const selected = rows.filter(
    (row) => input.onlyOperationId === undefined || row.operation_id === input.onlyOperationId
  );
  if (selected.length && !input.runDatabase(() => verifyLimsAuditHashChainInDb(input.db).ok))
    throw new Error('Registry history integrity check failed; primer recovery was refused.');
  for (const { operation_id: operationId } of selected) {
    const intent = input.runDatabase(() => readIntent(input.db, operationId));
    if (!intent) throw new Error('Primer publication intent is missing.');

    if (intent.organizationResolution && !input.organizationResolution) {
      if (input.onlyOperationId)
        throw new Error(
          'Refresh current organization access and Retry this reviewed primer change.'
        );
      continue;
    }
    await assertIntentCurrentAccess(input, intent);
    input.runDatabase(() => assertIntentProjectionCurrent(input.db, intent, input));
    await publishNativeCatalogBytes({
      workspacePath: intent.workspacePath,
      relativePath: intent.relativePath,
      operationId: publicationId(operationId),
      beforeBytes: Buffer.from(intent.beforeBytesBase64, 'base64'),
      afterBytes: Buffer.from(intent.afterBytes),
    });
    await readExactPublishedBytes(intent, operationId);
    const artifact = parsePrimerArtifact(intent.afterBytes);
    const bindings = await readPrimerArtifactBindings({
      ...input,
      artifact,
      workspaceId: intent.workspaceId,
      workspacePath: intent.workspacePath,
      operationId,
    });
    const relationshipReference =
      artifact.registryRelationships === undefined
        ? undefined
        : {
            relativePath: intent.relativePath,
            contentHash: digest(intent.afterBytes),
          };
    const projection = primerArtifactLegacyProjection(
      artifact,
      bindings,
      intent.workspaceId,
      relationshipReference
    );
    const relationshipAuthority = await readPrimerRelationshipAuthority(
      projection.input,
      intent.workspacePath
    );
    await assertIntentCurrentAccess(input, intent);
    await readExactPublishedBytes(intent, operationId);
    if ((await account(input, intent.result.id)) !== intent.accountId)
      throw new Error('The active account changed while settling this primer save.');
    input.runDatabase(() =>
      input.db.transaction(() => {
        assertWritableHome(input.db, intent.workspaceId);
        assertIntentProjectionCurrent(input.db, intent, input);
        assertPrimerBindingIdentitiesCurrent(input.db, bindings);
        const catalog = input.db
          .prepare('SELECT metadata FROM catalog_entities WHERE id=?')
          .get(intent.result.id) as { metadata: string | null };
        const metadata: unknown = catalog.metadata ? JSON.parse(catalog.metadata) : {};
        if (!record(metadata)) throw new Error('Primer catalog metadata is invalid.');
        input.db
          .prepare(
            'UPDATE catalog_entities SET name=?,metadata=?,updated_at=? WHERE id=? AND workspace_id=?'
          )
          .run(
            artifact.name,
            JSON.stringify({
              ...metadata,
              schema: artifact.schema,
              schemaVersion: artifact.schemaVersion,
              artifactRevision: artifact.artifactRevision,
              relativePath: intent.relativePath,
              entitySchema: artifact.entity?.schema,
            }),
            Date.now(),
            artifact.id,
            intent.workspaceId
          );
        const owner = readPrimerArtifactAuthority(input.db, intent.result);
        const file = input.db
          .prepare('SELECT path FROM catalog_entity_files WHERE id=?')
          .get(owner.bindingId) as { path: string };
        bindCatalogEntityFileInDb(input.db, {
          entityId: artifact.id,
          path: file.path,
          workspaceRoot: owner.workspacePath,
          fileKind: 'primer-artifact',
          contentHash: `sha256:${digest(serializePrimerArtifact(artifact))}`,
          status: 'current',
        });
        replacePrimerLegacyProjectionInsideTx(input.db, projection.input, relationshipAuthority);
        if (
          !input.db
            .prepare('SELECT 1 FROM lims_audit WHERE idempotency_key=? AND event_type=?')
            .get(completeKey(operationId), COMPLETE)
        )
          insertAuditEvent(input.db, {
            eventType: COMPLETE,
            operationId,
            idempotencyKey: completeKey(operationId),
            subjectTable: 'lims_entity',
            subjectId: artifact.id,
            workspaceId: intent.workspaceId,
            actor: 'artifact-publication',
          });
      })()
    );
    input.runDatabase(() =>
      materializeLimsGitReadableExportInDb(input.db, {
        workspaceId: intent.workspaceId,
        durable: true,
      })
    );
    await readExactPublishedBytes(intent, operationId);
    await assertIntentCurrentAccess(input, intent);

    await pruneCompletedNativeCatalogPublication({
      workspacePath: intent.workspacePath,
      relativePath: intent.relativePath,
      operationId: publicationId(operationId),
    });
    await readExactPublishedBytes(intent, operationId);
    if ((await account(input, intent.result.id)) !== intent.accountId)
      throw new Error('The active account changed before this primer save finished.');
    input.runDatabase(() =>
      input.db.transaction(() => {
        assertWritableHome(input.db, intent.workspaceId);
        assertIntentProjectionCurrent(input.db, intent, input);
        assertPrimerBindingIdentitiesCurrent(input.db, bindings);

        const resolution = verifiedIntentResolution(input, intent);
        if (resolution) {
          settleOrgRegistryRecordResolutionInTx(input.db, {
            accountId: resolution.accountId,
            resolutionId: resolution.resolutionId,
            operationId,
            entity: intent.result,
            publicationDigest: orgRegistryPrimerPublicationDigest(intent.afterBytes),
            verifiedAccessGeneration: resolution.verifiedAccessGeneration,
            now: Date.now(),
          });
        } else {
          captureOrgRegistryRecordPublicationInTx(input.db, {
            accountId: intent.accountId,
            operationId,
            entity: intent.result,
            publicationDigest: orgRegistryPrimerPublicationDigest(intent.afterBytes),
            now: Date.now(),
          });
          markOrgRegistryRecordPublicationReadyInTx(input.db, {
            operationId,
            entityId: artifact.id,
            publicationDigest: orgRegistryPrimerPublicationDigest(intent.afterBytes),
            now: Date.now(),
          });
        }
        input.db
          .prepare('DELETE FROM native_catalog_publication_outbox WHERE operation_id=?')
          .run(operationId);
      })()
    );
  }
}

export { assertEnrolledPrimerPhysicalMutationAllowed } from './primer-artifact-mutation-guard';

function readIntent(db: Database.Database, operationId: string) {
  const row = db
    .prepare('SELECT payload FROM lims_audit WHERE idempotency_key=? AND event_type=?')
    .get(intentKey(operationId), REQUIRED) as { payload: string } | undefined;
  if (!row) return null;
  const value: unknown = JSON.parse(row.payload);
  if (
    !record(value) ||
    value.schema !== 'dnaforge.primer-artifact-publication.v1' ||
    !Number.isSafeInteger(value.workspaceId) ||
    Number(value.workspaceId) < 1 ||
    typeof value.workspacePath !== 'string' ||
    typeof value.bindingId !== 'string' ||
    typeof value.relativePath !== 'string' ||
    !isSafeWorkspaceRelativePath(value.relativePath) ||
    typeof value.beforeBytesBase64 !== 'string' ||
    typeof value.afterBytes !== 'string' ||
    typeof value.requestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.requestHash) ||
    (value.accountId !== null && typeof value.accountId !== 'string') ||
    (value.workspaceUuid !== null && typeof value.workspaceUuid !== 'string') ||
    !Array.isArray(value.registeredBindings) ||
    value.requestHashVersion !== NATIVE_MUTATION_REQUEST_VERSION
  )
    throw new Error('Primer publication intent is invalid.');
  const beforeBytes = Buffer.from(value.beforeBytesBase64, 'base64');
  if (beforeBytes.toString('base64') !== value.beforeBytesBase64)
    throw new Error('Primer publication source bytes are invalid.');
  const before = parsePrimerArtifact(beforeBytes.toString('utf8'));
  const after = parsePrimerArtifact(value.afterBytes);
  const organizationResolution =
    value.organizationResolution === undefined
      ? undefined
      : registeredRecordResolutionIdentity(value.organizationResolution);
  let organizationSnapshot: OrganizationSavedPrimerSnapshot | undefined;
  if (organizationResolution) {
    if (
      organizationResolution.operationId !== operationId ||
      organizationResolution.entityId !== after.id ||
      organizationResolution.accountId !== value.accountId ||
      registeredRecordResolutionRequestHash(organizationResolution, value.requestHashVersion) !==
        value.requestHash
    )
      throw new Error('The retained organization approval does not match this primer publication.');
    if (organizationResolution.choice === 'keep_saved') {
      if (
        value.organizationSnapshot !== undefined ||
        !beforeBytes.equals(Buffer.from(value.afterBytes)) ||
        !isDeepStrictEqual(before, after)
      )
        throw new Error(
          'The retained Keep saved approval does not match these exact primer bytes.'
        );
    } else {
      const approved = db
        .prepare(
          `SELECT review_json FROM org_registry_record_resolutions
        WHERE resolution_id=? AND org_id=? AND account_id=? AND entity_id=?
        AND publication_operation_id=? AND choice='use_remote'`
        )
        .get(
          organizationResolution.resolutionId,
          organizationResolution.orgId,
          organizationResolution.accountId,
          organizationResolution.entityId,
          operationId
        ) as { review_json: string } | undefined;
      if (!approved) throw new Error('The approved organization primer review is unavailable.');
      const review = JSON.parse(approved.review_json) as OrgRegistryRecordReview;
      if (
        !record(value.reviewedSavedOwner) ||
        registeredRecordResolutionSourceRevision(
          review.sourceRevision,
          registeredSpecializedRecordFingerprint(
            'primer_artifact',
            { home: value.reviewedSavedOwner.home, files: value.reviewedSavedOwner.files },
            digest(beforeBytes)
          )
        ) !== organizationResolution.sourceRevision
      )
        throw new Error(
          'The retained organization approval belongs to a different saved primer revision.'
        );
      assertOrganizationSavedPrimerSnapshot(value.organizationSnapshot, review);
      organizationSnapshot = value.organizationSnapshot;
      if (organizationSnapshot.content !== value.afterBytes)
        throw new Error('The retained organization primer bytes changed.');
      assertResolutionPrimerIdentity(before, after);
    }
  } else {
    assertRevisionIdentity(before, after);
  }
  if (
    after.file.workspaceRelativePath !== value.relativePath ||
    !uuid.test(after.id) ||
    (!organizationResolution && serializePrimerArtifact(after) !== value.afterBytes)
  )
    throw new Error('Primer publication bytes do not match their saved identity or locator.');
  const result = parseLimsEntitySnapshot(value.result);
  const projection = projected(after);
  if (
    result.id !== after.id ||
    result.workspaceId !== value.workspaceId ||
    result.kind !== after.registry.kind ||
    result.name !== after.name ||
    result.schemaRevisionId !== after.entity?.schema.schemaRevisionId ||
    !isDeepStrictEqual(result.fields, projection.fields) ||
    result.registrationStatus !== projection.registrationStatus ||
    result.domainStatus !== projection.domainStatus ||
    result.tombstone !== (after.entity?.state?.archived ?? false) ||
    result.archivedAt !== (after.entity?.state?.archivedAt ?? null)
  )
    throw new Error('Primer publication intent and Registry result disagree.');
  return {
    workspaceId: Number(value.workspaceId),
    workspacePath: value.workspacePath,
    relativePath: value.relativePath,
    bindingId: value.bindingId,
    accountId: value.accountId,
    workspaceUuid: value.workspaceUuid,
    registeredBindings: value.registeredBindings,
    beforeBytesBase64: value.beforeBytesBase64,
    afterBytes: value.afterBytes,
    requestHash: value.requestHash,
    requestHashVersion: value.requestHashVersion,
    ...(organizationResolution ? { organizationResolution } : {}),
    ...(organizationSnapshot ? { organizationSnapshot } : {}),
    result,
  };
}

export async function publishReviewedPrimerArtifactResolution(
  input: Context & {
    request: RegisteredRecordResolutionRequest;
    verifiedAccessGeneration: string;
    organizationSnapshot?: OrganizationSavedPrimerSnapshot;
  }
): Promise<RegisteredRecordResolutionPublicationResult> {
  const identity = registeredRecordResolutionIdentity(input.request);
  const verified = { ...identity, verifiedAccessGeneration: input.verifiedAccessGeneration };
  const resumed = await resumeReviewedPrimerArtifactResolution({ ...input, ...verified });
  if (resumed) return resumed;
  const assertAccount = async () => {
    if ((await account(input, identity.entityId)) !== identity.accountId)
      throw new Error('Sign in with the account that registered this primer before resolving it.');
  };
  await assertAccount();
  input.runDatabase(() => assertRegisteredRecordResolutionAccessInDb(input.db, verified));
  const checked = await readCheckedOrganizationRecordReview(
    input.db,
    identity,
    assertAccount,
    input.runDatabase
  );
  const prepared = checked.primer;
  if (!prepared || checked.review.binding.authority !== 'primer_artifact')
    throw new Error('This review does not belong to a saved primer.');
  if (
    checked.displayed.sourceRevision !== identity.sourceRevision ||
    !isDeepStrictEqual(checked.review, input.request.review)
  )
    throw Object.assign(
      new Error(
        'The saved primer or organization review changed. Review the current versions again.'
      ),
      { code: 'REVIEW_CHANGED' }
    );
  let organizationSnapshot: OrganizationSavedPrimerSnapshot | undefined;
  if (identity.choice === 'use_remote') {
    if (!input.organizationSnapshot)
      throw Object.assign(
        new Error(
          'The exact saved primer for this organization version is unavailable. Its Registry fields cannot replace the saved document.'
        ),
        { code: 'SAVED_VERSION_UNAVAILABLE' }
      );
    assertOrganizationSavedPrimerSnapshot(input.organizationSnapshot, checked.review);
    organizationSnapshot = input.organizationSnapshot;
    assertResolutionPrimerIdentity(
      prepared.before,
      parsePrimerArtifact(organizationSnapshot.content)
    );
  }
  const admittedBindings = input.runDatabase(() =>
    registeredBindings(input.db, identity.entityId, identity.accountId)
  );
  const before = await readNativeCatalogPublicationBase({
    workspacePath: prepared.owner.workspacePath,
    relativePath: prepared.owner.relativePath,
    operationId: publicationId(identity.operationId),
  });
  if (!before?.equals(prepared.beforeBytes))
    throw Object.assign(
      new Error('The saved primer changed. Review its exact current bytes again.'),
      { code: 'REVIEW_CHANGED' }
    );
  await assertAccount();
  const afterBytes = organizationSnapshot?.content ?? prepared.beforeBytes.toString('utf8');
  const after = parsePrimerArtifact(afterBytes);
  const result = input.runDatabase(() =>
    input.db.transaction(() => {
      const live = limsEntityFromRow(getEntityRowById(input.db, identity.entityId));
      assertWritableHome(input.db, prepared.owner.workspaceId);
      assertRegisteredRecordResolutionAccessInDb(input.db, verified);
      if (
        !isDeepStrictEqual(live, prepared.current) ||
        !isDeepStrictEqual(readPrimerArtifactAuthority(input.db, live), prepared.owner) ||
        !isDeepStrictEqual(
          registeredBindings(input.db, live.id, identity.accountId),
          admittedBindings
        )
      )
        throw Object.assign(new Error('The primer owner or saved edit changed. Review it again.'), {
          code: 'REVIEW_CHANGED',
        });
      prepareOrgRegistryRecordResolutionInTx(input.db, {
        ...identity,
        review: input.request.review,
        publicationOperationId: identity.operationId,
        now: Date.now(),
      });
      let entity = live;
      if (organizationSnapshot) {
        entity = applySavedLimsEntityLifecycleInsideTx(
          input.db,
          {
            id: live.id,
            expectedEventSeq: live.eventSeq ?? undefined,
            actor: 'local-user',
          },
          {
            archived: after.entity?.state?.archived ?? false,
            archivedAt: after.entity?.state?.archivedAt ?? null,
          }
        );
      }
      entity = updateLimsEntityInsideTx(input.db, {
        id: entity.id,
        expectedEventSeq: entity.eventSeq ?? undefined,
        name: after.name,
        ...projected(after),
        replaceFields: true,
        actor: 'local-user',
        batchId: identity.operationId,
      });
      insertAuditEvent(input.db, {
        eventType: REQUIRED,
        operationId: identity.operationId,
        idempotencyKey: intentKey(identity.operationId),
        subjectTable: 'lims_entity',
        subjectId: live.id,
        workspaceId: prepared.owner.workspaceId,
        actor: 'local-user',
        payload: {
          schema: 'dnaforge.primer-artifact-publication.v1',
          ...prepared.owner,
          accountId: identity.accountId,
          workspaceUuid: workspaceUuid(input.db, prepared.owner.workspaceId),
          registeredBindings: admittedBindings,
          requestHash: registeredRecordResolutionRequestHash(identity),
          requestHashVersion: NATIVE_MUTATION_REQUEST_VERSION,
          beforeBytesBase64: prepared.beforeBytes.toString('base64'),
          afterBytes,
          organizationResolution: identity,
          ...(organizationSnapshot
            ? { organizationSnapshot, reviewedSavedOwner: checked.savedOwnerIdentity }
            : {}),
          result: entity,
        },
      });
      readIntent(input.db, identity.operationId);
      input.db
        .prepare(
          'INSERT INTO native_catalog_publication_outbox(operation_id,workspace_id) VALUES(?,?)'
        )
        .run(identity.operationId, prepared.owner.workspaceId);
      captureOrgRegistryRecordResolutionPublicationInTx(input.db, {
        accountId: identity.accountId,
        resolutionId: identity.resolutionId,
        operationId: identity.operationId,
        entity,
        publicationDigest: orgRegistryPrimerPublicationDigest(afterBytes),
        now: Date.now(),
      });
      return entity;
    })()
  );
  await recoverPrimerArtifactPublications({
    ...input,
    organizationResolution: verified,
    workspaceId: prepared.owner.workspaceId,
    onlyOperationId: identity.operationId,
  });
  return { entity: result, replayed: false };
}

export async function resumeReviewedPrimerArtifactResolution(
  input: Context & VerifiedRegisteredRecordResolution
): Promise<RegisteredRecordResolutionPublicationResult | null> {
  const identity = registeredRecordResolutionIdentity(input);
  const intent = input.runDatabase(() => readIntent(input.db, identity.operationId));
  if (!intent) return null;
  if (
    !intent.organizationResolution ||
    !isDeepStrictEqual(intent.organizationResolution, identity) ||
    intent.requestHash !==
      registeredRecordResolutionRequestHash(identity, intent.requestHashVersion)
  )
    throw new Error(
      'The primer resolution identity was reused for another choice or saved version.'
    );
  const context = { ...input, organizationResolution: input };
  await assertIntentCurrentAccess(context, intent);
  await recoverPrimerArtifactPublications({
    ...context,
    workspaceId: intent.workspaceId,
    onlyOperationId: identity.operationId,
  });
  await assertIntentCurrentAccess(context, intent);
  input.runDatabase(() => {
    const resolution = input.db
      .prepare('SELECT status FROM org_registry_record_resolutions WHERE resolution_id=?')
      .get(identity.resolutionId) as { status: string } | undefined;
    if (resolution?.status !== 'settled')
      throw new Error('The approved primer publication is still pending.');
  });
  return { entity: intent.result, replayed: true };
}

export function readReviewedPrimerArtifactResolutionIdentity(
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
  const review = readOrgRegistryRecordResolutionRetryReview(db, {
    ...input,
    expectedAccessGeneration: input.verifiedAccessGeneration,
  });
  if (!review || review.binding.authority !== 'primer_artifact')
    throw new Error('The pending primer is outside the current organization scope.');
  const pending = db
    .prepare('SELECT 1 FROM native_catalog_publication_outbox WHERE operation_id=?')
    .get(input.operationId);
  if (!pending) return null;
  const intent = readIntent(db, input.operationId);
  const identity = intent?.organizationResolution;
  if (
    !identity ||
    identity.accountId !== input.accountId ||
    identity.orgId !== input.orgId ||
    identity.entityId !== input.entityId ||
    identity.resolutionId !== input.resolutionId ||
    identity.operationId !== input.operationId
  )
    throw new Error('The pending primer approval does not match this record.');
  return identity;
}
