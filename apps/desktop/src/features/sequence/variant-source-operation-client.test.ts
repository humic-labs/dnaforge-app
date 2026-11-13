// @vitest-environment node

import type { OperationSnapshot, VariantSourceResult } from '@waypoint/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startVariantSourcePreparationOperationOperationsVariantSourcePreparationPost } from '@waypoint/api-client';
import { managedOperations } from '../../services/managed-operations';
import {
  startVariantSourceOperation,
  waitForVariantSourceResult,
} from './variant-source-operation-client';

vi.mock('@waypoint/api-client', () => ({
  startVariantSourcePreparationOperationOperationsVariantSourcePreparationPost: vi.fn(),
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
  id: 'variant-source-operation-1',
  kind: 'variant-source-preparation',
  kind_contract_version: 1,
  owner_instance_id: 'owner-1',
  state: 'queued',
  subject: {
    scope_id: 'workspace-a',
    subject_id: 'variant-source-v1:sha256:subject',
    input_revision: 'variant-source-preparation-v1:sha256:revision',
  },
  updated_at: 1,
  version: 1,
};

const SOURCE_GENERATION = {
  canonicalPath: '/data/calls.vcf',
  size: 123,
  mtimeNs: '1',
  ctimeNs: '2',
  device: '3',
  inode: '4',
};

const RESULT: VariantSourceResult = {
  sourcePath: '/data/calls.vcf',
  queryPath: '/cache/calls.vcf.gz',
  indexPath: '/cache/calls.vcf.gz.tbi',
  format: 'vcf',
  label: 'calls.vcf',
  sourceSizeBytes: 123,
  sourceMtimeNs: '1',
  sourceIdentity: 'a'.repeat(64),
  sourceGeneration: SOURCE_GENERATION,
  queryGeneration: { ...SOURCE_GENERATION, canonicalPath: '/cache/calls.vcf.gz' },
  indexGeneration: { ...SOURCE_GENERATION, canonicalPath: '/cache/calls.vcf.gz.tbi' },
  assemblyRevision: `variant-assembly-v1:sha256:${'b'.repeat(64)}`,
  matchedReferences: ['chr1'],
  samples: ['sample'],
};

describe('variant source operation client', () => {
  beforeEach(() => {
    vi.mocked(managedOperations.startRegisteredOperation)
      .mockReset()
      .mockImplementation((start) =>
        start({ scopeId: 'workspace-a', submissionKey: 'submission-1' })
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
      kind: 'variant-source-preparation',
      result_schema_version: 1,
      status: 'available',
      result: RESULT,
    });
    vi.mocked(startVariantSourcePreparationOperationOperationsVariantSourcePreparationPost)
      .mockReset()
      .mockResolvedValue({ data: SNAPSHOT, status: 202, headers: new Headers() });
  });

  it('returns the durable operation identity before observing completion', async () => {
    await expect(
      startVariantSourceOperation({
        variantPath: '/data/calls.vcf',
        references: [{ name: 'chr1', length: 1_000 }],
      })
    ).resolves.toEqual(SNAPSHOT);

    expect(managedOperations.waitForTerminal).not.toHaveBeenCalled();
    expect(
      startVariantSourcePreparationOperationOperationsVariantSourcePreparationPost
    ).toHaveBeenCalledWith({
      submission_key: 'submission-1',
      subject: { scope_id: 'workspace-a' },
      input: {
        variantPath: '/data/calls.vcf',
        references: [{ name: 'chr1', length: 1_000 }],
      },
    });
  });

  it('detaches observation with the caller signal and reads the bound retained result', async () => {
    const controller = new AbortController();

    await expect(
      waitForVariantSourceResult(SNAPSHOT.id, { signal: controller.signal })
    ).resolves.toEqual(RESULT);

    expect(managedOperations.waitForTerminal).toHaveBeenCalledWith(SNAPSHOT.id, {
      timeoutMs: 30 * 60_000,
      signal: controller.signal,
    });
    expect(managedOperations.getResult).toHaveBeenCalledExactlyOnceWith(SNAPSHOT.id);
  });

  it('rejects a result without every admitted file and assembly generation', async () => {
    vi.mocked(managedOperations.getResult).mockResolvedValue({
      operation_id: SNAPSHOT.id,
      kind: 'variant-source-preparation',
      result_schema_version: 1,
      status: 'available',
      result: { ...RESULT, indexGeneration: undefined } as never,
    });

    await expect(waitForVariantSourceResult(SNAPSHOT.id)).rejects.toThrow(
      'invalid variant-source result'
    );
  });
});
