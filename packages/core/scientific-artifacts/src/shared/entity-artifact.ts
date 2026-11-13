import type { LimsSchemaDefinitionView } from './lims';
import {
  isPortableEntitySchemaRevisionSnapshot,
  type ProjectableEntitySchemaRevisionSnapshot,
} from './entity-schema';
import {
  isProjectableRelationshipSchemaRevisionSnapshot,
  type ProjectableRelationshipSchemaRevisionSnapshot,
} from './relationship-schema';
import type { LimsImportPlanSourceKind, LimsRegistrationStatus, LimsSourceMetadata } from './lims';
import {
  ENTITY_RECORD_ARTIFACT_SCHEMA,
  ENTITY_RECORD_ARTIFACT_SUFFIX,
  ENTITY_RECORD_ARTIFACT_CURRENT_SCHEMA,
} from './registry-file-types';

export const ENTITY_ARTIFACT_SCHEMA = ENTITY_RECORD_ARTIFACT_SCHEMA;
export const ENTITY_ARTIFACT_CURRENT_SCHEMA = ENTITY_RECORD_ARTIFACT_CURRENT_SCHEMA;
export const ENTITY_ARTIFACT_SUFFIX = ENTITY_RECORD_ARTIFACT_SUFFIX;

export interface EntityArtifactRelationshipV1 {
  type: string;
  fromEntityId: string;
  toEntityId: string;
  payload: Record<string, unknown>;
}

export interface ImportedEntityArtifactSourceV1 {
  type?: 'file_import';
  recordId: string;
  sourceName: string;
  sourceKind: LimsImportPlanSourceKind;
  sourceRow?: number;
  values: Record<string, unknown>;
}

export interface ManualEntityArtifactSourceV1 {
  type: 'manual';
  values: Record<string, unknown>;
}

export type EntityArtifactSourceV1 = ImportedEntityArtifactSourceV1 | ManualEntityArtifactSourceV1;

export interface EntityArtifactV1 {
  schema: typeof ENTITY_ARTIFACT_SCHEMA;
  id: string;
  kind: string;

  schemaSnapshot?: ProjectableEntitySchemaRevisionSnapshot;
  archived?: boolean;
  relationshipSchemaSnapshots?: ProjectableRelationshipSchemaRevisionSnapshot[];
  name: string;
  fields: Record<string, unknown>;
  registrationStatus: LimsRegistrationStatus;
  domainStatus: string | null;
  relationships: EntityArtifactRelationshipV1[];
  source: EntityArtifactSourceV1;
}

export interface EntityArtifactV2 extends Omit<EntityArtifactV1, 'schema'> {
  schema: typeof ENTITY_ARTIFACT_CURRENT_SCHEMA;
  schemaRevisionId: string;
  schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot;
  archived: boolean;
}

export type EntityArtifact = EntityArtifactV1 | EntityArtifactV2;

