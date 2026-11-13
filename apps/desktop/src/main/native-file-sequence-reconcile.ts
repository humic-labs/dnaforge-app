import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseSequenceFile } from '@waypoint/sequence-utils';
import {
  nativeWorkspaceUsesAtomicSequenceProjection,
  type NativeWorkspaceAtomicSequenceProjectionEntity,
  type NativeWorkspaceManifestV2,
} from '../shared/native-workspace-manifest';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { mapPortableRecordRelationships } from '../shared/portable-record-relationships';
import { parseSequenceClassificationDecision } from '../shared/oligo-classification';
import {
  limsEntityFromRow,
  type LimsLink,
  type LimsLinkRow,
  type LimsEntity,
  type LimsEntityRow,
  type LimsAuditRow,
} from '../shared/lims';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import {
  allocateRegistryIdInsideTx,
  assertActiveFileSequenceOwnerIsUnique,
  assertEntityValid,
  insertAuditEvent,
  materializeEntitySchemaSnapshotInsideTx,
  nextEventSeq,
  resolveSchemaRevisionForKind,
  upsertLimsEntityProjectionInsideTx,
  upsertLimsLinkProjectionInsideTx,
  assertRelationshipTypeExists,
  LINEAGE_RELATIONSHIP_TYPES,
  wouldCreateRelationshipCycle,
} from './lims-engine-core';
import { readClassificationFile } from './native-sequence-classification-review';
import { materializeFileBinding } from './native-workspace-materializer';
import { sourceFormatForPath } from './lims-sequence-io';
import { replayAuditRowsIntoProjection } from './lims-projection-rebuild';
import { upsertProviderBinding } from './catalog-provider-bindings';
import { nativeLimsEndpointPresent } from './native-workspace-reconcile-graph';
import { acceptedScientificResourceIds } from './scientific-strain-authority';

export function reconcileNativeFileSequencesInsideTx(
  db: Database.Database,
  root: string,
  workspace: { id: number; repo_uuid: string | null },
  manifest: NativeWorkspaceManifestV2
): number {
  if (!db.inTransaction) throw new Error('Sequence reconstruction requires a transaction.');
  const scope = workspaceScopeKey(workspace.repo_uuid, workspace.id);
  const accepted = acceptedScientificResourceIds(db, workspace.id);
  const sequences = manifest.entities
    .filter(nativeWorkspaceUsesAtomicSequenceProjection)
    .filter(
      (entity) => !accepted.has(entity.id) && !accepted.has(scopedProjectionId(scope, entity.id))
    );
  const manifestIds = new Set(manifest.entities.map((entity) => entity.id));
  const fileChecks: Array<() => void> = [];
  for (const portable of sequences) {
    reconcileNativeFileSequenceInsideTx({
      db,
      root,
      workspace,
      portable,
      scope,
      manifestIds,
      fileChecks,
    });
  }
  for (const check of fileChecks) check();
  return sequences.length;
}

type ReconcileNativeFileSequenceArgs = {
  db: Database.Database;
  root: string;
  workspace: { id: number; repo_uuid: string | null };
  portable: NativeWorkspaceAtomicSequenceProjectionEntity;
  scope: ReturnType<typeof workspaceScopeKey>;
  manifestIds: ReadonlySet<string>;
  fileChecks: Array<() => void>;
};

type NativeFileSequence = NativeWorkspaceAtomicSequenceProjectionEntity;
type NativeFileSequenceLims = NonNullable<NativeFileSequence['lims']>;
type SequenceClassificationDecision = ReturnType<typeof parseSequenceClassificationDecision>;
type SequenceMolecule = SequenceClassificationDecision['molecule'];

function readNativeSequenceFileOrMissing(root: string, path: string, limit: number): Buffer | null {
  try {
    return readClassificationFile(root, path, limit);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
    return null;
  }
}

