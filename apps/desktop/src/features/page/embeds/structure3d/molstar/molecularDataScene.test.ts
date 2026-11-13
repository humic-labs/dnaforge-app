import { recolorStructureScene } from './sceneColors';
import { expect, it } from 'vitest';
import { molecularDataScene, molecularDataVisibility } from './molecularDataScene';
import { DISPLAY_GROUP_CONTRACT } from './molecularDisplayGroups';
import { StructureElement } from 'molstar/lib/mol-model/structure';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import {
  requireMolecularDisplayGroups,
  resolveMolecularDisplayGroups,
} from './molecularDisplayGroups';
import { molViewSpecColorGroups } from './molViewSpecLegend';

const base = JSON.stringify({
  metadata: { version: '1' },
  root: {
    kind: 'root',
    children: [
      {
        kind: 'download',
        params: { url: 'coordinates.cif' },
        children: [
          {
            kind: 'parse',
            params: { format: 'mmcif' },
            children: [
              {
                kind: 'structure',
                params: { type: 'model' },
                children: [
                  {
                    kind: 'component',
                    params: { selector: 'all' },
                    children: [
                      {
                        kind: 'representation',
                        params: { type: 'ball_and_stick' },
                        children: [
                          { kind: 'color', params: { color: '#cccccc' } },
                          { kind: 'opacity', params: { opacity: 0.8 } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { kind: 'camera', params: { target: [0, 0, 0], position: [0, 0, 150], up: [0, 1, 0] } },
    ],
  },
});
it('authors standard scoped colors on existing representations, preserving base geometry and camera', () => {
  const colors = [
    { row: 0, selector: { label_asym_id: 'A' }, color: '#ff0000' },
    {
      row: 1,
      selector: [{ label_asym_id: 'D', label_atom_id: 'CA' }, { label_asym_id: 'H' }],
      color: '#00ff00',
    },
  ];
  const scene = JSON.parse(molecularDataScene(base, colors));
  expect(scene.root.children[1]).toEqual(JSON.parse(base).root.children[1]);
  const representation = scene.root.children[0].children[0].children[0].children[0].children[0];
  expect(representation.params).toEqual({ type: 'ball_and_stick' });
  expect(representation.children).toEqual([
    { kind: 'color', params: { color: '#cccccc' } },
    { kind: 'opacity', params: { opacity: 0.8 } },
    {
      kind: 'color',
      custom: { dnaforge_display_group_role: 'data', dnaforge_molecular_data_color: true },
      params: { color: '#ff0000', selector: [{ label_asym_id: 'A' }] },
    },
    {
      kind: 'color',
      custom: { dnaforge_display_group_role: 'data', dnaforge_molecular_data_color: true },
      params: {
        color: '#00ff00',
        selector: [{ label_asym_id: 'D', label_atom_id: 'CA' }, { label_asym_id: 'H' }],
      },
    },
  ]);
});
it('keeps a designated view saveable after its data colors are applied ', () => {
  const designated = JSON.parse(base);
  designated.root.custom = { dnaforge_display_group_contract: DISPLAY_GROUP_CONTRACT };
  const representation =
    designated.root.children[0].children[0].children[0].children[0].children[0];
  representation.custom = {
    dnaforge_display_group: { label: 'Polymer context', color: '#cccccc', id: 'polymer' },
  };
  representation.children[0].custom = { dnaforge_legend_label: 'Polymer context' };
  const before = JSON.stringify(designated);
  expect(() => requireMolecularDisplayGroups(JSON.parse(before))).not.toThrow();
  const colored = molecularDataScene(before, [
    { row: 0, selector: { label_asym_id: 'A', label_seq_id: 1 }, color: '#ff0000' },
  ]);
  expect(() => requireMolecularDisplayGroups(JSON.parse(colored))).not.toThrow();
  const authored = JSON.parse(before);
  authored.root.children[0].children[0].children[0].children[0].children[0].children.push({
    kind: 'color',
    params: { color: '#00ff00', selector: [{ label_asym_id: 'A' }] },
  });
  expect(() => requireMolecularDisplayGroups(authored)).toThrow(/undesignated color layer/);
});

it('rejects stories explicitly instead of silently reapplying their cameras for a data edit', () => {
  expect(() => molecularDataScene(JSON.stringify({ kind: 'multiple', snapshots: [] }), [])).toThrow(
    /single/i
  );
});

it('keeps data-derived views saveable and replayable without changing molecular object legends', () => {
  const authored = resolveMolecularDisplayGroups(JSON.parse(base));
  const colors = [
    { row: 0, selector: { label_asym_id: 'A', label_seq_id: 1 }, color: '#ff0000' },
    { row: 1, selector: { label_asym_id: 'A', label_seq_id: 2 }, color: '#0000ff' },
  ];
  const applied = molecularDataScene(JSON.stringify(authored), colors);
  const visibleLegend = (scene: string) =>
    molViewSpecColorGroups(scene, 0).map((group) => ({
      id: group.id,
      label: group.label,
      color: group.color,
      structureCount: group.structureCount,
      selectable: group.selectable,
      bindingScope: group.bindingScope,
      presentationRole: group.presentationRole,
    }));
  expect(() => requireMolecularDisplayGroups(JSON.parse(applied))).not.toThrow();
  expect(visibleLegend(applied)).toEqual(visibleLegend(JSON.stringify(authored)));
  const replayed = JSON.parse(JSON.stringify(resolveMolecularDisplayGroups(JSON.parse(applied))));
  expect(() => requireMolecularDisplayGroups(replayed)).not.toThrow();
  expect(visibleLegend(JSON.stringify(replayed))).toEqual(visibleLegend(JSON.stringify(authored)));
  const representation = replayed.root.children[0].children[0].children[0].children[0].children[0];
  expect(representation.children.slice(-2).map((node) => node.params)).toEqual(
    colors.map(({ selector, color }) => ({ selector: [selector], color }))
  );
  delete representation.children.at(-1).custom.dnaforge_display_group_role;
  delete representation.children.at(-1).custom.dnaforge_legend_label;
  expect(() => requireMolecularDisplayGroups(replayed)).toThrow('undesignated color layer');
});

it('keeps an authored data-colored scene eligible for Save without changing its molecular designation', () => {
  const authored = resolveMolecularDisplayGroups(MVSData.fromMVSJ(base));
  expect(() => requireMolecularDisplayGroups(authored)).not.toThrow();
  const colors = [
    { row: 0, selector: { label_asym_id: 'A' }, color: '#ff0000' },
    { row: 1, selector: { label_asym_id: 'B' }, color: '#0000ff' },
  ];
  const colored = MVSData.fromMVSJ(molecularDataScene(MVSData.toMVSJ(authored), colors));
  expect(() => requireMolecularDisplayGroups(colored)).not.toThrow();
  if (authored.kind === 'multiple' || colored.kind === 'multiple') throw Error('Expected one view');
  const before = authored.root.children![0].children![0].children![0].children![0].children![0];
  const after = colored.root.children![0].children![0].children![0].children![0].children![0];
  expect(after.custom).toEqual(before.custom);
  expect(after.params).toEqual(before.params);
  expect(after.children!.slice(0, before.children!.length)).toEqual(before.children);
  expect(after.children!.slice(before.children!.length)).toEqual(
    colors.map(({ selector, color }) => ({
      kind: 'color',
      params: { color, selector: [selector] },
      custom: {
        dnaforge_display_group_role: 'data',
        dnaforge_legend_label: before.custom!.dnaforge_display_group.label,
        dnaforge_legend_generated: true,
      },
    }))
  );
  expect(colored.root.children![1]).toEqual(authored.root.children![1]);
  expect(JSON.parse(base).root.custom).toBeUndefined();
});

it('retains disjoint data colors and the saved camera through display-group resolution', () => {
  const authored = resolveMolecularDisplayGroups(MVSData.fromMVSJ(base));
  const current = JSON.parse(base);
  current.root.children[1].params.position = [40, 50, 60];
  const colors = [
    { row: 0, selector: { label_asym_id: 'A' }, color: '#ff0000' },
    { row: 1, selector: { label_asym_id: 'B' }, color: '#0000ff' },
  ];
  const colored = MVSData.fromMVSJ(
    molecularDataScene(MVSData.toMVSJ(authored), colors, JSON.stringify(current))
  );
  const resolved = resolveMolecularDisplayGroups(colored);
  expect(() => requireMolecularDisplayGroups(resolved)).not.toThrow();
  if (authored.kind === 'multiple' || resolved.kind === 'multiple')
    throw Error('Expected one view');
  const before = authored.root.children![0].children![0].children![0].children![0].children![0];
  const after = resolved.root.children![0].children![0].children![0].children![0].children![0];
  expect(after.params).toEqual(before.params);
  expect(after.children!.slice(-2).map((node) => node.params)).toEqual(
    colors.map(({ color, selector }) => ({ color, selector: [selector] }))
  );
  expect(after.children!.slice(-2).map((node) => node.custom?.dnaforge_legend_generated)).toEqual([
    true,
    true,
  ]);
  expect(resolved.root.children![1]).toEqual(current.root.children[1]);
});

it('retains the current saved camera node and its position in the root when reapplying data', () => {
  const current = JSON.parse(base);
  const camera = {
    kind: 'camera',
    params: { target: [4, 5, 6], position: [40, 50, 60], up: [0, 1, 0] },
  };
  current.root.children = [camera, current.root.children[0]];
  const result = JSON.parse(
    molecularDataScene(
      base,
      [{ row: 0, selector: { label_asym_id: 'A' }, color: '#ff0000' }],
      JSON.stringify(current)
    )
  );
  expect(result.root.children[0]).toEqual(camera);
  expect(result.root.children[1].kind).toBe('download');
  expect(JSON.parse(base).root.children[1].params.target).toEqual([0, 0, 0]);
});

it('distinguishes coordinate targets from atoms actually drawn, including hidden representations', () => {
  const unit = { kind: 0, id: 7, model: { id: 'model' } };
  const native = {
    state: { visible: true, alphaFactor: 1, transparency: { layers: [] } },
    props: { alpha: 1 },
    renderObjects: [
      {
        state: { visible: true },
        values: { drawCount: { ref: { value: 3 } }, uAlpha: { ref: { value: 1 } } },
      },
    ],
    eachLocation: (visit: Function) =>
      visit(StructureElement.Location.create(undefined, unit as never, 10), false),
  };
  const plugin = {
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                components: [{ representations: [{ cell: { obj: { data: { repr: native } } } }] }],
              },
            ],
          },
        },
      },
    },
  };
  const resolved = {
    targets: [
      { row: 0, elements: ['0:7:10', '0:7:11'] },
      { row: 1, elements: ['0:7:11'] },
    ],
    mappedRows: [0, 1],
    unresolved: [],
  };
  const colors = [
    { row: 0, selector: { atom_id: 10 }, color: '#ff0000' },
    { row: 1, selector: { atom_id: 11 }, color: '#0000ff' },
  ];
  expect(molecularDataVisibility(plugin as never, resolved, colors)).toEqual({
    renderedRows: [0],
    unrenderedRows: [1],
  });
  native.state.visible = false;
  expect(molecularDataVisibility(plugin as never, resolved, colors)).toEqual({
    renderedRows: [],
    unrenderedRows: [0, 1],
  });
});

it('keeps data colors saveable under the existing molecular owner without changing their paint', () => {
  const designated = resolveMolecularDisplayGroups(JSON.parse(base));
  const original = JSON.stringify(designated);
  const colors = [
    { row: 0, selector: { label_asym_id: 'A' }, color: '#ff0000' },
    { row: 1, selector: { label_asym_id: 'D' }, color: '#0000ff' },
  ];
  const scene = JSON.parse(molecularDataScene(original, colors));
  expect(() => requireMolecularDisplayGroups(scene)).not.toThrow();
  const before =
    JSON.parse(original).root.children[0].children[0].children[0].children[0].children[0];
  const after = scene.root.children[0].children[0].children[0].children[0].children[0];
  expect(after.params).toEqual(before.params);
  expect(after.custom).toEqual(before.custom);
  expect(after.children.slice(0, before.children.length)).toEqual(before.children);
  expect(after.children.slice(before.children.length)).toEqual(
    colors.map(({ color, selector }) => ({
      kind: 'color',
      params: { color, selector: [selector] },
      custom: {
        dnaforge_display_group_role: 'data',
        dnaforge_legend_label: before.custom.dnaforge_display_group.label,
        dnaforge_legend_generated: true,
      },
    }))
  );
  expect(scene.root.children[1]).toEqual(JSON.parse(original).root.children[1]);
  expect(JSON.stringify(designated)).toBe(original);
});

it('keeps distinct measurement colors when the same owner is resolved for a later edit', () => {
  const designated = resolveMolecularDisplayGroups(JSON.parse(base));
  const colors = [
    { row: 0, selector: { label_asym_id: 'A' }, color: '#ff0000' },
    { row: 1, selector: { label_asym_id: 'D' }, color: '#0000ff' },
  ];
  const scene = JSON.parse(molecularDataScene(JSON.stringify(designated), colors));
  const edited = resolveMolecularDisplayGroups(scene);
  if (edited.kind === 'multiple') throw new Error('Expected one fixture view.');
  const representation =
    edited.root.children![0].children![0].children![0].children![0].children![0];
  const dataColors = representation.children?.filter((node) => node.kind === 'color').slice(-2);
  expect(dataColors?.map((node) => node.params)).toEqual(
    colors.map(({ color, selector }) => ({ color, selector: [selector] }))
  );
  expect(() => requireMolecularDisplayGroups(edited)).not.toThrow();
  const authoredIdentity = structuredClone(scene);
  for (const color of authoredIdentity.root.children[0].children[0].children[0].children[0].children[0].children.slice(
    -2
  )) {
    color.custom.dnaforge_legend_generated = false;
    delete color.custom.dnaforge_display_group_role;
  }
  const collapsed = resolveMolecularDisplayGroups(authoredIdentity);
  if (collapsed.kind === 'multiple') throw new Error('Expected one fixture view.');
  const collapsedColors = collapsed.root
    .children![0].children![0].children![0].children![0].children![0].children?.filter(
      (node) => node.kind === 'color'
    )
    .slice(-2);
  expect(collapsedColors?.map((node) => node.params.color)).toEqual(['#ff0000', '#ff0000']);
});

it.each(['chain', 'element', 'confidence'] as const)(
  'keeps manual %s coloring and recovered data colors saveable under the existing owner',
  (mode) => {
    const designated = resolveMolecularDisplayGroups(JSON.parse(base));
    const original = JSON.stringify(designated);
    const manual = JSON.parse(recolorStructureScene(original, 0, mode));
    expect(() => requireMolecularDisplayGroups(manual)).not.toThrow();
    const recovered = JSON.parse(
      molecularDataScene(JSON.stringify(manual), [
        { row: 0, selector: { label_asym_id: 'A' }, color: '#ff0000' },
        { row: 1, selector: { label_asym_id: 'D' }, color: '#0000ff' },
      ])
    );
    expect(() => requireMolecularDisplayGroups(recovered)).not.toThrow();
    const representation =
      recovered.root.children[0].children[0].children[0].children[0].children[0];
    const before =
      JSON.parse(original).root.children[0].children[0].children[0].children[0].children[0];
    expect(representation.custom).toEqual(before.custom);
    expect(representation.children[0].custom).toMatchObject({
      dnaforge_legend_label: before.custom.dnaforge_display_group.label,
      dnaforge_legend_generated: true,
    });
    expect(recovered.root.children[1]).toEqual(JSON.parse(original).root.children[1]);
    delete representation.children[0].custom.dnaforge_legend_label;
    expect(() => requireMolecularDisplayGroups(recovered)).toThrow('undesignated color layer');
    expect(JSON.stringify(designated)).toBe(original);
  }
);
