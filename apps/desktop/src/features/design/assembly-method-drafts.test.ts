// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  assemblyDraftCompositionKey,
  switchAssemblyMethodPreservingDraft,
} from './assembly-method-drafts';
import type { DesignPrimer, DesignRegion, SequenceDesign } from './types';

describe('assembly method draft preservation', () => {
  it('returns the same design when the requested method and enzyme are already active', () => {
    const design = designFixture('gibson');

    expect(
      switchAssemblyMethodPreservingDraft({
        design,
        method: 'gibson',
        version: 2,
        now: new Date('2026-05-06T00:00:00.000Z'),
      })
    ).toBe(design);
  });

  it('snapshots the active method and restores it when switching back', () => {
    const gibsonDesign = withGibsonDraft(designFixture('gibson'));
    const switchedToGoldenGate = switchAssemblyMethodPreservingDraft({
      design: gibsonDesign,
      method: 'goldengate',
      enzyme: 'BsaI',
      version: 8,
      now: new Date('2026-05-06T00:00:00.000Z'),
    });
    const goldenGateDesign = withGoldenGateDraft(switchedToGoldenGate);

    const restoredGibson = switchAssemblyMethodPreservingDraft({
      design: goldenGateDesign,
      method: 'gibson',
      version: 9,
      now: new Date('2026-05-06T00:01:00.000Z'),
    });

    expect(restoredGibson.assemblyMethod).toBe('gibson');
    expect(restoredGibson.assemblyState).toBe('ready');
    expect(restoredGibson.homologyRegions).toEqual(gibsonDesign.homologyRegions);
    expect(restoredGibson.designPrimers).toEqual(gibsonDesign.designPrimers);
    expect(restoredGibson.goldenGateConfig).toBeUndefined();
    expect(restoredGibson.goldenGateJunctions).toBeUndefined();

    const restoredGoldenGate = switchAssemblyMethodPreservingDraft({
      design: restoredGibson,
      method: 'goldengate',
      enzyme: 'BsaI',
      version: 10,
      now: new Date('2026-05-06T00:02:00.000Z'),
    });

    expect(restoredGoldenGate.assemblyMethod).toBe('goldengate');
    expect(restoredGoldenGate.assemblyState).toBe('ready');
    expect(restoredGoldenGate.goldenGateConfig).toEqual({ enzyme: 'BsaI' });
    expect(restoredGoldenGate.goldenGateJunctions).toEqual(goldenGateDesign.goldenGateJunctions);
    expect(restoredGoldenGate.designPrimers).toEqual(goldenGateDesign.designPrimers);
  });

  it('does not restore a draft when the region or spacer composition changed', () => {
    const gibsonDesign = withGibsonDraft(designFixture('gibson'));
    const switchedToGoldenGate = switchAssemblyMethodPreservingDraft({
      design: gibsonDesign,
      method: 'goldengate',
      enzyme: 'BsaI',
      version: 8,
      now: new Date('2026-05-06T00:00:00.000Z'),
    });
    const changedComposition: SequenceDesign = {
      ...switchedToGoldenGate,
      spacers: [{ id: 'spacer-1', junctionIndex: 0, sequence: 'ATGC' }],
    };

    const restored = switchAssemblyMethodPreservingDraft({
      design: changedComposition,
      method: 'gibson',
      version: 9,
      now: new Date('2026-05-06T00:01:00.000Z'),
    });

    expect(restored.assemblyMethod).toBe('gibson');
    expect(restored.assemblyState).toBe('drafting');
    expect(restored.homologyRegions).toEqual([]);
    expect(restored.designPrimers).toEqual([]);
  });

  it('treats a Golden Gate enzyme change as a fresh method draft', () => {
    const goldenGateDesign = withGoldenGateDraft(designFixture('goldengate'));

    const switched = switchAssemblyMethodPreservingDraft({
      design: goldenGateDesign,
      method: 'goldengate',
      enzyme: 'BsmBI',
      version: 5,
      now: new Date('2026-05-06T00:00:00.000Z'),
    });

    expect(switched.assemblyMethod).toBe('goldengate');
    expect(switched.goldenGateConfig).toEqual({ enzyme: 'BsmBI' });
    expect(switched.goldenGateJunctions).toEqual([]);
    expect(switched.designPrimers).toEqual([]);
    expect(switched.assemblyMethodDrafts?.goldengate?.goldenGateConfig).toEqual({
      enzyme: 'BsaI',
    });
    expect(switched.assemblyMethodDrafts?.goldengate?.goldenGateJunctions).toEqual(
      goldenGateDesign.goldenGateJunctions
    );
  });

  it('clones saved and restored draft state so later mutations cannot corrupt snapshots', () => {
    const gibsonDesign = withGibsonDraft(designFixture('gibson'));
    const switchedToGoldenGate = switchAssemblyMethodPreservingDraft({
      design: gibsonDesign,
      method: 'goldengate',
      enzyme: 'BsaI',
      version: 8,
      now: new Date('2026-05-06T00:00:00.000Z'),
    });

    gibsonDesign.homologyRegions[0].encoding.onLeft = 99;

    const restored = switchAssemblyMethodPreservingDraft({
      design: switchedToGoldenGate,
      method: 'gibson',
      version: 9,
      now: new Date('2026-05-06T00:01:00.000Z'),
    });

    expect(restored.homologyRegions[0].encoding).toEqual({ onLeft: 12, onRight: 13 });

    restored.homologyRegions[0].encoding.onLeft = 77;
    expect(switchedToGoldenGate.assemblyMethodDrafts!.gibson!.homologyRegions[0].encoding).toEqual({
      onLeft: 12,
      onRight: 13,
    });
  });

  it('does not restore stale saved validation errors as live method state', () => {
    const gibsonDesign: SequenceDesign = {
      ...withGibsonDraft(designFixture('gibson')),
      validationErrors: [
        {
          code: 'goldengate_rd_enzyme_mismatch',
          severity: 'error',
          message: 'Stale validation text from an old draft.',
          field: 'regions[0]',
          fragmentIndex: 0,
        },
      ],
    };
    const switchedToGoldenGate = switchAssemblyMethodPreservingDraft({
      design: gibsonDesign,
      method: 'goldengate',
      enzyme: 'BsaI',
      version: 8,
      now: new Date('2026-05-06T00:00:00.000Z'),
    });

    const restored = switchAssemblyMethodPreservingDraft({
      design: switchedToGoldenGate,
      method: 'gibson',
      version: 9,
      now: new Date('2026-05-06T00:01:00.000Z'),
    });

    expect(switchedToGoldenGate.assemblyMethodDrafts?.gibson?.validationErrors).toHaveLength(1);
    expect(restored.validationErrors).toEqual([]);
  });

  it('composition keys are insensitive to spacer array order but sensitive to biological content', () => {
    const design = {
      ...designFixture('gibson'),
      spacers: [
        { id: 'spacer-b', junctionIndex: 1, sequence: 'GG' },
        { id: 'spacer-a', junctionIndex: 0, sequence: 'AA' },
      ],
    };
    const reordered = {
      ...design,
      spacers: [...design.spacers].reverse(),
    };
    const changedSequence = {
      ...design,
      regions: design.regions.map((region, index) =>
        index === 0 ? { ...region, sequence: `${region.sequence}A` } : region
      ),
    };

    expect(assemblyDraftCompositionKey(reordered)).toBe(assemblyDraftCompositionKey(design));
    expect(assemblyDraftCompositionKey(changedSequence)).not.toBe(
      assemblyDraftCompositionKey(design)
    );
  });
});

