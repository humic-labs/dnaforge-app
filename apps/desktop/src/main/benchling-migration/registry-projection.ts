import { createHash } from 'node:crypto';
import type {
  DnaSequenceRef,
  LimsDefineSchemaInput,
  LimsFieldDefinition,
  LimsLinkEntitiesInput,
  LimsRecordRelationshipValue,
  LimsRegisterEntityInput,
  ProteinSequenceRef,
  RnaSequenceRef,
} from '../../shared/lims';
import { validateLimsEntityFields } from '../../shared/lims';
import type { SourceObject } from '../../shared/benchling-migration';

export const BENCHLING_REGISTRY_LEGACY_PROJECTION_VERSION = 1 as const;
export const BENCHLING_REGISTRY_PROJECTION_VERSION = 2 as const;
export const BENCHLING_REGISTRY_CONVERTER_ID = 'benchling-registry-v1' as const;

const RESERVED_FIELD_DEFINITIONS = [
  requiredTextField('benchling_primary_registry_id', 'Benchling primary registry ID'),
  requiredTextField('benchling_source_registry_id', 'Benchling source registry ID'),
  requiredTextField('benchling_source_object_id', 'Benchling source object ID'),
  requiredTextField('benchling_source_url', 'Benchling source URL'),
  {
    key: 'benchling_relationship_provenance',
    label: 'Benchling relationship provenance',
    type: 'long_text',
    description:
      'Immutable captured relationship evidence, including external and source-broken targets.',
  },
] satisfies readonly LimsFieldDefinition[];

const RESERVED_FIELD_KEYS = new Set(RESERVED_FIELD_DEFINITIONS.map((field) => field.key));
const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type BenchlingPreservedRules = {
  conditional: readonly JsonValue[];
  automations: readonly JsonValue[];
  complexValidations: readonly JsonValue[];
};

export type BenchlingRegistryFieldSource = {
  sourceFieldId: string;
  definition: LimsFieldDefinition;
  rules?: Partial<BenchlingPreservedRules>;
};

export type BenchlingRegistrySchemaRevisionSource = {
  sourceSchemaId: string;
  sourceRevisionId: string;
  sourceRevisionNumber?: number | string;
  name: string;
  displayName: string;
  description?: string | null;
  fields: readonly BenchlingRegistryFieldSource[];
  rules?: Partial<BenchlingPreservedRules>;
};

export type BenchlingNativeMolecule =
  | { fieldKey: string; type: 'dna_sequence'; value: DnaSequenceRef }
  | { fieldKey: string; type: 'rna_sequence'; value: RnaSequenceRef }
  | { fieldKey: string; type: 'protein_sequence'; value: ProteinSequenceRef };

type RegistryRelationshipBase = {
  fieldKey: string;
  sourceRelationshipId: string;
  sourceTargetId: string;
  relationType: string;
  label: string;
};

export type BenchlingRegistryRelationshipSource =
  | (RegistryRelationshipBase & {
      classification: 'exact';
      destinationEntityId: string;
    })
  | (RegistryRelationshipBase & {
      classification: 'source_broken';
    })
  | (RegistryRelationshipBase & {
      classification: 'external';
      targetUrl: string;
    });

export type BenchlingRegistryRecordSource = {
  sourceObject: SourceObject;
  sourceSchemaRevisionId: string;
  fieldValues: Readonly<Record<string, unknown>>;
  molecule?: BenchlingNativeMolecule;
  relationships?: readonly BenchlingRegistryRelationshipSource[];
};

export type BenchlingRegistryProjectionInput = {
  destinationWorkspaceId: string;
  organizationId: string;
  converterVersion: string;
  capturedAt: string;
  schemas: readonly BenchlingRegistrySchemaRevisionSource[];
  records: readonly BenchlingRegistryRecordSource[];
};

export type RegistryRuleProvenance = {
  schema: BenchlingPreservedRules;
  fields: Array<{
    sourceFieldId: string;
    fieldKey: string;
    rules: BenchlingPreservedRules;
  }>;
};

export type RegistrySchemaProjection = {
  sourceSchemaId: string;
  sourceRevisionId: string;
  sourceRevisionNumber: number | string | null;
  destinationSchemaId: string;
  destinationSchemaRevisionId: string;
  destinationSchemaName: string;
  registryNamespace: string;
  materialization: {
    defineSchema: LimsDefineSchemaInput;
  };
  preservedRules: RegistryRuleProvenance;
};

