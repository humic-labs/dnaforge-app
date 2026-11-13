import { userMessage } from '@waypoint/user-messages';
import type { AnnotationDocumentApplyResponse } from '@waypoint/api-client';
import {
  sequenceDocumentKey,
  type SequenceDocumentRef,
} from '../../shared/managed-sequence-document';
import { assertWorkspaceEditorsSettled } from '../../services/workspace-editor-mutation-state';
import { useToastStore } from '../../stores/toast-store';
import { useCanvasStore } from '../canvas/public/store';
import { useSequenceStore } from './store';
import { resolveSequenceDocument } from './sequence-document-repository';
import { openDocument } from '../document-opening/public/open-document';

export function notifySavedAnnotationDocument(
  receipt: AnnotationDocumentApplyResponse,
  documentRef: SequenceDocumentRef,
  label: string
): void {
  const saved = receipt.outcome;
  if (saved.status !== 'saved') return;
  const toasts = useToastStore.getState();
  if (saved.checkpoint.status === 'failed') {
    toasts.addToast(
      userMessage('notice.the-result-was-saved-but-its-version-history-checkpoint-failed-check-t'),
      {
        definition:
          'sequence-tab-the-result-was-saved-but-its-version-history-checkpoint-failed-check-the-job',
      }
    );
  }
  if (saved.display !== 'pending') return;
  const stableRef = { ...documentRef };
  const documentId = sequenceDocumentKey(stableRef);
  let reopening = false;
  const toastId = toasts.addRichToast({
    definition: 'sequence-tab-the-result-was-saved-its-document-view-still-needs-to-refresh',
    actions: [
      {
        label: 'Reopen saved document',
        async onClick() {
          if (reopening) return;
          reopening = true;
          try {
            const resolved = await resolveSequenceDocument(stableRef);
            if (resolved.documentId !== documentId) throw new Error('Document identity changed.');
            assertWorkspaceEditorsSettled({
              workspaceRoot: resolved.sourcePath,
              affectedEntityIds: [documentId],
            });
            const sequences = useSequenceStore.getState();
            if (sequences.isDirty(documentId) || sequences.hasPendingSequenceEdits(documentId)) {
              throw new Error('The document has unsaved edits.');
            }
            const canvas = useCanvasStore.getState();
            for (const panel of Object.values(canvas.panels)) {
              for (const tab of panel.tabs) {
                if (tab.entityId === documentId) canvas.closeTab(panel.id, tab.id);
              }
            }
            sequences.clearSequence(documentId);
            const result = await openDocument({
              target: { kind: 'sequence-document', document: resolved.ref },
              label,
            });
            if (result.status !== 'presented')
              throw new Error('The document could not be reopened.');
            useToastStore.getState().removeToast(toastId);
          } catch {
            useToastStore
              .getState()
              .addToast(
                userMessage(
                  'notice.the-result-was-saved-save-or-cancel-any-current-edits-then-reopen-the-'
                ),
                { definition: 'sequence-tab-saved-annotation-reopen-blocked' }
              );
          } finally {
            reopening = false;
          }
        },
      },
    ],
  });
}
