import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { limsEntityFromRow, type LimsEntity, type LimsEntityRow } from '../shared/lims';
import { isEntityRecordArtifactProjection } from '../shared/registry-file-types';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import { PRIMER_ARTIFACT_SCHEMA } from '../shared/primer-artifact-schema';
import { isSequencePackageFileKind } from '../db/sequence-package-contract';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';
import { semanticManagedSequenceProjectionFields } from '../shared/managed-sequence-registry-projection';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import type {
  PreparedOrganizationRegistryClaim,
  OrganizationRegistryRecordSyncStatus,
} from '../shared/org-registry-sync';
import type {
  OrgRegistryMutationRow,
  OrgRegistryRemoteMutationReceipt,
} from './org-registry-sync-types';

export type OrgRegistryPublicationDigest = {
  authority: 'entity_artifact' | 'database' | 'primer_artifact' | 'sequence_package';
  sha256: string;
};

export function orgRegistryRecordPublicationAuthority(
  db: Database.Database,
  entity: LimsEntity
): OrgRegistryPublicationDigest['authority'] {
  if (isEntityRecordArtifactProjection(entity.fields)) return 'entity_artifact';

  const artifact = entity.fields.artifact;
  const isPrimer =
    artifact &&
    typeof artifact === 'object' &&
    !Array.isArray(artifact) &&
    'schema' in artifact &&
    artifact.schema === PRIMER_ARTIFACT_SCHEMA;
  const managed = readManagedSequenceDocumentRef(entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]);
  if (isWorkspaceSyncRemoteUuid(entity.id) && (isPrimer || managed?.packageId === entity.id)) {
    const owners = db
      .prepare(
        `SELECT f.workspace_id AS fileWorkspaceId, f.file_kind AS fileKind,
      c.workspace_id AS catalogWorkspaceId, c.type AS catalogType, c.storage_type AS storageType
      FROM catalog_entity_files f JOIN catalog_entities c ON c.id=f.entity_id
      WHERE f.entity_id=? AND f.status='current'`
      )
      .all(entity.id) as Array<{
      fileWorkspaceId: number;
      fileKind: string;
      catalogWorkspaceId: number | null;
      catalogType: string;
      storageType: string;
    }>;
    const owner = owners[0];
    if (
      owners.length === 1 &&
      owner &&
      entity.workspaceId !== null &&
      owner.fileWorkspaceId === entity.workspaceId &&
      owner.catalogWorkspaceId === entity.workspaceId &&
      owner.storageType === 'file'
    ) {
      if (
        isPrimer &&
        !managed &&
        owner.catalogType === 'primer' &&
        owner.fileKind === 'primer-artifact'
      )
        return 'primer_artifact';
      if (
        !artifact &&
        managed?.packageId === entity.id &&
        (owner.catalogType === 'sequence' || owner.catalogType === 'construct') &&
        isSequencePackageFileKind(owner.fileKind)
      )
        return 'sequence_package';
    }
  }
  const sequence = entity.fields.sequence;
  if (
    entity.fields.artifact != null ||
    entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD] != null ||
    (sequence && typeof sequence === 'object' && 'mode' in sequence && sequence.mode === 'file') ||
    entity.fields.packagePath != null ||
    entity.kind === 'notebook' ||
    entity.kind === 'track-view' ||
    db
      .prepare('SELECT 1 FROM catalog_workspace_placements WHERE entity_id=? LIMIT 1')
      .get(entity.id) ||
    db
      .prepare("SELECT 1 FROM catalog_entity_files WHERE entity_id=? AND status='current' LIMIT 1")
      .get(entity.id)
  ) {
    throw new Error(
      'This saved document type cannot yet stay synchronized with the organization Registry.'
    );
  }
  return 'database';
}

export function orgRegistryPublicationFields(
  entity: LimsEntity,
  authority: OrgRegistryPublicationDigest['authority']
): Record<string, unknown> {
  return authority === 'sequence_package'
    ? semanticManagedSequenceProjectionFields(entity.fields)
    : entity.fields;
}

