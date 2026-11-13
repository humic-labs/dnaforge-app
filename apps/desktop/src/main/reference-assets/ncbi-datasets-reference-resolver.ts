import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, opendir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import * as yauzl from 'yauzl';
import { readStorageCapacity } from '@waypoint/platform/node-storage';

import type { ResolvedLocalReferenceSources } from './local-reference-source-types';

const KIB = 1_024;
const MIB = 1_024 * KIB;
const GIB = 1_024 * MIB;

export const NCBI_DATASETS_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 32 * GIB,
  maxEntryCount: 4_096,
  maxEntryBytes: 96 * GIB,
  maxExpandedBytes: 128 * GIB,
  maxCompressionRatio: 10_000,
  maxPathBytes: 2_048,
  maxMetadataBytes: 16 * MIB,
  diskReserveBytes: 512 * MIB,
});

const ASSEMBLY_REPORT_PATH = 'ncbi_dataset/data/assembly_data_report.jsonl';
const CATALOG_PATHS = [
  'ncbi_dataset/data/dataset_catalog.json',
  'ncbi_dataset/dataset_catalog.json',
] as const;
const MD5SUM_PATH = 'md5sum.txt';
const SAFE_ACCESSION = /^GC[AF]_[0-9]+\.[0-9]+$/;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;
const UNIX_DIRECTORY = 0x4000;
const UNIX_SYMBOLIC_LINK = 0xa000;

interface NcbiAssemblyReport {
  readonly accession?: unknown;
}

interface ScannedZip {
  readonly zipFile: yauzl.ZipFile;
  readonly entries: ReadonlyMap<string, yauzl.Entry>;
}

export async function resolveNcbiDatasetsSelection(input: {
  readonly selectedPath: string;
  readonly selectedKind: 'folder' | 'file';
  readonly stagingRoot: string;
}): Promise<ResolvedLocalReferenceSources | null> {
  if (input.selectedKind === 'folder') {
    return resolveNcbiDatasetsFolder(input.selectedPath);
  }
  if (!(await hasZipSignature(input.selectedPath))) return null;
  return extractNcbiDatasetsZip(input.selectedPath, input.stagingRoot);
}

async function resolveNcbiDatasetsFolder(
  selectedPath: string
): Promise<ResolvedLocalReferenceSources | null> {
  const packageRoot = await canonicalDirectory(selectedPath);
  const reportPath = await containedRegularFile(packageRoot, ASSEMBLY_REPORT_PATH, {
    optional: true,
  });
  if (!reportPath) return null;

  const catalogPath = await firstContainedRegularFile(packageRoot, CATALOG_PATHS);
  if (!catalogPath) {
    throw new Error('This NCBI Datasets folder is missing dataset_catalog.json.');
  }
  const md5Path = await containedRegularFile(packageRoot, MD5SUM_PATH, { optional: true });
  if (!md5Path) {
    throw new Error('This NCBI Datasets folder is missing md5sum.txt.');
  }
  parseJsonObject(await readBoundedFile(catalogPath, 'NCBI dataset catalog'));
  const md5ByPath = parseMd5Manifest(await readBoundedFile(md5Path, 'NCBI checksum manifest'));
  const accession = parseAssemblyAccession(
    await readBoundedFile(reportPath, 'NCBI assembly report')
  );
  const assemblyRoot = await canonicalContainedDirectory(
    packageRoot,
    `ncbi_dataset/data/${accession}`
  );

  const { fastaPath, gffPath } = await resolveNcbiAssemblyDirectory(assemblyRoot);
  for (const sourcePath of [fastaPath, ...(gffPath ? [gffPath] : [])]) {
    const manifestPath = relative(packageRoot, sourcePath).split('\\').join('/');
    const expectedMd5 = md5ByPath.get(manifestPath);
    if (!expectedMd5) {
      throw new Error(`NCBI checksum manifest does not cover ${manifestPath}.`);
    }
    await verifyFileMd5(sourcePath, expectedMd5, manifestPath);
  }
  return {
    kind: 'ncbi-datasets',
    sourcePaths: gffPath ? [fastaPath, gffPath] : [fastaPath],
  };
}

