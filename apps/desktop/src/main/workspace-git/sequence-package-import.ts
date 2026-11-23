import { constants as fsConstants, createReadStream, existsSync, promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import {
  type NucleicAcid,
  decodeGenBankLocusName,
  GENBANK_LOCUS_ENCODING_COMMENT,
  parseSequenceFile,
} from '@waypoint/sequence-utils';
import {
  sequenceFileTypeForPath,
  MANAGED_DNA_FILE_EXTENSIONS,
} from '@waypoint/sequence-utils/sequence-file-types';
import { createDefaultSequenceEntityMetadata } from '../../shared/sequence-entity-schema';
import {
  SEQUENCE_PRODUCT_EXTENSIONS,
  buildSequencePackageDocument,
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackageMetaPaths,
  sequencePackagePaths,
  sequenceManagedMemberPath,
  sequencePrimerArtifactLookupPaths,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { writeAlignmentHistoryMember } from '../../db/sequence-package-io';
import { PAIRED_SIDECAR_SUFFIXES } from '../../db/workspace-content-manifest';
import {
  assertPhysicalPackageMember,
  assertPhysicalWriteDestination,
} from './package-member-boundary';
import type {
  SequenceImportPreviewPackage,
  SequenceImportPreviewResult,
} from '../../shared/workspace-git-types';
import { BoundedFileReadLimitError, readFileBoundedFromHandle } from '../ipc/bounded-file-read';
import { claimRegularFileNoClobber, publishFileContentNoClobber } from './exclusive-file-claim';
import { prepareSequenceRecovery } from '../../db/sequence-fasta-recovery';
import {
  assertMigrationPathsAvailable,
  migrationPathsIntersect,
  type MigrationPathOptions,
} from './migration-paths';
import { writeWorkspaceTextFileAtomicInMain } from '../primer-artifact-files';
import {
  allocatePackageSources,
  declaredRecords,
  describeAutomaticSplitRefusal,
  describeLossyConversion,
  extractFastaHeaders,
  fastaRecordGenBank,
  MAX_PACKAGE_NAME_COLLISIONS,
  normalizeFastaContent,
  prepareConvertedSequenceSources,
  splitGenBankPackageSources,
  type PreparedFastaPackageSources,
  type RecordPackageSource,
} from '../../db/sequence-package-conversion';

const GENBANK_EXTENSIONS = SEQUENCE_PRODUCT_EXTENSIONS;

export interface ImportedSequencePackage {
  packageRoot: string;
  productPath: string;
}

export interface PackageImportFileOps {
  writeMeta(path: string, content: string): Promise<void>;
  rename?(oldPath: string, newPath: string): Promise<void>;
  link?(existingPath: string, newPath: string): Promise<void>;
  unlink?(path: string): Promise<void>;
}

const DEFAULT_FILE_OPS: PackageImportFileOps = { writeMeta: writeFileExclusive };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MaterializeImportedSequenceResult {
  packages: ImportedSequencePackage[];
  converted: boolean;
  untouchedPath?: string;
  skippedReason?: string;
  sourceOnly?: true;
}

export function isConstructSequenceFile(fileName: string): boolean {
  const extension = extname(fileName).slice(1).toLowerCase();
  return MANAGED_DNA_FILE_EXTENSIONS.includes(extension);
}

function isAlreadyGenBank(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return GENBANK_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function genBankRecordLayout(filePath: string): Promise<'none' | 'single' | 'multiple'> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let records = 0;
  try {
    for await (const rawLine of lines) {
      const line = records === 0 ? rawLine.replace(/^\uFEFF/, '') : rawLine;
      if (!line.startsWith('LOCUS')) continue;
      records += 1;
      if (records > 1) return 'multiple';
    }
    return records === 0 ? 'none' : 'single';
  } finally {
    lines.close();
    stream.destroy();
  }
}

type MaterializeRecordPackagesResult =
  | { kind: 'created'; packages: ImportedSequencePackage[] }
  | { kind: 'changed' };

async function materializeRecordPackages(
  importedFilePath: string,
  expectedContent: string | Uint8Array,
  sources: readonly RecordPackageSource[],
  ops: PackageImportFileOps,
  expectedSourceSha256?: string,
  destinationDirectory = dirname(importedFilePath),
  packageCollisionPolicy: SequencePackageCollisionPolicy = 'keep-both',
  recordLocus = false,
  packageId?: string,
  migration: MaterializeOptions = {}
): Promise<MaterializeRecordPackagesResult> {
  const allocation = allocatePackageSources(sources);
  if (allocation.kind === 'blocked') throw new Error(allocation.reason);

  const parentDir = dirname(importedFilePath);
  const fileName = basename(importedFilePath);
  const extension = extname(fileName);
  const sourceStem = fileName.slice(0, fileName.length - extension.length);
  const renameFile = ops.rename ?? fs.rename;
  const recoveryRoot = await fs.mkdtemp(join(parentDir, `.${sourceStem}.conversion-source-`));
  activeConversionSourceRoots.add(recoveryRoot);
  try {
    const heldSourcePath = join(recoveryRoot, fileName);
    try {
      await renameFile(importedFilePath, heldSourcePath);
    } catch (error) {
      await fs.rmdir(recoveryRoot).catch(() => {});
      throw error;
    }

    let claimedBytes: Buffer;
    try {
      claimedBytes = await fs.readFile(heldSourcePath);
      assertExpectedSourceBytes(claimedBytes, expectedSourceSha256);
    } catch (error) {
      try {
        await restoreHeldSourceNoClobber(heldSourcePath, importedFilePath);
        await fs.rmdir(recoveryRoot);
      } catch (restoreError) {
        throw sourceRecoveryError(importedFilePath, heldSourcePath, error, restoreError);
      }
      throw error;
    }
    const expectedBytes =
      typeof expectedContent === 'string'
        ? Buffer.from(expectedContent, 'utf8')
        : Buffer.from(expectedContent);
    if (!claimedBytes.equals(expectedBytes)) {
      try {
        await restoreHeldSourceNoClobber(heldSourcePath, importedFilePath);
        await fs.rmdir(recoveryRoot);
      } catch (restoreError) {
        throw sourceRecoveryError(
          importedFilePath,
          heldSourcePath,
          new Error('The source file changed before conversion could claim it.'),
          restoreError
        );
      }
      return { kind: 'changed' };
    }

    const created: Array<{
      package: ImportedSequencePackage;
      ownership: CreatedPackageOwnership;
    }> = [];
    try {
      for (const source of allocation.sources) {
        let ownership: CreatedPackageOwnership = {};
        const createdPackage = await createPackage(
          destinationDirectory,
          source.stem,
          source.fileName,
          async (destination) => writeFileExclusive(destination, source.content),
          undefined,
          undefined,
          ops,
          packageCollisionPolicy,
          (createdOwnership) => {
            ownership = createdOwnership;
          },
          recordLocus,
          source.original,
          allocation.sources.length === 1 ? packageId : undefined,
          migration,
          sha256Bytes(Buffer.from(source.content, 'utf8')),
          allocation.sources.length
        );
        created.push({ package: createdPackage, ownership });
      }
    } catch (error) {
      let packageRollbackComplete = true;
      for (const item of created) {
        packageRollbackComplete =
          (await removeCreatedPackageMembers(item.package, item.ownership)) &&
          packageRollbackComplete;
      }
      try {
        await restoreHeldSourceNoClobber(heldSourcePath, importedFilePath);
        await fs.rmdir(recoveryRoot);
      } catch (restoreError) {
        throw sourceRecoveryError(importedFilePath, heldSourcePath, error, restoreError);
      }
      if (!packageRollbackComplete) {
        throw new AggregateError(
          [error],
          'Package conversion failed and at least one created package retained recovery data.'
        );
      }
      throw error;
    }

    await removeRecoveryRootsBestEffort([recoveryRoot]);
    if (created.length === 1) {
      await relocatePairedSidecars({
        sourceDir: parentDir,
        fileName,
        destDir: created[0].package.packageRoot,
      });
    }
    return { kind: 'created', packages: created.map((item) => item.package) };
  } finally {
    activeConversionSourceRoots.delete(recoveryRoot);
  }
}

export const DEFAULT_MAX_CONVERTIBLE_BYTES = 64 * 1024 * 1024;

export type SequencePackageCollisionPolicy = 'keep-both' | 'exact';

export class SequencePackageTargetExistsError extends Error {
  readonly code = 'SEQUENCE_PACKAGE_TARGET_EXISTS';

  constructor(readonly packageRoot: string) {
    super(`A sequence package already exists at "${packageRoot}".`);
    this.name = 'SequencePackageTargetExistsError';
  }
}

export interface ExpectedSequencePackageState {
  rootIdentity: { dev: number; ino: number };
  markerFile: string;
  markerIdentity: { dev: number; ino: number };
  markerSha256: string;
  productIdentity: { dev: number; ino: number };
  productSha256: string;
  generatedMembers: Array<{
    file: string;
    identity: { dev: number; ino: number } | null;
    sha256: string | null;
  }>;
  id: string;
  productFile: string;
}

export class SequencePackageTargetChangedError extends Error {
  readonly code = 'SEQUENCE_PACKAGE_TARGET_CHANGED';

  constructor(readonly packageRoot: string) {
    super(`The sequence package changed before replacement at "${packageRoot}".`);
    this.name = 'SequencePackageTargetChangedError';
  }
}

export interface MaterializeOptions extends MigrationPathOptions {
  prepareAutomaticMigration?: (sourceSha256: string) => Promise<{
    expectedSourceSha256: string;
    onPackagePlanned: NonNullable<MaterializeOptions['onPackagePlanned']>;
  }>;
  onPackagePlanned?: (plan: {
    packageRoot: string;
    packageId: string;
    productFile: string;
    productSha256: string;
    packageCount: number;
  }) => Promise<void>;
  maxConvertibleBytes?: number;
  expectedSourceSha256?: string;
  confirmedDnaSourceSha256?: string;
  confirmedNucleicAcid?: NucleicAcid;
  overwritePackageRoot?: string;
  expectedOverwritePackage?: ExpectedSequencePackageState;
  logicalFileName?: string;
  destinationDirectory?: string;
  packageCollisionPolicy?: SequencePackageCollisionPolicy;
  automatic?: boolean;
  packageId?: string;
  rerunPackageId?: string;
  updateExistingPackage?: (input: { packageRoot: string; productContent: string }) => Promise<void>;
}

async function rerunPackageRoot(
  importedFilePath: string,
  parentDir: string,
  stem: string,
  productFile: string,
  options: MaterializeOptions
): Promise<string | null> {
  if (!options.updateExistingPackage || options.packageCollisionPolicy === 'exact') return null;
  if ((await fs.lstat(importedFilePath)).isSymbolicLink()) return null;
  const packageRoot = join(parentDir, stem);
  const metaPath = sequencePackageMetaPaths(packageRoot).find((path) => existsSync(path));
  if (!metaPath) return null;
  assertMigrationPathsAvailable([packageRoot], options);
  try {
    const document = parseSequencePackageDocument(await fs.readFile(metaPath, 'utf8'));
    if (
      options.protectedEntityIds?.has(document.id) ||
      (options.rerunPackageId && document.id !== options.rerunPackageId) ||
      (options.packageId && document.id !== options.packageId)
    )
      return null;
    return document.product.file === productFile ? packageRoot : null;
  } catch {
    return null;
  }
}

async function updateRerunPackage(
  importedFilePath: string,
  expectedBytes: Uint8Array,
  packageRoot: string,
  productContent: string,
  options: MaterializeOptions
): Promise<MaterializeImportedSequenceResult> {
  assertMigrationPathsAvailable([packageRoot], options);
  if (options.withCleanPaths) {
    return options.withCleanPaths([packageRoot], () =>
      updateRerunPackage(importedFilePath, expectedBytes, packageRoot, productContent, {
        ...options,
        withCleanPaths: undefined,
      })
    );
  }
  const fileName = basename(importedFilePath);
  const stem = fileName.slice(0, fileName.length - extname(fileName).length);
  if (options.onPackagePlanned) {
    const document = parseSequencePackageDocument(
      await fs.readFile(sequencePackagePaths(packageRoot).metaPath, 'utf8')
    );
    await options.onPackagePlanned({
      packageRoot,
      packageId: document.id,
      productFile: document.product.file,
      productSha256: sha256Bytes(Buffer.from(productContent)),
      packageCount: 1,
    });
  }
  const recoveryRoot = await fs.mkdtemp(
    join(dirname(importedFilePath), `.${stem}.conversion-source-`)
  );
  activeConversionSourceRoots.add(recoveryRoot);
  try {
    const heldSourcePath = join(recoveryRoot, fileName);
    try {
      // workspace-entity-move: holds the arrival for the plasmid version; failure restores it.
      await fs.rename(importedFilePath, heldSourcePath);
    } catch (error) {
      await fs.rmdir(recoveryRoot).catch(() => {});
      throw error;
    }
    let changed = false;
    try {
      changed = !(await fs.readFile(heldSourcePath)).equals(Buffer.from(expectedBytes));
      if (!changed) await options.updateExistingPackage?.({ packageRoot, productContent });
    } catch (error) {
      try {
        await restoreHeldSourceNoClobber(heldSourcePath, importedFilePath);
        await fs.rmdir(recoveryRoot);
      } catch (restoreError) {
        throw sourceRecoveryError(importedFilePath, heldSourcePath, error, restoreError);
      }
      throw error;
    }
    if (changed) {
      try {
        await restoreHeldSourceNoClobber(heldSourcePath, importedFilePath);
        await fs.rmdir(recoveryRoot);
      } catch (restoreError) {
        throw sourceRecoveryError(
          importedFilePath,
          heldSourcePath,
          new Error('The source file changed before conversion could claim it.'),
          restoreError
        );
      }
      return {
        packages: [],
        converted: false,
        untouchedPath: importedFilePath,
        skippedReason: `"${fileName}" changed while conversion was starting. It was left as-is.`,
      };
    }
    await removeRecoveryRootsBestEffort([recoveryRoot]);
    const document = parseSequencePackageDocument(
      await fs.readFile(sequencePackagePaths(packageRoot).metaPath, 'utf8')
    );
    return {
      packages: [
        {
          packageRoot,
          productPath: sequencePackagePaths(packageRoot, { productFile: document.product.file })
            .productPath,
        },
      ],
      converted: true,
    };
  } finally {
    activeConversionSourceRoots.delete(recoveryRoot);
  }
}

function prepareConvertedPackageSources(
  bytes: Uint8Array,
  fileName: string,
  stem: string,
  confirmedDnaSourceSha256?: string,
  confirmedNucleicAcid: NucleicAcid = 'dna'
): PreparedFastaPackageSources {
  assertExpectedSourceBytes(bytes, confirmedDnaSourceSha256);
  return prepareConvertedSequenceSources(
    bytes,
    fileName,
    stem,
    confirmedDnaSourceSha256 ? confirmedNucleicAcid : undefined
  );
}

function previewPackagesForSources(
  sources: readonly RecordPackageSource[]
): SequenceImportPreviewPackage[] | null {
  const allocated = allocatePackageSources(sources);
  if (allocated.kind === 'blocked') return null;
  return allocated.sources.map((source, recordIndex) => ({
    name: source.stem,
    recordIndex,
    recordCount: allocated.sources.length,
  }));
}

async function inspectGenBankSource(
  sourcePath: string,
  options: { followClaimedSymlink?: boolean } = {}
): Promise<{
  sourceSha256: string;
  recordCount: number;
  completeRecords: boolean;
  size: number;
  locusName: string | null;
}> {
  const flags = options.followClaimedSymlink
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(sourcePath, flags);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error('DNA sequence preview requires a regular file.');

    const hash = createHash('sha256');
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let carry = '';
    let recordCount = 0;
    let awaitingTerminator = false;
    let interruptedRecord = false;
    let bytesRead = 0;
    let firstLine = true;
    let locusName: string | null = null;
    let locusEncoded = false;
    const countLine = (rawLine: string): void => {
      const line = firstLine ? rawLine.replace(/^\uFEFF/, '') : rawLine;
      firstLine = false;
      if (line === GENBANK_LOCUS_ENCODING_COMMENT) locusEncoded = true;
      if (line.trim() === '//') {
        awaitingTerminator = false;
        return;
      }
      if (!/^LOCUS\b/u.test(line)) return;
      if (awaitingTerminator) interruptedRecord = true;
      awaitingTerminator = true;
      recordCount += 1;
      if (locusName !== null) return;
      const match = line.match(/^LOCUS\s+(.+?)\s+\d+\s+bp\b/i);
      const token = match?.[1]?.trim();
      if (token) locusName = token;
    };

    for (;;) {
      const read = await handle.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      bytesRead += read.bytesRead;
      const lines = `${carry}${decoder.write(chunk)}`.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) countLine(line.replace(/\r$/, ''));
    }
    carry += decoder.end();
    if (carry.length > 0) countLine(carry.replace(/\r$/, ''));

    const finishedStat = await handle.stat();
    if (
      bytesRead !== openedStat.size ||
      finishedStat.size !== openedStat.size ||
      finishedStat.mtimeMs !== openedStat.mtimeMs ||
      finishedStat.ctimeMs !== openedStat.ctimeMs
    ) {
      throw new Error('The DNA sequence source changed while it was being previewed.');
    }
    return {
      sourceSha256: hash.digest('hex'),
      recordCount,
      completeRecords: !awaitingTerminator && !interruptedRecord,
      size: bytesRead,
      locusName: locusName && locusEncoded ? decodeGenBankLocusName(locusName) : locusName,
    };
  } finally {
    await handle.close();
  }
}

