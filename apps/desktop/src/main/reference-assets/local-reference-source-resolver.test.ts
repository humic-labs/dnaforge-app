import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_GENERIC_REFERENCE_FOLDER_ENTRIES,
  resolveGenericReferenceFolder,
  resolveLocalReferenceSelection,
} from './local-reference-source-resolver';

const temporaryRoots: string[] = [];

async function temporaryFolder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dnaforge-reference-folder-')));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('local reference folder resolver', () => {
  it('resolves one FASTA and one GFF3 without exposing unrelated files', async () => {
    const root = await temporaryFolder();
    await Promise.all([
      writeFile(join(root, 'assembly.fna'), '>chr1\nACGT\n'),
      writeFile(join(root, 'annotations.gff3.gz'), 'compressed fixture placeholder'),
      writeFile(join(root, 'README.txt'), 'ignored'),
    ]);

    await expect(resolveGenericReferenceFolder(root)).resolves.toEqual({
      kind: 'generic-folder',
      sourcePaths: [join(root, 'assembly.fna'), join(root, 'annotations.gff3.gz')],
    });
  });

  it('fails closed instead of guessing between multiple assemblies', async () => {
    const root = await temporaryFolder();
    await Promise.all([
      writeFile(join(root, 'primary.fa'), '>chr1\nACGT\n'),
      writeFile(join(root, 'haplotype.fa'), '>chr1\nACGT\n'),
      writeFile(join(root, 'annotations.gff3'), '##gff-version 3\n'),
    ]);

    await expect(resolveGenericReferenceFolder(root)).rejects.toThrow(
      'Found 2 FASTA and 1 GFF3 candidates'
    );
  });

  it('resolves a sequence-only folder without inventing an annotation source', async () => {
    const root = await temporaryFolder();
    await writeFile(join(root, 'assembly.fa'), '>chr1\nACGT\n');

    await expect(resolveGenericReferenceFolder(root)).resolves.toEqual({
      kind: 'generic-folder',
      sourcePaths: [join(root, 'assembly.fa')],
    });
  });

  it('passes one standalone source file to content validation', async () => {
    const root = await temporaryFolder();
    const fastaPath = join(root, 'assembly.data');
    await writeFile(fastaPath, '>chr1\nACGT\n');

    await expect(
      resolveLocalReferenceSelection({
        selection: { path: fastaPath },
        stagingRoot: join(root, '.staging'),
      })
    ).resolves.toEqual({
      kind: 'standalone-fasta',
      sourcePaths: [fastaPath],
    });
  });

  it('rejects a symlinked source candidate', async () => {
    const root = await temporaryFolder();
    const outside = await temporaryFolder();
    await writeFile(join(outside, 'assembly.fa'), '>chr1\nACGT\n');
    await symlink(join(outside, 'assembly.fa'), join(root, 'assembly.fa'));
    await writeFile(join(root, 'annotations.gff3'), '##gff-version 3\n');

    await expect(resolveGenericReferenceFolder(root)).rejects.toThrow('symbolic links');
  });

  it('does not recursively discover nested candidate files', async () => {
    const root = await temporaryFolder();
    await mkdir(join(root, 'nested'));
    await Promise.all([
      writeFile(join(root, 'assembly.fa'), '>chr1\nACGT\n'),
      writeFile(join(root, 'annotations.gff3'), '##gff-version 3\n'),
      writeFile(join(root, 'nested', 'other.fa'), '>chr2\nACGT\n'),
    ]);

    await expect(resolveGenericReferenceFolder(root)).resolves.toMatchObject({
      sourcePaths: [join(root, 'assembly.fa'), join(root, 'annotations.gff3')],
    });
  });

  it('bounds the selected directory scan', async () => {
    const root = await temporaryFolder();
    await Promise.all(
      Array.from({ length: MAX_GENERIC_REFERENCE_FOLDER_ENTRIES + 1 }, (_, index) =>
        writeFile(join(root, `ignored-${index}.txt`), '')
      )
    );

    await expect(resolveGenericReferenceFolder(root)).rejects.toThrow(
      `more than ${MAX_GENERIC_REFERENCE_FOLDER_ENTRIES.toLocaleString('en-US')} items`
    );
  }, 30_000);
});
