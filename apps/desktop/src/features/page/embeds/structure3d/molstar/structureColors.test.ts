import { describe, expect, it, vi } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { act, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure';
import type { Unit } from 'molstar/lib/mol-model/structure';
import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import { Color } from 'molstar/lib/mol-util/color';
import { ColorTheme } from 'molstar/lib/mol-theme/color';
import {
  observeStructureColorChanges,
  resolveStructureColorProjection,
  resolveStructureColors,
  resolveStructureColorLegends,
} from './structureColors';
import { extractSequenceDataFromPlugin, useSequenceData } from '../hooks/useSequenceData';
import { chainTitleColor, structureResidueColorKey } from '../utils/structureColoration';
import { chainInstanceIdForSequenceChain } from '../utils/structureIds';
import { applyNativeChainVisibility } from './chainVisibility';
import { SequenceTrack } from '../components/SequenceTrack';

function nativeFixture() {
  const unit = {
    kind: 0,
    id: 1,
    elements: [0, 1, 2, 3],
    residueIndex: [0, 0, 1, 1],
    chainIndex: [0, 0, 0, 0],
    conformation: { operator: { name: '1_555' } },
    model: {
      id: 'model-one',
      properties: { structAsymMap: new Map([['A', { auth_id: 'E' }]]) },
      atomicHierarchy: {
        chains: {
          label_asym_id: { value: () => 'A' },
          auth_asym_id: { value: () => 'E' },
          label_entity_id: { value: () => '1' },
        },
        residues: {
          auth_seq_id: { value: (index: number) => index + 1 },
          label_seq_id: { value: (index: number) => index + 1 },
        },
        atoms: {
          label_comp_id: { value: (index: number) => (index < 2 ? 'ALA' : 'GLY') },
          label_atom_id: { value: (index: number) => (index % 2 === 0 ? 'CA' : 'CB') },
        },
      },
    },
  } as unknown as Unit.Atomic;
  const structure = { units: [unit] };
  const locations = unit.elements.map((element) =>
    StructureElement.Location.create(undefined, unit, element)
  );
  const representation = {
    theme: { color: { granularity: 'group', color: () => 0xffa500 } },
    props: { alpha: 1 },
    state: {
      visible: true,
      alphaFactor: 1,
      overpaint: {
        layers: [] as Array<{ loci: StructureElement.Loci; color: number; clear: boolean }>,
      },
      transparency: { layers: [] as Array<{ loci: StructureElement.Loci; value: number }> },
      themeStrength: { overpaint: 1, transparency: 1 },
    },
    updated: new Subject<number>(),
    setState: vi.fn((next: Record<string, unknown>) => {
      Object.assign(representation.state, next);
    }),
    eachLocation: (callback: (location: StructureElement.Location, secondary: boolean) => void) => {
      locations.forEach((location) => callback(location, false));
    },
  };
  const component = {
    cell: { obj: { data: structure } },
    representations: [
      {
        cell: {
          params: { values: { type: { name: 'cartoon' } } },
          obj: { data: { repr: representation } },
        },
      },
    ],
  };
  const state = {
    events: { changed: new Subject(), cell: { stateUpdated: new Subject() } },
    behaviors: { isUpdating: new BehaviorSubject(false) },
  };
  const plugin = {
    state: { data: state },
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { obj: { data: structure } },
                components: [component],
              },
            ],
          },
        },
      },
    },
  };
  const loci = StructureElement.Loci(structure as StructureElement.Loci['structure'], [
    {
      unit,
      indices: OrderedSet.ofSingleton(0),
    },
  ]);
  return { plugin, state, representation, component, unit, locations, loci };
}