export async function inspectSequenceFileSha256(sourcePath: string): Promise<string> {
  const inspection = await inspectGenBankSource(sourcePath, { followClaimedSymlink: true });
  return inspection.sourceSha256;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class SequenceImportSourceChangedError extends Error {
  constructor() {
    super(
      'The selected DNA sequence changed after preview. Review the updated package list before importing.'
    );
    this.name = 'SequenceImportSourceChangedError';
  }
}

function assertExpectedSourceBytes(
  bytes: Uint8Array,
  expectedSourceSha256: string | undefined
): void {
  if (!expectedSourceSha256) return;
  if (!/^[0-9a-f]{64}$/.test(expectedSourceSha256)) {
    throw new Error('The sequence import preview carried an invalid source digest.');
  }
  if (sha256Bytes(bytes) !== expectedSourceSha256) {
    throw new SequenceImportSourceChangedError();
  }
}

export async function previewImportedSequencePackages(
  sourcePath: string,
  options: Pick<
    MaterializeOptions,
    'maxConvertibleBytes' | 'confirmedDnaSourceSha256' | 'confirmedNucleicAcid' | 'automatic'
  > = {}
): Promise<SequenceImportPreviewResult> {
  const fileName = basename(sourcePath);
  const extension = extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  if (!isConstructSequenceFile(fileName)) {
    return {
      kind: 'blocked',
      sourcePath,
      reason: 'This selection is not a supported DNA sequence source.',
      reasonCode: 'unsupported_format',
    };
  }

  const maxBytes = options.maxConvertibleBytes ?? DEFAULT_MAX_CONVERTIBLE_BYTES;
  if (isAlreadyGenBank(fileName)) {
    const inspection = await inspectGenBankSource(sourcePath);
    if (inspection.recordCount === 0) {
      return {
        kind: 'blocked',
        sourcePath,
        reason: `"${fileName}" contains no GenBank records. It was left as-is.`,
        reasonCode: 'parse_failure',
      };
    }
    if (!inspection.completeRecords) {
      return {
        kind: 'blocked',
        sourcePath,
        reason: `"${fileName}" has a GenBank record without a closing // line.`,
        reasonCode: 'parse_failure',
      };
    }
    if (inspection.recordCount <= 1) {
      return {
        kind: 'ready',
        sourcePath,
        sourceSha256: inspection.sourceSha256,
        packages: [{ name: stem, recordIndex: 0, recordCount: 1 }],
      };
    }
    if (inspection.size > maxBytes) {
      return {
        kind: 'blocked',
        sourcePath,
        reason: `This source contains multiple GenBank records and is too large to split safely (${Math.round(inspection.size / 1_000_000)} MB).`,
        reasonCode: 'source_too_large',
      };
    }
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = await readFileBoundedFromHandle(sourcePath, maxBytes);
    } catch (error) {
      return {
        kind: 'blocked',
        sourcePath,
        reason:
          error instanceof Error
            ? error.message
            : 'This source could not be read safely for multi-record preview.',
        reasonCode:
          error instanceof BoundedFileReadLimitError ? 'source_too_large' : 'read_failure',
      };
    }
    const content = Buffer.from(sourceBytes).toString('utf8');
    const sourceSha256 = sha256Bytes(sourceBytes);
    const split = splitGenBankPackageSources(content, stem);
    if (split.kind === 'invalid') {
      return { kind: 'blocked', sourcePath, reason: split.reason, reasonCode: 'parse_failure' };
    }
    if (split.kind === 'single') {
      return {
        kind: 'ready',
        sourcePath,
        sourceSha256,
        packages: [{ name: stem, recordIndex: 0, recordCount: 1 }],
      };
    }
    const automaticRefusal = options.automatic
      ? describeAutomaticSplitRefusal(fileName, split.records)
      : null;
    if (automaticRefusal)
      return {
        kind: 'blocked',
        sourcePath,
        reason: automaticRefusal,
        reasonCode: 'automatic_split_required',
        sourceSha256,
      };
    const packages = previewPackagesForSources(split.records);
    if (!packages) {
      return {
        kind: 'blocked',
        sourcePath,
        reason:
          `More than ${MAX_PACKAGE_NAME_COLLISIONS + 1} records resolve to the same package name. ` +
          'Rename the duplicate records before importing.',
        reasonCode: 'record_name_conflict',
      };
    }
    return {
      kind: 'ready',
      sourcePath,
      sourceSha256,
      packages,
    };
  }

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = await readFileBoundedFromHandle(sourcePath, maxBytes);
  } catch (error) {
    return {
      kind: 'blocked',
      sourcePath,
      reason:
        error instanceof Error
          ? error.message
          : 'This source could not be read safely for DNA sequence preview.',
      reasonCode: error instanceof BoundedFileReadLimitError ? 'source_too_large' : 'read_failure',
    };
  }
  const prepared = prepareConvertedPackageSources(
    sourceBytes,
    fileName,
    stem,
    options.confirmedDnaSourceSha256,
    options.confirmedNucleicAcid
  );
  if (prepared.kind === 'blocked') {
    return {
      kind: 'blocked',
      sourcePath,
      reason: prepared.reason,
      reasonCode: prepared.reasonCode,
      sourceSha256: sha256Bytes(sourceBytes),
      ...(prepared.canConfirmDnaIdentity ? { canConfirmDnaIdentity: true } : {}),
      ...(prepared.canConvertToRna ? { canConvertToRna: true } : {}),
    };
  }
  const automaticRefusal = options.automatic
    ? describeAutomaticSplitRefusal(fileName, prepared.sources)
    : null;
  if (automaticRefusal)
    return {
      kind: 'blocked',
      sourcePath,
      reason: automaticRefusal,
      reasonCode: 'automatic_split_required',
      sourceSha256: sha256Bytes(sourceBytes),
    };
  const packages = previewPackagesForSources(prepared.sources);
  if (!packages) {
    return {
      kind: 'blocked',
      sourcePath,
      reason:
        `More than ${MAX_PACKAGE_NAME_COLLISIONS + 1} records resolve to the same package name. ` +
        'Rename the duplicate records before importing.',
      reasonCode: 'record_name_conflict',
    };
  }
  return {
    kind: 'ready',
    sourcePath,
    sourceSha256: sha256Bytes(sourceBytes),
    packages,
  };
}

