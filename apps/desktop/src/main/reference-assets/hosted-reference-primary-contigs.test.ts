import { describe, expect, it } from 'vitest';

import {
  AGIS1_PRIMARY_CONTIGS,
  DM6_PRIMARY_CONTIGS,
  GRCZ12TU_PRIMARY_CONTIGS,
  MAIZE_NAM5_PRIMARY_CONTIGS,
  MM39_PRIMARY_CONTIGS,
  TAIR10_PRIMARY_CONTIGS,
  XENTRO10_PRIMARY_CONTIGS,
} from './hosted-reference-primary-contigs';

const ASSEMBLIES = [
  ['mm39', MM39_PRIMARY_CONTIGS, 22, 2_723_431_143],
  ['grcz12tu', GRCZ12TU_PRIMARY_CONTIGS, 25, 1_448_791_966],
  ['dm6', DM6_PRIMARY_CONTIGS, 8, 137_567_484],
  ['xenTro10', XENTRO10_PRIMARY_CONTIGS, 11, 1_449_337_250],
  ['tair10', TAIR10_PRIMARY_CONTIGS, 5, 119_146_348],
  ['agis1', AGIS1_PRIMARY_CONTIGS, 12, 385_710_679],
  ['zmB73v5', MAIZE_NAM5_PRIMARY_CONTIGS, 10, 2_131_846_805],
] as const;

describe('hosted primary-chromosome rosters', () => {
  it.each(ASSEMBLIES)(
    'pins the complete %s roster to unique, indexable primary molecules',
    (_id, contigs, expectedCount, expectedLength) => {
      expect(contigs).toHaveLength(expectedCount);
      expect(contigs.reduce((sum, { lengthBp }) => sum + lengthBp, 0)).toBe(expectedLength);
      expect(new Set(contigs.map(({ chrom }) => chrom)).size).toBe(expectedCount);
      expect(new Set(contigs.map(({ sourceSeqId }) => sourceSeqId)).size).toBe(expectedCount);
      expect(
        contigs.every(
          ({ chrom, sourceSeqId, lengthBp, aliases }) =>
            chrom.length > 0 &&
            /^N[CT]_\d+\.\d+$/.test(sourceSeqId) &&
            aliases?.refseq === sourceSeqId &&
            Number.isSafeInteger(lengthBp) &&
            lengthBp > 0 &&
            lengthBp < 2 ** 29
        )
      ).toBe(true);
    }
  );

  it('pins the assembly-specific primary chromosome identities', () => {
    expect(
      MM39_PRIMARY_CONTIGS.map(({ chrom, sourceSeqId, lengthBp }) => [chrom, sourceSeqId, lengthBp])
    ).toEqual([
      ['chr1', 'NC_000067.7', 195_154_279],
      ['chr2', 'NC_000068.8', 181_755_017],
      ['chr3', 'NC_000069.7', 159_745_316],
      ['chr4', 'NC_000070.7', 156_860_686],
      ['chr5', 'NC_000071.7', 151_758_149],
      ['chr6', 'NC_000072.7', 149_588_044],
      ['chr7', 'NC_000073.7', 144_995_196],
      ['chr8', 'NC_000074.7', 130_127_694],
      ['chr9', 'NC_000075.7', 124_359_700],
      ['chr10', 'NC_000076.7', 130_530_862],
      ['chr11', 'NC_000077.7', 121_973_369],
      ['chr12', 'NC_000078.7', 120_092_757],
      ['chr13', 'NC_000079.7', 120_883_175],
      ['chr14', 'NC_000080.7', 125_139_656],
      ['chr15', 'NC_000081.7', 104_073_951],
      ['chr16', 'NC_000082.7', 98_008_968],
      ['chr17', 'NC_000083.7', 95_294_699],
      ['chr18', 'NC_000084.7', 90_720_763],
      ['chr19', 'NC_000085.7', 61_420_004],
      ['chrX', 'NC_000086.8', 169_476_592],
      ['chrY', 'NC_000087.8', 91_455_967],
      ['chrM', 'NC_005089.1', 16_299],
    ]);
    expect(GRCZ12TU_PRIMARY_CONTIGS.map(({ chrom, sourceSeqId }) => [chrom, sourceSeqId])).toEqual(
      Array.from({ length: 25 }, (_, index) => [
        `chr${index + 1}`,
        `NC_${String(133_176 + index).padStart(6, '0')}.1`,
      ])
    );
    expect(DM6_PRIMARY_CONTIGS.map(({ chrom }) => chrom)).toEqual([
      'chr2L',
      'chr2R',
      'chr3L',
      'chr3R',
      'chr4',
      'chrX',
      'chrY',
      'chrM',
    ]);
    expect(XENTRO10_PRIMARY_CONTIGS.map(({ chrom }) => chrom)).toEqual([
      'chr1',
      'chr2',
      'chr3',
      'chr4',
      'chr5',
      'chr6',
      'chr7',
      'chr8',
      'chr9',
      'chr10',
      'chrM',
    ]);
    expect(TAIR10_PRIMARY_CONTIGS.map(({ chrom }) => chrom)).toEqual([
      'chr1',
      'chr2',
      'chr3',
      'chr4',
      'chr5',
    ]);
    expect(AGIS1_PRIMARY_CONTIGS.map(({ chrom }) => chrom)).toEqual(
      Array.from({ length: 12 }, (_, index) => `chr${index + 1}`)
    );
    expect(MAIZE_NAM5_PRIMARY_CONTIGS.map(({ chrom }) => chrom)).toEqual(
      Array.from({ length: 10 }, (_, index) => `chr${index + 1}`)
    );
  });

  it('marks only admitted mitochondrial molecules as circular organelles', () => {
    const organelles = ASSEMBLIES.flatMap(([id, contigs]) =>
      contigs
        .filter(({ role }) => role !== 'assembled-molecule')
        .map(({ chrom, role, circular }) => [id, chrom, role, circular])
    );

    expect(organelles).toEqual([
      ['mm39', 'chrM', 'mitochondrion', true],
      ['dm6', 'chrM', 'mitochondrion', true],
      ['xenTro10', 'chrM', 'mitochondrion', true],
    ]);
    expect(
      ASSEMBLIES.every(([, contigs]) =>
        contigs.every(({ role, circular }) => circular === (role === 'mitochondrion'))
      )
    ).toBe(true);
    expect(GRCZ12TU_PRIMARY_CONTIGS.some(({ chrom }) => chrom === 'chrM')).toBe(false);
    expect(
      [...TAIR10_PRIMARY_CONTIGS, ...AGIS1_PRIMARY_CONTIGS, ...MAIZE_NAM5_PRIMARY_CONTIGS].every(
        ({ role }) => role === 'assembled-molecule'
      )
    ).toBe(true);
  });
});