function captureNativeSequenceFile(
  root: string,
  path: string,
  limit: number,
  fileChecks: Array<() => void>
): { bytes: Buffer | null; hash: string | null } {
  const bytes = readNativeSequenceFileOrMissing(root, path, limit);
  const hash = bytes === null ? null : sha(bytes);
  fileChecks.push(() => assertNativeSequenceFileUnchanged(root, path, limit, hash));
  return { bytes, hash };
}

function assertNativeSequenceFileUnchanged(
  root: string,
  path: string,
  limit: number,
  expectedHash: string | null
): void {
  const current = readNativeSequenceFileOrMissing(root, path, limit);
  if ((current === null ? null : sha(current)) !== expectedHash)
    throw new Error('Sequence file changed during reconstruction. Retry opening the workspace.');
}

type ReconcileNativeSequenceCatalogArgs = {
  db: Database.Database;
  workspaceId: number;
  portable: NativeFileSequence;
  decision: SequenceClassificationDecision | null;
  id: string;
  path: string;
  bytes: Buffer | null;
  hash: string | null;
};

type ReconcileNativeSequenceFileBindingArgs = Pick<
  ReconcileNativeSequenceCatalogArgs,
  'db' | 'workspaceId' | 'portable' | 'id' | 'path' | 'bytes' | 'hash'
> & { now: number };

function reconcileNativeSequenceFileBindingInsideTx({
  db,
  workspaceId,
  portable,
  id,
  path,
  bytes,
  hash,
  now,
}: ReconcileNativeSequenceFileBindingArgs): void {
  const previousBinding = db
    .prepare('SELECT entity_id,content_hash FROM catalog_entity_files WHERE path=?')
    .get(path) as { entity_id: string; content_hash: string | null } | undefined;
  if (previousBinding && previousBinding.entity_id !== id)
    throw new Error('Sequence file binding belongs to another entity.');
  if (bytes !== null || !previousBinding) {
    materializeFileBinding(db, {
      workspaceId,
      entityId: id,
      absolutePath: path,
      relativePath: portable.placement.relativePath,
      fileKind: portable.placement.fileKind,
      contentHash:
        bytes !== null && previousBinding?.content_hash?.startsWith('git:')
          ? `git:${createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}`
          : hash,
      sizeBytes: bytes?.length ?? null,
      modifiedAt: null,
      now,
    });
  }
  if (bytes === null) {
    db.prepare(
      "UPDATE catalog_entity_files SET status='missing',missing_since=COALESCE(missing_since,?) WHERE entity_id=? AND path=?"
    ).run(now, id, path);
  }
}

function restoreNativeSequenceProviderBindingsInsideTx(
  db: Database.Database,
  portable: NativeFileSequence,
  entityId: string
): void {
  for (const identity of portable.sourceIdentities ?? []) {
    upsertProviderBinding(db, {
      reference: {
        provider: identity.provider,
        stableObjectId: identity.stableObjectId,
        objectClass: identity.objectClass,
        providerAccountHint: identity.providerAccountHint ?? null,
        canonicalUrl: identity.canonicalUrl ?? null,
      },
      entityId,
      bindingKind: identity.bindingKind,
      evidence: { source: '.forge/catalog.json' },
    });
  }
}

