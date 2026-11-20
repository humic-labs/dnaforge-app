import { withUserMessage } from '@waypoint/user-messages';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  decodeSequenceDocument,
  indexGenBankRecords,
  PARSER_DISPATCH_LIMITS,
  serializeGenBank,
} from '@waypoint/sequence-utils';
import type {
  MaterializeQuickLookPackageRequest,
  QuickLookPackageReceipt,
  QuickLookRecordReceipt,
} from '../../shared/file-association-ipc';
import {
  QUICK_LOOK_PACKAGE_STORE_DIRECTORY,
  type FileAssociationFamilyId,
} from '../../shared/file-associations';
import { formatFileSize } from '../../shared/oversized-guard';
import { fromPackageRelative, parseSequencePackageDocument } from '../../db/sequence-package';
import {
  addSequencePackageMember,
  loadSequencePackageDocument,
  type SequencePackageIoFs,
} from '../../db/sequence-package-io';
import { SEQUENCE_PACKAGE_FORMAT_VERSION } from '../../db/sequence-package-contract';
import {
  DEFAULT_MAX_CONVERTIBLE_BYTES,
  materializeImportedSequencePackages,
} from '../workspace-git/sequence-package-import';
import { BoundedFileReadLimitError, readFileBoundedFromHandle } from '../ipc/bounded-file-read';
import { writeWorkspaceTextFileAtomicInMain } from '../primer-artifact-files';

const QUICK_LOOK_GENERATION_MANIFEST = 'quick-look.json';
const QUICK_LOOK_PACKAGE_MIGRATION_JOURNAL = '.sequence-package-migration.json';
const GENBANK_EXTENSIONS = new Set(['.gb', '.gbk', '.gbff', '.genbank']);
const SNAPGENE_EXTENSIONS = new Set(['.dna']);
export const QUICK_LOOK_STORE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const QUICK_LOOK_MAX_GENBANK_RECORDS = 1000;

export const QUICK_LOOK_MAX_SOURCE_BYTES = {
  genbank: PARSER_DISPATCH_LIMITS.genbankIndexedBytes - 1,
  snapgene: DEFAULT_MAX_CONVERTIBLE_BYTES,
} satisfies Readonly<Record<FileAssociationFamilyId, number>>;

export interface QuickLookPackageStore {
  materialize(request: MaterializeQuickLookPackageRequest): Promise<QuickLookPackageReceipt>;
  preparePackage(packageRoot: string): Promise<boolean>;
  recoverReceipt(receipt: QuickLookPackageReceipt): Promise<QuickLookPackageReceipt>;
  originalPath(receipt: QuickLookPackageReceipt): Promise<string>;
  promote(
    request: { readonly receipt: QuickLookPackageReceipt; readonly targetRoot: string },
    importer: QuickLookPackageImporter
  ): Promise<QuickLookPackagePromotionWriteResult>;
}

export interface QuickLookPackageStoreOptions {
  readonly maxStoreBytes?: number;
}

interface GenerationIdentity {
  contentHash: string;
  generationKey: string;
  sourceFileName: string;
}

export interface VerifiedQuickLookPackageFile {
  readonly relativePath: string;
  readonly sha256: string;
}

export interface VerifiedQuickLookPackageSnapshot {
  readonly recordId: string;
  readonly packageRoot: string;
  readonly productRelativePath: string;
  readonly files: readonly VerifiedQuickLookPackageFile[];
}

export interface VerifiedQuickLookGenerationSnapshot {
  readonly sourceFileName: string;
  readonly records: readonly VerifiedQuickLookPackageSnapshot[];
}

export type QuickLookPackageImporter = (
  snapshot: VerifiedQuickLookGenerationSnapshot,
  targetRoot: string
) => Promise<QuickLookPackagePromotionWriteResult>;

export interface QuickLookPackagePromotionWriteResult {
  readonly destPath: string;
  readonly relPath: string;
  readonly committed: boolean;
  readonly records: readonly {
    readonly recordId: string;
    readonly destPath: string;
    readonly relPath: string;
  }[];
}

interface QuickLookGenerationRecord {
  readonly recordId: string;
  readonly ordinal: number;
  readonly displayName: string;
  readonly sequenceLength: number;
  readonly circular: boolean;
  readonly packageRelativePath: string;
  readonly productRelativePath: string;
  readonly originalMemberPath: string | null;
  readonly files: readonly VerifiedQuickLookPackageFile[];
}

interface QuickLookGenerationManifest {
  readonly version: 3;
  readonly sourceContentHash: string;
  readonly sourceFileName: string;
  readonly records: readonly [QuickLookGenerationRecord, ...QuickLookGenerationRecord[]];
}