export type RegistryRelationshipProjection = BenchlingRegistryRelationshipSource & {
  nativeFieldValue: LimsRecordRelationshipValue | null;
  linkInput: LimsLinkEntitiesInput | null;
};

export type RegistryRecordProjection = {
  sourceObjectId: string;
  stableSourceId: string;
  sourceSchemaId: string;
  sourceSchemaRevisionId: string;
  sourceRegistryId: string;
  destinationEntityId: string;
  desiredRegistryId: string;
  materialization: {
    registerEntity: LimsRegisterEntityInput;
    links: LimsLinkEntitiesInput[];
  };
  relationships: RegistryRelationshipProjection[];
  provenance: {
    sourceUrl: string;
    sourceType: string;
    createdAt: string | null;
    modifiedAt: string | null;
    capturedAt: string;
    metadata: JsonValue;
  };
};

export type RegistryRelationshipTypeProjection = {
  relationType: string;
  materialization: {
    defineSchema: LimsDefineSchemaInput;
  };
};

type BenchlingRegistryProjectionDocumentBody = {
  kind: 'waypoint.benchling-registry-projection';
  converterId: typeof BENCHLING_REGISTRY_CONVERTER_ID;
  converterVersion: string;
  organizationId: string;
  capturedAt: string;
  schemas: RegistrySchemaProjection[];
  relationshipTypes: RegistryRelationshipTypeProjection[];
  records: RegistryRecordProjection[];
  excludedSources: Array<{
    sourceObjectId: string;
    stableSourceId: string;
    reason: 'unregistered_sequence';
  }>;
};

export type BenchlingRegistryProjectionDocumentV1 = BenchlingRegistryProjectionDocumentBody & {
  version: typeof BENCHLING_REGISTRY_LEGACY_PROJECTION_VERSION;
};

export type BenchlingRegistryProjectionDocumentV2 = BenchlingRegistryProjectionDocumentBody & {
  version: typeof BENCHLING_REGISTRY_PROJECTION_VERSION;
  destinationWorkspaceId: string;
};

export type BenchlingRegistryProjectionDocument =
  | BenchlingRegistryProjectionDocumentV1
  | BenchlingRegistryProjectionDocumentV2;

export function buildBenchlingRegistryProjection(
  input: BenchlingRegistryProjectionInput
): BenchlingRegistryProjectionDocumentV2 {
  const destinationWorkspaceId = requiredText(
    input.destinationWorkspaceId,
    'destination workspace ID'
  );
  const organizationId = requiredText(input.organizationId, 'organization ID');
  const converterVersion = requiredText(input.converterVersion, 'converter version');
  const capturedAt = requireIsoTimestamp(input.capturedAt, 'capture time');
  const schemas = input.schemas
    .map((schema) => projectSchema(destinationWorkspaceId, organizationId, schema))
    .sort(compareProjectedSchemas);
  assertUnique(schemas, (schema) => schema.sourceRevisionId, 'source schema revision ID');
  assertUnique(schemas, (schema) => schema.destinationSchemaName, 'destination schema name');

  const schemaByRevision = new Map(schemas.map((schema) => [schema.sourceRevisionId, schema]));
  const sourceSchemaByRevision = new Map(
    input.schemas.map((schema) => [schema.sourceRevisionId, schema])
  );
  if (sourceSchemaByRevision.size !== input.schemas.length) {
    throw new Error('Benchling schema revision IDs must be unique.');
  }

  const included = input.records.filter((record) => !isUnregisteredSequence(record.sourceObject));
  const excludedSources = input.records
    .filter((record) => isUnregisteredSequence(record.sourceObject))
    .map((record) => ({
      sourceObjectId: requiredText(record.sourceObject.id, 'source object ID'),
      stableSourceId: requiredText(record.sourceObject.stableId, 'stable source object ID'),
      reason: 'unregistered_sequence' as const,
    }))
    .sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId));

  assertUnique(included, (record) => record.sourceObject.stableId, 'stable source object ID');
  const registryIdGroups = groupRecordsByRegistryId(included);
  assertNoWithinSchemaRegistryCollisions(registryIdGroups, schemaByRevision);

  const records = included
    .map((record) => {
      const schema = schemaByRevision.get(record.sourceSchemaRevisionId);
      const sourceSchema = sourceSchemaByRevision.get(record.sourceSchemaRevisionId);
      if (!schema || !sourceSchema) {
        throw new Error(
          `Record ${record.sourceObject.stableId} references unknown schema revision ${record.sourceSchemaRevisionId}.`
        );
      }
      if (record.sourceObject.schemaId && record.sourceObject.schemaId !== schema.sourceSchemaId) {
        throw new Error(
          `Record ${record.sourceObject.stableId} schema ${record.sourceObject.schemaId} does not match revision ${schema.sourceSchemaId}.`
        );
      }
      return projectRecord(
        destinationWorkspaceId,
        organizationId,
        capturedAt,
        record,
        schema,
        sourceSchema,
        registryIdGroups
      );
    })
    .sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId));

  const relationshipTypes = projectRelationshipTypes(
    destinationWorkspaceId,
    organizationId,
    records.flatMap((record) => record.relationships)
  );

  return {
    version: BENCHLING_REGISTRY_PROJECTION_VERSION,
    kind: 'waypoint.benchling-registry-projection',
    destinationWorkspaceId,
    converterId: BENCHLING_REGISTRY_CONVERTER_ID,
    converterVersion,
    organizationId,
    capturedAt,
    schemas,
    relationshipTypes,
    records,
    excludedSources,
  };
}

