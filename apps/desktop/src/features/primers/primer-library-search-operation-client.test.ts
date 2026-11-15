// @vitest-environment node

import type {
  OperationSnapshot,
  PrimerLibrarySearchRequest,
  PrimerLibrarySearchResult,
} from '@waypoint/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startPrimerLibrarySearchOperationOperationsPrimerLibrarySearchPost } from '@waypoint/api-client';
import { managedOperations } from '../../services/managed-operations';
import {
  startPrimerLibrarySearchOperation,
  waitForPrimerLibrarySearchResult,
} from './primer-library-search-operation-client';

vi.mock('@waypoint/api-client', () => ({
  startPrimerLibrarySearchOperationOperationsPrimerLibrarySearchPost: vi.fn(),
}));

vi.mock('../../services/managed-operations', () => ({
  managedOperations: {
    startRegisteredOperation: vi.fn(),
    waitForTerminal: vi.fn(),
    getResult: vi.fn(),
  },
}));

const SNAPSHOT: OperationSnapshot = {
  actor_id: 'local-human',
  actor_kind: 'human',
  cancellation_availability: 'available',
  cancellation_mode: 'queued_only',
  channel: 'desktop_ui',
  created_at: 1,
  id: 'primer-library-search-operation-1',
  kind: 'primer-library-search',
  kind_contract_version: 1,
  owner_instance_id: 'owner-1',
  state: 'queued',
  subject: {
    scope_id: 'workspace-a',
    subject_id: 'primer-library-search-target-v1:sha256:subject',
    input_revision: 'primer-library-search-v1:sha256:revision',
  },
  updated_at: 1,
  version: 1,
};

const INPUT: PrimerLibrarySearchRequest = {
  targetDocumentId: 'document-a',
  referenceSequence: 'target-one',
  circular: false,
  primers: [{ id: 'primer-a', sequence: 'primer-one', revision: 'updated-at:1' }],
  maxEditDistance: 3,
  minMatchLength: 0,
  minEffectiveTm: 0,
  maxMismatches: 10,
};

const RESULT: PrimerLibrarySearchResult = {
  targetRevision: `primer-search-target-v1:sha256:${'a'.repeat(64)}`,
  libraryRevision: `primer-library-v1:sha256:${'b'.repeat(64)}`,
  results: [
    {
      primerId: 'primer-a',
      hits: [
        {
          start: 10,
          end: 20,
          strand: 1,
          identity: 1,
          edit_distance: 0,
          mismatch_positions: [],
          three_prime_match_length: 10,
          effective_tm: 52,
        },
      ],
    },
  ],
};

describe('primer library search operation client', () => {
  beforeEach(() => {
    vi.mocked(managedOperations.startRegisteredOperation)
      .mockReset()
      .mockImplementation((start, submissionKey) =>
        start({
          apiClient: { options: (options: RequestInit = {}) => options },
          scopeId: 'workspace-a',
          submissionKey: submissionKey ?? 'submission-1',
        })
      );
    vi.mocked(managedOperations.waitForTerminal)
      .mockReset()
      .mockResolvedValue({
        ...SNAPSHOT,
        state: 'succeeded',
        result_status: 'available',
        cancellation_availability: 'already_settled',
        version: 2,
      });
    vi.mocked(managedOperations.getResult).mockReset().mockResolvedValue({
      operation_id: SNAPSHOT.id,
      kind: 'primer-library-search',
      result_schema_version: 1,
      status: 'available',
      result: RESULT,
    });
    vi.mocked(startPrimerLibrarySearchOperationOperationsPrimerLibrarySearchPost)
      .mockReset()
      .mockResolvedValue({ data: SNAPSHOT, status: 202, headers: new Headers() });
  });

  it('submits the exact request through the shared runtime owner', async () => {
    await expect(startPrimerLibrarySearchOperation(INPUT)).resolves.toEqual(SNAPSHOT);
    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledOnce();
    expect(startPrimerLibrarySearchOperationOperationsPrimerLibrarySearchPost).toHaveBeenCalledWith(
      {
        submission_key: 'submission-1',
        subject: { scope_id: 'workspace-a' },
        input: INPUT,
      },
      {}
    );
  });

  it('binds the saved target file and the expected account when the runtime accepts inputs', async () => {
    const accepted = {
      workspace_id: 'workspace-a',
      version_id: 'version-a',
      manifest_sha256: 'c'.repeat(64),
      files: [
        {
          key: 'target',
          resource_id: 'resource-a',
          path: 'sequences/a/a.gb',
          content_sha256: 'd'.repeat(64),
          size_bytes: 100,
        },
      ],
    };
    vi.mocked(managedOperations.startRegisteredOperation).mockImplementation(
      (start, submissionKey) =>
        start({
          apiClient: { options: (options: RequestInit = {}) => options },
          scopeId: 'workspace-a',
          submissionKey: submissionKey ?? 'submission-1',
          acceptedWorkspaceInput: accepted,
          expectedAccountId: 'account-a',
        })
    );
    const inputFiles = [{ key: 'target', path: '/hosted/workspace-a/sequences/a/a.gb' }];

    await expect(startPrimerLibrarySearchOperation(INPUT, inputFiles)).resolves.toEqual(SNAPSHOT);

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      inputFiles
    );
    expect(startPrimerLibrarySearchOperationOperationsPrimerLibrarySearchPost).toHaveBeenCalledWith(
      {
        submission_key: 'submission-1',
        subject: { scope_id: 'workspace-a', accepted_workspace_input: accepted },
        input: INPUT,
      },
      { headers: { 'X-DNAForge-Account-ID': 'account-a' } }
    );
  });

  it('detaches this observer with its signal and reads the retained typed result', async () => {
    const controller = new AbortController();

    await expect(
      waitForPrimerLibrarySearchResult(SNAPSHOT.id, { signal: controller.signal })
    ).resolves.toEqual(RESULT);

    expect(managedOperations.waitForTerminal).toHaveBeenCalledWith(SNAPSHOT.id, {
      timeoutMs: 30 * 60_000,
      signal: controller.signal,
    });
    expect(managedOperations.getResult).toHaveBeenCalledExactlyOnceWith(SNAPSHOT.id);
  });

  it('rejects malformed retained hits instead of silently treating them as no matches', async () => {
    vi.mocked(managedOperations.getResult).mockResolvedValue({
      operation_id: SNAPSHOT.id,
      kind: 'primer-library-search',
      result_schema_version: 1,
      status: 'available',
      result: {
        ...RESULT,
        results: [{ primerId: 'primer-a', hits: [{ ...RESULT.results[0].hits[0], start: null }] }],
      },
    } as never);

    await expect(waitForPrimerLibrarySearchResult(SNAPSHOT.id)).rejects.toThrow(
      'invalid primer-library search result'
    );
  });
});