function withGibsonDraft(design: SequenceDesign): SequenceDesign {
  return {
    ...design,
    assemblyMethod: 'gibson',
    assemblyState: 'ready',
    status: 'computed',
    homologyRegions: [
      {
        id: 'homology-1',
        junctionIndex: 0,
        junctionPosition: 80,
        start: 68,
        end: 93,
        encoding: { onLeft: 12, onRight: 13 },
        metadata: { sequence: 'ACGTACGTACGTACGTACGTACGTA' },
      },
    ],
    designPrimers: [
      {
        fragmentIndex: 0,
        forward: primer('gibson-forward', 'forward', 'AAAA'),
        reverse: primer('gibson-reverse', 'reverse', 'TTTT'),
      },
    ],
  };
}

function withGoldenGateDraft(design: SequenceDesign): SequenceDesign {
  return {
    ...design,
    assemblyMethod: 'goldengate',
    assemblyState: 'ready',
    status: 'computed',
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsaI' },
    goldenGateJunctions: [
      {
        junctionIndex: 0,
        junctionPosition: 80,
        offset: 1,
        overhangStart: 79,
        overhangEnd: 83,
        overhang: 'ACGT',
        source: { type: 'pcr-designed' },
        isValid: true,
      },
    ],
    designPrimers: [
      {
        fragmentIndex: 1,
        forward: primer('gg-forward', 'forward', 'CCCC'),
        reverse: primer('gg-reverse', 'reverse', 'GGGG'),
      },
    ],
  };
}

function designFixture(method: SequenceDesign['assemblyMethod']): SequenceDesign {
  return {
    id: 'design-1',
    name: 'Draft comparison',
    topology: 'circular',
    regions: [region('left', 'A'.repeat(80)), region('right', 'C'.repeat(80))],
    spacers: [],
    version: 7,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: method,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: method === 'goldengate' ? { enzyme: 'BsaI' } : undefined,
    goldenGateJunctions: method === 'goldengate' ? [] : undefined,
    designPrimers: [],
    selectedJunctionIndex: 0,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: new Date('2026-05-06T00:00:00.000Z'),
    updatedAt: new Date('2026-05-06T00:00:00.000Z'),
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
    annotations: [],
    sourceType: 'pcr',
  };
}

function primer(id: string, direction: 'forward' | 'reverse', sequence: string): DesignPrimer {
  return {
    id,
    name: id,
    sequence,
    pbs: { start: 0, end: sequence.length, sequence },
    overhang: { length: 0, sequence: '' },
    direction,
    fragmentIndex: 0,
    junctionIndex: 0,
  };
}
