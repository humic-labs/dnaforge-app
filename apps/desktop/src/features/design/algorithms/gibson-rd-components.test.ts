// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { DesignRegion, SequenceDesign } from '../types';
import { computeDraftAssembly, reverseComplement } from './draft-assembly';
import { getRegionEffectiveSequence } from '../restriction-digest';

describe('Gibson assemblies with restriction digest components', () => {
  it('puts the full RD-to-PCR overlap on the PCR forward primer tail', () => {
    const rd = makeRegion('rd-left', 'ATGC'.repeat(18) + 'GATTACAGATTACA', 'rd');
    const pcr = makeRegion('pcr-right', 'CGTA'.repeat(22), 'pcr');

    const result = computeDraftAssembly(makeDesign([rd, pcr], 'linear'));
    const junction = result.homologyRegions[0];
    const pcrPair = result.designPrimers.find((pair) => pair.fragmentIndex === 1);

    expect(junction.encoding.onLeft).toBe(junction.metadata?.sequence?.length);
    expect(junction.encoding.onRight).toBe(0);
    expect(junction.metadata?.sequence).toBe(rd.sequence.slice(-junction.encoding.onLeft));
    expect(result.designPrimers.some((pair) => pair.fragmentIndex === 0)).toBe(false);
    expect(pcrPair?.forward.overhang.sequence).toBe(junction.metadata?.sequence);
  });

  it('keeps spacer cargo out of RD-to-PCR homology but in the PCR forward primer tail', () => {
    const rd = makeRegion('rd-left', 'ATGC'.repeat(18) + 'GATTACAGATTACA', 'rd');
    const pcr = makeRegion('pcr-right', 'CGTA'.repeat(22), 'pcr');
    const spacer = { id: 'spacer-1', junctionIndex: 0, sequence: 'GGCC' };

    const result = computeDraftAssembly(makeDesign([rd, pcr], 'linear', [spacer]));
    const junction = result.homologyRegions[0];
    const pcrPair = result.designPrimers.find((pair) => pair.fragmentIndex === 1);
    const rdOverlap = junction.metadata?.sequence ?? '';
    const tailLength = (pcrPair?.forward.overhang as { tailLength?: number } | undefined)
      ?.tailLength;

    expect(junction.encoding.onLeft).toBe(rdOverlap.length);
    expect(junction.encoding.onRight).toBe(0);
    expect(rdOverlap).toBe(rd.sequence.slice(-junction.encoding.onLeft));
    expect(rdOverlap.endsWith(spacer.sequence)).toBe(false);
    expect(pcrPair?.forward.overhang.sequence).toBe(rdOverlap + spacer.sequence);
    expect(pcrPair?.forward.overhang.spacerSequence).toBe(spacer.sequence);
    expect(pcrPair?.forward.overhang.length).toBe(rdOverlap.length);
    expect(tailLength).toBe(rdOverlap.length + spacer.sequence.length);
  });

  it('puts the full PCR-to-RD overlap on the PCR reverse primer tail', () => {
    const pcr = makeRegion('pcr-left', 'ATGC'.repeat(22), 'pcr');
    const rd = makeRegion('rd-right', 'TTAACCGGTTAACCGG' + 'CGTA'.repeat(18), 'rd');
    const spacer = { id: 'spacer-1', junctionIndex: 0, sequence: 'GGCC' };

    const result = computeDraftAssembly(makeDesign([pcr, rd], 'linear', [spacer]));
    const junction = result.homologyRegions[0];
    const pcrPair = result.designPrimers.find((pair) => pair.fragmentIndex === 0);
    const rdOverlap = junction.metadata?.sequence ?? '';

    expect(junction.encoding.onLeft).toBe(0);
    expect(junction.encoding.onRight).toBe(rdOverlap.length);
    expect(rdOverlap).toBe(rd.sequence.slice(0, junction.encoding.onRight));
    expect(result.designPrimers.some((pair) => pair.fragmentIndex === 1)).toBe(false);
    expect(pcrPair?.reverse.overhang.sequence).toBe(reverseComplement(spacer.sequence + rdOverlap));
    expect(pcrPair?.reverse.overhang.length).toBe(rdOverlap.length);
    expect((pcrPair?.reverse.overhang as { tailLength?: number } | undefined)?.tailLength).toBe(
      spacer.sequence.length + rdOverlap.length
    );
  });

  it("excludes upstream 5' RD overhang cutter bases from PCR-to-RD Gibson overlaps", () => {
    const pcr = makeRegion('pcr-left', 'ATGC'.repeat(22), 'pcr');
    const rd = makeRegion('rd-right-of-ecori', 'AATTC' + 'CGTA'.repeat(22), 'rd', {
      rdEnds: {
        upstream: {
          overhangType: '5_prime',
          overhang: 'AATT',
          retainedScarSequence: 'AATTC',
          retainedScarLength: 5,
        },
      },
    });

    const result = computeDraftAssembly(makeDesign([pcr, rd], 'linear'));
    const junction = result.homologyRegions[0];
    const pcrPair = result.designPrimers.find((pair) => pair.fragmentIndex === 0);
    const effectiveRd = getRegionEffectiveSequence(rd, 'gibson');

    expect(effectiveRd).toBe('CGTA'.repeat(22));
    expect(junction.metadata?.sequence).toBe(effectiveRd.slice(0, junction.encoding.onRight));
    expect(junction.metadata?.sequence).not.toBe(rd.sequence.slice(0, junction.encoding.onRight));
    expect(pcrPair?.reverse.overhang.sequence).toBe(
      reverseComplement(junction.metadata?.sequence ?? '')
    );
  });

  it('puts a two-PCR Gibson overlap on the second product when no backbone is set', () => {
    const left = makeRegion('pcr-left', 'ATGC'.repeat(22), 'pcr');
    const right = makeRegion('pcr-right', 'CGTA'.repeat(22), 'pcr');

    const result = computeDraftAssembly(makeDesign([left, right], 'linear'));
    const junction = result.homologyRegions[0];

    expect(junction.encoding.onLeft).toBeGreaterThan(0);
    expect(junction.encoding.onRight).toBe(0);
    expect(junction.encoding.onLeft + junction.encoding.onRight).toBe(
      junction.metadata?.sequence?.length
    );
    expect(result.designPrimers).toHaveLength(2);
  });

  it('designs both tails on the PCR product in a circular RD/PCR Gibson assembly', () => {
    const rd = makeRegion('rd', 'ATGC'.repeat(24), 'rd');
    const pcr = makeRegion('pcr', 'CGTA'.repeat(24), 'pcr');

    const result = computeDraftAssembly(makeDesign([rd, pcr], 'circular'));
    const rdToPcr = result.homologyRegions.find((hr) => hr.junctionIndex === 0)!;
    const pcrToRd = result.homologyRegions.find((hr) => hr.junctionIndex === 1)!;
    const pcrPair = result.designPrimers.find((pair) => pair.fragmentIndex === 1);

    expect(result.designPrimers).toHaveLength(1);
    expect(pcrPair?.forward.overhang.sequence).toBe(rdToPcr.metadata?.sequence);
    expect(pcrPair?.reverse.overhang.sequence).toBe(
      reverseComplement(pcrToRd.metadata?.sequence ?? '')
    );
  });
});

function makeDesign(
  regions: DesignRegion[],
  topology: 'linear' | 'circular',
  spacers: SequenceDesign['spacers'] = []
): SequenceDesign {
  const now = new Date('2026-04-27T00:00:00.000Z');
  return {
    id: 'design-1',
    name: 'Gibson RD test design',
    topology,
    regions,
    spacers,
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

function makeRegion(
  id: string,
  sequence: string,
  sourceType: 'pcr' | 'rd',
  overrides: Partial<DesignRegion> = {}
): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType,
    ...(sourceType === 'rd'
      ? {
          ggType: 'insert' as const,
          rdOverhangs: {
            upstream: 'AATG',
            downstream: 'GCTA',
          },
          rdSourceEnzyme: 'BsaI' as const,
        }
      : {}),
    ...overrides,
  };
}
