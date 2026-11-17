import {
  classifyLimsEntityFieldIssues,
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  type LimsImportPlan,
} from '../../lims';
import type { SheetSyncSourceRow, SheetSyncValue } from './planner';
import { planSheetSync } from './planner';
import { parseIdtOligoNotation } from '../../primer-artifacts/oligo-modifications';

export function sheetSyncJsonValue(value: unknown): SheetSyncValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(sheetSyncJsonValue);
  if (
    value &&
    typeof value === 'object' &&
    Object.prototype.toString.call(value) === '[object Object]'
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, sheetSyncJsonValue(child)])
    );
  }
  throw new Error('Spreadsheet mapped values must be finite JSON values.');
}

export function sheetSyncRowsFromImportPlan(
  plan: LimsImportPlan,
  keyColumn: string
): SheetSyncSourceRow[] {
  if (!plan.columns.some((column) => column.sourceColumn === keyColumn))
    throw new Error(`Stable key column is missing: ${keyColumn}`);
  const rows = plan.records.map((record) => {
    if (!record.accepted || record.errors.length)
      throw new Error(
        `Spreadsheet row ${record.sourceRow ?? record.id} needs review before synchronization.`
      );
    const rawKey = record.source[keyColumn];
    if (typeof rawKey !== 'string' && !(typeof rawKey === 'number' && Number.isFinite(rawKey)))
      throw new Error(`Spreadsheet row ${record.sourceRow ?? record.id} has no stable key.`);
    const fields = Object.fromEntries(
      Object.entries(record.entityDraft.fields ?? {})
        .filter(([key]) => key !== 'sourceMetadata')
        .map(([key, value]) => [key, sheetSyncJsonValue(value)])
    );
    const schema = plan.schemaFields
      ? { fields: plan.schemaFields }
      : LIMS_BUILTIN_ENTITY_SCHEMAS.find((candidate) => candidate.name === record.entityDraft.kind);
    if (schema) {
      const issues = classifyLimsEntityFieldIssues(
        record.entityDraft.kind,
        record.entityDraft.fields,
        schema.fields
      );
      if (issues.incomplete.length || issues.malformed.length)
        throw new Error(
          `Spreadsheet row ${record.sourceRow ?? record.id} needs complete valid fields before synchronization: ${[...issues.incomplete, ...issues.malformed].join('; ')}`
        );
    }
    let oligoNotation: string | undefined;
    if (record.entityDraft.kind === 'oligo' || record.entityDraft.kind === 'rna_oligo') {
      const sequence = record.entityDraft.fields.sequence;
      const notation =
        record.sequenceNotation ??
        (sequence &&
        typeof sequence === 'object' &&
        'bases' in sequence &&
        typeof sequence.bases === 'string'
          ? sequence.bases
          : undefined);
      if (!notation)
        throw new Error('Spreadsheet oligos need a complete sequence before synchronization.');
      const parsed = parseIdtOligoNotation(notation, {
        orderType: record.entityDraft.kind === 'rna_oligo' ? 'rna' : 'dna',
      });
      if (parsed.errors.length || !parsed.bases)
        throw new Error('Spreadsheet oligo chemistry needs review before synchronization.');
      oligoNotation = parsed.composition?.notation ?? parsed.bases;
    }
    return {
      key: String(rawKey),
      record: {
        kind: record.entityDraft.kind,
        name: record.entityDraft.name,
        fields,
        ...(oligoNotation === undefined ? {} : { oligoNotation }),
      },
    };
  });
  planSheetSync({ sourceRows: rows, checkpoints: [], targets: [] });
  return rows;
}
