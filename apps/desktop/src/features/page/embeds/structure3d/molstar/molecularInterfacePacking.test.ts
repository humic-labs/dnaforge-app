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

describe('protein interface packing independent of guide categories', () => {
  it('draws buried residues from both protein sides without adding guides or distant residues', async () => {
    const atom = (serial: number, name: string, chain: string, seq: number, x: number) =>
      `ATOM  ${String(serial).padStart(5)} ${name.padEnd(4)} ALA ${chain}${String(seq).padStart(4)}    ${x.toFixed(3).padStart(8)}${'0.000'.padStart(8)}${'0.000'.padStart(8)}  1.00 20.00           C  `;
    const parsed = await parsePDB(
      [
        atom(1, ' CA ', 'A', 1, 0),
        atom(2, ' CB ', 'A', 1, 1),
        atom(3, ' CA ', 'A', 2, 30),
        atom(4, ' CB ', 'A', 2, 31),
        'TER',
        atom(5, ' CA ', 'B', 1, 3),
        atom(6, ' CB ', 'B', 1, 4),
        atom(7, ' CA ', 'B', 2, 60),
        atom(8, ' CB ', 'B', 2, 61),
        'END',
      ].join('\n')
    ).run();
    if (parsed.isError) throw Error(parsed.message);
    const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
    const selections = molecularSceneSelections(source);
    const plugin = molstarPluginFixture({
      managers: {
        asset: {},
        structure: {
          hierarchy: {
            current: {
              structures: [{ cell: { obj: { data: source } }, components: [] }],
            },
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
    const plan = await buildMolecularInteractionContext(
      plugin,
      builder.getState(),
      Structure.toStructureElementLoci(selections.select({ auth_asym_id: 'A', auth_seq_id: 1 })),
      {
        focus: false,
        presentationRole: 'interface',
        interfaceDetailSide: 'both',
        interfaceDetailBasis: 'burial',
        surfaceSide: 'partner',
        targetSelector: { auth_asym_id: 'A' },
        partnerSelector: { auth_asym_id: 'B' },
      }
    );
    expect(plan.context.presentationRole).toBe('interface');
    expect(plan.context.surfaceSide).toBe('partner');
    expect(plan.context.contactCount).toBe(0);
    expect(plan.context.displayedGuideCount).toBe(0);
    expect(plan.context.contactCalculation.parameters.providers.hydrophobic.name).toBe('off');
    expect(plan.context.interfaceBurial!.target.residueCount).toBe(1);
    expect(plan.context.interfaceBurial!.partner.residueCount).toBe(1);
    const document = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(JSON.parse(plan.scene), currentMolecularRenderProfile()),
      () => source
    );
    if (document.kind === 'multiple') throw Error();
    const nodes = walk(document.root as Node);
    const context = nodes.find((n) => n.custom?.dnaforge_binding_region)!;
    const displayed = selections.select(context.params!.selector);
    expect(displayed.elementCount).toBe(4);
    const residueIds = displayed.units.flatMap((unit) =>
      Array.from(unit.elements, (index) => {
        const h = unit.model.atomicHierarchy;
        return [
          h.chains.auth_asym_id.value(h.chainAtomSegments.index[index]),
          h.residues.auth_seq_id.value(h.residueAtomSegments.index[index]),
        ].join(':');
      })
    );
    expect(new Set(residueIds)).toEqual(new Set(['A:1', 'B:1']));
    const owner = nodes.find((n) => n.custom?.dnaforge_surface_owner)!;
    expect(owner.custom!.dnaforge_surface_owner).toMatchObject({ side: 'partner' });
    expect(selections.select(owner.params!.selector).elementCount).toBe(4);
    expect(owner.children![0].custom?.dnaforge_interface_surface_patch).toBeDefined();
  });
});
