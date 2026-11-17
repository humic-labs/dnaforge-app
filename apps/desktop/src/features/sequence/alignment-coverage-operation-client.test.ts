// @vitest-environment node

import type { OperationSnapshot } from '@waypoint/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startAlignmentCoverageOperation } from './alignment-coverage-operation-client';
import {
  managedOperations,
  type ManagedOperationRecord,
  type ManagedOperationsSnapshot,
} from '../../services/managed-operations';
import { startAlignmentCoveragePreparationOperationOperationsAlignmentCoveragePreparationPost } from '@waypoint/api-client';

vi.mock('@waypoint/api-client', () => ({
  startAlignmentCoveragePreparationOperationOperationsAlignmentCoveragePreparationPost: vi.fn(),
}));

vi.mock('../../services/managed-operations', () => ({
  managedOperations: { startRegisteredOperation: vi.fn(), getSnapshot: vi.fn() },
}));

const SNAPSHOT: OperationSnapshot = {
  actor_id: 'local-human',
  actor_kind: 'human',
  cancellation_availability: 'available',
  cancellation_mode: 'queued_only',
  channel: 'desktop_ui',
  created_at: 1,
  id: 'coverage-operation-1',
  kind: 'alignment-coverage-preparation',
  kind_contract_version: 1,
  owner_instance_id: 'owner-1',
  state: 'queued',
  subject: {
    scope_id: 'workspace-a',
    subject_id: 'aligned-read-source-v1:sha256:subject',
    input_revision: 'alignment-coverage-v1:sha256:revision',
  },
  updated_at: 1,
  version: 1,
};

const INPUT = {
  assemblyId: 'grch38',
  bamPath: '/data/sample.bam',
  indexPath: '/data/sample.bam.bai',
  chroms: ['chr1', 'chr2'],
  sourceGeneration: {
    contract: 'aligned-read-source-generation.v1' as const,
    alignment: {
      canonicalPath: '/data/sample.bam',
      size: 20,
      mtimeNs: '1',
      ctimeNs: '2',
    },
    index: {
      canonicalPath: '/data/sample.bam.bai',
      size: 10,
      mtimeNs: '3',
      ctimeNs: '4',
    },
  },
};

let records: ManagedOperationRecord[] = [];
let submissions = 0;

function inputWithMtime(mtimeNs: string) {
  return {
    ...INPUT,
    sourceGeneration: {
      ...INPUT.sourceGeneration,
      alignment: { ...INPUT.sourceGeneration.alignment, mtimeNs },
    },
  };
}

function record(snapshot: OperationSnapshot): ManagedOperationRecord {
  return { snapshot, observation: { freshness: 'current', observedAtMs: 1 } };
}

function operationsSnapshot(): ManagedOperationsSnapshot {
  return {
    status: 'connected',
    scopeId: 'workspace-a',
    ownerId: null,
    ownerInstanceId: 'owner-1',
    records,
    historySummary: null,
    supportedActionsByKind: {},
    kindCatalogByKind: {},
    reconnectAvailable: false,
  };
}

function settle(
  id: string,
  state: OperationSnapshot['state'],
  resultStatus?: OperationSnapshot['result_status']
) {
  records = records.map((entry) =>
    entry.snapshot.id === id
      ? record({
          ...entry.snapshot,
          state,
          ...(resultStatus ? { result_status: resultStatus } : {}),
        })
      : entry
  );
}

