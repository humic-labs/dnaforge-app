// @vitest-environment node

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from '@waypoint/platform/node-storage';

import { strToU8, Zip, ZipDeflate, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireNcbiReferencePackage,
  NCBI_REFERENCE_PACKAGE_ACQUISITION_V1,
  NCBI_REFERENCE_PACKAGE_ACQUISITION_V2,
  parseAcquireNcbiReferencePackageCli,
  readNcbiDatasetsAssemblyReport,
  readNcbiDatasetsSequenceReport,
} from './ncbi-reference-package-acquisition';
import type { HostedReferenceExternalAnnotationSourceV1 } from './hosted-reference-external-annotation-source';

const ACCESSION = 'GCF_000000001.1';
const SEQUENCE_ID = 'NC_000001.1';
const FASTA_PATH = `ncbi_dataset/data/${ACCESSION}/${ACCESSION}_fixture_genomic.fna`;
const GFF3_PATH = `ncbi_dataset/data/${ACCESSION}/genomic.gff`;
const SEQUENCE_REPORT_PATH = `ncbi_dataset/data/${ACCESSION}/sequence_report.jsonl`;
const ASSEMBLY_REPORT_PATH = 'ncbi_dataset/data/assembly_data_report.jsonl';
const DATASET_CATALOG_PATH = 'ncbi_dataset/data/dataset_catalog.json';
const FASTA = `>${SEQUENCE_ID} fixture chromosome\nACGTACGT\n`;
const GFF3 = `##gff-version 3\n##sequence-region ${SEQUENCE_ID} 1 8\n${SEQUENCE_ID}\tRefSeq\tregion\t1\t8\t.\t+\t.\tID=${SEQUENCE_ID}\n`;
const EXTERNAL_GFF3 = `Chr1\tNbKLAB\tgene\t1\t8\t.\t+\t.\tID=gene-1\n`;
const EXTERNAL_ANNOTATION: HostedReferenceExternalAnnotationSourceV1 = {
  contract: 'dnaforge-hosted-reference-external-annotation-source.v1',
  provider: 'figshare',
  assemblyId: 'fixture-assembly',
  accession: ACCESSION,
  articleId: 25441192,
  articleVersion: 1,
  fileId: 45147526,
  fileName: 'Nb_KLAB.gff3',
  sha256: sha256(EXTERNAL_GFF3),
  byteLength: Buffer.byteLength(EXTERNAL_GFF3),
  publishedDate: '2024-03-20',
  license: 'CC BY 4.0',
  attribution: 'Shin Ah-Young (2024)',
  sourceUrl:
    'https://figshare.com/articles/dataset/Nicotiana_benthamiana_KLAB_NbKLAB_Genome_assembly_and_annotation/25441192',
};
const SUPPORTED_LARGE_SEQUENCE_REPORT_BYTES = 27_139_558;
const OVERSIZED_SEQUENCE_REPORT_BYTES = 64 * 1024 * 1024 + 1;
const OVERSIZED_STANDARD_METADATA_PADDING_BYTES = 16 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('NCBI reference-package acquisition', () => {
  it('reads accession-bound assembly and chromosome authority metadata', async () => {
    const root = await temporaryRoot();
    const packagePath = join(root, 'fixture.zip');
    await writeFile(packagePath, packageZip());

    await expect(readNcbiDatasetsAssemblyReport(packagePath, ACCESSION)).resolves.toEqual({
      accession: ACCESSION,
      assemblyName: 'Fixture Assembly 1.0',
      assemblyLevel: 'Chromosome',
      assemblyStatus: 'current',
      organismName: 'Fixture organism',
      taxId: 1234,
      totalNumberOfChromosomes: 1,
      annotationName: 'Fixture RefSeq annotation',
      annotationReleaseDate: '2026-08-29',
    });
    await expect(readNcbiDatasetsSequenceReport(packagePath, ACCESSION)).resolves.toEqual([
      {
        assemblyAccession: ACCESSION,
        assemblyUnit: 'Primary Assembly',
        assignedMoleculeLocationType: 'Chromosome',
        chrName: '1',
        sequenceName: 'chr1',
        sortOrder: 1,
        ucscStyleName: 'chr1',
        refseqAccession: SEQUENCE_ID,
        genbankAccession: 'CM000001.1',
        length: 8,
        role: 'assembled-molecule',
      },
    ]);
  });

  it('admits an exact assembly report without an NCBI annotation release', async () => {
    const root = await temporaryRoot();
    const packagePath = join(root, 'sequence-only-fixture.zip');
    await writeFile(packagePath, packageZip({ includeAnnotationInfo: false }));

    await expect(readNcbiDatasetsAssemblyReport(packagePath, ACCESSION)).resolves.toEqual({
      accession: ACCESSION,
      assemblyName: 'Fixture Assembly 1.0',
      assemblyLevel: 'Chromosome',
      assemblyStatus: 'current',
      organismName: 'Fixture organism',
      taxId: 1234,
      totalNumberOfChromosomes: 1,
    });
  });

  it('downloads the exact annotated package and seals create-only final bytes', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    const outputDirectory = join(root, 'output');
    const invocationPath = join(root, 'invocation.json');
    await writeFile(fixture, packageZip());
    const binary = await fakeDatasetsBinary(root, fixture, { invocationPath });

    const result = await acquireNcbiReferencePackage({
      accession: ACCESSION,
      datasetsBinary: binary,
      outputDirectory,
      timeoutMs: 10_000,
    });

    expect(JSON.parse(await readFile(invocationPath, 'utf8'))).toEqual([
      'download',
      'genome',
      'accession',
      ACCESSION,
      '--include',
      'genome,gff3,seq-report',
      '--filename',
      expect.stringMatching(/package\.zip$/u),
      '--no-progressbar',
    ]);
    expect(result.receipt).toMatchObject({
      contract: NCBI_REFERENCE_PACKAGE_ACQUISITION_V1,
      accession: ACCESSION,
      package: { fileName: `${ACCESSION}.ncbi-dataset.zip` },
      sources: {
        fasta: { sha256: sha256(FASTA), byteLength: Buffer.byteLength(FASTA) },
        gff3: { sha256: sha256(GFF3), byteLength: Buffer.byteLength(GFF3) },
      },
    });
    const persistedReceipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
    expect(persistedReceipt).toEqual(result.receipt);
    const finalPackage = await readFile(result.packagePath);
    expect(result.receipt.package).toMatchObject({
      sha256: createHash('sha256').update(finalPackage).digest('hex'),
      byteLength: finalPackage.byteLength,
    });
    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory,
        timeoutMs: 10_000,
      })
    ).rejects.toThrow('already exists');
    expect(JSON.parse(await readFile(invocationPath, 'utf8'))).toHaveLength(9);
  });

  it('admits the supported 27 MB sequence report that exceeds the former bound', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    await writeFile(
      fixture,
      packageZipWithSequenceReportBytes(SUPPORTED_LARGE_SEQUENCE_REPORT_BYTES)
    );
    const binary = await fakeDatasetsBinary(root, fixture);

    const result = await acquireNcbiReferencePackage({
      accession: ACCESSION,
      datasetsBinary: binary,
      outputDirectory: join(root, 'output'),
      timeoutMs: 10_000,
    });

    expect(result.receipt.reports.sequence).toMatchObject({
      byteLength: SUPPORTED_LARGE_SEQUENCE_REPORT_BYTES,
      recordCount: 1,
    });
  }, 30_000);

  it('still rejects a sequence report above the bounded metadata limit', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    await writeFile(fixture, packageZipWithSequenceReportBytes(OVERSIZED_SEQUENCE_REPORT_BYTES));
    const binary = await fakeDatasetsBinary(root, fixture);

    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory: join(root, 'output'),
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/metadata entry is too large/i);
    await expectAcquisitionCleaned(root);
  }, 30_000);

  it('keeps non-sequence metadata at the smaller 16 MiB bound', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    await writeFile(
      fixture,
      packageZip({ assemblyReportPaddingBytes: OVERSIZED_STANDARD_METADATA_PADDING_BYTES })
    );
    const binary = await fakeDatasetsBinary(root, fixture);

    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory: join(root, 'output'),
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/metadata entry is too large/i);
    await expectAcquisitionCleaned(root);
  }, 30_000);

  it('rejects a package for a different accession without leaving final files', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    await writeFile(fixture, packageZip({ reportAccession: 'GCF_000000002.1' }));
    const binary = await fakeDatasetsBinary(root, fixture);

    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory: join(root, 'output'),
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/accession/i);
    await expectAcquisitionCleaned(root);
  });

  it('rejects sequence-only packages instead of inventing annotations', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    await writeFile(fixture, packageZip({ includeGff3: false }));
    const binary = await fakeDatasetsBinary(root, fixture);

    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory: join(root, 'output'),
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/GFF3/i);
    await expectAcquisitionCleaned(root);
  });

  it('binds a pinned Figshare annotation to an otherwise sequence-only exact package', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    const outputDirectory = join(root, 'output');
    await writeFile(fixture, packageZip({ includeGff3: false }));
    const binary = await fakeDatasetsBinary(root, fixture);
    const fetchAsset = async (input: string | URL): Promise<Response> => {
      expect(String(input)).toBe('https://ndownloader.figshare.com/files/45147526');
      const response = new Response(EXTERNAL_GFF3, {
        status: 200,
        headers: { 'content-length': String(Buffer.byteLength(EXTERNAL_GFF3)) },
      });
      Object.defineProperty(response, 'url', { value: String(input) });
      return response;
    };

    const result = await acquireNcbiReferencePackage({
      accession: ACCESSION,
      datasetsBinary: binary,
      outputDirectory,
      externalAnnotation: EXTERNAL_ANNOTATION,
      fetchAsset,
      timeoutMs: 10_000,
    });

    expect(result.receipt).toMatchObject({
      contract: NCBI_REFERENCE_PACKAGE_ACQUISITION_V2,
      accession: ACCESSION,
      sources: {
        fasta: { sha256: sha256(FASTA), byteLength: Buffer.byteLength(FASTA) },
        gff3: {
          fileName: `${ACCESSION}.external-annotation.gff3`,
          sha256: sha256(EXTERNAL_GFF3),
          byteLength: Buffer.byteLength(EXTERNAL_GFF3),
        },
      },
      externalAnnotation: {
        provider: 'Figshare',
        datasetId: '10.6084/m9.figshare.25441192.v1',
        fileId: 45147526,
        sourceUrl: EXTERNAL_ANNOTATION.sourceUrl,
        downloadUrl: 'https://ndownloader.figshare.com/files/45147526',
        license: 'CC BY 4.0',
        attribution: 'Shin Ah-Young (2024)',
      },
    });
    expect(result.annotationPath).toBe(
      join(outputDirectory, `${ACCESSION}.external-annotation.gff3`)
    );
    await expect(readFile(result.annotationPath!, 'utf8')).resolves.toBe(EXTERNAL_GFF3);
  });

  it('rejects external annotation bytes that differ from the reviewed identity', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    await writeFile(fixture, packageZip({ includeGff3: false }));
    const binary = await fakeDatasetsBinary(root, fixture);
    const response = new Response(`${EXTERNAL_GFF3}changed\n`, { status: 200 });
    Object.defineProperty(response, 'url', {
      value: 'https://ndownloader.figshare.com/files/45147526',
    });

    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory: join(root, 'output'),
        externalAnnotation: EXTERNAL_ANNOTATION,
        fetchAsset: async () => response,
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/pinned byte length|pinned source identity/i);
    await expectAcquisitionCleaned(root);
  });

  it('rejects publisher-checksum mismatch without leaving final files', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    await writeFile(fixture, packageZip({ fastaMd5: '00000000000000000000000000000000' }));
    const binary = await fakeDatasetsBinary(root, fixture);

    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory: join(root, 'output'),
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/checksum validation failed/i);
    await expectAcquisitionCleaned(root);
  });

  it('rejects sequence-report checksum mismatch without leaving final files', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'fixture.zip');
    await writeFile(fixture, packageZip({ sequenceReportMd5: '00000000000000000000000000000000' }));
    const binary = await fakeDatasetsBinary(root, fixture);

    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory: join(root, 'output'),
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/checksum validation failed/i);
    await expectAcquisitionCleaned(root);
  });

  it('surfaces a nonzero datasets exit without leaving final files', async () => {
    const root = await temporaryRoot();
    const binary = await fakeDatasetsBinary(root, null, { exitCode: 17 });

    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory: join(root, 'output'),
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/exit 17/i);
    await expectAcquisitionCleaned(root);
  });

  it('kills a timed-out download and leaves no final files or temp residue', async () => {
    const root = await temporaryRoot();
    const binary = await fakeDatasetsBinary(root, null, { downloadDelayMs: 5_000 });

    await expect(
      acquireNcbiReferencePackage({
        accession: ACCESSION,
        datasetsBinary: binary,
        outputDirectory: join(root, 'output'),
        timeoutMs: 200,
      })
    ).rejects.toThrow(/timeout/i);
    await expectAcquisitionCleaned(root);
  });

  it('parses only exact-version assembly accessions and explicit paths', () => {
    expect(
      parseAcquireNcbiReferencePackageCli([
        `--accession=${ACCESSION}`,
        '--datasets-binary=/opt/ncbi/datasets',
        '--output-directory=/tmp/reference-acquisitions',
      ])
    ).toEqual({
      accession: ACCESSION,
      datasetsBinary: '/opt/ncbi/datasets',
      outputDirectory: '/tmp/reference-acquisitions',
    });
    expect(
      parseAcquireNcbiReferencePackageCli([
        `--accession=${ACCESSION}`,
        '--datasets-binary=/opt/ncbi/datasets',
        '--output-directory=/tmp/reference-acquisitions',
        `--external-annotation-source=${JSON.stringify(EXTERNAL_ANNOTATION)}`,
      ])
    ).toEqual({
      accession: ACCESSION,
      datasetsBinary: '/opt/ncbi/datasets',
      outputDirectory: '/tmp/reference-acquisitions',
      externalAnnotation: EXTERNAL_ANNOTATION,
    });
    expect(() =>
      parseAcquireNcbiReferencePackageCli([
        '--accession=GCF_000000001',
        '--datasets-binary=/opt/ncbi/datasets',
        '--output-directory=/tmp/reference-acquisitions',
      ])
    ).toThrow(/accession/i);
    expect(() =>
      parseAcquireNcbiReferencePackageCli([
        `--accession=${ACCESSION}`,
        '--datasets-binary=/opt/ncbi/datasets',
        '--output-directory=/tmp/reference-acquisitions',
        '--surprise=true',
      ])
    ).toThrow(/Unknown/i);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-ncbi-acquisition-'));
  temporaryRoots.push(root);
  return root;
}

async function fakeDatasetsBinary(
  root: string,
  fixturePath: string | null,
  options: {
    readonly invocationPath?: string;
    readonly exitCode?: number;
    readonly downloadDelayMs?: number;
  } = {}
): Promise<string> {
  const path = join(root, 'datasets');
  const exitCode = options.exitCode ?? 0;
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('datasets version: 18.11.0\\n');
  process.exit(0);
}
${options.invocationPath ? `fs.writeFileSync(${JSON.stringify(options.invocationPath)}, JSON.stringify(args));` : ''}
${
  options.downloadDelayMs && options.downloadDelayMs > 0
    ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${options.downloadDelayMs});`
    : ''
}
${exitCode === 0 ? '' : `process.stderr.write('fixture download failed\\n'); process.exit(${exitCode});`}
const filenameIndex = args.indexOf('--filename');
if (filenameIndex < 0 || !args[filenameIndex + 1]) process.exit(91);
fs.copyFileSync(${JSON.stringify(fixturePath)}, args[filenameIndex + 1]);
`;
  await writeFile(path, script, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function packageZip(
  options: {
    readonly reportAccession?: string;
    readonly includeGff3?: boolean;
    readonly fastaMd5?: string;
    readonly sequenceReportMd5?: string;
    readonly assemblyReportPaddingBytes?: number;
    readonly includeAnnotationInfo?: boolean;
  } = {}
): Uint8Array {
  const reportAccession = options.reportAccession ?? ACCESSION;
  const includeGff3 = options.includeGff3 ?? true;
  const assemblyReport = `${JSON.stringify({
    accession: reportAccession,
    assemblyInfo: {
      assemblyLevel: 'Chromosome',
      assemblyName: 'Fixture Assembly 1.0',
      assemblyStatus: 'current',
    },
    assemblyStats: { totalNumberOfChromosomes: 1 },
    organism: { organismName: 'Fixture organism', taxId: 1234 },
    ...(options.includeAnnotationInfo === false
      ? {}
      : {
          annotationInfo: {
            name: 'Fixture RefSeq annotation',
            releaseDate: '2026-08-29',
          },
        }),
    ...(options.assemblyReportPaddingBytes
      ? { padding: 'a'.repeat(options.assemblyReportPaddingBytes) }
      : {}),
  })}\n`;
  const sequenceReport = `${JSON.stringify({
    assemblyAccession: reportAccession,
    assemblyUnit: 'Primary Assembly',
    assignedMoleculeLocationType: 'Chromosome',
    chrName: '1',
    sequenceName: 'chr1',
    sortOrder: 1,
    ucscStyleName: 'chr1',
    refseqAccession: SEQUENCE_ID,
    genbankAccession: 'CM000001.1',
    length: 8,
    role: 'assembled-molecule',
  })}\n`;
  const md5Lines = [
    `${options.fastaMd5 ?? md5(FASTA)}  ${FASTA_PATH}`,
    ...(includeGff3 ? [`${md5(GFF3)}  ${GFF3_PATH}`] : []),
    `${md5(assemblyReport)}  ${ASSEMBLY_REPORT_PATH}`,
    `${options.sequenceReportMd5 ?? md5(sequenceReport)}  ${SEQUENCE_REPORT_PATH}`,
  ];
  return zipSync({
    [ASSEMBLY_REPORT_PATH]: strToU8(assemblyReport),
    [DATASET_CATALOG_PATH]: strToU8('{}\n'),
    [FASTA_PATH]: strToU8(FASTA),
    ...(includeGff3 ? { [GFF3_PATH]: strToU8(GFF3) } : {}),
    [SEQUENCE_REPORT_PATH]: strToU8(sequenceReport),
    'md5sum.txt': strToU8(`${md5Lines.join('\n')}\n`),
  });
}

function packageZipWithSequenceReportBytes(targetBytes: number): Uint8Array {
  const assemblyReport = `${JSON.stringify({ accession: ACCESSION })}\n`;
  const prefix = strToU8(
    `{"assemblyAccession":"${ACCESSION}","refseqAccession":"${SEQUENCE_ID}","length":8,"role":"assembled-molecule","padding":"`
  );
  const suffix = strToU8('"}\n');
  const paddingBytes = targetBytes - prefix.byteLength - suffix.byteLength;
  if (paddingBytes < 0)
    throw new Error('Target sequence report is smaller than its JSON envelope.');

  const chunks: Uint8Array[] = [];
  let archiveError: Error | undefined;
  const archive = new Zip((error, chunk) => {
    if (error) archiveError = error;
    else chunks.push(chunk);
  });
  addZipEntry(archive, ASSEMBLY_REPORT_PATH, strToU8(assemblyReport));
  addZipEntry(archive, DATASET_CATALOG_PATH, strToU8('{}\n'));
  addZipEntry(archive, FASTA_PATH, strToU8(FASTA));
  addZipEntry(archive, GFF3_PATH, strToU8(GFF3));

  const sequenceMd5 = createHash('md5');
  const sequenceEntry = new ZipDeflate(SEQUENCE_REPORT_PATH, { level: 1 });
  archive.add(sequenceEntry);
  sequenceMd5.update(prefix);
  sequenceEntry.push(prefix);
  const reusablePadding = new Uint8Array(Math.min(STREAM_CHUNK_BYTES, paddingBytes)).fill(97);
  let remainingPaddingBytes = paddingBytes;
  while (remainingPaddingBytes > 0) {
    const chunk = reusablePadding.subarray(
      0,
      Math.min(reusablePadding.byteLength, remainingPaddingBytes)
    );
    sequenceMd5.update(chunk);
    sequenceEntry.push(chunk);
    remainingPaddingBytes -= chunk.byteLength;
  }
  sequenceMd5.update(suffix);
  sequenceEntry.push(suffix, true);

  const md5Lines = [
    `${md5(FASTA)}  ${FASTA_PATH}`,
    `${md5(GFF3)}  ${GFF3_PATH}`,
    `${md5(assemblyReport)}  ${ASSEMBLY_REPORT_PATH}`,
    `${sequenceMd5.digest('hex')}  ${SEQUENCE_REPORT_PATH}`,
  ];
  addZipEntry(archive, 'md5sum.txt', strToU8(`${md5Lines.join('\n')}\n`));
  archive.end();
  if (archiveError) throw archiveError;
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function addZipEntry(archive: Zip, path: string, bytes: Uint8Array): void {
  const entry = new ZipDeflate(path, { level: 1 });
  archive.add(entry);
  entry.push(bytes, true);
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function expectAcquisitionCleaned(root: string): Promise<void> {
  const output = join(root, 'output');
  await expect(readFile(join(output, `${ACCESSION}.ncbi-dataset.zip`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(join(output, `${ACCESSION}.ncbi-acquisition.json`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(
    readFile(join(output, `${ACCESSION}.external-annotation.gff3`))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  let names: string[] = [];
  try {
    names = await readdir(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  expect(names.filter((name) => name.includes('.acquire-'))).toEqual([]);
}
