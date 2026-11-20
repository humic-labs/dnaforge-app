import type { RelocatedSavedPrimer } from './relocate-primer-artifacts';
import { deterministicSchemaId } from '@waypoint/scientific-artifacts/shared/entity-types';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import {
  assertLimsAgendaDefinition,
  assertLimsTemporalEdits,
} from '@waypoint/scientific-artifacts/shared/lims-temporal';
import { resolveSavedRegistryProject } from './registry-entity-project';
import { setupEnvironment } from 'dugite';

import {
  isPathInsideBoundary,
  pathRelativeToBoundary,
  rebasePath,
  stripTrailingSep,
} from '../shared/path-boundary';
import {
  LIMS_BUILTIN_SCHEMAS,
  LIMS_DEFAULT_ID_SCHEMES,
  LIMS_ENTITY_KINDS,
  LIMS_OLIGO_USES,
  LIMS_ID_SCHEME_MAX_PAD_WIDTH,
  formatRegistryId,
  limsEntityFromRow,
  limsLinkFromRow,
  limsSchemaFieldsJson,
  isLimsFieldType,
  serializeLimsSchemaDefinition,
  parseLimsSchemaFields,
  classifyLimsEntityFieldIssues,
  recordRegistrationStatus,
  type DnaSequenceRef,
  type LimsAuditRow,
  type LimsBackfillRegistryIdsInput,
  type LimsBackfillRegistryIdsResult,
  type LimsContentPin,
  type LimsDefineSchemaInput,
  type LimsEntity,
  type LimsEntityRow,
  type LimsFieldDefinition,
  type LimsIdScheme,
  type LimsLink,
  type LimsLinkEntitiesInput,
  type LimsLinkRow,
  type LimsRegisterEntityInput,
  type LimsResetRegistryResult,
  type LimsSchemaRevisionRow,
  type LimsSchemaDefinitionView,
  type LimsSchemaRow,
  type LimsSchemaKind,
  type LimsSetIdSchemeInput,
  type LimsUpdateEntityInput,
} from '../shared/lims';
import {
  isEntityRecordArtifactProjection,
  REGISTRY_ARTIFACT_SEARCH_PROJECTION_KEY,
} from '../shared/registry-file-types';
import { registrySourceEligibilitySql } from './registry-source-eligibility';
import {
  isPortableEntitySchemaRevisionSnapshot,
  type ProjectableEntitySchemaRevisionSnapshot,
} from '../shared/entity-schema';
import {
  isProjectableRelationshipSchemaRevisionSnapshot,
  type ProjectableRelationshipSchemaRevisionSnapshot,
} from '../shared/relationship-schema';
import { validateSequenceSchemaPropertyFields } from '../shared/sequence-entity-schema';
import {
  BUILTIN_SEQUENCE_SCHEMA_ID,
  BUILTIN_SEQUENCE_SCHEMA_REVISION_ID,
  SEQUENCE_SCHEMA_FIELD_DEFINITIONS,
  SEQUENCE_SCHEMA_V2_FIELD_DEFINITIONS,
  SEQUENCE_SCHEMA_V2_REVISION_ID,
  SEQUENCE_SCHEMA_V1_REVISION_ID,
} from '../shared/sequence-entity-schema';
import { prepareCachedStatement } from './sqlite-statement-cache';

export const LOCAL_ACTOR = 'local-user';
export const LIMS_AUDIT_SCHEMA_VERSION = 1;
export const LIMS_LOCAL_CLIENT_ID = 'local-client';

export const LINEAGE_RELATIONSHIP_TYPES = new Set([
  'derives_from',
  'variant_of',
  'assembled_from',
  'has_part',
  'has_genome',

  'composed_of',
]);

export type ResolvedSchemaRevision = {
  schemaId: string;
  revisionId: string;
  fieldsJson: string;
};

export type AuditEventInput = {
  id?: string;
  eventType: string;
  subjectTable?: string | null;
  subjectId?: string | null;
  batchId?: string | null;
  actor?: string | null;
  workspaceId?: number | null;
  before?: unknown;
  after?: unknown;
  payload?: unknown;
  eventSeq?: number;
  schemaVersion?: number;
  idempotencyKey?: string;
  operationId?: string;
  actorClientId?: string;
  actorUserId?: string;
};

const seededLimsBuiltinDbs = new WeakSet<Database.Database>();
const activeFileSequencePathIndexDbs = new WeakSet<Database.Database>();
const initializedLimsEventSequenceDbs = new WeakSet<Database.Database>();

