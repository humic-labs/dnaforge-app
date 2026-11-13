// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { fragmentToRegion } from './fragmentToRegion';
import type { VirtualDigestFragment } from '../hooks/useVirtualDigest';

function createFragment(
  index: number,
  upstreamSeq: string,
  downstreamSeq: string,
  startPosition: number = 0,
  length: number = 100
): VirtualDigestFragment {
  return {
    index,
    startPosition,
    endPosition: startPosition + length,
    length,
    upstream: {
      sequence: upstreamSeq,
      enzymeName: 'TestI',
      enzymeNames: ['TestI'],
      sitePosition: startPosition,
      siteOrientation: 'forward',
    },
    downstream: {
      sequence: downstreamSeq,
      enzymeName: 'TestI',
      enzymeNames: ['TestI'],
      sitePosition: startPosition + length,
      siteOrientation: 'forward',
    },
    ggType: 'insert',
    wrapsOrigin: false,
    annotations: [],
    internalSites: [],
    hasInternalSites: false,
  };
}

describe('fragmentToRegion', () => {
  const sourceSequence = 'A'.repeat(500);
  const baseParams = {
    sourceSequence,
    sourceSequenceId: 'seq1',
    sourceSequenceName: 'Test Sequence',
    overhangLength: 4,
  };

  describe('sibling overhang computation', () => {
    it('includes sibling overhangs when allFragments is provided', () => {
      const fragment0 = createFragment(0, 'AAAA', 'BBBB', 0, 100);
      const fragment1 = createFragment(1, 'CCCC', 'DDDD', 104, 100);
      const fragment2 = createFragment(2, 'EEEE', 'FFFF', 208, 100);

      const allFragments = [fragment0, fragment1, fragment2];

      const region = fragmentToRegion({
        ...baseParams,
        fragment: fragment0,
        allFragments,
      });

      expect(region.rdSiblingOverhangs).toBeDefined();
      expect(region.rdSiblingOverhangs).toContain('CCCC');
      expect(region.rdSiblingOverhangs).toContain('DDDD');
      expect(region.rdSiblingOverhangs).toContain('EEEE');
      expect(region.rdSiblingOverhangs).toContain('FFFF');
    });

    it('excludes own overhangs from sibling list', () => {
      const fragment0 = createFragment(0, 'AAAA', 'BBBB', 0, 100);
      const fragment1 = createFragment(1, 'CCCC', 'DDDD', 104, 100);

      const allFragments = [fragment0, fragment1];

      const region = fragmentToRegion({
        ...baseParams,
        fragment: fragment0,
        allFragments,
      });

      expect(region.rdSiblingOverhangs).not.toContain('AAAA');
      expect(region.rdSiblingOverhangs).not.toContain('BBBB');
      expect(region.rdSiblingOverhangs).toContain('CCCC');
      expect(region.rdSiblingOverhangs).toContain('DDDD');
    });

    it('returns undefined when allFragments is not provided', () => {
      const fragment = createFragment(0, 'AAAA', 'BBBB');

      const region = fragmentToRegion({
        ...baseParams,
        fragment,
      });

      expect(region.rdSiblingOverhangs).toBeUndefined();
    });

    it('returns undefined when only one fragment exists', () => {
      const fragment = createFragment(0, 'AAAA', 'BBBB');

      const region = fragmentToRegion({
        ...baseParams,
        fragment,
        allFragments: [fragment],
      });

      expect(region.rdSiblingOverhangs).toBeUndefined();
    });

    it('normalizes overhangs to uppercase', () => {
      const fragment0 = createFragment(0, 'AAAA', 'BBBB', 0, 100);
      const fragment1 = createFragment(1, 'cccc', 'dddd', 104, 100);

      const allFragments = [fragment0, fragment1];

      const region = fragmentToRegion({
        ...baseParams,
        fragment: fragment0,
        allFragments,
      });

      expect(region.rdSiblingOverhangs).toContain('CCCC');
      expect(region.rdSiblingOverhangs).toContain('DDDD');
    });

    it('deduplicates identical overhangs from different siblings', () => {
      const fragment0 = createFragment(0, 'AAAA', 'BBBB', 0, 100);
      const fragment1 = createFragment(1, 'CCCC', 'DDDD', 104, 100);
      const fragment2 = createFragment(2, 'CCCC', 'EEEE', 208, 100);

      const allFragments = [fragment0, fragment1, fragment2];

      const region = fragmentToRegion({
        ...baseParams,
        fragment: fragment0,
        allFragments,
      });

      const ccccCount = region.rdSiblingOverhangs?.filter((o) => o === 'CCCC').length;
      expect(ccccCount).toBe(1);
    });
  });

  describe('basic region properties', () => {
    it('extracts a one-cut circular RD fragment as the full linearized source object', () => {
      const sourceSequence = 'AAAACCCCGGGGTTTT';
      const fragment = createFragment(0, 'AATT', 'AATT', 4, sourceSequence.length);
      fragment.endPosition = 4;
      fragment.wrapsOrigin = true;

      const region = fragmentToRegion({
        sourceSequence,
        sourceSequenceId: 'seq1',
        sourceSequenceName: 'One Cut Source',
        overhangLength: 4,
        fragment,
        sourceAnnotations: [
          {
            name: 'after-cut',
            type: 'misc_feature',
            start: 6,
            end: 10,
            strand: 'forward',
          },
          {
            name: 'before-cut',
            type: 'misc_feature',
            start: 1,
            end: 3,
            strand: 'reverse',
          },
        ],
      });

      expect(region.sequence).toBe('CCCCGGGGTTTTAAAA');
      expect(region.sourceStart).toBe(4);
      expect(region.sourceEnd).toBe(20);
      expect(region.annotations).toEqual([
        expect.objectContaining({ name: 'after-cut', start: 2, end: 6 }),
        expect.objectContaining({ name: 'before-cut', start: 13, end: 15 }),
      ]);
    });

    it('sets sourceType to rd', () => {
      const fragment = createFragment(0, 'AAAA', 'BBBB');

      const region = fragmentToRegion({
        ...baseParams,
        fragment,
      });

      expect(region.sourceType).toBe('rd');
    });

    it('includes rdOverhangs from fragment', () => {
      const fragment = createFragment(0, 'ATCG', 'GCTA');

      const region = fragmentToRegion({
        ...baseParams,
        fragment,
      });

      expect(region.rdOverhangs).toEqual({
        upstream: 'ATCG',
        downstream: 'GCTA',
      });
    });

    it('stores non-wrapping sourceEnd at the physical fragment boundary', () => {
      const sourceSequence = 'AAAACCCCGGGGTTTT';
      const fragment = createFragment(0, 'AATT', 'AATT', 4, 8);
      fragment.endPosition = 12;

      const region = fragmentToRegion({
        sourceSequence,
        sourceSequenceId: 'seq1',
        sourceSequenceName: 'Boundary Source',
        overhangLength: 4,
        fragment,
      });

      expect(region.sequence).toBe('CCCCGGGG');
      expect(region.sourceStart).toBe(4);
      expect(region.sourceEnd).toBe(12);
      expect(region.sourceEnd - region.sourceStart).toBe(region.sequence.length);
    });

    it('includes ggType from fragment', () => {
      const fragment = createFragment(0, 'AAAA', 'BBBB');
      fragment.ggType = 'backbone';

      const region = fragmentToRegion({
        ...baseParams,
        fragment,
      });

      expect(region.ggType).toBe('backbone');
    });

    it('stores the source enzyme for RD compatibility checks', () => {
      const fragment = createFragment(0, 'AAAA', 'BBBB');

      const region = fragmentToRegion({
        ...baseParams,
        fragment,
        enzymeName: 'BsaI',
      });

      expect(region.rdSourceEnzyme).toBe('BsaI');
    });

    it('canonicalizes Golden Gate isoschizomer-style names while preserving raw enzyme provenance', () => {
      const fragment = createFragment(0, 'AAAA', 'BBBB');

      const region = fragmentToRegion({
        ...baseParams,
        fragment,
        enzymeName: 'BpiI',
      });

      expect(region.rdSourceEnzyme).toBe('BbsI');
      expect(region.rdSourceEnzymeName).toBe('BpiI');
    });

    it('does not narrow mixed active-enzyme digest labels into a Golden Gate source enzyme', () => {
      const fragment = createFragment(0, 'AAAA', 'BBBB');

      const region = fragmentToRegion({
        ...baseParams,
        fragment,
        enzymeName: 'AatII + BsaI',
      });

      expect(region.rdSourceEnzyme).toBeUndefined();
      expect(region.rdSourceEnzymeName).toBe('AatII + BsaI');
    });

    it('carries annotations in fragment-relative coordinates', () => {
      const fragment = createFragment(0, 'AAAA', 'BBBB', 100, 80);

      const region = fragmentToRegion({
        ...baseParams,
        fragment,
        sourceAnnotations: [
          {
            name: 'cargo',
            type: 'CDS',
            start: 120,
            end: 150,
            strand: 'forward',
            color: '#123456',
          },
        ],
      });

      expect(region.annotations).toEqual([
        {
          name: 'cargo',
          type: 'CDS',
          start: 20,
          end: 50,
          strand: 'forward',
          color: '#123456',
        },
      ]);
    });
  });

  describe('origin-spanning annotation remapping ', () => {
    const src = 'AAAACCCCGGGGTTTT';

    it('carries an origin-spanning annotation whose feature excludes the cut as one contiguous re-indexed interval', () => {
      const fragment = createFragment(0, 'AATT', 'AATT', 4, src.length);
      fragment.endPosition = 4;
      fragment.wrapsOrigin = true;

      const region = fragmentToRegion({
        sourceSequence: src,
        sourceSequenceId: 'seq1',
        sourceSequenceName: 'origin-spanning source',
        overhangLength: 4,
        fragment,
        sourceAnnotations: [
          { name: 'ori-feature', type: 'misc_feature', start: 14, end: 2, strand: 'forward' },
        ],
      });

      expect(region.annotations).toEqual([
        expect.objectContaining({ name: 'ori-feature', start: 10, end: 14, strand: 'forward' }),
      ]);
    });

    it('does not clip an origin-spanning annotation contained in a wrapping multi-cut fragment', () => {
      const fragment = createFragment(0, 'AATT', 'AATT', 10, 12);
      fragment.endPosition = 6;
      fragment.wrapsOrigin = true;

      const region = fragmentToRegion({
        sourceSequence: src,
        sourceSequenceId: 'seq1',
        sourceSequenceName: 'origin-spanning source',
        overhangLength: 4,
        fragment,
        sourceAnnotations: [
          { name: 'ori-feature', type: 'misc_feature', start: 14, end: 2, strand: 'forward' },
        ],
      });

      expect(region.annotations).toEqual([
        expect.objectContaining({ name: 'ori-feature', start: 4, end: 8, strand: 'forward' }),
      ]);
    });

    it('splits a feature straddling a cut into one piece per resulting fragment', () => {
      const fragA = createFragment(0, 'AATT', 'AATT', 1, 8);
      fragA.endPosition = 9;
      fragA.wrapsOrigin = false;
      const fragB = createFragment(1, 'AATT', 'AATT', 9, 8);
      fragB.endPosition = 1;
      fragB.wrapsOrigin = true;

      const ann = {
        name: 'straddle',
        type: 'misc_feature',
        start: 14,
        end: 4,
        strand: 'forward' as const,
      };

      const regionA = fragmentToRegion({
        sourceSequence: src,
        sourceSequenceId: 's',
        sourceSequenceName: 'n',
        overhangLength: 4,
        fragment: fragA,
        sourceAnnotations: [ann],
      });
      const regionB = fragmentToRegion({
        sourceSequence: src,
        sourceSequenceId: 's',
        sourceSequenceName: 'n',
        overhangLength: 4,
        fragment: fragB,
        sourceAnnotations: [ann],
      });

      expect(regionA.annotations).toEqual([
        expect.objectContaining({ name: 'straddle', start: 0, end: 3 }),
      ]);
      expect(regionB.annotations).toEqual([
        expect.objectContaining({ name: 'straddle', start: 5, end: 8 }),
      ]);
    });
  });
});
