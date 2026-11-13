import { withUserMessage } from '@waypoint/user-messages';
import { getLimsEntityHistoryInDb } from './lims-entity-history';
export { getLimsEntityHistoryInDb, queryLimsEntitiesInDb, countLimsEntitiesByKindInDb };

import { upgradeLegacyRegistryArtifactForRenderer } from './ipc/registry-format-upgrade';
import { mutateEntityArtifact } from './entity-artifact-mutation';
import {
  assertFileBackedRegistryMutation,
  assertFileBackedRegistryRelationships,
  reconstructFileBackedRegistryEntity,
  reconstructFileBackedRegistryRelationships,
} from './file-backed-registry-mutation';
import { assertRegistryEntityWriteAllowed } from './registry-write-admission';
import {
  assertRegistrySemanticMutationAllowed,
  assertRegistryOutgoingAuthoringAllowed,
  registryMutationWorkspacePathsInDb,
  type RegistryMutationAdmission,
} from './registry-semantic-write-admission';
import { assertRelationshipSchemaSnapshotsMatchInDb } from './relationship-schema-snapshot';
import { reconstructLegacyAcceptedPlasmidForRenderer } from './ipc/legacy-accepted-plasmid-reconstruction';
import { replaceLimsOutgoingRelationshipsInsideTx } from './lims-relationship-projection';
import { limsContract } from '../shared/ipc/lims.contract';
import { handleGroup } from '../shared/ipc-contract';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { registerPrimerArtifactIpcHandlers } from './primer-artifact-ipc';
import {
  assertPrimerRegistryProjection,
  publishPrimerArtifactLifecycle,
} from './primer-artifact-mutations';
import { readOrgRegistryPublicationAdmissionInDb } from './org-registry-record-sync';
import { registeredSpecializedAuthority } from './org-registry-specialized-authority';
import {
  readCheckedManagedSequenceRegistrySnapshot,
  publishRegisteredSequenceLifecycleInMain,
} from './sequence-package-revision-publication';
import {
  readRegisteredRecordMutationAccount,
  settleDatabaseRegisteredRecordInTx,
} from './org-registry-local-mutations';

import { validateSequenceSchemaPropertyFields } from '../shared/sequence-entity-schema';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import { readNativeSequenceClassificationReview } from './native-sequence-classification-review';
import { registrySourceEligibilitySql } from './registry-source-eligibility';
import {
  applyNativeSequenceClassification,
  mutateNativeCatalogSequence,
} from './native-sequence-classification';
import {
  parseApplyOligoClassificationRequest,
  type ApplyOligoClassificationRequest,
} from '../shared/oligo-classification';
import { assertWorkspaceMigrationActionsSettled } from './workspace-migration-admission';
import {
  archiveLimsEntityInsideTx,
  restoreLimsEntityInsideTx,
  revertLimsEntityInsideTx,
} from './lims-entity-lifecycle';

import {
  hasEntityArtifactAuthority,
  assertEntityArtifactProjectionMatchesFile,
  undoImportBatchWithEntityArtifacts,
} from './entity-artifact-mutations';
import {
  seedLimsScenarioWithOwnedFixtures,
  assertLimsScenarioMutationAllowed,
} from './lims-scenario-seed';
import {
  getLimsRegistryPreviewInDb,
  queryLimsRegistrySummariesInDb,
  queryLimsEntitiesInDb,
  countLimsEntitiesByKindInDb,
} from './lims-registry-projection';