export function serializeBenchlingRegistryProjection(
  document: BenchlingRegistryProjectionDocument
): string {
  return `${stableJson(document)}\n`;
}

export function parseBenchlingRegistryProjectionDocument(
  value: unknown
): BenchlingRegistryProjectionDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Benchling registry projection must be an object.');
  }
  const document = value as Record<string, unknown>;
  if (document.kind !== 'waypoint.benchling-registry-projection') {
    throw new Error('Unsupported Benchling registry projection kind.');
  }
  if (document.converterId !== BENCHLING_REGISTRY_CONVERTER_ID) {
    throw new Error('Unsupported Benchling registry projection converter.');
  }
  if (
    document.version !== BENCHLING_REGISTRY_LEGACY_PROJECTION_VERSION &&
    document.version !== BENCHLING_REGISTRY_PROJECTION_VERSION
  ) {
    throw new Error('Unsupported Benchling registry projection version.');
  }
  requiredText(document.organizationId, 'organization ID');
  requiredText(document.converterVersion, 'converter version');
  requireIsoTimestamp(requiredText(document.capturedAt, 'capture time'), 'capture time');
  for (const key of ['schemas', 'relationshipTypes', 'records', 'excludedSources'] as const) {
    if (!Array.isArray(document[key])) {
      throw new Error(`Benchling registry projection ${key} must be an array.`);
    }
  }
  const body: BenchlingRegistryProjectionDocumentBody = {
    kind: 'waypoint.benchling-registry-projection',
    converterId: BENCHLING_REGISTRY_CONVERTER_ID,
    converterVersion: requiredText(document.converterVersion, 'converter version'),
    organizationId: requiredText(document.organizationId, 'organization ID'),
    capturedAt: requireIsoTimestamp(
      requiredText(document.capturedAt, 'capture time'),
      'capture time'
    ),
    schemas: document.schemas as RegistrySchemaProjection[],
    relationshipTypes: document.relationshipTypes as RegistryRelationshipTypeProjection[],
    records: document.records as RegistryRecordProjection[],
    excludedSources:
      document.excludedSources as BenchlingRegistryProjectionDocumentBody['excludedSources'],
  };
  if (document.version === BENCHLING_REGISTRY_PROJECTION_VERSION) {
    return {
      ...body,
      version: BENCHLING_REGISTRY_PROJECTION_VERSION,
      destinationWorkspaceId: requiredText(
        document.destinationWorkspaceId,
        'destination workspace ID'
      ),
    };
  }
  return { ...body, version: BENCHLING_REGISTRY_LEGACY_PROJECTION_VERSION };
}

