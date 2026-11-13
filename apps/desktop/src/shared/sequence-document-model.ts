import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import type { SequenceDocumentSaveInput } from './sequence-edit-lineage';
const saveCaptureTimes = new WeakMap<AnnotatedSequence, string>();
function saveCaptureTime(sequence: AnnotatedSequence): string {
  let captured = saveCaptureTimes.get(sequence);
  if (!captured) {
    captured = new Date().toISOString();
    saveCaptureTimes.set(sequence, captured);
  }
  return captured;
}
import { createStore } from 'zustand/vanilla';
import {
  MANAGED_GENBANK_ANNOTATION_ID_QUALIFIER,
  nucleicAcidOf,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import {
  adjustAnnotationsForDelete,
  cleanSequenceFromEditorState,
  createInitialState,
  editorReducer,
  hasUncommittedSequenceEdits,
  type EditorAction,
  type DeletedRange,
  type EditorPendingPrimerBinding,
  type EditorPastePrimerBinding,
  type EditorState,
  type InsertedRange,
  type SubstitutedRange,
} from '@waypoint/workspace-editor/model';
import { withRevision } from './store-revision';
import { looksLikeWorkspacePath } from './resolve-entity-path';
export function assertSequenceDocumentId(documentId: string): void {
  if (!documentId.trim() || looksLikeWorkspacePath(documentId)) {
    throw new Error('Sequence state requires a stable document ID, never a filesystem path.');
  }
}
export interface SequenceDraftBaseline {
  sequence: string;
  length: number;
  circular: boolean;
}
interface SequenceDraftLineage {
  id: string;
  baseline: SequenceDraftBaseline;
  accepted?: ScientificAcceptedDocumentRevision;
}
export interface SequenceSaveCapture {
  revision: number;

  sequence: AnnotatedSequence;

  pendingPrimerBindings: EditorPendingPrimerBinding[];

  draftBaseline: SequenceDraftBaseline;

  draftSequence: string;

  insertedRanges: InsertedRange[];
  deletedRanges: DeletedRange[];
  substitutedRanges: SubstitutedRange[];

  draftLineageId: string;
  accepted?: SequenceDocumentSaveInput['accepted'];
}
export interface AnnotationEditPatch {
  name: string;
  type: string;
  direction: 1 | -1 | 0;
  color: string;
  start: number;
  end: number;
  qualifiers?: Record<string, string[]>;
}
export interface SequenceState {
  sequences: Record<string, AnnotatedSequence>;

  savedSequences: Record<string, AnnotatedSequence>;

  drafts: Record<string, EditorState>;

  draftLineages: Record<string, SequenceDraftLineage>;
  acceptedRevisions: Record<string, ScientificAcceptedDocumentRevision>;

  loadingDocumentIds: Set<string>;

  scrollPositions: Record<string, number>;

  sequenceVersions: Record<string, number>;

  savedVersions: Record<string, number>;

  dirtyPaths: Record<string, boolean>;

  revision: number;
}
export interface SequenceActions {
  setSequence: (
    documentId: string,
    data: AnnotatedSequence,
    accepted?: ScientificAcceptedDocumentRevision
  ) => void;

  acknowledgeMetadata: (
    documentId: string,
    expectedSaved: AnnotatedSequence,
    published: AnnotatedSequence,
    accepted?: ScientificAcceptedDocumentRevision
  ) => void;

  hasSequence: (documentId: string) => boolean;

  getSequence: (documentId: string) => AnnotatedSequence | null;

  isLoading: (documentId: string) => boolean;

  setLoading: (documentId: string, loading: boolean) => void;

  clearSequence: (documentId: string) => void;

  clearAll: () => void;

  setScrollPosition: (documentId: string, position: number) => void;

  getScrollPosition: (documentId: string) => number | null;

  clearScrollPosition: (documentId: string) => void;

  getVersion: (documentId: string) => number;

  dispatchEdit: (documentId: string, action: EditorAction) => void;

  replaceBases: (documentId: string, start: number, end: number, bases: string) => void;

  updateAnnotation: (documentId: string, index: number, patch: AnnotationEditPatch) => void;

  deleteAnnotation: (documentId: string, index: number) => void;

  addAnnotation: (documentId: string, annotation: Annotation) => void;

  mergeAnnotations: (documentId: string, annotations: Annotation[]) => void;

  hasPendingSequenceEdits: (documentId: string) => boolean;

  captureForSave: (documentId: string) => SequenceSaveCapture | null;

  acknowledgeSaved: (
    documentId: string,
    capture: SequenceSaveCapture,
    managedAnnotationIds?: string[],
    accepted?: ScientificAcceptedDocumentRevision
  ) => { settled: boolean };

  discardEdits: (documentId: string) => AnnotatedSequence | null;

  patchSavedMetadata: (
    documentId: string,
    patch: Partial<Omit<AnnotatedSequence, 'sequence' | 'annotations' | 'length' | 'id'>>
  ) => void;

  markClean: (documentId: string) => void;

  isDirty: (documentId: string) => boolean;

  restoreRecoveredDraft: (documentId: string, content: RecoveredDraftContent) => boolean;
}
export type RecoveredDraftContent = Pick<
  EditorState,
  'sequence' | 'annotations' | 'insertedRanges' | 'deletedRanges' | 'substitutedRanges'
> & {
  pendingPrimerBindings?: EditorPastePrimerBinding[];
  draftLineageId?: string;
};
export type SequenceStore = SequenceState & SequenceActions;
const LIFECYCLE_ACTIONS = new Set<EditorAction['type']>([
  'RESET',
  'COMMIT',
  'DISCARD',
  'MARK_SAVED',
]);
function draftContentChanged(prev: EditorState, next: EditorState): boolean {
  return (
    prev.sequence !== next.sequence ||
    prev.annotations !== next.annotations ||
    prev.insertedRanges !== next.insertedRanges ||
    prev.deletedRanges !== next.deletedRanges ||
    prev.substitutedRanges !== next.substitutedRanges ||
    prev.pendingPrimerBindings !== next.pendingPrimerBindings
  );
}
function workingDocument(saved: AnnotatedSequence, draft: EditorState): AnnotatedSequence {
  const clean = cleanSequenceFromEditorState(draft);
  return {
    ...saved,
    sequence: clean.sequence,
    length: clean.sequence.length,
    annotations: clean.annotations,
  };
}
function createDraftLineage(
  document: AnnotatedSequence,
  accepted?: ScientificAcceptedDocumentRevision
): SequenceDraftLineage {
  return {
    ...(accepted ? { accepted } : {}),
    id: globalThis.crypto.randomUUID(),
    baseline: {
      sequence: document.sequence,
      length: document.sequence.length,
      circular: document.circular === true,
    },
  };
}
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _, ...rest } = record;
  return rest;
}
function dirtyProjection(
  dirtyPaths: Record<string, boolean>,
  documentId: string,
  dirty: boolean
): Record<string, boolean> {
  if (dirty) {
    return dirtyPaths[documentId] === true ? dirtyPaths : { ...dirtyPaths, [documentId]: true };
  }
  return withoutKey(dirtyPaths, documentId);
}
function draftPosition(position: number, draft: EditorState): number {
  if (draft.deletedRanges.length === 0) return position;
  let index0 = position - 1;
  for (const range of [...draft.deletedRanges].sort((a, b) => a.start - b.start)) {
    if (range.start > index0) break;
    index0 += range.end - range.start;
  }
  return index0 + 1;
}
function draftAnnotation<
  T extends {
    start: number;
    end: number;
  },
