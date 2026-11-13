// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  isGoldenGateFixedRegionOrderCompatible,
  reorderByInsertionSlot,
  reorderGroupByInsertionSlot,
  resolveAssemblyMapInsertionSlot,
} from './assembly-rail-reorder';
import type { DesignRegion, SequenceDesign } from './types';

function rdRegion(id: string, upstream: string, downstream: string): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: 20,
    sequence: 'ATCG'.repeat(5),
    annotations: [],
    sourceType: 'rd',
    ggType: 'insert',
    rdOverhangs: { upstream, downstream },
    rdSourceEnzyme: 'BsaI',
  };
}

const GOLDEN_GATE_CIRCLE = {
  assemblyMethod: 'goldengate',
  topology: 'circular',
} satisfies Pick<SequenceDesign, 'assemblyMethod' | 'topology'>;

describe('reorderByInsertionSlot', () => {
  const ids = ['A', 'B', 'C', 'D'];

  it('moves an item to an insertion slot without using preview-order indices', () => {
    expect(reorderByInsertionSlot(ids, 0, 4)).toEqual(['B', 'C', 'D', 'A']);
    expect(reorderByInsertionSlot(ids, 3, 0)).toEqual(['D', 'A', 'B', 'C']);
  });

  it('treats self-adjacent insertion slots as no-ops', () => {
    expect(reorderByInsertionSlot(ids, 1, 1)).toEqual(ids);
    expect(reorderByInsertionSlot(ids, 1, 2)).toEqual(ids);
  });

  it('keeps the preview stable when the same target slot is reported repeatedly', () => {
    const firstPreview = reorderByInsertionSlot(ids, 0, 3);
    const secondPreview = reorderByInsertionSlot(ids, 0, 3);

    expect(firstPreview).toEqual(['B', 'C', 'A', 'D']);
    expect(secondPreview).toEqual(firstPreview);
  });
});

describe('isGoldenGateFixedRegionOrderCompatible', () => {
  const aToB = rdRegion('A-B', 'AATG', 'GCTT');
  const bToC = rdRegion('B-C', 'GCTT', 'CGCT');
  const cToA = rdRegion('C-A', 'CGCT', 'AATG');

  it('accepts the fusion-site order and an equivalent circular rotation', () => {
    expect(isGoldenGateFixedRegionOrderCompatible(GOLDEN_GATE_CIRCLE, [aToB, bToC, cToA])).toBe(
      true
    );
    expect(isGoldenGateFixedRegionOrderCompatible(GOLDEN_GATE_CIRCLE, [bToC, cToA, aToB])).toBe(
      true
    );
  });

  it('rejects an arbitrary rearrangement of fixed digest fragments', () => {
    expect(isGoldenGateFixedRegionOrderCompatible(GOLDEN_GATE_CIRCLE, [aToB, cToA, bToC])).toBe(
      false
    );
  });

  it('does not constrain Gibson ordering or PCR-designed Golden Gate neighbors', () => {
    const pcr = { ...aToB, id: 'PCR', sourceType: 'pcr' as const, rdOverhangs: undefined };
    expect(
      isGoldenGateFixedRegionOrderCompatible({ assemblyMethod: 'gibson', topology: 'circular' }, [
        aToB,
        cToA,
        bToC,
      ])
    ).toBe(true);
    expect(isGoldenGateFixedRegionOrderCompatible(GOLDEN_GATE_CIRCLE, [aToB, pcr, cToA])).toBe(
      true
    );
  });
});

describe('resolveAssemblyMapInsertionSlot', () => {
  const ranges = [
    { start: 0, end: 100 },
    { start: 104, end: 260 },
    { start: 260, end: 400 },
  ];

  it('chooses the nearest between-part boundary instead of a nucleotide midpoint', () => {
    expect(resolveAssemblyMapInsertionSlot(ranges, 2)).toBe(0);
    expect(resolveAssemblyMapInsertionSlot(ranges, 102)).toBe(1);
    expect(resolveAssemblyMapInsertionSlot(ranges, 258)).toBe(2);
    expect(resolveAssemblyMapInsertionSlot(ranges, 399)).toBe(3);
  });

  it('returns null for an empty map or a non-finite pointer position', () => {
    expect(resolveAssemblyMapInsertionSlot([], 10)).toBeNull();
    expect(resolveAssemblyMapInsertionSlot(ranges, Number.NaN)).toBeNull();
  });
});

describe('reorderGroupByInsertionSlot', () => {
  const ids = ['A', 'B', 'C', 'D', 'E'];

  it('moves selected items as one block while preserving their order', () => {
    expect(reorderGroupByInsertionSlot(ids, [1, 2], 0)).toEqual(['B', 'C', 'A', 'D', 'E']);
    expect(reorderGroupByInsertionSlot(ids, [1, 3], 5)).toEqual(['A', 'C', 'E', 'B', 'D']);
  });

  it('treats insertion slots inside the selected block as no-ops', () => {
    expect(reorderGroupByInsertionSlot(ids, [1, 2], 1)).toEqual(ids);
    expect(reorderGroupByInsertionSlot(ids, [1, 2], 2)).toEqual(ids);
    expect(reorderGroupByInsertionSlot(ids, [1, 2], 3)).toEqual(ids);
  });

  it('deduplicates and bounds selected indices before reordering', () => {
    expect(reorderGroupByInsertionSlot(ids, [3, 3, -1, 99, 1], 0)).toEqual([
      'B',
      'D',
      'A',
      'C',
      'E',
    ]);
  });
});