function projectSchema(
  destinationWorkspaceId: string,
  organizationId: string,
  source: BenchlingRegistrySchemaRevisionSource
): RegistrySchemaProjection {
  const sourceSchemaId = requiredText(source.sourceSchemaId, 'source schema ID');
  const sourceRevisionId = requiredText(source.sourceRevisionId, 'source schema revision ID');
  const name = requiredText(source.name, 'source schema name');
  const displayName = requiredText(source.displayName, 'source schema display name');
  if (!Array.isArray(source.fields) || source.fields.length === 0) {
    throw new Error(`Benchling schema revision ${sourceRevisionId} requires at least one field.`);
  }
  const projectedFields = source.fields.map(projectField);
  assertUnique(projectedFields, (field) => field.key, `field key in ${sourceRevisionId}`);
  for (const field of projectedFields) {
    if (RESERVED_FIELD_KEYS.has(field.key)) {
      throw new Error(`Benchling field ${field.key} conflicts with migration provenance.`);
    }
  }
  const identity = `${destinationWorkspaceId}\0${organizationId}\0${sourceSchemaId}\0${sourceRevisionId}`;
  const workspaceNamespace = digest(destinationWorkspaceId, 8);
  const destinationSchemaId = `schema-${digest(identity, 24)}`;
  const destinationSchemaName = `imported_${slug(name, 20)}_${workspaceNamespace}_${digest(identity, 8)}`;
  const registryNamespace = `${slug(name, 16)}-${workspaceNamespace}-${digest(
    `${organizationId}\0${sourceSchemaId}`,
    8
  )}`;
  const fields = [...projectedFields, ...RESERVED_FIELD_DEFINITIONS].map(copyFieldDefinition);

  return {
    sourceSchemaId,
    sourceRevisionId,
    sourceRevisionNumber: normalizeRevisionNumber(source.sourceRevisionNumber),
    destinationSchemaId,
    destinationSchemaRevisionId: `${destinationSchemaId}-v1`,
    destinationSchemaName,
    registryNamespace,
    materialization: {
      defineSchema: {
        id: destinationSchemaId,
        kind: 'entity',
        name: destinationSchemaName,
        displayName: `${displayName} (Benchling ${sourceRevisionId})`,
        description: source.description ?? null,
        fields,
        builtin: false,
      },
    },
    preservedRules: {
      schema: normalizeRules(source.rules),
      fields: source.fields.map((field) => ({
        sourceFieldId: requiredText(
          field.sourceFieldId,
          `source field ID for ${field.definition.key}`
        ),
        fieldKey: field.definition.key,
        rules: normalizeRules(field.rules),
      })),
    },
  };
}

function projectField(source: BenchlingRegistryFieldSource): LimsFieldDefinition {
  requiredText(source.sourceFieldId, 'source field ID');
  const field = copyFieldDefinition(source.definition);
  if (!FIELD_KEY_PATTERN.test(field.key)) throw new Error(`Invalid LIMS field key: ${field.key}`);
  requiredText(field.label, `label for field ${field.key}`);
  if (field.type === 'enum' && (!field.enumOptions || field.enumOptions.length === 0)) {
    throw new Error(`Enum field ${field.key} requires enumOptions.`);
  }
  if (field.enumOptions) {
    const options = field.enumOptions.map((option) =>
      requiredText(option, `${field.key} enum option`)
    );
    if (new Set(options).size !== options.length) {
      throw new Error(`Enum field ${field.key} has duplicate enumOptions.`);
    }
  }
  for (const [label, value] of [
    ['minimum value', field.minValue],
    ['maximum value', field.maxValue],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`Field ${field.key} ${label} must be finite.`);
    }
  }
  if (
    field.minValue !== undefined &&
    field.maxValue !== undefined &&
    field.minValue > field.maxValue
  ) {
    throw new Error(`Field ${field.key} has an invalid numeric range.`);
  }
  if (field.minDate !== undefined) requireIsoDate(field.minDate, `${field.key} minimum date`);
  if (field.maxDate !== undefined) requireIsoDate(field.maxDate, `${field.key} maximum date`);
  if (
    field.minDate !== undefined &&
    field.maxDate !== undefined &&
    Date.parse(field.minDate) > Date.parse(field.maxDate)
  ) {
    throw new Error(`Field ${field.key} has an invalid date range.`);
  }
  return field;
}

