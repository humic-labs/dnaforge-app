import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { createGunzip } from 'node:zlib';

import type { AssemblySequenceRole } from '@waypoint/genome-data';

import type {
  HostedReferenceCatalogDefinitionV1,
  HostedReferenceContigV1,
} from './hosted-reference-catalog';
import { inspectLocalReferenceSources } from './local-reference-source-plan';
import {
  UCSC_CENTRAL_ANNOTATION_TABLE,
  UCSC_REFERENCE_PACKAGE_ACQUISITION_V1,
  UCSC_REFERENCE_SOURCE_ORIGIN,
  UCSC_REFERENCE_SOURCE_SET_V1,
  requireUcscManifestMd5,
  type UcscReferencePackageAcquisitionReceiptV1,
  type UcscReferenceSourceSetV1,
} from './ucsc-reference-package-acquisition';
import { convertUcscGtfToGff3, type UcscGtfToGff3Receipt } from './ucsc-gtf-to-gff3';

export const UCSC_REFERENCE_SOURCE_ADMISSION_V1 =
  'dnaforge-ucsc-reference-source-admission.v1' as const;
export const UCSC_REFERENCE_SOURCE_ADMISSION_V2 =
  'dnaforge-ucsc-reference-source-admission.v2' as const;

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MD5 = /^[0-9a-f]{32}$/u;
const MAX_CHROM_SIZES_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CHECKSUM_MANIFEST_BYTES = 1024 * 1024;
const MAX_EXPANDED_FASTA_BYTES = 8 * 1024 * 1024 * 1024;

type UcscSourceIdentity = UcscReferenceSourceSetV1['sources']['fasta'];
type UcscPackageIdentity = UcscReferencePackageAcquisitionReceiptV1['package'];
type UcscTransportIdentity = UcscReferencePackageAcquisitionReceiptV1['transport'];

export interface AdmitUcscReferenceSourceInput {
  readonly receiptPath: string;
  readonly packagePath: string;
  readonly assemblyId: string;
  readonly name: string;
  readonly organism: string;
  readonly taxId?: number;
  readonly assembly?: string;
  readonly description: string;
  readonly outputDirectory: string;
}

export interface UcscReferenceCatalogCandidateV2 {
  readonly contract: typeof UCSC_REFERENCE_SOURCE_ADMISSION_V2;
  readonly genomeId: string;
  readonly annotationTable: typeof UCSC_CENTRAL_ANNOTATION_TABLE;
  readonly acquisition: Readonly<{
    receiptPath: string;
    packagePath: string;
    receiptSha256: string;
    packageSha256: string;
  }>;
  readonly snapshots: Readonly<{
    fasta: Readonly<{ relativePath: string; sha256: string; byteLength: number; fileName: string }>;
    annotations: Readonly<{
      relativePath: string;
      sha256: string;
      byteLength: number;
      fileName: string;
      conversion: UcscGtfToGff3Receipt;
    }>;
  }>;
  readonly candidate: HostedReferenceCatalogDefinitionV1;
}

export interface AdmitUcscReferenceSourceResult {
  readonly fastaPath: string;
  readonly gff3Path: string;
  readonly candidatePath: string;
  readonly candidate: UcscReferenceCatalogCandidateV2;
}

