import type { GenomicMarkupDataset, GenomicMarkupObservation } from './genomic-markup';

export interface SequenceDataLayerTarget {
  readonly documentId: string;
  readonly sequenceFingerprint: string;
  readonly annotationFingerprint?: string;
  readonly length: number;
}

export interface SequenceDataLayerAnnotation {
  readonly id: string;
  readonly start0: number;
  readonly end0: number;
  readonly qualifiers?: Readonly<Record<string, readonly string[]>>;
}

export type SequenceDataLayerMapping =
  | Readonly<{
      kind: 'positions';
      startColumn: string;
      endColumn?: string;
      coordinateSystem: 'zero-based-half-open' | 'one-based-inclusive';
    }>
  | Readonly<{
      kind: 'annotation';
      identifierColumn: string;
      identifierField: 'id' | 'locus_tag' | 'ID';
    }>;

export interface SequenceLayerCsvRow {
  readonly id: string;
  readonly number: number;
  readonly cells: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

export interface SequenceLayerCsv {
  readonly columns: readonly string[];
  readonly rows: readonly SequenceLayerCsvRow[];
}

export interface SequenceLayerCsvLimits {
  readonly maxBytes?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
}

type RowIdentity = Readonly<{ rowId: string; rowNumber: number }>;
type MappingTarget = Readonly<{ start: number; end: number; annotationId?: string }>;

export type SequenceDataLayerRowOutcome = RowIdentity &
  (
    | (Readonly<{ kind: 'mapped' }> & MappingTarget)
    | Readonly<{
        kind: 'unmapped';
        code: 'missing-identifier' | 'identifier-not-found';
        message: string;
      }>
    | Readonly<{
        kind: 'ambiguous';
        identifier: string;
        candidates: readonly MappingTarget[];
        message: string;
      }>
    | Readonly<{
        kind: 'rejected';
        code: 'row-width' | 'invalid-number' | 'invalid-position' | 'duplicate-annotation';
        message: string;
      }>
  );

export interface SequenceDataLayerMappingReport {
  readonly outcomes: readonly SequenceDataLayerRowOutcome[];
  readonly counts: Readonly<{
    total: number;
    mapped: number;
    unmapped: number;
    ambiguous: number;
    rejected: number;
  }>;
}

export interface PrepareSequenceDataLayerInput {
  readonly datasetId: string;
  readonly label: string;
  readonly unit: string;
  readonly csv: string;
  readonly target: SequenceDataLayerTarget;
  readonly mapping: SequenceDataLayerMapping;
  readonly valueColumns: readonly string[];
  readonly annotations?: readonly SequenceDataLayerAnnotation[];
  readonly unresolvedPolicy: 'reject' | 'exclude';
  readonly aggregation: 'none' | 'mean';
}

export interface PrepareSequenceDataLayerResult {
  readonly dataset: GenomicMarkupDataset;
  readonly report: SequenceDataLayerMappingReport;
  readonly publishable: boolean;
  readonly annotationAggregation: 'none' | 'mean';
}

const CSV_LIMITS = { maxBytes: 4 * 1024 * 1024, maxRows: 50_000, maxColumns: 128 };
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const INTEGER = /^[+-]?\d+$/u;

export function parseSequenceLayerCsv(
  csv: string,
  limits: SequenceLayerCsvLimits = {}
): SequenceLayerCsv {
  const bounds = { ...CSV_LIMITS, ...limits };
  for (const key of ['maxBytes', 'maxRows', 'maxColumns'] as const) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] <= 0 || bounds[key] > CSV_LIMITS[key])
      throw new Error(`Invalid CSV ${key} limit.`);
  }
  if (new TextEncoder().encode(csv).byteLength > bounds.maxBytes)
    throw new Error('The CSV exceeds the supported byte limit.');
  if (csv.includes('\0')) throw new Error('The CSV contains a null character.');
  const records: string[][] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const pushField = () => {
    cells.push(field);
    if (cells.length > bounds.maxColumns) throw new Error('The CSV has too many columns.');
    field = '';
    closedQuote = false;
  };
  const pushRecord = () => {
    pushField();
    records.push(cells);
    if (records.length > bounds.maxRows + 1) throw new Error('The CSV has too many rows.');
    cells = [];
  };
  const text = csv.startsWith('\ufeff') ? csv.slice(1) : csv;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else field += character;
    } else if (character === ',') pushField();
    else if (character === '\n' || character === '\r') {
      pushRecord();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else if (character === '"' && !closedQuote && field.length === 0) quoted = true;
    else {
      if (closedQuote || character === '"') throw new Error('The CSV has an invalid quoted field.');
      field += character;
    }
  }
  if (quoted) throw new Error('The CSV has an unterminated quoted field.');
  if (field.length > 0 || closedQuote || cells.length > 0) pushRecord();
  const columns = records.shift()?.map((column) => column.trim());
  if (!columns || columns.some((column) => !column))
    throw new Error('The CSV needs nonempty column headers.');
  if (new Set(columns).size !== columns.length)
    throw new Error('CSV column headers must be unique.');
  return {
    columns,
    rows: records.map((record, index) => ({
      id: `row-${index + 1}`,
      number: index + 2,
      cells: record,
      values: Object.fromEntries(columns.map((column, offset) => [column, record[offset] ?? ''])),
    })),
  };
}