>(annotation: T, draft: EditorState): T {
  if (draft.deletedRanges.length === 0) return annotation;
  return {
    ...annotation,
    start: draftPosition(annotation.start, draft),
    end: draftPosition(annotation.end, draft),
  };
}
function survivesDeletions(annotation: Annotation, draft: EditorState): boolean {
  let current = [annotation];
  let sequenceLength = draft.sequence.length;
  for (const range of [...draft.deletedRanges].sort((a, b) => b.start - a.start)) {
    current = adjustAnnotationsForDelete(current, range.start, range.end, sequenceLength);
    sequenceLength -= range.end - range.start;
    if (current.length === 0) return false;
  }
  return true;
}
function draftAnnotationIndex(workingIndex: number, draft: EditorState): number {
  if (workingIndex < 0 || !Number.isInteger(workingIndex)) return -1;
  if (draft.deletedRanges.length === 0) {
    return workingIndex < draft.annotations.length ? workingIndex : -1;
  }
  let seen = -1;
  for (let index = 0; index < draft.annotations.length; index++) {
    if (!survivesDeletions(draft.annotations[index], draft)) continue;
    seen += 1;
    if (seen === workingIndex) return index;
  }
  return -1;
}
function withManagedAnnotationIds(annotations: Annotation[], ids: readonly string[]): Annotation[] {
  if (annotations.length !== ids.length) {
    throw new Error('Saved managed annotation IDs do not match the editor capture.');
  }
  return annotations.map((annotation, index) => {
    const id = ids[index];
    const existing = annotation.qualifiers?.dnaforge_ann_id;
    if (!id || (existing && (existing.length !== 1 || existing[0] !== id))) {
      throw new Error('A saved managed annotation identity conflicts with the editor capture.');
    }
    return {
      ...annotation,
      qualifiers: { ...annotation.qualifiers, dnaforge_ann_id: [id] },
    };
  });
}
function dropStaleTranslation(prev: Annotation, merged: Annotation, patch: AnnotationEditPatch) {
  if (patch.qualifiers) {
    const previousId = prev.qualifiers?.[MANAGED_GENBANK_ANNOTATION_ID_QUALIFIER];
    const suppliedId = patch.qualifiers[MANAGED_GENBANK_ANNOTATION_ID_QUALIFIER];
    if (suppliedId !== undefined && JSON.stringify(suppliedId) !== JSON.stringify(previousId)) {
      throw new Error('Managed annotation ID cannot be changed by an annotation edit.');
    }
    const qualifiers = { ...patch.qualifiers };
    if (previousId) qualifiers[MANAGED_GENBANK_ANNOTATION_ID_QUALIFIER] = [...previousId];
    return {
      ...merged,
      qualifiers: Object.keys(qualifiers).length > 0 ? qualifiers : undefined,
    };
  }
  const rangeChanged = prev.start !== patch.start || prev.end !== patch.end;
  if (!rangeChanged || !merged.qualifiers?.translation) return merged;
  const q = { ...merged.qualifiers };
  delete q.translation;
  delete q.codon_start;
  delete q.transl_table;
  return { ...merged, qualifiers: Object.keys(q).length > 0 ? q : undefined };
}
export type SequenceModelMethod =
  | 'setSequence'
  | 'clearSequence'
  | 'clearAll'
  | 'acknowledgeMetadata'
  | 'dispatchEdit'
  | 'replaceBases'
  | 'updateAnnotation'
  | 'deleteAnnotation'
  | 'addAnnotation'
  | 'mergeAnnotations'
  | 'discardEdits'
  | 'patchSavedMetadata'
  | 'restoreRecoveredDraft';