function reconcileNativeSequenceCatalogInsideTx({
  db,
  workspaceId,
  portable,
  decision,
  id,
  path,
  bytes,
  hash,
}: ReconcileNativeSequenceCatalogArgs): { archived: boolean; now: number } {
  const archived = portable.lifecycle?.state === 'archived';
  let status = archived ? 'archived' : bytes === null ? 'missing' : 'active';
  const locator = `file://${path}`;
  const existingCatalog = db
    .prepare(
      'SELECT type,workspace_id,locator,name,status,metadata FROM catalog_entities WHERE id=?'
    )
    .get(id) as
    | {
        type: string;
        workspace_id: number;
        locator: string;
        name: string;
        status: string;
        metadata: string | null;
      }
    | undefined;
  if (
    existingCatalog &&
    (existingCatalog.type !== 'sequence' ||
      existingCatalog.workspace_id !== workspaceId ||
      existingCatalog.locator !== locator)
  )
    throw new Error('Reviewed sequence identity is owned by another file or workspace.');
  if (!decision && existingCatalog?.status === 'archived') status = 'archived';
  const name = !decision && existingCatalog ? existingCatalog.name : portable.name;
  const metadata = {
    ...portable.metadata,
    ...(portable.migrationSource ? { migrationSource: portable.migrationSource } : {}),
    portableId: portable.id,
    path,
    relativePath: portable.placement.relativePath,
    fileKind: portable.placement.fileKind,
    placement: portable.placement,
    reconstructedFrom: '.forge/catalog.json',
  };
  const now = Date.now();
  if (
    !existingCatalog ||
    existingCatalog.name !== name ||
    existingCatalog.status !== status ||
    !isDeepStrictEqual(JSON.parse(existingCatalog.metadata ?? '{}'), metadata)
  ) {
    db.prepare(
      `INSERT INTO catalog_entities (id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at)
      VALUES (?,'sequence',?,?,'file',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,status=excluded.status,metadata=excluded.metadata,updated_at=excluded.updated_at`
    ).run(id, name, locator, status, workspaceId, JSON.stringify(metadata), now, now);
  }
  db.prepare('DELETE FROM catalog_workspace_placements WHERE entity_id=?').run(id);
  reconcileNativeSequenceFileBindingInsideTx({
    db,
    workspaceId,
    portable,
    id,
    path,
    bytes,
    hash,
    now,
  });
  restoreNativeSequenceProviderBindingsInsideTx(db, portable, id);
  return { archived, now };
}

type LoadExistingNativeSequenceArgs = {
  db: Database.Database;
  workspaceId: number;
  lims: NativeFileSequenceLims;
  id: string;
  molecule: SequenceMolecule;
  decision: SequenceClassificationDecision | null;
};

function loadExistingNativeSequenceInsideTx({
  db,
  workspaceId,
  lims,
  id,
  molecule,
  decision,
}: LoadExistingNativeSequenceArgs): LimsEntity | null {
  materializeEntitySchemaSnapshotInsideTx(db, {
    ...lims,
    id,
    workspaceId,
    actor: 'workspace-reconcile',
  });
  let row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(id) as LimsEntityRow | undefined;
  if (!row) {
    const history = db
      .prepare(
        "SELECT * FROM lims_audit WHERE subject_table='lims_entity' AND subject_id=? ORDER BY event_seq"
      )
      .all(id) as LimsAuditRow[];
    replayAuditRowsIntoProjection(db, history);
    row = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(id) as LimsEntityRow | undefined;
  }
  if (
    row &&
    (row.workspace_id !== workspaceId ||
      (molecule === 'dna'
        ? !['dna_sequence', 'oligo'].includes(row.kind)
        : !['rna_sequence', 'rna_oligo'].includes(row.kind)))
  )
    throw new Error(
      'Reviewed sequence reconstruction cannot change scientific ownership or molecule.'
    );
  const existing = row ? limsEntityFromRow(row) : null;
  if (!decision && existing && existing.kind !== lims.kind)
    throw new Error('Generic sequence reconstruction cannot replace a reviewed classification.');
  return existing;
}

function mapNativeSequenceOwnedFields(
  lims: NativeFileSequenceLims,
  decision: SequenceClassificationDecision | null,
  existing: LimsEntity | null,
  manifestIds: ReadonlySet<string>,
  scope: ReturnType<typeof workspaceScopeKey>
): Record<string, unknown> {
  if (!decision && existing) return existing.fields;
  return mapPortableRecordRelationships(lims.fields, lims.schemaSnapshot, (rawId) => {
    if (!manifestIds.has(rawId))
      throw new Error('Sequence relationship references an unknown portable entity.');
    return scopedProjectionId(scope, rawId);
  });
}

type NativeStoredSequenceRef = Record<string, unknown> & {
  mode: 'file';
  topology: 'linear' | 'circular';
  documentId?: string;
};

