// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { reverseComplement, type Annotation } from '@waypoint/sequence-utils';
import {
  buildCopiedRegionFromDesignRegion,
  buildCopiedRegionFromSelection,
  extractDesignAnnotationsForRange,
} from './annotation-transfer';
import type { DesignRegion } from './types';

describe('extractDesignAnnotationsForRange', () => {
  const annotations: Annotation[] = [
    {
      name: 'geneA',
      type: 'CDS',
      start: 11,
      end: 30,
      direction: 1,
      color: '#ff0000',
    },
    {
      name: 'promoter',
      type: 'promoter',
      start: 45,
      end: 55,
      direction: -1,
      color: '#00ff00',
    },
  ];

  it('copies overlapping annotations into selection-relative coordinates', () => {
    const result = extractDesignAnnotationsForRange(annotations, { start: 20, end: 50 }, 100);

    expect(result).toEqual([
      {
        name: 'geneA',
        type: 'CDS',
        start: 0,
        end: 10,
        strand: 'forward',
        color: '#ff0000',
      },
      {
        name: 'promoter',
        type: 'promoter',
        start: 24,
        end: 30,
        strand: 'reverse',
        color: '#00ff00',
      },
    ]);
  });

  it('handles wrapped copied ranges', () => {
    const result = extractDesignAnnotationsForRange(
      [
        {
          name: 'origin-spanning',
          type: 'misc_feature',
          start: 96,
          end: 8,
          direction: 0,
        },
      ],
      { start: 90, end: 12, wraps: true },
      100
    );

    expect(result).toEqual([
      {
        name: 'origin-spanning',
        type: 'misc_feature',
        start: 5,
        end: 10,
        strand: 'none',
        color: undefined,
      },
      {
        name: 'origin-spanning',
        type: 'misc_feature',
        start: 10,
        end: 18,
        strand: 'none',
        color: undefined,
      },
    ]);
  });
});

describe('buildCopiedRegionFromSelection', () => {
  const sourceSequence = 'AAAACCCCGGGGTTTTAAAACCCCGGGGTT';
  const sourceAnnotations: Annotation[] = [
    {
      name: 'geneA',
      type: 'CDS',
      start: 8,
      end: 14,
      direction: 1,
      color: '#ff0000',
      qualifiers: { codon_start: ['1'], note: ['keep-me'] },
    },
    {
      name: 'promoter',
      type: 'promoter',
      start: 16,
      end: 20,
      direction: -1,
      color: '#00ff00',
    },
  ];

  it('builds the same rich copied object for a forward-oriented selection', () => {
    const result = buildCopiedRegionFromSelection({
      sourceId: 'source.gb',
      sourceName: 'source',
      sourceSequence,
      sourceAnnotations,
      sourceIsCircular: false,
      range: { start: 5, end: 17 },
      orientation: 'forward',
    });

    expect(result.clipboardSequence).toBe(sourceSequence.slice(5, 17));
    expect(result.region).toMatchObject({
      sequence: sourceSequence.slice(5, 17),
      sourceSequence,
      sourceId: 'source.gb',
      sourceName: 'source',
      start: 5,
      end: 17,
      sourceIsCircular: false,
      sourceType: 'pcr',
    });
    expect(result.region.annotations).toEqual([
      {
        name: 'geneA',
        type: 'CDS',
        start: 2,
        end: 9,
        strand: 'forward',
        color: '#ff0000',
        qualifiers: { codon_start: '1', note: 'keep-me' },
      },
      {
        name: 'promoter',
        type: 'promoter',
        start: 10,
        end: 12,
        strand: 'reverse',
        color: '#00ff00',
      },
    ]);
  });

  it('reverse-complement copy preserves object shape and transforms annotation register', () => {
    const result = buildCopiedRegionFromSelection({
      sourceId: 'source.gb',
      sourceName: 'source',
      sourceSequence,
      sourceAnnotations,
      sourceIsCircular: false,
      range: { start: 5, end: 17 },
      orientation: 'reverse-complement',
    });

    expect(result.clipboardSequence).toBe(reverseComplement(sourceSequence.slice(5, 17)));
    expect(result.region).toMatchObject({
      sequence: reverseComplement(sourceSequence.slice(5, 17)),
      sourceSequence: reverseComplement(sourceSequence),
      sourceId: 'source.gb',
      sourceName: 'source',
      start: sourceSequence.length - 17,
      end: sourceSequence.length - 5,
      sourceIsCircular: false,
      sourceType: 'pcr',
    });
    expect(result.region.annotations).toEqual([
      {
        name: 'promoter',
        type: 'promoter',
        start: 0,
        end: 2,
        strand: 'forward',
        color: '#00ff00',
      },
      {
        name: 'geneA',
        type: 'CDS',
        start: 3,
        end: 10,
        strand: 'reverse',
        color: '#ff0000',
        qualifiers: { codon_start: '1', note: 'keep-me' },
      },
    ]);
    expect(result.region.sourceAnnotations).toEqual([
      {
        name: 'promoter',
        type: 'promoter',
        start: sourceSequence.length - 20,
        end: sourceSequence.length - 15,
        strand: 'forward',
        color: '#00ff00',
      },
      {
        name: 'geneA',
        type: 'CDS',
        start: sourceSequence.length - 14,
        end: sourceSequence.length - 7,
        strand: 'reverse',
        color: '#ff0000',
        qualifiers: { codon_start: '1', note: 'keep-me' },
      },
    ]);
  });

  it('keeps wrapped circular reverse-complement copies slice-compatible with their source axis', () => {
    const circularSource = 'AAACCCGGGTTT';
    const result = buildCopiedRegionFromSelection({
      sourceId: 'circle.gb',
      sourceName: 'circle',
      sourceSequence: circularSource,
      sourceAnnotations: [],
      sourceIsCircular: true,
      range: { start: 8, end: 2, wraps: true },
      orientation: 'reverse-complement',
    });

    const expectedClipboard = reverseComplement(
      circularSource.slice(8) + circularSource.slice(0, 2)
    );
    const sourceAxisSlice =
      result.region.sourceSequence!.slice(result.region.start) +
      result.region.sourceSequence!.slice(0, result.region.end);

    expect(result.clipboardSequence).toBe(expectedClipboard);
    expect(result.region.sequence).toBe(expectedClipboard);
    expect(result.region.start).toBe(circularSource.length - 2);
    expect(result.region.end).toBe(circularSource.length - 8);
    expect(sourceAxisSlice).toBe(expectedClipboard);
  });
});

