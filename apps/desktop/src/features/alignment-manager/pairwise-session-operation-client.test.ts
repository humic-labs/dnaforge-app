// @vitest-environment node

import type {
  OperationSnapshot,
  PairwiseSessionAlignmentRequest,
  PairwiseSessionAlignmentResult,
} from '@waypoint/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startPairwiseSessionAlignmentOperationOperationsPairwiseSessionAlignmentPost } from '@waypoint/api-client';
import { managedOperations } from '../../services/managed-operations';
import {
  startPairwiseSessionAlignmentOperation,
  stopPairwiseSessionAlignmentOperation,
  isPairwiseSessionAlignmentResult,
  waitForPairwiseSessionAlignmentResult,
} from './pairwise-session-operation-client';

vi.mock('@waypoint/api-client', () => ({
  startPairwiseSessionAlignmentOperationOperationsPairwiseSessionAlignmentPost: vi.fn(),
}));

vi.mock('../../services/managed-operations', () => ({
  managedOperations: {
    startRegisteredOperation: vi.fn(),
    waitForTerminal: vi.fn(),
    getResult: vi.fn(),
    requestCancel: vi.fn(),
  },
}));

const INPUT_REVISION = `pairwise-session-alignment-v1:sha256:${'a'.repeat(64)}`;
const QUERY_REVISION = `pairwise-query-v1:sha256:${'b'.repeat(64)}`;

const SNAPSHOT: OperationSnapshot = {
  actor_id: 'local-human',
  actor_kind: 'human',
  cancellation_availability: 'available',
  cancellation_mode: 'cooperative',
  channel: 'desktop_ui',
  created_at: 1,
  id: 'pairwise-session-operation-1',
  kind: 'pairwise-session-alignment',
  kind_contract_version: 1,
  owner_instance_id: 'owner-1',
  state: 'running',
  subject: {
    scope_id: 'workspace-a',
    subject_id: `pairwise-session-alignment-subject-v1:sha256:${'c'.repeat(64)}`,
    input_revision: INPUT_REVISION,
  },
  updated_at: 1,
  version: 1,
};

const INPUT: PairwiseSessionAlignmentRequest = {
  referenceSequence: 'N'.repeat(20),
  queries: [{ id: 'query-one', sequence: 'N'.repeat(20) }],
  algorithm: 'auto',
  threads: 2,
  timeoutSeconds: 120,
  isCircular: false,
};

const RESULT: PairwiseSessionAlignmentResult = {
  inputRevision: INPUT_REVISION,
  referenceRevision: `pairwise-reference-v1:sha256:${'d'.repeat(64)}`,
  results: [
    {
      queryId: 'query-one',
      queryRevision: QUERY_REVISION,
      alignment: {
        aligned_query: 'N'.repeat(20),
        aligned_reference: 'N'.repeat(20),
        identity: 100,
        matches: 20,
        mismatches: 0,
        gaps: 0,
        alignment_length: 20,
        query_length: 20,
        reference_length: 20,
        mutations: [],
      },
    },
  ],
};

