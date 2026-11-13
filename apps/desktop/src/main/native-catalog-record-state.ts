import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseLimsSchemaFields, type LimsEntityRow } from '../shared/lims';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../shared/entity-schema';
import type { Sha256Digest } from '../shared/benchling-import-decision';
import { limsEntityFromRow } from '../shared/lims';
import { getEntityRowById, getSchemaRevisionForEntity } from './lims-engine-core';

export function readNativeCatalogSequenceState(db: Database.Database, entityId: string) {
  const entity = limsEntityFromRow(getEntityRowById(db, entityId));
  const catalog = db
    .prepare("SELECT * FROM catalog_entities WHERE id=? AND type='sequence'")
    .get(entityId);
  if (!catalog) throw new Error('Native classification has no sequence catalog identity.');
  return {
    entity,
    schema: getSchemaRevisionForEntity(db, getEntityRowById(db, entityId)),
    schemaMetadata: db
      .prepare('SELECT display_name,description FROM lims_schema WHERE id=?')
      .get(entity.schemaId),
    catalog,
    files: db
      .prepare('SELECT * FROM catalog_entity_files WHERE entity_id=? ORDER BY id')
      .all(entityId),
    bindings: db
      .prepare('SELECT * FROM catalog_provider_bindings WHERE entity_id=? ORDER BY id')
      .all(entityId),
  };
}

export function nativeCatalogSequenceStateSha256(
  db: Database.Database,
  entityId: string
): Sha256Digest {
  return `sha256:${createHash('sha256')
    .update(canonicalRecordJson(readNativeCatalogSequenceState(db, entityId)))
    .digest('hex')}`;
}

export function readNativeCatalogRecordState(
  db: Database.Database,
  entityId: string,
  options: { includeArchived?: boolean } = {}
) {
  const row = db
    .prepare(
      `
    SELECT l.*, e.metadata AS catalog_metadata, e.name AS catalog_name, s.display_name AS schema_display_name, s.description AS schema_description,
           r.schema_id, r.version AS schema_version, r.fields AS schema_fields, e.status AS catalog_status
      FROM lims_entity l
      JOIN catalog_entities e ON e.id = l.id
      JOIN lims_schema_revision r ON r.id = l.schema_revision_id
      JOIN lims_schema s ON s.id = r.schema_id
     WHERE l.id = ? AND e.type = 'record'
       AND ((e.status = 'active' AND l.tombstone = 0 AND l.archived_at IS NULL)
            OR (? = 1 AND e.status = 'archived' AND l.tombstone = 1 AND l.archived_at IS NOT NULL))
  `
    )
    .get(entityId, options.includeArchived ? 1 : 0) as
    | (LimsEntityRow & {
        schema_display_name: string;
        schema_description: string | null;
        schema_id: string;
        schema_version: number;
        schema_fields: string;
        catalog_metadata: string | null;
        catalog_name: string;
        catalog_status: string;
      })
    | undefined;
  if (!row) return null;
  const definition = parseLimsSchemaFields(row.schema_fields);
  if (definition.baseKind !== 'record') return null;
  const schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot = {
    schemaId: row.schema_id,
    schemaRevisionId: row.schema_revision_id,
    version: row.schema_version,
    name: row.kind,
    displayName: row.schema_display_name,
    ...(row.schema_description === null ? {} : { description: row.schema_description }),
    baseKind: 'record',
    fields: definition.fields.map((field) => ({ ...field })),
  };
  const fields: unknown = JSON.parse(row.fields);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new Error(`Native record ${entityId} has invalid fields.`);
  const metadata: unknown = JSON.parse(row.catalog_metadata ?? '{}');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error(`Native record ${entityId} has invalid catalog metadata.`);
  return {
    metadata: Object.fromEntries(Object.entries(metadata)),
    catalogName: row.catalog_name,
    catalogStatus: row.catalog_status,
    archivedAt: row.archived_at,
    placements: db
      .prepare(
        'SELECT * FROM catalog_workspace_placements WHERE entity_id = ? ORDER BY workspace_id'
      )
      .all(entityId),
    graph: {
      catalog: db
        .prepare('SELECT * FROM catalog_entity_links WHERE source_entity_id = ? ORDER BY id')
        .all(entityId),
      lims: db
        .prepare('SELECT * FROM lims_link WHERE from_entity_id = ? ORDER BY id')
        .all(entityId),
    },
    name: row.name,
    fields: Object.fromEntries(Object.entries(fields)),
    schemaSnapshot,
    registrationStatus: row.registration_status,
    domainStatus: row.domain_status,
    eventSeq: row.event_seq,
    workspaceId: row.workspace_id,
  };
}

export function nativeCatalogRecordStateSha256(
  state: NonNullable<ReturnType<typeof readNativeCatalogRecordState>>
): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalRecordJson(state)).digest('hex')}`;
}

export function nativeCatalogRecordScience(input: {
  name: string;
  fields: Record<string, unknown>;
  schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot;
}): string {
  return canonicalRecordJson({
    name: input.name,
    fields: input.fields,
    schema: {
      displayName: input.schemaSnapshot.displayName,
      description: input.schemaSnapshot.description ?? null,
      baseKind: input.schemaSnapshot.baseKind,
      fields: input.schemaSnapshot.fields,
    },
  });
}

function canonicalRecordJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRecordJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRecordJson(entry)}`)
      .join(',')}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Native record state contains a non-JSON value.');
  return json;
}