export { getLimsRegistryPreviewInDb, queryLimsRegistrySummariesInDb };
export {
  materializeLimsGitReadableExportInDb,
  materializeLimsGlobalRegistryExportInDb,
  readLimsAuditExportRowsFromWorkspace,
  type MaterializeLimsGitExportInput,
  type MaterializeLimsGitExportResult,
} from './lims-git-export';
import type Database from 'better-sqlite3';
import { getDb } from './ipc/database';
import {
  ownsAcceptedScientificEntity,
  readAcceptedScientificStrain,
} from './scientific-strain-authority';
import { actOnAcceptedScientificEntity } from './scientific-resource-lifecycle';
import {
  findKnownWorkspaceRoot,
  withKnownWorkspacePathsMutationAcrossWorkspaces,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from './ipc/workspace-mutation-capability';
import {
  type RendererDatabaseLifecycleSender,
  withRendererDatabaseRead,
  withRendererDatabaseStatement,
} from './workspace-sync-database-fence';
import { repairLimsEntityFromVerifiedAuditInDb } from './lims-projection-rebuild';
import { queryNativeRecordRelationshipTargets } from './native-record-relationship-targets';
import {
  recoverNativeCatalogRecordPublications,
  updateNativeCatalogRecord,
  actOnNativeCatalogRecord,
} from './native-catalog-record-mutations';
import {
  derivePendingRefsInDb,
  confirmPendingRefInDb,
  rejectPendingRefCandidateInDb,
  dismissPendingRefInDb,
  restorePendingRefInDb,
} from './lims-pending-refs';
import {
  limsEntityFromRow,
  parseLimsSchemaFields,
  serializeLimsSchemaDefinition,
  type DnaSequenceRef,
  type FileDnaSequenceRef,
  type LimsApplyImportBatchInput,
  type LimsApplyImportBatchResult,
  type LimsAttachGenomeHypothesisInput,
  type LimsAttachGenomeHypothesisResult,
  type LimsAttachVerifiedGenomeInput,
  type LimsAttachVerifiedGenomeResult,
  type LimsAuditRow,
  type LimsDefineSchemaInput,
  type LimsEntity,
  type LimsEntityRow,
  type LimsSetIdSchemeInput,
  type LimsBackfillRegistryIdsInput,
  type LimsLink,
  type LimsLinkEntitiesInput,
  type LimsReplaceOutgoingRelationshipsInput,
  type LimsReplaceOutgoingRelationshipsResult,
  type LimsPrimerUnionRow,
  type LimsQueryEntitiesInput,
  type LimsQueryRegistrySummariesInput,
  type LimsRecordStrainParentGenomeInput,
  type LimsRefineSchemaInput,
  type LimsRegistryPreviewInput,
  type LimsRecordRelationshipTargetQuery,
  type LimsRegisterEntityInput,
  type LimsRegistrationBadgeCandidate,
  type LimsRegistrationBadgeInput,
  type LimsRecordStrainParentGenomeResult,
  type LimsSchemaRow,
  type LimsSeedDemoDatasetInput,
  type LimsSeedMockDemoInput,
  type LimsSeedPracticeDemoInput,
  type LimsSeedStarterRegistryInput,
  type LimsStrainGenomeSummariesInput,
  type LimsStrainGenomeSummaryInput,
  type LimsTelemetryInput,
  type LimsUndoImportBatchInput,
  type LimsConfirmPendingRefInput,
  type LimsRejectPendingRefCandidateInput,
  type LimsPendingRefActionInput,
  type LimsUndoImportBatchResult,
  type LimsUpdateEntityInput,
  type LimsEntityActionInput,
  type LimsRevertEntityResult,
  type LimsEntityHistoryInput,
  type LimsSchemaRevisionRow,
  type LimsBackfillRegistryIdsResult,
} from '../shared/lims';

import {
  backfillLimsRegistryIdsInDb as backfillLimsRegistryIdsCoreInDb,
  defineLimsSchemaInsideTx,
  getEntityRowById,
  getLimsIdSchemesInDb,
  getSchemaById,
  listLimsEntitySchemasInDb,
  insertAuditEvent,
  linkLimsEntitiesOrExistingInsideTx,
  LOCAL_ACTOR,
  nextEventSeq,
  registerLimsEntityInsideTx,
  resetLimsRegistryInDb,
  seedLimsBuiltinsInDb,
  setLimsIdSchemeInDb,
  updateLimsEntityInsideTx,
  upsertLimsSchemaProjectionInsideTx,
  upsertLimsSchemaRevisionProjectionInsideTx,
  validateSchemaInput,
} from './lims-engine-core';

export { relocateLimsEntityFileRefsInDb } from './lims-engine-core';

export {
  seedLimsBuiltinsInDb,
  getLimsIdSchemesInDb,
  listLimsEntitySchemasInDb,
  setLimsIdSchemeInDb,
  resetLimsRegistryInDb,
};
import {
  attachGenomeHypothesisInDb as attachGenomeHypothesisCoreInDb,
  attachVerifiedLimsGenomeInDb as attachVerifiedLimsGenomeCoreInDb,
  getLimsStrainGenomeSummariesInDb,
  getLimsStrainGenomeSummaryInDb,
  recordLimsStrainParentGenomeInDb as recordLimsStrainParentGenomeCoreInDb,
} from './lims-strain-genome';
import { assertLimsSafetyNotQuarantined } from './lims-safety-quarantine';

export { getLimsStrainGenomeSummariesInDb, getLimsStrainGenomeSummaryInDb };
import {
  seedLimsDemoDatasetInDb,
  seedLimsMockDemoInDb,
  seedLimsPracticeDemoInDb,
  seedLimsStarterRegistryInDb,
} from './lims-demo-seed';

export {
  seedLimsDemoDatasetInDb,
  seedLimsMockDemoInDb,
  seedLimsPracticeDemoInDb,
  seedLimsStarterRegistryInDb,
};
import {
  materializeLimsGitExportForAllEntityWorkspaces,
  materializeLimsGitExportForBatchId,
  materializeLimsGitExportForLinks,
  materializeLimsGitExportForWorkspaceIds,
  materializeLimsGlobalRegistryExportForProfile,
} from './lims-export-sync';
import {
  applyLimsImportBatchInDb as applyLimsImportBatchCoreInDb,
  undoLimsImportBatchInDb as undoLimsImportBatchCoreInDb,
  shouldApplyImportRecord,
  withImportSourceMetadata,
  resolveImportLinkEndpoint,
} from './lims-import';

export function backfillLimsRegistryIdsInDb(
  db: Database.Database,
  input: LimsBackfillRegistryIdsInput
): LimsBackfillRegistryIdsResult {
  const result = backfillLimsRegistryIdsCoreInDb(db, input);
  materializeLimsGitExportForAllEntityWorkspaces(db);
  return result;
}

export function defineLimsSchemaInDb(
  db: Database.Database,
  input: LimsDefineSchemaInput
): LimsSchemaRow {
  const row = db.transaction(() => defineLimsSchemaInsideTx(db, input))();
  materializeLimsGitExportForWorkspaceIds(db, [row.workspace_id]);
  return row;
}

export function refineLimsSchemaInDb(
  db: Database.Database,
  input: LimsRefineSchemaInput
): LimsSchemaRow {
  const row = db.transaction(() => {
    const schema = getSchemaById(db, input.schemaId);
    const previousDefinition = parseLimsSchemaFields(schema.fields);
    validateSchemaInput(input.fields, previousDefinition.baseKind ?? schema.name);
    validateSequenceSchemaPropertyFields(input.fields, previousDefinition.baseKind ?? schema.name);
    if (
      input.expectedRevisionId &&
      input.expectedRevisionId !== (schema.current_revision_id ?? `${schema.id}-v${schema.version}`)
    ) {
      throw withUserMessage(
        new Error('Schema changed elsewhere. Reopen it before saving.'),
        'validation.compatible.41'
      );
    }
    const nextVersion = schema.version + 1;
    const revisionId = `${input.schemaId}-v${nextVersion}`;
    const seq = nextEventSeq(db);
    const now = Date.now();
    const fieldsJson = serializeLimsSchemaDefinition({
      fields: input.fields,
      relationship: previousDefinition.relationship,
      baseKind: previousDefinition.baseKind ?? schema.name,
    });
    const after: LimsSchemaRow = {
      ...schema,
      fields: fieldsJson,
      current_revision_id: revisionId,
      version: nextVersion,
      description: input.description === undefined ? schema.description : input.description,
      actor: input.actor ?? LOCAL_ACTOR,
      workspace_id: input.workspaceId ?? schema.workspace_id,
      event_seq: seq,
      updated_at: now,
    };
    const revisionRow: LimsSchemaRevisionRow = {
      id: revisionId,
      schema_id: input.schemaId,
      version: nextVersion,
      fields: fieldsJson,
      actor: input.actor ?? LOCAL_ACTOR,
      workspace_id: input.workspaceId ?? schema.workspace_id,
      event_seq: seq,
      tombstone: 0,
      created_at: now,
      archived_at: null,
    };
    insertAuditEvent(db, {
      eventSeq: seq,
      eventType: 'schema_refined',
      subjectTable: 'lims_schema',
      subjectId: input.schemaId,
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: input.workspaceId ?? schema.workspace_id,
      before: schema,
      after: { schema: after, revision: revisionRow },
    });
    upsertLimsSchemaProjectionInsideTx(db, after);
    upsertLimsSchemaRevisionProjectionInsideTx(db, revisionRow);
    return after;
  })();
  materializeLimsGitExportForWorkspaceIds(db, [row.workspace_id]);
  return row;
}

export function registerLimsEntityInDb(
  db: Database.Database,
  input: LimsRegisterEntityInput
): LimsEntity {
  seedLimsBuiltinsInDb(db);
  const entity = db.transaction(() => registerLimsEntityInsideTx(db, input))();
  materializeLimsGitExportForWorkspaceIds(db, [entity.workspaceId]);
  return entity;
}

export function repairLimsEntityProjectionFromAuditInDb(
  db: Database.Database,
  entityId: string
): boolean {
  if (db.prepare(`SELECT 1 FROM lims_entity WHERE id = ? LIMIT 1`).get(entityId)) return true;
  const hasAudit = db
    .prepare(
      `SELECT 1 FROM lims_audit
       WHERE subject_table = 'lims_entity' AND subject_id = ?
       LIMIT 1`
    )
    .get(entityId);
  if (!hasAudit) return false;
  return repairLimsEntityFromVerifiedAuditInDb(db, entityId);
}

export function updateLimsEntityInDb(
  db: Database.Database,
  input: LimsUpdateEntityInput,
  accountId: string | null = null
): LimsEntity {
  seedLimsBuiltinsInDb(db);
  const { entity, previousWorkspaceId } = db.transaction(() => {
    const previousWorkspaceId = limsEntityFromRow(getEntityRowById(db, input.id)).workspaceId;
    const entity = updateLimsEntityInsideTx(db, input);
    settleDatabaseRegisteredRecordInTx(db, {
      entity,
      accountId,
      operationId: input.operationId ?? randomUUID(),
    });
    return { entity, previousWorkspaceId };
  })();
  materializeLimsGitExportForWorkspaceIds(db, [previousWorkspaceId, entity.workspaceId]);
  return entity;
}

export function revertLimsEntityInDb(
  db: Database.Database,
  input: LimsEntityActionInput,
  accountId: string | null = null
): LimsRevertEntityResult {
  seedLimsBuiltinsInDb(db);
  const result = db.transaction(() => {
    const result = revertLimsEntityInsideTx(db, input);
    if (result.reverted)
      settleDatabaseRegisteredRecordInTx(db, {
        entity: result.entity,
        accountId,
        operationId: input.operationId ?? randomUUID(),
      });
    return result;
  })();
  materializeLimsGitExportForWorkspaceIds(db, [result.entity.workspaceId]);
  return result;
}

export function archiveLimsEntityInDb(
  db: Database.Database,
  input: LimsEntityActionInput,
  accountId: string | null = null
): LimsEntity {
  seedLimsBuiltinsInDb(db);
  const entity = db.transaction(() => {
    const before = getEntityRowById(db, input.id);
    const entity = archiveLimsEntityInsideTx(db, input);
    if (entity.eventSeq !== before.event_seq)
      settleDatabaseRegisteredRecordInTx(db, {
        entity,
        accountId,
        operationId: input.operationId ?? randomUUID(),
      });
    return entity;
  })();
  materializeLimsGitExportForWorkspaceIds(db, [entity.workspaceId]);
  return entity;
}

export function restoreLimsEntityInDb(
  db: Database.Database,
  input: LimsEntityActionInput,
  accountId: string | null = null
): LimsEntity {
  seedLimsBuiltinsInDb(db);
  const entity = db.transaction(() => {
    const before = getEntityRowById(db, input.id);
    const entity = restoreLimsEntityInsideTx(db, input).entity;
    if (entity.eventSeq !== before.event_seq)
      settleDatabaseRegisteredRecordInTx(db, {
        entity,
        accountId,
        operationId: input.operationId ?? randomUUID(),
      });
    return entity;
  })();
  materializeLimsGitExportForWorkspaceIds(db, [entity.workspaceId]);
  return entity;
}

export function restoreVerifiedLimsEntitiesInDb(
  db: Database.Database,
  input: { ids: readonly string[]; actor: string }
): { restoredIds: string[] } {
  seedLimsBuiltinsInDb(db);
  const uniqueIds = [...new Set(input.ids)];
  const restored = db.transaction(() =>
    uniqueIds.map((id) => restoreLimsEntityInsideTx(db, { id, actor: input.actor }))
  )();
  const restoredEntities = restored.filter((result) => result.restored);
  materializeLimsGitExportForWorkspaceIds(
    db,
    restoredEntities.map((result) => result.entity.workspaceId)
  );
  return { restoredIds: restoredEntities.map((result) => result.entity.id) };
}
export function applyLimsImportBatchInDb(
  db: Database.Database,
  input: LimsApplyImportBatchInput
): LimsApplyImportBatchResult {
  const result = applyLimsImportBatchCoreInDb(db, input);
  materializeLimsGitExportForBatchId(db, result.batchId);
  materializeLimsGitExportForWorkspaceIds(
    db,
    input.records.map((record) => record.entity.workspaceId)
  );
  return result;
}

export function undoLimsImportBatchInDb(
  db: Database.Database,
  input: LimsUndoImportBatchInput
): LimsUndoImportBatchResult {
  const result = undoLimsImportBatchCoreInDb(db, input);
  materializeLimsGitExportForBatchId(db, input.batchId.trim());
  return result;
}

export function linkLimsEntitiesInDb(
  db: Database.Database,
  input: LimsLinkEntitiesInput
): LimsLink {
  const owner = input.type === 'carried_by' ? input.toEntityId : input.fromEntityId;
  if (
    ['carried_by', 'has_genome', 'derives_from'].includes(input.type) &&
    readAcceptedScientificStrain(db, owner)
  )
    throw new Error(
      'Open the strain and save its relationship with the captured scientific revision.'
    );
  seedLimsBuiltinsInDb(db);
  const link = db.transaction(() => linkLimsEntitiesOrExistingInsideTx(db, input))();
  materializeLimsGitExportForWorkspaceIds(db, [link.workspaceId]);
  return link;
}

export function replaceLimsOutgoingRelationshipsInDb(
  db: Database.Database,
  input: LimsReplaceOutgoingRelationshipsInput
): LimsReplaceOutgoingRelationshipsResult {
  if (readAcceptedScientificStrain(db, input.entityId))
    throw new Error('Open the strain and save its captured relationships.');
  seedLimsBuiltinsInDb(db);
  const result = db.transaction(() => replaceLimsOutgoingRelationshipsInsideTx(db, input))();
  materializeLimsGitExportForWorkspaceIds(db, [input.workspaceId ?? null]);
  return result;
}

export function getLimsRegistrationBadgeCandidatesInDb(
  db: Database.Database,
  input: LimsRegistrationBadgeInput
): LimsRegistrationBadgeCandidate[] {
  seedLimsBuiltinsInDb(db);
  const rows = db
    .prepare(
      `SELECT * FROM lims_entity
       WHERE tombstone = 0
         AND registration_status IN ('tracked', 'registered', 'drifted', 'unresolved')
         AND kind IN (
           'plasmid', 'genome', 'chromosome', 'oligo', 'dna_sequence', 'rna_sequence', 'sequence'
         )
       ORDER BY updated_at DESC, created_at DESC`
    )
    .all() as LimsEntityRow[];
  const candidates: LimsRegistrationBadgeCandidate[] = [];
  for (const row of rows) {
    const entity = limsEntityFromRow(row);
    const sequence = entity.fields.sequence;
    if (isFileDnaSequenceRef(sequence) && sequence.documentId === input.documentId) {
      candidates.push({
        entity,
        sequence: {
          sizeBytes: sequence.sizeBytes,
          modifiedAt: sequence.modifiedAt,
          contentHash: sequence.contentHash,
        },
      });
    }
  }
  return candidates;
}

function isFileDnaSequenceRef(value: unknown): value is FileDnaSequenceRef {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FileDnaSequenceRef>;
  return (
    candidate.mode === 'file' &&
    typeof candidate.documentId === 'string' &&
    typeof candidate.relPath === 'string' &&
    (candidate.topology === 'linear' || candidate.topology === 'circular')
  );
}

export function getAllLimsPrimersInDb(db: Database.Database): LimsPrimerUnionRow[] {
  seedLimsBuiltinsInDb(db);
  const limsRows = db
    .prepare(
      `SELECT * FROM lims_entity WHERE tombstone = 0 AND kind = 'oligo' AND ${registrySourceEligibilitySql(db)}`
    )
    .all() as LimsEntityRow[];
  const limsPrimers = limsRows
    .map(limsEntityFromRow)
    .filter((entity) => entity.fields.use === 'primer')
    .map((entity): LimsPrimerUnionRow | null => {
      const sequence = entity.fields.sequence as DnaSequenceRef | undefined;
      if (sequence?.mode !== 'inline') return null;
      return {
        id: `lims:${entity.id}`,
        source: 'lims',
        origin: typeof entity.fields.source === 'string' ? (entity.fields.source as string) : null,
        name: entity.name,
        sequence: sequence.bases,
        length: sequence.length,
        catalogNumber:
          typeof entity.fields.catalogNumber === 'string'
            ? (entity.fields.catalogNumber as string)
            : null,
        limsEntityId: entity.id,
        legacyPrimerId: null,
        status: typeof entity.fields.status === 'string' ? (entity.fields.status as string) : null,
        notes: typeof entity.fields.notes === 'string' ? (entity.fields.notes as string) : null,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
      };
    })
    .filter((row): row is LimsPrimerUnionRow => row !== null);

  const legacy = db
    .prepare(
      `SELECT id, catalog_number, name, sequence, length, origin, status, notes, created_at, updated_at
       FROM primers
       ORDER BY created_at DESC`
    )
    .all() as Array<{
    id: string;
    catalog_number: string | null;
    name: string;
    sequence: string;
    length: number;
    origin: string | null;
    status: string | null;
    notes: string | null;
    created_at: number;
    updated_at: number;
  }>;

  return [
    ...limsPrimers,
    ...legacy.map((row) => ({
      id: `legacy:${row.id}`,
      source: 'legacy_primers' as const,
      origin: row.origin,
      name: row.name,
      sequence: row.sequence,
      length: row.length,
      catalogNumber: row.catalog_number,
      limsEntityId: null,
      legacyPrimerId: row.id,
      status: row.status,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  ];
}

export function logLimsTelemetryInDb(
  db: Database.Database,
  input: LimsTelemetryInput
): LimsAuditRow {
  if (
    !['badge_consulted', 'import_accuracy_evaluated', 'register_consulted'].includes(
      input.eventType
    )
  )
    throw new Error('Registry telemetry cannot author semantic history events.');
  seedLimsBuiltinsInDb(db);
  const row = db.transaction(() =>
    insertAuditEvent(db, {
      eventType: input.eventType,
      subjectTable: input.subjectTable ?? null,
      subjectId: input.subjectId ?? null,
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: input.workspaceId ?? null,
      payload: input.payload ?? {},
    })
  )();
  materializeLimsGitExportForWorkspaceIds(db, [row.workspace_id]);
  return row;
}

export function recordLimsStrainParentGenomeInDb(
  db: Database.Database,
  input: LimsRecordStrainParentGenomeInput
): LimsRecordStrainParentGenomeResult {
  const result = recordLimsStrainParentGenomeCoreInDb(db, input);
  materializeLimsGitExportForWorkspaceIds(db, [result.link.workspaceId]);
  return result;
}

export function attachGenomeHypothesisInDb(
  db: Database.Database,
  input: LimsAttachGenomeHypothesisInput
): LimsAttachGenomeHypothesisResult {
  const result = attachGenomeHypothesisCoreInDb(db, input);
  materializeLimsGitExportForLinks(db, [
    result.hasGenomeLink,
    result.derivesFromLink,
    result.parentReferenceLink,
  ]);
  return result;
}

export function attachVerifiedLimsGenomeInDb(
  db: Database.Database,
  input: LimsAttachVerifiedGenomeInput
): LimsAttachVerifiedGenomeResult {
  const result = attachVerifiedLimsGenomeCoreInDb(db, input);
  materializeLimsGitExportForLinks(db, [result.hasGenomeLink, result.verifiedByLink]);
  return result;
}

export function registerLimsIpcHandlers(): void {
  handleGroup(limsContract, {
    reconstructLegacyAcceptedPlasmid: (event, input, mutationToken) =>
      reconstructLegacyAcceptedPlasmidForRenderer({
        db: getDb(),
        sender: event.sender,
        input,
        mutationToken,
      }),
    ensureSeeded: (event, mutationToken?: string) =>
      withLimsMutation(
        event.sender,
        null,
        { kind: 'maintenance', purpose: 'builtin-seeding' },
        seedLimsBuiltinsInDb,
        mutationToken
      ),
    listSchemas: (event) => withLimsRead(event.sender, listLimsEntitySchemasInDb),
    defineSchema: (event, input: LimsDefineSchemaInput) =>
      withLimsMutation(
        event.sender,
        input,
        { kind: 'schema', schemaId: input.id, workspaceId: input.workspaceId },
        (db) => defineLimsSchemaInDb(db, input)
      ),
    refineSchema: (event, input: LimsRefineSchemaInput) =>
      withLimsMutation(
        event.sender,
        input,
        { kind: 'schema', schemaId: input.schemaId, workspaceId: input.workspaceId },
        (db) => refineLimsSchemaInDb(db, input)
      ),
    registerEntity: (event, input: LimsRegisterEntityInput, mutationToken?: string) =>
      withLimsLease(
        event.sender,
        input,
        async (db, runDatabase) => {
          if (
            runDatabase(
              () => input.id && ownsAcceptedScientificEntity(db, input.id, input.workspaceId)
            )
          )
            throw new Error(
              'Open this scientific record and save its captured revision before changing the Registry.'
            );
          const projection = runDatabase(() =>
            assertPrimerRegistryProjection(db, input, 'register')
          );
          if (!projection) {
            const reconstructed = await reconstructFileBackedRegistryEntity(
              db,
              { action: 'register', input },
              runDatabase
            );
            if (reconstructed) return reconstructed;
          }
          return runDatabase(() => {
            if (!projection) assertRegistryEntityWriteAllowed(db, input);
            return registerLimsEntityInDb(db, input);
          });
        },
        mutationToken
      ),
    upgradeLegacyEntityArtifact: (event, input, mutationToken) =>
      upgradeLegacyRegistryArtifactForRenderer({
        db: getDb(),
        sender: event.sender,
        input,
        mutationToken,
      }),
    repairEntityProjectionFromAudit: (event, entityId: string, mutationToken?: string) =>
      withLimsMutation(
        event.sender,
        { entityId },
        { kind: 'maintenance', purpose: 'verified-audit-repair' },
        (db) => {
          if (ownsAcceptedScientificEntity(db, entityId))
            throw new Error(
              'Reopen this project to rebuild the Registry from its accepted records.'
            );
          return repairLimsEntityProjectionFromAuditInDb(db, entityId);
        },
        mutationToken
      ),
    updateEntity: (event, input: LimsUpdateEntityInput, mutationToken?: string) =>
      withLimsLease(
        event.sender,
        { entityId: input.id },
        async (db, runDatabase) => {
          if (runDatabase(() => ownsAcceptedScientificEntity(db, input.id)))
            throw new Error(
              'Open this scientific record and save its captured revision. Restore it first if it was removed.'
            );
          const specialized = runDatabase(() => registeredSpecializedAuthority(db, input.id));
          if (specialized === 'primer_artifact')
            throw new Error(
              'Edit this registered saved primer through its primer editor. Registry-only updates cannot publish its saved file.'
            );
          if (specialized === 'sequence_package')
            return checkedRegisteredSequenceProjection(db, runDatabase, input, mutationToken);
          if (runDatabase(() => hasEntityArtifactAuthority(db, input.id))) {
            if (input.actor === 'workspace-reconcile') {
              await assertEntityArtifactProjectionMatchesFile({
                db,
                runDatabase,
                action: 'update',
                input,
              });
              return runDatabase(() => updateLimsEntityInDb(db, input));
            }
            return (await mutateEntityArtifact({ db, runDatabase, action: 'update', input }))
              .entity;
          }
          if (runDatabase(() => hasReviewedNativeSequence(db, input.id))) {
            const systemRefresh =
              input.actor === 'workspace-reconcile' && mutationToken !== undefined;
            const expectedEventSeq =
              input.expectedEventSeq ??
              (systemRefresh ? runDatabase(() => getEntityRowById(db, input.id).event_seq) : null);
            const operationId = input.operationId ?? (systemRefresh ? randomUUID() : null);
            if (expectedEventSeq === null || !operationId)
              throw new Error(
                'Refresh this sequence before saving; its current edit version is required.'
              );
            return (
              await mutateNativeCatalogSequence({
                db,
                runDatabase,
                action: 'update',
                input: { ...input, expectedEventSeq, operationId },
              })
            ).entity;
          }
          const nativeRecord = runDatabase(() =>
            db
              .prepare(
                "SELECT 1 FROM catalog_entities c JOIN catalog_workspace_placements p ON p.entity_id = c.id WHERE c.id = ? AND c.type = 'record'"
              )
              .get(input.id)
          );
          if (!nativeRecord) {
            const projection = runDatabase(() =>
              assertPrimerRegistryProjection(db, input, 'update')
            );
            if (!projection) {
              const reconstructed = await reconstructFileBackedRegistryEntity(
                db,
                { action: 'update', input },
                runDatabase
              );
              if (reconstructed) return reconstructed;
            }
            const accountId = await readRegisteredRecordMutationAccount(db, [input.id], {
              runDatabase,
            });
            return runDatabase(() => {
              if (!projection) assertRegistryEntityWriteAllowed(db, input);
              return updateLimsEntityInDb(db, input, accountId);
            });
          }
          if (input.expectedEventSeq === undefined || !input.operationId)
            throw new Error(
              'Refresh this record before saving; its current edit version is required.'
            );
          return updateNativeCatalogRecord({
            db,
            runDatabase,
            input,
            expectedEventSeq: input.expectedEventSeq,
            operationId: input.operationId,
          });
        },
        mutationToken
      ),
    revertEntity: (event, input: LimsEntityActionInput) =>
      withLimsLifecycle(event.sender, input, 'revert'),
    archiveEntity: (event, input: LimsEntityActionInput, mutationToken?: string) =>
      withLimsLifecycle(event.sender, input, 'archive', mutationToken).then(
        (result) => result.entity
      ),
    restoreEntity: (event, input: LimsEntityActionInput, mutationToken?: string) =>
      withLimsLifecycle(event.sender, input, 'restore', mutationToken).then(
        (result) => result.entity
      ),
    replaceOutgoingRelationships: (
      event,
      input: LimsReplaceOutgoingRelationshipsInput,
      mutationToken?: string
    ) =>
      input.expectedEventSeq !== undefined || input.operationId !== undefined
        ? withLimsLease(
            event.sender,
            { entityId: input.entityId },
            async (db, runDatabase) => {
              const result = await mutateEntityArtifact({
                db,
                runDatabase,
                action: 'relationships',
                input: {
                  id: input.entityId,
                  expectedEventSeq: input.expectedEventSeq,
                  operationId: input.operationId,
                  actor: input.actor,
                  relationships: input.relationships,
                },
              });
              if (!result.relationships) throw new Error('Record relationship receipt is missing.');
              return result.relationships;
            },
            mutationToken
          )
        : withLimsAuthoringLease(
            event.sender,
            { entityId: input.entityId },
            { kind: 'relationship-projection', entityId: input.entityId },
            async (db, runDatabase) => {
              const reconstructed = await reconstructFileBackedRegistryRelationships(
                db,
                input,
                runDatabase
              );
              if (reconstructed) return reconstructed;
              return runDatabase(() => {
                assertRegistryOutgoingAuthoringAllowed(db, input.entityId, input.workspaceId);
                assertRelationshipSchemaSnapshotsMatchInDb(db, input.schemaSnapshots);
                return replaceLimsOutgoingRelationshipsInDb(db, input);
              });
            },
            mutationToken
          ),
    getEntityHistory: (event, input: LimsEntityHistoryInput) =>
      withLimsRead(event.sender, (db) => getLimsEntityHistoryInDb(db, input)),
    linkEntities: (event, input: LimsLinkEntitiesInput, mutationToken?: string) =>
      withLimsMutation(
        event.sender,
        input,
        { kind: 'outgoing', entityIds: [input.fromEntityId], workspaceId: input.workspaceId },
        (db) => linkLimsEntitiesInDb(db, input),
        mutationToken
      ),
    countEntitiesByKind: (event) => withLimsRead(event.sender, countLimsEntitiesByKindInDb),
    getRegistryPreview: (event, input: LimsRegistryPreviewInput) =>
      withLimsRead(event.sender, (db) => getLimsRegistryPreviewInDb(db, input)),
    getIdSchemes: (event) => withLimsRead(event.sender, getLimsIdSchemesInDb),
    setIdScheme: (event, input: LimsSetIdSchemeInput) =>
      withLimsMutation(
        event.sender,
        null,
        { kind: 'maintenance', purpose: 'global-id-scheme' },
        (db) => setLimsIdSchemeInDb(db, input)
      ),
    getStrainGenomeSummaries: (event, input: LimsStrainGenomeSummariesInput) =>
      withLimsRead(event.sender, (db) => getLimsStrainGenomeSummariesInDb(db, input)),
    applyImportBatch: async (event, input: LimsApplyImportBatchInput, mutationToken?: string) => {
      const result = await withLimsAuthoringLease(
        event.sender,
        input,
        { kind: 'import', input },
        async (db, runDatabase) => {
          await assertLimsImportCanonicalSources(db, input, runDatabase);
          return runDatabase(() => applyLimsImportBatchInDb(db, input));
        },
        mutationToken
      );

      try {
        const database = getDb();
        withRendererDatabaseStatement(database, event.sender, () =>
          materializeLimsGlobalRegistryExportForProfile(database)
        );
      } catch (err) {
        console.warn(`[LIMS] global registry export after import failed: ${String(err)}`);
      }
      return result;
    },
    undoImportBatch: (event, input: LimsUndoImportBatchInput) =>
      withLimsAuthoringLease(
        event.sender,
        input,
        { kind: 'undo-import', batchId: input.batchId },
        async (db, runDatabase) => {
          const result = await undoImportBatchWithEntityArtifacts({ db, runDatabase, input });
          runDatabase(() => materializeLimsGitExportForBatchId(db, input.batchId.trim()));
          return result;
        }
      ),
    pendingRefs: (event) => withLimsRead(event.sender, derivePendingRefsInDb),
    confirmPendingRef: (event, input: LimsConfirmPendingRefInput) => {
      return withLimsMutation(
        event.sender,
        input,
        { kind: 'pending', key: input.key, confirmsRelationship: true },
        (db) => confirmPendingRefInDb(db, input)
      );
    },
    rejectPendingRefCandidate: (event, input: LimsRejectPendingRefCandidateInput) => {
      return withLimsMutation(
        event.sender,
        input,
        { kind: 'pending', key: input.key, confirmsRelationship: false },
        (db) => rejectPendingRefCandidateInDb(db, input)
      );
    },
    dismissPendingRef: (event, input: LimsPendingRefActionInput) => {
      return withLimsMutation(
        event.sender,
        input,
        { kind: 'pending', key: input.key, confirmsRelationship: false },
        (db) => dismissPendingRefInDb(db, input)
      );
    },
    restorePendingRef: (event, input: LimsPendingRefActionInput) => {
      return withLimsMutation(
        event.sender,
        input,
        { kind: 'pending', key: input.key, confirmsRelationship: false },
        (db) => restorePendingRefInDb(db, input)
      );
    },
    getRegistrationBadgeCandidates: (event, input: LimsRegistrationBadgeInput) =>
      withLimsRead(event.sender, (db) => getLimsRegistrationBadgeCandidatesInDb(db, input)),
    getAllPrimers: (event) => withLimsRead(event.sender, getAllLimsPrimersInDb),
    resetRegistry: (event) => {
      assertLimsScenarioMutationAllowed('lims:resetRegistry');
      return withLimsMutation(
        event.sender,
        null,
        { kind: 'maintenance', purpose: 'disposable-scenario-reset' },
        resetLimsRegistryInDb
      );
    },
    recordStrainParentGenome: (event, input: LimsRecordStrainParentGenomeInput) =>
      withLimsMutation(
        event.sender,
        input,
        { kind: 'outgoing', entityIds: [input.strainEntityId] },
        (db) => recordLimsStrainParentGenomeInDb(db, input)
      ),
    attachGenomeHypothesis: (event, input: LimsAttachGenomeHypothesisInput) =>
      withLimsMutation(
        event.sender,
        input,
        {
          kind: 'outgoing',
          entityIds: [
            input.strainEntityId,
            ...(input.parentGenomeEntityId ? [input.hypothesisGenomeEntityId] : []),
          ],
        },
        (db) => attachGenomeHypothesisInDb(db, input)
      ),
    attachVerifiedGenome: (event, input: LimsAttachVerifiedGenomeInput) =>
      withLimsMutation(
        event.sender,
        input,
        {
          kind: 'outgoing',
          entityIds: [
            input.strainEntityId,
            ...(input.hypothesisGenomeEntityId ? [input.hypothesisGenomeEntityId] : []),
          ],
        },
        (db) => attachVerifiedLimsGenomeInDb(db, input)
      ),
    getStrainGenomeSummary: (event, input: LimsStrainGenomeSummaryInput) =>
      withLimsRead(event.sender, (db) => getLimsStrainGenomeSummaryInDb(db, input)),
    logTelemetry: (event, input: LimsTelemetryInput) =>
      withLimsLease(
        event.sender,
        input,
        async (db, runDatabase) => runDatabase(() => logLimsTelemetryInDb(db, input)),
        undefined,
        { fallbackToAllWorkspaces: false }
      ),
    reviewClassification: (event, entityId: string) => {
      if (typeof entityId !== 'string' || !entityId || entityId.length > 256)
        throw new Error('Classification entity identity is invalid.');
      return withLimsRead(event.sender, (db) =>
        readNativeSequenceClassificationReview(db, entityId)
      );
    },
    applyClassification: (event, input: ApplyOligoClassificationRequest) => {
      const request = parseApplyOligoClassificationRequest(input);
      return withLimsLease(event.sender, { entityId: request.entityId }, (db, runDatabase) => {
        if (runDatabase(() => ownsAcceptedScientificEntity(db, request.entityId)))
          throw new Error('Create a new oligo from this sequence to keep its accepted history.');
        return applyNativeSequenceClassification({ db, runDatabase, input: request });
      });
    },
    queryEntities: (event, input: LimsQueryEntitiesInput) =>
      withLimsRead(event.sender, (db) => queryLimsEntitiesInDb(db, input)),
    queryRegistrySummaries: (event, input: LimsQueryRegistrySummariesInput) => {
      const database = getDb();
      return withRendererDatabaseRead(database, event.sender, () => {
        assertLimsSafetyNotQuarantined(database);
        return queryLimsRegistrySummariesInDb(database, input ?? {});
      });
    },
    queryRecordRelationshipTargets: (event, input: LimsRecordRelationshipTargetQuery) => {
      const db = getDb();
      return queryNativeRecordRelationshipTargets(db, input, (operation) =>
        withLimsRead(event.sender, (current) => {
          if (current !== db) throw new Error('Database changed during relationship search.');
          return operation();
        })
      );
    },
    backfillRegistryIds: (event, input: LimsBackfillRegistryIdsInput) =>
      withLimsMutation(
        event.sender,
        null,
        { kind: 'maintenance', purpose: 'display-id-allocation' },
        (db) => backfillLimsRegistryIdsInDb(db, input)
      ),
    seedDemoDataset: (event, input: LimsSeedDemoDatasetInput) => {
      assertLimsScenarioMutationAllowed('lims:seedDemoDataset');
      return withLimsLease(event.sender, null, (db, runDatabase) =>
        seedLimsScenarioWithOwnedFixtures({
          db,
          runDatabase,
          dataset: 'demo',
          seed: () => seedLimsDemoDatasetInDb(db, input ?? {}),
        })
      );
    },
    seedMockDemo: (event, input: LimsSeedMockDemoInput) => {
      assertLimsScenarioMutationAllowed('lims:seedMockDemo');
      return withLimsLease(event.sender, null, (db, runDatabase) =>
        seedLimsScenarioWithOwnedFixtures({
          db,
          runDatabase,
          dataset: 'mock',
          seed: () => seedLimsMockDemoInDb(db, input ?? {}),
        })
      );
    },
    seedStarterRegistry: (event, input: LimsSeedStarterRegistryInput) => {
      assertLimsScenarioMutationAllowed('lims:seedStarterRegistry');
      return withLimsLease(event.sender, null, (db, runDatabase) =>
        seedLimsScenarioWithOwnedFixtures({
          db,
          runDatabase,
          dataset: 'starter',
          seed: () => seedLimsStarterRegistryInDb(db, input ?? {}),
        })
      );
    },
    seedPracticeDemo: (event, input: LimsSeedPracticeDemoInput) => {
      assertLimsScenarioMutationAllowed('lims:seedPracticeDemo');
      return withLimsLease(event.sender, null, (db, runDatabase) =>
        seedLimsScenarioWithOwnedFixtures({
          db,
          runDatabase,
          dataset: 'practice',
          seed: () => seedLimsPracticeDemoInDb(db, input ?? {}),
        })
      );
    },
  });

  registerPrimerArtifactIpcHandlers(withLimsLease, async (sender, operation) => {
    const database = getDb();
    assertLimsSafetyNotQuarantined(database);
    const runDatabase = <R>(work: () => R): R =>
      withRendererDatabaseStatement(database, sender, work);
    return operation(database, runDatabase);
  });
}

async function withLimsMutation<T>(
  sender: RendererDatabaseLifecycleSender,
  input: unknown,
  admission: RegistryMutationAdmission,
  operation: (db: Database.Database) => T,
  mutationToken?: string
): Promise<T> {
  return withLimsAuthoringLease(
    sender,
    input,
    admission,
    async (database, runDatabase) => runDatabase(() => operation(database)),
    mutationToken
  );
}

async function withLimsAuthoringLease<T>(
  sender: RendererDatabaseLifecycleSender,
  input: unknown,
  admission: RegistryMutationAdmission,
  operation: (db: Database.Database, runDatabase: <R>(operation: () => R) => R) => Promise<T>,
  mutationToken?: string
): Promise<T> {
  const initial = withLimsRead(sender, (db) =>
    assertRegistrySemanticMutationAllowed(db, admission)
  );
  return withLimsLease(
    sender,
    input,
    async (db, runDatabase) => {
      runDatabase(() => {
        if (assertRegistrySemanticMutationAllowed(db, admission) !== initial)
          throw new Error('WORKSPACE_MUTATION_OWNER_CHANGED');
      });
      const runAdmitted = <R>(work: () => R): R =>
        runDatabase(() => {
          if (assertRegistrySemanticMutationAllowed(db, admission) !== initial)
            throw new Error('WORKSPACE_MUTATION_OWNER_CHANGED');
          return work();
        });
      return operation(db, runAdmitted);
    },
    mutationToken,
    {
      fallbackToAllWorkspaces: admission.kind === 'maintenance' && mutationToken === undefined,
      admission,
    }
  );
}

async function withLimsLease<T>(
  sender: RendererDatabaseLifecycleSender,
  input: unknown,
  operation: (db: Database.Database, runDatabase: <R>(operation: () => R) => R) => Promise<T>,
  mutationToken?: string,
  options: { fallbackToAllWorkspaces: boolean; admission?: RegistryMutationAdmission } = {
    fallbackToAllWorkspaces: mutationToken === undefined,
  }
): Promise<T> {
  const database = getDb();
  assertLimsSafetyNotQuarantined(database);
  const runDatabase = <R>(work: () => R): R =>
    withRendererDatabaseStatement(database, sender, work);
  const { paths, affectedPaths } = runDatabase(() => ({
    paths: limsMutationWorkspacePaths(database, input, options),
    affectedPaths: limsMutationWorkspacePaths(database, input, {
      ...options,
      fallbackToAllWorkspaces: false,
    }),
  }));
  const scopeKey = (roots: readonly string[]) =>
    JSON.stringify([...new Set(roots.map(workspaceMutationRootIdentity))].sort());
  const admittedScope = scopeKey(paths);
  const run = async (): Promise<T> => {
    runDatabase(() => {
      if (scopeKey(limsMutationWorkspacePaths(database, input, options)) !== admittedScope)
        throw new Error('WORKSPACE_MUTATION_OWNER_CHANGED');
    });
    for (const workspacePath of new Set(affectedPaths)) {
      await assertWorkspaceMigrationActionsSettled(workspacePath);
      await recoverNativeCatalogRecordPublications({ db: database, workspacePath, runDatabase });
    }
    return operation(database, runDatabase);
  };
  if (mutationToken) {
    const tokenRoot = workspaceMutationCapabilities.resolveOwnedWorkspaceRoot(
      mutationToken,
      sender.id
    );
    if (!tokenRoot) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
    const roots = [
      ...new Set(paths.map((path) => findKnownWorkspaceRoot(database, path)).filter(isString)),
    ];
    if (roots.length > 1 || (roots.length === 1 && roots[0] !== tokenRoot)) {
      throw new Error('WORKSPACE_MUTATION_CROSSES_KNOWN_WORKSPACES');
    }
    const borrowed = await workspaceMutationCapabilities.runWithToken(
      mutationToken,
      sender.id,
      tokenRoot,
      run
    );
    if (borrowed.active) {
      return borrowed.value;
    }
    throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
  }
  return withKnownWorkspacePathsMutationAcrossWorkspaces(database, paths, async () => run());
}

async function withLimsLifecycle(
  sender: RendererDatabaseLifecycleSender,
  input: LimsEntityActionInput,
  action: 'archive' | 'restore' | 'revert',
  mutationToken?: string
): Promise<LimsRevertEntityResult> {
  const scientific = await actOnAcceptedScientificEntity({
    db: getDb(),
    input,
    action,
    renderer: { ownerId: sender.id, ...(mutationToken ? { mutationToken } : {}) },
  });
  if (scientific) return scientific;
  return withLimsLease(
    sender,
    { entityId: input.id },
    async (db, runDatabase) => {
      const specialized = runDatabase(() => registeredSpecializedAuthority(db, input.id));
      if (specialized === 'primer_artifact') {
        if (action === 'revert' || input.actor === 'workspace-reconcile')
          throw new Error(
            'Use the saved primer editor for this change. Registry-only history or reconciliation cannot change its saved archive state.'
          );
        const result = await publishPrimerArtifactLifecycle({
          db,
          runDatabase,
          action,
          request: input,
        });
        return { entity: result.entity, reverted: false };
      }
      if (specialized === 'sequence_package') {
        if (action === 'revert' || input.actor === 'workspace-reconcile')
          throw new Error(
            'Use the saved sequence package history or its explicit Archive/Restore action; reconciliation cannot change its saved lifecycle.'
          );
        const entity = await publishRegisteredSequenceLifecycleInMain(action, input, {
          db,
          runDatabase,
          getActiveAccountId: () =>
            readRegisteredRecordMutationAccount(db, [input.id], { runDatabase }),
        });
        runDatabase(() => materializeLimsGitExportForWorkspaceIds(db, [entity.workspaceId]));
        return { entity, reverted: false };
      }
      if (runDatabase(() => hasEntityArtifactAuthority(db, input.id))) {
        if (input.actor === 'workspace-reconcile' && action !== 'revert') {
          await assertEntityArtifactProjectionMatchesFile({ db, runDatabase, action, input });
          return runDatabase(() => ({
            reverted: false,
            entity:
              action === 'archive'
                ? archiveLimsEntityInDb(db, input)
                : restoreLimsEntityInDb(db, input),
          }));
        }
        return mutateEntityArtifact({ db, runDatabase, action, input });
      }
      if (runDatabase(() => hasReviewedNativeSequence(db, input.id))) {
        if (input.expectedEventSeq === undefined || !input.operationId)
          throw new Error(
            'Refresh this sequence before changing it; its current edit version is required.'
          );
        return mutateNativeCatalogSequence({
          db,
          runDatabase,
          action,
          input: {
            ...input,
            expectedEventSeq: input.expectedEventSeq,
            operationId: input.operationId,
          },
        });
      }
      const nativeRecord = runDatabase(() =>
        db
          .prepare(
            "SELECT 1 FROM catalog_entities c JOIN catalog_workspace_placements p ON p.entity_id = c.id WHERE c.id = ? AND c.type = 'record'"
          )
          .get(input.id)
      );
      if (!nativeRecord) {
        const projection =
          runDatabase(() => assertPrimerRegistryProjection(db, input, action)) ||
          (await assertFileBackedRegistryMutation(db, action, input, runDatabase));
        const accountId = await readRegisteredRecordMutationAccount(db, [input.id], {
          runDatabase,
        });
        return runDatabase(() => {
          if (!projection) assertRegistryEntityWriteAllowed(db, input);
          return action === 'revert'
            ? revertLimsEntityInDb(db, input, accountId)
            : {
                reverted: false,
                entity:
                  action === 'archive'
                    ? archiveLimsEntityInDb(db, input, accountId)
                    : restoreLimsEntityInDb(db, input, accountId),
              };
        });
      }
      if (input.expectedEventSeq === undefined || !input.operationId)
        throw new Error(
          'Refresh this record before changing it; its current edit version is required.'
        );
      return actOnNativeCatalogRecord({
        db,
        runDatabase,
        input,
        action,
        expectedEventSeq: input.expectedEventSeq,
        operationId: input.operationId,
      });
    },
    mutationToken
  );
}

async function checkedRegisteredSequenceProjection(
  db: Database.Database,
  runDatabase: <R>(work: () => R) => R,
  input: LimsUpdateEntityInput,
  mutationToken?: string
): Promise<LimsEntity> {
  if (
    input.actor !== 'workspace-reconcile' ||
    !mutationToken ||
    !input.replaceFields ||
    input.relationshipTargets !== undefined
  )
    throw new Error(
      'Edit this registered sequence package through its versioned Save or Metadata action.'
    );
  const accountId = await readRegisteredRecordMutationAccount(db, [input.id], { runDatabase });
  const admission = runDatabase(() =>
    readOrgRegistryPublicationAdmissionInDb(db, { entityId: input.id, accountId })
  );
  if (
    !admission ||
    admission.bindings.some((binding) => binding.authorityKind !== 'sequence_package')
  )
    throw new Error('This registered record is not owned by a managed sequence package.');
  const locator = readManagedSequenceDocumentRef(
    admission.entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]
  );
  const home = runDatabase(() =>
    db.prepare('SELECT path FROM workspaces WHERE id=?').get(admission.entity.workspaceId)
  ) as { path: string } | undefined;
  if (!locator || locator.packageId !== input.id || !home)
    throw new Error('The registered sequence package has no verified saved home.');
  const checked = await readCheckedManagedSequenceRegistrySnapshot(
    {
      db,
      runDatabase,
      lifecyclePublication: true,
      getActiveAccountId: () =>
        readRegisteredRecordMutationAccount(db, [input.id], { runDatabase }),
    },
    { entityId: input.id, workspaceRoot: home.path, packageRoot: locator.packageRoot }
  );
  if ((await readRegisteredRecordMutationAccount(db, [input.id], { runDatabase })) !== accountId)
    throw new Error('The active account changed while checking the saved sequence package.');
  return runDatabase(() => {
    const current = readOrgRegistryPublicationAdmissionInDb(db, { entityId: input.id, accountId });
    if (
      !current ||
      !isDeepStrictEqual(current, admission) ||
      !isDeepStrictEqual(checked.entity, current.entity) ||
      (input.expectedEventSeq !== undefined &&
        input.expectedEventSeq !== current.entity.eventSeq) ||
      input.workspaceId !== current.entity.workspaceId ||
      input.name !== checked.projection.name ||
      input.registrationStatus !== checked.projection.registrationStatus ||
      input.domainStatus !== checked.projection.domainStatus ||
      !isDeepStrictEqual(input.fields, {
        ...checked.projection.fields,
        [MANAGED_SEQUENCE_DOCUMENT_FIELD]: current.entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD],
      }) ||
      !isDeepStrictEqual(input.projectionSchema, {
        kind: checked.projection.kind,
        schemaRevisionId: checked.projection.schemaRevisionId,
        schemaSnapshot: checked.projection.schemaSnapshot,
      })
    )
      throw new Error(
        'The requested Registry projection differs from the checked saved package. Finish its versioned Save or resolve the retained file difference.'
      );
    return current.entity;
  });
}

function hasReviewedNativeSequence(db: Database.Database, entityId: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM catalog_entities WHERE id=? AND type='sequence' AND json_valid(metadata) AND json_type(metadata,'$.classificationDecision')='object'"
      )
      .get(entityId)
  );
}

