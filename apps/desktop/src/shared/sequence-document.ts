import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import { z } from 'zod';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import type { EditorState, EditorAction } from '@waypoint/workspace-editor/model';
import type {
  RecoveredDraftContent,
  AnnotationEditPatch,
  SequenceDraftBaseline,
} from './sequence-document-model';
import type { SequenceDocumentSaveResult } from './sequence-edit-lineage';
import { OPTIONAL_IUPAC_BASES_PATTERN } from './published-schema-patterns';

export function isSequenceViewOnlyAction(action: EditorAction): boolean {
  return [
    'SET_CURSOR',
    'MOVE_CURSOR',
    'MOVE_CURSOR_LINE',
    'SET_SELECTION',
    'EXTEND_SELECTION',
    'CLEAR_SELECTION_ANCHOR',
    'SELECT_ALL',
  ].includes(action.type);
}

const annotationSchema = z
  .object({
    name: z.string().min(1).max(1000),
    type: z.string().min(1).max(100),
    start: z.number().int().min(1),
    end: z.number().int().min(1),
    direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
    color: z
      .string()
      .regex(/^#[\da-fA-F]{6}$/)
      .default('#888888'),
    qualifiers: z.record(z.string().max(100), z.array(z.string().max(10000)).max(100)).optional(),
  })
  .strict();

export const sequenceEditOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('replace-bases'),
      start: z.number().int().min(0).describe('Zero-based start in the CURRENT working sequence.'),
      end: z.number().int().min(0).describe('Exclusive end; equal to start for insertion.'),
      bases: z.string().regex(OPTIONAL_IUPAC_BASES_PATTERN).describe('IUPAC DNA; empty to delete.'),
      expectedBases: z
        .string()
        .describe('Exact bases currently in [start,end); empty for insertion.'),
    })
    .strict(),
  z.object({ kind: z.literal('add-annotation'), annotation: annotationSchema }).strict(),
  z
    .object({
      kind: z.literal('update-annotation'),
      index: z.number().int().min(0),
      annotation: annotationSchema,
    })
    .strict(),
  z.object({ kind: z.literal('delete-annotation'), index: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('undo') }).strict(),
  z.object({ kind: z.literal('redo') }).strict(),
  z.object({ kind: z.literal('discard') }).strict(),
]);

export const sequenceDocumentInspectSchema = z
  .object({
    kind: z.literal('inspect'),
    start: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(10000).default(1000),
    annotationOffset: z.number().int().min(0).default(0),
    annotationLimit: z
      .number()
      .int()
      .min(0)
      .max(200)
      .default(50)
      .describe('Zero returns sequence and revision metadata without annotation bodies.'),
  })
  .strict();
export const sequenceDocumentOperationSchema = z.union([
  sequenceDocumentInspectSchema,
  sequenceEditOperationSchema,
  z
    .object({
      kind: z.literal('save'),
      message: z.string().min(1).max(500).default('Edit sequence'),
    })
    .strict(),
  z.object({ kind: z.literal('reload') }).strict(),
  z.object({ kind: z.literal('restore-recovery'), recoveryId: z.string().min(1) }).strict(),
]);
export const sequenceDocumentAgentRequestSchema = z
  .object({
    documentId: z.string().min(1),
    expectedVersion: z.number().int().min(0).optional(),
    requestId: z.string().min(1).max(128).optional(),
    operation: sequenceDocumentOperationSchema,
  })
  .strict();
export type SequenceDocumentAgentRequest = z.infer<typeof sequenceDocumentAgentRequestSchema>;
export type SequenceDocumentOperation = z.infer<typeof sequenceDocumentOperationSchema>;
export type SequenceDocumentCopy = {
  sequence: AnnotatedSequence;
  savedSequence: AnnotatedSequence;
  draft: EditorState;
  lineage: {
    id: string;
    baseline: SequenceDraftBaseline;
    accepted?: ScientificAcceptedDocumentRevision;
  };
  acceptedRevision?: ScientificAcceptedDocumentRevision;
  version: number;
  savedVersion: number;
};
export type SequenceDocumentClientCommand =
  | { method: 'dispatchEdit'; action: EditorAction }
  | { method: 'replaceBases'; start: number; end: number; bases: string }
  | { method: 'updateAnnotation'; index: number; patch: AnnotationEditPatch }
  | { method: 'deleteAnnotation'; index: number }
  | { method: 'addAnnotation'; annotation: Annotation }
  | { method: 'mergeAnnotations'; annotations: Annotation[] }
  | { method: 'discardEdits' }
  | {
      method: 'patchSavedMetadata';
      patch: Partial<Omit<AnnotatedSequence, 'sequence' | 'annotations' | 'length' | 'id'>>;
    }
  | { method: 'restoreRecoveredDraft'; content: RecoveredDraftContent };
