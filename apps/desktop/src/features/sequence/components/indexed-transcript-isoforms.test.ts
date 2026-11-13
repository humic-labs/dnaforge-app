// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { GenomeFeature, GenomeFeatureDetails } from '../../../shared/indexed-genome';
import { resolveIndexedTranscriptIsoforms } from './indexed-transcript-isoforms';

function feature(
  id: string,
  type: string,
  start: number,
  end: number,
  attributes: Record<string, string[]> = {}
): GenomeFeature {
  return {
    chrom: 'chr1',
    source: 'fixture',
    type,
    start,
    end,
    score: null,
    strand: '+',
    phase: null,
    attributes: { ID: [id], ...attributes },
    raw: '',
  };
}

function details(features: GenomeFeature[], selectedId: string): GenomeFeatureDetails {
  return {
    chrom: 'chr1',
    featureId: selectedId,
    feature: features.find((value) => value.attributes.ID?.includes(selectedId)) ?? null,
    relatedFeatures: features,
    sourceRecordCount: features.length,
    window: { start: 100, end: 900 },
    truncated: false,
  };
}

describe('resolveIndexedTranscriptIsoforms', () => {
  it('returns the current transcript and sibling isoforms from the same parent gene', () => {
    const rows = [
      feature('gene-a', 'gene', 100, 900, { Name: ['GENE-A'] }),
      feature('tx-2', 'mRNA', 180, 800, { Parent: ['gene-a'], Name: ['Isoform beta'] }),
      feature('tx-1', 'transcript', 120, 850, {
        Parent: ['gene-a'],
        transcript_id: ['TX-ALPHA.1'],
      }),
      feature('exon-1', 'exon', 120, 200, { Parent: ['tx-1'] }),
      feature('tx-other', 'mRNA', 300, 700, { Parent: ['gene-b'] }),
    ];

    expect(resolveIndexedTranscriptIsoforms(details(rows, 'tx-1'), 'tx-1')).toEqual([
      {
        featureId: 'tx-1',
        geneId: 'gene-a',
        name: 'TX-ALPHA.1',
        chrom: 'chr1',
        start0: 120,
        end0: 850,
        strand: '+',
        isSelected: true,
      },
      {
        featureId: 'tx-2',
        geneId: 'gene-a',
        name: 'Isoform beta',
        chrom: 'chr1',
        start0: 180,
        end0: 800,
        strand: '+',
        isSelected: false,
      },
    ]);
  });

  it('supports non-coding RNA transcript types and ignores non-transcript children', () => {
    const rows = [
      feature('rna-a', 'lnc_RNA', 10, 80, { Parent: ['gene-a'] }),
      feature('rna-b', 'ncRNA', 20, 70, { Parent: ['gene-a'], Name: ['Noncoding B'] }),
      feature('cds-a', 'CDS', 20, 60, { Parent: ['rna-a'] }),
    ];

    expect(resolveIndexedTranscriptIsoforms(details(rows, 'rna-a'), 'rna-a')).toEqual([
      expect.objectContaining({ featureId: 'rna-a', isSelected: true }),
      expect.objectContaining({ featureId: 'rna-b', name: 'Noncoding B', isSelected: false }),
    ]);
  });

  it('refuses a truncated closure because its sibling list may be incomplete', () => {
    const value = details([feature('tx-1', 'mRNA', 100, 900, { Parent: ['gene-a'] })], 'tx-1');
    value.truncated = true;

    expect(() => resolveIndexedTranscriptIsoforms(value, 'tx-1')).toThrow(/incomplete/i);
  });
});
