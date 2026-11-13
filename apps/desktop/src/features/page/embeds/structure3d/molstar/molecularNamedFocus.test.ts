import { describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure, StructureSelection } from 'molstar/lib/mol-model/structure';
import { Script } from 'molstar/lib/mol-script/script';
import { StructureSelectionQueries } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { resolveMolecularDisplayGroups } from './molecularDisplayGroups';
import { molecularSceneSelections } from './molecularSceneSelections';
import { molViewSpecColorGroups } from './molViewSpecLegend';
import type { MolecularProfileNode } from './nucleotidePresentationSettings';
import { constructMolecularBindingRegions } from './molecularSurfaceOwnership';
import { molecularAtomSelector } from './molecularConnections';

const nodes = (n: MolecularProfileNode): MolecularProfileNode[] => [
  n,
  ...(n.children ?? []).flatMap(nodes),
];

async function fixture(featureColor: string, explicitFocus = true) {
  const parsed = await parsePDB(
    [
      'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00 20.00           N  ',
      'ATOM      2  CA  ALA A   1       1.000   0.000   0.000  1.00 20.00           C  ',
      'ATOM      3  C   ALA A   1       2.000   0.000   0.000  1.00 20.00           C  ',
      'ATOM      4  O   ALA A   1       3.000   0.000   0.000  1.00 20.00           O  ',
      'ATOM      5  CA  ALA A   2       4.000   0.000   0.000  1.00 20.00           C  ',
      'END',
      '',
    ].join('\n')
  ).run();
  if (parsed.isError) throw Error(parsed.message);
  const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
  const selections = molecularSceneSelections(source);
  const b = MVSData.createBuilder();
  const structure = b.download({ url: 'structure.pdb' }).parse({ format: 'pdb' }).modelStructure();
  const seed = { auth_asym_id: 'A', auth_seq_id: 1 };
  if (explicitFocus)
    structure.component({ selector: seed, custom: { dnaforge_presentation_role: 'focus' } });
  structure
    .component({ selector: 'all' })
    .representation({ type: 'cartoon' })
    .color({
      color: '#df4c9b',
      custom: { dnaforge_legend_label: 'Protein domain', dnaforge_molecular_identity: 'domain' },
    });
  const component = structure.component({
    selector: 'all',
    custom: {
      dnaforge_interaction_context: 'native-interaction-context-v1',
      dnaforge_presentation_role: 'binding-site',
      dnaforge_binding_region: {
        seed,
        target: seed,
        partner: { auth_asym_id: 'A', auth_seq_id: 2 },
        detail: 'all',
        detailMode: 'neighborhood',
      },
    },
  });
  const representation = component.representation({ type: 'ball_and_stick' });
  representation.color({
    color: '#df4c9b',
    custom: { dnaforge_legend_label: 'Protein domain', dnaforge_molecular_identity: 'domain' },
  });
  representation.color({
    color: featureColor,
    selector: seed,
    custom: {
      dnaforge_legend_label: 'Named question feature',
      dnaforge_molecular_identity: 'domain',
      molstar_color_theme_name: 'element-symbol',
      molstar_color_theme_params: {
        carbonColor: { name: 'uniform', params: { value: parseInt(featureColor.slice(1), 16) } },
        saturation: 0,
        lightness: 0,
        colors: { name: 'default', params: {} },
      },
    },
  });
  const document = b.getState();
  if (document.kind === 'multiple') throw Error('Single fixture');
  const region = nodes(document.root).find((n) => n.custom?.dnaforge_binding_region);
  if (region) region.ref = 'native-binding-region';
  return { document, selections, source };
}

function nativeProteinProjection(f: Awaited<ReturnType<typeof fixture>>) {
  if (f.document.kind === 'multiple') throw Error('Single fixture');
  const selected = StructureSelection.unionStructure(
    Script.getStructureSelection(StructureSelectionQueries.sidechainWithTrace.expression, f.source)
  );
  const selector = molecularAtomSelector(selected, f.source);
  const region = nodes(f.document.root).find((n) => n.custom?.dnaforge_binding_region)!;
  region.params = { ...region.params, selector };
  region.custom!.dnaforge_binding_region = {
    ...(region.custom!.dnaforge_binding_region as Record<string, unknown>),
    detail: selector,
  };
  const semantic = nodes(f.document.root).find(
    (n) => n.custom?.dnaforge_presentation_role === 'focus'
  )!;
  const relation = f.selections.selectionRelation(
    selector,
    semantic.params!.selector,
    semantic.params!.selector,
    'all'
  );
  expect(relation.leftAtomCount).toBeGreaterThan(0);
  expect(relation.leftAtomCount).toBeLessThan(relation.rightAtomCount);
  return constructMolecularBindingRegions(f.document, () => f.source);
}

