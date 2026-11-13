import {
  formatRegistryId,
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  type LimsIdScheme,
  type LimsImportPlan,
  type LimsImportPlanColumn,
  type LimsImportPlanRecord,
  type LimsSchemaDefinitionView,
} from '../../../shared/lims';
import type { FieldMappingOption } from './FieldMappingPicker';

export interface ImportPlanView {
  targetKind: string | undefined;
  fieldOptions: FieldMappingOption[];
  columnsByField: Map<string, string[]>;
  duplicatedFields: Set<string>;
  hasDuplicateMapping: boolean;
  requiredFieldsUnmet: FieldMappingOption[];
  sequenceFiles: boolean;
  orderedColumns: LimsImportPlanColumn[];
  dataColumns: string[];
  showRegistryId: boolean;
  targetScheme: LimsIdScheme | null;
  idPreview: Map<string, string>;
  idPreviewSample: string;
  idRange: string;
  acceptedCount: number;
  newCount: number;
  flaggedCount: number;
  registryDuplicateCount: number;
  allAlreadyRegistered: boolean;
  alreadyRegisteredName: string | null;
  detectedRecordsText: string;
  canApply: boolean;
}

export function computeImportPlanView(
  plan: LimsImportPlan,
  idSchemes: LimsIdScheme[],
  effectivePrefixOverride?: string,
  liveTargetSchema?: LimsSchemaDefinitionView
): ImportPlanView {
  const sequenceFiles = plan.columns.length === 0;
  const targetKind = plan.records[0]?.entityDraft.kind;
  const builtinSchema = targetKind
    ? LIMS_BUILTIN_ENTITY_SCHEMAS.find((schema) => schema.name === targetKind)
    : undefined;
  const fieldSource: { fields: { key: string; label: string; required: boolean }[] } | undefined =
    liveTargetSchema
      ? {
          fields: liveTargetSchema.fields.map((f) => ({
            key: f.key,
            label: f.label,
            required: f.required === true,
          })),
        }
      : builtinSchema
        ? {
            fields: builtinSchema.fields.map((f) => ({
              key: f.key,
              label: f.label,
              required: f.required === true,
            })),
          }
        : undefined;
  const builtinFieldKeys = new Set((builtinSchema?.fields ?? []).map((f) => f.key));
  const fieldOptions: FieldMappingOption[] = fieldSource
    ? [
        { value: 'entity.name', label: 'Name', custom: false, required: true },
        ...fieldSource.fields.map((field) => ({
          value: `fields.${field.key}`,
          label: field.label,
          custom: !builtinFieldKeys.has(field.key),
          required: field.required,
        })),
      ]
    : [];

  const fieldOrder = new Map<string, number>();
  fieldOptions.forEach((option, index) => fieldOrder.set(option.value, index));
  const registryRank = (column: LimsImportPlanColumn): number =>
    column.mappingMode === 'mapped' && column.mappedField
      ? (fieldOrder.get(column.mappedField) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
  const orderedColumns = plan.columns
    .map((column, sourceIndex) => ({ column, sourceIndex }))
    .sort(
      (a, b) => registryRank(a.column) - registryRank(b.column) || a.sourceIndex - b.sourceIndex
    )
    .map((entry) => entry.column);
  const dataColumns = orderedColumns.map((column) => column.sourceColumn);

  const columnsByField = new Map<string, string[]>();
  for (const column of plan.columns) {
    if (column.mappingMode === 'mapped' && column.mappedField) {
      const claimants = columnsByField.get(column.mappedField) ?? [];
      claimants.push(column.sourceColumn);
      columnsByField.set(column.mappedField, claimants);
    }
  }
  const duplicatedFields = new Set(
    [...columnsByField].filter(([, claimants]) => claimants.length > 1).map(([field]) => field)
  );
  const hasDuplicateMapping = duplicatedFields.size > 0;

  const requiredFieldsUnmet: FieldMappingOption[] = sequenceFiles
    ? []
    : fieldOptions.filter(
        (option) => option.required && !(columnsByField.get(option.value)?.length ?? 0)
      );

  const idScheme =
    (targetKind && idSchemes.find((scheme) => scheme.kind === targetKind && scheme.enabled)) ||
    null;
  const showRegistryId = idScheme !== null && !sequenceFiles;
  const effectivePrefix = effectivePrefixOverride ?? idScheme?.prefix ?? '';
  const idPreview = new Map<string, string>();
  if (showRegistryId && idScheme) {
    let seq = idScheme.nextSeq;
    for (const record of plan.records) {
      if (
        record.accepted &&
        record.errors.length === 0 &&
        record.duplicateCandidates.length === 0
      ) {
        idPreview.set(record.id, formatRegistryId(effectivePrefix, idScheme.padWidth, seq));
        seq += 1;
      }
    }
  }
  const idValues = [...idPreview.values()];
  const idPreviewSample = idValues.slice(0, 2).join(', ');
  const idRange =
    idValues.length === 0
      ? ''
      : idValues.length === 1
        ? idValues[0]
        : `${idValues[0]} – ${idValues[idValues.length - 1]}`;

  const acceptedCount = plan.records.filter((record) => record.accepted).length;
  const newCount = plan.records.filter(
    (record) => importRecordDuplicateKind(record) === null && !recordHasReviewIssue(record)
  ).length;
  const flaggedCount = plan.records.filter(
    (record) =>
      record.accepted &&
      record.errors.length === 0 &&
      (record.warnings.length > 0 || record.unresolvedLinks.length > 0)
  ).length;

  const registryDuplicateCount = plan.records.filter(
    (record) => importRecordDuplicateKind(record) === 'registry'
  ).length;
  const allAlreadyRegistered =
    plan.records.length > 0 &&
    registryDuplicateCount > 0 &&
    plan.records.every(
      (record) => importRecordDuplicateKind(record) === 'registry' && record.errors.length === 0
    );
  const alreadyRegisteredName =
    allAlreadyRegistered && plan.records.length === 1
      ? (plan.records[0]?.duplicateCandidates[0]?.name ?? null)
      : null;

  return {
    targetKind,
    fieldOptions,
    columnsByField,
    duplicatedFields,
    hasDuplicateMapping,
    requiredFieldsUnmet,
    sequenceFiles,
    orderedColumns,
    dataColumns,
    showRegistryId,
    targetScheme: idScheme,
    idPreview,
    idPreviewSample,
    idRange,
    acceptedCount,
    newCount,
    flaggedCount,
    registryDuplicateCount,
    allAlreadyRegistered,
    alreadyRegisteredName,
    detectedRecordsText: detectedRecordsText(plan),
    canApply: plan.canApply && !hasDuplicateMapping && requiredFieldsUnmet.length === 0,
  };
}

export function importRecordDuplicateKind(
  record: LimsImportPlanRecord
): 'registry' | 'batch' | null {
  const reason = record.duplicateCandidates[0]?.reason;
  if (!reason) return null;
  if (reason.startsWith('Another row in this import')) return 'batch';
  return 'registry';
}

function recordHasReviewIssue(record: LimsImportPlanRecord): boolean {
  return (
    record.errors.length > 0 ||
    record.unresolvedLinks.length > 0 ||
    record.duplicateCandidates.length > 0 ||
    record.warnings.length > 0 ||
    record.action === 'skip'
  );
}

function detectedRecordsText(plan: LimsImportPlan): string {
  const count = plan.records.length;
  if (plan.detectedKind === 'primer_table') return `${count} ${count === 1 ? 'oligo' : 'oligos'}`;
  if (plan.detectedKind === 'sequence_file') {
    if (plan.records.every((record) => record.entityDraft.kind === 'protein')) {
      return `${count} ${count === 1 ? 'protein' : 'proteins'}`;
    }
    return `${count} sequence ${count === 1 ? 'file' : 'files'}`;
  }
  if (plan.detectedKind === 'strain_table') {
    return `${count} ${count === 1 ? 'strain' : 'strains'}`;
  }
  return `${count} ${count === 1 ? 'record' : 'records'}`;
}