export async function admitUcscReferenceSource(
  rawInput: AdmitUcscReferenceSourceInput
): Promise<AdmitUcscReferenceSourceResult> {
  const input = validateInput(rawInput);
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const operationLockPath = join(input.outputDirectory, `.${input.assemblyId}.admission.lock`);
  await acquireOperationLock(operationLockPath);
  let temporaryRoot: string | undefined;
  const createdFinals = new Set<string>();
  try {
    const operationRoot = await mkdtemp(join(input.outputDirectory, '.ucsc-admit-'));
    temporaryRoot = operationRoot;
    const snapshotRoot = join(operationRoot, 'inputs');
    await mkdir(snapshotRoot, { mode: 0o700 });

    const receiptSnapshotPath = join(snapshotRoot, basename(input.receiptPath));
    const receiptIdentity = await snapshotFile({
      sourcePath: input.receiptPath,
      destinationPath: receiptSnapshotPath,
      label: 'acquisition receipt',
      maxBytes: MAX_CONTROL_FILE_BYTES,
    });
    const receipt = await readReceipt(receiptSnapshotPath);
    if (basename(input.packagePath) !== receipt.package.fileName) {
      throw new Error('UCSC source-set path does not match the acquisition receipt.');
    }
    const packageSnapshotPath = join(snapshotRoot, receipt.package.fileName);
    const packageIdentity = await snapshotFile({
      sourcePath: input.packagePath,
      destinationPath: packageSnapshotPath,
      label: 'source set',
      expected: receipt.package,
      maxBytes: MAX_CONTROL_FILE_BYTES,
    });
    const sourceSet = await readAndVerifySourceSet(packageSnapshotPath, receipt);
    const sourceRoot = dirname(input.packagePath);
    const snapshotPaths = {
      checksumManifest: join(snapshotRoot, receipt.checksumManifest.fileName),
      fasta: join(snapshotRoot, sourceSet.sources.fasta.fileName),
      chromSizes: join(snapshotRoot, sourceSet.sources.chromSizes.fileName),
      annotations: join(snapshotRoot, sourceSet.sources.annotations.fileName),
    };
    await snapshotFile({
      sourcePath: safeSourcePath(sourceRoot, receipt.checksumManifest.fileName),
      destinationPath: snapshotPaths.checksumManifest,
      label: 'checksum manifest',
      expected: receipt.checksumManifest,
      maxBytes: MAX_CHECKSUM_MANIFEST_BYTES,
    });
    for (const kind of ['fasta', 'chromSizes', 'annotations'] as const) {
      await snapshotFile({
        sourcePath: safeSourcePath(sourceRoot, sourceSet.sources[kind].fileName),
        destinationPath: snapshotPaths[kind],
        label: `${kind} source`,
        expected: sourceSet.sources[kind],
        maxBytes: sourceSet.sources[kind].byteLength,
      });
    }
    await verifyPublisherManifest(snapshotPaths.checksumManifest, sourceSet.sources);

    const contigAuthority = await readChromSizes(snapshotPaths.chromSizes);
    const contigs = contigAuthority.map(hostedContigFromUcscAuthority);
    const fastaFileName = `${receipt.genomeId}_primary.fna`;
    const gff3FileName = `${receipt.genomeId}_primary.gff3`;
    const candidateFileName = `${receipt.genomeId}.source-admission.json`;
    const fastaPath = join(input.outputDirectory, fastaFileName);
    const gff3Path = join(input.outputDirectory, gff3FileName);
    const candidatePath = join(input.outputDirectory, candidateFileName);
    await Promise.all([fastaPath, gff3Path, candidatePath].map(assertPathAbsent));

    const temporaryFasta = join(operationRoot, fastaFileName);
    await decodeGzip(snapshotPaths.fasta, temporaryFasta, expandedFastaByteBound(contigAuthority));

    const temporaryGff3 = join(operationRoot, gff3FileName);
    const gff3Receipt = await convertUcscGtfToGff3({
      sourcePath: snapshotPaths.annotations,
      destinationPath: temporaryGff3,
      contigs: contigAuthority,
    });

    const inspection = await inspectLocalReferenceSources([temporaryFasta, temporaryGff3]);
    assertFastaMatchesChromSizes(inspection.fasta.contigs, contigAuthority);
    const fastaStat = await stat(temporaryFasta);
    const fastaReceipt = {
      sha256: inspection.fasta.sha256,
      byteLength: fastaStat.size,
    };

    const fastaRelativePath = hostedReferenceSourceRelativePath({
      assemblyId: input.assemblyId,
      genomeId: receipt.genomeId,
      fileName: fastaFileName,
      sha256: fastaReceipt.sha256,
    });
    const gff3RelativePath = hostedReferenceSourceRelativePath({
      assemblyId: input.assemblyId,
      genomeId: receipt.genomeId,
      fileName: gff3FileName,
      sha256: gff3Receipt.sha256,
    });
    const candidateDefinition: HostedReferenceCatalogDefinitionV1 = {
      id: input.assemblyId,
      name: input.name,
      organism: input.organism,
      ...(input.taxId === undefined ? {} : { taxId: input.taxId }),
      ...(input.assembly === undefined ? {} : { assembly: input.assembly }),
      description: input.description,
      sources: {
        fasta: {
          relativePath: fastaRelativePath,
          sha256: fastaReceipt.sha256,
          byteLength: fastaReceipt.byteLength,
        },
        annotations: {
          relativePath: gff3RelativePath,
          sha256: gff3Receipt.sha256,
          byteLength: gff3Receipt.byteLength,
        },
      },
      provenance: {
        provider: 'UCSC Genome Browser',
        datasetId: receipt.genomeId,
        datasetVersion: input.assembly ?? receipt.genomeId,
        sourceUrl: new URL('.', sourceSet.sources.fasta.url).toString(),
        license: 'UCSC Genome Browser data are freely available for public use',
        attribution: `UCSC Genome Browser; ${receipt.annotationTable} gene model table`,
      },
      contigs,
    };
    if ('preparedBundle' in candidateDefinition) {
      throw new Error('UCSC source admission must not emit a prepared bundle.');
    }
    const candidate: UcscReferenceCatalogCandidateV2 = {
      contract: UCSC_REFERENCE_SOURCE_ADMISSION_V2,
      genomeId: receipt.genomeId,
      annotationTable: receipt.annotationTable,
      acquisition: {
        receiptPath: basename(input.receiptPath),
        packagePath: basename(input.packagePath),
        receiptSha256: receiptIdentity.sha256,
        packageSha256: packageIdentity.sha256,
      },
      snapshots: {
        fasta: {
          ...fastaReceipt,
          relativePath: fastaRelativePath,
          fileName: fastaFileName,
        },
        annotations: {
          sha256: gff3Receipt.sha256,
          byteLength: gff3Receipt.byteLength,
          relativePath: gff3RelativePath,
          fileName: gff3FileName,
          conversion: gff3Receipt,
        },
      },
      candidate: candidateDefinition,
    };
    const temporaryCandidate = join(operationRoot, candidateFileName);
    await writeCreateOnlyJson(temporaryCandidate, candidate);
    for (const [temporaryPath, finalPath] of [
      [temporaryFasta, fastaPath],
      [temporaryGff3, gff3Path],
      [temporaryCandidate, candidatePath],
    ] as const) {
      await link(temporaryPath, finalPath);
      createdFinals.add(finalPath);
    }
    return { fastaPath, gff3Path, candidatePath, candidate };
  } catch (error) {
    await Promise.all([...createdFinals].map((path) => rm(path, { force: true })));
    throw error;
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    await rm(operationLockPath, { force: true });
  }
}