export function prepareSequenceDataLayer(
  input: PrepareSequenceDataLayerInput
): PrepareSequenceDataLayerResult {
  const { target, mapping } = input;
  requireText(input.datasetId, 'Dataset identity');
  requireText(input.label, 'Dataset label');
  requireText(input.unit, 'Measurement unit');
  requireText(target.documentId, 'Sequence identity');
  if (!/^sha256:[0-9a-f]{64}$/u.test(target.sequenceFingerprint))
    throw new Error('The target needs a normalized sequence SHA-256 fingerprint.');
  if (!Number.isSafeInteger(target.length) || target.length <= 0)
    throw new Error('The target needs a positive sequence length.');
  if (
    (mapping.kind === 'annotation' || target.annotationFingerprint !== undefined) &&
    !/^annotation-(?:mapping|document)-v1:sha256:[0-9a-f]{64}$/u.test(
      target.annotationFingerprint ?? ''
    )
  )
    throw new Error('Annotation mapping needs an annotation fingerprint.');
  if (
    !['reject', 'exclude'].includes(input.unresolvedPolicy) ||
    !['none', 'mean'].includes(input.aggregation)
  )
    throw new Error('Choose explicit unresolved-row and aggregation policies.');
  const parsed = parseSequenceLayerCsv(input.csv);
  if (
    input.valueColumns.length === 0 ||
    input.valueColumns.length > 32 ||
    new Set(input.valueColumns).size !== input.valueColumns.length
  )
    throw new Error('Choose between one and 32 unique measurement columns.');
  const requiredColumns = [
    ...input.valueColumns,
    ...(mapping.kind === 'positions'
      ? [mapping.startColumn, ...(mapping.endColumn === undefined ? [] : [mapping.endColumn])]
      : [mapping.identifierColumn]),
  ];
  for (const column of requiredColumns) {
    if (!parsed.columns.includes(column)) throw new Error(`Unknown CSV column: ${column}.`);
  }
  if (
    mapping.kind === 'positions' &&
    !['zero-based-half-open', 'one-based-inclusive'].includes(mapping.coordinateSystem)
  )
    throw new Error('Choose an explicit coordinate system.');
  const targets =
    mapping.kind === 'annotation'
      ? annotationTargets(input.annotations ?? [], mapping.identifierField, target.length)
      : new Map<string, readonly MappingTarget[]>();
  const measurements = new Map<string, readonly (number | null)[]>();
  let outcomes: SequenceDataLayerRowOutcome[] = parsed.rows.map((row) => {
    const identity = { rowId: row.id, rowNumber: row.number };
    if (row.cells.length !== parsed.columns.length)
      return {
        ...identity,
        kind: 'rejected',
        code: 'row-width',
        message: 'The row has a different number of cells from the header.',
      };
    const values: Array<number | null> = [];
    for (const column of input.valueColumns) {
      const text = row.values[column].trim();
      const value = text === '' ? null : Number(text);
      if (value !== null && (!DECIMAL.test(text) || !Number.isFinite(value)))
        return {
          ...identity,
          kind: 'rejected',
          code: 'invalid-number',
          message: `Column ${column} does not contain a finite decimal number or an empty value.`,
        };
      values.push(value);
    }
    measurements.set(row.id, values);
    if (mapping.kind === 'positions') {
      const first = row.values[mapping.startColumn].trim();
      const last = mapping.endColumn === undefined ? first : row.values[mapping.endColumn].trim();
      const start = Number(first) - (mapping.coordinateSystem === 'one-based-inclusive' ? 1 : 0);
      const end = mapping.endColumn === undefined ? start + 1 : Number(last);
      if (!INTEGER.test(first) || !INTEGER.test(last) || !validInterval(start, end, target.length))
        return {
          ...identity,
          kind: 'rejected',
          code: 'invalid-position',
          message: 'The row does not identify an integer interval within this sequence.',
        };
      return { ...identity, kind: 'mapped', start, end };
    }
    const identifier = row.values[mapping.identifierColumn];
    if (!identifier)
      return {
        ...identity,
        kind: 'unmapped',
        code: 'missing-identifier',
        message: 'The row has no annotation identifier.',
      };
    const matches = targets.get(identifier) ?? [];
    if (matches.length === 0)
      return {
        ...identity,
        kind: 'unmapped',
        code: 'identifier-not-found',
        message: `No ${mapping.identifierField} exactly matches ${identifier}.`,
      };
    if (matches.length > 1)
      return {
        ...identity,
        kind: 'ambiguous',
        identifier,
        candidates: matches,
        message: 'The identifier refers to more than one sequence interval.',
      };
    return { ...identity, kind: 'mapped', ...matches[0] };
  });
  if (input.aggregation === 'none') {
    const counts = new Map<string, number>();
    for (const row of outcomes) {
      if (row.kind === 'mapped' && row.annotationId)
        counts.set(row.annotationId, (counts.get(row.annotationId) ?? 0) + 1);
    }
    outcomes = outcomes.map((row) =>
      row.kind === 'mapped' && row.annotationId && counts.get(row.annotationId)! > 1
        ? {
            rowId: row.rowId,
            rowNumber: row.rowNumber,
            kind: 'rejected',
            code: 'duplicate-annotation',
            message:
              'Multiple measurements target this annotation; choose explicit mean aggregation or revise the dataset.',
          }
        : row
    );
  }
  const counts = { total: outcomes.length, mapped: 0, unmapped: 0, ambiguous: 0, rejected: 0 };
  for (const outcome of outcomes) counts[outcome.kind] += 1;
  return {
    dataset: {
      id: input.datasetId,
      reference: { id: target.documentId, chrom: target.documentId, length: target.length },
      unit: input.unit,
      samples: input.valueColumns.map((column, index) => ({
        id: column,
        label: column,
        observations: outcomes.flatMap((outcome): GenomicMarkupObservation[] =>
          outcome.kind === 'mapped'
            ? [
                {
                  id: outcome.rowId,
                  start: outcome.start,
                  end: outcome.end,
                  value: measurements.get(outcome.rowId)![index],
                  ...(outcome.annotationId
                    ? { annotationId: outcome.annotationId, label: outcome.annotationId }
                    : {}),
                },
              ]
            : []
        ),
      })),
    },
    report: { outcomes, counts },
    publishable:
      counts.mapped > 0 && (input.unresolvedPolicy === 'exclude' || counts.mapped === counts.total),
    annotationAggregation: input.aggregation,
  };
}

