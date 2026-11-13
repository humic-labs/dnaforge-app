// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  checkInternalSitesInPcrRegions,
  validateGoldenGateAssembly,
} from './useOverhangValidation';
import type { DesignRegion, GoldenGateEnzyme } from '../../design/types';

function createPcrRegion(sequence: string, index: number = 0): DesignRegion {
  return {
    id: `r${index}`,
    sourceSequenceId: `s${index}`,
    sourceSequenceName: `Fragment ${index + 1}`,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function createRdRegion(sequence: string, index: number = 0): DesignRegion {
  return {
    id: `r${index}`,
    sourceSequenceId: `s${index}`,
    sourceSequenceName: `Fragment ${index + 1}`,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'rd',
    rdOverhangs: { upstream: 'ATCG', downstream: 'GCTA' },
    rdSourceEnzyme: 'BsaI',
  };
}

function createGoldenGateRdRegion(
  enzyme: GoldenGateEnzyme,
  index = 0,
  overrides: Partial<DesignRegion> = {}
): DesignRegion {
  const enzymeSites: Record<GoldenGateEnzyme, string> = {
    BsaI: 'GGTCTC',
    BbsI: 'GAAGAC',
    BsmBI: 'CGTCTC',
    SapI: 'GCTCTTC',
  };
  const cutGeometry: Record<GoldenGateEnzyme, { top: number; bottom: number }> = {
    BsaI: { top: 7, bottom: 11 },
    BbsI: { top: 8, bottom: 12 },
    BsmBI: { top: 7, bottom: 11 },
    SapI: { top: 8, bottom: 11 },
  };
  const sourceSequence = 'A'.repeat(160);
  const upstreamRecognitionStart = 20;
  const downstreamRecognitionStart = 100;
  const geometry = cutGeometry[enzyme];
  return {
    id: `rd-${enzyme}-${index}`,
    sourceSequenceId: `source-${enzyme}-${index}`,
    sourceSequenceName: `${enzyme} RD Fragment`,
    sourceStart: 0,
    sourceEnd: 80,
    sequence: 'ATCG'.repeat(20),
    annotations: [],
    sourceSequence,
    sourceType: 'rd',
    ggType: 'insert',
    rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
    rdSourceEnzyme: enzyme,
    rdSourceEnzymeName: enzyme,
    rdEnds: {
      upstream: {
        overhang: 'AATG',
        recognitionSequence: enzymeSites[enzyme],
        recognitionStart: upstreamRecognitionStart,
        recognitionEnd: upstreamRecognitionStart + enzymeSites[enzyme].length,
        cutPositionTop: upstreamRecognitionStart + geometry.top,
        cutPositionBottom: upstreamRecognitionStart + geometry.bottom,
        strand: 'forward',
      },
      downstream: {
        overhang: 'GCTA',
        recognitionSequence: enzymeSites[enzyme],
        recognitionStart: downstreamRecognitionStart,
        recognitionEnd: downstreamRecognitionStart + enzymeSites[enzyme].length,
        cutPositionTop: downstreamRecognitionStart + geometry.top,
        cutPositionBottom: downstreamRecognitionStart + geometry.bottom,
        strand: 'forward',
      },
    },
    ...overrides,
  };
}

describe('checkInternalSitesInPcrRegions', () => {
  describe('forward strand detection', () => {
    it('detects BsaI site (GGTCTC) in forward strand', () => {
      const region = createPcrRegion('ATCGATCGGGTCTCATCGATCG', 0);
      const conflicts = checkInternalSitesInPcrRegions([region], 'BsaI');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('internal-site');
      expect(conflicts[0].message).toContain('BsaI');
      expect(conflicts[0].message).toContain('1');
      expect(conflicts[0].involvedIndices).toContain(0);
    });

    it('detects multiple BsaI sites in same region', () => {
      const region = createPcrRegion('GGTCTCATCGATCGGGTCTC', 0);
      const conflicts = checkInternalSitesInPcrRegions([region], 'BsaI');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].message).toContain('2');
    });
  });

  describe('reverse complement detection', () => {
    it('detects BsaI site in reverse complement (GAGACC)', () => {
      const region = createPcrRegion('ATCGATCGGAGACCATCGATCG', 0);
      const conflicts = checkInternalSitesInPcrRegions([region], 'BsaI');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('internal-site');
    });

    it('counts both forward and reverse sites', () => {
      const region = createPcrRegion('GGTCTCATCGGAGACC', 0);
      const conflicts = checkInternalSitesInPcrRegions([region], 'BsaI');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].message).toContain('2');
    });
  });

  describe('no sites case', () => {
    it('returns empty array when no enzyme sites present', () => {
      const region = createPcrRegion('ATCGATCGATCGATCGATCG', 0);
      const conflicts = checkInternalSitesInPcrRegions([region], 'BsaI');

      expect(conflicts).toHaveLength(0);
    });

    it('returns empty array for empty regions array', () => {
      const conflicts = checkInternalSitesInPcrRegions([], 'BsaI');
      expect(conflicts).toHaveLength(0);
    });
  });

  describe('multiple enzyme types', () => {
    it('detects BbsI site (GAAGAC)', () => {
      const region = createPcrRegion('ATCGGAAGACATCG', 0);
      const conflicts = checkInternalSitesInPcrRegions([region], 'BbsI');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].message).toContain('BbsI');
    });

    it('detects BsmBI site (CGTCTC)', () => {
      const region = createPcrRegion('ATCGCGTCTCATCG', 0);
      const conflicts = checkInternalSitesInPcrRegions([region], 'BsmBI');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].message).toContain('BsmBI');
    });

    it('detects SapI site (GCTCTTC)', () => {
      const region = createPcrRegion('ATCGGCTCTTCATCG', 0);
      const conflicts = checkInternalSitesInPcrRegions([region], 'SapI');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].message).toContain('SapI');
    });

    it('does not cross-detect wrong enzyme', () => {
      const region = createPcrRegion('ATCGGGTCTCATCG', 0);
      const conflicts = checkInternalSitesInPcrRegions([region], 'BbsI');

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('RD region handling', () => {
    it('skips RD regions (only checks PCR)', () => {
      const rdRegion = createRdRegion('ATCGGGTCTCATCG', 0);
      const conflicts = checkInternalSitesInPcrRegions([rdRegion], 'BsaI');

      expect(conflicts).toHaveLength(0);
    });

    it('checks PCR but not RD in mixed assembly', () => {
      const pcrWithSite = createPcrRegion('ATCGGGTCTCATCG', 0);
      const rdWithSite = createRdRegion('ATCGGGTCTCATCG', 1);
      const pcrNoSite = createPcrRegion('ATCGATCGATCG', 2);

      const conflicts = checkInternalSitesInPcrRegions(
        [pcrWithSite, rdWithSite, pcrNoSite],
        'BsaI'
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].involvedIndices).toEqual([0]);
    });
  });

  describe('multiple regions', () => {
    it('flags multiple PCR regions with sites', () => {
      const region1 = createPcrRegion('ATCGGGTCTCATCG', 0);
      const region2 = createPcrRegion('GGTCTCGGTCTC', 1);

      const conflicts = checkInternalSitesInPcrRegions([region1, region2], 'BsaI');

      expect(conflicts).toHaveLength(2);
      expect(conflicts[0].involvedIndices).toEqual([0]);
      expect(conflicts[1].involvedIndices).toEqual([1]);
      expect(conflicts[1].message).toContain('2');
    });
  });
});

