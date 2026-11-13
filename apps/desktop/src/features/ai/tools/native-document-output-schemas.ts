import { z } from 'zod';
import { jsonObjectSchema, type JsonValue } from '../../../shared/json-value';
import {
  sequenceDocumentOutputSchema as legacySequenceOutputSchema,
  notebookDocumentOutputSchema as legacyNotebookOutputSchema,
  tableInspectionOutputSchema,
} from './document-edit-output-schemas';
import { fileDocumentOutputSchema as legacyFileOutputSchema } from './workspace-edit-output-schemas';

const count = z.number().int().nonnegative();
const ok = { ok: z.literal(true) };
const nativeKind = z.enum([
  'text',
  'csv',
  'tsv',
  'sequence',
  'notebook',
  'design',
  'protein',
  'primer',
  'protocol',
  'scientific',
  'binary',
  'unsupported',
]);
const sort = z.object({ column: count, direction: z.enum(['asc', 'desc']).nullable() }).nullable();
const annotation = z.object({
  index: count,
  name: z.string(),
  type: z.string(),
  start: z.number(),
  end: z.number(),
  direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  color: z.string().optional(),
  label: z.string().optional(),
  qualifiers: z.record(z.array(z.string())).optional(),
  segments: z.array(z.object({ start: z.number(), end: z.number() })).optional(),
});
const acceptedSave = z
  .object({
    kind: z.literal('accepted-object'),
    contentSha256: z.string().min(1),
    resourceId: z.string().min(1),
    resourceRevisionId: z.string().min(1),
    workspaceVersionId: z.string().min(1),
    sequenceEditParentEventId: z.string().nullable(),
    operationId: z.string().min(1),
  })
  .strict();
const writeReceipt = z
  .object({
    nativeActionId: z.string().min(1),
    revisionId: z.string().nullable(),
    contentSha256: z.string().min(1),
    wrote: z.boolean(),
    accepted: acceptedSave.optional(),
    primerPublicationIds: z.array(z.string().min(1)).optional(),
  })
  .strict();
