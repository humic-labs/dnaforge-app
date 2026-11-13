// @vitest-environment node

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  UCSC_REFERENCE_PACKAGE_ACQUISITION_V1,
  UCSC_REFERENCE_SOURCE_SET_V1,
  type UcscReferencePackageAcquisitionReceiptV1,
  type UcscReferenceSourceSetV1,
} from './ucsc-reference-package-acquisition';
import {
  admitUcscReferenceSource,
  parseAdmitUcscReferenceSourceCli,
  UCSC_REFERENCE_SOURCE_ADMISSION_V2,
} from './ucsc-reference-source-admission';

const GENOME_ID = 'fixture1';
const FASTA = '>chr1\nACGTACGT\n>chr2A\nGGGG\n>chrM\nAACCC\n';
const CHROM_SIZES = 'chr1\t8\nchr2A\t4\nchrM\t5\n';
const GTF = [
  'chrPatch\tncbiRefSeq\texon\t1\t4\t.\t+\t.\tgene_id "PATCH"; transcript_id "PATCH.1";',
  'chr1\tncbiRefSeq\texon\t1\t8\t.\t+\t.\tgene_id "G1"; transcript_id "T1"; gene_name "Gene one";',
  'chr1\tncbiRefSeq\tCDS\t2\t7\t.\t+\t0\tgene_id "G1"; transcript_id "T1"; gene_name "Gene one";',
  '',
].join('\n');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('UCSC reference source admission', () => {
  it('binds chromosome sizes, FASTA, and explicit GTF authority into a review-only candidate', async () => {
    const acquired = await writeAcquisitionFixture();
    const first = await admitUcscReferenceSource({
      receiptPath: acquired.receiptPath,
      packagePath: acquired.packagePath,
      assemblyId: 'fixture-assembly',
      name: 'Fixture UCSC assembly',
      organism: 'Synthetic fixture',
      taxId: 9_999,
      assembly: 'Fixture build 1',
      description: 'Exact UCSC-native central source admission fixture.',
      outputDirectory: join(acquired.root, 'admitted-first'),
    });
    const second = await admitUcscReferenceSource({
      receiptPath: acquired.receiptPath,
      packagePath: acquired.packagePath,
      assemblyId: 'fixture-assembly',
      name: 'Fixture UCSC assembly',
      organism: 'Synthetic fixture',
      taxId: 9_999,
      assembly: 'Fixture build 1',
      description: 'Exact UCSC-native central source admission fixture.',
      outputDirectory: join(acquired.root, 'admitted-second'),
    });

    expect(first.candidate.contract).toBe(UCSC_REFERENCE_SOURCE_ADMISSION_V2);
    expect(first.candidate.genomeId).toBe(GENOME_ID);
    expect(first.candidate.candidate).not.toHaveProperty('preparedBundle');
    expect(first.candidate.candidate.contigs).toEqual([
      {
        chrom: 'chr1',
        sourceSeqId: 'chr1',
        displayName: 'chr1',
        lengthBp: 8,
        role: 'assembled-molecule',
        circular: false,
        aliases: { ucsc: 'chr1' },
      },
      {
        chrom: 'chr2A',
        sourceSeqId: 'chr2A',
        displayName: 'chr2A',
        lengthBp: 4,
        role: 'assembled-molecule',
        circular: false,
        aliases: { ucsc: 'chr2A' },
      },
      {
        chrom: 'chrM',
        sourceSeqId: 'chrM',
        displayName: 'chrM',
        lengthBp: 5,
        role: 'mitochondrion',
        circular: true,
        aliases: { ucsc: 'chrM' },
      },
    ]);
    expect(first.candidate.candidate.provenance).toMatchObject({
      provider: 'UCSC Genome Browser',
      datasetId: GENOME_ID,
      datasetVersion: 'Fixture build 1',
    });
    expect(first.candidate.snapshots.annotations.conversion).toMatchObject({
      sourceRows: 3,
      admittedSourceRows: 2,
      omittedSourceRows: 1,
      omittedSourceSeqIds: ['chrPatch'],
    });
    expect(await readFile(first.fastaPath, 'utf8')).toBe(FASTA);
    const gff3 = await readFile(first.gff3Path, 'utf8');
    expect(gff3).toContain('##sequence-region chrM 1 5');
    expect(gff3).toMatch(/chrM\tUCSC\tregion\t1\t5/u);
    expect(gff3).toMatch(/chr1\tncbiRefSeq\tmRNA\t1\t8/u);
    expect(second.candidate.snapshots).toEqual(first.candidate.snapshots);
    expect(await readFile(second.fastaPath)).toEqual(await readFile(first.fastaPath));
    expect(await readFile(second.gff3Path)).toEqual(await readFile(first.gff3Path));
    expect(JSON.parse(await readFile(first.candidatePath, 'utf8'))).toEqual(first.candidate);
  });

  it('rejects chromosome-size drift from the exact FASTA dictionary', async () => {
    const acquired = await writeAcquisitionFixture({
      chromSizes: 'chr1\t9\nchr2A\t4\nchrM\t5\n',
    });
    await expect(admitFixture(acquired)).rejects.toThrow(/FASTA length|length.*FASTA/u);
  });

  it('rejects source bytes that no longer match the acquisition receipt', async () => {
    const acquired = await writeAcquisitionFixture();
    await writeFile(acquired.annotationsPath, gzipSync(`${GTF}# tampered\n`));
    await expect(admitFixture(acquired)).rejects.toThrow(/do not match the acquisition receipt/u);
  });

  it('requires and revalidates the publisher checksum manifest', async () => {
    const missing = await writeAcquisitionFixture();
    await rm(missing.manifestPath);
    await expect(admitFixture(missing)).rejects.toThrow(/checksum manifest/u);

    const contradictory = await writeAcquisitionFixture({ manifestFastaMd5: '0'.repeat(32) });
    await expect(admitFixture(contradictory)).rejects.toThrow(/publisher MD5/u);
  });

  it('bounds expanded FASTA bytes from the chromosome-size authority', async () => {
    const acquired = await writeAcquisitionFixture({
      fasta: `>chr1\n${'A'.repeat(2_000_000)}\n>chr2A\nGGGG\n>chrM\nAACCC\n`,
    });

    await expect(admitFixture(acquired)).rejects.toThrow(/expanded byte bound/u);
  });

  it('allows exactly one concurrent create-only admission to publish', async () => {
    const acquired = await writeAcquisitionFixture();
    const outputDirectory = join(acquired.root, 'admitted');
    const input = {
      receiptPath: acquired.receiptPath,
      packagePath: acquired.packagePath,
      assemblyId: 'fixture-assembly',
      name: 'Fixture UCSC assembly',
      organism: 'Synthetic fixture',
      assembly: 'Fixture build 1',
      description: 'Exact UCSC-native central source admission fixture.',
      outputDirectory,
    } as const;

    const outcomes = await Promise.allSettled([
      admitUcscReferenceSource(input),
      admitUcscReferenceSource(input),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect((await readdir(outputDirectory)).sort()).toEqual(
      [
        `${GENOME_ID}.source-admission.json`,
        `${GENOME_ID}_primary.fna`,
        `${GENOME_ID}_primary.gff3`,
      ].sort()
    );
  });

  it('rejects a self-consistent receipt that points outside the exact UCSC authority', async () => {
    const acquired = await writeAcquisitionFixture({ sourceOrigin: 'https://example.com' });
    await expect(admitFixture(acquired)).rejects.toThrow(/exact UCSC source URL/u);
  });

  it('parses the non-activating operator CLI and rejects publisher flags', () => {
    expect(
      parseAdmitUcscReferenceSourceCli([
        '--receipt=/tmp/receipt.json',
        '--package=/tmp/package.json',
        '--assembly-id=hg19',
        '--name=Human hg19',
        '--organism=Homo sapiens',
        '--tax-id=9606',
        '--assembly=GRCh37',
        '--description=Exact UCSC hg19 source candidate',
        '--output-directory=/tmp/admitted',
      ])
    ).toMatchObject({ assemblyId: 'hg19', taxId: 9_606, assembly: 'GRCh37' });
    expect(() =>
      parseAdmitUcscReferenceSourceCli([
        '--receipt=/tmp/receipt.json',
        '--package=/tmp/package.json',
        '--assembly-id=hg19',
        '--name=Human hg19',
        '--organism=Homo sapiens',
        '--description=Exact UCSC hg19 source candidate',
        '--output-directory=/tmp/admitted',
        '--publish=true',
      ])
    ).toThrow(/Unknown UCSC source-admission argument/u);
  });
});

async function admitFixture(acquired: Awaited<ReturnType<typeof writeAcquisitionFixture>>) {
  return admitUcscReferenceSource({
    receiptPath: acquired.receiptPath,
    packagePath: acquired.packagePath,
    assemblyId: 'fixture-assembly',
    name: 'Fixture UCSC assembly',
    organism: 'Synthetic fixture',
    assembly: 'Fixture build 1',
    description: 'Exact UCSC-native central source admission fixture.',
    outputDirectory: join(acquired.root, 'admitted'),
  });
}

async function writeAcquisitionFixture(
  overrides: Readonly<{
    chromSizes?: string;
    fasta?: string;
    manifestFastaMd5?: string;
    sourceOrigin?: string;
  }> = {}
): Promise<{
  readonly root: string;
  readonly receiptPath: string;
  readonly packagePath: string;
  readonly annotationsPath: string;
  readonly manifestPath: string;
}> {
  const root = await temporaryRoot();
  const acquisitionRoot = join(root, 'acquired');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(acquisitionRoot, { recursive: true });
  const fastaBytes = gzipSync(overrides.fasta ?? FASTA);
  const chromSizes = overrides.chromSizes ?? CHROM_SIZES;
  const annotationBytes = gzipSync(GTF);
  const names = {
    fasta: `${GENOME_ID}.fa.gz`,
    chromSizes: `${GENOME_ID}.chrom.sizes`,
    annotations: `${GENOME_ID}.ncbiRefSeq.gtf.gz`,
    manifest: `${GENOME_ID}.md5sum.txt`,
    package: `${GENOME_ID}.ucsc-source-set.json`,
    receipt: `${GENOME_ID}.ucsc-acquisition.json`,
  };
  const manifest = `${overrides.manifestFastaMd5 ?? md5(fastaBytes)}  ${names.fasta}\n${md5(chromSizes)}  ${names.chromSizes}\n`;
  const sourceOrigin =
    overrides.sourceOrigin ?? `https://hgdownload.soe.ucsc.edu/goldenPath/${GENOME_ID}/bigZips`;
  const sourceIdentity = (fileName: string, bytes: Buffer | string, url: string) => ({
    fileName,
    url,
    sha256: sha256(bytes),
    md5: md5(bytes),
    byteLength: Buffer.byteLength(bytes),
  });
  const sources: UcscReferenceSourceSetV1['sources'] = {
    fasta: sourceIdentity(names.fasta, fastaBytes, `${sourceOrigin}/${names.fasta}`),
    chromSizes: sourceIdentity(names.chromSizes, chromSizes, `${sourceOrigin}/${names.chromSizes}`),
    annotations: sourceIdentity(
      names.annotations,
      annotationBytes,
      `${sourceOrigin}/genes/${names.annotations}`
    ),
  };
  const sourceSet: UcscReferenceSourceSetV1 = {
    contract: UCSC_REFERENCE_SOURCE_SET_V1,
    genomeId: GENOME_ID,
    annotationTable: 'ncbiRefSeq',
    sources,
  };
  const packageBytes = Buffer.from(`${JSON.stringify(sourceSet, null, 2)}\n`);
  const receipt: UcscReferencePackageAcquisitionReceiptV1 = {
    contract: UCSC_REFERENCE_PACKAGE_ACQUISITION_V1,
    genomeId: GENOME_ID,
    annotationTable: 'ncbiRefSeq',
    transport: { name: 'node-fetch', nodeVersion: process.version },
    checksumManifest: sourceIdentity(names.manifest, manifest, `${sourceOrigin}/md5sum.txt`),
    package: {
      fileName: names.package,
      sha256: sha256(packageBytes),
      byteLength: packageBytes.byteLength,
    },
    sources,
  };
  await Promise.all([
    writeFile(join(acquisitionRoot, names.fasta), fastaBytes),
    writeFile(join(acquisitionRoot, names.chromSizes), chromSizes),
    writeFile(join(acquisitionRoot, names.annotations), annotationBytes),
    writeFile(join(acquisitionRoot, names.manifest), manifest),
    writeFile(join(acquisitionRoot, names.package), packageBytes),
    writeFile(join(acquisitionRoot, names.receipt), `${JSON.stringify(receipt, null, 2)}\n`),
  ]);
  return {
    root,
    receiptPath: join(acquisitionRoot, names.receipt),
    packagePath: join(acquisitionRoot, names.package),
    annotationsPath: join(acquisitionRoot, names.annotations),
    manifestPath: join(acquisitionRoot, names.manifest),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-ucsc-admission-'));
  temporaryRoots.push(root);
  return root;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function md5(value: string | Buffer): string {
  return createHash('md5').update(value).digest('hex');
}
