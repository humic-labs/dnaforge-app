import { describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import {
  requireMolecularDisplayGroups,
  resolveMolecularDisplayGroups,
} from './molecularDisplayGroups';
import {
  bindMolViewSpecRepresentations,
  isMolViewSpecAppearanceUpdate,
  updateMolViewSpecAppearance,
} from './molViewSpecAppearance';

function scene() {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure()
    .component({ selector: 'all' })
    .representation({ type: 'ball_and_stick' })
    .color({ color: '#888888' });
  builder.camera({ position: [0, 0, 60], target: [0, 0, 0], up: [0, 1, 0] });
  return builder.getState();
}

function representation(document: ReturnType<typeof scene>) {
  return document.root.children![0].children![0].children![0].children![0].children![0];
}

describe('incremental standard molecular scene appearance', () => {
  it('adds the save-required display contract to legacy data colors without changing geometry', () => {
    const previous = scene();
    const original = JSON.stringify(previous);
    const next = resolveMolecularDisplayGroups(structuredClone(previous));
    expect(() => requireMolecularDisplayGroups(previous)).toThrow(/display-group contract/i);
    expect(() => requireMolecularDisplayGroups(next)).not.toThrow();
    expect(isMolViewSpecAppearanceUpdate(previous, next)).toBe(true);
    expect(JSON.stringify(previous)).toBe(original);
    const changedProfile = structuredClone(next);
    changedProfile.root.custom = {
      ...changedProfile.root.custom,
      dnaforge_render_profile: { version: 12 },
    };
    expect(isMolViewSpecAppearanceUpdate(previous, changedProfile)).toBe(false);
    const changedIdentity = structuredClone(next);
    changedIdentity.root.children![0].children![0].children![0].ref = 'different-source';
    expect(isMolViewSpecAppearanceUpdate(previous, changedIdentity)).toBe(false);
  });

  it('restores the prior native appearance if a newer intent arrives while the update commits', async () => {
    const previous = scene(),
      next = scene();
    representation(next).children = [{ kind: 'color', params: { color: '#ff0000' } }];
    const refs = bindMolViewSpecRepresentations(previous).refs;
    const original = {
      colorTheme: { name: 'uniform', params: { value: 0x888888 } },
      type: { name: 'ball-and-stick', params: { alpha: 1 } },
    };
    const cell = {
      transform: { ref: 'native', tags: [`mvs-ref:${[...refs.values()][0]}`] },
      obj: new PluginStateObject.Molecule.Structure.Representation3D({
        repr: {} as never,
        sourceData: {} as never,
      }),
      params: { values: original },
      status: 'ok',
    };
    let current = true,
      commits = 0;
    const plugin = {
      state: { data: { cells: new Map([['native', cell]]) } },
      managers: { snapshot: { current: null } },
      build: () => {
        const pending: Array<() => void> = [];
        return {
          to: () => ({
            update: (
              _transform: unknown,
              operation: (params: typeof original) => typeof original
            ) =>
              pending.push(() => {
                cell.params.values = operation(cell.params.values);
              }),
          }),
          commit: async () => {
            pending.forEach((operation) => operation());
            if (++commits === 1) current = false;
          },
        };
      },
    };
    await expect(
      updateMolViewSpecAppearance(
        plugin as never,
        previous,
        next,
        refs,
        'https://fixture.invalid/',
        () => current
      )
    ).rejects.toThrow(/changed/i);
    expect(cell.params.values).toEqual(original);
    expect(commits).toBe(2);
  });
  it('binds native representations deterministically without changing the authored document', () => {
    const document = scene();
    const original = JSON.stringify(document);
    const first = bindMolViewSpecRepresentations(document);
    const second = bindMolViewSpecRepresentations(document);
    expect(first.refs.size).toBe(1);
    expect([...first.refs]).toEqual([...second.refs]);
    expect(JSON.stringify(document)).toBe(original);
    expect(MVSData.validationIssues(first.document)).toBeUndefined();
  });

  it('recognizes arbitrary molecular selector colors and opacity as local edits', () => {
    const previous = scene();
    const next = structuredClone(previous);
    representation(next).children = [
      { kind: 'color', params: { color: '#ff0000', selector: { label_asym_id: 'A' } } },
      { kind: 'color', params: { color: '#0000ff', selector: { atom_id: 420 } } },
      { kind: 'opacity', params: { opacity: 0.4 } },
    ];
    expect(isMolViewSpecAppearanceUpdate(previous, next)).toBe(true);
  });

  it('accepts changed native legend metadata with data colors without changing geometry', () => {
    const previous = scene();
    representation(previous).custom = {
      dnaforge_display_group: { id: 'protein', label: 'Protein', color: '#888888' },
    };
    const original = JSON.stringify(previous);
    const next = structuredClone(previous);
    representation(next).custom = {
      dnaforge_display_group: {
        id: 'protein',
        label: 'Protein',
        color: '#888888',
        residual: false,
      },
    };
    representation(next).children = [
      { kind: 'color', params: { color: '#ff0000', selector: { label_asym_id: 'A' } } },
    ];
    expect(isMolViewSpecAppearanceUpdate(previous, next)).toBe(true);
    expect(JSON.stringify(previous)).toBe(original);
  });

  it.each([
    'camera',
    'coordinates',
    'component',
    'representation',
    'native geometry',
    'visibility',
  ])('refuses a changed %s as a local appearance edit', (kind) => {
    const previous = scene();
    const next = structuredClone(previous);
    if (kind === 'camera')
      next.root.children![1].params = { position: [4, 5, 60], target: [0, 0, 0], up: [0, 1, 0] };
    if (kind === 'coordinates') next.root.children![0].params = { url: 'other.cif' };
    if (kind === 'component')
      next.root.children![0].children![0].children![0].children![0].params = {
        selector: 'protein',
      };
    if (kind === 'representation') representation(next).params = { type: 'spacefill' };
    representation(next).custom = {
      dnaforge_display_group: { id: 'protein', label: 'Protein', color: '#ff0000' },
      ...(kind === 'native geometry' ? { molstar_representation_params: { sizeFactor: 2 } } : {}),
      ...(kind === 'visibility' ? { is_hidden: true } : {}),
    };
    expect(isMolViewSpecAppearanceUpdate(previous, next)).toBe(false);
  });
});
