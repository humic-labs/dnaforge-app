import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { platform } from '../../platform';
import { observeWorkflowAction } from '../../lib/workflow-telemetry';
import type { SequenceDocumentWriteReceipt } from '../../shared/sequence-edit-lineage';
import { annotationTargetDocumentRevision } from '../../shared/annotation-target-document-revision';

const artifacts = new Map<string, string>();
const saved = new Map<
  string,
  {
    operationId: string;
    stateRevision: number;
    revision: Promise<string | null>;
    receipt: SequenceDocumentWriteReceipt;
    reopened: boolean;
  }
>();

export function sequenceArtifactCorrelation(documentId: string): string {
  let value = artifacts.get(documentId);
  if (!value) {
    value = crypto.randomUUID();
    artifacts.set(documentId, value);
  }
  return value;
}

export function rememberSequenceWrite(
  documentId: string,
  operationId: string,
  stateRevision: number,
  sequence: AnnotatedSequence,
  receipt: SequenceDocumentWriteReceipt
): void {
  saved.set(documentId, {
    operationId,
    stateRevision,
    revision: annotationTargetDocumentRevision(sequence).catch(() => null),
    receipt,
    reopened: false,
  });
}

export function sequenceWriteOperation(
  documentId: string,
  nativeActionId: string
): string | undefined {
  const last = saved.get(documentId);
  return last?.receipt.nativeActionId === nativeActionId ? last.operationId : undefined;
}

export function observeSequenceEdit(
  documentId: string,
  action: 'update' | 'undo' | 'redo' | 'revert',
  stateRevision: number,
  changed: boolean
): void {
  observeWorkflowAction({
    workflow: 'content',
    action,
    status: changed ? 'updated' : 'success',
    artifactCorrelationId: sequenceArtifactCorrelation(documentId),
    stateRevision,
    affectedCount: changed ? 1 : 0,
    outcomeKind: !changed
      ? 'unchanged'
      : action === 'undo'
        ? 'undone'
        : action === 'redo'
          ? 'redone'
          : action === 'revert'
            ? 'discarded'
            : 'edited',
    valueDelivered: false,
    usableResult: false,
  });
}

export async function observeSequenceSavedReopen(
  documentId: string,
  sourcePath: string,
  sequence: AnnotatedSequence
): Promise<void> {
  const last = saved.get(documentId);
  if (!last || last.reopened) return;
  try {
    const expectedRevision = await last.revision;
    if (
      !expectedRevision ||
      (await annotationTargetDocumentRevision(sequence)) !== expectedRevision
    )
      return;
    const hash = await platform().fs.sha256File(sourcePath);
    if (saved.get(documentId) !== last || hash !== `sha256:${last.receipt.contentSha256}`) return;
    last.reopened = true;
    observeWorkflowAction({
      workflow: 'content',
      action: 'open',
      status: 'viewed',
      operationId: last.operationId,
      nativeActionId: last.receipt.nativeActionId,
      artifactCorrelationId: sequenceArtifactCorrelation(documentId),
      stateRevision: last.stateRevision,
      outcomeKind: 'reopened_confirmed',
      valueDelivered: false,
      usableResult: false,
    });
  } catch {}
}