export function parseAdmitUcscReferenceSourceCli(
  argv: readonly string[]
): Omit<AdmitUcscReferenceSourceInput, 'taxId' | 'assembly'> &
  Readonly<{ taxId?: number; assembly?: string }> {
  const values = new Map<string, string>();
  const allowed = new Set([
    'receipt',
    'package',
    'assembly-id',
    'name',
    'organism',
    'tax-id',
    'assembly',
    'description',
    'output-directory',
  ]);
  for (const argument of argv) {
    const match = /^--([^=]+)=(.+)$/u.exec(argument);
    if (!match || !allowed.has(match[1])) {
      throw new Error(`Unknown UCSC source-admission argument: ${argument}`);
    }
    if (values.has(match[1])) {
      throw new Error(`Duplicate UCSC source-admission argument: --${match[1]}`);
    }
    values.set(match[1], match[2]);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) {
      throw new Error(
        'Usage: pnpm exec vite-node tools/devops/scripts/admit-ucsc-reference-source.ts ' +
          '--receipt=<path> --package=<path> --assembly-id=<id> --name=<name> ' +
          '--organism=<organism> --description=<text> --output-directory=<directory> ' +
          '[--tax-id=<int>] [--assembly=<label>]'
      );
    }
    return value;
  };
  const taxIdRaw = values.get('tax-id');
  let taxId: number | undefined;
  if (taxIdRaw !== undefined) {
    taxId = Number(taxIdRaw);
    if (!Number.isSafeInteger(taxId) || taxId < 1) {
      throw new Error('UCSC source admission tax ID must be a positive safe integer.');
    }
  }
  return {
    receiptPath: resolve(required('receipt')),
    packagePath: resolve(required('package')),
    assemblyId: required('assembly-id'),
    name: required('name'),
    organism: required('organism'),
    description: required('description'),
    outputDirectory: resolve(required('output-directory')),
    ...(taxId === undefined ? {} : { taxId }),
    ...(values.has('assembly') ? { assembly: values.get('assembly') } : {}),
  };
}

