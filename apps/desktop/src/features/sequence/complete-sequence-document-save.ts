import { useVerificationStore } from '../alignment-manager/public/store';
import type {
  SequenceDocumentSavePublication,
  SequenceDocumentWriteReceipt,
} from '../../shared/sequence-edit-lineage';
import { recordSequenceHistoryResult } from './sequence-history-recovery';
import { rememberSequenceWrite, sequenceArtifactCorrelation } from './sequence-activity';
import {
  completeSavedSequenceDocument,
  SequenceDocumentSaveProjectionError,
  type SavedSequenceDocument,
  type SequenceDocumentSaveCompletion,
} from '../../services/sequence-document-save-completion';
import {
  persistSequenceDocument,
  type PersistSequenceDocumentOptions,
  type SequencePersistenceResult,
} from './persist-sequence-document';
import { useSequenceStore, type SequenceSaveCapture } from './store';
import { beginWorkflowAction, type WorkflowResultMetadata } from '../../lib/workflow-telemetry';
import type { RecordHistoryStatus } from '../../shared/scientific-workflow-vocab';

export type SequenceSaveObservation =
  | { kind: 'direct' }
  | { kind: 'annotation'; parentActionId?: string };

export type SequenceSavePublication =
  | { status: 'not-attempted' }
  | { status: 'completed'; completion: SequenceDocumentSaveCompletion }
  | {
      status: 'projection-failed';
      completion: SequenceDocumentSaveCompletion;
      error: SequenceDocumentSaveProjectionError;
    }
  | { status: 'unconfirmed'; error: unknown };

type SequenceSaveCommandOptions = Omit<
  PersistSequenceDocumentOptions,
  'onPersisted' | 'requiredCapture'
> & {
  complete: (
    publication?: SequenceDocumentSavePublication
  ) => Promise<SequenceDocumentSaveCompletion>;
  observation?: SequenceSaveObservation;
} & (
    | { kind: 'write'; requiredCapture?: SequenceSaveCapture }
    | { kind: 'annotation-apply'; requiredCapture: SequenceSaveCapture }
  );

export interface SequenceSaveCommandResult {
  persistence: SequencePersistenceResult;
  publication: SequenceSavePublication;
}

const ordinarySaves = new Map<string, Promise<SequenceSaveCommandResult>>();

export function saveSequenceDocumentWithCompletion(
  options: SequenceSaveCommandOptions
): Promise<SequenceSaveCommandResult> {
  if (
    options.kind !== 'write' ||
    options.requiredCapture ||
    options.observation?.kind === 'annotation'
  )
    return runSequenceDocumentSave(options);
  const documentId = options.document.documentId;
  const existing = ordinarySaves.get(documentId);
  if (existing) return existing;
  const pending = runSequenceDocumentSave(options).finally(() => {
    if (ordinarySaves.get(documentId) === pending) ordinarySaves.delete(documentId);
  });
  ordinarySaves.set(documentId, pending);
  return pending;
}

