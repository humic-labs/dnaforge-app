import { STANDARD_GENETIC_CODE_ID, type GeneticCodeSpec } from '@waypoint/sequence-utils';
import { PRIMER_ARTIFACT_SCHEMA } from '@waypoint/scientific-artifacts/shared/primers/primer-artifact';
import {
  ENTITY_RECORD_ARTIFACT_SCHEMA,
  ENTITY_RECORD_ARTIFACT_CURRENT_SCHEMA,
} from './registry-file-types';
import type {
  EntitySchemaFieldSnapshot,
  ProjectableEntitySchemaRevisionSnapshot,
} from './entity-schema';
import {
  resolvedEntitySchemaFields,
  resolvedEntitySchemaProperties,
  isDerivedSequencePropertyField,
} from './sequence-entity-schema';
import {
  classifyLimsEntityFieldIssues,
  type LimsFieldDefinition,
  type LimsRegistrationStatus,
} from './lims';

export interface SequenceIntrinsicRecordValues {
  length?: number;
  topology?: 'linear' | 'circular';
  geneticCode?: GeneticCodeSpec;
}

export function entityRecordFieldValue(
  field: EntitySchemaFieldSnapshot,
  storedFields: Readonly<Record<string, unknown>>,
  sequence: SequenceIntrinsicRecordValues = {}
): unknown {
  switch (field.intrinsic) {
    case 'sequence.length':
      return sequence.length;
    case 'sequence.topology':
      return sequence.topology;
    case 'sequence.geneticCode':
      return sequence.geneticCode ?? STANDARD_GENETIC_CODE_ID;
    default:
      return storedFields[field.key];
  }
}

export function resolveEntityRecordFieldValues(
  schema: ProjectableEntitySchemaRevisionSnapshot,
  storedFields: Readonly<Record<string, unknown>>,
  sequence: SequenceIntrinsicRecordValues = {}
): Record<string, unknown> {
  return Object.fromEntries([
    ...resolvedEntitySchemaFields(schema).map((field) => [
      field.key,
      entityRecordFieldValue(field, storedFields, sequence),
    ]),
    ...resolvedEntitySchemaProperties(schema).map((property) => [property.key, sequence.length]),
  ]);
}

export function validatedSequenceEntityRegistrationStatus(
  schema: ProjectableEntitySchemaRevisionSnapshot<'sequence'>,
  fields: Readonly<Record<string, unknown>>,
  currentStatus: LimsRegistrationStatus
): LimsRegistrationStatus {
  const { malformed, incomplete } = classifyLimsEntityFieldIssues(
    schema.name,
    fields as Record<string, unknown>,
    schema.fields as readonly LimsFieldDefinition[]
  );
  if (malformed.length > 0) {
    throw new Error(`Invalid ${schema.displayName} metadata: ${malformed.join('; ')}`);
  }
  if (incomplete.length > 0 && currentStatus === 'registered') return 'unresolved';
  if (incomplete.length === 0 && currentStatus === 'unresolved') return 'registered';
  return currentStatus;
}

const ENTITY_RECORD_BOOKKEEPING_KEYS = new Set([
  'artifact',
  'artifactFingerprint',
  'schemaId',
  'schemaRevisionId',
  'packageKind',
  'acceptedAssemblyVersionId',
  'acceptedVersionId',
  'designId',
  'canonicalDraftChecksum',
]);

export function isEntityRecordBookkeepingField(key: string): boolean {
  return key.startsWith('_') || ENTITY_RECORD_BOOKKEEPING_KEYS.has(key);
}

export function otherEntityMetadata(
  schema: Pick<ProjectableEntitySchemaRevisionSnapshot, 'baseKind' | 'fields'>,
  storedFields: Readonly<Record<string, unknown>>
): Array<{ key: string; label: string; value: unknown }> {
  const schemaKeys = new Set([
    ...resolvedEntitySchemaFields(schema).map((field) => field.key),
    ...resolvedEntitySchemaProperties(schema).map((property) => property.key),
    ...schema.fields
      .filter((field) => isDerivedSequencePropertyField(schema, field))
      .map((field) => field.key),
  ]);
  return Object.entries(storedFields)
    .filter(
      ([key, value]) =>
        !schemaKeys.has(key) &&
        key !== 'sequence' &&
        key !== 'sourceMetadata' &&
        (key === 'artifact' || !isEntityRecordBookkeepingField(key)) &&
        !(key === 'artifact' && isProjectedArtifactLocator(value))
    )
    .map(([key, value]) => ({ key, label: humanizeMetadataKey(key), value }));
}

function isProjectedArtifactLocator(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'schema' in value &&
    'relativePath' in value &&
    typeof value.relativePath === 'string' &&
    [
      PRIMER_ARTIFACT_SCHEMA,
      ENTITY_RECORD_ARTIFACT_SCHEMA,
      ENTITY_RECORD_ARTIFACT_CURRENT_SCHEMA,
    ].some((schema) => schema === value.schema)
  );
}

export function humanizeMetadataKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
