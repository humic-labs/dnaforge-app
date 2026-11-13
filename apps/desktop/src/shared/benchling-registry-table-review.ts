import { isSafeWorkspaceRelativePath } from './path-boundary';

export type RegistryTableReviewSource = Readonly<{
  archiveSha256: string;
  entryPath: string;
  entrySha256: string;
  entrySizeBytes: number;
}>;

export type RegistryTableReviewCandidate = RegistryTableReviewSource &
  (
    | Readonly<{
        status: 'ready';
        headersSha256: string;
        headers: readonly string[];
        rowCount: number;
        previewRows: readonly (readonly string[])[];
      }>
    | Readonly<{ status: 'unavailable'; reason: string }>
  );

export type ReviewedRegistryFieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'string_array'
  | 'record_relationship';

export type ReviewedRegistryTableRowRef = Readonly<{
  actionId: string;
  source: RegistryTableReviewSource;
  rowOrdinal: number;
  mappingSha256: string;
}>;

export function parseReviewedRegistryTableRowRef(value: unknown): ReviewedRegistryTableRowRef {
  const row = object(value);
  exactKeys(row, ['actionId', 'source', 'rowOrdinal', 'mappingSha256']);
  const decision = parseRegistryTableMappingDecision({
    kind: 'registry_table_mapping',
    version: 1,
    source: row.source,
    outcome: { kind: 'source_only', reason: 'Source reference' },
  });
  const rowOrdinal = integer(row.rowOrdinal, 20000);
  if (rowOrdinal === 0) throw new Error('Reviewed table row ordinal must be positive.');
  return {
    actionId: label(row.actionId),
    source: decision.source,
    rowOrdinal,
    mappingSha256: sha256(row.mappingSha256),
  };
}

export type RegistryTableColumnChoice =
  | Readonly<{ kind: 'name' }>
  | Readonly<{ kind: 'provider_id' }>
  | Readonly<{ kind: 'field'; label: string; type: ReviewedRegistryFieldType }>
  | Readonly<{ kind: 'source_only'; reason: string }>;

export type RegistryTableMappingDecision = Readonly<{
  kind: 'registry_table_mapping';
  version: 1;
  source: RegistryTableReviewSource;
  outcome:
    | Readonly<{ kind: 'source_only'; reason: string }>
    | Readonly<{
        kind: 'records';
        headersSha256: string;
        rowCount: number;
        columns: readonly RegistryTableColumnChoice[];
      }>;
}>;

export function parseRegistryTableMappingDecision(value: unknown): RegistryTableMappingDecision {
  const input = object(value);
  exactKeys(input, ['kind', 'version', 'source', 'outcome']);
  if (input.kind !== 'registry_table_mapping' || input.version !== 1)
    throw new Error('Registry table mapping version is invalid.');
  const rawSource = object(input.source);
  exactKeys(rawSource, ['archiveSha256', 'entryPath', 'entrySha256', 'entrySizeBytes']);
  if (
    typeof rawSource.entryPath !== 'string' ||
    !isSafeWorkspaceRelativePath(rawSource.entryPath) ||
    !/\.(csv|tsv)$/iu.test(rawSource.entryPath)
  )
    throw new Error('Registry table mapping path is invalid.');
  const source: RegistryTableReviewSource = {
    archiveSha256: sha256(rawSource.archiveSha256),
    entryPath: rawSource.entryPath,
    entrySha256: sha256(rawSource.entrySha256),
    entrySizeBytes: integer(rawSource.entrySizeBytes, Number.MAX_SAFE_INTEGER),
  };
  const outcome = object(input.outcome);
  if (outcome.kind === 'source_only') {
    exactKeys(outcome, ['kind', 'reason']);
    return {
      kind: 'registry_table_mapping',
      version: 1,
      source,
      outcome: { kind: 'source_only', reason: label(outcome.reason) },
    };
  }
  exactKeys(outcome, ['kind', 'headersSha256', 'rowCount', 'columns']);
  if (source.entrySizeBytes > 16 * 1024 * 1024)
    throw new Error('Registry table exceeds the record-conversion size limit.');
  if (
    outcome.kind !== 'records' ||
    !Array.isArray(outcome.columns) ||
    outcome.columns.length === 0 ||
    outcome.columns.length > 1000
  )
    throw new Error('Registry table mapping requires ordered column choices.');
  const columns = outcome.columns.map((raw): RegistryTableColumnChoice => {
    const column = object(raw);
    switch (column.kind) {
      case 'name':
      case 'provider_id':
        exactKeys(column, ['kind']);
        return { kind: column.kind };
      case 'source_only':
        exactKeys(column, ['kind', 'reason']);
        return { kind: 'source_only', reason: label(column.reason) };
      case 'field': {
        exactKeys(column, ['kind', 'label', 'type']);
        const type = column.type;
        if (
          type !== 'text' &&
          type !== 'long_text' &&
          type !== 'number' &&
          type !== 'boolean' &&
          type !== 'date' &&
          type !== 'string_array' &&
          type !== 'record_relationship'
        )
          throw new Error('Registry table field type is not supported.');
        return { kind: 'field', label: label(column.label), type };
      }
      default:
        throw new Error('Registry table column choice is invalid.');
    }
  });
  if (
    columns.filter((column) => column.kind === 'name').length !== 1 ||
    columns.filter((column) => column.kind === 'provider_id').length > 1
  )
    throw new Error('Choose exactly one Name column and at most one Benchling ID column.');
  return {
    kind: 'registry_table_mapping',
    version: 1,
    source,
    outcome: {
      kind: 'records',
      headersSha256: sha256(outcome.headersSha256),
      rowCount: integer(outcome.rowCount, 20000),
      columns,
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Registry table mapping must contain objects.');
  return Object.fromEntries(Object.entries(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error('Registry table mapping contains missing or unsupported fields.');
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error('Registry table mapping digest is invalid.');
  return value;
}

function integer(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error('Registry table mapping count is invalid.');
  return value;
}

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\0\r\n]/u.test(value))
    throw new Error('Registry table mapping label or reason is invalid.');
  return value;
}