function validateInput(input: AdmitUcscReferenceSourceInput): AdmitUcscReferenceSourceInput {
  if (!SAFE_SEGMENT.test(input.assemblyId)) {
    throw new Error('UCSC source admission assembly ID is invalid.');
  }
  for (const [label, value] of [
    ['name', input.name],
    ['organism', input.organism],
    ['description', input.description],
  ] as const) {
    if (value.trim().length === 0) {
      throw new Error(`UCSC source admission ${label} is required.`);
    }
  }
  if (input.taxId !== undefined && (!Number.isSafeInteger(input.taxId) || input.taxId < 1)) {
    throw new Error('UCSC source admission tax ID must be a positive safe integer.');
  }
  return {
    ...input,
    receiptPath: resolve(input.receiptPath),
    packagePath: resolve(input.packagePath),
    outputDirectory: resolve(input.outputDirectory),
  };
}

async function readReceipt(path: string): Promise<UcscReferencePackageAcquisitionReceiptV1> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(parsed) || parsed.contract !== UCSC_REFERENCE_PACKAGE_ACQUISITION_V1) {
    throw new Error('UCSC source admission receipt is not a v1 acquisition receipt.');
  }
  const genomeId = textField(parsed, 'genomeId');
  if (!SAFE_SEGMENT.test(genomeId)) {
    throw new Error('UCSC acquisition receipt genome ID is invalid.');
  }
  if (parsed.annotationTable !== UCSC_CENTRAL_ANNOTATION_TABLE) {
    throw new Error('UCSC acquisition receipt annotation authority is unsupported.');
  }
  const packageIdentity = admitPackageIdentity(parsed.package);
  const sources = admitSources(parsed.sources);
  const checksumManifest = admitDownloadIdentity(parsed.checksumManifest, 'checksumManifest');
  const transport = admitTransportIdentity(parsed.transport);
  assertExactUcscSourceUrls(genomeId, sources, checksumManifest);
  return {
    contract: UCSC_REFERENCE_PACKAGE_ACQUISITION_V1,
    genomeId,
    annotationTable: UCSC_CENTRAL_ANNOTATION_TABLE,
    transport,
    checksumManifest,
    package: packageIdentity,
    sources,
  };
}

async function readAndVerifySourceSet(
  path: string,
  receipt: UcscReferencePackageAcquisitionReceiptV1
): Promise<UcscReferenceSourceSetV1> {
  if (basename(path) !== receipt.package.fileName) {
    throw new Error('UCSC source-set path does not match the acquisition receipt.');
  }
  const identity = await hashFile(path);
  if (
    identity.sha256 !== receipt.package.sha256 ||
    identity.byteLength !== receipt.package.byteLength
  ) {
    throw new Error('UCSC source-set bytes do not match the acquisition receipt.');
  }
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !isRecord(parsed) ||
    parsed.contract !== UCSC_REFERENCE_SOURCE_SET_V1 ||
    parsed.genomeId !== receipt.genomeId ||
    parsed.annotationTable !== receipt.annotationTable
  ) {
    throw new Error('UCSC source set does not match the acquisition receipt identity.');
  }
  const sources = admitSources(parsed.sources);
  if (!isDeepStrictEqual(sources, receipt.sources)) {
    throw new Error('UCSC source set differs from the acquisition receipt.');
  }
  return {
    contract: UCSC_REFERENCE_SOURCE_SET_V1,
    genomeId: receipt.genomeId,
    annotationTable: receipt.annotationTable,
    sources,
  };
}

function admitPackageIdentity(value: unknown): UcscPackageIdentity {
  if (!isRecord(value) || !safeFileName(value.fileName)) {
    throw new Error('UCSC acquisition receipt package identity is invalid.');
  }
  if (
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    !positiveSafeInteger(value.byteLength)
  ) {
    throw new Error('UCSC acquisition receipt package bytes are invalid.');
  }
  return {
    fileName: value.fileName,
    sha256: value.sha256,
    byteLength: value.byteLength,
  };
}

function admitSources(value: unknown): UcscReferenceSourceSetV1['sources'] {
  if (!isRecord(value)) throw new Error('UCSC acquisition receipt sources are invalid.');
  return {
    fasta: admitDownloadIdentity(value.fasta, 'fasta'),
    chromSizes: admitDownloadIdentity(value.chromSizes, 'chromSizes'),
    annotations: admitDownloadIdentity(value.annotations, 'annotations'),
  };
}