describe('native molecular color projection', () => {
  it('uses resolved native colors for residues and their chain title', () => {
    const { plugin } = nativeFixture();
    const chain = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0];
    expect(chain.authAsymId).toBe('E');
    expect(chain.coloration).toEqual({ kind: 'uniform', color: 0xffa500 });
    expect(chain.residues.map((residue) => residue.coloration)).toEqual([
      { kind: 'uniform', color: 0xffa500 },
      { kind: 'uniform', color: 0xffa500 },
    ]);
  });

  it.each(['cartoon', 'ball-and-stick', 'spacefill', 'line'])(
    'uses the drawn %s trace atom for residue letters when its theme varies within one residue',
    (typeName) => {
      const { plugin, representation, locations, component } = nativeFixture();
      component.representations[0].cell.params.values.type.name = typeName;
      representation.theme.color.color = vi.fn((location?: StructureElement.Location) =>
        location?.element === locations[0].element ? 0x0000ff : 0xffa500
      );
      const chain = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0];
      expect(chain.residues[0].coloration).toEqual({ kind: 'uniform', color: 0x0000ff });
      expect(chain.residues[1].coloration).toEqual({ kind: 'uniform', color: 0xffa500 });
      expect(chain.coloration).toEqual({ kind: 'multiple', colors: [0x0000ff, 0xffa500] });
    }
  );

  it('keeps a partially represented chain title neutral while preserving residue colors', () => {
    const { plugin, representation, locations } = nativeFixture();
    representation.eachLocation = (callback) => {
      locations.slice(0, 2).forEach((location) => callback(location, false));
    };
    const chain = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0];
    expect(chain.residues.map((residue) => residue.coloration)).toEqual([
      { kind: 'uniform', color: 0xffa500 },
      { kind: 'unrepresented' },
    ]);
    expect(chain.coloration).toEqual({ kind: 'partial', colors: [0xffa500] });
    expect(chainTitleColor(chain.coloration!)).toBe('hsl(var(--color-fg))');
  });

  it('keeps differently colored physical copies separate despite shared numbering', () => {
    const { plugin, unit } = nativeFixture();
    const colors = resolveStructureColors(plugin);
    expect(colors.get(structureResidueColorKey(unit, 0))).toEqual({
      kind: 'uniform',
      color: 0xffa500,
    });
    expect(colors.get(structureResidueColorKey({ ...unit, id: 2 }, 0))).toBeUndefined();
    expect(
      colors.get(structureResidueColorKey({ ...unit, model: { id: 'model-two' } }, 0))
    ).toBeUndefined();
  });

  it('uses the visible backbone color rather than side-chain atom colors for sequence letters', () => {
    const { plugin, representation, component, unit } = nativeFixture();
    component.representations.push({
      cell: {
        params: { values: { type: { name: 'ball-and-stick' } } },
        obj: {
          data: {
            repr: {
              ...representation,
              theme: { color: { granularity: 'group', color: () => 0x800080 } },
            },
          },
        },
      },
    });
    const key = structureResidueColorKey(unit, 0);
    expect(resolveStructureColorProjection(plugin).backbone.get(key)).toEqual({
      kind: 'uniform',
      color: 0xffa500,
    });
    expect(
      extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].residues[0].coloration
    ).toEqual({
      kind: 'uniform',
      color: 0xffa500,
    });
  });

  it('samples the exact visible alpha carbon for atomic-detail backgrounds independently of the trace', () => {
    const { plugin, representation, component, unit, loci } = nativeFixture();
    component.representations.push({
      cell: {
        params: { values: { type: { name: 'ball-and-stick' } } },
        obj: {
          data: {
            repr: {
              ...representation,
              theme: {
                color: {
                  granularity: 'group',
                  color: (location: StructureElement.Location) =>
                    location.element % 2 === 0 ? 0x33aabb : 0x800080,
                },
              },
              state: {
                ...representation.state,
                overpaint: { layers: [{ loci, color: 0xffcc00, clear: false }] },
              },
            },
          },
        },
      },
    });
    const residues = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].residues;
    expect(residues[0].coloration).toEqual({ kind: 'uniform', color: 0xffa500 });
    expect(residues[0].alphaCarbonColoration).toEqual({ kind: 'uniform', color: 0xffcc00 });
    expect(residues[1].alphaCarbonColoration).toEqual({ kind: 'uniform', color: 0x33aabb });
    expect(
      resolveStructureColorProjection(plugin).alphaCarbon.get(structureResidueColorKey(unit, 0))
    ).toEqual({ kind: 'uniform', color: 0xffcc00 });
  });

  it('includes native CA overlays in the chain controls while preserving trace glyphs and atomic backgrounds', () => {
    const { plugin, representation, component } = nativeFixture();
    component.representations.push({
      cell: {
        params: { values: { type: { name: 'ball-and-stick' } } },
        obj: {
          data: {
            repr: {
              ...representation,
              theme: {
                color: {
                  granularity: 'group',
                  color: (location: StructureElement.Location) =>
                    location.element % 2 === 0 ? 0x33aabb : 0x800080,
                },
              },
            },
          },
        },
      },
    });
    const chain = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0];
    expect(chain.coloration).toEqual({ kind: 'multiple', colors: [0x33aabb, 0xffa500] });
    render(
      createElement(SequenceTrack, {
        chain,
        chainInstanceId: chainInstanceIdForSequenceChain(chain),
        colorMode: 'chain',
        interactionState: { hovered: null, selected: [] },
        onHover: vi.fn(),
        onSelect: vi.fn(),
        onToggleVisibility: vi.fn(),
      })
    );
    const title = screen.getByText('Chain E');
    const checkbox = screen.getByRole('checkbox', { name: 'Hide chain E (A)' });
    expect(title.style.color).toBe('hsl(var(--color-fg))');
    expect(checkbox.style.backgroundColor).toBe(title.style.color);
    expect(checkbox.getAttribute('data-visibility-state')).toBe('all');
    expect(screen.getAllByTestId('residue-color-tile')[0].style.backgroundColor).toBe(
      'rgb(255, 165, 0)'
    );
    expect(screen.getByTestId('residue-A-1').style.backgroundColor).toBe(
      'rgba(51, 170, 187, 0.13)'
    );
  });

  it('keeps CA colors separate for native sources reusing the same model, unit, and residue IDs', () => {
    const first = nativeFixture();
    const second = nativeFixture();
    const entry = first.plugin.managers.structure.hierarchy.current.structures[0];
    const secondEntry = second.plugin.managers.structure.hierarchy.current.structures[0];
    Object.assign(entry.cell, { transform: { ref: 'first' } });
    Object.assign(secondEntry.cell, { transform: { ref: 'second' } });
    first.component.representations[0].cell.params.values.type.name = 'ball-and-stick';
    second.component.representations[0].cell.params.values.type.name = 'ball-and-stick';
    second.representation.theme.color.color = () => 0x33aabb;
    first.plugin.managers.structure.hierarchy.current.structures.push(secondEntry);
    Object.assign(first.plugin.state.data, {
      tree: {
        transforms: new Map([
          ['first', { tags: ['mvs-ref:source-one'] }],
          ['second', { tags: ['mvs-ref:source-two'] }],
        ]),
      },
    });
    const sequences = extractSequenceDataFromPlugin(first.plugin, 'chain')!;
    expect(sequences.chains).toHaveLength(2);
    expect(
      sequences.chains.map((chain) => [chain.structureRef, chain.residues[0].alphaCarbonColoration])
    ).toEqual([
      ['source-one', { kind: 'uniform', color: 0xffa500 }],
      ['source-two', { kind: 'uniform', color: 0x33aabb }],
    ]);
    expect(sequences.chains.map((chain) => [chain.structureRef, chain.coloration])).toEqual([
      ['source-one', { kind: 'uniform', color: 0xffa500 }],
      ['source-two', { kind: 'uniform', color: 0x33aabb }],
    ]);
    expect(
      sequences.chains.every((chain) => chain.residues[0].coloration?.kind === 'uniform')
    ).toBe(true);
  });

  it('does not invent a CA color from a side-chain-only native overlay', () => {
    const { plugin, representation, component, locations } = nativeFixture();
    component.representations[0].cell.params.values.type.name = 'ball-and-stick';
    representation.eachLocation = (callback) => callback(locations[1], false);
    expect(
      extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].residues[0].alphaCarbonColoration
    ).toEqual({ kind: 'unrepresented' });
  });

  it('does not let plane-only or connector-only cartoons recolor backbone sequence letters', () => {
    const { plugin, representation, component, unit } = nativeFixture();
    for (const visual of [
      'dnaforge-nucleotide-base-plane',
      'dnaforge-nucleotide-connector',
      'nucleotide-ring',
    ]) {
      component.representations.push({
        cell: {
          params: { values: { type: { name: 'cartoon' } } },
          obj: {
            data: {
              repr: {
                ...representation,
                props: { alpha: 0.35, visuals: [visual] },
                theme: { color: { granularity: 'group', color: () => 0x33aabb } },
              } as typeof representation,
            },
          },
        },
      });
    }
    expect(
      resolveStructureColorProjection(plugin).backbone.get(structureResidueColorKey(unit, 0))
    ).toEqual({
      kind: 'uniform',
      color: 0xffa500,
    });
    expect(
      extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].residues[0].coloration
    ).toEqual({
      kind: 'uniform',
      color: 0xffa500,
    });
  });

  it('keeps plane-only polymer letters neutral when no actual backbone is drawn', () => {
    const { plugin, representation } = nativeFixture();
    Object.assign(representation.props, { visuals: ['dnaforge-nucleotide-base-plane'] });
    expect(resolveStructureColorProjection(plugin).backbone.size).toBe(0);
    expect(
      extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].residues[0].coloration
    ).toEqual({ kind: 'unavailable' });
  });

  it('limits unsupported atomic color fallback to the real native filtered structure', () => {
    const { plugin, representation, component, unit, locations } = nativeFixture();
    component.representations[0].cell.params.values.type.name = 'ball-and-stick';
    representation.theme.color.granularity = 'vertex';
    const subset = {
      units: [{ ...unit, elements: unit.elements.slice(0, 2) }],
    } as unknown as Structure;
    Object.assign(representation, { getAllLoci: () => [Structure.Loci(subset)] });
    representation.eachLocation = (callback) => {
      locations.slice(0, 2).forEach((location) => callback(location, false));
    };
    const projection = resolveStructureColorProjection(plugin);
    expect(projection.all.get(structureResidueColorKey(unit, 0))).toEqual({ kind: 'unavailable' });
    expect(projection.all.has(structureResidueColorKey(unit, 1))).toBe(false);
  });

  it('masks only native displayed atoms and refreshes the mask when that scope changes', () => {
    const { plugin, representation, component, unit } = nativeFixture();
    const source = component.cell.obj.data as unknown as Structure;
    Object.assign(source, { unitMap: new Map([[unit.id, unit]]) });
    let subset = {
      units: [{ ...unit, elements: unit.elements.slice(1, 2) }],
    } as unknown as Structure;
    Object.assign(representation, { getAllLoci: () => [Structure.Loci(subset)] });
    const chain = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0];
    const id = chainInstanceIdForSequenceChain(chain);
    expect(applyNativeChainVisibility(plugin, [id])).toBe(true);
    expect(representation.state.visible).toBe(false);
    expect(representation.state.transparency.layers).toHaveLength(0);
    subset = source;
    expect(applyNativeChainVisibility(plugin, [id])).toBe(true);
    expect(representation.state.visible).toBe(false);
    expect(applyNativeChainVisibility(plugin, [id])).toBe(false);
  });

  it('reports a native backbone-atom detail span without recoloring its cartoon letters', () => {
    const { plugin, representation, component, unit } = nativeFixture();
    unit.model.atomicHierarchy.atoms.label_atom_id.value = ((index: number) =>
      ['N', 'CA', 'C', 'O'][index]) as typeof unit.model.atomicHierarchy.atoms.label_atom_id.value;
    component.representations.push({
      cell: {
        params: { values: { type: { name: 'ball-and-stick' } } },
        obj: {
          data: {
            repr: {
              ...representation,
              eachLocation: (
                callback: (location: StructureElement.Location, secondary: boolean) => void
              ) => {
                for (const element of unit.elements.slice(0, 2))
                  callback(StructureElement.Location.create(undefined, unit, element), false);
              },
            },
          },
        },
      },
    });

    const residues = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].residues;
    expect(residues[0].coloration).toEqual({ kind: 'uniform', color: 0xffa500 });
    expect(residues[0].atomicDetail).toBe('backbone');
    expect(residues[1].atomicDetail).toBeUndefined();
  });

  it('does not substitute side-chain atom colors when a polymer has no visible backbone', () => {
    const { plugin, component, representation, locations } = nativeFixture();
    component.representations[0].cell.params.values.type.name = 'ball-and-stick';
    representation.eachLocation = (callback) => {
      locations
        .filter((location) => location.element % 2 === 1)
        .forEach((location) => callback(location, false));
    };
    const residue = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].residues[0];
    expect(residue.coloration).toEqual({ kind: 'unavailable' });
  });

  it('excludes hidden and fully transparent representations', () => {
    const { plugin, representation } = nativeFixture();
    representation.state.visible = false;
    expect(extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].coloration).toEqual({
      kind: 'unrepresented',
    });
    representation.state.visible = true;
    representation.props.alpha = 0;
    expect(resolveStructureColors(plugin).size).toBe(0);
    representation.props.alpha = 1;
    representation.state.alphaFactor = 0;
    expect(resolveStructureColors(plugin).size).toBe(0);
  });

  it('excludes masked atoms when a surface color cannot be sampled by residue', () => {
    const { plugin, representation, component, unit } = nativeFixture();
    Object.assign(unit, { chainIndex: [0, 0, 1, 1] });
    unit.model.atomicHierarchy.chains.label_asym_id.value = (index: number) =>
      index === 0 ? 'A' : 'B';
    unit.model.atomicHierarchy.chains.auth_asym_id.value = (index: number) =>
      index === 0 ? 'E' : 'G';
    component.representations[0].cell.params.values.type.name = 'molecular-surface';
    representation.theme.color.granularity = 'vertex';
    const chain = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0];
    expect(chain.coloration).toEqual({ kind: 'unavailable' });
    expect(applyNativeChainVisibility(plugin, [chainInstanceIdForSequenceChain(chain)])).toBe(true);
    expect(resolveStructureColorProjection(plugin).all.has(structureResidueColorKey(unit, 0))).toBe(
      false
    );
    expect(extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].coloration).toEqual({
      kind: 'unrepresented',
    });
    expect(applyNativeChainVisibility(plugin, [])).toBe(true);
    expect(extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].coloration).toEqual({
      kind: 'unavailable',
    });
  });

  it('hides an entire physical chain natively and restores its authored transparency', () => {
    const { plugin, representation, loci } = nativeFixture();
    const chain = extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0];
    const chainId = chainInstanceIdForSequenceChain(chain);
    representation.state.transparency.layers.push({ loci, value: 0.35 });
    const originalTransparency = representation.state.transparency;

    expect(applyNativeChainVisibility(plugin, [chainId])).toBe(true);
    expect(representation.state.visible).toBe(false);
    expect(representation.state.transparency.layers).toHaveLength(1);
    expect(
      extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].residues.map(
        (residue) => residue.coloration?.kind
      )
    ).toEqual(['unrepresented', 'unrepresented']);
    expect(applyNativeChainVisibility(plugin, [chainId])).toBe(false);

    expect(applyNativeChainVisibility(plugin, [])).toBe(true);
    expect(representation.state.visible).toBe(true);
    expect(representation.state.transparency).toBe(originalTransparency);
    expect(
      extractSequenceDataFromPlugin(plugin, 'chain')!.chains[0].residues.map(
        (residue) => residue.coloration
      )
    ).toEqual([
      { kind: 'uniform', color: 0xffa500 },
      { kind: 'uniform', color: 0xffa500 },
    ]);
  });

  it('lists and masks equal chain identifiers in two native sources independently', () => {
    const first = nativeFixture();
    const second = nativeFixture();
    Object.assign(second.unit.model, { id: 'model-two' });
    second.representation.theme.color.color = () => 0x800080;
    Object.assign(first.plugin.managers.structure.hierarchy.current.structures[0].cell, {
      transform: { ref: 'first-source' },
    });
    Object.assign(second.plugin.managers.structure.hierarchy.current.structures[0].cell, {
      transform: { ref: 'second-source' },
    });
    first.plugin.managers.structure.hierarchy.current.structures.push(
      second.plugin.managers.structure.hierarchy.current.structures[0]
    );
    const before = extractSequenceDataFromPlugin(first.plugin, 'chain')!.chains;
    expect(before).toHaveLength(2);
    expect(before.map((chain) => chain.chainId)).toEqual(['A', 'A']);
    const firstId = chainInstanceIdForSequenceChain(before[0]);
    const secondId = chainInstanceIdForSequenceChain(before[1]);
    expect(secondId).not.toBe(firstId);
    expect(applyNativeChainVisibility(first.plugin, [secondId])).toBe(true);
    const masked = extractSequenceDataFromPlugin(first.plugin, 'chain')!.chains;
    expect(masked.map((chain) => chain.coloration)).toEqual([
      { kind: 'uniform', color: 0xffa500 },
      { kind: 'unrepresented' },
    ]);
    expect(applyNativeChainVisibility(first.plugin, [])).toBe(true);
    expect(applyNativeChainVisibility(first.plugin, [firstId])).toBe(true);
    expect(
      extractSequenceDataFromPlugin(first.plugin, 'chain')!.chains.map((chain) => chain.coloration)
    ).toEqual([{ kind: 'unrepresented' }, { kind: 'uniform', color: 0x800080 }]);
  });

  it('resolves native residue overpaint and respects a later clear layer', () => {
    const { plugin, representation, loci, unit } = nativeFixture();
    representation.state.overpaint.layers.push({ loci, color: 0x00ff00, clear: false });
    expect(resolveStructureColors(plugin).get(structureResidueColorKey(unit, 0))).toEqual({
      kind: 'multiple',
      colors: [0x00ff00, 0xffa500],
    });
    representation.state.overpaint.layers.push({ loci, color: 0, clear: true });
    expect(resolveStructureColors(plugin).get(structureResidueColorKey(unit, 0))).toEqual({
      kind: 'uniform',
      color: 0xffa500,
    });
  });

  it('does not invent colors for unsupported spatial color themes', () => {
    const { plugin, representation, unit } = nativeFixture();
    representation.theme.color.granularity = 'vertex';
    expect(resolveStructureColors(plugin).get(structureResidueColorKey(unit, 0))).toEqual({
      kind: 'unavailable',
    });
  });

  it('projects ligand colors through the same native source', () => {
    const { plugin, unit } = nativeFixture();
    unit.model.atomicHierarchy.atoms.label_comp_id.value = (() =>
      'MG') as typeof unit.model.atomicHierarchy.atoms.label_comp_id.value;
    const data = extractSequenceDataFromPlugin(plugin, 'element')!;
    expect(data.chains).toHaveLength(0);
    expect(data.ligands.map((ligand) => ligand.coloration)).toEqual([
      { kind: 'uniform', color: 0xffa500 },
      { kind: 'uniform', color: 0xffa500 },
    ]);
  });

  it('decodes the native palette coordinate instead of treating it as an RGB color', () => {
    const { plugin, representation, unit } = nativeFixture();
    Object.assign(representation.theme.color, {
      palette: { colors: [Color(0xff0000), Color(0x0000ff)], filter: 'nearest' },
    });
    representation.theme.color.color = () => 1;
    expect(resolveStructureColors(plugin).get(structureResidueColorKey(unit, 0))).toEqual({
      kind: 'uniform',
      color: 0xff0000,
    });
    representation.theme.color.color = () => ColorTheme.PaletteScale + 1;
    expect(resolveStructureColors(plugin).get(structureResidueColorKey(unit, 0))).toEqual({
      kind: 'uniform',
      color: 0x0000ff,
    });
  });

  it('excludes atom colors that the native representation hides', () => {
    const { plugin, representation, unit } = nativeFixture();
    Object.assign(unit.model.atomicHierarchy, {
      derived: { atom: { atomicNumber: [1, 6, 1, 6] } },
    });
    Object.assign(representation.props, { ignoreHydrogens: true });
    representation.theme.color.color = vi.fn((location?: StructureElement.Location) =>
      location?.element === 0 ? 0x0000ff : 0xffa500
    );
    expect(resolveStructureColors(plugin).get(structureResidueColorKey(unit, 0))).toEqual({
      kind: 'uniform',
      color: 0xffa500,
    });
  });

  it('uses the native legend and drops it when overpaint makes it inaccurate', () => {
    const { plugin, representation, loci } = nativeFixture();
    const legend = {
      kind: 'scale-legend',
      minLabel: 'low',
      maxLabel: 'high',
      colors: [Color(0x0000ff), Color(0xff0000)],
    };
    Object.assign(representation.theme.color, { legend });
    expect(resolveStructureColorLegends(plugin).map(({ legend }) => legend)).toEqual([legend]);
    representation.state.overpaint.layers.push({ loci, color: 0x00ff00, clear: false });
    expect(resolveStructureColorLegends(plugin).map(({ legend }) => legend)).toEqual([]);
  });

  it('does not present a uniform theme name as a scientific color key', () => {
    const { plugin, representation } = nativeFixture();
    Object.assign(representation.theme.color, {
      legend: { kind: 'table-legend', table: [['uniform', Color(0x12ab34)]] },
    });
    expect(resolveStructureColorLegends(plugin).map(({ legend }) => legend)).toEqual([]);
    const named = { kind: 'table-legend', table: [['HNH', Color(0x12ab34)]] };
    Object.assign(representation.theme.color, { legend: named });
    expect(resolveStructureColorLegends(plugin).map(({ legend }) => legend)).toEqual([named]);
  });

  it('does not show the full periodic table for an element-colored molecular scene', () => {
    const { plugin, representation } = nativeFixture();
    const ref =
      plugin.managers.structure.hierarchy.current.structures[0].components[0].representations[0];
    Object.assign(ref.cell.params!.values, { colorTheme: { name: 'element-symbol' } });
    Object.assign(representation.theme.color, {
      legend: {
        kind: 'table-legend',
        table: [
          ['H', Color(0xffffff)],
          ['D', Color(0xffff99)],
          ['T', Color(0xffff66)],
          ['HE', Color(0xd9ffff)],
        ],
      },
    });
    expect(resolveStructureColorLegends(plugin).map(({ legend }) => legend)).toEqual([]);
  });
});

describe('native color change observation', () => {
  it('refreshes sequence colors when the native theme changes without any scene or prop change', async () => {
    const { plugin, representation } = nativeFixture();
    const { result, unmount } = renderHook(() =>
      useSequenceData(plugin, 'chain', true, 'same-scene')
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current!.chains[0].coloration).toEqual({ kind: 'uniform', color: 0xffa500 });
    await act(async () => {
      representation.theme.color.color = () => 0x800080;
      representation.updated.next(1);
      await Promise.resolve();
    });
    expect(result.current!.chains[0].coloration).toEqual({ kind: 'uniform', color: 0x800080 });
    unmount();
    expect(representation.updated.observers).toHaveLength(0);
  });

  it('coalesces updates, waits for commit, and unsubscribes on unmount', async () => {
    const { plugin, state, representation } = nativeFixture();
    const changed = vi.fn();
    const stop = observeStructureColorChanges(plugin as unknown as PluginContext, changed);
    await Promise.resolve();
    changed.mockClear();
    state.behaviors.isUpdating.next(true);
    representation.updated.next(1);
    state.events.changed.next({});
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    state.behaviors.isUpdating.next(false);
    representation.updated.next(2);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    representation.updated.next(3);
    state.events.changed.next({});
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
