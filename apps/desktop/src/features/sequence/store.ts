import { useStore } from 'zustand';
import type { UseBoundStore, StoreApi } from 'zustand';
import {
  createInitialState,
  type EditorState,
  type SequenceEditorSession,
} from '@waypoint/workspace-editor/model';
import { observeSequenceEdit } from './sequence-activity';
import { assertWorkspaceEditorInputAllowed } from '../../services/workspace-editor-mutation-state';
import {
  createSequenceDocumentModel,
  assertSequenceDocumentId,
  type SequenceStore,
} from './sequence-document-model';
import {
  notifySequenceModelCommand,
  assertNativeSequenceClientInputCurrent,
} from './sequence-client-port';
export type {
  SequenceDraftBaseline,
  SequenceSaveCapture,
  AnnotationEditPatch,
  RecoveredDraftContent,
} from './sequence-document-model';
export { assertSequenceDocumentId } from './sequence-document-model';

export const sequenceDocumentModel = createSequenceDocumentModel({
  beforeInput: (documentId, purpose) => {
    assertWorkspaceEditorInputAllowed(documentId);
    assertNativeSequenceClientInputCurrent(documentId, purpose);
  },
  afterCommand: (command, beforeRevision) => {
    if (command.method === 'dispatchEdit') {
      const [documentId, action] = command.args;
      const after = sequenceDocumentModel.getState().getVersion(documentId);
      if (after !== beforeRevision || action.type === 'UNDO' || action.type === 'REDO')
        observeSequenceEdit(
          documentId,
          action.type === 'UNDO' ? 'undo' : action.type === 'REDO' ? 'redo' : 'update',
          after,
          after !== beforeRevision
        );
    } else if (command.method === 'discardEdits') {
      const documentId = command.args[0];
      const after = sequenceDocumentModel.getState().getVersion(documentId);
      if (after !== beforeRevision) observeSequenceEdit(documentId, 'revert', after, true);
    }
    notifySequenceModelCommand(command);
  },
});
export const useSequenceStore = Object.assign(
  <T>(selector: (state: SequenceStore) => T) => useStore(sequenceDocumentModel, selector),
  sequenceDocumentModel
) as UseBoundStore<StoreApi<SequenceStore>>;

const EMPTY_DRAFT: EditorState = createInitialState('', []);

export function sequenceEditorSession(documentId: string): SequenceEditorSession {
  assertSequenceDocumentId(documentId);
  return {
    getState: () => useSequenceStore.getState().drafts[documentId] ?? EMPTY_DRAFT,
    dispatch: (action) => useSequenceStore.getState().dispatchEdit(documentId, action),
    subscribe: (listener) =>
      useSequenceStore.subscribe((state, previous) => {
        if (state.drafts[documentId] !== previous.drafts[documentId]) listener();
      }),
  };
}