function admitDownloadIdentity(value: unknown, kind: string): UcscSourceIdentity {
  if (
    !isRecord(value) ||
    !safeFileName(value.fileName) ||
    typeof value.url !== 'string' ||
    !/^https?:\/\//u.test(value.url) ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    typeof value.md5 !== 'string' ||
    !MD5.test(value.md5) ||
    !positiveSafeInteger(value.byteLength) ||
    (value.lastModified !== undefined && typeof value.lastModified !== 'string') ||
    (value.etag !== undefined && typeof value.etag !== 'string')
  ) {
    throw new Error(`UCSC acquisition receipt ${kind} source is invalid.`);
  }
  return {
    fileName: value.fileName,
    url: value.url,
    sha256: value.sha256,
    md5: value.md5,
    byteLength: value.byteLength,
    ...(value.lastModified === undefined ? {} : { lastModified: value.lastModified }),
    ...(value.etag === undefined ? {} : { etag: value.etag }),
  };
}

function admitTransportIdentity(value: unknown): UcscTransportIdentity {
  if (
    !isRecord(value) ||
    value.name !== 'node-fetch' ||
    typeof value.nodeVersion !== 'string' ||
    value.nodeVersion.length === 0
  ) {
    throw new Error('UCSC acquisition receipt transport identity is invalid.');
  }
  return { name: 'node-fetch', nodeVersion: value.nodeVersion };
}

function assertExactUcscSourceUrls(
  genomeId: string,
  sources: UcscReferenceSourceSetV1['sources'],
  checksumManifest: UcscSourceIdentity
): void {
  const base = `${UCSC_REFERENCE_SOURCE_ORIGIN}/goldenPath/${genomeId}/bigZips`;
  if (
    checksumManifest.url !== `${base}/md5sum.txt` ||
    checksumManifest.fileName !== `${genomeId}.md5sum.txt`
  ) {
    throw new Error(
      'UCSC acquisition receipt checksumManifest does not use the exact UCSC source URL.'
    );
  }
  const expected = {
    fasta: `${base}/${genomeId}.fa.gz`,
    chromSizes: `${base}/${genomeId}.chrom.sizes`,
    annotations: `${base}/genes/${genomeId}.${UCSC_CENTRAL_ANNOTATION_TABLE}.gtf.gz`,
  } as const;
  const expectedNames = {
    fasta: `${genomeId}.fa.gz`,
    chromSizes: `${genomeId}.chrom.sizes`,
    annotations: `${genomeId}.${UCSC_CENTRAL_ANNOTATION_TABLE}.gtf.gz`,
  } as const;
  for (const kind of ['fasta', 'chromSizes', 'annotations'] as const) {
    if (sources[kind].url !== expected[kind] || sources[kind].fileName !== expectedNames[kind]) {
      throw new Error(`UCSC acquisition receipt ${kind} does not use the exact UCSC source URL.`);
    }
  }
}

function safeSourcePath(root: string, fileName: string): string {
  if (!safeFileName(fileName)) throw new Error('UCSC acquisition source file name is unsafe.');
  return join(root, fileName);
}

async function verifyPublisherManifest(
  manifestPath: string,
  sources: UcscReferenceSourceSetV1['sources']
): Promise<void> {
  const manifest = await readFile(manifestPath, 'utf8');
  for (const kind of ['fasta', 'chromSizes'] as const) {
    const publisherMd5 = requireUcscManifestMd5(manifest, sources[kind].fileName);
    if (publisherMd5 !== sources[kind].md5) {
      throw new Error(`UCSC publisher MD5 does not match the ${kind} acquisition receipt.`);
    }
  }
}

async function readChromSizes(
  path: string
): Promise<readonly { readonly sourceSeqId: string; readonly lengthBp: number }[]> {
  const sourceStat = await stat(path);
  if (!sourceStat.isFile() || sourceStat.size < 1 || sourceStat.size > MAX_CHROM_SIZES_BYTES) {
    throw new Error('UCSC chromosome sizes file has an invalid byte length.');
  }
  const seen = new Set<string>();
  const contigs = (await readFile(path, 'utf8'))
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const fields = line.split('\t');
      if (fields.length !== 2 || !SAFE_SEGMENT.test(fields[0])) {
        throw new Error(`UCSC chromosome sizes line ${index + 1} is invalid.`);
      }
      const lengthBp = Number(fields[1]);
      if (!Number.isSafeInteger(lengthBp) || lengthBp < 1) {
        throw new Error(`UCSC chromosome sizes line ${index + 1} has an invalid length.`);
      }
      if (seen.has(fields[0])) {
        throw new Error(`UCSC chromosome sizes duplicate ${fields[0]}.`);
      }
      seen.add(fields[0]);
      return Object.freeze({ sourceSeqId: fields[0], lengthBp });
    });
  if (contigs.length === 0) throw new Error('UCSC chromosome sizes file is empty.');
  return Object.freeze(contigs);
}

