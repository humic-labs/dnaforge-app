// @vitest-environment node

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ChainInstanceId,
  MolstarComponentTag,
  StructureMemberId,
  VisualLayerId,
} from './structureIds';
import {
  chainInstanceId,
  chainInstanceIdForSequenceChain,
  molstarComponentTag,
  stableStructureIdToken,
  structureMemberId,
  visualLayerId,
} from './structureIds';

describe('structure identity brands', () => {
  it('brands different structure identity families as incompatible types', () => {
    expectTypeOf<string>().not.toMatchTypeOf<ChainInstanceId>();
    expectTypeOf<StructureMemberId>().not.toMatchTypeOf<ChainInstanceId>();
    expectTypeOf<MolstarComponentTag>().not.toMatchTypeOf<ChainInstanceId>();
    expectTypeOf<VisualLayerId>().not.toMatchTypeOf<MolstarComponentTag>();

    expectTypeOf(chainInstanceId('auth-a')).toMatchTypeOf<string>();
    expectTypeOf(
      molstarComponentTag('waypoint.structure3d.component.layer.query')
    ).toMatchTypeOf<string>();
  });

  it('normalizes physical chain-instance identity from auth, label, entity, operator, and chain', () => {
    const id = chainInstanceIdForSequenceChain({
      chainId: 'A',
      chainLabel: 'Chain A',
      baseChain: 'A',
      authAsymId: 'Auth A',
      labelAsymId: 'Label A',
      entityId: '7',
      operator: 'ASM_1',
      sequence: 'AGS',
      residues: [],
    });

    expect(id).toBe('auth-a-label-a-7-asm_1-a');
  });

  it('rejects empty IDs at the conversion boundary', () => {
    expect(() => structureMemberId('')).toThrow(/StructureMemberId/);
    expect(() => chainInstanceId('   ')).toThrow(/ChainInstanceId/);
    expect(() => visualLayerId('')).toThrow(/VisualLayerId/);
  });

  it('exposes a shared stable token helper for compatible compact IDs', () => {
    expect(stableStructureIdToken(' RCSB:6OQR:Entity 2 ')).toBe('rcsb-6oqr-entity-2');
  });
});
