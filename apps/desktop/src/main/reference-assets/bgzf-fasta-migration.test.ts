import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BGZF_FASTA_MIGRATION_RECEIPT_FILE,
  bgzfFastaProductPaths,
  clearBgzfFastaMigrationInflightForTests,
  hostedObjectSatisfiedByBgzfFastaMigration,
  migrateUncompressedFastaBundle,
  resolveBuiltDnaIndexerBinary,
  uncompressedFastaPathFor,
} from './bgzf-fasta-migration';
import { isBgzfFile } from './reference-preparation-file-integrity';

const DNA_INDEXER = resolveBuiltDnaIndexerBinary(resolve(process.cwd(), '../..'));

const MINIMAL_BGZF = Buffer.from([
  0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x06, 0x00, 0x42, 0x43, 0x02, 0x00,
  0x1b, 0x00,
]);

const roots: string[] = [];

afterEach(async () => {
  clearBgzfFastaMigrationInflightForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bgzf fasta migration', () => {
  it('maps compressed and uncompressed FASTA paths onto the plain sibling', () => {
    expect(uncompressedFastaPathFor('/cache/chr1.fa.gz')).toBe('/cache/chr1.fa');
    expect(uncompressedFastaPathFor('/cache/chr1.fa')).toBe('/cache/chr1.fa');
    expect(uncompressedFastaPathFor('/cache/chr1.gff3.gz')).toBeNull();
  });

  it('compresses, seals a receipt, and deletes the uncompressed originals', async () => {
    const root = await fixtureRoot();
    const fastaPath = join(root, 'chr1.fa');
    const faiPath = join(root, 'chr1.fa.fai');
    const fasta = Buffer.from('>chr1\nACGTACGT\n');
    const fai = Buffer.from('chr1\t8\t6\t8\t9\n');
    await writeFile(fastaPath, fasta);
    await writeFile(faiPath, fai);
    const compressCalls: string[] = [];

    const result = await migrateUncompressedFastaBundle({
      uncompressedFastaPath: fastaPath,
      compress: async (path) => {
        compressCalls.push(path);
        await writeMigratedProducts(path, fai);
      },
    });

    expect(compressCalls).toEqual([fastaPath]);
    expect(result.alreadyMigrated).toBe(false);
    expect(await readFile(result.product.faiPath)).toEqual(fai);
    await expect(readFile(fastaPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(faiPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const receipt = JSON.parse(
      await readFile(join(root, BGZF_FASTA_MIGRATION_RECEIPT_FILE), 'utf8')
    ) as { source: { fastaSha256: string }; product: { faiSha256: string } };
    expect(receipt.source.fastaSha256).toBe(sha256(fasta));
    expect(receipt.product.faiSha256).toBe(sha256(fai));
  });

  it('is idempotent once the receipt and products exist', async () => {
    const root = await fixtureRoot();
    const fastaPath = join(root, 'chr1.fa');
    const fai = Buffer.from('chr1\t8\t6\t8\t9\n');
    await writeFile(fastaPath, '>chr1\nACGTACGT\n');
    await writeFile(`${fastaPath}.fai`, fai);
    let compressCalls = 0;
    const compress = async (path: string): Promise<void> => {
      compressCalls += 1;
      await writeMigratedProducts(path, fai);
    };

    await migrateUncompressedFastaBundle({ uncompressedFastaPath: fastaPath, compress });
    const second = await migrateUncompressedFastaBundle({
      uncompressedFastaPath: fastaPath,
      compress,
    });

    expect(compressCalls).toBe(1);
    expect(second.alreadyMigrated).toBe(true);
  });

  it('seals leftover products after a crash without recompressing', async () => {
    const root = await fixtureRoot();
    const fastaPath = join(root, 'chr1.fa');
    const fai = Buffer.from('chr1\t8\t6\t8\t9\n');
    await writeFile(fastaPath, '>chr1\nACGTACGT\n');
    await writeFile(`${fastaPath}.fai`, fai);
    await writeMigratedProducts(fastaPath, fai);
    let compressCalls = 0;

    const result = await migrateUncompressedFastaBundle({
      uncompressedFastaPath: fastaPath,
      compress: async () => {
        compressCalls += 1;
        throw new Error('compress should not run when products already match');
      },
    });

    expect(compressCalls).toBe(0);
    expect(result.alreadyMigrated).toBe(false);
    await expect(readFile(fastaPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a sealed hosted fasta object as satisfied without the original file', async () => {
    const generationRoot = await fixtureRoot();
    const chromDir = join(generationRoot, 'prepared', 'chr1');
    await mkdir(chromDir, { recursive: true });
    const fastaPath = join(chromDir, 'chr1.fa');
    const fai = Buffer.from('chr1\t8\t6\t8\t9\n');
    const fasta = Buffer.from('>chr1\nACGTACGT\n');
    await writeFile(fastaPath, fasta);
    await writeFile(`${fastaPath}.fai`, fai);
    await migrateUncompressedFastaBundle({
      uncompressedFastaPath: fastaPath,
      compress: async (path) => writeMigratedProducts(path, fai),
    });

    await expect(
      hostedObjectSatisfiedByBgzfFastaMigration({
        generationRoot,
        object: {
          id: 'chr1-fasta',
          role: 'fasta',
          installPath: 'prepared/chr1/chr1.fa',
          sha256: sha256(fasta),
        },
      })
    ).resolves.toBe(true);
    await expect(
      hostedObjectSatisfiedByBgzfFastaMigration({
        generationRoot,
        object: {
          id: 'chr1-fasta-index',
          role: 'fasta-index',
          installPath: 'prepared/chr1/chr1.fa.fai',
          sha256: sha256(fai),
        },
      })
    ).resolves.toBe(true);
    await expect(
      hostedObjectSatisfiedByBgzfFastaMigration({
        generationRoot,
        object: {
          id: 'chr1-fasta',
          role: 'fasta',
          installPath: 'prepared/chr1/chr1.fa',
          sha256: '0'.repeat(64),
        },
      })
    ).resolves.toBe(false);
  });

  it.skipIf(!DNA_INDEXER)(
    'uses dna-indexer compress-fasta and leaves only BGZF products',
    async () => {
      const root = await fixtureRoot();
      const fastaPath = join(root, 'chr1.fa');
      const fasta = Buffer.from('>chr1\nACGTACGT\n');
      const fai = Buffer.from('chr1\t8\t6\t8\t9\n');
      await writeFile(fastaPath, fasta);
      await writeFile(`${fastaPath}.fai`, fai);

      const result = await migrateUncompressedFastaBundle({
        uncompressedFastaPath: fastaPath,
        indexerBinary: DNA_INDEXER!,
      });

      expect(result.alreadyMigrated).toBe(false);
      expect(await isBgzfFile(result.product.fastaPath)).toBe(true);
      expect(await readFile(result.product.faiPath)).toEqual(fai);
      await expect(readFile(fastaPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result.receipt.source.fastaSha256).toBe(sha256(fasta));
      expect(result.receipt.product.faiSha256).toBe(sha256(fai));
    }
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bgzf-fasta-migration-'));
  roots.push(root);
  return root;
}

async function writeMigratedProducts(uncompressedFastaPath: string, fai: Buffer): Promise<void> {
  const products = bgzfFastaProductPaths(uncompressedFastaPath);
  await writeFile(products.fastaPath, MINIMAL_BGZF);
  await writeFile(products.faiPath, fai);
  await writeFile(products.gziPath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
