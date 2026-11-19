import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure } from 'molstar/lib/mol-model/structure';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import {
  constructMolecularBindingRegions,
  requireMolecularSurfaceOwnership,
  requireComputedMolecularInterfaceSurfaces,
} from './molecularSurfaceOwnership';
import {
  currentMolecularRenderProfile,
  resolveMolViewSpecRenderProfile,
} from './molecularRenderProfile';
import { molecularSceneSelections } from './molecularSceneSelections';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import cif from './fixtures/molecular-attachment-1hrc.cif?raw';
import overviewCoordinates from '../../../../../../../../test-fixtures/molecular-data/1URN.cif?raw';
import overviewScene from '../../../../../../../../test-fixtures/molecular-data/overview-contour.mvs.json?raw';
import { molecularBindingDetail } from './molecularBindingDetail';
import { resolveMolecularDisplayGroups } from './molecularDisplayGroups';
import { molViewSpecColorGroups } from './molViewSpecLegend';
import { buildMolecularInteractionContext } from './molecularInteractionContext';
async function fixture() {
  const parsed = await CIF.parseText(cif).run();
  if (parsed.isError) throw Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const source = Structure.ofModel(trajectory.representative);
  const b = MVSData.createBuilder();
  const structure = b
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure();
  const component = structure.component({ selector: 'all' });
  component.representation({ type: 'ball_and_stick' }).color({ color: '#225599' });
  const document = b.getState();
  const parent = document.root.children![0].children![0].children![0] as Node;
  const region = parent.children![0] as Node & { ref: string };
  region.ref = 'site';
  region.custom = {
    dnaforge_presentation_role: 'interface',
    dnaforge_binding_region: {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      surfaceSide: 'target',
    },
  };
  return { source, document, parent, region };
}
const walk = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(walk)];
describe('binding surfaces checked against actual coordinate instances', () => {
  it('accepts an unannotated Gaussian surface covering a whole entity during authoring and replay', async () => {
    const parsed = await CIF.parseText(overviewCoordinates).run();
    if (parsed.isError) throw Error(parsed.message);
    const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
    const source = Structure.ofModel(trajectory.representative);
    const document = MVSData.fromMVSJ(overviewScene);
    requireMolecularSurfaceOwnership(document, () => source, true);
    expect(() => requireMolecularSurfaceOwnership(document, () => source)).not.toThrow();
  });

  it.each([
    { selector: { label_entity_id: '1', auth_seq_id: 18 }, custom: undefined },
    { selector: { label_entity_id: '1', auth_seq_id: 999 }, custom: undefined },
    {
      selector: { label_entity_id: '1' },
      custom: { dnaforge_presentation_role: 'binding-site' },
    },
    {
      selector: { label_entity_id: '1' },
      custom: { dnaforge_surface_owner: { side: 'target' } },
    },
  ])(
    'rejects a partial, empty or binding-owned contour without a valid owner: %j',
    async (input) => {
      const { source, parent, document } = await fixture();
      parent.children = [
        {
          kind: 'component',
          params: { selector: input.selector },
          custom: input.custom,
          children: [{ kind: 'representation', params: { type: 'surface' } }],
        },
      ];
      expect(() => requireMolecularSurfaceOwnership(document, () => source, true)).toThrowError(
        expect.objectContaining({ code: 'MVS_SURFACE_OWNERSHIP_REQUIRED' })
      );
    }
  );

  it.each([
    { cofactor: true, requested: 'contact-patch', expected: 'complete' },
    { cofactor: false, requested: undefined, expected: 'contact-patch' },
    { cofactor: false, requested: 'complete', expected: 'complete' },
  ] as const)(
    'keeps complete molecular contours separate from a native protein contact patch: %j',
    async ({ cofactor, requested, expected }) => {
      const f = await fixture();
      delete f.region.custom;
      const selections = molecularSceneSelections(f.source);
      const target = selections.select([
        { auth_seq_id: 17 },
        { auth_seq_id: 18 },
        { auth_seq_id: 80 },
        ...(cofactor ? [{ label_comp_id: 'HEC' }] : []),
      ]);
      const plugin = molstarPluginFixture({
        managers: {
          asset: {},
          structure: {
            hierarchy: {
              current: { structures: [{ cell: { obj: { data: f.source } }, components: [] }] },
            },
          },
        },
        runTask: (task: { run: () => Promise<unknown> }) => task.run(),
      });
      const plan = await buildMolecularInteractionContext(
        plugin,
        f.document,
        Structure.toStructureElementLoci(target),
        {
          focus: false,
          presentationRole: 'interface',
          interfaceDetailSide: 'both',
          interfaceDetailBasis: 'burial',
          partnerSelector: { auth_seq_id: 14 },
          surfaceSide: 'target',
          surfaceExtent: requested,
        }
      );
      const built = constructMolecularBindingRegions(
        resolveMolViewSpecRenderProfile(JSON.parse(plan.scene), currentMolecularRenderProfile()),
        () => f.source
      );
      if (built.kind === 'multiple') throw Error();
      const surface = walk(built.root as Node).find((node) => node.custom?.dnaforge_surface_owner)!;
      const region = walk(built.root as Node).find((node) => node.custom?.dnaforge_binding_region)!;
      expect(selections.select(surface.params!.selector).elementCount).toBe(target.elementCount);
      expect(plan.context.interfaceBurial).toBeDefined();
      expect(plan.context.surfaceExtent).toBe(expected);
      expect(region.custom!.dnaforge_binding_region).toMatchObject({ surfaceExtent: expected });
      const patch = surface.children![0].custom?.dnaforge_interface_surface_patch;
      if (expected === 'contact-patch') expect(patch).toBeDefined();
      else expect(patch).toBeUndefined();
      expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).not.toThrow();
      expect(() => requireComputedMolecularInterfaceSurfaces(built)).not.toThrow();
    }
  );
  it('cannot replace a complete ligand contour with a protein patch through interface mode', async () => {
    const f = await fixture();
    const selections = molecularSceneSelections(f.source);
    const plugin = molstarPluginFixture({
      managers: {
        asset: {},
        structure: {
          hierarchy: {
            current: { structures: [{ cell: { obj: { data: f.source } }, components: [] }] },
          },
        },
      },
      runTask: (task: { run: () => Promise<unknown> }) => task.run(),
    });
    const plan = await buildMolecularInteractionContext(
      plugin,
      f.document,
      Structure.toStructureElementLoci(selections.select('polymer')),
      {
        focus: false,
        presentationRole: 'interface',
        partnerSelector: { label_comp_id: 'HEC' },
        surfaceSide: 'target',
      }
    );
    const profiled = resolveMolViewSpecRenderProfile(
      JSON.parse(plan.scene),
      currentMolecularRenderProfile()
    );
    const built = constructMolecularBindingRegions(profiled, () => f.source);
    if (built.kind === 'multiple') throw Error();
    const surface = walk(built.root as Node).find((node) => node.custom?.dnaforge_surface_owner)!;
    expect(selections.select(surface.params!.selector).elementCount).toBe(
      selections.select({ label_comp_id: 'HEC' }).elementCount
    );
    expect(surface.custom!.dnaforge_surface_owner).toMatchObject({ side: 'partner' });
    expect(surface.children![0].custom!.dnaforge_interface_surface_patch).toBeUndefined();
    expect(plan.context.presentationRole).toBe('binding-site');
    expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).not.toThrow();
    expect(() => requireComputedMolecularInterfaceSurfaces(built)).not.toThrow();
  });
  it('rejects a manually supplied interface surface instead of treating its declaration as a computed patch', async () => {
    const f = await fixture();
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document, currentMolecularRenderProfile()),
      () => f.source
    );
    expect(() => requireComputedMolecularInterfaceSurfaces(built)).toThrow(
      /mol_show_interaction_context/
    );
  });
  it('preserves the complete native interaction neighborhood when constructing an interface surface', async () => {
    const f = await fixture();
    const plugin = molstarPluginFixture({
      managers: {
        asset: {},
        structure: {
          hierarchy: {
            current: { structures: [{ cell: { obj: { data: f.source } }, components: [] }] },
          },
        },
      },
      runTask: (task: { run: () => Promise<unknown> }) => task.run(),
    });
    const target = molecularSceneSelections(f.source).select({ label_comp_id: 'HEC' });
    const plan = await buildMolecularInteractionContext(
      plugin,
      f.document,
      Structure.toStructureElementLoci(target),
      {
        focus: false,
        presentationRole: 'interface',
        partnerSelector: { auth_seq_id: 14 },
        surfaceSide: 'target',
      }
    );
    const built = constructMolecularBindingRegions(JSON.parse(plan.scene), () => f.source);
    if (built.kind === 'multiple') throw Error();
    const context = walk(built.root as Node).find(
      (n) =>
        n.kind === 'component' &&
        n.custom?.dnaforge_binding_region &&
        n.custom?.dnaforge_interaction_context === 'native-interaction-context-v1'
    )!;
    const detail = molecularSceneSelections(f.source).select(context.params!.selector);
    expect(detail.elementCount).toBe(plan.context.environmentAtomCount);
    const original = walk(JSON.parse(plan.scene).root).find(
      (n) =>
        n.kind === 'component' &&
        n.custom?.dnaforge_binding_region &&
        n.custom?.dnaforge_interaction_context === 'native-interaction-context-v1'
    )!;
    expect(context.params!.selector).toEqual(original.params!.selector);
    expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).not.toThrow();
  });
  it.each(['single-record', 'coalesced-records'] as const)(
    'retains the whole source-derived feature scope beyond a nearest displayed member: %s',
    async (mode) => {
      const parsed = await parsePDB(
        [
          'ATOM      1  NZ  LYS A   1       0.000   0.000   0.000  1.00 20.00           N  ',
          'TER',
          "ATOM      2  O3'  DG D  14       3.000   1.000   0.000  1.00 20.00           O  ",
          "ATOM      3  C3'  DG D  14       4.000   1.000   0.000  1.00 20.00           C  ",
          'ATOM      4  P    DA D  15       3.000   0.000   0.000  1.00 20.00           P  ',
          'ATOM      5  OP1  DA D  15       2.000   0.000   0.000  1.00 20.00           O  ',
          'ATOM      6  OP2  DA D  15       3.000  -1.000   0.000  1.00 20.00           O  ',
          'ATOM      7  N9   DA D  15       5.000   0.000   0.000  1.00 20.00           N  ',
          'ATOM      8  N9   DA D  16       6.000   0.000   0.000  1.00 20.00           N  ',
          'END',
        ].join('\n')
      ).run();
      if (parsed.isError) throw Error(parsed.message);
      const source = Structure.ofModel(
        (await trajectoryFromPDB(parsed.result).run()).representative
      );
      const b = MVSData.createBuilder();
      b.download({ url: 'structure.pdb' })
        .parse({ format: 'pdb' })
        .modelStructure()
        .component({ selector: 'all' })
        .representation({ type: 'ball_and_stick' });
      const document = b.getState();
      const parent = document.root.children![0].children![0].children![0] as Node;
      const region = parent.children![0] as Node & { ref: string };
      region.ref = 'site';
      region.custom = {
        dnaforge_presentation_role: 'binding-site',
        dnaforge_binding_region: {
          target: { auth_asym_id: 'D' },
          partner: { auth_asym_id: 'A' },
          seed: { auth_asym_id: 'D', auth_seq_id: 15 },
          radius: 5,
          detailMode: 'contact-residues',
        },
      };
      const endpoint = (atoms: number[]) => ({
        expressions: atoms.map((atom_index) => ({ atom_index })),
      });
      const completeFeature = {
        contract: 'typed-native-contact-v1',
        featureA: endpoint([0]),
        featureB: endpoint([1, 3, 4, 5]),
      };
      const primary =
        mode === 'single-record'
          ? completeFeature
          : { ...completeFeature, featureB: endpoint([4]) };
      const guide: Node = {
        kind: 'primitive',
        params: { kind: 'tube', start: endpoint([0]), end: endpoint([4]) },
        custom: {
          dnaforge_contact_evidence: primary,
          ...(mode === 'coalesced-records'
            ? { dnaforge_contact_evidence_set: [primary, completeFeature] }
            : {}),
        },
      };
      parent.children!.push({
        kind: 'primitives',
        custom: { dnaforge_interaction_context: 'native-interaction-context-v1' },
        children: [guide],
      });
      const built = constructMolecularBindingRegions(document, () => source);
      if (built.kind === 'multiple') throw Error('Expected one scene');
      const output = walk(built.root as Node).find((n) => n.custom?.dnaforge_binding_region)!;
      const select = molecularSceneSelections(source).select;
      const selected = select(output.params?.selector);
      expect(selected.elementCount).toBe(7);
      expect(select({ auth_asym_id: 'D', auth_seq_id: 14 }, selected).elementCount).toBe(2);
      expect(select({ auth_asym_id: 'D', auth_seq_id: 16 }, selected).elementCount).toBe(0);
      expect(walk(built.root as Node).find((n) => n.kind === 'primitive')).toEqual(guide);
    }
  );
  it('constructs a translucent complete ligand surface for a new binding-site intent without adding its protein neighborhood', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_presentation_role = 'binding-site';
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
    };
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const surface = walk(built.root as Node).find((n) => n.custom?.dnaforge_surface_owner)!;
    expect(surface).toBeDefined();
    expect(surface.params?.selector).toEqual({ label_comp_id: 'HEC' });
    expect(surface.custom?.dnaforge_surface_owner).toEqual({ regionRef: 'site', side: 'target' });
    expect(surface.children![0].custom?.molstar_representation_params).toMatchObject({
      alpha: 0.3,
    });
    expect(
      surface.children![0].children!.filter((n) => n.kind === 'color').map((n) => n.params?.color)
    ).toEqual(['#225599']);
    requireMolecularSurfaceOwnership(built, () => f.source);
  });

  it('uses the ligand’s explicit uniform carbon tint as a single surface color, never its element palette', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_presentation_role = 'binding-site';
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
    };
    const repr = f.region.children![0];
    repr.children![0].custom = {
      molstar_color_theme_name: 'element-symbol',
      molstar_color_theme_params: { carbonColor: { name: 'uniform', params: { value: 0xe6a02c } } },
    };
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const surface = walk(built.root as Node).find((n) => n.custom?.dnaforge_surface_owner)!;
    expect(surface).toBeDefined();
    const colors = surface.children![0].children!.filter((n) => n.kind === 'color');
    expect(colors.map((n) => n.params?.color)).toEqual(['#e6a02c']);
    expect(colors.some((n) => n.custom?.molstar_color_theme_name)).toBe(false);
  });

  it.each(['historical', 'authored', 'exception'] as const)(
    'retains the %s binding-site surface choice',
    async (mode) => {
      const f = await fixture();
      f.region.custom!.dnaforge_presentation_role = 'binding-site';
      f.region.custom!.dnaforge_binding_region = {
        target: { label_comp_id: 'HEC' },
        partner: 'polymer',
      };
      const profile = currentMolecularRenderProfile();
      if (mode === 'historical') {
        profile.version = 10;
        delete (profile.presentation as Record<string, unknown>).bindingSiteSurface;
      } else if (mode === 'authored') {
        Object.assign(profile.presentation!, { bindingSiteSurface: 'authored' });
      }
      f.document.root.custom = {
        dnaforge_render_profile: profile,
        ...(mode === 'exception'
          ? {
              dnaforge_presentation_override: {
                reason: 'Keep the ligand unobscured for this chemistry view.',
                fields: ['bindingSiteSurface'],
              },
            }
          : {}),
      };
      const built = constructMolecularBindingRegions(
        resolveMolViewSpecRenderProfile(f.document),
        () => f.source
      );
      if (built.kind === 'multiple') throw Error();
      expect(walk(built.root as Node).filter((n) => n.custom?.dnaforge_surface_owner)).toHaveLength(
        0
      );
      expect((built.root.custom!.dnaforge_render_profile as typeof profile).presentation).toEqual(
        profile.presentation
      );
    }
  );

  it.each([
    { target: 'polymer' },
    {
      target: [
        { label_comp_id: 'HEC', label_atom_id: 'FE' },
        { label_comp_id: 'HEC', label_atom_id: 'NA' },
      ],
    },
  ])(
    'does not infer a complete small-molecule owner from a polymer or partial ligand: %j',
    async ({ target }) => {
      const f = await fixture();
      f.region.custom!.dnaforge_presentation_role = 'binding-site';
      f.region.custom!.dnaforge_binding_region = {
        target,
        partner: target === 'polymer' ? { label_comp_id: 'HEC' } : 'polymer',
      };
      const built = constructMolecularBindingRegions(
        resolveMolViewSpecRenderProfile(f.document),
        () => f.source
      );
      if (built.kind === 'multiple') throw Error();
      expect(walk(built.root as Node).filter((n) => n.custom?.dnaforge_surface_owner)).toHaveLength(
        0
      );
    }
  );

  it('keeps a native ligand-binding contour on the complete ligand despite an authored partner side', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_presentation_role = 'binding-site';
    f.region.custom!.dnaforge_interaction_context = 'native-interaction-context-v1';
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      surfaceSide: 'partner',
      detailMode: 'contact-residues',
      contactScope: 'binding-boundary-v2',
      detail: { label_comp_id: 'HEC' },
    };
    f.region.params = { selector: { label_comp_id: 'HEC' } };
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const surfaces = walk(built.root as Node).filter((n) => n.custom?.dnaforge_surface_owner);
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].params?.selector).toEqual({ label_comp_id: 'HEC' });
    expect(surfaces[0].custom?.dnaforge_surface_owner).toEqual({
      regionRef: 'site',
      side: 'target',
    });
  });

  it('does not construct a selectable surface fallback when scientific identity paint covers the complete owner', async () => {
    const f = await fixture();
    f.region.children![0].children = [
      {
        kind: 'color',
        params: { color: '#225599', selector: { label_comp_id: 'HEC' } },
        custom: { dnaforge_legend_label: 'Attached cofactor' },
      },
    ];
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const surface = walk(built.root as Node).find((n) => n.custom?.dnaforge_surface_owner)!;
    expect(
      surface.children![0].children!.filter((n) => n.kind === 'color').map((n) => n.params?.color)
    ).toEqual(['#225599']);
    const selections = molecularSceneSelections(f.source);
    const compiled = resolveMolecularDisplayGroups(built, selections.describe, () => selections);
    const labels = molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0).map((group) => group.label);
    expect(labels).toContain('Attached cofactor · binding site');
    expect(labels).not.toContain('Target surface');
  });

  it('keeps whole-owner surface identity while leaving narrow emphasis on the cartoon', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      surfaceSide: 'partner',
    };
    f.parent.children!.unshift({
      kind: 'component',
      params: { selector: 'polymer' },
      children: [
        {
          kind: 'representation',
          params: { type: 'cartoon' },
          children: [
            {
              kind: 'color',
              params: { color: '#2255aa' },
              custom: { dnaforge_legend_label: 'Protein' },
            },
            {
              kind: 'color',
              params: { color: '#ff6600', selector: { auth_seq_id: 14 } },
              custom: { dnaforge_legend_label: 'Local emphasis' },
            },
          ],
        },
      ],
    });
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const output = walk(built.root as Node);
    const surface = output.find((n) => n.custom?.dnaforge_surface_owner)!;
    expect(
      surface.children![0].children!.filter((n) => n.kind === 'color').map((n) => n.params?.color)
    ).toEqual(['#2255aa']);
    expect(
      output
        .find((n) => n.params?.type === 'cartoon')
        ?.children?.some((n) => n.params?.color === '#ff6600')
    ).toBe(true);
  });

  it.each([{ is_hidden: true }, { molstar_representation_params: { alpha: 0 } }])(
    'does not let invisible owner paint define the surface: %j',
    async (hidden) => {
      const f = await fixture();
      f.region.custom!.dnaforge_binding_region = {
        target: { label_comp_id: 'HEC' },
        partner: 'polymer',
        surfaceSide: 'partner',
      };
      f.parent.children!.unshift({
        kind: 'component',
        params: { selector: 'polymer' },
        children: [
          {
            kind: 'representation',
            params: { type: 'cartoon' },
            children: [{ kind: 'color', params: { color: '#2255aa' } }],
          },
          {
            kind: 'representation',
            params: { type: 'cartoon' },
            custom: hidden,
            children: [{ kind: 'color', params: { color: '#ff6600' } }],
          },
        ],
      });
      const built = constructMolecularBindingRegions(
        resolveMolViewSpecRenderProfile(f.document),
        () => f.source
      );
      if (built.kind === 'multiple') throw Error();
      const surface = walk(built.root as Node).find((n) => n.custom?.dnaforge_surface_owner)!;
      expect(surface.children![0].children!.some((n) => n.params?.color === '#ff6600')).toBe(false);
      expect(surface.children![0].children!.some((n) => n.params?.color === '#2255aa')).toBe(true);
    }
  );

  it('keeps intentional residue-patch surface paint behind an explicit emphasis choice', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      surfaceSide: 'partner',
      surfaceColorMode: 'emphasis',
    };
    f.parent.children!.unshift({
      kind: 'component',
      params: { selector: 'polymer' },
      children: [
        {
          kind: 'representation',
          params: { type: 'cartoon' },
          children: [
            { kind: 'color', params: { color: '#2255aa' } },
            { kind: 'color', params: { color: '#ff6600', selector: { auth_seq_id: 14 } } },
          ],
        },
      ],
    });
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const surface = walk(built.root as Node).find((n) => n.custom?.dnaforge_surface_owner)!;
    expect(
      surface.children![0].children!.filter((n) => n.kind === 'color').map((n) => n.params?.color)
    ).toEqual(['#2255aa', '#ff6600']);
  });

  it.each([false, true])(
    'retains separate protein and complete carbohydrate paint when managed contact geometry is reduced: %j',
    async (managed) => {
      const f = await fixture();
      const augmented = cif
        .replace('2 non-polymer', '2 non-polymer\n3 non-polymer')
        .replace('HEC non-polymer', 'HEC non-polymer\nNAG non-polymer')
        .replace('B 2\n#', 'B 2\nG 3\n#')
        .replace(
          /#\s*$/,
          'HETATM 990 C C1 ? NAG G 3 ? ? 45 28 7 1.00 10.00 ? 1 NAG G C1 1\nHETATM 991 O O1 ? NAG G 3 ? ? 46 28 7 1.00 10.00 ? 2 NAG G O1 1\n#\n'
        );
      const parsed = await CIF.parseText(augmented).run();
      if (parsed.isError) throw Error(parsed.message);
      f.source = Structure.ofModel(
        (await trajectoryFromMmCIF(parsed.result.blocks[0]).run()).representative
      );
      f.region.custom!.dnaforge_binding_region = {
        target: [
          { auth_seq_id: 17 },
          { auth_seq_id: 18 },
          { auth_seq_id: 80 },
          { label_asym_id: 'G' },
        ],
        partner: { auth_seq_id: 14 },
        surfaceSide: 'target',
      };
      f.region.params!.selector = [
        { auth_seq_id: 14 },
        { auth_seq_id: 17 },
        { auth_seq_id: 18 },
        { auth_seq_id: 80 },
      ];
      f.parent.children!.unshift({
        kind: 'component',
        params: { selector: 'polymer' },
        children: [
          {
            kind: 'representation',
            params: { type: 'cartoon' },
            children: [
              {
                kind: 'color',
                params: { color: '#2255aa' },
                custom: { dnaforge_legend_label: 'Protein' },
              },
            ],
          },
        ],
      });
      f.parent.children!.push({
        kind: 'component',
        params: { selector: { label_asym_id: 'G' } },
        children: [
          {
            kind: 'representation',
            params: { type: 'ball_and_stick' },
            children: [
              {
                kind: 'color',
                params: { color: '#ffaa22' },
                custom: { dnaforge_legend_label: 'Attached glycan' },
              },
              { kind: 'color', params: { color: '#ff0000', selector: { type_symbol: 'O' } } },
            ],
          },
        ],
      });
      if (managed) {
        const glycan = f.parent.children!.pop()!;
        f.region.children![0].children!.push(...glycan.children![0].children!);
        f.parent.children!.push({
          kind: 'primitives',
          custom: { dnaforge_interaction_context: 'native-interaction-context-v1' },
          children: [
            {
              kind: 'tube',
              params: {
                start: {
                  expressions: [{ auth_seq_id: 14, label_asym_id: 'A', label_atom_id: 'SG' }],
                },
                end: { expressions: [{ label_asym_id: 'G', auth_seq_id: 1, label_atom_id: 'C1' }] },
              },
            },
          ],
        });
      }
      const built = constructMolecularBindingRegions(
        resolveMolViewSpecRenderProfile(f.document),
        () => f.source
      );
      if (built.kind === 'multiple') throw Error();
      const surface = walk(built.root as Node).find((n) => n.custom?.dnaforge_surface_owner)!;
      const colors = surface.children![0].children!.filter((n) => n.kind === 'color');
      expect(colors.map((n) => n.params?.color)).toEqual(['#2255aa', '#ffaa22']);
      expect(colors.find((n) => n.params?.color === '#ffaa22')?.custom?.dnaforge_legend_label).toBe(
        'Attached glycan'
      );
      expect(
        molecularSceneSelections(f.source).select(
          colors.find((n) => n.params?.color === '#ffaa22')?.params?.selector
        ).elementCount
      ).toBe(2);
      if (managed) {
        const region = walk(built.root as Node).find((n) => n.custom?.dnaforge_binding_region)!;
        const detail = molecularSceneSelections(f.source).select(region.params?.selector);
        expect(
          molecularSceneSelections(f.source).select({ label_asym_id: 'G', auth_seq_id: 2 }, detail)
            .elementCount
        ).toBe(0);
      }
    }
  );

  it('preserves a named identity through overview, surface and opacity changes across steps', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      surfaceSide: 'partner',
    };
    f.parent.children!.unshift({
      kind: 'component',
      params: { selector: 'polymer' },
      children: [
        {
          kind: 'representation',
          params: { type: 'cartoon' },
          children: [
            {
              kind: 'color',
              params: { color: '#2255aa' },
              custom: { dnaforge_legend_label: 'Protein' },
            },
          ],
        },
      ],
    });
    const overview = structuredClone(f.document.root);
    const parent = walk(overview as Node).find((n) => n.kind === 'structure')!;
    parent.children = parent.children?.filter((n) => !n.custom?.dnaforge_binding_region);
    const detail = structuredClone(f.document.root);
    const cartoon = walk(detail as Node).find((n) => n.params?.type === 'cartoon')!;
    cartoon.children![0].params!.color = '#aa2255';
    cartoon.children!.push({ kind: 'opacity', params: { opacity: 0.2 } });
    const story = {
      kind: 'multiple' as const,
      metadata: f.document.metadata,
      snapshots: [
        { root: overview, metadata: { title: 'Overview' } },
        { root: detail, metadata: { title: 'Detail' } },
      ],
    };
    const built = resolveMolecularDisplayGroups(
      constructMolecularBindingRegions(resolveMolViewSpecRenderProfile(story), () => f.source)
    );
    if (built.kind !== 'multiple') throw Error();
    for (const step of built.snapshots) {
      const identityPaint = walk(step.root as Node).filter(
        (n) => n.kind === 'color' && n.custom?.dnaforge_legend_label === 'Protein'
      );
      expect(identityPaint.length).toBeGreaterThan(0);
      expect(identityPaint.every((n) => n.params?.color === '#2255aa')).toBe(true);
    }
    const surface = walk(built.snapshots[1].root as Node).find(
      (n) => n.custom?.dnaforge_surface_owner
    )!;
    expect(
      surface.children![0].children!.some((n) => n.custom?.dnaforge_legend_label === 'Protein')
    ).toBe(true);
  });

  it.each([
    { role: 'interface', detailMode: undefined, contactsOnly: true },
    { role: 'interface', detailMode: 'neighborhood', contactsOnly: false },
    { role: 'binding-site', detailMode: undefined, contactsOnly: false },
  ])(
    'uses declared contact detail without changing binding-site neighborhood: %j',
    async ({ role, detailMode, contactsOnly }) => {
      const f = await fixture();
      f.region.custom!.dnaforge_presentation_role = role;
      f.region.custom!.dnaforge_binding_region = {
        target: { label_comp_id: 'HEC' },
        partner: 'polymer',
        surfaceSide: 'target',
        ...(detailMode ? { detailMode } : {}),
      };
      f.parent.children!.push({
        kind: 'primitives',
        custom: { dnaforge_interaction_context: 'native-interaction-context-v1' },
        children: [
          {
            kind: 'tube',
            params: {
              start: { expressions: [{ auth_seq_id: 14, label_atom_id: 'SG' }] },
              end: { expressions: [{ label_comp_id: 'HEC', label_atom_id: 'CAB' }] },
            },
          },
        ],
      });
      const built = constructMolecularBindingRegions(
        resolveMolViewSpecRenderProfile(f.document),
        () => f.source
      );
      if (built.kind === 'multiple') throw Error();
      const region = walk(built.root as Node).find((n) => n.custom?.dnaforge_binding_region)!;
      const detail = molecularSceneSelections(f.source).select(region.params?.selector);
      expect(
        molecularSceneSelections(f.source).select({ auth_seq_id: 14 }, detail).elementCount
      ).toBeGreaterThan(0);
      expect(
        molecularSceneSelections(f.source).select({ label_comp_id: 'HEC' }, detail).elementCount
      ).toBeGreaterThan(0);
      const other = molecularSceneSelections(f.source).select(
        { auth_seq_id: 17 },
        detail
      ).elementCount;
      if (contactsOnly) expect(other).toBe(0);
      else expect(other).toBeGreaterThan(0);
      expect((region.custom!.dnaforge_binding_region as { detailMode: string }).detailMode).toBe(
        contactsOnly ? 'contact-residues' : 'neighborhood'
      );
      expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).not.toThrow();
    }
  );

  it('colors the complete surface from its scientific owner rather than local or foreign atomic colors', async () => {
    const f = await fixture();
    f.region.children![0].children = [
      { kind: 'color', params: { color: '#ff6600', selector: { label_comp_id: 'HEC' } } },
    ];
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      surfaceSide: 'partner',
    };
    f.parent.children!.unshift({
      kind: 'component',
      params: { selector: 'polymer' },
      children: [
        {
          kind: 'representation',
          params: { type: 'cartoon' },
          children: [
            {
              kind: 'color',
              params: { color: '#2255aa' },
              custom: { dnaforge_legend_label: 'Cytochrome' },
            },
          ],
        },
      ],
    });
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const surface = walk(built.root as Node).find((n) => n.custom?.dnaforge_surface_owner)!;
    const colors = surface.children![0].children!.filter((n) => n.kind === 'color');
    expect(colors.some((n) => n.params?.color === '#ff6600')).toBe(false);
    expect(
      colors.some(
        (n) =>
          n.params?.color === '#2255aa' &&
          molecularSceneSelections(f.source).select(n.params?.selector ?? 'all').elementCount ===
            molecularSceneSelections(f.source).select('polymer').elementCount
      )
    ).toBe(true);
  });

  it('limits a whole-protein interface seed to residues near the other declared side', async () => {
    const f = await fixture();
    const parsed = await CIF.parseText(
      cif.replace(
        /#\s*$/,
        'ATOM 999 C CA ? ALA A 1 100 ? 1000 1000 1000 1.00 10.00 ? 99 ALA A CA 1\n#\n'
      )
    ).run();
    if (parsed.isError) throw Error(parsed.message);
    f.source = Structure.ofModel(
      (await trajectoryFromMmCIF(parsed.result.blocks[0]).run()).representative
    );
    const far = molecularSceneSelections(f.source).select({ auth_seq_id: 99 });
    const isolated = molecularBindingDetail(f.source, far, far, f.source, 1, false);
    expect(isolated.elementCount).toBe(1);
    expect(
      molecularSceneSelections(f.source).select({ auth_seq_id: 99 }, isolated).elementCount
    ).toBe(1);
    f.region.custom!.dnaforge_binding_region = {
      target: 'polymer',
      partner: { label_comp_id: 'HEC' },
      seed: 'polymer',
      radius: 4,
      surfaceSide: 'target',
    };
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const region = walk(built.root as Node).find((n) => n.custom?.dnaforge_binding_region)!;
    const detail = molecularSceneSelections(f.source).select(region.params?.selector);
    expect(detail.elementCount).toBeLessThan(f.source.elementCount);
    expect(
      molecularSceneSelections(f.source).select({ auth_seq_id: 99 }, detail).elementCount
    ).toBe(0);
    expect(
      molecularSceneSelections(f.source).select({ label_comp_id: 'HEC' }, detail).elementCount
    ).toBeGreaterThan(0);
  });
  it('accepts exactly one complete declared side', async () => {
    const f = await fixture();
    const d = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    expect(() => requireMolecularSurfaceOwnership(d, () => f.source)).not.toThrow();
    expect(() => requireMolecularSurfaceOwnership(d, () => undefined)).toThrow(/coordinate source/);
  });
  it('preserves an explicit opposing context contour without changing the binding owner', async () => {
    const f = await fixture();
    const context: Node & { ref: string } = {
      kind: 'component',
      ref: 'whole-partner-context',
      params: { selector: 'polymer' },
      custom: { dnaforge_presentation_role: 'context', dnaforge_legend_label: 'Whole partner' },
      children: [
        {
          kind: 'representation',
          params: { type: 'surface' },
          children: [
            { kind: 'color', params: { color: '#8964bd' } },
            { kind: 'opacity', params: { opacity: 0.16 } },
          ],
        },
      ],
    };
    f.parent.children!.push(context);
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const output = walk(built.root as Node);
    const retained = output.find((node) => (node as Node & { ref?: string }).ref === context.ref)!;
    expect(retained).toEqual(context);
    expect(output.filter((node) => node.custom?.dnaforge_surface_owner)).toHaveLength(1);
    expect(output.find((node) => node.custom?.dnaforge_surface_owner)?.params?.selector).toEqual({
      label_comp_id: 'HEC',
    });
    expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).not.toThrow();
    expect(constructMolecularBindingRegions(built, () => f.source)).toEqual(built);
    retained.custom!.dnaforge_surface_owner = { side: 'target' };
    expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).toThrow(/surface owner/);
    delete retained.custom!.dnaforge_surface_owner;
    retained.params!.selector = { label_comp_id: 'HEC' };
    expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).toThrow(/surface owner/);
  });

  it('rejects an explicit context contour overlapping the selected binding side during construction', async () => {
    const f = await fixture();
    f.parent.children!.push({
      kind: 'component',
      params: { selector: { label_comp_id: 'HEC' } },
      custom: { dnaforge_presentation_role: 'context' },
      children: [{ kind: 'representation', params: { type: 'surface' } }],
    });
    expect(() =>
      constructMolecularBindingRegions(resolveMolViewSpecRenderProfile(f.document), () => f.source)
    ).toThrowError(expect.objectContaining({ code: 'MVS_SURFACE_OWNERSHIP_REQUIRED' }));
  });

  it('rejects union, partial owner, unknown owner and opposing separate surfaces', async () => {
    const f = await fixture();
    const d = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (d.kind === 'multiple') throw Error();
    const surface = walk(d.root as Node).find((n) => n.custom?.dnaforge_surface_owner)!;
    const original = structuredClone(surface);
    surface.params!.selector = 'all';
    expect(() => requireMolecularSurfaceOwnership(d, () => f.source)).toThrow(
      /complete declared side/
    );
    surface.params!.selector = { label_comp_id: 'HEC', label_atom_id: 'FE' };
    expect(() => requireMolecularSurfaceOwnership(d, () => f.source)).toThrow(
      /complete declared side/
    );
    Object.assign(surface, structuredClone(original));
    const parent = walk(d.root as Node).find((n) => n.children?.includes(surface))!;
    parent.children!.push({
      ...structuredClone(original),
      params: { selector: 'polymer' },
      custom: { dnaforge_surface_owner: { regionRef: 'site', side: 'partner' } },
    });
    expect(() => requireMolecularSurfaceOwnership(d, () => f.source)).toThrow(
      /only one declared side/
    );
    parent.children!.pop();
    surface.custom = { dnaforge_surface_owner: { regionRef: 'other-source', side: 'target' } };
    expect(() => requireMolecularSurfaceOwnership(d, () => f.source)).toThrow(
      /same coordinate source/
    );
  });
  it('rejects overlapping sides and lost opaque atomic environment', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_binding_region = {
      target: 'all',
      partner: 'polymer',
      surfaceSide: 'target',
    };
    expect(() =>
      requireMolecularSurfaceOwnership(resolveMolViewSpecRenderProfile(f.document), () => f.source)
    ).toThrow(/disjoint/);
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      detail: 'all',
      surfaceSide: 'target',
    };
    f.region.params!.selector = { label_comp_id: 'HEC' };
    expect(() =>
      requireMolecularSurfaceOwnership(resolveMolViewSpecRenderProfile(f.document), () => f.source)
    ).toThrow(/missing opaque atomic/);
  });
  it('constructs the surface and atomic scope from intent, discarding independent render-selector mistakes and competing detail', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      detail: 'all',
      surfaceSide: 'target',
    };
    const d = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (d.kind === 'multiple') throw Error();
    const nodes = walk(d.root as Node);
    const region = nodes.find((n) => n.custom?.dnaforge_binding_region)!;
    region.params!.selector = { label_comp_id: 'HEC' };
    const surface = nodes.find((n) => n.custom?.dnaforge_surface_owner)!;
    surface.params!.selector = 'all';
    surface.custom!.dnaforge_surface_owner = { regionRef: 'site', side: 'partner' };
    const parent = nodes.find((n) => n.children?.includes(surface))!;
    parent.children!.push({
      kind: 'component',
      params: { selector: 'polymer' },
      children: [{ kind: 'representation', params: { type: 'spacefill' } }],
    });
    parent.children!.push(structuredClone(surface));
    const built = constructMolecularBindingRegions(d, () => f.source);
    if (built.kind === 'multiple') throw Error();
    const output = walk(built.root as Node);
    expect(output.filter((n) => n.custom?.dnaforge_surface_owner)).toHaveLength(1);
    expect(output.find((n) => n.custom?.dnaforge_surface_owner)?.params?.selector).toEqual({
      label_comp_id: 'HEC',
    });
    expect(
      output.find((n) => n.custom?.dnaforge_surface_owner)?.custom?.dnaforge_surface_owner
    ).toEqual({ regionRef: 'site', side: 'target' });
    expect(
      molecularSceneSelections(f.source).select(
        output.find((n) => n.custom?.dnaforge_binding_region)?.params?.selector
      ).elementCount
    ).toBe(f.source.elementCount);
    expect(output.some((n) => n.params?.type === 'spacefill')).toBe(false);
    expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).not.toThrow();
    expect(constructMolecularBindingRegions(built, () => f.source)).toEqual(built);
  });

  it('derives local chemistry from the coordinate seed even when exported detail selectors are corrupted', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      seed: { label_comp_id: 'HEC' },
      radius: 5,
      detail: { label_comp_id: 'HEC' },
      surfaceSide: 'target',
    };
    f.region.params!.selector = { label_comp_id: 'HEC' };
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const intent = walk(built.root as Node).find((n) => n.custom?.dnaforge_binding_region)!;
    expect(intent.params?.selector).not.toEqual({ label_comp_id: 'HEC' });
    expect((intent.custom!.dnaforge_binding_region as { detail: unknown }).detail).toEqual(
      intent.params?.selector
    );
    expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).not.toThrow();
  });

  it('defaults the coordinate seed to the target, never to an independently authored detail selector', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      detail: { label_comp_id: 'HEC' },
      surfaceSide: 'target',
    };
    f.region.params!.selector = { label_comp_id: 'HEC' };
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const region = walk(built.root as Node).find((n) => n.custom?.dnaforge_binding_region)!;
    expect(region.params?.selector).not.toEqual({ label_comp_id: 'HEC' });
    expect(() => requireMolecularSurfaceOwnership(built, () => f.source)).not.toThrow();
  });

  it('requires a nonempty contact seed inside the declared scientific target before construction', async () => {
    const f = await fixture();
    const intent = f.region.custom!.dnaforge_binding_region as Record<string, unknown>;
    intent.seed = 'polymer';
    expect(() => constructMolecularBindingRegions(f.document, () => f.source)).toThrow(
      /seed must belong/
    );
    intent.seed = { label_comp_id: 'MISSING' };
    expect(() => constructMolecularBindingRegions(f.document, () => f.source)).toThrow(
      /seed must belong/
    );
  });

  it('does not permit a native profile or missing owner to bypass new authoring checks', async () => {
    const f = await fixture();
    f.document.root.custom = { dnaforge_render_profile: 'native' };
    f.parent.children!.push({
      kind: 'component',
      params: { selector: 'all' },
      children: [{ kind: 'representation', params: { type: 'surface' } }],
    });
    expect(() => requireMolecularSurfaceOwnership(f.document, () => f.source, true)).toThrow(
      /explicit surface owner/
    );
  });

  it('preserves explicitly focused outside atomic context without duplicating a component identity when its representations split', async () => {
    const f = await fixture();
    f.region.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'HEC' },
      partner: 'polymer',
      seed: { label_comp_id: 'HEC', label_atom_id: 'FE' },
      radius: 1,
      surfaceSide: 'target',
    };
    f.parent.children!.push({
      kind: 'component',
      ref: 'mixed-context',
      custom: { dnaforge_presentation_role: 'focus' },
      params: { selector: 'all' },
      children: [
        { kind: 'representation', params: { type: 'cartoon' } },
        { kind: 'representation', params: { type: 'spacefill' } },
      ],
    } as Node & { ref: string });
    const built = constructMolecularBindingRegions(
      resolveMolViewSpecRenderProfile(f.document),
      () => f.source
    );
    if (built.kind === 'multiple') throw Error();
    const nodes = walk(built.root as Node);
    expect(nodes.some((n) => n.params?.type === 'cartoon')).toBe(true);
    expect(nodes.some((n) => n.params?.type === 'spacefill')).toBe(true);
    const refs = nodes.map((n) => (n as Node & { ref?: string }).ref).filter(Boolean);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('does not change historical replay semantics', async () => {
    const f = await fixture();
    f.document.root.custom = { dnaforge_render_profile: { version: 4 } };
    delete f.region.custom!.dnaforge_binding_region;
    expect(() => requireMolecularSurfaceOwnership(f.document, () => undefined)).not.toThrow();
  });
});
