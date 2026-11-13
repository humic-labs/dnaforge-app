import { describe, it, expect } from 'vitest';
import type { IndexedGenomeManifest } from './types';
import {
  assemblyOfOne,
  assemblyTotalLengthBp,
  buildAssemblyManifest,
  type AssemblyChromosomeEntry,
} from './assembly-manifest';

function manifest(chrom: string): IndexedGenomeManifest {
  return {
    chrom,
    fastaPath: `/idx/${chrom}.fa`,
    faiPath: `/idx/${chrom}.fa.fai`,
    gffPath: `/idx/${chrom}.gff3.gz`,
    tbiPath: `/idx/${chrom}.gff3.gz.tbi`,
    length: 1000,
  };
}

function entry(chrom: string, length: number): AssemblyChromosomeEntry {
  return { chrom, displayName: chrom, length, manifest: manifest(chrom), cytobandId: chrom };
}

describe('assembly-manifest ', () => {
  it('builds and sums lengths', () => {
    const asm = buildAssemblyManifest({
      assemblyId: 'grch38',
      displayName: 'GRCh38',
      organism: 'Homo sapiens',
      taxId: 9606,
      chromosomes: [
        entry('chr1', 248_956_422),
        entry('chr11', 135_086_622),
        entry('chr22', 50_818_468),
      ],
    });
    expect(asm.chromosomes.map((c) => c.chrom)).toEqual(['chr1', 'chr11', 'chr22']);
    expect(assemblyTotalLengthBp(asm)).toBe(248_956_422 + 135_086_622 + 50_818_468);
  });

  it('threads the per-chromosome manifest through unchanged', () => {
    const m = manifest('chr11');
    const asm = buildAssemblyManifest({
      assemblyId: 'a',
      displayName: 'a',
      chromosomes: [{ chrom: 'chr11', displayName: 'chr11', length: 1000, manifest: m }],
    });
    expect(asm.chromosomes[0].manifest).toBe(m);
  });

  it('rejects invalid assemblies', () => {
    expect(() =>
      buildAssemblyManifest({ assemblyId: 'a', displayName: 'a', chromosomes: [] })
    ).toThrow(/no chromosomes/);
    expect(() =>
      buildAssemblyManifest({
        assemblyId: 'a',
        displayName: 'a',
        chromosomes: [
          { chrom: 'chr1', displayName: 'chr1', length: 10, manifest: manifest('chrX') },
        ],
      })
    ).toThrow(/!== entry.manifest.chrom/);
    expect(() =>
      buildAssemblyManifest({ assemblyId: 'a', displayName: 'a', chromosomes: [entry('chr1', 0)] })
    ).toThrow(/non-positive length/);
    expect(() =>
      buildAssemblyManifest({
        assemblyId: 'a',
        displayName: 'a',
        chromosomes: [entry('chr1', 10), entry('chr1', 20)],
      })
    ).toThrow(/duplicate chromosome id/);
  });

  it('assemblyOfOne wraps a single manifest as the degenerate N=1 assembly', () => {
    const m = manifest('chr11');
    const asm = assemblyOfOne(m, { length: 135_086_622 });
    expect(asm.chromosomes).toHaveLength(1);
    expect(asm.chromosomes[0].chrom).toBe('chr11');
    expect(asm.chromosomes[0].manifest).toBe(m);
    expect(asm.chromosomes[0].length).toBe(135_086_622);
    expect(asm.chromosomes[0].cytobandId).toBe('chr11');
    expect(assemblyTotalLengthBp(asm)).toBe(135_086_622);
  });

  it('assemblyOfOne falls back to manifest.length when no length given', () => {
    const asm = assemblyOfOne(manifest('chr1'));
    expect(asm.chromosomes[0].length).toBe(1000);
  });
});
