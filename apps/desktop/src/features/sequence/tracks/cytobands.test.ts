import { describe, it, expect } from 'vitest';
import {
  cytoBandsByChrom,
  chromosomeById,
  cytoBandsForChrom,
  chromosomeForChrom,
  KARYOTYPE_CHROM_IDS,
} from './cytobands';

const GRCH38_LENGTHS = {
  chr1: 248_956_422,
  chr11: 135_086_622,
  chr22: 50_818_468,
} as const;

const EXPECTED_24 = [...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`), 'chrX', 'chrY'];

describe('cytoband registry  full GRCh38 karyotype)', () => {
  it('registers all 24 chromosomes (chr1-22, chrX, chrY)', () => {
    expect(Object.keys(cytoBandsByChrom).sort()).toEqual([...EXPECTED_24].sort());
    expect(Object.keys(chromosomeById).sort()).toEqual([...EXPECTED_24].sort());
    expect([...KARYOTYPE_CHROM_IDS]).toEqual(EXPECTED_24);
  });

  it('every chromosome is non-empty, single-chrom, and contiguous (first start 0, each start == prev end)', () => {
    for (const chrom of Object.keys(cytoBandsByChrom)) {
      const bands = cytoBandsByChrom[chrom];
      expect(bands.length).toBeGreaterThan(0);
      expect(bands.every((b) => b.chrom === chrom)).toBe(true);
      expect(bands[0].start).toBe(0);
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].start).toBe(bands[i - 1].end);
      }
    }
  });

  it('chromosome length == last band end; matches the GRCh38 length for chr1/chr11/chr22', () => {
    for (const chrom of Object.keys(chromosomeById)) {
      const c = chromosomeById[chrom];
      expect(c.length).toBe(c.cytobands[c.cytobands.length - 1].end);
      expect(c.id).toBe(chrom);
      expect(c.displayName).toBe(chrom);
    }
    for (const [chrom, len] of Object.entries(GRCH38_LENGTHS)) {
      expect(chromosomeById[chrom].length).toBe(len);
    }
  });

  it('chr11 stays pinned to the pre-existing visual-contract fixture (not current UCSC)', () => {
    const chr11 = cytoBandsByChrom.chr11;
    expect(chr11.find((b) => b.name === 'q11')).toMatchObject({
      start: 51_600_000,
      end: 55_700_000,
      stain: 'acen',
    });
    expect(chr11.find((b) => b.name === 'p14.3')?.stain).toBe('gpos50');
  });

  it('unregistered chromosome degrades explicitly to null (never a blank strip)', () => {
    expect(cytoBandsForChrom('chrM')).toBeNull();
    expect(chromosomeForChrom('chrZ')).toBeNull();
    expect(cytoBandsForChrom('chr1_random')).toBeNull();
  });

  it('registered lookups return the same frozen instances', () => {
    expect(cytoBandsForChrom('chr1')).toBe(cytoBandsByChrom.chr1);
    expect(chromosomeForChrom('chr11')).toBe(chromosomeById.chr11);
    expect(Object.isFrozen(cytoBandsByChrom.chr1)).toBe(true);
    expect(Object.isFrozen(chromosomeById.chr11)).toBe(true);
  });

  it('projects admitted UCSC acen records through the provider-neutral morphology boundary', () => {
    expect(chromosomeForChrom('chr11')?.morphology).toEqual({
      kind: 'localized',
      interval: { startBp: 51_000_000, endBp: 55_700_000 },
      topology: 'internal',
    });
  });
});
