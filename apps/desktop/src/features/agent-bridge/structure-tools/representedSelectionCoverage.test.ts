import { OrderedSet, SortedArray } from 'molstar/lib/mol-data/int';
import type { Loci } from 'molstar/lib/mol-model/loci';
import { describe, expect, it } from 'vitest';
import type { MolstarPlugin } from '../../page/public/embeds/structure3d/viewerCache';
import { representedSelectionCoverage } from './representedSelectionCoverage';

const selected = {
  kind: 'element-loci',
  elements: [
    {
      unit: { id: 1, elements: SortedArray.ofBounds(0, 10) },
      indices: OrderedSet.ofBounds(0, 10),
    },
  ],
} as unknown as Loci;

function component(start: number, end: number, hidden = false) {
  return {
    cell: {
      state: { isHidden: hidden },
      obj: { data: { units: [{ id: 1, elements: SortedArray.ofBounds(start, end) }] } },
    },
    representations: [{ cell: { state: { isHidden: false } } }],
  };
}

function pluginWith(...components: ReturnType<typeof component>[]) {
  return {
    managers: { structure: { hierarchy: { current: { structures: [{ components }] } } } },
  } as unknown as MolstarPlugin;
}

describe('represented selection coverage', () => {
  it('separates a loaded full protein from its pocket-only visible scene', () => {
    expect(representedSelectionCoverage(pluginWith(component(0, 2)), selected)).toEqual({
      selectedAtomCount: 10,
      representedAtomCount: 2,
    });
  });

  it('counts overlapping visible components once and excludes hidden components', () => {
    expect(
      representedSelectionCoverage(
        pluginWith(component(0, 6), component(4, 10), component(0, 10, true)),
        selected
      )
    ).toEqual({ selectedAtomCount: 10, representedAtomCount: 10 });
    expect(representedSelectionCoverage(pluginWith(component(0, 10, true)), selected)).toEqual({
      selectedAtomCount: 10,
      representedAtomCount: 0,
    });
  });
});

describe('native representation visibility', () => {
  it('supports array-like element sets for native cartoon coverage', () => {
    const source = component(0, 2);
    const unit = source.cell.obj.data.units[0];
    Object.assign(unit, { elements: { 0: 0, 1: 1, length: 2 } });
    Object.assign(source.representations[0].cell, {
      params: { values: { type: { name: 'cartoon' } } },
      obj: {
        data: {
          repr: {
            state: { visible: true, alphaFactor: 1 },
            props: { alpha: 1 },
            eachLocation: (visit: (location: unknown) => void) =>
              visit({ kind: 'element-location', unit, element: 0 }),
          },
        },
      },
    });
    expect(representedSelectionCoverage(pluginWith(source), selected)).toEqual({
      selectedAtomCount: 10,
      representedAtomCount: 1,
    });
  });

  for (const [name, state, alpha, expected] of [
    ['transparent', { visible: true, alphaFactor: 1 }, 0, 0],
    ['hidden', { visible: false, alphaFactor: 1 }, 1, 0],
    ['zero alpha factor', { visible: true, alphaFactor: 0 }, 1, 0],
    ['translucent', { visible: true, alphaFactor: 1 }, 0.25, 10],
  ] as const) {
    it(`counts only drawn atoms for a ${name} representation`, () => {
      const source = component(0, 10);
      Object.assign(source.representations[0].cell, {
        obj: { data: { repr: { state, props: { alpha } } } },
      });
      expect(representedSelectionCoverage(pluginWith(source), selected)).toEqual({
        selectedAtomCount: 10,
        representedAtomCount: expected,
      });
    });
  }
});
