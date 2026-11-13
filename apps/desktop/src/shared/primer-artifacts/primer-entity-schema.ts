import {
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  type LimsFieldDefinition,
  type LimsSchemaDefinitionView,
} from '../lims';
import {
  BUILTIN_PRIMER_SCHEMA_ID,
  BUILTIN_PRIMER_SCHEMA_REVISION_ID,
  BUILTIN_RNA_OLIGO_SCHEMA_ID,
  BUILTIN_RNA_OLIGO_SCHEMA_REVISION_ID,
  type PrimerEntitySchemaSnapshot,
} from './primer-artifact';
import type { OligoOrderType } from './oligo-order-type';
import { PRIMER_MANAGED_SCHEMA_FIELD_KEYS } from './primer-schema-contract';

export function builtinPrimerSchemaView(
  orderType: OligoOrderType = 'dna'
): LimsSchemaDefinitionView {
  const schemaName = orderType === 'rna' ? 'rna_oligo' : 'oligo';
  const oligo = LIMS_BUILTIN_ENTITY_SCHEMAS.find((schema) => schema.name === schemaName);
  if (!oligo) throw new Error(`The built-in ${schemaName} schema is missing.`);
  return {
    schemaId: orderType === 'rna' ? BUILTIN_RNA_OLIGO_SCHEMA_ID : BUILTIN_PRIMER_SCHEMA_ID,
    currentRevisionId:
      orderType === 'rna'
        ? BUILTIN_RNA_OLIGO_SCHEMA_REVISION_ID
        : BUILTIN_PRIMER_SCHEMA_REVISION_ID,
    entityKind: oligo.name,
    baseKind: 'primer',
    displayName: oligo.displayName,
    description: oligo.description,
    version: 1,
    builtin: true,
    fields: oligo.fields.map((field) => ({ ...field })),
  };
}

export function primerSchemas(
  schemas: readonly LimsSchemaDefinitionView[],
  orderType: OligoOrderType = 'dna'
): LimsSchemaDefinitionView[] {
  const builtinKind = orderType === 'rna' ? 'rna_oligo' : 'oligo';
  const sequenceFieldType = orderType === 'rna' ? 'rna_sequence' : 'dna_sequence';
  const compatible = schemas.filter((schema) => {
    if (schema.entityKind === builtinKind) return true;
    if (schema.baseKind !== 'primer') return false;
    return schema.fields.some(
      (field) => field.key === 'sequence' && field.type === sequenceFieldType
    );
  });
  if (!compatible.some((schema) => schema.entityKind === builtinKind)) {
    return [builtinPrimerSchemaView(orderType), ...compatible];
  }
  return compatible.map((schema) =>
    schema.entityKind === builtinKind
      ? {
          ...schema,
          baseKind: 'primer',
          displayName: builtinPrimerSchemaView(orderType).displayName,
        }
      : schema
  );
}

export function primerSchemaSnapshot(schema: LimsSchemaDefinitionView): PrimerEntitySchemaSnapshot {
  return {
    schemaId: schema.schemaId,
    schemaRevisionId: schema.currentRevisionId,
    name: schema.entityKind,
    displayName: schema.displayName,
    baseKind: 'primer',
    version: schema.version,
    description: schema.description,
    fields: schema.fields.map((field) => ({
      ...field,
      ...(field.enumOptions ? { enumOptions: [...field.enumOptions] } : {}),
    })),
  };
}

export function editablePrimerSchemaFields(
  schema: LimsSchemaDefinitionView
): LimsFieldDefinition[] {
  return schema.fields.filter((field) => !PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(field.key));
}

export function parsePrimerSchemaFieldValue(
  field: LimsFieldDefinition,
  value: string | boolean
): unknown {
  if (field.type === 'boolean') return value === true;
  const text = String(value).trim();
  if (!text) return undefined;
  if (field.type === 'number') return Number(text);
  if (field.type === 'string_array') {
    return text
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return text;
}
