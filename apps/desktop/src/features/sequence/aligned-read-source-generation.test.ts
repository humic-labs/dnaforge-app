// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import type { FilesystemStat } from '../../shared/filesystem-stat';
import {
  alignedReadReferenceGenerationKey,
  alignedReadReferenceGenerationsEqual,
  alignedReadSourceGenerationKey,
  captureAlignedReadReferenceGeneration,
  captureAlignedReadSourceGeneration,
  isAlignedReadReferenceGeneration,
  isAlignedReadSourceGeneration,
} from './aligned-read-source-generation';

function fileStat(path: string, generation: number): FilesystemStat {
  return {
    canonicalPath: `/canonical${path}`,
    size: generation * 100,
    isFile: true,
    isDirectory: false,
    mtime: generation,
    ctime: generation + 1,
    mtimeNs: `${generation}000000`,
    ctimeNs: `${generation + 1}000000`,
    device: '42',
    inode: String(1000 + generation),
  };
}

describe('aligned-read source generation', () => {
  it('captures the alignment and index as one BAM generation receipt', async () => {
    const stat = vi.fn(async (path: string) => fileStat(path, path.endsWith('.bai') ? 2 : 1));

    const receipt = await captureAlignedReadSourceGeneration(
      { bamPath: '/data/sample.bam', indexPath: '/indexes/sample.bam.bai' },
      stat
    );

    expect(stat.mock.calls.map(([path]) => path)).toEqual([
      '/data/sample.bam',
      '/indexes/sample.bam.bai',
    ]);
    expect(receipt).toEqual({
      contract: 'aligned-read-source-generation.v1',
      alignment: {
        canonicalPath: '/canonical/data/sample.bam',
        size: 100,
        mtimeNs: '1000000',
        ctimeNs: '2000000',
        device: '42',
        inode: '1001',
      },
      index: {
        canonicalPath: '/canonical/indexes/sample.bam.bai',
        size: 200,
        mtimeNs: '2000000',
        ctimeNs: '3000000',
        device: '42',
        inode: '1002',
      },
    });
  });

  it('binds a CRAM generation to its alignment, index, reference, and FAI', async () => {
    const paths = [
      '/data/sample.cram',
      '/data/sample.cram.crai',
      '/references/GRCh38.fa',
      '/references/GRCh38.fa.fai',
    ];
    const stat = vi.fn(async (path: string) => fileStat(path, paths.indexOf(path) + 1));

    const receipt = await captureAlignedReadSourceGeneration(
      {
        bamPath: paths[0],
        indexPath: paths[1],
        referencePath: paths[2],
      },
      stat
    );

    expect(stat.mock.calls.map(([path]) => path)).toEqual(paths);
    expect(receipt.reference?.canonicalPath).toBe('/canonical/references/GRCh38.fa');
    expect(receipt.referenceIndex?.canonicalPath).toBe('/canonical/references/GRCh38.fa.fai');
    expect(isAlignedReadSourceGeneration(receipt)).toBe(true);
  });

  it('captures the canonical FASTA and FAI authority for a remote CRAM', async () => {
    const stat = vi.fn(async (path: string) => ({
      ...fileStat(path, path.endsWith('.fai') ? 2 : 1),
      canonicalPath:
        path === '/references/GRCh38.fa'
          ? '/canonical/references/GRCh38.fa'
          : '/canonical/references/GRCh38.fa.fai',
    }));

    const receipt = await captureAlignedReadReferenceGeneration('/references/GRCh38.fa', stat);

    expect(stat.mock.calls.map(([path]) => path)).toEqual([
      '/references/GRCh38.fa',
      '/canonical/references/GRCh38.fa.fai',
    ]);
    expect(receipt).toMatchObject({
      contract: 'aligned-read-reference-generation.v1',
      reference: { canonicalPath: '/canonical/references/GRCh38.fa' },
      referenceIndex: { canonicalPath: '/canonical/references/GRCh38.fa.fai' },
    });
    expect(isAlignedReadReferenceGeneration(receipt)).toBe(true);
    expect(alignedReadReferenceGenerationsEqual(receipt, { ...receipt })).toBe(true);
    expect(alignedReadReferenceGenerationKey(receipt)).toContain(
      '/canonical/references/GRCh38.fa.fai'
    );
  });

  it('rejects a partial persisted generation receipt', () => {
    expect(
      isAlignedReadSourceGeneration({
        contract: 'aligned-read-source-generation.v1',
        alignment: {
          canonicalPath: '/data/sample.bam',
          size: 100,
          mtimeNs: '1',
          ctimeNs: '2',
        },
      })
    ).toBe(false);
  });

  it('changes source identity when the same path is replaced in place', async () => {
    const first = await captureAlignedReadSourceGeneration(
      { bamPath: '/data/sample.bam', indexPath: '/data/sample.bam.bai' },
      async (path) => fileStat(path, path.endsWith('.bai') ? 2 : 1)
    );
    const replacement = await captureAlignedReadSourceGeneration(
      { bamPath: '/data/sample.bam', indexPath: '/data/sample.bam.bai' },
      async (path) => fileStat(path, path.endsWith('.bai') ? 2 : 3)
    );

    expect(first.alignment.canonicalPath).toBe(replacement.alignment.canonicalPath);
    expect(alignedReadSourceGenerationKey(first)).not.toBe(
      alignedReadSourceGenerationKey(replacement)
    );
  });
});
