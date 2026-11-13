import { isEntityRecordBookkeepingField } from './entity-record';
import type { ProjectableEntitySchemaRevisionSnapshot } from './entity-schema';
import { resolvedEntitySchemaFields } from './sequence-entity-schema';

const nativeLocators: Readonly<Record<string, readonly string[]>> = {
  notebook: ['packagePath'],
  'track-view': ['referenceAssemblyId'],
  'molecular-document': ['currentReferenceId'],
};

export function publicEntitySchemaFields(
  schema: ProjectableEntitySchemaRevisionSnapshot,
  kind = schema.name
) {
  return resolvedEntitySchemaFields(schema).filter(
    (field) =>
      !isEntityRecordBookkeepingField(field.key) && !nativeLocators[kind]?.includes(field.key)
  );
}

export const PUBLIC_METADATA_HISTORY_VALUE_TYPES: ReadonlySet<string> = new Set([
  'text',
  'long_text',
  'number',
  'boolean',
  'date',
  'enum',
  'string_array',
  'genetic_code',
]);