export async function materializeImportedSequencePackages(
  importedFilePath: string,
  ops: PackageImportFileOps = DEFAULT_FILE_OPS,
  options: MaterializeOptions = {}
): Promise<MaterializeImportedSequenceResult> {
  const sourcePaths = [
    importedFilePath,
    ...PAIRED_SIDECAR_SUFFIXES.map((suffix) => importedFilePath + suffix),
  ];
  assertMigrationPathsAvailable(sourcePaths, options);
  if (options.packageId && options.protectedEntityIds?.has(options.packageId))
    throw new Error(
      'The sequence identity already belongs to an accepted entity. Its source was preserved.'
    );
  const materialize = async (): Promise<MaterializeImportedSequenceResult> => {
    if (options.prepareAutomaticMigration) {
      const preview = await previewImportedSequencePackages(importedFilePath, {
        ...options,
        automatic: true,
      });
      if (preview.kind === 'blocked') {
        if (preview.reasonCode === 'read_failure') throw new Error(preview.reason);
        return {
          packages: [],
          converted: false,
          untouchedPath: importedFilePath,
          skippedReason: preview.reason,
          sourceOnly: true,
        };
      }
      options = { ...options, ...(await options.prepareAutomaticMigration(preview.sourceSha256)) };
    }
    return materializeImportedSequencePackagesUnlocked(importedFilePath, ops, options);
  };
  return options.withCleanPaths ? options.withCleanPaths(sourcePaths, materialize) : materialize();
}

