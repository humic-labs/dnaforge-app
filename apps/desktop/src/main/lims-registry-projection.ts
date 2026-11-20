import {
  namedEntityTypePresentation,
  resolveNamedEntityType,
} from '@waypoint/scientific-artifacts/shared/entity-types';
import { registryRepresentationForEntity } from '../shared/registry-entity-opening';
export {
  registryRepresentationForEntity,
  sequenceFileOpenTarget,
  recordDetailOpenTarget,
} from '../shared/registry-entity-opening';

import type Database from 'better-sqlite3';
import { registryConfidenceLabel } from '../shared/strain-genome-evidence';
export { registryConfidenceLabel } from '../shared/strain-genome-evidence';
import { registrySourceEligibilitySql } from './registry-source-eligibility';
import { registeredSpecializedAuthority } from './org-registry-specialized-authority';
import { readNativeCatalogRecordState } from './native-catalog-record-state';
import {
  readScientificStrainRegistryRecord,
  ownsAcceptedScientificEntity,
} from './scientific-strain-authority';
import { readCatalogProviderSource } from './catalog-provider-source';
import { readCatalogReviewedTableSource } from './catalog-reviewed-table-source';
import {
  limsEntityFromRow,
  limsLinkFromRow,
  parseLimsSchemaFields,
  type DnaSequenceRef,
  type LimsEntity,
  type LimsEntityRow,
  type LimsLink,
  type LimsLinkRow,
  type LimsQueryRegistrySummariesInput,
  type LimsRegistryLinkedEntitySummary,
  type LimsRegistryPreview,
  type LimsRegistryPreviewInput,
  type LimsRegistrySummary,
  type LimsRegistrySummaryPage,
  type LimsStrainGenomeSummary,
  LIMS_ENTITY_KINDS,
  type LimsQueryEntitiesInput,
} from '../shared/lims';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../shared/entity-schema';
import { resolveEntityRecordFieldValues } from '../shared/entity-record';
import { createLimsEntityQuery } from '../shared/lims-entity-query';
import {
  buildEntitySearchableText,
  createRegistryQuery,
  entitySpeciesTaxon,
} from '../shared/registry-query';
export { buildEntitySearchableText } from '../shared/registry-query';
import {
  MANAGED_SEQUENCE_CONTENT_FIELD,
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceContentSummary,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import { getEntityRowById, seedLimsBuiltinsInDb } from './lims-engine-core';
import {
  getLimsStrainGenomeSummariesInsideTx,
  getLimsStrainGenomeSummaryInsideTx,
} from './lims-strain-genome';

export function queryLimsRegistrySummariesInDb(
  db: Database.Database,
  input: LimsQueryRegistrySummariesInput = {}
): LimsRegistrySummaryPage {
  seedLimsBuiltinsInDb(db);
  const definitions = new Map<string, ReturnType<typeof parseLimsSchemaFields>['fields']>();
  const select = createRegistryQuery(input, (entity, key) => {
    if (!entity.schemaId) return null;
    let fields = definitions.get(entity.schemaRevisionId);
    if (!fields) {
      const row = db
        .prepare('SELECT fields FROM lims_schema_revision WHERE id=?')
        .get(entity.schemaRevisionId) as { fields: string } | undefined;
      if (!row) return null;
      fields = parseLimsSchemaFields(row.fields).fields;
      definitions.set(entity.schemaRevisionId, fields);
    }
    const definition = fields.find((field) => field.key === key);
    return definition?.type === 'date' || definition?.type === 'datetime'
      ? { schemaId: entity.schemaId, type: definition.type }
      : null;
  });
  const candidates = getRegistryCandidateEntities(db, input.includeArchived);
  const {
    entities: windowEntities,
    totalCount,
    limit,
    offset,
    availableKinds,
  } = select(candidates);
  const strainSummaries = getLimsStrainGenomeSummariesInsideTx(db, {
    strainEntityIds: windowEntities
      .filter((entity) => entity.kind === 'strain')
      .map((entity) => entity.id),
  }).summaries;
  const summaries = windowEntities.map((entity) =>
    buildLimsRegistrySummary(db, entity, strainSummaries[entity.id])
  );

  const organismCounts = new Map<
    string,
    { speciesTaxid: string; speciesName: string; count: number }
  >();
  for (const entity of candidates) {
    const taxon = entitySpeciesTaxon(entity);
    if (!taxon) continue;
    const existing = organismCounts.get(taxon.speciesTaxid);
    if (existing) existing.count += 1;
    else
      organismCounts.set(taxon.speciesTaxid, {
        speciesTaxid: taxon.speciesTaxid,
        speciesName: taxon.speciesName,
        count: 1,
      });
  }
  const availableOrganisms = [...organismCounts.values()].sort((a, b) =>
    a.speciesName.localeCompare(b.speciesName)
  );

  const projectCounts = new Map<number, number>();
  for (const entity of candidates) {
    if (entity.workspaceId !== null) {
      projectCounts.set(entity.workspaceId, (projectCounts.get(entity.workspaceId) ?? 0) + 1);
    }
  }
  const availableProjects = (
    db.prepare('SELECT id, name FROM workspaces').all() as { id: number; name: string }[]
  )
    .filter((project) => projectCounts.has(project.id))
    .map((project) => ({
      workspaceId: project.id,
      name: project.name,
      count: projectCounts.get(project.id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.workspaceId - b.workspaceId);

  return {
    summaries,
    eventSeq: (
      db.prepare('SELECT COALESCE(MAX(event_seq), 0) AS seq FROM lims_audit').get() as {
        seq: number;
      }
    ).seq,
    totalCount,
    limit,
    offset,
    availableOrganisms,
    availableProjects,
    availableKinds,
  };
}

export function getLimsRegistryPreviewInDb(
  db: Database.Database,
  input: LimsRegistryPreviewInput
): LimsRegistryPreview {
  seedLimsBuiltinsInDb(db);
  const entityRow = getEntityRowById(db, input.entityId);
  const entity = limsEntityFromRow(entityRow);
  const strainGenomeSummary =
    entity.kind === 'strain'
      ? getLimsStrainGenomeSummaryInsideTx(db, { strainEntityId: entity.id })
      : undefined;
  const summary = buildLimsRegistrySummary(db, entity, strainGenomeSummary);
  const savedAuthority = registeredSpecializedAuthority(db, entity.id);
  const scientificRecord = readScientificStrainRegistryRecord(db, entity.id);
  const nativeRecord = scientificRecord
    ? null
    : readNativeCatalogRecordState(db, entity.id, { includeArchived: true });
  const originalSource = (
    readCatalogReviewedTableSource(db, entity.id) ?? readCatalogProviderSource(db, entity.id)
  )?.request;
  const links = getActiveLinksForEntity(db, entity.id);
  return {
    entity,
    summary,
    classificationEligible: !ownsAcceptedScientificEntity(db, entity.id),
    acceptedScientificOwner: ownsAcceptedScientificEntity(db, entity.id),
    ...(savedAuthority === 'sequence_package' ? { savedLifecycleAuthority: savedAuthority } : {}),
    schemaSnapshot: registrySchemaSnapshotForEntity(db, entity),
    outgoingLinks: links.outgoing.map((link) =>
      linkedRegistryEntitySummary(db, link, link.toEntityId)
    ),
    incomingLinks: links.incoming.map((link) =>
      linkedRegistryEntitySummary(db, link, link.fromEntityId)
    ),
    strainGenomeSummary,
    ...(scientificRecord
      ? { nativeRecord: scientificRecord }
      : nativeRecord
        ? { nativeRecord: { schemaSnapshot: nativeRecord.schemaSnapshot } }
        : {}),
    ...(originalSource ? { originalSource } : {}),
  };
}

export function getRegistryCandidateEntities(
  db: Database.Database,
  includeArchived = false
): LimsEntity[] {
  const eligibility = registrySourceEligibilitySql(db);
  const rows = db
    .prepare(
      `SELECT * FROM lims_entity
       WHERE ${includeArchived ? '' : 'tombstone = 0 AND '}${eligibility}
       ORDER BY lower(name) ASC, id ASC`
    )
    .all() as LimsEntityRow[];
  return rows.map(limsEntityFromRow);
}

export function buildLimsRegistrySummary(
  db: Database.Database,
  entity: LimsEntity,
  strainGenomeSummary?: LimsStrainGenomeSummary
): LimsRegistrySummary {
  const sequence = entity.fields.sequence as DnaSequenceRef | undefined;
  const managedSequence = readManagedSequenceDocumentRef(
    entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]
  );
  const managedSequenceContent = readManagedSequenceContentSummary(
    entity.fields[MANAGED_SEQUENCE_CONTENT_FIELD]
  );
  const representation = registryRepresentationForEntity(entity, sequence);
  const links = getActiveLinksForEntity(db, entity.id);
  const linkSummary = summarizeRegistryLinks(db, links);
  const evidenceSummary =
    entity.kind === 'strain'
      ? registryEvidenceSummary(
          strainGenomeSummary ??
            getLimsStrainGenomeSummaryInsideTx(db, { strainEntityId: entity.id })
        )
      : undefined;
  const sequenceSummary = managedSequenceContent
    ? {
        topology: managedSequenceContent.topology,
        length: managedSequenceContent.length,
        contentHash: managedSequenceContent.normalizedSequenceHash,
        fileContentHash: managedSequenceContent.fileContentHash,
        normalizedSequenceHash: managedSequenceContent.normalizedSequenceHash,
      }
    : sequence?.mode === 'file'
      ? {
          topology: sequence.topology,
          length: sequence.length,
          sourceFormat: sequence.sourceFormat,
          contentHash: sequence.contentHash,
          fileContentHash: sequence.fileContentHash,
          normalizedSequenceHash: sequence.normalizedSequenceHash,
        }
      : sequence?.mode === 'inline'
        ? {
            topology: sequence.topology,
            length: sequence.length,
            inlineBases: sequence.bases,
            contentHash: sequence.contentHash,
          }
        : undefined;

  const { snapshot: schemaSnapshot, builtin } = registrySchemaRevision(db, entity);
  const type = namedEntityTypePresentation(
    resolveNamedEntityType({
      type: 'registry',
      registryKind: entity.kind,
      schemaId: schemaSnapshot.schemaId,
      schemaBuiltin: builtin,
    }),
    schemaSnapshot.name,
    schemaSnapshot.displayName
  );

  const isCatalogRecord = Boolean(
    db.prepare("SELECT 1 FROM catalog_entities WHERE id = ? AND type = 'record'").get(entity.id)
  );
  return {
    id: entity.id,
    workspaceId: entity.workspaceId,
    kind: entity.kind,
    schemaSnapshot,
    fieldValues: resolveEntityRecordFieldValues(schemaSnapshot, entity.fields, {
      length: sequenceSummary?.length,
      topology: sequenceSummary?.topology,
      geneticCode:
        managedSequenceContent?.geneticCode ??
        (sequence?.mode === 'file' ? sequence.geneticCode : undefined),
    }),
    schemaDisplayName: type.kindLabel,
    schemaIconKind: type.iconKind,
    eventSeq: entity.eventSeq,
    name: entity.name,
    registryId: entity.registryId,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
    organism: entitySpeciesTaxon(entity),
    representation,
    summary: managedSequence
      ? 'Managed DNA sequence'
      : isCatalogRecord
        ? `${type.kindLabel} record`
        : registrySummaryText(entity, sequence, evidenceSummary),
    evidenceSummary,
    sequenceSummary,
    linkSummary,
    searchableText: buildEntitySearchableText(entity),
    updatedAt: entity.updatedAt,
    archived: Boolean(entity.tombstone),
  };
}

export function registrySchemaSnapshotForEntity(
  db: Database.Database,
  entity: Pick<LimsEntity, 'schemaRevisionId'>
): ProjectableEntitySchemaRevisionSnapshot {
  return registrySchemaRevision(db, entity).snapshot;
}

function registrySchemaRevision(
  db: Database.Database,
  entity: Pick<LimsEntity, 'schemaRevisionId'>
): { snapshot: ProjectableEntitySchemaRevisionSnapshot; builtin: boolean } {
  const row = db
    .prepare(
      `SELECT s.id AS schema_id,
              s.name AS schema_name,
              s.builtin AS builtin,
              s.display_name AS display_name,
              s.description AS description,
              r.id AS revision_id,
              r.version AS revision_version,
              r.fields AS revision_fields
         FROM lims_schema_revision r
         JOIN lims_schema s ON s.id = r.schema_id
        WHERE r.id = ? AND s.kind = 'entity'
        LIMIT 1`
    )
    .get(entity.schemaRevisionId) as
    | {
        schema_id: string;
        schema_name: string;
        builtin: number;
        display_name: string;
        description: string | null;
        revision_id: string;
        revision_version: number;
        revision_fields: string;
      }
    | undefined;
  if (!row) throw new Error(`Schema revision ${entity.schemaRevisionId} not found`);
  const definition = parseLimsSchemaFields(row.revision_fields);
  const snapshot = {
    schemaId: row.schema_id,
    schemaRevisionId: row.revision_id,
    name: row.schema_name,
    displayName: row.display_name,
    description: row.description,
    baseKind: definition.baseKind ?? row.schema_name,
    version: row.revision_version,
    fields: definition.fields.map((field) => ({ ...field })),
  };
  return { snapshot, builtin: row.builtin === 1 };
}

export function registryEvidenceSummary(
  summary: LimsStrainGenomeSummary
): LimsRegistrySummary['evidenceSummary'] {
  return {
    confidenceLabel: registryConfidenceLabel(summary),
    gapStatus: summary.gap.status,
    gapMessage: summary.gap.message,
    parentGenomeName: summary.parentGenome?.name,
    hypothesisGenomeName: summary.hypothesisGenome?.name,
    verifiedGenomeName: summary.verifiedGenome?.name,
  };
}

export function registrySummaryText(
  entity: LimsEntity,
  sequence: DnaSequenceRef | undefined,
  evidenceSummary: LimsRegistrySummary['evidenceSummary']
): string {
  if (entity.kind === 'molecular-document') {
    const sources = Number(entity.fields.sourceCount ?? 0);
    const revisions = Number(entity.fields.revisionCount ?? 0);
    return `${sources} ${sources === 1 ? 'source' : 'sources'} · ${revisions} saved ${revisions === 1 ? 'version' : 'versions'}`;
  }
  if (entity.kind === 'track-view') {
    const reference =
      typeof entity.fields.referenceName === 'string'
        ? entity.fields.referenceName
        : entity.fields.referenceAssemblyId;
    const count = typeof entity.fields.trackCount === 'number' ? entity.fields.trackCount : 0;
    return `${String(reference || 'Unknown reference')} · ${count} ${count === 1 ? 'track' : 'tracks'}`;
  }
  if (entity.kind === 'strain') {
    const genotype =
      typeof entity.fields.genotypeCanonical === 'string'
        ? entity.fields.genotypeCanonical
        : 'No genotype recorded';
    return evidenceSummary ? `${genotype}; ${evidenceSummary.gapMessage}` : genotype;
  }
  if (sequence?.mode === 'file') {
    return `${sequence.topology} ${entity.kind} sequence, ${sequence.length} bp`;
  }
  if (sequence?.mode === 'inline')
    return entity.kind === 'oligo' ? 'Oligo sequence' : 'Stored sequence';
  if (sequence?.mode === 'unresolved') return 'Sequence is unresolved';
  if (entity.kind === 'organism') {
    const scientificName =
      typeof entity.fields.scientificName === 'string' ? entity.fields.scientificName : entity.name;
    return scientificName;
  }
  const notes = typeof entity.fields.notes === 'string' ? entity.fields.notes : '';
  return notes || `${entity.kind} record`;
}

export function summarizeRegistryLinks(
  db: Database.Database,
  links: { outgoing: LimsLink[]; incoming: LimsLink[] }
): LimsRegistrySummary['linkSummary'] {
  const notable = [
    ...links.incoming.map((link) => ({
      type: link.type,
      label: limsEntityFromRow(getEntityRowById(db, link.fromEntityId)).name,
      entityId: link.fromEntityId,
    })),
    ...links.outgoing.map((link) => ({
      type: link.type,
      label: limsEntityFromRow(getEntityRowById(db, link.toEntityId)).name,
      entityId: link.toEntityId,
    })),
  ]
    .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label))
    .slice(0, 8);

  return {
    outgoingCount: links.outgoing.length,
    incomingCount: links.incoming.length,
    notable,
  };
}

export function getActiveLinksForEntity(
  db: Database.Database,
  entityId: string
): { outgoing: LimsLink[]; incoming: LimsLink[] } {
  const outgoingRows = db
    .prepare(
      `SELECT * FROM lims_link
       WHERE from_entity_id = ? AND tombstone = 0
       ORDER BY updated_at DESC, created_at DESC, id ASC`
    )
    .all(entityId) as LimsLinkRow[];
  const incomingRows = db
    .prepare(
      `SELECT * FROM lims_link
       WHERE to_entity_id = ? AND tombstone = 0
       ORDER BY updated_at DESC, created_at DESC, id ASC`
    )
    .all(entityId) as LimsLinkRow[];
  return {
    outgoing: outgoingRows.map(limsLinkFromRow),
    incoming: incomingRows.map(limsLinkFromRow),
  };
}

export function linkedEntitySummary(entity: LimsEntity): LimsRegistryLinkedEntitySummary['entity'] {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
  };
}