function requireNativeStoredSequenceRef(
  fields: Record<string, unknown>,
  reviewed: boolean
): NativeStoredSequenceRef {
  const sequence = fields.sequence;
  if (
    !sequence ||
    typeof sequence !== 'object' ||
    !('mode' in sequence) ||
    sequence.mode !== 'file' ||
    (reviewed && (!('documentId' in sequence) || typeof sequence.documentId !== 'string')) ||
    !('topology' in sequence) ||
    (sequence.topology !== 'linear' && sequence.topology !== 'circular')
  ) {
    throw new Error('Reviewed classification has an invalid file sequence reference.');
  }
  return sequence as NativeStoredSequenceRef;
}

function parseNativeSequenceRecord(
  content: string | Buffer,
  path: string,
  fallbackTopology: NativeStoredSequenceRef['topology'],
  decision: SequenceClassificationDecision | null,
  molecule: SequenceMolecule
): { sequence: string; circular: boolean } {
  const records = parseSequenceFile(content, { filename: basename(path) });
  if (records.length !== 1)
    throw new Error('Reviewed sequence file must contain exactly one record.');
  const record = records[0];
  const circular =
    record.format === 'genbank' || record.format === 'snapgene'
      ? record.metadata?.circular === true
      : fallbackTopology === 'circular';
  if (
    !record.sequence ||
    (decision !== null && !/^[ACGTURYSWKMBDHVN]+$/iu.test(record.sequence)) ||
    (decision?.choice.kind === 'classify' && circular)
  ) {
    throw new Error('Reviewed oligo requires a nonempty linear nucleotide sequence.');
  }
  const declared =
    typeof content === 'string'
      ? /^LOCUS\s+.*\b(?:bp|aa)\s+(DNA|RNA)\b/imu.exec(content)?.[1].toLowerCase()
      : undefined;
  if (
    decision !== null &&
    ((declared && declared !== molecule) ||
      (molecule === 'dna' && /U/iu.test(record.sequence)) ||
      (molecule === 'rna' && /T/iu.test(record.sequence)))
  ) {
    throw new Error('Reviewed classification and sequence file molecule disagree.');
  }
  return { sequence: record.sequence, circular };
}

type ReconstructNativeSequenceFieldsArgs = {
  lims: NativeFileSequenceLims;
  decision: SequenceClassificationDecision | null;
  existing: LimsEntity | null;
  manifestIds: ReadonlySet<string>;
  scope: ReturnType<typeof workspaceScopeKey>;
  bytes: Buffer | null;
  path: string;
  hash: string | null;
  molecule: SequenceMolecule;
  id: string;
};

function reconstructNativeSequenceFields({
  lims,
  decision,
  existing,
  manifestIds,
  scope,
  bytes,
  path,
  hash,
  molecule,
  id,
}: ReconstructNativeSequenceFieldsArgs): Record<string, unknown> {
  const ownedFields = mapNativeSequenceOwnedFields(lims, decision, existing, manifestIds, scope);
  if (bytes === null && existing) {
    if (existing.kind !== lims.kind)
      throw new Error('Missing sequence file prevents reconstructing a changed classification.');
    return {
      ...ownedFields,
      sequence: existing.fields.sequence,
    };
  }
  if (bytes === null) throw new Error('Sequence bytes are unavailable.');
  const storedRef = requireNativeStoredSequenceRef(lims.fields, decision !== null);
  const content = path.toLowerCase().endsWith('.dna') ? bytes : bytes.toString('utf8');
  const parsed = parseNativeSequenceRecord(content, path, storedRef.topology, decision, molecule);
  const ref = Object.fromEntries(Object.entries(storedRef).filter(([key]) => key !== 'pathBase'));
  return {
    ...ownedFields,
    sequence: {
      ...ref,
      mode: 'file',
      documentId: id,

      sequenceId: null,
      relPath: path,
      length: parsed.sequence.length,
      topology: parsed.circular ? 'circular' : 'linear',
      contentHash: hash,
      fileContentHash: hash,
      normalizedSequenceHash: sha(parsed.sequence.toUpperCase()),
      sourceFormat: sourceFormatForPath(path),
    },
  };
}

