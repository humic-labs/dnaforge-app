import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fixture from '../../../../../../test-fixtures/assembly/rad51-gibson.json';
import { computeDraftAssembly } from './draft-assembly';
import { createTmCalculator } from './tm-service';
import {
  deriveAssemblyIssues,
  issueBlocksGate,
  issuesToValidationErrors,
} from '../../assembly/public/issues/assembly-issues';
import { realAssemblyPipelineAppScenario } from '../../../test/scenarios/assembly-real-pipeline';
import type { SequenceDesign } from '../types';

function design(): SequenceDesign {
  const original = Object.values(
    realAssemblyPipelineAppScenario('gibson-pcr-pcr').designs!.designs
  )[0];
  return {
    ...original,
    regions: fixture.regions,
    spacers: [],
    designPrimers: [],
    homologyRegions: [],
    primerDesignConstraints: undefined,
    defaultHomologyLength: 30,
  } as SequenceDesign;
}

describe(' agent Gibson workflow', () => {
  it.each(['gibson', 'nebuilder'] as const)(
    'targets 60 C without requiring saved primer rules for %s',
    (assemblyMethod) => {
      const input = { ...design(), assemblyMethod };
      const draft = computeDraftAssembly(input);
      const primers = draft.designPrimers.flatMap((pair) => [pair.forward, pair.reverse]);
      expect(primers).toHaveLength(4);
      for (const primer of primers) {
        expect(primer.tm).toBeGreaterThanOrEqual(58);
        expect(primer.tm).toBeLessThanOrEqual(62);
        expect(primer.sequence).toBe(primer.overhang.sequence + primer.pbs.sequence);
      }
      expect(draft.designPrimers[1].forward.pbs.sequence.length).toBeGreaterThan(40);
      expect(
        createHash('sha256')
          .update(
            input.regions
              .map((r) => r.sequence)
              .join('')
              .toUpperCase()
          )
          .digest('hex')
      ).toBe(fixture.productSha256);
    }
  );

  it('honors the supplied PCR temperature without saved rules', () => {
    const tm = createTmCalculator();
    const draft = computeDraftAssembly(design(), 65, tm);
    expect(draft.designPrimers[1].forward.tm).toBeGreaterThanOrEqual(63);
  });

  it('rejects a ten-base shared overlap in canonical validation without an open workbench', () => {
    const input = design();
    const draft = computeDraftAssembly(input);
    draft.homologyRegions[0] = {
      ...draft.homologyRegions[0],
      encoding: { onLeft: 5, onRight: 5 },
      metadata: { ...draft.homologyRegions[0].metadata!, sequence: 'ATGCATGCAT' },
    };
    const issues = deriveAssemblyIssues({ design: { ...input, ...draft } });
    const issue = issues.find((value) => value.kind === 'homology-length-out-of-range');
    expect(issue).toBeDefined();
    expect(issueBlocksGate(issue!, 'finalize')).toBe(true);
    expect(issuesToValidationErrors(issues)).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'homology_length_out_of_range' })
    );
  });
});
