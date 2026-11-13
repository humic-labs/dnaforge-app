// @vitest-environment node

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from '@waypoint/platform/node-storage';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedReferenceContigV1 } from './hosted-reference-catalog';
import { acquireNcbiReferencePackage } from './ncbi-reference-package-acquisition';
import {
  admitNcbiReferenceSource,
  NCBI_REFERENCE_SOURCE_ADMISSION_V1,
  parseAdmitNcbiReferenceSourceCli,
} from './ncbi-reference-source-admission';

const ACCESSION = 'GCF_000000001.1';
const EXTERNAL_ACCESSION = 'GCA_000000001.1';
const SEQUENCE_A = 'NC_000001.1';
const SEQUENCE_B = 'NC_000002.1';
const GENBANK_SEQUENCE = 'CM000001.1';
const AUTHOR_SEQUENCE = 'Chr1';
const FASTA_PATH = `ncbi_dataset/data/${ACCESSION}/${ACCESSION}_fixture_genomic.fna`;
const GFF3_PATH = `ncbi_dataset/data/${ACCESSION}/genomic.gff`;
const SEQUENCE_REPORT_PATH = `ncbi_dataset/data/${ACCESSION}/sequence_report.jsonl`;
const ASSEMBLY_REPORT_PATH = 'ncbi_dataset/data/assembly_data_report.jsonl';
const DATASET_CATALOG_PATH = 'ncbi_dataset/data/dataset_catalog.json';
const FASTA = `>${SEQUENCE_A} fixture chromosome\nACGTACGT\n>${SEQUENCE_B} fixture contig\nTGCATGCA\n`;
const GFF3 = [
  '##gff-version 3',
  `##sequence-region ${SEQUENCE_A} 1 8`,
  `##sequence-region ${SEQUENCE_B} 1 8`,
  `${SEQUENCE_A}\tRefSeq\tregion\t1\t8\t.\t+\t.\tID=${SEQUENCE_A}`,
  `${SEQUENCE_B}\tRefSeq\tregion\t1\t8\t.\t+\t.\tID=${SEQUENCE_B}`,
  '',
].join('\n');
const EXTERNAL_GFF3 = [
  `${AUTHOR_SEQUENCE}\tNbKLAB\tgene\t1\t8\t.\t+\t.\tID=gene-1`,
  `${AUTHOR_SEQUENCE}\tNbKLAB\tmRNA\t1\t8\t.\t+\t.\tID=transcript-1;Parent=gene-1`,
  '',
].join('\n');
const PRIMARY_CONTIG: HostedReferenceContigV1 = {
  chrom: 'chr1',
  sourceSeqId: SEQUENCE_A,
  displayName: '1',
  lengthBp: 8,
  role: 'assembled-molecule',
  circular: false,
  aliases: { refseq: SEQUENCE_A, ucsc: 'chr1' },
};
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

