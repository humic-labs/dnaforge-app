// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AssemblyOptimizationGoldenGateJunctionInput,
  AssemblyOptimizationInput,
} from '../assembly/assembly-optimization-input';
import {
  getGoldenGateFidelityDataset,
  scoreGoldenGateOverhangSet,
  type GoldenGateFidelityDataset,
  type GoldenGateSetFidelityScore,
} from './golden-gate-fidelity/GoldenGateFidelityDataset';
import {
  clearGoldenGateAutoOptimizationCacheForTesting,
  goldenGateAutoOptimizationCacheStatsForTesting,
  planGoldenGateAutoOptimization,
  type GoldenGateOptimizationCombination,
  type GoldenGateOptimizationJunctionChoice,
} from './AssemblyWorkbenchAutoOptimizer';
import { goldenGateOffsetLimitBp } from './AssemblyWorkbenchContract';

describe('AssemblyWorkbenchAutoOptimizer', () => {
  beforeEach(() => {
    clearGoldenGateAutoOptimizationCacheForTesting();
  });

  it.each([
    {
      name: 'single editable PCR junction',
      input: () => {
        const productSequence = deBruijnDna4();
        return optimizationInput({
          productSequence,
          offsetLimit: 3,
          junctions: [pcrJunction(productSequence, 0, 48, 0)],
        });
      },
    },
    {
      name: 'three editable PCR junctions',
      input: () => {
        const productSequence = deBruijnDna4();
        return optimizationInput({
          productSequence,
          offsetLimit: 2,
          junctions: [
            pcrJunction(productSequence, 0, 48, 0),
            pcrJunction(productSequence, 1, 96, 0),
            pcrJunction(productSequence, 2, 148, 0),
          ],
        });
      },
    },
    {
      name: 'editable PCR junctions around a locked RD-matched junction',
      input: () => {
        const productSequence = deBruijnDna4();
        return optimizationInput({
          productSequence,
          offsetLimit: 3,
          junctions: [
            pcrJunction(productSequence, 0, 48, 0),
            lockedJunction(1, 96, -7, 'GGAG'),
            pcrJunction(productSequence, 2, 148, 0),
          ],
        });
      },
    },
    {
      name: 'circular overhang windows crossing the product origin',
      input: () => {
        const productSequence = deBruijnDna4();
        return optimizationInput({
          productSequence,
          offsetLimit: 2,
          junctions: [
            pcrJunction(productSequence, 0, 1, 0),
            pcrJunction(productSequence, 1, productSequence.length - 1, 0),
          ],
        });
      },
    },
  ])('matches an independent exhaustive Golden Gate oracle for $name', ({ input: buildInput }) => {
    const input = buildInput();
    const dataset = getGoldenGateFidelityDataset('BsaI-HFv2');
    const expectedRows = expectedOptimizedChoiceSets(input, dataset);

    const plan = planGoldenGateAutoOptimization(input, {
      maxExactSearchNodes: 50_000,
      topCombinationCount: expectedRows.length + 1,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    expect(plan.exhaustive).toBe(true);
    expect(plan.topCombinations[0]?.rank).toBe(0);
    expect(plan.topCombinations[0]?.changedCount).toBe(0);
    expect(plan.topCombinations[0]?.choices.map(choiceKey)).toEqual(
      input.goldenGate!.junctions.map((junction) =>
        [
          junction.junctionIndex,
          junction.offset,
          junction.overhang,
          junction.source.type === 'pcr-designed' ? 'E' : 'L',
        ].join(':')
      )
    );

    const optimizedRows = plan.topCombinations.slice(1);
    expect(optimizedRows).toHaveLength(expectedRows.length);
    expect(new Set(optimizedRows.map(combinationKey))).toEqual(
      new Set(expectedRows.map(choiceSetKey))
    );
    if (expectedRows.length > 0) {
      expect(choiceSetKey(optimizedRows[0].choices)).toBe(choiceSetKey(expectedRows[0]));
    }
  });

  it('solves a real-scale 4-junction Golden Gate search EXACTLY and fast via branch-and-bound', () => {
    const productSequence = deBruijnDna4();
    const input = optimizationInput({
      productSequence,
      offsetLimit: 6,
      junctions: [
        pcrJunction(productSequence, 0, 40, 0),
        pcrJunction(productSequence, 1, 100, 0),
        pcrJunction(productSequence, 2, 160, 0),
        pcrJunction(productSequence, 3, 220, 0),
      ],
    });

    const start = performance.now();
    const plan = planGoldenGateAutoOptimization(input, { topCombinationCount: 8 });
    const elapsedMs = performance.now() - start;

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    expect(plan.exhaustive).toBe(true);
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('includes the circular-closure (product-end) junction in every optimized combination ', () => {
    const uniqueFourBaseWindows = deBruijnDna4();
    const regionSequences = [
      uniqueFourBaseWindows.slice(0, 80),
      uniqueFourBaseWindows.slice(80, 160),
      uniqueFourBaseWindows.slice(160, 240),
    ];
    const productSequence = regionSequences.join('');
    const lastJunctionIndex = regionSequences.length - 1;
    const input: AssemblyOptimizationInput = {
      ...optimizationInput({
        productSequence,
        offsetLimit: 3,
        junctions: [
          pcrJunction(productSequence, 0, regionSequences[0].length, 0),
          pcrJunction(productSequence, 1, regionSequences[0].length + regionSequences[1].length, 0),
          pcrJunction(productSequence, lastJunctionIndex, productSequence.length, 0),
        ],
      }),
      topology: 'circular',
      regions: regionSequences.map((sequence, fragmentIndex) => ({
        id: `r${fragmentIndex + 1}`,
        sourceSequenceId: `source-${fragmentIndex + 1}`,
        sourceType: 'pcr',
        sourceStart: 0,
        sourceEnd: sequence.length,
        sequence,
      })),
    };

    const plan = planGoldenGateAutoOptimization(input, {
      topCombinationCount: 8,
      maxExactSearchNodes: 50_000,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    expect(plan.exhaustive).toBe(true);
    expect(plan.topCombinations.length).toBeGreaterThan(1);

    const lastOffsets = new Set<number>();
    for (const combination of plan.topCombinations) {
      expect(combination.choices.map((choice) => choice.junctionIndex)).toEqual([0, 1, 2]);
      const lastChoice = choiceByJunction(combination, lastJunctionIndex);
      expect(lastChoice.overhang).toBe(
        circularSequenceSlice(productSequence, productSequence.length - 2 + lastChoice.offset, 4)
      );
      lastOffsets.add(lastChoice.offset);
    }
    expect(lastOffsets.size).toBeGreaterThan(1);
  });

  it('returns the BEST combinations found so far when a search exceeds the node budget — never a search-limit error  regression)', () => {
    const productSequence = deBruijnDna4();
    const input = optimizationInput({
      productSequence,
      offsetLimit: 24,
      junctions: [
        pcrJunction(productSequence, 0, 40, 0),
        pcrJunction(productSequence, 1, 100, 0),
        pcrJunction(productSequence, 2, 160, 0),
        pcrJunction(productSequence, 3, 220, 0),
      ],
    });

    const plan = planGoldenGateAutoOptimization(input, {
      topCombinationCount: 8,
      maxExactSearchNodes: 5_000,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') {
      throw new Error(`optimizer must not error on a budget-limited search (got ${plan.status})`);
    }
    expect(plan.topCombinations.length).toBeGreaterThan(1);
    expect(plan.exhaustive).toBe(false);
    for (const combination of plan.topCombinations) {
      expect(combination.choices.map((choice) => choice.junctionIndex)).toEqual([0, 1, 2, 3]);
    }
  });

  it('searches every configured Golden Gate offset for editable junctions and keeps RD-matched junctions locked', () => {
    const productSequence = deBruijnDna4();
    const offsetLimit = 4;
    const input = optimizationInput({
      productSequence,
      offsetLimit,
      junctions: [
        pcrJunction(productSequence, 0, 48, 0),
        lockedJunction(1, 96, -7, 'GGAG'),
        pcrJunction(productSequence, 2, 148, 0),
      ],
    });
    const dataset = getGoldenGateFidelityDataset('BsaI-HFv2');
    const expectedRows = expectedOptimizedChoiceSets(input, dataset);

    const plan = planGoldenGateAutoOptimization(input, {
      maxExactSearchNodes: 20_000,
      topCombinationCount: 200,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    expect(plan.exhaustive).toBe(true);
    expect(plan.topCombinations[0]?.rank).toBe(0);
    expect(plan.topCombinations[0]?.changedCount).toBe(0);

    const optimizedRows = plan.topCombinations.slice(1);
    expect(optimizedRows).toHaveLength(expectedRows.length);
    expect(new Set(optimizedRows.map(combinationKey))).toEqual(
      new Set(expectedRows.map(choiceSetKey))
    );

    for (const junctionIndex of [0, 2]) {
      const offsets = new Set(
        optimizedRows.map((row) => choiceByJunction(row, junctionIndex).offset)
      );
      expect([...offsets].sort((a, b) => a - b)).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
      for (const row of optimizedRows) {
        const choice = choiceByJunction(row, junctionIndex);
        const junction = input.goldenGate!.junctions.find(
          (candidate) => candidate.junctionIndex === junctionIndex
        )!;
        expect(choice.overhang).toBe(
          circularSequenceSlice(productSequence, junction.junctionPosition - 2 + choice.offset, 4)
        );
        expect(choice.locked).toBe(false);
      }
    }

    for (const row of optimizedRows) {
      const lockedChoice = choiceByJunction(row, 1);
      expect(lockedChoice.locked).toBe(true);
      expect(lockedChoice.offset).toBe(-7);
      expect(lockedChoice.overhang).toBe('GGAG');
    }
  });

  it.each([
    {
      name: 'linear forward primer',
      topology: 'linear' as const,
      spacerSequence: '',
      junctionIndex: 0,
      junctionPosition: 36,
      constraints: [
        { fragmentIndex: 1, regionId: 'r2', direction: 'forward' as const, length: 34 },
      ],
      expectedOffsets: [-6, -5, -4, -3, -2, -1, 0],
    },
    {
      name: 'linear spacer with both adjacent primers constrained',
      topology: 'linear' as const,
      spacerSequence: 'GCTA',
      junctionIndex: 0,
      junctionPosition: 40,
      constraints: [
        { fragmentIndex: 0, regionId: 'r1', direction: 'reverse' as const, length: 36 },
        { fragmentIndex: 1, regionId: 'r2', direction: 'forward' as const, length: 34 },
      ],
      expectedOffsets: [-2, -1, 0],
    },
    {
      name: 'circular closure without a spacer',
      topology: 'circular' as const,
      spacerSequence: '',
      junctionIndex: 1,
      junctionPosition: 72,
      constraints: [
        { fragmentIndex: 1, regionId: 'r2', direction: 'reverse' as const, length: 33 },
        { fragmentIndex: 0, regionId: 'r1', direction: 'forward' as const, length: 33 },
      ],
      expectedOffsets: [-1, 0, 1],
    },
    {
      name: 'circular closure with a spacer',
      topology: 'circular' as const,
      spacerSequence: 'GCTA',
      junctionIndex: 1,
      junctionPosition: 76,
      constraints: [
        { fragmentIndex: 1, regionId: 'r2', direction: 'reverse' as const, length: 36 },
        { fragmentIndex: 0, regionId: 'r1', direction: 'forward' as const, length: 34 },
      ],
      expectedOffsets: [-2, -1, 0],
    },
  ])(
    'offers exactly the PBS-preserving offsets for $name',
    ({
      topology,
      spacerSequence,
      junctionIndex,
      junctionPosition,
      constraints,
      expectedOffsets,
    }) => {
      const uniqueFourBaseWindows = deBruijnDna4();
      const regionSequences = [
        uniqueFourBaseWindows.slice(0, 36),
        uniqueFourBaseWindows.slice(36, 72),
      ];
      const spacers =
        spacerSequence.length > 0
          ? [{ id: 'closure-or-linear-spacer', junctionIndex, sequence: spacerSequence }]
          : [];
      const productSequence =
        topology === 'circular' && junctionIndex === 1
          ? `${regionSequences[0]}${regionSequences[1]}${spacerSequence}`
          : `${regionSequences[0]}${spacerSequence}${regionSequences[1]}`;
      const input: AssemblyOptimizationInput = {
        ...optimizationInput({
          productSequence,
          offsetLimit: 6,
          junctions: [pcrJunction(productSequence, junctionIndex, junctionPosition, 0)],
        }),
        topology,
        regions: regionSequences.map((sequence, fragmentIndex) => ({
          id: `r${fragmentIndex + 1}`,
          sourceSequenceId: `source-${fragmentIndex + 1}`,
          sourceType: 'pcr' as const,
          sourceStart: 0,
          sourceEnd: sequence.length,
          sequence,
        })),
        spacers,
        primerPbsConstraints: constraints,
      };

      const plan = planGoldenGateAutoOptimization(input, {
        scopeJunctionIndex: junctionIndex,
        topCombinationCount: 100,
      });

      expect(plan.status).toBe('planned');
      if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
      const offeredOffsets = new Set(
        plan.topCombinations.map(
          (combination) => choiceByJunction(combination, junctionIndex).offset
        )
      );
      expect([...offeredOffsets].sort((left, right) => left - right)).toEqual(expectedOffsets);
    }
  );

  it('optimizes only the scoped Golden Gate junction and leaves all other choices at current values', () => {
    const productSequence = deBruijnDna4();
    const input = optimizationInput({
      productSequence,
      offsetLimit: 3,
      junctions: [
        pcrJunction(productSequence, 0, 48, 0),
        pcrJunction(productSequence, 1, 96, 0),
        pcrJunction(productSequence, 2, 148, 0),
      ],
    });
    const dataset = getGoldenGateFidelityDataset('BsaI-HFv2');
    const expectedRows = expectedOptimizedChoiceSetsForScope(input, dataset, 1);

    const plan = planGoldenGateAutoOptimization(input, {
      scopeJunctionIndex: 1,
      topCombinationCount: expectedRows.length + 1,
      maxExactSearchNodes: 50_000,
      candidateRank: 1,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    const optimizedRows = plan.topCombinations.slice(1);
    expect(new Set(optimizedRows.map(combinationKey))).toEqual(
      new Set(expectedRows.map(choiceSetKey))
    );
    for (const row of optimizedRows) {
      expect(choiceByJunction(row, 0).offset).toBe(0);
      expect(choiceByJunction(row, 2).offset).toBe(0);
    }
    expect([...plan.offsetsByJunctionIndex.keys()]).toEqual([1]);
  });

  it('returns a manual-only plan when every Golden Gate junction is RD-locked', () => {
    const productSequence = deBruijnDna4();
    const input = optimizationInput({
      productSequence,
      offsetLimit: 6,
      junctions: [
        lockedJunction(0, 48, -2, 'GGAG'),
        lockedJunction(1, 96, 4, 'TGAC'),
        lockedJunction(2, 148, 0, 'TCCC'),
      ],
    });

    const plan = planGoldenGateAutoOptimization(input, {
      topCombinationCount: 8,
      maxExactSearchNodes: 50_000,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    expect(plan.exhaustive).toBe(true);
    expect(plan.selectedRank).toBe(0);
    expect(plan.offsetsByJunctionIndex.size).toBe(0);
    expect(plan.topCombinations).toHaveLength(1);
    expect(plan.topCombinations[0].choices.map((choice) => choice.locked)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('does not expose optimized rows when topCombinationCount only has room for the manual row', () => {
    const productSequence = deBruijnDna4();
    const input = optimizationInput({
      productSequence,
      offsetLimit: 4,
      junctions: [pcrJunction(productSequence, 0, 48, 0), pcrJunction(productSequence, 1, 96, 0)],
    });

    const plan = planGoldenGateAutoOptimization(input, {
      topCombinationCount: 1,
      maxExactSearchNodes: 50_000,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    expect(plan.topCombinations).toHaveLength(1);
    expect(plan.selectedRank).toBe(0);
    expect(plan.offsetsByJunctionIndex.size).toBe(0);
  });

  it('breaks paper-fidelity ties by on-target ligation count so later display rows are not quality-better than rank 1', () => {
    const productSequence = deBruijnDna4();
    const input = optimizationInput({
      productSequence,
      offsetLimit: 6,
      junctions: [pcrJunction(productSequence, 0, 96, 0)],
    });

    const plan = planGoldenGateAutoOptimization(input, {
      topCombinationCount: 4,
      maxExactSearchNodes: 50_000,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    const firstOptimized = plan.topCombinations[1];
    for (const combination of plan.topCombinations.slice(2)) {
      const betterFidelity =
        combination.fidelity.fidelity - firstOptimized.fidelity.fidelity > 1e-12;
      const betterOnTarget =
        Math.abs(combination.fidelity.fidelity - firstOptimized.fidelity.fidelity) <= 1e-12 &&
        combination.fidelity.onTargetCount > firstOptimized.fidelity.onTargetCount;
      expect(betterFidelity || betterOnTarget).toBe(false);
    }
  });

  it('clamps explicit Golden Gate candidate ranks to a visible exact-scored row', () => {
    const productSequence = deBruijnDna4();
    const input = optimizationInput({
      productSequence,
      offsetLimit: 3,
      junctions: [pcrJunction(productSequence, 0, 48, 0), pcrJunction(productSequence, 1, 96, 0)],
    });

    const plan = planGoldenGateAutoOptimization(input, {
      topCombinationCount: 4,
      candidateRank: 999,
      maxExactSearchNodes: 50_000,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    expect(plan.selectedRank).toBe(plan.topCombinations.length - 1);
    expect([...plan.offsetsByJunctionIndex.entries()]).toEqual([
      ...plan.topCombinations.at(-1)!.offsetsByJunctionIndex.entries(),
    ]);
  });

  it('rejects unsupported Golden Gate enzymes instead of falling back to the wrong dataset', () => {
    const productSequence = deBruijnDna4();
    const baseInput = optimizationInput({
      productSequence,
      offsetLimit: 4,
      junctions: [pcrJunction(productSequence, 0, 48, 0)],
    });
    const input: AssemblyOptimizationInput = {
      ...baseInput,
      goldenGate: {
        ...baseInput.goldenGate!,
        enzyme: 'SapI',
      },
    };

    const plan = planGoldenGateAutoOptimization(input);

    expect(plan.status).toBe('unavailable');
    if (plan.status !== 'unavailable') throw new Error('Expected unavailable optimizer plan.');
    expect(plan.reason).toBe('no-four-base-dataset');
    expect(plan.offsetsByJunctionIndex.size).toBe(0);
  });

  it('keeps the best exact Golden Gate solution first but diversifies visible rows across every editable junction', () => {
    const input = prefixDominatedOptimizationInput();
    const dataset = getGoldenGateFidelityDataset('BsaI-HFv2');
    const exactRows = expectedOptimizedChoiceSets(input, dataset);

    const plan = planGoldenGateAutoOptimization(input, {
      topCombinationCount: 8,
      maxExactSearchNodes: 20_000,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan.');
    expect(plan.topCombinations).toHaveLength(8);
    expect(choiceSetKey(plan.topCombinations[1].choices)).toBe(choiceSetKey(exactRows[0]));

    const visibleOptimizedRows = plan.topCombinations.slice(1).map((row) => row.choices);
    const best = visibleOptimizedRows[0];
    for (const junctionIndex of [0, 1, 2]) {
      expect(
        visibleOptimizedRows.some(
          (row) =>
            choiceByJunctionChoices(row, junctionIndex).offset !==
            choiceByJunctionChoices(best, junctionIndex).offset
        )
      ).toBe(true);
    }
  });

  it('returns the best partial result (NOT an error) when exact enumeration exceeds the node budget', () => {
    const productSequence = deBruijnDna4().repeat(2);
    const input = optimizationInput({
      productSequence,
      offsetLimit: 4,
      junctions: [
        pcrJunction(productSequence, 0, 48, 0),
        pcrJunction(productSequence, 1, 96, 0),
        pcrJunction(productSequence, 2, 148, 0),
      ],
    });

    const plan = planGoldenGateAutoOptimization(input, {
      topCombinationCount: 8,
      maxExactSearchNodes: 10,
    });

    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned')
      throw new Error('optimizer must not error on a budget-limited search');
    expect(plan.exhaustive).toBe(false);
    expect(plan.topCombinations.length).toBeGreaterThanOrEqual(1);
  });

  it('reuses the exact search when arrowing candidate ranks or manually changing current offsets without changing assembly geometry', () => {
    const productSequence = deBruijnDna4();
    const input = optimizationInput({
      productSequence,
      offsetLimit: 4,
      junctions: [
        pcrJunction(productSequence, 0, 48, 0),
        pcrJunction(productSequence, 1, 96, 0),
        pcrJunction(productSequence, 2, 148, 0),
      ],
    });

    const firstPlan = planGoldenGateAutoOptimization(input, { topCombinationCount: 8 });
    expect(firstPlan.status).toBe('planned');
    expect(goldenGateAutoOptimizationCacheStatsForTesting()).toEqual({
      entries: 1,
      hits: 0,
      misses: 1,
    });

    const rankedPlan = planGoldenGateAutoOptimization(input, {
      topCombinationCount: 8,
      candidateRank: 2,
    });
    expect(rankedPlan.status).toBe('planned');
    expect(goldenGateAutoOptimizationCacheStatsForTesting()).toEqual({
      entries: 1,
      hits: 1,
      misses: 1,
    });

    const manuallyShiftedInput: AssemblyOptimizationInput = {
      ...input,
      goldenGate: {
        ...input.goldenGate!,
        junctions: input.goldenGate!.junctions.map((junction) =>
          junction.source.type === 'pcr-designed'
            ? pcrJunction(productSequence, junction.junctionIndex, junction.junctionPosition, 1)
            : junction
        ),
      },
    };
    const shiftedPlan = planGoldenGateAutoOptimization(manuallyShiftedInput, {
      topCombinationCount: 8,
      candidateRank: 1,
    });

    expect(shiftedPlan.status).toBe('planned');
    expect(goldenGateAutoOptimizationCacheStatsForTesting()).toEqual({
      entries: 1,
      hits: 2,
      misses: 1,
    });
    if (firstPlan.status !== 'planned' || shiftedPlan.status !== 'planned') {
      throw new Error('Expected planned Golden Gate optimizer plans.');
    }
    expect(shiftedPlan.topCombinations.slice(1).map(combinationKey)).toEqual(
      firstPlan.topCombinations.slice(1).map(combinationKey)
    );
    expect(shiftedPlan.topCombinations[0]?.choices.map((choice) => choice.offset)).toEqual([
      1, 1, 1,
    ]);
  });

  it('keeps PCR-designed optimized rows stable after manual offset edits even on a cold cache', () => {
    const productSequence = deBruijnDna4();
    const input = optimizationInput({
      productSequence,
      offsetLimit: 4,
      junctions: [
        pcrJunction(productSequence, 0, 48, 0),
        pcrJunction(productSequence, 1, 96, 0),
        pcrJunction(productSequence, 2, 148, 0),
      ],
    });
    const manuallyShiftedInput: AssemblyOptimizationInput = {
      ...input,
      goldenGate: {
        ...input.goldenGate!,
        junctions: input.goldenGate!.junctions.map((junction) =>
          pcrJunction(productSequence, junction.junctionIndex, junction.junctionPosition, 2)
        ),
      },
    };

    const baseline = planGoldenGateAutoOptimization(input, { topCombinationCount: 8 });
    expect(baseline.status).toBe('planned');
    clearGoldenGateAutoOptimizationCacheForTesting();
    const shiftedCold = planGoldenGateAutoOptimization(manuallyShiftedInput, {
      topCombinationCount: 8,
    });

    expect(shiftedCold.status).toBe('planned');
    if (baseline.status !== 'planned' || shiftedCold.status !== 'planned') {
      throw new Error('Expected Golden Gate optimizer plans.');
    }
    expect(shiftedCold.topCombinations.slice(1).map(combinationKey)).toEqual(
      baseline.topCombinations.slice(1).map(combinationKey)
    );
    expect(shiftedCold.topCombinations[0]?.choices.map((choice) => choice.offset)).toEqual([
      2, 2, 2,
    ]);
  });
});

type ChoiceSet = GoldenGateOptimizationJunctionChoice[];

function optimizationInput({
  productSequence,
  offsetLimit,
  junctions,
}: {
  productSequence: string;
  offsetLimit: number;
  junctions: AssemblyOptimizationGoldenGateJunctionInput[];
}): AssemblyOptimizationInput {
  return {
    schemaVersion: 2,
    optimizationFingerprint: `test-golden-gate:${productSequence.length}:${offsetLimit}:${junctions
      .map(
        (junction) =>
          `${junction.junctionIndex}:${junction.junctionPosition}:${junction.source.type}`
      )
      .join(',')}`,
    method: 'goldengate',
    topology: 'linear',
    productSequence,
    regions: [],
    spacers: [],
    primerPbsConstraints: [],
    homologyRegions: [],
    goldenGate: {
      enzyme: 'BsaI',
      offsetLimitBp: offsetLimit,
      junctions,
    },
  };
}

function expectedCombinations(
  input: AssemblyOptimizationInput,
  scopeJunctionIndex: number | null = null
): ChoiceSet[] {
  const offsetLimit = goldenGateOffsetLimitBp(input.goldenGate);
  const candidatesByJunction = input.goldenGate!.junctions.map((junction) => {
    if (
      junction.source.type !== 'pcr-designed' ||
      (scopeJunctionIndex !== null && junction.junctionIndex !== scopeJunctionIndex)
    ) {
      return [
        {
          junctionIndex: junction.junctionIndex,
          offset: junction.offset,
          overhang: junction.overhang,
          locked: true,
          movement: 0,
        },
      ];
    }
    return Array.from({ length: offsetLimit * 2 + 1 }, (_, index) => {
      const offset = index - offsetLimit;
      return {
        junctionIndex: junction.junctionIndex,
        offset,
        overhang: circularSequenceSlice(
          input.productSequence,
          junction.junctionPosition - 2 + offset,
          4
        ),
        locked: false,
        movement: Math.abs(offset),
      };
    });
  });
  return cartesian(candidatesByJunction);
}

function expectedOptimizedChoiceSets(
  input: AssemblyOptimizationInput,
  dataset: GoldenGateFidelityDataset
): ChoiceSet[] {
  return expectedOptimizedChoiceSetsForScope(input, dataset, null);
}

function expectedOptimizedChoiceSetsForScope(
  input: AssemblyOptimizationInput,
  dataset: GoldenGateFidelityDataset,
  scopeJunctionIndex: number | null
): ChoiceSet[] {
  const currentKey = choiceSetKey(currentChoiceSet(input, scopeJunctionIndex));
  return expectedCombinations(input, scopeJunctionIndex)
    .filter((choices) => choiceSetKey(choices) !== currentKey)
    .sort((left, right) => -compareChoiceSets(left, right, dataset));
}

function currentChoiceSet(
  input: AssemblyOptimizationInput,
  scopeJunctionIndex: number | null
): ChoiceSet {
  return input.goldenGate!.junctions.map((junction) => ({
    junctionIndex: junction.junctionIndex,
    offset: junction.offset,
    overhang: junction.overhang,
    locked:
      junction.source.type !== 'pcr-designed' ||
      (scopeJunctionIndex !== null && junction.junctionIndex !== scopeJunctionIndex),
    movement: 0,
  }));
}

function prefixDominatedOptimizationInput(): AssemblyOptimizationInput {
  const productSequence =
    'acggactgagccgtattcggaaacaggccttactcgcttgttacgacagtcatatacacatcagttaattccgtgccatggggacgtctcttcccaggcctcacgacaatgggtcctggcgattaagagcccagtggtcgtctggaagtaataccctcaagggccagatggcgagccgttttctagaaagcgtctcgagccaaatcggcctactccgtcgagatcccaacttatggctcgacggcgggtttttcgcaccg';
  return optimizationInput({
    productSequence,
    offsetLimit: 6,
    junctions: [
      pcrJunction(productSequence, 0, 71, 0),
      pcrJunction(productSequence, 1, 135, 0),
      pcrJunction(productSequence, 2, 218, 0),
    ],
  });
}

function cartesian<T>(sets: T[][]): T[][] {
  return sets.reduce<T[][]>(
    (rows, set) => rows.flatMap((row) => set.map((item) => [...row, item])),
    [[]]
  );
}

function pcrJunction(
  productSequence: string,
  junctionIndex: number,
  junctionPosition: number,
  offset: number
): AssemblyOptimizationGoldenGateJunctionInput {
  const overhangStart = junctionPosition - 2 + offset;
  return {
    junctionIndex,
    junctionPosition,
    offset,
    overhangStart,
    overhangEnd: overhangStart + 4,
    overhang: circularSequenceSlice(productSequence, overhangStart, 4),
    source: { type: 'pcr-designed' },
  };
}

function lockedJunction(
  junctionIndex: number,
  junctionPosition: number,
  offset: number,
  overhang: string
): AssemblyOptimizationGoldenGateJunctionInput {
  const overhangStart = junctionPosition - 2 + offset;
  return {
    junctionIndex,
    junctionPosition,
    offset,
    overhangStart,
    overhangEnd: overhangStart + 4,
    overhang,
    source: { type: 'pcr-matched-rd', matchedRegionIndex: junctionIndex },
  };
}

function choiceByJunction(
  row: GoldenGateOptimizationCombination,
  junctionIndex: number
): GoldenGateOptimizationJunctionChoice {
  const choice = row.choices.find((candidate) => candidate.junctionIndex === junctionIndex);
  if (!choice) throw new Error(`Missing choice for junction ${junctionIndex}.`);
  return choice;
}

function choiceByJunctionChoices(
  row: readonly GoldenGateOptimizationJunctionChoice[],
  junctionIndex: number
): GoldenGateOptimizationJunctionChoice {
  const choice = row.find((candidate) => candidate.junctionIndex === junctionIndex);
  if (!choice) throw new Error(`Missing choice for junction ${junctionIndex}.`);
  return choice;
}

function combinationKey(combination: GoldenGateOptimizationCombination): string {
  return choiceSetKey(combination.choices);
}

function choiceKey(choice: GoldenGateOptimizationJunctionChoice): string {
  return `${choice.junctionIndex}:${choice.offset}:${choice.overhang}:${choice.locked ? 'L' : 'E'}`;
}

function choiceSetKey(choices: readonly GoldenGateOptimizationJunctionChoice[]): string {
  return choices.map(choiceKey).join('|');
}

function compareChoiceSets(
  left: readonly GoldenGateOptimizationJunctionChoice[],
  right: readonly GoldenGateOptimizationJunctionChoice[],
  dataset: GoldenGateFidelityDataset
): number {
  const leftScore = scoreChoiceSet(left, dataset);
  const rightScore = scoreChoiceSet(right, dataset);
  if (leftScore.valid !== rightScore.valid) return leftScore.valid ? 1 : -1;
  const conflictDelta = rightScore.conflicts.length - leftScore.conflicts.length;
  if (conflictDelta !== 0) return conflictDelta;
  const logDelta = leftScore.logFidelity - rightScore.logFidelity;
  if (Math.abs(logDelta) > 1e-12) return logDelta > 0 ? 1 : -1;
  const onTargetDelta = leftScore.onTargetCount - rightScore.onTargetCount;
  if (onTargetDelta !== 0) return onTargetDelta;
  const movementDelta = choiceSetTotalMovement(right) - choiceSetTotalMovement(left);
  if (movementDelta !== 0) return movementDelta;
  const changedDelta = choiceSetChangedCount(right) - choiceSetChangedCount(left);
  if (changedDelta !== 0) return changedDelta;
  return -candidateOffsetLexicographicCompare(left, right);
}

function choiceSetTotalMovement(choices: readonly GoldenGateOptimizationJunctionChoice[]): number {
  return choices.reduce((total, choice) => total + choice.movement, 0);
}

function choiceSetChangedCount(choices: readonly GoldenGateOptimizationJunctionChoice[]): number {
  return choices.filter((choice) => choice.movement > 0).length;
}

function scoreChoiceSet(
  choices: readonly GoldenGateOptimizationJunctionChoice[],
  dataset: GoldenGateFidelityDataset
): GoldenGateSetFidelityScore {
  return scoreGoldenGateOverhangSet(
    choices.map((choice) => choice.overhang),
    dataset
  );
}

function candidateOffsetLexicographicCompare(
  left: readonly GoldenGateOptimizationJunctionChoice[],
  right: readonly GoldenGateOptimizationJunctionChoice[]
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const delta = left[index].offset - right[index].offset;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

function circularSequenceSlice(sequence: string, start: number, length: number): string {
  let result = '';
  for (let index = 0; index < length; index++) {
    const pos = (((start + index) % sequence.length) + sequence.length) % sequence.length;
    result += sequence[pos];
  }
  return result;
}

function deBruijnDna4(): string {
  const alphabet = ['A', 'C', 'G', 'T'];
  const subsequence: number[] = [];
  const work = new Array(alphabet.length * 4).fill(0);

  function db(t: number, p: number): void {
    if (t > 4) {
      if (4 % p === 0) {
        for (let index = 1; index <= p; index++) subsequence.push(work[index]);
      }
      return;
    }
    work[t] = work[t - p];
    db(t + 1, p);
    for (let j = work[t - p] + 1; j < alphabet.length; j++) {
      work[t] = j;
      db(t + 1, t);
    }
  }

  db(1, 1);
  return subsequence.map((index) => alphabet[index]).join('');
}
