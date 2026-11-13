import { describe, expect, it, vi } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure, StructureElement, Unit } from 'molstar/lib/mol-model/structure';
import type { MolstarPlugin } from './cache';
import type { MolViewSpecColorGroup } from './molViewSpecLegend';
import {
  focusMolViewSpecColorGroup,
  resolveMolViewSpecColorGroupLoci,
  selectMolViewSpecColorGroup,
} from './molViewSpecSwatchSelection';
import { extractEffectiveChainInfo } from '../utils/molstarChainUtils';
import { chainInstanceIdForIdentity } from '../utils/structureIds';
import { readMolstarLociResidues } from '../utils/molstarSelectionReadback';

const runtime = vi.hoisted(() => ({ scene: 'loaded-scene', snapshotIndex: 0 }));
vi.mock('./molViewSpec', () => ({
  activeMolViewSpecScene: () => runtime.scene,
  activeMolViewSpecSnapshotIndex: () => runtime.snapshotIndex,
  sameLoadedMolViewSpecScene: (loaded: string, requested: string) => loaded === requested,
}));

const PDB = [
  'HEADER    SWATCH SELECTION TEST',
  'ATOM      1  N   ALA A   1      11.104  13.207   7.216  1.00 20.00           N',
  'ATOM      2  CA  ALA A   1      12.560  13.207   7.216  1.00 20.00           C',
  'ATOM      3  C   ALA A   1      13.000  14.620   7.216  1.00 20.00           C',
  'ATOM      4  O   ALA A   1      12.220  15.560   7.216  1.00 20.00           O',
  'HETATM    5 MG    MG A 601      14.500  13.500   7.216  1.00 20.00          MG',
  'HETATM    6 MG    MG B 601      19.500  13.500   7.216  1.00 20.00          MG',
  'TER',
  'END',
  '',
].join('\n');

async function viewer() {
  const parsed = await parsePDB(PDB).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromPDB(parsed.result).run();
  const structure = Structure.ofModel(trajectory.representative);
  const deselectAll = vi.fn();
  const select = vi.fn();
  const plugin = {
    state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
    managers: {
      structure: {
        hierarchy: { current: { structures: [{ cell: { obj: { data: structure } } }] } },
      },
      interactivity: { lociSelects: { deselectAll, select } },
    },
  } as unknown as MolstarPlugin;
  return { plugin, structure, deselectAll, select };
}

function group(laterColorSelectors: unknown[]): MolViewSpecColorGroup {
  return {
    id: 'protein',
    label: 'Protein',
    color: 0xb74583,
    selectable: true,
    structureCount: 1,
    targets: [
      {
        structureIndex: 0,
        componentSelector: 'protein',
        colorSelector: 'all',
        laterColorSelectors,
      },
    ],
  };
}