describe('NCBI reference source admission', () => {
  it('writes primary snapshots and a review-only catalog candidate', async () => {
    const prepared = await acquireFixture();
    const outputDirectory = join(prepared.root, 'admitted');

    const result = await admitNcbiReferenceSource({
      receiptPath: prepared.receiptPath,
      packagePath: prepared.packagePath,
      assemblyId: 'fixture-assembly',
      name: 'Fixture assembly',
      organism: 'Synthetic fixture',
      description: 'Reviewable primary-source candidate.',
      contigRoster: [PRIMARY_CONTIG],
      outputDirectory,
    });

    expect(result.candidate.contract).toBe(NCBI_REFERENCE_SOURCE_ADMISSION_V1);
    expect(result.candidate.candidate).not.toHaveProperty('preparedBundle');
    expect(result.candidate.candidate.contigs).toEqual([PRIMARY_CONTIG]);
    expect(result.candidate.snapshots.fasta.relativePath).toBe(
      `fixture-assembly/${ACCESSION}/${result.candidate.snapshots.fasta.sha256.slice(0, 16)}/${ACCESSION}_primary.fna`
    );
    const fasta = await readFile(result.fastaPath, 'utf8');
    expect(fasta).toBe(`>${SEQUENCE_A} fixture chromosome\nACGTACGT\n`);
    expect(fasta).not.toContain(SEQUENCE_B);
    const gff3 = await readFile(result.gff3Path, 'utf8');
    expect(gff3).toContain(`##sequence-region ${SEQUENCE_A} 1 8`);
    expect(gff3).not.toContain(SEQUENCE_B);
    expect(JSON.parse(await readFile(result.candidatePath, 'utf8'))).toEqual(result.candidate);

    await expect(
      admitNcbiReferenceSource({
        receiptPath: prepared.receiptPath,
        packagePath: prepared.packagePath,
        assemblyId: 'fixture-assembly',
        name: 'Fixture assembly',
        organism: 'Synthetic fixture',
        description: 'Reviewable primary-source candidate.',
        contigRoster: [PRIMARY_CONTIG],
        outputDirectory,
      })
    ).rejects.toThrow('already exists');
  });

  it('normalizes an exact author GFF sequence namespace through the NCBI report', async () => {
    const prepared = await acquireExternalFixture();
    const outputDirectory = join(prepared.root, 'admitted');
    const contig: HostedReferenceContigV1 = {
      chrom: 'chr1',
      sourceSeqId: GENBANK_SEQUENCE,
      displayName: '1',
      lengthBp: 8,
      role: 'assembled-molecule',
      circular: false,
      aliases: { genbank: GENBANK_SEQUENCE, ucsc: 'chr1' },
    };

    const result = await admitNcbiReferenceSource({
      receiptPath: prepared.receiptPath,
      packagePath: prepared.packagePath,
      annotationPath: prepared.annotationPath,
      assemblyId: 'fixture-assembly',
      name: 'Fixture assembly',
      organism: 'Synthetic fixture',
      assembly: 'Fixture Assembly 1.0',
      description: 'Exact assembly with author annotations.',
      contigRoster: [contig],
      outputDirectory,
    });

    expect(result.candidate.candidate.contigs).toEqual([contig]);
    expect(result.candidate.candidate.provenance).toEqual({
      provider: 'NCBI GenBank + Figshare',
      datasetId: `${EXTERNAL_ACCESSION}; 10.6084/m9.figshare.25441192.v1`,
      datasetVersion: 'Fixture Assembly 1.0; v1',
      sourceUrl:
        'https://figshare.com/articles/dataset/Nicotiana_benthamiana_KLAB_NbKLAB_Genome_assembly_and_annotation/25441192',
      license: 'NCBI public-domain data; CC BY 4.0',
      attribution: 'National Center for Biotechnology Information (NCBI); Shin Ah-Young (2024)',
    });
    const normalizedGff3 = await readFile(result.gff3Path, 'utf8');
    expect(normalizedGff3).toContain(`##sequence-region ${GENBANK_SEQUENCE} 1 8`);
    expect(normalizedGff3).toContain(`${GENBANK_SEQUENCE}\tNbKLAB\tgene`);
    expect(normalizedGff3).not.toContain(AUTHOR_SEQUENCE);
  });

  it.each([
    ['unknown', 'NotInAssembly'],
    ['ambiguous', 'Un.'],
  ])('rejects an %s external GFF sequence alias', async (_case, sourceSeqId) => {
    const prepared = await acquireExternalFixture(
      `${sourceSeqId}\tNbKLAB\tgene\t1\t8\t.\t+\t.\tID=gene-1\n`
    );
    const outputDirectory = join(prepared.root, 'admitted');
    await expect(
      admitNcbiReferenceSource({
        receiptPath: prepared.receiptPath,
        packagePath: prepared.packagePath,
        annotationPath: prepared.annotationPath,
        assemblyId: 'fixture-assembly',
        name: 'Fixture assembly',
        organism: 'Synthetic fixture',
        description: 'Exact assembly with author annotations.',
        contigRoster: [
          {
            ...PRIMARY_CONTIG,
            sourceSeqId: GENBANK_SEQUENCE,
            aliases: { genbank: GENBANK_SEQUENCE },
          },
        ],
        outputDirectory,
      })
    ).rejects.toThrow(/absent from the exact NCBI sequence report/i);
    await expectAdmissionCleaned(outputDirectory);
  });

  it('rejects a missing roster sequence without leaving final files', async () => {
    const prepared = await acquireFixture();
    const outputDirectory = join(prepared.root, 'admitted');
    await expect(
      admitNcbiReferenceSource({
        receiptPath: prepared.receiptPath,
        packagePath: prepared.packagePath,
        assemblyId: 'fixture-assembly',
        name: 'Fixture assembly',
        organism: 'Synthetic fixture',
        description: 'Reviewable primary-source candidate.',
        contigRoster: [
          { ...PRIMARY_CONTIG, sourceSeqId: 'NC_000009.1', aliases: { refseq: 'NC_000009.1' } },
        ],
        outputDirectory,
      })
    ).rejects.toThrow(/absent from the FASTA/i);
    await expectAdmissionCleaned(outputDirectory);
  });

  it('rejects a length mismatch without leaving final files', async () => {
    const prepared = await acquireFixture();
    const outputDirectory = join(prepared.root, 'admitted');
    await expect(
      admitNcbiReferenceSource({
        receiptPath: prepared.receiptPath,
        packagePath: prepared.packagePath,
        assemblyId: 'fixture-assembly',
        name: 'Fixture assembly',
        organism: 'Synthetic fixture',
        description: 'Reviewable primary-source candidate.',
        contigRoster: [{ ...PRIMARY_CONTIG, lengthBp: 7 }],
        outputDirectory,
      })
    ).rejects.toThrow(/does not match FASTA/i);
    await expectAdmissionCleaned(outputDirectory);
  });

  it('rejects a package that no longer matches the receipt', async () => {
    const prepared = await acquireFixture();
    await writeFile(prepared.packagePath, Buffer.from('tampered-package'));
    await expect(
      admitNcbiReferenceSource({
        receiptPath: prepared.receiptPath,
        packagePath: prepared.packagePath,
        assemblyId: 'fixture-assembly',
        name: 'Fixture assembly',
        organism: 'Synthetic fixture',
        description: 'Reviewable primary-source candidate.',
        contigRoster: [PRIMARY_CONTIG],
        outputDirectory: join(prepared.root, 'admitted'),
      })
    ).rejects.toThrow(/do not match the acquisition receipt/i);
  });

  it('parses exact CLI paths and rejects unknown keys', () => {
    expect(
      parseAdmitNcbiReferenceSourceCli([
        '--receipt=/tmp/receipt.json',
        '--package=/tmp/package.zip',
        '--assembly-id=sacCer3',
        '--name=Yeast',
        '--organism=Saccharomyces cerevisiae',
        '--description=Primary source candidate',
        '--contig-roster=/tmp/roster.json',
        '--annotation=/tmp/external.gff3',
        '--output-directory=/tmp/out',
      ])
    ).toMatchObject({
      assemblyId: 'sacCer3',
      contigRosterPath: '/tmp/roster.json',
      annotationPath: '/tmp/external.gff3',
    });
    expect(() =>
      parseAdmitNcbiReferenceSourceCli([
        '--receipt=/tmp/receipt.json',
        '--package=/tmp/package.zip',
        '--assembly-id=sacCer3',
        '--name=Yeast',
        '--organism=Saccharomyces cerevisiae',
        '--description=Primary source candidate',
        '--contig-roster=/tmp/roster.json',
        '--output-directory=/tmp/out',
        '--publish=true',
      ])
    ).toThrow(/Unknown/i);
  });
});

