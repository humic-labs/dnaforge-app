import { z } from 'zod';
import type { SequenceStore } from './sequence-document-model';
import { sequenceEditOperationSchema } from './sequence-document';

export function inspectSequenceModel(store: SequenceStore, documentId: string) {
  const sequence = store.getSequence(documentId);
  const draft = store.drafts[documentId];
  if (!sequence || !draft) throw new Error('Sequence document is not loaded.');
  return {
    documentId,
    version: store.getVersion(documentId),
    savedVersion: store.savedVersions[documentId],
    dirty: store.isDirty(documentId),
    canUndo: draft.historyIndex > 0,
    canRedo: draft.historyIndex < draft.history.length - 1,
    sequence: sequence.sequence,
    length: sequence.sequence.length,
    annotations: sequence.annotations,
    circular: sequence.circular,
  };
}

export function applySequenceModelCommand(
  store: SequenceStore,
  input: {
    documentId: string;
    expectedVersion: number;
    operation: z.input<typeof sequenceEditOperationSchema>;
  }
) {
  const fail = (code: string, error: string) => ({
    ok: false as const,
    code,
    error,
    retriable: false,
    stateChanged: false as const,
    partialEffects: [],
  });
  const parsed = sequenceEditOperationSchema.safeParse(input.operation);
  if (!parsed.success) return fail('INVALID_SEQUENCE_EDIT', parsed.error.message);
  const { documentId, expectedVersion } = input;
  const sequence = store.getSequence(documentId);
  if (!sequence) return fail('SEQUENCE_NOT_LOADED', 'Inspect the sequence before editing it.');
  if (store.getVersion(documentId) !== expectedVersion) {
    return fail(
      'STALE_SEQUENCE',
      'The sequence changed after your inspection. Inspect it again before editing.'
    );
  }
  const operation = parsed.data;
  if ('annotation' in operation) {
    const { start, end } = operation.annotation;
    if (start > sequence.length || end > sequence.length || (start > end && !sequence.circular)) {
      return fail(
        'INVALID_ANNOTATION_RANGE',
        'Annotation bounds must lie inside this sequence; only circular records can wrap the origin.'
      );
    }
  }
  if ('index' in operation && !sequence.annotations[operation.index]) {
    return fail('ANNOTATION_NOT_FOUND', 'That annotation index does not exist at this revision.');
  }
  if (operation.kind === 'replace-bases') {
    if (operation.end < operation.start || operation.end > sequence.sequence.length) {
      return fail(
        'INVALID_SEQUENCE_RANGE',
        'The replacement range is outside the current sequence.'
      );
    }
    if (sequence.sequence.slice(operation.start, operation.end) !== operation.expectedBases) {
      return fail('BASES_MISMATCH', 'The expected bases do not match the current sequence.');
    }
  }
  try {
    switch (operation.kind) {
      case 'replace-bases':
        store.replaceBases(documentId, operation.start, operation.end, operation.bases);
        break;
      case 'add-annotation':
        store.addAnnotation(documentId, operation.annotation);
        break;
      case 'update-annotation':
        store.updateAnnotation(documentId, operation.index, operation.annotation);
        break;
      case 'delete-annotation':
        store.deleteAnnotation(documentId, operation.index);
        break;
      case 'discard':
        store.discardEdits(documentId);
        break;
      case 'undo':
      case 'redo':
        store.dispatchEdit(documentId, { type: operation.kind === 'undo' ? 'UNDO' : 'REDO' });
        break;
    }
  } catch (error) {
    return fail('SEQUENCE_EDIT_BLOCKED', error instanceof Error ? error.message : String(error));
  }
  const state = inspectSequenceModel(store, documentId);
  return {
    ok: true as const,
    documentId,
    version: state.version,
    dirty: state.dirty,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    length: state.length,
    annotationCount: state.annotations.length,
  };
}