async function extractNcbiDatasetsZip(
  selectedPath: string,
  stagingRoot: string
): Promise<ResolvedLocalReferenceSources> {
  const archivePath = await canonicalRegularFile(selectedPath);
  const archiveMetadata = await stat(archivePath);
  if (archiveMetadata.size > NCBI_DATASETS_ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new Error('This NCBI Datasets ZIP exceeds the supported compressed size.');
  }

  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const scanned = await scanZip(archivePath);
  try {
    const reportEntry = requiredZipEntry(scanned.entries, ASSEMBLY_REPORT_PATH);
    const catalogEntry =
      CATALOG_PATHS.map((path) => scanned.entries.get(path)).find(
        (entry): entry is yauzl.Entry => entry !== undefined
      ) ?? null;
    if (!catalogEntry) {
      throw new Error('This NCBI Datasets ZIP is missing dataset_catalog.json.');
    }
    const md5Entry = requiredZipEntry(scanned.entries, MD5SUM_PATH);

    parseJsonObject(
      (
        await readZipEntry(
          scanned.zipFile,
          catalogEntry,
          NCBI_DATASETS_ARCHIVE_LIMITS.maxMetadataBytes
        )
      ).toString('utf8')
    );
    const accession = parseAssemblyAccession(
      (
        await readZipEntry(
          scanned.zipFile,
          reportEntry,
          NCBI_DATASETS_ARCHIVE_LIMITS.maxMetadataBytes
        )
      ).toString('utf8')
    );
    const assemblyPrefix = `ncbi_dataset/data/${accession}/`;
    const fastaEntries = [...scanned.entries.values()].filter(
      (entry) =>
        entry.fileName.startsWith(assemblyPrefix) &&
        /^.+_genomic\.fna(?:\.gz)?$/i.test(basename(entry.fileName))
    );
    const gffEntries = [...scanned.entries.values()].filter(
      (entry) =>
        entry.fileName.startsWith(assemblyPrefix) &&
        /^genomic\.gff(?:\.gz)?$/i.test(basename(entry.fileName))
    );
    if (fastaEntries.length !== 1 || gffEntries.length > 1) {
      throw new Error(
        `NCBI package ${accession} must contain exactly one genomic FASTA and at most one genomic GFF3; found ${fastaEntries.length} FASTA and ${gffEntries.length} GFF3 files.`
      );
    }

    const md5ByPath = parseMd5Manifest(
      (
        await readZipEntry(scanned.zipFile, md5Entry, NCBI_DATASETS_ARCHIVE_LIMITS.maxMetadataBytes)
      ).toString('utf8')
    );
    const targetEntries = [fastaEntries[0], ...(gffEntries[0] ? [gffEntries[0]] : [])];
    await assertStagingDiskSpace(
      stagingRoot,
      targetEntries.reduce((total, entry) => total + entry.uncompressedSize, 0)
    );

    const sourceRoot = resolve(stagingRoot, 'resolved-sources');
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    const extracted: string[] = [];
    for (const entry of targetEntries) {
      const expectedMd5 = md5ByPath.get(entry.fileName);
      if (!expectedMd5) {
        throw new Error(`NCBI checksum manifest does not cover ${entry.fileName}.`);
      }
      const suffix = entry.fileName.toLowerCase().endsWith('.gz') ? '.gz' : '';
      const extension = entry === fastaEntries[0] ? `.fna${suffix}` : `.gff${suffix}`;
      const destination = resolve(sourceRoot, `reference${extension}`);
      await extractZipEntry(scanned.zipFile, entry, destination, expectedMd5);
      extracted.push(destination);
    }

    return {
      kind: 'ncbi-datasets',
      sourcePaths: extracted.length === 2 ? [extracted[0], extracted[1]] : [extracted[0]],
    };
  } catch (error) {
    await rm(resolve(stagingRoot, 'resolved-sources'), { recursive: true, force: true });
    throw error;
  } finally {
    scanned.zipFile.close();
  }
}