describe('named physical focus uses the existing semantic color machinery', () => {
  it('enforces declared whole-residue contrast after the native protein projection', async () => {
    const f = await fixture('#df4c9b');
    const projected = nativeProteinProjection(f);
    expect(() =>
      resolveMolecularDisplayGroups(projected, f.selections.describe, () => f.selections)
    ).toThrow(/named focus.*carbon hue.*broader/i);
  });
  it('retains the declared focus tint and role after native protein projection', async () => {
    const f = await fixture('#202020');
    const projected = nativeProteinProjection(f);
    const compiled = resolveMolecularDisplayGroups(
      projected,
      f.selections.describe,
      () => f.selections
    );
    expect(
      molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0).find(
        (g) => g.label === 'Named question feature'
      )
    ).toMatchObject({ color: 0x202020, presentationRole: 'focus' });
  });
  it('does not assign a narrow declared focus role to paint covering the broader source', async () => {
    const f = await fixture('#202020');
    if (f.document.kind === 'multiple') throw Error('Single fixture');
    const feature = nodes(f.document.root).find(
      (n) => n.custom?.dnaforge_legend_label === 'Named question feature'
    )!;
    feature.params = { ...feature.params, selector: 'all' };
    const compiled = resolveMolecularDisplayGroups(
      f.document,
      f.selections.describe,
      () => f.selections
    );
    expect(
      molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0).every((g) => !g.presentationRole)
    ).toBe(true);
  });
  it('preserves representation-free focus intent through binding ownership compilation before enforcing contrast', async () => {
    const f = await fixture('#df4c9b');
    const owned = constructMolecularBindingRegions(f.document, () => f.source);
    expect(() =>
      resolveMolecularDisplayGroups(owned, f.selections.describe, () => f.selections)
    ).toThrow(/named focus.*carbon hue.*broader/i);
  });
  it('rejects the same rendered carbon hue on an explicitly named focus and its broader context', async () => {
    const f = await fixture('#df4c9b');
    expect(() =>
      resolveMolecularDisplayGroups(f.document, f.selections.describe, () => f.selections)
    ).toThrow(/named focus.*carbon hue.*broader/i);
  });
  it('retains a chosen focus tint separately from broad identity while preserving element colors and geometry', async () => {
    const f = await fixture('#202020');
    const compiled = resolveMolecularDisplayGroups(
      f.document,
      f.selections.describe,
      () => f.selections
    );
    const groups = molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0);
    const feature = groups.find((g) => g.label === 'Named question feature');
    expect(feature).toMatchObject({ color: 0x202020, presentationRole: 'focus' });
    expect(groups.find((g) => g.label === 'Protein domain')?.color).toBe(0xdf4c9b);
    if (compiled.kind === 'multiple' || f.document.kind === 'multiple')
      throw Error('Single fixture');
    expect(
      nodes(compiled.root)
        .filter((n) => ['component', 'representation'].includes(n.kind))
        .map((n) => [n.kind, n.params])
    ).toEqual(
      nodes(f.document.root)
        .filter((n) => ['component', 'representation'].includes(n.kind))
        .map((n) => [n.kind, n.params])
    );
    const color = nodes(compiled.root).find(
      (n) => n.custom?.dnaforge_legend_label === 'Named question feature'
    );
    expect(color?.custom?.molstar_color_theme_params).toMatchObject({
      carbonColor: { params: { value: 0x202020 } },
      colors: { name: 'default' },
      saturation: 0,
      lightness: 0,
    });
  });
  it('keeps ordinary molecular identity color continuity when no named focus is declared', async () => {
    const f = await fixture('#202020', false);
    const compiled = resolveMolecularDisplayGroups(
      f.document,
      f.selections.describe,
      () => f.selections
    );
    expect(
      molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0).every((g) => g.color === 0xdf4c9b)
    ).toBe(true);
  });
  it('accepts arbitrary named contact seeds without inferring deliberate emphasis', async () => {
    const f = await fixture('#df4c9b', false);
    const compiled = resolveMolecularDisplayGroups(
      f.document,
      f.selections.describe,
      () => f.selections
    );
    expect(
      molViewSpecColorGroups(MVSData.toMVSJ(compiled), 0).every((g) => !g.presentationRole)
    ).toBe(true);
  });
  it('does not demand a carbon contrast for a physical feature containing no carbon', async () => {
    const f = await fixture('#df4c9b');
    if (f.document.kind === 'multiple') throw Error('Single fixture');
    const exact = { auth_asym_id: 'A', auth_seq_id: 1, label_atom_id: 'N' };
    for (const node of nodes(f.document.root)) {
      if (
        node.custom?.dnaforge_presentation_role === 'focus' ||
        node.custom?.dnaforge_legend_label === 'Named question feature'
      )
        node.params = { ...node.params, selector: exact };
    }
    expect(f.selections.selectionRelation(exact, 'all', 'all', 'all').leftCarbonCount).toBe(0);
    expect(() =>
      resolveMolecularDisplayGroups(f.document, f.selections.describe, () => f.selections)
    ).not.toThrow();
  });
  it('does not infer a constant carbon hue from a dynamic native element theme', async () => {
    const f = await fixture('#df4c9b');
    if (f.document.kind === 'multiple') throw Error('Single fixture');
    const feature = nodes(f.document.root).find(
      (n) => n.custom?.dnaforge_legend_label === 'Named question feature'
    )!;
    feature.custom!.molstar_color_theme_params = {
      carbonColor: { name: 'element-symbol', params: {} },
    };
    expect(() =>
      resolveMolecularDisplayGroups(f.document, f.selections.describe, () => f.selections)
    ).not.toThrow();
  });
});
