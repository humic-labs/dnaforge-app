/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { MVSData, type MVSData_State } from 'molstar/lib/extensions/mvs/mvs-data';
import { colorThemeForNode, representationProps } from 'molstar/lib/extensions/mvs/load-helpers';
import {
  DEFAULT_MOLECULAR_RENDER_PROFILE,
  currentMolecularRenderProfile,
  getMolViewSpecRenderProfile,
  resolveMolViewSpecRenderProfile as resolveProfile,
  setMolViewSpecRenderProfile,
} from './molecularRenderProfile';

const resolveMolViewSpecRenderProfile: typeof resolveProfile = (
  document,
  selection = DEFAULT_MOLECULAR_RENDER_PROFILE
) => resolveProfile(document, selection);

function scene(): MVSData_State {
  const builder = MVSData.createBuilder();
  const structure = builder
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure();
  structure.component({ selector: 'ligand' }).representation({ type: 'ball_and_stick' });
  structure.component({ selector: 'ion' }).representation({ type: 'spacefill' });
  structure.component({ selector: 'protein' }).representation({ type: 'cartoon' });
  structure
    .component({ selector: { label_asym_id: 'A', beg_label_seq_id: 15, end_label_seq_id: 20 } })
    .representation({ type: 'surface' })
    .opacity({ opacity: 0.35 });
  builder.camera({ target: [1, 2, 3], position: [1, 2, 30], up: [0, 1, 0] });
  return builder.getState();
}

function representations(document: MVSData_State) {
  const structure = document.root.children![0].children![0].children![0];
  return structure
    .children!.flatMap((component) => component.children ?? [])
    .filter((node) => node.kind === 'representation');
}

