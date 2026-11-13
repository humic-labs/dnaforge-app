import { describe, expect, it } from 'vitest';

import { adaptBigBedFeatures, parseBigBedAutoSqlFieldNames } from './bigbed-record-adapter';

const COORDINATES = {
  chrom: 'chr1',
  localStart: 90,
  localEnd: 220,
  globalStart: 1_000,
} as const;

describe('BigBed semantic record adapter', () => {
  it('uses BED12 blocks and AutoSQL fields for imported transcripts', () => {
    const autoSql = `table example\n"example"\n(\n  string chrom; "Reference"\n  uint chromStart; "Start"\n  uint chromEnd; "End"\n  string name; "Transcript"\n  uint score; "Score"\n  char[1] strand; "Strand"\n  uint thickStart; "CDS start"\n  uint thickEnd; "CDS end"\n  uint reserved; "Color"\n  int blockCount; "Block count"\n  int[blockCount] blockSizes; "Block sizes"\n  int[blockCount] chromStarts; "Relative starts"\n  string geneName; "Gene symbol"\n)`;

    expect(parseBigBedAutoSqlFieldNames(autoSql)).toEqual([
      'chrom',
      'chromStart',
      'chromEnd',
      'name',
      'score',
      'strand',
      'thickStart',
      'thickEnd',
      'reserved',
      'blockCount',
      'blockSizes',
      'chromStarts',
      'geneName',
    ]);

    const result = adaptBigBedFeatures(
      'transcript',
      [
        {
          start: 100,
          end: 200,
          rest: 'tx1\t960\t-\t120\t180\t12,34,56\t2\t20,30,\t0,70,\tGENE1',
          uniqueId: 'bb-1-2',
        },
      ],
      COORDINATES,
      { autoSql }
    );

    expect(result).toMatchObject({
      scientificKind: 'transcript',
      records: [
        {
          transcriptId: 'tx1',
          geneName: 'GENE1',
          strand: '-',
          start: 1_100,
          end: 1_200,
          color: 0x0c2238,
          exons: [
            { start: 1_100, end: 1_120 },
            { start: 1_170, end: 1_200 },
          ],
          cds: [{ start: 1_170, end: 1_180 }],
          extra: { uniqueId: 'bb-1-2', geneName: 'GENE1' },
        },
      ],
    });
  });

  it('maps narrowPeak columns without confusing them for BED12 columns', () => {
    const result = adaptBigBedFeatures(
      'peak',
      [{ start: 110, end: 170, rest: 'peak-1\t500\t+\t12.5\t8\t7\t25' }],
      COORDINATES
    );

    expect(result).toMatchObject({
      scientificKind: 'peak',
      records: [
        {
          name: 'peak-1',
          score: 500,
          signalValue: 12.5,
          pValue: 8,
          qValue: 7,
          summit: 1_135,
        },
      ],
    });
  });

  it('preserves interval colors and AutoSQL repeat classification', () => {
    const interval = adaptBigBedFeatures(
      'interval',
      [{ start: 100, end: 125, rest: 'region\t0\t.\t100\t125\t1,2,3' }],
      COORDINATES
    );
    const repeat = adaptBigBedFeatures(
      'repeat',
      [{ start: 130, end: 160, rest: 'repeat\t42\t+\tLINE\tL1' }],
      COORDINATES,
      {
        autoSql:
          'table repeats\n(\nstring chrom;\nuint chromStart;\nuint chromEnd;\nstring name;\nuint score;\nchar[1] strand;\nstring repClass;\nstring repFamily;\n)',
      }
    );

    expect(interval).toMatchObject({ records: [{ name: 'region', color: 0x010203 }] });
    expect(repeat).toMatchObject({
      records: [{ repeatClass: 'LINE', repeatFamily: 'L1', color: 0x2563eb }],
    });
  });
});