function projectRecord(
  destinationWorkspaceId: string,
  organizationId: string,
  capturedAt: string,
  source: BenchlingRegistryRecordSource,
  schema: RegistrySchemaProjection,
  sourceSchema: BenchlingRegistrySchemaRevisionSource,
  registryIdGroups: ReadonlyMap<string, readonly BenchlingRegistryRecordSource[]>
): RegistryRecordProjection {
  const object = source.sourceObject;
  const sourceRegistryId = requiredText(object.registryId, `registry ID for ${object.stableId}`);
  const stableSourceId = requiredText(object.stableId, 'stable source object ID');
  const sourceObjectId = requiredText(object.id, 'source object ID');
  const destinationEntityId = benchlingRegistryDestinationEntityId(
    destinationWorkspaceId,
    organizationId,
    stableSourceId
  );
  const collisionGroup = registryIdGroups.get(normalizeRegistryId(sourceRegistryId)) ?? [];
  const desiredRegistryId =
    collisionGroup.length > 1
      ? `${schema.registryNamespace}:${sourceRegistryId}`
      : sourceRegistryId;
  const fields: Record<string, unknown> = cloneRecord(source.fieldValues, 'record field values');
  const fieldDefinitions = schema.materialization.defineSchema.fields;
  const sourceFieldDefinitions = new Map(
    sourceSchema.fields.map((field) => [field.definition.key, field.definition])
  );

  if (source.molecule) {
    const definition = sourceFieldDefinitions.get(source.molecule.fieldKey);
    if (!definition || definition.type !== source.molecule.type) {
      throw new Error(
        `Molecule field ${source.molecule.fieldKey} must be defined as ${source.molecule.type}.`
      );
    }
    fields[source.molecule.fieldKey] = cloneJsonValue(source.molecule.value, 'native molecule');
  }
  if (moleculeTypeForSource(object.sourceType) && !source.molecule) {
    throw new Error(`Registered molecule ${stableSourceId} requires native sequence data.`);
  }

  const relationships = projectRelationships(
    destinationEntityId,
    source.relationships ?? [],
    sourceFieldDefinitions
  );
  for (const relationship of relationships) {
    if (relationship.nativeFieldValue) {
      if (Object.prototype.hasOwnProperty.call(fields, relationship.fieldKey)) {
        throw new Error(`Relationship field ${relationship.fieldKey} has more than one value.`);
      }
      fields[relationship.fieldKey] = relationship.nativeFieldValue;
    }
  }
  fields.benchling_primary_registry_id = desiredRegistryId;
  fields.benchling_source_registry_id = sourceRegistryId;
  fields.benchling_source_object_id = stableSourceId;
  fields.benchling_source_url = requiredHttpUrl(object.sourceUrl, 'source object URL');
  if (relationships.length > 0) {
    fields.benchling_relationship_provenance = stableJson(
      relationships.map(
        ({ nativeFieldValue: _native, linkInput: _link, ...relationship }) => relationship
      )
    );
  }

  const validationErrors = validateLimsEntityFields(
    schema.destinationSchemaName,
    fields,
    fieldDefinitions
  );
  if (validationErrors.length > 0) {
    throw new Error(
      `Invalid Benchling registry record ${stableSourceId}: ${validationErrors.join('; ')}`
    );
  }

  return {
    sourceObjectId,
    stableSourceId,
    sourceSchemaId: schema.sourceSchemaId,
    sourceSchemaRevisionId: schema.sourceRevisionId,
    sourceRegistryId,
    destinationEntityId,
    desiredRegistryId,
    materialization: {
      registerEntity: {
        id: destinationEntityId,
        kind: schema.destinationSchemaName,
        name: requiredText(object.name, `name for ${stableSourceId}`),
        fields,
        registrationStatus: 'registered',
        schemaRevisionId: schema.destinationSchemaRevisionId,
        ...(object.createdAt
          ? { createdAt: requireEpoch(object.createdAt, 'record creation time') }
          : {}),
      },
      links: relationships.flatMap((relationship) =>
        relationship.linkInput ? [relationship.linkInput] : []
      ),
    },
    relationships,
    provenance: {
      sourceUrl: object.sourceUrl,
      sourceType: object.sourceType,
      createdAt: object.createdAt ?? null,
      modifiedAt: object.modifiedAt ?? null,
      capturedAt,
      metadata: cloneJsonValue(object.metadata, 'record metadata'),
    },
  };
}