describe('native MolViewSpec swatch selection', () => {
  it('targets the same exact atoms without changing the native highlight', async () => {
    const { plugin, deselectAll, select } = await viewer();
    const focusLoci = vi.fn();
    Object.assign(plugin.managers, { camera: { focusLoci } });
    expect(focusMolViewSpecColorGroup(plugin, runtime.scene, 0, group([]))).toBe(4);
    expect(focusLoci).toHaveBeenCalledOnce();
    expect(StructureElement.Loci.size(focusLoci.mock.calls[0][0][0])).toBe(4);
    expect(deselectAll).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(() => focusMolViewSpecColorGroup(plugin, 'stale-scene', 0, group([]))).toThrow(
      /changed/
    );
    expect(focusLoci).toHaveBeenCalledOnce();
  });
  it('resolves inherited MVS tags along one native transform lineage', async () => {
    const { plugin, structure } = await viewer();
    const entry = {
      cell: { transform: { ref: 'base' }, obj: { data: structure } },
      transform: { cell: { transform: { ref: 'final' }, obj: { data: structure } } },
    };
    plugin.managers.structure.hierarchy.current.structures = [entry] as never;
    Object.assign(plugin, {
      state: {
        data: {
          tree: {
            transforms: new Map([
              ['final', { parent: 'previous' }],
              ['previous', { parent: 'base' }],
              ['base', { parent: 'root' }],
            ]),
          },
          cells: new Map([
            ['previous', { transform: { ref: 'previous' }, obj: { data: structure } }],
            ['final', entry.transform.cell],
          ]),
        },
      },
    });
    for (const ref of ['previous', 'final'])
      Object.assign(plugin.state.data.tree.transforms.get(ref)!, { tags: ['mvs-ref:placed'] });
    const placed = { ...group([]), targets: [{ ...group([]).targets[0], structureRef: 'placed' }] };
    expect(selectMolViewSpecColorGroup(plugin, runtime.scene, 0, placed)).toBe(4);
  });
  it('selects source-qualified atoms when native hierarchy order is reversed', async () => {
    const first = await viewer();
    const second = await viewer();
    const a = { cell: { transform: { ref: 'one' }, obj: { data: first.structure } } };
    const b = { cell: { transform: { ref: 'two' }, obj: { data: second.structure } } };
    first.plugin.managers.structure.hierarchy.current.structures = [b, a] as never;
    Object.assign(first.plugin, {
      state: {
        data: {
          tree: {
            transforms: new Map([
              ['one', { tags: ['mvs-ref:one'] }],
              ['two', { tags: ['mvs-ref:two'] }],
            ]),
          },
          cells: new Map([
            ['one', a.cell],
            ['two', b.cell],
          ]),
        },
      },
    });
    const multi = {
      ...group([]),
      structureCount: 2,
      targets: [
        { ...group([]).targets[0], structureRef: 'one', colorSelector: { label_atom_id: 'CA' } },
        {
          ...group([]).targets[0],
          structureIndex: 1,
          structureRef: 'two',
          componentSelector: 'all',
          colorSelector: { label_comp_id: 'MG' },
        },
      ],
    };
    expect(selectMolViewSpecColorGroup(first.plugin, runtime.scene, 0, multi)).toBe(3);
    expect(first.select).toHaveBeenCalledTimes(2);
    expect(first.select.mock.calls.map((c) => c[0].loci.structure)).toEqual([
      first.structure,
      second.structure,
    ]);
    expect(first.select.mock.calls.map((c) => StructureElement.Loci.size(c[0].loci))).toEqual([
      1, 2,
    ]);
  });

  it('rejects ambiguous MVS ownership before changing the native selection', async () => {
    const { plugin, structure, deselectAll } = await viewer();
    Object.assign(plugin, {
      state: {
        data: {
          tree: {
            transforms: new Map([
              ['one', { tags: ['mvs-ref:ambiguous'] }],
              ['two', { tags: ['mvs-ref:ambiguous'] }],
            ]),
          },
          cells: new Map([
            ['one', { transform: { ref: 'one' }, obj: { data: structure } }],
            ['two', { transform: { ref: 'two' }, obj: { data: structure } }],
          ]),
        },
      },
    });
    const ambiguous = {
      ...group([]),
      targets: [{ ...group([]).targets[0], structureRef: 'ambiguous' }],
    };
    expect(() => selectMolViewSpecColorGroup(plugin, runtime.scene, 0, ambiguous)).toThrow(
      /ambiguous/
    );
    expect(deselectAll).not.toHaveBeenCalled();
  });
  it('reads every ligand copy selected by a named color group without changing the live selection', async () => {
    const { plugin, deselectAll, select } = await viewer();
    const groupWithTwoLigands: MolViewSpecColorGroup = {
      ...group([]),
      id: 'Bound magnesium',
      label: 'Bound magnesium',
      targets: [
        {
          structureIndex: 0,
          componentSelector: 'all',
          colorSelector: { label_comp_id: 'MG' },
          laterColorSelectors: [],
        },
      ],
    };
    const residues = readMolstarLociResidues(
      resolveMolViewSpecColorGroupLoci(plugin, groupWithTwoLigands)
    );
    expect(residues).toHaveLength(2);
    expect(residues.map((residue) => residue.compId)).toEqual(['MG', 'MG']);
    expect(new Set(residues.map((residue) => residue.authAsymId))).toEqual(new Set(['A', 'B']));
    expect(deselectAll).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('selects only painted atoms after a later layer repaints one atom', async () => {
    const { plugin, deselectAll, select } = await viewer();
    expect(
      selectMolViewSpecColorGroup(plugin, runtime.scene, 0, group([{ label_atom_id: 'CA' }]))
    ).toBe(3);
    expect(deselectAll).toHaveBeenCalledOnce();
    expect(StructureElement.Loci.size(select.mock.calls[0][0].loci)).toBe(3);
    expect(select.mock.calls[0][1]).toBe(false);
  });

  it('leaves the old selection intact when a swatch owns no visible atoms or the story changed', async () => {
    const { plugin, deselectAll, select } = await viewer();
    expect(() => selectMolViewSpecColorGroup(plugin, runtime.scene, 0, group(['all']))).toThrow(
      'no atoms'
    );
    expect(() => selectMolViewSpecColorGroup(plugin, runtime.scene, 1, group([]))).toThrow(
      'changed'
    );
    expect(deselectAll).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('does not select atoms hidden by the chain visibility control', async () => {
    const { plugin, structure, deselectAll, select } = await viewer();
    const unit = structure.units.find(Unit.isAtomic)!;
    const chain = extractEffectiveChainInfo(
      unit,
      unit.model.atomicHierarchy.chains,
      unit.chainIndex[unit.elements[0]]
    )!;
    const hiddenId = chainInstanceIdForIdentity({
      chainId: chain.effectiveChainId,
      authAsymId: chain.authAsymId,
      labelAsymId: chain.labelAsymId,
      entityId: chain.entityId,
      operator: chain.operator,
    });
    expect(() =>
      selectMolViewSpecColorGroup(plugin, runtime.scene, 0, group([]), [hiddenId])
    ).toThrow('no atoms');
    expect(deselectAll).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});