const inflightBySource = new Map<string, Promise<QuickLookPackageReceipt>>();
let materializationTail: Promise<void> = Promise.resolve();

const nodePackageIo: SequencePackageIoFs = {
  exists: async (path) =>
    fs
      .access(path)
      .then(() => true)
      .catch(() => false),
  readTextFile: (path) => fs.readFile(path, 'utf8'),
  writeTextFile: (path, content) => fs.writeFile(path, content, 'utf8'),
  writeWorkspaceTextFileAtomic: (input) => writeWorkspaceTextFileAtomicInMain(input),
  mkdir: (path, options) => fs.mkdir(path, options).then(() => undefined),
  move: async (sourcePath, destinationDir) => {
    const destPath = join(destinationDir, basename(sourcePath));
    await fs.rename(sourcePath, destPath);
    return { destPath };
  },
  readFile: (path) => fs.readFile(path),
  writeFile: (path, contents) => fs.writeFile(path, contents),
  unlink: (path) => fs.unlink(path),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
};

function extensionsForFamily(familyId: FileAssociationFamilyId): ReadonlySet<string> {
  return familyId === 'genbank' ? GENBANK_EXTENSIONS : SNAPGENE_EXTENSIONS;
}

function validateRequest(request: MaterializeQuickLookPackageRequest): void {
  if (!isAbsolute(request.sourcePath)) {
    throw new Error('Quick Look requires an absolute source path.');
  }
  const extension = extname(request.sourcePath).toLowerCase();
  if (!extensionsForFamily(request.familyId).has(extension)) {
    throw new Error(`The source file does not match the ${request.familyId} file family.`);
  }
}

function safeProductStem(sourceFileName: string): string {
  const extension = extname(sourceFileName);
  const stem = sourceFileName.slice(0, sourceFileName.length - extension.length).trim();
  return stem.length > 0 ? stem : 'sequence';
}

function oversizedSourceError(
  sourcePath: string,
  familyId: FileAssociationFamilyId,
  sizeBytes: number
): Error {
  const limitBytes = QUICK_LOOK_MAX_SOURCE_BYTES[familyId];
  return withUserMessage(
    new Error(
      `“${basename(sourcePath)}” is too large for Quick Look (${formatFileSize(sizeBytes)}). ` +
        `The ${familyId === 'genbank' ? 'GenBank' : 'SnapGene'} limit is ${formatFileSize(limitBytes)}.`
    ),
    'document.quickLookTooLarge'
  );
}

function generationIdentity(
  request: MaterializeQuickLookPackageRequest,
  sourceBytes: Uint8Array
): GenerationIdentity {
  const sourceFileName = basename(request.sourcePath);
  const contentHash = createHash('sha256').update(sourceBytes).digest('hex');
  const generationKey = generationKeyFor(request.familyId, request.sourcePath, contentHash);
  return { contentHash, generationKey, sourceFileName };
}

function generationKeyFor(
  familyId: FileAssociationFamilyId,
  sourcePath: string,
  contentHash: string,
  legacy = false
): string {
  return createHash('sha256')
    .update(legacy ? '' : 'dnaforge.external-sequence.v1\0')
    .update(familyId)
    .update('\0')
    .update(sourcePath)
    .update('\0')
    .update(contentHash)
    .digest('hex');
}

