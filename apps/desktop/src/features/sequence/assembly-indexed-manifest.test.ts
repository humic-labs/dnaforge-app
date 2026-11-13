// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { completeManifestFromIndexedGff3Source } from './assembly-indexed-manifest';

describe('completeManifestFromIndexedGff3Source', () => {
  it('derives the committed FASTA/FAI/TBI quartet from a .gff3.gz source', () => {
    expect(
      completeManifestFromIndexedGff3Source({
        chrom: 'reference',
        fastaPath: '',
        faiPath: '',
        gffPath: '/workspace/full-genome/members/reference.gff3.gz',
        length: 100_000,
      })
    ).toEqual({
      chrom: 'reference',
      fastaPath: '/workspace/full-genome/members/reference.fa',
      faiPath: '/workspace/full-genome/members/reference.fa.fai',
      gffPath: '/workspace/full-genome/members/reference.gff3.gz',
      tbiPath: '/workspace/full-genome/members/reference.gff3.gz.tbi',
      length: 100_000,
    });
  });

  it('preserves explicit companion paths and ignores ideogram-only chromosomes', () => {
    const explicit = {
      chrom: 'chr1',
      fastaPath: '/idx/ref.fa',
      faiPath: '/idx/ref.fa.fai',
      gffPath: '/idx/ref.gff3.gz',
      tbiPath: '/idx/ref.gff3.gz.tbi',
      length: 248_956_422,
    };
    expect(completeManifestFromIndexedGff3Source(explicit)).toEqual(explicit);

    const ideogramOnly = { chrom: 'chr2', fastaPath: '', faiPath: '', gffPath: null };
    expect(completeManifestFromIndexedGff3Source(ideogramOnly)).toBe(ideogramOnly);
  });
});
