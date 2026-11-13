import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useMemo, useEffect, useRef, useState } from 'react';
import { useSequenceStore } from '../store';
import type {
  PersistSequenceDocumentOptions,
  SequencePersistenceResult,
} from '../persist-sequence-document';
import { useFileWatcher } from './useFileWatcher';
import { useToastStore } from '../../../stores/toast-store';
import { registerWorkspaceEditorBlocker } from '../../../services/workspace-editor-mutation-state';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { SequenceSaveCapture } from '../store';
import { registerSequenceSave } from '../save-all-sequences';
import {
  saveSequenceDocumentWithCompletion,
  type SequenceDocumentSaveCompletion,
  type SequenceSaveObservation,
} from '../complete-sequence-document-save';
import type { SequenceDocumentSavePublication } from '../../../shared/sequence-edit-lineage';

interface UseSequencePersistenceOptions {
  documentId: string;
  filePath: string;
  sequence: AnnotatedSequence | null;

  readOnly?: boolean;
  onSaveComplete: (
    publication?: SequenceDocumentSavePublication
  ) => Promise<SequenceDocumentSaveCompletion>;
  getCommitMessage?: () => string;
  onExternalReload: () => void;
  persistPendingPrimerBindings?: PersistSequenceDocumentOptions['persistPendingPrimerBindings'];
}

interface UseSequencePersistenceResult {
  isDirty: boolean;
  isSaving: boolean;

  save: SequenceDocumentSave;

  showExternalChangeToast: boolean;
  acceptExternalChange: () => void;
  dismissExternalChange: () => void;

  reloadFromDisk: () => Promise<void>;
}

export interface SequenceDocumentSave {
  (): Promise<boolean>;
  (requiredCapture: undefined, observation: SequenceSaveObservation): Promise<boolean>;
  (
    requiredCapture: SequenceSaveCapture,
    observation?: SequenceSaveObservation
  ): Promise<SequencePersistenceResult>;
}

function savePermissionDenied(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false;
  const code = 'code' in failure ? failure.code : null;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return true;
  return /^(?:Error invoking remote method 'fs:(?:sequenceDocument|saveSequenceDocument)': )?(?:(?:NativeDocumentCommandError|Error): )?(?:SEQUENCE_SAVE_FAILED: )?(?:EACCES|EPERM|EROFS)(?=:|$)/u.test(
    failure.message
  );
}

function saveLocationChanged(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false;
  if ('code' in failure && failure.code === 'SEQUENCE_DOCUMENT_BINDING_CHANGED') return true;
  return /^(?:Error invoking remote method 'fs:(?:sequenceDocument|saveSequenceDocument)': )?(?:(?:NativeDocumentCommandError|Error): )?SEQUENCE_DOCUMENT_BINDING_CHANGED(?=:|$)/u.test(
    failure.message
  );
}

