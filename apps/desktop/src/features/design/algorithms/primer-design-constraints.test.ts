import { describe, expect, it } from 'vitest';
import { computeDraftAssembly } from './draft-assembly';
import { createTmCalculator } from './tm-service';
import { reverseComplement } from './utils';
import { primerRuleTemperatureStatus } from './primer-rule-temperature-status';
import { OWCZARZY_TM_MODEL } from './tm-model';
import type { DesignRegion, SequenceDesign } from '../types';

const sequence = 'ATGCGTACCGGTTACGATCGGCATTAGCCGATCGTACGGATCCGTTAACGGCATGCATGCATGCATGCAT';
const region = (id: string): DesignRegion => ({
  id,
  sourceSequenceId: id,
  sourceSequenceName: id,
  sourceStart: 0,
  sourceEnd: sequence.length,
  sequence,
  annotations: [],
  sourceType: 'pcr',
});
function design(): SequenceDesign {
  return {
    id: 'rules',
    name: 'rules',
    version: 0,
    regions: [region('a'), region('b')],
    spacers: [],
    topology: 'circular',
    assemblyMethod: 'gibson',
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('saved assembly primer rules', () => {
  it.each(['gibson', 'nebuilder'] as const)(
    'honours exact overlap and nearest PCR Tm for %s',
    (method) => {
      const input = {
        ...design(),
        assemblyMethod: method,
        primerDesignConstraints: { targetPcrTm: 65, overlapLength: 40 },
      };
      const result = computeDraftAssembly(input);
      const tm = createTmCalculator({});
      expect(result.homologyRegions).toHaveLength(2);
      for (const homology of result.homologyRegions)
        expect(homology.metadata?.sequence).toHaveLength(40);
      for (const pair of result.designPrimers) {
        for (const primer of [pair.forward, pair.reverse]) {
          const lengths = Array.from({ length: 51 }, (_, index) => index + 10);
          const candidates = lengths.map((length) =>
            tm.estimate(
              primer.direction === 'forward'
                ? sequence.slice(0, length)
                : reverseComplement(sequence.slice(-length))
            )
          );
          expect(Math.abs(primer.tm - 65)).toBeCloseTo(
            Math.min(...candidates.map((value) => Math.abs(value - 65))),
            8
          );
          expect(primer.pbs.sequence).toHaveLength(primer.pbs.end - primer.pbs.start);
        }
      }
    }
  );

  it('uses active Owczarzy conditions to select binding lengths on distinct templates', () => {
    const input = design();
    input.regions[1] = {
      ...region('b'),
      sequence: 'GGCATACGATATCCGCGCTTAGCGTTACCGATCGTACCCGATAGC'.repeat(2),
    };
    input.primerDesignConstraints = { targetPcrTm: 65, overlapLength: 40 };
    const tm = createTmCalculator({
      override: OWCZARZY_TM_MODEL,
      conditions: { monovalentMm: 100, divalentMm: 2, dntpMm: 0.2 },
    });
    const custom = computeDraftAssembly(input, undefined, tm);
    const baseline = computeDraftAssembly(input);
    expect(custom.tmResolution.model).toEqual(OWCZARZY_TM_MODEL);
    expect(
      custom.designPrimers.map((pair) => [
        pair.forward.pbs.sequence.length,
        pair.reverse.pbs.sequence.length,
      ])
    ).not.toEqual(
      baseline.designPrimers.map((pair) => [
        pair.forward.pbs.sequence.length,
        pair.reverse.pbs.sequence.length,
      ])
    );
    for (const pair of custom.designPrimers) {
      expect(pair.forward.tm).toBe(tm.estimate(pair.forward.pbs.sequence));
      expect(pair.reverse.tm).toBe(tm.estimate(pair.reverse.pbs.sequence));
    }
  });

  it('reports an unattainable target on short AT-rich templates without borrowing adjacent bases', () => {
    const input = design();
    input.regions = input.regions.map((value) => ({
      ...value,
      sequence: 'AT'.repeat(8),
      sourceEnd: 16,
    }));
    input.primerDesignConstraints = { targetPcrTm: 75, overlapLength: 15 };
    const draft = computeDraftAssembly(input);
    const status = primerRuleTemperatureStatus({ ...input, ...draft }, createTmCalculator());
    expect(status).toMatchObject({ target: 75, unreachable: 4, primerCount: 4 });
    expect(status?.maximum).toBeLessThan(75);
    for (const pair of draft.designPrimers) {
      expect(pair.forward.pbs.sequence.length).toBeLessThanOrEqual(16);
      expect(pair.reverse.pbs.sequence.length).toBeLessThanOrEqual(16);
      expect(pair.forward.pbs.sequence).toBe(
        input.regions[pair.fragmentIndex].sequence.slice(0, pair.forward.pbs.sequence.length)
      );
      expect(pair.reverse.pbs.sequence).toBe(
        reverseComplement(
          input.regions[pair.fragmentIndex].sequence.slice(-pair.reverse.pbs.sequence.length)
        )
      );
    }
  });

  it('keeps spacer cargo outside an exact RD-to-PCR overlap', () => {
    const input = design();
    input.topology = 'linear';
    input.regions[0] = { ...region('rd'), sourceType: 'rd' };
    input.spacers = [{ id: 'cargo', junctionIndex: 0, sequence: 'GGCC' }];
    input.primerDesignConstraints = { targetPcrTm: 65, overlapLength: 40 };
    const draft = computeDraftAssembly(input);
    const homology = draft.homologyRegions[0];
    expect(homology.encoding).toEqual({ onLeft: 40, onRight: 0 });
    expect(homology.metadata?.sequence).toBe(input.regions[0].sequence.slice(-40));
    expect(draft.designPrimers).toHaveLength(1);
    expect(draft.designPrimers[0].forward.overhang.sequence).toBe(
      input.regions[0].sequence.slice(-40) + 'GGCC'
    );
    input.regions[0] = { ...input.regions[0], sequence: 'ATGC'.repeat(9), sourceEnd: 36 };
    expect(() => computeDraftAssembly(input)).toThrow(/cannot supply.*40 bp overlap/);
  });

  it('targets the default PCR temperature without explicit rules', () => {
    const result = computeDraftAssembly(design());
    expect(Math.abs(result.designPrimers[0].forward.tm - 60)).toBeLessThan(2);
  });

  it('refuses impossible overlaps instead of wrapping across unrelated parts', () => {
    const input = design();
    input.regions = input.regions.map((value) => ({ ...value, sequence: 'ATGC', sourceEnd: 4 }));
    input.primerDesignConstraints = { targetPcrTm: 60, overlapLength: 40 };
    expect(() => computeDraftAssembly(input)).toThrow(/cannot supply.*40 bp overlap/);
  });

  it('rejects invalid persisted constraints', () => {
    expect(() =>
      computeDraftAssembly({
        ...design(),
        primerDesignConstraints: { targetPcrTm: NaN, overlapLength: 30 },
      })
    ).toThrow(/Primer rules/);
  });
});
