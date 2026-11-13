import {
  startPairwiseSessionAlignmentOperationOperationsPairwiseSessionAlignmentPost,
  type OperationSnapshot,
  type PairwiseSessionAlignmentRequest,
  type PairwiseSessionAlignmentResult,
} from '@waypoint/api-client';

import {
  managedOperations,
  type ManagedOperationInputFile,
} from '../../services/managed-operations';

const OPERATION_KIND = 'pairwise-session-alignment';
const OPERATION_WAIT_TIMEOUT_MS = 30 * 60_000;

export interface PairwiseSessionOperationIdentity {
  readonly id: string;
  readonly inputRevision: string;
}

export interface PairwiseSessionOperationWaitOptions {
  readonly signal?: AbortSignal;
}

export async function startPairwiseSessionAlignmentOperation(
  documentId: string,
  sessionId: string,
  input: PairwiseSessionAlignmentRequest,
  inputFiles: readonly ManagedOperationInputFile[] = []
): Promise<OperationSnapshot> {
  return managedOperations.startRegisteredOperation(
    async ({ scopeId, submissionKey, acceptedWorkspaceInput, expectedAccountId }) => {
      const response =
        await startPairwiseSessionAlignmentOperationOperationsPairwiseSessionAlignmentPost(
          {
            submission_key: submissionKey,
            subject: {
              scope_id: scopeId,
              document_id: documentId,
              session_id: sessionId,
              ...(acceptedWorkspaceInput
                ? { accepted_workspace_input: acceptedWorkspaceInput }
                : {}),
            },
            input,
          },
          acceptedWorkspaceInput
            ? { headers: { 'X-DNAForge-Account-ID': expectedAccountId! } }
            : undefined
        );
      if (response.status !== 202) {
        throw new Error(response.data.detail.message);
      }
      if (response.data.kind !== OPERATION_KIND || response.data.subject.scope_id !== scopeId) {
        throw new Error('The operation owner returned an invalid pairwise session job.');
      }
      return response.data;
    },
    undefined,
    inputFiles
  );
}

export function pairwiseSessionOperationIdentity(
  operation: OperationSnapshot
): PairwiseSessionOperationIdentity {
  if (operation.kind !== OPERATION_KIND) {
    throw new Error('The operation owner returned an invalid pairwise session job.');
  }
  return {
    id: operation.id,
    inputRevision: operation.subject.input_revision,
  };
}

export async function waitForPairwiseSessionAlignmentResult(
  operation: OperationSnapshot | PairwiseSessionOperationIdentity,
  options: PairwiseSessionOperationWaitOptions = {}
): Promise<PairwiseSessionAlignmentResult> {
  const identity =
    'inputRevision' in operation ? operation : pairwiseSessionOperationIdentity(operation);
  const terminal = await managedOperations.waitForTerminal(identity.id, {
    timeoutMs: OPERATION_WAIT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (terminal.kind !== OPERATION_KIND || terminal.id !== identity.id) {
    throw new Error('The operation owner returned an invalid pairwise session job.');
  }
  if (terminal.subject.input_revision !== identity.inputRevision) {
    throw new Error('The operation owner returned a different pairwise session revision.');
  }
  if (terminal.state !== 'succeeded') {
    throw new PairwiseSessionOperationError(
      terminal.state,
      terminal.error?.message ??
        (terminal.state === 'canceled'
          ? 'Pairwise session alignment was canceled.'
          : terminal.state === 'interrupted'
            ? 'Pairwise session alignment was interrupted.'
            : 'Pairwise session alignment failed.')
    );
  }

  const envelope = await managedOperations.getResult(identity.id);
  if (
    envelope.kind !== OPERATION_KIND ||
    envelope.operation_id !== identity.id ||
    envelope.status !== 'available' ||
    !isPairwiseSessionAlignmentResult(envelope.result, envelope.result_schema_version)
  ) {
    throw new Error('The operation owner returned an invalid pairwise session result.');
  }
  if (envelope.result.inputRevision !== identity.inputRevision) {
    throw new Error('The operation owner returned a different pairwise session revision.');
  }
  return envelope.result;
}

export async function stopPairwiseSessionAlignmentOperation(
  operationId: string
): Promise<OperationSnapshot> {
  const response = await managedOperations.requestCancel(operationId);
  if (response.snapshot.id !== operationId || response.snapshot.kind !== OPERATION_KIND) {
    throw new Error('The operation owner returned an invalid pairwise session job.');
  }
  const terminal = await managedOperations.waitForTerminal(operationId, {
    timeoutMs: OPERATION_WAIT_TIMEOUT_MS,
  });
  if (terminal.id !== operationId || terminal.kind !== OPERATION_KIND) {
    throw new Error('The operation owner returned an invalid pairwise session job.');
  }
  return terminal;
}

export class PairwiseSessionOperationError extends Error {
  constructor(
    readonly operationState: OperationSnapshot['state'],
    message: string
  ) {
    super(message);
    this.name = 'PairwiseSessionOperationError';
  }
}

export function isPairwiseSessionAlignmentResult(
  value: unknown,
  resultSchemaVersion = 1
): value is PairwiseSessionAlignmentResult {
  if (!isRecord(value)) return false;
  return (
    isRevision(value.inputRevision, 'pairwise-session-alignment-v1') &&
    isRevision(value.referenceRevision, 'pairwise-reference-v1') &&
    (resultSchemaVersion === 1
      ? value.tool === undefined || value.tool === null || isPairwiseToolIdentity(value.tool)
      : resultSchemaVersion === 2 && isPairwiseToolIdentity(value.tool)) &&
    Array.isArray(value.results) &&
    value.results.length > 0 &&
    value.results.every((row) => {
      if (!isRecord(row) || !isRecord(row.alignment)) return false;
      const alignment = row.alignment;
      return (
        typeof row.queryId === 'string' &&
        row.queryId.length > 0 &&
        isRevision(row.queryRevision, 'pairwise-query-v1') &&
        typeof alignment.aligned_query === 'string' &&
        typeof alignment.aligned_reference === 'string' &&
        isFiniteNumber(alignment.identity) &&
        isFiniteNumber(alignment.alignment_length) &&
        (alignment.mutations === undefined || Array.isArray(alignment.mutations))
      );
    })
  );
}

function isPairwiseToolIdentity(value: unknown): boolean {
  if (!isRecord(value) || value.name !== 'MAFFT' || typeof value.version !== 'string') {
    return false;
  }
  return (
    value.version.length <= 128 &&
    value.version === value.version.trim() &&
    /^[\x20-\x7E]+$/.test(value.version) &&
    /^v?[0-9]+\.[0-9]+(?:\.[0-9]+)?(?: \([ -~]+\))?$/.test(value.version)
  );
}

function isRevision(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}:sha256:[0-9a-f]{64}$`).test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