export function useSequencePersistence({
  documentId,
  filePath,
  sequence: _sequence,
  readOnly = false,
  onSaveComplete,
  getCommitMessage,
  onExternalReload,
  persistPendingPrimerBindings,
}: UseSequencePersistenceOptions): UseSequencePersistenceResult {
  const isDirty = useSequenceStore((state) => state.dirtyPaths[documentId] === true);
  useEffect(
    () =>
      registerWorkspaceEditorBlocker(() => ({
        entityId: documentId,
        path: filePath,
        state: useSequenceStore.getState().isDirty(documentId) ? 'dirty' : 'clean',
      })),
    [documentId, filePath, readOnly]
  );

  const saveErrorToastIdRef = useRef<string | null>(null);
  const [savesInFlight, setSavesInFlight] = useState(0);

  useEffect(() => {
    if (!isDirty && saveErrorToastIdRef.current) {
      useToastStore.getState().removeToast(saveErrorToastIdRef.current);
      saveErrorToastIdRef.current = null;
    }
  }, [isDirty]);

  const {
    showExternalChangeToast,
    acceptExternalChange,
    dismissExternalChange,
    suppressNextChange,
    reloadFromDisk,
  } = useFileWatcher({
    filePath,
    documentId,
    isDirty,
    onReload: onExternalReload,
  });

  const save = useMemo(() => {
    function saveDocument(): Promise<boolean>;
    function saveDocument(
      requiredCapture: undefined,
      observation: SequenceSaveObservation
    ): Promise<boolean>;
    function saveDocument(
      requiredCapture: SequenceSaveCapture,
      observation?: SequenceSaveObservation
    ): Promise<SequencePersistenceResult>;
    async function saveDocument(
      requiredCapture?: SequenceSaveCapture,
      observation?: SequenceSaveObservation
    ): Promise<boolean | SequencePersistenceResult> {
      setSavesInFlight((count) => count + 1);
      const { persistence: result } = await saveSequenceDocumentWithCompletion({
        kind: 'write',
        observation,
        document: { documentId, sourcePath: filePath },
        requiredCapture,
        readOnly,
        beforeWrite: suppressNextChange,
        commitMessage: getCommitMessage?.(),
        complete: onSaveComplete,
        persistPendingPrimerBindings,
      }).finally(() => setSavesInFlight((count) => count - 1));

      if (result.ok) {
        if (result.outcome === 'saved') {
          if (saveErrorToastIdRef.current) {
            useToastStore.getState().removeToast(saveErrorToastIdRef.current);
            saveErrorToastIdRef.current = null;
          }
          console.log('[useSequencePersistence] Saved:', filePath);
        }
        return requiredCapture ? result : !useSequenceStore.getState().isDirty(documentId);
      }

      if (result.error.code === 'racing_edits') {
        console.warn(
          `[useSequencePersistence] Save remained dirty after ${result.attempts} attempts:`,
          filePath
        );
        return requiredCapture ? result : false;
      }

      const failure = result.error.cause;
      const name = filePath.split(/[\\/]/).filter(Boolean).pop() || 'sequence';
      const toastStore = useToastStore.getState();
      if (saveErrorToastIdRef.current) toastStore.removeToast(saveErrorToastIdRef.current);

      if (result.error.code === 'accepted_pending') {
        saveErrorToastIdRef.current = toastStore.addToast(
          toUserMessage(failure, 'document.saveRefreshPending'),
          {
            definition:
              'use-sequence-persistence-failed-to-save-example-example-error-your-changes-are-still-in-memory-but-were',
          }
        );
        return requiredCapture ? result : false;
      }

      if (result.error.code === 'primer_bindings_failed') {
        console.error('[useSequencePersistence] Primer binding transfer failed:', failure);
        saveErrorToastIdRef.current = toastStore.addToast(
          userMessageWithValues(
            'notice.value-was-saved-but-copied-primer-bindings-could-not-be-attached-save-',
            { value0: userMessageValue(name) }
          ),
          {
            definition:
              'use-sequence-persistence-example-was-written-but-copied-primer-bindings-were-not-attached-example-erro',
          }
        );
        return requiredCapture ? result : false;
      }

      console.error('[useSequencePersistence] Save did not complete:', failure);
      saveErrorToastIdRef.current = toastStore.addToast(
        result.error.code === 'completion_failed'
          ? userMessageWithValues('document.savedUpdateFailed', { name: userMessageValue(name) })
          : result.error.code === 'write_receipt_failed'
            ? userMessageWithValues('document.savedVerificationFailed', {
                name: userMessageValue(name),
              })
            : result.error.code === 'write_failed' && saveLocationChanged(failure)
              ? userMessageWithValues('document.saveLocationChanged', {
                  name: userMessageValue(name),
                })
              : result.error.code === 'write_failed' && savePermissionDenied(failure)
                ? userMessageWithValues('document.savePermissionDenied', {
                    name: userMessageValue(name),
                  })
                : userMessageWithValues(
                    'notice.couldn-t-save-value-your-changes-are-still-open-try-saving-again-or-di',
                    { value0: userMessageValue(name) }
                  ),
        {
          definition:
            'use-sequence-persistence-failed-to-save-example-example-error-your-changes-are-still-in-memory-but-were',
        }
      );
      return requiredCapture ? result : false;
    }
    return saveDocument;
  }, [
    documentId,
    filePath,
    onSaveComplete,
    getCommitMessage,
    persistPendingPrimerBindings,
    readOnly,
    suppressNextChange,
  ]);

  useEffect(
    () => registerSequenceSave(documentId, filePath, readOnly, () => save()),
    [documentId, filePath, readOnly, save]
  );

  return {
    isDirty,
    isSaving: savesInFlight > 0,
    save,
    showExternalChangeToast,
    acceptExternalChange,
    dismissExternalChange,
    reloadFromDisk,
  };
}
