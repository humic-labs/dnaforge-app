import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptedAssemblyVersion } from '../assembly/accepted-types';
import type { DesignPrimer, DesignPrimerPair } from '../design/types';
import { sha256Hex } from '../primers/primer-artifact';

const mocks = vi.hoisted(() => ({
  recordPrimers: vi.fn(),
}));

vi.mock('../primers/record-primers', () => ({
  recordPrimers: mocks.recordPrimers,
}));

vi.mock('./operations', () => ({
  queryLimsEntities: vi.fn(),
  registerLimsEntity: vi.fn(),
}));

vi.mock('./dna-sequence', () => ({
  buildFileDnaSequenceRef: vi.fn(),
}));

import { recordAcceptedAssemblyPrimers } from './assembly-bridge';

function designPrimer(
  overrides: Partial<DesignPrimer> & { name: string; sequence: string }
): DesignPrimer {
  return {
    id: `primer-${overrides.name}`,
    pbs: { start: 0, end: overrides.sequence.length, sequence: overrides.sequence },
    overhang: { length: 0, sequence: '' },
    direction: 'forward',
    fragmentIndex: 0,
    junctionIndex: null,
    tm: 60,
    ...overrides,
  };
}

function pair(fragmentIndex: number, fwd: DesignPrimer, rev: DesignPrimer): DesignPrimerPair {
  return { forward: fwd, reverse: rev, fragmentIndex };
}

function acceptedVersionWith(designPrimers: DesignPrimerPair[]): AcceptedAssemblyVersion {
  return {
    projectionInput: { designPrimers },
  } as unknown as AcceptedAssemblyVersion;
}

const EMPTY_RESULT = { recorded: [], skipped: [], failed: [] };

describe('recordAcceptedAssemblyPrimers — mapping to the recordPrimers seam ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordPrimers.mockResolvedValue(EMPTY_RESULT);
  });

  it('flattens every fwd+rev pair into origin:assembly, deferCommit:true RecordablePrimers', async () => {
    const av = acceptedVersionWith([
      pair(
        0,
        designPrimer({
          name: 'F0',
          sequence: 'acgtacgtacgtacgtacgt',
          direction: 'forward',
          tm: 61,
        }),
        designPrimer({ name: 'R0', sequence: 'TTTTGGGGCCCCAAAATTTT', direction: 'reverse', tm: 62 })
      ),
      pair(
        1,
        designPrimer({
          name: 'F1',
          sequence: 'GGGGAAAACCCCTTTTGGGG',
          direction: 'forward',
          tm: 63,
        }),
        designPrimer({ name: 'R1', sequence: 'AAAACCCCGGGGTTTTAAAA', direction: 'reverse', tm: 64 })
      ),
    ]);

    await recordAcceptedAssemblyPrimers({ acceptedVersion: av, workspaceRoot: '/ws' });

    expect(mocks.recordPrimers).toHaveBeenCalledTimes(1);
    const input = mocks.recordPrimers.mock.calls[0][0];
    expect(input.workspaceRoot).toBe('/ws');
    expect(input.origin).toBe('assembly');
    expect(input.deferCommit).toBe(true);
    expect(input.primers).toHaveLength(4);
    expect(input.primers.map((p: { name: string }) => p.name)).toEqual(['F0', 'R0', 'F1', 'R1']);
    for (const p of input.primers) {
      expect(p.application).toBe('pcr');
    }
  });

  it('builds a collision-free + idempotent ${name}-${sha8(sequence)} artifact stem', async () => {
    const seq = 'acgtACGTacgtACGTacgt';
    const av = acceptedVersionWith([
      pair(
        0,
        designPrimer({ name: 'F0', sequence: seq }),
        designPrimer({ name: 'R0', sequence: 'TTTTGGGGCCCCAAAATTTT' })
      ),
    ]);

    await recordAcceptedAssemblyPrimers({ acceptedVersion: av, workspaceRoot: '/ws' });

    const input = mocks.recordPrimers.mock.calls[0][0];
    const expectedHash = (await sha256Hex(seq.trim().toUpperCase())).slice(0, 8);
    expect(input.primers[0].artifactStem).toBe(`F0-${expectedHash}`);
    const spaced = ` ${seq.toUpperCase()} `;
    expect((await sha256Hex(spaced.trim().toUpperCase())).slice(0, 8)).toBe(expectedHash);
  });

  it('carries the primer sequence and Tm through verbatim', async () => {
    const av = acceptedVersionWith([
      pair(
        0,
        designPrimer({ name: 'F0', sequence: 'ACGTACGTACGTACGTACGT', tm: 61.5 }),
        designPrimer({ name: 'R0', sequence: 'TTTTGGGGCCCCAAAATTTT', tm: 58.2 })
      ),
    ]);

    await recordAcceptedAssemblyPrimers({ acceptedVersion: av, workspaceRoot: '/ws' });

    const input = mocks.recordPrimers.mock.calls[0][0];
    expect(input.primers[0]).toMatchObject({
      name: 'F0',
      sequence: 'ACGTACGTACGTACGTACGT',
      tm: 61.5,
    });
    expect(input.primers[1]).toMatchObject({
      name: 'R0',
      sequence: 'TTTTGGGGCCCCAAAATTTT',
      tm: 58.2,
    });
  });

  it('filters out empty-sequence primers (Golden Gate RD pairs carry no primer)', async () => {
    const av = acceptedVersionWith([
      pair(
        0,
        designPrimer({ name: 'F0', sequence: 'ACGTACGTACGTACGTACGT' }),
        designPrimer({ name: 'R0', sequence: 'TTTTGGGGCCCCAAAATTTT' })
      ),
      pair(
        1,
        designPrimer({ name: 'RD_F', sequence: '' }),
        designPrimer({ name: 'RD_R', sequence: '   ' })
      ),
    ]);

    await recordAcceptedAssemblyPrimers({ acceptedVersion: av, workspaceRoot: '/ws' });

    const input = mocks.recordPrimers.mock.calls[0][0];
    expect(input.primers.map((p: { name: string }) => p.name)).toEqual(['F0', 'R0']);
  });

  it('returns the seam result unchanged', async () => {
    const seamResult = { recorded: [{ any: 'thing' }], skipped: [], failed: [] };
    mocks.recordPrimers.mockResolvedValue(seamResult);
    const av = acceptedVersionWith([
      pair(
        0,
        designPrimer({ name: 'F0', sequence: 'ACGTACGTACGTACGTACGT' }),
        designPrimer({ name: 'R0', sequence: 'TTTTGGGGCCCCAAAATTTT' })
      ),
    ]);

    const result = await recordAcceptedAssemblyPrimers({
      acceptedVersion: av,
      workspaceRoot: '/ws',
    });
    expect(result).toBe(seamResult);
  });

  it('records nothing (no seam call) when there are no design primers', async () => {
    const av = acceptedVersionWith([]);
    const result = await recordAcceptedAssemblyPrimers({
      acceptedVersion: av,
      workspaceRoot: '/ws',
    });
    expect(mocks.recordPrimers).not.toHaveBeenCalled();
    expect(result).toEqual({ recorded: [], skipped: [], failed: [] });
  });
});
