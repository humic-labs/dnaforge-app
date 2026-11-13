import { userMessage, type UserMessage } from '@waypoint/user-messages';
import { annotationInputRevision } from './annotation-input-revision';
import { useSequenceStore } from './store';

export async function annotationReviewBlockReason(
  documentId: string,
  inputRevision: string
): Promise<UserMessage | undefined> {
  const store = useSequenceStore.getState();
  const sequence = store.getSequence(documentId);
  if (!sequence) return userMessage('annotation.openSequence');
  if (store.hasPendingSequenceEdits(documentId)) {
    return userMessage('annotation.unsavedEdits');
  }
  const version = store.getVersion(documentId);
  const current = await annotationInputRevision({
    sequence: sequence.sequence,
    linear: !sequence.circular,
  });
  if (useSequenceStore.getState().getVersion(documentId) !== version) {
    return userMessage('annotation.changedDuringReview');
  }
  return current === inputRevision ? undefined : userMessage('annotation.revisionChanged');
}
