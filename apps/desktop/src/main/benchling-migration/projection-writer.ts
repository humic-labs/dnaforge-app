import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import type {
  ProjectionReceipt,
  ValidationDestinationArtifactEvidence,
  ValidationDestinationIntegrityEvidence,
} from '../../shared/benchling-migration';
import type { BenchlingMigrationActionAllocation } from '../../shared/benchling-migration-action-journal';
import { MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH } from '../../shared/benchling-migration-destination-index';
import { COLLECTION_PROJECTION_MANIFEST_PATH } from './collection-projection-writer';
import {
  hashProjectionFiles,
  projectionDestinationPrimaryPath,
  validateProjectionDestination,
  type ProjectionFile,
  type ProjectionPlan,
} from './projection';
import { BENCHLING_REGISTRY_CONVERTER_ID } from './registry-projection';
import {
  BENCHLING_REGISTRY_PROJECTION_DIRECTORY,
  readBenchlingRegistryProjectionDocuments,
} from './registry-projection-store';
import { isSafeWorkspaceRelativePath } from './safe-workspace-path';
import { fingerprintExistingDestination } from './destination-name-allocator';
import { dnaBasesScientificFingerprint } from './native-exact-match';
import {
  externalZipDecoderSource,
  verifyExternalZipSource,
  type SelectedExternalZipSource,
} from './external-zip-source';
import {
  inspectNativeExportArchive,
  readNativeExportArchiveEntryPreview,
} from './native-export-archive';

type ExternalProjectionAssets = Readonly<{
  sourceObjectId: string;
  sources: readonly Pick<SelectedExternalZipSource, 'source' | 'entries'>[];
}>;

export type ProjectionIntegrityFailure = {
  receiptId: string | null;
  sourceObjectId: string | null;
  destinationPath: string | null;
  message: string;
};

export type ProjectionIntegrityEvidence = {
  destinationIntegrity: ValidationDestinationIntegrityEvidence;
  failures: ProjectionIntegrityFailure[];
};

export type ProjectionIntegrityDestinationArtifacts = {
  collectionDocumentPaths: readonly string[];
  nativeFolderPaths?: readonly string[];
};

const NATIVE_COLLECTION_ROOT = 'Benchling Imports/Collections';
const NATIVE_V2_COLLECTION_ROOT = '.dnaforge/migration/collections';
const PROJECTION_INTEGRITY_CONCURRENCY = 16;
const PROJECTION_DIRECTORY_ENTRY_CONCURRENCY = 4;

export class ProjectionIntegrityError extends Error {
  readonly code = 'hash_mismatch' as const;

  constructor(readonly evidence: ProjectionIntegrityEvidence) {
    super(
      `Projection integrity hash_mismatch: ${evidence.failures.map((failure) => failure.message).join(' ')}`
    );
    this.name = 'ProjectionIntegrityError';
  }
}

export type ProjectionWriterTestHooks = {
  afterCandidateInstall?: (destinationDirectory: string) => void | Promise<void>;
  afterStaging?: (candidatePath: string) => void | Promise<void>;
  afterDisplacement?: (destinationPath: string) => void | Promise<void>;
  afterFileRename?: (destinationPath: string) => void | Promise<void>;
  afterPackageRename?: (destinationPath: string) => void | Promise<void>;
  beforeCatalogCommit?: () => void | Promise<void>;
};

export type FreshProjectionBatchItem = Readonly<{
  runId: string;
  sourceObjectId: string;
  plan: ProjectionPlan;
  createdAt: string;
}>;

export type ProjectionInstallState = 'staged' | 'installed';

const FRESH_PROJECTION_FILE_CONCURRENCY = 16;

