import type { JSONContent } from '@tiptap/core';
import { z } from 'zod';
import { TABLE_NOTEBOOK_BLOCK } from '../../table-notebook-contract';
import type { TableData } from '../../table-document-types';

export const TABLE_INITIAL_DIMENSIONS = {
  rows: { min: 1, max: 100, default: 5 },
  columns: { min: 1, max: 20, default: 5 },
} as const;

export const tableDimensionsSchema = z
  .object({
    rows: z
      .number()
      .int()
      .min(TABLE_INITIAL_DIMENSIONS.rows.min)
      .max(TABLE_INITIAL_DIMENSIONS.rows.max),
    columns: z
      .number()
      .int()
      .min(TABLE_INITIAL_DIMENSIONS.columns.min)
      .max(TABLE_INITIAL_DIMENSIONS.columns.max),
  })
  .strict();

export function configureTableData(
  data: TableData,
  dimensions: z.infer<typeof tableDimensionsSchema>
): TableData {
  const { rows, columns } = tableDimensionsSchema.parse(dimensions);

  return { ...data, rows, cols: columns, cells: [] };
}

export function createConfiguredTableBlock(
  tableId: string | undefined,
  dimensions: z.infer<typeof tableDimensionsSchema>
): JSONContent & { attrs: { refId: string; data: TableData } } {
  return createTableBlock(tableId, configureTableData({}, dimensions));
}

export function createTableBlock(
  tableId: string | undefined,
  data: TableData
): JSONContent & { attrs: { refId: string; data: TableData } } {
  const parsed = TABLE_NOTEBOOK_BLOCK.parseData(data);
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    type: 'embed',
    attrs: {
      type: TABLE_NOTEBOOK_BLOCK.type,
      version: TABLE_NOTEBOOK_BLOCK.currentVersion,
      refId: tableId ?? crypto.randomUUID(),
      data,
    },
  };
}
