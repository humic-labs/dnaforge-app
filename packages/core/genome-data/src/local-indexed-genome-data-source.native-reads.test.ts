import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalIndexedGenomeDataSource } from './local-indexed-genome-data-source';

it('assembles concurrent positioned reads from real FASTA and FAI files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'genome-concurrent-'));
  const fastaPath = join(root, 'genome.fa');
  const bases = 'AAAACCCCGGGGTTTTACGTACGTACGTACGTGGGGCCCC';
  await writeFile(fastaPath, `>chr1\n${bases}\n`);
  await writeFile(`${fastaPath}.fai`, `chr1\t40\t6\t40\t41\n`);
  const source = new LocalIndexedGenomeDataSource(
    { chrom: 'chr1', fastaPath, faiPath: `${fastaPath}.fai` },
    { sequenceBlockSize: 4 }
  );
  try {
    const reads = await Promise.all([
      source.getSequence('chr1', 1, 39),
      source.getSequence('chr1', 7, 35),
      source.getSequence('chr1', 0, 40),
    ]);
    expect(reads).toEqual([bases.slice(1, 39), bases.slice(7, 35), bases]);
    await expect(source.getSequence('chr1', 3, 29)).resolves.toBe(bases.slice(3, 29));
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