export type SequenceDocumentRequest = Omit<SequenceDocumentAgentRequest, 'operation'> & {
  expectedRevision?: { revision: string; copyJson: string; bindingIdentity?: string };
  operation:
    | SequenceDocumentOperation
    | { kind: 'client-command'; command: SequenceDocumentClientCommand }
    | { kind: 'capture-save'; message: string; fromCaptureId?: string }
    | { kind: 'publish-save'; captureId: string }
    | { kind: 'refresh-metadata' };
  projection?: 'document' | 'inspection';
};
export interface SequenceDocumentSnapshot {
  bindingIdentity?: string;
  requiresManagedAnnotationStamp?: boolean;
  stampingManagedAnnotations?: boolean;
  documentId: string;
  path: string;
  workspaceRoot: string;
  revision: string;
  persistedRevision: string;
  version: number;
  savedVersion: number;
  ready: boolean;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  length: number;
  annotationCount: number;
  capabilities: readonly string[];
  bases?: { start: number; end: number; text: string };
  annotations?: Array<Annotation & { index: number }>;
  nextAnnotationOffset?: number | null;
  recoveryId?: string;
  reason?: string;
  copy?: SequenceDocumentCopy;
  captureId?: string;
  saved?: boolean;
  saveResult?: SequenceDocumentSaveResult;
  primerBindingFailure?: { message: string };
  verificationFailed?: boolean;
  history?: {
    status: 'committed' | 'unchanged' | 'failed';
    error?: string;
    historyStatus?: import('./sequence-edit-lineage').SequenceDocumentHistoryResult['status'];
    nativeActionId?: string;
  };
}
export function sequenceDocumentAgentResult(
  { copy: _copy, captureId: _captureId, ...snapshot }: SequenceDocumentSnapshot,
  operation: SequenceDocumentOperation['kind']
) {
  return {
    ...snapshot,
    nextMutationInput: snapshot.readOnly
      ? null
      : { documentId: snapshot.documentId, expectedVersion: snapshot.version },
    ...(operation === 'save'
      ? { outcome: snapshot.saved ? ('saved' as const) : ('unchanged' as const) }
      : {}),
  };
}
const nativeAnnotationSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    start: z.number().int().min(1),
    end: z.number().int().min(1),
    direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
    color: z.string().optional(),
    qualifiers: z.record(z.array(z.string())).optional(),
  })
  .passthrough();
const nativeRangeSchema = z
  .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
  .strict();
const nativePrimerBindingSchema = nativeRangeSchema
  .extend({
    primerId: z.string().min(1),
    pendingId: z.string().min(1).optional(),
    strand: z.union([z.literal(1), z.literal(-1)]),
    sourceWorkspaceRoot: z.string().optional(),
  })
  .strict();
const nativeRecoveredSequenceSchema = z
  .object({
    sequence: z.string(),
    annotations: z.array(nativeAnnotationSchema),
    insertedRanges: z.array(nativeRangeSchema),
    deletedRanges: z.array(nativeRangeSchema),
    substitutedRanges: z.array(nativeRangeSchema.extend({ original: z.string() })),
    pendingPrimerBindings: z.array(nativePrimerBindingSchema).default([]),
    draftLineageId: z.string().min(1).optional(),
  })
  .strict();
