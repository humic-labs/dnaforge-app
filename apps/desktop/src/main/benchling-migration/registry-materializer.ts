import type Database from 'better-sqlite3';
import {
  limsEntityFromRow,
  parseLimsSchemaFields,
  type LimsEntity,
  type LimsEntityRow,
  type LimsLinkRow,
  type LimsSchemaRow,
} from '../../shared/lims';
import {
  defineLimsSchemaInsideTx,
  linkLimsEntitiesOrExistingInsideTx,
  registerMigratedLimsEntityInsideTx,
} from '../lims-engine-core';
import { materializeLimsGitExportForWorkspaceIds } from '../lims-export-sync';
import type {
  BenchlingRegistryProjectionDocument,
  RegistryRecordProjection,
  RegistrySchemaProjection,
} from './registry-projection';

const MIGRATION_ACTOR = 'benchling-migration';

export type BenchlingRegistryMaterializationResult = {
  workspaceId: number;
  batchId: string;
  schemasCreated: number;
  schemasReused: number;
  relationshipTypesCreated: number;
  relationshipTypesReused: number;
  recordsCreated: number;
  recordsReused: number;
  linksCreated: number;
  linksReused: number;
  excludedUnregisteredSequences: number;
  assignedRegistryIds: Record<string, string>;
};

export type MaterializeBenchlingRegistryProjectionInput = {
  document: BenchlingRegistryProjectionDocument;
  workspaceId: number;
  actor?: string;
  batchId?: string;
};

export function materializeBenchlingRegistryProjectionInDb(
  db: Database.Database,
  input: MaterializeBenchlingRegistryProjectionInput
): BenchlingRegistryMaterializationResult {
  const result = db.transaction(() => materializeBenchlingRegistryProjectionInsideTx(db, input))();
  materializeLimsGitExportForWorkspaceIds(db, [input.workspaceId]);
  return result;
}

export function materializeBenchlingRegistryProjectionInsideTx(
  db: Database.Database,
  input: MaterializeBenchlingRegistryProjectionInput
): BenchlingRegistryMaterializationResult {
  assertMaterializationInput(db, input);
  const actor = input.actor?.trim() || MIGRATION_ACTOR;
  const batchId =
    input.batchId?.trim() ||
    `benchling-registry:${
      input.document.version === 2 ? input.document.destinationWorkspaceId : 'legacy-v1'
    }:${input.document.organizationId}:${input.document.capturedAt}`;
  const assignedRegistryIds = planRegistryIds(db, input.document, input.workspaceId);

  let schemasCreated = 0;
  let schemasReused = 0;
  let relationshipTypesCreated = 0;
  let relationshipTypesReused = 0;
  let recordsCreated = 0;
  let recordsReused = 0;
  let linksCreated = 0;
  let linksReused = 0;

  for (const schema of input.document.schemas) {
    const existed = schemaExistsByIdentity(db, schema.destinationSchemaId);
    const row = defineLimsSchemaInsideTx(db, {
      ...schema.materialization.defineSchema,
      workspaceId: input.workspaceId,
      actor,
    });
    assertEntitySchemaMatches(row, schema, input.workspaceId);
    if (existed) schemasReused += 1;
    else schemasCreated += 1;
  }

  for (const relationshipType of input.document.relationshipTypes) {
    const existed = relationshipTypeExistsByName(db, relationshipType.relationType);
    const row = defineLimsSchemaInsideTx(db, {
      ...relationshipType.materialization.defineSchema,
      workspaceId: input.workspaceId,
      actor,
    });
    if (row.kind !== 'relationship_type' || row.name !== relationshipType.relationType) {
      throw new Error(
        `Relationship type ${relationshipType.relationType} resolved to an incompatible schema.`
      );
    }
    if (existed) relationshipTypesReused += 1;
    else relationshipTypesCreated += 1;
  }

  for (const record of input.document.records) {
    const assignedRegistryId = assignedRegistryIds[record.stableSourceId];
    if (!assignedRegistryId) {
      throw new Error(`No registry ID was planned for ${record.stableSourceId}.`);
    }
    const existing = getEntityById(db, record.destinationEntityId);
    if (existing) {
      assertExistingRecordMatches(existing, record, assignedRegistryId, input.workspaceId);
      recordsReused += 1;
      continue;
    }
    const fields = {
      ...record.materialization.registerEntity.fields,
      benchling_primary_registry_id: assignedRegistryId,
    };
    registerMigratedLimsEntityInsideTx(
      db,
      {
        ...record.materialization.registerEntity,
        fields,
        workspaceId: input.workspaceId,
        actor,
        batchId,
      },
      assignedRegistryId
    );
    recordsCreated += 1;
  }

  for (const record of input.document.records) {
    for (const linkInput of record.materialization.links) {
      if (linkInput.fromEntityId !== record.destinationEntityId) {
        throw new Error(
          `Registry relationship ${linkInput.id ?? linkInput.type} has the wrong source entity.`
        );
      }
      assertActiveEntityInWorkspace(db, linkInput.fromEntityId, input.workspaceId);
      assertActiveEntityInWorkspace(db, linkInput.toEntityId, input.workspaceId);
      assertLinkIdIsCompatible(db, linkInput.id, linkInput);
      const existing = getActiveLinkByTuple(
        db,
        linkInput.fromEntityId,
        linkInput.toEntityId,
        linkInput.type
      );
      linkLimsEntitiesOrExistingInsideTx(db, {
        ...linkInput,
        workspaceId: input.workspaceId,
        actor,
        batchId,
      });
      if (existing) linksReused += 1;
      else linksCreated += 1;
    }
  }

  return {
    workspaceId: input.workspaceId,
    batchId,
    schemasCreated,
    schemasReused,
    relationshipTypesCreated,
    relationshipTypesReused,
    recordsCreated,
    recordsReused,
    linksCreated,
    linksReused,
    excludedUnregisteredSequences: input.document.excludedSources.length,
    assignedRegistryIds,
  } satisfies BenchlingRegistryMaterializationResult;
}

