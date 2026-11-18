import { assertLimsTemporalEdits } from '@waypoint/scientific-artifacts/shared/lims-temporal';
import {
  temporalFieldValue,
  temporalFieldDraft,
  temporalFieldDisplay,
} from '../../registry-temporal-input';
import { withUserMessage, userMessagePayload, userMessageValue } from '@waypoint/user-messages';
import {
  geneticCodeLabel,
  isKnownGeneticCodeId,
  STANDARD_GENETIC_CODE_ID,
  type GeneticCodeSpec,
  GENETIC_CODES,
} from '@waypoint/sequence-utils';
import type { EntitySchemaFieldSnapshot } from '../../entity-schema';
import { classifyLimsEntityFieldIssues, isLimsFieldType } from '../../lims';

export const EMPTY_REGISTRY_FIELD_TEXT = '-';

const EDITABLE_FIELD_TYPES = new Set([
  'text',
  'long_text',
  'date',
  'datetime',
  'number',
  'boolean',
  'enum',
  'string_array',
  'genetic_code',
  'record_relationship',
]);

export function registryFieldIsEditable(field: EntitySchemaFieldSnapshot): boolean {
  return field.readOnly !== true && EDITABLE_FIELD_TYPES.has(field.type);
}

export function registryFieldText(field: EntitySchemaFieldSnapshot, value: unknown): string {
  if (value === undefined || value === null || value === '') return EMPTY_REGISTRY_FIELD_TEXT;
  if (field.type === 'datetime') return temporalFieldDisplay('datetime', value);
  if (field.intrinsic === 'sequence.topology')
    return value === 'circular' ? 'Circular' : value === 'linear' ? 'Linear' : String(value);
  if (field.type === 'genetic_code') {
    if (typeof value === 'number' || (typeof value === 'object' && value !== null)) {
      return geneticCodeLabel(value as GeneticCodeSpec);
    }
    return EMPTY_REGISTRY_FIELD_TEXT;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : '-';
  if (typeof value === 'string') return value || EMPTY_REGISTRY_FIELD_TEXT;
  if (Array.isArray(value)) {
    const items = value.filter(
      (item): item is string => typeof item === 'string' && item.length > 0
    );
    return items.length > 0 ? items.join(', ') : EMPTY_REGISTRY_FIELD_TEXT;
  }
  if (typeof value !== 'object') return EMPTY_REGISTRY_FIELD_TEXT;

  const record = value as Record<string, unknown>;
  if (['dna_sequence', 'rna_sequence', 'protein_sequence'].includes(field.type)) {
    const length =
      typeof record.length === 'number'
        ? record.length
        : typeof record.bases === 'string'
          ? record.bases.length
          : null;
    return length === null ? EMPTY_REGISTRY_FIELD_TEXT : length.toLocaleString();
  }
  if (
    field.type === 'quantity' &&
    typeof record.lexical === 'string' &&
    typeof record.unit === 'string'
  ) {
    return `${record.lexical} ${record.unit}`.trim() || EMPTY_REGISTRY_FIELD_TEXT;
  }
  if (field.type === 'record_relationship' && typeof record.label === 'string') {
    return record.label || EMPTY_REGISTRY_FIELD_TEXT;
  }
  if (field.type === 'attachment_reference' && typeof record.logicalName === 'string') {
    return record.logicalName || EMPTY_REGISTRY_FIELD_TEXT;
  }
  if (field.type === 'formula_result') {
    const result =
      record.compatibility === 'supported' ? record.calculatedValue : record.sourceValue;
    if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
      return String(result);
    }
  }
  return JSON.stringify(value);
}

export function registryFieldOptions(
  field: EntitySchemaFieldSnapshot
): { value: string; label: string }[] {
  const empty = field.required ? [] : [{ value: '', label: EMPTY_REGISTRY_FIELD_TEXT }];
  if (field.type === 'genetic_code')
    return GENETIC_CODES.map((code) => ({
      value: String(code.id),
      label: geneticCodeLabel(code.id),
    }));
  if (field.type === 'boolean')
    return [...empty, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
  return [
    ...empty,
    ...(field.enumOptions ?? []).map((value) => ({
      value,
      label: registryFieldText(field, value),
    })),
  ];
}

export function registryFieldDraftText(field: EntitySchemaFieldSnapshot, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (field.type === 'date' || field.type === 'datetime') return temporalFieldDraft(value);
  if (field.type === 'genetic_code') return typeof value === 'number' ? String(value) : '';
  if (field.type === 'string_array') {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').join('\n')
      : '';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function parseRegistryFieldDraft(field: EntitySchemaFieldSnapshot, draft: string): unknown {
  const value = parseMetadataFieldValue(field, draft);
  if (!isLimsFieldType(field.type)) throw new Error(`${field.label} cannot be edited here.`);
  if (field.type === 'date' || field.type === 'datetime')
    assertLimsTemporalEdits({ [field.key]: value }, [{ ...field, type: field.type }]);
  const issues = classifyLimsEntityFieldIssues('metadata', { [field.key]: value }, [
    { ...field, type: field.type },
  ]);
  const error = [...issues.malformed, ...issues.incomplete][0];
  if (error) {
    const label = userMessageValue(field.label);
    const message =
      field.required &&
      (value == null || value === '' || (Array.isArray(value) && value.length === 0))
        ? userMessagePayload('validation.fieldRequired', { field: label })
        : typeof value === 'number' && typeof field.maxValue === 'number' && value > field.maxValue
          ? userMessagePayload('validation.fieldMax', {
              field: label,
              limit: userMessageValue(field.maxValue),
            })
          : typeof value === 'number' &&
              typeof field.minValue === 'number' &&
              value < field.minValue
            ? userMessagePayload('validation.fieldMin', {
                field: label,
                limit: userMessageValue(field.minValue),
              })
            : userMessagePayload('validation.fieldInvalid', { field: label });
    throw withUserMessage(new Error(error.replace(field.key, field.label)), message);
  }
  return value;
}

function parseMetadataFieldValue(field: EntitySchemaFieldSnapshot, draft: string): unknown {
  switch (field.type) {
    case 'number': {
      if (draft.trim() === '') return null;
      const value = Number(draft);
      if (!Number.isFinite(value)) throw new Error(`${field.label} must be a number.`);
      return value;
    }
    case 'boolean':
      if (draft === '') return null;
      if (draft === 'true') return true;
      if (draft === 'false') return false;
      throw new Error(`${field.label} must be Yes or No.`);
    case 'datetime':
      return temporalFieldValue('datetime', draft);
    case 'enum':
    case 'date':
      return draft === '' ? null : draft;
    case 'genetic_code': {
      const value = draft === '' ? STANDARD_GENETIC_CODE_ID : Number(draft);
      if (!isKnownGeneticCodeId(value)) {
        throw new Error(`${field.label} must be a published NCBI genetic code.`);
      }
      return value;
    }
    case 'string_array':
      return draft
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
    case 'text':
    case 'long_text':
      return draft;
    default:
      throw new Error(`${field.label} cannot be edited here.`);
  }
}
