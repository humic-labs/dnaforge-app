import { describe, expect, it, vi } from 'vitest';
import type { AcceptedAssemblyVersion } from '../assembly/public/accepted-types';
import type { DesignPrimer } from '../design';
import { sha256Hex } from '../primers/public/primer-artifact';

const mocks = vi.hoisted(() => ({
  recordPrimers: vi.fn().mockResolvedValue({ recorded: [], skipped: [], failed: [] }),
}));
vi.mock('../primers/record-primers', () => ({ recordPrimers: mocks.recordPrimers }));
import { recordAcceptedAssemblyPrimers } from './assembly-bridge';

describe('saved assembly primer identity', () => {
  it('does not reuse an older oligo path that has lost its binding and tail split', async () => {
    const primer: DesignPrimer = {
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
    const acceptedVersion = {
      projectionInput: {
        designPrimers: [{ fragmentIndex: 0, forward: primer, reverse: { ...primer, name: 'r' } }],
      },
    } as AcceptedAssemblyVersion;
    await recordAcceptedAssemblyPrimers({ acceptedVersion, workspaceRoot: '/assembly-project' });
    expect(mocks.recordPrimers.mock.calls[0][0].primers[0].artifactStem).not.toBe(
      `f-${(await sha256Hex(primer.sequence)).slice(0, 8)}`
    );
  });
});