export async function writeProjectionPlan(
  input: {
    workspacePath: string;
    runId: string;
    actionId?: string;
    sourceObjectId: string;
    plan: ProjectionPlan;
    allocation?: BenchlingMigrationActionAllocation;
    externalAssetSources?: ExternalProjectionAssets['sources'];
    createdAt: string;
    deferReadbackUntilValidation?: boolean;
    onInstallState?: (state: ProjectionInstallState) => void | Promise<void>;
  },
  testHooks: ProjectionWriterTestHooks = {}
): Promise<ProjectionReceipt> {
  input = {
    ...input,
    plan: await hydrateProjectionPlanAssets(
      input.workspacePath,
      input.plan,
      input.externalAssetSources
        ? { sourceObjectId: input.sourceObjectId, sources: input.externalAssetSources }
        : undefined
    ),
  };
  if (input.allocation) {
    if (
      input.allocation.sourceObjectId !== input.sourceObjectId ||
      (input.plan.destination.kind === 'package' &&
        input.plan.destinationObjectId !== input.allocation.destinationEntityId) ||
      JSON.stringify(input.allocation.destination) !== JSON.stringify(input.plan.destination)
    ) {
      throw new Error('Projection plan does not match its immutable allocation.');
    }
    input = {
      ...input,
      plan: { ...input.plan, destinationObjectId: input.allocation.destinationEntityId },
    };
  }
  validateProjectionPlanPaths(input.plan);
  if (
    input.allocation &&
    input.allocation.installState !== 'reserved' &&
    input.allocation.installState !== 'staged'
  ) {
    const receipt = projectionReceiptForPlan(input);
    await assertProjectionReceiptDestinationIntegrity({
      workspacePath: input.workspacePath,
      receipt,
    });
    return receipt;
  }
  if (input.plan.destination.kind === 'catalog-record') {
    await input.onInstallState?.('staged');
    await testHooks.beforeCatalogCommit?.();
    const receipt = projectionReceiptForPlan(input);
    await input.onInstallState?.('installed');
    return receipt;
  }
  if (input.plan.destination.kind === 'file') {
    return writeDirectProjectionFile(input, testHooks);
  }
  const workspacePath = resolve(input.workspacePath);
  const destinationDirectoryRelative = input.plan.destination.rootRelativePath;
  const destinationDirectory = resolve(workspacePath, destinationDirectoryRelative);
  assertContainedPath(workspacePath, destinationDirectory);
  await assertNoSymlinkSegments(workspacePath, destinationDirectoryRelative);

  const operationId = randomUUID();
  const stagingRoot = join(
    workspacePath,
    '.dnaforge',
    'migration',
    'projection-staging',
    operationId
  );
  const candidateDirectory = join(stagingRoot, 'candidate');
  let backupDirectory = join(stagingRoot, 'prior');
  let retainBackup = false;
  let preserveStagingRoot = false;
  await mkdir(candidateDirectory, { recursive: true });

  try {
    for (const file of input.plan.files) {
      const memberPath = relative(destinationDirectoryRelative, file.relativePath).replaceAll(
        '\\',
        '/'
      );
      if (!isSafeWorkspaceRelativePath(memberPath)) {
        throw new Error('Every projection file must remain inside one object directory.');
      }
      const content =
        file.text !== undefined ? Buffer.from(file.text, 'utf8') : Buffer.from(file.bytes);
      const candidatePath = join(candidateDirectory, memberPath);
      await mkdir(dirname(candidatePath), { recursive: true });
      await writeFile(candidatePath, content, { mode: 0o600, flag: 'wx' });
    }
    if (!input.deferReadbackUntilValidation) {
      await assertDirectoryMatchesPlan(
        candidateDirectory,
        input.plan,
        destinationDirectoryRelative
      );
    }
    await input.onInstallState?.('staged');
    await testHooks.afterStaging?.(candidateDirectory);

    await mkdir(dirname(destinationDirectory), { recursive: true });
    const destinationExists = existsSync(destinationDirectory);
    if (destinationExists) {
      const destinationStat = await lstat(destinationDirectory);
      if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
        throw new Error('Projection destination must be a regular workspace directory.');
      }
      if (
        await directoryMatchesPlan(destinationDirectory, input.plan, destinationDirectoryRelative)
      ) {
        const receipt = projectionReceiptForPlan(input);
        await input.onInstallState?.('installed');
        return receipt;
      }
      const rollback = input.allocation?.rollback;
      if (rollback?.kind === 'displaced') {
        const actualFingerprint = await fingerprintExistingDestination(
          workspacePath,
          destinationDirectoryRelative
        );
        if (JSON.stringify(actualFingerprint) !== JSON.stringify(rollback.expectedExistingState)) {
          throw new Error('Package structural replacement precondition changed.');
        }
        backupDirectory = resolve(workspacePath, rollback.backupRelativePath);
        assertContainedPath(workspacePath, backupDirectory);
        await mkdir(dirname(backupDirectory), { recursive: true });
        if (await pathEntryExists(backupDirectory)) {
          throw new Error('Package rollback destination is already occupied.');
        }
        retainBackup = true;
      } else if (input.allocation?.expectedPriorImportedHash) {
        const priorHash = await projectionDirectoryHash(
          destinationDirectory,
          destinationDirectoryRelative
        );
        if (`sha256:${priorHash}` !== input.allocation.expectedPriorImportedHash) {
          throw new Error('Package replacement content changed after the import decision.');
        }
        backupDirectory = resolve(
          workspacePath,
          `.dnaforge/migration/rollback/${input.actionId ?? input.runId}/${input.sourceObjectId}-${basename(
            destinationDirectoryRelative
          )}`
        );
        assertContainedPath(workspacePath, backupDirectory);
        await mkdir(dirname(backupDirectory), { recursive: true });
        if (await pathEntryExists(backupDirectory)) {
          throw new Error('Package rollback destination is already occupied.');
        }
        retainBackup = true;
      }
      await rename(destinationDirectory, backupDirectory);
      await testHooks.afterDisplacement?.(destinationDirectory);
    }

    try {
      await rename(candidateDirectory, destinationDirectory);
      await testHooks.afterPackageRename?.(destinationDirectory);
      await testHooks.afterCandidateInstall?.(destinationDirectory);
      if (!input.deferReadbackUntilValidation || testHooks.afterCandidateInstall) {
        await assertDirectoryMatchesPlan(
          destinationDirectory,
          input.plan,
          destinationDirectoryRelative
        );
      }
    } catch (error) {
      let rollbackError: unknown = null;
      if (existsSync(destinationDirectory)) {
        try {
          await rm(destinationDirectory, { recursive: true, force: true });
        } catch (candidateRemovalError) {
          rollbackError = candidateRemovalError;
        }
      }
      if (rollbackError === null && existsSync(backupDirectory)) {
        try {
          await rename(backupDirectory, destinationDirectory);
        } catch (backupRestoreError) {
          rollbackError = backupRestoreError;
        }
      }
      if (rollbackError !== null) {
        preserveStagingRoot = true;
        throw new AggregateError(
          [error, rollbackError],
          'Projection install failed and its prior object could not be restored.'
        );
      }
      throw error;
    }

    if (!retainBackup) await rm(backupDirectory, { recursive: true, force: true });
    const receipt = projectionReceiptForPlan(input);
    await input.onInstallState?.('installed');
    return receipt;
  } finally {
    if (!preserveStagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}

async function writeDirectProjectionFile(
  input: {
    workspacePath: string;
    runId: string;
    actionId?: string;
    sourceObjectId: string;
    plan: ProjectionPlan;
    allocation?: BenchlingMigrationActionAllocation;
    createdAt: string;
    deferReadbackUntilValidation?: boolean;
    onInstallState?: (state: ProjectionInstallState) => void | Promise<void>;
  },
  testHooks: ProjectionWriterTestHooks
): Promise<ProjectionReceipt> {
  if (input.plan.destination.kind !== 'file' || input.plan.files.length !== 1) {
    throw new Error('Direct-file projection must contain exactly one allocated file.');
  }
  const workspacePath = resolve(input.workspacePath);
  const relativePath = input.plan.destination.relativePath;
  const destinationPath = resolve(workspacePath, relativePath);
  assertContainedPath(workspacePath, destinationPath);
  await assertNoSymlinkSegments(workspacePath, dirname(relativePath));
  await mkdir(dirname(destinationPath), { recursive: true });

  const file = input.plan.files[0];
  const bytes = file.text !== undefined ? Buffer.from(file.text, 'utf8') : Buffer.from(file.bytes);
  const candidatePath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.${randomUUID()}.dnaforge-migration.tmp`
  );
  let backupPath: string | null = null;
  let installed = false;
  try {
    await writeFile(candidatePath, bytes, { mode: 0o600, flag: 'wx' });
    const stagedBytes = await readFile(candidatePath);
    if (!stagedBytes.equals(bytes)) throw new Error('Direct-file staging read-back changed bytes.');
    await input.onInstallState?.('staged');
    await testHooks.afterStaging?.(candidatePath);

    const existingFingerprint = await fingerprintExistingDestination(workspacePath, relativePath);
    if (existingFingerprint) {
      const expectedPriorHash = input.allocation?.expectedPriorImportedHash ?? null;
      const rollback = input.allocation?.rollback;
      if (rollback?.kind === 'displaced') {
        if (
          JSON.stringify(existingFingerprint) !== JSON.stringify(rollback.expectedExistingState)
        ) {
          throw new Error('Direct-file structural replacement precondition changed.');
        }
        backupPath = resolve(workspacePath, rollback.backupRelativePath);
      } else if (expectedPriorHash) {
        if (existingFingerprint.kind !== 'file') {
          throw new Error('Direct-file replacement expected a regular file.');
        }
        const installedBytes = await readFile(destinationPath);
        const installedProjectionHash = `sha256:${hashProjectionFiles([
          { relativePath, bytes: installedBytes },
        ])}`;
        const installedScientificHash = scientificHashForDirectFile(relativePath, installedBytes);
        if (
          installedProjectionHash !== expectedPriorHash &&
          installedScientificHash !== expectedPriorHash
        ) {
          throw new Error('Direct-file replacement content changed after the import decision.');
        }
        backupPath = resolve(
          workspacePath,
          `.dnaforge/migration/rollback/${input.actionId ?? input.runId}/${input.sourceObjectId}-${basename(relativePath)}`
        );
      } else {
        const installedHash =
          existingFingerprint.kind === 'file'
            ? `sha256:${hashProjectionFiles([
                { relativePath, bytes: await readFile(destinationPath) },
              ])}`
            : null;
        if (installedHash === `sha256:${input.plan.destinationHash}`) {
          const receipt = projectionReceiptForPlan(input);
          await input.onInstallState?.('installed');
          return receipt;
        }
        throw new Error('Direct-file destination appeared after allocation.');
      }
      assertContainedPath(workspacePath, backupPath);
      await mkdir(dirname(backupPath), { recursive: true });
      if (await pathEntryExists(backupPath)) {
        throw new Error('Direct-file rollback destination is already occupied.');
      }
      await rename(destinationPath, backupPath);
      await testHooks.afterDisplacement?.(destinationPath);
    }

    if (await pathEntryExists(destinationPath)) {
      throw new Error('Direct-file destination appeared immediately before installation.');
    }
    await rename(candidatePath, destinationPath);
    installed = true;
    await testHooks.afterFileRename?.(destinationPath);
    if (!input.deferReadbackUntilValidation || testHooks.afterFileRename) {
      const installedBytes = await readFile(destinationPath);
      if (!installedBytes.equals(bytes)) {
        throw new Error('Direct-file installed bytes do not match the staged candidate.');
      }
    }
    const receipt = projectionReceiptForPlan(input);
    await input.onInstallState?.('installed');
    return receipt;
  } catch (error) {
    let rollbackError: unknown = null;
    if (installed && (await pathEntryExists(destinationPath))) {
      try {
        const installedBytes = await readFile(destinationPath);
        if (
          hashProjectionFiles([{ relativePath, bytes: installedBytes }]) ===
          input.plan.destinationHash
        ) {
          await rm(destinationPath, { force: true });
        } else {
          rollbackError = new Error(
            'Direct-file rollback preserved bytes changed after installation.'
          );
        }
      } catch (candidateRollbackError) {
        rollbackError = candidateRollbackError;
      }
    }
    if (rollbackError === null && backupPath && (await pathEntryExists(backupPath))) {
      try {
        if (await pathEntryExists(destinationPath)) {
          rollbackError = new Error('Direct-file rollback destination is occupied.');
        } else {
          await rename(backupPath, destinationPath);
        }
      } catch (backupRollbackError) {
        rollbackError = backupRollbackError;
      }
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Direct-file installation failed and rollback could not complete safely.'
      );
    }
    throw error;
  } finally {
    await rm(candidatePath, { force: true });
  }
}

function scientificHashForDirectFile(
  relativePath: string,
  bytes: Buffer
): `sha256:${string}` | null {
  if (!/\.(?:gb|gbk|genbank)$/iu.test(relativePath)) return null;
  try {
    return dnaBasesScientificFingerprint(parseGenBankFull(bytes.toString('utf8')).sequence);
  } catch {
    return null;
  }
}

export async function writeFreshProjectionBatch(input: {
  workspacePath: string;
  items: readonly FreshProjectionBatchItem[];
}): Promise<ProjectionReceipt[]> {
  if (input.items.length === 0) return [];

  input = {
    ...input,
    items: await Promise.all(
      input.items.map(async (item) => ({
        ...item,
        plan: await hydrateProjectionPlanAssets(input.workspacePath, item.plan),
      }))
    ),
  };

  const workspacePath = resolve(input.workspacePath);
  const workspaceStats = await lstat(workspacePath);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new Error('Migration workspace must be a regular directory.');
  }

  const objectDirectoryKeys = new Set<string>();
  const filePathKeys = new Set<string>();
  for (const item of input.items) {
    validateProjectionPlanPaths(item.plan);
    if (item.plan.destination.kind !== 'package') {
      throw new Error('Fresh legacy projection batch accepts package destinations only.');
    }
    const directory = item.plan.destination.rootRelativePath;
    const directoryKey = directory.normalize('NFC').toLowerCase();
    if (objectDirectoryKeys.has(directoryKey)) {
      throw new Error(`Fresh projection object directory collision: ${directory}`);
    }
    objectDirectoryKeys.add(directoryKey);
    for (const file of item.plan.files) {
      const fileKey = file.relativePath.normalize('NFC').toLowerCase();
      if (filePathKeys.has(fileKey)) {
        throw new Error(`Fresh projection path collision: ${file.relativePath}`);
      }
      filePathKeys.add(fileKey);
    }
  }

  const destinationRoot = resolve(workspacePath, 'Benchling Imports');
  assertContainedPath(workspacePath, destinationRoot);
  await assertNoSymlinkSegments(workspacePath, 'Benchling Imports');
  if (await pathEntryExists(destinationRoot)) {
    throw new Error('Fresh projection requires an empty Benchling Imports destination.');
  }

  const operationId = randomUUID();
  const stagingRoot = join(
    workspacePath,
    '.dnaforge',
    'migration',
    'projection-staging',
    operationId
  );
  const candidateWorkspace = join(stagingRoot, 'candidate-workspace');
  const candidateRoot = join(candidateWorkspace, 'Benchling Imports');
  const files = input.items.flatMap((item) => item.plan.files);
  const receipts = input.items.map((item) => projectionReceiptForPlan(item));

  try {
    for (let offset = 0; offset < files.length; offset += FRESH_PROJECTION_FILE_CONCURRENCY) {
      const chunk = files.slice(offset, offset + FRESH_PROJECTION_FILE_CONCURRENCY);
      await Promise.all(
        chunk.map(async (file) => {
          const candidatePath = resolve(candidateWorkspace, file.relativePath);
          assertContainedPath(candidateWorkspace, candidatePath);
          const content =
            file.text !== undefined ? Buffer.from(file.text, 'utf8') : Buffer.from(file.bytes);
          await mkdir(dirname(candidatePath), { recursive: true });
          await writeFile(candidatePath, content, { mode: 0o600, flag: 'wx' });
        })
      );
    }

    const candidateStats = await lstat(candidateRoot);
    if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
      throw new Error('Fresh projection candidate root must be a regular directory.');
    }
    if (await pathEntryExists(destinationRoot)) {
      throw new Error('Fresh projection destination appeared before installation.');
    }
    await rename(candidateRoot, destinationRoot);
    return receipts;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function hydrateProjectionPlanAssets(
  workspacePathInput: string,
  plan: ProjectionPlan,
  external?: ExternalProjectionAssets
): Promise<ProjectionPlan> {
  if (!plan.attachmentAssets?.length) return plan;
  const workspacePath = resolve(workspacePathInput);
  const files = [...plan.files];
  for (const asset of plan.attachmentAssets) {
    if (!/^[a-f0-9]{64}$/u.test(asset.archiveSha256)) {
      throw new Error('Projection attachment archive hash is invalid.');
    }
    if (!isSafeWorkspaceRelativePath(asset.relativePath)) {
      throw new Error('Projection attachment destination is unsafe.');
    }
    if (external) {
      const candidates = external.sources.flatMap(({ source, entries }) =>
        entries
          .filter(
            (entry) =>
              entry.sourceId === source.sourceId &&
              entry.sourceObjectId === external.sourceObjectId &&
              entry.entrySha256 === `sha256:${asset.archiveSha256}`
          )
          .map((entry) => ({ source, entry }))
      );
      const candidate = candidates[0];
      if (!candidate) throw new Error('Projection attachment has no verified external source.');
      await verifyExternalZipSource(candidate.source);
      const archive = await inspectNativeExportArchive(externalZipDecoderSource(candidate.source));
      const result = await readNativeExportArchiveEntryPreview(
        archive,
        candidate.entry.entryPath,
        Math.max(1, candidate.entry.sizeBytes)
      );
      if (
        result.truncated ||
        result.evidence.sha256 !== candidate.entry.entrySha256 ||
        result.evidence.actualSize !== candidate.entry.sizeBytes
      )
        throw new Error('Projection attachment failed external source integrity verification.');
      files.push({ relativePath: asset.relativePath, bytes: Buffer.from(result.bytes) });
      continue;
    }
    const archivePath = resolve(
      workspacePath,
      '.dnaforge',
      'migration',
      'archive',
      'blobs',
      'sha256',
      asset.archiveSha256.slice(0, 2),
      asset.archiveSha256
    );
    assertContainedPath(workspacePath, archivePath);
    await assertNoSymlinkSegmentsExisting(
      workspacePath,
      relative(workspacePath, archivePath).replaceAll('\\', '/'),
      'file'
    );
    const bytes = await readFile(archivePath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== asset.archiveSha256) {
      throw new Error(`Projection attachment failed integrity verification: ${asset.relativePath}`);
    }
    files.push({ relativePath: asset.relativePath, bytes });
  }
  return {
    ...plan,
    files,
    attachmentAssets: undefined,
    destinationHash: hashProjectionFiles(files),
  };
}

export async function verifyProjectionReceiptIntegrity(input: {
  workspacePath: string;
  receipts: readonly ProjectionReceipt[];
  destinationArtifacts?: ProjectionIntegrityDestinationArtifacts;
  preservedDestinationPaths?: readonly {
    path: string;
    kind: 'file' | 'directory';
  }[];
  onProgress?: (progress: Readonly<{ completed: number; total: number }>) => void;
}): Promise<ProjectionIntegrityEvidence> {
  const workspacePath = resolve(input.workspacePath);
  const failures: ProjectionIntegrityFailure[] = [];
  const artifacts: ValidationDestinationArtifactEvidence[] = [];
  const expectedImportFiles = new Set<string>();
  const expectedImportDirectories = new Set<string>();
  const check = async (
    context: Omit<ProjectionIntegrityFailure, 'message'>,
    operation: () => Promise<void> | void
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push({
        ...context,
        message: projectionIntegrityFailureMessage(error, workspacePath),
      });
    }
  };

  const regularDirectories = new Set<string>();
  const registryByPath = new Map<string, ProjectionReceipt[]>();
  const regularChecks: Array<{
    receipt: ProjectionReceipt;
    kind: 'file' | 'package' | 'catalog-record';
    directory: string | null;
    preflightFailure: ProjectionIntegrityFailure | null;
  }> = [];
  for (const receipt of input.receipts) {
    if (receipt.converterId === BENCHLING_REGISTRY_CONVERTER_ID) {
      const receipts = registryByPath.get(receipt.destinationPath) ?? [];
      receipts.push(receipt);
      registryByPath.set(receipt.destinationPath, receipts);
      continue;
    }
    try {
      const destination = receipt.destination;
      if (destination?.kind === 'catalog-record') {
        regularChecks.push({
          receipt,
          kind: 'catalog-record',
          directory: null,
          preflightFailure: null,
        });
        continue;
      }
      const destinationPath = destination
        ? projectionDestinationPrimaryPath(destination)
        : receipt.destinationPath;
      if (!isSafeWorkspaceRelativePath(destinationPath)) {
        throw new Error(`Unsafe projection destination on receipt ${receipt.id}.`);
      }
      if (destination?.kind === 'file') {
        regularChecks.push({ receipt, kind: 'file', directory: null, preflightFailure: null });
        continue;
      }
      const directory =
        destination?.kind === 'package'
          ? destination.rootRelativePath
          : projectionObjectDirectory(destinationPath);
      if (regularDirectories.has(directory)) {
        throw new Error(`Projection directory ${directory} is not uniquely receipted.`);
      }
      regularDirectories.add(directory);
      regularChecks.push({ receipt, kind: 'package', directory, preflightFailure: null });
    } catch (error) {
      regularChecks.push({
        receipt,
        kind: 'package',
        directory: null,
        preflightFailure: {
          ...receiptContext(receipt),
          message: projectionIntegrityFailureMessage(error, workspacePath),
        },
      });
    }
  }

  const totalReceiptCount = input.receipts.length;
  let completedReceiptCount = 0;
  input.onProgress?.({ completed: 0, total: totalReceiptCount });
  const advanceProgress = (count: number): void => {
    completedReceiptCount += count;
    input.onProgress?.({ completed: completedReceiptCount, total: totalReceiptCount });
  };
  const regularResults = await mapAtFixedConcurrency(
    regularChecks,
    PROJECTION_INTEGRITY_CONCURRENCY,
    async ({ receipt, kind, directory, preflightFailure }) => {
      try {
        if (preflightFailure) return { failure: preflightFailure, projectionFiles: [] as string[] };
        if (kind === 'catalog-record') {
          return { failure: null, projectionFiles: [] as string[] };
        }
        if (kind === 'package' && directory === null) {
          throw new Error('Package projection receipt has no package root.');
        }
        const projectionFiles =
          kind === 'file'
            ? await assertDirectProjectionMatchesReceipt(workspacePath, receipt)
            : await assertRegularProjectionMatchesReceipt(
                workspacePath,
                requireProjectionDirectory(directory),
                receipt
              );
        return {
          failure: null,
          projectionFiles,
          artifact: {
            kind: 'projection_bundle' as const,
            path: receipt.destination
              ? projectionDestinationPrimaryPath(receipt.destination)
              : receipt.destinationPath,
            sha256: receipt.destinationHash,
          },
        };
      } catch (error) {
        return {
          failure: {
            ...receiptContext(receipt),
            message: projectionIntegrityFailureMessage(error, workspacePath),
          },
          projectionFiles: [] as string[],
        };
      } finally {
        advanceProgress(1);
      }
    }
  );
  for (const result of regularResults) {
    if (result.failure) {
      failures.push(result.failure);
      continue;
    }
    for (const path of result.projectionFiles) {
      if (isLegacyBenchlingImportPath(path)) {
        addExpectedImportFile(path, expectedImportFiles, expectedImportDirectories);
      }
    }
    if (result.artifact) artifacts.push(result.artifact);
  }

  if (
    registryByPath.size > 0 ||
    (await pathEntryExists(join(workspacePath, BENCHLING_REGISTRY_PROJECTION_DIRECTORY)))
  ) {
    try {
      await check(emptyContext(), async () => {
        const documents = await readBenchlingRegistryProjectionDocuments(workspacePath);
        if (documents.length !== registryByPath.size) {
          throw new Error('Registry projection files do not exactly match their receipts.');
        }
        for (const [destinationPath, receipts] of registryByPath) {
          await assertRegistryReceiptPath(workspacePath, destinationPath, receipts);
          artifacts.push({
            kind: 'registry_projection',
            path: destinationPath,
            sha256: receipts[0].destinationHash,
          });
        }
      });
    } finally {
      advanceProgress(
        [...registryByPath.values()].reduce((count, receipts) => count + receipts.length, 0)
      );
    }
  }

  const destinationArtifacts = input.destinationArtifacts;
  if (destinationArtifacts) {
    await check(emptyContext(), () => {
      for (const path of destinationArtifacts.collectionDocumentPaths) {
        if (isLegacyBenchlingImportPath(path)) {
          addExpectedImportFile(path, expectedImportFiles, expectedImportDirectories);
        }
      }
      for (const path of destinationArtifacts.nativeFolderPaths ?? []) {
        if (isLegacyBenchlingImportPath(path)) {
          addExpectedImportFile(`${path}/.gitkeep`, expectedImportFiles, expectedImportDirectories);
        }
      }
    });
    await check(emptyContext(), async () => {
      for (const path of destinationArtifacts.nativeFolderPaths ?? []) {
        artifacts.push(
          await hashRegularDestinationArtifact(workspacePath, 'native_folder', `${path}/.gitkeep`)
        );
      }
    });
    await check(emptyContext(), async () => {
      artifacts.push(
        await hashRegularDestinationArtifact(
          workspacePath,
          'destination_link_index',
          MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH
        )
      );
    });
    await verifyCollectionDestinationArtifacts(
      workspacePath,
      destinationArtifacts.collectionDocumentPaths,
      artifacts,
      failures
    );
    await check(emptyContext(), async () => {
      for (const preserved of input.preservedDestinationPaths ?? []) {
        if (!isSafeWorkspaceRelativePath(preserved.path)) {
          throw new Error(`Preserved destination is unsafe: ${preserved.path}`);
        }
        if (preserved.kind === 'file') {
          await assertNoSymlinkSegmentsExisting(workspacePath, preserved.path, 'file');
          if (isLegacyBenchlingImportPath(preserved.path))
            addExpectedImportFile(preserved.path, expectedImportFiles, expectedImportDirectories);
          continue;
        }
        const tree = await listRegularDestinationTree(workspacePath, preserved.path);
        for (const directory of tree.directories) {
          if (isLegacyBenchlingImportPath(directory))
            addExpectedImportDirectory(directory, expectedImportDirectories);
        }
        for (const file of tree.files) {
          if (isLegacyBenchlingImportPath(file))
            addExpectedImportFile(file, expectedImportFiles, expectedImportDirectories);
        }
      }
    });
    await check(emptyContext(), async () => {
      await assertClosedWorldBenchlingImports(
        workspacePath,
        expectedImportFiles,
        expectedImportDirectories
      );
    });
  }

  return {
    destinationIntegrity: {
      schema: 'dnaforge.migration.destination-integrity.v1',
      ...projectionReceiptLedgerEvidence(input.receipts),
      artifacts: sortDestinationArtifacts(artifacts),
    },
    failures,
  };
}

function isLegacyBenchlingImportPath(relativePath: string): boolean {
  const normalized = relativePath.normalize('NFC').replace(/\\/gu, '/');
  return normalized === 'Benchling Imports' || normalized.startsWith('Benchling Imports/');
}

function requireProjectionDirectory(directory: string | null): string {
  if (directory === null) throw new Error('Projection receipt has no package root.');
  return directory;
}

export async function assertProjectionReceiptIntegrity(input: {
  workspacePath: string;
  receipts: readonly ProjectionReceipt[];
  destinationArtifacts?: ProjectionIntegrityDestinationArtifacts;
  preservedDestinationPaths?: readonly { path: string; kind: 'file' | 'directory' }[];
}): Promise<void> {
  const evidence = await verifyProjectionReceiptIntegrity(input);
  if (evidence.failures.length > 0) throw new ProjectionIntegrityError(evidence);
}

export async function assertProjectionReceiptDestinationIntegrity(input: {
  workspacePath: string;
  receipt: ProjectionReceipt;
}): Promise<void> {
  const workspacePath = resolve(input.workspacePath);
  const { receipt } = input;
  if (receipt.converterId === BENCHLING_REGISTRY_CONVERTER_ID) {
    await assertRegistryReceiptPath(workspacePath, receipt.destinationPath, [receipt]);
    return;
  }
  const destination = receipt.destination;
  if (destination?.kind === 'catalog-record') return;
  if (destination?.kind === 'file') {
    await assertDirectProjectionMatchesReceipt(workspacePath, receipt);
    return;
  }
  const destinationPath = destination
    ? projectionDestinationPrimaryPath(destination)
    : receipt.destinationPath;
  if (!isSafeWorkspaceRelativePath(destinationPath)) {
    throw new Error(`Unsafe projection destination on receipt ${receipt.id}.`);
  }
  const directory =
    destination?.kind === 'package'
      ? destination.rootRelativePath
      : projectionObjectDirectory(destinationPath);
  await assertRegularProjectionMatchesReceipt(workspacePath, directory, receipt);
}

export async function assertProjectionIntegrityMatchesEvidence(input: {
  workspacePath: string;
  receipts: readonly ProjectionReceipt[];
  expected: ValidationDestinationIntegrityEvidence;
}): Promise<void> {
  const collectionDocumentPaths = input.expected.artifacts
    .filter((artifact) => artifact.kind === 'native_collection')
    .map((artifact) => artifact.path);
  const nativeFolderPaths = input.expected.artifacts
    .filter((artifact) => artifact.kind === 'native_folder')
    .map((artifact) => dirname(artifact.path).replaceAll('\\', '/'));
  const actual = await verifyProjectionReceiptIntegrity({
    workspacePath: input.workspacePath,
    receipts: input.receipts,
    destinationArtifacts: { collectionDocumentPaths, nativeFolderPaths },
  });
  if (actual.failures.length > 0) throw new ProjectionIntegrityError(actual);
  if (canonicalJson(actual.destinationIntegrity) !== canonicalJson(input.expected)) {
    throw new ProjectionIntegrityError({
      ...actual,
      failures: [
        {
          receiptId: null,
          sourceObjectId: null,
          destinationPath: null,
          message:
            'Destination artifacts or the projection receipt ledger no longer match passing validation.',
        },
      ],
    });
  }
}

export function projectionReceiptLedgerEvidence(receipts: readonly ProjectionReceipt[]): {
  receiptCount: number;
  receiptLedgerSha256: string;
} {
  const canonicalReceipts = receipts.map((receipt) => canonicalJson(receipt)).sort();
  return {
    receiptCount: receipts.length,
    receiptLedgerSha256: createHash('sha256')
      .update(`[${canonicalReceipts.join(',')}]`)
      .digest('hex'),
  };
}

function receiptContext(receipt: ProjectionReceipt): Omit<ProjectionIntegrityFailure, 'message'> {
  return {
    receiptId: receipt.id,
    sourceObjectId: receipt.sourceObjectId,
    destinationPath: receipt.destinationPath,
  };
}

function emptyContext(): Omit<ProjectionIntegrityFailure, 'message'> {
  return { receiptId: null, sourceObjectId: null, destinationPath: null };
}

async function verifyCollectionDestinationArtifacts(
  workspacePath: string,
  collectionDocumentPathsInput: readonly string[],
  artifacts: ValidationDestinationArtifactEvidence[],
  failures: ProjectionIntegrityFailure[]
): Promise<void> {
  try {
    const collectionDocumentPaths = [...new Set(collectionDocumentPathsInput)].sort();
    if (collectionDocumentPaths.length !== collectionDocumentPathsInput.length) {
      throw new Error('Native collection destination paths are not unique.');
    }
    const manifestExists = await pathEntryExists(
      join(workspacePath, COLLECTION_PROJECTION_MANIFEST_PATH)
    );
    const collectionRoot = collectionDocumentPaths.some((path) =>
      path.startsWith(`${NATIVE_V2_COLLECTION_ROOT}/`)
    )
      ? NATIVE_V2_COLLECTION_ROOT
      : NATIVE_COLLECTION_ROOT;
    const collectionRootExists =
      (await pathEntryExists(join(workspacePath, NATIVE_COLLECTION_ROOT))) ||
      (await pathEntryExists(join(workspacePath, NATIVE_V2_COLLECTION_ROOT)));
    if (collectionDocumentPaths.length === 0) {
      if (manifestExists || collectionRootExists) {
        throw new Error('Unexpected collection projection artifacts are present.');
      }
      return;
    }
    for (const path of collectionDocumentPaths) {
      if (
        !isSafeWorkspaceRelativePath(path) ||
        !path.startsWith(`${collectionRoot}/`) ||
        (collectionRoot === NATIVE_V2_COLLECTION_ROOT &&
          !/^\.dnaforge\/migration\/collections\/folder-[a-f0-9]{24}\.json$/u.test(path))
      ) {
        throw new Error(`Unsafe native collection destination: ${path}`);
      }
    }

    artifacts.push(
      await hashRegularDestinationArtifact(
        workspacePath,
        'collection_projection_manifest',
        COLLECTION_PROJECTION_MANIFEST_PATH
      )
    );
    const actualCollectionPaths = await listRegularFilesRecursively(workspacePath, collectionRoot);
    if (canonicalJson(actualCollectionPaths) !== canonicalJson(collectionDocumentPaths)) {
      throw new Error(
        'Native collection files do not exactly match the deterministic collection manifest.'
      );
    }
    for (const path of collectionDocumentPaths) {
      artifacts.push(
        await hashRegularDestinationArtifact(workspacePath, 'native_collection', path)
      );
    }
  } catch (error) {
    failures.push({
      receiptId: null,
      sourceObjectId: null,
      destinationPath: null,
      message: projectionIntegrityFailureMessage(error, workspacePath),
    });
  }
}

async function hashRegularDestinationArtifact(
  workspacePath: string,
  kind: ValidationDestinationArtifactEvidence['kind'],
  relativePath: string
): Promise<ValidationDestinationArtifactEvidence> {
  if (!isSafeWorkspaceRelativePath(relativePath)) {
    throw new Error(`Unsafe destination artifact path: ${relativePath}`);
  }
  await assertNoSymlinkSegmentsExisting(workspacePath, relativePath, 'file');
  const bytes = await readFile(resolve(workspacePath, relativePath));
  return {
    kind,
    path: relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function listRegularFilesRecursively(
  workspacePath: string,
  relativeRoot: string
): Promise<string[]> {
  return (await listRegularDestinationTree(workspacePath, relativeRoot)).files;
}

async function mapAtFixedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function listRegularDestinationTree(
  workspacePath: string,
  relativeRoot: string
): Promise<{ files: string[]; directories: string[] }> {
  await assertNoSymlinkSegmentsExisting(workspacePath, relativeRoot, 'directory');
  const files: string[] = [];
  const directories: string[] = [];
  let frontier = [relativeRoot];
  while (frontier.length > 0) {
    const level = await mapAtFixedConcurrency(
      frontier,
      PROJECTION_INTEGRITY_CONCURRENCY,
      async (relativeDirectory) => {
        const absoluteDirectory = resolve(workspacePath, relativeDirectory);
        const directoryStats = await lstat(absoluteDirectory);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
          throw new Error(`Destination artifact path is not a directory: ${relativeDirectory}`);
        }
        const entries = (
          await readdir(absoluteDirectory, {
            withFileTypes: true,
          })
        ).sort((left, right) => left.name.localeCompare(right.name));
        const classified = await mapAtFixedConcurrency(
          entries,
          PROJECTION_DIRECTORY_ENTRY_CONCURRENCY,
          async (entry) => {
            const relativePath = `${relativeDirectory}/${entry.name}`;
            const stats = await lstat(resolve(workspacePath, relativePath));
            if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
              throw new Error(`Destination artifact path contains a symlink: ${relativePath}`);
            }
            if (entry.isDirectory() && stats.isDirectory()) {
              return { kind: 'directory' as const, relativePath };
            }
            if (entry.isFile() && stats.isFile()) {
              return { kind: 'file' as const, relativePath };
            }
            throw new Error(`Destination artifact is not a regular file: ${relativePath}`);
          }
        );
        return { relativeDirectory, classified };
      }
    );
    const nextFrontier: string[] = [];
    for (const { relativeDirectory, classified } of level) {
      directories.push(relativeDirectory);
      for (const entry of classified) {
        if (entry.kind === 'directory') nextFrontier.push(entry.relativePath);
        else files.push(entry.relativePath);
      }
    }
    frontier = nextFrontier.sort();
  }
  return { files: files.sort(), directories: directories.sort() };
}

async function assertClosedWorldBenchlingImports(
  workspacePath: string,
  expectedFiles: ReadonlySet<string>,
  expectedDirectories: ReadonlySet<string>
): Promise<void> {
  const rootPath = join(workspacePath, 'Benchling Imports');
  let rootStats: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStats = await lstat(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && expectedFiles.size === 0) return;
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Benchling Imports must be a regular destination directory.');
  }
  const actual = await listRegularDestinationTree(workspacePath, 'Benchling Imports');
  const expectedFileList = [...expectedFiles].sort();
  const expectedDirectoryList = [...expectedDirectories].sort();
  if (
    canonicalJson(actual.files) !== canonicalJson(expectedFileList) ||
    canonicalJson(actual.directories) !== canonicalJson(expectedDirectoryList)
  ) {
    const unexpected = [
      ...actual.files.filter((path) => !expectedFiles.has(path)),
      ...actual.directories.filter((path) => !expectedDirectories.has(path)),
    ].slice(0, 5);
    const missing = [
      ...expectedFileList.filter((path) => !actual.files.includes(path)),
      ...expectedDirectoryList.filter((path) => !actual.directories.includes(path)),
    ].slice(0, 5);
    throw new Error(
      `Benchling Imports contains destination files or directories without validated receipts. Unexpected: ${unexpected.join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}.`
    );
  }
}

function addExpectedImportFile(
  relativePath: string,
  files: Set<string>,
  directories: Set<string>
): void {
  if (
    !isSafeWorkspaceRelativePath(relativePath) ||
    !relativePath.startsWith('Benchling Imports/')
  ) {
    throw new Error(`Destination file is outside Benchling Imports: ${relativePath}`);
  }
  files.add(relativePath);
  let directory = dirname(relativePath).replaceAll('\\', '/');
  while (directory === 'Benchling Imports' || directory.startsWith('Benchling Imports/')) {
    directories.add(directory);
    if (directory === 'Benchling Imports') break;
    directory = dirname(directory).replaceAll('\\', '/');
  }
}

function addExpectedImportDirectory(relativePath: string, directories: Set<string>): void {
  if (
    !isSafeWorkspaceRelativePath(relativePath) ||
    !relativePath.startsWith('Benchling Imports/')
  ) {
    throw new Error(`Destination directory is outside Benchling Imports: ${relativePath}`);
  }
  let directory = relativePath;
  while (directory === 'Benchling Imports' || directory.startsWith('Benchling Imports/')) {
    directories.add(directory);
    if (directory === 'Benchling Imports') break;
    directory = dirname(directory).replaceAll('\\', '/');
  }
}

function sortDestinationArtifacts(
  artifacts: readonly ValidationDestinationArtifactEvidence[]
): ValidationDestinationArtifactEvidence[] {
  return [...artifacts].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.kind.localeCompare(right.kind) ||
      left.sha256.localeCompare(right.sha256)
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
}

function projectionIntegrityFailureMessage(error: unknown, workspacePath: string): string {
  const message = error instanceof Error ? error.message : 'Projection integrity check failed.';
  return message.replaceAll(workspacePath, '<workspace>');
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoSymlinkSegmentsExisting(
  workspacePath: string,
  relativePath: string,
  finalKind: 'file' | 'directory'
): Promise<void> {
  if (!isSafeWorkspaceRelativePath(relativePath)) {
    throw new Error(`Unsafe destination artifact path: ${relativePath}`);
  }
  const workspaceStats = await lstat(workspacePath);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new Error('Migration workspace must be a regular directory.');
  }
  let current = workspacePath;
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Destination artifact path contains a symlink: ${segment}`);
    }
    const isFinal = index === segments.length - 1;
    if (!isFinal && !stats.isDirectory()) {
      throw new Error(`Destination artifact parent is not a directory: ${segment}`);
    }
    if (isFinal && finalKind === 'file' && !stats.isFile()) {
      throw new Error(`Destination artifact is not a regular file: ${relativePath}`);
    }
    if (isFinal && finalKind === 'directory' && !stats.isDirectory()) {
      throw new Error(`Destination artifact is not a regular directory: ${relativePath}`);
    }
  }
}