async function acquireFixture(): Promise<{
  readonly root: string;
  readonly receiptPath: string;
  readonly packagePath: string;
}> {
  const root = await temporaryRoot();
  const fixture = join(root, 'fixture.zip');
  await writeFile(fixture, packageZip());
  const binary = await fakeDatasetsBinary(root, fixture);
  const acquired = await acquireNcbiReferencePackage({
    accession: ACCESSION,
    datasetsBinary: binary,
    outputDirectory: join(root, 'acquired'),
    timeoutMs: 10_000,
  });
  return { root, receiptPath: acquired.receiptPath, packagePath: acquired.packagePath };
}

async function acquireExternalFixture(externalGff3 = EXTERNAL_GFF3): Promise<{
  readonly root: string;
  readonly receiptPath: string;
  readonly packagePath: string;
  readonly annotationPath: string;
}> {
  const root = await temporaryRoot();
  const fixture = join(root, 'external-fixture.zip');
  await writeFile(fixture, externalPackageZip());
  const binary = await fakeDatasetsBinary(root, fixture);
  const response = new Response(externalGff3, {
    status: 200,
    headers: { 'content-length': String(Buffer.byteLength(externalGff3)) },
  });
  Object.defineProperty(response, 'url', {
    value: 'https://ndownloader.figshare.com/files/45147526',
  });
  const acquired = await acquireNcbiReferencePackage({
    accession: EXTERNAL_ACCESSION,
    datasetsBinary: binary,
    outputDirectory: join(root, 'acquired'),
    timeoutMs: 10_000,
    fetchAsset: async () => response,
    externalAnnotation: {
      contract: 'dnaforge-hosted-reference-external-annotation-source.v1',
      provider: 'figshare',
      assemblyId: 'fixture-assembly',
      accession: EXTERNAL_ACCESSION,
      articleId: 25441192,
      articleVersion: 1,
      fileId: 45147526,
      fileName: 'Nb_KLAB.gff3',
      sha256: createHash('sha256').update(externalGff3).digest('hex'),
      byteLength: Buffer.byteLength(externalGff3),
      publishedDate: '2024-03-20',
      license: 'CC BY 4.0',
      attribution: 'Shin Ah-Young (2024)',
      sourceUrl:
        'https://figshare.com/articles/dataset/Nicotiana_benthamiana_KLAB_NbKLAB_Genome_assembly_and_annotation/25441192',
    },
  });
  return {
    root,
    receiptPath: acquired.receiptPath,
    packagePath: acquired.packagePath,
    annotationPath: acquired.annotationPath!,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-ncbi-admission-'));
  temporaryRoots.push(root);
  return root;
}

async function fakeDatasetsBinary(root: string, fixturePath: string): Promise<string> {
  const path = join(root, 'datasets');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('datasets version: 18.11.0\\n');
  process.exit(0);
}
const filenameIndex = args.indexOf('--filename');
if (filenameIndex < 0 || !args[filenameIndex + 1]) process.exit(91);
fs.copyFileSync(${JSON.stringify(fixturePath)}, args[filenameIndex + 1]);
`;
  await writeFile(path, script, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function packageZip(): Uint8Array {
  const assemblyReport = `${JSON.stringify({ accession: ACCESSION })}\n`;
  const sequenceReport = [
    JSON.stringify({
      assemblyAccession: ACCESSION,
      refseqAccession: SEQUENCE_A,
      length: 8,
      role: 'assembled-molecule',
    }),
    JSON.stringify({
      assemblyAccession: ACCESSION,
      refseqAccession: SEQUENCE_B,
      length: 8,
      role: 'assembled-molecule',
    }),
    '',
  ].join('\n');
  const md5Lines = [
    `${md5(FASTA)}  ${FASTA_PATH}`,
    `${md5(GFF3)}  ${GFF3_PATH}`,
    `${md5(assemblyReport)}  ${ASSEMBLY_REPORT_PATH}`,
    `${md5(sequenceReport)}  ${SEQUENCE_REPORT_PATH}`,
  ];
  return zipSync({
    [ASSEMBLY_REPORT_PATH]: strToU8(assemblyReport),
    [DATASET_CATALOG_PATH]: strToU8('{}\n'),
    [FASTA_PATH]: strToU8(FASTA),
    [GFF3_PATH]: strToU8(GFF3),
    [SEQUENCE_REPORT_PATH]: strToU8(sequenceReport),
    'md5sum.txt': strToU8(`${md5Lines.join('\n')}\n`),
  });
}

function externalPackageZip(): Uint8Array {
  const fastaPath = `ncbi_dataset/data/${EXTERNAL_ACCESSION}/${EXTERNAL_ACCESSION}_fixture_genomic.fna`;
  const sequenceReportPath = `ncbi_dataset/data/${EXTERNAL_ACCESSION}/sequence_report.jsonl`;
  const fasta = `>${GENBANK_SEQUENCE} fixture chromosome\nACGTACGT\n`;
  const assemblyReport = `${JSON.stringify({ accession: EXTERNAL_ACCESSION })}\n`;
  const sequenceReport =
    [
      {
        assemblyAccession: EXTERNAL_ACCESSION,
        assemblyUnit: 'Primary Assembly',
        assignedMoleculeLocationType: 'Chromosome',
        chrName: '1',
        sequenceName: AUTHOR_SEQUENCE,
        genbankAccession: GENBANK_SEQUENCE,
        length: 8,
        role: 'assembled-molecule',
      },
      {
        assemblyAccession: EXTERNAL_ACCESSION,
        assemblyUnit: 'Primary Assembly',
        chrName: 'Un.',
        sequenceName: 'Scaffold1',
        genbankAccession: 'JA000001.1',
        length: 4,
        role: 'unplaced-scaffold',
      },
      {
        assemblyAccession: EXTERNAL_ACCESSION,
        assemblyUnit: 'Primary Assembly',
        chrName: 'Un.',
        sequenceName: 'Scaffold2',
        genbankAccession: 'JA000002.1',
        length: 4,
        role: 'unplaced-scaffold',
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n';
  const md5Lines = [
    `${md5(fasta)}  ${fastaPath}`,
    `${md5(assemblyReport)}  ${ASSEMBLY_REPORT_PATH}`,
    `${md5(sequenceReport)}  ${sequenceReportPath}`,
  ];
  return zipSync({
    [ASSEMBLY_REPORT_PATH]: strToU8(assemblyReport),
    [DATASET_CATALOG_PATH]: strToU8('{}\n'),
    [fastaPath]: strToU8(fasta),
    [sequenceReportPath]: strToU8(sequenceReport),
    'md5sum.txt': strToU8(`${md5Lines.join('\n')}\n`),
  });
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

async function expectAdmissionCleaned(outputDirectory: string): Promise<void> {
  await expect(readFile(join(outputDirectory, `${ACCESSION}_primary.fna`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(join(outputDirectory, `${ACCESSION}_primary.gff3`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(
    readFile(join(outputDirectory, `${ACCESSION}.source-admission.json`))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  let names: string[] = [];
  try {
    names = await readdir(outputDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  expect(names.filter((name) => name.includes('.admit-'))).toEqual([]);
}
