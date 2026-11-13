import { create } from 'zustand';
import { platform } from '../../platform';
import { beginWorkflowAction } from '../../lib/workflow-telemetry';
import type { SequenceDocumentHistoryInput } from '../../shared/sequence-edit-lineage';
import type { SequenceDocumentSaveCompletion } from '../../services/sequence-document-save-completion';
import { refreshSavedSequenceSession } from '../../services/sequence-document-save-completion';
import { sequenceArtifactCorrelation, sequenceWriteOperation } from './sequence-activity';
import { resolveSequenceDocumentById } from './sequence-document-repository';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { registerAcknowledgedSequenceReadProof } from '../../services/acknowledged-sequence-read';

type Recovery = {
  status: 'pending' | 'retrying' | 'revision-changed' | 'unavailable' | 'delivery-pending';
  input: SequenceDocumentHistoryInput;
  artifactCorrelationId: string;
};
export const useSequenceHistoryRecovery = create<{ documents: Record<string, Recovery> }>(() => ({
  documents: {},
}));
const retries = new Map<string, Promise<void>>();

async function canReadAcknowledgedSequence(sourcePath: string): Promise<boolean> {
  const candidates = Object.values(useSequenceHistoryRecovery.getState().documents).filter(
    (entry) =>
      entry.status === 'pending' ||
      entry.status === 'retrying' ||
      entry.status === 'delivery-pending'
  );
  if (candidates.length === 0) return false;
  try {
    const fs = platform().fs;
    const target = await fs.canonicalPath(sourcePath);
    for (const recovery of candidates) {
      if ((await fs.canonicalPath(recovery.input.sourcePath)) !== target) continue;
      const document = await resolveSequenceDocumentById(
        recovery.input.documentId,
        useWorkspaceStore.getState().folders.map((folder) => folder.path)
      );
      if (
        document.documentId !== recovery.input.documentId ||
        (await fs.canonicalPath(document.sourcePath)) !== target
      )
        continue;
      if ((await fs.sha256File(document.sourcePath)) !== `sha256:${recovery.input.contentSha256}`)
        continue;
      return useSequenceHistoryRecovery.getState().documents[document.documentId] === recovery;
    }
  } catch {}
  return false;
}

registerAcknowledgedSequenceReadProof(canReadAcknowledgedSequence);

export function refreshSequenceHistoryDisplay(documentId: string): Promise<void> {
  const recovery = useSequenceHistoryRecovery.getState().documents[documentId];
  if (recovery?.status !== 'delivery-pending') return Promise.resolve();
  const key = `${recovery.input.nativeActionId}:display`;
  const pending = retries.get(key);
  if (pending) return pending;
  const run = refreshSavedSequenceSession(recovery.input)
    .then(() => {
      useSequenceHistoryRecovery.setState((state) => {
        const current = state.documents[documentId];
        if (
          current?.input.nativeActionId !== recovery.input.nativeActionId ||
          current.status !== 'delivery-pending'
        )
          return state;
        const documents = { ...state.documents };
        delete documents[documentId];
        return { documents };
      });
      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-reconciled', {
          detail: { path: recovery.input.sourcePath },
        })
      );
    })
    .catch(() => {})
    .finally(() => retries.delete(key));
  retries.set(key, run);
  return run;
}

export function recordSequenceHistoryResult(
  input: SequenceDocumentHistoryInput,
  completion: SequenceDocumentSaveCompletion
): void {
  useSequenceHistoryRecovery.setState((state) => {
    const documents = { ...state.documents };
    if (completion.status === 'committed' && !completion.delivery)
      delete documents[input.documentId];
    else
      documents[input.documentId] = {
        input,
        artifactCorrelationId: sequenceArtifactCorrelation(input.documentId),
        status:
          completion.status === 'committed'
            ? 'delivery-pending'
            : completion.status === 'not-a-repository'
              ? 'unavailable'
              : completion.historyStatus === 'revision-changed'
                ? 'revision-changed'
                : completion.historyStatus === 'unavailable'
                  ? 'unavailable'
                  : 'pending',
      };
    return { documents };
  });
}

export function retrySequenceHistory(documentId: string): Promise<void> {
  const recovery = useSequenceHistoryRecovery.getState().documents[documentId];
  if (
    !recovery ||
    recovery.status === 'unavailable' ||
    recovery.status === 'revision-changed' ||
    recovery.status === 'delivery-pending'
  )
    return Promise.resolve();
  const key = recovery.input.nativeActionId;
  const pending = retries.get(key);
  if (pending) return pending;
  const operation = beginWorkflowAction({
    workflow: 'content',
    action: 'commit',
    operationId: sequenceWriteOperation(documentId, key) ?? key,
    artifactCorrelationId: recovery.artifactCorrelationId,
  });
  const publish = (next: Recovery | null): void => {
    useSequenceHistoryRecovery.setState((state) => {
      if (state.documents[documentId]?.input.nativeActionId !== key) return state;
      const documents = { ...state.documents };
      if (next) documents[documentId] = next;
      else delete documents[documentId];
      return { documents };
    });
  };
  publish({ ...recovery, status: 'retrying' });
  const run = (async () => {
    try {
      const result = await platform().fs.commitSequenceDocumentHistory(recovery.input);
      const metadata = {
        nativeActionId: result.nativeActionId,
        valueDelivered: false,
        usableResult: false,
      };
      if (result.status === 'committed' || result.status === 'already-committed') {
        operation.complete({ ...metadata, status: 'saved', outcomeKind: 'history_committed' });
        try {
          await refreshSavedSequenceSession(recovery.input);
          publish(null);
          window.dispatchEvent(
            new CustomEvent('waypoint:workspace-reconciled', {
              detail: { path: recovery.input.sourcePath },
            })
          );
        } catch {
          publish({ ...recovery, status: 'delivery-pending' });
        }
      } else {
        const status =
          result.status === 'revision-changed'
            ? 'revision-changed'
            : result.status === 'not-a-repository' || result.status === 'unavailable'
              ? 'unavailable'
              : 'pending';
        operation.fail('filesystem', {
          ...metadata,
          status: 'needs_action',
          outcomeKind:
            status === 'revision-changed'
              ? 'revision_changed'
              : status === 'unavailable'
                ? 'history_unavailable'
                : 'history_pending',
        });
        publish({ ...recovery, status });
      }
    } catch {
      operation.fail('filesystem', {
        status: 'needs_action',
        outcomeKind: 'history_pending',
        valueDelivered: false,
        usableResult: false,
      });
      publish({ ...recovery, status: 'pending' });
    } finally {
      retries.delete(key);
    }
  })();
  retries.set(key, run);
  return run;
}
