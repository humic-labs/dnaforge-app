import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { encodedResidueIdentity, readEncodedPolymerChain } from './encodedPolymer';
import { extractSequenceDataFromPlugin } from '../hooks/useSequenceData';
import { Structure } from 'molstar/lib/mol-model/structure';

const source = (id: string) =>
  readFileSync(
    resolve(process.cwd(), '../../test-fixtures/structure-complexes/rcsb', `${id}.cif`),
    'utf8'
  );
const rnaSequence = 'GCGGAUUUAGCUCAGUUGGGAGAGCGCCAGACUGAAGAUCUGGAGGUCCUGUGUUCGAUCCACAGAAUUCGCACCA';
async function modelFrom(text: string) {
  const parsed = await CIF.parseText(text).run();
  if (parsed.isError) throw new Error(parsed.message);
  return (await trajectoryFromMmCIF(parsed.result.blocks[0]).run()).representative;
}
const pdbSource = () =>
  readFileSync(
    resolve(process.cwd(), '../../test-fixtures/structure-complexes/rcsb/1EHZ.pdb'),
    'utf8'
  );
async function pdbModelFrom(text: string) {
  const parsed = await parsePDB(text).run();
  if (parsed.isError) throw new Error(parsed.message);
  return (await trajectoryFromPDB(parsed.result).run()).representative;
}
const rnaChain = (model: Awaited<ReturnType<typeof modelFrom>>) =>
  readEncodedPolymerChain(model, 0)!;