function assertFastaMatchesChromSizes(
  fastaContigs: readonly { readonly sourceSeqId: string; readonly lengthBp: number }[],
  chromSizes: readonly { readonly sourceSeqId: string; readonly lengthBp: number }[]
): void {
  const fastaById = new Map(fastaContigs.map((contig) => [contig.sourceSeqId, contig.lengthBp]));
  if (fastaById.size !== chromSizes.length) {
    throw new Error('UCSC chromosome sizes and FASTA contain different sequence counts.');
  }
  let fastaTotal = 0;
  let authorityTotal = 0;
  for (const contig of fastaContigs) fastaTotal += contig.lengthBp;
  for (const contig of chromSizes) {
    authorityTotal += contig.lengthBp;
    const fastaLength = fastaById.get(contig.sourceSeqId);
    if (fastaLength === undefined) {
      throw new Error(`UCSC chromosome ${contig.sourceSeqId} is absent from the FASTA.`);
    }
    if (fastaLength !== contig.lengthBp) {
      throw new Error(
        `UCSC chromosome ${contig.sourceSeqId} length ${contig.lengthBp} does not match FASTA length ${fastaLength}.`
      );
    }
  }
  if (fastaTotal !== authorityTotal) {
    throw new Error('UCSC chromosome-size total does not match the FASTA total length.');
  }
}

function hostedContigFromUcscAuthority(contig: {
  readonly sourceSeqId: string;
  readonly lengthBp: number;
}): HostedReferenceContigV1 {
  return {
    chrom: contig.sourceSeqId,
    sourceSeqId: contig.sourceSeqId,
    displayName: contig.sourceSeqId,
    lengthBp: contig.lengthBp,
    role: ucscSequenceRole(contig.sourceSeqId),
    circular: contig.sourceSeqId === 'chrM',
    aliases: { ucsc: contig.sourceSeqId },
  };
}

function ucscSequenceRole(sourceSeqId: string): AssemblySequenceRole {
  if (sourceSeqId === 'chrM') return 'mitochondrion';
  if (/^chr(?:[0-9]+[A-Z]?|[XYWZ])$/u.test(sourceSeqId)) return 'assembled-molecule';
  if (sourceSeqId.startsWith('chrUn_')) return 'unplaced-scaffold';
  if (sourceSeqId.endsWith('_random')) return 'unlocalized-scaffold';
  return 'other';
}

function expandedFastaByteBound(
  contigs: readonly { readonly sourceSeqId: string; readonly lengthBp: number }[]
): number {
  let totalBases = 0;
  for (const contig of contigs) {
    totalBases += contig.lengthBp;
    if (!Number.isSafeInteger(totalBases)) {
      throw new Error('UCSC chromosome-size total exceeds the safe integer range.');
    }
  }
  const formattingAllowance = Math.max(
    64 * 1024,
    Math.ceil(totalBases / 20),
    contigs.length * 4_096
  );
  const bound = totalBases + formattingAllowance;
  if (!Number.isSafeInteger(bound) || bound > MAX_EXPANDED_FASTA_BYTES) {
    throw new Error('UCSC FASTA expanded byte bound exceeds the hard limit.');
  }
  return bound;
}

async function decodeGzip(
  sourcePath: string,
  destinationPath: string,
  maxExpandedBytes: number
): Promise<void> {
  let expandedBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      expandedBytes += bytes.byteLength;
      if (expandedBytes > maxExpandedBytes) {
        callback(new Error('UCSC FASTA exceeded the expanded byte bound.'));
        return;
      }
      callback(null, bytes);
    },
  });
  try {
    await pipeline(
      createReadStream(sourcePath),
      createGunzip(),
      limiter,
      createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 })
    );
  } catch (error) {
    await rm(destinationPath, { force: true });
    throw error;
  }
}

interface SnapshotExpectedIdentity {
  readonly sha256: string;
  readonly byteLength: number;
  readonly md5?: string;
}

