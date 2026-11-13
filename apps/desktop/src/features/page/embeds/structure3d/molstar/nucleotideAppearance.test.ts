import { describe, expect, it } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure';
import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { representationProps } from 'molstar/lib/extensions/mvs/load-helpers';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import {
  currentMolecularRenderProfile,
  resolveMolViewSpecRenderProfile,
} from './molecularRenderProfile';
import {
  resolveMolecularDisplayGroups,
  requireMolecularDisplayGroups,
} from './molecularDisplayGroups';
import { molecularSceneSelections } from './molecularSceneSelections';
import { resolveNucleotideAppearance } from './nucleotideAppearance';
import { molViewSpecColorGroups } from './molViewSpecLegend';
import { resolveMolViewSpecColorGroupLoci } from './molViewSpecSwatchSelection';

async function source() {
  let serial = 0;
  const lines = ['A', 'B'].flatMap((chain, c) =>
    ['P', "C1'", 'N1', 'C2', 'N3', 'C4', 'C5', 'C6'].map(
      (name, i) =>
        `ATOM  ${String(++serial).padStart(5)} ${name.padStart(4)}   C ${chain}   1    ${(i + c * 20).toFixed(3).padStart(8)}${'0.000'.padStart(8)}${'0.000'.padStart(8)}  1.00 20.00          ${name[0].padStart(2)}  `
    )
  );
  const parsed = await parsePDB([...lines, 'END'].join('\n')).run();
  if (parsed.isError) throw Error(parsed.message);
  return Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
}
function input() {
  const b = MVSData.createBuilder();
  const s = b.download({ url: 'structure.pdb' }).parse({ format: 'pdb' }).modelStructure();
  for (const [chain, alpha] of [
    ['A', 0.1],
    ['B', 1],
  ] as const)
    s.component({ selector: { auth_asym_id: chain } })
      .representation({ type: 'cartoon' })
      .color({ color: '#adb5bf' })
      .opacity({ opacity: alpha });
  const atoms = s.component({ selector: 'nucleic' }).representation({ type: 'ball_and_stick' });
  atoms.color({ color: '#25b5ad', selector: { auth_asym_id: 'A' } });
  atoms.color({ color: '#edb33a', selector: { auth_asym_id: 'B' } });
  return b.getState();
}
function structure(document: MVSData): Node {
  if (document.kind === 'multiple') throw Error('Expected single scene');
  return document.root.children![0].children![0].children![0] as Node;
}
function compile(document: MVSData, native: Structure) {
  const select = molecularSceneSelections(native);
  return resolveMolecularDisplayGroups(
    resolveMolViewSpecRenderProfile(
      document,
      currentMolecularRenderProfile(),
      select.hasNucleotides
    ),
    select.describe
  );
}

