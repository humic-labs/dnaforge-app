export interface EntitySchemaFieldSnapshot {
  key: string;
  label: string;

  type: string;
  required?: boolean;
  suggested?: boolean;
  enumOptions?: readonly string[];
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  minDate?: string;
  maxDate?: string;
  description?: string;
  requireResolved?: boolean;

  intrinsic?: 'sequence.length' | 'sequence.topology' | 'sequence.geneticCode';

  readOnly?: boolean;
}

export interface PortableEntitySchemaRevisionSnapshot<BaseKind extends string = string> {
  schemaId: string;
  schemaRevisionId: string;
  name: string;
  displayName: string;
  baseKind: BaseKind;

  fields: EntitySchemaFieldSnapshot[];
  [key: string]: unknown;
}

export interface ProjectableEntitySchemaRevisionSnapshot<
  BaseKind extends string = string,
> extends PortableEntitySchemaRevisionSnapshot<BaseKind> {
  version: number;
  description?: string | null;
}

export function hasScientificSequenceField(schema?: PortableEntitySchemaRevisionSnapshot): boolean {
  if (!schema) return true;
  if (schema.baseKind === 'sequence') return true;
  const field = schema.fields.find((field) => field.key === 'sequence');
  return (
    field !== undefined && ['dna_sequence', 'rna_sequence', 'protein_sequence'].includes(field.type)
  );
}

export function isPortableEntitySchemaRevisionSnapshot(
  value: unknown,
  expectedBaseKind?: string
): value is PortableEntitySchemaRevisionSnapshot {
  if (!isRecord(value)) return false;
  if (
    typeof value.schemaId !== 'string' ||
    !value.schemaId ||
    typeof value.schemaRevisionId !== 'string' ||
    !value.schemaRevisionId ||
    typeof value.name !== 'string' ||
    !value.name ||
    typeof value.displayName !== 'string' ||
    !value.displayName ||
    typeof value.baseKind !== 'string' ||
    !value.baseKind ||
    (expectedBaseKind != null && value.baseKind !== expectedBaseKind) ||
    !Array.isArray(value.fields)
  ) {
    return false;
  }
  const keys = new Set<string>();
  for (const field of value.fields) {
    if (
      !isRecord(field) ||
      typeof field.key !== 'string' ||
      !field.key ||
      typeof field.label !== 'string' ||
      !field.label ||
      typeof field.type !== 'string' ||
      !field.type ||
      keys.has(field.key)
    ) {
      return false;
    }
    keys.add(field.key);
  }
  return true;
}

export function isProjectableEntitySchemaRevisionSnapshot(
  value: unknown
): value is ProjectableEntitySchemaRevisionSnapshot {
  return (
    isPortableEntitySchemaRevisionSnapshot(value) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 1 &&
    (value.description === undefined ||
      value.description === null ||
      typeof value.description === 'string')
  );
}

export function entitySchemaRevisionContent(snapshot: ProjectableEntitySchemaRevisionSnapshot) {
  return {
    schemaId: snapshot.schemaId,
    schemaRevisionId: snapshot.schemaRevisionId,
    version: snapshot.version,
    name: snapshot.name,
    baseKind: snapshot.baseKind,
    fields: snapshot.fields,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
