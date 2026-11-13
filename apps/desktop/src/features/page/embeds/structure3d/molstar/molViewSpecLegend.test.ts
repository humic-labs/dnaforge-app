import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { Color } from 'molstar/lib/mol-util/color';
import type { MolecularDataLayer } from '../utils/molecularData';
import type { Structure3dAttrs } from '../types';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure';
import {
  colorKeysForThemes,
  colorLegendsForMolViewSpecScene,
  molViewSpecColorGroups,
} from './molViewSpecLegend';
import {
  nativeMolViewSpecColorGroups,
  resolveMolViewSpecColorGroupLociByStructure,
} from './molViewSpecSwatchSelection';

function scene(label: string, color = '#B74583', opacity = 1) {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'structure.pdb' })
    .parse({ format: 'pdb' })
    .modelStructure()
    .component({ selector: 'protein' })
    .representation({ type: 'cartoon' })
    .color({ color });
  const document = builder.getState();
  const representation =
    document.root.children![0].children![0].children![0].children![0].children![0];
  representation.children![0].custom = { dnaforge_legend_label: label };
  if (opacity !== 1) representation.children!.push({ kind: 'opacity', params: { opacity } });
  return document;
}

describe('MolViewSpec color key', () => {
  function generatedContourScene(
    change: {
      generated?: boolean;
      legacy?: boolean;
      identity?: string;
      label?: string;
      role?: string;
      type?: string;
      owner?: unknown;
    } = {}
  ) {
    const document = scene('Stationary domain', '#345678');
    const structure = document.root.children![0].children![0].children![0];
    structure.ref = 'physical-source';
    structure.children!.push({
      kind: 'component',
      params: { selector: { label_asym_id: 'A', beg_label_seq_id: 30, end_label_seq_id: 60 } },
      children: [
        {
          kind: 'representation',
          params: { type: 'cartoon' },
          children: [
            {
              kind: 'color',
              params: { color: '#987654' },
              custom: { dnaforge_legend_label: 'Moving domain' },
            },
          ],
        },
      ],
    });
    structure.children!.push({
      kind: 'component',
      params: { selector: { label_asym_id: 'A' } },
      custom: {
        dnaforge_surface_owner: change.owner ?? { regionRef: 'contact-region', side: 'partner' },
      },
      children: [
        {
          kind: 'representation',
          params: { type: change.type ?? 'surface' },
          custom: {
            dnaforge_presentation_generated: change.role ?? 'interface',
            dnaforge_legend_label: 'Generated contour',
          },
          children: [
            {
              kind: 'color',
              params: { color: '#aabbcc' },
              custom: {
                dnaforge_legend_label: change.label ?? 'Generated contour',
                ...(change.legacy ? {} : { dnaforge_legend_generated: change.generated ?? true }),
                ...(change.identity ? { dnaforge_molecular_identity: change.identity } : {}),
              },
            },
          ],
        },
      ],
    } as never);
    return JSON.stringify(document);
  }

  it('keeps a compiler contour supplement out of a partitioned scientific key without rewriting its scene', () => {
    const input = generatedContourScene();
    expect(molViewSpecColorGroups(input, 0).map((group) => group.label)).toEqual([
      'Stationary domain',
      'Moving domain',
    ]);
    expect(
      JSON.parse(input).root.children[0].children[0].children[0].children[2].children[0].children[0]
        .params.color
    ).toBe('#aabbcc');
  });

  it.each([
    { generated: false },
    { legacy: true },
    { identity: 'a separate molecular object' },
    { label: 'Inherited molecular identity' },
    { role: 'context' },
    { type: 'cartoon' },
    { owner: { regionRef: 'contact-region', side: 'invalid' } },
  ])('preserves scientific, inherited or noncompiler contour groups: %j', (change) => {
    expect(molViewSpecColorGroups(generatedContourScene(change), 0)).toHaveLength(3);
  });

  it.each([
    { surfaceChain: 'A', identity: 'Bound molecule', merged: true },
    { surfaceChain: 'B', identity: 'Bound molecule', merged: false },
    { surfaceChain: 'A', identity: 'A distinct scientific role', merged: false },
  ])(
    'inherits a generated surface only with exact scientific and physical ownership: $surfaceChain / $identity',
    async ({ surfaceChain, identity, merged }) => {
      const parsed = await parsePDB(
        [
          'HETATM    1  C1  ADP A 601       0.000   0.000   0.000  1.00 20.00           C',
          'HETATM    2  O1  ADP A 601       1.000   0.000   0.000  1.00 20.00           O',
          'HETATM    3 MG    MG A 602       2.000   0.000   0.000  1.00 20.00          MG',
          'HETATM    4  C1  ADP B 601      20.000   0.000   0.000  1.00 20.00           C',
          'HETATM    5  O1  ADP B 601      21.000   0.000   0.000  1.00 20.00           O',
          'END',
        ].join('\n')
      ).run();
      if (parsed.isError) throw Error(parsed.message);
      const source = Structure.ofModel(
        (await trajectoryFromPDB(parsed.result).run()).representative
      );
      const builder = MVSData.createBuilder();
      const structure = builder
        .download({ url: 'source.pdb' })
        .parse({ format: 'pdb' })
        .modelStructure();
      structure
        .component({ selector: { auth_asym_id: 'A' } })
        .representation({ type: 'ball_and_stick' })
        .color({
          color: '#d4517b',
          custom: {
            dnaforge_legend_label: 'Pocket molecule',
            dnaforge_molecular_identity: 'Bound molecule',
          },
        })
        .color({
          color: '#8aff00',
          selector: { auth_asym_id: 'A', auth_seq_id: 602 },
          custom: {
            dnaforge_legend_label: 'Magnesium ions',
          },
        });
      structure
        .component({ selector: { auth_asym_id: surfaceChain, auth_seq_id: 601 } })
        .representation({
          type: 'surface',
          custom: { dnaforge_presentation_generated: 'binding-site' },
        })
        .color({
          color: '#d4517b',
          custom: {
            dnaforge_legend_label: 'Molecule envelope',
            dnaforge_molecular_identity: identity,
            dnaforge_binding_scope: 'site',
          },
        });
      const plugin = molstarPluginFixture({
        state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
        managers: {
          structure: {
            hierarchy: {
              current: {
                structures: [{ cell: { obj: { data: source } } }],
              },
            },
          },
        },
      });
      const groups = nativeMolViewSpecColorGroups(plugin, MVSData.toMVSJ(builder.getState()), 0);
      expect(groups.map((group) => group.label)).toEqual(
        merged
          ? ['Pocket molecule', 'Magnesium ions']
          : ['Pocket molecule', 'Magnesium ions', 'Molecule envelope · binding site']
      );
      expect(
        StructureElement.Loci.size(
          resolveMolViewSpecColorGroupLociByStructure(plugin, groups[0])[0].loci
        )
      ).toBe(2);
    }
  );
  it('sectors a multicolor swatch by the carbon colors actually drawn on its polymer ', async () => {
    const parsed = await parsePDB(
      [
        'ATOM      1 N    ALA A   1       3.000   0.000   0.000  1.00 20.00           N',
        'ATOM      2 CA   ALA A   1       3.100   0.000   0.000  1.00 20.00           C',
        'ATOM      3 C    ALA A   1       3.200   0.000   0.000  1.00 20.00           C',
        'ATOM      4 O    ALA A   1       3.300   0.000   0.000  1.00 20.00           O',
        'ATOM      5 CB   ALA A   1       3.400   0.000   0.000  1.00 20.00           C',
        'ATOM      6 N    ALA A   2       6.500   0.000   0.000  1.00 20.00           N',
        'ATOM      7 CA   ALA A   2       6.600   0.000   0.000  1.00 20.00           C',
        'ATOM      8 C    ALA A   2       6.700   0.000   0.000  1.00 20.00           C',
        'ATOM      9 O    ALA A   2       6.800   0.000   0.000  1.00 20.00           O',
        'ATOM     10 CB   ALA A   2       6.900   0.000   0.000  1.00 20.00           C',
        'ATOM     11 N    ALA B   1      34.000   0.000   0.000  1.00 20.00           N',
        'ATOM     12 CA   ALA B   1      34.100   0.000   0.000  1.00 20.00           C',
        'ATOM     13 C    ALA B   1      34.200   0.000   0.000  1.00 20.00           C',
        'ATOM     14 O    ALA B   1      34.300   0.000   0.000  1.00 20.00           O',
        'ATOM     15 CB   ALA B   1      34.400   0.000   0.000  1.00 20.00           C',
        'ATOM     16 N    ALA B   2      37.500   0.000   0.000  1.00 20.00           N',
        'ATOM     17 CA   ALA B   2      37.600   0.000   0.000  1.00 20.00           C',
        'ATOM     18 C    ALA B   2      37.700   0.000   0.000  1.00 20.00           C',
        'ATOM     19 O    ALA B   2      37.800   0.000   0.000  1.00 20.00           O',
        'ATOM     20 CB   ALA B   2      37.900   0.000   0.000  1.00 20.00           C',
        'HETATM   21 C1   ADP C 601      60.000   0.000   0.000  1.00 20.00           C',
        'HETATM   22 O1   ADP C 601      61.000   0.000   0.000  1.00 20.00           O',
        'END',
      ].join('\n')
    ).run();
    if (parsed.isError) throw Error(parsed.message);
    const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
    const plugin = molstarPluginFixture({
      state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
      managers: {
        structure: {
          hierarchy: { current: { structures: [{ cell: { obj: { data: source } } }] } },
        },
      },
    });
    const swatch = (selector: 'all' | 'ligand', theme: string) => {
      const builder = MVSData.createBuilder();
      builder
        .download({ url: 'source.pdb' })
        .parse({ format: 'pdb' })
        .modelStructure()
        .component({ selector })
        .representation({ type: 'ball_and_stick' })
        .color({
          color: '#3388ff',
          custom: { molstar_color_theme_name: theme, dnaforge_legend_label: 'Selection' },
        });
      const document = builder.getState();
      document.root.custom = { dnaforge_display_group_contract: 'automatic-display-groups-v1' };
      const [group] = nativeMolViewSpecColorGroups(plugin, MVSData.toMVSJ(document), 0);
      expect(group.multicolor).toBe(true);
      return group.swatch;
    };
    const elementPolymer = swatch('all', 'element-symbol');
    const chainPolymer = swatch('all', 'chain-id');
    const elementLigand = swatch('ligand', 'element-symbol');
    expect(elementPolymer?.kind).toBe('colors');
    expect(elementPolymer?.colors).toHaveLength(2);
    expect(elementPolymer?.colors).not.toContain(Color(0x3050f8));
    expect(elementPolymer?.colors).not.toContain(Color(0xff0d0d));
    expect(chainPolymer).toEqual(elementPolymer);
    expect(elementLigand?.colors).toHaveLength(1);
    expect(elementPolymer?.colors).not.toContain(elementLigand?.colors[0]);
    expect(swatch('all', 'uncertainty')?.kind).toBe('gradient');
  });

  it('keeps groups selectable with a distinct MVS structure identity for each source', () => {
    const document = scene('First');
    const second = scene('Second');
    second.root.children![0].params.url = 'second.pdb';
    document.root.children!.push(...second.root.children!);
    const groups = molViewSpecColorGroups(JSON.stringify(document), 0);
    expect(groups.map((g) => g.selectable)).toEqual([true, true]);
    const refs = groups.map((g) => g.targets[0].structureRef);
    expect(refs.every((ref) => typeof ref === 'string' && ref.length > 0)).toBe(true);
    expect(new Set(refs).size).toBe(2);
  });
  it('does not silently discard groups beyond sixteen', () => {
    const document = scene('Group 1');
    const structure = document.root.children![0].children![0].children![0];
    const component = structure.children![0];
    for (let index = 2; index <= 20; index++) {
      const extra = structuredClone(component);
      extra.children![0].children![0].custom = { dnaforge_legend_label: `Group ${index}` };
      structure.children!.push(extra);
    }
    expect(molViewSpecColorGroups(JSON.stringify(document), 0)).toHaveLength(20);
  });
  it('keeps the exact component and color selectors behind a named swatch', () => {
    const document = scene('Pocket');
    const representation =
      document.root.children![0].children![0].children![0].children![0].children![0];
    representation.children![0].params = {
      color: '#B74583',
      selector: { label_asym_id: 'A', auth_seq_id: 42 },
    };
    representation.children!.push({
      kind: 'color',
      params: { color: '#eeeeee', selector: { label_asym_id: 'A', auth_seq_id: 43 } },
    });
    expect(molViewSpecColorGroups(JSON.stringify(document), 0)).toEqual([
      expect.objectContaining({
        label: 'Pocket',
        color: Color(0xb74583),
        selectable: true,
        targets: [
          {
            structureIndex: 0,
            structureRef: expect.any(String),
            componentSelector: 'protein',
            colorSelector: { label_asym_id: 'A', auth_seq_id: 42 },
            laterColorSelectors: [{ label_asym_id: 'A', auth_seq_id: 43 }],
          },
        ],
      }),
    ]);
  });

  it('keeps internal nucleotide paint within its owner while preserving scientific overrides', () => {
    const document = scene('Target DNA', '#e1b62b');
    const component = document.root.children![0].children![0].children![0].children![0];
    component.params = { selector: [{ label_asym_id: 'B' }, { label_asym_id: 'C' }] };
    const representation = component.children![0];
    const detail = { label_asym_id: 'B', auth_seq_id: 3 };
    const recognition = { label_asym_id: 'C', auth_seq_id: 5 };
    representation.children!.push(
      {
        kind: 'color',
        params: { color: '#e1b62b', selector: detail },
        custom: {
          dnaforge_legend_label: 'Target DNA',
          dnaforge_nucleotide_appearance_color: true,
        },
      },
      {
        kind: 'color',
        params: { color: '#b74583', selector: recognition },
        custom: { dnaforge_legend_label: 'Recognition base' },
      }
    );
    const groups = molViewSpecColorGroups(JSON.stringify(document), 0);
    expect(groups.map((group) => group.label)).toEqual(['Target DNA', 'Recognition base']);
    expect(groups[0].targets[0]).toMatchObject({
      componentSelector: [{ label_asym_id: 'B' }, { label_asym_id: 'C' }],
      colorSelector: 'all',
      laterColorSelectors: [recognition],
    });
    expect(groups[1].targets[0]).toMatchObject({
      colorSelector: recognition,
      laterColorSelectors: [],
    });
  });

  it('does not offer a misleading partial selection for an annotation repaint', () => {
    const document = scene('First layer');
    const representation =
      document.root.children![0].children![0].children![0].children![0].children![0];
    representation.children!.push({
      kind: 'color_from_source',
      params: { category_name: 'atom_site' },
    });
    expect(molViewSpecColorGroups(JSON.stringify(document), 0)[0].selectable).toBe(false);
  });

  it('extends an established owner with foreground supplements without creating helper owners', () => {
    const document = scene('Target DNA', '#e1b62b');
    const structure = document.root.children![0].children![0].children![0];
    const background = structure.children![0];
    background.params = { selector: { label_asym_id: 'A', auth_seq_id: 1 } };
    const foreground = structuredClone(background);
    foreground.params = { selector: { label_asym_id: 'A', auth_seq_id: 2 } };
    foreground.children![0].custom = {
      dnaforge_display_group: {
        id: 'appearance',
        label: 'Appearance helper',
        color: '#e1b62b',
        supplement: true,
      },
    };
    foreground.children![0].children!.push({
      kind: 'color',
      params: { color: '#e1b62b', selector: { label_asym_id: 'A', auth_seq_id: 3 } },
      custom: { dnaforge_legend_label: 'Unestablished helper' },
    });
    structure.children!.unshift(foreground);
    const groups = molViewSpecColorGroups(JSON.stringify(document), 0);
    expect(groups.map((group) => group.label)).toEqual(['Target DNA']);
    expect(groups[0].targets).toHaveLength(2);
    expect(groups[0].targets.map((target) => target.componentSelector)).toEqual([
      { label_asym_id: 'A', auth_seq_id: 1 },
      { label_asym_id: 'A', auth_seq_id: 2 },
    ]);
  });

  it('does not expose an atom selection for clipped or hidden geometry', () => {
    const clipped = scene('Cutaway');
    const representation =
      clipped.root.children![0].children![0].children![0].children![0].children![0];
    representation.children!.push({ kind: 'clip', params: { type: 'sphere' } });
    expect(molViewSpecColorGroups(JSON.stringify(clipped), 0)[0].selectable).toBe(false);
    representation.custom = { is_hidden: true };
    expect(molViewSpecColorGroups(JSON.stringify(clipped), 0)).toEqual([]);
  });

  it('uses the actual color node for a named swatch', () => {
    const document = scene('HNH nuclease');
    expect(colorLegendsForMolViewSpecScene(JSON.stringify(document), 0)).toEqual([
      { kind: 'table-legend', table: [['HNH nuclease', Color(0xb74583)]] },
    ]);
    expect(MVSData.validationIssues(document, { noExtra: true })).toBeUndefined();
  });

  it('marks a selection painted by a multicolor theme instead of showing its placeholder color ', () => {
    const paint = (custom: Record<string, unknown>) => {
      const document = scene('Polymer context', '#3388ff');
      document.root.custom = { dnaforge_display_group_contract: 'automatic-display-groups-v1' };
      const color =
        document.root.children![0].children![0].children![0].children![0].children![0].children![0];
      color.custom = { ...color.custom, ...custom };
      return molViewSpecColorGroups(JSON.stringify(document), 0)[0];
    };
    expect(paint({ molstar_color_theme_name: 'element-symbol' }).multicolor).toBe(true);
    expect(paint({ molstar_color_theme_name: 'chain-id' }).multicolor).toBe(true);
    expect(paint({ molstar_use_default_coloring: true }).multicolor).toBe(true);
    expect(paint({ molstar_color_theme_name: 'uniform' }).multicolor).toBeUndefined();
    expect(
      paint({
        molstar_color_theme_name: 'element-symbol',
        molstar_color_theme_params: {
          carbonColor: { name: 'uniform', params: { value: 0x3388ff } },
        },
      }).multicolor
    ).toBeUndefined();
    expect(paint({}).multicolor).toBeUndefined();
  });

  it('titles every color key by the coloring that produced it, and drops untitled keys ', () => {
    const scale = {
      kind: 'scale-legend' as const,
      minLabel: '0',
      maxLabel: '100',
      colors: [Color(0x0000ff), Color(0xff0000)],
    };
    const chains = {
      kind: 'table-legend' as const,
      table: [['E', Color(0x1b9e77)]] as [string, Color][],
    };
    const themes = [
      { themeName: 'uncertainty', legend: scale },
      { themeName: 'chain-id', legend: chains },
    ];
    expect(colorKeysForThemes(themes, 'pdb')).toEqual([{ title: 'B-factor (Å²)', legend: scale }]);
    expect(colorKeysForThemes(themes, 'alphafold')).toEqual([{ title: 'pLDDT', legend: scale }]);
    expect(colorKeysForThemes([{ themeName: 'plddt-confidence', legend: chains }], 'file')).toEqual(
      [{ title: 'pLDDT', legend: chains }]
    );
  });

  it('titles the active mapped-data coloring by its column and units ', () => {
    const revision = 'a'.repeat(64);
    const layer = (
      id: string,
      column: string,
      style: MolecularDataLayer['style'],
      units?: string
    ): MolecularDataLayer => ({
      id,
      name: id,
      datasetId: 'measurements',
      dataRevision: revision,
      mappingRevision: revision,
      column,
      units,
      style,
    });
    const ratio = layer(
      'ratio',
      'b_iso_log2_ratio',
      {
        kind: 'continuous',
        domain: [-2, 2],
        colors: ['#0000ff', '#ffffff', '#ff0000'],
        missingColor: '#9ca3af',
        transform: 'linear',
      },
      'log2 ratio'
    );
    const classes = layer('classes', 'molecule_class', {
      kind: 'categorical',
      colors: { rna: '#ff0000', protein: '#0000ff' },
      missingColor: '#9ca3af',
    });
    const counts = layer('counts', 'reads', {
      kind: 'continuous',
      domain: [1, 1000],
      colors: ['#ffffff', '#000000'],
      missingColor: '#9ca3af',
      transform: 'log10',
    });
    const attrs = (activeLayerId?: string): Pick<Structure3dAttrs, 'source' | 'molecularData'> => ({
      source: 'pdb',
      molecularData: {
        version: 1,
        datasets: [],
        mappings: [],
        layers: [ratio, classes, counts],
        activeLayerId,
      },
    });

    expect(colorKeysForThemes([], attrs('ratio'))).toEqual([
      {
        title: 'b_iso_log2_ratio (log2 ratio)',
        legend: {
          kind: 'scale-legend',
          minLabel: '-2',
          maxLabel: '2',
          colors: [Color(0x0000ff), Color(0xffffff), Color(0xff0000)],
        },
      },
    ]);
    expect(colorKeysForThemes([], attrs('classes'))).toEqual([
      {
        title: 'molecule_class',
        legend: {
          kind: 'table-legend',
          table: [
            ['rna', Color(0xff0000)],
            ['protein', Color(0x0000ff)],
          ],
        },
      },
    ]);
    expect(colorKeysForThemes([], attrs('counts'))[0].title).toBe('reads (log scale)');
    expect(colorKeysForThemes([], attrs())).toEqual([]);
  });

  it('shows only the active story step and ignores fully invisible representations', () => {
    const first = scene('Overview', '#e58c24');
    const second = scene('Pocket', 'royalblue');
    const hidden = scene('Hidden', '#00ff00', 0);
    second.root.children!.push(...hidden.root.children!);
    const story = JSON.stringify({
      kind: 'multiple',
      metadata: first.metadata,
      snapshots: [
        { root: first.root, metadata: { title: 'Overview' } },
        { root: second.root, metadata: { title: 'Pocket' } },
      ],
    });
    expect(colorLegendsForMolViewSpecScene(story, 0)).toEqual([
      { kind: 'table-legend', table: [['Overview', Color(0xe58c24)]] },
    ]);
    expect(colorLegendsForMolViewSpecScene(story, 1)).toEqual([
      { kind: 'table-legend', table: [['Pocket', Color(0x4169e1)]] },
    ]);
  });

  it('does not invent entries for unlabeled, invalid, or malformed colors', () => {
    expect(colorLegendsForMolViewSpecScene(JSON.stringify(scene(' ')), 0)).toEqual([]);
    expect(colorLegendsForMolViewSpecScene(JSON.stringify(scene('Site', '#nothex')), 0)).toEqual(
      []
    );
    expect(colorLegendsForMolViewSpecScene('{', 0)).toEqual([]);
  });
});
