// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { ChainSequence, Structure3dAttrs } from '../types';
import {
  createPolymerResidueDisplayProjection,
  polymerResidueDisplayProjectionsFromExtractedQueryChains,
} from './polymerResidueDisplay';

const THREE_LETTER: Record<string, string> = {
  A: 'ALA',
  C: 'CYS',
  D: 'ASP',
  E: 'GLU',
  F: 'PHE',
  G: 'GLY',
  H: 'HIS',
  I: 'ILE',
  K: 'LYS',
  L: 'LEU',
  M: 'MET',
  N: 'ASN',
  P: 'PRO',
  Q: 'GLN',
  R: 'ARG',
  S: 'SER',
  T: 'THR',
  V: 'VAL',
  W: 'TRP',
  Y: 'TYR',
};

function chainFromObserved(
  sequence: string,
  sourceIndices: readonly number[],
  overrides: Partial<ChainSequence> = {}
): ChainSequence {
  return {
    chainId: 'A',
    chainLabel: 'Chain A',
    sequence,
    baseChain: 'A',
    labelAsymId: 'A',
    authAsymId: 'A',
    entityId: '1',
    operator: 'ASM_1',
    residues: [...sequence].map((name, index) => ({
      position: 101 + index,
      sequenceIndex: sourceIndices[index],
      labelSeqId: 201 + index,
      name,
      name3: THREE_LETTER[name] ?? 'UNK',
    })),
    ...overrides,
  };
}

describe('createPolymerResidueDisplayProjection', () => {
  it('projects the full linked polymer and marks N-terminal, internal, and C-terminal gaps', () => {
    const source = 'AMSTKQY';
    const chain = chainFromObserved('MSTK', [1, 2, 3, 4]);

    const projection = createPolymerResidueDisplayProjection(chain, source);

    expect(projection.status).toBe('mapped');
    if (projection.status !== 'mapped') throw new Error('expected mapped projection');
    expect(projection.entries.map((entry) => entry.coordinateStatus)).toEqual([
      'missing',
      'modeled',
      'modeled',
      'modeled',
      'modeled',
      'missing',
      'missing',
    ]);
    expect(projection.entries[0]).toEqual({
      coordinateStatus: 'missing',
      polymerIndex: 0,
      sourceOneLetterCode: 'A',
      location: null,
    });
    expect(projection.entries[1]).toMatchObject({
      coordinateStatus: 'modeled',
      polymerIndex: 1,
      sourceOneLetterCode: 'M',
      coordinateOneLetterCode: 'M',
      coordinateThreeLetterCode: 'MET',
      identityRelation: 'exact',
      location: {
        chain: 'A',
        position: 101,
        labelSeqId: 201,
        labelCompId: 'MET',
        operator: 'ASM_1',
      },
    });
    expect(projection.polymerLength).toBe(7);
    expect(projection.modeledCount).toBe(4);
  });

  it('preserves source and coordinate identity for substitutions and modifications', () => {
    const source = 'MSTACDEFGHIKLMNPQRSTVWY';
    const observed = 'MSTVCDEFGHIKLMNPQRSTVWY';
    const chain = chainFromObserved(
      observed,
      [...observed].map((_, index) => index)
    );
    chain.residues[0] = { ...chain.residues[0], name3: 'MSE' };

    const projection = createPolymerResidueDisplayProjection(chain, source);

    expect(projection.status).toBe('mapped');
    if (projection.status !== 'mapped') throw new Error('expected mapped projection');
    expect(projection.entries[0]).toMatchObject({
      coordinateStatus: 'modeled',
      sourceOneLetterCode: 'M',
      coordinateOneLetterCode: 'M',
      coordinateThreeLetterCode: 'MSE',
      identityRelation: 'modified',
    });
    expect(projection.entries[3]).toMatchObject({
      coordinateStatus: 'modeled',
      sourceOneLetterCode: 'A',
      coordinateOneLetterCode: 'V',
      coordinateThreeLetterCode: 'VAL',
      identityRelation: 'substitution',
    });
  });

  it('retains repeated author ids by using each modeled residue label_seq_id', () => {
    const chain = chainFromObserved('MST', [0, 1, 2]);
    chain.residues = chain.residues.map((residue) => ({ ...residue, position: 7 }));

    const projection = createPolymerResidueDisplayProjection(chain, 'MST');

    expect(projection.status).toBe('mapped');
    if (projection.status !== 'mapped') throw new Error('expected mapped projection');
    expect(
      projection.entries.map((entry) =>
        entry.coordinateStatus === 'modeled' ? entry.location.labelSeqId : null
      )
    ).toEqual([201, 202, 203]);
  });

  it('fails closed when repeated source residues make the alignment ambiguous', () => {
    const projection = createPolymerResidueDisplayProjection(
      chainFromObserved('MAK', [0, 1, 2]),
      'MAAAK'
    );

    expect(projection).toMatchObject({ status: 'unavailable', reason: 'ambiguous' });
  });

  it('fails closed before an unbounded quadratic alignment', () => {
    const observed = 'AC'.repeat(1_000);
    const chain = chainFromObserved(
      observed,
      [...observed].map((_, index) => index)
    );
    chain.residues = chain.residues.map((residue, index) => ({
      ...residue,
      position: 100_000 + index,
    }));

    const projection = createPolymerResidueDisplayProjection(chain, 'CA'.repeat(1_000));

    expect(projection).toMatchObject({ status: 'unavailable', reason: 'too-large' });
  });

  it('renders a declared physical chain with no coordinates as fully missing', () => {
    const projection = createPolymerResidueDisplayProjection(
      chainFromObserved('', [], { residues: [] }),
      'MST'
    );

    expect(projection).toMatchObject({
      status: 'mapped',
      method: 'declared-empty-chain',
      polymerLength: 3,
      modeledCount: 0,
    });
    if (projection.status !== 'mapped') throw new Error('expected mapped projection');
    expect(projection.entries.every((entry) => entry.coordinateStatus === 'missing')).toBe(true);
  });

  it('rejects a projection pinned to a stale polymer revision', () => {
    const projection = createPolymerResidueDisplayProjection(
      chainFromObserved('MST', [0, 1, 2]),
      'MST',
      { expectedSourceDigestSha256: 'not-the-current-sequence-digest' }
    );

    expect(projection).toMatchObject({ status: 'unavailable', reason: 'stale-revision' });
  });
});

describe('polymerResidueDisplayProjectionsFromExtractedQueryChains', () => {
  it('preserves distinct physical multimer copies and does not broaden explicit scope', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      authAsymIds: ['G'],
    };
    const first = chainFromObserved('MST', [0, 1, 2], {
      chainId: 'B',
      labelAsymId: 'B',
      authAsymId: 'G',
      operator: 'ASM_1',
    });
    const second = chainFromObserved('MST', [0, 1, 2], {
      chainId: 'B2',
      labelAsymId: 'B',
      authAsymId: 'G',
      operator: 'ASM_2',
    });
    const unrelated = chainFromObserved('MST', [0, 1, 2], {
      chainId: 'C',
      labelAsymId: 'C',
      authAsymId: 'X',
      operator: 'ASM_1',
    });

    const projections = polymerResidueDisplayProjectionsFromExtractedQueryChains(
      attrs,
      [first, second, unrelated],
      'MST'
    );

    expect(projections.map((projection) => projection.chain.operator)).toEqual(['ASM_1', 'ASM_2']);
    expect(new Set(projections.map((projection) => projection.chainKey)).size).toBe(2);
  });
});
