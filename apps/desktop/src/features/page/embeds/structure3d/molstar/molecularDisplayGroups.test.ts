import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { Column } from 'molstar/lib/mol-data/db';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure';
import { colorThemeForNode } from 'molstar/lib/extensions/mvs/load-helpers';
import { makeMultilayerColorThemeProvider } from 'molstar/lib/extensions/mvs/components/multilayer-color-theme';
import { ColorTheme } from 'molstar/lib/mol-theme/color';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import {
  requireMolecularDisplayGroups,
  resolveMolecularDisplayGroups,
} from './molecularDisplayGroups';
import { molecularSceneSelections } from './molecularSceneSelections';
import { molViewSpecColorGroups, colorLegendsForMolViewSpecScene } from './molViewSpecLegend';
import { resolveMolViewSpecRenderProfile } from './molecularRenderProfile';
import { resolveMolViewSpecColorGroupLoci } from './molViewSpecSwatchSelection';

const PDB = [
  'ATOM      1  CA  ALA A   1      12.560  13.207   7.216  1.00 20.00           C',
  'HETATM    2 MG    MG A 601      14.500  13.500   7.216  1.00 20.00          MG',
  'HETATM    3 MG    MG B 601      19.500  13.500   7.216  1.00 20.00          MG',
  'END',
  '',
].join('\n');