async function materializeImportedSequencePackagesUnlocked(
  importedFilePath: string,
  ops: PackageImportFileOps,
  options: MaterializeOptions
): Promise<MaterializeImportedSequenceResult> {
  const physicalFileName = basename(importedFilePath);
  const fileName = options.logicalFileName ?? physicalFileName;
  if (basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
    throw new Error('SEQUENCE_IMPORT_LOGICAL_NAME: logicalFileName must be a bare file name.');
  }
  if (!isConstructSequenceFile(fileName)) {
    return { packages: [], converted: false, untouchedPath: importedFilePath };
  }

  if (options.overwritePackageRoot) {
    return overwriteImportedSequencePackage(
      importedFilePath,
      options.overwritePackageRoot,
      ops,
      options
    );
  }

  const sourceParentDir = dirname(importedFilePath);
  const parentDir = options.destinationDirectory ?? sourceParentDir;
  if (!isAbsolute(parentDir)) {
    throw new Error('SEQUENCE_IMPORT_DESTINATION: destinationDirectory must be absolute.');
  }
  const enclosingProduct = await enclosingPackageProduct(sourceParentDir);
  if (enclosingProduct !== null) {
    if (enclosingProduct === fileName) {
      return {
        packages: [{ packageRoot: sourceParentDir, productPath: importedFilePath }],
        converted: false,
        untouchedPath: importedFilePath,
      };
    }
    return {
      packages: [],
      converted: false,
      untouchedPath: importedFilePath,
      skippedReason:
        `"${fileName}" sits inside the plasmid package "${basename(parentDir)}" but is not the ` +
        `product it describes ("${enclosingProduct}"). It was left as-is.`,
    };
  }

  const extension = extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);

  if (isAlreadyGenBank(fileName)) {
    const recordLayout = await genBankRecordLayout(importedFilePath);
    if (recordLayout === 'none') {
      return {
        packages: [],
        converted: false,
        untouchedPath: importedFilePath,
        skippedReason: `"${fileName}" contains no GenBank records. It was left as-is.`,
        sourceOnly: true,
      };
    }
    if (recordLayout === 'multiple') {
      const maxBytes = options.maxConvertibleBytes ?? DEFAULT_MAX_CONVERTIBLE_BYTES;
      const { size } = await fs.stat(importedFilePath);
      if (size > maxBytes) {
        return {
          packages: [],
          converted: false,
          untouchedPath: importedFilePath,
          skippedReason:
            `"${fileName}" contains multiple GenBank records and is too large to split safely ` +
            `(${Math.round(size / 1_000_000)} MB). It was imported as-is.`,
          sourceOnly: true,
        };
      }
      const sourceContent = await fs.readFile(importedFilePath, 'utf8');
      const split = splitGenBankPackageSources(sourceContent, stem);
      if (split.kind === 'invalid' || split.kind === 'single') {
        return {
          packages: [],
          converted: false,
          untouchedPath: importedFilePath,
          skippedReason:
            split.kind === 'invalid'
              ? `${split.reason} "${fileName}" was imported as-is.`
              : `"${fileName}" changed while record boundaries were being read. It was imported as-is.`,
        };
      }
      const automaticRefusal = options.automatic
        ? describeAutomaticSplitRefusal(fileName, split.records)
        : null;
      if (automaticRefusal) {
        return {
          packages: [],
          converted: false,
          untouchedPath: importedFilePath,
          skippedReason: automaticRefusal,
          sourceOnly: true,
        };
      }
      const materialized = await materializeRecordPackages(
        importedFilePath,
        sourceContent,
        split.records,
        ops,
        options.expectedSourceSha256,
        parentDir,
        options.packageCollisionPolicy,
        true,
        options.packageId,
        options
      );
      if (materialized.kind === 'changed') {
        return {
          packages: [],
          converted: false,
          untouchedPath: importedFilePath,
          skippedReason: `"${fileName}" changed while splitting was starting. It was left as-is.`,
        };
      }
      return { packages: materialized.packages, converted: true };
    }

    const rerunRoot = await rerunPackageRoot(importedFilePath, parentDir, stem, fileName, options);
    if (rerunRoot) {
      const bytes = await fs.readFile(importedFilePath);
      assertExpectedSourceBytes(bytes, options.expectedSourceSha256);
      return updateRerunPackage(
        importedFilePath,
        bytes,
        rerunRoot,
        bytes.toString('utf8'),
        options
      );
    }

    let claimedSymlinkTarget: string | null = null;
    let productClaimed = false;
    const renameFile = ops.rename ?? fs.rename;
    const created = await createPackage(
      parentDir,
      stem,
      fileName,
      async (destination) => {
        if (options.packageCollisionPolicy === 'exact') {
          await moveFileNoClobber(importedFilePath, destination, ops);
        } else {
          await renameFile(importedFilePath, destination);
        }
        productClaimed = true;
        if (options.expectedSourceSha256) {
          assertExpectedSourceBytes(await fs.readFile(destination), options.expectedSourceSha256);
        }
        const claimed = await fs.lstat(destination);
        if (!claimed.isSymbolicLink()) return;

        claimedSymlinkTarget = await fs.readlink(destination);
        const rewrittenTarget = isAbsolute(claimedSymlinkTarget)
          ? claimedSymlinkTarget
          : relative(
              dirname(destination),
              resolve(dirname(importedFilePath), claimedSymlinkTarget)
            );
        const rewritten = `${destination}.rewritten-${randomUUID()}`;
        await fs.symlink(rewrittenTarget, rewritten);
        try {
          await fs.rename(rewritten, destination);
        } catch (error) {
          await fs.unlink(rewritten).catch(() => {});
          throw error;
        }
      },
      async (destination) => {
        if (!productClaimed) return;
        if (claimedSymlinkTarget === null) {
          await fs.link(destination, importedFilePath);
          await fs.unlink(destination);
          productClaimed = false;
          return;
        }
        await fs.symlink(claimedSymlinkTarget, importedFilePath);
        try {
          await fs.unlink(destination);
          productClaimed = false;
        } catch (error) {
          await fs.unlink(importedFilePath).catch(() => {});
          throw error;
        }
      },
      importedFilePath,
      ops,
      options.packageCollisionPolicy,
      undefined,
      true,
      undefined,
      options.packageId,
      options,
      options.expectedSourceSha256
    );
    await relocatePairedSidecars({
      sourceDir: sourceParentDir,
      fileName: physicalFileName,
      destDir: created.packageRoot,
    });
    return { packages: [created], converted: true };
  }

  const maxBytes = options.maxConvertibleBytes ?? DEFAULT_MAX_CONVERTIBLE_BYTES;
  try {
    const { size } = await fs.stat(importedFilePath);
    if (size > maxBytes) {
      return {
        packages: [],
        converted: false,
        untouchedPath: importedFilePath,
        skippedReason:
          `"${fileName}" is too large to convert safely (${Math.round(size / 1_000_000)} MB). ` +
          `It was imported as-is.`,
        sourceOnly: true,
      };
    }
  } catch {}

  let sourceBytes: Buffer;
  try {
    sourceBytes = await fs.readFile(importedFilePath);
  } catch (err) {
    return {
      packages: [],
      converted: false,
      untouchedPath: importedFilePath,
      skippedReason: `"${fileName}" could not be read as sequences: ${
        err instanceof Error ? err.message : String(err)
      }. It was imported as-is.`,
    };
  }
  const prepared = prepareConvertedPackageSources(
    sourceBytes,
    fileName,
    stem,
    options.confirmedDnaSourceSha256,
    options.confirmedNucleicAcid
  );
  if (prepared.kind === 'blocked') {
    return {
      packages: [],
      converted: false,
      untouchedPath: importedFilePath,
      skippedReason: prepared.reason,
      sourceOnly: true,
    };
  }
  const automaticRefusal = options.automatic
    ? describeAutomaticSplitRefusal(fileName, prepared.sources)
    : null;
  if (automaticRefusal) {
    return {
      packages: [],
      converted: false,
      untouchedPath: importedFilePath,
      skippedReason: automaticRefusal,
      sourceOnly: true,
    };
  }
  if (prepared.sources.length === 1) {
    const allocation = allocatePackageSources(prepared.sources);
    const source = allocation.kind === 'blocked' ? null : allocation.sources[0];
    const rerunRoot =
      source &&
      (await rerunPackageRoot(importedFilePath, parentDir, source.stem, source.fileName, options));
    if (source && rerunRoot) {
      return updateRerunPackage(importedFilePath, sourceBytes, rerunRoot, source.content, options);
    }
  }
  const materialized = await materializeRecordPackages(
    importedFilePath,
    sourceBytes,
    prepared.sources,
    ops,
    options.expectedSourceSha256,
    parentDir,
    options.packageCollisionPolicy,
    false,
    options.packageId,
    options
  );
  if (materialized.kind === 'changed') {
    return {
      packages: [],
      converted: false,
      untouchedPath: importedFilePath,
      skippedReason: `"${fileName}" changed while conversion was starting. It was left as-is.`,
    };
  }
  return { packages: materialized.packages, converted: true };
}

export async function inspectSequenceRecovery(sourcePath: string) {
  const bytes = await readFileBoundedFromHandle(sourcePath, DEFAULT_MAX_CONVERTIBLE_BYTES);
  const fileName = basename(sourcePath);
  const sourceSha256 = sha256Bytes(bytes);
  const recovery = prepareSequenceRecovery(
    bytes,
    fileName,
    fileName.slice(0, -extname(fileName).length),
    sourceSha256
  );
  return recovery
    ? {
        sourceSha256,
        replacementCount: recovery.replacementCount,
        recordCount: recovery.recordCount,
      }
    : null;
}

export async function recoverImportedSequencePackages(
  sourcePath: string,
  confirmedSourceSha256: string,
  ops: PackageImportFileOps = DEFAULT_FILE_OPS
): Promise<MaterializeImportedSequenceResult> {
  if (!/^[0-9a-f]{64}$/.test(confirmedSourceSha256))
    throw new Error('Recovery requires the inspected source digest.');
  const bytes = await readFileBoundedFromHandle(sourcePath, DEFAULT_MAX_CONVERTIBLE_BYTES);
  assertExpectedSourceBytes(bytes, confirmedSourceSha256);
  const fileName = basename(sourcePath);
  const prepared = prepareSequenceRecovery(
    bytes,
    fileName,
    fileName.slice(0, -extname(fileName).length),
    confirmedSourceSha256
  );
  if (!prepared)
    throw new Error(
      'This file cannot be recovered conservatively as a nucleotide sequence. The original was left unchanged.'
    );
  const allocation = allocatePackageSources(prepared.sources);
  if (allocation.kind === 'blocked') throw new Error(allocation.reason);
  const created: Array<{ package: ImportedSequencePackage; ownership: CreatedPackageOwnership }> =
    [];
  try {
    for (const source of allocation.sources) {
      let ownership: CreatedPackageOwnership = {};
      const pkg = await createPackage(
        dirname(sourcePath),
        source.stem,
        source.fileName,
        async (target) => writeFileExclusive(target, source.content),
        undefined,
        undefined,
        ops,
        'keep-both',
        (createdOwnership) => {
          ownership = createdOwnership;
        },
        false,
        source.original
      );
      created.push({ package: pkg, ownership });
    }
    assertExpectedSourceBytes(
      await readFileBoundedFromHandle(sourcePath, DEFAULT_MAX_CONVERTIBLE_BYTES),
      confirmedSourceSha256
    );
  } catch (error) {
    let complete = true;
    for (const item of created)
      complete = (await removeCreatedPackageMembers(item.package, item.ownership)) && complete;
    if (!complete)
      throw new AggregateError([error], 'Recovery failed; retained recovery data was left intact.');
    throw error;
  }
  return {
    converted: true,
    packages: created.map((item) => item.package),
    untouchedPath: sourcePath,
  };
}

type PreparedOverwriteProduct =
  | { kind: 'copy-source' }
  | { kind: 'write-content'; content: string; original?: RecordPackageSource['original'] }
  | { kind: 'skipped'; reason: string };

