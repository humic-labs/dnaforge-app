import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fixture from './rad51-assembly.fixture.json';
import { computeDraftAssembly } from './draft-assembly';
import { deriveAssemblyIssues } from '../../assembly/public/issues/assembly-issues';
import type { SequenceDesign } from '../types';

export function rad51Design(): SequenceDesign {
  return {
    id: 'rad51-regression',
    name: 'pRS426-ScRAD51-WT-native',
    topology: 'circular',
    assemblyMethod: 'gibson',
    regions: fixture.regions.map((region) => ({ ...region, sourceType: 'pcr', annotations: [] })),
    spacers: [],
    version: 0,
    assemblyState: 'preflight',
    validationErrors: [],
    proposedPlans: [],
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('reported RAD51 Gibson assembly', () => {
  it('puts both 30 bp overlaps on the insert and keeps the first fragment primers plain', () => {
    const result = computeDraftAssembly(rad51Design(), 60);
    expect(
      result.designPrimers.map((pair) => [
        pair.forward.overhang.length,
        pair.reverse.overhang.length,
      ])
    ).toEqual([
      [0, 0],
      [30, 30],
    ]);
  });
  it('uses the independent 7969 bp circular product oracle', () => {
    const sequence = fixture.regions
      .map((region) => region.sequence)
      .join('')
      .toUpperCase();
    expect(sequence).toHaveLength(7969);
    expect(createHash('sha256').update(sequence).digest('hex')).toBe(fixture.expectedSha256);
  });

  it('solves default binding lengths against the requested PCR temperature', () => {
    const result = computeDraftAssembly(rad51Design(), 60);
    for (const pair of result.designPrimers)
      for (const primer of [pair.forward, pair.reverse])
        expect(Math.abs(primer.tm - 60)).toBeLessThanOrEqual(1);
    expect(result.designPrimers[1].forward.pbs.sequence.length).toBeGreaterThan(40);
  });

  it('honors the default 30 bp junction overlap instead of shrinking it to a Tm-only minimum', () => {
    const result = computeDraftAssembly(rad51Design(), 60);
    expect(result.homologyRegions.map((region) => region.metadata?.sequence.length)).toEqual([
      30, 30,
    ]);
  });

  it('blocks a 10 bp Gibson junction', () => {
    const design = rad51Design();
    const result = computeDraftAssembly(design, 60);
    result.homologyRegions[0].metadata!.sequence = 'ACGTACGTAC';
    const issues = deriveAssemblyIssues({ design: { ...design, ...result } });
    expect(
      issues.some(
        (issue) => issue.kind === 'homology-length-out-of-range' && issue.severity === 'error'
      )
    ).toBe(true);
  });
});