export const sequenceEditorActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SET_CURSOR'), position: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('MOVE_CURSOR'), delta: z.number().int() }).strict(),
  z
    .object({
      type: z.literal('MOVE_CURSOR_LINE'),
      delta: z.number().int(),
      charsPerLine: z.number().int().min(1),
    })
    .strict(),
  z.object({ type: z.literal('INSERT'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('INSERT_FRAGMENT'),
      fragment: z
        .object({
          sequence: z.string(),
          annotations: z.array(nativeAnnotationSchema),
          primerBindings: z.array(nativePrimerBindingSchema),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('SET_SELECTION'),
      selection: nativeRangeSchema.extend({ wraps: z.boolean().optional() }).nullable(),
    })
    .strict(),
  z.object({ type: z.literal('EXTEND_SELECTION'), position: z.number().int().min(0) }).strict(),
  z
    .object({ type: z.literal('SET_ANNOTATIONS'), annotations: z.array(nativeAnnotationSchema) })
    .strict(),
  ...(
    [
      'DELETE_BEFORE',
      'DELETE_AFTER',
      'DELETE_SELECTION',
      'CLEAR_SELECTION_ANCHOR',
      'SELECT_ALL',
      'UNDO',
      'REDO',
    ] as const
  ).map((type) => z.object({ type: z.literal(type) }).strict()),
]);
export const sequenceDocumentClientCommandSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('dispatchEdit'), action: sequenceEditorActionSchema }).strict(),
  z
    .object({
      method: z.literal('replaceBases'),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
      bases: z.string(),
    })
    .strict(),
  z
    .object({
      method: z.literal('updateAnnotation'),
      index: z.number().int().min(0),
      patch: nativeAnnotationSchema,
    })
    .strict(),
  z.object({ method: z.literal('deleteAnnotation'), index: z.number().int().min(0) }).strict(),
  z.object({ method: z.literal('addAnnotation'), annotation: nativeAnnotationSchema }).strict(),
  z
    .object({ method: z.literal('mergeAnnotations'), annotations: z.array(nativeAnnotationSchema) })
    .strict(),
  z.object({ method: z.literal('discardEdits') }).strict(),
  z
    .object({
      method: z.literal('patchSavedMetadata'),
      patch: z
        .record(z.unknown())
        .refine(
          (patch) =>
            !['sequence', 'annotations', 'length', 'id'].some((key) =>
              Object.prototype.hasOwnProperty.call(patch, key)
            ),
          'Biological content requires its typed edit command.'
        ),
    })
    .strict(),
  z
    .object({ method: z.literal('restoreRecoveredDraft'), content: nativeRecoveredSequenceSchema })
    .strict(),
]);
export const sequenceDocumentRequestSchema = sequenceDocumentAgentRequestSchema
  .extend({
    expectedRevision: z
      .object({
        revision: z.string().min(1).max(512),
        copyJson: z.string().min(1),
        bindingIdentity: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    operation: z.union([
      sequenceDocumentOperationSchema,
      z
        .object({ kind: z.literal('client-command'), command: sequenceDocumentClientCommandSchema })
        .strict(),
      z
        .object({
          kind: z.literal('capture-save'),
          message: z.string().min(1).max(500),
          fromCaptureId: z.string().uuid().optional(),
        })
        .strict(),
      z.object({ kind: z.literal('publish-save'), captureId: z.string().uuid() }).strict(),
      z.object({ kind: z.literal('refresh-metadata') }).strict(),
    ]),
    projection: z.enum(['document', 'inspection']).optional(),
  })
  .strict();
export const legacySequenceDraftSchema = z
  .object({
    documentId: z.string().min(1),
    version: z.literal(1),
    baseline: z.string().min(1),
    name: z.string(),
    content: nativeRecoveredSequenceSchema,
  })
  .strict();
export type LegacySequenceDraft = z.infer<typeof legacySequenceDraftSchema>;
export interface LegacySequenceDraftRetention {
  retained: true;
  documentId: string;
  recoveryId: string;
}
export function sequenceLegacyBaselineFingerprint(document: AnnotatedSequence): string {
  let value = 0x811c9dc5;
  const mix = (text: string) => {
    for (let index = 0; index < text.length; index++) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 0x01000193);
    }
  };
  mix(document.sequence);
  mix(JSON.stringify(document.annotations ?? []));
  return `${document.sequence.length}:${(value >>> 0).toString(16)}`;
}
