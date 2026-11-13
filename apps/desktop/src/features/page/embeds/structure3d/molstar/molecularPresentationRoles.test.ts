import { beforeEach, describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import {
  DEFAULT_MOLECULAR_RENDER_PROFILE,
  currentMolecularRenderProfile,
  resolveMolViewSpecRenderProfile,
} from './molecularRenderProfile';
import {
  DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES,
  useMolecularPresentationPreferences,
} from './molecularPresentationPreferences';
import { resolveMolecularDisplayGroups } from './molecularDisplayGroups';

function scene(role?: string) {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure()
    .component({ selector: [{ label_asym_id: 'A' }, { label_comp_id: 'NAG' }] })
    .representation({ type: 'cartoon' })
    .color({ color: '#247ab5' });
  const document = builder.getState();
  const component = document.root.children![0].children![0].children![0].children![0] as Node;
  if (role) component.custom = { dnaforge_presentation_role: role };
  return { document, component };
}
function component(document: ReturnType<typeof scene>['document']): Node {
  return document.root.children![0].children![0].children![0].children![0] as Node;
}
function resolve(input: ReturnType<typeof scene>['document']) {
  const result = resolveMolViewSpecRenderProfile(input);
  if (result.kind === 'multiple') throw Error('Expected one scene');
  return result;
}

describe('declared scientific regions', () => {
  beforeEach(() =>
    useMolecularPresentationPreferences
      .getState()
      .update(DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES)
  );

  it('supplies omitted local atomic detail for a binding-site region without changing its selector', () => {
    const input = scene('binding-site');
    const resolved = resolve(input.document);
    const region = component(resolved);
    expect(
      region.children?.some(
        (n) => n.kind === 'representation' && n.params?.type === 'ball_and_stick'
      )
    ).toBe(true);
    expect(region.params?.selector).toEqual(input.component.params?.selector);
    expect(input.component.children).toHaveLength(1);
  });

  it('preserves distinct state labels while an explicit shared biological identity owns their hue', () => {
    const first = scene();
    const second = scene();
    const colorA = first.component.children![0].children![0] as Node;
    colorA.custom = {
      dnaforge_legend_label: 'Starting state',
      dnaforge_molecular_identity: '  corresponding   domain  ',
    };
    const colorB = second.component.children![0].children![0] as Node;
    colorB.params!.color = '#bb4422';
    colorB.custom = {
      dnaforge_legend_label: 'Rearranged state',
      dnaforge_molecular_identity: 'corresponding domain',
    };
    const story = {
      kind: 'multiple' as const,
      metadata: first.document.metadata,
      snapshots: [
        { root: first.document.root, metadata: { title: 'Start' } },
        { root: second.document.root, metadata: { title: 'Rearranged' } },
      ],
    };
    const resolved = resolveMolecularDisplayGroups(resolveMolViewSpecRenderProfile(story));
    if (resolved.kind !== 'multiple') throw Error();
    const colors = resolved.snapshots.map(
      (s) =>
        s.root.children![0].children![0].children![0].children![0].children![0].children![0] as Node
    );
    expect(colors.map((n) => n.custom?.dnaforge_molecular_identity)).toEqual([
      'corresponding domain',
      'corresponding domain',
    ]);
    expect(colors.map((n) => n.custom?.dnaforge_legend_label)).toEqual([
      'Starting state',
      'Rearranged state',
    ]);
    expect(colors.map((n) => n.params?.color)).toEqual(['#247ab5', '#247ab5']);
  });

  it.each(['', ' '.repeat(3), 17, 'x'.repeat(81)])(
    'rejects invalid explicit molecular identities: %j',
    (identity) => {
      const input = scene();
      (input.component.children![0].children![0] as Node).custom = {
        dnaforge_molecular_identity: identity,
      };
      expect(() => resolve(input.document)).toThrow(/molecular identity/);
    }
  );

  it('rejects identity on a component rather than silently assigning all of its paint layers one identity', () => {
    const input = scene();
    input.component.custom = { dnaforge_molecular_identity: 'Shared object' };
    expect(() => resolve(input.document)).toThrow(/scientific color layer/);
  });

  it('rejects an interface without an explicit surface side instead of surfacing the mixed environment', () => {
    expect(() => resolve(scene('interface').document)).toThrow(/surface.*side|surface.*owner/i);
  });

  it('does not retain a mixed-surface authoring path under an older profile', () => {
    const input = scene('interface');
    const profile = { ...currentMolecularRenderProfile(), version: 5 };
    delete profile.surfaceOwnership;
    expect(() => resolveMolViewSpecRenderProfile(input.document, profile)).toThrow(
      /surface.*side|surface.*owner/i
    );
  });

  it('leaves explicit surface appearance to the single construction path', () => {
    const input = scene('interface');
    input.component.children = [
      {
        kind: 'representation',
        params: { type: 'surface' },
        children: [{ kind: 'opacity', params: { opacity: 1 } }],
      },
    ];
    input.document.root.custom = {
      dnaforge_presentation_override: {
        reason: 'Measure the excluded-volume contour in this isolated view.',
        fields: ['interfaceSurface'],
      },
    };
    expect(
      component(resolve(input.document)).children?.[0].children?.find((n) => n.kind === 'opacity')
        ?.params?.opacity
    ).toBe(1);
  });

  it('records validated intent without generating a second independently scoped surface', () => {
    const input = scene('interface');
    Object.assign(input.component, { ref: 'region' });
    input.component.custom!.dnaforge_binding_region = {
      target: { label_comp_id: 'NAG' },
      partner: { label_asym_id: 'A' },
      surfaceSide: 'partner',
    };
    const resolved = resolve(input.document);
    const parent = resolved.root.children![0].children![0].children![0];
    expect(parent.children!.some((n) => n.custom?.dnaforge_surface_owner)).toBe(false);
    expect(component(resolved).children?.some((n) => n.params?.type === 'surface')).toBe(false);
    expect(component(resolved).params?.selector).toEqual(input.component.params?.selector);
    expect(resolve(resolved)).toEqual(resolved);
  });

  it('leaves unannotated overview and historical profiles free of new detail', () => {
    const overview = scene();
    expect(component(resolve(overview.document)).children).toHaveLength(1);
    const historical = scene('interface');
    const resolved = resolveMolViewSpecRenderProfile(
      historical.document,
      DEFAULT_MOLECULAR_RENDER_PROFILE
    );
    if (resolved.kind === 'multiple') throw Error('Expected one scene');
    expect(component(resolved).children).toEqual(historical.component.children);
  });

  it('rejects misspelled roles rather than silently skipping the preference', () => {
    expect(() => resolve(scene('interfase').document)).toThrow(/presentation role/i);
  });

  it('honors disabled preferences without losing the scientific role', () => {
    useMolecularPresentationPreferences
      .getState()
      .update({ bindingSiteDetail: 'authored', interfaceSurface: 'authored' });
    const input = scene('interface');
    const region = component(resolve(input.document));
    expect(region.children).toHaveLength(1);
    expect(region.custom?.dnaforge_presentation_role).toBe('interface');
  });
});
