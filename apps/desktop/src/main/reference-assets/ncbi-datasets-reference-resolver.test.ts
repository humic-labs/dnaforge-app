// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from '@waypoint/platform/node-storage';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveNcbiDatasetsSelection } from './ncbi-datasets-reference-resolver';

const ACCESSION = 'GCF_000000001.1';
const FASTA_PATH = `ncbi_dataset/data/${ACCESSION}/${ACCESSION}_fixture_genomic.fna`;
const GFF_PATH = `ncbi_dataset/data/${ACCESSION}/genomic.gff`;
const REPORT_PATH = 'ncbi_dataset/data/assembly_data_report.jsonl';
const CATALOG_PATH = 'ncbi_dataset/data/dataset_catalog.json';
const FASTA = '>NC_000001.1 fixture chromosome\nACGTACGT\n';
const GFF = '##gff-version 3\nNC_000001.1\tRefSeq\tregion\t1\t8\t.\t+\t.\tID=chr1\n';
const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.spyOn(storage, 'readStorageCapacity').mockResolvedValue({
    destinationPath: '',
    totalBytes: 3996329328640,
    freeBytes: 0,
    importantBytes: 789331063752,
    opportunisticBytes: null,
    availableBytes: 789331063752,
    source: 'macos-important-usage',
    purpose: 'important',
  });
});