describe('overridable molecular render profiles', () => {
  it('resolves native atom sizing and element colors before saving standard MVS', () => {
    const original = scene();
    const resolved = resolveMolViewSpecRenderProfile(original);
    if (resolved.kind === 'multiple') throw new Error('Expected one scene.');
    const [atoms, ions, cartoon, surface] = representations(resolved);
    const props = representationProps(atoms);

    expect(props.type?.params).toMatchObject({ sizeFactor: 0.5, sizeAspectRatio: 0.5 });
    expect(props.sizeTheme).toEqual({ name: 'uniform', params: { value: 0.55 } });
    expect(atoms.children).toEqual([
      {
        kind: 'color',
        params: { color: '#909090' },
        custom: {
          molstar_color_theme_name: 'element-symbol',
          molstar_color_theme_params: {
            carbonColor: { name: 'uniform', params: { value: 0x909090 } },
            saturation: 0,
            lightness: 0,
            colors: { name: 'default', params: {} },
          },
        },
      },
    ]);
    expect(ions.children?.[0].custom?.molstar_color_theme_name).toBe('element-symbol');
    expect(cartoon).toEqual(representations(original)[2]);
    expect(surface).toEqual(representations(original)[3]);
    expect(resolved.root.custom?.dnaforge_render_profile).toEqual(DEFAULT_MOLECULAR_RENDER_PROFILE);
    expect(resolved.root.children?.[resolved.root.children.length - 1]).toEqual(
      original.root.children?.[original.root.children.length - 1]
    );
    expect(MVSData.validationIssues(resolved, { noExtra: true })).toBeUndefined();
    expect(representations(original)[0].children).toBeUndefined();
  });

  it('lets explicit sizing, colors, opacity, and native representation options win', () => {
    const original = scene();
    const atoms = representations(original)[0];
    if (atoms.params.type !== 'ball_and_stick') throw new Error('Expected atoms.');
    atoms.params.size_factor = 0.9;
    atoms.custom = {
      dnaforge_legend_label: 'Contact atoms',
      molstar_representation_params: {
        sizeFactor: 0.35,
        sizeAspectRatio: 0.75,
        multipleBonds: 'symmetric',
      },
    };
    atoms.children = [
      {
        kind: 'color',
        params: { color: '#cc8844' },
        custom: { dnaforge_legend_label: 'Deliberate uniform exception' },
      },
      { kind: 'opacity', params: { opacity: 0.45 } },
    ];
    const before = structuredClone(atoms);
    const resolved = resolveMolViewSpecRenderProfile(original);
    if (resolved.kind === 'multiple') throw new Error('Expected one scene.');

    expect(representations(resolved)[0]).toEqual(before);
    expect(representationProps(representations(resolved)[0]).type?.params).toMatchObject({
      sizeFactor: 0.35,
      sizeAspectRatio: 0.75,
      alpha: 0.45,
      multipleBonds: 'symmetric',
    });
  });

  it('uses the native element palette with an optional carbon group tint', () => {
    const original = scene();
    representations(original)[0].custom = { dnaforge_carbon_color: '#34aabb' };
    const resolved = resolveMolViewSpecRenderProfile(original);
    if (resolved.kind === 'multiple') throw new Error('Expected one scene.');
    const atoms = representations(resolved)[0];
    const theme = colorThemeForNode(atoms, {} as Parameters<typeof colorThemeForNode>[1]);

    expect(theme).toEqual({
      name: 'element-symbol',
      params: {
        carbonColor: { name: 'uniform', params: { value: 0x34aabb } },
        saturation: 0,
        lightness: 0,
        colors: { name: 'default', params: {} },
      },
    });
  });

  it('supports unchanged native scenes and a representation-level opt-out', () => {
    const original = scene();
    expect(resolveMolViewSpecRenderProfile(original, 'native')).toEqual(original);
    representations(original)[0].custom = { dnaforge_render_profile: 'native' };
    const before = structuredClone(representations(original)[0]);
    const resolved = resolveMolViewSpecRenderProfile(original);
    if (resolved.kind === 'multiple') throw new Error('Expected one scene.');
    expect(representations(resolved)[0]).toEqual(before);
    expect(representations(resolved)[1].children?.[0].kind).toBe('color');
  });

  it('keeps worker profile configuration isolated and snapshots mutable caller settings', () => {
    const firstPlugin = {};
    const secondPlugin = {};
    const customProfile = structuredClone(DEFAULT_MOLECULAR_RENDER_PROFILE);
    setMolViewSpecRenderProfile(firstPlugin, 'native');
    setMolViewSpecRenderProfile(secondPlugin, customProfile);
    customProfile.ballAndStick.sizeFactor = 1.5;
    expect(getMolViewSpecRenderProfile(firstPlugin)).toBe('native');
    expect(getMolViewSpecRenderProfile(secondPlugin)).toEqual(DEFAULT_MOLECULAR_RENDER_PROFILE);
    expect(getMolViewSpecRenderProfile({})).toBe('default');
    const read = getMolViewSpecRenderProfile(secondPlugin);
    if (typeof read === 'string') throw new Error('Expected a profile snapshot.');
    read.atomicColors.carbonColor = '#ff0000';
    expect(getMolViewSpecRenderProfile(secondPlugin)).toEqual(DEFAULT_MOLECULAR_RENDER_PROFILE);
  });

  it('pins the profile and all resolved settings across future default changes', () => {
    const first = resolveMolViewSpecRenderProfile(scene());
    const futureProfile = {
      ...DEFAULT_MOLECULAR_RENDER_PROFILE,
      version: 2,
      ballAndStick: { sizeFactor: 1.5, atomScale: 0.8, bondToAtomRatio: 0.8 },
      atomicColors: { ...DEFAULT_MOLECULAR_RENDER_PROFILE.atomicColors, carbonColor: '#ff0000' },
    };
    const roundTrip = MVSData.fromMVSJ(MVSData.toMVSJ(first));
    expect(resolveMolViewSpecRenderProfile(roundTrip, futureProfile)).toEqual(first);
  });

  it('resolves each story step without changing selections, cameras, or transitions', () => {
    const first = scene();
    const second = scene();
    representations(second)[0].custom = { dnaforge_carbon_color: '#aa3377' };
    const story = MVSData.createMultistate([
      {
        root: first.root,
        metadata: { title: 'Overview', linger_duration_ms: 1000, transition_duration_ms: 250 },
      },
      { root: second.root, metadata: { title: 'Contact', linger_duration_ms: 1500 } },
    ]);
    const resolved = resolveMolViewSpecRenderProfile(story);
    if (resolved.kind !== 'multiple') throw new Error('Expected a story.');
    expect(resolved.snapshots.map((snapshot) => snapshot.metadata)).toEqual(
      story.snapshots.map((snapshot) => snapshot.metadata)
    );
    expect(
      resolved.snapshots.map((snapshot) => snapshot.root.custom?.dnaforge_render_profile)
    ).toEqual([DEFAULT_MOLECULAR_RENDER_PROFILE, DEFAULT_MOLECULAR_RENDER_PROFILE]);
    expect(MVSData.validationIssues(resolved, { noExtra: true })).toBeUndefined();
  });

  it('rejects malformed profile or carbon configuration instead of silently ignoring it', () => {
    const invalidProfile = scene();
    invalidProfile.root.custom = { dnaforge_render_profile: { id: 'broken', version: 1 } };
    expect(() => resolveMolViewSpecRenderProfile(invalidProfile)).toThrow(/render profile/i);
    const invalidCarbon = scene();
    representations(invalidCarbon)[0].custom = { dnaforge_carbon_color: 'definitely-not-a-color' };
    expect(() => resolveMolViewSpecRenderProfile(invalidCarbon)).toThrow(/carbon color/i);
  });

  it('does not choose molecular regions, nucleotide detail, surfaces, labels, or transparency', () => {
    const original = scene();
    const resolved = resolveMolViewSpecRenderProfile(original);
    if (resolved.kind === 'multiple') throw new Error('Expected one scene.');
    const [, , cartoon, surface] = representations(resolved);
    expect(cartoon.custom?.molstar_representation_params).toBeUndefined();
    expect(surface).toEqual(representations(original)[3]);
    expect(resolved.root.children?.map((node) => node.kind)).toEqual(
      original.root.children?.map((node) => node.kind)
    );
  });

  it('keeps a v1 snapshot byte-for-byte unchanged and records v2 atomic opacity', () => {
    const legacy = scene();
    const legacyProfile = {
      id: 'dnaforge-detail',
      version: 1,
      ballAndStick: { sizeFactor: 0.6, atomScale: 0.5, bondToAtomRatio: 0.5 },
      atomicColors: { carbonColor: '#909090', saturation: 0, lightness: 0 },
    };
    const first = resolveMolViewSpecRenderProfile(legacy, legacyProfile);
    expect(resolveMolViewSpecRenderProfile(first)).toEqual(first);
    const current = resolveMolViewSpecRenderProfile(scene());
    if (current.kind === 'multiple') throw new Error('Expected one scene.');
    expect(current.root.custom?.dnaforge_render_profile).toMatchObject({
      version: 2,
      atomicOpacity: 1,
    });
    expect(representationProps(representations(current)[0]).type?.params.alpha).toBe(1);
  });

  it('resolves explicit nucleotide detail to independent planes and exclusive connectors', () => {
    const original = scene();
    const component = original.root.children![0].children![0].children![0].children![0];
    component.params.selector = { label_asym_id: 'R', label_seq_id: 12 };
    const atoms = representations(original)[0];
    atoms.custom = {
      dnaforge_carbon_color: '#33aabb',
      dnaforge_nucleotide_presentation: { connectorMode: 'simplified' },
    };
    const resolved = resolveMolViewSpecRenderProfile(original);
    if (resolved.kind === 'multiple') throw new Error('Expected one scene.');
    const [detail, plane, connector] =
      resolved.root.children![0].children![0].children![0].children![0].children!;
    expect(detail.custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideAtomicMode: 'base-only',
      includeParent: false,
    });
    expect(representationProps(plane).type?.params).toMatchObject({
      visuals: ['dnaforge-nucleotide-base-plane'],
      alpha: 0.35,
    });
    expect(plane.children?.find((child) => child.kind === 'color')?.params).toEqual({
      color: '#33aabb',
    });
    expect(representationProps(connector).type?.params).toMatchObject({
      visuals: ['dnaforge-nucleotide-connector'],
      alpha: 1,
    });
    const context = representations(resolved).find((node) => node === representations(resolved)[4]);
    expect(context?.custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideExclude: [{ label_asym_id: 'R', label_seq_id: 12 }],
    });
    expect(resolveMolViewSpecRenderProfile(resolved)).toEqual(resolved);
    expect(MVSData.validationIssues(resolved, { noExtra: true })).toBeUndefined();

    atoms.custom.dnaforge_nucleotide_presentation = { connectorMode: 'atomic', baseOpacity: 0.22 };
    const atomic = resolveMolViewSpecRenderProfile(original);
    if (atomic.kind === 'multiple') throw new Error('Expected one scene.');
    const atomicChildren =
      atomic.root.children![0].children![0].children![0].children![0].children!;
    expect(atomicChildren).toHaveLength(2);
    expect(atomicChildren[0].custom?.molstar_representation_params).toMatchObject({
      dnaforgeNucleotideAtomicMode: 'full',
    });
    expect(representationProps(atomicChildren[1]).type?.params).toMatchObject({
      visuals: ['dnaforge-nucleotide-base-plane'],
      alpha: 0.22,
    });
  });
  it('keeps generated nucleotide colors linked through later selective group edits', () => {
    const input = scene();
    const component = input.root.children![0].children![0].children![0].children![0];
    component.params.selector = 'nucleic';
    const atoms = representations(input)[0];
    atoms.custom = { dnaforge_nucleotide_presentation: {} };
    const first = resolveProfile(input, currentMolecularRenderProfile());
    if (first.kind === 'multiple') throw Error('Expected one scene');
    const detail = representations(first)[0];
    detail.children!.push({
      kind: 'color',
      params: { color: '#29b6c7', selector: { label_asym_id: 'C' } },
      custom: {
        molstar_color_theme_name: 'element-symbol',
        molstar_color_theme_params: {
          carbonColor: { name: 'uniform', params: { value: 0x29b6c7 } },
        },
      },
    });
    const second = resolveProfile(first, currentMolecularRenderProfile());
    if (second.kind === 'multiple') throw Error('Expected one scene');
    const parts = representations(second).filter((r) => r.custom?.dnaforge_nucleotide_generated);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.children!.filter((c) => c.kind === 'color').map((c) => c.params)).toEqual([
        { color: '#909090' },
        { color: '#29b6c7', selector: { label_asym_id: 'C' } },
      ]);
    }
    expect(resolveProfile(second, currentMolecularRenderProfile())).toEqual(second);
  });
  it('retains an authored independent plane hue while linking connector hues to atoms', () => {
    const input = scene();
    const component = input.root.children![0].children![0].children![0].children![0];
    component.params.selector = 'nucleic';
    const atoms = representations(input)[0];
    atoms.custom = {
      dnaforge_carbon_color: '#25b5ad',
      dnaforge_nucleotide_presentation: { baseColor: '#edb33a' },
    };
    const first = resolveProfile(input, currentMolecularRenderProfile());
    if (first.kind === 'multiple') throw Error('Expected one scene');
    const parts = representations(first).filter((r) => r.custom?.dnaforge_nucleotide_generated);
    expect(parts[0].children![0].params?.color).toBe('#edb33a');
    expect(parts[1].children![0].params?.color).toBe('#25b5ad');
    expect(resolveProfile(first, currentMolecularRenderProfile())).toEqual(first);
  });

  it('refreshes linked colors even when nucleotide detail mode has an explicit exception', () => {
    const input = scene();
    const component = input.root.children![0].children![0].children![0].children![0];
    component.params.selector = 'nucleic';
    const atoms = representations(input)[0];
    atoms.custom = { dnaforge_nucleotide_presentation: { connectorMode: 'atomic' } };
    input.root.custom = {
      dnaforge_presentation_override: {
        reason: 'Inspect the full deposited nucleotide chemistry.',
        fields: ['nucleotideDetail'],
      },
    };
    const first = resolveProfile(input, currentMolecularRenderProfile());
    if (first.kind === 'multiple') throw Error('Expected one scene');
    const detail = representations(first)[0];
    detail.children = [{ kind: 'color', params: { color: '#25b5ad' } }];
    const second = resolveProfile(first, currentMolecularRenderProfile());
    if (second.kind === 'multiple') throw Error('Expected one scene');
    const parts = representations(second).filter((r) => r.custom?.dnaforge_nucleotide_generated);
    expect(parts).toHaveLength(1);
    expect(parts[0].children![0].params?.color).toBe('#25b5ad');
  });
  it('lets a normal baseColor edit add and remove an independent plane override', () => {
    const input = scene();
    const component = input.root.children![0].children![0].children![0].children![0];
    component.params.selector = 'nucleic';
    representations(input)[0].custom = {
      dnaforge_carbon_color: '#25b5ad',
      dnaforge_nucleotide_presentation: {},
    };
    const first = resolveProfile(input, currentMolecularRenderProfile());
    if (first.kind === 'multiple') throw Error('Expected one scene');
    const settings = representations(first)[0].custom!.dnaforge_nucleotide_presentation as {
      baseColor?: string;
    };
    settings.baseColor = '#edb33a';
    const second = resolveProfile(first, currentMolecularRenderProfile());
    if (second.kind === 'multiple') throw Error('Expected one scene');
    expect(
      representations(second).find((r) => r.custom?.dnaforge_nucleotide_generated)!.children![0]
        .params?.color
    ).toBe('#edb33a');
    delete (
      representations(second)[0].custom!.dnaforge_nucleotide_presentation as { baseColor?: string }
    ).baseColor;
    const third = resolveProfile(second, currentMolecularRenderProfile());
    if (third.kind === 'multiple') throw Error('Expected one scene');
    expect(
      representations(third).find((r) => r.custom?.dnaforge_nucleotide_generated)!.children![0]
        .params?.color
    ).toBe('#25b5ad');
  });
});
