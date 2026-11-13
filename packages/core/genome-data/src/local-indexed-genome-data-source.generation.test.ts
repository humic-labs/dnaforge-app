import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFile } from 'generic-filehandle2';
import { expect, it } from 'vitest';
import { LocalIndexedGenomeDataSource } from './local-indexed-genome-data-source';
import type { IndexedGenomeDataSourceOptions } from './types';

it('keeps a multi-block read on one actual file generation while another request refreshes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixture-genome-generation-'));
  const fasta = join(root, 'chrI.fa');
  const length = 8192;
  await writeFile(fasta, `>chrI\n${'A'.repeat(length)}\n`);
  await writeFile(`${fasta}.fai`, `chrI\t${length}\t6\t${length}\t${length + 1}\n`);
  let started!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  const options: IndexedGenomeDataSourceOptions = {
    openFile(file) {
      const handle = new LocalFile(file);
      if (file === fasta && !paused) {
        const read = handle.read.bind(handle);
        handle.read = async (...args: Parameters<typeof handle.read>) => {
          const bytes = await read(...args);
          if (!paused) {
            paused = true;
            started();
            await released;
          }
          return bytes;
        };
      }
      return handle;
    },
  };
  const source = new LocalIndexedGenomeDataSource(
    { chrom: 'chrI', fastaPath: fasta, faiPath: `${fasta}.fai` },
    options
  );
  try {
    const pending = source.getSequence('chrI', 0, length);
    await firstRead;
    await writeFile(`${fasta}.new`, `>chrI\n${'C'.repeat(length)}\n`);
    await rename(`${fasta}.new`, fasta);
    expect(await source.getChromosomeLength('chrI')).toBe(length);
    release();
    await expect(pending).rejects.toThrow(/generation changed/);
    expect(await source.getSequence('chrI', 0, length)).toBe('C'.repeat(length));
  } finally {
    release();
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
