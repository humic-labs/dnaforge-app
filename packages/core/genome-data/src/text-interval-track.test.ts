import { describe, expect, it } from 'vitest';

import { parseTextIntervalTrack } from './text-interval-track';

describe('parseTextIntervalTrack', () => {
  it('maps BED6 to canonical intervals with score and strand metadata', () => {
    const parsed = parseTextIntervalTrack(
      'bed',
      ['track name=targets', 'chr1\t10\t30\ttarget-a\t750\t-', 'chr1\t40\t55'].join('\n')
    );

    expect(parsed.scientificKind).toBe('interval');
    expect(parsed.records).toEqual([
      {
        chrom: 'chr1',
        start: 10,
        end: 30,
        name: 'target-a',
        strand: '-',
        extra: { score: 750 },
      },
      { chrom: 'chr1', start: 40, end: 55 },
    ]);
    expect(parsed.referenceExtents).toEqual([{ name: 'chr1', maxEnd: 55 }]);
    expect(parsed.stats).toEqual({ totalLines: 3, commentLines: 1, parsedRecords: 2 });
  });

  it('infers transcript semantics for BED12 and preserves exon and CDS structure', () => {
    const parsed = parseTextIntervalTrack(
      'bed',
      'chr2\t100\t260\ttx-1\t0\t+\t120\t240\t10,20,30\t3\t40,20,30\t0,80,130'
    );

    expect(parsed.scientificKind).toBe('transcript');
    expect(parsed.records).toEqual([
      {
        chrom: 'chr2',
        start: 100,
        end: 260,
        transcriptId: 'tx-1',
        strand: '+',
        exons: [
          { start: 100, end: 140 },
          { start: 180, end: 200 },
          { start: 230, end: 260 },
        ],
        cds: [
          { start: 120, end: 140 },
          { start: 180, end: 200 },
          { start: 230, end: 240 },
        ],
        color: 0x0a141e,
        extra: { score: 0 },
      },
    ]);
  });

  it('folds GFF3 transcript children and normalizes one-based coordinates', () => {
    const parsed = parseTextIntervalTrack(
      'gff3',
      [
        '##gff-version 3',
        'chr3\tsource\tmRNA\t101\t300\t.\t-\t.\tID=tx-a;Parent=gene-a;Name=Alpha',
        'chr3\tsource\texon\t101\t150\t.\t-\t.\tParent=tx-a',
        'chr3\tsource\texon\t251\t300\t.\t-\t.\tParent=tx-a',
        'chr3\tsource\tCDS\t120\t150\t.\t-\t0\tParent=tx-a',
        'chr3\tsource\tCDS\t251\t280\t.\t-\t2\tParent=tx-a',
      ].join('\n')
    );

    expect(parsed.scientificKind).toBe('transcript');
    expect(parsed.records).toEqual([
      expect.objectContaining({
        chrom: 'chr3',
        start: 100,
        end: 300,
        transcriptId: 'tx-a',
        geneId: 'gene-a',
        geneName: 'Alpha',
        strand: '-',
        exons: [
          { start: 100, end: 150 },
          { start: 250, end: 300 },
        ],
        cds: [
          { start: 119, end: 150, phase: 0 },
          { start: 250, end: 280, phase: 2 },
        ],
      }),
    ]);
  });

  it('folds GTF rows by transcript_id without requiring parent feature rows', () => {
    const parsed = parseTextIntervalTrack(
      'gtf',
      [
        'chr4\tsource\texon\t11\t40\t.\t+\t.\tgene_id "gene-b"; transcript_id "tx-b"; gene_name "Beta";',
        'chr4\tsource\tCDS\t20\t35\t.\t+\t1\tgene_id "gene-b"; transcript_id "tx-b";',
        'chr4\tsource\texon\t61\t90\t.\t+\t.\tgene_id "gene-b"; transcript_id "tx-b";',
      ].join('\n')
    );

    expect(parsed.scientificKind).toBe('transcript');
    expect(parsed.records).toEqual([
      expect.objectContaining({
        chrom: 'chr4',
        start: 10,
        end: 90,
        transcriptId: 'tx-b',
        geneId: 'gene-b',
        geneName: 'Beta',
        exons: [
          { start: 10, end: 40 },
          { start: 60, end: 90 },
        ],
        cds: [{ start: 19, end: 35, phase: 1 }],
      }),
    ]);
  });

  it.each([
    ['genepred' as const, 'tx-c\tchr5\t-\t100\t250\t120\t220\t2\t100,200,\t150,250,', undefined],
    [
      'refflat' as const,
      'Gamma\ttx-c\tchr5\t-\t100\t250\t120\t220\t2\t100,200,\t150,250,',
      'Gamma',
    ],
  ])('maps %s transcript tables', (format, text, geneName) => {
    const parsed = parseTextIntervalTrack(format, text);

    expect(parsed.scientificKind).toBe('transcript');
    expect(parsed.records).toEqual([
      expect.objectContaining({
        transcriptId: 'tx-c',
        ...(geneName ? { geneName } : {}),
        chrom: 'chr5',
        start: 100,
        end: 250,
        strand: '-',
        exons: [
          { start: 100, end: 150 },
          { start: 200, end: 250 },
        ],
        cds: [
          { start: 120, end: 150 },
          { start: 200, end: 220 },
        ],
      }),
    ]);
  });

  it.each([
    ['narrowpeak' as const, 'chr6\t100\t180\tpeak-a\t500\t.\t12.5\t6.1\t5.4\t35', 135],
    ['broadpeak' as const, 'chr6\t200\t280\tpeak-b\t300\t+\t8.5\t4.1\t3.4', undefined],
  ])('maps %s significance fields', (format, text, summit) => {
    const parsed = parseTextIntervalTrack(format, text);

    expect(parsed.scientificKind).toBe('peak');
    expect(parsed.records).toEqual([
      expect.objectContaining({
        chrom: 'chr6',
        score: format === 'narrowpeak' ? 500 : 300,
        signalValue: format === 'narrowpeak' ? 12.5 : 8.5,
        pValue: format === 'narrowpeak' ? 6.1 : 4.1,
        qValue: format === 'narrowpeak' ? 5.4 : 3.4,
        ...(summit === undefined ? {} : { summit }),
      }),
    ]);
  });

  it('fails closed when non-comment rows are malformed', () => {
    expect(() => parseTextIntervalTrack('bed', 'chr1\tnot-a-number\t20')).toThrow('BED line 1');
  });
});
