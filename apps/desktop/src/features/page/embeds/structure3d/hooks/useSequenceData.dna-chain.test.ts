// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure } from 'molstar/lib/mol-model/structure';
import { extractSequenceDataFromPlugin, useSequenceData } from './useSequenceData';

const DNA_COMP_IDS = ['DC', 'DG', 'DC', 'DG', 'DA', 'DA', 'DT', 'DT', 'DC', 'DG', 'DC', 'DG'];
const EXPECTED_ONE_LETTER = 'CGCGAATTCGCG';

it('retains all deposited modified tRNA positions and their actual chemistry', async () => {
  const text = readFileSync(
    resolve(process.cwd(), '../../test-fixtures/structure-complexes/rcsb/1EHZ.cif'),
    'utf8'
  );
  const parsed = await CIF.parseText(text).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const plugin = {
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [{ cell: { obj: { data: Structure.ofModel(trajectory.representative) } } }],
          },
        },
      },
    },
  };
  const extracted = extractSequenceDataFromPlugin(plugin, 'chain');
  const chain = extracted?.chains.find((item) => item.labelAsymId === 'A');
  expect(chain?.sequence).toBe(
    'GCGGAUUUAGCUCAGUUGGGAGAGCGCCAGACUGAAGAUCUGGAGGUCCUGUGUUCGAUCCACAGAAUUCGCACCA'
  );
  expect(chain?.polymerType).toBe('rna');
  expect(chain?.residues).toHaveLength(76);
  expect(chain?.residues.find((item) => item.labelSeqId === 37)).toMatchObject({
    name: 'G',
    name3: 'YYG',
  });
  expect(chain?.residues.find((item) => item.labelSeqId === 55)).toMatchObject({
    name: 'U',
    name3: 'PSU',
  });
  expect(extracted?.ligands.every((item) => ['MG', 'MN'].includes(item.name))).toBe(true);
});