async function overwriteImportedSequencePackage(
  importedFilePath: string,
  packageRoot: string,
  ops: PackageImportFileOps,
  options: MaterializeOptions
): Promise<MaterializeImportedSequenceResult> {
  const sourceWithinPackage = relative(packageRoot, importedFilePath);
  if (
    sourceWithinPackage === '' ||
    (!sourceWithinPackage.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      sourceWithinPackage !== '..' &&
      !isAbsolute(sourceWithinPackage))
  ) {
    throw new Error(
      `PACKAGE_OVERWRITE_SOURCE: the loose import must be outside package "${packageRoot}".`
    );
  }

  const metaPath =
    sequencePackageMetaPaths(packageRoot).find((path) => existsSync(path)) ??
    sequencePackagePaths(packageRoot).metaPath;
  let packageStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    packageStat = await fs.lstat(packageRoot);
  } catch (error) {
    if (options.expectedOverwritePackage) {
      throw new SequencePackageTargetChangedError(packageRoot);
    }
    throw error;
  }
  const expectedPackage = options.expectedOverwritePackage;
  if (
    expectedPackage &&
    (!packageStat.isDirectory() ||
      packageStat.dev !== expectedPackage.rootIdentity.dev ||
      packageStat.ino !== expectedPackage.rootIdentity.ino)
  ) {
    throw new SequencePackageTargetChangedError(packageRoot);
  }
  if (!packageStat.isDirectory()) {
    throw new Error(
      `PACKAGE_OVERWRITE_ROOT: package root is not a physical directory: "${packageRoot}".`
    );
  }
  try {
    await assertPhysicalPackageMember(packageRoot, metaPath);
  } catch (error) {
    if (expectedPackage) throw new SequencePackageTargetChangedError(packageRoot);
    throw error;
  }
  let current: ReturnType<typeof parseSequencePackageDocument>;
  let currentMarkerSha256: string;
  try {
    const markerBytes = await fs.readFile(metaPath);
    currentMarkerSha256 = sha256Bytes(markerBytes);
    current = parseSequencePackageDocument(markerBytes.toString('utf8'));
  } catch (error) {
    if (options.expectedOverwritePackage) {
      throw new SequencePackageTargetChangedError(packageRoot);
    }
    throw error;
  }
  if (
    expectedPackage &&
    (relative(packageRoot, metaPath).replace(/\\/g, '/') !== expectedPackage.markerFile ||
      currentMarkerSha256 !== expectedPackage.markerSha256 ||
      current.id !== expectedPackage.id ||
      current.product.file !== expectedPackage.productFile)
  ) {
    throw new SequencePackageTargetChangedError(packageRoot);
  }
  const currentPaths = sequencePackagePaths(packageRoot, {
    productFile: current.product.file,
  });
  try {
    await assertPhysicalWriteDestination(packageRoot, currentPaths.productPath);
  } catch (error) {
    if (expectedPackage) throw new SequencePackageTargetChangedError(packageRoot);
    throw error;
  }
  let productStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    productStat = await fs.lstat(currentPaths.productPath);
  } catch (error) {
    if (expectedPackage) throw new SequencePackageTargetChangedError(packageRoot);
    throw error;
  }
  if (!productStat.isFile() && !productStat.isSymbolicLink()) {
    if (expectedPackage) throw new SequencePackageTargetChangedError(packageRoot);
    throw new Error(
      `PACKAGE_OVERWRITE_PRODUCT: recorded product is not a file or symbolic link: "${currentPaths.productPath}".`
    );
  }
  if (
    expectedPackage &&
    (productStat.dev !== expectedPackage.productIdentity.dev ||
      productStat.ino !== expectedPackage.productIdentity.ino)
  ) {
    throw new SequencePackageTargetChangedError(packageRoot);
  }
  const oldGeneratedMembers = [
    currentPaths.productPath,
    metaPath,
    ...recordedPrimerArtifactPaths(current, packageRoot),
  ].filter((path, index, all) => all.indexOf(path) === index);
  const oldMemberIdentities = new Map<string, { device: number; inode: number }>();
  const oldMemberSha256 = new Map<string, string>();
  const expectedGeneratedMembers = new Map(
    expectedPackage?.generatedMembers.map((member) => [member.file, member] as const) ?? []
  );
  for (const target of oldGeneratedMembers) {
    const targetFile = relative(packageRoot, target).replace(/\\/g, '/');
    const expectedGeneratedMember = expectedGeneratedMembers.get(targetFile);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (
          expectedPackage &&
          (target === currentPaths.productPath ||
            target === metaPath ||
            expectedGeneratedMember?.identity)
        ) {
          throw new SequencePackageTargetChangedError(packageRoot);
        }
        continue;
      }
      throw error;
    }
    if (target === currentPaths.productPath) {
      await assertPhysicalWriteDestination(packageRoot, target);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error(`PACKAGE_OVERWRITE_MEMBER: product is not a file: "${target}".`);
      }
      if (
        expectedPackage &&
        (stat.dev !== expectedPackage.productIdentity.dev ||
          stat.ino !== expectedPackage.productIdentity.ino)
      ) {
        throw new SequencePackageTargetChangedError(packageRoot);
      }
    } else {
      await assertPhysicalPackageMember(packageRoot, target);
      if (!stat.isFile()) {
        throw new Error(
          `PACKAGE_OVERWRITE_MEMBER: recorded generated member is not a physical file: "${target}".`
        );
      }
      if (
        expectedPackage &&
        target === metaPath &&
        (stat.dev !== expectedPackage.markerIdentity.dev ||
          stat.ino !== expectedPackage.markerIdentity.ino)
      ) {
        throw new SequencePackageTargetChangedError(packageRoot);
      }
      if (
        expectedPackage &&
        target !== metaPath &&
        (!expectedGeneratedMember?.identity ||
          stat.dev !== expectedGeneratedMember.identity.dev ||
          stat.ino !== expectedGeneratedMember.identity.ino)
      ) {
        throw new SequencePackageTargetChangedError(packageRoot);
      }
    }
    oldMemberIdentities.set(target, { device: stat.dev, inode: stat.ino });
    try {
      let expectedSha256: string;
      if (target === metaPath) {
        expectedSha256 = currentMarkerSha256;
      } else if (target === currentPaths.productPath && expectedPackage) {
        expectedSha256 = expectedPackage.productSha256;
      } else if (expectedPackage) {
        if (!expectedGeneratedMember?.sha256) {
          throw new SequencePackageTargetChangedError(packageRoot);
        }
        expectedSha256 = expectedGeneratedMember.sha256;
      } else {
        expectedSha256 = await inspectSequenceFileSha256(target);
      }
      if (
        target === currentPaths.productPath &&
        stat.isSymbolicLink() &&
        (await inspectSequenceFileSha256(target)) !== expectedSha256
      ) {
        throw new SequencePackageTargetChangedError(packageRoot);
      }
      oldMemberSha256.set(target, expectedSha256);
    } catch (error) {
      if (expectedPackage && !(error instanceof SequencePackageTargetChangedError)) {
        throw new SequencePackageTargetChangedError(packageRoot);
      }
      throw error;
    }
  }

  const prepared = await prepareOverwriteProduct(
    importedFilePath,
    options,
    options.logicalFileName
  );
  if (prepared.kind === 'skipped') {
    return {
      packages: [],
      converted: false,
      untouchedPath: importedFilePath,
      skippedReason: prepared.reason,
    };
  }

  const parent = dirname(packageRoot);
  const packageName = basename(packageRoot);
  const stagingRoot = await fs.mkdtemp(join(parent, `.${packageName}.import-staging-`));
  let previousRoot: string;
  try {
    previousRoot = await fs.mkdtemp(join(parent, `.${packageName}.import-previous-`));
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const stagedPaths = sequencePackagePaths(stagingRoot, {
    productFile: current.product.file,
  });
  const heldSourcePath = join(stagingRoot, '.source', basename(importedFilePath));
  const renameFile = ops.rename ?? fs.rename;
  let sourceClaimed = false;
  let evidenceMove: { staged: string; target: string } | undefined;
  try {
    await fs.mkdir(stagedPaths.metaDir, { recursive: true });
    await fs.mkdir(dirname(heldSourcePath), { recursive: true });
    await renameFile(importedFilePath, heldSourcePath);
    sourceClaimed = true;
    assertExpectedSourceBytes(await fs.readFile(heldSourcePath), options.expectedSourceSha256);
    const claimedPrepared = await prepareOverwriteProduct(
      heldSourcePath,
      options,
      options.logicalFileName
    );
    if (claimedPrepared.kind === 'skipped') {
      await restoreHeldSourceNoClobber(heldSourcePath, importedFilePath);
      sourceClaimed = false;
      await Promise.all([
        fs.rm(stagingRoot, { recursive: true, force: true }),
        fs.rm(previousRoot, { recursive: true, force: true }),
      ]);
      return {
        packages: [],
        converted: false,
        untouchedPath: importedFilePath,
        skippedReason: claimedPrepared.reason,
      };
    }

    if (claimedPrepared.kind === 'copy-source') {
      await fs.copyFile(heldSourcePath, stagedPaths.productPath, fsConstants.COPYFILE_EXCL);
    } else {
      await writeFileExclusive(stagedPaths.productPath, claimedPrepared.content);
    }

    const retainedMembers = current.members.filter((member) => member.role !== 'primer-export');
    const preserved: Record<string, unknown> = { ...current, members: retainedMembers };
    delete preserved.assembly;
    delete preserved.product;
    delete preserved.updatedAt;
    if (claimedPrepared.kind === 'write-content' && claimedPrepared.original) {
      const original = claimedPrepared.original;
      const memberId = randomUUID();
      const memberPath = sequenceManagedMemberPath(`${memberId}-${basename(original.name)}`);
      evidenceMove = {
        staged: fromPackageRelative(memberPath, stagingRoot),
        target: fromPackageRelative(memberPath, packageRoot),
      };
      await fs.mkdir(stagedPaths.contentsDir, { recursive: true });
      await writeFileExclusive(evidenceMove.staged, original.bytes);
      preserved.members = [
        ...retainedMembers,
        {
          id: memberId,
          role: 'evidence-input',
          path: memberPath,
          replaceable: false,
          createdAt: new Date().toISOString(),
          mediaType: 'application/octet-stream',
        },
      ];
    }
    const replacedLocus =
      claimedPrepared.kind === 'copy-source'
        ? (await inspectGenBankSource(stagedPaths.productPath)).locusName
        : null;
    const existingEntity =
      preserved.entity &&
      typeof preserved.entity === 'object' &&
      !Array.isArray(preserved.entity) &&
      'schema' in preserved.entity &&
      'fields' in preserved.entity
        ? (preserved.entity as ReturnType<typeof createDefaultSequenceEntityMetadata>)
        : undefined;
    await ops.writeMeta(
      stagedPaths.metaPath,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: current.id,
          name: current.name,
          product: { file: current.product.file },
          ...(replacedLocus
            ? { entity: sequenceEntityRecordingLocus(replacedLocus, existingEntity) }
            : {}),
          existing: preserved,
        })
      )
    );
  } catch (error) {
    let restoreError: unknown;
    if (sourceClaimed) {
      try {
        await restoreHeldSourceNoClobber(heldSourcePath, importedFilePath);
        sourceClaimed = false;
      } catch (caught) {
        restoreError = caught;
      }
    }
    if (restoreError !== undefined) {
      throw sourceRecoveryError(importedFilePath, heldSourcePath, error, restoreError);
    }
    await Promise.all([
      fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {}),
      fs.rm(previousRoot, { recursive: true, force: true }).catch(() => {}),
    ]);
    throw error;
  }

  const backedUp: Array<{ target: string; previous: string }> = [];
  const installed: Array<{ staged: string; target: string }> = [];
  let recoveryMustRemain = false;

  try {
    for (const target of oldGeneratedMembers) {
      const expectedIdentity = oldMemberIdentities.get(target);
      if (!expectedIdentity) continue;
      const member = relative(packageRoot, target);
      if (member.startsWith('..') || isAbsolute(member)) {
        throw new Error(`PACKAGE_OVERWRITE_MEMBER: generated member escapes package: "${target}".`);
      }
      const previous = join(previousRoot, member);
      await fs.mkdir(dirname(previous), { recursive: true });
      await renameFile(target, previous);
      const moved = await fs.lstat(previous);
      let movedMemberChanged = false;
      const expectedSha256 = oldMemberSha256.get(target);
      if (expectedSha256 && moved.isFile()) {
        try {
          movedMemberChanged = (await inspectSequenceFileSha256(previous)) !== expectedSha256;
        } catch {
          movedMemberChanged = true;
        }
      }
      if (
        moved.dev !== expectedIdentity.device ||
        moved.ino !== expectedIdentity.inode ||
        movedMemberChanged
      ) {
        try {
          await restoreHeldSourceNoClobber(previous, target);
        } catch (restoreError) {
          recoveryMustRemain = true;
          throw new AggregateError(
            [restoreError],
            `PACKAGE_OVERWRITE_REPLACED_MEMBER: "${target}" changed after verification and remains at "${previous}".`
          );
        }
        throw new SequencePackageTargetChangedError(packageRoot);
      }
      backedUp.push({ target, previous });
    }

    for (const move of [
      { staged: stagedPaths.productPath, target: currentPaths.productPath },
      ...(evidenceMove ? [evidenceMove] : []),
      { staged: stagedPaths.metaPath, target: currentPaths.metaPath },
    ]) {
      await fs.mkdir(dirname(move.target), { recursive: true });
      await moveFileNoClobber(move.staged, move.target, ops);
      installed.push(move);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const move of [...installed].reverse()) {
      try {
        await restoreHeldSourceNoClobber(move.target, move.staged);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const backup of [...backedUp].reverse()) {
      try {
        await fs.mkdir(dirname(backup.target), { recursive: true });
        await restoreHeldSourceNoClobber(backup.previous, backup.target);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      await restoreHeldSourceNoClobber(heldSourcePath, importedFilePath);
      sourceClaimed = false;
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0 || recoveryMustRemain) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Package overwrite failed AND recovery was incomplete. New/recovery files remain at ` +
          `"${stagingRoot}" and "${previousRoot}".`
      );
    }
    await Promise.all([
      fs.rm(stagingRoot, { recursive: true, force: true }),
      fs.rm(previousRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }

  await removeRecoveryRootsBestEffort([stagingRoot, previousRoot]);

  return {
    packages: [{ packageRoot, productPath: currentPaths.productPath }],
    converted: true,
  };
}

const activeConversionSourceRoots = new Set<string>();
const CONVERSION_SOURCE_DIR = /^\..+\.conversion-source-[A-Za-z0-9]{6}$/;

export function isConversionSourceDirectoryName(name: string): boolean {
  return CONVERSION_SOURCE_DIR.test(name);
}

export type HeldConversionSourceRecovery =
  | { kind: 'restored'; path: string }
  | { kind: 'stranded'; path: string; reason: string }
  | { kind: 'empty' }
  | { kind: 'in-use' };

export async function recoverHeldConversionSource(
  recoveryRoot: string
): Promise<HeldConversionSourceRecovery> {
  if (activeConversionSourceRoots.has(recoveryRoot)) return { kind: 'in-use' };
  const names = await fs.readdir(recoveryRoot);
  if (names.length === 0) {
    await fs.rmdir(recoveryRoot);
    return { kind: 'empty' };
  }
  if (names.length !== 1) {
    return {
      kind: 'stranded',
      path: recoveryRoot,
      reason: `An interrupted conversion left ${names.length} files set aside in this hidden folder; they were not moved.`,
    };
  }
  const heldPath = join(recoveryRoot, names[0]);
  const originalPath = join(dirname(recoveryRoot), names[0]);
  try {
    await restoreHeldSourceNoClobber(heldPath, originalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        kind: 'stranded',
        path: heldPath,
        reason: `An interrupted conversion set "${names[0]}" aside, and a newer file now has its name. The earlier copy is kept in this hidden folder.`,
      };
    }
    throw error;
  }
  await fs.rmdir(recoveryRoot);
  return { kind: 'restored', path: originalPath };
}

async function restoreHeldSourceNoClobber(
  heldSourcePath: string,
  originalPath: string
): Promise<void> {
  const held = await fs.lstat(heldSourcePath);
  if (held.isSymbolicLink()) {
    const target = await fs.readlink(heldSourcePath);
    await fs.symlink(target, originalPath);
  } else if (held.isFile()) {
    await fs.link(heldSourcePath, originalPath);
  } else {
    throw new Error(`PACKAGE_SOURCE_RECOVERY: held source is not a file: "${heldSourcePath}".`);
  }
  await fs.unlink(heldSourcePath);
}

async function moveFileNoClobber(
  sourcePath: string,
  destinationPath: string,
  ops: PackageImportFileOps
): Promise<void> {
  const source = await fs.lstat(sourcePath);
  if (!source.isFile() && !source.isSymbolicLink()) {
    throw new Error(`PACKAGE_INSTALL_MEMBER: "${sourcePath}" is not a file or symbolic link.`);
  }

  const recoveryRoot = await fs.mkdtemp(
    join(dirname(sourcePath), `.${basename(sourcePath)}.transfer-source-`)
  );
  const heldSourcePath = join(recoveryRoot, basename(sourcePath));
  const expectedSource = { dev: source.dev, ino: source.ino };
  let destinationIdentity: PackageMemberIdentity | undefined;
  let sourceClaimed = false;
  let recoveryMustRemain = false;

  try {
    if (source.isFile()) {
      const claimed = await claimRegularFileNoClobber(sourcePath, destinationPath, {
        link: ops.link,
      });
      destinationIdentity = claimed.identity;
      if (
        claimed.method === 'link' &&
        (claimed.identity.dev !== expectedSource.dev || claimed.identity.ino !== expectedSource.ino)
      ) {
        throw new Error(
          `PACKAGE_INSTALL_DESTINATION_CHANGED: "${destinationPath}" changed while it was being claimed.`
        );
      }
    } else {
      await fs.symlink(await fs.readlink(sourcePath), destinationPath);
      const installed = await fs.lstat(destinationPath);
      destinationIdentity = { dev: installed.dev, ino: installed.ino };
    }

    await (ops.rename ?? fs.rename)(sourcePath, heldSourcePath);
    sourceClaimed = true;
    const claimed = await fs.lstat(heldSourcePath);
    if (claimed.dev !== expectedSource.dev || claimed.ino !== expectedSource.ino) {
      try {
        await restoreHeldSourceNoClobber(heldSourcePath, sourcePath);
        sourceClaimed = false;
      } catch (restoreError) {
        recoveryMustRemain = true;
        throw new AggregateError(
          [restoreError],
          `PACKAGE_INSTALL_SOURCE_CHANGED: "${sourcePath}" changed during transfer and the ` +
            `displaced file remains at "${heldSourcePath}".`
        );
      }
      throw new Error(
        `PACKAGE_INSTALL_SOURCE_CHANGED: "${sourcePath}" changed while it was being claimed.`
      );
    }

    await (ops.unlink ?? fs.unlink)(heldSourcePath);
    sourceClaimed = false;
    await fs.rmdir(recoveryRoot).catch((cleanupError) => {
      console.warn(
        `[plasmid-package] Package member transfer succeeded, but the empty transfer directory ` +
          `could not be removed at "${recoveryRoot}".`,
        cleanupError
      );
    });
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    let mayRemoveDestination = !sourceClaimed;
    if (sourceClaimed) {
      try {
        await restoreHeldSourceNoClobber(heldSourcePath, sourcePath);
        sourceClaimed = false;
        mayRemoveDestination = true;
      } catch (restoreError) {
        recoveryMustRemain = true;
        mayRemoveDestination = false;
        recoveryErrors.push(restoreError);
      }
    }
    if (destinationIdentity && mayRemoveDestination) {
      try {
        await unlinkPackageMemberIfIdentityMatches(destinationPath, destinationIdentity);
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
    }
    if (!recoveryMustRemain) {
      await fs.rmdir(recoveryRoot).catch((cleanupError) => recoveryErrors.push(cleanupError));
    }
    if (recoveryErrors.length > 0 || recoveryMustRemain) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        `Package member transfer failed and recovery bytes remain at "${recoveryRoot}".`
      );
    }
    throw error;
  }
}

function sourceRecoveryError(
  originalPath: string,
  heldSourcePath: string,
  originalError: unknown,
  restoreError: unknown
): AggregateError {
  return new AggregateError(
    [originalError, restoreError],
    `Package conversion failed AND the source could not be restored without overwriting ` +
      `"${originalPath}". The claimed source remains at "${heldSourcePath}" for recovery.`
  );
}

async function prepareOverwriteProduct(
  importedFilePath: string,
  options: MaterializeOptions,
  logicalFileName?: string
): Promise<PreparedOverwriteProduct> {
  const fileName = logicalFileName ?? basename(importedFilePath);
  if (isAlreadyGenBank(fileName)) return { kind: 'copy-source' };

  const maxBytes = options.maxConvertibleBytes ?? DEFAULT_MAX_CONVERTIBLE_BYTES;
  const { size } = await fs.stat(importedFilePath);
  if (size > maxBytes) {
    return {
      kind: 'skipped',
      reason: `"${fileName}" is too large to convert safely (${Math.round(size / 1_000_000)} MB).`,
    };
  }

  if (sequenceFileTypeForPath(fileName)?.managedImport === 'snapgene') {
    const prepared = prepareConvertedPackageSources(
      await fs.readFile(importedFilePath),
      fileName,
      fileName.slice(0, -extname(fileName).length)
    );
    if (prepared.kind === 'blocked') return { kind: 'skipped', reason: prepared.reason };
    const [source] = prepared.sources;
    return { kind: 'write-content', content: source.content, original: source.original };
  }

  let records: ReturnType<typeof parseSequenceFile>;
  let rawContent: string;
  try {
    const sourceBytes = await fs.readFile(importedFilePath);
    assertExpectedSourceBytes(sourceBytes, options.confirmedDnaSourceSha256);
    rawContent = sourceBytes.toString('utf8');
    records = declaredRecords(
      parseSequenceFile(rawContent, { filename: fileName }),
      options.confirmedDnaSourceSha256 ? options.confirmedNucleicAcid : undefined
    );
  } catch (error) {
    return {
      kind: 'skipped',
      reason: `"${fileName}" could not be read as sequences: ${errorMessage(error)}.`,
    };
  }
  if (records.length !== 1) {
    return {
      kind: 'skipped',
      reason:
        records.length === 0
          ? `"${fileName}" contains no readable sequences.`
          : `"${fileName}" contains ${records.length} records; one existing plasmid package cannot be overwritten by multiple products.`,
    };
  }
  const lossy = describeLossyConversion(
    records,
    rawContent,
    fileName,
    !!options.confirmedDnaSourceSha256
  );
  if (lossy) return { kind: 'skipped', reason: lossy.reason };

  const header = extractFastaHeaders(normalizeFastaContent(rawContent))[0];
  return {
    kind: 'write-content',
    content: fastaRecordGenBank(
      records[0],
      header,
      options.confirmedDnaSourceSha256 ? options.confirmedNucleicAcid : undefined
    ),
  };
}

function recordedPrimerArtifactPaths(
  doc: ReturnType<typeof parseSequencePackageDocument>,
  packageRoot: string
): string[] {
  const relativePaths = [
    ...doc.members.filter((member) => member.role === 'primer-export').map((member) => member.path),
    doc.assembly?.primers?.csv,
    doc.assembly?.primers?.fasta,
  ];
  const candidates = relativePaths
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .flatMap((path) => sequencePrimerArtifactLookupPaths(path));
  return [...new Set(candidates)].map((path) => fromPackageRelative(path, packageRoot));
}

async function removeRecoveryRootsBestEffort(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await fs.rm(path, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `[plasmid-package] Replacement succeeded, but recovery cleanup failed at "${path}". ` +
          'The directory was retained for manual recovery.',
        error
      );
    }
  }
}

type PackageMemberIdentity = { dev: number; ino: number };
type CreatedPackageOwnership = {
  product?: PackageMemberIdentity;
  meta?: PackageMemberIdentity;
  evidence?: { path: string; identity: PackageMemberIdentity };
};

async function removeCreatedPackageMembers(
  pkg: ImportedSequencePackage,
  ownership: CreatedPackageOwnership
): Promise<boolean> {
  const paths = sequencePackagePaths(pkg.packageRoot, {
    productFile: basename(pkg.productPath),
  });
  let complete = await unlinkPackageMemberIfIdentityMatches(paths.metaPath, ownership.meta).catch(
    () => false
  );
  complete =
    (await unlinkPackageMemberIfIdentityMatches(paths.productPath, ownership.product).catch(
      () => false
    )) && complete;
  if (ownership.evidence) {
    complete =
      (await unlinkPackageMemberIfIdentityMatches(
        ownership.evidence.path,
        ownership.evidence.identity
      ).catch(() => false)) && complete;
  }
  for (const directory of [paths.contentsDir, paths.primersDir, paths.metaDir, pkg.packageRoot]) {
    try {
      await fs.rmdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
    }
  }
  return complete;
}

async function unlinkPackageMemberIfIdentityMatches(
  path: string,
  expected: PackageMemberIdentity | undefined
): Promise<boolean> {
  if (!expected) return true;
  let current: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    current = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
  await fs.unlink(path);
  return true;
}

function sequenceEntityRecordingLocus(
  locusName: string,
  existing?: ReturnType<typeof createDefaultSequenceEntityMetadata>
) {
  const entity = existing ?? createDefaultSequenceEntityMetadata();
  return { ...entity, fields: { ...entity.fields, locus: locusName } };
}

async function createPackage(
  parentDir: string,
  stem: string,
  productFileName: string,
  placeProduct: (destination: string) => Promise<void>,
  undoPlaceProduct?: (destination: string) => Promise<void>,
  restoreDestination?: string,
  ops: PackageImportFileOps = DEFAULT_FILE_OPS,
  collisionPolicy: SequencePackageCollisionPolicy = 'keep-both',
  onCreated?: (ownership: CreatedPackageOwnership) => void,
  recordLocus = false,
  initialEvidence?: { name: string; bytes: Uint8Array },
  packageId?: string,
  migration: MaterializeOptions = {},
  plannedProductSha256?: string,
  packageCount = 1
): Promise<ImportedSequencePackage> {
  let packageRoot = join(parentDir, stem);
  for (let n = 1; ; n += 1) {
    try {
      const occupied = await fs.lstat(packageRoot).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      );
      if (
        occupied ||
        migration.protectedPaths?.some((path) => migrationPathsIntersect(packageRoot, path))
      )
        throw Object.assign(new Error('The package destination is already owned.'), {
          code: 'EEXIST',
        });
      const create = async () => {
        assertMigrationPathsAvailable([packageRoot], migration);
        await fs.mkdir(packageRoot, { recursive: false });
      };
      if (migration.withCleanPaths) await migration.withCleanPaths([packageRoot], create);
      else await create();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      if (collisionPolicy === 'exact') throw new SequencePackageTargetExistsError(packageRoot);
      if (n > MAX_PACKAGE_NAME_COLLISIONS) throw err;
      packageRoot = join(parentDir, `${stem} (${n})`);
    }
  }

  const paths = sequencePackagePaths(packageRoot, { productFile: productFileName });
  const createdPackageId = packageId ?? randomUUID();
  let productIdentity: PackageMemberIdentity | undefined;
  let metaIdentity: PackageMemberIdentity | undefined;
  let evidence: CreatedPackageOwnership['evidence'];
  try {
    if (migration.onPackagePlanned) {
      if (!plannedProductSha256)
        throw new Error('Sequence migration is missing its expected product content.');
      await migration.onPackagePlanned({
        packageRoot,
        packageId: createdPackageId,
        productFile: productFileName,
        productSha256: plannedProductSha256,
        packageCount,
      });
    }
    await fs.mkdir(paths.metaDir, { recursive: true });
    await placeProduct(paths.productPath);
    const placedProduct = await fs.lstat(paths.productPath);
    productIdentity = { dev: placedProduct.dev, ino: placedProduct.ino };
    const productInspection = await inspectGenBankSource(paths.productPath, {
      followClaimedSymlink: true,
    });
    migration.assertCurrent?.();
    if (initialEvidence) {
      const relativePath = sequenceManagedMemberPath(basename(initialEvidence.name));
      const evidencePath = fromPackageRelative(relativePath, packageRoot);
      await fs.mkdir(paths.contentsDir, { recursive: true });
      await assertPhysicalWriteDestination(packageRoot, evidencePath);
      await writeFileExclusive(evidencePath, initialEvidence.bytes);
      const stat = await fs.lstat(evidencePath);
      evidence = { path: evidencePath, identity: { dev: stat.dev, ino: stat.ino } };
    }
    await ops.writeMeta(
      paths.metaPath,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: createdPackageId,
          name: basename(packageRoot),
          ...(initialEvidence
            ? {
                members: [
                  {
                    id: randomUUID(),
                    role: 'evidence-input',
                    path: sequenceManagedMemberPath(basename(initialEvidence.name)),
                    replaceable: false,
                    createdAt: new Date().toISOString(),
                    mediaType: 'application/octet-stream',
                  },
                ],
              }
            : {}),
          ...(recordLocus && productInspection.locusName
            ? { entity: sequenceEntityRecordingLocus(productInspection.locusName) }
            : {}),
          product: {
            file: productFileName,
            genBankChecksum: `sha256:${productInspection.sourceSha256}`,
          },
        })
      )
    );
    const writtenMeta = await fs.lstat(paths.metaPath);
    metaIdentity = { dev: writtenMeta.dev, ino: writtenMeta.ino };
  } catch (err) {
    let restored = true;
    let restoreFailure: unknown;
    if (undoPlaceProduct) {
      try {
        await undoPlaceProduct(paths.productPath);
      } catch (error) {
        restored = false;
        restoreFailure = error;
      }
    }
    if (restored) {
      await unlinkPackageMemberIfIdentityMatches(paths.metaPath, metaIdentity);
      await unlinkPackageMemberIfIdentityMatches(paths.productPath, productIdentity);
      if (evidence) await unlinkPackageMemberIfIdentityMatches(evidence.path, evidence.identity);
      await fs.rmdir(paths.contentsDir).catch(() => {});
      await fs.rmdir(paths.primersDir).catch(() => {});
      await fs.rmdir(paths.metaDir).catch(() => {});
      await fs.rmdir(packageRoot).catch(() => {});
    } else {
      const message =
        `Package creation failed AND the product could not be restored to ` +
        `"${restoreDestination ?? 'its original import location'}". ` +
        `The surviving product remains at "${paths.productPath}" inside recovery directory ` +
        `"${packageRoot}"; it was not deleted.`;
      console.error(`[plasmid-package] ${message}`, restoreFailure);
      throw new AggregateError(
        restoreFailure === undefined ? [err] : [err, restoreFailure],
        message
      );
    }
    throw err;
  }

  onCreated?.({ product: productIdentity, meta: metaIdentity, evidence });
  return { packageRoot, productPath: paths.productPath };
}

export async function relocatePairedSidecars(input: {
  sourceDir: string;
  fileName: string;
  destDir: string;
}): Promise<void> {
  for (const suffix of PAIRED_SIDECAR_SUFFIXES) {
    const fromPath = join(input.sourceDir, `${input.fileName}${suffix}`);
    const toPath = join(input.destDir, `${input.fileName}${suffix}`);
    let raw: string;
    try {
      raw = await fs.readFile(fromPath, 'utf8');
    } catch {
      continue;
    }
    const rewritten = rewriteSidecarQueryPaths(raw, input.sourceDir, input.destDir);
    try {
      if (suffix === '.waypoint.json') {
        await writeAlignmentHistoryMember({
          packageRoot: input.destDir,
          productFile: input.fileName,
          content: rewritten,
          fs: nodeSequencePackageIo(),
        });
      } else {
        await fs.writeFile(toPath, rewritten, 'utf8');
      }
      await fs.unlink(fromPath);
    } catch (err) {
      console.warn(
        `[plasmid-package] could not move sidecar ${fromPath} → ${toPath}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

export function rewriteSidecarQueryPaths(content: string, oldDir: string, newDir: string): string {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return content;
  }
  if (!data || typeof data !== 'object') return content;
  const sessions = (data as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return content;

  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;
    const tracks = (session as { tracks?: unknown }).tracks;
    if (!Array.isArray(tracks)) continue;
    for (const track of tracks) {
      if (!track || typeof track !== 'object') continue;
      const queryPath = (track as { queryPath?: unknown }).queryPath;
      if (typeof queryPath !== 'string' || queryPath.length === 0) continue;
      const absolute = isAbsolute(queryPath) ? queryPath : resolve(oldDir, queryPath);
      const next = relative(newDir, absolute);
      (track as { queryPath: string }).queryPath = next.length > 0 ? next : basename(absolute);
    }
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

function nodeSequencePackageIo() {
  return {
    exists: async (path: string) => {
      try {
        await fs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    readTextFile: (path: string) => fs.readFile(path, 'utf8'),
    writeTextFile: (path: string, content: string) => fs.writeFile(path, content, 'utf8'),
    writeWorkspaceTextFileAtomic: (input: {
      workspaceRoot: string;
      path: string;
      content: string;
      mode: 'replace';
      expectedContentHash: string;
      artifactNoun: string;
    }) => writeWorkspaceTextFileAtomicInMain(input),
    mkdir: async (path: string, options?: { recursive?: boolean }) => {
      await fs.mkdir(path, options);
    },
    move: async (sourcePath: string, destinationDir: string) => {
      const destPath = join(destinationDir, basename(sourcePath));
      // workspace-entity-move: attaches within contents; member row follows.
      await fs.rename(sourcePath, destPath);
      return { destPath };
    },
    unlink: (path: string) => fs.unlink(path),
    // workspace-entity-move: retires verified leftovers after copy-verify.
    rename: (from: string, to: string) => fs.rename(from, to),
  };
}

async function enclosingPackageProduct(dirPath: string): Promise<string | null> {
  const metaPath =
    sequencePackageMetaPaths(dirPath).find((path) => existsSync(path)) ??
    sequencePackagePaths(dirPath).metaPath;
  let raw: string;
  try {
    raw = await fs.readFile(metaPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return parseSequencePackageDocument(raw).product.file;
  } catch {
    return '';
  }
}

export async function existingPlasmidPackageRootForProduct(
  productPath: string
): Promise<string | null> {
  const packageRoot = dirname(productPath);
  const recordedProduct = await enclosingPackageProduct(packageRoot);
  if (recordedProduct !== basename(productPath)) return null;
  try {
    const rootStat = await fs.lstat(packageRoot);
    if (!rootStat.isDirectory()) return null;
    const metaPath =
      sequencePackageMetaPaths(packageRoot).find((path) => existsSync(path)) ??
      sequencePackagePaths(packageRoot).metaPath;
    await assertPhysicalPackageMember(packageRoot, metaPath);
    await assertPhysicalWriteDestination(packageRoot, productPath);
    const productStat = await fs.lstat(productPath);
    return productStat.isFile() || productStat.isSymbolicLink() ? packageRoot : null;
  } catch {
    return null;
  }
}

export async function assertExistingPlasmidPackageRoot(packageRoot: string): Promise<string[]> {
  const rootStat = await fs.lstat(packageRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`INVALID_PLASMID_PACKAGE_ROOT: "${packageRoot}" is not a physical directory.`);
  }
  const metaPath =
    sequencePackageMetaPaths(packageRoot).find((path) => existsSync(path)) ??
    sequencePackagePaths(packageRoot).metaPath;
  await assertPhysicalPackageMember(packageRoot, metaPath);
  const doc = parseSequencePackageDocument(await fs.readFile(metaPath, 'utf8'));
  const productPath = sequencePackagePaths(packageRoot, {
    productFile: doc.product.file,
  }).productPath;
  await assertPhysicalWriteDestination(packageRoot, productPath);
  const productStat = await fs.lstat(productPath);
  if (!productStat.isFile() && !productStat.isSymbolicLink()) {
    throw new Error(
      `INVALID_PLASMID_PACKAGE_PRODUCT: recorded product is not a file or symbolic link: "${productPath}".`
    );
  }

  const authorizedMembers = new Set<string>(['.forge/plasmid.json', doc.product.file]);
  for (const relativePath of [
    ...doc.members.filter((member) => member.replaceable).map((member) => member.path),
    doc.assembly?.primers?.csv,
    doc.assembly?.primers?.fasta,
  ]) {
    if (typeof relativePath !== 'string' || !relativePath) continue;
    const memberPath = fromPackageRelative(relativePath, packageRoot);
    authorizedMembers.add(relativePath.replace(/\\/g, '/'));
    try {
      const memberStat = await fs.lstat(memberPath);
      await assertPhysicalPackageMember(packageRoot, memberPath);
      if (!memberStat.isFile()) {
        throw new Error(
          `INVALID_PLASMID_PACKAGE_MEMBER: recorded generated member is not a physical file: "${memberPath}".`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [...authorizedMembers];
}

async function writeFileExclusive(path: string, content: string | Uint8Array): Promise<void> {
  await publishFileContentNoClobber(path, content);
}