describe('startAlignmentCoverageOperation', () => {
  beforeEach(() => {
    records = [];
    submissions = 0;
    vi.mocked(managedOperations.getSnapshot).mockReset().mockImplementation(operationsSnapshot);
    vi.mocked(managedOperations.startRegisteredOperation)
      .mockReset()
      .mockImplementation(async (start) => {
        submissions += 1;
        const snapshot = await start({
          apiClient: { options: (options: RequestInit = {}) => options },
          scopeId: 'workspace-a',
          submissionKey: `submission-${submissions}`,
        });
        records = [...records, record(snapshot)];
        return snapshot;
      });
    vi.mocked(startAlignmentCoveragePreparationOperationOperationsAlignmentCoveragePreparationPost)
      .mockReset()
      .mockImplementation(async () => ({
        data: { ...SNAPSHOT, id: `coverage-operation-${submissions}` },
        status: 202,
        headers: new Headers(),
      }));
  });

  it('submits the generated typed contract through the shared runtime owner', async () => {
    await expect(startAlignmentCoverageOperation(inputWithMtime('10'))).resolves.toEqual(SNAPSHOT);

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledOnce();
    expect(
      startAlignmentCoveragePreparationOperationOperationsAlignmentCoveragePreparationPost
    ).toHaveBeenCalledWith(
      {
        submission_key: 'submission-1',
        subject: { scope_id: 'workspace-a' },
        input: inputWithMtime('10'),
      },
      {}
    );
  });

  it('rejects a response that is not the admitted coverage kind', async () => {
    vi.mocked(
      startAlignmentCoveragePreparationOperationOperationsAlignmentCoveragePreparationPost
    ).mockResolvedValue({
      data: { ...SNAPSHOT, kind: 'annotation' },
      status: 202,
      headers: new Headers(),
    });

    await expect(startAlignmentCoverageOperation(inputWithMtime('11'))).rejects.toThrow(
      'invalid alignment-coverage job'
    );
  });

  it(' starts one coverage job when attach and restore request the same BAM together', async () => {
    const attach = inputWithMtime('20');
    const { referencePath: _omitted, ...attachRequest } = { ...attach, referencePath: undefined };
    const restoreRequest = { ...attach, referencePath: undefined };

    const [fromAttach, fromRestore] = await Promise.all([
      startAlignmentCoverageOperation(attachRequest),
      startAlignmentCoverageOperation(restoreRequest),
    ]);

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledOnce();
    expect(fromRestore.id).toBe(fromAttach.id);
  });

  it('reuses a running coverage job for the same source generation', async () => {
    const input = inputWithMtime('25');
    const first = await startAlignmentCoverageOperation(input);
    settle(first.id, 'running');

    const second = await startAlignmentCoverageOperation(input);

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledOnce();
    expect(second).toMatchObject({ id: first.id, state: 'running' });
  });

  it('reuses a succeeded coverage job while its result is still available', async () => {
    const input = inputWithMtime('30');
    const first = await startAlignmentCoverageOperation(input);
    settle(first.id, 'succeeded', 'available');

    const second = await startAlignmentCoverageOperation(input);

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledOnce();
    expect(second).toMatchObject({ id: first.id, state: 'succeeded' });
  });

  it.each(['released', 'expired', 'none'] as const)(
    'starts a new job once the succeeded result is %s',
    async (resultStatus) => {
      const input = inputWithMtime(`3${resultStatus.length}`);
      const first = await startAlignmentCoverageOperation(input);
      settle(first.id, 'succeeded', resultStatus);

      const second = await startAlignmentCoverageOperation(input);

      expect(managedOperations.startRegisteredOperation).toHaveBeenCalledTimes(2);
      expect(second.id).not.toBe(first.id);
    }
  );

  it('starts a new job when the earlier job dropped out of the operation records', async () => {
    const input = inputWithMtime('35');
    const first = await startAlignmentCoverageOperation(input);
    records = records.filter((entry) => entry.snapshot.id !== first.id);

    const second = await startAlignmentCoverageOperation(input);

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledTimes(2);
    expect(second.id).not.toBe(first.id);
  });

  it('starts a new job after the earlier one failed', async () => {
    const input = inputWithMtime('40');
    const first = await startAlignmentCoverageOperation(input);
    settle(first.id, 'failed');

    const second = await startAlignmentCoverageOperation(input);

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledTimes(2);
    expect(second.id).not.toBe(first.id);
  });

  it('starts a separate job when the source generation changed', async () => {
    await startAlignmentCoverageOperation(inputWithMtime('50'));
    await startAlignmentCoverageOperation(inputWithMtime('51'));

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledTimes(2);
  });

  it('lets the next request submit again after a rejected start', async () => {
    const input = inputWithMtime('60');
    vi.mocked(managedOperations.startRegisteredOperation).mockRejectedValueOnce(
      new Error('owner changed')
    );

    await expect(startAlignmentCoverageOperation(input)).rejects.toThrow('owner changed');
    await startAlignmentCoverageOperation(input);

    expect(managedOperations.startRegisteredOperation).toHaveBeenCalledTimes(2);
  });
});