function receiptForManifest(
  storeRoot: string,
  request: MaterializeQuickLookPackageRequest,
  identity: GenerationIdentity,
  manifest: QuickLookGenerationManifest
): QuickLookPackageReceipt {
  const generationRoot = join(storeRoot, identity.generationKey);
  const mappedRecords: QuickLookRecordReceipt[] = manifest.records.map((record) => ({
    recordId: record.recordId,
    ordinal: record.ordinal,
    displayName: record.displayName,
    sequenceLength: record.sequenceLength,
    circular: record.circular,
    productPath: join(generationRoot, record.packageRelativePath, record.productRelativePath),
  }));
  const first = manifest.records[0];
  const firstReceipt = mappedRecords[0];
  if (!firstReceipt) {
    throw new Error('Quick Look generation contains no sequence records.');
  }
  const records: QuickLookPackageReceipt['records'] = [firstReceipt, ...mappedRecords.slice(1)];
  const packageRoot = join(generationRoot, first.packageRelativePath);
  return {
    sourcePath: request.sourcePath,
    productPath: firstReceipt.productPath,
    packageRoot,
    contentHash: identity.contentHash,
    familyId: request.familyId,
    sourceFileName: identity.sourceFileName,
    records,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function parseGenerationManifest(value: unknown): QuickLookGenerationManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 3 ||
    typeof record.sourceContentHash !== 'string' ||
    typeof record.sourceFileName !== 'string' ||
    !Array.isArray(record.records) ||
    record.records.length === 0
  ) {
    return null;
  }
  const records: QuickLookGenerationManifest['records'][number][] = [];
  const seenRecordIds = new Set<string>();
  for (const value of record.records) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.recordId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.recordId) ||
      seenRecordIds.has(candidate.recordId) ||
      typeof candidate.ordinal !== 'number' ||
      !Number.isSafeInteger(candidate.ordinal) ||
      candidate.ordinal !== records.length ||
      typeof candidate.displayName !== 'string' ||
      typeof candidate.sequenceLength !== 'number' ||
      !Number.isSafeInteger(candidate.sequenceLength) ||
      candidate.sequenceLength <= 0 ||
      typeof candidate.circular !== 'boolean' ||
      typeof candidate.packageRelativePath !== 'string' ||
      typeof candidate.productRelativePath !== 'string' ||
      (candidate.originalMemberPath !== null && typeof candidate.originalMemberPath !== 'string') ||
      !Array.isArray(candidate.files)
    ) {
      return null;
    }
    const files: VerifiedQuickLookPackageFile[] = [];
    const seenFiles = new Set<string>();
    for (const fileValue of candidate.files) {
      if (!fileValue || typeof fileValue !== 'object' || Array.isArray(fileValue)) return null;
      const file = fileValue as Record<string, unknown>;
      if (
        typeof file.relativePath !== 'string' ||
        typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        seenFiles.has(file.relativePath)
      ) {
        return null;
      }
      seenFiles.add(file.relativePath);
      files.push({ relativePath: file.relativePath, sha256: file.sha256 });
    }
    seenRecordIds.add(candidate.recordId);
    records.push({
      recordId: candidate.recordId,
      ordinal: candidate.ordinal,
      displayName: candidate.displayName,
      sequenceLength: candidate.sequenceLength,
      circular: candidate.circular,
      packageRelativePath: candidate.packageRelativePath,
      productRelativePath: candidate.productRelativePath,
      originalMemberPath: candidate.originalMemberPath,
      files,
    });
  }
  const firstRecord = records[0];
  if (!firstRecord) return null;
  return {
    version: 3,
    sourceContentHash: record.sourceContentHash,
    sourceFileName: record.sourceFileName,
    records: [firstRecord, ...records.slice(1)],
  };
}

async function collectPackageFiles(
  packageRoot: string,
  relativeDir = ''
): Promise<VerifiedQuickLookPackageFile[]> {
  const directory = relativeDir ? fromPackageRelative(relativeDir, packageRoot) : packageRoot;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: VerifiedQuickLookPackageFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolutePath = fromPackageRelative(relativePath, packageRoot);
    const metadata = await fs.lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Quick Look package member is a symbolic link: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectPackageFiles(packageRoot, relativePath)));
    } else if (metadata.isFile()) {
      files.push({ relativePath, sha256: await sha256File(absolutePath) });
    } else {
      throw new Error(`Quick Look package member is not a regular file: ${relativePath}`);
    }
  }
  return files;
}

function equalFileManifests(
  left: readonly VerifiedQuickLookPackageFile[],
  right: readonly VerifiedQuickLookPackageFile[]
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Map(left.map((file) => [file.relativePath, file.sha256]));
  return right.every((file) => expected.get(file.relativePath) === file.sha256);
}

function equalFileManifestsExceptPackageMetadata(
  left: readonly VerifiedQuickLookPackageFile[],
  right: readonly VerifiedQuickLookPackageFile[]
): boolean {
  const withoutMarker = (files: readonly VerifiedQuickLookPackageFile[]) =>
    files.filter((file) => file.relativePath !== '.forge/plasmid.json');
  return equalFileManifests(withoutMarker(left), withoutMarker(right));
}

function onDiskPackageFormatVersion(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).formatVersion;
    return typeof value === 'number' && Number.isInteger(value) ? value : 1;
  } catch {
    return null;
  }
}

function assertSupportedSequencePackageFormat(raw: string): void {
  parseSequencePackageDocument(raw);
}