export type SequenceModelCommand = {
  [K in SequenceModelMethod]: { method: K; args: Parameters<SequenceStore[K]> };
}[SequenceModelMethod];
export function createSequenceDocumentModel(
  options: {
    beforeInput?(documentId: string, purpose?: 'discard'): void;
    afterCommand?(command: SequenceModelCommand, beforeRevision: number | undefined): void;
  } = {}
) {
  const model = createStore<SequenceStore>()(
    withRevision((set, get) => {
      const applyDraft = (
        documentId: string,
        next: EditorState,
        recoveredLineageId?: string
      ): void => {
        set((state) => {
          const draft = state.drafts[documentId];
          const saved = state.savedSequences[documentId];
          if (!draft || !saved || next === draft) return state;
          if (!draftContentChanged(draft, next)) {
            return { drafts: { ...state.drafts, [documentId]: next } };
          }
          options.beforeInput?.(documentId);
          const revision = (state.sequenceVersions[documentId] ?? 0) + 1;
          const working = workingDocument(saved, next);
          const dirty =
            working.sequence !== saved.sequence ||
            next.pendingPrimerBindings.length > 0 ||
            (working.annotations !== saved.annotations &&
              JSON.stringify(working.annotations) !== JSON.stringify(saved.annotations));
          return {
            drafts: { ...state.drafts, [documentId]: next },
            ...(recoveredLineageId
              ? {
                  draftLineages: {
                    ...state.draftLineages,
                    [documentId]: { ...state.draftLineages[documentId], id: recoveredLineageId },
                  },
                }
              : {}),
            sequences: { ...state.sequences, [documentId]: working },
            sequenceVersions: { ...state.sequenceVersions, [documentId]: revision },
            dirtyPaths: dirtyProjection(state.dirtyPaths, documentId, dirty),
          };
        });
      };
      const editAnnotations = (
        documentId: string,
        transform: (annotations: Annotation[], draft: EditorState) => Annotation[] | null
      ): void => {
        assertSequenceDocumentId(documentId);
        const draft = get().drafts[documentId];
        if (!draft) return;
        const nextAnnotations = transform(draft.annotations, draft);
        if (!nextAnnotations) return;
        applyDraft(
          documentId,
          editorReducer(draft, { type: 'SET_ANNOTATIONS', annotations: nextAnnotations })
        );
      };
      const acknowledge = (
        documentId: string,
        capture: SequenceSaveCapture,
        managedAnnotationIds?: string[],
        accepted?: ScientificAcceptedDocumentRevision
      ): boolean => {
        let settled = false;
        set((state) => {
          const draft = state.drafts[documentId];
          if (!draft) return state;
          const capturedAnnotations = managedAnnotationIds
            ? withManagedAnnotationIds(capture.sequence.annotations, managedAnnotationIds)
            : capture.sequence.annotations;
          const revision = state.sequenceVersions[documentId] ?? 0;
          settled = revision === capture.revision;
          if (!settled) {
            if (state.savedVersions[documentId] === capture.revision) return state;

            const saved = state.savedSequences[documentId] ?? capture.sequence;
            return {
              ...(accepted
                ? { acceptedRevisions: { ...state.acceptedRevisions, [documentId]: accepted } }
                : {}),
              savedSequences: {
                ...state.savedSequences,
                [documentId]: {
                  ...saved,
                  sequence: capture.sequence.sequence,
                  length: capture.sequence.length,
                  annotations: capturedAnnotations,
                },
              },
              savedVersions: { ...state.savedVersions, [documentId]: capture.revision },
              dirtyPaths: dirtyProjection(state.dirtyPaths, documentId, true),
            };
          }

          const working = state.sequences[documentId] ?? capture.sequence;
          const acknowledgedWorking = managedAnnotationIds
            ? {
                ...working,
                annotations: withManagedAnnotationIds(working.annotations, managedAnnotationIds),
              }
            : working;
          const committed = editorReducer(draft, { type: 'COMMIT' });
          const acknowledgedAnnotations = managedAnnotationIds
            ? withManagedAnnotationIds(committed.annotations, managedAnnotationIds)
            : committed.annotations;
          const acknowledgedDraft = managedAnnotationIds
            ? {
                ...committed,
                annotations: acknowledgedAnnotations,
                history: committed.history.map((entry) => ({
                  ...entry,
                  annotations: acknowledgedAnnotations,
                })),
              }
            : committed;

          if (
            state.savedVersions[documentId] === revision &&
            state.savedSequences[documentId] === working &&
            !state.dirtyPaths[documentId]
          ) {
            return state;
          }
          return {
            ...(accepted
              ? { acceptedRevisions: { ...state.acceptedRevisions, [documentId]: accepted } }
              : {}),
            drafts: { ...state.drafts, [documentId]: acknowledgedDraft },
            sequences: { ...state.sequences, [documentId]: acknowledgedWorking },
            draftLineages: {
              ...state.draftLineages,
              [documentId]: createDraftLineage(
                acknowledgedWorking,
                accepted ?? state.acceptedRevisions[documentId]
              ),
            },
            savedSequences: { ...state.savedSequences, [documentId]: acknowledgedWorking },
            savedVersions: { ...state.savedVersions, [documentId]: revision },
            dirtyPaths: dirtyProjection(state.dirtyPaths, documentId, false),
          };
        });
        return settled;
      };
      return {
        acceptedRevisions: {},
        acknowledgeMetadata: (documentId, expectedSaved, published, accepted) => {
          assertSequenceDocumentId(documentId);
          if (accepted && accepted.resourceId !== documentId)
            throw new Error('Accepted metadata identity does not match its document.');
          set((state) => {
            const working = state.sequences[documentId];
            if (!working || state.savedSequences[documentId] !== expectedSaved) return state;
            if (
              published.sequence !== expectedSaved.sequence ||
              JSON.stringify(published.annotations) !== JSON.stringify(expectedSaved.annotations)
            )
              throw new Error('Metadata publication cannot replace sequence edits.');
            const saved = { ...published, id: documentId };
            return {
              acceptedRevisions: accepted
                ? { ...state.acceptedRevisions, [documentId]: accepted }
                : withoutKey(state.acceptedRevisions, documentId),
              savedSequences: { ...state.savedSequences, [documentId]: saved },
              sequences: {
                ...state.sequences,
                [documentId]: {
                  ...saved,
                  sequence: working.sequence,
                  length: working.length,
                  annotations: working.annotations,
                },
              },

              draftLineages: {
                ...state.draftLineages,
                [documentId]: createDraftLineage(saved, accepted),
              },
            };
          });
        },

        sequences: {},
        savedSequences: {},
        drafts: {},
        draftLineages: {},
        loadingDocumentIds: new Set(),
        scrollPositions: {},
        sequenceVersions: {},
        savedVersions: {},
        dirtyPaths: {},
        revision: 0,
        setSequence: (documentId, data, accepted) => {
          assertSequenceDocumentId(documentId);
          if (accepted && accepted.resourceId !== documentId)
            throw new Error('Accepted sequence identity does not match its document.');
          const document = data.id === documentId ? data : { ...data, id: documentId };
          set((state) => {
            const revision = (state.sequenceVersions[documentId] ?? 0) + 1;
            return {
              acceptedRevisions: accepted
                ? { ...state.acceptedRevisions, [documentId]: accepted }
                : withoutKey(state.acceptedRevisions, documentId),
              sequences: { ...state.sequences, [documentId]: document },
              savedSequences: { ...state.savedSequences, [documentId]: document },
              drafts: {
                ...state.drafts,
                [documentId]: createInitialState(
                  document.sequence,
                  document.annotations ?? [],
                  nucleicAcidOf(document)
                ),
              },
              draftLineages: {
                ...state.draftLineages,
                [documentId]: createDraftLineage(document, accepted),
              },
              loadingDocumentIds: new Set(
                [...state.loadingDocumentIds].filter((id) => id !== documentId)
              ),
              sequenceVersions: { ...state.sequenceVersions, [documentId]: revision },
              savedVersions: { ...state.savedVersions, [documentId]: revision },
              dirtyPaths: dirtyProjection(state.dirtyPaths, documentId, false),
            };
          });
        },
        hasSequence: (documentId) => {
          assertSequenceDocumentId(documentId);
          return documentId in get().sequences;
        },
        getSequence: (documentId) => {
          assertSequenceDocumentId(documentId);
          return get().sequences[documentId] ?? null;
        },
        isLoading: (documentId) => {
          assertSequenceDocumentId(documentId);
          return get().loadingDocumentIds.has(documentId);
        },
        setLoading: (documentId, loading) => {
          assertSequenceDocumentId(documentId);
          set((state) => {
            const isLoading = state.loadingDocumentIds.has(documentId);
            if (isLoading === loading) return state;
            const nextLoadingDocumentIds = new Set(state.loadingDocumentIds);
            if (loading) {
              nextLoadingDocumentIds.add(documentId);
            } else {
              nextLoadingDocumentIds.delete(documentId);
            }
            return { loadingDocumentIds: nextLoadingDocumentIds };
          });
        },
        clearSequence: (documentId) => {
          assertSequenceDocumentId(documentId);
          set((state) => {
            if (!(documentId in state.sequences)) return state;
            return {
              sequences: withoutKey(state.sequences, documentId),
              savedSequences: withoutKey(state.savedSequences, documentId),
              drafts: withoutKey(state.drafts, documentId),
              draftLineages: withoutKey(state.draftLineages, documentId),
              acceptedRevisions: withoutKey(state.acceptedRevisions, documentId),
              sequenceVersions: withoutKey(state.sequenceVersions, documentId),
              savedVersions: withoutKey(state.savedVersions, documentId),
              dirtyPaths: withoutKey(state.dirtyPaths, documentId),
            };
          });
        },
        clearAll: () => {
          set({
            sequences: {},
            savedSequences: {},
            drafts: {},
            draftLineages: {},
            acceptedRevisions: {},
            loadingDocumentIds: new Set(),
            scrollPositions: {},
            sequenceVersions: {},
            savedVersions: {},
            dirtyPaths: {},
          });
        },
        setScrollPosition: (documentId, position) => {
          assertSequenceDocumentId(documentId);
          console.log('[SequenceStore] setScrollPosition:', { documentId, position });
          set((state) => {
            if (state.scrollPositions[documentId] === position) return state;
            return {
              scrollPositions: { ...state.scrollPositions, [documentId]: position },
            };
          });
        },
        getScrollPosition: (documentId) => {
          assertSequenceDocumentId(documentId);
          const position = get().scrollPositions[documentId] ?? null;
          console.log('[SequenceStore] getScrollPosition:', { documentId, position });
          return position;
        },
        clearScrollPosition: (documentId) => {
          assertSequenceDocumentId(documentId);
          console.log('[SequenceStore] clearScrollPosition:', { documentId });
          set((state) => {
            if (!(documentId in state.scrollPositions)) return state;
            return { scrollPositions: withoutKey(state.scrollPositions, documentId) };
          });
        },
        getVersion: (documentId) => {
          assertSequenceDocumentId(documentId);
          return get().sequenceVersions[documentId] ?? 0;
        },
        dispatchEdit: (documentId, action) => {
          assertSequenceDocumentId(documentId);
          if (LIFECYCLE_ACTIONS.has(action.type)) {
            throw new Error(
              `Editor action ${action.type} is owned by the document model; use setSequence, acknowledgeSaved or discardEdits.`
            );
          }
          const draft = get().drafts[documentId];
          if (!draft) return;
          applyDraft(documentId, editorReducer(draft, action));
        },
        replaceBases: (documentId, start, end, bases) => {
          assertSequenceDocumentId(documentId);
          const draft = get().drafts[documentId];
          const working = get().sequences[documentId];
          if (!draft || !working) throw new Error('Sequence document is not loaded.');
          if (
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < 0 ||
            end < start ||
            end > working.sequence.length ||
            !/^[ACGTRYSWKMBDHVN]*$/i.test(bases)
          ) {
            throw new Error('Invalid sequence replacement.');
          }
          if (working.sequence.slice(start, end).toUpperCase() === bases.toUpperCase()) return;
          const draftStart = draftPosition(start + 1, draft) - 1;
          const selection =
            start === end
              ? null
              : {
                  start: draftStart,
                  end: draftPosition(end, draft) - 1,
                };
          let next = editorReducer(draft, { type: 'SET_CURSOR', position: draftStart });
          next = editorReducer(next, { type: 'SET_SELECTION', selection });
          next = editorReducer(
            next,
            bases ? { type: 'INSERT', text: bases } : { type: 'DELETE_SELECTION' }
          );
          applyDraft(documentId, next);
        },
        updateAnnotation: (documentId, index, patch) => {
          editAnnotations(documentId, (annotations, draft) => {
            const target = draftAnnotationIndex(index, draft);
            const prev = annotations[target];
            if (!prev) return null;
            const mapped = draftAnnotation(patch, draft);
            const updated = [...annotations];
            updated[target] = dropStaleTranslation(prev, { ...prev, ...mapped }, mapped);
            return updated;
          });
        },
        deleteAnnotation: (documentId, index) => {
          editAnnotations(documentId, (annotations, draft) => {
            const target = draftAnnotationIndex(index, draft);
            return target >= 0 ? annotations.filter((_, i) => i !== target) : null;
          });
        },
        addAnnotation: (documentId, annotation) => {
          editAnnotations(documentId, (annotations, draft) =>
            [...annotations, draftAnnotation(annotation, draft)].sort((a, b) => a.start - b.start)
          );
        },
        mergeAnnotations: (documentId, incoming) => {
          editAnnotations(documentId, (annotations, draft) =>
            incoming.length > 0
              ? [
                  ...annotations,
                  ...incoming.map((annotation) => draftAnnotation(annotation, draft)),
                ]
              : null
          );
        },
        hasPendingSequenceEdits: (documentId) => {
          assertSequenceDocumentId(documentId);
          const draft = get().drafts[documentId];
          return draft ? hasUncommittedSequenceEdits(draft) : false;
        },
        captureForSave: (documentId) => {
          assertSequenceDocumentId(documentId);
          const state = get();
          const draft = state.drafts[documentId];
          const sequence = state.sequences[documentId];
          const lineage = state.draftLineages[documentId];
          if (!draft || !sequence || !lineage) return null;
          return {
            revision: state.sequenceVersions[documentId] ?? 0,
            sequence,
            pendingPrimerBindings: cleanSequenceFromEditorState(draft).pendingPrimerBindings,
            draftBaseline: { ...lineage.baseline },
            draftSequence: draft.sequence,
            insertedRanges: draft.insertedRanges.map((range) => ({ ...range })),
            deletedRanges: draft.deletedRanges.map((range) => ({ ...range })),
            substitutedRanges: draft.substitutedRanges.map((range) => ({ ...range })),
            draftLineageId: lineage.id,
            ...(lineage.accepted && state.acceptedRevisions[documentId]
              ? {
                  accepted: {
                    operationId: `sequence-save:${lineage.id}:${state.sequenceVersions[documentId] ?? 0}`,
                    createdAt: saveCaptureTime(sequence),
                    expectedHead: state.acceptedRevisions[documentId].workspaceVersionId,
                    expectedRevisionId: state.acceptedRevisions[documentId].resourceRevisionId,
                    parentEventId: lineage.accepted.sequenceEditParentEventId,
                    baseline: {
                      head: lineage.accepted.workspaceVersionId,
                      revisionId: lineage.accepted.resourceRevisionId,
                    },
                    replacementEventId:
                      state.acceptedRevisions[documentId].sequenceEditParentEventId,
                  },
                }
              : {}),
          };
        },
        acknowledgeSaved: (documentId, capture, managedAnnotationIds, accepted) => {
          assertSequenceDocumentId(documentId);
          return { settled: acknowledge(documentId, capture, managedAnnotationIds, accepted) };
        },
        discardEdits: (documentId) => {
          assertSequenceDocumentId(documentId);
          let restored: AnnotatedSequence | null = null;
          set((state) => {
            const saved = state.savedSequences[documentId];
            if (!saved) return state;
            restored = saved;
            if (state.sequences[documentId] === saved && !state.dirtyPaths[documentId])
              return state;
            options.beforeInput?.(documentId, 'discard');
            const revision = (state.sequenceVersions[documentId] ?? 0) + 1;
            return {
              drafts: {
                ...state.drafts,
                [documentId]: createInitialState(
                  saved.sequence,
                  saved.annotations ?? [],
                  nucleicAcidOf(saved)
                ),
              },
              draftLineages: {
                ...state.draftLineages,
                [documentId]: createDraftLineage(saved, state.acceptedRevisions[documentId]),
              },
              sequences: { ...state.sequences, [documentId]: saved },
              sequenceVersions: { ...state.sequenceVersions, [documentId]: revision },
              savedVersions: { ...state.savedVersions, [documentId]: revision },
              dirtyPaths: dirtyProjection(state.dirtyPaths, documentId, false),
            };
          });
          return restored;
        },
        patchSavedMetadata: (documentId, patch) => {
          assertSequenceDocumentId(documentId);
          set((state) => {
            const saved = state.savedSequences[documentId];
            const working = state.sequences[documentId];
            if (!saved || !working) return state;
            return {
              savedSequences: { ...state.savedSequences, [documentId]: { ...saved, ...patch } },
              sequences: { ...state.sequences, [documentId]: { ...working, ...patch } },
            };
          });
        },
        markClean: (documentId) => {
          assertSequenceDocumentId(documentId);
          const capture = get().captureForSave(documentId);
          if (capture) acknowledge(documentId, capture);
        },
        isDirty: (documentId) => {
          assertSequenceDocumentId(documentId);
          return get().dirtyPaths[documentId] === true;
        },
        restoreRecoveredDraft: (documentId, content) => {
          assertSequenceDocumentId(documentId);
          if (!get().drafts[documentId] || !get().savedSequences[documentId]) return false;
          applyDraft(
            documentId,
            {
              ...createInitialState(
                content.sequence,
                content.annotations,
                nucleicAcidOf(get().savedSequences[documentId])
              ),
              insertedRanges: content.insertedRanges,
              deletedRanges: content.deletedRanges,
              substitutedRanges: content.substitutedRanges,

              pendingPrimerBindings: (content.pendingPrimerBindings ?? []).map((binding) => ({
                ...binding,
                pendingId: binding.pendingId ?? globalThis.crypto.randomUUID(),
              })),
              isDirty: true,
            },
            content.draftLineageId
          );
          return get().dirtyPaths[documentId] === true;
        },
      };
    })
  );
  if (options.afterCommand) {
    const dispatchEdit = model.getState().dispatchEdit;
    model.setState({
      dispatchEdit: (documentId, input) => {
        const action: EditorAction =
          input.type === 'INSERT_FRAGMENT'
            ? {
                ...input,
                fragment: {
                  ...input.fragment,
                  primerBindings: input.fragment.primerBindings.map((binding) => ({
                    ...binding,
                    pendingId: binding.pendingId ?? globalThis.crypto.randomUUID(),
                  })),
                },
              }
            : input;
        const beforeRevision = model.getState().getVersion(documentId);
        dispatchEdit(documentId, action);
        options.afterCommand?.(
          { method: 'dispatchEdit', args: [documentId, action] },
          beforeRevision
        );
      },
    });
    const methods: SequenceModelMethod[] = [
      'setSequence',
      'clearSequence',
      'clearAll',
      'acknowledgeMetadata',
      'replaceBases',
      'updateAnnotation',
      'deleteAnnotation',
      'addAnnotation',
      'mergeAnnotations',
      'discardEdits',
      'patchSavedMetadata',
      'restoreRecoveredDraft',
    ];
    const state = model.getState();
    for (const method of methods) {
      const execute = state[method] as (...args: unknown[]) => unknown;
      const wrapped = (...args: unknown[]) => {
        const beforeRevision =
          typeof args[0] === 'string' ? model.getState().getVersion(args[0]) : undefined;
        const result = execute(...args);
        options.afterCommand?.({ method, args } as SequenceModelCommand, beforeRevision);
        return result;
      };
      model.setState({ ...model.getState(), [method]: wrapped }, true);
    }
  }
  return model;
}