describe('pairwise session alignment operation client', () => {
  beforeEach(() => {
    vi.mocked(managedOperations.startRegisteredOperation)
      .mockReset()
      .mockImplementation((start, submissionKey) =>
        start({ scopeId: 'workspace-a', submissionKey: submissionKey ?? 'submission-1' })
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
      kind: 'pairwise-session-alignment',
      result_schema_version: 1,
      status: 'available',
      result: RESULT,
    });
    vi.mocked(managedOperations.requestCancel)
      .mockReset()
      .mockResolvedValue({
        snapshot: { ...SNAPSHOT, state: 'stopping', version: 2 },
        disposition: 'accepted',
        reason: 'Cancellation requested.',
      });
    vi.mocked(startPairwiseSessionAlignmentOperationOperationsPairwiseSessionAlignmentPost)
      .mockReset()
      .mockResolvedValue({ data: SNAPSHOT, status: 202, headers: new Headers() });
  });

  it('submits one document/session batch through the generated operation route', async () => {
    await expect(
      startPairwiseSessionAlignmentOperation('document-a', 'session-a', INPUT)
    ).resolves.toEqual(SNAPSHOT);

    expect(
      startPairwiseSessionAlignmentOperationOperationsPairwiseSessionAlignmentPost
    ).toHaveBeenCalledWith(
      {
        submission_key: 'submission-1',
        subject: {
          scope_id: 'workspace-a',
          document_id: 'document-a',
          session_id: 'session-a',
        },
        input: INPUT,
      },
      undefined
    );
  });

  it('reads only the retained result for the admitted revision', async () => {
    await expect(waitForPairwiseSessionAlignmentResult(SNAPSHOT)).resolves.toEqual(RESULT);
    expect(managedOperations.waitForTerminal).toHaveBeenCalledWith(SNAPSHOT.id, {
      timeoutMs: 30 * 60_000,
    });
    expect(managedOperations.getResult).toHaveBeenCalledWith(SNAPSHOT.id);
  });

  it('preserves a validated owner tool identity in the complete retained result', async () => {
    const result = { ...RESULT, tool: { name: 'MAFFT', version: 'v7.526 (2024/Apr/26)' } };
    vi.mocked(managedOperations.getResult).mockResolvedValue({
      operation_id: SNAPSHOT.id,
      kind: 'pairwise-session-alignment',
      result_schema_version: 1,
      status: 'available',
      result,
    });
    await expect(waitForPairwiseSessionAlignmentResult(SNAPSHOT)).resolves.toEqual(result);
  });

  it('requires tool identity for schema 2 while retaining legacy results without invention', () => {
    expect(isPairwiseSessionAlignmentResult(RESULT, 1)).toBe(true);
    expect(isPairwiseSessionAlignmentResult(RESULT, 2)).toBe(false);
    expect(isPairwiseSessionAlignmentResult({ ...RESULT, tool: null }, 2)).toBe(false);
    expect(
      isPairwiseSessionAlignmentResult(
        {
          ...RESULT,
          tool: { name: 'MAFFT', version: 'v7.526 (2024/Apr/26)' },
        },
        2
      )
    ).toBe(true);
    expect(isPairwiseSessionAlignmentResult(RESULT, 3)).toBe(false);
  });

  it.each([undefined, null])('rejects a schema 2 wait envelope with tool %j', async (tool) => {
    const envelope = JSON.parse(
      JSON.stringify({
        operation_id: SNAPSHOT.id,
        kind: 'pairwise-session-alignment',
        result_schema_version: 2,
        status: 'available',
        result: { ...RESULT, tool },
      })
    ) as Awaited<ReturnType<typeof managedOperations.getResult>>;
    vi.mocked(managedOperations.getResult).mockResolvedValue(envelope);
    await expect(waitForPairwiseSessionAlignmentResult(SNAPSHOT)).rejects.toThrow(
      'invalid pairwise session result'
    );
  });

  it.each([
    { name: 'Railway', version: 'v7.526' },
    { name: 'MAFFT', version: 'unknown' },
    { name: 'MAFFT', version: 'Railway account help' },
    { name: 'MAFFT', version: '' },
    { name: 'MAFFT', version: ' v7.526' },
    { name: 'MAFFT', version: 'v7.526\nhelp' },
    { name: 'MAFFT', version: 7526 },
  ])('rejects malformed present tool identity: %j', async (tool) => {
    const result = { ...RESULT, tool };
    vi.mocked(managedOperations.getResult).mockResolvedValue({
      operation_id: SNAPSHOT.id,
      kind: 'pairwise-session-alignment',
      result_schema_version: 1,
      status: 'available',
      result,
    });
    await expect(waitForPairwiseSessionAlignmentResult(SNAPSHOT)).rejects.toThrow(
      'invalid pairwise session result'
    );
  });

  it('rejects a retained result for a different revision', async () => {
    vi.mocked(managedOperations.getResult).mockResolvedValue({
      operation_id: SNAPSHOT.id,
      kind: 'pairwise-session-alignment',
      result_schema_version: 1,
      status: 'available',
      result: {
        ...RESULT,
        inputRevision: `pairwise-session-alignment-v1:sha256:${'e'.repeat(64)}`,
      },
    } as never);

    await expect(waitForPairwiseSessionAlignmentResult(SNAPSHOT)).rejects.toThrow(
      'different pairwise session revision'
    );
  });

  it('routes Stop through the owner and waits for physical settlement', async () => {
    vi.mocked(managedOperations.waitForTerminal).mockResolvedValue({
      ...SNAPSHOT,
      state: 'canceled',
      cancellation_availability: 'already_settled',
      version: 3,
    });

    await expect(stopPairwiseSessionAlignmentOperation(SNAPSHOT.id)).resolves.toMatchObject({
      id: SNAPSHOT.id,
      state: 'canceled',
    });
    expect(managedOperations.requestCancel).toHaveBeenCalledWith(SNAPSHOT.id);
    expect(managedOperations.waitForTerminal).toHaveBeenCalledWith(SNAPSHOT.id, {
      timeoutMs: 30 * 60_000,
    });
  });

  it('rejects a Stop settlement for a different operation kind', async () => {
    vi.mocked(managedOperations.waitForTerminal).mockResolvedValue({
      ...SNAPSHOT,
      kind: 'msa',
      state: 'canceled',
      cancellation_availability: 'already_settled',
      version: 3,
    });

    await expect(stopPairwiseSessionAlignmentOperation(SNAPSHOT.id)).rejects.toThrow(
      'invalid pairwise session job'
    );
  });
});