describe('validateGoldenGateAssembly', () => {
  it('includes internal site conflicts in validation result', () => {
    const pcrWithSite = createPcrRegion('ATCGGGTCTCATCG', 0);
    const result = validateGoldenGateAssembly([pcrWithSite], false, 'BsaI');

    expect(result.isValid).toBe(false);
    expect(result.conflicts.some((c) => c.type === 'internal-site')).toBe(true);
  });

  it('returns valid when no conflicts', () => {
    const pcrClean = createPcrRegion('ATCGATCGATCG', 0);
    const result = validateGoldenGateAssembly([pcrClean], false, 'BsaI');

    expect(result.isValid).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('does not treat same-digest sibling overhang metadata as a conflict', () => {
    const rdRegion: DesignRegion = {
      id: 'r0',
      sourceSequenceId: 's0',
      sourceSequenceName: 'RD Fragment',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'ATCGATCG',
      annotations: [],
      sourceType: 'rd',
      rdOverhangs: { upstream: 'GGGG', downstream: 'CCCC' },
      rdSourceEnzyme: 'BsaI',
      rdSiblingOverhangs: ['GGGG', 'CCCC'],
    };

    const result = validateGoldenGateAssembly([rdRegion], false, 'BsaI');

    expect(result.isValid).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('rejects a Golden Gate RD fragment when its source enzyme does not match the selected enzyme', () => {
    const bsmBIRdRegion: DesignRegion = {
      id: 'r0',
      sourceSequenceId: 's0',
      sourceSequenceName: 'BsmBI RD Fragment',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'ATCGATCG',
      annotations: [],
      sourceType: 'rd',
      ggType: 'insert',
      rdOverhangs: { upstream: 'GGGG', downstream: 'CCCC' },
      rdSourceEnzyme: 'BsmBI',
      rdSourceEnzymeName: 'BsmBI',
      rdEnds: {
        upstream: {
          overhang: 'GGGG',
          recognitionSequence: 'CGTCTC',
          cutPositionTop: 10,
          cutPositionBottom: 14,
        },
        downstream: {
          overhang: 'CCCC',
          recognitionSequence: 'CGTCTC',
          cutPositionTop: 90,
          cutPositionBottom: 94,
        },
      },
    };

    const bsaIResult = validateGoldenGateAssembly([bsmBIRdRegion], false, 'BsaI');
    const bsmBIResult = validateGoldenGateAssembly([bsmBIRdRegion], false, 'BsmBI');

    expect(bsaIResult.isValid).toBe(false);
    expect(bsaIResult.conflicts).toContainEqual(
      expect.objectContaining({
        type: 'rd-enzyme-mismatch',
        involvedIndices: [0],
      })
    );
    expect(bsmBIResult.conflicts.some((conflict) => conflict.type === 'rd-enzyme-mismatch')).toBe(
      false
    );
  });

  it.each([
    ['BsaI', 'BbsI'],
    ['BsaI', 'BsmBI'],
    ['BbsI', 'BsaI'],
    ['BsmBI', 'BsaI'],
  ] as Array<[GoldenGateEnzyme, GoldenGateEnzyme]>)(
    'only accepts a %s RD fragment under the matching selected Golden Gate enzyme',
    (rdEnzyme, wrongSelectedEnzyme) => {
      const rdRegion = createGoldenGateRdRegion(rdEnzyme);

      const matchingResult = validateGoldenGateAssembly([rdRegion], false, rdEnzyme);
      const wrongResult = validateGoldenGateAssembly([rdRegion], false, wrongSelectedEnzyme);

      expect(matchingResult.conflicts.map((conflict) => conflict.type)).not.toContain(
        'rd-enzyme-mismatch'
      );
      expect(matchingResult.conflicts.map((conflict) => conflict.type)).not.toContain(
        'rd-cut-site-mismatch'
      );
      expect(wrongResult.isValid).toBe(false);
      expect(wrongResult.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'rd-enzyme-mismatch',
            involvedIndices: [0],
          }),
          expect.objectContaining({
            type: 'rd-cut-site-mismatch',
            involvedIndices: [0],
          }),
        ])
      );
    }
  );

  it.each(['backbone', 'unusable', 'rd'] as const)(
    'rejects a %s RD fragment as Golden Gate insert cargo',
    (ggType) => {
      const rdRegion = createGoldenGateRdRegion('BsaI', 0, { ggType });

      const result = validateGoldenGateAssembly([rdRegion], false, 'BsaI');

      expect(result.isValid).toBe(false);
      expect(result.conflicts).toContainEqual(
        expect.objectContaining({
          type: 'rd-fragment-not-insert',
          involvedIndices: [0],
        })
      );
    }
  );

  it('rejects mixed or non-Golden-Gate restriction digest provenance in a Golden Gate draft', () => {
    const mixedDigestRegion = createGoldenGateRdRegion('BsaI', 0, {
      rdSourceEnzyme: undefined,
      rdSourceEnzymeName: 'AatII + BsaI',
    });

    const result = validateGoldenGateAssembly([mixedDigestRegion], false, 'BsaI');

    expect(result.isValid).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        type: 'rd-enzyme-unknown',
        overhang: 'AatII + BsaI',
        involvedIndices: [0],
      })
    );
  });

  it('rejects RD end provenance whose Type IIS recognition sequence does not match the selected enzyme', () => {
    const badProvenanceRegion: DesignRegion = {
      id: 'r0',
      sourceSequenceId: 's0',
      sourceSequenceName: 'Bad RD Fragment',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'ATCGATCG',
      annotations: [],
      sourceType: 'rd',
      ggType: 'insert',
      rdOverhangs: { upstream: 'GGGG', downstream: 'CCCC' },
      rdSourceEnzyme: 'BsaI',
      rdSourceEnzymeName: 'BsaI',
      rdEnds: {
        upstream: {
          overhang: 'GGGG',
          recognitionSequence: 'CGTCTC',
          cutPositionTop: 10,
          cutPositionBottom: 14,
        },
      },
    };

    const result = validateGoldenGateAssembly([badProvenanceRegion], false, 'BsaI');

    expect(result.isValid).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        type: 'rd-cut-site-mismatch',
        involvedIndices: [0],
      })
    );
  });

  it('rejects RD end provenance whose Type IIS cut coordinates do not match the selected enzyme geometry', () => {
    const badCutGeometryRegion: DesignRegion = {
      id: 'r0',
      sourceSequenceId: 's0',
      sourceSequenceName: 'Bad cut geometry RD Fragment',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'ATCGATCG',
      annotations: [],
      sourceType: 'rd',
      ggType: 'insert',
      sourceSequence: 'A'.repeat(100),
      rdOverhangs: { upstream: 'GGGG', downstream: 'CCCC' },
      rdSourceEnzyme: 'BsaI',
      rdSourceEnzymeName: 'BsaI',
      rdEnds: {
        upstream: {
          overhang: 'GGGG',
          recognitionSequence: 'GGTCTC',
          recognitionStart: 10,
          recognitionEnd: 16,
          cutPositionTop: 18,
          cutPositionBottom: 22,
          strand: 'forward',
        },
      },
    };

    const result = validateGoldenGateAssembly([badCutGeometryRegion], false, 'BsaI');

    expect(result.isValid).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        type: 'rd-cut-site-mismatch',
        message: expect.stringContaining('cut coordinates 18/22 do not match BsaI geometry 17/21'),
        involvedIndices: [0],
      })
    );
  });

  it('combines overhang and internal site conflicts', () => {
    const rdRegion: DesignRegion = {
      id: 'r0',
      sourceSequenceId: 's0',
      sourceSequenceName: 'RD Fragment',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'ATCGATCG',
      annotations: [],
      sourceType: 'rd',
      rdOverhangs: { upstream: 'AAAA', downstream: 'AAAA' },
      rdSourceEnzyme: 'BsaI',
    };
    const pcrWithSite = createPcrRegion('ATCGGGTCTCATCG', 1);

    const result = validateGoldenGateAssembly([rdRegion, pcrWithSite], false, 'BsaI');

    expect(result.isValid).toBe(false);
    const hasSelfLigation = result.conflicts.some((c) => c.type === 'self-ligation');
    const hasInternalSite = result.conflicts.some((c) => c.type === 'internal-site');
    expect(hasSelfLigation).toBe(true);
    expect(hasInternalSite).toBe(true);
  });
});