function assertMaterializationInput(
  db: Database.Database,
  input: MaterializeBenchlingRegistryProjectionInput
): void {
  if (!Number.isSafeInteger(input.workspaceId) || input.workspaceId <= 0) {
    throw new Error('Benchling registry materialization requires a positive workspace ID.');
  }
  const workspace = db
    .prepare(`SELECT id, repo_uuid FROM workspaces WHERE id = ?`)
    .get(input.workspaceId) as { id: number; repo_uuid: string | null } | undefined;
  if (!workspace) throw new Error(`Unknown migration workspace ${input.workspaceId}.`);
  if (
    (input.document.version !== 1 && input.document.version !== 2) ||
    input.document.kind !== 'waypoint.benchling-registry-projection'
  ) {
    throw new Error('Unsupported Benchling registry projection document.');
  }
  if (
    input.document.version === 2 &&
    input.document.destinationWorkspaceId !== workspace.repo_uuid
  ) {
    throw new Error(
      `Benchling registry projection belongs to workspace ${input.document.destinationWorkspaceId}, not ${workspace.repo_uuid ?? 'an unbound workspace'}.`
    );
  }
  if (!input.document.organizationId.trim()) {
    throw new Error('Benchling registry projection organization is required.');
  }
  assertUnique(
    input.document.schemas.map((schema) => schema.destinationSchemaId),
    'destination schema ID'
  );
  assertUnique(
    input.document.records.map((record) => record.destinationEntityId),
    'destination entity ID'
  );
  assertUnique(
    input.document.records.map((record) => record.stableSourceId),
    'stable source ID'
  );
}

function planRegistryIds(
  db: Database.Database,
  document: BenchlingRegistryProjectionDocument,
  workspaceId: number
): Record<string, string> {
  const schemaByRevision = new Map(
    document.schemas.map((schema) => [schema.sourceRevisionId, schema])
  );
  const occupied = new Map<string, string>();
  const rows = db
    .prepare(`SELECT id, registry_id FROM lims_entity WHERE registry_id IS NOT NULL`)
    .all() as Array<{ id: string; registry_id: string }>;
  for (const row of rows) occupied.set(normalizeRegistryId(row.registry_id), row.id);

  const assigned: Record<string, string> = {};
  for (const record of document.records) {
    const schema = schemaByRevision.get(record.sourceSchemaRevisionId);
    if (!schema) {
      throw new Error(
        `Record ${record.stableSourceId} references missing schema revision ${record.sourceSchemaRevisionId}.`
      );
    }
    const existing = getEntityById(db, record.destinationEntityId);
    if (existing) {
      if (existing.workspaceId !== workspaceId) {
        throw new Error(
          `Entity ${record.destinationEntityId} already belongs to workspace ${existing.workspaceId ?? 'global'}.`
        );
      }
      if (!existing.registryId) {
        throw new Error(
          `Existing migrated entity ${record.destinationEntityId} has no registry ID.`
        );
      }
      const fallback = namespacedRegistryId(schema, record);
      if (![record.desiredRegistryId, fallback].includes(existing.registryId)) {
        throw new Error(
          `Existing migrated entity ${record.destinationEntityId} has incompatible registry ID ${existing.registryId}.`
        );
      }
      assigned[record.stableSourceId] = existing.registryId;
      occupied.set(normalizeRegistryId(existing.registryId), existing.id);
      continue;
    }

    const desiredOwner = occupied.get(normalizeRegistryId(record.desiredRegistryId));
    const registryId = desiredOwner
      ? namespacedRegistryId(schema, record)
      : record.desiredRegistryId;
    const owner = occupied.get(normalizeRegistryId(registryId));
    if (owner && owner !== record.destinationEntityId) {
      throw new Error(
        `Registry ID ${registryId} remains occupied after deterministic source-schema namespacing.`
      );
    }
    assigned[record.stableSourceId] = registryId;
    occupied.set(normalizeRegistryId(registryId), record.destinationEntityId);
  }
  return assigned;
}