async function assertRegularProjectionMatchesReceipt(
  workspacePath: string,
  directoryRelative: string,
  receipt: ProjectionReceipt
): Promise<string[]> {
  const primaryPath = receipt.destination
    ? projectionDestinationPrimaryPath(receipt.destination)
    : receipt.destinationPath;
  if (!isSafeWorkspaceRelativePath(primaryPath)) {
    throw new Error(`Unsafe projection destination on receipt ${receipt.id}.`);
  }
  const directory = resolve(workspacePath, directoryRelative);
  assertContainedPath(workspacePath, directory);
  const tree = await listRegularDestinationTree(workspacePath, directoryRelative);
  if (!tree.files.includes(primaryPath)) {
    throw new Error(`Primary projection file ${primaryPath} is missing.`);
  }
  assertNoEmptyProjectionDirectories(tree, directoryRelative);
  const files: ProjectionFile[] = await Promise.all(
    tree.files.map(async (relativePath) => ({
      relativePath,
      bytes: await readFile(resolve(workspacePath, relativePath)),
    }))
  );
  if (hashProjectionFiles(files) !== receipt.destinationHash) {
    throw new Error(`Destination bytes no longer match receipt ${receipt.id}.`);
  }
  return files.map((file) => file.relativePath).sort();
}

async function assertDirectProjectionMatchesReceipt(
  workspacePath: string,
  receipt: ProjectionReceipt
): Promise<string[]> {
  if (receipt.destination?.kind !== 'file') {
    throw new Error('Direct projection receipt has no file destination.');
  }
  const relativePath = receipt.destination.relativePath;
  await assertNoSymlinkSegmentsExisting(workspacePath, relativePath, 'file');
  const bytes = await readFile(resolve(workspacePath, relativePath));
  if (hashProjectionFiles([{ relativePath, bytes }]) !== receipt.destinationHash) {
    throw new Error(`Destination bytes no longer match receipt ${receipt.id}.`);
  }
  return [relativePath];
}