export function orgRegistryPrimerPublicationDigest(
  bytes: string | Buffer
): OrgRegistryPublicationDigest {
  return { authority: 'primer_artifact', sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function orgRegistrySequencePackagePublicationDigest(input: {
  packageId: string;
  formatVersion: number;
  markerSha256: string;
  productSha256: string;
}): OrgRegistryPublicationDigest {
  if (
    !input.packageId ||
    !Number.isSafeInteger(input.formatVersion) ||
    input.formatVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(input.markerSha256) ||
    !/^[a-f0-9]{64}$/.test(input.productSha256)
  )
    throw new Error('A managed sequence publication requires its exact checked file pair.');
  return {
    authority: 'sequence_package',
    sha256: createHash('sha256')
      .update(
        canonicalNativeMutationRequest({
          authority: 'sequence_package',
          digestVersion: 1,
          packageId: input.packageId,
          formatVersion: input.formatVersion,
          markerSha256: input.markerSha256,
          productSha256: input.productSha256,
        })
      )
      .digest('hex'),
  };
}

export function orgRegistryDatabasePublicationDigest(
  entity: LimsEntity
): OrgRegistryPublicationDigest {
  return {
    authority: 'database',
    sha256: createHash('sha256').update(canonicalNativeMutationRequest(entity)).digest('hex'),
  };
}

type Scope = { accountId: string; orgId: string };
type Binding = {
  org_id: string;
  account_id: string;
  entity_id: string;
  client_id: string;
  workspace_id: number;
  workspace_uuid: string;
  home_workspace_id: string;
  kind: string;
  local_schema_revision_id: string;
  authority_kind: OrgRegistryPublicationDigest['authority'];
  schema_id: string;
  schema_revision_id: string;
  claim_mutation_id: string;
  claim_source_revision: string;
  claim_local_event_seq: number;
  acknowledged_mutation_id: string | null;
  acknowledged_local_event_seq: number | null;
  reviewed_resolution_id: string | null;
};
type Publication = {
  mutation_id: string;
  operation_id: string;
  lifecycle_mutation_id: string;
  phase: 'first' | 'lifecycle';
  org_id: string;
  account_id: string;
  entity_id: string;
  local_event_seq: number;
  publication_authority: OrgRegistryPublicationDigest['authority'];
  publication_sha256: string;
  payload_json: string;
  status: 'publication_pending' | 'ready' | 'queued' | 'acknowledged' | 'failed';
  error_message: string | null;
};

function bindingFor(
  db: Database.Database,
  input: Scope & { entityId: string }
): Binding | undefined {
  return db
    .prepare(
      `SELECT * FROM org_registry_local_records
    WHERE org_id=? AND account_id=? AND entity_id=?`
    )
    .get(input.orgId, input.accountId, input.entityId) as Binding | undefined;
}

function assertHome(
  db: Database.Database,
  binding: Binding,
  allowReadOnlyRole = false
): LimsEntity {
  const row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(binding.entity_id) as
    | LimsEntityRow
    | undefined;
  const home = db
    .prepare(
      `SELECT w.repo_uuid,w.archived_at,w.trashed_at,w.access_mode,
    b.workspace_uuid,b.owner_account_id,b.owner_org_id,b.remote_workspace_id,b.access_role,b.detached_reason
    FROM workspaces w LEFT JOIN workspace_sync_bindings b ON b.workspace_id=w.id
    WHERE w.id=?`
    )
    .get(binding.workspace_id) as Record<string, unknown> | undefined;
  if (
    !row ||
    !home ||
    row.workspace_id !== binding.workspace_id ||
    row.kind !== binding.kind ||
    row.schema_revision_id !== binding.local_schema_revision_id ||
    home.repo_uuid !== binding.workspace_uuid ||
    home.workspace_uuid !== binding.workspace_uuid ||
    home.owner_account_id !== binding.account_id ||
    home.owner_org_id !== binding.org_id ||
    home.remote_workspace_id !== binding.home_workspace_id ||
    home.archived_at != null ||
    home.trashed_at != null ||
    home.access_mode === 'reference' ||
    (!allowReadOnlyRole && home.access_role === 'viewer') ||
    home.detached_reason
  ) {
    throw new Error(
      'The registered record’s home, definition or write access changed. Review its organization connection before saving.'
    );
  }
  const entity = limsEntityFromRow(row);
  if (orgRegistryRecordPublicationAuthority(db, entity) !== binding.authority_kind)
    throw new Error(
      'The registered record’s saved authority changed. Review its organization connection before saving.'
    );
  return entity;
}

export function enrollOrgRegistryRecordInTx(
  db: Database.Database,
  input: Scope & {
    clientId: string;
    mutationId: string;
    claim: PreparedOrganizationRegistryClaim;
    now: number;
  }
): void {
  const { claim } = input;
  const existing = bindingFor(db, { ...input, entityId: claim.sourceEntityId });
  if (existing) {
    if (
      existing.claim_mutation_id !== input.mutationId ||
      existing.claim_source_revision !== claim.sourceRevision
    )
      throw new Error('This record already has a reviewed organization connection.');
    assertHome(db, existing);
    return;
  }
  const row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(claim.sourceEntityId) as
    | LimsEntityRow
    | undefined;
  if (
    !row ||
    row.workspace_id === null ||
    !Number.isSafeInteger(row.event_seq) ||
    Number(row.event_seq) < 1
  )
    throw new Error('The saved record’s edit version or home is unavailable.');
  const payload = claim.payload;
  if (
    payload.id !== row.id ||
    payload.homeWorkspaceId !== claim.homeWorkspaceId ||
    typeof payload.schemaId !== 'string' ||
    typeof payload.schemaRevisionId !== 'string'
  )
    throw new Error('The organization connection does not match the reviewed claim.');
  const binding: Binding = {
    org_id: input.orgId,
    account_id: input.accountId,
    entity_id: row.id,
    client_id: input.clientId,
    workspace_id: row.workspace_id,
    workspace_uuid: claim.homeProjectUuid,
    home_workspace_id: claim.homeWorkspaceId,
    kind: row.kind,
    local_schema_revision_id: row.schema_revision_id,
    authority_kind: orgRegistryRecordPublicationAuthority(db, limsEntityFromRow(row)),
    schema_id: payload.schemaId,
    schema_revision_id: payload.schemaRevisionId,
    claim_mutation_id: input.mutationId,
    claim_source_revision: claim.sourceRevision,
    claim_local_event_seq: row.event_seq!,
    acknowledged_mutation_id: null,
    acknowledged_local_event_seq: null,
    reviewed_resolution_id: null,
  };
  assertHome(db, binding);
  db.prepare(
    `INSERT INTO org_registry_local_records
    (org_id,account_id,entity_id,client_id,workspace_id,workspace_uuid,home_workspace_id,kind,
     local_schema_revision_id,authority_kind,schema_id,schema_revision_id,claim_mutation_id,claim_source_revision,
     claim_local_event_seq,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    binding.org_id,
    binding.account_id,
    binding.entity_id,
    binding.client_id,
    binding.workspace_id,
    binding.workspace_uuid,
    binding.home_workspace_id,
    binding.kind,
    binding.local_schema_revision_id,
    binding.authority_kind,
    binding.schema_id,
    binding.schema_revision_id,
    binding.claim_mutation_id,
    binding.claim_source_revision,
    binding.claim_local_event_seq,
    input.now,
    input.now
  );

  const acknowledged = db
    .prepare(
      `SELECT response_json FROM org_registry_mutation_receipts
    WHERE mutation_id=? AND org_id=? AND account_id=? AND client_id=? AND operation='entity.create'`
    )
    .get(input.mutationId, input.orgId, input.accountId, input.clientId) as
    | { response_json: string }
    | undefined;
  if (acknowledged)
    acknowledgeOrgRegistryRecordMutationInTx(db, {
      ...input,
      operation: 'entity.create',
      payload: claim.payload,
      receipt: JSON.parse(acknowledged.response_json) as OrgRegistryRemoteMutationReceipt,
    });
}

export function assertOrgRegistryRecordMutationAccount(
  db: Database.Database,
  input: { entityId: string; accountId: string | null }
): void {
  const owners = db
    .prepare('SELECT account_id FROM org_registry_local_records WHERE entity_id=?')
    .all(input.entityId) as Array<{ account_id: string }>;
  if (
    owners.length &&
    (!input.accountId || !owners.some((row) => row.account_id === input.accountId))
  )
    throw new Error(
      'Sign in with the account that registered this record before saving organization changes.'
    );
}

export type OrgRegistryPublicationBinding = {
  orgId: string;
  accountId: string;
  entityId: string;
  clientId: string;
  workspaceId: number;
  workspaceUuid: string;
  homeWorkspaceId: string;
  kind: string;
  localSchemaRevisionId: string;
  authorityKind: OrgRegistryPublicationDigest['authority'];
  schemaId: string;
  schemaRevisionId: string;
  claimMutationId: string;
  claimSourceRevision: string;
  claimLocalEventSeq: number;
};
export type OrgRegistryPublicationAdmission = {
  entity: LimsEntity;
  bindings: readonly OrgRegistryPublicationBinding[];
};

export function readOrgRegistryPublicationAdmissionInDb(
  db: Database.Database,
  input: { entityId: string; accountId: string | null }
): OrgRegistryPublicationAdmission | null {
  return readPublicationAdmission(db, input);
}

export function readOrgRegistryResolutionPublicationAdmissionInDb(
  db: Database.Database,
  input: {
    accountId: string;
    orgId: string;
    entityId: string;
    resolutionId: string;
    operationId: string;
    choice: 'use_remote' | 'keep_saved';
    verifiedAccessGeneration: string;
  }
): OrgRegistryPublicationAdmission {
  const row = db
    .prepare('SELECT * FROM org_registry_record_resolutions WHERE resolution_id=?')
    .get(input.resolutionId) as Resolution | undefined;
  if (
    !row ||
    row.account_id !== input.accountId ||
    row.org_id !== input.orgId ||
    row.entity_id !== input.entityId ||
    row.publication_operation_id !== input.operationId ||
    row.choice !== input.choice
  )
    throw new Error('The saved publication does not match its durable organization approval.');
  requireResolutionBinding(
    db,
    input,
    requireVerifiedAccessGeneration(input.verifiedAccessGeneration)
  );
  const admitted = readPublicationAdmission(db, input, row.resolution_id);
  if (!admitted) throw new Error('The approved publication has no registered owner.');
  return admitted;
}

function readPublicationAdmission(
  db: Database.Database,
  input: { entityId: string; accountId: string | null },
  approvedResolutionId?: string
): OrgRegistryPublicationAdmission | null {
  assertOrgRegistryRecordMutationAccount(db, input);
  const bindings = db
    .prepare(
      'SELECT * FROM org_registry_local_records WHERE entity_id=? AND account_id=? ORDER BY org_id,account_id'
    )
    .all(input.entityId, input.accountId) as Binding[];
  if (!bindings.length) return null;
  let entity: LimsEntity | undefined;
  const scopes = bindings.map((binding): OrgRegistryPublicationBinding => {
    const pending = pendingResolution(db, binding);
    if (pending && pending.resolution_id !== approvedResolutionId)
      throw new Error('Finish the reviewed organization change before saving another edit.');
    const current = assertHome(db, binding);
    if (entity && !isDeepStrictEqual(entity, current))
      throw new Error('The registered record changed during publication admission.');
    entity = current;
    return {
      orgId: binding.org_id,
      accountId: binding.account_id,
      entityId: binding.entity_id,
      clientId: binding.client_id,
      workspaceId: binding.workspace_id,
      workspaceUuid: binding.workspace_uuid,
      homeWorkspaceId: binding.home_workspace_id,
      kind: binding.kind,
      localSchemaRevisionId: binding.local_schema_revision_id,
      authorityKind: binding.authority_kind,
      schemaId: binding.schema_id,
      schemaRevisionId: binding.schema_revision_id,
      claimMutationId: binding.claim_mutation_id,
      claimSourceRevision: binding.claim_source_revision,
      claimLocalEventSeq: binding.claim_local_event_seq,
    };
  });
  return { entity: entity!, bindings: scopes };
}

function representedLocalEventSeq(db: Database.Database, binding: Binding): number {
  const acknowledged = binding.acknowledged_local_event_seq ?? binding.claim_local_event_seq;
  if (!binding.reviewed_resolution_id) return acknowledged;
  const reviewed = db
    .prepare(
      `SELECT choice,published_local_event_seq FROM org_registry_record_resolutions
    WHERE resolution_id=? AND org_id=? AND account_id=? AND entity_id=? AND status='settled'`
    )
    .get(binding.reviewed_resolution_id, binding.org_id, binding.account_id, binding.entity_id) as
    | { choice: Resolution['choice']; published_local_event_seq: number | null }
    | undefined;
  if (
    !reviewed ||
    !Number.isSafeInteger(reviewed.published_local_event_seq) ||
    Number(reviewed.published_local_event_seq) < 1
  )
    throw new Error('The explicitly reviewed local publication is unavailable.');

  return reviewed.choice === 'use_remote'
    ? Math.max(acknowledged, reviewed.published_local_event_seq!)
    : acknowledged;
}

export function captureOrgRegistryRecordPublicationInTx(
  db: Database.Database,
  input: {
    accountId: string | null;
    operationId: string;
    entity: LimsEntity;
    publicationDigest: OrgRegistryPublicationDigest;
    now: number;
  }
): void {
  assertOrgRegistryRecordMutationAccount(db, {
    entityId: input.entity.id,
    accountId: input.accountId,
  });
  const bindings = db
    .prepare('SELECT * FROM org_registry_local_records WHERE entity_id=? AND account_id=?')
    .all(input.entity.id, input.accountId) as Binding[];
  if (!bindings.length) return;
  if (
    !/^[a-f0-9]{64}$/.test(input.publicationDigest.sha256) ||
    !Number.isSafeInteger(input.entity.eventSeq) ||
    Number(input.entity.eventSeq) < 1
  )
    throw new Error('A registered edit requires its exact saved bytes and local edit version.');
  for (const binding of bindings) {
    if (pendingResolution(db, binding))
      throw new Error('Finish the reviewed organization change before saving another edit.');
    const current = assertHome(db, binding);
    if (
      binding.authority_kind !== input.publicationDigest.authority ||
      (binding.authority_kind === 'database' &&
        orgRegistryDatabasePublicationDigest(current).sha256 !== input.publicationDigest.sha256)
    )
      throw new Error(
        'The publication digest does not match the registered record’s checked authority.'
      );
    if (!isDeepStrictEqual(current, input.entity))
      throw new Error('The registered record changed during its save.');
    const payload = {
      id: input.entity.id,
      name: input.entity.name,
      fields: orgRegistryPublicationFields(input.entity, binding.authority_kind),
      registrationStatus: input.entity.registrationStatus,
      domainStatus: input.entity.domainStatus,
      archived: input.entity.tombstone,
    };
    const existing = db
      .prepare(
        `SELECT * FROM org_registry_record_publications
      WHERE org_id=? AND account_id=? AND entity_id=? AND operation_id=?`
      )
      .get(binding.org_id, binding.account_id, binding.entity_id, input.operationId) as
      | Publication
      | undefined;
    if (existing) {
      if (
        existing.local_event_seq !== input.entity.eventSeq ||
        existing.publication_authority !== input.publicationDigest.authority ||
        existing.publication_sha256 !== input.publicationDigest.sha256 ||
        !isDeepStrictEqual(JSON.parse(existing.payload_json), payload)
      )
        throw new Error('A registered save operation was reused for different content.');
      continue;
    }
    if (input.entity.eventSeq! <= representedLocalEventSeq(db, binding)) continue;
    const sameVersion = db
      .prepare(
        `SELECT payload_json FROM org_registry_record_publications
      WHERE org_id=? AND account_id=? AND entity_id=? AND local_event_seq=?
        AND NOT EXISTS(SELECT 1 FROM org_registry_record_publication_supersessions s WHERE s.mutation_id=org_registry_record_publications.mutation_id)`
      )
      .get(binding.org_id, binding.account_id, binding.entity_id, input.entity.eventSeq) as
      | { payload_json: string }
      | undefined;
    if (sameVersion) {
      if (!isDeepStrictEqual(JSON.parse(sameVersion.payload_json), payload))
        throw new Error('A local edit version was reused for different registered content.');
      continue;
    }
    db.prepare(
      `INSERT INTO org_registry_record_publications
      (mutation_id,lifecycle_mutation_id,phase,operation_id,org_id,account_id,entity_id,local_event_seq,publication_authority,publication_sha256,payload_json,status,created_at,updated_at)
      VALUES(?,?,'first',?,?,?,?,?,?,?,?,'publication_pending',?,?)`
    ).run(
      randomUUID(),
      randomUUID(),
      input.operationId,
      binding.org_id,
      binding.account_id,
      binding.entity_id,
      input.entity.eventSeq,
      input.publicationDigest.authority,
      input.publicationDigest.sha256,
      JSON.stringify(payload),
      input.now,
      input.now
    );
  }
}

export function markOrgRegistryRecordPublicationReadyInTx(
  db: Database.Database,
  input: {
    operationId: string;
    entityId: string;
    publicationDigest: OrgRegistryPublicationDigest;
    now: number;
  }
): void {
  const rows = db
    .prepare('SELECT * FROM org_registry_record_publications WHERE operation_id=?')
    .all(input.operationId) as Publication[];
  for (const row of rows) {
    if (
      row.entity_id !== input.entityId ||
      row.publication_authority !== input.publicationDigest.authority ||
      row.publication_sha256 !== input.publicationDigest.sha256
    )
      throw new Error('Published bytes do not match the queued organization edit.');
    db.prepare(
      `UPDATE org_registry_record_publications SET status='ready',updated_at=?
      WHERE mutation_id=? AND status='publication_pending'`
    ).run(input.now, row.mutation_id);
  }
}

function checkedCanonicalEntity(
  binding: Binding,
  entity: Record<string, unknown> | undefined
): Record<string, unknown> & { revision: number } {
  if (
    !entity ||
    entity.id !== binding.entity_id ||
    entity.orgId !== binding.org_id ||
    entity.homeWorkspaceId !== binding.home_workspace_id ||
    entity.kind !== binding.kind ||
    entity.schemaId !== binding.schema_id ||
    entity.schemaRevisionId !== binding.schema_revision_id ||
    !Number.isSafeInteger(entity.revision) ||
    Number(entity.revision) < 1
  )
    throw new Error(
      'The organization record does not match the registered identity, home, definition or revision.'
    );
  return entity as Record<string, unknown> & { revision: number };
}

function checkedCanonical(
  binding: Binding,
  receipt: OrgRegistryRemoteMutationReceipt
): Record<string, unknown> & { revision: number } {
  if (
    receipt.entityId !== binding.entity_id ||
    receipt.homeWorkspaceId !== binding.home_workspace_id
  )
    throw new Error(
      'The organization receipt does not match the registered record’s identity or home.'
    );
  return checkedCanonicalEntity(binding, receipt.entity);
}

export function acknowledgeOrgRegistryRecordMutationInTx(
  db: Database.Database,
  input: Scope & {
    clientId: string;
    mutationId: string;
    operation: string;
    payload: Record<string, unknown>;
    receipt: OrgRegistryRemoteMutationReceipt;
    now: number;
  }
): void {
  const publication = db
    .prepare(
      'SELECT * FROM org_registry_record_publications WHERE mutation_id=? OR lifecycle_mutation_id=?'
    )
    .get(input.mutationId, input.mutationId) as Publication | undefined;
  const binding = publication
    ? bindingFor(db, { ...input, entityId: publication.entity_id })
    : (db
        .prepare('SELECT * FROM org_registry_local_records WHERE claim_mutation_id=?')
        .get(input.mutationId) as Binding | undefined);
  if (!binding) return;
  if (
    binding.account_id !== input.accountId ||
    binding.org_id !== input.orgId ||
    binding.client_id !== input.clientId ||
    input.receipt.mutationId !== input.mutationId ||
    (publication
      ? !['entity.update', 'entity.archive', 'entity.restore'].includes(input.operation) ||
        publication.status !== 'queued' ||
        input.mutationId !==
          (publication.phase === 'first'
            ? publication.mutation_id
            : publication.lifecycle_mutation_id)
      : input.operation !== 'entity.create')
  )
    throw new Error('The organization acknowledgement belongs to a different saved operation.');
  const entity = checkedCanonical(binding, input.receipt);
  const expectedRevision = publication ? Number(input.payload.expectedRevision) + 1 : 1;
  const desired = publication
    ? (JSON.parse(publication.payload_json) as Record<string, unknown>)
    : input.payload;
  if (
    !Number.isSafeInteger(expectedRevision) ||
    entity.revision !== expectedRevision ||
    entity.name !== desired.name ||
    !isDeepStrictEqual(entity.fields, desired.fields) ||
    entity.registrationStatus !== desired.registrationStatus ||
    entity.domainStatus !== desired.domainStatus
  )
    throw new Error('The organization acknowledgement does not contain the saved edit.');
  const needsLifecycle = publication && desired.archived !== (entity.archivedAt != null);
  if (needsLifecycle && (input.operation !== 'entity.update' || publication.phase !== 'first'))
    throw new Error('The organization acknowledgement has not applied the saved archive state.');
  db.prepare(
    `UPDATE org_registry_local_records SET acknowledged_mutation_id=?,reviewed_resolution_id=NULL,
    acknowledged_local_event_seq=CASE WHEN ? THEN acknowledged_local_event_seq ELSE ? END,updated_at=?
    WHERE org_id=? AND account_id=? AND entity_id=?`
  ).run(
    input.mutationId,
    needsLifecycle ? 1 : 0,
    publication?.local_event_seq ?? binding.claim_local_event_seq,
    input.now,
    binding.org_id,
    binding.account_id,
    binding.entity_id
  );
  if (publication)
    db.prepare(
      `UPDATE org_registry_record_publications SET status=?,phase=?,updated_at=?
    WHERE mutation_id=?`
    ).run(
      needsLifecycle ? 'ready' : 'acknowledged',
      needsLifecycle ? 'lifecycle' : publication.phase,
      input.now,
      publication.mutation_id
    );
}

function acknowledgedReceipt(
  db: Database.Database,
  binding: Binding
): OrgRegistryRemoteMutationReceipt | null {
  if (!binding.acknowledged_mutation_id) return null;
  const row = db
    .prepare(
      `SELECT response_json FROM org_registry_mutation_receipts
    WHERE mutation_id=? AND account_id=? AND org_id=? AND client_id=?`
    )
    .get(
      binding.acknowledged_mutation_id,
      binding.account_id,
      binding.org_id,
      binding.client_id
    ) as { response_json: string } | undefined;
  if (!row)
    throw new Error('The registered record’s durable organization acknowledgement is unavailable.');
  const receipt = JSON.parse(row.response_json) as OrgRegistryRemoteMutationReceipt;
  if (receipt.mutationId !== binding.acknowledged_mutation_id)
    throw new Error('The registered acknowledgement changed.');
  checkedCanonical(binding, receipt);
  return receipt;
}

export function readReadyOrgRegistryRecordMutations(
  db: Database.Database,
  input: Scope & { now: number }
): Array<{
  clientId: string;
  mutationId: string;
  operation: 'entity.update' | 'entity.archive' | 'entity.restore';
  payload: Record<string, unknown>;
}> {
  const rows = db
    .prepare(
      `SELECT p.* FROM org_registry_record_publications p
    JOIN org_registry_local_records b USING(org_id,account_id,entity_id)
    WHERE p.org_id=? AND p.account_id=? AND p.status='ready'
      AND (b.acknowledged_mutation_id IS NOT NULL OR b.reviewed_resolution_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM org_registry_record_publication_supersessions s WHERE s.mutation_id=p.mutation_id)
      AND NOT EXISTS(SELECT 1 FROM org_registry_record_resolutions r WHERE r.org_id=p.org_id AND r.account_id=p.account_id AND r.entity_id=p.entity_id AND r.status<>'settled')
      AND NOT EXISTS(SELECT 1 FROM org_registry_record_publications earlier
        WHERE earlier.org_id=p.org_id AND earlier.account_id=p.account_id AND earlier.entity_id=p.entity_id
          AND earlier.local_event_seq<p.local_event_seq AND earlier.status<>'acknowledged'
          AND NOT EXISTS(SELECT 1 FROM org_registry_record_publication_supersessions s WHERE s.mutation_id=earlier.mutation_id))
    ORDER BY p.local_event_seq,p.mutation_id`
    )
    .all(input.orgId, input.accountId) as Publication[];
  const result: Array<{
    clientId: string;
    mutationId: string;
    operation: 'entity.update' | 'entity.archive' | 'entity.restore';
    payload: Record<string, unknown>;
  }> = [];
  for (const row of rows) {
    try {
      const binding = bindingFor(db, { ...input, entityId: row.entity_id })!;
      assertHome(db, binding);
      const base = canonicalBase(db, binding);
      if (!base) throw new Error('The registered record has no confirmed revision base.');
      const canonical = base.entity;
      const desired = JSON.parse(row.payload_json) as Record<string, unknown>;
      const fieldsChanged =
        canonical.name !== desired.name ||
        !isDeepStrictEqual(canonical.fields, desired.fields) ||
        canonical.registrationStatus !== desired.registrationStatus ||
        canonical.domainStatus !== desired.domainStatus;
      const lifecycleChanged = desired.archived !== (canonical.archivedAt != null);
      const operation =
        row.phase === 'lifecycle' || (!fieldsChanged && lifecycleChanged)
          ? desired.archived
            ? 'entity.archive'
            : 'entity.restore'
          : 'entity.update';
      const { archived: _archived, ...fields } = desired;
      result.push({
        clientId: binding.client_id,
        mutationId: row.phase === 'first' ? row.mutation_id : row.lifecycle_mutation_id,
        operation,
        payload:
          operation === 'entity.update'
            ? { ...fields, expectedRevision: canonical.revision }
            : { id: row.entity_id, expectedRevision: canonical.revision },
      });
    } catch (error) {
      db.prepare(
        `UPDATE org_registry_record_publications SET status='failed',error_message=?,updated_at=? WHERE mutation_id=?`
      ).run(
        error instanceof Error ? error.message : 'The registered edit needs review.',
        input.now,
        row.mutation_id
      );
    }
  }
  return result;
}

export function markOrgRegistryRecordMutationQueuedInTx(
  db: Database.Database,
  input: { mutationId: string; now: number }
): void {
  const result = db
    .prepare(
      `UPDATE org_registry_record_publications SET status='queued',updated_at=? WHERE status='ready' AND ((phase='first' AND mutation_id=?) OR (phase='lifecycle' AND lifecycle_mutation_id=?))`
    )
    .run(input.now, input.mutationId, input.mutationId);
  if (result.changes !== 1)
    throw new Error('The registered edit is no longer ready to synchronize.');
}

export function assertOrgRegistryRecordMutationMaySend(
  db: Database.Database,
  mutation: OrgRegistryMutationRow
): void {
  const publication = db
    .prepare(
      'SELECT * FROM org_registry_record_publications WHERE mutation_id=? OR lifecycle_mutation_id=?'
    )
    .get(mutation.mutationId, mutation.mutationId) as Publication | undefined;
  const binding = publication
    ? bindingFor(db, { ...mutation, entityId: publication.entity_id })
    : (db
        .prepare('SELECT * FROM org_registry_local_records WHERE claim_mutation_id=?')
        .get(mutation.mutationId) as Binding | undefined);
  if (!binding) return;
  if (
    binding.account_id !== mutation.accountId ||
    binding.org_id !== mutation.orgId ||
    binding.client_id !== mutation.clientId
  )
    throw new Error('The registered edit belongs to a different account.');
  if (pendingResolution(db, binding))
    throw new Error('A reviewed organization change is still being published.');
  assertHome(db, binding);
}

export function isOrgRegistryRecordMutationHeld(
  db: Database.Database,
  mutation: OrgRegistryMutationRow
): boolean {
  const publication = db
    .prepare(
      'SELECT * FROM org_registry_record_publications WHERE mutation_id=? OR lifecycle_mutation_id=?'
    )
    .get(mutation.mutationId, mutation.mutationId) as Publication | undefined;
  if (!publication) return false;
  const binding = bindingFor(db, {
    ...mutation,
    entityId: publication.entity_id,
  });
  return Boolean(binding && pendingResolution(db, binding));
}

export function assertOrgRegistryConflictIsNotLinked(
  db: Database.Database,
  mutationId: string
): void {
  if (
    db
      .prepare(
        'SELECT 1 FROM org_registry_record_publications WHERE mutation_id=? OR lifecycle_mutation_id=?'
      )
      .get(mutationId, mutationId)
  )
    throw new Error(
      'Review this registered record’s saved file and organization revision before resolving its conflict.'
    );
}

export function readOrgRegistryRecordSyncStatus(
  db: Database.Database,
  input: { accountId: string; entityId: string }
): OrganizationRegistryRecordSyncStatus | null {
  const bindings = db
    .prepare('SELECT * FROM org_registry_local_records WHERE account_id=? AND entity_id=?')
    .all(input.accountId, input.entityId) as Binding[];
  if (!bindings.length) return null;
  if (bindings.length !== 1)
    throw new Error('The registered record has ambiguous organization connections.');
  const binding = bindings[0];
  const scope = db
    .prepare(
      'SELECT status,access_generation FROM org_registry_sync_state WHERE org_id=? AND account_id=?'
    )
    .get(binding.org_id, binding.account_id) as
    | { status: string; access_generation: string | null }
    | undefined;
  if (!scope?.access_generation || scope.status === 'access_revoked')
    throw Object.assign(
      new Error(
        'Verify current organization access before viewing registered record synchronization.'
      ),
      { code: 'FORBIDDEN' }
    );
  const cached = db
    .prepare(
      `SELECT payload_json FROM org_registry_cache
    WHERE org_id=? AND account_id=? AND record_type='entity' AND record_id=?`
    )
    .get(binding.org_id, binding.account_id, binding.entity_id) as
    | { payload_json: string }
    | undefined;
  if ((binding.acknowledged_mutation_id || binding.reviewed_resolution_id) && !cached)
    throw Object.assign(
      new Error('This organization record is not available in the current access scope.'),
      { code: 'FORBIDDEN' }
    );
  const pending = db
    .prepare(
      `SELECT p.*,o.status AS mutation_status,o.last_error_message FROM org_registry_record_publications p
    LEFT JOIN org_registry_outbox o ON o.mutation_id=CASE WHEN p.phase='first' THEN p.mutation_id ELSE p.lifecycle_mutation_id END
    WHERE p.org_id=? AND p.account_id=? AND p.entity_id=? AND p.status<>'acknowledged'
    AND NOT EXISTS(SELECT 1 FROM org_registry_record_publication_supersessions s WHERE s.mutation_id=p.mutation_id)
    ORDER BY p.local_event_seq,p.mutation_id LIMIT 1`
    )
    .get(binding.org_id, binding.account_id, binding.entity_id) as
    | (Publication & {
        mutation_status: OrgRegistryMutationRow['status'] | null;
        last_error_message: string | null;
      })
    | undefined;
  const claim = db
    .prepare('SELECT status,last_error_message FROM org_registry_outbox WHERE mutation_id=?')
    .get(binding.claim_mutation_id) as
    | {
        status: OrgRegistryMutationRow['status'];
        last_error_message: string | null;
      }
    | undefined;
  let acknowledgedRevision: number | null = null;
  let baseRevision: number | null = null;
  let baseProvenance: 'receipt' | 'reviewed_remote' | null = null;
  let remoteChanged = false;
  try {
    const receipt = acknowledgedReceipt(db, binding);
    if (receipt) acknowledgedRevision = checkedCanonical(binding, receipt).revision;
    const base = canonicalBase(db, binding);
    if (base) {
      const acknowledged = base.entity;
      baseRevision = acknowledged.revision;
      baseProvenance = base.provenance;
      const current = checkedCanonicalEntity(binding, JSON.parse(cached!.payload_json));
      remoteChanged =
        current.revision !== acknowledged.revision ||
        !isDeepStrictEqual(entityState(current), entityState(acknowledged));
    }
  } catch (error) {
    return {
      orgId: binding.org_id,
      entityId: binding.entity_id,
      homeWorkspaceId: binding.home_workspace_id,
      acknowledgedRevision: null,
      baseRevision: null,
      baseProvenance: null,
      status: 'failed',
      mutationId: binding.acknowledged_mutation_id!,
      message: (error as Error).message,
    };
  }
  const resolution = pendingResolution(db, binding);
  const blocked =
    pending?.mutation_status ?? (!binding.acknowledged_mutation_id ? claim?.status : null);
  const status = resolution
    ? 'publication_pending'
    : blocked === 'conflict'
      ? 'conflict'
      : blocked === 'failed' || pending?.status === 'failed'
        ? 'failed'
        : !binding.acknowledged_mutation_id
          ? 'claim_pending'
          : pending?.status === 'publication_pending'
            ? 'publication_pending'
            : pending
              ? 'queued'
              : remoteChanged
                ? 'remote_changes'
                : 'synced';
  return {
    orgId: binding.org_id,
    entityId: binding.entity_id,
    homeWorkspaceId: binding.home_workspace_id,
    acknowledgedRevision,
    baseRevision,
    baseProvenance,
    status,
    mutationId:
      resolution?.resolution_id ??
      (pending
        ? pending.phase === 'first'
          ? pending.mutation_id
          : pending.lifecycle_mutation_id
        : null) ??
      binding.acknowledged_mutation_id ??
      binding.claim_mutation_id,
    message:
      pending?.error_message ??
      pending?.last_error_message ??
      (!binding.acknowledged_mutation_id ? claim?.last_error_message : null) ??
      null,
  };
}

type Resolution = {
  resolution_id: string;
  org_id: string;
  account_id: string;
  entity_id: string;
  choice: 'use_remote' | 'keep_saved';
  publication_operation_id: string;
  review_json: string;
  desired_json: string;
  status: 'prepared' | 'publication_pending' | 'settled';
  publication_authority: OrgRegistryPublicationDigest['authority'] | null;
  publication_sha256: string | null;
  published_entity_json: string | null;
  published_local_event_seq: number | null;
};

function pendingResolution(db: Database.Database, binding: Binding): Resolution | undefined {
  return db
    .prepare(
      `SELECT * FROM org_registry_record_resolutions
    WHERE org_id=? AND account_id=? AND entity_id=? AND status<>'settled'`
    )
    .get(binding.org_id, binding.account_id, binding.entity_id) as Resolution | undefined;
}

function entityState(entity: Record<string, unknown>): Record<string, unknown> {
  return {
    id: entity.id,
    name: entity.name,
    fields: entity.fields,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
    archived: entity.archivedAt != null,
  };
}

function localState(
  entity: LimsEntity,
  authority: OrgRegistryPublicationDigest['authority']
): Record<string, unknown> {
  return {
    id: entity.id,
    name: entity.name,
    fields: orgRegistryPublicationFields(entity, authority),
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
    archived: entity.tombstone,
  };
}

function canonicalBase(
  db: Database.Database,
  binding: Binding
): {
  provenance: 'receipt' | 'reviewed_remote';
  identity: string;
  entity: Record<string, unknown> & { revision: number };
} | null {
  if (binding.reviewed_resolution_id) {
    const row = db
      .prepare(
        `SELECT * FROM org_registry_record_resolutions
      WHERE resolution_id=? AND org_id=? AND account_id=? AND entity_id=? AND status='settled'`
      )
      .get(
        binding.reviewed_resolution_id,
        binding.org_id,
        binding.account_id,
        binding.entity_id
      ) as Resolution | undefined;
    if (!row) throw new Error('The explicitly reviewed organization revision is unavailable.');
    const review = JSON.parse(row.review_json) as OrgRegistryRecordReview;
    return {
      provenance: 'reviewed_remote',
      identity: row.resolution_id,
      entity: checkedCanonicalEntity(binding, review.canonical),
    };
  }
  const receipt = acknowledgedReceipt(db, binding);
  return receipt
    ? {
        provenance: 'receipt',
        identity: receipt.mutationId,
        entity: checkedCanonical(binding, receipt),
      }
    : null;
}

function currentScopedCanonical(
  db: Database.Database,
  binding: Binding,
  expectedGeneration?: string
) {
  const scope = db
    .prepare(
      `SELECT status,access_generation FROM org_registry_sync_state WHERE org_id=? AND account_id=?`
    )
    .get(binding.org_id, binding.account_id) as
    | { status: string; access_generation: string | null }
    | undefined;
  if (
    !scope?.access_generation ||
    scope.status === 'access_revoked' ||
    (expectedGeneration !== undefined && expectedGeneration !== scope.access_generation)
  )
    throw Object.assign(
      new Error('Refresh current organization access before reviewing this record.'),
      { code: 'FORBIDDEN' }
    );
  const cached = db
    .prepare(
      `SELECT payload_json FROM org_registry_cache
    WHERE org_id=? AND account_id=? AND record_type='entity' AND record_id=?`
    )
    .get(binding.org_id, binding.account_id, binding.entity_id) as
    | { payload_json: string }
    | undefined;
  if (!cached)
    throw Object.assign(new Error('This organization record is not in the current access scope.'), {
      code: 'FORBIDDEN',
    });
  return {
    accessGeneration: scope.access_generation,
    entity: checkedCanonicalEntity(binding, JSON.parse(cached.payload_json)),
  };
}

function activePublications(db: Database.Database, binding: Binding): Publication[] {
  return db
    .prepare(
      `SELECT p.* FROM org_registry_record_publications p
    WHERE p.org_id=? AND p.account_id=? AND p.entity_id=? AND p.status<>'acknowledged'
    AND NOT EXISTS(SELECT 1 FROM org_registry_record_publication_supersessions s WHERE s.mutation_id=p.mutation_id)
    ORDER BY p.local_event_seq,p.mutation_id`
    )
    .all(binding.org_id, binding.account_id, binding.entity_id) as Publication[];
}

function reviewedPublication(row: Publication) {
  return {
    operationId: row.operation_id,
    mutationId: row.mutation_id,
    lifecycleMutationId: row.lifecycle_mutation_id,
    phase: row.phase,
    status: row.status,
    localEventSeq: row.local_event_seq,
    publicationDigest: {
      authority: row.publication_authority,
      sha256: row.publication_sha256,
    },
    desired: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

export function readOrgRegistryRecordReview(
  db: Database.Database,
  input: Scope & { entityId: string; expectedAccessGeneration?: string }
) {
  return readRecordReview(db, input, false);
}

export function readOrgRegistryRecordResolutionRetryReview(
  db: Database.Database,
  input: Scope & { entityId: string; expectedAccessGeneration: string }
) {
  return readRecordReview(db, input, true);
}

function readRecordReview(
  db: Database.Database,
  input: Scope & { entityId: string; expectedAccessGeneration?: string },
  allowReadOnlyRole: boolean
) {
  const binding = bindingFor(db, input);
  if (!binding) return null;
  const scoped = currentScopedCanonical(db, binding, input.expectedAccessGeneration);
  const local = assertHome(db, binding, allowReadOnlyRole);
  const base = canonicalBase(db, binding);
  if (!base)
    throw new Error(
      'Wait for the record’s registration to finish before reviewing organization changes.'
    );
  const lineage = activePublications(db, binding);
  const conflict = db
    .prepare(
      `SELECT c.id,c.mutation_id FROM org_registry_conflicts c
    JOIN org_registry_record_publications p ON c.mutation_id=p.mutation_id OR c.mutation_id=p.lifecycle_mutation_id
    WHERE p.org_id=? AND p.account_id=? AND p.entity_id=? AND c.status='open'
    AND NOT EXISTS(SELECT 1 FROM org_registry_record_publication_supersessions s WHERE s.mutation_id=p.mutation_id)
    ORDER BY p.local_event_seq,c.created_at LIMIT 1`
    )
    .get(input.orgId, input.accountId, input.entityId) as
    | { id: string; mutation_id: string }
    | undefined;
  const snapshot = {
    scope: {
      accountId: input.accountId,
      orgId: input.orgId,
      accessGeneration: scoped.accessGeneration,
    },
    conflictId: conflict?.id ?? null,
    mutationId: conflict?.mutation_id ?? null,
    binding: {
      entityId: binding.entity_id,
      clientId: binding.client_id,
      workspaceId: binding.workspace_id,
      workspaceUuid: binding.workspace_uuid,
      homeWorkspaceId: binding.home_workspace_id,
      authority: binding.authority_kind,
      schemaId: binding.schema_id,
      schemaRevisionId: binding.schema_revision_id,
    },
    localEventSeq: local.eventSeq,
    local: localState(local, binding.authority_kind),
    canonical: scoped.entity,
    base: {
      provenance: base.provenance,
      identity: base.identity,
      revision: base.entity.revision,
    },
    publications: lineage.map(reviewedPublication),
  };
  return {
    ...snapshot,
    sourceRevision: createHash('sha256')
      .update(canonicalNativeMutationRequest(snapshot))
      .digest('hex'),
  };
}
export type OrgRegistryRecordReview = NonNullable<ReturnType<typeof readOrgRegistryRecordReview>>;

export function readOrgRegistryRecordConflict(
  db: Database.Database,
  input: Scope & { conflictId: string; expectedAccessGeneration?: string }
) {
  const row = db
    .prepare(
      `SELECT p.entity_id FROM org_registry_conflicts c
    JOIN org_registry_record_publications p ON c.mutation_id=p.mutation_id OR c.mutation_id=p.lifecycle_mutation_id
    WHERE c.id=? AND c.org_id=? AND c.account_id=? AND c.status='open'
    AND NOT EXISTS(SELECT 1 FROM org_registry_record_publication_supersessions s WHERE s.mutation_id=p.mutation_id)`
    )
    .get(input.conflictId, input.orgId, input.accountId) as { entity_id: string } | undefined;
  if (!row) return null;
  const review = readOrgRegistryRecordReview(db, {
    ...input,
    entityId: row.entity_id,
  });
  if (review?.conflictId !== input.conflictId)
    throw new Error('The reviewed conflict lineage changed. Refresh it before continuing.');
  return review;
}

function requireResolutionBinding(
  db: Database.Database,
  input: Scope & { entityId: string },
  generation: string
): Binding {
  const binding = bindingFor(db, input);
  if (!binding)
    throw new Error('The reviewed record belongs to a different account or organization.');
  assertHome(db, binding);
  currentScopedCanonical(db, binding, generation);
  return binding;
}

function assertNoUncertainSend(db: Database.Database, lineage: Publication[]): void {
  for (const publication of lineage) {
    const outbox = db
      .prepare(
        'SELECT status,attempt_count FROM org_registry_outbox WHERE mutation_id=? OR mutation_id=?'
      )
      .all(publication.mutation_id, publication.lifecycle_mutation_id) as Array<{
      status: string;
      attempt_count: number;
    }>;
    if (
      outbox.some(
        (row) => row.status === 'sending' || (row.attempt_count > 0 && row.status !== 'conflict')
      )
    )
      throw new Error(
        'Finish verifying the earlier organization update before resolving this record.'
      );
    if (publication.status === 'publication_pending')
      throw new Error('Finish saving this record locally before reviewing organization changes.');
  }
}

export function prepareOrgRegistryRecordResolutionInTx(
  db: Database.Database,
  input: Scope & {
    entityId: string;
    resolutionId: string;
    choice: 'use_remote' | 'keep_saved';
    review: OrgRegistryRecordReview;
    publicationOperationId: string;
    now: number;
  }
): void {
  const binding = requireResolutionBinding(db, input, input.review.scope.accessGeneration);
  if (
    !input.resolutionId ||
    !input.publicationOperationId ||
    input.review.scope.accountId !== input.accountId ||
    input.review.scope.orgId !== input.orgId ||
    input.review.binding.entityId !== input.entityId
  )
    throw new Error('The reviewed organization change belongs to a different record or account.');
  const prior = db
    .prepare('SELECT * FROM org_registry_record_resolutions WHERE resolution_id=?')
    .get(input.resolutionId) as Resolution | undefined;
  if (prior) {
    if (
      prior.org_id !== input.orgId ||
      prior.account_id !== input.accountId ||
      prior.entity_id !== input.entityId ||
      prior.choice !== input.choice ||
      prior.publication_operation_id !== input.publicationOperationId ||
      !isDeepStrictEqual(JSON.parse(prior.review_json), input.review)
    )
      throw new Error('The resolution identity was reused for a different reviewed change.');
    return;
  }
  if (pendingResolution(db, binding))
    throw new Error('An earlier reviewed organization change is still being published.');
  const current = readOrgRegistryRecordReview(db, input);
  if (!current || !isDeepStrictEqual(current, input.review))
    throw Object.assign(
      new Error(
        'The saved record or organization review changed. Review the current versions again.'
      ),
      { code: 'REVIEW_CHANGED' }
    );
  assertNoUncertainSend(db, activePublications(db, binding));
  const desired =
    input.choice === 'use_remote' ? entityState(input.review.canonical) : input.review.local;
  db.prepare(
    `INSERT INTO org_registry_record_resolutions
    (resolution_id,org_id,account_id,entity_id,choice,publication_operation_id,review_json,desired_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'prepared',?,?)`
  ).run(
    input.resolutionId,
    input.orgId,
    input.accountId,
    input.entityId,
    input.choice,
    input.publicationOperationId,
    JSON.stringify(input.review),
    JSON.stringify(desired),
    input.now,
    input.now
  );
}

export function captureOrgRegistryRecordResolutionPublicationInTx(
  db: Database.Database,
  input: {
    accountId: string;
    resolutionId: string;
    operationId: string;
    entity: LimsEntity;
    publicationDigest: OrgRegistryPublicationDigest;

    verifiedAccessGeneration?: string;
    now: number;
  }
): void {
  const row = db
    .prepare('SELECT * FROM org_registry_record_resolutions WHERE resolution_id=?')
    .get(input.resolutionId) as Resolution | undefined;
  if (
    !row ||
    row.account_id !== input.accountId ||
    row.entity_id !== input.entity.id ||
    row.publication_operation_id !== input.operationId
  )
    throw new Error('This publication does not match the approved organization change.');
  const review = JSON.parse(row.review_json) as OrgRegistryRecordReview;
  const binding = requireResolutionBinding(
    db,
    { accountId: row.account_id, orgId: row.org_id, entityId: row.entity_id },
    input.verifiedAccessGeneration === undefined
      ? review.scope.accessGeneration
      : requireVerifiedAccessGeneration(input.verifiedAccessGeneration)
  );
  const current = assertHome(db, binding);
  if (
    !isDeepStrictEqual(current, input.entity) ||
    !isDeepStrictEqual(
      localState(input.entity, binding.authority_kind),
      JSON.parse(row.desired_json)
    ) ||
    binding.authority_kind !== input.publicationDigest.authority ||
    !/^[a-f0-9]{64}$/.test(input.publicationDigest.sha256) ||
    !Number.isSafeInteger(input.entity.eventSeq) ||
    Number(input.entity.eventSeq) < Number(review.localEventSeq) ||
    (row.choice === 'keep_saved' &&
      Number(input.entity.eventSeq) <= Number(review.localEventSeq)) ||
    (binding.authority_kind === 'database' &&
      orgRegistryDatabasePublicationDigest(input.entity).sha256 !== input.publicationDigest.sha256)
  )
    throw new Error(
      'The published record does not match the approved saved state, identity or edit version.'
    );
  if (row.status !== 'prepared') {
    if (
      row.publication_authority !== input.publicationDigest.authority ||
      row.publication_sha256 !== input.publicationDigest.sha256 ||
      row.published_local_event_seq !== input.entity.eventSeq ||
      !isDeepStrictEqual(JSON.parse(row.published_entity_json!), input.entity)
    )
      throw new Error('The resolution publication identity was reused for different bytes.');
    return;
  }
  db.prepare(
    `UPDATE org_registry_record_resolutions SET status='publication_pending',publication_authority=?,publication_sha256=?,
    published_entity_json=?,published_local_event_seq=?,updated_at=? WHERE resolution_id=? AND status='prepared'`
  ).run(
    input.publicationDigest.authority,
    input.publicationDigest.sha256,
    JSON.stringify(input.entity),
    input.entity.eventSeq,
    input.now,
    input.resolutionId
  );
}

function requireVerifiedAccessGeneration(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value)
    throw new Error('Verify current organization access before finishing this published change.');
  return value;
}

export function settleOrgRegistryRecordResolutionInTx(
  db: Database.Database,
  input: {
    accountId: string;
    resolutionId: string;
    operationId: string;
    entity: LimsEntity;
    publicationDigest: OrgRegistryPublicationDigest;

    verifiedAccessGeneration: string;
    now: number;
  }
): void {
  const row = db
    .prepare('SELECT * FROM org_registry_record_resolutions WHERE resolution_id=?')
    .get(input.resolutionId) as Resolution | undefined;
  if (
    !row ||
    row.account_id !== input.accountId ||
    row.entity_id !== input.entity.id ||
    row.publication_operation_id !== input.operationId ||
    row.status === 'prepared' ||
    row.publication_authority !== input.publicationDigest.authority ||
    row.publication_sha256 !== input.publicationDigest.sha256 ||
    row.published_local_event_seq !== input.entity.eventSeq ||
    !isDeepStrictEqual(JSON.parse(row.published_entity_json!), input.entity)
  )
    throw new Error(
      'The approved organization change has not finished publishing its checked local bytes.'
    );
  const review = JSON.parse(row.review_json) as OrgRegistryRecordReview;
  const binding = requireResolutionBinding(
    db,
    { accountId: row.account_id, orgId: row.org_id, entityId: row.entity_id },
    requireVerifiedAccessGeneration(input.verifiedAccessGeneration)
  );

  if (row.status === 'settled') return;
  const current = assertHome(db, binding);
  if (
    !isDeepStrictEqual(current, input.entity) ||
    !isDeepStrictEqual(localState(current, binding.authority_kind), JSON.parse(row.desired_json)) ||
    (binding.authority_kind === 'database' &&
      orgRegistryDatabasePublicationDigest(current).sha256 !== input.publicationDigest.sha256)
  )
    throw new Error('The saved record changed before its reviewed publication settled.');
  const base = canonicalBase(db, binding);
  if (
    !base ||
    base.provenance !== review.base.provenance ||
    base.identity !== review.base.identity ||
    base.entity.revision !== review.base.revision
  )
    throw new Error('The registered record’s accepted base changed during review.');
  const lineage = activePublications(db, binding);
  if (!isDeepStrictEqual(lineage.map(reviewedPublication), review.publications))
    throw new Error('The saved edit lineage changed before its reviewed publication settled.');
  assertNoUncertainSend(db, lineage);

  checkedCanonicalEntity(binding, review.canonical);
  for (const publication of lineage) {
    db.prepare(
      'INSERT INTO org_registry_record_publication_supersessions(mutation_id,resolution_id,superseded_at) VALUES(?,?,?)'
    ).run(publication.mutation_id, row.resolution_id, input.now);
    db.prepare(
      `UPDATE org_registry_conflicts SET status=?,resolved_at=?,updated_at=?
      WHERE mutation_id IN (?,?) AND org_id=? AND account_id=? AND status='open'`
    ).run(
      row.choice === 'use_remote' ? 'discarded' : 'resolved',
      input.now,
      input.now,
      publication.mutation_id,
      publication.lifecycle_mutation_id,
      row.org_id,
      row.account_id
    );
    db.prepare(
      `UPDATE org_registry_outbox SET status='failed',next_attempt_at=NULL,last_error_code='RESOLVED_REGISTERED_RECORD',
      last_error_message='Superseded by an explicitly reviewed record publication.',updated_at=?
      WHERE mutation_id IN (?,?) AND org_id=? AND account_id=?`
    ).run(
      input.now,
      publication.mutation_id,
      publication.lifecycle_mutation_id,
      row.org_id,
      row.account_id
    );
  }
  db.prepare(
    `UPDATE org_registry_record_resolutions SET status='settled',settled_at=?,updated_at=? WHERE resolution_id=?`
  ).run(input.now, input.now, row.resolution_id);
  db.prepare(
    `UPDATE org_registry_local_records SET reviewed_resolution_id=?,updated_at=?
    WHERE org_id=? AND account_id=? AND entity_id=?`
  ).run(row.resolution_id, input.now, row.org_id, row.account_id, row.entity_id);
  if (row.choice === 'keep_saved') {
    captureOrgRegistryRecordPublicationInTx(db, {
      accountId: input.accountId,
      operationId: input.operationId,
      entity: input.entity,
      publicationDigest: input.publicationDigest,
      now: input.now,
    });
    markOrgRegistryRecordPublicationReadyInTx(db, {
      operationId: input.operationId,
      entityId: input.entity.id,
      publicationDigest: input.publicationDigest,
      now: input.now,
    });
  }
}