type UpsertReconstructedNativeSequenceArgs = {
  db: Database.Database;
  workspaceId: number;
  portable: NativeFileSequence;
  lims: NativeFileSequenceLims;
  decision: SequenceClassificationDecision | null;
  existing: LimsEntity | null;
  fields: Record<string, unknown>;
  archived: boolean;
  id: string;
  now: number;
};

function upsertReconstructedNativeSequenceInsideTx({
  db,
  workspaceId,
  portable,
  lims,
  decision,
  existing,
  fields,
  archived,
  id,
  now,
}: UpsertReconstructedNativeSequenceArgs): void {
  const preserveExistingClassification = decision === null && existing !== null;
  const schema = resolveSchemaRevisionForKind(
    db,
    lims.kind,
    preserveExistingClassification ? existing.schemaRevisionId : lims.schemaRevisionId
  );
  const { incomplete } = assertEntityValid(lims.kind, fields, schema.fieldsJson);
  const manifestState = {
    kind: lims.kind,
    schemaId: schema.schemaId,
    schemaRevisionId: schema.revisionId,
    name: lims.name,
    fields,
    registrationStatus:
      existing === null && incomplete.length > 0
        ? ('unresolved' as const)
        : (lims.registrationStatus ?? 'registered'),
    domainStatus: lims.domainStatus ?? null,
    workspaceId,
    tombstone: archived,
    archivedAt: portable.lifecycle?.state === 'archived' ? portable.lifecycle.archivedAt : null,
  };
  const state = preserveExistingClassification
    ? {
        ...manifestState,
        name: existing.name,
        registrationStatus: existing.registrationStatus,
        domainStatus: existing.domainStatus,
        tombstone: existing.tombstone,
        archivedAt: existing.archivedAt,
      }
    : manifestState;
  if (
    existing &&
    Object.entries(state).every(([key, value]) =>
      isDeepStrictEqual(existing[key as keyof LimsEntity], value)
    )
  )
    return;
  const after: LimsEntity = {
    ...state,
    id,
    registryId: existing ? existing.registryId : allocateRegistryIdInsideTx(db, lims.kind, now),
    createdAt: existing?.createdAt ?? lims.createdAt ?? now,
    updatedAt: now,
    eventSeq: nextEventSeq(db),
    actor: 'workspace-reconcile',
  };
  assertActiveFileSequenceOwnerIsUnique(db, after);
  insertAuditEvent(db, {
    eventSeq: after.eventSeq ?? undefined,
    eventType: existing ? 'entity_updated' : 'entity_registered',
    subjectTable: 'lims_entity',
    subjectId: id,
    workspaceId,
    actor: after.actor,
    before: existing,
    after,
  });
  upsertLimsEntityProjectionInsideTx(db, after);
}

function reconcileNativeFileSequenceInsideTx({
  db,
  root,
  workspace,
  portable,
  scope,
  manifestIds,
  fileChecks,
}: ReconcileNativeFileSequenceArgs): void {
  const decision =
    portable.metadata?.classificationDecision === undefined
      ? null
      : parseSequenceClassificationDecision(portable.metadata.classificationDecision);
  const { lims } = portable;
  if (decision && !lims.schemaSnapshot)
    throw new Error('Reviewed classification requires a pinned file sequence.');
  const molecule = decision?.molecule ?? (lims.kind === 'rna_sequence' ? 'rna' : 'dna');
  const fileLimit = decision ? 16 * 1024 * 1024 : HARD_CAP_BYTES;
  const id = scopedProjectionId(scope, portable.id);
  const path = join(root, portable.placement.relativePath);
  const { bytes, hash } = captureNativeSequenceFile(root, path, fileLimit, fileChecks);
  const { archived, now } = reconcileNativeSequenceCatalogInsideTx({
    db,
    workspaceId: workspace.id,
    portable,
    decision,
    id,
    path,
    bytes,
    hash,
  });
  const existing = loadExistingNativeSequenceInsideTx({
    db,
    workspaceId: workspace.id,
    lims,
    id,
    molecule,
    decision,
  });

  if (bytes === null && !existing) return;
  const fields = reconstructNativeSequenceFields({
    lims,
    decision,
    existing,
    manifestIds,
    scope,
    bytes,
    path,
    hash,
    molecule,
    id,
  });
  upsertReconstructedNativeSequenceInsideTx({
    db,
    workspaceId: workspace.id,
    portable,
    lims,
    decision,
    existing,
    fields,
    archived,
    id,
    now,
  });
}

