import { describe, expect, it } from 'vitest';
import { findDuplicateMolViewSpecGeometry } from './molViewSpecGeometry';
import type { MolstarPlugin } from './cache';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure } from 'molstar/lib/mol-model/structure';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';

function pluginWithRepresentations(
  entries: Array<{
    chain: string;
    type: string;
    elements: number[];
    color: string;
    size?: number;
    matrix?: number[];
    visuals?: string[];
    native?: Record<string, unknown>;
  }>
): MolstarPlugin {
  const components = entries.map((entry) => ({
    cell: {
      obj: {
        label: entry.chain,
        data: {
          elementCount: entry.elements.length,
          units: [
            {
              id: 1,
              model: { id: 'model-1' },
              conformation: { operator: { matrix: entry.matrix ?? [1, 0, 0, 1] } },
              elements: entry.elements,
            },
          ],
        },
      },
    },
    representations: [
      {
        cell: {
          params: {
            values: {
              type: {
                name: entry.type,
                params: {
                  alpha: 1,
                  sizeFactor: entry.size ?? 1,
                  ...(entry.visuals ? { visuals: entry.visuals } : {}),
                  ...entry.native,
                },
              },
              sizeTheme: { name: 'uniform', params: { value: 1 } },
              colorTheme: { name: 'uniform', params: { value: entry.color } },
            },
          },
          obj: {
            data: { repr: { state: { visible: true, alphaFactor: 1 }, props: { alpha: 1 } } },
          },
        },
      },
    ],
  }));
  return {
    managers: { structure: { hierarchy: { current: { structures: [{ components }] } } } },
  } as unknown as MolstarPlugin;
}

