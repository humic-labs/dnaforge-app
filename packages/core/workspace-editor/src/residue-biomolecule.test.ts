import { describe, it, expect } from 'vitest';
import {
  buildDirectProteinRef,
  standaloneProteinMoleculeIdFromEntity,
} from './residue-biomolecule';

describe('buildDirectProteinRef / standaloneProteinMoleculeIdFromEntity ', () => {
  it('builds a protein-sequence ref scoped by entity id and sequence hash', () => {
    const ref = buildDirectProteinRef({ entityId: 'aa000001', sequenceHash: 'deadbeef' });
    expect(ref).toEqual({
      kind: 'protein-sequence',
      canonicalProteinIdentityKey: 'protein-sequence:file:aa000001:deadbeef',
      source: { kind: 'file', entityId: 'aa000001' },
      aliases: [],
    });
  });

  it('gives two entities with an identical sequence DISTINCT molecule ids', () => {
    const idA = standaloneProteinMoleculeIdFromEntity('aa000001', 'deadbeef');
    const idB = standaloneProteinMoleculeIdFromEntity('aa000002', 'deadbeef');
    expect(idA).not.toBe(idB);
  });

  it('is deterministic for the same entity id + sequence hash', () => {
    const first = standaloneProteinMoleculeIdFromEntity('aa000001', 'deadbeef');
    const second = standaloneProteinMoleculeIdFromEntity('aa000001', 'deadbeef');
    expect(first).toBe(second);
  });
});
