import { describe, expect, it, vi } from 'vitest';
import type { AcceptedAssemblyVersion } from '../assembly/public/accepted-types';
import type { DesignPrimer } from '../design';

const mocks = vi.hoisted(() => ({
  recordPrimers: vi.fn().mockResolvedValue({ recorded: [], skipped: [], failed: [] }),
}));
vi.mock('../primers/record-primers', () => ({ recordPrimers: mocks.recordPrimers }));
import { recordAcceptedAssemblyPrimers } from './assembly-bridge';

describe('assembly-owned primer annealing evidence', () => {
  it('saves the complete primer and its binding suffix without attaching to either source', async () => {
    const forward: DesignPrimer = {
      id: 'f',
      name: 'f',
      sequence: 'GGGGACGTCCTAGTCA',
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: 0,
      tm: 60,
      pbs: { start: 0, end: 12, sequence: 'ACGTCCTAGTCA' },
      overhang: { length: 4, sequence: 'GGGG' },
    };
    const reverse: DesignPrimer = { ...forward, id: 'r', name: 'r', direction: 'reverse' };
    const acceptedVersion = {
      projectionInput: { designPrimers: [{ fragmentIndex: 0, forward, reverse }] },
    } as AcceptedAssemblyVersion;
    await recordAcceptedAssemblyPrimers({ acceptedVersion, workspaceRoot: '/assembly-project' });
    expect(mocks.recordPrimers).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'assembly',
        workspaceRoot: '/assembly-project',
        primers: [forward, reverse].map((primer) =>
          expect.objectContaining({
            name: primer.name,
            sequence: primer.sequence,
            annealing: { pbsSequence: 'ACGTCCTAGTCA', overhangSequence: 'GGGG' },
          })
        ),
      })
    );
    for (const primer of mocks.recordPrimers.mock.calls[0][0].primers) {
      expect(primer.binding).toBeUndefined();
    }
  });

  it('does not write a second oligo for a primer that already has a current saved oligo', async () => {
    mocks.recordPrimers.mockClear();
    const forward: DesignPrimer = {
      id: 'f',
      name: 'f',
      sequence: 'GGGGACGTCCTAGTCA',
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: 0,
      tm: 60,
      pbs: { start: 0, end: 12, sequence: 'ACGTCCTAGTCA' },
      overhang: { length: 4, sequence: 'GGGG' },
    };
    const reverse: DesignPrimer = { ...forward, id: 'r', name: 'r', direction: 'reverse' };
    const acceptedVersion = {
      projectionInput: { designPrimers: [{ fragmentIndex: 0, forward, reverse }] },
    } as AcceptedAssemblyVersion;

    await recordAcceptedAssemblyPrimers({
      acceptedVersion,
      workspaceRoot: '/assembly-project',
      alreadySavedPrimerIds: new Set(['f']),
    });
    expect(mocks.recordPrimers.mock.calls[0][0].primers).toEqual([
      expect.objectContaining({ name: 'r' }),
    ]);

    mocks.recordPrimers.mockClear();
    expect(
      await recordAcceptedAssemblyPrimers({
        acceptedVersion,
        workspaceRoot: '/assembly-project',
        alreadySavedPrimerIds: new Set(['f', 'r']),
      })
    ).toEqual({ recorded: [], skipped: [], failed: [] });
    expect(mocks.recordPrimers).not.toHaveBeenCalled();
  });
});
