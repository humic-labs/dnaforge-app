import { z } from 'zod';
import type { TableData } from './table-document-types';
import {
  sequenceDocumentOperationSchema,
  type SequenceDocumentSnapshot,
} from './sequence-document';
import type { NativeDocumentKind, DocumentLifecycleCapabilities } from './document-lifecycle';
import {
  targetedNotebookOperationSchema,
  type NotebookDocumentSnapshot,
} from './notebook-document';

const index = z.number().int().min(0);
const range = z.object({ startRow: index, endRow: index, startCol: index, endCol: index }).strict();
export const fileDocumentInspectSchema = z
  .object({
    kind: z.literal('inspect'),
    offset: index.default(0),
    limit: z.number().int().min(1).max(20000).default(2000),
    rowOffset: index.default(0),
    rowLimit: z.number().int().min(1).max(50).default(20),
    columnOffset: index.default(0),
    columnLimit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const fileDocumentTableCommandSchema = z.discriminatedUnion('kind', [
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
export const fileDocumentOperationSchema = z.discriminatedUnion('kind', [
  fileDocumentInspectSchema,
  z
    .object({
      kind: z.literal('replace-string'),
      oldText: z
        .string()
        .min(1)
        .max(100000)
        .describe(
          'Exact text copied from inspect.text. Must match exactly once; include surrounding text if needed.'
        ),
      newText: z
        .string()
        .max(100000)
        .describe('Replacement text. Use this operation instead of counting character positions.'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('replace-text'),
      from: index.describe(
        'Zero-based start position in inspect.text, measured in UTF-16 code units, including any BOM.'
      ),
      to: index.describe(
        'Exclusive end position in the same inspect.text string; at most its inspected length.'
      ),
      text: z.string().max(100000),
    })
    .strict(),
  z.object({ kind: z.literal('table'), command: fileDocumentTableCommandSchema }).strict(),
  z.object({ kind: z.literal('sequence'), command: sequenceDocumentOperationSchema }).strict(),
  z.object({ kind: z.literal('notebook'), command: targetedNotebookOperationSchema }).strict(),
  z.object({ kind: z.literal('undo') }).strict(),
  z.object({ kind: z.literal('redo') }).strict(),
  z.object({ kind: z.literal('save') }).strict(),
  z.object({ kind: z.literal('reload') }).strict(),
  z.object({ kind: z.literal('discard') }).strict(),
  z.object({ kind: z.literal('restore-recovery'), recoveryId: z.string().min(1) }).strict(),
]);
export type FileDocumentOperation = z.infer<typeof fileDocumentOperationSchema>;
export type FileDocumentInspection = {
  documentId: string;
  path: string;
  type: NativeDocumentKind;
  kind?: NativeDocumentKind;
  workspaceRoot?: string;
  owner?: { kind: NativeDocumentKind; runtime: 'native' | 'editing-client' | 'unsupported' };
  lifecycle?: DocumentLifecycleCapabilities;
  sequence?: Omit<SequenceDocumentSnapshot, 'copy'>;
  notebook?: Omit<NotebookDocumentSnapshot, 'copy' | 'recovery'> & {
    recovery?: { baselineMismatch: boolean };
  };
  revision: string;
  persistedRevision: string;
  ready: boolean;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  capabilities: readonly string[];
  text?: string;
  length?: number;
  nextOffset?: number | null;
  table?: Record<string, unknown>;
  recoveryId?: string;
  reason?: string;
};
export const fileDocumentTargetSchema = z.union([
  z.object({ path: z.string().min(1), workspaceRoot: z.string().min(1).optional() }).strict(),
  z.object({ documentId: z.string().min(1) }).strict(),
]);
export const fileDocumentTargetedAgentRequestSchema = z
  .object({
    target: fileDocumentTargetSchema,
    operation: fileDocumentOperationSchema,
    expectedRevision: z.string().min(1).optional(),
    requestId: z.string().min(1).max(128).optional(),
  })
  .strict();
export const fileDocumentDirtyListRequestSchema = z
  .object({
    project: z.string().min(1).optional(),
    operation: z
      .object({
        kind: z.literal('list-dirty'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().min(1).max(2048).optional(),
      })
      .strict(),
  })
  .strict();
export const fileDocumentAgentRequestSchema = z.union([
  fileDocumentTargetedAgentRequestSchema,
  fileDocumentDirtyListRequestSchema,
]);
export type FileDocumentDirtyListRequest = z.infer<typeof fileDocumentDirtyListRequestSchema>;
export type FileDocumentAgentRequest = z.infer<typeof fileDocumentAgentRequestSchema>;
export function isFileDocumentDirtyListRequest(input: {
  operation: { kind: string };
}): input is FileDocumentDirtyListRequest {
  return input.operation.kind === 'list-dirty';
}
const fileDocumentTargetedToolRequestSchema = fileDocumentTargetedAgentRequestSchema
  .partial({ target: true })
  .extend({ tabId: z.string().min(1).optional() })
  .strict()
  .refine(
    (input) => Boolean(input.target) !== Boolean(input.tabId),
    'Choose one stable file target or the legacy tab locator.'
  );
const fileDocumentToolRequestVariants = z.union([
  fileDocumentTargetedToolRequestSchema,
  fileDocumentDirtyListRequestSchema,
]);
export const fileDocumentToolRequestSchema = fileDocumentTargetedToolRequestSchema
  .innerType()
  .extend({
    project: fileDocumentDirtyListRequestSchema.shape.project,
    operation: z.union([
      fileDocumentOperationSchema,
      fileDocumentDirtyListRequestSchema.shape.operation,
    ]),
  })
  .transform((input, context) => {
    const result = fileDocumentToolRequestVariants.safeParse(input);
    if (result.success) return result.data;
    for (const issue of result.error.issues) context.addIssue(issue);
    return z.NEVER;
  });

export type FileDocumentTarget = { path: string; workspaceRoot?: string } | { documentId: string };
export type FileDocumentTextChange = { from: number; to: number; text: string };
export type FileDocumentClientOperation =
  | FileDocumentOperation
  | { kind: 'capture-save' }
  | { kind: 'await-save'; saveCaptureId: string }
  | {
      kind: 'text-transaction';
      changes: FileDocumentTextChange[];
      selection?: { anchor: number; head: number };
      userEvent?: string;
    }
  | { kind: 'replace-table'; data: TableData; firstRowAsHeader: boolean }
  | {
      kind: 'table-view';
      sort: { column: number; direction: 'asc' | 'desc' | null } | null;
      filters: Record<number, string>;
    }
  | { kind: 'reload' };
export interface FileDocumentRequest {
  target: FileDocumentTarget;
  operation: FileDocumentClientOperation;
  expectedRevision?: string;
  requestId?: string;
  projection?: 'document' | 'inspection';
  ordinaryOnly?: boolean;
}
export interface FileDocumentSnapshot extends FileDocumentInspection {
  saveCaptureId?: string;
  content: string | null;
  persistedContent: string | null;
  diskContent: string | null;
  tableData?: TableData;
  firstRowAsHeader?: boolean;
  headerRowValues?: string[];
}
export const fileDocumentRequestSchema = z
  .object({
    target: fileDocumentTargetSchema,
    operation: z.union([
      fileDocumentOperationSchema,
      z.object({ kind: z.literal('capture-save') }).strict(),
      z
        .object({ kind: z.literal('await-save'), saveCaptureId: z.string().min(1).max(128) })
        .strict(),
      z
        .object({
          kind: z.literal('text-transaction'),
          changes: z
            .array(
              z.object({ from: index, to: index, text: z.string().max(2 * 1024 * 1024) }).strict()
            )
            .max(10000),
          selection: z.object({ anchor: index, head: index }).strict().optional(),
          userEvent: z.string().max(100).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('replace-table'),
          data: z.record(z.unknown()),
          firstRowAsHeader: z.boolean(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('table-view'),
          sort: z
            .object({ column: index, direction: z.enum(['asc', 'desc']).nullable() })
            .strict()
            .nullable(),
          filters: z.record(z.string().max(1000)),
        })
        .strict(),
      z.object({ kind: z.literal('reload') }).strict(),
    ]),
    expectedRevision: z.string().min(1).optional(),
    requestId: z.string().min(1).max(128).optional(),
    projection: z.enum(['document', 'inspection']).optional(),
    ordinaryOnly: z.boolean().optional(),
  })
  .strict();
