import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parseCoordinateInventory } from './coordinate-inventory';

it('keeps both deposited DNA strands separate from water entities sharing their PDB chain labels', async () => {
  const bytes = readFileSync(
    resolve(process.cwd(), '../../test-fixtures/structure-complexes/rcsb/1BNA.pdb')
  );
  const { inventory, mappings } = await parseCoordinateInventory({ bytes, format: 'pdb' });
  expect(inventory.coordinateSha256).toBe(
    'df42f1506792f191b957227b061360652adcf6f813eb69d9ec553067ea584670'
  );
  const strands = inventory.chains.filter((chain) => chain.kind === 'dna');
  expect(strands.map((chain) => chain.authAsymId).sort()).toEqual(['A', 'B']);
  expect(new Set(inventory.chains.map((chain) => chain.key)).size).toBe(inventory.chains.length);
  for (const chain of strands) {
    expect(chain).toMatchObject({
      sequence: 'CGCGAATTCGCG',
      sequenceEvidence: 'declared',
      unresolved: [],
    });
    expect(chain.observedResidues).toHaveLength(12);
    expect(chain.observedResidues.flatMap((residue) => residue.componentIds)).not.toContain('HOH');
    expect(mappings.find((mapping) => mapping.chainKey === chain.key)).toMatchObject({
      relationship: 'exact',
      status: 'mapped',
      mappedCount: 12,
      mismatchCount: 0,
    });
  }
  const second = strands.find((chain) => chain.authAsymId === 'B')!;
  expect(second.observedResidues[0]).toMatchObject({
    authorSequenceId: 13,
    componentIds: ['DC'],
    encodedCode: 'C',
  });
  const water = inventory.chains.filter((chain) => chain.kind === 'non-polymer');
  expect(water.length).toBeGreaterThan(0);
  expect(
    water.flatMap((chain) => chain.observedResidues.flatMap((residue) => residue.componentIds))
  ).toContain('HOH');
});
