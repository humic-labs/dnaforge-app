import { backtranslateOutputSchema } from './protein-output-schemas';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const opsMock = vi.hoisted(() => ({ queryLimsEntities: vi.fn() }));
vi.mock('../../lims/operations', () => opsMock);

const seqMock = vi.hoisted(() => ({ resolveAminoAcidSequence: vi.fn() }));
vi.mock('../../lims/protein-sequence', () => seqMock);

import { createBacktranslateTool } from './backtranslate';
import { execTool as executeTool } from './test-helpers';
import type { LimsEntity } from '../../../shared/lims';

const GFP = 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEG';

const tool = createBacktranslateTool([]);

beforeEach(() => {
  vi.clearAllMocks();
});

interface BacktranslateResult {
  error?: string;
  refId?: string;
  host?: string;
  aminoAcidSequence?: string;
  dnaSequence?: string;
  dnaLengthBp?: number;
  verified?: boolean;
}

describe('backtranslate tool  slice 2.5)', () => {
  it('backtranslates a raw sequence directly and verifies the round trip', async () => {
    const result = await execTool<BacktranslateResult>(tool, {
      sequence: GFP,
      host: 'E_COLI_K12',
    });

    expect(result.error).toBeUndefined();
    expect(result.dnaSequence?.length).toBe(GFP.length * 3);
    expect(result.verified).toBe(true);
    expect(result.aminoAcidSequence).toBe(GFP);
  });

  it('resolves a registered protein by refId', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([
      { id: 'aa-uuid-1', kind: 'protein', fields: { sequence: {} } } as unknown as LimsEntity,
    ]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: GFP,
      length: 33,
    });

    const result = await execTool<BacktranslateResult>(tool, {
      refId: 'aa-uuid-1',
      host: 'S_CEREVISIAE',
    });

    expect(result.error).toBeUndefined();
    expect(result.refId).toBe('aa-uuid-1');
    expect(result.verified).toBe(true);
    expect(opsMock.queryLimsEntities).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'aa-uuid-1' })
    );
  });

  it('rejects when both refId and sequence are provided', async () => {
    const result = await execTool<BacktranslateResult>(tool, {
      refId: 'aa-uuid-1',
      sequence: GFP,
      host: 'E_COLI_K12',
    });
    expect(result.error).toMatch(/exactly one/i);
  });

  it('rejects when neither refId nor sequence is provided', async () => {
    const result = await execTool<BacktranslateResult>(tool, { host: 'E_COLI_K12' } as never);
    expect(result.error).toMatch(/exactly one/i);
  });

  it('returns a structured error for a non-protein entity, never guessing', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([
      { id: 'p-1', kind: 'plasmid', fields: {} } as unknown as LimsEntity,
    ]);

    const result = await execTool<BacktranslateResult>(tool, { refId: 'p-1', host: 'E_COLI_K12' });
    expect(result.error).toMatch(/not a protein/i);
  });

  it('returns a structured error when the registered entity has no sequence field at all', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([
      { id: 'aa-uuid-2', kind: 'protein', fields: {} } as unknown as LimsEntity,
    ]);

    const result = await execTool<BacktranslateResult>(tool, {
      refId: 'aa-uuid-2',
      host: 'E_COLI_K12',
    });
    expect(result.error).toMatch(/has no sequence field/i);
    expect(seqMock.resolveAminoAcidSequence).not.toHaveBeenCalled();
  });

  it('returns a structured error when the sequence reference does not resolve to a loaded status', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([
      { id: 'aa-uuid-3', kind: 'protein', fields: { sequence: {} } } as unknown as LimsEntity,
    ]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({ status: 'missing', length: 0 });

    const result = await execTool<BacktranslateResult>(tool, {
      refId: 'aa-uuid-3',
      host: 'E_COLI_K12',
    });
    expect(result.error).toMatch(/could not be resolved \(missing\)/i);
  });

  it('returns a structured error when the refId does not resolve to any entity', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([]);
    const result = await execTool<BacktranslateResult>(tool, {
      refId: 'missing',
      host: 'E_COLI_K12',
    });
    expect(result.error).toMatch(/no lims entity/i);
  });

  it('returns a structured error for an unsupported host, never silently defaulting', async () => {
    const result = await execTool<BacktranslateResult>(tool, {
      sequence: GFP,
      host: 'H_SAPIENS',
    } as never);
    expect(result.error).toMatch(/unsupported/i);
  });

  it('returns a structured error for an invalid residue (X/*/gap), never guessing a codon', async () => {
    const result = await execTool<BacktranslateResult>(tool, {
      sequence: 'MSKX',
      host: 'E_COLI_K12',
    });
    expect(result.error).toMatch(/cannot backtranslate/i);
  });
});

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(backtranslateOutputSchema, result);
  return result;
}
