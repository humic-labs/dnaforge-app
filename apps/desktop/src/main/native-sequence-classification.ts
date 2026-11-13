import { createHash } from 'node:crypto';
import { assertRegistryEntityWriteAllowed } from './registry-write-admission';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve, basename } from 'node:path';
import { parseSequenceFile } from '@waypoint/sequence-utils';
import { parseSequenceContent } from './lims-sequence-io';
import type Database from 'better-sqlite3';
import {
  LIMS_OLIGO_USES,
  limsEntityFromRow,
  parseLimsSchemaFields,
  type LimsEntity,
  type LimsUpdateEntityInput,
  type LimsRevertEntityResult,
} from '../shared/lims';
import {
  parseApplyOligoClassificationRequest,
  type AppliedOligoClassification,
  type ApplyOligoClassificationResult,
} from '../shared/oligo-classification';
import {
  serializeNativeWorkspaceManifest,
  parseNativeWorkspaceManifest,
  type NativeWorkspaceManifestEntityV2,
} from '../shared/native-workspace-manifest';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../shared/entity-schema';
import { parseLimsEntitySnapshot } from '../shared/lims-entity-snapshot';
import {
  nativeMutationRequestBytes,
  NATIVE_MUTATION_REQUEST_VERSION,
} from './native-mutation-request';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { readNativeCatalogPublicationBase } from './native-catalog-publication';
import {
  archiveLimsEntityInsideTx,
  restoreLimsEntityInsideTx,
  revertLimsEntityInsideTx,
} from './lims-entity-lifecycle';
import {
  classifyLimsSequenceInsideTx,
  getEntityRowById,
  getSchemaRevisionForEntity,
  insertAuditEvent,
  updateLimsEntityInsideTx,
} from './lims-engine-core';
import {
  loadNativeSequenceClassificationReview,
  readClassificationFile,
} from './native-sequence-classification-review';
import {
  enqueueNativeSequenceCatalogPublicationInsideTx,
  recoverNativeCatalogRecordPublications,
} from './native-catalog-record-mutations';

