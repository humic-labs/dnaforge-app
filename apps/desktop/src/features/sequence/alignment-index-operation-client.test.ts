// @vitest-environment node

import type { AlignmentIndexResult, OperationSnapshot } from '@waypoint/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startAlignmentIndexPreparationOperationOperationsAlignmentIndexPreparationPost } from '@waypoint/api-client';
import { managedOperations } from '../../services/managed-operations';
import {
  startAlignmentIndexOperation,
  waitForAlignmentIndexResult,
} from './alignment-index-operation-client';

vi.mock('@waypoint/api-client', () => ({
  startAlignmentIndexPreparationOperationOperationsAlignmentIndexPreparationPost: vi.fn(),
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
  cancellation_availability: 'unavailable',
  cancellation_mode: 'queued_only',
  channel: 'desktop_ui',
  created_at: 1,
  id: 'alignment-index-operation-1',
  kind: 'alignment-index-preparation',
  kind_contract_version: 1,
  owner_instance_id: 'owner-1',
  state: 'queued',
  subject: {
    scope_id: 'workspace-a',
    subject_id: 'aligned-read-file-v1:sha256:subject',
    input_revision: 'alignment-index-v1:sha256:revision',
  },
  updated_at: 1,
  version: 1,
};

const RESULT: AlignmentIndexResult = {
  format: 'bam',
  state: 'created',
  indexPath: '/data/sample.bam.bai',
};

describe('alignment index operation client', () => {
  beforeEach(() => {
    vi.mocked(managedOperations.startRegisteredOperation)
      .mockReset()
      .mockImplementation((start) =>
        start({
          apiClient: { options: (options: RequestInit = {}) => options },
          scopeId: 'workspace-a',
          submissionKey: 'submission-1',
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
      kind: 'alignment-index-preparation',
      result_schema_version: 1,
      status: 'available',
      result: RESULT,
    });
    vi.mocked(startAlignmentIndexPreparationOperationOperationsAlignmentIndexPreparationPost)
      .mockReset()
      .mockResolvedValue({ data: SNAPSHOT, status: 202, headers: new Headers() });
  });

  it('returns the durable operation identity immediately from the generated route', async () => {
    await expect(startAlignmentIndexOperation({ bamPath: '/data/sample.bam' })).resolves.toEqual(
      SNAPSHOT
    );

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledOnce();
    expect(
      startAlignmentIndexPreparationOperationOperationsAlignmentIndexPreparationPost
    ).toHaveBeenCalledWith(
      {
        submission_key: 'submission-1',
        subject: { scope_id: 'workspace-a' },
        input: { bamPath: '/data/sample.bam' },
      },
      {}
    );
  });

  it('waits on the shared operation stream and reads the matching retained result', async () => {
    const controller = new AbortController();
    await expect(
      waitForAlignmentIndexResult(SNAPSHOT.id, { signal: controller.signal })
    ).resolves.toEqual(RESULT);

    expect(managedOperations.waitForTerminal).toHaveBeenCalledWith(SNAPSHOT.id, {
      timeoutMs: 30 * 60_000,
      signal: controller.signal,
    });
    expect(managedOperations.getResult).toHaveBeenCalledExactlyOnceWith(SNAPSHOT.id);
  });

  it('reports the owned operation failure without requesting a nonexistent result', async () => {
    vi.mocked(managedOperations.waitForTerminal).mockResolvedValue({
      ...SNAPSHOT,
      state: 'failed',
      error: { code: 'ALIGNMENT_INDEX_INVALID_SOURCE', message: 'The BAM is not sorted.' },
      cancellation_availability: 'already_settled',
      version: 2,
    });

    await expect(waitForAlignmentIndexResult(SNAPSHOT.id)).rejects.toThrow(
      'The BAM is not sorted.'
    );
    expect(managedOperations.getResult).not.toHaveBeenCalled();
  });

  it('rejects a result envelope for a different operation identity', async () => {
    vi.mocked(managedOperations.getResult).mockResolvedValue({
      operation_id: 'another-operation',
      kind: 'alignment-index-preparation',
      result_schema_version: 1,
      status: 'available',
      result: RESULT,
    });

    await expect(waitForAlignmentIndexResult(SNAPSHOT.id)).rejects.toThrow(
      'invalid alignment-index result'
    );
  });
});