async function scanZip(archivePath: string): Promise<ScannedZip> {
  const zipFile = await openZip(archivePath);
  if (zipFile.entryCount > NCBI_DATASETS_ARCHIVE_LIMITS.maxEntryCount) {
    zipFile.close();
    throw new Error('This NCBI Datasets ZIP contains too many entries.');
  }

  return new Promise<ScannedZip>((resolvePromise, reject) => {
    const entries = new Map<string, yauzl.Entry>();
    const foldedNames = new Set<string>();
    let expandedBytes = 0;
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
      resolvePromise({ zipFile, entries });
    });
    zipFile.on('entry', (entry: yauzl.Entry) => {
      try {
        validateZipEntry(entry);
        const folded = entry.fileName.normalize('NFC').toLocaleLowerCase('en-US');
        if (foldedNames.has(folded)) {
          throw new Error(`NCBI Datasets ZIP contains a duplicate path: ${entry.fileName}`);
        }
        foldedNames.add(folded);
        expandedBytes += entry.uncompressedSize;
        if (
          !Number.isSafeInteger(expandedBytes) ||
          expandedBytes > NCBI_DATASETS_ARCHIVE_LIMITS.maxExpandedBytes
        ) {
          throw new Error('This NCBI Datasets ZIP expands beyond the supported size.');
        }
        entries.set(entry.fileName, entry);
        zipFile.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zipFile.readEntry();
  });
}

function validateZipEntry(entry: yauzl.Entry): void {
  const name = entry.fileName;
  if (
    name.length === 0 ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    Buffer.byteLength(name) > NCBI_DATASETS_ARCHIVE_LIMITS.maxPathBytes
  ) {
    throw new Error(`NCBI Datasets ZIP contains an unsafe path: ${name}`);
  }
  const pathWithoutDirectorySlash = name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = pathWithoutDirectorySlash.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`NCBI Datasets ZIP contains an unsafe path: ${name}`);
  }
  if (entry.isEncrypted()) {
    throw new Error(`Encrypted ZIP entries are not supported: ${name}`);
  }
  if (
    !Number.isSafeInteger(entry.compressedSize) ||
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.compressedSize < 0 ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > NCBI_DATASETS_ARCHIVE_LIMITS.maxEntryBytes
  ) {
    throw new Error(`NCBI Datasets ZIP entry has an invalid size: ${name}`);
  }
  if (
    entry.uncompressedSize > 0 &&
    (entry.compressedSize === 0 ||
      entry.uncompressedSize / entry.compressedSize >
        NCBI_DATASETS_ARCHIVE_LIMITS.maxCompressionRatio)
  ) {
    throw new Error(`NCBI Datasets ZIP entry has an unsafe compression ratio: ${name}`);
  }
  const unixMode = entry.externalFileAttributes >>> 16;
  const unixType = unixMode & UNIX_FILE_TYPE_MASK;
  if (unixType === UNIX_SYMBOLIC_LINK) {
    throw new Error(`NCBI Datasets ZIP contains a symbolic link: ${name}`);
  }
  if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
    throw new Error(`NCBI Datasets ZIP contains a special file: ${name}`);
  }
  if (/\.zip$/i.test(name)) {
    throw new Error(`Nested archives are not supported inside NCBI Datasets ZIP files: ${name}`);
  }
}

async function resolveNcbiAssemblyDirectory(assemblyRoot: string): Promise<{
  readonly fastaPath: string;
  readonly gffPath?: string;
}> {
  const directory = await opendir(assemblyRoot);
  const fastaPaths: string[] = [];
  const gffPaths: string[] = [];
  let entryCount = 0;
  for await (const entry of directory) {
    entryCount += 1;
    if (entryCount > NCBI_DATASETS_ARCHIVE_LIMITS.maxEntryCount) {
      throw new Error('This NCBI assembly folder contains too many files.');
    }
    const isFasta = /^.+_genomic\.fna(?:\.gz)?$/i.test(entry.name);
    const isGff = /^genomic\.gff(?:\.gz)?$/i.test(entry.name);
    if (!isFasta && !isGff) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`NCBI reference source must be a regular file: ${entry.name}`);
    }
    const path = await realpath(resolve(assemblyRoot, entry.name));
    if (isFasta) fastaPaths.push(path);
    else gffPaths.push(path);
  }
  if (fastaPaths.length !== 1 || gffPaths.length > 1) {
    throw new Error(
      `This NCBI assembly must contain exactly one genomic FASTA and at most one genomic GFF3; found ${fastaPaths.length} FASTA and ${gffPaths.length} GFF3 files.`
    );
  }
  return { fastaPath: fastaPaths[0], gffPath: gffPaths[0] };
}

async function readZipEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxBytes: number
): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) {
    throw new Error(`NCBI metadata file is too large: ${entry.fileName}`);
  }
  const stream = await openZipEntryStream(zipFile, entry);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error(`NCBI metadata file is too large: ${entry.fileName}`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function extractZipEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  destination: string,
  expectedMd5: string
): Promise<void> {
  const source = await openZipEntryStream(zipFile, entry);
  const md5 = createHash('md5');
  let writtenBytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      writtenBytes += chunk.length;
      md5.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, verifier, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (writtenBytes !== entry.uncompressedSize) {
      throw new Error(`ZIP entry size changed while extracting ${entry.fileName}.`);
    }
    if (md5.digest('hex') !== expectedMd5) {
      throw new Error(`NCBI checksum validation failed for ${entry.fileName}.`);
    }
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(
      path,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zipFile) => {
        if (error) reject(error);
        else resolvePromise(zipFile);
      }
    );
  });
}

function openZipEntryStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry
): Promise<NodeJS.ReadableStream & { destroy(error?: Error): void }> {
  return new Promise((resolvePromise, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolvePromise(stream);
    });
  });
}

function requiredZipEntry(entries: ReadonlyMap<string, yauzl.Entry>, path: string): yauzl.Entry {
  const entry = entries.get(path);
  if (!entry) {
    throw new Error(
      `This NCBI Datasets ZIP is missing ${path}. Found: ${[...entries.keys()]
        .slice(0, 8)
        .join(', ')}`
    );
  }
  return entry;
}

function parseAssemblyAccession(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `NCBI package must describe exactly one reference assembly; found ${lines.length}.`
    );
  }
  const report = parseJsonObject(lines[0]) as NcbiAssemblyReport;
  if (typeof report.accession !== 'string' || !SAFE_ACCESSION.test(report.accession)) {
    throw new Error('NCBI assembly report has an invalid or missing assembly accession.');
  }
  return report.accession;
}

function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('NCBI package metadata contains invalid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('NCBI package metadata must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function parseMd5Manifest(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    const match = /^([A-Fa-f0-9]{32})\s+\*?(.+)$/.exec(line);
    if (!match) throw new Error(`NCBI checksum manifest is invalid on line ${index + 1}.`);
    const path = match[2].replace(/^\.\//, '');
    if (checksums.has(path)) {
      throw new Error(`NCBI checksum manifest contains a duplicate path: ${path}`);
    }
    checksums.set(path, match[1].toLowerCase());
  }
  return checksums;
}

async function verifyFileMd5(
  path: string,
  expectedMd5: string,
  manifestPath: string
): Promise<void> {
  const md5 = createHash('md5');
  for await (const chunk of createReadStream(path)) md5.update(chunk);
  if (md5.digest('hex') !== expectedMd5) {
    throw new Error(`NCBI checksum validation failed for ${manifestPath}.`);
  }
}

async function readBoundedFile(path: string, label: string): Promise<string> {
  const metadata = await stat(path);
  if (metadata.size > NCBI_DATASETS_ARCHIVE_LIMITS.maxMetadataBytes) {
    throw new Error(`${label} is too large.`);
  }
  return readFile(path, 'utf8');
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new Error('The selected NCBI package is not a folder.');
  return canonical;
}

async function canonicalRegularFile(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error('The selected NCBI package is not a regular file.');
  return canonical;
}

async function canonicalContainedDirectory(root: string, relativePath: string): Promise<string> {
  const candidate = resolve(root, relativePath);
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`NCBI package directory is invalid: ${relativePath}`);
  }
  const canonical = await realpath(candidate);
  assertContained(root, canonical);
  return canonical;
}

async function containedRegularFile(
  root: string,
  relativePath: string,
  options?: { readonly optional?: boolean }
): Promise<string | null> {
  const candidate = resolve(root, relativePath);
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (options?.optional && isMissingFileError(error)) return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`NCBI package file is invalid: ${relativePath}`);
  }
  const canonical = await realpath(candidate);
  assertContained(root, canonical);
  return canonical;
}

async function firstContainedRegularFile(
  root: string,
  candidates: readonly string[]
): Promise<string | null> {
  for (const candidate of candidates) {
    const path = await containedRegularFile(root, candidate, { optional: true });
    if (path) return path;
  }
  return null;
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith('..') &&
      !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  ) {
    return;
  }
  throw new Error('NCBI package path escapes the selected folder.');
}

async function hasZipSignature(path: string): Promise<boolean> {
  const source = createReadStream(path, { start: 0, end: 3 });
  const chunks: Buffer[] = [];
  for await (const chunk of source)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const signature = Buffer.concat(chunks);
  return (
    signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    signature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    signature.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))
  );
}

async function assertStagingDiskSpace(stagingRoot: string, requiredBytes: number): Promise<void> {
  const capacity = await readStorageCapacity(stagingRoot, { purpose: 'important' });
  if (capacity.availableBytes < requiredBytes + NCBI_DATASETS_ARCHIVE_LIMITS.diskReserveBytes) {
    throw new Error(
      `There is not enough available storage to prepare this reference package (${capacity.source}).`
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
