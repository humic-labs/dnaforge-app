import type { TableData } from '../../../table-document-types';

export function mergeTableDataPatch(
  existing: TableData | Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>
): TableData {
  const prev = (existing ?? {}) as TableData;
  return {
    ...prev,
    ...patch,
  } as TableData;
}
