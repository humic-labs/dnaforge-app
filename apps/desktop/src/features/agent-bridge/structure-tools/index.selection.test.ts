import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure';
import { SymmetryOperator } from 'molstar/lib/mol-math/geometry/symmetry-operator';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { lociForSelection } from './index';
import { extractSequenceDataFromPlugin } from '../../page/public/embeds/structure3d/hooks/useSequenceData';
import { readMolstarLociResidues } from '../../page/public/embeds/structure3d/utils/molstarSelectionReadback';
import { molecularSceneSelections } from '../../page/public/embeds/structure3d/molstar/molecularSceneSelections';

async function physicalCopies() {
  const parsed = await parsePDB(
    [
      'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 20.00           C  ',
      'ATOM      2  N   ALA A   1       1.000   0.000   0.000  1.00 20.00           N  ',
      'TER',
      'HETATM    3  C1  BIO B   2       2.000   0.000   0.000  1.00 20.00           C  ',
      'END',
    ].join('\n')
  ).run();
  if (parsed.isError) throw Error(parsed.message);
  const original = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
  const operator = SymmetryOperator.create(
    'ASM_2',
    Mat4.fromTranslation(Mat4(), Vec3.create(20, 0, 0)),
    { instanceId: 'ASM-X0-2' }
  );
  const copiedUnits = original.units.map((unit) => unit.applyOperator(unit.id + 100, operator));
  const assembly = Structure.create([...original.units, ...copiedUnits]);
  const plugin = molstarPluginFixture({
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [{ cell: { obj: { data: original } } }],
          },
        },
      },
    },
  });
  return { plugin, assembly };
}

describe('interaction selection against exact native physical copies', () => {
  it('round-trips the native instance identity through inventory, residue readback and residual legend owners', async () => {
    const { plugin, assembly } = await physicalCopies();
    const copy = assembly.units.find((unit) => unit.conformation.operator.name === 'ASM_2')!;
    const chain = copy.model.atomicHierarchy.chains.label_asym_id.value(
      copy.chainIndex[copy.elements[0]]
    );
    const selected = lociForSelection(
      plugin,
      { label_asym_id: chain, instance_id: copy.conformation.operator.instanceId },
      assembly
    );
    if (!StructureElement.Loci.is(selected)) throw Error('Expected exact native atom loci');
    const residues = readMolstarLociResidues(selected);
    expect(residues[0]).toMatchObject({ operator: 'ASM_2', instanceId: 'ASM-X0-2' });
    const selectedAgain = lociForSelection(
      plugin,
      { label_asym_id: residues[0].labelAsymId, instance_id: residues[0].instanceId },
      assembly
    );
    expect(StructureElement.Loci.size(selectedAgain as StructureElement.Loci)).toBe(2);
    const inventory = extractSequenceDataFromPlugin(
      {
        managers: {
          structure: {
            hierarchy: { current: { structures: [{ cell: { obj: { data: assembly } } }] } },
          },
        },
      } as never,
      'chain'
    );
    expect(inventory?.chains.find((c) => c.operator === 'ASM_2')).toMatchObject({
      instanceId: 'ASM-X0-2',
    });
    expect(inventory?.ligands.find((l) => l.operator === 'ASM_2')).toMatchObject({
      instanceId: 'ASM-X0-2',
    });
    const owners = molecularSceneSelections(assembly).describeResidualGroups('all', []);
    expect(
      owners.reduce(
        (sum, owner) =>
          sum +
          StructureElement.Loci.size(
            lociForSelection(plugin, owner.selector, assembly) as StructureElement.Loci
          ),
        0
      )
    ).toBe(assembly.elementCount);
  });
  it('selects one transformed chain instance while the legacy chain string selects both copies', async () => {
    const { plugin, assembly } = await physicalCopies();
    const selected = lociForSelection(
      plugin,
      { auth_asym_id: 'A', instance_id: 'ASM-X0-2' },
      assembly
    );
    expect(StructureElement.Loci.is(selected)).toBe(true);
    if (!StructureElement.Loci.is(selected)) throw Error('Expected exact native atom loci');
    expect(StructureElement.Loci.size(selected)).toBe(2);
    expect(selected.elements.map(({ unit }) => unit.conformation.operator.instanceId)).toEqual([
      'ASM-X0-2',
    ]);
    const unit = selected.elements[0].unit;
    expect(Array.from(unit.elements, (atom) => unit.conformation.x(atom))).toEqual([20, 21]);
    const legacy = lociForSelection(plugin, 'chain A', assembly);
    if (!StructureElement.Loci.is(legacy)) throw Error('Expected legacy native atom loci');
    expect(StructureElement.Loci.size(legacy)).toBe(4);
  });

  it('supports exact atom-index OR selectors without merging identical atoms from other instances', async () => {
    const { plugin, assembly } = await physicalCopies();
    const atomIndex = assembly.units[0].elements[0];
    const selected = lociForSelection(
      plugin,
      [
        { atom_index: atomIndex, instance_id: 'ASM-X0-2' },
        { auth_asym_id: 'B', instance_id: '1_555' },
      ],
      assembly
    );
    if (!StructureElement.Loci.is(selected)) throw Error('Expected exact native atom loci');
    expect(StructureElement.Loci.size(selected)).toBe(2);
    expect(
      selected.elements.map(({ unit }) => unit.conformation.operator.instanceId).sort()
    ).toEqual(['1_555', 'ASM-X0-2']);
    expect(() =>
      lociForSelection(plugin, { atom_index: atomIndex, instance_id: 'ASM-X0-2' })
    ).toThrow('declared coordinate source');
  });
});
