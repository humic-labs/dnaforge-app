import {
  boundedTableObservationCount,
  type TableOperation,
  type TableOperationObservation,
  type TableSurface,
  type TableCalculationObservation,
} from '../../../table-notebook-observation';
import type { Cell } from '../../../table-document-types';

export function tableOperationObservation(
  operation: TableOperation,
  surface: TableSurface | undefined,
  cells: Cell[][],
  calculation: TableCalculationObservation
): TableOperationObservation | undefined {
  if (!surface) return undefined;
  try {
    return {
      version: 1,
      operation,
      surface,
      rows: boundedTableObservationCount(cells.length),
      columns: boundedTableObservationCount(cells[0]?.length ?? 0),
      calculation: { ...calculation },
    };
  } catch {
    return undefined;
  }
}