describe('automatic molecular display groups', () => {
  it('removes a color layer whose actual parent-intersected atom set is empty before assigning its legend', async () => {
    const parsed = await parsePDB(
      [
        'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 20.00           C  ',
        'TER',
        'ATOM      2  CA  ALA B   1      10.000   0.000   0.000  1.00 20.00           C  ',
        'END',
      ].join('\n')
    ).run();
    if (parsed.isError) throw Error(parsed.message);
    const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
    const selections = molecularSceneSelections(source);
    expect(selections.select({ auth_asym_id: 'B' }).elementCount).toBe(1);
    const b = MVSData.createBuilder();
    b.download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure()
      .component({ selector: { auth_asym_id: 'A' } })
      .representation({ type: 'cartoon' })
      .color({ color: '#2255aa', custom: { dnaforge_legend_label: 'Observed protein' } })
      .color({
        color: '#909090',
        selector: { auth_asym_id: 'B' },
        custom: { dnaforge_legend_label: 'An empty child layer' },
      });
    const compiled = resolveMolecularDisplayGroups(
      b.getState(),
      selections.describe,
      () => selections
    );
    const groups = molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0);
    expect(groups.map((g) => g.label)).toEqual(['Observed protein']);
    if (compiled.kind === 'multiple') throw Error('Expected one scene');
    const representation =
      compiled.root.children![0].children![0].children![0].children![0].children![0];
    expect(representation.children).toHaveLength(1);
    expect(representation.children![0].params?.color).toBe('#2255aa');
  });
  it('omits fully overwritten paint while preserving a layer with a visible parent-scoped remainder', async () => {
    const parsed = await parsePDB(
      [
        'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 20.00           C  ',
        'TER',
        'ATOM      2  CA  ALA B   1      10.000   0.000   0.000  1.00 20.00           C  ',
        'END',
      ].join('\n')
    ).run();
    if (parsed.isError) throw Error(parsed.message);
    const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
    const selections = molecularSceneSelections(source);
    for (const [selector, expectedLabels] of [
      [{ auth_asym_id: 'A' }, ['Final molecular owner']],
      ['all', ['Earlier owner', 'Final molecular owner']],
    ] as const) {
      const builder = MVSData.createBuilder();
      builder
        .download({ url: 'structure.pdb' })
        .parse({ format: 'pdb' })
        .modelStructure()
        .component({ selector })
        .representation({ type: 'cartoon' })
        .color({ color: '#909090', custom: { dnaforge_legend_label: 'Earlier owner' } })
        .color({
          color: '#ff8800',
          selector: { auth_asym_id: 'A' },
          custom: { dnaforge_legend_label: 'Final molecular owner' },
        });
      const compiled = resolveMolecularDisplayGroups(
        builder.getState(),
        selections.describe,
        () => selections
      );
      expect(molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0).map((g) => g.label)).toEqual(
        expectedLabels
      );
      if (compiled.kind === 'multiple') throw Error('Expected one scene');
      const representation =
        compiled.root.children![0].children![0].children![0].children![0].children![0];
      expect(representation.children).toHaveLength(expectedLabels.length);
      expect(representation.children!.at(-1)?.params?.color).toBe('#ff8800');
    }
  });
  it.each([false, true])(
    'gives unpainted contact atoms their physical owners without changing native paint (reordered source indices: %s)',
    async (reordered) => {
      const pdb = [
        'ATOM      1  CA  ALA A   1      12.560  13.207   7.216  1.00 20.00           C',
        'HETATM    2  C1  ANP A 601      14.500  13.500   7.216  1.00 20.00           C',
        'HETATM    3  O1  ANP A 601      15.500  13.500   7.216  1.00 20.00           O',
        'HETATM    4  C1  ANP B 601      24.500  13.500   7.216  1.00 20.00           C',
        'HETATM    5  O1  ANP B 601      25.500  13.500   7.216  1.00 20.00           O',
        'HETATM    6  O   HOH A 701      16.500  13.500   7.216  1.00 20.00           O',
        'END',
        '',
      ].join('\n');
      const parsed = await parsePDB(pdb).run();
      if (parsed.isError) throw Error(parsed.message);
      const source = Structure.ofModel(
        (await trajectoryFromPDB(parsed.result).run()).representative
      );
      const hierarchy = source.models[0].atomicHierarchy;
      if (reordered)
        Object.defineProperty(hierarchy, 'atomSourceIndex', {
          value: Column.ofIntArray(Int32Array.of(5, 0, 1, 2, 3, 4)),
        });
      const b = MVSData.createBuilder();
      b.download({ url: 'structure.pdb' })
        .parse({ format: 'pdb' })
        .modelStructure()
        .component({
          selector: [0, 2, 3, 4, 5].map((atom) => ({
            atom_index: hierarchy.atomSourceIndex.value(atom),
          })),
        })
        .representation({ type: 'ball_and_stick' })
        .color({
          color: '#2255aa',
          selector: 'protein',
          custom: { dnaforge_legend_label: 'Protein owner' },
        })
        .color({
          color: '#ff8800',
          selector: { auth_asym_id: 'B' },
          custom: { dnaforge_legend_label: 'Pocket ligand' },
        });
      const authored = b.getState();
      const selections = molecularSceneSelections(source);
      const compiled = resolveMolecularDisplayGroups(
        authored,
        selections.describe,
        () => selections
      );
      const groups = molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0);
      expect(groups.map((g) => g.label)).toEqual([
        'ANP · chain A, residue 601',
        'Waters',
        'Protein owner',
        'Pocket ligand',
      ]);
      const plugin = molstarPluginFixture({
        state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
        managers: {
          structure: {
            hierarchy: { current: { structures: [{ cell: { obj: { data: source } } }] } },
          },
        },
      });
      expect(
        groups.map((g) =>
          StructureElement.Loci.toStructure(
            resolveMolViewSpecColorGroupLoci(plugin, g)
          ).units.flatMap((u) => Array.from(u.elements))
        )
      ).toEqual([[2], [5], [0], [3, 4]]);
      expect(groups[0].id).not.toBe(groups[3].id);
      if (authored.kind === 'multiple' || compiled.kind === 'multiple')
        throw Error('Expected single scene');
      const findRepresentation = (root: typeof authored.root) =>
        root.children![0].children![0].children![0].children![0].children![0];
      expect(findRepresentation(compiled.root).children).toEqual(
        findRepresentation(authored.root).children?.map((node) => ({
          ...node,
          custom: expect.objectContaining(node.custom ?? {}),
        }))
      );
      const again = resolveMolecularDisplayGroups(compiled, selections.describe, () => selections);
      expect(molViewSpecColorGroups(MVSData.toMVSJ(again), 0)).toEqual(groups);
    }
  );
  it('keeps ligand copies distinct and marks only the source-verified binding-site copy', async () => {
    const pdb = [
      'HETATM    1  C1  ADP A 601      14.500  13.500   7.216  1.00 20.00           C',
      'HETATM    2  O1  ADP A 601      15.500  13.500   7.216  1.00 20.00           O',
      'HETATM    3  C1  ADP A 602      34.500  13.500   7.216  1.00 20.00           C',
      'HETATM    4  O1  ADP A 602      35.500  13.500   7.216  1.00 20.00           O',
      'END',
      '',
    ].join('\n');
    const parsed = await parsePDB(pdb).run();
    if (parsed.isError) throw Error(parsed.message);
    const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
    const builder = MVSData.createBuilder();
    const structure = builder
      .download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure();
    for (const residue of [601, 602]) {
      const selector = { auth_asym_id: 'A', auth_seq_id: residue };
      structure
        .component({
          selector,
          custom:
            residue === 601
              ? {
                  dnaforge_binding_region: { target: selector, partner: [] },
                }
              : undefined,
        })
        .representation({ type: 'ball_and_stick' })
        .color({ color: '#ff8800' });
    }
    const selections = molecularSceneSelections(source);
    const compiled = resolveMolecularDisplayGroups(
      builder.getState(),
      selections.describe,
      () => selections
    );
    const groups = molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.bindingScope)).toEqual(['site', 'context']);
    expect(groups[0].label).toContain('binding site');
    expect(groups[1].label).toContain('context');
    const plugin = molstarPluginFixture({
      state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
      managers: {
        structure: {
          hierarchy: { current: { structures: [{ cell: { obj: { data: source } } }] } },
        },
      },
    });
    expect(groups.map((g) => readSelected(g))).toEqual([
      [0, 1],
      [2, 3],
    ]);
    function readSelected(group: (typeof groups)[number]) {
      return StructureElement.Loci.toStructure(
        resolveMolViewSpecColorGroupLoci(plugin, group)
      ).units.flatMap((u) => Array.from(u.elements));
    }
    const again = resolveMolecularDisplayGroups(compiled, selections.describe, () => selections);
    expect(molViewSpecColorGroups(MVSData.toMVSJ(again), 0)).toEqual(groups);
  });
  it.each([
    { selector: 'all' as const, expectedAtoms: [1, 2] },
    { selector: { auth_asym_id: 'A' }, expectedAtoms: [1] },
  ])(
    'names residual ions from the actual component remainder: $selector',
    async ({ selector, expectedAtoms }) => {
      const parsed = await parsePDB(PDB).run();
      if (parsed.isError) throw Error(parsed.message);
      const source = Structure.ofModel(
        (await trajectoryFromPDB(parsed.result).run()).representative
      );
      const b = MVSData.createBuilder();
      b.download({ url: 'structure.pdb' })
        .parse({ format: 'pdb' })
        .modelStructure()
        .component({ selector })
        .representation({ type: 'ball_and_stick' })
        .color({
          color: '#2255aa',
          selector: 'protein',
          custom: { dnaforge_legend_label: 'Supporting protein' },
        });
      const selections = molecularSceneSelections(source);
      const document = resolveMolecularDisplayGroups(
        b.getState(),
        selections.describe,
        () => selections
      );
      const groups = molViewSpecColorGroups(MVSData.toMVSJ(document), 0);
      expect(groups.map(({ id, label, color }) => ({ id, label, color }))).toEqual([
        { id: 'ion:MG', label: 'Magnesium ions', color: 0xffffff },
        { id: 'Supporting protein\u0000' + 0x2255aa, label: 'Supporting protein', color: 0x2255aa },
      ]);
      const plugin = molstarPluginFixture({
        state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
        managers: {
          structure: {
            hierarchy: { current: { structures: [{ cell: { obj: { data: source } } }] } },
          },
        },
      });
      const selected = StructureElement.Loci.toStructure(
        resolveMolViewSpecColorGroupLoci(plugin, groups[0])
      );
      expect(selected.units.flatMap((u) => Array.from(u.elements))).toEqual(expectedAtoms);

      if (document.kind === 'multiple') throw Error('Expected single scene');
      const representation =
        document.root.children![0].children![0].children![0].children![0].children![0];
      const props = colorThemeForNode(representation as never, {} as never)!;
      const provider = makeMultilayerColorThemeProvider(ColorTheme.createRegistry());
      const theme = provider.factory(
        { structure: source },
        {
          ...PD.getDefaultValues(provider.getParams({ structure: source })),
          ...props.params,
        }
      );
      for (const unit of selected.units)
        for (const atom of unit.elements)
          expect(theme.color(StructureElement.Location.create(source, unit, atom), false)).toBe(
            groups[0].color
          );
      const again = resolveMolecularDisplayGroups(document, selections.describe, () => selections);
      expect(molViewSpecColorGroups(MVSData.toMVSJ(again), 0)).toEqual(groups);
    }
  );

  it.each([
    { label: 'Local ionic context', water: false, expected: ['Local ionic context'] },
    { label: undefined, water: true, expected: ['Magnesium ions', 'Waters'] },
  ])(
    'preserves authored owners and classifies unpainted physical types',
    async ({ label, water, expected }) => {
      const pdb = water
        ? PDB.replace(
            'END',
            'HETATM    4  O   HOH A 701      16.500  13.500   7.216  1.00 20.00           O\nEND'
          )
        : PDB;
      const parsed = await parsePDB(pdb).run();
      if (parsed.isError) throw Error(parsed.message);
      const source = Structure.ofModel(
        (await trajectoryFromPDB(parsed.result).run()).representative
      );
      const b = MVSData.createBuilder();
      b.download({ url: 'structure.pdb' })
        .parse({ format: 'pdb' })
        .modelStructure()
        .component({ selector: 'all' })
        .representation({
          type: 'ball_and_stick',
          custom: label ? { dnaforge_legend_label: label } : undefined,
        })
        .color({
          color: '#2255aa',
          selector: 'protein',
          custom: { dnaforge_legend_label: 'Supporting protein' },
        });
      const selections = molecularSceneSelections(source);
      const document = resolveMolecularDisplayGroups(
        b.getState(),
        selections.describe,
        () => selections
      );
      expect(molViewSpecColorGroups(MVSData.toMVSJ(document), 0).map((g) => g.label)).toEqual([
        ...expected,
        'Supporting protein',
      ]);
    }
  );

  it('does not invent a detail group when named scientific colors cover the entire component', async () => {
    const parsed = await parsePDB(PDB).run();
    if (parsed.isError) throw Error(parsed.message);
    const trajectory = await trajectoryFromPDB(parsed.result).run();
    const source = Structure.ofModel(trajectory.representative);
    const b = MVSData.createBuilder();
    b.download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure()
      .component({ selector: 'protein' })
      .representation({ type: 'ball_and_stick' })
      .color({
        color: '#2255aa',
        selector: { auth_asym_id: 'A' },
        custom: { dnaforge_legend_label: 'Catalytic subunit' },
      });
    const selections = molecularSceneSelections(source);
    const built = resolveMolecularDisplayGroups(
      b.getState(),
      selections.describe,
      () => selections
    );
    expect(molViewSpecColorGroups(MVSData.toMVSJ(built), 0).map((g) => g.label)).toEqual([
      'Catalytic subunit',
    ]);
  });
  it.each(['symbol', 'atom-index'])(
    'keeps %s element paint out of semantic legends and selects the complete molecule',
    async (mode) => {
      const pdb = [
        'ATOM      1  CA  ALA A   1      12.560  13.207   7.216  1.00 20.00           C',
        'ATOM      2  N   ALA A   1      13.560  13.207   7.216  1.00 20.00           N',
        'ATOM      3  O   ALA A   1      14.560  13.207   7.216  1.00 20.00           O',
        'END',
      ].join('\n');
      const parsed = await parsePDB(pdb).run();
      if (parsed.isError) throw Error(parsed.message);
      const source = Structure.ofModel(
        (await trajectoryFromPDB(parsed.result).run()).representative
      );
      const b = MVSData.createBuilder();
      const atom = b
        .download({ url: 'structure.pdb' })
        .parse({ format: 'pdb' })
        .modelStructure()
        .component({ selector: 'protein' })
        .representation({ type: 'ball_and_stick' });
      atom.color({ color: '#25b5ad', custom: { dnaforge_legend_label: 'Focal protein' } });
      atom.color({
        color: '#3058d5',
        selector: mode === 'symbol' ? { type_symbol: 'N' } : { atom_index: 1 },
        custom: { dnaforge_legend_label: 'Protein chain A' },
      });
      atom.color({
        color: '#e33232',
        selector: mode === 'symbol' ? { type_symbol: 'O' } : { atom_index: 2 },
        custom: { dnaforge_legend_label: 'Protein chain A' },
      });
      const doc = resolveMolecularDisplayGroups(
        b.getState(),
        molecularSceneSelections(source).describe
      );
      const groups = molViewSpecColorGroups(MVSData.toMVSJ(doc), 0);
      expect(groups.map((g) => g.label)).toEqual(['Focal protein']);
      const rep =
        doc.kind !== 'multiple'
          ? doc.root.children![0].children![0].children![0].children![0].children![0]
          : null;
      expect(rep?.children?.filter((c) => c.kind === 'color').map((c) => c.params?.color)).toEqual([
        '#25b5ad',
        '#3058d5',
        '#e33232',
      ]);
      const plugin = molstarPluginFixture({
        state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
        managers: {
          structure: {
            hierarchy: { current: { structures: [{ cell: { obj: { data: source } } }] } },
          },
        },
      });
      expect(StructureElement.Loci.size(resolveMolViewSpecColorGroupLoci(plugin, groups[0]))).toBe(
        3
      );
    }
  );

  it('preserves one identity color across story steps without changing element chemistry', () => {
    const b = MVSData.createBuilder();
    b.download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure()
      .component({ selector: 'protein' })
      .representation({ type: 'ball_and_stick' })
      .color({ color: '#25b5ad', custom: { dnaforge_legend_label: 'Same biological unit' } })
      .color({ color: '#3058d5', selector: { type_symbol: 'N' } });
    const first = b.getState();
    const second = structuredClone(first);
    second.root.children![0].children![0].children![0].children![0].children![0].children![0].params!.color =
      '#e33232';
    const story = {
      kind: 'multiple' as const,
      metadata: first.metadata,
      snapshots: [{ root: first.root }, { root: second.root }],
    };
    const compiled = resolveMolecularDisplayGroups(story);
    expect(molViewSpecColorGroups(MVSData.toMVSJ(compiled), 1).map((g) => g.color)).toEqual([
      0x25b5ad,
    ]);
    if (compiled.kind !== 'multiple') throw Error('Expected story');
    const atom =
      compiled.snapshots[1].root.children![0].children![0].children![0].children![0].children![0];
    expect(atom.children![1].params!.color).toBe('#3058d5');
  });

  it('coalesces equivalent ions using real chemistry and keeps both exact copies', async () => {
    const parsed = await parsePDB(PDB).run();
    if (parsed.isError) throw Error(parsed.message);
    const trajectory = await trajectoryFromPDB(parsed.result).run();
    const source = Structure.ofModel(trajectory.representative);
    const builder = MVSData.createBuilder();
    const structure = builder
      .download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure();
    for (const chain of ['A', 'B'])
      structure
        .component({ selector: { auth_asym_id: chain, label_comp_id: 'MG' } })
        .representation({ type: 'ball_and_stick' })
        .color({ color: '#ff8800', custom: { dnaforge_legend_label: `Magnesium ${chain}` } });
    const compiled = resolveMolecularDisplayGroups(
      builder.getState(),
      molecularSceneSelections(source).describe
    );
    const groups = molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'ion:MG', label: 'Magnesium ions', selectable: true });
    expect(groups[0].targets).toHaveLength(2);
    const plugin = molstarPluginFixture({
      state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
      managers: {
        structure: {
          hierarchy: { current: { structures: [{ cell: { obj: { data: source } } }] } },
        },
      },
    });
    const loci = resolveMolViewSpecColorGroupLoci(plugin, groups[0]);
    expect(StructureElement.Loci.size(loci)).toBe(2);
    expect(
      StructureElement.Loci.toStructure(loci).units.flatMap((u) => Array.from(u.elements))
    ).not.toContain(0);
    const elementDocument = builder.getState();
    const ionComponents = elementDocument.root.children![0].children![0].children![0].children!;
    for (const component of ionComponents) component.children![0].children = [];
    const elementProfile = resolveMolViewSpecRenderProfile(elementDocument);
    const elementGroups = molViewSpecColorGroups(
      MVSData.toMVSJ(
        resolveMolecularDisplayGroups(elementProfile, molecularSceneSelections(source).describe)
      ),
      0
    );
    expect(elementGroups).toHaveLength(1);
    expect(elementGroups[0]).toMatchObject({ label: 'Magnesium ions', color: 0x8aff00 });
  });

  it('covers named partial paints and residual geometry, and excludes elemental palette tables', () => {
    const builder = MVSData.createBuilder();
    builder
      .download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure()
      .component({ selector: 'protein' })
      .representation({ type: 'cartoon' })
      .color({
        color: '#ff0000',
        selector: { auth_seq_id: 42 },
        custom: { dnaforge_legend_label: 'Pocket' },
      });
    const compiled = resolveMolecularDisplayGroups(builder.getState());
    const groups = molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0);
    expect(groups.map((g) => g.label)).toEqual(['Protein', 'Pocket']);
    expect(groups[0].targets[0].laterColorSelectors).toEqual([{ auth_seq_id: 42 }]);
    expect(colorLegendsForMolViewSpecScene(MVSData.toMVSJ(compiled), 0)).toHaveLength(1);
    const representation =
      compiled.kind !== 'multiple'
        ? compiled.root.children![0].children![0].children![0].children![0].children![0]
        : undefined;
    if (!representation) throw Error('Expected representation');
    delete representation.custom!.dnaforge_display_group;
    expect(() => requireMolecularDisplayGroups(compiled)).toThrow('without a valid legend');
  });

  it('requires a legend for a data-marked color in a designated view', () => {
    const builder = MVSData.createBuilder();
    builder
      .download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure()
      .component({ selector: 'protein' })
      .representation({ type: 'cartoon' })
      .color({ color: '#2255aa' });
    const scene = resolveMolecularDisplayGroups(builder.getState());
    if (scene.kind === 'multiple') throw Error('Expected one scene');
    const representation =
      scene.root.children![0].children![0].children![0].children![0].children![0];
    const color = representation.children!.find((child) => child.kind === 'color')!;
    color.custom = { dnaforge_molecular_data_color: true };
    expect(() => requireMolecularDisplayGroups(scene)).toThrow('undesignated color layer');
  });

  it('rejects missing designation in a later step and preserves historical replay', () => {
    const builder = MVSData.createBuilder();
    builder
      .download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure()
      .component({ selector: 'protein' })
      .representation({ type: 'cartoon' });
    const original = builder.getState();
    expect(() => requireMolecularDisplayGroups(original, false)).not.toThrow();
    expect(() => requireMolecularDisplayGroups(original)).toThrow('Apply the scene once');
    const valid = resolveMolecularDisplayGroups(original);
    if (valid.kind === 'multiple') throw Error('Expected single');
    const broken = structuredClone(valid.root);
    delete broken.children![0].children![0].children![0].children![0].children![0].custom!
      .dnaforge_display_group;
    const story = {
      kind: 'multiple' as const,
      metadata: valid.metadata,
      snapshots: [
        { root: valid.root, metadata: {} },
        { root: broken, metadata: {} },
      ],
    };
    expect(() => requireMolecularDisplayGroups(story)).toThrow('Story step 2');
  });
});
