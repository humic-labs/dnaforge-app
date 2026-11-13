import { z } from 'zod';
const index = z.number().int().min(0);
const range = z.object({ startRow: index, endRow: index, startCol: index, endCol: index }).strict();
export const tableValueCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inspect'),
      rowOffset: index.default(0),
      rowLimit: z.number().int().min(1).max(50).default(20),
      columnOffset: index.default(0),
      columnLimit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set-cell'),
      row: index,
      column: index,
      value: z.string().max(10000),
    })
    .strict(),
  z.object({ kind: z.literal('add-row') }).strict(),
  z.object({ kind: z.literal('remove-row'), index }).strict(),
  z.object({ kind: z.literal('add-column') }).strict(),
  z.object({ kind: z.literal('remove-column'), index }).strict(),
  z
    .object({ kind: z.literal('set-column-label'), column: index, label: z.string().max(1000) })
    .strict(),
  z.object({ kind: z.literal('clear-cells'), range }).strict(),
  z.object({ kind: z.literal('undo') }).strict(),
  z.object({ kind: z.literal('redo') }).strict(),
]);
export const tableEditorCommandSchema = z.discriminatedUnion('kind', [
  ...tableValueCommandSchema.options,
  z
    .object({
      kind: z.literal('set-column-width'),
      column: index,
      width: z.number().min(20).max(5000),
    })
    .strict(),
  z
    .object({ kind: z.literal('set-row-height'), row: index, height: z.number().min(16).max(5000) })
    .strict(),
  z.object({ kind: z.literal('rename'), name: z.string().trim().min(1).max(200) }).strict(),
  z
    .object({
      kind: z.literal('sort'),
      column: index,
      direction: z.enum(['asc', 'desc']).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('filter'), column: index, value: z.string().max(1000) }).strict(),
  z.object({ kind: z.literal('clear-filters') }).strict(),
  z
    .object({
      kind: z.literal('format-cells'),
      range,
      format: z
        .object({
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          underline: z.boolean().optional(),
          strikethrough: z.boolean().optional(),
          wrap: z.boolean().optional(),
          align: z.enum(['left', 'center', 'right']).optional(),
          textColor: z.string().max(100).optional(),
          bgColor: z.string().max(100).optional(),
        })
        .strict(),
    })
    .strict(),
]);