function ensureActiveFileSequencePathIndex(db: Database.Database): void {
  if (activeFileSequencePathIndexDbs.has(db)) return;

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_lims_entity_active_file_sequence_path
     ON lims_entity(trim(json_extract(fields, '$.sequence.relPath')))
     WHERE tombstone = 0
       AND archived_at IS NULL
       AND json_extract(fields, '$.sequence.mode') = 'file'
       AND json_type(fields, '$.sequence.relPath') = 'text'`
  );
  activeFileSequencePathIndexDbs.add(db);
}

export function upsertLimsSchemaProjectionInsideTx(
  db: Database.Database,
  row: LimsSchemaRow
): void {
  db.prepare(
    `INSERT INTO lims_schema (
      id, kind, name, display_name, description, fields, current_revision_id,
      version, builtin, workspace_id, actor, event_seq, tombstone,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      name = excluded.name,
      display_name = excluded.display_name,
      description = excluded.description,
      fields = excluded.fields,
      current_revision_id = excluded.current_revision_id,
      version = excluded.version,
      builtin = excluded.builtin,
      workspace_id = excluded.workspace_id,
      actor = excluded.actor,
      event_seq = excluded.event_seq,
      tombstone = excluded.tombstone,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      archived_at = excluded.archived_at`
  ).run(
    row.id,
    row.kind,
    row.name,
    row.display_name,
    row.description,
    row.fields,
    row.current_revision_id,
    row.version,
    row.builtin,
    row.workspace_id,
    row.actor,
    row.event_seq,
    row.tombstone,
    row.created_at,
    row.updated_at,
    row.archived_at
  );
}

export function upsertLimsSchemaRevisionProjectionInsideTx(
  db: Database.Database,
  row: LimsSchemaRevisionRow
): void {
  db.prepare(
    `INSERT INTO lims_schema_revision (
      id, schema_id, version, fields, actor, workspace_id, event_seq,
      tombstone, created_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      schema_id = excluded.schema_id,
      version = excluded.version,
      fields = excluded.fields,
      actor = excluded.actor,
      workspace_id = excluded.workspace_id,
      event_seq = excluded.event_seq,
      tombstone = excluded.tombstone,
      created_at = excluded.created_at,
      archived_at = excluded.archived_at`
  ).run(
    row.id,
    row.schema_id,
    row.version,
    row.fields,
    row.actor,
    row.workspace_id,
    row.event_seq,
    row.tombstone,
    row.created_at,
    row.archived_at
  );
}

export function defineLimsSchemaInsideTx(
  db: Database.Database,
  input: LimsDefineSchemaInput
): LimsSchemaRow {
  validateSchemaInput(input.fields, input.baseKind, input.kind);
  validateSequenceSchemaPropertyFields(input.fields, input.baseKind);
  const existingByName = db
    .prepare(`SELECT * FROM lims_schema WHERE kind = ? AND name = ? AND tombstone = 0 LIMIT 1`)
    .get(input.kind, input.name) as LimsSchemaRow | undefined;
  if (existingByName) {
    if (input.existingPolicy === 'reject') {
      throw new Error(`Schema name already exists: ${input.name}`);
    }
    return existingByName;
  }

  const schemaId = input.id ?? randomUUID();
  const revisionId = `${schemaId}-v1`;
  const seq = nextEventSeq(db);
  const now = Date.now();
  const fieldsJson = serializeLimsSchemaDefinition({
    fields: input.fields,
    baseKind: input.baseKind ?? input.name,
  });
  const row: LimsSchemaRow = {
    id: schemaId,
    kind: input.kind,
    name: input.name,
    display_name: input.displayName,
    description: input.description ?? null,
    fields: fieldsJson,
    current_revision_id: revisionId,
    version: 1,
    builtin: input.builtin ? 1 : 0,
    workspace_id: input.workspaceId ?? null,
    actor: input.actor ?? LOCAL_ACTOR,
    event_seq: seq,
    tombstone: 0,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  const revisionRow: LimsSchemaRevisionRow = {
    id: revisionId,
    schema_id: schemaId,
    version: 1,
    fields: fieldsJson,
    actor: input.actor ?? LOCAL_ACTOR,
    workspace_id: input.workspaceId ?? null,
    event_seq: seq,
    tombstone: 0,
    created_at: now,
    archived_at: null,
  };
  insertAuditEvent(db, {
    eventSeq: seq,
    eventType: 'schema_defined',
    subjectTable: 'lims_schema',
    subjectId: schemaId,
    actor: input.actor ?? LOCAL_ACTOR,
    workspaceId: input.workspaceId ?? null,
    after: { schema: row, revision: revisionRow },
  });
  upsertLimsSchemaProjectionInsideTx(db, row);
  upsertLimsSchemaRevisionProjectionInsideTx(db, revisionRow);
  if (input.kind === 'entity') ensureDefaultIdSchemeInsideTx(db, input.name);
  return row;
}

export function upsertLimsEntityProjectionInsideTx(
  db: Database.Database,
  entity: LimsEntity
): void {
  if (entity.workspaceId == null)
    throw new Error('Every saved Registry entity must belong to a project.');
  assertFileAuthoritativeEntityHasWorkspace(entity);
  writeLimsEntityProjectionInsideTx(db, entity);
}

export function replayHistoricalLimsEntityProjectionInsideTx(
  db: Database.Database,
  entity: LimsEntity
): void {
  writeLimsEntityProjectionInsideTx(db, entity);
}

function writeLimsEntityProjectionInsideTx(db: Database.Database, entity: LimsEntity): void {
  prepareCachedStatement(
    db,
    `INSERT INTO lims_entity (
      id, kind, schema_id, schema_revision_id, name, registry_id, fields, registration_status,
      domain_status, workspace_id, actor, event_seq, tombstone,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      schema_id = excluded.schema_id,
      schema_revision_id = excluded.schema_revision_id,
      name = excluded.name,
      registry_id = excluded.registry_id,
      fields = excluded.fields,
      registration_status = excluded.registration_status,
      domain_status = excluded.domain_status,
      workspace_id = excluded.workspace_id,
      actor = excluded.actor,
      event_seq = excluded.event_seq,
      tombstone = excluded.tombstone,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      archived_at = excluded.archived_at`
  ).run(
    entity.id,
    entity.kind,
    entity.schemaId,
    entity.schemaRevisionId,
    entity.name,
    entity.registryId,
    JSON.stringify(entity.fields),
    entity.registrationStatus,
    entity.domainStatus,
    entity.workspaceId,
    entity.actor,
    entity.eventSeq,
    entity.tombstone ? 1 : 0,
    entity.createdAt,
    entity.updatedAt,
    entity.archivedAt
  );
  synchronizeArtifactRegistryCatalogProjectionInsideTx(db, entity);
}

function synchronizeArtifactRegistryCatalogProjectionInsideTx(
  db: Database.Database,
  entity: LimsEntity
): void {
  const locator = `entity://lims/${entity.id}`;
  const existing = prepareCachedStatement(
    db,
    'SELECT type,storage_type,locator,workspace_id,metadata FROM catalog_entities WHERE id=?'
  ).get(entity.id) as
    | {
        type: string;
        storage_type: string;
        locator: string;
        workspace_id: number | null;
        metadata: string | null;
      }
    | undefined;
  let owned = false;
  if (
    existing?.type === 'record' &&
    existing.storage_type === 'database' &&
    existing.locator === locator
  ) {
    try {
      owned =
        JSON.parse(existing.metadata ?? '{}')?.[REGISTRY_ARTIFACT_SEARCH_PROJECTION_KEY] === true;
    } catch {
      owned = false;
    }
  }
  if (existing && !owned) return;
  const eligible =
    prepareCachedStatement(
      db,
      `SELECT id FROM lims_entity WHERE id=? AND (${registrySourceEligibilitySql(db)})`
    ).get(entity.id) !== undefined;
  if (!isEntityRecordArtifactProjection(entity.fields) || !eligible) {
    if (owned)
      prepareCachedStatement(
        db,
        "UPDATE catalog_entities SET status='missing',updated_at=? WHERE id=?"
      ).run(entity.updatedAt, entity.id);
    return;
  }
  const workspaceId = entity.workspaceId ?? existing?.workspace_id;
  if (workspaceId == null) return;
  prepareCachedStatement(
    db,
    `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,status,workspace_id,metadata,created_at,updated_at)
     VALUES (?,'record',?,?,'database',?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,
       workspace_id=excluded.workspace_id,updated_at=excluded.updated_at`
  ).run(
    entity.id,
    entity.name,
    locator,
    entity.tombstone ? 'archived' : 'active',
    workspaceId,
    JSON.stringify({ [REGISTRY_ARTIFACT_SEARCH_PROJECTION_KEY]: true }),
    entity.createdAt,
    entity.updatedAt
  );
}

export function retireArtifactRegistryCatalogProjectionInsideTx(db: Database.Database): void {
  prepareCachedStatement(
    db,
    `UPDATE catalog_entities SET status='missing'
     WHERE type='record' AND storage_type='database' AND locator='entity://lims/'||id
       AND CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.${REGISTRY_ARTIFACT_SEARCH_PROJECTION_KEY}') ELSE 0 END=1`
  ).run();
}

export function assertFileAuthoritativeEntityHasWorkspace(
  entity: Pick<LimsEntity, 'fields' | 'workspaceId' | 'tombstone' | 'archivedAt'>
): void {
  if (entity.tombstone || entity.archivedAt !== null) return;
  if (isEntityRecordArtifactProjection(entity.fields) && entity.workspaceId == null) {
    throw new Error('A file-authoritative Registry record requires an owning workspace.');
  }
}

function fileBackedSequenceRelPath(fields: Record<string, unknown>): string | null {
  const sequence = fields.sequence as Partial<DnaSequenceRef> | undefined;
  if (sequence?.mode !== 'file') return null;
  const relPath = typeof sequence.relPath === 'string' ? sequence.relPath.trim() : '';
  return relPath.length > 0 ? relPath : null;
}

export function assertActiveFileSequenceOwnerIsUnique(
  db: Database.Database,
  entity: Pick<LimsEntity, 'id' | 'name' | 'fields' | 'tombstone' | 'archivedAt'>
): void {
  if (entity.tombstone || entity.archivedAt !== null) return;
  const relPath = fileBackedSequenceRelPath(entity.fields);
  if (!relPath) return;
  ensureActiveFileSequencePathIndex(db);

  const existing = prepareCachedStatement(
    db,
    `SELECT id, name FROM lims_entity
       WHERE tombstone = 0
         AND archived_at IS NULL
         AND id != ?
         AND json_extract(fields, '$.sequence.mode') = 'file'
         AND json_type(fields, '$.sequence.relPath') = 'text'
         AND trim(json_extract(fields, '$.sequence.relPath')) = ?
       LIMIT 1`
  ).get(entity.id, relPath) as { id: string; name: string } | undefined;
  if (!existing) return;
  throw new Error(
    `File-backed sequence ${relPath} is already owned by active LIMS entity ` +
      `"${existing.name}" (${existing.id}). Archive or fork that entity before ` +
      `registering another active owner for the same file.`
  );
}

export function upsertLimsLinkProjectionInsideTx(db: Database.Database, link: LimsLink): void {
  prepareCachedStatement(
    db,
    `INSERT INTO lims_link (
      id, from_entity_id, to_entity_id, type, payload, workspace_id, actor,
      event_seq, tombstone, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      from_entity_id = excluded.from_entity_id,
      to_entity_id = excluded.to_entity_id,
      type = excluded.type,
      payload = excluded.payload,
      workspace_id = excluded.workspace_id,
      actor = excluded.actor,
      event_seq = excluded.event_seq,
      tombstone = excluded.tombstone,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      archived_at = excluded.archived_at`
  ).run(
    link.id,
    link.fromEntityId,
    link.toEntityId,
    link.type,
    JSON.stringify(link.payload),
    link.workspaceId,
    link.actor,
    link.eventSeq,
    link.tombstone ? 1 : 0,
    link.createdAt,
    link.updatedAt,
    link.archivedAt
  );
}

export function seedLimsBuiltinsInDb(db: Database.Database): void {
  if (seededLimsBuiltinDbs.has(db)) return;
  db.transaction(() => {
    migrateLegacyPlasmidSchemaInsideTx(db);
    for (const schema of LIMS_BUILTIN_SCHEMAS) {
      const schemaId = deterministicSchemaId(schema.kind, schema.name);
      const schemaVersion = schema.version ?? 1;
      const revisionId = `${schemaId}-v${schemaVersion}`;
      const existing = db.prepare(`SELECT id FROM lims_schema WHERE id = ?`).get(schemaId) as
        | { id: string }
        | undefined;
      if (existing) {
        const revision = db
          .prepare(`SELECT id FROM lims_schema_revision WHERE id = ?`)
          .get(revisionId) as { id: string } | undefined;
        if (!revision) {
          const seq = nextEventSeq(db);
          const now = Date.now();
          const fieldsJson = limsSchemaFieldsJson(schema);
          const current = getSchemaById(db, schemaId);
          const advanceCurrent = current.version < schemaVersion;
          const schemaRow: LimsSchemaRow = advanceCurrent
            ? {
                ...current,
                fields: fieldsJson,
                current_revision_id: revisionId,
                version: schemaVersion,
                event_seq: seq,
                updated_at: now,
              }
            : current;
          const revisionRow: LimsSchemaRevisionRow = {
            id: revisionId,
            schema_id: schemaId,
            version: schemaVersion,
            fields: fieldsJson,
            actor: LOCAL_ACTOR,
            workspace_id: null,
            event_seq: seq,
            tombstone: 0,
            created_at: now,
            archived_at: null,
          };
          insertAuditEvent(db, {
            eventSeq: seq,
            eventType: 'schema_seeded',
            subjectTable: 'lims_schema',
            subjectId: schemaId,
            actor: LOCAL_ACTOR,
            after: { schema: schemaRow, revision: revisionRow },
          });
          upsertLimsSchemaRevisionProjectionInsideTx(db, revisionRow);
          if (advanceCurrent) upsertLimsSchemaProjectionInsideTx(db, schemaRow);
        }
        continue;
      }

      const seq = nextEventSeq(db);
      const now = Date.now();
      const fieldsJson = limsSchemaFieldsJson(schema);
      const schemaRow: LimsSchemaRow = {
        id: schemaId,
        kind: schema.kind,
        name: schema.name,
        display_name: schema.displayName,
        description: schema.description,
        fields: fieldsJson,
        current_revision_id: revisionId,
        version: schemaVersion,
        builtin: schema.builtin ? 1 : 0,
        workspace_id: null,
        actor: LOCAL_ACTOR,
        event_seq: seq,
        tombstone: 0,
        created_at: now,
        updated_at: now,
        archived_at: null,
      };
      const revisionRow: LimsSchemaRevisionRow = {
        id: revisionId,
        schema_id: schemaId,
        version: schemaVersion,
        fields: fieldsJson,
        actor: LOCAL_ACTOR,
        workspace_id: null,
        event_seq: seq,
        tombstone: 0,
        created_at: now,
        archived_at: null,
      };
      insertAuditEvent(db, {
        eventSeq: seq,
        eventType: 'schema_seeded',
        subjectTable: 'lims_schema',
        subjectId: schemaId,
        actor: LOCAL_ACTOR,
        after: { schema: schemaRow, revision: revisionRow },
      });
      upsertLimsSchemaProjectionInsideTx(db, schemaRow);
      upsertLimsSchemaRevisionProjectionInsideTx(db, revisionRow);
    }
    seedSequenceSchemaV2InsideTx(db);
    seedSequenceSchemaV3InsideTx(db);

    const seedNow = Date.now();
    for (const kind of LIMS_ENTITY_KINDS) {
      const def = LIMS_DEFAULT_ID_SCHEMES[kind];
      db.prepare(
        `INSERT OR IGNORE INTO lims_id_scheme (kind, prefix, pad_width, next_seq, enabled, updated_at)
         VALUES (?, ?, ?, 1, 1, ?)`
      ).run(kind, def.prefix, def.padWidth, seedNow);
    }
  })();

  if (!db.inTransaction) seededLimsBuiltinDbs.add(db);
}

function migrateLegacyPlasmidSchemaInsideTx(db: Database.Database): void {
  const schemaId = deterministicSchemaId('entity', 'plasmid');
  const current = db
    .prepare(`SELECT * FROM lims_schema WHERE id = ? AND tombstone = 0 LIMIT 1`)
    .get(schemaId) as LimsSchemaRow | undefined;
  if (!current || current.builtin !== 1) return;
  const definition = parseLimsSchemaFields(current.fields);
  if (definition.baseKind === 'sequence') return;

  const maxRevision = db
    .prepare(`SELECT MAX(version) AS version FROM lims_schema_revision WHERE schema_id = ?`)
    .get(schemaId) as { version: number | null };
  const nextVersion = Math.max(current.version, maxRevision.version ?? 0) + 1;
  const revisionId = `${schemaId}-v${nextVersion}`;
  const fields = definition.fields.filter(
    (field) => field.key !== 'sequence' && field.key !== 'type'
  );
  const fieldsJson = serializeLimsSchemaDefinition({
    fields,
    relationship: definition.relationship,
    baseKind: 'sequence',
  });
  const seq = nextEventSeq(db);
  const now = Date.now();
  const after: LimsSchemaRow = {
    ...current,
    fields: fieldsJson,
    current_revision_id: revisionId,
    version: nextVersion,
    actor: LOCAL_ACTOR,
    event_seq: seq,
    updated_at: now,
  };
  const revision: LimsSchemaRevisionRow = {
    id: revisionId,
    schema_id: schemaId,
    version: nextVersion,
    fields: fieldsJson,
    actor: LOCAL_ACTOR,
    workspace_id: current.workspace_id,
    event_seq: seq,
    tombstone: 0,
    created_at: now,
    archived_at: null,
  };
  insertAuditEvent(db, {
    eventSeq: seq,
    eventType: 'schema_refined',
    subjectTable: 'lims_schema',
    subjectId: schemaId,
    actor: LOCAL_ACTOR,
    workspaceId: current.workspace_id,
    before: current,
    after: { schema: after, revision },
    payload: { reason: 'inherit_sequence_primitive' },
  });
  upsertLimsSchemaRevisionProjectionInsideTx(db, revision);
  upsertLimsSchemaProjectionInsideTx(db, after);
}

function seedSequenceSchemaV2InsideTx(db: Database.Database): void {
  const current = getSchemaById(db, BUILTIN_SEQUENCE_SCHEMA_ID);
  const fieldsJson = serializeLimsSchemaDefinition({
    fields: SEQUENCE_SCHEMA_V2_FIELD_DEFINITIONS,
    baseKind: 'sequence',
  });
  const existing = db
    .prepare(`SELECT * FROM lims_schema_revision WHERE id = ?`)
    .get(SEQUENCE_SCHEMA_V2_REVISION_ID) as LimsSchemaRevisionRow | undefined;
  if (
    existing &&
    (existing.schema_id !== BUILTIN_SEQUENCE_SCHEMA_ID ||
      existing.version !== 2 ||
      stableJson(parseLimsSchemaFields(existing.fields)) !==
        stableJson(parseLimsSchemaFields(fieldsJson)))
  ) {
    if (existing.schema_id === BUILTIN_SEQUENCE_SCHEMA_ID && existing.version === 2) return;
    throw new Error(`Schema revision collision for ${SEQUENCE_SCHEMA_V2_REVISION_ID}.`);
  }
  if (!existing) {
    const versionOwner = db
      .prepare(`SELECT id FROM lims_schema_revision WHERE schema_id = ? AND version = 2 LIMIT 1`)
      .get(BUILTIN_SEQUENCE_SCHEMA_ID) as { id: string } | undefined;

    if (versionOwner) return;
  }
  const promote = current.current_revision_id === SEQUENCE_SCHEMA_V1_REVISION_ID;
  if (existing && !promote) return;
  const seq = nextEventSeq(db);
  const now = Date.now();
  const schemaRow: LimsSchemaRow = promote
    ? {
        ...current,
        fields: fieldsJson,
        current_revision_id: SEQUENCE_SCHEMA_V2_REVISION_ID,
        version: 2,
        event_seq: seq,
        updated_at: now,
      }
    : current;
  const revisionRow: LimsSchemaRevisionRow = existing ?? {
    id: SEQUENCE_SCHEMA_V2_REVISION_ID,
    schema_id: BUILTIN_SEQUENCE_SCHEMA_ID,
    version: 2,
    fields: fieldsJson,
    actor: LOCAL_ACTOR,
    workspace_id: null,
    event_seq: seq,
    tombstone: 0,
    created_at: now,
    archived_at: null,
  };
  insertAuditEvent(db, {
    eventSeq: seq,
    eventType: 'schema_seeded',
    subjectTable: 'lims_schema',
    subjectId: BUILTIN_SEQUENCE_SCHEMA_ID,
    actor: LOCAL_ACTOR,
    before: current,
    after: { schema: schemaRow, revision: revisionRow },
  });
  if (!existing) upsertLimsSchemaRevisionProjectionInsideTx(db, revisionRow);
  if (promote) upsertLimsSchemaProjectionInsideTx(db, schemaRow);
}

function seedSequenceSchemaV3InsideTx(db: Database.Database): void {
  const current = getSchemaById(db, BUILTIN_SEQUENCE_SCHEMA_ID);
  const currentDefinition = stableJson(parseLimsSchemaFields(current.fields));
  const shippedDefinitions = [
    SEQUENCE_SCHEMA_FIELD_DEFINITIONS,
    SEQUENCE_SCHEMA_V2_FIELD_DEFINITIONS,
  ].map((fields) =>
    stableJson(
      parseLimsSchemaFields(serializeLimsSchemaDefinition({ fields, baseKind: 'sequence' }))
    )
  );

  if (current.version > 1 && !shippedDefinitions.includes(currentDefinition)) return;
  const fieldsJson = serializeLimsSchemaDefinition({
    fields: SEQUENCE_SCHEMA_FIELD_DEFINITIONS,
    baseKind: 'sequence',
  });
  const existing = db
    .prepare(`SELECT * FROM lims_schema_revision WHERE id = ?`)
    .get(BUILTIN_SEQUENCE_SCHEMA_REVISION_ID) as LimsSchemaRevisionRow | undefined;
  if (
    existing &&
    (existing.schema_id !== BUILTIN_SEQUENCE_SCHEMA_ID ||
      existing.version !== 3 ||
      stableJson(parseLimsSchemaFields(existing.fields)) !==
        stableJson(parseLimsSchemaFields(fieldsJson)))
  ) {
    throw new Error(`Schema revision collision for ${BUILTIN_SEQUENCE_SCHEMA_REVISION_ID}.`);
  }
  if (!existing) {
    const versionOwner = db
      .prepare(`SELECT id FROM lims_schema_revision WHERE schema_id = ? AND version = 3 LIMIT 1`)
      .get(BUILTIN_SEQUENCE_SCHEMA_ID) as { id: string } | undefined;

    if (versionOwner) return;
  }
  const promote =
    current.current_revision_id === SEQUENCE_SCHEMA_V1_REVISION_ID ||
    current.current_revision_id === SEQUENCE_SCHEMA_V2_REVISION_ID;
  if (existing && !promote) return;
  const seq = nextEventSeq(db);
  const now = Date.now();
  const schemaRow: LimsSchemaRow = promote
    ? {
        ...current,
        fields: fieldsJson,
        current_revision_id: BUILTIN_SEQUENCE_SCHEMA_REVISION_ID,
        version: 3,
        event_seq: seq,
        updated_at: now,
      }
    : current;
  const revisionRow: LimsSchemaRevisionRow = existing ?? {
    id: BUILTIN_SEQUENCE_SCHEMA_REVISION_ID,
    schema_id: BUILTIN_SEQUENCE_SCHEMA_ID,
    version: 3,
    fields: fieldsJson,
    actor: LOCAL_ACTOR,
    workspace_id: null,
    event_seq: seq,
    tombstone: 0,
    created_at: now,
    archived_at: null,
  };
  insertAuditEvent(db, {
    eventSeq: seq,
    eventType: 'schema_seeded',
    subjectTable: 'lims_schema',
    subjectId: BUILTIN_SEQUENCE_SCHEMA_ID,
    actor: LOCAL_ACTOR,
    before: current,
    after: { schema: schemaRow, revision: revisionRow },
  });
  if (!existing) upsertLimsSchemaRevisionProjectionInsideTx(db, revisionRow);
  if (promote) upsertLimsSchemaProjectionInsideTx(db, schemaRow);
}

export function clearLimsRegistryInsideTx(db: Database.Database): void {
  retireLimsRegistryRowsInsideTx(
    db,
    db
      .prepare(`SELECT * FROM lims_entity WHERE tombstone = 0 ORDER BY id`)
      .all() as LimsEntityRow[],
    db.prepare(`SELECT * FROM lims_link WHERE tombstone = 0 ORDER BY id`).all() as LimsLinkRow[],
    'scenario_registry_cleared'
  );
}

export function clearDevSeededLimsRegistryInsideTx(
  db: Database.Database,
  idPrefixes: readonly string[]
): void {
  if (idPrefixes.length === 0) return;
  if (idPrefixes.some((prefix) => prefix.length === 0)) {
    throw new Error('Developer seed cleanup requires nonempty identity prefixes.');
  }
  const entityParams = idPrefixes.flatMap((prefix) => [prefix, prefix]);
  const entityWhere = idPrefixes.map(() => `substr(id, 1, length(?)) = ?`).join(' OR ');
  const linkWhere = idPrefixes
    .map(() => `substr(from_entity_id, 1, length(?)) = ? OR substr(to_entity_id, 1, length(?)) = ?`)
    .join(' OR ');
  const linkParams = idPrefixes.flatMap((prefix) => [prefix, prefix, prefix, prefix]);
  retireLimsRegistryRowsInsideTx(
    db,
    db
      .prepare(`SELECT * FROM lims_entity WHERE tombstone = 0 AND (${entityWhere}) ORDER BY id`)
      .all(...entityParams) as LimsEntityRow[],
    db
      .prepare(`SELECT * FROM lims_link WHERE tombstone = 0 AND (${linkWhere}) ORDER BY id`)
      .all(...linkParams) as LimsLinkRow[],
    'developer_seed_replaced'
  );
}

function retireLimsRegistryRowsInsideTx(
  db: Database.Database,
  entities: readonly LimsEntityRow[],
  links: readonly LimsLinkRow[],
  reason: string
): void {
  if (!db.inTransaction) throw new Error('Registry cleanup requires an active transaction.');
  const now = Date.now();
  for (const row of links) {
    const before = limsLinkFromRow(row);
    const after: LimsLink = {
      ...before,
      actor: LOCAL_ACTOR,
      eventSeq: nextEventSeq(db),
      tombstone: true,
      updatedAt: now,
      archivedAt: now,
    };
    insertAuditEvent(db, {
      eventSeq: after.eventSeq ?? undefined,
      eventType: 'link_tombstoned',
      subjectTable: 'lims_link',
      subjectId: after.id,
      actor: after.actor,
      workspaceId: after.workspaceId,
      before,
      after,
      payload: { reason },
    });
    upsertLimsLinkProjectionInsideTx(db, after);
  }
  for (const row of entities) {
    const before = limsEntityFromRow(row);
    const after: LimsEntity = {
      ...before,
      actor: LOCAL_ACTOR,
      eventSeq: nextEventSeq(db),
      tombstone: true,
      updatedAt: now,
      archivedAt: now,
    };
    insertAuditEvent(db, {
      eventSeq: after.eventSeq ?? undefined,
      eventType: 'entity_tombstoned',
      subjectTable: 'lims_entity',
      subjectId: after.id,
      actor: after.actor,
      workspaceId: after.workspaceId,
      before,
      after,
      payload: { reason },
    });
    upsertLimsEntityProjectionInsideTx(db, after);
  }
}

export function resetLimsRegistryInDb(db: Database.Database): LimsResetRegistryResult {
  seedLimsBuiltinsInDb(db);
  return db.transaction((): LimsResetRegistryResult => {
    clearLimsRegistryInsideTx(db);
    return { cleared: true, entityCount: 0 };
  })();
}

export interface LimsIdSchemeRow {
  kind: string;
  prefix: string;
  pad_width: number;
  next_seq: number;
  enabled: number;
  updated_at: number;
}

export function limsIdSchemeFromRow(row: LimsIdSchemeRow): LimsIdScheme {
  return {
    kind: row.kind,
    prefix: row.prefix,
    padWidth: row.pad_width,
    nextSeq: row.next_seq,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

export function getIdSchemeRow(db: Database.Database, kind: string): LimsIdSchemeRow | undefined {
  return prepareCachedStatement(db, `SELECT * FROM lims_id_scheme WHERE kind = ?`).get(kind) as
    | LimsIdSchemeRow
    | undefined;
}

export function getLimsIdSchemesInDb(db: Database.Database): LimsIdScheme[] {
  seedLimsBuiltinsInDb(db);
  const rows = db
    .prepare(`SELECT * FROM lims_id_scheme ORDER BY kind ASC`)
    .all() as LimsIdSchemeRow[];
  return rows.map(limsIdSchemeFromRow);
}

export function allocateRegistryIdInsideTx(
  db: Database.Database,
  kind: string,
  now: number
): string | null {
  const row = getIdSchemeRow(db, kind);
  if (!row || row.enabled !== 1) return null;
  const exists = prepareCachedStatement(
    db,
    `SELECT 1 FROM lims_entity WHERE registry_id = ? LIMIT 1`
  );
  let seq = row.next_seq;
  let candidate = formatRegistryId(row.prefix, row.pad_width, seq);
  while (exists.get(candidate)) {
    seq += 1;
    candidate = formatRegistryId(row.prefix, row.pad_width, seq);
  }
  prepareCachedStatement(
    db,
    `UPDATE lims_id_scheme SET next_seq = ?, updated_at = ? WHERE kind = ?`
  ).run(seq + 1, now, kind);
  return candidate;
}

export function ensureDefaultIdSchemeInsideTx(db: Database.Database, kind: string): void {
  if (getIdSchemeRow(db, kind)) return;
  const base =
    kind
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 3) || 'x';
  const prefixTaken = (p: string): boolean =>
    Boolean(
      db.prepare(`SELECT 1 FROM lims_id_scheme WHERE prefix = ? AND enabled = 1 LIMIT 1`).get(p)
    );
  let prefix = base;
  let n = 1;
  while (prefixTaken(prefix)) {
    prefix = `${base}${n}`;
    n += 1;
  }
  db.prepare(
    `INSERT OR IGNORE INTO lims_id_scheme (kind, prefix, pad_width, next_seq, enabled, updated_at)
     VALUES (?, ?, 6, 1, 1, ?)`
  ).run(kind, prefix, Date.now());
}

export function setLimsIdSchemeInDb(
  db: Database.Database,
  input: LimsSetIdSchemeInput
): LimsIdScheme {
  seedLimsBuiltinsInDb(db);

  const hasSchema = db
    .prepare(
      `SELECT 1 FROM lims_schema WHERE kind = 'entity' AND name = ? AND tombstone = 0 LIMIT 1`
    )
    .get(input.kind);
  if (!hasSchema) {
    throw new Error(
      `No entity schema defined for kind "${input.kind}" — define the kind before configuring its ID scheme`
    );
  }
  const existing = getIdSchemeRow(db, input.kind);
  const prefix = input.prefix !== undefined ? input.prefix.trim() : (existing?.prefix ?? '');
  if (input.prefix !== undefined && prefix.length === 0) {
    throw new Error('Registry ID prefix cannot be empty');
  }
  const padWidth = input.padWidth ?? existing?.pad_width ?? 6;
  if (!Number.isInteger(padWidth) || padWidth < 0 || padWidth > LIMS_ID_SCHEME_MAX_PAD_WIDTH) {
    throw new Error(`padWidth must be an integer between 0 and ${LIMS_ID_SCHEME_MAX_PAD_WIDTH}`);
  }
  const enabled = input.enabled ?? existing?.enabled === 1;

  if (enabled) {
    const clash = db
      .prepare(`SELECT kind FROM lims_id_scheme WHERE prefix = ? AND enabled = 1 AND kind != ?`)
      .get(prefix, input.kind) as { kind: string } | undefined;
    if (clash) {
      throw new Error(`Prefix "${prefix}" is already used by the ${clash.kind} scheme`);
    }
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO lims_id_scheme (kind, prefix, pad_width, next_seq, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET prefix = excluded.prefix, pad_width = excluded.pad_width,
       enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(input.kind, prefix, padWidth, existing?.next_seq ?? 1, enabled ? 1 : 0, now);
  return limsIdSchemeFromRow(getIdSchemeRow(db, input.kind)!);
}

export function backfillLimsRegistryIdsInDb(
  db: Database.Database,
  input: LimsBackfillRegistryIdsInput = {}
): LimsBackfillRegistryIdsResult {
  seedLimsBuiltinsInDb(db);
  const byKind: Record<string, number> = {};
  let assigned = 0;
  db.transaction(() => {
    const kinds = input.kind ? [input.kind] : [...LIMS_ENTITY_KINDS];
    for (const kind of kinds) {
      const schemeRow = getIdSchemeRow(db, kind);
      if (!schemeRow || schemeRow.enabled !== 1) continue;
      const rows = db
        .prepare(
          `SELECT id FROM lims_entity
           WHERE kind = ? AND tombstone = 0 AND (registry_id IS NULL OR registry_id = '')
           ORDER BY event_seq ASC, created_at ASC, id ASC`
        )
        .all(kind) as Array<{ id: string }>;
      for (const row of rows) {
        const now = Date.now();
        const registryId = allocateRegistryIdInsideTx(db, kind, now);
        if (!registryId) break;

        const before = limsEntityFromRow(getEntityRowById(db, row.id));
        const seq = nextEventSeq(db);
        const after: LimsEntity = {
          ...before,
          registryId,
          eventSeq: seq,
          updatedAt: now,
        };
        insertAuditEvent(db, {
          eventSeq: seq,
          eventType: 'entity_registry_id_assigned',
          subjectTable: 'lims_entity',
          subjectId: row.id,
          batchId: null,
          actor: input.actor ?? LOCAL_ACTOR,
          workspaceId: after.workspaceId,
          before,
          after,
        });
        upsertLimsEntityProjectionInsideTx(db, after);
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        assigned += 1;
      }
    }
  })();
  return { assigned, byKind };
}

export function relocateLimsEntityFileRefsInDb(
  db: Database.Database,
  input: {
    workspaceRoot: string;
    oldPath: string;
    newPath: string;
    actor?: string;
    savedPrimers?: ReadonlyMap<string, RelocatedSavedPrimer>;
  }
): { rebasedEntityIds: string[]; workspaceIds: Array<number | null> } {
  const oldAbs = stripTrailingSep(resolve(input.oldPath));
  const newAbs = stripTrailingSep(resolve(input.newPath));
  const wsRoot = stripTrailingSep(resolve(input.workspaceRoot));
  const result = { rebasedEntityIds: [] as string[], workspaceIds: [] as Array<number | null> };
  if (oldAbs === newAbs) return result;

  const wsRow = db.prepare(`SELECT id FROM workspaces WHERE path = ?`).get(wsRoot) as
    | { id: number }
    | undefined;
  const wsId = wsRow?.id ?? null;

  const rebaseWsRelative = (rel: string): string | null => {
    const abs = resolve(wsRoot, rel);
    if (!isPathInsideBoundary(abs, oldAbs)) return rel;
    return pathRelativeToBoundary(rebasePath(abs, oldAbs, newAbs), wsRoot);
  };

  const rows = db.prepare(`SELECT * FROM lims_entity`).all() as LimsEntityRow[];
  for (const row of rows) {
    const before = limsEntityFromRow(row);
    const fields = before.fields as Record<string, unknown>;
    const nextFields: Record<string, unknown> = { ...fields };
    let changed = false;

    const seq = fields.sequence as
      | (Extract<DnaSequenceRef, { mode: 'file' }> & { relPath?: unknown })
      | undefined;
    if (seq?.mode === 'file' && typeof seq.relPath === 'string') {
      let resolved: { absolutePath: string; workspaceRoot: string | null } | null = null;
      try {
        resolved = resolveSequenceAbsolutePath(db, seq);
      } catch {
        resolved = null;
      }
      if (resolved && isPathInsideBoundary(resolved.absolutePath, oldAbs)) {
        const rebasedAbs = rebasePath(resolved.absolutePath, oldAbs, newAbs);
        const newRelPath = isAbsolute(seq.relPath)
          ? rebasedAbs
          : resolved.workspaceRoot
            ? (pathRelativeToBoundary(rebasedAbs, resolved.workspaceRoot) ?? rebasedAbs)
            : rebasedAbs;
        nextFields.sequence = { ...seq, relPath: newRelPath };
        changed = true;
      }
    }

    if (before.workspaceId != null && before.workspaceId === wsId) {
      const artifact = fields.artifact as { relativePath?: unknown } | undefined;

      if (
        artifact &&
        typeof artifact.relativePath === 'string' &&
        !isEntityRecordArtifactProjection(fields)
      ) {
        const rebased = rebaseWsRelative(artifact.relativePath);
        if (rebased != null && rebased !== artifact.relativePath) {
          nextFields.artifact = { ...artifact, relativePath: rebased };
          changed = true;
        }
      }
      const bindings = fields.bindings;
      if (Array.isArray(bindings)) {
        let bindingsChanged = false;
        const nextBindings = bindings.map((b) => {
          const bind = b as { target?: { workspaceRelativePath?: unknown } };
          const rel = bind.target?.workspaceRelativePath;
          if (typeof rel === 'string') {
            const rebased = rebaseWsRelative(rel);
            if (rebased != null && rebased !== rel) {
              bindingsChanged = true;
              return { ...bind, target: { ...bind.target, workspaceRelativePath: rebased } };
            }
          }
          return b;
        });
        if (bindingsChanged) {
          nextFields.bindings = nextBindings;
          changed = true;
        }
      }
    }

    const saved = input.savedPrimers?.get(before.id);
    if (saved) {
      const artifact = nextFields.artifact;
      if (
        !artifact ||
        typeof artifact !== 'object' ||
        !('schema' in artifact) ||
        artifact.schema !== 'dnaforge.primer'
      )
        throw new Error('The registry does not own this saved primer.');
      nextFields.artifact = { ...artifact, relativePath: saved.relativePath, contentHash: saved.sha256 };
      nextFields.bindings = saved.bindings;
      changed = true;
    }
    if (!changed) continue;

    const eventSeq = nextEventSeq(db);
    const after: LimsEntity = {
      ...before,
      fields: nextFields,
      eventSeq,
      updatedAt: Date.now(),
    };
    if (!before.tombstone && before.archivedAt === null) {
      assertActiveFileSequenceOwnerIsUnique(db, after);
    }
    insertAuditEvent(db, {
      eventSeq,
      eventType: 'entity_updated',
      subjectTable: 'lims_entity',
      subjectId: before.id,
      batchId: null,
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: after.workspaceId,
      before,
      after,
    });
    upsertLimsEntityProjectionInsideTx(db, after);
    result.rebasedEntityIds.push(before.id);
    result.workspaceIds.push(after.workspaceId);
  }
  return result;
}

function sequenceGitHash(ref: DnaSequenceRef): string | null {
  if (ref.mode !== 'file') return null;
  const hash = ref.fileContentHash ?? ref.contentHash;
  return typeof hash === 'string' && hash.startsWith('git:') ? hash : null;
}

function runBundledGit(args: readonly string[], cwd: string): string {
  const { env, gitLocation } = setupEnvironment({});
  return execFileSync(gitLocation, [...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitSafeRefSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'entity';
}

function pathIsAtOrUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveSequenceAbsolutePath(
  db: Database.Database,
  ref: Extract<DnaSequenceRef, { mode: 'file' }>
): { absolutePath: string; workspaceRoot: string | null } {
  if (ref.workspaceId != null) {
    const workspace = prepareCachedStatement(db, `SELECT path FROM workspaces WHERE id = ?`).get(
      ref.workspaceId
    ) as { path: string } | undefined;
    if (workspace) {
      const workspaceRoot = resolve(workspace.path);
      const absolutePath = isAbsolute(ref.relPath)
        ? resolve(ref.relPath)
        : resolve(workspaceRoot, ref.relPath);
      if (!pathIsAtOrUnder(absolutePath, workspaceRoot)) {
        throw new Error(`file is outside workspace ${workspaceRoot}`);
      }
      return { absolutePath, workspaceRoot };
    }
  }
  return { absolutePath: resolve(ref.relPath), workspaceRoot: null };
}

function createContentPinForSequence(
  db: Database.Database,
  entity: LimsEntity,
  field: string,
  ref: Extract<DnaSequenceRef, { mode: 'file' }>
): LimsContentPin | null {
  const contentHash = sequenceGitHash(ref);
  if (!contentHash) return null;
  const expectedOid = contentHash.slice('git:'.length);
  const { absolutePath, workspaceRoot } = resolveSequenceAbsolutePath(db, ref);
  if (!workspaceRoot) {
    throw new Error('git content pins require a workspace-scoped file reference');
  }
  if (!existsSync(absolutePath)) {
    throw new Error(`LIMS git content pin cannot resolve file: ${ref.relPath}`);
  }
  try {
    const repoPath = runBundledGit(['rev-parse', '--show-toplevel'], dirname(absolutePath));
    if (resolve(repoPath) !== workspaceRoot) {
      throw new Error(`file is in repository ${repoPath}, not workspace ${workspaceRoot}`);
    }
    const relPath = relative(repoPath, absolutePath).replace(/\\/g, '/');
    if (!relPath || relPath.startsWith('..') || isAbsolute(relPath)) {
      throw new Error(`file is outside repository ${repoPath}`);
    }
    const blobOid = runBundledGit(['rev-parse', `HEAD:${relPath}`], repoPath);
    if (blobOid !== expectedOid) {
      throw new Error(`expected ${expectedOid}, found ${blobOid}`);
    }
    const commit = runBundledGit(['rev-parse', 'HEAD'], repoPath);
    const refName = `refs/dnaforge/lims-pins/${gitSafeRefSegment(entity.id)}/${entity.eventSeq ?? Date.now()}`;
    runBundledGit(['update-ref', refName, commit], repoPath);
    return {
      entityId: entity.id,
      field,
      relPath,
      contentHash,
      commit,
      ref: refName,
      repoPath,
    };
  } catch (err) {
    throw new Error(`LIMS git content pin failed for ${entity.id}.${field}: ${errorMessage(err)}`);
  }
}

export function createLimsContentPinsInsideTx(
  db: Database.Database,
  entity: LimsEntity
): LimsContentPin[] {
  const pins: LimsContentPin[] = [];
  for (const [field, value] of Object.entries(entity.fields)) {
    const ref = value as DnaSequenceRef | undefined;
    if (ref?.mode !== 'file') continue;
    const pin = createContentPinForSequence(db, entity, field, ref);
    if (pin) pins.push(pin);
  }
  return pins;
}

export function verifyLimsContentPinResolves(pin: LimsContentPin): boolean {
  if (!pin.repoPath || !existsSync(pin.repoPath)) return false;
  try {
    runBundledGit(['cat-file', '-e', `${pin.commit}^{commit}`], pin.repoPath);
    runBundledGit(
      ['cat-file', '-e', `${pin.contentHash.slice('git:'.length)}^{blob}`],
      pin.repoPath
    );
    const refCommit = runBundledGit(['rev-parse', pin.ref], pin.repoPath);
    return refCommit === pin.commit;
  } catch {
    return false;
  }
}

function deleteLimsContentPins(pins: readonly LimsContentPin[]): void {
  for (const pin of pins) {
    if (!pin.repoPath) continue;
    try {
      runBundledGit(['update-ref', '-d', pin.ref], pin.repoPath);
    } catch {}
  }
}

export function registerLimsEntityInsideTx(
  db: Database.Database,
  input: LimsRegisterEntityInput
): LimsEntity {
  return registerLimsEntityWithResolvedRegistryIdInsideTx(db, input);
}

export function classifyLimsSequenceInsideTx(
  db: Database.Database,
  input: {
    entityId: string;
    expectedEventSeq: number | null;
    use: (typeof LIMS_OLIGO_USES)[number] | null;
    actor?: string;
  }
): LimsEntity {
  if (!db.inTransaction) throw new Error('Sequence classification requires an active transaction.');
  const before = limsEntityFromRow(getEntityRowById(db, input.entityId));
  if (before.tombstone || before.archivedAt !== null)
    throw new Error('Cannot classify an archived sequence.');
  if (before.kind !== 'dna_sequence' && before.kind !== 'rna_sequence')
    throw new Error('Only a generic DNA or RNA sequence can be classified as an oligo.');
  if (before.eventSeq !== input.expectedEventSeq)
    throw new Error('Sequence changed since classification was reviewed.');
  const sequence = before.fields.sequence;
  if (
    !sequence ||
    typeof sequence !== 'object' ||
    !('mode' in sequence) ||
    (sequence.mode !== 'file' && sequence.mode !== 'inline') ||
    !('topology' in sequence) ||
    sequence.topology !== 'linear' ||
    !('length' in sequence) ||
    typeof sequence.length !== 'number' ||
    !Number.isSafeInteger(sequence.length) ||
    sequence.length <= 0
  )
    throw new Error('Classification requires a resolved, nonempty linear sequence.');
  const kind = before.kind === 'rna_sequence' ? 'rna_oligo' : 'oligo';
  const schema = resolveSchemaRevisionForKind(db, kind);
  const fields = { ...before.fields };
  if (input.use === null) delete fields.use;
  else fields.use = input.use;
  assertEntityValid(kind, fields, schema.fieldsJson);
  const eventSeq = nextEventSeq(db);
  const after: LimsEntity = {
    ...before,
    kind,
    schemaId: schema.schemaId,
    schemaRevisionId: schema.revisionId,
    fields,
    eventSeq,
    workspaceId: resolveSavedRegistryProject(db, {
      id: before.id,
      fields,
      workspaceId: before.workspaceId,
    }),
    actor: input.actor ?? LOCAL_ACTOR,
    updatedAt: Date.now(),
  };
  assertActiveFileSequenceOwnerIsUnique(db, after);
  insertAuditEvent(db, {
    eventSeq,
    eventType: 'entity_updated',
    subjectTable: 'lims_entity',
    subjectId: before.id,
    actor: after.actor,
    workspaceId: after.workspaceId,
    before,
    after,
    payload: { change: 'reviewed_oligo_classification' },
  });
  upsertLimsEntityProjectionInsideTx(db, after);
  return after;
}

export function updateLimsEntityInsideTx(
  db: Database.Database,
  input: LimsUpdateEntityInput
): LimsEntity {
  if (!db.inTransaction) {
    throw new Error('LIMS entity update requires an active transaction.');
  }
  if (input.relationshipTargets !== undefined)
    throw new Error('Relationship targets require the native record edit operation.');
  const existingRow = getEntityRowById(db, input.id);
  const existing = limsEntityFromRow(existingRow);
  if (input.workspaceId === null && existing.workspaceId != null)
    throw new Error(
      'A saved entity cannot be removed from its project. Choose a project to move it.'
    );
  if (
    input.expectedEventSeq !== undefined &&
    (!Number.isSafeInteger(input.expectedEventSeq) ||
      input.expectedEventSeq < 1 ||
      existing.eventSeq !== input.expectedEventSeq)
  ) {
    throw new Error('Registry record changed; refresh it before saving.');
  }
  if (input.projectionSchema) {
    if (
      input.actor !== 'workspace-reconcile' ||
      input.workspaceId == null ||
      input.replaceFields !== true ||
      input.fields === undefined
    ) {
      throw new Error(
        'Schema reprojection requires a complete file-authoritative workspace reconcile.'
      );
    }
    const projection = input.projectionSchema;
    if (
      projection.kind !== projection.schemaSnapshot.name ||
      projection.schemaRevisionId !== projection.schemaSnapshot.schemaRevisionId
    ) {
      throw new Error('Projected entity schema identity is inconsistent.');
    }
    materializeEntitySchemaSnapshotInsideTx(db, {
      id: input.id,
      kind: projection.kind,
      name: input.name ?? existing.name,
      fields: input.fields,
      schemaRevisionId: projection.schemaRevisionId,
      schemaSnapshot: projection.schemaSnapshot,
      registrationStatus: input.registrationStatus,
      domainStatus: input.domainStatus,
      workspaceId: input.workspaceId,
      actor: input.actor,
      batchId: input.batchId,
    });
  }
  const projectedKind = input.projectionSchema?.kind ?? existing.kind;
  const schema = input.projectionSchema
    ? resolveSchemaRevisionForKind(db, projectedKind, input.projectionSchema.schemaRevisionId)
    : getSchemaRevisionForEntity(db, existingRow);
  const schemaDefinition = parseLimsSchemaFields(schema.fieldsJson);
  const definitions = schemaDefinition.fields;
  if (input.fields) assertWholeValueFieldUpdate(input.fields, definitions);
  let fields = input.fields
    ? input.replaceFields
      ? input.fields
      : { ...existing.fields, ...input.fields }
    : existing.fields;
  if (input.fields && !input.projectionSchema)
    assertLimsTemporalEdits(input.fields, definitions, existing.fields);
  const { incomplete } = assertEntityValid(projectedKind, fields, schema.fieldsJson);
  const formulaKeys = new Set(
    definitions.filter((field) => field.type === 'formula_result').map((field) => field.key)
  );
  const dataChanged = [...new Set([...Object.keys(existing.fields), ...Object.keys(fields)])].some(
    (key) => !formulaKeys.has(key) && !isDeepStrictEqual(existing.fields[key], fields[key])
  );
  if (dataChanged) {
    fields = { ...fields };
    for (const key of formulaKeys) {
      const result = fields[key];
      if (
        result &&
        typeof result === 'object' &&
        'compatibility' in result &&
        result.compatibility === 'unsupported'
      )
        fields[key] = { ...result, stale: true };
    }
  }
  const seq = nextEventSeq(db);
  const now = Date.now();
  const after: LimsEntity = {
    ...existing,
    kind: projectedKind,
    schemaId: schema.schemaId,
    schemaRevisionId: schema.revisionId,
    name: input.name ?? existing.name,
    fields,
    registrationStatus: input.projectionSchema
      ? recordRegistrationStatus(
          input.registrationStatus ?? existing.registrationStatus,
          incomplete.length > 0
        )
      : schemaDefinition.baseKind === 'record'
        ? recordRegistrationStatus(
            input.registrationStatus ??
              (existing.registrationStatus === 'unresolved' &&
              classifyLimsEntityFieldIssues(existing.kind, existing.fields, definitions).incomplete
                .length > 0
                ? 'registered'
                : existing.registrationStatus),
            incomplete.length > 0
          )
        : (input.registrationStatus ?? existing.registrationStatus),
    domainStatus: input.domainStatus !== undefined ? input.domainStatus : existing.domainStatus,
    workspaceId: resolveSavedRegistryProject(db, {
      id: existing.id,
      fields,
      workspaceId: input.workspaceId !== undefined ? input.workspaceId : existing.workspaceId,
    }),
    actor: input.actor ?? LOCAL_ACTOR,
    eventSeq: seq,
    updatedAt: now,
  };
  assertActiveFileSequenceOwnerIsUnique(db, after);
  insertAuditEvent(db, {
    eventSeq: seq,
    eventType: 'entity_updated',
    subjectTable: 'lims_entity',
    subjectId: input.id,
    batchId: input.batchId ?? null,
    actor: input.actor ?? LOCAL_ACTOR,
    workspaceId: after.workspaceId,
    before: existing,
    after,
    payload: input.projectionSchema ? { change: 'file_authority_schema_reprojection' } : undefined,
  });
  upsertLimsEntityProjectionInsideTx(db, after);
  return after;
}

function assertWholeValueFieldUpdate(
  fields: Record<string, unknown>,
  definitions: readonly LimsFieldDefinition[]
): void {
  const sequence = fields.sequence;
  const sequenceDefinition = definitions.find((field) => field.key === 'sequence');
  if (
    (!sequenceDefinition ||
      ['dna_sequence', 'rna_sequence', 'protein_sequence'].includes(sequenceDefinition.type)) &&
    sequence !== undefined &&
    (typeof sequence !== 'object' || sequence === null || !('mode' in sequence))
  ) {
    throw new Error(
      'Entity field update must replace the whole sequence value (missing mode discriminant)'
    );
  }
  const sourceMetadata = fields.sourceMetadata;
  if (
    !definitions.some((field) => field.key === 'sourceMetadata') &&
    sourceMetadata !== undefined &&
    (typeof sourceMetadata !== 'object' ||
      sourceMetadata === null ||
      !('schemaVersion' in sourceMetadata))
  ) {
    throw new Error(
      'Entity field update must replace the whole sourceMetadata value (missing schemaVersion)'
    );
  }
}

export function replaceNativeCatalogRecordInsideTx(
  db: Database.Database,
  input: LimsRegisterEntityInput & { id: string }
): LimsEntity {
  if (!db.inTransaction)
    throw new Error('Native record replacement requires an active transaction.');
  const existingRow = getEntityRowById(db, input.id);
  const existing = limsEntityFromRow(existingRow);
  const oldSchema = getSchemaRevisionForEntity(db, existingRow);
  if (
    existing.tombstone ||
    existing.archivedAt !== null ||
    parseLimsSchemaFields(oldSchema.fieldsJson).baseKind !== 'record' ||
    input.schemaSnapshot?.baseKind !== 'record' ||
    input.workspaceId !== existing.workspaceId
  ) {
    throw new Error('Native replacement must remain an active record in the same workspace.');
  }
  materializeEntitySchemaSnapshotInsideTx(db, input);
  const schema = resolveSchemaRevisionForKind(db, input.kind, input.schemaRevisionId);
  const { incomplete } = assertEntityValid(input.kind, input.fields, schema.fieldsJson);
  const after: LimsEntity = {
    ...existing,
    kind: input.kind,
    name: input.name,
    fields: input.fields,
    schemaId: schema.schemaId,
    schemaRevisionId: schema.revisionId,
    registrationStatus: incomplete.length ? 'unresolved' : 'registered',
    actor: input.actor ?? LOCAL_ACTOR,
    eventSeq: nextEventSeq(db),
    updatedAt: Date.now(),
  };
  insertAuditEvent(db, {
    eventSeq: after.eventSeq ?? undefined,
    eventType: 'entity_updated',
    subjectTable: 'lims_entity',
    subjectId: input.id,
    batchId: input.batchId ?? null,
    actor: after.actor,
    workspaceId: after.workspaceId,
    before: existing,
    after,
  });
  upsertLimsEntityProjectionInsideTx(db, after);
  return after;
}

function registerLimsEntityWithResolvedRegistryIdInsideTx(
  db: Database.Database,
  input: LimsRegisterEntityInput,
  migratedRegistryId?: string,
  options: { replaceTombstoned?: boolean } = {}
): LimsEntity {
  if (!db.inTransaction) throw new Error('Registry registration requires an active transaction.');
  const existingRow = input.id
    ? (prepareCachedStatement(db, 'SELECT * FROM lims_entity WHERE id = ?').get(input.id) as
        | LimsEntityRow
        | undefined)
    : undefined;
  const replacing = Boolean(options.replaceTombstoned && existingRow?.tombstone);
  if (existingRow && !replacing) {
    const existing = limsEntityFromRow(existingRow);
    if (existing.kind !== input.kind)
      throw new Error('Registry create identity already belongs to another kind.');
    if (input.workspaceId != null && existing.workspaceId !== input.workspaceId)
      throw new Error('Registry create identity already belongs to another project.');
    return existing;
  }
  if (
    !replacing &&
    input.id &&
    prepareCachedStatement(
      db,
      "SELECT id FROM lims_audit WHERE subject_table = 'lims_entity' AND subject_id = ? LIMIT 1"
    ).get(input.id)
  )
    throw new Error('Registry create identity has retained history; recover its projection first.');
  input = { ...input, workspaceId: resolveSavedRegistryProject(db, input) };
  const initial = input.initialState;
  if (
    initial &&
    (!Number.isFinite(initial.updatedAt) ||
      typeof initial.archived !== 'boolean' ||
      (initial.archivedAt !== null && !Number.isFinite(initial.archivedAt)) ||
      (!initial.archived && initial.archivedAt !== null))
  )
    throw new Error('Initial saved entity lifecycle is invalid.');
  materializeEntitySchemaSnapshotInsideTx(db, input);
  const schema = resolveSchemaRevisionForKind(db, input.kind, input.schemaRevisionId);
  const { incomplete } = assertEntityValid(input.kind, input.fields, schema.fieldsJson);
  const id = input.id ?? randomUUID();
  const seq = nextEventSeq(db);
  const now = Date.now();

  const createdAt = input.createdAt ?? now;

  const registryId = migratedRegistryId ?? allocateRegistryIdInsideTx(db, input.kind, now);
  const entity: LimsEntity = {
    id,
    kind: input.kind,
    schemaId: schema.schemaId,
    schemaRevisionId: schema.revisionId,
    name: input.name,
    registryId,
    fields: input.fields,

    registrationStatus:
      incomplete.length > 0 ? 'unresolved' : (input.registrationStatus ?? 'registered'),
    domainStatus: input.domainStatus ?? null,
    workspaceId: input.workspaceId ?? null,
    actor: input.actor ?? LOCAL_ACTOR,
    eventSeq: seq,
    tombstone: initial?.archived ?? false,
    createdAt,
    updatedAt: initial?.updatedAt ?? createdAt,
    archivedAt: initial?.archivedAt ?? null,
  };
  assertActiveFileSequenceOwnerIsUnique(db, entity);
  const contentPins = createLimsContentPinsInsideTx(db, entity);
  try {
    insertAuditEvent(db, {
      eventSeq: seq,
      eventType: 'entity_registered',
      idempotencyKey: replacing
        ? `lims:entity-register:${id}:replace:${seq}`
        : `lims:entity-register:${id}`,
      subjectTable: 'lims_entity',
      subjectId: id,
      batchId: input.batchId ?? null,
      actor: input.actor ?? LOCAL_ACTOR,
      workspaceId: input.workspaceId ?? null,
      after: entity,
      payload: contentPins.length > 0 ? { contentPins } : undefined,
    });
    upsertLimsEntityProjectionInsideTx(db, entity);
    if (input.failAfterEntityInsert) {
      throw new Error('Forced LIMS entity rollback after entity insert');
    }
  } catch (err) {
    deleteLimsContentPins(contentPins);
    throw err;
  }
  return entity;
}

export function materializeEntitySchemaSnapshotInsideTx(
  db: Database.Database,
  input: LimsRegisterEntityInput
): void {
  const snapshot = input.schemaSnapshot;
  if (!snapshot) return;
  if (
    !isPortableEntitySchemaRevisionSnapshot(snapshot) ||
    !Number.isInteger(snapshot.version) ||
    snapshot.version < 1 ||
    snapshot.name !== input.kind ||
    snapshot.schemaRevisionId !== input.schemaRevisionId
  ) {
    throw new Error('Entity schema snapshot does not match the requested Registry projection.');
  }

  materializeSchemaSnapshotInsideTx(db, snapshot, 'entity', input);
}

export function materializeRelationshipSchemaSnapshotInsideTx(
  db: Database.Database,
  snapshot: ProjectableRelationshipSchemaRevisionSnapshot,
  input: Pick<LimsRegisterEntityInput, 'actor' | 'workspaceId'>
): void {
  if (!isProjectableRelationshipSchemaRevisionSnapshot(snapshot))
    throw new Error('Relationship schema snapshot is malformed.');
  materializeSchemaSnapshotInsideTx(db, snapshot, 'relationship_type', input);
}

function materializeSchemaSnapshotInsideTx(
  db: Database.Database,
  snapshot: ProjectableEntitySchemaRevisionSnapshot | ProjectableRelationshipSchemaRevisionSnapshot,
  kind: LimsSchemaKind,
  input: Pick<LimsRegisterEntityInput, 'actor' | 'workspaceId'>
): void {
  if (!db.inTransaction) throw new Error('Schema snapshot materialization requires a transaction.');
  const fields = snapshot.fields as LimsFieldDefinition[];
  validateSchemaInput(fields, snapshot.baseKind, kind);
  const fieldsJson = serializeLimsSchemaDefinition({
    fields,
    baseKind: snapshot.baseKind,
    ...(kind === 'relationship_type'
      ? { relationship: (snapshot as ProjectableRelationshipSchemaRevisionSnapshot).relationship }
      : {}),
  });
  const existingById = db
    .prepare(`SELECT * FROM lims_schema WHERE id = ? LIMIT 1`)
    .get(snapshot.schemaId) as LimsSchemaRow | undefined;
  const existingByName = db
    .prepare(`SELECT * FROM lims_schema WHERE kind = ? AND name = ? LIMIT 1`)
    .get(kind, snapshot.name) as LimsSchemaRow | undefined;
  if (
    (existingById &&
      (existingById.kind !== kind ||
        existingById.name !== snapshot.name ||
        existingById.display_name !== snapshot.displayName ||
        (snapshot.description !== undefined &&
          existingById.description !== snapshot.description))) ||
    (existingByName && existingByName.id !== snapshot.schemaId)
  ) {
    throw new Error(`Schema identity collision for ${snapshot.name}.`);
  }

  const existingRevision = db
    .prepare(`SELECT * FROM lims_schema_revision WHERE id = ? LIMIT 1`)
    .get(snapshot.schemaRevisionId) as LimsSchemaRevisionRow | undefined;
  if (existingRevision) {
    if (
      existingRevision.schema_id !== snapshot.schemaId ||
      existingRevision.version !== snapshot.version ||
      stableJson(parseLimsSchemaFields(existingRevision.fields)) !==
        stableJson(parseLimsSchemaFields(fieldsJson))
    ) {
      throw new Error(`Schema revision collision for ${snapshot.schemaRevisionId}.`);
    }
    return;
  }

  const versionCollision = db
    .prepare(`SELECT id FROM lims_schema_revision WHERE schema_id = ? AND version = ? LIMIT 1`)
    .get(snapshot.schemaId, snapshot.version) as { id: string } | undefined;
  if (versionCollision) {
    throw new Error(
      `Schema version ${snapshot.version} for ${snapshot.schemaId} is already ${versionCollision.id}.`
    );
  }

  const seq = nextEventSeq(db);
  const now = Date.now();
  const actor = input.actor ?? LOCAL_ACTOR;
  const workspaceId = input.workspaceId ?? null;
  const schemaRow: LimsSchemaRow = existingById ?? {
    id: snapshot.schemaId,
    kind,
    name: snapshot.name,
    display_name: snapshot.displayName,
    description: snapshot.description ?? null,
    fields: fieldsJson,
    current_revision_id: snapshot.schemaRevisionId,
    version: snapshot.version,
    builtin: 0,
    workspace_id: workspaceId,
    actor,
    event_seq: seq,
    tombstone: 0,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  const revisionRow: LimsSchemaRevisionRow = {
    id: snapshot.schemaRevisionId,
    schema_id: snapshot.schemaId,
    version: snapshot.version,
    fields: fieldsJson,
    actor,
    workspace_id: workspaceId,
    event_seq: seq,
    tombstone: 0,
    created_at: now,
    archived_at: null,
  };
  insertAuditEvent(db, {
    eventSeq: seq,
    eventType: existingById ? 'schema_revision_materialized' : 'schema_snapshot_materialized',
    subjectTable: 'lims_schema',
    subjectId: snapshot.schemaId,
    actor,
    workspaceId,
    after: { schema: schemaRow, revision: revisionRow },
  });
  if (!existingById) {
    upsertLimsSchemaProjectionInsideTx(db, schemaRow);
    if (kind === 'entity') ensureDefaultIdSchemeInsideTx(db, snapshot.name);
  }
  upsertLimsSchemaRevisionProjectionInsideTx(db, revisionRow);
}

export function registerMigratedLimsEntityInsideTx(
  db: Database.Database,
  input: LimsRegisterEntityInput,
  desiredRegistryId: string
): LimsEntity {
  const registryId = desiredRegistryId.trim();
  if (!registryId) throw new Error('Migrated registry ID is required');
  const conflict = db
    .prepare(`SELECT id FROM lims_entity WHERE registry_id = ? LIMIT 1`)
    .get(registryId) as { id: string } | undefined;
  if (conflict && conflict.id !== input.id) {
    throw new Error(`Registry ID ${registryId} is already assigned to entity ${conflict.id}`);
  }

  return registerLimsEntityWithResolvedRegistryIdInsideTx(db, input, registryId);
}

export function replaceTombstonedSeedLimsEntityInsideTx(
  db: Database.Database,
  input: LimsRegisterEntityInput
): LimsEntity {
  const row = input.id
    ? (prepareCachedStatement(db, 'SELECT * FROM lims_entity WHERE id = ?').get(input.id) as
        | LimsEntityRow
        | undefined)
    : undefined;
  if (!row?.tombstone) throw new Error('Only an archived seed entity can be replaced.');
  return registerLimsEntityWithResolvedRegistryIdInsideTx(db, input, row.registry_id ?? undefined, {
    replaceTombstoned: true,
  });
}

export function linkLimsEntitiesInsideTx(
  db: Database.Database,
  input: LimsLinkEntitiesInput
): LimsLink {
  if (input.fromEntityId === input.toEntityId) {
    throw new Error('LIMS links cannot point an entity at itself');
  }
  const from = getEntityRowById(db, input.fromEntityId);
  const to = getEntityRowById(db, input.toEntityId);
  if (from.tombstone || to.tombstone) throw new Error('Cannot link archived LIMS entities');
  assertRelationshipTypeExists(db, input.type);
  if (
    LINEAGE_RELATIONSHIP_TYPES.has(input.type) &&
    wouldCreateRelationshipCycle(db, input.fromEntityId, input.toEntityId, input.type)
  ) {
    throw new Error(`Link ${input.type} would create a cycle`);
  }

  const id = input.id ?? randomUUID();
  const seq = nextEventSeq(db);
  const now = Date.now();
  const link: LimsLink = {
    id,
    fromEntityId: input.fromEntityId,
    toEntityId: input.toEntityId,
    type: input.type,
    payload: input.payload ?? {},
    workspaceId: input.workspaceId ?? from.workspace_id ?? to.workspace_id ?? null,
    actor: input.actor ?? LOCAL_ACTOR,
    eventSeq: seq,
    tombstone: false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  insertAuditEvent(db, {
    eventSeq: seq,
    eventType: 'link_created',
    subjectTable: 'lims_link',
    subjectId: id,
    batchId: input.batchId ?? null,
    actor: input.actor ?? LOCAL_ACTOR,
    workspaceId: link.workspaceId,
    after: link,
  });
  upsertLimsLinkProjectionInsideTx(db, link);
  return link;
}

export function linkLimsEntitiesOrExistingInsideTx(
  db: Database.Database,
  input: LimsLinkEntitiesInput
): LimsLink {
  const existing = prepareCachedStatement(
    db,
    `SELECT * FROM lims_link
       WHERE from_entity_id = ? AND to_entity_id = ? AND type = ? AND tombstone = 0
       LIMIT 1`
  ).get(input.fromEntityId, input.toEntityId, input.type) as LimsLinkRow | undefined;
  if (existing) return limsLinkFromRow(existing);

  const tombstoned = prepareCachedStatement(
    db,
    `SELECT * FROM lims_link
       WHERE from_entity_id = ? AND to_entity_id = ? AND type = ? AND tombstone = 1
       LIMIT 1`
  ).get(input.fromEntityId, input.toEntityId, input.type) as LimsLinkRow | undefined;
  if (tombstoned) return reactivateLimsLinkInsideTx(db, tombstoned, input);
  return linkLimsEntitiesInsideTx(db, input);
}

export function reactivateLimsLinkInsideTx(
  db: Database.Database,
  row: LimsLinkRow,
  input: LimsLinkEntitiesInput
): LimsLink {
  const from = getEntityRowById(db, input.fromEntityId);
  const to = getEntityRowById(db, input.toEntityId);
  if (from.tombstone || to.tombstone) throw new Error('Cannot link archived LIMS entities');
  const seq = nextEventSeq(db);
  const now = Date.now();
  const before = limsLinkFromRow(row);
  const link: LimsLink = {
    ...before,
    payload: input.payload ?? {},
    workspaceId:
      input.workspaceId ?? row.workspace_id ?? from.workspace_id ?? to.workspace_id ?? null,
    actor: input.actor ?? LOCAL_ACTOR,
    eventSeq: seq,
    tombstone: false,
    updatedAt: now,
    archivedAt: null,
  };
  insertAuditEvent(db, {
    eventSeq: seq,
    eventType: 'link_reactivated',
    subjectTable: 'lims_link',
    subjectId: row.id,
    batchId: input.batchId ?? null,
    actor: input.actor ?? LOCAL_ACTOR,
    workspaceId: link.workspaceId,
    before,
    after: link,
  });
  upsertLimsLinkProjectionInsideTx(db, link);
  return link;
}

export function assertEntityValid(
  kind: string,
  fields: Record<string, unknown>,
  fieldsJson: string
): { incomplete: string[] } {
  const schemaDefinition = parseLimsSchemaFields(fieldsJson);
  const { malformed, incomplete } = classifyLimsEntityFieldIssues(
    kind,
    fields,
    schemaDefinition.fields,
    schemaDefinition.baseKind
  );

  if (malformed.length > 0) {
    throw new Error(`Invalid LIMS ${kind}: ${malformed.join('; ')}`);
  }
  return { incomplete };
}

export function resolveSchemaRevisionForKind(
  db: Database.Database,
  kind: string,
  schemaRevisionId?: string
): ResolvedSchemaRevision {
  if (schemaRevisionId) {
    const row = prepareCachedStatement(
      db,
      `SELECT s.id as schema_id, r.id as revision_id, r.fields as fields
         FROM lims_schema_revision r
         JOIN lims_schema s ON s.id = r.schema_id
         WHERE r.id = ? AND s.kind = 'entity' AND s.name = ?`
    ).get(schemaRevisionId, kind) as
      | { schema_id: string; revision_id: string; fields: string }
      | undefined;
    if (!row) throw new Error(`Schema revision ${schemaRevisionId} not found for ${kind}`);
    return { schemaId: row.schema_id, revisionId: row.revision_id, fieldsJson: row.fields };
  }

  const row = prepareCachedStatement(
    db,
    `SELECT s.id as schema_id, r.id as revision_id, r.fields as fields
       FROM lims_schema s
       JOIN lims_schema_revision r ON r.id = s.current_revision_id
       WHERE s.kind = 'entity' AND s.name = ? AND s.tombstone = 0`
  ).get(kind) as { schema_id: string; revision_id: string; fields: string } | undefined;
  if (!row) throw new Error(`No active LIMS entity schema found for ${kind}`);
  return { schemaId: row.schema_id, revisionId: row.revision_id, fieldsJson: row.fields };
}

export function getSchemaRevisionForEntity(
  db: Database.Database,
  entity: LimsEntityRow
): ResolvedSchemaRevision {
  const row = db
    .prepare(
      `SELECT s.id as schema_id, r.id as revision_id, r.fields as fields
       FROM lims_schema_revision r
       JOIN lims_schema s ON s.id = r.schema_id
       WHERE r.id = ?`
    )
    .get(entity.schema_revision_id) as
    | { schema_id: string; revision_id: string; fields: string }
    | undefined;
  if (!row) throw new Error(`Schema revision ${entity.schema_revision_id} not found`);
  return { schemaId: row.schema_id, revisionId: row.revision_id, fieldsJson: row.fields };
}

export function assertRelationshipTypeExists(db: Database.Database, type: string): void {
  const row = prepareCachedStatement(
    db,
    `SELECT id FROM lims_schema
       WHERE kind = 'relationship_type' AND name = ? AND tombstone = 0`
  ).get(type) as { id: string } | undefined;
  if (!row) throw new Error(`Unknown LIMS relationship type: ${type}`);
}

export function wouldCreateRelationshipCycle(
  db: Database.Database,
  fromEntityId: string,
  toEntityId: string,
  type: string
): boolean {
  const row = prepareCachedStatement(
    db,
    `WITH RECURSIVE graph(id) AS (
        SELECT to_entity_id
        FROM lims_link
        WHERE from_entity_id = ? AND type = ? AND tombstone = 0
        UNION
        SELECT l.to_entity_id
        FROM lims_link l
        JOIN graph g ON l.from_entity_id = g.id
        WHERE l.type = ? AND l.tombstone = 0
      )
      SELECT id FROM graph WHERE id = ? LIMIT 1`
  ).get(toEntityId, type, type, fromEntityId) as { id: string } | undefined;
  return Boolean(row);
}

export function insertAuditEvent(db: Database.Database, input: AuditEventInput): LimsAuditRow {
  const id = input.id ?? randomUUID();
  const schemaVersion = input.schemaVersion ?? LIMS_AUDIT_SCHEMA_VERSION;
  const idempotencyKey = input.idempotencyKey ?? `lims:v${schemaVersion}:${id}`;
  const existing = prepareCachedStatement(
    db,
    `SELECT * FROM lims_audit WHERE idempotency_key = ? LIMIT 1`
  ).get(idempotencyKey) as LimsAuditRow | undefined;
  if (existing) return existing;
  const eventSeq = input.eventSeq ?? nextEventSeq(db);
  const now = Date.now();
  const operationId = input.operationId ?? input.batchId ?? `op:${id}`;
  const actorClientId = input.actorClientId ?? LIMS_LOCAL_CLIENT_ID;
  const actorUserId = input.actorUserId ?? input.actor ?? LOCAL_ACTOR;
  const previous = prepareCachedStatement(
    db,
    `SELECT hash FROM lims_audit WHERE hash IS NOT NULL ORDER BY event_seq DESC LIMIT 1`
  ).get() as { hash: string | null } | undefined;
  const prevHash = previous?.hash ?? null;
  const hash = computeLimsAuditHash({
    id,
    event_seq: eventSeq,
    schema_version: schemaVersion,
    idempotency_key: idempotencyKey,
    operation_id: operationId,
    event_type: input.eventType,
    subject_table: input.subjectTable ?? null,
    subject_id: input.subjectId ?? null,
    batch_id: input.batchId ?? null,
    actor: input.actor ?? LOCAL_ACTOR,
    actor_client_id: actorClientId,
    actor_user_id: actorUserId,
    workspace_id: input.workspaceId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    payload: input.payload ?? null,
    prev_hash: prevHash,
    tombstone: 0,
    created_at: now,
  });
  prepareCachedStatement(
    db,
    `INSERT INTO lims_audit (
      id, event_seq, schema_version, idempotency_key, event_type,
      operation_id, subject_table, subject_id, batch_id, actor,
      actor_client_id, actor_user_id, workspace_id, before, after, payload,
      prev_hash, hash, tombstone, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    id,
    eventSeq,
    schemaVersion,
    idempotencyKey,
    input.eventType,
    operationId,
    input.subjectTable ?? null,
    input.subjectId ?? null,
    input.batchId ?? null,
    input.actor ?? LOCAL_ACTOR,
    actorClientId,
    actorUserId,
    input.workspaceId ?? null,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.payload === undefined ? null : JSON.stringify(input.payload),
    prevHash,
    hash,
    now
  );
  return prepareCachedStatement(db, `SELECT * FROM lims_audit WHERE id = ?`).get(
    id
  ) as LimsAuditRow;
}

export interface LimsAuditHashInput {
  id: string;
  event_seq: number;
  schema_version: number;
  idempotency_key: string;
  operation_id: string | null;
  event_type: string;
  subject_table: string | null;
  subject_id: string | null;
  batch_id: string | null;
  actor: string | null;
  actor_client_id: string | null;
  actor_user_id: string | null;
  workspace_id: number | null;
  before: unknown;
  after: unknown;
  payload: unknown;
  prev_hash: string | null;
  tombstone: number;
  created_at: number;
}

export function computeLimsAuditHash(input: LimsAuditHashInput): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortJsonValue(nested)])
    );
  }
  return value;
}

export function nextEventSeq(db: Database.Database): number {
  ensureLimsEventSequenceInsideTx(db);
  const row = prepareCachedStatement(
    db,
    `SELECT next_event_seq FROM lims_event_sequence WHERE id = 1`
  ).get() as { next_event_seq: number };
  prepareCachedStatement(db, `UPDATE lims_event_sequence SET next_event_seq = ? WHERE id = 1`).run(
    row.next_event_seq + 1
  );
  return row.next_event_seq;
}

export function ensureLimsEventSequenceInsideTx(db: Database.Database): void {
  if (initializedLimsEventSequenceDbs.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS lims_event_sequence (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      next_event_seq INTEGER NOT NULL
    )
  `);
  const existing = prepareCachedStatement(
    db,
    `SELECT next_event_seq FROM lims_event_sequence WHERE id = 1`
  ).get() as { next_event_seq: number } | undefined;
  if (existing) {
    initializedLimsEventSequenceDbs.add(db);
    return;
  }
  const row = prepareCachedStatement(
    db,
    `SELECT COALESCE(MAX(event_seq), 0) + 1 as seq FROM lims_audit`
  ).get() as { seq: number };
  prepareCachedStatement(
    db,
    `INSERT INTO lims_event_sequence (id, next_event_seq) VALUES (1, ?)`
  ).run(row.seq);
  if (!db.inTransaction) initializedLimsEventSequenceDbs.add(db);
}

export function syncLimsEventSequenceToAuditInsideTx(db: Database.Database): void {
  ensureLimsEventSequenceInsideTx(db);
  const row = db.prepare(`SELECT COALESCE(MAX(event_seq), 0) + 1 as seq FROM lims_audit`).get() as {
    seq: number;
  };
  db.prepare(
    `INSERT INTO lims_event_sequence (id, next_event_seq)
     VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET next_event_seq = excluded.next_event_seq`
  ).run(row.seq);
}

export function getSchemaById(db: Database.Database, id: string): LimsSchemaRow {
  const row = db.prepare(`SELECT * FROM lims_schema WHERE id = ?`).get(id) as
    | LimsSchemaRow
    | undefined;
  if (!row) throw new Error(`LIMS schema not found: ${id}`);
  return row;
}

export function listLimsEntitySchemasInDb(db: Database.Database): LimsSchemaDefinitionView[] {
  seedLimsBuiltinsInDb(db);
  const rows = db
    .prepare(`SELECT * FROM lims_schema WHERE kind = 'entity' AND tombstone = 0 ORDER BY name ASC`)
    .all() as LimsSchemaRow[];
  return rows.map((row) => ({
    schemaId: row.id,
    currentRevisionId: row.current_revision_id ?? `${row.id}-v${row.version}`,
    entityKind: row.name,
    baseKind: parseLimsSchemaFields(row.fields).baseKind ?? row.name,
    displayName: row.display_name,
    description: row.description,
    version: row.version,
    builtin: row.builtin === 1,
    fields: parseLimsSchemaFields(row.fields).fields,
  }));
}

export function getEntityRowById(db: Database.Database, id: string): LimsEntityRow {
  const row = prepareCachedStatement(db, `SELECT * FROM lims_entity WHERE id = ?`).get(id) as
    | LimsEntityRow
    | undefined;
  if (!row) throw new Error(`LIMS entity not found: ${id}`);
  return row;
}

export function getLinkRowById(db: Database.Database, id: string): LimsLinkRow {
  const row = db.prepare(`SELECT * FROM lims_link WHERE id = ?`).get(id) as LimsLinkRow | undefined;
  if (!row) throw new Error(`LIMS link not found: ${id}`);
  return row;
}

export function validateSchemaInput(
  fields: readonly LimsFieldDefinition[],
  baseKind?: string,
  kind: LimsSchemaKind = 'entity'
): void {
  if (
    !Array.isArray(fields) ||
    (fields.length === 0 &&
      baseKind !== 'sequence' &&
      baseKind !== 'relationship_type' &&
      kind !== 'relationship_type')
  ) {
    throw new Error('LIMS schema requires at least one field');
  }
  const keys = new Set<string>();
  for (const field of fields) {
    assertLimsAgendaDefinition(field);
    if (!field.key || !/^[A-Za-z][A-Za-z0-9_]*$/.test(field.key)) {
      throw new Error(`Invalid LIMS field key: ${field.key}`);
    }
    if (keys.has(field.key)) throw new Error(`Duplicate LIMS field key: ${field.key}`);
    keys.add(field.key);
    if (!isLimsFieldType(field.type)) {
      throw new Error(`Unsupported LIMS field type for ${field.key}: ${field.type}`);
    }
    if (field.type === 'enum' && (!field.enumOptions || field.enumOptions.length === 0)) {
      throw new Error(`Enum field ${field.key} requires enumOptions`);
    }
  }
}

export { deterministicSchemaId };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
