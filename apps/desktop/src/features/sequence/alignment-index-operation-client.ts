import {
  startAlignmentIndexPreparationOperationOperationsAlignmentIndexPreparationPost,
  type AlignmentIndexRequest,
  type AlignmentIndexResult,
  type OperationSnapshot,
} from '@waypoint/api-client';

import { managedOperations } from '../../services/managed-operations';

const OPERATION_KIND = 'alignment-index-preparation';
const INDEX_WAIT_TIMEOUT_MS = 30 * 60_000;

export interface AlignmentIndexWaitOptions {
  readonly signal?: AbortSignal;
}

export async function startAlignmentIndexOperation(
  input: AlignmentIndexRequest
): Promise<OperationSnapshot> {
  return managedOperations.startRegisteredOperation(async ({ scopeId, submissionKey }) => {
    const response =
      await startAlignmentIndexPreparationOperationOperationsAlignmentIndexPreparationPost({
        submission_key: submissionKey,
        subject: { scope_id: scopeId },
        input,
      });
    if (response.status !== 202) {
      throw new Error(response.data.detail.message);
    }
    if (response.data.kind !== OPERATION_KIND || response.data.subject.scope_id !== scopeId) {
      throw new Error('The operation owner returned an invalid alignment-index job.');
    }
    return response.data;
  });
}

export async function waitForAlignmentIndexResult(
  operationId: string,
  options: AlignmentIndexWaitOptions = {}
): Promise<AlignmentIndexResult> {
  const terminal = await managedOperations.waitForTerminal(operationId, {
    timeoutMs: INDEX_WAIT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (terminal.kind !== OPERATION_KIND || terminal.id !== operationId) {
    throw new Error('The operation owner returned an invalid alignment-index job.');
  }
  if (terminal.state !== 'succeeded') {
    throw new Error(
      terminal.error?.message ??
        (terminal.state === 'canceled'
          ? 'Alignment index preparation was canceled.'
          : terminal.state === 'interrupted'
            ? 'Alignment index preparation was interrupted.'
            : 'Alignment index preparation failed.')
    );
  }

  const envelope = await managedOperations.getResult(operationId);
  if (
    envelope.kind !== OPERATION_KIND ||
    envelope.operation_id !== operationId ||
    envelope.status !== 'available' ||
    !isAlignmentIndexResult(envelope.result)
  ) {
    throw new Error('The operation owner returned an invalid alignment-index result.');
  }
  return envelope.result;
}

function isAlignmentIndexResult(value: unknown): value is AlignmentIndexResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AlignmentIndexResult>;
  return (
    (candidate.format === 'bam' || candidate.format === 'cram') &&
    (candidate.state === 'present' || candidate.state === 'created') &&
    typeof candidate.indexPath === 'string' &&
    candidate.indexPath.trim().length > 0
  );
}