function pathWithin(root: string, candidate: string): string | null {
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    return null;
  }
  if (isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function preparePublishedPackage(
  storeRoot: string,
  requestedPackageRoot: string
): Promise<boolean> {
  const lexicalPackageRoot = resolve(requestedPackageRoot);
  const lexicalRelative = pathWithin(storeRoot, lexicalPackageRoot);
  if (!lexicalRelative) return false;

  let canonicalStoreRoot: string;
  let packageRoot: string;
  try {
    [canonicalStoreRoot, packageRoot] = await Promise.all([
      fs.realpath(storeRoot),
      fs.realpath(lexicalPackageRoot),
    ]);
  } catch {
    return false;
  }
  const packageRelativeToStore = pathWithin(canonicalStoreRoot, packageRoot);
  if (!packageRelativeToStore) return false;
  const segments = packageRelativeToStore.split('/');
  const [generationKey, recordsSegment, ordinalSegment, packageSegment] = segments;
  if (
    segments.length !== 4 ||
    !generationKey ||
    !/^[a-f0-9]{64}$/u.test(generationKey) ||
    recordsSegment !== 'records' ||
    !/^\d{6}$/u.test(ordinalSegment ?? '') ||
    packageSegment !== 'package'
  ) {
    return false;
  }

  const generationRoot = join(canonicalStoreRoot, generationKey);
  const manifestPath = join(generationRoot, QUICK_LOOK_GENERATION_MANIFEST);
  const journalPath = join(generationRoot, QUICK_LOOK_PACKAGE_MIGRATION_JOURNAL);
  const manifest = parseGenerationManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  if (!manifest) throw new Error('Quick Look generation manifest is invalid.');
  const requestedRecordPath = `records/${ordinalSegment}/package`;
  if (!manifest.records.some((record) => record.packageRelativePath === requestedRecordPath)) {
    throw new Error('Quick Look package is not declared by its generation manifest.');
  }

  const journalExists = await fs
    .access(journalPath)
    .then(() => true)
    .catch(() => false);
  const prepared = [] as Array<{
    record: QuickLookGenerationManifest['records'][number];
    packageRoot: string;
    formatVersion: number;
  }>;
  for (const record of manifest.records) {
    const recordPackageRoot = fromPackageRelative(record.packageRelativePath, generationRoot);
    const markerPath = join(recordPackageRoot, '.forge', 'plasmid.json');
    const rawMarker = await fs.readFile(markerPath, 'utf8');
    const formatVersion = onDiskPackageFormatVersion(rawMarker);
    if (formatVersion === null) throw new Error('Quick Look package metadata is invalid.');
    assertSupportedSequencePackageFormat(rawMarker);
    const beforeFiles = await collectPackageFiles(recordPackageRoot);
    const exact = equalFileManifests(record.files, beforeFiles);
    const resumable =
      journalExists && equalFileManifestsExceptPackageMetadata(record.files, beforeFiles);
    if (!exact && !resumable) {
      throw new Error('Quick Look package changed outside its main-owned migration.');
    }
    prepared.push({ record, packageRoot: recordPackageRoot, formatVersion });
  }

  const needsMigration = prepared.some(
    (entry) => entry.formatVersion < SEQUENCE_PACKAGE_FORMAT_VERSION
  );
  if (!needsMigration && !journalExists) return true;
  if (!journalExists) {
    await atomicWriteText(
      journalPath,
      `${JSON.stringify({ schema: 'waypoint.quick-look-package-migration.v1', generationKey })}\n`
    );
  }

  const records = [] as QuickLookGenerationManifest['records'][number][];
  for (const entry of prepared) {
    const document = await loadSequencePackageDocument(entry.packageRoot, nodePackageIo);
    if (document.product.file !== entry.record.productRelativePath) {
      throw new Error('Quick Look package migration changed its product binding.');
    }
    const files = await collectPackageFiles(entry.packageRoot);
    if (!equalFileManifestsExceptPackageMetadata(entry.record.files, files)) {
      throw new Error('Quick Look package migration changed non-metadata bytes.');
    }
    records.push({ ...entry.record, files });
  }
  const firstRecord = records[0];
  if (!firstRecord) throw new Error('Quick Look generation contains no sequence records.');
  await atomicWriteText(
    manifestPath,
    JSON.stringify({ ...manifest, records: [firstRecord, ...records.slice(1)] })
  );
  await fs.rm(journalPath, { force: true });
  return true;
}

export function quickLookPackageId(receipt: QuickLookPackageReceipt): string {
  const current = generationKeyFor(receipt.familyId, receipt.sourcePath, receipt.contentHash);
  const legacy = generationKeyFor(receipt.familyId, receipt.sourcePath, receipt.contentHash, true);
  const actual = basename(dirname(dirname(dirname(receipt.packageRoot))));
  if (actual !== current && actual !== legacy)
    throw new Error('The sequence preview identity does not match.');
  return actual;
}

function identityForReceipt(receipt: QuickLookPackageReceipt): GenerationIdentity | null {
  if (
    !isAbsolute(receipt.sourcePath) ||
    !/^[a-f0-9]{64}$/u.test(receipt.contentHash) ||
    basename(receipt.sourcePath) !== receipt.sourceFileName ||
    !extensionsForFamily(receipt.familyId).has(extname(receipt.sourcePath).toLowerCase())
  ) {
    return null;
  }
  return {
    contentHash: receipt.contentHash,
    generationKey: quickLookPackageId(receipt),
    sourceFileName: receipt.sourceFileName,
  };
}

async function verifiedPublishedSnapshot(
  storeRoot: string,
  receipt: QuickLookPackageReceipt
): Promise<VerifiedQuickLookGenerationSnapshot | null> {
  try {
    const identity = identityForReceipt(receipt);
    if (!identity) return null;
    const generationRoot = join(storeRoot, identity.generationKey);
    const manifestText = await fs.readFile(
      join(generationRoot, QUICK_LOOK_GENERATION_MANIFEST),
      'utf8'
    );
    const manifest = parseGenerationManifest(JSON.parse(manifestText));
    if (
      !manifest ||
      manifest.sourceContentHash !== receipt.contentHash ||
      manifest.sourceFileName !== receipt.sourceFileName
    ) {
      return null;
    }
    const expectedReceipt = receiptForManifest(storeRoot, receipt, identity, manifest);
    if (JSON.stringify(expectedReceipt) !== JSON.stringify(receipt)) return null;

    const records: VerifiedQuickLookPackageSnapshot[] = [];
    for (const record of manifest.records) {
      const packageRoot = fromPackageRelative(record.packageRelativePath, generationRoot);
      const productPath = fromPackageRelative(record.productRelativePath, packageRoot);
      const [product, marker] = await Promise.all([
        fs.stat(productPath),
        fs.stat(join(packageRoot, '.forge', 'plasmid.json')),
      ]);
      if (!product.isFile() || !marker.isFile()) return null;
      const packageDocument = parseSequencePackageDocument(
        await fs.readFile(join(packageRoot, '.forge', 'plasmid.json'), 'utf8')
      );
      if (packageDocument.product.file !== record.productRelativePath) return null;
      const currentFiles = await collectPackageFiles(packageRoot);
      if (!equalFileManifests(record.files, currentFiles)) return null;
      if (!record.files.some((file) => file.relativePath === '.forge/plasmid.json')) return null;
      const productFile = record.files.find(
        (file) => file.relativePath === record.productRelativePath
      );
      if (!productFile) return null;
      if (record.originalMemberPath) {
        const originalFile = record.files.find(
          (file) => file.relativePath === record.originalMemberPath
        );
        const originalMember = packageDocument.members.find(
          (member) => member.path === record.originalMemberPath
        );
        if (
          !originalFile ||
          originalFile.sha256 !== manifest.sourceContentHash ||
          !originalMember ||
          originalMember.replaceable
        ) {
          return null;
        }
      } else if (
        manifest.records.length === 1 &&
        productFile.sha256 !== manifest.sourceContentHash
      ) {
        if (receipt.familyId === 'genbank') return null;
      }
      records.push({
        recordId: record.recordId,
        packageRoot,
        productRelativePath: record.productRelativePath,
        files: record.files,
      });
    }
    return { sourceFileName: receipt.sourceFileName, records };
  } catch {
    return null;
  }
}

async function verifiedReceiptForIdentity(
  storeRoot: string,
  request: MaterializeQuickLookPackageRequest,
  identity: GenerationIdentity
): Promise<QuickLookPackageReceipt | null> {
  try {
    const generationRoot = join(storeRoot, identity.generationKey);
    const manifest = parseGenerationManifest(
      JSON.parse(await fs.readFile(join(generationRoot, QUICK_LOOK_GENERATION_MANIFEST), 'utf8'))
    );
    if (
      !manifest ||
      manifest.sourceContentHash !== identity.contentHash ||
      manifest.sourceFileName !== identity.sourceFileName
    ) {
      return null;
    }
    const receipt = receiptForManifest(storeRoot, request, identity, manifest);
    return (await verifiedPublishedSnapshot(storeRoot, receipt)) ? receipt : null;
  } catch {
    return null;
  }
}

function enqueueMaterialization<T>(operation: () => Promise<T>): Promise<T> {
  const result = materializationTail.then(operation, operation);
  materializationTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function removeStaleStagingDirectories(storeRoot: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(storeRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(storeRoot, entry.name);
    if (entry.name.startsWith('.staging-')) {
      await fs.rm(entryPath, { recursive: true, force: true });
      continue;
    }
    const quarantined = /^\.invalid-([a-f0-9]{64})-/u.exec(entry.name);
    if (!quarantined) {
      if (entry.name.startsWith('.invalid-')) {
        await fs.rm(entryPath, { recursive: true, force: true });
      }
      continue;
    }
    const generationRoot = join(storeRoot, quarantined[1]);
    try {
      await fs.rename(entryPath, generationRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await fs.rm(entryPath, { recursive: true, force: true });
    }
  }
}

async function directoryBytes(path: string, skipStaging = false): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    if (skipStaging && entry.name.startsWith('.staging-')) continue;
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else if (entry.isFile()) total += (await fs.stat(entryPath)).size;
  }
  return total;
}

function safeRecordStem(name: string, ordinal: number): string {
  const safeName = name
    .trim()
    .replace(/[/\\:*?"<>|]+/gu, '-')
    .replace(/^[.\s]+|[.\s]+$/gu, '')
    .slice(0, 120);
  return `${String(ordinal + 1).padStart(4, '0')}-${safeName || `record-${ordinal + 1}`}`;
}

function recordIdFor(identity: GenerationIdentity, ordinal: number, bytes: Uint8Array): string {
  return createHash('sha256')
    .update(identity.generationKey)
    .update('\0')
    .update(String(ordinal))
    .update('\0')
    .update(bytes)
    .digest('hex');
}

interface PreparedQuickLookRecord {
  readonly recordId: string;
  readonly ordinal: number;
  readonly displayName: string;
  readonly sequenceLength: number;
  readonly circular: boolean;
  readonly productFileName: string;
  readonly bytes: Uint8Array;
}

function prepareQuickLookRecords(
  request: MaterializeQuickLookPackageRequest,
  sourceBytes: Uint8Array,
  identity: GenerationIdentity
): PreparedQuickLookRecord[] {
  if (request.familyId === 'genbank') {
    const extension = extname(identity.sourceFileName) || '.gb';
    const indexed = indexGenBankRecords(sourceBytes, {
      maxRecords: QUICK_LOOK_MAX_GENBANK_RECORDS,
      verifyNucleotideLocus: true,
    });
    const preserveWholeSource = indexed.length === 1;
    return indexed.map((record) => {
      const bytes = preserveWholeSource
        ? sourceBytes
        : sourceBytes.slice(record.startByte, record.endByteExclusive);
      return {
        recordId: recordIdFor(identity, record.ordinal, bytes),
        ordinal: record.ordinal,
        displayName: record.name,
        sequenceLength: record.length,
        circular: record.circular,
        productFileName: preserveWholeSource
          ? identity.sourceFileName
          : `${safeRecordStem(record.name, record.ordinal)}${extension}`,
        bytes,
      };
    });
  }

  const document = decodeSequenceDocument(sourceBytes, {
    format: 'snapgene',
    filename: identity.sourceFileName,
    path: request.sourcePath,
    contentHash: identity.contentHash,
  });
  if (document.format !== 'snapgene' || !document.capabilities.canExportGenBank) {
    throw new Error('DNAForge could not convert this SnapGene file to GenBank.');
  }
  const bytes = new TextEncoder().encode(serializeGenBank(document.sequence));
  return [
    {
      recordId: recordIdFor(identity, 0, bytes),
      ordinal: 0,
      displayName: document.sequence.name,
      sequenceLength: document.sequence.length,
      circular: document.sequence.circular ?? false,
      productFileName: `${safeProductStem(identity.sourceFileName)}.gb`,
      bytes,
    },
  ];
}

async function buildGeneration(
  storeRoot: string,
  request: MaterializeQuickLookPackageRequest,
  sourceBytes: Uint8Array,
  identity: GenerationIdentity,
  maxStoreBytes: number
): Promise<QuickLookPackageReceipt> {
  const publishedReceipt = await verifiedReceiptForIdentity(storeRoot, request, identity);
  if (publishedReceipt) {
    if (request.familyId === 'genbank')
      indexGenBankRecords(sourceBytes, {
        maxRecords: QUICK_LOOK_MAX_GENBANK_RECORDS,
        verifyNucleotideLocus: true,
      });
    return publishedReceipt;
  }

  await fs.mkdir(storeRoot, { recursive: true });
  const publishedBytes = await directoryBytes(storeRoot, true);
  if (publishedBytes > maxStoreBytes) {
    throw new Error(
      `Quick Look storage is full (${formatFileSize(publishedBytes)} of ${formatFileSize(maxStoreBytes)} used). ` +
        'DNAForge kept every existing read-only package and did not copy this file.'
    );
  }
  const stagingRoot = await fs.mkdtemp(join(storeRoot, '.staging-'));
  const inputRoot = join(stagingRoot, 'input');
  try {
    await fs.mkdir(inputRoot);
    const preparedRecords = prepareQuickLookRecords(request, sourceBytes, identity);
    const preserveOriginal = request.familyId === 'snapgene' || preparedRecords.length > 1;
    const originalRoot = join(stagingRoot, 'original');
    const stagedOriginalPath = join(originalRoot, identity.sourceFileName);
    if (preserveOriginal) {
      await fs.mkdir(originalRoot);
      await fs.writeFile(stagedOriginalPath, sourceBytes);
    }
    let stagedBytes = 0;

    const manifestRecords: QuickLookGenerationManifest['records'][number][] = [];
    for (const prepared of preparedRecords) {
      const stagedSourcePath = join(inputRoot, prepared.productFileName);
      await fs.writeFile(stagedSourcePath, prepared.bytes);
      const materialized = await materializeImportedSequencePackages(stagedSourcePath);
      if (!materialized.converted || materialized.packages.length !== 1) {
        throw new Error(
          materialized.skippedReason ??
            `DNAForge could not create a package for record ${prepared.ordinal + 1}.`
        );
      }
      const materializedPackage = materialized.packages[0];
      let originalMemberPath: string | null = null;
      if (preserveOriginal && prepared.ordinal === 0) {
        await addSequencePackageMember({
          packageRoot: materializedPackage.packageRoot,
          role: 'user',
          sourcePath: stagedOriginalPath,
          replaceable: false,
          fs: nodePackageIo,
        });
        originalMemberPath = join('contents', identity.sourceFileName).replace(/\\/gu, '/');
      }

      const packageRelativePath = `records/${String(prepared.ordinal + 1).padStart(6, '0')}/package`;
      const stagedPackageRoot = fromPackageRelative(packageRelativePath, stagingRoot);
      await fs.mkdir(dirname(stagedPackageRoot), { recursive: true });
      await fs.rename(materializedPackage.packageRoot, stagedPackageRoot);
      stagedBytes += await directoryBytes(stagedPackageRoot);
      if (publishedBytes + stagedBytes > maxStoreBytes) {
        throw new Error(
          `Quick Look storage is full (${formatFileSize(publishedBytes)} of ${formatFileSize(maxStoreBytes)} used). ` +
            'DNAForge kept every existing read-only package and did not copy this file.'
        );
      }
      const packageDocument = parseSequencePackageDocument(
        await fs.readFile(join(stagedPackageRoot, '.forge', 'plasmid.json'), 'utf8')
      );
      if (packageDocument.product.file !== prepared.productFileName) {
        throw new Error(
          `Quick Look package ${prepared.ordinal + 1} does not identify the expected product.`
        );
      }
      manifestRecords.push({
        recordId: prepared.recordId,
        ordinal: prepared.ordinal,
        displayName: prepared.displayName,
        sequenceLength: prepared.sequenceLength,
        circular: prepared.circular,
        packageRelativePath,
        productRelativePath: prepared.productFileName,
        originalMemberPath,
        files: await collectPackageFiles(stagedPackageRoot),
      });
    }
    await fs.rm(inputRoot, { recursive: true, force: true });
    await fs.rm(originalRoot, { recursive: true, force: true });
    const firstManifestRecord = manifestRecords[0];
    if (!firstManifestRecord) {
      throw new Error('Quick Look generation contains no sequence records.');
    }
    const generationManifest: QuickLookGenerationManifest = {
      version: 3,
      sourceContentHash: identity.contentHash,
      sourceFileName: identity.sourceFileName,
      records: [firstManifestRecord, ...manifestRecords.slice(1)],
    };
    await fs.writeFile(
      join(stagingRoot, QUICK_LOOK_GENERATION_MANIFEST),
      JSON.stringify(generationManifest),
      'utf8'
    );

    const exactStagedBytes = await directoryBytes(stagingRoot);
    if (publishedBytes + exactStagedBytes > maxStoreBytes) {
      throw new Error(
        `Quick Look storage is full (${formatFileSize(publishedBytes)} of ${formatFileSize(maxStoreBytes)} used). ` +
          'DNAForge kept every existing read-only package and did not copy this file.'
      );
    }

    const generationRoot = join(storeRoot, identity.generationKey);
    try {
      await fs.rename(stagingRoot, generationRoot);
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'EEXIST' && errorCode !== 'ENOTEMPTY') throw error;
      const concurrentReceipt = await verifiedReceiptForIdentity(storeRoot, request, identity);
      if (concurrentReceipt) return concurrentReceipt;
      const invalidRoot = join(storeRoot, `.invalid-${identity.generationKey}-${randomUUID()}`);
      await fs.rename(generationRoot, invalidRoot);
      try {
        await fs.rename(stagingRoot, generationRoot);
      } catch (replacementError) {
        try {
          await fs.rename(invalidRoot, generationRoot);
        } catch (restoreError) {
          throw new AggregateError(
            [replacementError, restoreError],
            `Quick Look replacement failed and the prior generation remains at "${invalidRoot}".`
          );
        }
        throw replacementError;
      }
      await fs.rm(invalidRoot, { recursive: true, force: true });
    }

    const receipt = receiptForManifest(storeRoot, request, identity, generationManifest);
    if (!(await verifiedPublishedSnapshot(storeRoot, receipt))) {
      throw new Error('DNAForge could not publish the Quick Look sequence package.');
    }
    return receipt;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifiedOriginalPath(
  storeRoot: string,
  receipt: QuickLookPackageReceipt
): Promise<string> {
  if (!(await verifiedPublishedSnapshot(storeRoot, receipt)))
    throw new Error('The saved sequence preview is incomplete or changed.');
  const original =
    receipt.familyId === 'snapgene' || receipt.records.length > 1
      ? join(receipt.packageRoot, 'contents', receipt.sourceFileName)
      : receipt.productPath;
  if ((await sha256File(original)) !== receipt.contentHash)
    throw new Error('The original sequence package member has changed.');
  return original;
}

export function createQuickLookPackageStore(
  userDataRoot: string,
  options: QuickLookPackageStoreOptions = {}
): QuickLookPackageStore {
  const storeRoot = resolve(userDataRoot, QUICK_LOOK_PACKAGE_STORE_DIRECTORY);
  const maxStoreBytes = options.maxStoreBytes ?? QUICK_LOOK_STORE_MAX_BYTES;
  if (!Number.isSafeInteger(maxStoreBytes) || maxStoreBytes <= 0) {
    throw new Error('Quick Look store limit must be a positive safe integer.');
  }
  return {
    async materialize(request) {
      validateRequest(request);
      const sourcePath = await fs.realpath(resolve(request.sourcePath));
      const canonicalRequest = { ...request, sourcePath };
      const inflightKey = `${storeRoot}\0${request.familyId}\0${sourcePath}`;
      const existing = inflightBySource.get(inflightKey);
      if (existing) return existing;

      const promise = enqueueMaterialization(async () => {
        await removeStaleStagingDirectories(storeRoot);
        const maxSourceBytes = QUICK_LOOK_MAX_SOURCE_BYTES[request.familyId];
        let sourceBytes: Uint8Array;
        try {
          sourceBytes = await readFileBoundedFromHandle(sourcePath, maxSourceBytes);
        } catch (error) {
          if (error instanceof BoundedFileReadLimitError) {
            throw oversizedSourceError(sourcePath, request.familyId, error.sizeBytes);
          }
          throw error;
        }

        const identity = generationIdentity(canonicalRequest, sourceBytes);
        return buildGeneration(storeRoot, canonicalRequest, sourceBytes, identity, maxStoreBytes);
      }).finally(() => inflightBySource.delete(inflightKey));
      inflightBySource.set(inflightKey, promise);
      return promise;
    },
    async originalPath(receipt) {
      return enqueueMaterialization(() => verifiedOriginalPath(storeRoot, receipt));
    },
    async recoverReceipt(receipt) {
      return enqueueMaterialization(async () => {
        const original = await verifiedOriginalPath(storeRoot, receipt);
        const currentId = generationKeyFor(
          receipt.familyId,
          receipt.sourcePath,
          receipt.contentHash
        );
        if (quickLookPackageId(receipt) === currentId) return receipt;
        const bytes = await readFileBoundedFromHandle(
          original,
          QUICK_LOOK_MAX_SOURCE_BYTES[receipt.familyId]
        );
        const identity = generationIdentity(receipt, bytes);
        if (identity.contentHash !== receipt.contentHash)
          throw new Error('The saved preview source changed.');
        return buildGeneration(storeRoot, receipt, bytes, identity, maxStoreBytes);
      });
    },
    async preparePackage(packageRoot) {
      return enqueueMaterialization(() => preparePublishedPackage(storeRoot, packageRoot));
    },
    async promote(request, importer) {
      if (!isAbsolute(request.targetRoot)) {
        throw new Error('Quick Look promotion requires an absolute destination path.');
      }
      return enqueueMaterialization(async () => {
        await removeStaleStagingDirectories(storeRoot);
        const snapshot = await verifiedPublishedSnapshot(storeRoot, request.receipt);
        if (!snapshot) {
          throw new Error(
            'The Quick Look snapshot changed or is incomplete. Reopen the original file before importing.'
          );
        }
        return importer(snapshot, request.targetRoot);
      });
    },
  };
}
