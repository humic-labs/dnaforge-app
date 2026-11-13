// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { reverseComplement } from '@waypoint/sequence-utils';
import type { DesignRegion } from './types';
import {
  canReverseComplementDesignRegion,
  reverseComplementDesignRegion,
} from './region-orientation';

describe('reverseComplementDesignRegion', () => {
  it('reverses bases, annotations, source coordinates, overhangs, and physical digest ends', () => {
    const sourceSequence = 'AAAACCGTGGTT';
    const region: DesignRegion = {
      id: 'rd-part',
      colorIndex: 4,
      sourceSequenceId: '/workspace/source.gb',
      sourceSequenceName: 'source',
      sourceStart: 2,
      sourceEnd: 8,
      sourceSequence,
      sourceLength: sourceSequence.length,
      sourceIsCircular: false,
      sourceAnnotations: [{ name: 'source-CDS', type: 'CDS', start: 2, end: 8, strand: 'forward' }],
      sequence: sourceSequence.slice(2, 8),
      annotations: [{ name: 'part-CDS', type: 'CDS', start: 0, end: 4, strand: 'forward' }],
      sourceType: 'rd',
      ggType: 'insert',
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
      rdSourceEnzyme: 'BsaI',
      rdSourceEnzymeName: 'BsaI',
      rdSiblingOverhangs: ['TTAA', 'CGGT'],
      rdEnds: {
        upstream: {
          overhang: 'AATG',
          overhangType: '5_prime',
          recognitionSequence: 'GGTCTC',
          recognitionStart: 0,
          recognitionEnd: 6,
          cutPositionTop: 1,
          cutPositionBottom: 5,
          strand: 'forward',
          retainedScarSequence: 'AATG',
          retainedScarLength: 4,
          nebuilderResectionBases: 2,
        },
        downstream: {
          overhang: 'GCTA',
          overhangType: '5_prime',
          recognitionSequence: 'GAGACC',
          recognitionStart: 6,
          recognitionEnd: 12,
          cutPositionTop: 7,
          cutPositionBottom: 11,
          strand: 'reverse',
          retainedScarSequence: 'GCTA',
          retainedScarLength: 4,
          nebuilderResectionBases: 3,
        },
      },
    };

    const reversed = reverseComplementDesignRegion(region);

    expect(reversed).not.toBeNull();
    expect(reversed).toMatchObject({
      id: 'rd-part',
      colorIndex: 4,
      sequence: reverseComplement(region.sequence),
      sourceSequence: reverseComplement(sourceSequence),
      sourceStart: 4,
      sourceEnd: 10,
      rdOverhangs: { upstream: 'TAGC', downstream: 'CATT' },
      rdSiblingOverhangs: ['TTAA', 'ACCG'],
    });
    expect(reversed?.annotations).toEqual([
      { name: 'part-CDS', type: 'CDS', start: 2, end: 6, strand: 'reverse' },
    ]);
    expect(reversed?.sourceAnnotations).toEqual([
      { name: 'source-CDS', type: 'CDS', start: 4, end: 10, strand: 'reverse' },
    ]);
    expect(reversed?.rdEnds?.upstream).toEqual({
      overhang: 'TAGC',
      overhangType: '5_prime',
      recognitionSequence: 'GGTCTC',
      recognitionStart: 0,
      recognitionEnd: 6,
      cutPositionTop: 1,
      cutPositionBottom: 5,
      strand: 'forward',
      retainedScarSequence: 'TAGC',
      retainedScarLength: 4,
      nebuilderResectionBases: 3,
    });
    expect(reversed?.rdEnds?.downstream).toEqual({
      overhang: 'CATT',
      overhangType: '5_prime',
      recognitionSequence: 'GAGACC',
      recognitionStart: 6,
      recognitionEnd: 12,
      cutPositionTop: 7,
      cutPositionBottom: 11,
      strand: 'reverse',
      retainedScarSequence: 'CATT',
      retainedScarLength: 4,
      nebuilderResectionBases: 2,
    });

    expect(reverseComplementDesignRegion(reversed!)).toEqual(region);
  });

  it('refuses a file-backed region when the full source axis is unavailable', () => {
    const region: DesignRegion = {
      id: 'unloaded',
      sourceSequenceId: '/workspace/source.gb',
      sourceSequenceName: 'source',
      sourceStart: 10,
      sourceEnd: 14,
      sequence: 'ATGC',
      annotations: [],
    };

    expect(canReverseComplementDesignRegion(region)).toBe(false);
    expect(reverseComplementDesignRegion(region)).toBeNull();
  });

  it('reverse complements an unfiled pasted sequence using the part as its source axis', () => {
    const region: DesignRegion = {
      id: 'pasted',
      sourceSequenceId: 'external',
      sourceSequenceName: 'Pasted sequence',
      sourceStart: 0,
      sourceEnd: 4,
      sequence: 'ATGC',
      annotations: [],
    };

    expect(reverseComplementDesignRegion(region)).toMatchObject({
      sequence: 'GCAT',
      sourceSequence: 'GCAT',
      sourceLength: 4,
      sourceStart: 0,
      sourceEnd: 4,
    });
  });

  it('preserves the full circular source interval across one and two reverse complements', () => {
    const sourceSequence = 'AAAACCGTGGTT';
    const region: DesignRegion = {
      id: 'full-circle',
      sourceSequenceId: '/workspace/circular.gb',
      sourceSequenceName: 'circular',
      sourceStart: 0,
      sourceEnd: sourceSequence.length,
      sourceSequence,
      sourceLength: sourceSequence.length,
      sourceIsCircular: true,
      sequence: sourceSequence,
      annotations: [],
    };

    const reversed = reverseComplementDesignRegion(region);

    expect(reversed).toMatchObject({
      sourceStart: 0,
      sourceEnd: sourceSequence.length,
    });
    expect(reverseComplementDesignRegion(reversed!)).toEqual(region);
  });
});