async function assertRegistryReceiptPath(
  workspacePath: string,
  destinationPath: string,
  receipts: readonly ProjectionReceipt[]
): Promise<void> {
  if (!isSafeWorkspaceRelativePath(destinationPath)) {
    throw new Error(`Unsafe registry projection destination: ${destinationPath}`);
  }
  const expectedHashes = new Set(receipts.map((receipt) => receipt.destinationHash));
  if (expectedHashes.size !== 1) {
    throw new Error(
      `Shared registry projection ${destinationPath} has conflicting receipt hashes.`
    );
  }
  const expectedHash = [...expectedHashes][0];
  if (
    dirname(destinationPath).replaceAll('\\', '/') !== BENCHLING_REGISTRY_PROJECTION_DIRECTORY ||
    relative(BENCHLING_REGISTRY_PROJECTION_DIRECTORY, destinationPath) !==
      `registry-${expectedHash}.json`
  ) {
    throw new Error('Registry projection path is not bound to its receipt hash.');
  }
  const path = resolve(workspacePath, destinationPath);
  assertContainedPath(workspacePath, path);
  await assertNoSymlinkSegmentsExisting(workspacePath, destinationPath, 'file');
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Registry projection ${destinationPath} must be a regular file.`);
  }
}

function validateProjectionPlanPaths(plan: ProjectionPlan): void {
  const destination = validateProjectionDestination(plan.destination);
  if (destination.kind === 'catalog-record') {
    if (plan.files.length !== 0 || !plan.catalogPayload) {
      throw new Error('Catalog-record projection must contain a payload and no files.');
    }
    return;
  }
  const destinationDirectory =
    destination.kind === 'package'
      ? destination.rootRelativePath
      : dirname(destination.relativePath).replaceAll('\\', '/');
  const collisionKeys = new Set<string>();
  for (const file of plan.files) {
    if (!isSafeWorkspaceRelativePath(file.relativePath)) {
      throw new Error(`Unsafe projection file path: ${file.relativePath}`);
    }
    if (
      destination.kind === 'package' &&
      file.relativePath !== destinationDirectory &&
      !file.relativePath.startsWith(`${destinationDirectory}/`)
    ) {
      throw new Error('A package projection may write only inside its allocated root.');
    }
    if (destination.kind === 'file' && file.relativePath !== destination.relativePath) {
      throw new Error('A direct-file projection may write only its allocated file.');
    }
    const collisionKey = file.relativePath.normalize('NFC').toLowerCase();
    if (collisionKeys.has(collisionKey)) {
      throw new Error(`Projection path collision: ${file.relativePath}`);
    }
    collisionKeys.add(collisionKey);
  }
  if (
    destination.kind === 'file' &&
    (plan.files.length !== 1 || plan.files[0]?.relativePath !== destination.relativePath)
  ) {
    throw new Error('Direct-file projection does not contain its declared destination file.');
  }
  if (
    destination.kind === 'package' &&
    !plan.files.some((file) => file.relativePath === destination.primaryRelativePath)
  ) {
    throw new Error('Projection plan does not contain its declared destination file.');
  }
  if (hashProjectionFiles(plan.files) !== plan.destinationHash) {
    throw new Error('Projection plan destination hash is invalid.');
  }
}

async function directoryMatchesPlan(
  directory: string,
  plan: ProjectionPlan,
  destinationDirectoryRelative: string
): Promise<boolean> {
  try {
    await assertDirectoryMatchesPlan(directory, plan, destinationDirectoryRelative);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectoryMatchesPlan(
  directory: string,
  plan: ProjectionPlan,
  destinationDirectoryRelative: string
): Promise<void> {
  const tree = await readProjectionDirectoryTree(directory, destinationDirectoryRelative);
  const expectedPaths = plan.files
    .map((file) => file.relativePath)
    .sort((left, right) => left.localeCompare(right));
  if (canonicalJson(tree.files.map((file) => file.relativePath)) !== canonicalJson(expectedPaths)) {
    throw new Error(
      `Projection directory file set does not match its plan. Expected ${canonicalJson(expectedPaths)}; received ${canonicalJson(tree.files.map((file) => file.relativePath))}.`
    );
  }
  const expectedDirectories = projectionDirectoriesForFiles(
    destinationDirectoryRelative,
    expectedPaths
  );
  if (canonicalJson(tree.directories) !== canonicalJson(expectedDirectories)) {
    throw new Error('Projection directory structure does not match its plan.');
  }
  if (hashProjectionFiles(tree.files) !== plan.destinationHash) {
    throw new Error('Projected file read-back hash does not match the plan.');
  }
}

async function projectionDirectoryHash(
  directory: string,
  destinationDirectoryRelative: string
): Promise<string> {
  const tree = await readProjectionDirectoryTree(directory, destinationDirectoryRelative);
  return hashProjectionFiles(tree.files);
}

async function readProjectionDirectoryTree(
  directory: string,
  directoryRelative: string
): Promise<{ files: ProjectionFile[]; directories: string[] }> {
  const files: ProjectionFile[] = [];
  const directories = [directoryRelative];
  const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const absolutePath = join(absoluteDirectory, entry.name);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const stats = await lstat(absolutePath);
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw new Error(`Projected path is a symlink: ${relativePath}`);
      }
      if (entry.isDirectory() && stats.isDirectory()) {
        directories.push(relativePath);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() && stats.isFile()) {
        files.push({ relativePath, bytes: await readFile(absolutePath) });
      } else {
        throw new Error(`Projected path is not a regular file: ${relativePath}`);
      }
    }
  };
  await visit(directory, directoryRelative);
  return {
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    directories: directories.sort(),
  };
}

function projectionDirectoriesForFiles(root: string, files: readonly string[]): string[] {
  const directories = new Set([root]);
  for (const file of files) {
    let directory = dirname(file).replaceAll('\\', '/');
    while (directory === root || directory.startsWith(`${root}/`)) {
      directories.add(directory);
      if (directory === root) break;
      directory = dirname(directory).replaceAll('\\', '/');
    }
  }
  return [...directories].sort();
}

function assertNoEmptyProjectionDirectories(
  tree: { files: readonly string[]; directories: readonly string[] },
  root: string
): void {
  for (const directory of tree.directories) {
    if (directory === root) continue;
    if (!tree.files.some((file) => file.startsWith(`${directory}/`))) {
      throw new Error(`Projection directory is unexpectedly empty: ${directory}`);
    }
  }
}

function projectionObjectDirectory(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (
    !isSafeWorkspaceRelativePath(normalized) ||
    parts.length < 3 ||
    parts[0] !== 'Benchling Imports' ||
    !parts[1]
  ) {
    throw new Error('Projection destination path is not workspace-relative.');
  }
  return `${parts[0]}/${parts[1]}`;
}

async function assertNoSymlinkSegments(
  workspacePath: string,
  destinationDirectoryRelative: string
): Promise<void> {
  let current = workspacePath;
  for (const segment of destinationDirectoryRelative.split('/')) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error(`Projection path contains a symlink: ${segment}`);
      if (!stats.isDirectory())
        throw new Error(`Projection path contains a non-directory: ${segment}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function assertContainedPath(workspacePath: string, targetPath: string): void {
  if (targetPath !== workspacePath && !targetPath.startsWith(`${workspacePath}${sep}`)) {
    throw new Error('Projection destination escapes the staging workspace.');
  }
}

export function projectionReceiptForPlan(input: {
  runId: string;
  sourceObjectId: string;
  plan: ProjectionPlan;
  createdAt: string;
}): ProjectionReceipt {
  const receiptHash = createHash('sha256')
    .update(
      `${input.runId}\0${input.sourceObjectId}\0${input.plan.sourceHash}\0${input.plan.destinationHash}`
    )
    .digest('hex');
  const common = {
    id: `projection_${receiptHash.slice(0, 24)}`,
    runId: input.runId,
    sourceObjectId: input.sourceObjectId,
    destinationObjectId: input.plan.destinationObjectId,
    destinationPath: projectionDestinationPrimaryPath(input.plan.destination),
    projection: input.plan.projection,
    ...(input.plan.nativeRepresentation
      ? { nativeRepresentation: input.plan.nativeRepresentation }
      : {}),
    converterId: input.plan.converterId,
    converterVersion: input.plan.converterVersion,
    sourceHash: input.plan.sourceHash,
    destinationHash: input.plan.destinationHash,
    warnings: [...input.plan.warnings],
    exception: input.plan.exception,
    formulaEvidence: input.plan.formulaEvidence.map((entry) => ({ ...entry })),
    createdAt: input.createdAt,
  };
  const destination = input.plan.destination;
  switch (destination.kind) {
    case 'file':
      return { ...common, destination };
    case 'package':
      return { ...common, destination };
    case 'catalog-record':
      return {
        ...common,
        destination,
        ...(input.plan.catalogPayload ? { catalogPayload: input.plan.catalogPayload } : {}),
      };
    default: {
      const unhandled: never = destination;
      throw new Error(`Unknown receipt destination ${unhandled}`);
    }
  }
}