export function linkedRegistryEntitySummary(
  db: Database.Database,
  link: LimsLink,
  entityId: string
): LimsRegistryLinkedEntitySummary {
  const entity = limsEntityFromRow(getEntityRowById(db, entityId));
  const strainSummary =
    entity.kind === 'strain'
      ? getLimsStrainGenomeSummaryInsideTx(db, { strainEntityId: entity.id })
      : undefined;
  return {
    link,
    entity: linkedEntitySummary(entity),
    summary: buildLimsRegistrySummary(db, entity, strainSummary),
  };
}

export function queryLimsEntitiesInDb(
  db: Database.Database,
  input: LimsQueryEntitiesInput = {}
): LimsEntity[] {
  seedLimsBuiltinsInDb(db);
  const where: string[] = [registrySourceEligibilitySql(db)];
  const query = createLimsEntityQuery(input);
  where.push(...query.where);
  const rows = db
    .prepare(
      `SELECT * FROM lims_entity
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(...query.params, query.fetchLimit) as LimsEntityRow[];
  return query.finishRows(rows.map(limsEntityFromRow));
}

export function countLimsEntitiesByKindInDb(db: Database.Database): Record<string, number> {
  seedLimsBuiltinsInDb(db);
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) as count FROM lims_entity WHERE tombstone = 0 AND ${registrySourceEligibilitySql(db)} GROUP BY kind`
    )
    .all() as Array<{ kind: string; count: number }>;
  return Object.fromEntries([
    ...LIMS_ENTITY_KINDS.map((kind) => [kind, 0]),
    ...rows.map((row) => [row.kind, row.count]),
  ]);
}
