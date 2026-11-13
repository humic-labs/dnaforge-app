// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { ChainSequence, StructureComplexMember } from '../types';
import {
  structureMemberChainBadgesForChain,
  structureMemberDisplayLabelForChain,
} from './structureMemberLabels';

describe('structure member labels', () => {
  it('keeps generated chain subtitles aligned with the row display chain', () => {
    expect(
      structureMemberDisplayLabelForChain(
        member({ displayName: 'Chain A', authAsymIds: ['W'], labelAsymIds: ['A'] }),
        chain({ chainId: 'A', authAsymId: 'W', labelAsymId: 'A' })
      )
    ).toBe('Chain W');
  });

  it('preserves biological member names instead of replacing them with chain ids', () => {
    expect(
      structureMemberDisplayLabelForChain(
        member({ displayName: 'ATP synthase gamma chain', authAsymIds: ['G'] }),
        chain({ chainId: 'G', authAsymId: 'G' })
      )
    ).toBe('ATP synthase gamma chain');
  });

  it('uses the row chain identity for subtitle badges instead of the member-wide selection', () => {
    const gammaMember = member({
      displayName: 'ATP synthase gamma chain',
      authAsymIds: ['G', 'Q'],
      labelAsymIds: ['g1', 'q1'],
    });

    expect(
      structureMemberChainBadgesForChain(
        gammaMember,
        chain({ chainId: 'q1', authAsymId: 'Q', labelAsymId: 'q1', entityId: '7' })
      )
    ).toEqual(['auth Q', 'label q1', 'entity 7']);
  });
});

function member(input: {
  displayName: string;
  authAsymIds?: string[];
  labelAsymIds?: string[];
}): StructureComplexMember {
  return {
    memberId: `member:${input.displayName}`,
    kind: 'protein',
    displayName: input.displayName,
    selection: {
      authAsymIds: input.authAsymIds,
      labelAsymIds: input.labelAsymIds,
    },
    authAsymIds: input.authAsymIds,
    labelAsymIds: input.labelAsymIds,
    mappingStatus: 'unmapped',
  };
}

function chain(input: {
  chainId: string;
  authAsymId?: string;
  labelAsymId?: string;
  entityId?: string;
}): ChainSequence {
  return {
    chainId: input.chainId,
    chainLabel: `Chain ${input.chainId}`,
    baseChain: input.chainId,
    authAsymId: input.authAsymId,
    labelAsymId: input.labelAsymId,
    entityId: input.entityId,
    sequence: 'MA',
    residues: [
      { position: 1, name: 'M', name3: 'MET' },
      { position: 2, name: 'A', name3: 'ALA' },
    ],
  };
}
