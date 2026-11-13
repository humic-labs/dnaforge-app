export const BUILTIN_SEQUENCE_SCHEMA_ID = 'schema-entity-sequence' as const;
export const SEQUENCE_SCHEMA_V1_REVISION_ID = 'schema-entity-sequence-v1' as const;
export const SEQUENCE_SCHEMA_V2_REVISION_ID = 'schema-entity-sequence-v2' as const;
export const BUILTIN_SEQUENCE_SCHEMA_REVISION_ID = 'schema-entity-sequence-v3' as const;
export const BUILTIN_PLASMID_SCHEMA_ID = 'schema-entity-plasmid' as const;
export const BUILTIN_PLASMID_SCHEMA_REVISION_ID = 'schema-entity-plasmid-v2' as const;

import type {
  EntitySchemaFieldSnapshot,
  ProjectableEntitySchemaRevisionSnapshot,
} from './entity-schema';

export type { EntitySchemaFieldSnapshot } from './entity-schema';

export interface EntitySchemaRevisionSnapshot extends ProjectableEntitySchemaRevisionSnapshot<'sequence'> {
  baseKind: 'sequence';
}

export interface SchemaBoundEntityRelationship {
  type: string;
  fromEntityId: string;
  toEntityId: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SchemaBoundSequenceEntityMetadata {
  schema: EntitySchemaRevisionSnapshot;
  fields: Record<string, unknown>;
  registrationStatus: 'tracked' | 'registered' | 'drifted' | 'unresolved';
  domainStatus: string | null;
  registryId: string | null;
  relationships: SchemaBoundEntityRelationship[];

  lifecycle?: { archived: boolean; archivedAt: number | null };
  source?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SequenceSchemaDefinitionView {
  schemaId: string;
  currentRevisionId: string;
  entityKind: string;
  baseKind: string;
  displayName: string;
  description?: string | null;
  version: number;
  fields: readonly EntitySchemaFieldSnapshot[];
}

export const SEQUENCE_INTRINSIC_FIELD_DEFINITIONS = [
  {
    key: 'topology',
    label: 'Topology',
    type: 'enum',
    enumOptions: ['linear', 'circular'],
    intrinsic: 'sequence.topology',
  },
  {
    key: 'geneticCode',
    label: 'Genetic code',
    type: 'genetic_code',
    intrinsic: 'sequence.geneticCode',
  },
] as const satisfies readonly EntitySchemaFieldSnapshot[];

export const SEQUENCE_DERIVED_PROPERTY_DEFINITIONS = [
  { key: 'size', label: 'Size', type: 'number', source: 'sequence.length' },
] as const;

export type SequenceDerivedPropertyDefinition =
  (typeof SEQUENCE_DERIVED_PROPERTY_DEFINITIONS)[number];

export function resolvedEntitySchemaProperties(
  schema: Pick<ProjectableEntitySchemaRevisionSnapshot, 'baseKind'>
): readonly SequenceDerivedPropertyDefinition[] {
  return schema.baseKind === 'sequence' ? SEQUENCE_DERIVED_PROPERTY_DEFINITIONS : [];
}

export function isDerivedSequencePropertyField(
  schema: Pick<ProjectableEntitySchemaRevisionSnapshot, 'baseKind'>,
  field: Pick<EntitySchemaFieldSnapshot, 'key' | 'intrinsic'>
): boolean {
  return (
    schema.baseKind === 'sequence' &&
    (resolvedEntitySchemaProperties(schema).some((property) => property.key === field.key) ||
      field.intrinsic === 'sequence.length')
  );
}

export function validateSequenceSchemaPropertyFields(
  fields: readonly Pick<EntitySchemaFieldSnapshot, 'key' | 'intrinsic'>[],
  baseKind?: string
): void {
  if (fields.some((field) => isDerivedSequencePropertyField({ baseKind: baseKind ?? '' }, field))) {
    throw new Error('Sequence property keys cannot be schema fields.');
  }
}

export function resolvedEntitySchemaFields(
  schema: Pick<ProjectableEntitySchemaRevisionSnapshot, 'baseKind' | 'fields'>
): EntitySchemaFieldSnapshot[] {
  if (schema.baseKind !== 'sequence') return schema.fields.map((field) => ({ ...field }));
  const intrinsicKeys = new Set<string>(
    SEQUENCE_INTRINSIC_FIELD_DEFINITIONS.map((field) => field.key)
  );
  return [
    ...SEQUENCE_INTRINSIC_FIELD_DEFINITIONS.map((field) => ({ ...field })),
    ...schema.fields
      .filter(
        (field) => !intrinsicKeys.has(field.key) && !isDerivedSequencePropertyField(schema, field)
      )
      .map((field) => ({ ...field })),
  ];
}

export const SEQUENCE_SCHEMA_V1_FIELD_DEFINITIONS = [
  {
    key: 'description',
    label: 'Description',
    type: 'long_text',
    suggested: true,
    description: 'Optional scientific or operational context for this sequence.',
  },
] as const satisfies readonly EntitySchemaFieldSnapshot[];

export const SEQUENCE_LOCUS_FIELD = {
  key: 'locus',
  label: 'Locus',
  type: 'text',
  suggested: true,
} as const satisfies EntitySchemaFieldSnapshot;
export const SEQUENCE_SCHEMA_V2_FIELD_DEFINITIONS = [
  SEQUENCE_LOCUS_FIELD,
  ...SEQUENCE_SCHEMA_V1_FIELD_DEFINITIONS,
] as const satisfies readonly EntitySchemaFieldSnapshot[];

export const SEQUENCE_SCHEMA_FIELD_DEFINITIONS = SEQUENCE_SCHEMA_V1_FIELD_DEFINITIONS;

export const PLASMID_SCHEMA_FIELD_DEFINITIONS = [
  { key: 'markers', label: 'Markers or resistances', type: 'string_array', suggested: true },
  { key: 'ori', label: 'Origin of replication', type: 'text', suggested: true },
  { key: 'hostClass', label: 'Host class', type: 'text', suggested: true },
  { key: 'cloningMethod', label: 'Cloning method', type: 'text', suggested: true },
  { key: 'accessions', label: 'Accessions', type: 'string_array', suggested: true },
  { key: 'notes', label: 'Notes', type: 'long_text', suggested: true },
] as const satisfies readonly EntitySchemaFieldSnapshot[];

export const BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT: EntitySchemaRevisionSnapshot = {
  schemaId: BUILTIN_SEQUENCE_SCHEMA_ID,
  schemaRevisionId: BUILTIN_SEQUENCE_SCHEMA_REVISION_ID,
  name: 'sequence',
  displayName: 'DNA sequence',
  baseKind: 'sequence',
  version: 3,
  fields: SEQUENCE_SCHEMA_FIELD_DEFINITIONS.map((field) => ({ ...field })),
};

export const BUILTIN_PLASMID_SCHEMA_SNAPSHOT: EntitySchemaRevisionSnapshot = {
  schemaId: BUILTIN_PLASMID_SCHEMA_ID,
  schemaRevisionId: BUILTIN_PLASMID_SCHEMA_REVISION_ID,
  name: 'plasmid',
  displayName: 'Plasmid',
  description: 'A user-configurable sequence-backed plasmid record.',
  baseKind: 'sequence',
  version: 2,
  fields: PLASMID_SCHEMA_FIELD_DEFINITIONS.map((field) => ({ ...field })),
};

export function createSequenceEntityMetadataForSchema(
  schema: SequenceSchemaDefinitionView
): SchemaBoundSequenceEntityMetadata {
  if (schema.baseKind !== 'sequence') {
    throw new Error(`${schema.displayName} is not a sequence-backed schema.`);
  }
  return {
    schema: {
      schemaId: schema.schemaId,
      schemaRevisionId: schema.currentRevisionId,
      name: schema.entityKind,
      displayName: schema.displayName,
      description: schema.description ?? null,
      baseKind: 'sequence',
      version: schema.version,
      fields: schema.fields.map((field) => ({ ...field })),
    },
    fields: {},
    registrationStatus: 'tracked',
    domainStatus: null,
    registryId: null,
    relationships: [],
  };
}

export function createDefaultSequenceEntityMetadata(): SchemaBoundSequenceEntityMetadata {
  return {
    schema: {
      ...BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
      fields: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.fields.map((field) => ({ ...field })),
    },
    fields: {},
    registrationStatus: 'tracked',
    domainStatus: null,
    registryId: null,
    relationships: [],
  };
}

export function createDefaultPlasmidEntityMetadata(): SchemaBoundSequenceEntityMetadata {
  return {
    schema: {
      ...BUILTIN_PLASMID_SCHEMA_SNAPSHOT,
      fields: BUILTIN_PLASMID_SCHEMA_SNAPSHOT.fields.map((field) => ({ ...field })),
    },
    fields: {},
    registrationStatus: 'tracked',
    domainStatus: null,
    registryId: null,
    relationships: [],
  };
}

export const DEFAULT_SEQUENCE_ENTITY_METADATA = createDefaultSequenceEntityMetadata();
