import { workTaskReferenceSchema } from './work-task-reference';
import { tableDocumentReferenceSchema } from './table-document-reference';
import { molecularDocumentReferenceSchema } from './molecular-document-reference';
import { z } from 'zod';
import type { JSONContent } from '@tiptap/core';
import { tableDimensionsSchema } from './notebook-model/table/configuration';
import { tableEditorCommandSchema } from './table-editor-command';
import { notebookEntityTypeSchema, notebookInsertionSchema } from './notebook-insertion-schema';
const node: z.ZodType<JSONContent> = z.lazy(() =>
  z
    .object({
      type: z.string().min(1),
      text: z.string().optional(),
      attrs: z.record(z.unknown()).optional(),
      marks: z
        .array(z.object({ type: z.string(), attrs: z.record(z.unknown()).optional() }).strict())
        .optional(),
      content: z.array(node).optional(),
    })
    .strict()
);
const notebookOperations = {
  schema: z.object({ kind: z.literal('schema') }).strict(),
  search: z
    .object({
      kind: z.literal('search'),
      query: z.string().max(200).default(''),
      type: notebookEntityTypeSchema.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  insert: z
    .object({
      kind: z.literal('insert'),
      index: z.number().int().nonnegative(),
      source: notebookInsertionSchema,
    })
    .strict(),
  'insert-reference': z
    .object({
      kind: z.literal('insert-reference'),
      index: z.number().int().nonnegative(),
      referenceId: z.string().uuid().optional(),
      workTask: workTaskReferenceSchema.optional(),
      documentReference: molecularDocumentReferenceSchema.optional(),
      tableReference: tableDocumentReferenceSchema.optional(),
      presentation: z.enum(['embed', 'link']).optional(),
      label: z.string().min(1).max(500).optional(),
    })
    .strict(),
  list: z
    .object({
      kind: z.literal('list'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  inspect: z
    .object({
      kind: z.literal('inspect'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  create: z
    .object({
      kind: z.literal('create'),
      title: z.string().min(1).max(500),
      destinationProject: z
        .string()
        .optional()
        .describe(
          'Exact mounted project name or root; required when multiple writable projects are open.'
        ),
    })
    .strict(),
  'splice-blocks': z
    .object({
      kind: z.literal('splice-blocks'),
      index: z.number().int().min(0),
      deleteCount: z.number().int().min(0),
      blocks: z.array(node).max(100),
    })
    .strict(),
  'insert-table': z
    .object({
      kind: z.literal('insert-table'),
      index: z.number().int().nonnegative(),
      ...tableDimensionsSchema.shape,
    })
    .strict(),
  table: z
    .object({
      kind: z.literal('table'),
      tableId: z.string().min(1),
      command: tableEditorCommandSchema,
    })
    .strict(),
  rename: z.object({ kind: z.literal('rename'), title: z.string().min(1).max(500) }).strict(),
  undo: z.object({ kind: z.literal('undo') }).strict(),
  redo: z.object({ kind: z.literal('redo') }).strict(),
  save: z.object({ kind: z.literal('save') }).strict(),
  'keep-local': z
    .object({ kind: z.literal('keep-local'), expectedCanonicalFingerprint: z.string().min(1) })
    .strict(),
};
export const notebookDocumentOperationSchema = z.discriminatedUnion('kind', [
  notebookOperations['schema'],
  notebookOperations['search'],
  notebookOperations['insert'],
  notebookOperations['insert-reference'],
  notebookOperations['list'],
  notebookOperations['inspect'],
  notebookOperations['create'],
  notebookOperations['splice-blocks'],
  notebookOperations['insert-table'],
  notebookOperations['table'],
  notebookOperations['rename'],
  notebookOperations['undo'],
  notebookOperations['redo'],
  notebookOperations['save'],
  notebookOperations['keep-local'],
]);
export const notebookDocumentSchema = z
  .object({
    pageId: z.string().min(1).optional(),
    requestId: z.string().min(1).max(128).optional(),
    expectedRevision: z.string().min(1).optional(),
    operation: z.union([
      notebookDocumentOperationSchema,
      z.object({ kind: z.literal('inspect-conflict') }).strict(),
      z
        .object({
          kind: z.literal('resolve-conflict'),
          token: z.string().regex(/^[0-9a-f]{64}$/),
          choice: z.enum(['file', 'application']),
        })
        .strict(),
    ]),
  })
  .strict();
export type NotebookDocumentRequest = z.input<typeof notebookDocumentSchema>;
export type NotebookDocumentOperation = z.infer<typeof notebookDocumentOperationSchema>;
export const targetedNotebookOperationSchema = z.discriminatedUnion('kind', [
  notebookOperations['schema'],
  notebookOperations['insert'],
  notebookOperations['insert-reference'],
  notebookOperations['inspect'],
  notebookOperations['splice-blocks'],
  notebookOperations['insert-table'],
  notebookOperations['table'],
  notebookOperations['rename'],
  notebookOperations['undo'],
  notebookOperations['redo'],
  notebookOperations['save'],
  notebookOperations['keep-local'],
]);

export const notebookCreationContextSchema = z
  .object({
    targetPath: z.string().nullable().optional(),
    targetKind: z.enum(['file', 'folder']).nullable().optional(),
    parentPath: z.string().nullable().optional(),
    workspaceRoot: z.string().nullable().optional(),
    artifactFileName: z.string().nullable().optional(),
    artifactTitle: z.string().nullable().optional(),
  })
  .strict();
export const nativeNotebookCreateSchema = z
  .object({
    title: z.string().min(1).max(500),
    workspaceRoot: z.string().min(1),
    requestId: z.string().min(1).max(128),
    context: notebookCreationContextSchema.optional(),
  })
  .strict();
export type NotebookCreationContext = z.infer<typeof notebookCreationContextSchema>;
export type NativeNotebookCreateRequest = z.input<typeof nativeNotebookCreateSchema>;
export type NativeNotebookCreateResult =
  | { status: 'created'; snapshot: NotebookDocumentSnapshot }
  | {
      status: 'failed';
      code: string;
      message: string;
      stateChanged: boolean | 'unknown';
      partialEffects: readonly unknown[];
    };

export const nativeNotebookRequestSchema = z
  .object({
    documentId: z.string().min(1),
    expectedRevision: z.string().min(1).optional(),
    requestId: z.string().min(1).max(128).optional(),
    operation: z.union([
      notebookDocumentOperationSchema,
      z.object({ kind: z.literal('inspect-copy') }).strict(),
      z.object({ kind: z.literal('capture-save') }).strict(),
      z.object({ kind: z.literal('await-save'), saveCaptureId: z.string().min(1) }).strict(),
      z
        .object({
          kind: z.literal('apply-steps'),
          steps: z.array(z.unknown()).max(1000),
          baseFingerprint: z.string().min(1),
          selection: z.unknown().optional(),
          separateHistory: z.boolean().optional(),
          time: z.number().finite().nonnegative().optional(),
          addToHistory: z.boolean().optional(),
        })
        .strict(),
      z.object({ kind: z.literal('discard') }).strict(),
      z.object({ kind: z.literal('reload') }).strict(),
      z.object({ kind: z.literal('set-title'), title: z.string().min(1).max(500) }).strict(),
      z
        .object({
          kind: z.literal('table-view'),
          tableId: z.string().min(1),
          sort: z
            .object({
              column: z.number().int().min(0),
              direction: z.enum(['asc', 'desc']).nullable(),
            })
            .strict()
            .nullable(),
          filters: z.record(z.string().max(1000)),
        })
        .strict(),
      z.object({ kind: z.literal('restore-recovery') }).strict(),
      z
        .object({ kind: z.literal('retain-legacy-recovery'), baseline: z.string(), content: node })
        .strict(),
    ]),
  })
  .strict();
export type NativeNotebookRequest = z.input<typeof nativeNotebookRequestSchema>;
export interface NotebookDocumentSnapshot {
  documentId: string;
  pageId: string;
  path: string;
  workspaceRoot: string;
  title: string;
  updatedAt?: string;
  sizeBytes?: number;
  legacyBaselines?: string[];
  tableViews?: Record<
    string,
    {
      sort: import('./table-document-types').ColumnSort | null;
      filters: Record<number, string>;
    }
  >;
  revision: string;
  persistedRevision: string;
  canonicalFingerprint: string;
  version: number;
  ready: boolean;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  blockCount: number;
  blocks: Array<{
    index: number;
    block: JSONContent;
    truncated?: boolean;
    byteLength?: number;
    sha256?: string;
  }>;
  nextOffset: number | null;
  copy: { content: JSONContent; title: string };
  recovery?: { baselineMismatch: boolean; content: JSONContent };
  result?: unknown;
  reason?: string;
  publication?: import('./notebook-publication').NotebookPublicationState;
  warnings?: string[];
  saveCaptureId?: string;
  requestReceipt?: { requestId: string; appliedRevision: string; replayed: boolean };
}
export interface NotebookLegacyProjectMigrationResult {
  migrated: number;
  issues: Array<{ path: string; reason: string }>;
  gitChanged?: boolean;
  mutatedGitFiles: string[];
  expectedContentSha256: Record<string, string | null>;
}
