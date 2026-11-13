import { describe, expect, it } from 'vitest';
import { validateGoldenGateAssembly } from './validation/golden-gate-overhangs';
import { computeDraftAssembly } from './algorithms/draft-assembly';
import { getComposedSequenceForDesign, getRegionEffectiveSequence } from './restriction-digest';
import type { DesignPrimerPair, SequenceDesign } from './types';
import {
  REAL_ASSEMBLY_PIPELINE_SCENARIOS,
  REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID,
  realAssemblyPipelineFixtures,
} from '../../test/scenarios/assembly-real-pipeline';

describe('real assembly pipeline scenario catalog', () => {
  it('uses only the real pUC19 fixture as the source substrate', () => {
    expect(realAssemblyPipelineFixtures.puc19.source).toBe(
      'test-fixtures/sequences/circular/pUC19.gb'
    );
    expect(realAssemblyPipelineFixtures.puc19.parsed.sequence.length).toBeGreaterThan(2000);
    expect(realAssemblyPipelineFixtures.puc19.parsed.annotations.length).toBeGreaterThan(0);

    for (const scenario of REAL_ASSEMBLY_PIPELINE_SCENARIOS) {
      const design = scenario.buildDesign();

      expect(design.regions.length).toBeGreaterThan(0);
      for (const region of design.regions) {
        expect(region.sourceSequenceId).toBe(REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID);
        expect(region.sequence).toMatch(/^[ACGT]+$/);
        expect(region.sequence.length).toBeGreaterThan(0);
      }

      for (const spacer of design.spacers ?? []) {
        expect(spacer.sequence).toMatch(/^[ACGT]+$/);
        expect(spacer.name).toContain(realAssemblyPipelineFixtures.puc19.label);
      }
    }
  });

  it.each(REAL_ASSEMBLY_PIPELINE_SCENARIOS)(
    '$id matches its declared source, spacer, draft, and validation facts',
    (scenario) => {
      const design = scenario.buildDesign();
      const composedSequence = getComposedSequenceForDesign(design);

      expect(design.assemblyMethod).toBe(scenario.expected.method);
      expect(design.topology).toBe('circular');
      expect(design.regions.map((region) => region.sourceType ?? 'pcr')).toEqual(
        scenario.expected.regionSourceTypes
      );
      expect((design.spacers ?? []).map((spacer) => spacer.sequence)).toEqual(
        scenario.expected.spacerSequences
      );
      expect(composedSequence.length).toBe(expectedComposedSequenceLength(design));
      for (const spacerSequence of scenario.expected.spacerSequences) {
        expect(composedSequence).toContain(spacerSequence);
      }
      if (scenario.expected.rdEndTypesByRegion) {
        scenario.expected.rdEndTypesByRegion.forEach((expectedType, regionIndex) => {
          if (!expectedType) return;
          expect(design.regions[regionIndex].rdEnds?.upstream?.overhangType).toBe(expectedType);
          expect(design.regions[regionIndex].rdEnds?.downstream?.overhangType).toBe(expectedType);
        });
      }
      if (scenario.expected.gibsonTrimByRegion) {
        expect(
          design.regions.map(
            (region) => region.sequence.length - getRegionEffectiveSequence(region, 'gibson').length
          )
        ).toEqual(scenario.expected.gibsonTrimByRegion);
      }
      if (scenario.expected.expectedValidationErrorCodes) {
        expect(design.validationErrors.map((error) => error.code)).toEqual(
          expect.arrayContaining(scenario.expected.expectedValidationErrorCodes)
        );
      }

      if (design.assemblyMethod === 'goldengate') {
        const validation = validateGoldenGateAssembly(
          design.regions,
          design.topology === 'circular',
          design.goldenGateConfig?.enzyme ?? 'BsaI'
        );
        expect(validation.isValid).toBe(
          scenario.expected.validationValid ?? scenario.expected.valid
        );
        if (scenario.expected.expectedConflictTypes) {
          expect(validation.conflicts.map((conflict) => conflict.type)).toEqual(
            expect.arrayContaining(scenario.expected.expectedConflictTypes)
          );
        }
      }

      if (!scenario.expected.valid) {
        if (
          scenario.expected.goldenGateJunctionCount !== undefined ||
          scenario.expected.expectedInvalidJunctionErrors
        ) {
          const draft = computeDraftAssembly(design);
          assertDraftMatchesScenario(design, draft, scenario.expected);
        }
        return;
      }

      const draft = computeDraftAssembly(design);
      assertDraftMatchesScenario(design, draft, scenario.expected);
    }
  );
});

function assertDraftMatchesScenario(
  design: SequenceDesign,
  draft: ReturnType<typeof computeDraftAssembly>,
  expected: (typeof REAL_ASSEMBLY_PIPELINE_SCENARIOS)[number]['expected']
): void {
  expect(draft.homologyRegions).toHaveLength(expected.homologyJunctionCount ?? 0);
  expect(draft.designPrimers.map((pair) => pair.fragmentIndex)).toEqual(expected.primerPairIndices);
  expect(nonEmptyPrimerPairIndices(draft.designPrimers)).toEqual(
    expected.nonEmptyPrimerPairIndices
  );

  if (design.assemblyMethod === 'goldengate') {
    const goldenGateJunctions = draft.goldenGateJunctions ?? [];
    expect(goldenGateJunctions).toHaveLength(expected.goldenGateJunctionCount ?? 0);
    expect(goldenGateJunctions.map((junction) => junction.source.type)).toEqual(
      expected.goldenGateSourceTypes ?? []
    );
    if (expected.valid) {
      expect(goldenGateJunctions.every((junction) => junction.isValid)).toBe(true);
    } else if (expected.expectedInvalidJunctionErrors) {
      expect(
        goldenGateJunctions.map((junction) => junction.validationError ?? '').filter(Boolean)
      ).toEqual(
        expect.arrayContaining(
          expected.expectedInvalidJunctionErrors.map((message) => expect.stringContaining(message))
        )
      );
    }
  } else {
    expect(draft.goldenGateJunctions).toBeUndefined();
  }
}

function expectedComposedSequenceLength(design: SequenceDesign): number {
  return (
    design.regions.reduce(
      (sum, region) => sum + getRegionEffectiveSequence(region, design.assemblyMethod).length,
      0
    ) + (design.spacers ?? []).reduce((sum, spacer) => sum + spacer.sequence.length, 0)
  );
}

function nonEmptyPrimerPairIndices(pairs: DesignPrimerPair[]): number[] {
  return pairs
    .filter((pair) => pair.forward.sequence.length > 0 || pair.reverse.sequence.length > 0)
    .map((pair) => pair.fragmentIndex);
}