export async function applyNativeSequenceClassification(context: {
  db: Database.Database;
  runDatabase: <T>(operation: () => T) => T;
  input: unknown;
}): Promise<ApplyOligoClassificationResult> {
  const input = parseApplyOligoClassificationRequest(context.input);
  const { db, runDatabase } = context;
  runDatabase(() => assertRegistryEntityWriteAllowed(db, { id: input.entityId }));
  const requestHash = sha(JSON.stringify(input));
  const operationId = `sequence-classification:${input.requestId}`;
  const key = `sequence-classification-receipt:${input.requestId}`;
  const owner = runDatabase(() => {
    if (db.inTransaction) throw new Error('Classification cannot join an open transaction.');
    const entity = limsEntityFromRow(getEntityRowById(db, input.entityId));
    const row = db
      .prepare(
        'SELECT id,path FROM workspaces WHERE id=? AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .get(entity.workspaceId);
    if (
      !row ||
      typeof row !== 'object' ||
      !('id' in row) ||
      typeof row.id !== 'number' ||
      !('path' in row) ||
      typeof row.path !== 'string'
    )
      throw new Error('Classification requires an active owning workspace.');
    return { id: row.id, path: row.path };
  });
  const prior = runDatabase(() => {
    const row = db
      .prepare(
        "SELECT payload FROM lims_audit WHERE idempotency_key=? AND event_type='sequence_classification_decided'"
      )
      .get(key);
    if (!row) return null;
    if (typeof row !== 'object' || !('payload' in row) || typeof row.payload !== 'string')
      throw new Error('Classification receipt is invalid.');
    const value: unknown = JSON.parse(row.payload);
    if (
      !value ||
      typeof value !== 'object' ||
      !('requestHash' in value) ||
      value.requestHash !== requestHash ||
      !('workspaceId' in value) ||
      value.workspaceId !== owner.id ||
      !('result' in value)
    )
      throw new Error('Classification request identity was reused with a different request.');
    return parseReceipt(value.result, input.entityId, input.requestId);
  });
  await recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath: owner.path });
  if (prior) return prior;
  const result = runDatabase(() =>
    db.transaction((): ApplyOligoClassificationResult => {
      const loaded = loadNativeSequenceClassificationReview(db, input.entityId);
      if (loaded.status === 'unavailable') return { status: 'stale', review: loaded };
      if (loaded.review.reviewToken !== input.reviewToken)
        return { status: 'stale', review: loaded.review };
      const updated =
        input.choice.kind === 'classify'
          ? classifyLimsSequenceInsideTx(db, {
              entityId: input.entityId,
              expectedEventSeq: loaded.entity.eventSeq,
              use: input.choice.use,
              actor: 'local-user',
            })
          : loaded.entity;
      const decision = {
        schema: 'dnaforge.sequence-classification.v1',
        choice: input.choice,
        molecule: loaded.review.sequence.molecule,
        targetSourceId: loaded.review.targetSourceId,
        reviewedAt: Date.now(),
        actor: 'local-user',
        evidenceFingerprint: sha(
          JSON.stringify({ facts: loaded.review.evidence, limited: loaded.review.evidenceLimited })
        ),
        reviewedFileSha256: loaded.fileSha256,
      };
      const after: NativeWorkspaceManifestEntityV2 = {
        ...loaded.portable,
        metadata: { ...loaded.portable.metadata, classificationDecision: decision },
        lims: portableClassifiedSequence(db, loaded.portable, updated),
      };
      serializeNativeWorkspaceManifest({
        ...loaded.manifest,
        entities: loaded.manifest.entities.map((entity) =>
          entity.id === after.id ? after : entity
        ),
      });
      const metadataRow = db
        .prepare('SELECT metadata FROM catalog_entities WHERE id=?')
        .get(input.entityId);
      if (
        !metadataRow ||
        typeof metadataRow !== 'object' ||
        !('metadata' in metadataRow) ||
        (metadataRow.metadata !== null && typeof metadataRow.metadata !== 'string')
      )
        throw new Error('Classification catalog metadata is invalid.');
      const raw: unknown = JSON.parse(metadataRow.metadata ?? '{}');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Classification catalog metadata is invalid.');
      db.prepare('UPDATE catalog_entities SET metadata=?,updated_at=? WHERE id=?').run(
        JSON.stringify({ ...raw, classificationDecision: decision }),
        Date.now(),
        input.entityId
      );
      const kind =
        input.choice.kind === 'keep_generic'
          ? loaded.review.currentKind
          : loaded.review.sequence.molecule === 'rna'
            ? 'rna_oligo'
            : 'oligo';
      const result: AppliedOligoClassification = {
        status: 'applied',
        entityId: input.entityId,
        requestId: input.requestId,
        kind,
        use: input.choice.kind === 'classify' ? input.choice.use : null,
      };
      enqueueNativeSequenceCatalogPublicationInsideTx({
        db,
        operationId,
        workspaceId: owner.id,
        entityId: input.entityId,
        requestHash,
        beforeEntity: loaded.portable,
        afterEntity: after,
      });
      insertAuditEvent(db, {
        eventType: 'sequence_classification_decided',
        subjectTable: 'lims_entity',
        subjectId: input.entityId,
        workspaceId: owner.id,
        actor: 'local-user',
        operationId,
        idempotencyKey: key,
        payload: {
          schema: 'dnaforge.sequence-classification-receipt.v1',
          requestHash,
          workspaceId: owner.id,
          result,
          decision,
        },
      });
      return result;
    })()
  );
  if (result.status === 'applied')
    await recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath: owner.path });
  return result;
}