describe('encoded polymers retain physical chemistry and exact parent scope', () => {
  it('keeps deposited magnesium outside PDB protein sequence rows that share its native chain', async () => {
    const model = await pdbModelFrom(
      readFileSync(
        resolve(process.cwd(), '../../test-fixtures/structure-complexes/rcsb/3OAA.pdb'),
        'utf8'
      )
    );
    const displayed = extractSequenceDataFromPlugin(
      {
        managers: {
          structure: {
            hierarchy: {
              current: { structures: [{ cell: { obj: { data: Structure.ofModel(model) } } }] },
            },
          },
        },
      },
      'chain'
    );
    expect(displayed?.chains.find((chain) => chain.chainId === 'A')?.residues).toHaveLength(488);
    expect(
      displayed?.chains.flatMap((chain) => chain.residues.map((residue) => residue.name3))
    ).not.toContain('MG');
    expect(displayed?.ligands).toContainEqual(
      expect.objectContaining({ name: 'MG', chainId: 'A', position: 601, atomCount: 1 })
    );
    expect(model.atomicHierarchy.atoms.label_comp_id.toArray()).toContain('MG');
    expect(readEncodedPolymerChain(model, 0)?.components).not.toContain('MG');
  });

  it('recognizes deposited PDB MODRES parents through native author-to-label positions', async () => {
    const model = await pdbModelFrom(pdbSource());
    expect(rnaChain(model)).toMatchObject({ kind: 'rna', sequence: rnaSequence, unresolved: [] });
    expect(encodedResidueIdentity(model, 'A', 37, 'YYG')).toEqual({
      code: 'G',
      category: 'rna',
      parentCompId: 'G',
    });
    expect(model.atomicHierarchy.atoms.label_comp_id.toArray()).toContain('YYG');
    expect(encodedResidueIdentity(model, 'A', undefined, 'MG')).toBeNull();
    const plugin = {
      managers: {
        structure: {
          hierarchy: {
            current: {
              structures: [{ cell: { obj: { data: Structure.ofModel(model) } } }],
            },
          },
        },
      },
    };
    const displayed = extractSequenceDataFromPlugin(plugin, 'chain');
    expect(displayed?.chains[0].residues).toHaveLength(76);
    expect(displayed?.chains[0].residues[36]).toMatchObject({
      name: 'G',
      name3: 'YYG',
      parentCompId: 'G',
    });
    expect(displayed?.ligands).toHaveLength(9);
  });

  it.each(['missing', 'chain', 'position', 'insertion', 'component', 'conflicting'])(
    'preserves the unresolved PDB RNA position for %s parent metadata',
    async (fault) => {
      const original = pdbSource();
      const record = original
        .split('\n')
        .find((line) => line.startsWith('MODRES') && line.slice(12, 15) === 'YYG')!;
      const change = (from: number, to: number, value: string) =>
        record.slice(0, from) + value + record.slice(to);
      const replacement =
        fault === 'missing'
          ? ''
          : fault === 'chain'
            ? change(16, 17, 'Z')
            : fault === 'position'
              ? change(18, 22, '  38')
              : fault === 'insertion'
                ? change(22, 23, 'B')
                : fault === 'component'
                  ? change(12, 15, 'OMG')
                  : record + '\n' + change(24, 27, '  A');
      const text = original.replace(record, replacement);
      expect(text).not.toBe(original);
      const chain = rnaChain(await pdbModelFrom(text));
      expect(chain.sequence).toHaveLength(76);
      expect(chain.sequence[36]).toBe('N');
      expect(chain.unresolved).toContainEqual(expect.objectContaining({ sequenceIndex: 36 }));
    }
  );

  it('recognizes all modified tRNA positions from deposited parents without rewriting atoms', async () => {
    const model = await modelFrom(source('1EHZ'));
    const chain = rnaChain(model);
    expect(chain).toMatchObject({ kind: 'rna', sequence: rnaSequence, unresolved: [] });
    expect(chain.positions).toEqual(Array.from({ length: 76 }, (_, i) => i + 1));
    expect(chain.components[36]).toBe('YYG');
    expect(encodedResidueIdentity(model, 'A', 37, 'YYG')).toEqual({
      code: 'G',
      category: 'rna',
      parentCompId: 'G',
    });
    expect(model.atomicHierarchy.atoms.label_comp_id.toArray()).toContain('YYG');
    expect(encodedResidueIdentity(model, 'B', 37, 'YYG')).toBeNull();
  });

  it.each([
    ['missing parent', '7 A YYG 37 A YYG 37 ? ? ?'],
    ['multiple parents', "7 A YYG 37 A YYG 37 ? 'G,A' ?"],
    ['wrong position', '7 A YYG 38 A YYG 37 ? G ?'],
    ['wrong component', '7 A OMG 37 A YYG 37 ? G ?'],
    ['wrong chain', '7 Z YYG 37 A YYG 37 ? G ?'],
  ])('retains an unresolved sequence position for %s', async (_case, replacement) => {
    const text = source('1EHZ').replace(/^7\s+A YYG 37 A YYG 37 \? G \?\s*$/m, replacement);
    expect(text).not.toBe(source('1EHZ'));
    const model = await modelFrom(text),
      chain = rnaChain(model);
    expect(chain.sequence).toHaveLength(76);
    expect(chain.sequence[36]).toBe('N');
    expect(chain.unresolved).toContainEqual(
      expect.objectContaining({ sequenceIndex: 36, components: ['YYG'] })
    );
    const plugin = {
      managers: {
        structure: {
          hierarchy: {
            current: {
              structures: [{ cell: { obj: { data: Structure.ofModel(model) } } }],
            },
          },
        },
      },
    };
    const displayed = extractSequenceDataFromPlugin(plugin, 'chain')?.chains[0];
    expect(displayed?.residues).toHaveLength(76);
    expect(displayed?.residues[36]).toMatchObject({ name: 'N', name3: 'YYG', labelSeqId: 37 });
  });

  it('refuses contradictory duplicate parents instead of choosing the last row', async () => {
    const text = source('1EHZ').replace(
      /^(7\s+A YYG 37 A YYG 37 \? G \?)\s*$/m,
      '$1\n15 A YYG 37 A YYG 37 ? A ?'
    );
    const chain = rnaChain(await modelFrom(text));
    expect(chain.sequence[36]).toBe('N');
    expect(chain.unresolved).toHaveLength(1);
  });

  it('does not allow deposited parent metadata to relabel known methionine chemistry', async () => {
    const text = source('1A8O').replace(/^(1\s+A MSE 1\s+A MSE 151 \? )MET/m, '$1LEU');
    expect(text).not.toBe(source('1A8O'));
    const model = await modelFrom(text),
      chain = readEncodedPolymerChain(model, 0)!;
    expect(chain.sequence).toHaveLength(70);
    expect(chain.sequence[0]).toBe('X');
    expect(chain.unresolved).toContainEqual(expect.objectContaining({ sequenceIndex: 0 }));
  });

  it('retains differing monomers at one sequence position as an unresolved identity', async () => {
    const text = source('1EHZ').replace(/^(1\s+37\s+YYG\s+\S+)\s*$/m, '$1\n1 37 A y');
    expect(text).not.toBe(source('1EHZ'));
    const chain = rnaChain(await modelFrom(text));
    expect(chain.sequence).toHaveLength(76);
    expect(chain.sequence[36]).toBe('N');
    expect(chain.unresolved).toContainEqual(expect.objectContaining({ sequenceIndex: 36 }));
  });
});
