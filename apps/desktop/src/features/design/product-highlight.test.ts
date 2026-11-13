// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { productHighlightForRegionIndex } from './product-highlight';
import { getComposedSequenceForDesign, getEffectiveDesignRegions } from './restriction-digest';
import type { DesignRegion, DesignSpacer, SequenceDesign } from './types';

function part(id: string, length: number): DesignRegion {
  return {
    id,
    sourceSequenceId: `/tmp/${id}.gb`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: length,
    sequence: 'A'.repeat(length),
    annotations: [],
    sourceType: 'pcr',
  };
}

function design(regions: DesignRegion[], spacers: DesignSpacer[] = []): SequenceDesign {
  const now = new Date('2026-05-10T00:00:00.000Z');
  return {
    id: 'd',
    name: 'd',
    topology: 'linear',
    regions,
    spacers,
    version: 1,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('productHighlightForRegionIndex', () => {
  it('points at the first part from the very start of the product', () => {
    const d = design([part('a', 100), part('b', 250)]);
    expect(productHighlightForRegionIndex(d, 0)).toEqual({ position: 1, start: 0, end: 99 });
  });

  it('offsets a later part by everything in front of it', () => {
    const d = design([part('a', 100), part('b', 250), part('c', 40)]);
    expect(productHighlightForRegionIndex(d, 1)).toEqual({ position: 101, start: 100, end: 349 });
    expect(productHighlightForRegionIndex(d, 2)).toEqual({ position: 351, start: 350, end: 389 });
  });

  it('covers exactly the part length, never one base more', () => {
    const d = design([part('a', 100), part('b', 250)]);
    for (const [index, length] of [
      [0, 100],
      [1, 250],
    ] as const) {
      const h = productHighlightForRegionIndex(d, index)!;
      expect(h.end - h.start + 1).toBe(length);
    }
  });

  it('declines an empty part rather than pointing at whatever follows it', () => {
    const d = design([part('a', 100), part('empty', 0), part('c', 40)]);
    expect(productHighlightForRegionIndex(d, 1)).toBeNull();
    expect(productHighlightForRegionIndex(d, 2)).toEqual({ position: 101, start: 100, end: 139 });
  });

  it('declines an index that is not a part', () => {
    expect(productHighlightForRegionIndex(design([part('a', 10)]), 7)).toBeNull();
  });

  it('addresses by index so two parts sharing an id stay distinguishable', () => {
    const d = design([part('dup', 100), part('dup', 250)]);
    expect(productHighlightForRegionIndex(d, 0)).toEqual({ position: 1, start: 0, end: 99 });
    expect(productHighlightForRegionIndex(d, 1)).toEqual({ position: 101, start: 100, end: 349 });
  });
});

function assertHighlightMatchesComposedProduct(design: SequenceDesign, regionIndex: number) {
  const composed = getComposedSequenceForDesign(design);
  const effective = getEffectiveDesignRegions(design)[regionIndex];
  const highlight = productHighlightForRegionIndex(design, regionIndex)!;
  expect(highlight).not.toBeNull();
  expect(composed.slice(highlight.start, highlight.end + 1)).toBe(effective.sequence);
  expect(highlight.end).toBeLessThan(composed.length);
}

describe('productHighlightForRegionIndex — trimmed parts (Gibson/NEBuilder)', () => {
  function digestPart(id: string, sequence: string, scar: string): DesignRegion {
    return {
      id,
      sourceSequenceId: `/tmp/${id}.gb`,
      sourceSequenceName: id,
      sourceStart: 0,
      sourceEnd: sequence.length,
      sequence,
      annotations: [],
      sourceType: 'rd',
      rdEnds: {
        upstream: {
          overhangType: '5_prime',
          overhang: scar,
          retainedScarSequence: scar,
          retainedScarLength: scar.length,
          nebuilderResectionBases: 0,
          cutPositionTop: 0,
          cutPositionBottom: 0,
          strand: 1,
        },
      },
    } as unknown as DesignRegion;
  }

  it('locates a part that follows a TRIMMED part at its real composed offset', () => {
    const d = design([digestPart('rd', 'A'.repeat(100), 'GGGG'), part('after', 60)]);
    d.assemblyMethod = 'gibson';

    const effective = getEffectiveDesignRegions(d);
    expect(effective[0].sequence.length).toBeLessThan(d.regions[0].sequence.length);

    assertHighlightMatchesComposedProduct(d, 0);
    assertHighlightMatchesComposedProduct(d, 1);
  });

  it('never runs past the end of the composed product', () => {
    const d = design([digestPart('rd', 'A'.repeat(100), 'GGGG'), part('last', 40)]);
    d.assemblyMethod = 'gibson';
    const composed = getComposedSequenceForDesign(d);
    const last = productHighlightForRegionIndex(d, 1)!;
    expect(last.end).toBe(composed.length - 1);
  });

  it('is unaffected for a method that does not trim', () => {
    const d = design([digestPart('rd', 'A'.repeat(100), 'GGGG'), part('after', 60)]);
    d.assemblyMethod = 'goldengate';
    assertHighlightMatchesComposedProduct(d, 0);
    assertHighlightMatchesComposedProduct(d, 1);
  });
});
