import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure, StructureSymmetry } from 'molstar/lib/mol-model/structure';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { buildMolecularInteractionContext } from './molecularInteractionContext';
import { molecularSceneSelections } from './molecularSceneSelections';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import kcsaCif from './fixtures/molecular-ion-cohort-1k4c.cif?raw';

const walk = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(walk)];

async function fixture() {
  const atom = (
    serial: number,
    name: string,
    residue: string,
    chain: string,
    seq: number,
    x: number,
    element: string
  ) =>
    `${chain === 'B' ? 'HETATM' : 'ATOM  '}${String(serial).padStart(5)} ${name.padEnd(4)} ${residue} ${chain}${String(seq).padStart(4)}    ${x.toFixed(3).padStart(8)}${'0.000'.padStart(8)}${'0.000'.padStart(8)}  1.00 20.00          ${element.padStart(2)}  `;
  const parsed = await parsePDB(
    [
      atom(1, ' O  ', 'GLY', 'A', 1, 0, 'O'),
      atom(2, ' C  ', 'GLY', 'A', 1, -1.2, 'C'),
      atom(3, ' CA ', 'GLY', 'A', 1, -2.4, 'C'),
      atom(4, ' O  ', 'GLY', 'A', 2, 18.2, 'O'),
      atom(5, ' C  ', 'GLY', 'A', 2, 19.4, 'C'),
      atom(6, ' CA ', 'GLY', 'A', 2, 20.6, 'C'),
      'TER',
      atom(7, ' K  ', '  K', 'B', 1, 2.8, 'K'),
      atom(8, ' K  ', '  K', 'B', 2, 15.4, 'K'),
      atom(9, ' K  ', '  K', 'B', 3, 70, 'K'),
      atom(10, ' NA ', ' NA', 'B', 4, 10, 'NA'),
      'END',
    ].join('\n')
  ).run();
  if (parsed.isError) throw Error(parsed.message);
  const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
  const plugin = molstarPluginFixture({
    managers: {
      asset: {},
      structure: {
        hierarchy: {
          current: { structures: [{ cell: { obj: { data: source } }, components: [] }] },
        },
      },
    },
    runTask: (task: { run: () => Promise<unknown> }) => task.run(),
  });
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'ions.pdb' })
    .parse({ format: 'pdb' })
    .modelStructure()
    .component({ selector: 'polymer' })
    .representation({ type: 'cartoon' })
    .color({ color: '#345678' });
  const selections = molecularSceneSelections(source);
  return { source, plugin, document: builder.getState(), selections };
}

describe('complete physical ion context has deterministic guide membership', () => {
  for (const explicitTarget of [false, true]) {
    it(`${explicitTarget ? 'retains every declared ion' : 'retains contextual ion sites'} with every cohort coordination guide`, async () => {
      const f = await fixture();
      const seed = { auth_asym_id: 'B', auth_seq_id: 1 };
      const target = [seed, { auth_asym_id: 'B', auth_seq_id: 2 }];
      const plan = await buildMolecularInteractionContext(
        f.plugin,
        f.document,
        Structure.toStructureElementLoci(f.selections.select(seed)),
        { focus: false, ...(explicitTarget ? { targetSelector: target } : {}) }
      );
      expect(plan.context.contactCount).toBe(2);
      expect(plan.context.displayedGuideCount).toBe(2);
      expect(plan.context.contactCalculation.contract).toBe('native-molstar-binding-boundary-v2');
      const document = MVSData.fromMVSJ(plan.scene);
      if (document.kind === 'multiple') throw Error();
      const context = walk(document.root as Node).find(
        (node) => node.custom?.dnaforge_binding_region
      )!;
      const atomic = context.children!.find((node) => node.kind === 'representation')!;
      expect(atomic.children?.[0]).toMatchObject({
        kind: 'color',
        params: { selector: 'all' },
        custom: { molstar_color_theme_name: 'element-symbol' },
      });
      const detail = f.selections.select(context.params!.selector);
      const selected = molecularSceneSelections(detail);
      expect(selected.select({ label_comp_id: 'K' }).elementCount).toBe(2);
      expect(selected.select({ label_comp_id: 'NA' }).elementCount).toBe(0);
      expect(selected.select({ auth_asym_id: 'B', auth_seq_id: 3 }).elementCount).toBe(0);
      expect(selected.select({ auth_asym_id: 'A', auth_seq_id: 2 }).elementCount).toBe(3);
      const region = context.custom!.dnaforge_binding_region as { target: unknown };
      expect(f.selections.select(region.target).elementCount).toBe(2);
      expect(
        walk(document.root as Node).filter((node) => node.custom?.dnaforge_surface_owner)
      ).toHaveLength(0);
    });
  }

  it('retains the same complete KcsA guide endpoints for one-site and whole-cohort discovery', async () => {
    const parsed = await CIF.parseText(kcsaCif).run();
    if (parsed.isError) throw Error(parsed.message);
    const model = Structure.ofModel(
      (await trajectoryFromMmCIF(parsed.result.blocks[0]).run()).representative
    );
    const source = await StructureSymmetry.buildAssembly(model, '1').run();
    const plugin = molstarPluginFixture({
      managers: {
        asset: {},
        structure: {
          hierarchy: {
            current: { structures: [{ cell: { obj: { data: source } }, components: [] }] },
          },
        },
      },
      runTask: (task: { run: () => Promise<unknown> }) => task.run(),
    });
    const builder = MVSData.createBuilder();
    builder
      .download({ url: 'structure.cif' })
      .parse({ format: 'mmcif' })
      .assemblyStructure({ assembly_id: '1' });
    const cohort = ['E', 'F', 'G', 'H', 'I', 'J', 'K'].map((label_asym_id) => ({
      label_asym_id,
      instance_id: 'ASM-1',
    }));
    const selections = molecularSceneSelections(source);
    const endpointSets: string[][] = [];
    for (const selection of [cohort[1], cohort, cohort[2]]) {
      const plan = await buildMolecularInteractionContext(
        plugin,
        builder.getState(),
        Structure.toStructureElementLoci(selections.select(selection)),
        { focus: false }
      );
      expect(plan.context.physicalIonContext?.cohortAtomCount).toBe(7);
      expect(plan.context.displayedGuideCount).toBe(16);
      expect(
        plan.context.contactCalculation.parameters.providers['metal-coordination'].params
          .distanceMax
      ).toBe(3);
      const scene = MVSData.fromMVSJ(plan.scene);
      if (scene.kind === 'multiple') throw Error('Expected one native context');
      endpointSets.push(
        walk(scene.root as Node)
          .filter((node) => node.custom?.dnaforge_contact_evidence)
          .map((node) =>
            [node.params?.start, node.params?.end]
              .map((end) => JSON.stringify(end))
              .sort()
              .join('|')
          )
          .sort()
      );
    }
    expect(endpointSets[0]).toEqual(endpointSets[1]);
    expect(endpointSets[2]).toEqual(endpointSets[1]);
  });
});
