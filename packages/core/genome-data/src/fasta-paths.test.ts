import { describe, expect, it } from 'vitest';

import { bgzipFastaGziPath, isBgzipFastaPath } from './fasta-paths';

describe('bgzip FASTA path helpers', () => {
  it('detects BGZF FASTA names and rejects uncompressed FASTA', () => {
    expect(isBgzipFastaPath('/cache/chr1.fa.gz')).toBe(true);
    expect(isBgzipFastaPath('/cache/chr1.fasta.gz')).toBe(true);
    expect(isBgzipFastaPath('/cache/chr1.fna.gz')).toBe(true);
    expect(isBgzipFastaPath('/cache/chr1.fa')).toBe(false);
    expect(isBgzipFastaPath('/cache/chr1.gff3.gz')).toBe(false);
  });

  it('derives the htslib sibling gzip index path', () => {
    expect(bgzipFastaGziPath('/cache/chr1.fa.gz')).toBe('/cache/chr1.fa.gz.gzi');
  });
});