function namespacedRegistryId(
  schema: RegistrySchemaProjection,
  record: RegistryRecordProjection
): string {
  return `${schema.registryNamespace}:${record.sourceRegistryId}`;
}

function assertEntitySchemaMatches(
  row: LimsSchemaRow,
  projected: RegistrySchemaProjection,
  workspaceId: number
): void {
  if (
    row.id !== projected.destinationSchemaId ||
    row.kind !== 'entity' ||
    row.name !== projected.destinationSchemaName ||
    row.current_revision_id !== projected.destinationSchemaRevisionId ||
    row.workspace_id !== workspaceId
  ) {
    throw new Error(
      `Benchling schema ${projected.sourceRevisionId} conflicts with an existing destination schema.`
    );
  }
  const actual = parseLimsSchemaFields(row.fields).fields;
  const expected = projected.materialization.defineSchema.fields;
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(
      `Benchling schema ${projected.sourceRevisionId} fields differ from the existing destination schema.`
    );
  }
}

function assertExistingRecordMatches(
  existing: LimsEntity,
  projected: RegistryRecordProjection,
  assignedRegistryId: string,
  workspaceId: number
): void {
  const register = projected.materialization.registerEntity;
  if (
    existing.tombstone ||
    existing.workspaceId !== workspaceId ||
    existing.kind !== register.kind ||
    existing.schemaRevisionId !== register.schemaRevisionId ||
    existing.registryId !== assignedRegistryId ||
    existing.fields.benchling_source_object_id !== projected.stableSourceId ||
    existing.fields.benchling_source_registry_id !== projected.sourceRegistryId ||
    existing.fields.benchling_primary_registry_id !== assignedRegistryId
  ) {
    throw new Error(
      `Existing entity ${projected.destinationEntityId} is not the same Benchling registry projection.`
    );
  }
}

function assertActiveEntityInWorkspace(
  db: Database.Database,
  entityId: string,
  workspaceId: number
): void {
  const entity = getEntityById(db, entityId);
  if (!entity || entity.tombstone) {
    throw new Error(`Exact Benchling relationship target ${entityId} is not materialized.`);
  }
  if (entity.workspaceId !== workspaceId) {
    throw new Error(`Exact Benchling relationship target ${entityId} is outside the workspace.`);
  }
}

function assertLinkIdIsCompatible(
  db: Database.Database,
  linkId: string | undefined,
  input: { fromEntityId: string; toEntityId: string; type: string }
): void {
  if (!linkId) return;
  const row = db.prepare(`SELECT * FROM lims_link WHERE id = ?`).get(linkId) as
    | LimsLinkRow
    | undefined;
  if (
    row &&
    (row.from_entity_id !== input.fromEntityId ||
      row.to_entity_id !== input.toEntityId ||
      row.type !== input.type)
  ) {
    throw new Error(`Benchling relationship link ID ${linkId} is already used by another link.`);
  }
}

function getActiveLinkByTuple(
  db: Database.Database,
  fromEntityId: string,
  toEntityId: string,
  type: string
): LimsLinkRow | undefined {
  return db
    .prepare(
      `SELECT * FROM lims_link
       WHERE from_entity_id = ? AND to_entity_id = ? AND type = ? AND tombstone = 0
       LIMIT 1`
    )
    .get(fromEntityId, toEntityId, type) as LimsLinkRow | undefined;
}

function getEntityById(db: Database.Database, id: string): LimsEntity | undefined {
  const row = db.prepare(`SELECT * FROM lims_entity WHERE id = ?`).get(id) as
    | LimsEntityRow
    | undefined;
  return row ? limsEntityFromRow(row) : undefined;
}

function schemaExistsByIdentity(db: Database.Database, id: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM lims_schema WHERE id = ?`).get(id));
}

function relationshipTypeExistsByName(db: Database.Database, name: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM lims_schema
         WHERE kind = 'relationship_type' AND name = ? AND tombstone = 0`
      )
      .get(name)
  );
}

function normalizeRegistryId(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value.trim()) throw new Error(`Benchling registry projection ${label} is required.`);
    if (seen.has(value))
      throw new Error(`Duplicate Benchling registry projection ${label}: ${value}.`);
    seen.add(value);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)])
    );
  }
  return value;
}