describe('MolViewSpec duplicate geometry audit', () => {
  it('counts retained contact sugar/phosphate atoms and their native attachment in simplified detail', async () => {
    const parsed = await parsePDB(
      [
        'ATOM      1  P     A R   1       0.000   0.000   0.000  1.00 20.00           P  ',
        "ATOM      2  C1'   A R   1       1.000   0.000   0.000  1.00 20.00           C  ",
        'ATOM      3  N9    A R   1       2.000   0.000   0.000  1.00 20.00           N  ',
        'END',
      ].join('\n')
    ).run();
    if (parsed.isError) throw Error(parsed.message);
    const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
    const phosphorus = substructureFromSelector(
      source,
      componentPropsFromSelector({ label_atom_id: 'P' })
    );
    const plugin = pluginWithRepresentations([
      {
        chain: 'contacted nucleotide',
        type: 'ball-and-stick',
        elements: [0, 1, 2],
        color: 'elements',
        native: {
          dnaforgeNucleotideAtomicMode: 'base-only',
          dnaforgeNucleotideKeepAtoms: [{ label_atom_id: 'P' }],
        },
      },
      { chain: 'duplicate phosphate', type: 'spacefill', elements: [0], color: 'orange' },
      {
        chain: 'duplicate connector',
        type: 'cartoon',
        elements: [0, 1, 2],
        color: 'gray',
        visuals: ['dnaforge-nucleotide-connector'],
      },
    ]);
    const components = plugin.managers.structure.hierarchy.current.structures[0].components;
    components[0].cell.obj!.data = source;
    components[1].cell.obj!.data = phosphorus;
    components[2].cell.obj!.data = source;
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([
      expect.objectContaining({ feature: 'atomistic', repeatedElementCount: 1 }),
      expect.objectContaining({ feature: 'nucleotide-attachment', repeatedElementCount: 1 }),
    ]);
  });
  it('accepts a native empty component whose null representation has no type name', () => {
    const plugin = pluginWithRepresentations([
      { chain: 'Absent ligand', type: 'ball-and-stick', elements: [], color: 'elements' },
    ]);
    const representation =
      plugin.managers.structure.hierarchy.current.structures[0].components[0].representations[0];
    representation.cell.params!.values.type = {
      params: {},
    } as typeof representation.cell.params.values.type;
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([]);
  });

  it('allows trace and base-plane visuals to own complementary features of the same selection', () => {
    const plugin = pluginWithRepresentations([
      {
        chain: 'RNA context',
        type: 'cartoon',
        elements: [1, 2, 3],
        color: 'gray',
        visuals: ['polymer-trace'],
      },
      {
        chain: 'RNA evidence',
        type: 'cartoon',
        elements: [1, 2, 3],
        color: 'pink',
        visuals: ['dnaforge-nucleotide-base-plane'],
      },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([]);
  });

  it('rejects base faces owned by both native rings and a plane-only visual', () => {
    const plugin = pluginWithRepresentations([
      {
        chain: 'RNA context',
        type: 'cartoon',
        elements: [1, 2, 3],
        color: 'gray',
        visuals: ['nucleotide-ring'],
      },
      {
        chain: 'RNA evidence',
        type: 'cartoon',
        elements: [2],
        color: 'pink',
        visuals: ['dnaforge-nucleotide-base-plane'],
      },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([
      expect.objectContaining({ repeatedElementCount: 1 }),
    ]);
  });

  it('rejects two visuals inside one representation drawing the same base faces', () => {
    const plugin = pluginWithRepresentations([
      {
        chain: 'RNA',
        type: 'cartoon',
        elements: [1, 2, 3],
        color: 'pink',
        visuals: ['nucleotide-ring', 'dnaforge-nucleotide-base-plane'],
      },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([
      expect.objectContaining({ repeatedElementCount: 3 }),
    ]);
  });

  it('detects the full-chain cartoon plus same-style residue cartoon that caused GroEL', () => {
    const plugin = pluginWithRepresentations([
      { chain: 'A', type: 'cartoon', elements: [1, 2, 3, 4], color: 'gray' },
      { chain: 'A:191-376', type: 'cartoon', elements: [2, 3], color: 'teal' },
    ]);

    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([
      expect.objectContaining({
        type: 'cartoon',
        smallerComponent: 'A:191-376',
        largerComponent: 'A',
        repeatedElementCount: 2,
      }),
    ]);
  });

  it('accepts a cartoon with atomic sticks over selected residues', () => {
    const plugin = pluginWithRepresentations([
      { chain: 'A', type: 'cartoon', elements: [1, 2, 3, 4], color: 'gray' },
      { chain: 'A:site', type: 'ball-and-stick', elements: [2, 3], color: 'elements' },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([]);
  });

  it('rejects two atomistic depictions of the same oxygen even when styles differ', () => {
    const plugin = pluginWithRepresentations([
      {
        chain: 'filter backbone',
        type: 'ball-and-stick',
        elements: [1, 2, 3, 4],
        color: 'elements',
      },
      { chain: 'filter oxygen', type: 'spacefill', elements: [4], color: 'red' },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([
      expect.objectContaining({ repeatedElementCount: 1 }),
    ]);
  });

  it('rejects a backbone path drawn as both cartoon and backbone', () => {
    const plugin = pluginWithRepresentations([
      { chain: 'context', type: 'cartoon', elements: [1, 2, 3], color: 'gray' },
      { chain: 'highlight', type: 'backbone', elements: [2], color: 'blue' },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([
      expect.objectContaining({ repeatedElementCount: 1 }),
    ]);
  });

  it('detects partial overlap of two same-style cartoons', () => {
    const plugin = pluginWithRepresentations([
      { chain: 'first', type: 'cartoon', elements: [1, 2, 3], color: 'gray' },
      { chain: 'second', type: 'cartoon', elements: [3, 4], color: 'teal' },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([
      expect.objectContaining({ repeatedElementCount: 1 }),
    ]);
  });

  it('accepts separately transformed copies of the same source atoms', () => {
    const plugin = pluginWithRepresentations([
      { chain: 'original', type: 'cartoon', elements: [1, 2, 3], color: 'gray' },
      {
        chain: 'translated',
        type: 'cartoon',
        elements: [1, 2, 3],
        color: 'teal',
        matrix: [1, 0, 20, 1],
      },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([]);
  });

  it('rejects a thinner same-type cartoon on top of the same backbone', () => {
    const plugin = pluginWithRepresentations([
      { chain: 'A', type: 'cartoon', elements: [1, 2, 3, 4], color: 'gray' },
      { chain: 'A:wide', type: 'cartoon', elements: [2, 3], color: 'teal', size: 2 },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([
      expect.objectContaining({ repeatedElementCount: 2 }),
    ]);
  });

  it('accepts disjoint same-type selections', () => {
    const plugin = pluginWithRepresentations([
      { chain: 'A', type: 'cartoon', elements: [1, 2, 3, 4], color: 'gray' },
      { chain: 'B', type: 'cartoon', elements: [5, 6], color: 'red' },
    ]);
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([]);
  });
});