async function runSequenceDocumentSave({
  kind,
  complete,
  observation = { kind: 'direct' },
  ...options
}: SequenceSaveCommandOptions): Promise<SequenceSaveCommandResult> {
  const capturedRevision =
    options.requiredCapture?.revision ??
    useSequenceStore.getState().getVersion(options.document.documentId);
  const operationId = crypto.randomUUID();
  const operation = beginWorkflowAction({
    workflow: 'content',
    action: 'save',
    operationId,
    capturedRevision,
    artifactCorrelationId: sequenceArtifactCorrelation(options.document.documentId),
    workflowOrigin: observation.kind === 'annotation' ? 'projection' : 'direct',
    ...(observation.kind === 'annotation' && observation.parentActionId !== undefined
      ? { parentActionId: observation.parentActionId }
      : {}),
  });
  const publicationState: {
    pending?: Promise<SequenceSavePublication>;
    receipt?: SequenceDocumentWriteReceipt;
  } = {};
  const publish = (
    nativePublication?: SequenceDocumentSavePublication
  ): Promise<SequenceSavePublication> => {
    publicationState.pending ??= (async (): Promise<SequenceSavePublication> => {
      const receipt = nativePublication?.history?.receipt;
      publicationState.receipt = receipt;
      const state = useSequenceStore.getState();
      const sequence = state.savedSequences[options.document.documentId];
      if (receipt && sequence)
        rememberSequenceWrite(
          options.document.documentId,
          operationId,
          state.savedVersions[options.document.documentId] ?? 0,
          sequence,
          receipt
        );
      try {
        return { status: 'completed', completion: await complete(nativePublication) };
      } catch (error) {
        if (error instanceof SequenceDocumentSaveProjectionError)
          return { status: 'projection-failed', completion: error.completion, error };
        return { status: 'unconfirmed', error };
      }
    })();
    return publicationState.pending;
  };
  try {
    const persistence = await persistSequenceDocument({
      ...options,
      ...(kind === 'write'
        ? {
            onPersisted: async (nativePublication) => {
              const publication = await publish(nativePublication);
              if (
                publication.status === 'projection-failed' ||
                publication.status === 'unconfirmed'
              )
                throw publication.error;
            },
          }
        : {}),
    });
    if (
      kind === 'annotation-apply' &&
      persistence.ok &&
      persistence.outcome === 'saved' &&
      persistence.wrote
    )
      await publish();
    const publication: SequenceSavePublication = publicationState.pending
      ? await publicationState.pending
      : { status: 'not-attempted' };
    const publicationFailed =
      publication.status === 'projection-failed' || publication.status === 'unconfirmed';
    const current = useSequenceStore.getState();
    const dirty = current.isDirty(options.document.documentId);
    const acknowledgedRevision = current.savedVersions[options.document.documentId] ?? 0;
    const metadata: WorkflowResultMetadata = {
      attemptCount: persistence.attempts,
      wrote: persistence.wrote,
      dirty,
      capturedRevision,
      acknowledgedRevision,
      revisionRelation: persistence.wrote
        ? acknowledgedRevision < persistence.writtenRevision
          ? 'written_pending_ack'
          : dirty
            ? 'newer_dirty'
            : 'acknowledged'
        : persistence.ok
          ? 'unchanged'
          : 'not_acknowledged',
      ...(publicationState.receipt
        ? { nativeActionId: publicationState.receipt.nativeActionId }
        : {}),
      recordWriteStatus: persistence.wrote
        ? 'written'
        : persistence.ok
          ? 'existing'
          : 'unconfirmed',
      recordHistoryStatus: sequenceSaveHistoryStatus(publication),
      recordProjectionStatus:
        publication.status === 'completed'
          ? 'ready'
          : publication.status === 'projection-failed'
            ? 'failed'
            : publication.status === 'unconfirmed'
              ? 'unconfirmed'
              : 'not_attempted',
      ...(persistence.wrote ? { stateRevision: persistence.writtenRevision } : {}),
      valueDelivered: persistence.ok && persistence.wrote && !publicationFailed,
    };
    if (!persistence.ok || publicationFailed) {
      operation.fail(persistence.ok ? 'completion_failed' : persistence.error.code, {
        ...metadata,
        status: 'failed',
      });
    } else {
      operation.complete({
        ...metadata,
        status: persistence.outcome === 'saved' ? 'saved' : 'success',
        outcomeKind: persistence.outcome,
      });
    }
    return { persistence, publication };
  } catch (error) {
    operation.fail('sequence_save_unconfirmed', {
      status: 'failed',
      recordWriteStatus: 'unconfirmed',
      recordHistoryStatus: 'unconfirmed',
      recordProjectionStatus: 'unconfirmed',
      valueDelivered: false,
    });
    throw error;
  }
}

function sequenceSaveHistoryStatus(publication: SequenceSavePublication): RecordHistoryStatus {
  if (publication.status === 'not-attempted') return 'not_attempted';
  if (publication.status === 'unconfirmed') return 'unconfirmed';
  switch (publication.completion.status) {
    case 'committed':
      return 'committed';
    case 'not-a-repository':
      return 'not_applicable';
    case 'commit-failed':
      return 'failed';
  }
}

export type {
  SavedSequenceDocument,
  SequenceDocumentSaveCompletion,
} from '../../services/sequence-document-save-completion';

export async function completeSequenceDocumentSave(
  document: SavedSequenceDocument,
  message: string,
  publication?: SequenceDocumentSavePublication | SequenceDocumentWriteReceipt
): Promise<SequenceDocumentSaveCompletion> {
  const receipt =
    publication && 'nativeActionId' in publication ? publication : publication?.history?.receipt;
  try {
    const completion = await completeSavedSequenceDocument(
      document,
      message,
      (documentId) => useVerificationStore.getState().checkStaleness(documentId),
      publication
    );
    if (receipt) recordSequenceHistoryResult({ ...document, ...receipt, message }, completion);
    return completion;
  } catch (error) {
    if (receipt && error instanceof SequenceDocumentSaveProjectionError)
      recordSequenceHistoryResult(
        { ...document, ...receipt, message },
        { ...error.completion, delivery: 'pending' }
      );
    throw error;
  }
}
