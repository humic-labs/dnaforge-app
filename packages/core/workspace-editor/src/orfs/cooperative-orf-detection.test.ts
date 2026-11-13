import { describe, expect, it } from 'vitest';
import { findORFs } from '@waypoint/sequence-utils';
import { findORFsCooperatively } from './cooperative-orf-detection';

describe('findORFsCooperatively', () => {
  it('matches the canonical ORF detector across forward and reverse frames', async () => {
    const sequence =
      'CCCATG' +
      'AAA'.repeat(40) +
      'TAA' +
      'GGG' +
      'TTA' +
      'CCC'.repeat(36) +
      'CAT' +
      'GGGATGAAATAG';

    await expect(findORFsCooperatively(sequence, 90, () => true)).resolves.toEqual(
      findORFs(sequence, 90)
    );
  });

  it('finds the same ORFs in an RNA spelling as in DNA ', async () => {
    const dna =
      'CCCATG' + 'AAA'.repeat(40) + 'TAA' + 'GGG' + 'TTA' + 'CCC'.repeat(36) + 'CAT' + 'GGG';
    const rna = dna.replace(/T/g, 'U');

    const fromDna = await findORFsCooperatively(dna, 90, () => true);
    expect(fromDna?.map((orf) => orf.strand).sort()).toEqual(['+', '-']);
    await expect(findORFsCooperatively(rna, 90, () => true)).resolves.toEqual(fromDna);
  });
});
