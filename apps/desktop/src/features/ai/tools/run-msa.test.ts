import { beforeEach, describe, expect, it, vi } from 'vitest';

const opsMock = vi.hoisted(() => ({ queryLimsEntities: vi.fn() }));
vi.mock('../../lims/operations', () => opsMock);

const seqMock = vi.hoisted(() => ({ resolveAminoAcidSequence: vi.fn() }));
vi.mock('../../lims/protein-sequence', () => seqMock);

import { createRunMsaTool as originalCreateRunMsaTool, projectRunMsaAuditResult } from './run-msa';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { runMsaOutputSchema } from './sequence-output-schemas';
const createRunMsaTool = checkedSequenceToolFactory(originalCreateRunMsaTool, runMsaOutputSchema);

import { execTool } from './test-helpers';
import type { LimsEntity } from '../../../shared/lims';

const tool = createRunMsaTool([], { subjectId: 'msa:action-1' });

function makeEntity(id: string, name: string): LimsEntity {
  return {
    id,
    kind: 'protein',
    schemaId: null,
    schemaRevisionId: 'rev-1',
    name,
    registryId: `aa-${id}`,
    fields: { sequence: {} },
    registrationStatus: 'registered',
    domainStatus: null,
    workspaceId: null,
    actor: null,
    eventSeq: 1,
    tombstone: false,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}

interface RunMsaPreparation {
  error?: string;
  subject_id?: string;
  input?: {
    sequences: Array<{ id: string; name: string; sequence: string }>;
    algorithm: string;
    threads: number;
    timeout_seconds: number;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('run_msa managed-operation preparation', () => {
  it('resolves registered proteins without running compute or writing an entity', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    opsMock.queryLimsEntities
      .mockResolvedValueOnce([makeEntity('p1', 'GFP')])
      .mockResolvedValueOnce([makeEntity('p2', 'GFP variant')]);
    seqMock.resolveAminoAcidSequence
      .mockResolvedValueOnce({ status: 'loaded', bases: 'MSKGEEL', length: 7 })
      .mockResolvedValueOnce({ status: 'loaded', bases: 'MSKGEEA', length: 7 });

    const result = await execTool<RunMsaPreparation>(tool, { proteinIds: ['p1', 'p2'] });

    expect(result).toEqual({
      ok: true,
      subject_id: 'msa:action-1',
      input: {
        sequences: [
          { id: 'p1', name: 'GFP', sequence: 'MSKGEEL' },
          { id: 'p2', name: 'GFP variant', sequence: 'MSKGEEA' },
        ],
        algorithm: 'auto',
        threads: 4,
        timeout_seconds: 600,
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('projects a sequence-free renderer audit while preserving the transport result', () => {
    const result: RunMsaPreparation = {
      subject_id: 'msa:action-1',
      input: {
        sequences: [
          { id: 'p1', name: 'GFP', sequence: 'MSKGEEL' },
          { id: 'p2', name: 'GFP variant', sequence: 'MSKGEEA' },
        ],
        algorithm: 'auto',
        threads: 4,
        timeout_seconds: 600,
      },
    };

    expect(projectRunMsaAuditResult(result)).toEqual({
      subject_id: 'msa:action-1',
      input: {
        sequence_count: 2,
        sequences: [
          { id: 'p1', sequence_length: 7 },
          { id: 'p2', sequence_length: 7 },
        ],
        algorithm: 'auto',
        threads: 4,
        timeout_seconds: 600,
      },
    });
    expect(JSON.stringify(result)).toContain('MSKGEEL');
    const auditProjection = JSON.stringify(projectRunMsaAuditResult(result));
    expect(auditProjection).not.toContain('MSKGEEL');
    expect(auditProjection).not.toContain('GFP variant');
    expect(projectRunMsaAuditResult('unexpected renderer output')).toEqual({});
  });

  it('rejects fewer than two distinct protein ids before reading LIMS', async () => {
    const result = await execTool<RunMsaPreparation>(tool, { proteinIds: ['p1', 'p1'] });
    expect(result.error).toMatch(/at least 2/i);
    expect(opsMock.queryLimsEntities).not.toHaveBeenCalled();
  });

  it('rejects a missing LIMS entity', async () => {
    opsMock.queryLimsEntities.mockResolvedValueOnce([]);
    const result = await execTool<RunMsaPreparation>(tool, {
      proteinIds: ['missing', 'p2'],
    });
    expect(result.error).toMatch(/no lims entity/i);
  });

  it('rejects a non-protein entity', async () => {
    opsMock.queryLimsEntities.mockResolvedValueOnce([
      { ...makeEntity('p1', 'pUC19'), kind: 'plasmid' },
    ]);
    const result = await execTool<RunMsaPreparation>(tool, { proteinIds: ['p1', 'p2'] });
    expect(result.error).toMatch(/not a protein/i);
  });

  it('rejects a protein without a sequence field', async () => {
    opsMock.queryLimsEntities.mockResolvedValueOnce([{ ...makeEntity('p1', 'GFP'), fields: {} }]);
    const result = await execTool<RunMsaPreparation>(tool, { proteinIds: ['p1', 'p2'] });
    expect(result.error).toMatch(/has no sequence field/i);
    expect(seqMock.resolveAminoAcidSequence).not.toHaveBeenCalled();
  });

  it('rejects a sequence reference that does not resolve', async () => {
    opsMock.queryLimsEntities.mockResolvedValueOnce([makeEntity('p1', 'GFP')]);
    seqMock.resolveAminoAcidSequence.mockResolvedValueOnce({ status: 'missing', length: 0 });
    const result = await execTool<RunMsaPreparation>(tool, { proteinIds: ['p1', 'p2'] });
    expect(result.error).toMatch(/could not be resolved \(missing\)/i);
  });
});