function projectRelationships(
  destinationEntityId: string,
  sources: readonly BenchlingRegistryRelationshipSource[],
  fieldDefinitions: ReadonlyMap<string, LimsFieldDefinition>
): RegistryRelationshipProjection[] {
  const sorted = [...sources].sort((left, right) =>
    `${left.fieldKey}\0${left.sourceRelationshipId}`.localeCompare(
      `${right.fieldKey}\0${right.sourceRelationshipId}`
    )
  );
  assertUnique(sorted, (relationship) => relationship.fieldKey, 'relationship field key');
  return sorted.map((source) => {
    const field = fieldDefinitions.get(source.fieldKey);
    if (!field || field.type !== 'record_relationship') {
      throw new Error(`Relationship field ${source.fieldKey} must use record_relationship.`);
    }
    const sourceTargetId = requiredText(source.sourceTargetId, 'relationship source target ID');
    const relationType = requiredText(source.relationType, 'relationship type');
    const label = requiredText(source.label, 'relationship label');
    const sourceRelationshipId = requiredText(
      source.sourceRelationshipId,
      'source relationship ID'
    );
    if (source.classification === 'exact') {
      const destinationTargetId = requiredText(
        source.destinationEntityId,
        'exact relationship destination entity ID'
      );
      const nativeFieldValue: LimsRecordRelationshipValue = {
        sourceTargetId,
        destinationEntityId: destinationTargetId,
        relationType,
        label,
        resolution: 'exact',
      };
      return {
        ...source,
        sourceRelationshipId,
        sourceTargetId,
        relationType,
        label,
        destinationEntityId: destinationTargetId,
        nativeFieldValue,
        linkInput: {
          id: `link-${digest(
            `${destinationEntityId}\0${sourceRelationshipId}\0${destinationTargetId}`,
            24
          )}`,
          fromEntityId: destinationEntityId,
          toEntityId: destinationTargetId,
          type: relationType,
          payload: { source: 'benchling', sourceRelationshipId, sourceTargetId },
        },
      };
    }
    if (source.classification === 'source_broken') {
      return {
        ...source,
        sourceRelationshipId,
        sourceTargetId,
        relationType,
        label,
        nativeFieldValue: {
          sourceTargetId,
          destinationEntityId: null,
          relationType,
          label,
          resolution: 'source_broken',
        },
        linkInput: null,
      };
    }
    return {
      ...source,
      sourceRelationshipId,
      sourceTargetId,
      relationType,
      label,
      targetUrl: requiredHttpUrl(source.targetUrl, 'external relationship URL'),
      nativeFieldValue: null,
      linkInput: null,
    };
  });
}

function projectRelationshipTypes(
  destinationWorkspaceId: string,
  organizationId: string,
  relationships: readonly RegistryRelationshipProjection[]
): RegistryRelationshipTypeProjection[] {
  const names = [
    ...new Set(
      relationships
        .filter((relationship) => relationship.classification === 'exact')
        .map((relationship) => relationship.relationType)
    ),
  ].sort();
  return names.map((relationType) => ({
    relationType,
    materialization: {
      defineSchema: {
        id: `relationship-schema-${digest(
          `${destinationWorkspaceId}\0${organizationId}\0${relationType}`,
          24
        )}`,
        kind: 'relationship_type',
        name: relationType,
        displayName: relationType,
        description: 'Generic typed relationship imported from Benchling.',
        fields: [requiredTextField('source_relation_type', 'Source relationship type')],
        builtin: false,
      },
    },
  }));
}

function groupRecordsByRegistryId(
  records: readonly BenchlingRegistryRecordSource[]
): Map<string, BenchlingRegistryRecordSource[]> {
  const groups = new Map<string, BenchlingRegistryRecordSource[]>();
  for (const record of records) {
    const registryId = requiredText(
      record.sourceObject.registryId,
      `registry ID for ${record.sourceObject.stableId}`
    );
    const key = normalizeRegistryId(registryId);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return groups;
}

function assertNoWithinSchemaRegistryCollisions(
  groups: ReadonlyMap<string, readonly BenchlingRegistryRecordSource[]>,
  schemas: ReadonlyMap<string, RegistrySchemaProjection>
): void {
  for (const records of groups.values()) {
    const seen = new Set<string>();
    for (const record of records) {
      const sourceSchemaId = schemas.get(record.sourceSchemaRevisionId)?.sourceSchemaId;
      if (!sourceSchemaId) continue;
      if (seen.has(sourceSchemaId)) {
        throw new Error(
          `Registry ID ${record.sourceObject.registryId} is duplicated within source schema ${sourceSchemaId}.`
        );
      }
      seen.add(sourceSchemaId);
    }
  }
}

function compareProjectedSchemas(
  left: RegistrySchemaProjection,
  right: RegistrySchemaProjection
): number {
  return `${left.sourceSchemaId}\0${left.sourceRevisionId}`.localeCompare(
    `${right.sourceSchemaId}\0${right.sourceRevisionId}`
  );
}

function moleculeTypeForSource(sourceType: string): BenchlingNativeMolecule['type'] | null {
  const normalized = sourceType
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['dna_sequence', 'dna', 'plasmid'].includes(normalized)) return 'dna_sequence';
  if (['rna_sequence', 'rna'].includes(normalized)) return 'rna_sequence';
  if (['protein_sequence', 'protein'].includes(normalized)) return 'protein_sequence';
  return null;
}

