import type { AnnotationResult, OperationSnapshot } from '@waypoint/api-client';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { openDocument } from '../document-opening/public/open-document';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useSequenceStore } from './store';
import { resolveSequenceDocumentById } from './sequence-document-repository';
import { useAnnotationOperationState } from './annotation-operation-state';
import { useAnnotationReviewStore } from './annotation-review-store';
import { createDraftAnnotations } from './annotation-review-utils';

export { annotationReviewBlockReason } from './annotation-operation-revision-policy';

export function canOpenAnnotationOperationResult(operation: OperationSnapshot): boolean {
  return (
    operation.kind === 'annotation' &&
    operation.state === 'succeeded' &&
    operation.result_status === 'available' &&
    !operation.subject.subject_id.startsWith('external-input:') &&
    !operation.subject.subject_id.startsWith('recorded-input:')
  );
}

export function hydrateAnnotationOperationReview(
  operation: Pick<OperationSnapshot, 'id' | 'subject'>,
  result: AnnotationResult,
  sequence: AnnotatedSequence
): void {
  const documentId = operation.subject.subject_id;
  const existing = (sequence.annotations ?? []).map(({ name, type, start, end }) => ({
    name,
    type,
    start,
    end,
  }));
  useAnnotationReviewStore.getState().enterReviewMode(
    createDraftAnnotations(result.features, existing).map((draft, index) => ({
      ...draft,
      id: `${operation.id}:${index}`,
    })),
    documentId,
    useAnnotationOperationState.getState().submittedVersions[operation.id] ?? -1,
    { operationId: operation.id, inputRevision: operation.subject.input_revision }
  );
  const saved = useSequenceStore.getState().savedSequences[documentId];
  if (
    saved?.annotations?.some((annotation) =>
      annotation.qualifiers?.dnaforge_operation_id?.includes(operation.id)
    )
  ) {
    useAnnotationReviewStore.getState().setOperationDisposition(operation.id, 'applied');
  }
}

export async function openAnnotationOperationResult(operation: OperationSnapshot): Promise<void> {
  if (!canOpenAnnotationOperationResult(operation)) {
    throw new Error(
      'This result has no available DNAForge document review. Read or export it from its execution owner.'
    );
  }
  const roots = useWorkspaceStore.getState().folders.map((folder) => folder.path);
  const document = await resolveSequenceDocumentById(operation.subject.subject_id, roots);
  const opened = await openDocument({
    target: { kind: 'sequence-document', document: document.ref },
    label: document.name || document.sourcePath.split(/[\\/]/).pop() || 'Sequence',
  });
  if (opened.status !== 'presented')
    throw new Error('The sequence could not be opened for this result.');
  useAnnotationReviewStore.getState().presentOperationReview(operation.id);
  useAnnotationOperationState.getState().presentReview(document.documentId, operation.id);
}
