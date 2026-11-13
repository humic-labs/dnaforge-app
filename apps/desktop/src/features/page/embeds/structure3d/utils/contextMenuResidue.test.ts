import { describe, expect, it } from 'vitest';

import { residueFromContextMenuTarget } from './contextMenuResidue';

describe('residueFromContextMenuTarget', () => {
  it('decodes exact physical-chain identity from a nested amino-acid target', () => {
    const residue = document.createElement('div');
    residue.dataset.chainId = 'A2';
    residue.dataset.position = '57';
    residue.dataset.labelSeqId = '34';
    residue.dataset.residueName3 = 'GLY';
    residue.dataset.baseChain = 'A';
    residue.dataset.labelAsymId = 'C';
    residue.dataset.authAsymId = 'A';
    residue.dataset.entityId = '1';
    residue.dataset.operator = 'ASM_2';
    const letter = document.createElement('span');
    residue.append(letter);

    expect(residueFromContextMenuTarget(letter)).toEqual({
      chain: 'A2',
      position: 57,
      labelSeqId: 34,
      labelCompId: 'GLY',
      baseChain: 'A',
      labelAsymId: 'C',
      authAsymId: 'A',
      entityId: '1',
      operator: 'ASM_2',
    });
  });

  it('rejects background and malformed residue targets', () => {
    expect(residueFromContextMenuTarget(document.createElement('div'))).toBeNull();

    const malformed = document.createElement('div');
    malformed.dataset.chainId = 'A';
    malformed.dataset.position = '0';
    expect(residueFromContextMenuTarget(malformed)).toBeNull();
  });
});
