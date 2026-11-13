import { z } from 'zod';
import { jsonObjectSchema } from '../../../shared/json-value';

const count = z.number().int().nonnegative();
const ok = { ok: z.literal(true) };
const nextMutationInput = z.object({ documentId: z.string(), expectedVersion: count });
const annotation = z.object({
  index: count, name: z.string(), type: z.string(), start: z.number(), end: z.number(),
  direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  color: z.string().optional(), label: z.string().optional(),
  qualifiers: z.record(z.string(), z.array(z.string())).optional(),
  segments: z.array(z.object({ start: z.number(), end: z.number() })).optional(),
});
export const sequenceDocumentOutputSchema = z.union([
  z.object({
    ...ok, documentId: z.string(), version: count, savedVersion: count.optional(),
    dirty: z.boolean(), canUndo: z.boolean(), canRedo: z.boolean(), length: count,
    circular: z.boolean().optional(), readOnly: z.boolean(),
    nextMutationInput: nextMutationInput.nullable(),
    bases: z.object({ start: count, end: count, text: z.string() }),
    annotations: z.array(annotation), annotationCount: count, nextAnnotationOffset: count.nullable(),
  }),
  z.object({
    ...ok, documentId: z.string(), version: count, dirty: z.boolean(),
    canUndo: z.boolean(), canRedo: z.boolean(), length: count, annotationCount: count,
    nextMutationInput,
  }),
  z.object({
    ...ok, documentId: z.string(), version: count, nextMutationInput,
    saved: z.boolean(), outcome: z.string(), dirty: z.boolean(),
    history: z.enum(['committed', 'not-a-repository', 'commit-failed']).optional(),
  }),
]);
const mutation = z.object({
  id: z.string(), position: z.number(), type: z.enum(['substitution', 'insertion', 'deletion']),
  referenceBase: z.string(), alternateBase: z.string(), length: z.number(), quality: z.number().optional(),
  effect: z.object({ featureName: z.string(), featureType: z.string(), codonPosition: z.number().optional(),
    aminoAcidChange: z.string().optional(), classification: z.enum(['synonymous', 'missense', 'nonsense',
      'readthrough', 'frameshift', 'inframe_insertion', 'inframe_deletion', 'intergenic']) }).optional(),
});
export const alignmentSessionOutputSchema = z.union([
  z.object({
    ...ok, documentId: z.string(), revision: z.string(), stale: z.boolean(),
    activeSessionId: z.string().nullable(),
    sessions: z.array(z.object({
      id: z.string(), name: z.string(), mode: z.enum(['one-per-clone', 'multi-per-clone']),
      archived: z.boolean(), operation: z.object({ id: z.string(), status: z.string() }).nullable(),
      view: z.object({ viewMode: z.enum(['single', 'stacked']), selectedTrackId: z.string().nullable(),
        alignmentVisible: z.boolean().optional(), hiddenTrackIds: z.array(z.string()).optional() }).optional(),
      tracks: z.array(z.object({ id: z.string(), label: z.string(),
        status: z.enum(['pass', 'variants', 'fail', 'incomplete']), reason: z.string().optional(),
        mutationCount: count, checkedMutations: z.array(z.string()) })), trackCount: count,
    })),
    total: count, mutations: z.array(mutation).optional(), mutationCount: count.optional(), nextOffset: count.nullable(),
  }),
  z.object({ ...ok, documentId: z.string(), revision: z.string(), saved: z.literal(true), sessionId: z.string().optional() }),
]);
const richNode: z.ZodTypeAny = z.lazy(() => z.object({
  type: z.string().optional(), text: z.string().optional(),
  attrs: jsonObjectSchema.describe('Attributes owned by the registered notebook node extension.').optional(),
  marks: z.array(z.object({ type: z.string(),
    attrs: jsonObjectSchema.describe('Attributes owned by the registered notebook mark extension.').optional() })).optional(),
  content: z.array(richNode).optional(),
}));
const cell = z.object({
  value: z.string(), type: z.enum(['text', 'number', 'formula']),
  computed: z.union([z.string(), z.number()]).optional(),
  format: z.object({ bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(), align: z.enum(['left', 'center', 'right']).optional(),
    textColor: z.string().optional(), bgColor: z.string().optional(), wrap: z.boolean().optional() }).optional(),
  reference: z.union([
    z.object({ kind: z.literal('native-entity'), entityId: z.string() }),
    z.object({ kind: z.literal('migration-destination'), destinationTargetId: z.string() }),
    z.object({ kind: z.literal('external-url'), href: z.string() }),
  ]).optional(),
  span: z.object({ rows: count, cols: count }).optional(), covered: z.boolean().optional(),
  sourceFormula: z.string().optional(), sourceRenderedValue: z.string().optional(),
  formulaCompatibility: z.enum(['supported', 'unsupported']).optional(), stale: z.boolean().optional(),
});
const pageRevision = { pageId: z.string(), revision: z.string() };
export const tableInspectionOutputSchema = z.object({
  rows: count, columns: count, name: z.string(),
  sort: z.object({ column: count, direction: z.enum(['asc', 'desc']).nullable() }).nullable(),
  filters: z.record(z.string(), z.string()), columnLabels: z.array(z.string()),
  rowOffset: count, columnOffset: count, cells: z.array(z.array(cell)), nextRowOffset: count.nullable(),
});
export const notebookDocumentOutputSchema = z.union([
  z.object({ ...ok, embeds: z.array(z.object({ type: z.string(), label: z.string(), version: count })),
    nodes: z.array(z.string()), marks: z.array(z.string()), sources: z.array(z.enum(['entity', 'file', 'table'])) }),
  z.object({ ...ok, items: z.array(z.object({ entityId: z.string(), type: z.enum(['sequence', 'page', 'primer']), name: z.string() })) }),
  z.object({ ...ok, pages: z.array(z.object({ id: z.string(), title: z.string(),
    date: z.string().nullable().optional(), createdAt: z.string(), updatedAt: z.string() })),
    total: count, nextOffset: count.nullable() }),
  z.object({ ...ok, pageId: z.string(), created: z.literal(true), saved: z.literal(true), destinationProject: z.string(),
    nextInspectionInput: z.object({ pageId: z.string(), operation: z.object({ kind: z.literal('inspect'), limit: count }) }) }),
  z.object({ ...ok, ...pageRevision, title: z.string(), dirty: z.boolean(), editable: z.boolean(),
    blocks: z.array(z.object({ index: count, block: richNode })), blockCount: count, nextOffset: count.nullable() }),
  z.object({ ...ok, ...pageRevision, tableId: z.string(), ...tableInspectionOutputSchema.shape }),
  z.object({ ...ok, ...pageRevision, tableId: z.string(), applied: z.literal(true) }),
  z.object({ ...ok, ...pageRevision, changed: z.union([z.boolean(), z.literal('unknown')]),
    dirty: z.boolean(), saved: z.boolean(), tableId: z.string().optional() }),
]);
