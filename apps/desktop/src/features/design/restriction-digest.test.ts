// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { DesignRegion, SequenceDesign } from './types';
import {
  createRestrictionDigestEnd,
  getComposedSequenceForDesign,
  getComposedSequenceForMethod,
  getRegionEffectiveSequence,
  getVisibleRestrictionDigestScarSegments,
} from './restriction-digest';
import { computeDraftAssembly } from './algorithms/draft-assembly';

describe('restriction digest end scar modeling', () => {
  it('records the retained scar for EcoRI, PstI, and blunt cutters', () => {
    const sequence = 'TTTTGAATTCAAAACTGCAGGGGGCCCGGGTTTT';

    expect(
      createRestrictionDigestEnd(
        sequence,
        cutSite(sequence, 'GAATTC', 1, 5),
        enzyme('GAATTC', '5_prime'),
        'downstream',
        'AATT'
      ).retainedScarSequence
    ).toBe('G');

    expect(
      createRestrictionDigestEnd(
        sequence,
        cutSite(sequence, 'CTGCAG', 5, 1),
        enzyme('CTGCAG', '3_prime'),
        'downstream',
        'TGCA'
      ).retainedScarSequence
    ).toBe('CTGCA');

    expect(
      createRestrictionDigestEnd(
        sequence,
        cutSite(sequence, 'CCCGGG', 3, 3),
        enzyme('CCCGGG', 'blunt'),
        'downstream'
      ).retainedScarSequence
    ).toBe('CCC');
  });

  it('keeps RD scars for Gibson and resects selected RD bases for NEBuilder', () => {
    const rd = makeRdRegion('rd-left', 'ATGC'.repeat(12) + 'AAAAACTGCA', {
      downstream: {
        retainedScarSequence: 'CTGCA',
        retainedScarLength: 5,
        nebuilderResectionBases: 10,
      },
    });

    expect(getRegionEffectiveSequence(rd, 'gibson')).toBe(rd.sequence);
    expect(getRegionEffectiveSequence(rd, 'nebuilder')).toBe('ATGC'.repeat(12));
  });

  it("removes upstream 5' overhang cutter bases from Gibson RD parts", () => {
    const rd = makeRdRegion('rd-right-of-ecori', 'AATTC' + 'CGTA'.repeat(12), {
      upstream: {
        overhangType: '5_prime',
        overhang: 'AATT',
        retainedScarSequence: 'AATTC',
        retainedScarLength: 5,
      },
    });

    expect(getRegionEffectiveSequence(rd, 'gibson')).toBe('CGTA'.repeat(12));
    expect(getRegionEffectiveSequence(rd, 'nebuilder')).toBe('CGTA'.repeat(12));
  });

  it('treats NEBuilder RD-end resection as total trimming, not Gibson trim plus extra', () => {
    const rd = makeRdRegion('rd-right-of-ecori', 'AATTCGGGGG' + 'CGTA'.repeat(12), {
      upstream: {
        overhangType: '5_prime',
        overhang: 'AATT',
        retainedScarSequence: 'AATTC',
        retainedScarLength: 5,
        nebuilderResectionBases: 10,
      },
    });

    expect(getRegionEffectiveSequence(rd, 'gibson')).toBe('GGGGG' + 'CGTA'.repeat(12));
    expect(getRegionEffectiveSequence(rd, 'nebuilder')).toBe('CGTA'.repeat(12));
  });

  it('reports only retained scar bases that remain after Gibson and NEBuilder trimming', () => {
    const rd = makeRdRegion('rd-left-of-psti', 'GCTA'.repeat(12) + 'CTGCA', {
      downstream: {
        overhangType: '3_prime',
        overhang: 'TGCA',
        retainedScarSequence: 'CTGCA',
        retainedScarLength: 5,
        nebuilderResectionBases: 3,
      },
    });

    expect(getVisibleRestrictionDigestScarSegments(rd, 'gibson')).toEqual([
      expect.objectContaining({
        end: 'downstream',
        sequence: 'CTGCA',
        effectiveStart: rd.sequence.length - 5,
        effectiveEnd: rd.sequence.length,
        sourceStart: rd.sourceEnd - 5,
        sourceEnd: rd.sourceEnd,
        trimmedBases: 0,
      }),
    ]);
    expect(getVisibleRestrictionDigestScarSegments(rd, 'nebuilder')).toEqual([
      expect.objectContaining({
        end: 'downstream',
        sequence: 'CT',
        effectiveStart: rd.sequence.length - 5,
        effectiveEnd: rd.sequence.length - 3,
        sourceStart: rd.sourceEnd - 5,
        sourceEnd: rd.sourceEnd - 3,
        trimmedBases: 3,
      }),
    ]);
  });

  it("keeps downstream 3' overhang cutter scars for Gibson", () => {
    const rd = makeRdRegion('rd-left-of-psti', 'GCTA'.repeat(12) + 'CTGCA', {
      downstream: {
        overhangType: '3_prime',
        overhang: 'TGCA',
        retainedScarSequence: 'CTGCA',
        retainedScarLength: 5,
      },
    });

    expect(getRegionEffectiveSequence(rd, 'gibson')).toBe(rd.sequence);
  });

  it('uses the Gibson-effective RD sequence when composing homology assembly sequence', () => {
    const rd = makeRdRegion('rd-right-of-ecori', 'AATTC' + 'CGTA'.repeat(10), {
      upstream: {
        overhangType: '5_prime',
        overhang: 'AATT',
        retainedScarSequence: 'AATTC',
        retainedScarLength: 5,
      },
    });
    const pcr = makePcrRegion('pcr-left', 'ATGC'.repeat(10));

    expect(getComposedSequenceForMethod([pcr, rd], [], 'gibson')).toBe(
      pcr.sequence + 'CGTA'.repeat(10)
    );
  });

  it('uses the NEBuilder-resected RD sequence when computing RD-to-PCR homology', () => {
    const rd = makeRdRegion('rd-left', 'GCTA'.repeat(14) + 'AAAAACTGCA', {
      downstream: {
        retainedScarSequence: 'CTGCA',
        retainedScarLength: 5,
        nebuilderResectionBases: 10,
      },
    });
    const pcr = makePcrRegion('pcr-right', 'CGTA'.repeat(24));
    const design = makeDesign([rd, pcr], 'nebuilder');

    const result = computeDraftAssembly(design);
    const junction = result.homologyRegions[0];
    const effectiveRd = getRegionEffectiveSequence(rd, 'nebuilder');

    expect(junction.encoding.onLeft).toBe(junction.metadata?.sequence?.length);
    expect(junction.metadata?.sequence).toBe(effectiveRd.slice(-junction.encoding.onLeft));
    expect(junction.metadata?.sequence).not.toBe(rd.sequence.slice(-junction.encoding.onLeft));
  });

  it('lets spacers add recognition-site bases back after NEBuilder resection', () => {
    const rd = makeRdRegion('rd-left', 'GCTA'.repeat(10) + 'AAAAACTGCA', {
      downstream: {
        retainedScarSequence: 'CTGCA',
        retainedScarLength: 5,
        nebuilderResectionBases: 10,
      },
    });
    const pcr = makePcrRegion('pcr-right', 'CGTA'.repeat(10));
    const design = makeDesign([rd, pcr], 'nebuilder', [
      { id: 'restore-psti', junctionIndex: 0, sequence: 'CTGCA', name: 'restore PstI' },
    ]);

    expect(getComposedSequenceForDesign(design)).toContain(
      `${getRegionEffectiveSequence(rd, 'nebuilder')}CTGCA${pcr.sequence}`
    );
  });
});

