// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { computeGoldenGatePrimers, sizePbsLengthForTm } from './golden-gate';
import { computePrimers } from './gibson-primers';
import { computeDraftAssembly } from './draft-assembly';
import { estimateTm } from './tm-calculator';
import { reverseComplement } from './utils';
import type { DesignRegion, SequenceDesign } from '../types';
import type { TmCalculator } from './tm-service';

function pcrRegion(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: `src-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function ggDesign(regions: DesignRegion[]): SequenceDesign {
  const now = new Date('2026-06-20T00:00:00.000Z');
  return {
    id: 'd',
    name: 'fixture',
    topology: 'circular',
    regions,
    spacers: [],
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'goldengate',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsaI' },
    goldenGateJunctions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

const TEMPLATE = 'ATGCGTACCGGTTACGATCGGCATTAGCCGATCGTACGGATCCGTTAACGGCATGCATGCATGCATGCAT';

describe('empty assembly slots are not PCR templates', () => {
  it.each(['goldengate', 'gibson'] as const)(
    '%s never borrows a base from the next part',
    (method) => {
      const regions = [
        pcrRegion('left', TEMPLATE),
        { ...pcrRegion('missing', ''), isPlaceholder: true },
        pcrRegion('right', 'A' + TEMPLATE),
      ];
      const pairs =
        method === 'goldengate'
          ? computeGoldenGatePrimers(regions, [], 'circular', 'BsaI')
          : computePrimers(regions, [], 'circular');
      expect(pairs.some((pair) => pair.fragmentIndex === 1)).toBe(false);
      expect(pairs.map((pair) => pair.fragmentIndex)).toEqual([0, 2]);
    }
  );
});

function forwardTm(length: number): number {
  return estimateTm(TEMPLATE.slice(0, length));
}

describe('sizePbsLengthForTm  #11)', () => {
  const base = {
    template: TEMPLATE,
    anchor: 0,
    direction: 'forward' as const,
    regionStart: 0,
    regionEnd: TEMPLATE.length,
    cognateSeq: 'ACGT',
  };

  it('targets PBS Tm: returns the length whose anneal Tm is closest to target', () => {
    const target = 58;
    const len = sizePbsLengthForTm({ ...base, targetTm: target });
    expect(len).toBeGreaterThanOrEqual(10);
    expect(len).toBeLessThanOrEqual(60);

    const here = Math.abs(forwardTm(len) - target);
    if (len > 10) expect(here).toBeLessThanOrEqual(Math.abs(forwardTm(len - 1) - target));
    if (len < TEMPLATE.length) {
      expect(here).toBeLessThanOrEqual(Math.abs(forwardTm(len + 1) - target));
    }
  });

  it('is monotonic: a higher target Tm yields a longer-or-equal PBS', () => {
    const lo = sizePbsLengthForTm({ ...base, targetTm: 50 });
    const hi = sizePbsLengthForTm({ ...base, targetTm: 70 });
    expect(hi).toBeGreaterThanOrEqual(lo);
  });

  it('clamps to PBS min when the target is unreachably low', () => {
    expect(sizePbsLengthForTm({ ...base, targetTm: 5 })).toBe(10);
  });

  it('clamps to PBS max (bounded by available template) when the target is unreachably high', () => {
    expect(sizePbsLengthForTm({ ...base, targetTm: 300 })).toBe(60);
  });

  it('does not let the Golden Gate cognate overhang change PBS length', () => {
    const target = 58;
    const withGcCognate = sizePbsLengthForTm({ ...base, cognateSeq: 'GGGG', targetTm: target });
    const withNoCognate = sizePbsLengthForTm({ ...base, cognateSeq: '', targetTm: target });
    expect(withGcCognate).toBe(withNoCognate);
  });

  it('end-to-end: computeDraftAssembly with a target Tm sizes primers closer to it than the fixed default', () => {
    const r0 = 'ATGCGTACCGGTTACGATCAGCATTAGCCGATCGTACGGATCAGTTAACGGCATCG';
    const r1 = 'GCATTAGCCGATCAGTACGGATCAGTTAACGGCATCGATGCGTACCGGTTACGATC';
    const design = ggDesign([pcrRegion('r0', r0), pcrRegion('r1', r1)]);

    const target = 58;
    const targeted = computeDraftAssembly(design, target).designPrimers;
    const fixed = computeDraftAssembly(design).designPrimers;

    expect(targeted.length).toBeGreaterThan(0);
    for (let i = 0; i < targeted.length; i++) {
      const targetedDiff = Math.abs(targeted[i].forward.tm - target);
      const fixedDiff = Math.abs(fixed[i].forward.tm - target);
      expect(targetedDiff).toBeLessThanOrEqual(fixedDiff + 0.001);
      expect(targetedDiff).toBeLessThan(4);
    }
  });

  it('uses the injected Tm calculator for Golden Gate PBS sizing and reported primer Tm', () => {
    const r0 = 'ATGCGTACCGGTTACGATCAGCATTAGCCGATCGTACGGATCAGTTAACGGCATCG';
    const r1 = 'GCATTAGCCGATCAGTACGGATCAGTTAACGGCATCGATGCGTACCGGTTACGATC';
    const design = ggDesign([pcrRegion('r0', r0), pcrRegion('r1', r1)]);
    const measured: string[] = [];
    const calculator: TmCalculator = {
      resolution: {
        model: { kind: 'local', algorithm: 'santalucia-owczarzy' },
        source: 'user-setting',
        reason: 'Test calculator whose estimate is the annealing-sequence length.',
      },
      estimate: (sequence) => {
        measured.push(sequence);
        return sequence.length;
      },
      estimateWithProvenance: (sequence) => ({
        tm: sequence.length,
        model: { kind: 'local', algorithm: 'santalucia-owczarzy' },
        source: 'user-setting',
        pendingNebVerification: false,
      }),
      compute: async (sequence) => ({
        tm: sequence.length,
        provenance: {
          source: 'local',
          tm: sequence.length,
          conc_nM: 500,
          verified: false,
        },
        verified: false,
      }),
    };

    const result = computeDraftAssembly(design, 24, calculator);

    expect(measured.length).toBeGreaterThan(result.designPrimers.length * 2);
    for (const pair of result.designPrimers) {
      for (const primer of [pair.forward, pair.reverse]) {
        expect(primer.tm).toBe(primer.pbs.sequence.length);
        expect(primer.tm).toBe(24);
      }
    }
    expect(result.tmResolution.source).toBe('user-setting');
  });

  it('reverse direction grows the PBS upstream toward the anchor', () => {
    const len = sizePbsLengthForTm({
      ...base,
      direction: 'reverse',
      anchor: TEMPLATE.length,
      targetTm: 58,
    });
    const pbs = reverseComplement(TEMPLATE.slice(TEMPLATE.length - len, TEMPLATE.length));
    expect(pbs.length).toBe(len);
    const here = Math.abs(estimateTm(pbs) - 58);
    if (len > 10) {
      const shorter = reverseComplement(
        TEMPLATE.slice(TEMPLATE.length - (len - 1), TEMPLATE.length)
      );
      expect(here).toBeLessThanOrEqual(Math.abs(estimateTm(shorter) - 58));
    }
  });
});
