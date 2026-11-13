import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

import * as yauzl from 'yauzl';

import {
  figshareExternalAnnotationDatasetId,
  figshareExternalAnnotationDownloadUrl,
  validateHostedReferenceExternalAnnotationSourceV1,
  type HostedReferenceExternalAnnotationSourceV1,
} from './hosted-reference-external-annotation-source';
import { resolveNcbiDatasetsSelection } from './ncbi-datasets-reference-resolver';

export const NCBI_REFERENCE_PACKAGE_ACQUISITION_V1 =
  'dnaforge-ncbi-reference-package-acquisition.v1' as const;
export const NCBI_REFERENCE_PACKAGE_ACQUISITION_V2 =
  'dnaforge-ncbi-reference-package-acquisition.v2' as const;

const ACCESSION = /^GC[AF]_[0-9]+\.[0-9]+$/u;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_SEQUENCE_REPORT_BYTES = 64 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const ASSEMBLY_REPORT_PATH = 'ncbi_dataset/data/assembly_data_report.jsonl';
const MD5SUM_PATH = 'md5sum.txt';

export interface AcquireNcbiReferencePackageInput {
  readonly accession: string;
  readonly datasetsBinary: string;
  readonly outputDirectory: string;
  readonly externalAnnotation?: HostedReferenceExternalAnnotationSourceV1;
  readonly fetchAsset?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

interface ContentReceipt {
  readonly sha256: string;
  readonly byteLength: number;
}

interface ReportReceipt extends ContentReceipt {
  readonly recordCount: number;
}

export interface NcbiReferencePackageAcquisitionReceiptV1 {
  readonly contract: typeof NCBI_REFERENCE_PACKAGE_ACQUISITION_V1;
  readonly accession: string;
  readonly tool: ContentReceipt &
    Readonly<{
      name: 'datasets';
      version: string;
    }>;
  readonly package: ContentReceipt & Readonly<{ fileName: string }>;
  readonly reports: Readonly<{
    assembly: ReportReceipt;
    sequence: ReportReceipt;
  }>;
  readonly sources: Readonly<{
    fasta: ContentReceipt;
    gff3: ContentReceipt;
  }>;
}

export interface NcbiReferencePackageAcquisitionReceiptV2 {
  readonly contract: typeof NCBI_REFERENCE_PACKAGE_ACQUISITION_V2;
  readonly accession: string;
  readonly tool: NcbiReferencePackageAcquisitionReceiptV1['tool'];
  readonly package: NcbiReferencePackageAcquisitionReceiptV1['package'];
  readonly reports: NcbiReferencePackageAcquisitionReceiptV1['reports'];
  readonly sources: Readonly<{
    fasta: ContentReceipt;
    gff3: ContentReceipt & Readonly<{ fileName: string }>;
  }>;
  readonly externalAnnotation: Readonly<{
    provider: 'Figshare';
    datasetId: string;
    datasetVersion: string;
    articleId: number;
    fileId: number;
    originalFileName: string;
    publishedDate: string;
    sourceUrl: string;
    downloadUrl: string;
    license: string;
    attribution: string;
    lastModified?: string;
    etag?: string;
  }>;
}

export type NcbiReferencePackageAcquisitionReceipt =
  | NcbiReferencePackageAcquisitionReceiptV1
  | NcbiReferencePackageAcquisitionReceiptV2;

export interface AcquireNcbiReferencePackageResult {
  readonly packagePath: string;
  readonly receiptPath: string;
  readonly annotationPath?: string;
  readonly receipt: NcbiReferencePackageAcquisitionReceipt;
}

export async function acquireNcbiReferencePackage(
  rawInput: AcquireNcbiReferencePackageInput
): Promise<AcquireNcbiReferencePackageResult> {
  const input = validateInput(rawInput);
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });

  const packageFileName = `${input.accession}.ncbi-dataset.zip`;
  const receiptFileName = `${input.accession}.ncbi-acquisition.json`;
  const annotationFileName = `${input.accession}.external-annotation.gff3`;
  const packagePath = join(input.outputDirectory, packageFileName);
  const receiptPath = join(input.outputDirectory, receiptFileName);
  const annotationPath = join(input.outputDirectory, annotationFileName);
  await Promise.all(
    [packagePath, receiptPath, ...(input.externalAnnotation ? [annotationPath] : [])].map(
      assertPathAbsent
    )
  );

  const temporaryRoot = await mkdtemp(join(input.outputDirectory, `.${input.accession}.acquire-`));
  const downloadedPackagePath = join(temporaryRoot, 'package.zip');
  const createdFinals = new Set<string>();

  try {
    const toolSnapshot = await snapshotDatasetsBinary(input.datasetsBinary, temporaryRoot);
    await runDatasetsCommand(
      toolSnapshot.path,
      [
        'download',
        'genome',
        'accession',
        input.accession,
        '--include',
        'genome,gff3,seq-report',
        '--filename',
        downloadedPackagePath,
        '--no-progressbar',
      ],
      input.timeoutMs,
      'download'
    );

    const metadata = await inspectPackageMetadata(downloadedPackagePath, input.accession);
    const resolved = await resolveNcbiDatasetsSelection({
      selectedPath: downloadedPackagePath,
      selectedKind: 'file',
      stagingRoot: join(temporaryRoot, 'validated-sources'),
    });
    if (!resolved || resolved.kind !== 'ncbi-datasets') {
      throw new Error('Downloaded file is not an admitted NCBI Datasets package.');
    }
    if (!input.externalAnnotation && resolved.sourcePaths.length !== 2) {
      throw new Error(
        `NCBI package ${input.accession} must contain both genomic FASTA and GFF3 annotations.`
      );
    }
    if (input.externalAnnotation && resolved.sourcePaths.length !== 1) {
      throw new Error(
        `NCBI package ${input.accession} must be sequence-only when an external annotation is explicitly pinned.`
      );
    }
    const fastaSourcePath = resolved.sourcePaths[0];
    const packageGff3Path = resolved.sourcePaths[1];
    if (!fastaSourcePath || (!input.externalAnnotation && !packageGff3Path)) {
      throw new Error(`NCBI package ${input.accession} has an incomplete admitted source set.`);
    }

    const downloadedAnnotation = input.externalAnnotation
      ? await downloadExternalAnnotation({
          source: input.externalAnnotation,
          destinationPath: join(temporaryRoot, annotationFileName),
          timeoutMs: input.timeoutMs,
          fetchAsset: input.fetchAsset,
        })
      : undefined;

    const [downloadedPackage, fasta, gff3] = await Promise.all([
      hashFile(downloadedPackagePath),
      hashFile(fastaSourcePath),
      downloadedAnnotation
        ? Promise.resolve(downloadedAnnotation.identity)
        : hashFile(packageGff3Path as string),
    ]);

    await copyFile(downloadedPackagePath, packagePath, fsConstants.COPYFILE_EXCL);
    createdFinals.add(packagePath);
    const persistedPackage = await hashFile(packagePath);
    if (
      persistedPackage.byteLength !== downloadedPackage.byteLength ||
      persistedPackage.sha256 !== downloadedPackage.sha256
    ) {
      throw new Error('Final NCBI package bytes do not match the admitted download.');
    }

    let persistedAnnotation: ContentReceipt | undefined;
    if (downloadedAnnotation) {
      await copyFile(downloadedAnnotation.path, annotationPath, fsConstants.COPYFILE_EXCL);
      createdFinals.add(annotationPath);
      persistedAnnotation = await hashFile(annotationPath);
      if (
        persistedAnnotation.byteLength !== downloadedAnnotation.identity.byteLength ||
        persistedAnnotation.sha256 !== downloadedAnnotation.identity.sha256
      ) {
        throw new Error('Final external annotation bytes do not match the admitted download.');
      }
    }

    const common = {
      accession: input.accession,
      tool: toolSnapshot.receipt,
      package: {
        fileName: packageFileName,
        ...persistedPackage,
      },
      reports: metadata,
    } as const;
    const receipt: NcbiReferencePackageAcquisitionReceipt =
      input.externalAnnotation && downloadedAnnotation && persistedAnnotation
        ? {
            contract: NCBI_REFERENCE_PACKAGE_ACQUISITION_V2,
            ...common,
            sources: {
              fasta,
              gff3: { fileName: annotationFileName, ...persistedAnnotation },
            },
            externalAnnotation: {
              provider: 'Figshare',
              datasetId: figshareExternalAnnotationDatasetId(input.externalAnnotation),
              datasetVersion: `v${input.externalAnnotation.articleVersion}`,
              articleId: input.externalAnnotation.articleId,
              fileId: input.externalAnnotation.fileId,
              originalFileName: input.externalAnnotation.fileName,
              publishedDate: input.externalAnnotation.publishedDate,
              sourceUrl: input.externalAnnotation.sourceUrl,
              downloadUrl: figshareExternalAnnotationDownloadUrl(input.externalAnnotation),
              license: input.externalAnnotation.license,
              attribution: input.externalAnnotation.attribution,
              ...(downloadedAnnotation.lastModified
                ? { lastModified: downloadedAnnotation.lastModified }
                : {}),
              ...(downloadedAnnotation.etag ? { etag: downloadedAnnotation.etag } : {}),
            },
          }
        : {
            contract: NCBI_REFERENCE_PACKAGE_ACQUISITION_V1,
            ...common,
            sources: { fasta, gff3 },
          };
    const receiptHandle = await open(receiptPath, 'wx', 0o600);
    createdFinals.add(receiptPath);
    try {
      await receiptHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      await receiptHandle.sync();
    } finally {
      await receiptHandle.close();
    }

    return {
      packagePath,
      receiptPath,
      ...(input.externalAnnotation ? { annotationPath } : {}),
      receipt,
    };
  } catch (error) {
    await Promise.all([...createdFinals].map((path) => rm(path, { force: true })));
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function parseAcquireNcbiReferencePackageCli(
  argv: readonly string[]
): Omit<AcquireNcbiReferencePackageInput, 'timeoutMs' | 'fetchAsset'> {
  const values = new Map<string, string>();
  const allowed = new Set([
    'accession',
    'datasets-binary',
    'output-directory',
    'external-annotation-source',
  ]);
  for (const argument of argv) {
    const match = /^--([^=]+)=(.+)$/u.exec(argument);
    if (!match || !allowed.has(match[1])) {
      throw new Error(`Unknown NCBI acquisition argument: ${argument}`);
    }
    if (values.has(match[1])) {
      throw new Error(`Duplicate NCBI acquisition argument: --${match[1]}`);
    }
    values.set(match[1], match[2]);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) {
      throw new Error(
        'Usage: pnpm exec vite-node tools/devops/scripts/acquire-ncbi-reference-package.ts ' +
          '--accession=<GCF_or_GCA_version> --datasets-binary=<path> ' +
          '--output-directory=<directory>'
      );
    }
    return value;
  };
  const accession = required('accession');
  if (!ACCESSION.test(accession)) {
    throw new Error('NCBI acquisition accession must be an exact versioned GCF_ or GCA_ assembly.');
  }
  const externalAnnotationRaw = values.get('external-annotation-source');
  let externalAnnotation: HostedReferenceExternalAnnotationSourceV1 | undefined;
  if (externalAnnotationRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(externalAnnotationRaw);
    } catch {
      throw new Error('NCBI external annotation source must be valid JSON.');
    }
    externalAnnotation = validateHostedReferenceExternalAnnotationSourceV1(parsed, accession);
  }
  return {
    accession,
    datasetsBinary: resolve(required('datasets-binary')),
    outputDirectory: resolve(required('output-directory')),
    ...(externalAnnotation ? { externalAnnotation } : {}),
  };
}