describe('buildCopiedRegionFromDesignRegion', () => {
  it('preserves PCR provenance without inventing digest metadata', () => {
    const region: DesignRegion = {
      id: 'pcr-product-1',
      sourceSequenceId: 'template.gb',
      sourceSequenceName: 'Template',
      sourceStart: 30,
      sourceEnd: 38,
      sourceSequence: 'AAAATGCACTGATTTT',
      sourceIsCircular: false,
      sequence: 'TGCACTGA',
      annotations: [],
      sourceType: 'pcr',
    };

    expect(buildCopiedRegionFromDesignRegion(region)).toEqual({
      format: 'dnaforge.rich-sequence-fragment',
      version: 2,
      sequence: 'TGCACTGA',
      sourceSequence: 'AAAATGCACTGATTTT',
      sourceId: 'template.gb',
      sourceName: 'Template',
      start: 30,
      end: 38,
      annotations: [],
      primerBindings: [],
      sourceIsCircular: false,
      sourceType: 'pcr',
    });
  });

  it('preserves the complete restriction-digest provenance contract', () => {
    const region: DesignRegion = {
      id: 'bsaI-fragment-2',
      sourceSequenceId: 'source-plasmid.gb',
      sourceSequenceName: 'Source plasmid',
      sourceStart: 4,
      sourceEnd: 12,
      sourceSequence: 'AAAACCGGTATATTTT',
      sourceLength: 16,
      sourceIsCircular: true,
      sourceAnnotations: [
        {
          name: 'full-source-feature',
          type: 'misc_feature',
          start: 2,
          end: 14,
          strand: 'forward',
        },
      ],
      sequence: 'CCGGTATA',
      annotations: [
        {
          name: 'copied-feature',
          type: 'CDS',
          start: 1,
          end: 7,
          strand: 'reverse',
          color: '#ff0000',
          qualifiers: { note: 'preserve-me' },
        },
      ],
      sourceType: 'rd',
      ggType: 'insert',
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTT' },
      rdSourceEnzyme: 'BsaI',
      rdSourceEnzymeName: 'BsaI-HFv2',
      rdEnds: {
        upstream: {
          overhangType: '5_prime',
          overhang: 'AATG',
        },
        downstream: {
          overhangType: '5_prime',
          overhang: 'GCTT',
        },
      },
      rdSiblingOverhangs: ['AATG', 'GCTT', 'CGCT'],
    };

    expect(buildCopiedRegionFromDesignRegion(region)).toEqual({
      format: 'dnaforge.rich-sequence-fragment',
      version: 2,
      sequence: region.sequence,
      sourceSequence: region.sourceSequence,
      sourceId: region.sourceSequenceId,
      sourceName: region.sourceSequenceName,
      start: region.sourceStart,
      end: region.sourceEnd,
      annotations: region.annotations,
      primerBindings: [],
      sourceAnnotations: region.sourceAnnotations,
      sourceIsCircular: true,
      sourceType: 'rd',
      ggType: 'insert',
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTT' },
      rdSourceEnzyme: 'BsaI',
      rdSourceEnzymeName: 'BsaI-HFv2',
      rdEnds: region.rdEnds,
      rdSiblingOverhangs: ['AATG', 'GCTT', 'CGCT'],
    });
  });
});