describe('source-qualified nucleotide appearance ownership', () => {
  it('keeps compiled backbone support out of the focal residue identity and its selection', async () => {
    const native = await source();
    const b = MVSData.createBuilder();
    const s = b.download({ url: 'structure.pdb' }).parse({ format: 'pdb' }).modelStructure();
    s.component({ selector: 'nucleic' })
      .representation({ type: 'cartoon' })
      .color({ color: '#adb5bf', custom: { dnaforge_legend_label: 'RNA context' } })
      .opacity({ opacity: 0.1 });
    s.component({ selector: { auth_asym_id: 'A' } })
      .representation({ type: 'ball_and_stick' })
      .color({ color: '#25b5ad', custom: { dnaforge_legend_label: 'Focal nucleotide' } });
    const profiled = compile(b.getState(), native);
    const component = structure(profiled).children!.find((c) =>
      c.children?.some((rep) => rep.params?.type === 'ball_and_stick')
    )!;
    const support = { auth_asym_id: 'B', label_atom_id: "C1'" };
    component.params!.selector = [{ auth_asym_id: 'A' }, support];
    component.custom = { ...component.custom, dnaforge_nucleotide_junction_atoms: [support] };
    const atom = component.children!.find((rep) => rep.params?.type === 'ball_and_stick')!;
    atom.custom!.molstar_representation_params = {
      ...(atom.custom!.molstar_representation_params as Record<string, unknown>),
      dnaforgeNucleotideAtomicMode: 'full',
    };
    const resolved = resolveNucleotideAppearance(profiled, () => native);
    const group = molViewSpecColorGroups(JSON.stringify(resolved), 0).find(
      (g) => g.label === 'Focal nucleotide'
    )!;
    const plugin = molstarPluginFixture({
      state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
      managers: {
        structure: {
          hierarchy: { current: { structures: [{ cell: { obj: { data: native } } }] } },
        },
      },
    });
    expect(StructureElement.Loci.size(resolveMolViewSpecColorGroupLoci(plugin, group))).toBe(8);
    const retained = structure(resolved).children!.find((c) =>
      c.children?.some((rep) => rep.params?.type === 'ball_and_stick')
    )!;
    expect(molecularSceneSelections(native).select(retained.params!.selector).elementCount).toBe(9);
  });

  it('uses one physical detail mode for a focused region, without promoting base contacts residue by residue', async () => {
    const native = await source();
    for (const endpoint of ['N1', 'P']) {
      const profiled = compile(input(), native);
      if (profiled.kind === 'multiple') throw Error('Expected single scene');
      (profiled.root.custom!.dnaforge_render_profile as { version: number }).version = 12;
      const before = structure(profiled).children!.find((component) =>
        component.children?.some((rep) => rep.params?.type === 'ball_and_stick')
      )!;
      const atom = before.children!.find((rep) => rep.params?.type === 'ball_and_stick')!;
      const keep = [{ auth_asym_id: 'A', auth_seq_id: 1, label_atom_id: endpoint }];
      atom.custom!.molstar_representation_params = {
        ...(atom.custom!.molstar_representation_params as Record<string, unknown>),
        dnaforgeNucleotideKeepAtoms: keep,
      };
      for (const part of before.children!)
        if (part.custom?.dnaforge_nucleotide_generated)
          (
            part.custom.molstar_representation_params as Record<string, unknown>
          ).dnaforgeNucleotideExclude = keep;
      const result = resolveNucleotideAppearance(profiled, () => native);
      const representations = structure(result).children!.flatMap(
        (component) => component.children ?? []
      );
      const atomic = representations.find((rep) => rep.params?.type === 'ball_and_stick')!;
      expect(atomic.custom?.molstar_representation_params).toMatchObject({
        dnaforgeNucleotideAtomicMode: endpoint === 'P' ? 'full' : 'base-only',
        dnaforgeNucleotideKeepAtoms: [],
        includeParent: false,
      });
      const connectors = representations.filter((rep) =>
        (
          rep.custom?.molstar_representation_params as { visuals?: string[] } | undefined
        )?.visuals?.includes('dnaforge-nucleotide-connector')
      );
      expect(connectors).toHaveLength(endpoint === 'P' ? 0 : 1);
      for (const connector of connectors)
        expect(connector.custom?.molstar_representation_params).toMatchObject({
          dnaforgeNucleotideExclude: [],
        });
    }
  });

  it('preserves the historical trace-owned opacity rule when explicitly replaying its profile', async () => {
    const native = await source();
    const before = compile(input(), native);
    if (before.kind === 'multiple') throw Error('Expected single scene');
    (
      before.root.custom!.dnaforge_render_profile as { nucleotideAppearance: string }
    ).nucleotideAppearance = 'linked-residue-v1';
    (before.root.custom!.dnaforge_render_profile as { version: number }).version = 11;
    const frozen = structuredClone(before);
    const result = resolveNucleotideAppearance(before, () => native);
    const s = structure(result);
    const cartoons = s.children!.slice(0, 2).map((c) => c.children![0]);
    expect(cartoons[0].children!.filter((c) => c.kind === 'color').at(-1)?.params?.color).toBe(
      '#25b5ad'
    );
    expect(cartoons[1].children!.filter((c) => c.kind === 'color').at(-1)?.params?.color).toBe(
      '#edb33a'
    );
    const parts = s
      .children!.flatMap((c) => c.children ?? [])
      .filter((r) => r.custom?.dnaforge_nucleotide_generated);
    expect(parts).toHaveLength(4);
    const groups = molViewSpecColorGroups(JSON.stringify(result), 0);
    expect(
      groups
        .filter((g) => [0x25b5ad, 0xedb33a].includes(g.color))
        .every(
          (g) =>
            g.targets.filter((target) => target.nucleotideAtomicMode === 'base-only').length === 1
        )
    ).toBe(true);
    const connectors = parts.filter((r) =>
      (r.custom?.molstar_representation_params as { visuals: string[] }).visuals.includes(
        'dnaforge-nucleotide-connector'
      )
    );
    expect(
      connectors.map((r) => representationProps(r as never).type!.params.alpha).sort()
    ).toEqual([0.1, 1]);
    expect(
      parts
        .filter((r) =>
          (r.custom?.molstar_representation_params as { visuals: string[] }).visuals.includes(
            'dnaforge-nucleotide-base-plane'
          )
        )
        .map((r) => representationProps(r as never).type!.params.alpha)
        .sort()
    ).toEqual([0.1, 0.35]);
    requireMolecularDisplayGroups(result);
    expect(MVSData.validationIssues(result, { noExtra: true })).toBeUndefined();
    expect(before).toEqual(frozen);
  });

  it('constructs a foreground backbone for detailed nucleotides without changing surrounding trace opacity', async () => {
    const native = await source();
    const b = MVSData.createBuilder();
    const s = b.download({ url: 'structure.pdb' }).parse({ format: 'pdb' }).modelStructure();
    s.component({ selector: 'nucleic' })
      .representation({ type: 'cartoon' })
      .color({ color: '#adb5bf', custom: { dnaforge_legend_label: 'RNA context' } })
      .opacity({ opacity: 0.1 });
    s.component({ selector: { auth_asym_id: 'A', auth_seq_id: 1 } })
      .representation({ type: 'ball_and_stick' })
      .color({ color: '#25b5ad', custom: { dnaforge_legend_label: 'Focal nucleotide' } });
    const result = resolveNucleotideAppearance(compile(b.getState(), native), () => native);
    const nodes = structure(result).children!;
    expect(representationProps(nodes[0].children![0] as never).type!.params.alpha).toBe(0.1);
    const foreground = nodes
      .flatMap((c) => c.children ?? [])
      .filter((r) => r.custom?.dnaforge_nucleotide_appearance_trace);
    expect(foreground).toHaveLength(1);
    expect(representationProps(foreground[0] as never).type!.params.alpha).toBe(1);
    const component = nodes.find((c) => c.children?.includes(foreground[0]))!;
    const selected = molecularSceneSelections(native).select(component.params!.selector);
    expect(selected.elementCount).toBe(
      molecularSceneSelections(native).select({ auth_asym_id: 'A' }).elementCount
    );
    const connectors = nodes
      .flatMap((c) => c.children ?? [])
      .filter((r) =>
        (
          r.custom?.molstar_representation_params as { visuals?: string[] } | undefined
        )?.visuals?.includes('dnaforge-nucleotide-connector')
      );
    expect(connectors.every((r) => representationProps(r as never).type!.params.alpha === 1)).toBe(
      true
    );
    expect(
      molViewSpecColorGroups(MVSData.toMVSJ(result), 0)
        .map((g) => g.label)
        .sort()
    ).toEqual(['Focal nucleotide', 'RNA context']);
    const context = nodes.find(
      (c) =>
        c.custom?.dnaforge_nucleotide_appearance_part &&
        c.children?.some(
          (r) =>
            !r.custom?.dnaforge_nucleotide_generated &&
            !r.custom?.dnaforge_nucleotide_appearance_trace
        )
    )!;
    expect(molecularSceneSelections(native).select(context.params!.selector).elementCount).toBe(
      molecularSceneSelections(native).select({ auth_asym_id: 'B' }).elementCount
    );
    expect(resolveNucleotideAppearance(compile(result, native), () => native)).toEqual(result);
    requireMolecularDisplayGroups(result);
    expect(MVSData.validationIssues(result, { noExtra: true })).toBeUndefined();
  });

  it('keeps unnamed atom detail inside its named molecular identity without promoting element paint', async () => {
    const native = await source();
    const b = MVSData.createBuilder();
    const s = b.download({ url: 'structure.pdb' }).parse({ format: 'pdb' }).modelStructure();
    s.component({ selector: { auth_asym_id: 'A' } })
      .representation({ type: 'cartoon' })
      .color({ color: '#a45a9e', custom: { dnaforge_legend_label: 'Message RNA' } })
      .opacity({ opacity: 0.1 });
    const atom = s
      .component({ selector: { auth_asym_id: 'A', auth_seq_id: 1 } })
      .representation({ type: 'ball_and_stick' });
    atom.color({ color: '#25b5ad', selector: { type_symbol: 'C' } });
    atom.color({ color: '#0000ff', selector: { type_symbol: 'N' } });
    const result = resolveNucleotideAppearance(compile(b.getState(), native), () => native);
    const groups = molViewSpecColorGroups(MVSData.toMVSJ(result), 0);
    expect(groups.map((g) => g.label)).toEqual(['Message RNA']);
    expect(groups[0].color).toBe(0xa45a9e);
    const atoms = structure(result)
      .children!.flatMap((c) => c.children ?? [])
      .find((r) => r.params?.type === 'ball_and_stick')!;
    expect(atoms.children!.filter((c) => c.kind === 'color').map((c) => c.params?.color)).toEqual([
      '#a45a9e',
      '#0000ff',
    ]);
    expect(resolveNucleotideAppearance(compile(result, native), () => native)).toEqual(result);
  });

  it('keeps historical profile scenes untouched', async () => {
    const native = await source();
    const doc = compile(input(), native);
    if (doc.kind === 'multiple') throw Error('Expected single scene');
    (
      doc.root.custom!.dnaforge_render_profile as { version: number; nucleotideAppearance?: string }
    ).version = 4;
    delete (doc.root.custom!.dnaforge_render_profile as { nucleotideAppearance?: string })
      .nucleotideAppearance;
    expect(resolveNucleotideAppearance(doc, () => native)).toEqual(doc);
  });

  it('fails before changing a scene when its coordinate owner is unavailable', async () => {
    const native = await source();
    expect(() => resolveNucleotideAppearance(compile(input(), native), () => undefined)).toThrow(
      /coordinate source/i
    );
  });
});