const saveResult = z.union([
  z.object({ status: z.literal('unbound') }).strict(),
  z
    .object({
      status: z.literal('saved'),
      eventId: z.string().nullable(),
      lineage: z.enum(['recorded', 'unavailable']),
      managedAnnotationIds: z.array(z.string()).optional(),
      fileSha256: z.string().min(1).optional(),
      publicationPaths: z.array(z.string().min(1)).optional(),
      accepted: acceptedSave.optional(),
      writeReceipt: writeReceipt.optional(),
    })
    .strict(),
]);
export const nativeSequenceSnapshotOutputSchema = z
  .object({
    documentId: z.string(),
    path: z.string(),
    workspaceRoot: z.string(),
    bindingIdentity: z.string().min(1).optional(),
    revision: z.string(),
    persistedRevision: z.string(),
    version: count,
    savedVersion: count,
    ready: z.boolean(),
    readOnly: z.boolean(),
    dirty: z.boolean(),
    saving: z.boolean(),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    length: count,
    annotationCount: count,
    capabilities: z.array(z.string()),
    requiresManagedAnnotationStamp: z.boolean().optional(),
    stampingManagedAnnotations: z.boolean().optional(),
    bases: z.object({ start: count, end: count, text: z.string() }).optional(),
    annotations: z.array(annotation).optional(),
    nextAnnotationOffset: count.nullable().optional(),
    recoveryId: z.string().optional(),
    reason: z.string().optional(),
    saved: z.boolean().optional(),
    saveResult: saveResult.optional(),
    history: z
      .object({
        status: z.enum(['committed', 'unchanged', 'failed']),
        error: z.string().optional(),
        historyStatus: z
          .enum([
            'committed',
            'already-committed',
            'not-a-repository',
            'revision-changed',
            'unavailable',
            'failed',
          ])
          .optional(),
        nativeActionId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const nativeSequenceDocumentOutputSchema = z.union([
  nativeSequenceSnapshotOutputSchema
    .extend({
      ...ok,
      nextMutationInput: z
        .object({ documentId: z.string(), expectedVersion: count })
        .nullable()
        .optional(),
      outcome: z.enum(['saved', 'unchanged']).optional(),
    })
    .strict(),
  legacySequenceOutputSchema.options[0].strict(),
  legacySequenceOutputSchema.options[1].strict(),
  legacySequenceOutputSchema.options[2].strict(),
]);

interface RichNode {
  type?: string;
  text?: string;
  attrs?: Record<string, JsonValue>;
  marks?: Array<{ type: string; attrs?: Record<string, JsonValue> }>;
  content?: RichNode[];
}
const richNode: z.ZodType<RichNode> = z.lazy(() =>
  z.object({
    type: z.string().optional(),
    text: z.string().optional(),
    attrs: jsonObjectSchema.optional(),
    marks: z.array(z.object({ type: z.string(), attrs: jsonObjectSchema.optional() })).optional(),
    content: z.array(richNode).optional(),
  })
);
const notebookResult = z.union([
  z
    .object({
      changed: z.union([z.boolean(), z.literal('unknown')]),
      tableId: z.string().optional(),
    })
    .strict(),
  tableInspectionOutputSchema.strict(),
  z.object({ applied: z.literal(true) }).strict(),
  z.object({ nodes: z.array(z.string()), marks: z.array(z.string()) }).strict(),
]);
export const nativeNotebookSnapshotOutputSchema = z
  .object({
    documentId: z.string(),
    pageId: z.string(),
    path: z.string(),
    workspaceRoot: z.string(),
    title: z.string(),
    updatedAt: z.string().optional(),
    sizeBytes: count.optional(),
    legacyBaselines: z.array(z.string()).optional(),
    tableViews: z.record(z.object({ sort, filters: z.record(z.string()) })).optional(),
    revision: z.string(),
    persistedRevision: z.string(),
    canonicalFingerprint: z.string(),
    version: count,
    ready: z.boolean(),
    readOnly: z.boolean(),
    dirty: z.boolean(),
    saving: z.boolean(),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    blockCount: count,
    blocks: z
      .array(
        z.object({
          index: count,
          block: richNode,
          truncated: z.boolean().optional(),
          byteLength: count.optional(),
          sha256: z.string().optional(),
        })
      )
      .optional(),
    nextOffset: count.nullable().optional(),
    recovery: z.object({ baselineMismatch: z.boolean() }).strict().optional(),
    result: notebookResult.optional(),
    reason: z.string().optional(),
    publication: z.union([z.object({ status: z.literal('settled'), canonicalFingerprint: z.string(), projectionFingerprint: z.string() }).strict(), z.object({ status: z.enum(['pending', 'conflict']), canonicalFingerprint: z.string(), reason: z.string() }).strict()]).optional(),
    warnings: z.array(z.string()).optional(),
    requestReceipt: z
      .object({ requestId: z.string(), appliedRevision: z.string(), replayed: z.boolean() })
      .optional(),
  })
  .strict();
const notebookPublic = nativeNotebookSnapshotOutputSchema
  .omit({ legacyBaselines: true, tableViews: true })
  .extend({
    ...ok,
    editable: z.boolean(),
    created: z.literal(true).optional(),
    saved: z.boolean().optional(),
    nextInspectionInput: z
      .object({
        pageId: z.string(),
        operation: z.object({ kind: z.literal('inspect'), limit: count }),
      })
      .optional(),
    tableId: z.string().optional(),
    changed: z.union([z.boolean(), z.literal('unknown')]).optional(),
    applied: z.literal(true).optional(),
    nodes: z.array(z.string()).optional(),
    marks: z.array(z.string()).optional(),
    ...tableInspectionOutputSchema.partial().shape,
  })
  .strict();
export const nativeNotebookDocumentOutputSchema = z.union([
  z.object({ ...ok, conflict: z.object({ documentId: z.string(), title: z.string(), token: z.string(), fileText: z.string(), applicationText: z.string(), previewsTruncated: z.boolean(), fileFingerprint: z.string(), applicationFingerprint: z.string(), baseFingerprint: z.string().nullable() }).strict() }).strict(),
  z.object({ ...ok, resolved: z.literal(true), documentId: z.string(), choice: z.enum(['file', 'application']), retainedPath: z.string(), publication: z.unknown() }).strict(),
  notebookPublic,
  z
    .object({
      ...ok,
      nodes: z.array(z.string()),
      marks: z.array(z.string()),
      sources: z.array(z.enum(['entity', 'file', 'table'])),
    })
    .strict(),
  legacyNotebookOutputSchema.options[0].strict(),
  legacyNotebookOutputSchema.options[1].strict(),
  legacyNotebookOutputSchema.options[2].strict(),
  legacyNotebookOutputSchema.options[3].strict(),
  legacyNotebookOutputSchema.options[4].strict(),
  legacyNotebookOutputSchema.options[5].strict(),
  legacyNotebookOutputSchema.options[6].strict(),
  legacyNotebookOutputSchema.options[7].strict(),
]);

const capability = z.object({
  availability: z.enum(['native', 'editing-client', 'read-only', 'unsupported']),
  commands: z.array(z.string()),
  reason: z.string().optional(),
});
const lifecycle = z.object({
  inspect: capability,
  edit: capability,
  history: capability,
  save: capability,
  recovery: capability,
});
const fileBase = z
  .object({
    ...ok,
    documentId: z.string(),
    path: z.string(),
    type: nativeKind,
    kind: nativeKind.optional(),
    workspaceRoot: z.string().optional(),
    owner: z
      .object({ kind: nativeKind, runtime: z.enum(['native', 'editing-client', 'unsupported']) })
      .optional(),
    lifecycle: lifecycle.optional(),
    revision: z.string(),
    persistedRevision: z.string(),
    ready: z.boolean(),
    readOnly: z.boolean(),
    dirty: z.boolean(),
    saving: z.boolean(),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    capabilities: z.array(z.string()),
    recoveryId: z.string().optional(),
    reason: z.string().optional(),
    text: z.string().optional(),
    length: count.optional(),
    nextOffset: count.nullable().optional(),
    table: z
      .union([
        tableInspectionOutputSchema.strict(),
        z
          .object({
            rows: count,
            columns: count,
            rowOffset: count,
            columnOffset: count,
            cells: tableInspectionOutputSchema.shape.cells.length(0),
            requiresSmallerWindow: z.literal(true),
          })
          .strict(),
      ])
      .optional(),
    applied: z.literal(true).optional(),
    saved: z.boolean().optional(),
  })
  .strict();
const dirtyDocument = z
  .object({
    documentId: z.string(),
    target: z.union([
      z.object({ documentId: z.string() }).strict(),
      z.object({ path: z.string(), workspaceRoot: z.string().optional() }).strict(),
    ]),
    path: z.string(),
    workspaceRoot: z.string(),
    kind: nativeKind,
    revision: z.string().optional(),
    readOnly: z.boolean(),
    dirty: z.boolean(),
    saving: z.boolean(),
    recovery: z.boolean(),
    inspectionRequired: z.boolean(),
  })
  .strict();
export const nativeFileDocumentOutputSchema = z.union([
  z
    .object({ ...ok, documents: z.array(dirtyDocument), nextCursor: z.string().nullable() })
    .strict(),
  fileBase.extend({ type: z.enum(['text', 'csv', 'tsv']) }).strict(),
  fileBase
    .omit({ text: true, length: true, nextOffset: true, table: true })
    .extend({
      type: z.enum([
        'design',
        'protein',
        'primer',
        'protocol',
        'scientific',
        'binary',
        'unsupported',
      ]),
    })
    .strict(),
  nativeSequenceSnapshotOutputSchema
    .merge(fileBase)
    .extend({ type: z.literal('sequence'), sequence: nativeSequenceSnapshotOutputSchema })
    .strict(),
  fileBase
    .extend({ type: z.literal('notebook'), notebook: nativeNotebookSnapshotOutputSchema })
    .strict(),
  legacyFileOutputSchema.strict(),
]);
