import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { requestHostedReferenceAsset } from './hosted-reference-transport';

export const UCSC_REFERENCE_PACKAGE_ACQUISITION_V1 =
  'dnaforge-ucsc-reference-package-acquisition.v1' as const;
export const UCSC_REFERENCE_SOURCE_SET_V1 = 'dnaforge-ucsc-reference-source-set.v1' as const;
export const UCSC_CENTRAL_ANNOTATION_TABLE = 'ncbiRefSeq' as const;
export const UCSC_REFERENCE_SOURCE_ORIGIN = 'https://hgdownload.soe.ucsc.edu' as const;

const SAFE_GENOME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MD5 = /^[0-9a-f]{32}$/u;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;

export interface AcquireUcscReferencePackageInput {
  readonly genomeId: string;
  readonly outputDirectory: string;
  readonly sourceOrigin?: string;
  readonly timeoutMs?: number;
}

interface DownloadIdentity {
  readonly fileName: string;
  readonly url: string;
  readonly sha256: string;
  readonly md5: string;
  readonly byteLength: number;
  readonly lastModified?: string;
  readonly etag?: string;
}

export interface UcscReferenceSourceSetV1 {
  readonly contract: typeof UCSC_REFERENCE_SOURCE_SET_V1;
  readonly genomeId: string;
  readonly annotationTable: typeof UCSC_CENTRAL_ANNOTATION_TABLE;
  readonly sources: Readonly<{
    fasta: DownloadIdentity;
    chromSizes: DownloadIdentity;
    annotations: DownloadIdentity;
  }>;
}

export interface UcscReferencePackageAcquisitionReceiptV1 {
  readonly contract: typeof UCSC_REFERENCE_PACKAGE_ACQUISITION_V1;
  readonly genomeId: string;
  readonly annotationTable: typeof UCSC_CENTRAL_ANNOTATION_TABLE;
  readonly transport: Readonly<{ name: 'node-fetch'; nodeVersion: string }>;
  readonly checksumManifest: DownloadIdentity;
  readonly package: Readonly<{
    fileName: string;
    sha256: string;
    byteLength: number;
  }>;
  readonly sources: UcscReferenceSourceSetV1['sources'];
}

export interface AcquireUcscReferencePackageResult {
  readonly packagePath: string;
  readonly receiptPath: string;
  readonly sourcePaths: Readonly<{
    fasta: string;
    chromSizes: string;
    annotations: string;
  }>;
  readonly receipt: UcscReferencePackageAcquisitionReceiptV1;
}