export function entityArtifactSchemaSnapshot(
  schema: LimsSchemaDefinitionView
): ProjectableEntitySchemaRevisionSnapshot {
  return {
    schemaId: schema.schemaId,
    schemaRevisionId: schema.currentRevisionId,
    name: schema.entityKind,
    displayName: schema.displayName,
    baseKind: schema.baseKind,
    version: schema.version,
    description: schema.description,
    fields: schema.fields.map((field) => ({ ...field })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Entity artifact ${field} must be a non-empty string.`);
  }
  return value;
}

export function parseEntityArtifact(bytes: string): EntityArtifact {
  const raw: unknown = JSON.parse(bytes);
  if (
    !isRecord(raw) ||
    (raw.schema !== ENTITY_ARTIFACT_SCHEMA && raw.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA)
  ) {
    throw new Error(`Not a ${ENTITY_ARTIFACT_SCHEMA} artifact.`);
  }
  const fields = raw.fields;
  const source = raw.source;
  const relationships = raw.relationships;
  if (!isRecord(fields) || !isRecord(source) || !Array.isArray(relationships)) {
    throw new Error('Entity artifact fields, source, or relationships are malformed.');
  }
  const registrationStatus = raw.registrationStatus;
  if (!['tracked', 'registered', 'drifted', 'unresolved'].includes(String(registrationStatus))) {
    throw new Error('Entity artifact registrationStatus is invalid.');
  }
  const parsedRelationships = relationships.map((relationship, index) => {
    if (!isRecord(relationship) || !isRecord(relationship.payload)) {
      throw new Error(`Entity artifact relationship ${index + 1} is malformed.`);
    }
    return {
      ...relationship,
      type: requiredString(relationship.type, `relationship ${index + 1} type`),
      fromEntityId: requiredString(
        relationship.fromEntityId,
        `relationship ${index + 1} fromEntityId`
      ),
      toEntityId: requiredString(relationship.toEntityId, `relationship ${index + 1} toEntityId`),
      payload: relationship.payload,
    };
  });
  if (
    raw.schemaSnapshot !== undefined &&
    (!isPortableEntitySchemaRevisionSnapshot(raw.schemaSnapshot) ||
      raw.schemaSnapshot.name !== raw.kind)
  )
    throw new Error('Entity artifact schema snapshot is invalid or belongs to another kind.');
  if (raw.archived !== undefined && typeof raw.archived !== 'boolean')
    throw new Error('Entity artifact archived must be boolean.');
  if (raw.relationshipSchemaSnapshots !== undefined) {
    const types = new Set(parsedRelationships.map((relationship) => relationship.type));
    const names = new Set<string>();
    if (!Array.isArray(raw.relationshipSchemaSnapshots))
      throw new Error('Entity artifact relationship schema snapshots are malformed.');
    for (const snapshot of raw.relationshipSchemaSnapshots) {
      if (
        !isProjectableRelationshipSchemaRevisionSnapshot(snapshot) ||
        !types.has(snapshot.name) ||
        names.has(snapshot.name)
      )
        throw new Error(
          'Entity artifact relationship schema snapshot is invalid, duplicated or unrelated.'
        );
      names.add(snapshot.name);
    }
  }
  if (!isRecord(source.values)) throw new Error('Entity artifact source.values is malformed.');
  if (raw.domainStatus !== null && typeof raw.domainStatus !== 'string') {
    throw new Error('Entity artifact domainStatus is invalid.');
  }
  const parsedSource: EntityArtifactSourceV1 = (() => {
    if (source.type === 'manual') {
      return { ...source, type: 'manual', values: source.values };
    }
    if (source.type !== undefined && source.type !== 'file_import') {
      throw new Error('Entity artifact source.type is invalid.');
    }
    const sourceKind = requiredString(source.sourceKind, 'source.sourceKind');
    if (!['csv', 'tsv', 'xlsx', 'genbank', 'fasta', 'mixed'].includes(sourceKind)) {
      throw new Error('Entity artifact source.sourceKind is invalid.');
    }
    return {
      ...source,
      ...(source.type === 'file_import' ? { type: 'file_import' as const } : {}),
      recordId: requiredString(source.recordId, 'source.recordId'),
      sourceName: requiredString(source.sourceName, 'source.sourceName'),
      sourceKind: sourceKind as LimsImportPlanSourceKind,
      sourceRow: typeof source.sourceRow === 'number' ? source.sourceRow : undefined,
      values: source.values,
    };
  })();
  const parsed: EntityArtifactV1 = {
    ...raw,
    schema: ENTITY_ARTIFACT_SCHEMA,
    id: requiredString(raw.id, 'id'),
    kind: requiredString(raw.kind, 'kind'),
    name: requiredString(raw.name, 'name'),
    fields,
    registrationStatus: registrationStatus as LimsRegistrationStatus,
    domainStatus: raw.domainStatus,
    relationships: parsedRelationships,
    ...(raw.schemaSnapshot === undefined
      ? {}
      : { schemaSnapshot: raw.schemaSnapshot as ProjectableEntitySchemaRevisionSnapshot }),
    ...(raw.archived === undefined ? {} : { archived: raw.archived as boolean }),
    ...(raw.relationshipSchemaSnapshots === undefined
      ? {}
      : {
          relationshipSchemaSnapshots:
            raw.relationshipSchemaSnapshots as ProjectableRelationshipSchemaRevisionSnapshot[],
        }),
    source: parsedSource,
  };
  if (raw.schema === ENTITY_ARTIFACT_SCHEMA) return parsed;
  const snapshot = raw.schemaSnapshot;
  if (
    !isPortableEntitySchemaRevisionSnapshot(snapshot) ||
    !Number.isSafeInteger(snapshot.version) ||
    Number(snapshot.version) < 1 ||
    snapshot.name !== parsed.kind ||
    snapshot.schemaRevisionId !== raw.schemaRevisionId ||
    typeof raw.archived !== 'boolean'
  ) {
    throw new Error('Entity artifact frozen schema revision or archive state is invalid.');
  }
  return {
    ...parsed,
    schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
    schemaRevisionId: snapshot.schemaRevisionId,
    schemaSnapshot: snapshot as ProjectableEntitySchemaRevisionSnapshot,
    archived: raw.archived,
  };
}

export function serializeEntityArtifact(artifact: EntityArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function entityArtifactSourceMetadata(artifact: EntityArtifact): LimsSourceMetadata {
  if (artifact.source.type === 'manual') {
    return {
      schemaVersion: 1,
      origin: { type: 'manual' },
      values: { ...artifact.source.values },
    };
  }
  const metadata: LimsSourceMetadata = {
    schemaVersion: 1,
    origin: {
      type: 'file_import',
      sourceName: artifact.source.sourceName,
      sourceKind: artifact.source.sourceKind,
    },
    importRecordId: artifact.source.recordId,
    values: { ...artifact.source.values },
  };
  if (typeof artifact.source.sourceRow === 'number') {
    metadata.row = { index: artifact.source.sourceRow };
  }
  return metadata;
}

export function sanitizeEntityArtifactStem(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return sanitized || 'Record';
}

export function isEntityArtifactPath(path: string): boolean {
  return path.toLowerCase().endsWith(ENTITY_ARTIFACT_SUFFIX);
}
