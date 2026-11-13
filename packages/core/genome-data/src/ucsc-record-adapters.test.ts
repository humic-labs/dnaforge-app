import { describe, expect, it } from 'vitest';

import { adaptUcscTrackRecords } from './ucsc-record-adapters';

const CHR2 = {
  chrom: 'chr2',
  localStart: 920_000,
  localEnd: 950_000,
  globalStart: 248_956_422,
} as const;

describe('UCSC semantic record adapters', () => {
  it('preserves transcript exons, CDS blocks, strand, identity, and source color', () => {
    const result = adaptUcscTrackRecords(
      'transcript',
      [
        {
          chromStart: 924_431,
          chromEnd: 944_574,
          name: 'ENST00000342066.8',
          name2: 'ENSG00000187634.13',
          geneName: 'SAMD11',
          strand: '+',
          thickStart: 925_100,
          thickEnd: 943_900,
          blockSizes: '1000,500,2000,',
          chromStarts: '0,5000,18143,',
          exonFrames: '0,1,2,',
          itemRgb: '12,34,56',
        },
      ],
      CHR2
    );

    expect(result.scientificKind).toBe('transcript');
    if (result.scientificKind !== 'transcript') throw new Error('wrong adapter');
    expect(result.records).toEqual([
      expect.objectContaining({
        transcriptId: 'ENST00000342066.8',
        geneId: 'ENSG00000187634.13',
        geneName: 'SAMD11',
        strand: '+',
        start: 249_880_853,
        end: 249_900_996,
        color: 0x0c2238,
        exons: [
          { start: 249_880_853, end: 249_881_853 },
          { start: 249_885_853, end: 249_886_353 },
          { start: 249_898_996, end: 249_900_996 },
        ],
        cds: [
          { start: 249_881_522, end: 249_881_853, phase: 0 },
          { start: 249_885_853, end: 249_886_353, phase: 1 },
          { start: 249_898_996, end: 249_900_322, phase: 2 },
        ],
      }),
    ]);
  });

  it('keeps interval, peak, repeat, and quantitative semantics distinct', () => {
    const raw = [{ chromStart: 924_431, chromEnd: 924_531, name: 'row', strand: '+' }];
    const interval = adaptUcscTrackRecords('interval', raw, CHR2);
    const peak = adaptUcscTrackRecords(
      'peak',
      [{ ...raw[0], peak: 25, signalValue: 12.5, qValue: 8.1 }],
      CHR2
    );
    const repeat = adaptUcscTrackRecords(
      'repeat',
      [{ ...raw[0], repClass: 'LINE', repFamily: 'L1' }],
      CHR2
    );
    const quantitative = adaptUcscTrackRecords('quantitative', [{ ...raw[0], value: -0.75 }], CHR2);

    expect(interval).toMatchObject({
      scientificKind: 'interval',
      records: [{ name: 'row', start: 249_880_853, end: 249_880_953 }],
    });
    expect(peak).toMatchObject({
      scientificKind: 'peak',
      records: [{ summit: 249_880_878, signalValue: 12.5, qValue: 8.1 }],
    });
    expect(repeat).toMatchObject({
      scientificKind: 'repeat',
      records: [{ repeatClass: 'LINE', repeatFamily: 'L1' }],
    });
    expect(quantitative).toMatchObject({
      scientificKind: 'quantitative',
      records: [{ value: -0.75, start: 249_880_853, end: 249_880_953 }],
    });
  });

  it('adapts a real genePred row, whose bounds are named txStart and txEnd', () => {
    const result = adaptUcscTrackRecords(
      'transcript',
      [
        {
          bin: 585,
          name: 'YDL219W',
          chrom: 'chrIV',
          strand: '+',
          txStart: 65_241,
          txEnd: 65_765,
          cdsStart: 65_241,
          cdsEnd: 65_765,
          exonCount: 2,
          exonStarts: '65241,65457,',
          exonEnds: '65299,65765,',
          proteinID: 'Q12220',
        },
      ],
      { chrom: 'chrIV', localStart: 0, localEnd: 1_531_933, globalStart: 1_360_022 }
    );

    expect(result.scientificKind).toBe('transcript');
    if (result.scientificKind !== 'transcript') throw new Error('wrong adapter');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      transcriptId: 'YDL219W',
      strand: '+',
      start: 1_360_022 + 65_241,
      end: 1_360_022 + 65_765,
      exons: [
        { start: 1_360_022 + 65_241, end: 1_360_022 + 65_299 },
        { start: 1_360_022 + 65_457, end: 1_360_022 + 65_765 },
      ],
    });
    expect(result.records[0]?.cds).toHaveLength(2);
  });

  it('adapts a real cpgIslandExt record without dropping CpG metadata', () => {
    const result = adaptUcscTrackRecords(
      'interval',
      [
        {
          bin: 585,
          chrom: 'chr1',
          chromStart: 28_735,
          chromEnd: 29_737,
          name: 'CpG: 111',
          length: 1002,
          cpgNum: 111,
          gcNum: 731,
          perCpg: 22.2,
          perGc: 73,
          obsExp: 0.85,
        },
      ],
      { chrom: 'chr1', localStart: 0, localEnd: 65_536, globalStart: 0 }
    );

    expect(result).toMatchObject({
      scientificKind: 'interval',
      records: [
        {
          chrom: 'chr1',
          start: 28_735,
          end: 29_737,
          name: 'CpG: 111',
          extra: {
            bin: 585,
            chrom: 'chr1',
            chromStart: 28_735,
            chromEnd: 29_737,
            name: 'CpG: 111',
            length: 1002,
            cpgNum: 111,
            gcNum: 731,
            perCpg: 22.2,
            perGc: 73,
            obsExp: 0.85,
          },
        },
      ],
    });
  });

  it('rejects scientific kinds owned by BAM and VCF workflows', () => {
    expect(() => adaptUcscTrackRecords('reads', [], CHR2)).toThrow(
      'established dedicated workflow'
    );
    expect(() => adaptUcscTrackRecords('variants', [], CHR2)).toThrow(
      'established dedicated workflow'
    );
  });
});