export async function mutateNativeCatalogSequence(context: {
  db: Database.Database;
  runDatabase: <T>(operation: () => T) => T;
  action: 'update' | 'archive' | 'restore' | 'revert';
  input: LimsUpdateEntityInput & { operationId: string; expectedEventSeq: number };
}): Promise<LimsRevertEntityResult> {
  const { db, runDatabase, input, action } = context;
  if (
    !input.operationId ||
    input.operationId.length > 200 ||
    !Number.isSafeInteger(input.expectedEventSeq)
  )
    throw new Error('Sequence changes require an operation identity and edit version.');
  runDatabase(() => assertRegistryEntityWriteAllowed(db, input));
  const operationId = `native-sequence-edit:${input.operationId}`;
  const key = `native-sequence-edit-receipt:${input.operationId}`;
  const request = { action, input };
  const requestHash = sha(nativeMutationRequestBytes(request, NATIVE_MUTATION_REQUEST_VERSION));
  const owner = runDatabase(() => {
    const row = db
      .prepare(
        "SELECT w.id,w.path,w.repo_uuid FROM workspaces w JOIN catalog_entities c ON c.workspace_id=w.id JOIN lims_entity l ON l.id=c.id AND l.workspace_id=w.id WHERE c.id=? AND c.type='sequence'"
      )
      .get(input.id);
    if (
      !row ||
      typeof row !== 'object' ||
      !('id' in row) ||
      typeof row.id !== 'number' ||
      !('path' in row) ||
      typeof row.path !== 'string' ||
      !('repo_uuid' in row) ||
      (row.repo_uuid !== null && typeof row.repo_uuid !== 'string')
    )
      throw new Error('Native sequence owner is missing.');
    return { id: row.id, path: row.path, scope: workspaceScopeKey(row.repo_uuid, row.id) };
  });
  const prior = runDatabase(() => {
    const row = db
      .prepare(
        "SELECT payload FROM lims_audit WHERE idempotency_key=? AND event_type='native_sequence_changed'"
      )
      .get(key);
    if (!row) return null;
    if (typeof row !== 'object' || !('payload' in row) || typeof row.payload !== 'string')
      throw new Error('Native sequence receipt is invalid.');
    const receipt: unknown = JSON.parse(row.payload);
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      !('requestHash' in receipt) ||
      receipt.requestHash !==
        sha(
          nativeMutationRequestBytes(
            request,
            'requestHashVersion' in receipt ? receipt.requestHashVersion : undefined
          )
        ) ||
      !('result' in receipt) ||
      !receipt.result ||
      typeof receipt.result !== 'object' ||
      !('entity' in receipt.result) ||
      !('reverted' in receipt.result) ||
      typeof receipt.result.reverted !== 'boolean'
    )
      throw new Error('Native sequence operation was reused with a different request.');
    const entity = parseLimsEntitySnapshot(receipt.result.entity);
    if (entity.id !== input.id || entity.workspaceId !== owner.id)
      throw new Error('Native sequence receipt identity changed.');
    return {
      entity,
      reverted: receipt.result.reverted,
      ...(action === 'revert' && !receipt.result.reverted
        ? { reason: 'no-prior-edit' as const }
        : {}),
    };
  });
  await recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath: owner.path });
  if (prior) return prior;
  const bytes = await readNativeCatalogPublicationBase({ workspacePath: owner.path, operationId });
  if (!bytes) throw new Error('Native sequence catalog is missing.');
  const manifest = parseNativeWorkspaceManifest(bytes.toString('utf8'));
  if (manifest.schema !== 'dnaforge.native-workspace-manifest.v2')
    throw new Error('Native sequence requires a v2 catalog.');
  const before = manifest.entities.find(
    (entity) => scopedProjectionId(owner.scope, entity.id) === input.id
  );
  if (
    !before ||
    before.type !== 'sequence' ||
    before.placement.kind !== 'file' ||
    !before.lims ||
    !before.metadata?.classificationDecision
  )
    throw new Error('Native sequence has no reviewed catalog classification.');
  const beforeLims = before.lims;
  const beforeMetadata = before.metadata;
  const result = runDatabase(() =>
    db.transaction(() => {
      const current = limsEntityFromRow(getEntityRowById(db, input.id));
      if (current.eventSeq !== input.expectedEventSeq)
        throw new Error('Native sequence changed since this editor opened.');
      if (input.workspaceId !== undefined && input.workspaceId !== owner.id)
        throw new Error('Classification edits cannot move a sequence outside its workspace.');
      const withoutSequence = (fields: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'sequence'));
      const projected = portableClassifiedSequence(db, before, current);
      const expected = {
        ...beforeLims,
        schemaRevisionId: beforeLims.schemaRevisionId ?? projected.schemaRevisionId,
        schemaSnapshot: beforeLims.schemaSnapshot ?? projected.schemaSnapshot,
        registrationStatus: beforeLims.registrationStatus ?? 'registered',
        domainStatus: beforeLims.domainStatus ?? null,
      };
      if (
        !isDeepStrictEqual(
          { ...projected, fields: withoutSequence(projected.fields) },
          { ...expected, fields: withoutSequence(expected.fields) }
        ) ||
        current.tombstone !== (before.lifecycle?.state === 'archived') ||
        current.archivedAt !==
          (before.lifecycle?.state === 'archived' ? before.lifecycle.archivedAt : null)
      )
        throw new Error(
          'Native sequence and portable catalog disagree. Preserve the changed version before editing.'
        );
      if (action === 'update' && current.tombstone)
        throw new Error('Restore an archived sequence before editing.');
      const entity =
        action === 'update'
          ? updateLimsEntityInsideTx(db, input)
          : action === 'archive'
            ? archiveLimsEntityInsideTx(db, input)
            : action === 'restore'
              ? restoreLimsEntityInsideTx(db, input).entity
              : revertLimsEntityInsideTx(db, input, { preserveSequenceReference: true }).entity;
      if (
        entity.workspaceId !== owner.id ||
        !['dna_sequence', 'rna_sequence', 'oligo', 'rna_oligo'].includes(entity.kind) ||
        sequenceMolecule(entity.kind) !== sequenceMolecule(current.kind)
      )
        throw new Error('Native sequence history changed its owner or molecule kind.');
      assertSequenceFileAuthority(owner.path, before, current, entity);
      const generic = entity.kind === 'dna_sequence' || entity.kind === 'rna_sequence';
      const use = LIMS_OLIGO_USES.find((use) => use === entity.fields.use) ?? null;
      const decision = beforeMetadata.classificationDecision;
      if (!decision || typeof decision !== 'object' || Array.isArray(decision))
        throw new Error('Saved classification decision is invalid.');
      const after: NativeWorkspaceManifestEntityV2 = {
        ...before,
        name: entity.name,
        lims: portableClassifiedSequence(db, before, entity),
        lifecycle: entity.tombstone
          ? { state: 'archived', archivedAt: entity.archivedAt ?? Date.now() }
          : { state: 'active' },
        metadata: {
          ...before.metadata,
          classificationDecision: {
            ...decision,
            choice: generic ? { kind: 'keep_generic' } : { kind: 'classify', use },
          },
        },
      };
      serializeNativeWorkspaceManifest({
        ...manifest,
        entities: manifest.entities.map((value) => (value.id === after.id ? after : value)),
      });
      const row = db.prepare('SELECT metadata FROM catalog_entities WHERE id=?').get(input.id);
      const metadata =
        row && typeof row === 'object' && 'metadata' in row && typeof row.metadata === 'string'
          ? JSON.parse(row.metadata)
          : {};
      db.prepare(
        'UPDATE catalog_entities SET metadata=?,name=?,status=?,updated_at=? WHERE id=?'
      ).run(
        JSON.stringify({
          ...metadata,
          classificationDecision: after.metadata?.classificationDecision,
        }),
        entity.name,
        entity.tombstone ? 'archived' : 'active',
        Date.now(),
        entity.id
      );
      const reverted = entity.eventSeq !== current.eventSeq;
      const result: LimsRevertEntityResult = {
        entity,
        reverted,
        ...(action === 'revert' && !reverted ? { reason: 'no-prior-edit' as const } : {}),
      };
      enqueueNativeSequenceCatalogPublicationInsideTx({
        db,
        operationId,
        workspaceId: owner.id,
        entityId: entity.id,
        requestHash,
        beforeEntity: before,
        afterEntity: after,
      });
      insertAuditEvent(db, {
        eventType: 'native_sequence_changed',
        subjectTable: 'lims_entity',
        subjectId: entity.id,
        workspaceId: owner.id,
        actor: entity.actor,
        operationId,
        idempotencyKey: key,
        payload: { requestHash, requestHashVersion: NATIVE_MUTATION_REQUEST_VERSION, result },
      });
      return result;
    })()
  );
  await recoverNativeCatalogRecordPublications({ db, runDatabase, workspacePath: owner.path });
  return result;
}

