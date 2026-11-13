// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildAssemblyOptimizationInput } from './assembly-optimization-input';
import {
  applyAssemblyProductPendingEdits,
  assemblyProductIdentity,
  assemblyProductIdentityOf,
  freshAssemblyDerived,
  tagAssemblyDerived,
} from './assembly-product-freshness';
import type { DesignRegion, SequenceDesign } from '../design/types';

describe('assembly product freshness', () => {
  it('is the optimization fingerprint of the live product, including pending DNA', () => {
    const design = designWithParts();
    const committed = assemblyProductIdentity(design);
    expect(committed).toBe(assemblyProductIdentityOf(buildAssemblyOptimizationInput(design)));

    const pendingSpacer = assemblyProductIdentity(design, {
      spacers: { 0: 'GATTACA' },
    });
    expect(pendingSpacer).not.toBe(committed);
    expect(design.spacers).toEqual([]);

    const applied = applyAssemblyProductPendingEdits(design, {
      spacers: { 0: 'GATTACA' },
      regionSequences: { left: `${design.regions[0].sequence}AAAA` },
    });
    expect(applied.spacers[0]?.sequence).toBe('GATTACA');
    expect(applied.regions[0].sequence.endsWith('AAAA')).toBe(true);
    expect(assemblyProductIdentity(applied)).not.toBe(committed);

    const withSpacer = applyAssemblyProductPendingEdits(design, { spacers: { 0: 'GG' } });
    expect(
      applyAssemblyProductPendingEdits(withSpacer, { spacers: { 0: 'TT' } }).spacers[0]?.sequence
    ).toBe('TT');
    expect(applyAssemblyProductPendingEdits(withSpacer, { spacers: { 0: '' } }).spacers).toEqual(
      []
    );
    expect(applyAssemblyProductPendingEdits(design, null)).toBe(design);
    expect(applyAssemblyProductPendingEdits(design, {})).toBe(design);
  });

  it('does not treat a Golden Gate offset drag as a new product', () => {
    const design = designWithParts();
    design.assemblyMethod = 'goldengate';
    design.goldenGateConfig = { enzyme: 'BsaI', offsetLimitBp: 6 };
    design.goldenGateJunctions = [
      {
        junctionIndex: 0,
        junctionPosition: 16,
        overhangStart: 14,
        overhangEnd: 18,
        offset: 0,
        overhang: 'ACGT',
        source: { type: 'pcr-designed' },
        isValid: true,
      },
    ];
    const before = assemblyProductIdentity(design);
    const dragged: SequenceDesign = {
      ...design,
      goldenGateJunctions: design.goldenGateJunctions?.map((junction) => ({
        ...junction,
        offset: 2,
        overhangStart: 16,
        overhangEnd: 20,
        overhang: 'CGTA',
      })),
    };
    expect(assemblyProductIdentity(dragged)).toBe(before);
  });

  it('refuses to serve derived state computed for a different product', () => {
    const design = designWithParts();
    const current = assemblyProductIdentity(design);
    const overlay = tagAssemblyDerived(current, { rank: 1, overhang: 'ACGT' });
    expect(freshAssemblyDerived(current, overlay)).toEqual({ rank: 1, overhang: 'ACGT' });

    const afterSpacer = assemblyProductIdentity(design, { spacers: { 0: 'TT' } });
    expect(freshAssemblyDerived(afterSpacer, overlay)).toBeNull();
    expect(freshAssemblyDerived(current, null)).toBeNull();
    expect(freshAssemblyDerived(current, { productIdentity: '', value: { rank: 0 } })).toBeNull();
  });
});

function designWithParts(): SequenceDesign {
  const now = new Date('2026-08-13T00:00:00.000Z');
  return {
    id: 'freshness-design',
    name: 'Freshness',
    version: 1,
    topology: 'circular',
    assemblyMethod: 'goldengate',
    assemblyState: 'ready',
    status: 'computed',
    regions: [region('left', 'ATGCATGCATGCATGC'), region('right', 'GGCCGGCCGGCCGGCC')],
    spacers: [],
    homologyRegions: [],
    designPrimers: [],
    validationErrors: [],
    proposedPlans: [],
    defaultHomologyLength: 30,
    selectedJunctionIndex: 0,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function region(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    sourceType: 'pcr',
    annotations: [],
  };
}