function pluginWithSingleChain(compIds: readonly string[], chainId = 'A') {
  const indices = compIds.map((_, index) => index);
  return {
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
                          elements: indices,
                          chainIndex: indices.map(() => 0),
                          residueIndex: indices,
                          conformation: { operator: { name: '1_555' } },
                          model: {
                            properties: {
                              structAsymMap: new Map([[chainId, { auth_id: chainId }]]),
                            },
                            atomicHierarchy: {
                              chains: {
                                label_asym_id: { value: () => chainId },
                                auth_asym_id: { value: () => chainId },
                                label_entity_id: { value: () => '1' },
                              },
                              residues: {
                                auth_seq_id: { value: (idx: number) => idx + 1 },
                              },
                              atoms: {
                                label_comp_id: { value: (idx: number) => compIds[idx] },
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
}

describe('sequence metadata after an authored scene change', () => {
  it('refreshes metadata when a new scene reuses the same loaded plugin', () => {
    const plugin = pluginWithSingleChain(['ALA'], 'A');
    const { result, rerender } = renderHook(
      ({ revision }) => useSequenceData(plugin, 'chain', true, revision),
      { initialProps: { revision: 'first-scene' } }
    );
    expect(result.current?.chains.map((chain) => chain.chainId)).toEqual(['A']);
    plugin.managers.structure.hierarchy.current.structures = pluginWithSingleChain(
      ['GLY'],
      'B'
    ).managers.structure.hierarchy.current.structures;
    rerender({ revision: 'second-scene' });
    expect(result.current?.chains.map((chain) => chain.chainId)).toEqual(['B']);
  });
});

describe('extractSequenceDataFromPlugin — nucleic-acid chains', () => {
  it('holds exactly one character per residue in a DNA chain sequence', () => {
    const chain = extractSequenceDataFromPlugin(pluginWithSingleChain(DNA_COMP_IDS), 'chain')
      ?.chains[0];

    expect(chain?.sequence).toBe(EXPECTED_ONE_LETTER);
    expect(chain?.sequence.length).toBe(chain?.residues.length);
  });

  it('gives every DNA residue a one-character code and a separate deoxy display label', () => {
    const chain = extractSequenceDataFromPlugin(pluginWithSingleChain(DNA_COMP_IDS), 'chain')
      ?.chains[0];

    for (const residue of chain?.residues ?? []) {
      expect(residue.name).toHaveLength(1);
    }
    expect(chain?.residues[0]).toMatchObject({ name: 'C', displayLabel: 'dC', name3: 'DC' });
    expect(chain?.residues[4]).toMatchObject({ name: 'A', displayLabel: 'dA', name3: 'DA' });
    expect(chain?.residues[6]).toMatchObject({ name: 'T', displayLabel: 'dT', name3: 'DT' });
    expect(chain?.residues[1]).toMatchObject({ name: 'G', displayLabel: 'dG', name3: 'DG' });
  });

  it('labels the chain as DNA so its type lives on the chain, not inside each code', () => {
    const chain = extractSequenceDataFromPlugin(pluginWithSingleChain(DNA_COMP_IDS), 'chain')
      ?.chains[0];
    expect(chain?.polymerType).toBe('dna');
  });

  it('distinguishes RNA from DNA even though they share one-letter codes', () => {
    const rna = extractSequenceDataFromPlugin(pluginWithSingleChain(['A', 'C', 'G', 'U']), 'chain')
      ?.chains[0];

    expect(rna?.polymerType).toBe('rna');
    expect(rna?.sequence).toBe('ACGU');
    expect(rna?.residues.every((residue) => residue.displayLabel === undefined)).toBe(true);
  });

  it('does not mislabel ambiguous legacy A/C/G/T input as RNA', () => {
    const legacyDna = extractSequenceDataFromPlugin(
      pluginWithSingleChain(['A', 'C', 'G', 'T']),
      'chain'
    );

    expect(legacyDna?.chains[0]?.polymerType).toBe('unknown');
    expect(legacyDna?.chains[0]?.sequence).toBe('ACG');
    expect(legacyDna?.ligands).toContainEqual(
      expect.objectContaining({ name: 'T', chainId: 'A', position: 4 })
    );
  });

  it('does not invent a molecule type for ambiguous A/C/G-only chains', () => {
    const ambiguous = extractSequenceDataFromPlugin(pluginWithSingleChain(['A', 'C', 'G']), 'chain')
      ?.chains[0];

    expect(ambiguous?.polymerType).toBe('unknown');
  });

  it('labels an ordinary protein chain as protein and leaves it untouched', () => {
    const protein = extractSequenceDataFromPlugin(
      pluginWithSingleChain(['MET', 'THR', 'GLU', 'TYR', 'LYS']),
      'chain'
    )?.chains[0];

    expect(protein?.polymerType).toBe('protein');
    expect(protein?.sequence).toBe('MTEYK');
    expect(protein?.residues.every((residue) => residue.displayLabel === undefined)).toBe(true);
  });

  it('reports a chimeric deoxy/ribo strand as mixed rather than guessing a winner', () => {
    const hybrid = extractSequenceDataFromPlugin(
      pluginWithSingleChain(['DA', 'DC', 'A', 'U']),
      'chain'
    )?.chains[0];

    expect(hybrid?.polymerType).toBe('mixed');
    expect(hybrid?.sequence).toBe('ACAU');
  });

  it('does not call a deoxy plus ambiguous A/C/G hybrid pure DNA', () => {
    const hybridWithoutUridine = extractSequenceDataFromPlugin(
      pluginWithSingleChain(['DA', 'DC', 'A', 'G']),
      'chain'
    )?.chains[0];

    expect(hybridWithoutUridine?.polymerType).toBe('unknown');
    expect(hybridWithoutUridine?.sequence).toBe('ACAG');
  });

  it('does not label a protein/nucleotide chain as DNA/RNA', () => {
    const mixedFamily = extractSequenceDataFromPlugin(
      pluginWithSingleChain(['ALA', 'DA', 'U']),
      'chain'
    )?.chains[0];

    expect(mixedFamily?.polymerType).toBe('unknown');
  });
});