function portableClassifiedSequence(
  db: Database.Database,
  before: NativeWorkspaceManifestEntityV2,
  entity: LimsEntity
) {
  if (before.placement.kind !== 'file' || !before.lims)
    throw new Error('Classification requires a portable sequence file.');
  const sequence = entity.fields.sequence;
  if (!sequence || typeof sequence !== 'object')
    throw new Error('Classified sequence reference is missing.');
  const schema = getSchemaRevisionForEntity(db, getEntityRowById(db, entity.id));
  const definition = parseLimsSchemaFields(schema.fieldsJson);
  const details = db
    .prepare(
      `SELECT s.display_name,s.description,r.version FROM lims_schema_revision r JOIN lims_schema s ON s.id=r.schema_id WHERE r.id=?`
    )
    .get(entity.schemaRevisionId);
  if (
    !details ||
    typeof details !== 'object' ||
    !('display_name' in details) ||
    typeof details.display_name !== 'string' ||
    !('version' in details) ||
    typeof details.version !== 'number' ||
    !('description' in details) ||
    (details.description !== null && typeof details.description !== 'string')
  )
    throw new Error('Classification schema revision is missing.');
  const schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot = {
    schemaId: schema.schemaId,
    schemaRevisionId: entity.schemaRevisionId,
    name: entity.kind,
    displayName: details.display_name,
    version: details.version,
    baseKind: entity.kind,
    ...(details.description === null ? {} : { description: details.description }),
    fields: definition.fields.map((field) => ({ ...field })),
  };
  return {
    ...before.lims,
    kind: entity.kind,
    name: entity.name,
    schemaRevisionId: entity.schemaRevisionId,
    schemaSnapshot,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
    fields: {
      ...entity.fields,
      sequence: { ...sequence, relPath: before.placement.relativePath, pathBase: 'workspace' },
    },
  };
}

