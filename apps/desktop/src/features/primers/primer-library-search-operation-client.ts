import {
  startPrimerLibrarySearchOperationOperationsPrimerLibrarySearchPost,
  type OperationSnapshot,
  type PrimerLibrarySearchRequest,
  type PrimerLibrarySearchResult,
} from '@waypoint/api-client';

import {
  managedOperations,
  type ManagedOperationInputFile,
} from '../../services/managed-operations';

const OPERATION_KIND = 'primer-library-search';

export interface PrimerLibrarySearchWaitOptions {
  readonly signal?: AbortSignal;
}

export async function startPrimerLibrarySearchOperation(
  input: PrimerLibrarySearchRequest,
  inputFiles: readonly ManagedOperationInputFile[] = []
): Promise<OperationSnapshot> {
  return managedOperations.startRegisteredOperation(
    async ({ apiClient, scopeId, submissionKey, acceptedWorkspaceInput, expectedAccountId }) => {
      const response = await startPrimerLibrarySearchOperationOperationsPrimerLibrarySearchPost(
        {
          submission_key: submissionKey,
          subject: {
            scope_id: scopeId,
            ...(acceptedWorkspaceInput ? { accepted_workspace_input: acceptedWorkspaceInput } : {}),
          },
          input,
        },
        apiClient.options(
          acceptedWorkspaceInput
            ? { headers: { 'X-DNAForge-Account-ID': expectedAccountId! } }
            : undefined
        )
      );
      if (response.status !== 202) {
        throw new Error(response.data.detail.message);
      }
      if (response.data.kind !== OPERATION_KIND || response.data.subject.scope_id !== scopeId) {
        throw new Error('The operation owner returned an invalid primer-library search job.');
      }
      return response.data;
    },
    undefined,
    inputFiles
  );
}

export async function waitForPrimerLibrarySearchResult(
  operationId: string,
  options: PrimerLibrarySearchWaitOptions = {}
): Promise<PrimerLibrarySearchResult> {
  const terminal = await managedOperations.waitForTerminal(operationId, {
    timeoutMs: 30 * 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (terminal.kind !== OPERATION_KIND || terminal.id !== operationId) {
    throw new Error('The operation owner returned an invalid primer-library search job.');
  }
  if (terminal.state !== 'succeeded') {
    throw new Error(
      terminal.error?.message ??
        (terminal.state === 'canceled'
          ? 'Primer library search was canceled.'
          : terminal.state === 'interrupted'
            ? 'Primer library search was interrupted.'
            : 'Primer library search failed.')
    );
  }

  const envelope = await managedOperations.getResult(operationId);
  if (
    envelope.kind !== OPERATION_KIND ||
    envelope.operation_id !== operationId ||
    envelope.status !== 'available' ||
    !isPrimerLibrarySearchResult(envelope.result)
  ) {
    throw new Error('The operation owner returned an invalid primer-library search result.');
  }
  return envelope.result;
}

function isPrimerLibrarySearchResult(value: unknown): value is PrimerLibrarySearchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.targetRevision === 'string' &&
    /^primer-search-target-v1:sha256:[0-9a-f]{64}$/.test(result.targetRevision) &&
    typeof result.libraryRevision === 'string' &&
    /^primer-library-v1:sha256:[0-9a-f]{64}$/.test(result.libraryRevision) &&
    Array.isArray(result.results) &&
    result.results.every(isPrimerResult)
  );
}

function isPrimerResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.primerId === 'string' && Array.isArray(row.hits) && row.hits.every(isBindingHit)
  );
}

function isBindingHit(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hit = value as Record<string, unknown>;
  return (
    isFiniteNumber(hit.start) &&
    isFiniteNumber(hit.end) &&
    isFiniteNumber(hit.strand) &&
    isFiniteNumber(hit.identity) &&
    isFiniteNumber(hit.edit_distance) &&
    (hit.mismatch_positions === undefined || isNumberArray(hit.mismatch_positions)) &&
    (hit.three_prime_match_length === undefined || isFiniteNumber(hit.three_prime_match_length)) &&
    (hit.effective_tm === undefined || isFiniteNumber(hit.effective_tm))
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}