function sha(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

type NativeManifestLimsLink = NonNullable<NativeWorkspaceManifestV2['limsLinks']>[number];
type NativeSequenceLinkWorkspace = { id: number; repo_uuid: string | null; path: string };

function isNativeSequenceLinkCandidate(
  link: NativeManifestLimsLink,
  records: ReadonlySet<string>,
  atomic: ReadonlySet<string>
): boolean {
  return (
    !records.has(link.fromEntityId) &&
    !records.has(link.toEntityId) &&
    (atomic.has(link.fromEntityId) || atomic.has(link.toEntityId))
  );
}

function recoverNativeSequenceLinkFromAuditInsideTx(
  db: Database.Database,
  workspaceId: number,
  requestedId: string,
  fromEntityId: string,
  toEntityId: string,
  type: string
): LimsLinkRow | undefined {
  const owners = db
    .prepare(
      `SELECT DISTINCT subject_id FROM lims_audit
        WHERE subject_table='lims_link' AND workspace_id=? AND
        (subject_id=? OR (json_extract(after,'$.fromEntityId')=? AND json_extract(after,'$.toEntityId')=? AND json_extract(after,'$.type')=?))`
    )
    .all(workspaceId, requestedId, fromEntityId, toEntityId, type) as Array<{
    subject_id: string;
  }>;
  if (owners.length > 1)
    throw new Error('Sequence relationship history has conflicting identities.');
  if (!owners[0]) return undefined;
  const history = db
    .prepare(
      "SELECT * FROM lims_audit WHERE subject_table='lims_link' AND subject_id=? ORDER BY event_seq"
    )
    .all(owners[0].subject_id) as LimsAuditRow[];
  replayAuditRowsIntoProjection(db, history);
  const row = db.prepare('SELECT * FROM lims_link WHERE id=?').get(owners[0].subject_id) as
    | LimsLinkRow
    | undefined;
  if (
    !row ||
    row.from_entity_id !== fromEntityId ||
    row.to_entity_id !== toEntityId ||
    row.type !== type
  )
    throw new Error('Sequence relationship history does not match its declared endpoints.');
  if (
    !row.tombstone &&
    LINEAGE_RELATIONSHIP_TYPES.has(row.type) &&
    wouldCreateRelationshipCycle(db, row.from_entity_id, row.to_entity_id, row.type)
  )
    throw new Error('Recovered sequence relationship creates a cycle.');
  return row;
}

function insertNativeSequenceLinkInsideTx(
  db: Database.Database,
  workspaceId: number,
  link: NativeManifestLimsLink,
  requestedId: string,
  fromEntityId: string,
  toEntityId: string
): void {
  assertRelationshipTypeExists(db, link.type);
  if (
    LINEAGE_RELATIONSHIP_TYPES.has(link.type) &&
    wouldCreateRelationshipCycle(db, fromEntityId, toEntityId, link.type)
  )
    throw new Error('Sequence relationship creates a cycle.');
  const now = Date.now();
  const after: LimsLink = {
    id: requestedId,
    fromEntityId,
    toEntityId,
    type: link.type,
    payload: link.payload ?? {},
    workspaceId,
    actor: 'workspace-reconcile',
    eventSeq: nextEventSeq(db),
    tombstone: false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  insertAuditEvent(db, {
    eventSeq: after.eventSeq ?? undefined,
    eventType: 'link_created',
    subjectTable: 'lims_link',
    subjectId: requestedId,
    workspaceId,
    actor: after.actor,
    before: null,
    after,
  });
  upsertLimsLinkProjectionInsideTx(db, after);
}

type ReconcileNativeSequenceLinkArgs = {
  db: Database.Database;
  workspace: NativeSequenceLinkWorkspace;
  link: NativeManifestLimsLink;
  scope: ReturnType<typeof workspaceScopeKey>;
  portableById: ReadonlyMap<string, NativeWorkspaceManifestV2['entities'][number]>;
};

function reconcileNativeSequenceLinkInsideTx({
  db,
  workspace,
  link,
  scope,
  portableById,
}: ReconcileNativeSequenceLinkArgs): void {
  const fromEntityId = scopedProjectionId(scope, link.fromEntityId);
  const toEntityId = scopedProjectionId(scope, link.toEntityId);
  if (fromEntityId === toEntityId) throw new Error('Sequence links cannot point to themselves.');
  const fromPresent = nativeLimsEndpointPresent(
    db,
    workspace,
    portableById.get(link.fromEntityId),
    fromEntityId
  );
  const toPresent = nativeLimsEndpointPresent(
    db,
    workspace,
    portableById.get(link.toEntityId),
    toEntityId
  );

  if (!fromPresent || !toPresent) return;
  const requestedId = scopedProjectionId(scope, link.id);
  const claimed = db
    .prepare('SELECT from_entity_id,to_entity_id,type FROM lims_link WHERE id=?')
    .get(requestedId) as { from_entity_id: string; to_entity_id: string; type: string } | undefined;
  if (
    claimed &&
    (claimed.from_entity_id !== fromEntityId ||
      claimed.to_entity_id !== toEntityId ||
      claimed.type !== link.type)
  )
    throw new Error('Sequence relationship identity collision.');
  const row =
    (db
      .prepare('SELECT * FROM lims_link WHERE from_entity_id=? AND to_entity_id=? AND type=?')
      .get(fromEntityId, toEntityId, link.type) as LimsLinkRow | undefined) ??
    recoverNativeSequenceLinkFromAuditInsideTx(
      db,
      workspace.id,
      requestedId,
      fromEntityId,
      toEntityId,
      link.type
    );

  if (row) {
    if (row.workspace_id !== workspace.id)
      throw new Error('Sequence relationship belongs to another workspace.');
    return;
  }
  insertNativeSequenceLinkInsideTx(db, workspace.id, link, requestedId, fromEntityId, toEntityId);
}

export function reconcileNativeSequenceLinksInsideTx(
  db: Database.Database,
  workspace: NativeSequenceLinkWorkspace,
  manifest: NativeWorkspaceManifestV2
): void {
  if (!db.inTransaction) throw new Error('Sequence links require a transaction.');
  const scope = workspaceScopeKey(workspace.repo_uuid, workspace.id);
  const atomic = new Set(
    manifest.entities.filter(nativeWorkspaceUsesAtomicSequenceProjection).map((entity) => entity.id)
  );
  const records = new Set(
    manifest.entities.filter((entity) => entity.type === 'record').map((entity) => entity.id)
  );
  const portableById = new Map(manifest.entities.map((entity) => [entity.id, entity]));
  const accepted = acceptedScientificResourceIds(db, workspace.id);
  for (const link of manifest.limsLinks ?? []) {
    if (
      accepted.has(link.fromEntityId) ||
      accepted.has(link.toEntityId) ||
      accepted.has(scopedProjectionId(scope, link.fromEntityId)) ||
      accepted.has(scopedProjectionId(scope, link.toEntityId))
    )
      continue;
    if (!isNativeSequenceLinkCandidate(link, records, atomic)) continue;
    reconcileNativeSequenceLinkInsideTx({
      db,
      workspace,
      link,
      scope,
      portableById,
    });
  }
}