async function temporaryFolder(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dnaforge-ncbi-package-')));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('NCBI Datasets reference resolver', () => {
  it('extracts a requested ZIP using reclaimable capacity even with no raw free blocks', async () => {
    const root = await temporaryFolder();
    const archivePath = join(root, 'reference.zip');
    await writeFile(archivePath, packageZip({ includeGff: true }));
    const query = vi.spyOn(storage, 'readStorageCapacity').mockResolvedValue({
      destinationPath: join(root, 'staging'),
      totalBytes: 3996329328640,
      freeBytes: 0,
      importantBytes: 789331063752,
      opportunisticBytes: 48239351818,
      availableBytes: 789331063752,
      source: 'macos-important-usage',
      purpose: 'important',
    });
    const resolved = await resolveNcbiDatasetsSelection({
      selectedPath: archivePath,
      selectedKind: 'file',
      stagingRoot: join(root, 'staging'),
    });
    const gffPath = resolved!.sourcePaths[1];
    if (!gffPath) throw new Error('Reference package did not extract its GFF file.');
    expect(query).toHaveBeenCalledExactlyOnceWith(join(root, 'staging'), { purpose: 'important' });
    await expect(readFile(resolved!.sourcePaths[0], 'utf8')).resolves.toBe(FASTA);
    await expect(readFile(gffPath, 'utf8')).resolves.toBe(GFF);
  });

  it('reports the measured capacity and both parts of the space requirement before extraction', async () => {
    const root = await temporaryFolder();
    const archivePath = join(root, 'reference.zip');
    const stagingRoot = join(root, 'staging');
    await writeFile(archivePath, packageZip({ includeGff: true }));
    const payload = Buffer.byteLength(FASTA) + Buffer.byteLength(GFF);
    const reserve = 512 * 1024 * 1024;
    const available = payload + reserve - 1;
    vi.mocked(storage.readStorageCapacity).mockResolvedValue({
      destinationPath: stagingRoot,
      totalBytes: 2 ** 32,
      freeBytes: 0,
      importantBytes: available,
      opportunisticBytes: null,
      availableBytes: available,
      source: 'macos-important-usage',
      purpose: 'important',
    });

    await expect(
      resolveNcbiDatasetsSelection({
        selectedPath: archivePath,
        selectedKind: 'file',
        stagingRoot,
      })
    ).rejects.toThrow(
      `${available} bytes available (macos-important-usage). ` +
        `The package needs ${payload} bytes plus ${reserve} bytes of reserve.`
    );
    await expect(
      readFile(join(stagingRoot, 'resolved-sources', 'reference.fna'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an unknown capacity error instead of reporting the destination full', async () => {
    const root = await temporaryFolder();
    const archivePath = join(root, 'reference.zip');
    await writeFile(archivePath, packageZip({ includeGff: true }));
    const unknown = Object.assign(new Error('Available storage capacity is unknown.'), {
      code: 'STORAGE_CAPACITY_UNKNOWN',
    });
    vi.spyOn(storage, 'readStorageCapacity').mockRejectedValue(unknown);
    await expect(
      resolveNcbiDatasetsSelection({
        selectedPath: archivePath,
        selectedKind: 'file',
        stagingRoot: join(root, 'staging'),
      })
    ).rejects.toBe(unknown);
  });

  it('resolves the canonical extracted single-assembly layout', async () => {
    const root = await temporaryFolder();
    await writeExtractedPackage(root, { includeGff: true });

    await expect(
      resolveNcbiDatasetsSelection({
        selectedPath: root,
        selectedKind: 'folder',
        stagingRoot: join(root, '.staging'),
      })
    ).resolves.toEqual({
      kind: 'ncbi-datasets',
      sourcePaths: [join(root, FASTA_PATH), join(root, GFF_PATH)],
    });
  });

  it('rejects an extracted package whose publisher checksum does not match', async () => {
    const root = await temporaryFolder();
    await writeExtractedPackage(root, {
      includeGff: true,
      fastaMd5: '00000000000000000000000000000000',
    });

    await expect(
      resolveNcbiDatasetsSelection({
        selectedPath: root,
        selectedKind: 'folder',
        stagingRoot: join(root, '.staging'),
      })
    ).rejects.toThrow(`checksum validation failed for ${FASTA_PATH}`);
  });

  it('extracts only the checked sequence and annotations from an NCBI ZIP', async () => {
    const root = await temporaryFolder();
    const archivePath = join(root, 'reference.zip');
    await writeFile(archivePath, packageZip({ includeGff: true }));

    const resolved = await resolveNcbiDatasetsSelection({
      selectedPath: archivePath,
      selectedKind: 'file',
      stagingRoot: join(root, 'staging'),
    });

    expect(resolved).toMatchObject({
      kind: 'ncbi-datasets',
      sourcePaths: [
        join(root, 'staging', 'resolved-sources', 'reference.fna'),
        join(root, 'staging', 'resolved-sources', 'reference.gff'),
      ],
    });
    const fastaPath = resolved?.sourcePaths[0];
    const gffPath = resolved?.sourcePaths[1];
    if (!fastaPath || !gffPath) throw new Error('Expected checked FASTA and GFF sources.');
    await expect(readFile(fastaPath, 'utf8')).resolves.toBe(FASTA);
    await expect(readFile(gffPath, 'utf8')).resolves.toBe(GFF);
  });

  it('extracts a sequence-only NCBI package without inventing annotation bytes', async () => {
    const root = await temporaryFolder();
    const archivePath = join(root, 'sequence-only.zip');
    await writeFile(archivePath, packageZip({ includeGff: false }));

    await expect(
      resolveNcbiDatasetsSelection({
        selectedPath: archivePath,
        selectedKind: 'file',
        stagingRoot: join(root, 'staging'),
      })
    ).resolves.toEqual({
      kind: 'ncbi-datasets',
      sourcePaths: [join(root, 'staging', 'resolved-sources', 'reference.fna')],
    });
  });

  it('rejects archive traversal before writing any source', async () => {
    const root = await temporaryFolder();
    const archivePath = join(root, 'traversal.zip');
    await writeFile(
      archivePath,
      zipSync({
        '../escape.fna': strToU8(FASTA),
        [REPORT_PATH]: strToU8(`${JSON.stringify({ accession: ACCESSION })}\n`),
      })
    );

    await expect(
      resolveNcbiDatasetsSelection({
        selectedPath: archivePath,
        selectedKind: 'file',
        stagingRoot: join(root, 'staging'),
      })
    ).rejects.toThrow(/invalid relative path|unsafe path/i);
    await expect(readFile(join(root, 'escape.fna'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a package whose checksum does not match the extracted bytes', async () => {
    const root = await temporaryFolder();
    const archivePath = join(root, 'bad-checksum.zip');
    await writeFile(
      archivePath,
      packageZip({ includeGff: true, fastaMd5: '00000000000000000000000000000000' })
    );

    await expect(
      resolveNcbiDatasetsSelection({
        selectedPath: archivePath,
        selectedKind: 'file',
        stagingRoot: join(root, 'staging'),
      })
    ).rejects.toThrow('checksum validation failed');
    await expect(
      readFile(join(root, 'staging', 'resolved-sources', 'reference.fna'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on a multi-assembly report', async () => {
    const root = await temporaryFolder();
    const archivePath = join(root, 'multiple.zip');
    const second = { accession: 'GCF_000000002.1' };
    await writeFile(
      archivePath,
      packageZip({
        includeGff: true,
        reportText: `${JSON.stringify({ accession: ACCESSION })}\n${JSON.stringify(second)}\n`,
      })
    );

    await expect(
      resolveNcbiDatasetsSelection({
        selectedPath: archivePath,
        selectedKind: 'file',
        stagingRoot: join(root, 'staging'),
      })
    ).rejects.toThrow('exactly one reference assembly');
  });
});

async function writeExtractedPackage(
  root: string,
  options: { readonly includeGff: boolean; readonly fastaMd5?: string }
): Promise<void> {
  await mkdir(join(root, 'ncbi_dataset', 'data', ACCESSION), { recursive: true });
  const md5Lines = [
    `${options.fastaMd5 ?? md5(FASTA)}  ./${FASTA_PATH}`,
    ...(options.includeGff ? [`${md5(GFF)}  ./${GFF_PATH}`] : []),
  ];
  await Promise.all([
    writeFile(join(root, REPORT_PATH), `${JSON.stringify({ accession: ACCESSION })}\n`),
    writeFile(join(root, CATALOG_PATH), '{}\n'),
    writeFile(join(root, FASTA_PATH), FASTA),
    ...(options.includeGff ? [writeFile(join(root, GFF_PATH), GFF)] : []),
    writeFile(join(root, 'md5sum.txt'), `${md5Lines.join('\n')}\n`),
  ]);
}

function packageZip(options: {
  readonly includeGff: boolean;
  readonly fastaMd5?: string;
  readonly reportText?: string;
}): Uint8Array {
  const md5Lines = [
    `${options.fastaMd5 ?? md5(FASTA)}  ./${FASTA_PATH}`,
    ...(options.includeGff ? [`${md5(GFF)}  ./${GFF_PATH}`] : []),
  ];
  return zipSync({
    [REPORT_PATH]: strToU8(options.reportText ?? `${JSON.stringify({ accession: ACCESSION })}\n`),
    [CATALOG_PATH]: strToU8('{}\n'),
    [FASTA_PATH]: strToU8(FASTA),
    ...(options.includeGff ? { [GFF_PATH]: strToU8(GFF) } : {}),
    'md5sum.txt': strToU8(`${md5Lines.join('\n')}\n`),
    'README.md': strToU8('NCBI Datasets test package\n'),
  });
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}