function annotationTargets(
  annotations: readonly SequenceDataLayerAnnotation[],
  field: 'id' | 'locus_tag' | 'ID',
  length: number
): ReadonlyMap<string, readonly MappingTarget[]> {
  if (!['id', 'locus_tag', 'ID'].includes(field))
    throw new Error('Choose a stable annotation identifier field.');
  const byIdentifier = new Map<string, Map<string, MappingTarget>>();
  for (const annotation of annotations) {
    requireText(annotation.id, 'Annotation identity');
    if (!validInterval(annotation.start0, annotation.end0, length))
      throw new Error('The target contains an invalid annotation interval.');
    const identifiers = field === 'id' ? [annotation.id] : (annotation.qualifiers?.[field] ?? []);
    for (const identifier of identifiers) {
      requireText(identifier, 'Annotation identifier');
      const matches = byIdentifier.get(identifier) ?? new Map<string, MappingTarget>();
      matches.set(`${annotation.start0}:${annotation.end0}`, {
        start: annotation.start0,
        end: annotation.end0,
        annotationId: identifier,
      });
      byIdentifier.set(identifier, matches);
    }
  }
  return new Map(
    [...byIdentifier].map(([identifier, matches]) => [identifier, [...matches.values()]])
  );
}

function validInterval(start: number, end: number, length: number): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start < end &&
    end <= length
  );
}

function requireText(value: string, name: string): void {
  if (!value.trim() || value.includes('\0')) throw new Error(`${name} must be nonempty text.`);
}