function parseReceipt(
  value: unknown,
  entityId: string,
  requestId: string
): AppliedOligoClassification {
  if (
    !value ||
    typeof value !== 'object' ||
    !('status' in value) ||
    value.status !== 'applied' ||
    !('entityId' in value) ||
    value.entityId !== entityId ||
    !('requestId' in value) ||
    value.requestId !== requestId ||
    !('kind' in value) ||
    (value.kind !== 'dna_sequence' &&
      value.kind !== 'rna_sequence' &&
      value.kind !== 'oligo' &&
      value.kind !== 'rna_oligo') ||
    !('use' in value)
  )
    throw new Error('Classification receipt is invalid.');
  const storedUse = value.use;
  const use = storedUse === null ? null : LIMS_OLIGO_USES.find((use) => use === storedUse);
  if (use === undefined) throw new Error('Classification receipt use is invalid.');
  return { status: 'applied', entityId, requestId, kind: value.kind, use };
}
function sha(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sequenceMolecule(kind: string): 'dna' | 'rna' | null {
  return kind === 'dna_sequence' || kind === 'oligo'
    ? 'dna'
    : kind === 'rna_sequence' || kind === 'rna_oligo'
      ? 'rna'
      : null;
}
function assertSequenceFileAuthority(
  root: string,
  before: NativeWorkspaceManifestEntityV2,
  current: LimsEntity,
  after: LimsEntity
): void {
  const ref = after.fields.sequence,
    prior = current.fields.sequence;
  if (
    before.placement.kind !== 'file' ||
    !ref ||
    typeof ref !== 'object' ||
    !prior ||
    typeof prior !== 'object' ||
    !('mode' in ref) ||
    ref.mode !== 'file' ||
    !('relPath' in ref) ||
    typeof ref.relPath !== 'string' ||
    resolve(ref.relPath) !== resolve(root, before.placement.relativePath) ||
    !('documentId' in ref) ||
    !('documentId' in prior) ||
    ref.documentId !== prior.documentId ||
    !('topology' in ref) ||
    (ref.topology !== 'linear' && ref.topology !== 'circular')
  )
    throw new Error(
      'Registry changes must preserve the authoritative sequence file and document identity.'
    );
  const path = join(root, before.placement.relativePath);
  const bytes = readClassificationFile(root, path, 16 * 1024 * 1024);
  const content = path.toLowerCase().endsWith('.dna') ? bytes : bytes.toString('utf8');
  if (parseSequenceFile(content, { filename: basename(path) }).length !== 1)
    throw new Error('Sequence file must contain one record.');
  const parsed = parseSequenceContent(content, path, ref.topology);
  const rawHash = sha(bytes);
  if (
    !('length' in ref) ||
    ref.length !== parsed.sequence.length ||
    ref.topology !== (parsed.circular ? 'circular' : 'linear') ||
    !('contentHash' in ref) ||
    ref.contentHash !== rawHash ||
    ('fileContentHash' in ref && ref.fileContentHash !== rawHash) ||
    ('normalizedSequenceHash' in ref &&
      ref.normalizedSequenceHash !== sha(parsed.sequence.toUpperCase()))
  )
    throw new Error('Sequence file changed. Reopen the project to refresh its sequence reference.');
  const molecule = sequenceMolecule(after.kind);
  const declared =
    typeof content === 'string'
      ? /^LOCUS\s+.*\b(?:bp|aa)\s+(DNA|RNA)\b/imu.exec(content)?.[1].toLowerCase()
      : undefined;
  if ((declared && declared !== molecule) || (molecule === 'dna' && /U/iu.test(parsed.sequence)))
    throw new Error('Registry classification and sequence molecule disagree.');
}