function isUnregisteredSequence(source: SourceObject): boolean {
  return moleculeTypeForSource(source.sourceType) !== null && !source.registryId?.trim();
}

export function benchlingRegistryDestinationEntityId(
  destinationWorkspaceId: string,
  organizationId: string,
  stableSourceId: string
): string {
  return `entity-${digest(
    `${requiredText(destinationWorkspaceId, 'destination workspace ID')}\0${requiredText(
      organizationId,
      'organization ID'
    )}\0${requiredText(stableSourceId, 'stable source object ID')}`,
    24
  )}`;
}

function normalizeRules(
  rules: Partial<BenchlingPreservedRules> | undefined
): BenchlingPreservedRules {
  return {
    conditional: cloneJsonArray(rules?.conditional ?? [], 'conditional rules'),
    automations: cloneJsonArray(rules?.automations ?? [], 'automations'),
    complexValidations: cloneJsonArray(rules?.complexValidations ?? [], 'complex validations'),
  };
}

function copyFieldDefinition(field: LimsFieldDefinition): LimsFieldDefinition {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    ...(field.required !== undefined ? { required: field.required } : {}),
    ...(field.suggested !== undefined ? { suggested: field.suggested } : {}),
    ...(field.enumOptions ? { enumOptions: [...field.enumOptions] } : {}),
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
    ...(field.minValue !== undefined ? { minValue: field.minValue } : {}),
    ...(field.maxValue !== undefined ? { maxValue: field.maxValue } : {}),
    ...(field.minDate !== undefined ? { minDate: field.minDate } : {}),
    ...(field.maxDate !== undefined ? { maxDate: field.maxDate } : {}),
    ...(field.description !== undefined ? { description: field.description } : {}),
    ...(field.requireResolved !== undefined ? { requireResolved: field.requireResolved } : {}),
  };
}

function requiredTextField(key: string, label: string): LimsFieldDefinition {
  return { key, label, type: 'text', required: true };
}

function cloneJsonArray(value: readonly JsonValue[], label: string): JsonValue[] {
  return cloneJsonValue(value, label) as JsonValue[];
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>,
  label: string
): Record<string, unknown> {
  return cloneJsonValue(value, label) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown, label: string): JsonValue {
  try {
    const serialized = stableJson(value);
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new Error(`${label} must be deterministic JSON: ${errorMessage(error)}`);
  }
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(canonicalize(value, seen));
}

function canonicalize(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite numbers are not supported');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('cyclic values are not supported');
    seen.add(value);
    const result = value.map((entry) => canonicalize(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('cyclic values are not supported');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('only plain JSON objects are supported');
    }
    seen.add(value);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) throw new Error(`undefined value at ${key}`);
      result[key] = canonicalize(entry, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error(`${typeof value} values are not supported`);
}

function assertUnique<T>(values: readonly T[], keyFor: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = requiredText(keyFor(value), label);
    if (seen.has(key)) throw new Error(`Duplicate ${label}: ${key}.`);
    seen.add(key);
  }
}

function normalizeRegistryId(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function normalizeRevisionNumber(value: number | string | undefined): number | string | null {
  if (value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return requiredText(value, 'source schema revision number');
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required.`);
  return value.trim();
}

function requiredHttpUrl(value: unknown, label: string): string {
  const text = requiredText(value, label);
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  return url.toString();
}

function requireIsoTimestamp(value: string, label: string): string {
  const text = requiredText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be a valid timestamp.`);
  return text;
}

function requireIsoDate(value: string, label: string): string {
  const text = requiredText(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    !Number.isFinite(Date.parse(text)) ||
    new Date(`${text}T00:00:00.000Z`).toISOString().slice(0, 10) !== text
  ) {
    throw new Error(`${label} must be an ISO date.`);
  }
  return text;
}

function requireEpoch(value: string, label: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error(`${label} must be a valid timestamp.`);
  return epoch;
}

function slug(value: string, limit: number): string {
  return (
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, limit)
      .replace(/_+$/g, '') || 'schema'
  );
}

function digest(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
