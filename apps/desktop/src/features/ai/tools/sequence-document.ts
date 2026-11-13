export { nativeSequenceDocumentOutputSchema as sequenceDocumentOutputSchema } from './native-document-output-schemas';
import { sequenceDocumentAgentRequestSchema } from '../../../shared/sequence-document';
import { NativeDocumentCommandError } from '../../../shared/native-document-error';
import { platform } from '../../../platform';
import { isDesktopRuntime } from '../../../utils/environment';
import { flushFileDocumentClients } from '../../workspace/public/file-document-client';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import { useCanvasStore } from '../../canvas/public/store';
import { useSequenceStore } from '../../sequence/public/store';
import {
  applySequenceEditCommand,
  inspectSequenceEditState,
} from '../../sequence/public/sequence-edit-command';
import { persistSequenceDocument } from '../../sequence/public/persist-sequence-document';
import { completeSequenceDocumentSave } from '../../sequence/public/complete-sequence-document-save';
import { loadSequenceDocumentBiologyFile } from './path-utils';
import { ensureSequenceIdentity } from '../../../db';
import { persistRichPastePrimerBindings } from '../../sequence-clipboard/public/persist-primer-bindings';

export const sequenceDocumentSchema = sequenceDocumentAgentRequestSchema;

export function createSequenceDocumentTool(folders: WorkspaceFolder[]) {
  if (isDesktopRuntime())
    return resultTool({
      description:
        'Inspect and edit a native sequence working copy by stable catalog identity without opening a tab. Typed bases and annotation operations share native undo history and an immutable captured save with the human editor. Inspect first and pass expectedVersion on edits. Bases use zero-based half-open ranges; annotation coordinates are one-based inclusive. Save uses the existing format and sequence package writer, verifies source authority and preserves later edits. Source format capabilities and retained recovery are explicit.',
      inputSchema: sequenceDocumentSchema,
      execute: async (request) => {
        let attempted = false;
        try {
          await flushFileDocumentClients();
          attempted = request.operation.kind !== 'inspect';
          const { copy, ...snapshot } = await platform().fs.sequenceDocument({
            ...request,
            projection: 'inspection',
          });
          return toolSuccess({
            ...snapshot,
            nextMutationInput: snapshot.readOnly
              ? null
              : { documentId: snapshot.documentId, expectedVersion: snapshot.version },
            ...(request.operation.kind === 'save'
              ? { outcome: snapshot.saved ? 'saved' : 'unchanged' }
              : {}),
          });
        } catch (error) {
          if (error instanceof NativeDocumentCommandError)
            return toolFailure({
              code: error.code,
              error: error.message,
              retriable: false,
              stateChanged: error.stateChanged,
              partialEffects: [...error.partialEffects],
            });
          return toolFailure({
            code: 'SEQUENCE_DOCUMENT_FAILED',
            error: error instanceof Error ? error.message : String(error),
            retriable: false,
            stateChanged: attempted ? 'unknown' : false,
            partialEffects: [],
          });
        }
      },
    });
  return resultTool({
    description:
      'Inspect or edit an existing sequence and its annotations through the human editor. One typed operation per call. Inspect returns revision, dirty/undo state, bounded bases and annotation indices. Edits stay in the shared draft until save; save writes native history. Base ranges are zero-based half-open; annotations are one-based inclusive. Every write requires the observed expectedVersion. Undo/redo operate on the same history as the human editor.',
    inputSchema: sequenceDocumentSchema,
    execute: async ({ documentId: inputId, expectedVersion, operation }) => {
      let writeAttempted = false;
      const failure = (code: string, error: string, stateChanged: boolean | 'unknown' = false) =>
        toolFailure({ code, error, retriable: false, stateChanged, partialEffects: [] });
      try {
        const loaded = await loadSequenceDocumentBiologyFile(inputId, folders);
        const { documentId, sourcePath } = loaded;
        const nextMutationInput = (version: number) => ({ documentId, expectedVersion: version });
        const folder = findContainingPathBoundary(folders, sourcePath);
        if (!folder)
          return failure('OUTSIDE_WORKSPACE', 'This document is outside the mounted workspace.');
        const readOnly =
          Boolean(folder.pinned) ||
          Object.values(useCanvasStore.getState().panels).some((panel) =>
            panel.tabs.some(
              (tab) => tab.type === 'sequence' && tab.entityId === documentId && tab.readOnly
            )
          );
        if (operation.kind !== 'inspect' && readOnly)
          return failure(
            'READ_ONLY_SEQUENCE',
            'This source is read-only. Import an editable copy first.'
          );
        if (!useSequenceStore.getState().hasSequence(documentId)) {
          useSequenceStore.getState().setSequence(documentId, loaded.biology.sequence);
        }
        const state = inspectSequenceEditState(documentId);
        if (operation.kind === 'inspect') {
          const { sequence, annotations, ...summary } = state;
          if (operation.start > sequence.length)
            return failure('INVALID_RANGE', 'The requested start is beyond the current sequence.');
          return toolSuccess({
            ...summary,
            readOnly,
            nextMutationInput: readOnly ? null : nextMutationInput(state.version),
            bases: {
              start: operation.start,
              end: Math.min(sequence.length, operation.start + operation.limit),
              text: sequence.slice(operation.start, operation.start + operation.limit),
            },
            annotations: annotations
              .slice(
                operation.annotationOffset,
                operation.annotationOffset + operation.annotationLimit
              )
              .map((annotation, offset) => ({
                index: operation.annotationOffset + offset,
                ...annotation,
              })),
            annotationCount: annotations.length,
            nextAnnotationOffset:
              operation.annotationOffset + operation.annotationLimit < annotations.length
                ? operation.annotationOffset + operation.annotationLimit
                : null,
          });
        }
        if (expectedVersion === undefined || state.version !== expectedVersion) {
          return failure(
            'STALE_SEQUENCE',
            'Inspect the current sequence and supply its expectedVersion before changing it.'
          );
        }
        if (operation.kind === 'reload' || operation.kind === 'restore-recovery')
          return failure(
            'SEQUENCE_OPERATION_UNSUPPORTED',
            'This operation requires the native document owner.'
          );
        if (operation.kind !== 'save') {
          const edited = applySequenceEditCommand({ documentId, expectedVersion, operation });
          return edited.ok
            ? { ...edited, nextMutationInput: nextMutationInput(edited.version) }
            : edited;
        }
        if (!state.dirty)
          return toolSuccess({
            documentId,
            version: state.version,
            nextMutationInput: nextMutationInput(state.version),
            saved: false,
            outcome: 'unchanged',
            dirty: false,
          });
        let history: Awaited<ReturnType<typeof completeSequenceDocumentSave>> | undefined;
        writeAttempted = true;
        const persisted = await persistSequenceDocument({
          document: { documentId, sourcePath },
          requiredCapture: useSequenceStore.getState().captureForSave(documentId)!,
          beforeWrite: () => {
            if (useSequenceStore.getState().getVersion(documentId) !== expectedVersion) {
              throw new Error(
                'The document changed while saving. Newer edits remain in the draft.'
              );
            }
          },
          onPersisted: async () => {
            history = await completeSequenceDocumentSave(
              { documentId, sourcePath },
              operation.message
            );
          },
          persistPendingPrimerBindings: async (bindings, context) => {
            const sequence = useSequenceStore.getState().sequences[documentId];
            const sequenceId = await ensureSequenceIdentity(
              documentId,
              sourcePath,
              sequence.name ?? 'Unknown',
              sequence.length,
              Boolean(sequence.circular),
              folder.path
            );
            await persistRichPastePrimerBindings({
              bindings,
              draftLineageId: context.draftLineageId,
              expectedFileSha256: context.expectedFileSha256,
              targetDocumentId: documentId,
              targetFilePath: sourcePath,
              targetSequenceId: sequenceId,
              targetWorkspaceRoot: folder.path,
            });
          },
        });
        if (!persisted.ok)
          return failure(
            'SEQUENCE_SAVE_FAILED',
            persisted.error.message,
            persisted.wrote ? true : 'unknown'
          );
        if (history?.status === 'commit-failed')
          return toolFailure({
            code: 'SEQUENCE_HISTORY_FAILED',
            error: 'The sequence bytes were saved, but the Git history commit failed.',
            retriable: false,
            stateChanged: true,
            partialEffects: [{ documentId, saved: true }],
          });
        const savedVersion = useSequenceStore.getState().getVersion(documentId);
        return toolSuccess({
          documentId,
          version: savedVersion,
          nextMutationInput: nextMutationInput(savedVersion),
          saved: persisted.wrote,
          outcome: persisted.outcome,
          history: history?.status,
          dirty: useSequenceStore.getState().isDirty(documentId),
        });
      } catch (error) {
        return failure(
          'SEQUENCE_DOCUMENT_FAILED',
          error instanceof Error ? error.message : String(error),
          writeAttempted ? 'unknown' : false
        );
      }
    },
  });
}
