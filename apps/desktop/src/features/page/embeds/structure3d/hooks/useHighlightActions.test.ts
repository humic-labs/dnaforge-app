import { describe, expect, it } from 'vitest';
import type { ChainSequence, HighlightGroup } from '../types';
import { residueLocationsForHighlightGroup } from './useHighlightActions';

const CHAIN: ChainSequence = {
  chainId: 'A',
  chainLabel: 'Chain A',
  sequence: 'ACDE',
  baseChain: 'A',
  labelAsymId: 'A',
  authAsymId: 'H',
  entityId: '1',
  operator: 'ASM_1',
  residues: [
    { position: 86, labelSeqId: 1, name: 'A', name3: 'ALA' },
    { position: 88, labelSeqId: 2, name: 'C', name3: 'CYS' },
    { position: 109, labelSeqId: 3, name: 'D', name3: 'ASP' },
    { position: 195, labelSeqId: 4, name: 'E', name3: 'GLU' },
  ],
};

const GROUP: HighlightGroup = {
  id: 'saved-1',
  label: 'Disjoint snapshot',
  selections: [
    {
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'H',
      entityId: '1',
      operator: 'ASM_1',
      ranges: [
        [86, 109],
        [195, 195],
      ],
    },
  ],
};

describe('saved highlight activation', () => {
  it('resolves only real loaded residues and preserves exact physical-chain identity', () => {
    expect(residueLocationsForHighlightGroup(GROUP, [CHAIN])).toEqual([
      {
        chain: 'A',
        position: 86,
        labelSeqId: 1,
        labelCompId: 'ALA',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        operator: 'ASM_1',
      },
      {
        chain: 'A',
        position: 88,
        labelSeqId: 2,
        labelCompId: 'CYS',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        operator: 'ASM_1',
      },
      {
        chain: 'A',
        position: 109,
        labelSeqId: 3,
        labelCompId: 'ASP',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        operator: 'ASM_1',
      },
      {
        chain: 'A',
        position: 195,
        labelSeqId: 4,
        labelCompId: 'GLU',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        operator: 'ASM_1',
      },
    ]);
  });

  it('does not activate a snapshot against a different physical chain copy', () => {
    expect(
      residueLocationsForHighlightGroup(GROUP, [{ ...CHAIN, chainId: 'A2', operator: 'ASM_2' }])
    ).toEqual([]);
  });
});