async function snapshotFile(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly label: string;
  readonly maxBytes: number;
  readonly expected?: SnapshotExpectedIdentity;
}): Promise<{ readonly sha256: string; readonly byteLength: number; readonly md5?: string }> {
  let sourceEntry: Awaited<ReturnType<typeof lstat>>;
  try {
    sourceEntry = await lstat(input.sourcePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`UCSC ${input.label} is missing.`);
    }
    throw error;
  }
  if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink()) {
    throw new Error(`UCSC ${input.label} must be a regular file.`);
  }
  if (input.expected && sourceEntry.size !== input.expected.byteLength) {
    throw new Error(`UCSC ${input.label} bytes do not match the acquisition receipt.`);
  }
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    sourceEntry.size < 1 ||
    sourceEntry.size > input.maxBytes
  ) {
    throw new Error(`UCSC ${input.label} has an invalid byte length.`);
  }

  const source = await openStableSource(input.sourcePath);
  const destination = await open(input.destinationPath, 'wx', 0o600);
  const sha256 = createHash('sha256');
  const md5 = input.expected?.md5 === undefined ? null : createHash('md5');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteLength = 0;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.dev !== sourceEntry.dev || before.ino !== sourceEntry.ino) {
      throw new Error(`UCSC ${input.label} changed before it could be snapshotted.`);
    }
    let sourceComplete = false;
    while (!sourceComplete) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        sourceComplete = true;
        continue;
      }
      const bytes = buffer.subarray(0, bytesRead);
      byteLength += bytesRead;
      if (byteLength > input.maxBytes) {
        throw new Error(`UCSC ${input.label} exceeded its byte bound.`);
      }
      sha256.update(bytes);
      md5?.update(bytes);
      await destination.writeFile(bytes);
    }
    const after = await source.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      byteLength !== after.size
    ) {
      throw new Error(`UCSC ${input.label} changed while it was being snapshotted.`);
    }
    await destination.sync();
  } catch (error) {
    await destination.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    await rm(input.destinationPath, { force: true });
    throw error;
  }
  await destination.close();
  await source.close();
  const identity = {
    sha256: sha256.digest('hex'),
    byteLength,
    ...(md5 ? { md5: md5.digest('hex') } : {}),
  };
  if (
    input.expected &&
    (identity.sha256 !== input.expected.sha256 ||
      identity.byteLength !== input.expected.byteLength ||
      (input.expected.md5 !== undefined && identity.md5 !== input.expected.md5))
  ) {
    await rm(input.destinationPath, { force: true });
    throw new Error(`UCSC ${input.label} bytes do not match the acquisition receipt.`);
  }
  return identity;
}

async function openStableSource(path: string) {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      process.platform === 'win32' &&
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EINVAL' || error.code === 'ENOTSUP')
    ) {
      return open(path, constants.O_RDONLY);
    }
    throw error;
  }
}

async function acquireOperationLock(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`UCSC source admission is already creating this candidate: ${path}`);
    }
    throw error;
  }
}

function hostedReferenceSourceRelativePath(input: {
  readonly assemblyId: string;
  readonly genomeId: string;
  readonly fileName: string;
  readonly sha256: string;
}): string {
  if (!SAFE_SEGMENT.test(input.assemblyId) || !SAFE_SEGMENT.test(input.genomeId)) {
    throw new Error('Hosted reference source path segments are invalid.');
  }
  if (!SHA256.test(input.sha256)) {
    throw new Error('Hosted reference source SHA-256 must be lowercase hexadecimal.');
  }
  return `${input.assemblyId}/${input.genomeId}/${input.sha256.slice(0, 16)}/${input.fileName}`;
}

async function hashFile(
  path: string,
  includeMd5 = false
): Promise<{ readonly sha256: string; readonly byteLength: number; readonly md5?: string }> {
  const sha256 = createHash('sha256');
  const md5 = includeMd5 ? createHash('md5') : null;
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sha256.update(bytes);
    md5?.update(bytes);
    byteLength += bytes.byteLength;
  }
  if (byteLength === 0) throw new Error(`File is empty: ${basename(path)}`);
  return {
    sha256: sha256.digest('hex'),
    byteLength,
    ...(md5 ? { md5: md5.digest('hex') } : {}),
  };
}

async function writeCreateOnlyJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`UCSC source admission output already exists: ${path}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`UCSC acquisition receipt ${field} is required.`);
  }
  return candidate;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeFileName(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SEGMENT.test(value) && value !== '.' && value !== '..';
}
