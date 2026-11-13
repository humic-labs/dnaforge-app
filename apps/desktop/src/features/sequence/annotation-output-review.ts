import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { applyAnnotationOutput, inspectAnnotationOutput } from './annotation-output-import';
import { parseAnnotationOutputFile } from './annotation-output-client';
import { useAnnotationReviewStore } from './annotation-review-store';
import { createDraftAnnotations } from './annotation-review-utils';
import { useSequenceStore } from './store';

export async function reviewSelectedAnnotationOutput(
  absolutePath: string,
  targetDocumentId: string,
  folders: readonly WorkspaceFolder[]
): Promise<void> {
  const format = /\.json$/i.test(absolutePath) ? 'json' : 'gff3';
  const source = { kind: 'granted-file' as const, absolutePath, grantedFiles: [absolutePath] };
  const inspection = await inspectAnnotationOutput(
    { source, format, targetDocumentId, folders },
    { parse: parseAnnotationOutputFile }
  );
  const store = useSequenceStore.getState();
  const sequence = store.getSequence(targetDocumentId);
  if (!sequence) throw new Error('The target sequence is no longer available.');
  const existing = (sequence.annotations ?? []).map(({ name, type, start, end }) => ({
    name,
    type,
    start,
    end,
  }));
  const drafts = createDraftAnnotations(inspection.result.features, existing).map(
    (draft, index) => ({ ...draft, id: inspection.candidates[index].id })
  );
  useAnnotationReviewStore
    .getState()
    .enterOutputReview(drafts, targetDocumentId, store.getVersion(targetDocumentId), {
      source,
      format,
      outputSha256: inspection.outputSha256,
      targetDocumentRevision: inspection.targetDocumentRevision,
    });
}

export async function applyAnnotationOutputReview(
  documentId: string,
  folders: readonly WorkspaceFolder[],
  parentActionId?: string
) {
  const review = useAnnotationReviewStore.getState().getSession(documentId);
  if (!review?.outputImport)
    throw new Error('The imported annotation review is no longer available.');
  const result = await applyAnnotationOutput(
    {
      source: review.outputImport.source,
      format: review.outputImport.format,
      targetDocumentId: documentId,
      folders,
      expectedOutputSha256: review.outputImport.outputSha256,
      expectedTargetDocumentRevision: review.outputImport.targetDocumentRevision,
      selectedCandidateIds: review.drafts
        .filter((draft) => draft.accepted)
        .map((draft) => draft.id),
    },
    {
      parse: parseAnnotationOutputFile,
      ...(parentActionId !== undefined ? { parentActionId } : {}),
    }
  );
  if (result.status === 'saved' || result.status === 'already-applied') {
    useAnnotationReviewStore.getState().exitReviewMode(documentId);
  } else if (result.status === 'save-failed') {
    useAnnotationReviewStore
      .getState()
      .setOutputReviewRetryRevision(
        documentId,
        result.retryTargetDocumentRevision,
        useSequenceStore.getState().getVersion(documentId)
      );
  }
  return result;
}
