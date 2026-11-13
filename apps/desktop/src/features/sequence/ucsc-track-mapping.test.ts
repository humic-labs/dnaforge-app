// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { adaptUcscRecords } from './ucsc-track-mapping';

describe('adaptUcscRecords', () => {
  it('preserves a gene model and offsets a non-anchor chromosome onto the assembly axis', () => {
    const adapted = adaptUcscRecords(
      'transcript',
      [
        {
          chrom: 'chr2',
          chromStart: 924_431,
          chromEnd: 944_574,
          name: 'ENST00000342066.8',
          geneName: 'SAMD11',
          strand: '+',
          thickStart: 925_000,
          thickEnd: 944_000,
          blockSizes: '1000,2000,',
          chromStarts: '0,18143,',
        },
        { chromStart: 50, chromEnd: 40, name: 'invalid' },
      ],
      {
        chrom: 'chr2',
        localStart: 920_000,
        localEnd: 950_000,
        globalStart: 248_956_422,
      }
    );

    expect(adapted.scientificKind).toBe('transcript');
    if (adapted.scientificKind !== 'transcript') throw new Error('wrong adapter');
    expect(adapted.records).toHaveLength(1);
    expect(adapted.records[0]).toMatchObject({
      chrom: 'chr2',
      start: 249_880_853,
      end: 249_900_996,
      transcriptId: 'ENST00000342066.8',
      geneName: 'SAMD11',
      strand: '+',
      exons: [
        { start: 249_880_853, end: 249_881_853 },
        { start: 249_898_996, end: 249_900_996 },
      ],
    });
  });
});
