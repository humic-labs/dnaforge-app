import type { OptionalTelemetryOrigin } from './analytics-types';
export const TABLE_OPERATIONS = [
  'configure',
  'edit',
  'paste',
  'fill',
  'structure',
  'replace',
  'undo',
  'redo',
  'format',
  'metadata',
] as const;
export const TABLE_SURFACES = ['inline', 'expanded'] as const;
export const TABLE_CALCULATION_RESULTS = [
  'none',
  'evaluated',
  'failed',
  'saved',
  'saved_stale',
  'unavailable',
  'mixed',
  'mixed_failed',
] as const;
export const MAX_TABLE_OBSERVATION_COUNT = 1_000_000;
export type TableOperation = (typeof TABLE_OPERATIONS)[number];
export type TableSurface = (typeof TABLE_SURFACES)[number];
export interface TableCalculationObservation {
  result: (typeof TABLE_CALCULATION_RESULTS)[number];
  evaluatedCount: number;
  errorCount: number;
  savedCount: number;
  staleCount: number;
  unavailableCount: number;
}
export interface TableOperationObservation {
  version: 1;
  operation: TableOperation;
  surface: TableSurface;
  rows: number;
  columns: number;
  calculation: TableCalculationObservation;
}

export function boundedTableObservationCount(value: number): number {
  return Math.min(MAX_TABLE_OBSERVATION_COUNT, Math.max(0, Math.floor(value)));
}

export function isTableOperationObservation(value: unknown): value is TableOperationObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ['version', 'operation', 'surface', 'rows', 'columns', 'calculation'];
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_TABLE_OBSERVATION_COUNT;
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    row.version !== 1 ||
    !TABLE_OPERATIONS.some((operation) => operation === row.operation) ||
    !TABLE_SURFACES.some((surface) => surface === row.surface) ||
    !count(row.rows) ||
    !count(row.columns) ||
    !row.calculation ||
    typeof row.calculation !== 'object' ||
    Array.isArray(row.calculation)
  )
    return false;
  const calculation = row.calculation as Record<string, unknown>;
  const calculationKeys = [
    'result',
    'evaluatedCount',
    'errorCount',
    'savedCount',
    'staleCount',
    'unavailableCount',
  ];
  if (
    Object.keys(calculation).length !== calculationKeys.length ||
    Object.keys(calculation).some((key) => !calculationKeys.includes(key)) ||
    !TABLE_CALCULATION_RESULTS.some((result) => result === calculation.result) ||
    !['evaluatedCount', 'errorCount', 'savedCount', 'staleCount', 'unavailableCount'].every((key) =>
      count(calculation[key])
    ) ||
    (calculation.errorCount as number) > (calculation.evaluatedCount as number) ||
    (calculation.staleCount as number) > (calculation.savedCount as number)
  )
    return false;
  const expected =
    (calculation.errorCount as number) > 0
      ? (calculation.savedCount as number) > 0 || (calculation.unavailableCount as number) > 0
        ? 'mixed_failed'
        : 'failed'
      : (calculation.unavailableCount as number) > 0
        ? 'unavailable'
        : calculation.evaluatedCount === 0
          ? calculation.savedCount === 0
            ? 'none'
            : calculation.staleCount === 0
              ? 'saved'
              : 'saved_stale'
          : calculation.savedCount === 0
            ? calculation.errorCount === 0
              ? 'evaluated'
              : 'failed'
            : calculation.errorCount === 0
              ? 'mixed'
              : 'mixed_failed';
  return calculation.result === expected;
}

export function tableObservationProperties(
  observation: TableOperationObservation
): Record<string, string | number> {
  if (!isTableOperationObservation(observation)) return {};
  return {
    table_operation: observation.operation,
    table_surface: observation.surface,
    table_calculation_result: observation.calculation.result,
    table_rows: observation.rows,
    table_columns: observation.columns,
    table_formula_count: observation.calculation.evaluatedCount,
    table_calculation_error_count: observation.calculation.errorCount,
    table_saved_result_count: observation.calculation.savedCount,
    table_stale_result_count: observation.calculation.staleCount,
    table_saved_result_unavailable_count: observation.calculation.unavailableCount,
  };
}
export const TABLE_NOTEBOOK_RECEIPT_PREFIX = 'table_notebook_reopen_v1:';
export type TableNotebookReceiptMutation =
  | {
      kind: 'write';
      key: string;
      expectedValue: string | null;
      value: string;
      updatedAtMs: number;
      origin: OptionalTelemetryOrigin;
    }
  | {
      kind: 'retire';
      key: string;
      expectedValue: string;
    };