function withLimsRead<T>(
  sender: RendererDatabaseLifecycleSender,
  operation: (db: Database.Database) => T
): T {
  const database = getDb();
  assertLimsSafetyNotQuarantined(database);
  return withRendererDatabaseStatement(database, sender, () => operation(database));
}

function limsMutationWorkspacePaths(
  db: Database.Database,
  input: unknown,
  options: { fallbackToAllWorkspaces: boolean; admission?: RegistryMutationAdmission } = {
    fallbackToAllWorkspaces: true,
  }
): string[] {
  if (options.admission && options.admission.kind !== 'maintenance')
    return registryMutationWorkspacePathsInDb(db, options.admission);
  const workspaceIds = new Set<number>();
  const record = isLimsMutationRecord(input) ? input : null;
  if (record && Number.isSafeInteger(record.workspaceId)) {
    workspaceIds.add(Number(record.workspaceId));
  }
  const entityKeys = [
    'entityId',
    'fromEntityId',
    'toEntityId',
    'strainEntityId',
    'hypothesisGenomeEntityId',
    'parentGenomeEntityId',
    'verifiedGenomeEntityId',
    'targetEntityId',
    'rejectedEntityId',
  ];
  const selectEntityWorkspace = db.prepare(
    `SELECT workspace_id FROM lims_entity WHERE id = ? LIMIT 1`
  );
  for (const key of entityKeys) {
    const entityId = record?.[key];
    if (typeof entityId !== 'string' || entityId.length === 0) continue;
    const row = selectEntityWorkspace.get(entityId) as { workspace_id: number | null } | undefined;
    if (row?.workspace_id != null) workspaceIds.add(row.workspace_id);
  }
  if (typeof record?.batchId === 'string') {
    const owners = db
      .prepare(
        `SELECT DISTINCT COALESCE(f.workspace_id,e.workspace_id) AS workspace_id
        FROM lims_audit a JOIN lims_entity e ON e.id=a.subject_id
        LEFT JOIN catalog_entity_files f ON f.entity_id=e.id AND f.status='current'
        WHERE a.batch_id=? AND a.subject_table='lims_entity' AND a.event_type='entity_registered'`
      )
      .all(record.batchId.trim()) as { workspace_id: number | null }[];
    for (const owner of owners)
      if (owner.workspace_id !== null) workspaceIds.add(owner.workspace_id);
  }
  if (typeof record?.schemaId === 'string') {
    const row = db
      .prepare(`SELECT workspace_id FROM lims_schema WHERE id = ? LIMIT 1`)
      .get(record.schemaId) as { workspace_id: number | null } | undefined;
    if (row?.workspace_id != null) workspaceIds.add(row.workspace_id);
  }

  const rows =
    workspaceIds.size > 0
      ? (db
          .prepare(
            `SELECT path FROM workspaces WHERE id IN (${[...workspaceIds].map(() => '?').join(',')})`
          )
          .all(...workspaceIds) as Array<{ path: string }>)
      : options.fallbackToAllWorkspaces
        ? (db.prepare(`SELECT path FROM workspaces WHERE archived_at IS NULL`).all() as Array<{
            path: string;
          }>)
        : [];
  return rows.map((row) => row.path);
}

function isLimsMutationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: string | null): value is string {
  return value !== null;
}

async function assertLimsImportCanonicalSources(
  db: Database.Database,
  input: LimsApplyImportBatchInput,
  runDatabase: <T>(work: () => T) => T
): Promise<void> {
  const records = input.records.filter(shouldApplyImportRecord);
  const inputs = records.map((record) => withImportSourceMetadata(record, input));
  const ids = new Map(
    records.flatMap((record, index) =>
      record.entity.id ? [[record.entity.id, inputs[index]] as const] : []
    )
  );
  const endpoint = (
    link: NonNullable<LimsApplyImportBatchInput['records'][number]['links']>[number],
    side: 'from' | 'to',
    fallback: string
  ): string => {
    const direct = side === 'from' ? link.fromEntityId : link.toEntityId;
    if (direct && ids.has(direct)) return direct;
    const lookup = side === 'from' ? link.fromEntityLookup : link.toEntityLookup;
    if (!direct && lookup) {
      const matches = inputs.filter(
        (value) => value.name === lookup.name && (!lookup.kind || value.kind === lookup.kind)
      );
      if (matches.length === 1 && matches[0].id) return matches[0].id;
    }
    return runDatabase(() => resolveImportLinkEndpoint(db, link, side, fallback));
  };
  for (let index = 0; index < records.length; index++) {
    const registration = inputs[index];
    const projection =
      runDatabase(() => assertPrimerRegistryProjection(db, registration, 'register')) ||
      (await assertFileBackedRegistryMutation(db, 'register', registration, runDatabase));
    if (!projection) continue;
    if (!registration.id)
      throw new Error('A file-backed Registry import requires its exact native identity.');
    const relationships = records.flatMap((record) =>
      (record.links ?? []).flatMap((link) => {
        const from = endpoint(link, 'from', record.entity.id ?? '');
        return from === registration.id
          ? [
              {
                type: link.type,
                toEntityId: endpoint(link, 'to', record.entity.id ?? ''),
                payload: link.payload,
              },
            ]
          : [];
      })
    );
    await assertFileBackedRegistryRelationships(
      db,
      { entityId: registration.id, relationships, workspaceId: registration.workspaceId },
      runDatabase,
      registration
    );
  }
}