export async function acquireUcscReferencePackage(
  rawInput: AcquireUcscReferencePackageInput
): Promise<AcquireUcscReferencePackageResult> {
  const input = validateInput(rawInput);
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const names = sourceNames(input.genomeId);
  const operationLockPath = join(input.outputDirectory, `.${input.genomeId}.acquisition.lock`);
  await acquireOperationLock(operationLockPath);
  const finalPaths = {
    checksumManifest: join(input.outputDirectory, names.checksumManifest),
    fasta: join(input.outputDirectory, names.fasta),
    chromSizes: join(input.outputDirectory, names.chromSizes),
    annotations: join(input.outputDirectory, names.annotations),
    package: join(input.outputDirectory, names.package),
    receipt: join(input.outputDirectory, names.receipt),
  };
  let temporaryRoot: string | undefined;
  const createdFinals = new Set<string>();
  try {
    await Promise.all(Object.values(finalPaths).map(assertPathAbsent));
    const operationRoot = await mkdtemp(join(input.outputDirectory, `.${input.genomeId}.acquire-`));
    temporaryRoot = operationRoot;
    const temporaryPaths = Object.fromEntries(
      Object.entries(finalPaths).map(([key, path]) => [key, join(operationRoot, basename(path))])
    ) as Record<keyof typeof finalPaths, string>;
    const urls = sourceUrls(input.sourceOrigin, input.genomeId);
    const checksumManifest = await downloadFile({
      url: urls.checksumManifest,
      destinationPath: temporaryPaths.checksumManifest,
      timeoutMs: input.timeoutMs,
      maxBytes: MAX_MANIFEST_BYTES,
    });
    const checksumText = await readFile(temporaryPaths.checksumManifest, 'utf8');
    const expectedFastaMd5 = requireUcscManifestMd5(checksumText, names.fasta);
    const expectedChromSizesMd5 = requireUcscManifestMd5(checksumText, names.chromSizes);

    const fasta = await downloadFile({
      url: urls.fasta,
      destinationPath: temporaryPaths.fasta,
      timeoutMs: input.timeoutMs,
      maxBytes: MAX_SOURCE_BYTES,
      expectedMd5: expectedFastaMd5,
    });
    const chromSizes = await downloadFile({
      url: urls.chromSizes,
      destinationPath: temporaryPaths.chromSizes,
      timeoutMs: input.timeoutMs,
      maxBytes: MAX_MANIFEST_BYTES,
      expectedMd5: expectedChromSizesMd5,
    });
    const annotations = await downloadFile({
      url: urls.annotations,
      destinationPath: temporaryPaths.annotations,
      timeoutMs: input.timeoutMs,
      maxBytes: MAX_SOURCE_BYTES,
    });
    const sourceSet: UcscReferenceSourceSetV1 = {
      contract: UCSC_REFERENCE_SOURCE_SET_V1,
      genomeId: input.genomeId,
      annotationTable: UCSC_CENTRAL_ANNOTATION_TABLE,
      sources: { fasta, chromSizes, annotations },
    };
    await writeCreateOnlyJson(temporaryPaths.package, sourceSet);
    const packageIdentity = await hashFile(temporaryPaths.package);
    const receipt: UcscReferencePackageAcquisitionReceiptV1 = {
      contract: UCSC_REFERENCE_PACKAGE_ACQUISITION_V1,
      genomeId: input.genomeId,
      annotationTable: UCSC_CENTRAL_ANNOTATION_TABLE,
      transport: { name: 'node-fetch', nodeVersion: process.version },
      checksumManifest,
      package: { fileName: names.package, ...packageIdentity },
      sources: sourceSet.sources,
    };
    await writeCreateOnlyJson(temporaryPaths.receipt, receipt);

    for (const key of [
      'checksumManifest',
      'fasta',
      'chromSizes',
      'annotations',
      'package',
      'receipt',
    ] as const) {
      await link(temporaryPaths[key], finalPaths[key]);
      createdFinals.add(finalPaths[key]);
    }
    return {
      packagePath: finalPaths.package,
      receiptPath: finalPaths.receipt,
      sourcePaths: {
        fasta: finalPaths.fasta,
        chromSizes: finalPaths.chromSizes,
        annotations: finalPaths.annotations,
      },
      receipt,
    };
  } catch (error) {
    await Promise.all([...createdFinals].map((path) => rm(path, { force: true })));
    throw error;
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    await rm(operationLockPath, { force: true });
  }
}

export function parseAcquireUcscReferencePackageCli(
  argv: readonly string[]
): Pick<AcquireUcscReferencePackageInput, 'genomeId' | 'outputDirectory'> {
  const values = new Map<string, string>();
  const allowed = new Set(['genome-id', 'output-directory']);
  for (const argument of argv) {
    const match = /^--([^=]+)=(.+)$/u.exec(argument);
    if (!match || !allowed.has(match[1])) {
      throw new Error(`Unknown UCSC acquisition argument: ${argument}`);
    }
    if (values.has(match[1])) {
      throw new Error(`Duplicate UCSC acquisition argument: --${match[1]}`);
    }
    values.set(match[1], match[2]);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) {
      throw new Error(
        'Usage: pnpm exec vite-node tools/devops/scripts/acquire-ucsc-reference-package.ts ' +
          '--genome-id=<exact_ucsc_genome_id> --output-directory=<directory>'
      );
    }
    return value;
  };
  const genomeId = required('genome-id');
  if (!SAFE_GENOME_ID.test(genomeId)) {
    throw new Error('UCSC acquisition genome ID is invalid.');
  }
  return { genomeId, outputDirectory: resolve(required('output-directory')) };
}

function validateInput(
  input: AcquireUcscReferencePackageInput
): Required<AcquireUcscReferencePackageInput> {
  if (!SAFE_GENOME_ID.test(input.genomeId)) {
    throw new Error('UCSC acquisition genome ID is invalid.');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('UCSC acquisition timeout must be a positive safe integer.');
  }
  const sourceOrigin = admitSourceOrigin(input.sourceOrigin ?? UCSC_REFERENCE_SOURCE_ORIGIN);
  return {
    genomeId: input.genomeId,
    outputDirectory: resolve(input.outputDirectory),
    sourceOrigin,
    timeoutMs,
  };
}