function validateInput(input: AcquireNcbiReferencePackageInput): Readonly<{
  accession: string;
  datasetsBinary: string;
  outputDirectory: string;
  timeoutMs: number;
  externalAnnotation?: HostedReferenceExternalAnnotationSourceV1;
  fetchAsset: (input: string | URL, init?: RequestInit) => Promise<Response>;
}> {
  if (!ACCESSION.test(input.accession)) {
    throw new Error('NCBI acquisition accession must be an exact versioned GCF_ or GCA_ assembly.');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('NCBI acquisition timeout must be a positive safe integer.');
  }
  return {
    accession: input.accession,
    datasetsBinary: resolve(input.datasetsBinary),
    outputDirectory: resolve(input.outputDirectory),
    timeoutMs,
    ...(input.externalAnnotation
      ? {
          externalAnnotation: validateHostedReferenceExternalAnnotationSourceV1(
            input.externalAnnotation,
            input.accession
          ),
        }
      : {}),
    fetchAsset: input.fetchAsset ?? globalThis.fetch,
  };
}

async function downloadExternalAnnotation(input: {
  readonly source: HostedReferenceExternalAnnotationSourceV1;
  readonly destinationPath: string;
  readonly timeoutMs: number;
  readonly fetchAsset: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): Promise<{
  readonly path: string;
  readonly identity: ContentReceipt;
  readonly lastModified?: string;
  readonly etag?: string;
}> {
  const downloadUrl = figshareExternalAnnotationDownloadUrl(input.source);
  const response = await input.fetchAsset(new URL(downloadUrl), {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(input.timeoutMs),
    headers: { 'user-agent': 'dnaforge-reference-source-acquisition/1.0' },
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `External annotation acquisition failed for Figshare file ${input.source.fileId}: HTTP ${response.status}.`
    );
  }
  assertAdmittedFigshareResponseUrl(response.url, input.source);
  const declaredLengthRaw = response.headers.get('content-length');
  const declaredLength = declaredLengthRaw === null ? null : Number(declaredLengthRaw);
  if (
    declaredLength !== null &&
    (!Number.isSafeInteger(declaredLength) || declaredLength !== input.source.byteLength)
  ) {
    throw new Error('Figshare annotation declared byte length does not match its pinned identity.');
  }

  const handle = await open(input.destinationPath, 'wx', 0o600);
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let byteLength = 0;
  try {
    let next = await reader.read();
    while (!next.done) {
      const bytes = Buffer.from(next.value);
      byteLength += bytes.byteLength;
      if (byteLength > input.source.byteLength) {
        throw new Error('Figshare annotation exceeded its pinned byte length.');
      }
      hash.update(bytes);
      await handle.writeFile(bytes);
      next = await reader.read();
    }
    await handle.sync();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await rm(input.destinationPath, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
  await handle.close();
  const sha256 = hash.digest('hex');
  if (byteLength !== input.source.byteLength || sha256 !== input.source.sha256) {
    await rm(input.destinationPath, { force: true });
    throw new Error('Figshare annotation bytes do not match the pinned source identity.');
  }
  const lastModified = response.headers.get('last-modified');
  const etag = response.headers.get('etag');
  return {
    path: input.destinationPath,
    identity: { sha256, byteLength },
    ...(lastModified ? { lastModified } : {}),
    ...(etag ? { etag } : {}),
  };
}

function assertAdmittedFigshareResponseUrl(
  rawResponseUrl: string,
  source: HostedReferenceExternalAnnotationSourceV1
): void {
  if (!rawResponseUrl) {
    throw new Error('Figshare annotation response did not expose its final URL.');
  }
  const responseUrl = new URL(rawResponseUrl);
  const downloadUrl = new URL(figshareExternalAnnotationDownloadUrl(source));
  if (responseUrl.origin === downloadUrl.origin && responseUrl.pathname === downloadUrl.pathname) {
    return;
  }
  const admittedS3Redirect =
    responseUrl.protocol === 'https:' &&
    responseUrl.hostname === 's3-eu-west-1.amazonaws.com' &&
    responseUrl.pathname.startsWith(`/pfigshare-u-files/${source.fileId}/`);
  if (!admittedS3Redirect) {
    throw new Error('Figshare annotation redirect left the admitted publisher object path.');
  }
}

async function snapshotDatasetsBinary(
  path: string,
  temporaryRoot: string
): Promise<{
  readonly path: string;
  readonly receipt: NcbiReferencePackageAcquisitionReceiptV1['tool'];
}> {
  const resolvedPath = await realpath(path);
  const before = await stat(resolvedPath, { bigint: true });
  if (!before.isFile() || before.size <= 0n) {
    throw new Error('NCBI datasets binary must be a non-empty regular file.');
  }
  await access(resolvedPath, fsConstants.X_OK);
  const snapshotPath = join(temporaryRoot, 'datasets.snapshot');
  await copyFile(resolvedPath, snapshotPath, fsConstants.COPYFILE_EXCL);
  await chmod(snapshotPath, 0o700);
  const after = await stat(resolvedPath, { bigint: true });
  if (!sameFileIdentity(before, after)) {
    throw new Error('NCBI datasets binary changed while it was being snapshotted.');
  }
  const [identity, versionResult] = await Promise.all([
    hashFile(snapshotPath),
    runDatasetsCommand(snapshotPath, ['--version'], 30_000, 'version'),
  ]);
  const version = versionResult.stdout.trim();
  if (version.length === 0 || version.length > 1_024) {
    throw new Error('NCBI datasets binary returned an invalid version string.');
  }
  return {
    path: snapshotPath,
    receipt: {
      name: 'datasets',
      version,
      ...identity,
    },
  };
}

function sameFileIdentity(
  left: import('node:fs').BigIntStats,
  right: import('node:fs').BigIntStats
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function runDatasetsCommand(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  label: string
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputFailure: Error | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const collect = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === 'stdout') stdoutBytes += bytes.byteLength;
      else stderrBytes += bytes.byteLength;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES || stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        outputFailure = new Error(`NCBI datasets ${label} output exceeded the bounded limit.`);
        child.kill('SIGKILL');
        return;
      }
      target.push(bytes);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk, 'stderr'));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (outputFailure) {
        reject(outputFailure);
        return;
      }
      if (timedOut) {
        reject(new Error(`NCBI datasets ${label} exceeded the ${timeoutMs} ms timeout.`));
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(
          new Error(
            `NCBI datasets ${label} failed with exit ${code ?? 'null'}${
              signal ? ` (${signal})` : ''
            }: ${stderrText.trim() || '<no stderr>'}`
          )
        );
        return;
      }
      resolvePromise({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

async function inspectPackageMetadata(
  packagePath: string,
  accession: string
): Promise<NcbiReferencePackageAcquisitionReceiptV1['reports']> {
  const sequenceReportPath = `ncbi_dataset/data/${accession}/sequence_report.jsonl`;
  const entries = await readZipTextEntries(
    packagePath,
    [ASSEMBLY_REPORT_PATH, sequenceReportPath, MD5SUM_PATH],
    new Map([[sequenceReportPath, MAX_SEQUENCE_REPORT_BYTES]])
  );
  const assemblyBytes = requiredEntry(entries, ASSEMBLY_REPORT_PATH);
  const sequenceBytes = requiredEntry(entries, sequenceReportPath);
  const md5Bytes = requiredEntry(entries, MD5SUM_PATH);
  const assemblyRecords = parseJsonLines(assemblyBytes, ASSEMBLY_REPORT_PATH);
  if (assemblyRecords.length !== 1 || assemblyRecords[0].accession !== accession) {
    throw new Error(`NCBI package assembly report does not identify exact accession ${accession}.`);
  }
  const sequenceRecords = parseJsonLines(sequenceBytes, sequenceReportPath);
  if (
    sequenceRecords.length === 0 ||
    sequenceRecords.some((record) => record.assemblyAccession !== accession)
  ) {
    throw new Error(`NCBI package sequence report is not bound to exact accession ${accession}.`);
  }

  const md5ByPath = parseMd5Manifest(md5Bytes.toString('utf8'));
  assertMd5(assemblyBytes, md5ByPath.get(ASSEMBLY_REPORT_PATH), ASSEMBLY_REPORT_PATH);
  assertMd5(sequenceBytes, md5ByPath.get(sequenceReportPath), sequenceReportPath);

  return {
    assembly: { ...hashBuffer(assemblyBytes), recordCount: assemblyRecords.length },
    sequence: { ...hashBuffer(sequenceBytes), recordCount: sequenceRecords.length },
  };
}

export interface NcbiSequenceReportRecordV1 {
  readonly assemblyAccession: string;
  readonly assemblyUnit?: string;
  readonly assignedMoleculeLocationType?: string;
  readonly chrName?: string;
  readonly sequenceName?: string;
  readonly sortOrder?: number;
  readonly ucscStyleName?: string;
  readonly refseqAccession?: string;
  readonly genbankAccession?: string;
  readonly length: number;
  readonly role: string;
}

export interface NcbiAssemblyReportV1 {
  readonly accession: string;
  readonly assemblyName: string;
  readonly assemblyLevel: string;
  readonly assemblyStatus: string;
  readonly organismName: string;
  readonly taxId: number;
  readonly totalNumberOfChromosomes: number;
  readonly annotationName?: string;
  readonly annotationReleaseDate?: string;
}

export interface NcbiDatasetsReportAuthorityV1 {
  readonly assembly: NcbiAssemblyReportV1;
  readonly sequence: ReadonlyArray<NcbiSequenceReportRecordV1>;
  readonly identities: NcbiReferencePackageAcquisitionReceiptV1['reports'];
}

export async function readNcbiDatasetsReportAuthority(
  packagePath: string,
  accession: string
): Promise<NcbiDatasetsReportAuthorityV1> {
  if (!ACCESSION.test(accession)) {
    throw new Error('NCBI acquisition accession must be an exact versioned GCF_ or GCA_ assembly.');
  }
  const sequenceReportPath = `ncbi_dataset/data/${accession}/sequence_report.jsonl`;
  const entries = await readZipTextEntries(
    packagePath,
    [ASSEMBLY_REPORT_PATH, sequenceReportPath],
    new Map([[sequenceReportPath, MAX_SEQUENCE_REPORT_BYTES]])
  );
  const assemblyBytes = requiredEntry(entries, ASSEMBLY_REPORT_PATH);
  const sequenceBytes = requiredEntry(entries, sequenceReportPath);
  const assemblyRecords = parseJsonLines(assemblyBytes, ASSEMBLY_REPORT_PATH);
  if (assemblyRecords.length !== 1) {
    throw new Error('NCBI package must contain exactly one assembly report record.');
  }
  const sequenceRecords = parseJsonLines(sequenceBytes, sequenceReportPath).map((record, index) =>
    admitSequenceReportRecord(record, accession, `${sequenceReportPath}:${index + 1}`)
  );
  return {
    assembly: admitAssemblyReportRecord(assemblyRecords[0], accession, ASSEMBLY_REPORT_PATH),
    sequence: sequenceRecords,
    identities: {
      assembly: { ...hashBuffer(assemblyBytes), recordCount: assemblyRecords.length },
      sequence: { ...hashBuffer(sequenceBytes), recordCount: sequenceRecords.length },
    },
  };
}

export async function readNcbiDatasetsAssemblyReport(
  packagePath: string,
  accession: string
): Promise<NcbiAssemblyReportV1> {
  if (!ACCESSION.test(accession)) {
    throw new Error('NCBI acquisition accession must be an exact versioned GCF_ or GCA_ assembly.');
  }
  const entries = await readZipTextEntries(packagePath, [ASSEMBLY_REPORT_PATH]);
  const records = parseJsonLines(
    requiredEntry(entries, ASSEMBLY_REPORT_PATH),
    ASSEMBLY_REPORT_PATH
  );
  if (records.length !== 1) {
    throw new Error('NCBI package must contain exactly one assembly report record.');
  }
  return admitAssemblyReportRecord(records[0], accession, ASSEMBLY_REPORT_PATH);
}

export async function readNcbiDatasetsSequenceReport(
  packagePath: string,
  accession: string
): Promise<ReadonlyArray<NcbiSequenceReportRecordV1>> {
  if (!ACCESSION.test(accession)) {
    throw new Error('NCBI acquisition accession must be an exact versioned GCF_ or GCA_ assembly.');
  }
  const sequenceReportPath = `ncbi_dataset/data/${accession}/sequence_report.jsonl`;
  const entries = await readZipTextEntries(
    packagePath,
    [sequenceReportPath],
    new Map([[sequenceReportPath, MAX_SEQUENCE_REPORT_BYTES]])
  );
  const sequenceBytes = requiredEntry(entries, sequenceReportPath);
  return parseJsonLines(sequenceBytes, sequenceReportPath).map((record, index) =>
    admitSequenceReportRecord(record, accession, `${sequenceReportPath}:${index + 1}`)
  );
}

interface JsonRecord {
  readonly accession?: unknown;
  readonly assemblyAccession?: unknown;
  readonly assemblyUnit?: unknown;
  readonly assignedMoleculeLocationType?: unknown;
  readonly chrName?: unknown;
  readonly sequenceName?: unknown;
  readonly sortOrder?: unknown;
  readonly ucscStyleName?: unknown;
  readonly refseqAccession?: unknown;
  readonly genbankAccession?: unknown;
  readonly length?: unknown;
  readonly role?: unknown;
  readonly assemblyInfo?: unknown;
  readonly assemblyStats?: unknown;
  readonly organism?: unknown;
  readonly annotationInfo?: unknown;
}

function admitAssemblyReportRecord(
  record: JsonRecord,
  accession: string,
  label: string
): NcbiAssemblyReportV1 {
  if (record.accession !== accession) {
    throw new Error(`${label} is not bound to exact accession ${accession}.`);
  }
  const assemblyInfo = requiredRecord(record.assemblyInfo, `${label}.assemblyInfo`);
  const assemblyStats = requiredRecord(record.assemblyStats, `${label}.assemblyStats`);
  const organism = requiredRecord(record.organism, `${label}.organism`);
  const annotationInfo =
    record.annotationInfo === undefined || record.annotationInfo === null
      ? undefined
      : requiredRecord(record.annotationInfo, `${label}.annotationInfo`);
  return {
    accession,
    assemblyName: requiredReportText(
      assemblyInfo.assemblyName,
      `${label}.assemblyInfo.assemblyName`
    ),
    assemblyLevel: requiredReportText(
      assemblyInfo.assemblyLevel,
      `${label}.assemblyInfo.assemblyLevel`
    ),
    assemblyStatus: requiredReportText(
      assemblyInfo.assemblyStatus,
      `${label}.assemblyInfo.assemblyStatus`
    ),
    organismName: requiredReportText(organism.organismName, `${label}.organism.organismName`),
    taxId: requiredReportPositiveInteger(organism.taxId, `${label}.organism.taxId`),
    totalNumberOfChromosomes: requiredReportPositiveInteger(
      assemblyStats.totalNumberOfChromosomes,
      `${label}.assemblyStats.totalNumberOfChromosomes`
    ),
    ...(annotationInfo
      ? {
          annotationName: requiredReportText(annotationInfo.name, `${label}.annotationInfo.name`),
          annotationReleaseDate: requiredReportText(
            annotationInfo.releaseDate,
            `${label}.annotationInfo.releaseDate`
          ),
        }
      : {}),
  };
}

function admitSequenceReportRecord(
  record: JsonRecord,
  accession: string,
  label: string
): NcbiSequenceReportRecordV1 {
  if (record.assemblyAccession !== accession) {
    throw new Error(`${label} is not bound to exact accession ${accession}.`);
  }
  if (
    typeof record.length !== 'number' ||
    !Number.isSafeInteger(record.length) ||
    record.length < 1
  ) {
    throw new Error(`${label} does not declare a positive sequence length.`);
  }
  if (typeof record.role !== 'string' || record.role.trim().length === 0) {
    throw new Error(`${label} does not declare a sequence role.`);
  }
  const refseqAccession =
    typeof record.refseqAccession === 'string' && record.refseqAccession.trim().length > 0
      ? record.refseqAccession
      : undefined;
  const genbankAccession =
    typeof record.genbankAccession === 'string' && record.genbankAccession.trim().length > 0
      ? record.genbankAccession
      : undefined;
  if (!refseqAccession && !genbankAccession) {
    throw new Error(`${label} does not declare a RefSeq or GenBank accession.`);
  }
  const assemblyUnit = optionalReportText(record.assemblyUnit, `${label}.assemblyUnit`);
  const assignedMoleculeLocationType = optionalReportText(
    record.assignedMoleculeLocationType,
    `${label}.assignedMoleculeLocationType`
  );
  const chrName = optionalReportText(record.chrName, `${label}.chrName`);
  const sequenceName = optionalReportText(record.sequenceName, `${label}.sequenceName`);
  const ucscStyleName = optionalReportText(record.ucscStyleName, `${label}.ucscStyleName`);
  const sortOrder = optionalReportPositiveInteger(record.sortOrder, `${label}.sortOrder`);
  return {
    assemblyAccession: accession,
    ...(assemblyUnit ? { assemblyUnit } : {}),
    ...(assignedMoleculeLocationType ? { assignedMoleculeLocationType } : {}),
    ...(chrName ? { chrName } : {}),
    ...(sequenceName ? { sequenceName } : {}),
    ...(sortOrder ? { sortOrder } : {}),
    ...(ucscStyleName ? { ucscStyleName } : {}),
    ...(refseqAccession ? { refseqAccession } : {}),
    ...(genbankAccession ? { genbankAccession } : {}),
    length: record.length,
    role: record.role,
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredReportText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalReportText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredReportText(value, label);
}

function requiredReportPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function optionalReportPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredReportPositiveInteger(value, label);
}

function parseJsonLines(bytes: Buffer, path: string): JsonRecord[] {
  return bytes
    .toString('utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${path} contains invalid JSON on line ${index + 1}.`);
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${path} contains a non-object record on line ${index + 1}.`);
      }
      return value as JsonRecord;
    });
}

function parseMd5Manifest(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-fA-F]{32})\s+\*?(.+)$/u.exec(line);
    if (!match) throw new Error(`NCBI checksum manifest is malformed on line ${index + 1}.`);
    const path = match[2].replace(/^\.\//u, '');
    if (values.has(path)) throw new Error(`NCBI checksum manifest duplicates ${path}.`);
    values.set(path, match[1].toLowerCase());
  }
  return values;
}

function assertMd5(bytes: Buffer, expected: string | undefined, path: string): void {
  if (!expected) throw new Error(`NCBI checksum manifest does not cover ${path}.`);
  const observed = createHash('md5').update(bytes).digest('hex');
  if (observed !== expected) {
    throw new Error(`NCBI checksum validation failed for ${path}.`);
  }
}

async function readZipTextEntries(
  path: string,
  requestedPaths: readonly string[],
  maxBytesByPath: ReadonlyMap<string, number> = new Map()
): Promise<ReadonlyMap<string, Buffer>> {
  const zipFile = await openZip(path);
  const requested = new Set(requestedPaths);
  return new Promise((resolvePromise, reject) => {
    const found = new Map<string, Buffer>();
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(error);
    };
    zipFile.once('error', fail);
    zipFile.once('end', () => {
      if (settled) return;
      settled = true;
      zipFile.removeListener('error', fail);
      zipFile.close();
      resolvePromise(found);
    });
    zipFile.on('entry', (entry: yauzl.Entry) => {
      if (!requested.has(entry.fileName)) {
        zipFile.readEntry();
        return;
      }
      if (found.has(entry.fileName)) {
        fail(new Error(`NCBI package duplicates metadata entry ${entry.fileName}.`));
        return;
      }
      readZipEntry(zipFile, entry, maxBytesByPath.get(entry.fileName) ?? MAX_METADATA_BYTES)
        .then((bytes) => {
          found.set(entry.fileName, bytes);
          zipFile.readEntry();
        })
        .catch(fail);
    });
    zipFile.readEntry();
  });
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error('Unable to open NCBI package ZIP.'));
      else resolvePromise(zipFile);
    });
  });
}

function readZipEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxBytes: number
): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) {
    return Promise.reject(new Error(`NCBI metadata entry is too large: ${entry.fileName}`));
  }
  return new Promise((resolvePromise, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read NCBI metadata entry ${entry.fileName}.`));
        return;
      }
      collectBoundedStream(stream, maxBytes).then(resolvePromise, reject);
    });
  });
}

async function collectBoundedStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error('NCBI metadata entry exceeded the bounded read limit.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function requiredEntry(entries: ReadonlyMap<string, Buffer>, path: string): Buffer {
  const value = entries.get(path);
  if (!value) throw new Error(`NCBI package is missing ${path}.`);
  return value;
}

function hashBuffer(bytes: Buffer): ContentReceipt {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  };
}

async function hashFile(path: string): Promise<ContentReceipt> {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    byteLength += bytes.byteLength;
    if (!Number.isSafeInteger(byteLength)) {
      throw new Error(`File exceeds the safe byte-length limit: ${basename(path)}`);
    }
  }
  if (byteLength === 0) throw new Error(`File is empty: ${basename(path)}`);
  return { sha256: hash.digest('hex'), byteLength };
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`NCBI acquisition output already exists: ${path}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
