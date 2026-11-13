import { platform } from '../platform';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { createLegacyUnsavedDiscard } from '../shared/legacy-unsaved-discard';
import { fileDocumentInspectSchema } from '../shared/file-document';
import {
  readUnsavedDraft,
  deleteUnsavedDraftIfUnchanged,
  flushPendingUnsavedDraftWrites,
  UNSAVED_DRAFT_SESSION_ID,
} from '../shared/unsaved-draft-recovery';
import {
  readUnsavedSequenceEntry,
  deleteUnsavedSequenceEntryIfUnchanged,
  UNSAVED_SEQUENCE_SESSION_ID,
} from '../features/sequence/unsaved-sequence-recovery';

export function installLegacyUnsavedDiscard(): () => void {
  const service = createLegacyUnsavedDiscard({
    currentRoots: () => useWorkspaceStore.getState().folders.map((folder) => folder.path),
    draftSessionId: UNSAVED_DRAFT_SESSION_ID,
    sequenceSessionId: UNSAVED_SEQUENCE_SESSION_ID,
    readDraft: readUnsavedDraft,
    readSequence: readUnsavedSequenceEntry,
    deleteDraftIfUnchanged: deleteUnsavedDraftIfUnchanged,
    deleteSequenceIfUnchanged: deleteUnsavedSequenceEntryIfUnchanged,
    flushDrafts: flushPendingUnsavedDraftWrites,
    canDiscardFile: async (path) => {
      const document = await platform().fs.fileDocument({
        target: { path },
        projection: 'inspection',
        operation: fileDocumentInspectSchema.parse({ kind: 'inspect' }),
      });
      return (
        document.ready && !document.recoveryId && ['text', 'csv', 'tsv'].includes(document.type)
      );
    },
    resolveDocument: async (documentId, kind) => {
      const document = await platform().fs.fileDocument({
        target: { documentId },
        projection: 'inspection',
        operation: fileDocumentInspectSchema.parse({ kind: 'inspect' }),
      });
      if (
        !document.ready ||
        document.recoveryId ||
        document.type !== kind ||
        !document.workspaceRoot
      )
        throw new Error(
          'A legacy recovery has no current admitted native owner; its copy was kept.'
        );
      return { workspaceRoot: document.workspaceRoot, path: document.path, kind: document.type };
    },
  });
  window.__dnaforgeCaptureUnsavedCopies = service.capture;
  window.__dnaforgeDiscardUnsavedCopies = service.discard;
  return () => {
    if (window.__dnaforgeCaptureUnsavedCopies === service.capture)
      delete window.__dnaforgeCaptureUnsavedCopies;
    if (window.__dnaforgeDiscardUnsavedCopies === service.discard)
      delete window.__dnaforgeDiscardUnsavedCopies;
  };
}
