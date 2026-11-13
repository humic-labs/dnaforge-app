import { describe, expect, it } from 'vitest';
import type { DesignRegion, SequenceDesign } from '../design/types';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import { applyOverrideToCanonicalModels, buildJunctionWorkbenchModels } from './model';
import { SourceContextRegistry, createJunctionSourceWindowRequests } from './SourceContextRegistry';

describe('product row invariant under source-register drag', () => {
  for (const offsetBp of [-5, -1, +1, +5, +20]) {
    it(`offsetBp=${offsetBp} on left source: product.sequence is unchanged`, () => {
      const { canonical, shifted } = buildPair('left-source', offsetBp);
      const canonicalProduct = canonical.find((m) => m)!.rows.find((r) => r.kind === 'product')!;
      const shiftedProduct = shifted.find((m) => m)!.rows.find((r) => r.kind === 'product')!;
      expect(shiftedProduct.sequence).toBe(canonicalProduct.sequence);
    });

    it(`offsetBp=${offsetBp} on left source: product.annotations are unchanged`, () => {
      const { canonical, shifted } = buildPair('left-source', offsetBp);
      const canonicalProduct = canonical[0].rows.find((r) => r.kind === 'product')!;
      const shiftedProduct = shifted[0].rows.find((r) => r.kind === 'product')!;
      expect(shiftedProduct.annotations).toEqual(canonicalProduct.annotations);
    });

    it(`offsetBp=${offsetBp} on right source: product.sequence is unchanged`, () => {
      const { canonical, shifted } = buildPair('right-source', offsetBp);
      const canonicalProduct = canonical[0].rows.find((r) => r.kind === 'product')!;
      const shiftedProduct = shifted[0].rows.find((r) => r.kind === 'product')!;
      expect(shiftedProduct.sequence).toBe(canonicalProduct.sequence);
    });

    it(`offsetBp=${offsetBp} on right source: product.annotations are unchanged`, () => {
      const { canonical, shifted } = buildPair('right-source', offsetBp);
      const canonicalProduct = canonical[0].rows.find((r) => r.kind === 'product')!;
      const shiftedProduct = shifted[0].rows.find((r) => r.kind === 'product')!;
      expect(shiftedProduct.annotations).toEqual(canonicalProduct.annotations);
    });

    it(`offsetBp=${offsetBp}: candidate CDS annotations on product are unchanged`, () => {
      const { canonical, shifted } = buildPair('left-source', offsetBp);
      const canonicalProduct = canonical[0].rows.find((r) => r.kind === 'product')!;
      const shiftedProduct = shifted[0].rows.find((r) => r.kind === 'product')!;
      const canonicalCandidates = canonicalProduct.annotations.filter((a) =>
        annotationQualifierIncludes(a.qualifiers?.candidate, 'true')
      );
      const shiftedCandidates = shiftedProduct.annotations.filter((a) =>
        annotationQualifierIncludes(a.qualifiers?.candidate, 'true')
      );
      expect(shiftedCandidates).toEqual(canonicalCandidates);
    });
  }

  it('product row is reference-equal to canonical when only a SOURCE row is overridden', () => {
    const { canonical, shifted } = buildPair('left-source', +5);
    const canonicalProduct = canonical[0].rows.find((r) => r.kind === 'product')!;
    const shiftedProduct = shifted[0].rows.find((r) => r.kind === 'product')!;
    expect(shiftedProduct).toBe(canonicalProduct);
  });
});

function annotationQualifierIncludes(value: string | string[] | undefined, expected: string) {
  return Array.isArray(value) ? value.includes(expected) : value === expected;
}

function buildPair(rowKind: 'left-source' | 'right-source', offsetBp: number) {
  const design = makeDesign();
  const draft = computeDraftAssembly(design);
  const drafted = {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
  };
  const sourceSequences = Object.fromEntries(
    drafted.regions.map((region) => [
      region.sourceSequenceId,
      {
        id: region.sourceSequenceId,
        name: region.sourceSequenceName,
        sequence: region.sourceSequence!,
        length: region.sourceSequence!.length,
        circular: false,
        annotations: [],
      },
    ])
  );
  const stripped: SequenceDesign = {
    ...drafted,
    regions: drafted.regions.map((region) => ({
      ...region,
      sourceSequence: undefined,
      sourceAnnotations: undefined,
      sourceIsCircular: undefined,
    })),
  };
  const sourceWindows = new SourceContextRegistry(sourceSequences).resolveWindows(
    createJunctionSourceWindowRequests(stripped, { maxWindowBp: 200 })
  );
  const canonical = buildJunctionWorkbenchModels(stripped, {
    maxWindowBp: 200,
    sourceWindows,
  });
  const shifted = applyOverrideToCanonicalModels(canonical, sourceWindows, {
    junctionIndex: 0,
    rowKind,
    offsetBp,
  });
  return { canonical, shifted };
}

function makeDesign(): SequenceDesign {
  const now = new Date('2026-04-26T00:00:00.000Z');
  return {
    id: 'product-invariant',
    name: 'Product invariant under drag',
    topology: 'circular',
    regions: [region('left', 0), region('right', 1)],
    spacers: [{ junctionIndex: 0, sequence: 'GAGAG' }],
    version: 0,
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

function region(label: string, index: number): DesignRegion {
  const bodies = ['ATGCGTAC', 'GGCATACC'];
  const ups = ['T', 'A'];
  const downs = ['G', 'C'];
  const body = bodies[index].repeat(80);
  const upstream = ups[index].repeat(320);
  const downstream = downs[index].repeat(320);
  const sourceSequence = upstream + body + downstream;
  return {
    id: label,
    sourceSequenceId: label,
    sourceSequenceName: label,
    sourceStart: upstream.length,
    sourceEnd: upstream.length + body.length,
    sequence: body,
    annotations: [],
    sourceSequence,
    sourceAnnotations: [
      {
        name: `${label}-cds`,
        type: 'CDS',
        start: upstream.length + body.length - 30,
        end: upstream.length + body.length + 30,
        strand: 'forward',
        color: '#16a34a',
        qualifiers: { codon_start: '1' },
      },
    ],
    sourceIsCircular: false,
    sourceType: 'pcr',
  };
}