function admitSourceOrigin(raw: string): string {
  const url = new URL(raw);
  const localhostTestOrigin =
    url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '::1');
  const admittedOrigin = localhostTestOrigin || url.origin === UCSC_REFERENCE_SOURCE_ORIGIN;
  if (
    !admittedOrigin ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('UCSC acquisition source origin must be the official UCSC source origin.');
  }
  return url.origin;
}

function sourceNames(genomeId: string): Readonly<{
  checksumManifest: string;
  fasta: string;
  chromSizes: string;
  annotations: string;
  package: string;
  receipt: string;
}> {
  return {
    checksumManifest: `${genomeId}.md5sum.txt`,
    fasta: `${genomeId}.fa.gz`,
    chromSizes: `${genomeId}.chrom.sizes`,
    annotations: `${genomeId}.${UCSC_CENTRAL_ANNOTATION_TABLE}.gtf.gz`,
    package: `${genomeId}.ucsc-source-set.json`,
    receipt: `${genomeId}.ucsc-acquisition.json`,
  };
}

function sourceUrls(
  origin: string,
  genomeId: string
): Readonly<{
  checksumManifest: string;
  fasta: string;
  chromSizes: string;
  annotations: string;
}> {
  const base = `${origin}/goldenPath/${genomeId}/bigZips`;
  return {
    checksumManifest: `${base}/md5sum.txt`,
    fasta: `${base}/${genomeId}.fa.gz`,
    chromSizes: `${base}/${genomeId}.chrom.sizes`,
    annotations: `${base}/genes/${genomeId}.${UCSC_CENTRAL_ANNOTATION_TABLE}.gtf.gz`,
  };
}

async function downloadFile(input: {
  readonly url: string;
  readonly destinationPath: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly expectedMd5?: string;
}): Promise<DownloadIdentity> {
  const response = await requestHostedReferenceAsset({
    url: new URL(input.url),
    label: 'UCSC reference source',
    fetchAsset: globalThis.fetch,
    redirect: 'error',
    headers: { 'user-agent': 'dnaforge-reference-source-acquisition/1.0' },
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok || !response.body) {
    throw new Error(`UCSC acquisition failed for ${input.url}: HTTP ${response.status}.`);
  }
  const declaredLengthRaw = response.headers.get('content-length');
  const declaredLength = declaredLengthRaw === null ? null : Number(declaredLengthRaw);
  if (
    declaredLength !== null &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > input.maxBytes)
  ) {
    throw new Error(`UCSC acquisition declared an invalid byte length for ${input.url}.`);
  }
  const handle = await open(input.destinationPath, 'wx', 0o600);
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let byteLength = 0;
  const reader = response.body.getReader();
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      const bytes = Buffer.from(chunk.value);
      byteLength += bytes.byteLength;
      if (byteLength > input.maxBytes) {
        throw new Error(`UCSC acquisition exceeded the byte bound for ${input.url}.`);
      }
      sha256.update(bytes);
      md5.update(bytes);
      await handle.writeFile(bytes);
      chunk = await reader.read();
    }
    if (byteLength === 0 || (declaredLength !== null && byteLength !== declaredLength)) {
      throw new Error(`UCSC acquisition byte length does not match for ${input.url}.`);
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
  const actualMd5 = md5.digest('hex');
  if (input.expectedMd5 && actualMd5 !== input.expectedMd5) {
    await rm(input.destinationPath, { force: true });
    throw new Error(`UCSC publisher MD5 does not match ${basename(input.destinationPath)}.`);
  }
  const lastModified = response.headers.get('last-modified');
  const etag = response.headers.get('etag');
  return {
    fileName: basename(input.destinationPath),
    url: input.url,
    sha256: sha256.digest('hex'),
    md5: actualMd5,
    byteLength,
    ...(lastModified ? { lastModified } : {}),
    ...(etag ? { etag } : {}),
  };
}

export function requireUcscManifestMd5(manifest: string, fileName: string): string {
  for (const line of manifest.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{32})\s+\*?([^/\s]+)$/u.exec(line.trim());
    if (match?.[2] === fileName && MD5.test(match[1])) return match[1];
  }
  throw new Error(`UCSC checksum manifest has no exact entry for ${fileName}.`);
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
      throw new Error(`UCSC acquisition is already creating this source set: ${path}`);
    }
    throw error;
  }
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

async function hashFile(
  path: string
): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0) throw new Error(`File is empty: ${basename(path)}`);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength };
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`UCSC acquisition output already exists: ${path}`);
}
