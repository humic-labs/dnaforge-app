import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bgzfFastaProductPaths,
  migrateUncompressedFastaBundle,
  resolveBuiltDnaIndexerBinary,
} from './bgzf-fasta-migration';

const REPO_ROOT = resolve(process.cwd(), '../..');
const INDEXER = resolveBuiltDnaIndexerBinary(REPO_ROOT);

const FIXTURES = [
  {
    name: 'pUC19',
    fasta: join(REPO_ROOT, 'test-fixtures/indexed/pUC19/pUC19.fa'),
    fai: join(REPO_ROOT, 'test-fixtures/indexed/pUC19/pUC19.fa.fai'),
    chrom: 'puc19',
    windows: [
      [0, 24],
      [1200, 1225],
      [2600, 2686],
    ] as const,
  },
  {
    name: 'yeast-chrIV',
    fasta: join(REPO_ROOT, 'test-fixtures/indexed/yeast-chrIV/chrIV.fa'),
    fai: join(REPO_ROOT, 'test-fixtures/indexed/yeast-chrIV/chrIV.fa.fai'),
    chrom: 'chrIV',
    windows: [
      [0, 80],
      [800_000, 800_120],
      [1_531_850, 1_531_933],
    ] as const,
  },
] as const;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!INDEXER)('BGZF FASTA migration replay', () => {
  for (const fixture of FIXTURES) {
    it(
      `migrates ${fixture.name} through the real indexer and the production reader`,
      async () => {
        const root = await mkdtemp(join(tmpdir(), `bgzf-replay-${fixture.name}-`));
        roots.push(root);
        const fastaPath = join(root, `${fixture.name}.fa`);
        const faiPath = `${fastaPath}.fai`;
        await copyFile(fixture.fasta, fastaPath);
        await copyFile(fixture.fai, faiPath);
        await chmod(fastaPath, 0o444);
        await chmod(faiPath, 0o444);

        const before = new LocalIndexedGenomeDataSource(
          { chrom: fixture.chrom, fastaPath, faiPath },
          { checkFileMtimeOnRead: false }
        );
        const length = await before.getChromosomeLength(fixture.chrom);
        const expected = await before.getSequence(fixture.chrom, 0, length);
        const expectedWindows = await Promise.all(
          fixture.windows.map(async ([start, end]) => ({
            start,
            end,
            bases: await before.getSequence(fixture.chrom, start, end),
          }))
        );
        await before.close();

        const first = await migrateUncompressedFastaBundle({
          uncompressedFastaPath: fastaPath,
          indexerBinary: INDEXER!,
        });
        expect(first.alreadyMigrated).toBe(false);
        await expect(readFile(fastaPath)).rejects.toMatchObject({ code: 'ENOENT' });

        const after = new LocalIndexedGenomeDataSource(
          {
            chrom: fixture.chrom,
            fastaPath: first.product.fastaPath,
            faiPath: first.product.faiPath,
            gziPath: first.product.gziPath,
          },
          { checkFileMtimeOnRead: false }
        );
        expect(await after.getChromosomeLength(fixture.chrom)).toBe(length);
        expect(await after.getSequence(fixture.chrom, 0, length)).toBe(expected);
        for (const window of expectedWindows) {
          expect(await after.getSequence(fixture.chrom, window.start, window.end)).toBe(
            window.bases
          );
        }
        await after.close();

        const second = await migrateUncompressedFastaBundle({
          uncompressedFastaPath: fastaPath,
          indexerBinary: INDEXER!,
        });
        expect(second.alreadyMigrated).toBe(true);
      },
      fixture.name === 'yeast-chrIV' ? 30_000 : 15_000
    );
  }

  it('seals after dna-indexer wrote products and originals still exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgzf-replay-crash-'));
    roots.push(root);
    const fastaPath = join(root, 'pUC19.fa');
    await copyFile(FIXTURES[0].fasta, fastaPath);
    await copyFile(FIXTURES[0].fai, `${fastaPath}.fai`);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)(INDEXER!, ['compress-fasta', '--in', fastaPath]);
    const products = bgzfFastaProductPaths(fastaPath);
    expect(existsSync(products.fastaPath)).toBe(true);
    expect(existsSync(fastaPath)).toBe(true);

    let compressCalls = 0;
    const result = await migrateUncompressedFastaBundle({
      uncompressedFastaPath: fastaPath,
      indexerBinary: INDEXER!,
      compress: async () => {
        compressCalls += 1;
        throw new Error('should adopt existing products');
      },
    });
    expect(compressCalls).toBe(0);
    expect(result.alreadyMigrated).toBe(false);
    await expect(readFile(fastaPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const source = new LocalIndexedGenomeDataSource(
      {
        chrom: 'puc19',
        fastaPath: result.product.fastaPath,
        faiPath: result.product.faiPath,
        gziPath: result.product.gziPath,
      },
      { checkFileMtimeOnRead: false }
    );
    expect(await source.getChromosomeLength('puc19')).toBe(2686);
    await source.close();
  });
});
