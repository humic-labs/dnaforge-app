// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure } from 'molstar/lib/mol-model/structure';
import cif from '../molstar/fixtures/molecular-attachment-1hrc.cif?raw';
import atpGFullComplex from '../../../../../../../../test-fixtures/structure-complexes/rcsb/6OQR.cif?raw';
import { chainInstanceIdForSequenceChain } from '../utils/structureIds';
import {
  extractSequenceDataFromPlugin,
  getColorModeDomain,
  getModifiedResidueName,
  isModifiedResidue,
} from './useSequenceData';

describe('useSequenceData utilities', () => {
  it('identifies the real full-entry 6OQR distal Fo chain without an assembly operator', async () => {
    const parsed = await CIF.parseText(atpGFullComplex).run();
    if (parsed.isError) throw new Error(parsed.message);
    const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
    const structure = Structure.ofModel(trajectory.representative);
    const plugin = {
      managers: {
        structure: {
          hierarchy: {
            current: { structures: [{ cell: { obj: { data: structure } }, components: [] }] },
          },
        },
      },
    };
    const chains = extractSequenceDataFromPlugin(plugin, 'chain')?.chains ?? [];
    const matches = chains.filter(
      (chain) => chain.authAsymId === 'a' && chain.labelAsymId === 'T' && chain.entityId === '8'
    );
    expect(matches).toHaveLength(1);
    const [distalFo] = matches;
    if (!distalFo) throw new Error('Missing distal Fo chain in the real 6OQR coordinate model');
    expect(distalFo.operator).toBe('1_555');
    expect(chainInstanceIdForSequenceChain(distalFo)).toBe('a-t-8-1_555-t');
    expect(distalFo.residues.length).toBeGreaterThan(0);
  });

  it('lists the union of represented story molecules and omits a never-depicted source', async () => {
    const parsed = await CIF.parseText(cif).run();
    if (parsed.isError) throw Error(parsed.message);
    const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
    const structures = ['first', 'second', 'never'].map((name) => ({
      cell: {
        transform: { ref: name },
        obj: { data: Structure.ofModel(trajectory.representative) },
      },
      components: [],
    }));
    const plugin = { managers: { structure: { hierarchy: { current: { structures } } } } };
    const rootFor = (source: string) => ({
      kind: 'root',
      children: [
        {
          kind: 'structure',
          ref: `native:${source}`,
          children: [
            {
              kind: 'component',
              params: { selector: 'polymer' },
              children: [
                {
                  kind: 'representation',
                  params: { type: 'cartoon' },
                },
              ],
            },
          ],
        },
      ],
    });
    const scene = JSON.stringify({
      kind: 'multiple',
      snapshots: [{ root: rootFor('first') }, { root: rootFor('second') }],
    });
    expect(
      extractSequenceDataFromPlugin(plugin, 'chain')!.chains.map((chain) => chain.structureRef)
    ).toEqual(['native:first', 'native:second', 'native:never']);
    const story = extractSequenceDataFromPlugin(plugin, 'chain', scene)!;
    expect(story.chains.map((chain) => chain.structureRef)).toEqual([
      'native:first',
      'native:second',
    ]);
    expect(story.ligands).toHaveLength(0);
  });
  describe('isModifiedResidue', () => {
    it('returns false for standard amino acids', () => {
      const standardAAs = [
        'ALA',
        'ARG',
        'ASN',
        'ASP',
        'CYS',
        'GLU',
        'GLN',
        'GLY',
        'HIS',
        'ILE',
        'LEU',
        'LYS',
        'MET',
        'PHE',
        'PRO',
        'SER',
        'THR',
        'TRP',
        'TYR',
        'VAL',
      ];
      for (const aa of standardAAs) {
        expect(isModifiedResidue(aa)).toBe(false);
      }
    });

    it('returns false for standard nucleotides', () => {
      const nucleotides = ['DA', 'DC', 'DG', 'DT', 'A', 'C', 'G', 'U'];
      for (const nt of nucleotides) {
        expect(isModifiedResidue(nt)).toBe(false);
      }
    });

    it('returns true for phosphorylated residues', () => {
      expect(isModifiedResidue('TPO')).toBe(true);
      expect(isModifiedResidue('SEP')).toBe(true);
      expect(isModifiedResidue('PTR')).toBe(true);
    });

    it('returns true for methylated residues', () => {
      expect(isModifiedResidue('MLY')).toBe(true);
      expect(isModifiedResidue('MLZ')).toBe(true);
      expect(isModifiedResidue('M3L')).toBe(true);
    });

    it('returns true for selenomethionine', () => {
      expect(isModifiedResidue('MSE')).toBe(true);
    });

    it('returns true for acetylated lysine', () => {
      expect(isModifiedResidue('ALY')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isModifiedResidue('tpo')).toBe(true);
      expect(isModifiedResidue('Tpo')).toBe(true);
      expect(isModifiedResidue('ala')).toBe(false);
      expect(isModifiedResidue('Ala')).toBe(false);
    });

    it('returns false for unknown residues', () => {
      expect(isModifiedResidue('XYZ')).toBe(false);
      expect(isModifiedResidue('FOO')).toBe(false);
    });
  });

  describe('getModifiedResidueName', () => {
    it('returns full name for known phosphorylated residues', () => {
      expect(getModifiedResidueName('TPO')).toBe('Phosphothreonine');
      expect(getModifiedResidueName('SEP')).toBe('Phosphoserine');
      expect(getModifiedResidueName('PTR')).toBe('Phosphotyrosine');
    });

    it('returns full name for selenomethionine', () => {
      expect(getModifiedResidueName('MSE')).toBe('Selenomethionine');
    });

    it('returns full name for methylated residues', () => {
      expect(getModifiedResidueName('MLY')).toBe('N,N-dimethyllysine');
      expect(getModifiedResidueName('M3L')).toBe('N,N,N-trimethyllysine');
    });

    it('is case-insensitive', () => {
      expect(getModifiedResidueName('tpo')).toBe('Phosphothreonine');
      expect(getModifiedResidueName('Tpo')).toBe('Phosphothreonine');
    });

    it('returns original code for unknown modifications', () => {
      expect(getModifiedResidueName('XYZ')).toBe('XYZ');
      expect(getModifiedResidueName('ALA')).toBe('ALA');
    });
  });

  describe('getColorModeDomain', () => {
    it('returns [0, 100] for plddt mode', () => {
      expect(getColorModeDomain('plddt')).toEqual([0, 100]);
    });

    it('returns [0, 100] for bfactor mode', () => {
      expect(getColorModeDomain('bfactor')).toEqual([0, 100]);
    });

    it('returns [0, 1] for alphamissense mode', () => {
      expect(getColorModeDomain('alphamissense')).toEqual([0, 1]);
    });

    it('returns [0, 1] for chain mode (default)', () => {
      expect(getColorModeDomain('chain')).toEqual([0, 1]);
    });

    it('returns [0, 1] for any unknown mode', () => {
      // @ts-expect-error testing unknown mode
      expect(getColorModeDomain('unknown')).toEqual([0, 1]);
    });
  });

  describe('extractSequenceDataFromPlugin', () => {
    it('deduplicates multi-atom polymer residues while counting ligand atoms and excluding water', () => {
      const plugin = {
        managers: {
          structure: {
            hierarchy: {
              current: {
                structures: [
                  {
                    cell: {
                      obj: {
                        data: {
                          units: [
                            {
                              id: 1,
                              elements: [0, 1, 2, 3, 4, 5, 6],
                              residueIndex: [0, 0, 0, 1, 1, 2, 2],
                              chainIndex: [0, 0, 0, 0, 0, 0, 0],
                              model: {
                                atomicHierarchy: {
                                  chains: {
                                    label_asym_id: { value: () => 'A' },
                                    auth_asym_id: { value: () => 'A' },
                                    label_entity_id: { value: () => '1' },
                                  },
                                  residues: {
                                    auth_seq_id: { value: (index: number) => index + 1 },
                                  },
                                  atoms: {
                                    label_comp_id: {
                                      value: (index: number) =>
                                        ['ALA', 'ALA', 'ALA', 'ATP', 'ATP', 'HOH', 'HOH'][index],
                                    },
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      };

      const result = extractSequenceDataFromPlugin(plugin, 'chain');
      expect(result?.chains).toMatchObject([
        { chainId: 'A', sequence: 'A', residues: [{ position: 1 }] },
      ]);
      expect(result?.ligands).toMatchObject([{ name: 'ATP', position: 2, atomCount: 2 }]);
    });

    it('keeps same-entity chains separate when Molstar groups them in one unit', () => {
      const plugin = {
        managers: {
          structure: {
            hierarchy: {
              current: {
                structures: [
                  {
                    cell: {
                      obj: {
                        data: {
                          units: [
                            {
                              id: 1,
                              elements: [0, 1, 2, 3],
                              chainIndex: [0, 0, 1, 1],
                              residueIndex: [0, 1, 2, 3],
                              conformation: { operator: { name: '1_555' } },
                              model: {
                                properties: {
                                  structAsymMap: new Map([
                                    ['G', { auth_id: 'G' }],
                                    ['O', { auth_id: 'O' }],
                                  ]),
                                },
                                atomicHierarchy: {
                                  chains: {
                                    label_asym_id: { value: (idx: number) => ['G', 'O'][idx] },
                                    auth_asym_id: { value: (idx: number) => ['G', 'O'][idx] },
                                    label_entity_id: { value: () => '3' },
                                  },
                                  residues: {
                                    auth_seq_id: { value: (idx: number) => [1, 2, 1, 2][idx] },
                                  },
                                  atoms: {
                                    label_comp_id: {
                                      value: (idx: number) => ['ALA', 'GLY', 'SER', 'THR'][idx],
                                    },
                                  },
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      };

      expect(extractSequenceDataFromPlugin(plugin, 'chain')?.chains).toMatchObject([
        {
          chainId: 'G',
          authAsymId: 'G',
          entityId: '3',
          sequence: 'AG',
          residues: [{ position: 1 }, { position: 2 }],
        },
        {
          chainId: 'O',
          authAsymId: 'O',
          entityId: '3',
          sequence: 'ST',
          residues: [{ position: 1 }, { position: 2 }],
        },
      ]);
    });
  });
});