function enzyme(recognitionSequence: string, overhangType: 'blunt' | '5_prime' | '3_prime') {
  return {
    recognition_sequence: recognitionSequence,
    overhang_type: overhangType,
  };
}

function cutSite(
  sequence: string,
  recognitionSequence: string,
  topOffset: number,
  bottomOffset: number
) {
  const recognitionStart = sequence.indexOf(recognitionSequence);
  return {
    recognitionStart,
    recognitionEnd: recognitionStart + recognitionSequence.length,
    cutPositionTop: recognitionStart + topOffset,
    cutPositionBottom: recognitionStart + bottomOffset,
    strand: 'forward' as const,
  };
}

function makeDesign(
  regions: DesignRegion[],
  assemblyMethod: SequenceDesign['assemblyMethod'],
  spacers: SequenceDesign['spacers'] = []
): SequenceDesign {
  const now = new Date('2026-04-27T00:00:00.000Z');
  return {
    id: 'design-1',
    name: 'RD scar test design',
    topology: 'linear',
    regions,
    spacers,
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod,
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

function makePcrRegion(id: string, sequence: string): DesignRegion {
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

function makeRdRegion(id: string, sequence: string, rdEnds: DesignRegion['rdEnds']): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'rd',
    ggType: 'insert',
    rdOverhangs: {
      upstream: 'AATG',
      downstream: 'TGCA',
    },
    rdSourceEnzymeName: 'PstI',
    rdEnds,
  };
}
