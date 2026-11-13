import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure } from 'molstar/lib/mol-model/structure';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { buildMolecularInteractionContext } from './molecularInteractionContext';
import { constructMolecularBindingRegions } from './molecularSurfaceOwnership';
import { molecularSceneSelections } from './molecularSceneSelections';
import {
  currentMolecularRenderProfile,
  resolveMolViewSpecRenderProfile,
} from './molecularRenderProfile';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';

const walk = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(walk)];

async function fixture(ions = false) {
  const atom = (
    serial: number,
    name: string,
    residue: string,
    chain: string,
    seq: number,
    x: number,
    element = 'C'
  ) =>
    `${chain === 'B' ? 'HETATM' : 'ATOM  '}${String(serial).padStart(5)} ${name.padEnd(4)} ${residue} ${chain}${String(seq).padStart(4)}    ${x.toFixed(3).padStart(8)}${'0.000'.padStart(8)}${'0.000'.padStart(8)}  1.00 20.00          ${element.padStart(2)}  `;
  const pdb = [
    atom(1, ' CA ', 'ALA', 'A', 1, 0),
    atom(2, ' CB ', 'ALA', 'A', 1, 1),
    atom(3, ' CA ', 'ALA', 'A', 2, 30),
    atom(4, ' CB ', 'ALA', 'A', 2, 31),
    'TER',
    atom(5, ions ? ' K  ' : ' C1 ', ions ? '  K' : 'LIG', 'B', 1, 3, ions ? 'K' : 'C'),
    atom(6, ions ? ' K  ' : ' C2 ', ions ? '  K' : 'LIG', 'B', ions ? 2 : 1, 4, ions ? 'K' : 'C'),
    'END',
  ].join('\n');
  const parsed = await parsePDB(pdb).run();
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
    .download({ url: 'structure.pdb' })
    .parse({ format: 'pdb' })
    .modelStructure()
    .component({ selector: 'polymer' })
    .representation({ type: 'cartoon' });
  return {
    source,
    plugin,
    document: builder.getState(),
    selections: molecularSceneSelections(source),
  };
}

describe('independent ligand contour, physical pocket and guide scope', () => {
  it('shows nonpolar packing without inventing a dotted line or admitting a distant residue', async () => {
    const f = await fixture();
    const plan = await buildMolecularInteractionContext(
      f.plugin,
      f.document,
      Structure.toStructureElementLoci(f.selections.select({ label_comp_id: 'LIG' })),
      {
        focus: false,
        presentationRole: 'interface',
        surfaceSide: 'partner',
        partnerSelector: 'polymer',
      }
    );
    expect(plan.context.presentationRole).toBe('binding-site');
    expect(plan.context.surfaceSide).toBe('target');
    expect(plan.context.contactCount).toBe(0);
    expect(plan.context.displayedGuideCount).toBe(0);
    expect(plan.context.interfaceBurial!.partner.residueCount).toBe(1);
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(JSON.parse(plan.scene), currentMolecularRenderProfile()),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const nodes = walk(built.root as Node);
    const context = nodes.find((n) => n.custom?.dnaforge_binding_region)!;
    expect(f.selections.select(context.params!.selector).elementCount).toBe(4);
    const owner = nodes.find((n) => n.custom?.dnaforge_surface_owner)!;
    expect(f.selections.select(owner.params!.selector).elementCount).toBe(2);
    expect(owner.custom!.dnaforge_surface_owner).toMatchObject({ side: 'target' });
    expect(owner.children![0].custom?.dnaforge_interface_surface_patch).toBeUndefined();
  });

  it('filters a single-ion boundary without merging disconnected ions into a ligand envelope', async () => {
    const f = await fixture(true);
    for (const selector of [{ auth_asym_id: 'B', auth_seq_id: 1 }, { auth_asym_id: 'B' }]) {
      const plan = await buildMolecularInteractionContext(
        f.plugin,
        f.document,
        Structure.toStructureElementLoci(f.selections.select(selector)),
        { focus: false }
      );
      expect(plan.context.contactCalculation.contract).toBe('native-molstar-binding-boundary-v2');
      const built = constructMolecularBindingRegions(
        resolveMolViewSpecRenderProfile(JSON.parse(plan.scene), currentMolecularRenderProfile()),
        () => f.source
      );
      if (built.kind === 'multiple') throw Error();
      expect(walk(built.root as Node).filter((n) => n.custom?.dnaforge_surface_owner)).toHaveLength(
        0
      );
    }
  });
});
