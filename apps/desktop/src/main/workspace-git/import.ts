import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, existsSync, type Stats } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { isBundledSampleWorkspaceOriginPath } from '../../shared/sample-workspace-ipc';
import {
  LARGE_MANAGED_IMPORT_FILE_THRESHOLD_BYTES,
  MANAGED_WORKSPACE_MARKER,
  type ImportContentRequest,
  type ImportFileRequest,
  type ImportFileResult,
  type ImportSequenceContentRequest,
  type ImportSequenceContentResult,
  type ImportManagedWorkspaceResult,
  type ImportProgressStatus,
  type ManagedWorkspaceLargeFile,
  type ManagedWorkspaceLargeFilePolicy,
  type ManagedWorkspaceSymlinkedFile,
} from '../../shared/workspace-git-types';
import {
  beginQuickLookPromotionWrite,
  beginQuickLookRendererMutationBlock,
  commitAllIfDirty,
  initManagedRepo,
  QUICK_LOOK_PROMOTION_OWNER_FILE,
  type QuickLookPromotionWriteLease,
  withManagedWorkspaceMutationLock,
} from './index';
import { materializeCoordinatePackage } from './coordinate-package-import';
import { packagedCoordinateFormat } from '../../shared/default-molecular-view';
import {
  existingPlasmidPackageRootForProduct,
  inspectSequenceFileSha256,
  isConstructSequenceFile,
  materializeImportedSequencePackages,
  SequencePackageTargetChangedError,
  SequencePackageTargetExistsError,
  type ExpectedSequencePackageState,
  type PackageImportFileOps,
} from './sequence-package-import';
import { convertTreeToPlasmidPackages, type ConvertTreeResult } from './convert-tree-to-packages';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackageMetaPaths,
  sequencePackagePaths,
  sequencePrimerArtifactLookupPaths,
  stripSequenceProductExtension,
} from '../../db/sequence-package';
import {
  assertPhysicalPackageMember,
  assertPhysicalWriteDestination,
} from './package-member-boundary';
import type {
  VerifiedQuickLookGenerationSnapshot,
  VerifiedQuickLookPackageSnapshot,
} from '../file-associations/quick-look-package-store';
import type { PreparedQuickLookWorkspace } from '../file-associations/quick-look-destination-promotion';
import { DEFAULT_PROJECT_DISPLAY_NAME } from '../../shared/first-project';
import {
  rememberOriginalDefaultProject,
  resolveOriginalDefaultProject,
} from '../original-default-project';
import { retainSequencePackagesInOrder } from '../retain-sequence-package';
import { findKnownWorkspaceRoot } from './known-workspace-scope';
import { benchlingProjectionLayoutPolicy } from './benchling-projection-layout';
import { withKnownWorkspacePathMutation } from '../workspace-sync-mutation-lease';
import {
  assertSharedProjectContentWritable,
  SharedProjectViewOnlyError,
} from '../shared-project-write-access';
import { claimRegularFileNoClobber } from './exclusive-file-claim';
import { assertIndependentWorkImport, isWorkImportCandidate } from '../work-task-import';
import { copyIndependentFile } from './copy-independent-file';
import { admitProjectRootInMain } from '../project-filesystem-authority';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import { workspaceMutationRootIdentity } from '../workspace-sync-mutation-lease';

export type ImportProgressUpdate = {
  status: ImportProgressStatus;
  filesCopied: number;
  totalFiles: number;
  bytesCopied: number;
  totalBytes: number;
};

async function withQuickLookWorkspacePublicationLock<T>(
  db: Database.Database,
  mutationRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const releaseRendererMutations = await beginQuickLookRendererMutationBlock(mutationRoot);
  try {
    return await withKnownWorkspacePathMutation(db, [mutationRoot], () =>
      withManagedWorkspaceMutationLock(mutationRoot, operation)
    );
  } finally {
    releaseRendererMutations();
  }
}

export {
  MANAGED_WORKSPACE_MARKER,
  type ImportManagedWorkspaceResult,
} from '../../shared/workspace-git-types';

const COPY_SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
function findManagedRepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, MANAGED_WORKSPACE_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertExpectedSourceDigest(
  copiedPath: string,
  expectedSourceSha256: string | undefined
): Promise<void> {
  if (!expectedSourceSha256) return;
  if (!/^[0-9a-f]{64}$/.test(expectedSourceSha256)) {
    throw new Error('The sequence import preview carried an invalid source digest.');
  }
  if ((await sha256File(copiedPath)) !== expectedSourceSha256) {
    throw new Error(
      'The selected DNA sequence changed after preview. Review the updated package list before importing.'
    );
  }
}

type PhysicalFileIdentity = { dev: number; ino: number };

async function physicalFileIdentity(path: string): Promise<PhysicalFileIdentity> {
  const identity = await lstat(path);
  return { dev: identity.dev, ino: identity.ino };
}

async function unlinkIfIdentityMatches(
  path: string,
  expected: PhysicalFileIdentity
): Promise<boolean> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
  await unlink(path);
  return true;
}

async function rmdirIfIdentityMatches(
  path: string,
  expected: PhysicalFileIdentity
): Promise<boolean> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    return false;
  }
  await rmdir(path);
  return true;
}

async function claimEmptyDirectoryNoClobber(
  path: string,
  createDirectory: (path: string) => Promise<void>
): Promise<PhysicalFileIdentity> {
  await createDirectory(path);
  const claimed = await lstat(path);
  if (!claimed.isDirectory()) {
    throw new Error(`SEQUENCE_IMPORT_CLAIM_CHANGED: "${path}" is no longer the claimed directory.`);
  }
  return { dev: claimed.dev, ino: claimed.ino };
}

function requiredGitFilesForProducts(productPaths: readonly string[] | undefined): string[] {
  return (productPaths ?? []).flatMap((productPath) => [
    productPath,
    sequencePackagePaths(dirname(productPath)).metaPath,
  ]);
}

async function sha256Stream(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const QUICK_LOOK_PROMOTION_RECORD_SCHEMA = 'dnaforge.quick-look-promotion.v2';
const QUICK_LOOK_WORKSPACE_PREPARATION_SCHEMA = 'dnaforge.quick-look-workspace-preparation.v1';
const QUICK_LOOK_WORKSPACE_OWNER_FILE = '.dnaforge-quick-look-workspace.json';

interface QuickLookPromotionRecord {
  readonly schema: typeof QUICK_LOOK_PROMOTION_RECORD_SCHEMA;
  readonly state: 'active' | 'completed';
  readonly recordKey: string;
  readonly token: string;
  readonly realTarget: string;
  readonly candidateRoot: string;
  readonly candidateName: string;
  readonly candidateDevice: string;
  readonly candidateInode: string;
  readonly productRelativePath: string;
  readonly files: readonly VerifiedQuickLookPackageSnapshot['files'][number][];
  readonly committed: boolean;
}

interface QuickLookWorkspacePreparationRecord {
  readonly schema: typeof QUICK_LOOK_WORKSPACE_PREPARATION_SCHEMA;
  readonly state: 'reserved' | 'prepared';
  readonly recordKey: string;
  readonly workspaceUuid: string;
  readonly displayName: string;
  readonly ownerToken: string;
  readonly workspaceContainerPath: string;
  readonly repoPath: string;
  readonly containerDevice: string | null;
  readonly containerInode: string | null;
  readonly createdAt: number;
}

export interface QuickLookWorkspacePreparationDeps extends ImportFileIntoWorkspaceDeps {
  readonly preparationJournalRoot: string;
  readonly packagePromotionJournalRoot: string;
}

export interface QuickLookPackageImportDeps extends ImportFileIntoWorkspaceDeps {
  readonly promotionJournalRoot: string;
}

function promotionRecordFromUnknown(value: unknown): QuickLookPromotionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== QUICK_LOOK_PROMOTION_RECORD_SCHEMA ||
    (record.state !== 'active' && record.state !== 'completed') ||
    typeof record.recordKey !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(record.recordKey) ||
    typeof record.token !== 'string' ||
    typeof record.realTarget !== 'string' ||
    typeof record.candidateRoot !== 'string' ||
    typeof record.candidateName !== 'string' ||
    typeof record.candidateDevice !== 'string' ||
    !/^\d+$/u.test(record.candidateDevice) ||
    typeof record.candidateInode !== 'string' ||
    !/^\d+$/u.test(record.candidateInode) ||
    typeof record.productRelativePath !== 'string' ||
    typeof record.committed !== 'boolean' ||
    !Array.isArray(record.files)
  ) {
    return null;
  }
  const files = record.files.flatMap((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return [];
    const entry = file as Record<string, unknown>;
    return typeof entry.relativePath === 'string' && /^[0-9a-f]{64}$/u.test(String(entry.sha256))
      ? [{ relativePath: entry.relativePath, sha256: String(entry.sha256) }]
      : [];
  });
  if (files.length !== record.files.length || files.length === 0) return null;
  return {
    schema: QUICK_LOOK_PROMOTION_RECORD_SCHEMA,
    state: record.state,
    recordKey: record.recordKey,
    token: record.token,
    realTarget: record.realTarget,
    candidateRoot: record.candidateRoot,
    candidateName: record.candidateName,
    candidateDevice: record.candidateDevice,
    candidateInode: record.candidateInode,
    productRelativePath: record.productRelativePath,
    files,
    committed: record.committed,
  };
}

function workspacePreparationRecordFromUnknown(
  value: unknown
): QuickLookWorkspacePreparationRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== QUICK_LOOK_WORKSPACE_PREPARATION_SCHEMA ||
    (record.state !== 'reserved' && record.state !== 'prepared') ||
    typeof record.recordKey !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(record.recordKey) ||
    typeof record.workspaceUuid !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(record.workspaceUuid) ||
    typeof record.displayName !== 'string' ||
    typeof record.ownerToken !== 'string' ||
    typeof record.workspaceContainerPath !== 'string' ||
    !isAbsolute(record.workspaceContainerPath) ||
    typeof record.repoPath !== 'string' ||
    record.repoPath !== join(record.workspaceContainerPath, 'repo') ||
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt)
  ) {
    return null;
  }
  const hasIdentity =
    typeof record.containerDevice === 'string' && typeof record.containerInode === 'string';
  const hasNoIdentity = record.containerDevice === null && record.containerInode === null;
  if (
    (record.state === 'prepared' && !hasIdentity) ||
    (record.state === 'reserved' && !hasNoIdentity)
  ) {
    return null;
  }
  return {
    schema: QUICK_LOOK_WORKSPACE_PREPARATION_SCHEMA,
    state: record.state,
    recordKey: record.recordKey,
    workspaceUuid: record.workspaceUuid,
    displayName: record.displayName,
    ownerToken: record.ownerToken,
    workspaceContainerPath: record.workspaceContainerPath,
    repoPath: record.repoPath,
    containerDevice: hasIdentity ? String(record.containerDevice) : null,
    containerInode: hasIdentity ? String(record.containerInode) : null,
    createdAt: record.createdAt,
  };
}

async function readPromotionRecord(path: string): Promise<QuickLookPromotionRecord | null> {
  try {
    return promotionRecordFromUnknown(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

async function writePromotionRecord(path: string, record: QuickLookPromotionRecord): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeWorkspacePreparationRecord(
  path: string,
  record: QuickLookWorkspacePreparationRecord
): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function promotionRecordKey(
  snapshot: VerifiedQuickLookPackageSnapshot,
  realTarget: string
): string {
  const files = [...snapshot.files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        realTarget,
        packageRoot: snapshot.packageRoot,
        productRelativePath: snapshot.productRelativePath,
        files,
      })
    )
    .digest('hex');
}

function promotionRecordMatchesSnapshot(
  record: QuickLookPromotionRecord,
  snapshot: VerifiedQuickLookPackageSnapshot,
  realTarget: string
): boolean {
  const recordFiles = [...record.files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
  const snapshotFiles = [...snapshot.files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
  return (
    record.realTarget === realTarget &&
    record.productRelativePath === snapshot.productRelativePath &&
    JSON.stringify(recordFiles) === JSON.stringify(snapshotFiles)
  );
}

async function ownerToken(candidateRoot: string): Promise<string | null> {
  try {
    const value = JSON.parse(
      await readFile(join(candidateRoot, QUICK_LOOK_PROMOTION_OWNER_FILE), 'utf8')
    ) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const token = (value as Record<string, unknown>).token;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

async function physicalDirectoryIdentity(
  path: string
): Promise<{ device: string; inode: string } | null> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
  return { device: metadata.dev.toString(), inode: metadata.ino.toString() };
}

function identityMatches(
  record: QuickLookPromotionRecord,
  identity: { device: string; inode: string } | null
): boolean {
  return (
    identity !== null &&
    identity.device === record.candidateDevice &&
    identity.inode === record.candidateInode
  );
}

async function collectPhysicalPackageFiles(
  root: string,
  relativeRoot = ''
): Promise<Array<{ relativePath: string; sha256: string }>> {
  const entries = await readdir(join(root, relativeRoot), { withFileTypes: true });
  const files: Array<{ relativePath: string; sha256: string }> = [];
  for (const entry of entries) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (relativePath === QUICK_LOOK_PROMOTION_OWNER_FILE) continue;
    const absolutePath = join(root, relativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Quick Look promotion contains a symbolic link: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectPhysicalPackageFiles(root, relativePath)));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`Quick Look promotion contains a non-file entry: ${relativePath}`);
    }
    files.push({ relativePath, sha256: await sha256Stream(absolutePath) });
  }
  return files;
}

async function verifyPromotedPackage(
  candidateRoot: string,
  productRelativePath: string,
  expectedFiles: readonly VerifiedQuickLookPackageSnapshot['files'][number][]
): Promise<boolean> {
  try {
    const rootMetadata = await lstat(candidateRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return false;
    const actualFiles = await collectPhysicalPackageFiles(candidateRoot);
    const expected = [...expectedFiles].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    );
    actualFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (JSON.stringify(actualFiles) !== JSON.stringify(expected)) return false;
    const document = parseSequencePackageDocument(
      await readFile(fromPackageRelative('.forge/plasmid.json', candidateRoot), 'utf8')
    );
    return (
      document.product.file === productRelativePath &&
      document.members.every((member) => expected.some((file) => file.relativePath === member.path))
    );
  } catch {
    return false;
  }
}

function isCanonicalPromotionCandidate(record: QuickLookPromotionRecord): boolean {
  return (
    isAbsolute(record.realTarget) &&
    isAbsolute(record.candidateRoot) &&
    dirname(record.candidateRoot) === record.realTarget &&
    basename(record.candidateRoot) === record.candidateName
  );
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function targetIsCurrentlyAdmitted(
  record: QuickLookPromotionRecord,
  deps: ImportFileIntoWorkspaceDeps
): Promise<boolean> {
  try {
    const currentTarget = await realpath(record.realTarget);
    return (
      currentTarget === record.realTarget &&
      (await isAdmittedWorkspaceDestination(deps.db, deps.managedRootDir, currentTarget))
    );
  } catch {
    return false;
  }
}

async function removeExactOwnedPromotionCandidate(
  record: QuickLookPromotionRecord,
  deps: ImportFileIntoWorkspaceDeps
): Promise<boolean> {
  if (!(await targetIsCurrentlyAdmitted(record, deps))) return false;
  const mutationLease = await beginQuickLookPromotionWrite(record.candidateRoot);
  try {
    let firstIdentity: { device: string; inode: string } | null;
    try {
      firstIdentity = await physicalDirectoryIdentity(record.candidateRoot);
    } catch {
      return false;
    }
    if (!identityMatches(record, firstIdentity)) return false;
    const token = await ownerToken(record.candidateRoot);
    if (token !== null && token !== record.token) return false;

    if (!(await targetIsCurrentlyAdmitted(record, deps))) return false;
    let finalIdentity: { device: string; inode: string } | null;
    try {
      finalIdentity = await physicalDirectoryIdentity(record.candidateRoot);
    } catch {
      return false;
    }
    if (!identityMatches(record, finalIdentity)) return false;

    if (token === null) {
      try {
        await rmdir(record.candidateRoot);
      } catch {
        return false;
      }
      return true;
    }

    await rm(record.candidateRoot, { recursive: true, force: true });
    return true;
  } finally {
    mutationLease.release();
  }
}

async function recoverPromotionRecord(
  path: string,
  deps: ImportFileIntoWorkspaceDeps
): Promise<void> {
  const record = await readPromotionRecord(path);
  if (
    !record ||
    !isCanonicalPromotionCandidate(record) ||
    basename(path) !== `${record.recordKey}.json`
  ) {
    console.warn(`[quick-look-promotion] Leaving unreadable recovery record untouched: ${path}`);
    return;
  }

  if (!(await targetIsCurrentlyAdmitted(record, deps))) {
    console.warn(
      `[quick-look-promotion] Retaining recovery state while its target is unavailable or untrusted: ${record.realTarget}`
    );
    return;
  }

  let candidate: Awaited<ReturnType<typeof lstat>>;
  try {
    candidate = await lstat(record.candidateRoot);
  } catch (error) {
    if (!isMissingPathError(error)) {
      console.warn(
        `[quick-look-promotion] Retaining recovery state after a destination inspection failure: ${record.candidateRoot}`,
        error
      );
      return;
    }
    await rm(path, { force: true });
    return;
  }
  if (!candidate.isDirectory() || candidate.isSymbolicLink()) {
    console.warn(
      `[quick-look-promotion] Refusing to recover a non-directory destination: ${record.candidateRoot}`
    );
    return;
  }
  const candidateIdentity = await physicalDirectoryIdentity(record.candidateRoot);
  if (!identityMatches(record, candidateIdentity)) {
    console.warn(
      `[quick-look-promotion] Refusing to recover a replaced destination: ${record.candidateRoot}`
    );
    return;
  }
  const owned = (await ownerToken(record.candidateRoot)) === record.token;
  const complete = await verifyPromotedPackage(
    record.candidateRoot,
    record.productRelativePath,
    record.files
  );
  if (record.state === 'completed' && complete) {
    if (owned) {
      if (!(await targetIsCurrentlyAdmitted(record, deps))) return;
      const currentIdentity = await physicalDirectoryIdentity(record.candidateRoot);
      if (!identityMatches(record, currentIdentity)) return;
      await rm(join(record.candidateRoot, QUICK_LOOK_PROMOTION_OWNER_FILE), { force: true });
    }
    return;
  }
  if (record.state === 'completed') {
    console.warn(
      `[quick-look-promotion] Retaining a completed destination whose contents changed after publication: ${record.candidateRoot}`
    );
    return;
  }
  if (await removeExactOwnedPromotionCandidate(record, deps)) {
    await rm(path, { force: true });
    return;
  }
  console.warn(
    `[quick-look-promotion] Refusing to remove an unowned incomplete destination: ${record.candidateRoot}`
  );
}

export async function recoverQuickLookPackagePromotions(
  journalRoot: string,
  deps: ImportFileIntoWorkspaceDeps
): Promise<void> {
  await mkdir(journalRoot, { recursive: true });
  const entries = await readdir(journalRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.includes('.json.tmp-')) {
      await rm(join(journalRoot, entry.name), { force: true });
      continue;
    }
    if (/^set-[0-9a-f]{64}\.json$/u.test(entry.name)) {
      const path = join(journalRoot, entry.name);
      const record = await readQuickLookSetRecord(path);
      if (!record) {
        await recoverQuickLookSetPromotionRecord(path, deps);
        continue;
      }
      const mutationRoot = findManagedRepoRoot(record.realTarget) ?? record.realTarget;
      await withQuickLookWorkspacePublicationLock(deps.db, mutationRoot, () =>
        recoverQuickLookSetPromotionRecord(path, deps)
      );
      continue;
    }
    if (!/^[0-9a-f]{64}\.json$/u.test(entry.name)) continue;
    const path = join(journalRoot, entry.name);
    const record = await readPromotionRecord(path);
    if (!record) {
      await recoverPromotionRecord(path, deps);
      continue;
    }
    const mutationRoot = findManagedRepoRoot(record.realTarget) ?? record.realTarget;
    await withQuickLookWorkspacePublicationLock(deps.db, mutationRoot, () =>
      recoverPromotionRecord(path, deps)
    );
  }
}

function validatedExpectedRelPath(
  targetRoot: string,
  expectedRelPath: string | undefined
): string | undefined {
  if (expectedRelPath === undefined) return undefined;
  const normalized = expectedRelPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(
      `IMPORT_EXPECTED_PATH_OUTSIDE_ROOT: expectedRelPath must be a strict path relative to the target root: "${expectedRelPath}".`
    );
  }
  const lexicalRoot = resolve(targetRoot);
  const destination = resolve(lexicalRoot, normalized);
  const member = relative(lexicalRoot, destination);
  if (member === '' || isAbsolute(member) || member === '..' || member.startsWith(`..${sep}`)) {
    throw new Error(
      `IMPORT_EXPECTED_PATH_OUTSIDE_ROOT: expectedRelPath escapes the target root: "${expectedRelPath}".`
    );
  }
  return member;
}

export interface ImportManagedWorkspaceDeps {
  db: Database.Database;
  managedRootDir: string;
  displayName?: string;
  largeFileThresholdBytes?: number;
  largeFilePolicy?: ManagedWorkspaceLargeFilePolicy;
  resolveLargeFilePolicy?: (
    files: ManagedWorkspaceLargeFile[],
    thresholdBytes: number
  ) => Promise<ManagedWorkspaceLargeFilePolicy | 'cancel'>;
  onProgress?: (update: ImportProgressUpdate) => void;
  commitAllIfDirty?: typeof commitAllIfDirty;
}

export interface ImportFileIntoWorkspaceDeps {
  db: Database.Database;
  managedRootDir: string;
  sequenceImportFileOps?: {
    link?: (existingPath: string, newPath: string) => Promise<void>;
    mkdir?: (path: string) => Promise<void>;
    rename?: (oldPath: string, newPath: string) => Promise<void>;
  };
  sequencePackageFileOps?: PackageImportFileOps;
  sequencePackageMaterializer?: typeof materializeImportedSequencePackages;
  commitAllIfDirty?: typeof commitAllIfDirty;
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const child = relative(parentPath, candidatePath);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

async function isAdmittedWorkspaceDestination(
  db: Database.Database,
  managedRootDir: string,
  realTarget: string
): Promise<boolean> {
  return (await findKnownWorkspaceRoot(realTarget, { db, managedRootDir })) !== null;
}

async function assertKnownImportDestination(
  targetPath: string,
  deps: ImportFileIntoWorkspaceDeps
): Promise<void> {
  const workspaceRoot = await findKnownWorkspaceRoot(targetPath, deps);
  if (!workspaceRoot) {
    throw new Error('Refusing to import into an unknown project root.');
  }
  assertSharedProjectContentWritable(deps.db, workspaceRoot);
}

async function retainImportedPackages(
  deps: Pick<ImportFileIntoWorkspaceDeps, 'db' | 'managedRootDir'>,
  targetRoot: string,
  packageRoots: readonly string[]
): Promise<void> {
  if (packageRoots.length === 0) return;
  const workspaceRoot = await findKnownWorkspaceRoot(targetRoot, deps);
  if (!workspaceRoot) throw new Error('The imported package has no owning project.');
  const physicalWorkspace = await realpath(workspaceRoot);
  await retainSequencePackagesInOrder(deps.db, {
    workspaceRoot: physicalWorkspace,
    packageRoots,
  });
}

function sequenceRootsFromPackageFiles(paths: readonly string[]): string[] {
  return paths.flatMap((path) =>
    sequencePackageMetaPaths(dirname(dirname(path))).includes(path) ? [dirname(dirname(path))] : []
  );
}

interface WorkspaceRow {
  id: number;
  name: string;
  path: string;
  repo_uuid: string | null;
  origin_path: string | null;
  created_at: number;
}

export async function importIntoManagedWorkspaceRepo(
  sourcePath: string,
  deps: ImportManagedWorkspaceDeps
): Promise<ImportManagedWorkspaceResult> {
  const { db, managedRootDir } = deps;
  const commitManagedChanges = deps.commitAllIfDirty ?? commitAllIfDirty;
  const largeFileThresholdBytes =
    deps.largeFileThresholdBytes ?? LARGE_MANAGED_IMPORT_FILE_THRESHOLD_BYTES;
  const originPath = await realpath(sourcePath);
  const sourceStat = await stat(originPath);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Cannot mount a non-directory as a workspace: ${sourcePath}`);
  }
  if (isPathInsideBoundary(originPath, workspaceMutationRootIdentity(managedRootDir)))
    await admitProjectRootInMain(originPath, { db, managedRootDir });

  const existing = db
    .prepare(
      `SELECT id, name, path, repo_uuid, origin_path, created_at
       FROM workspaces WHERE (origin_path = ? OR path = ?) AND repo_uuid IS NOT NULL`
    )
    .get(originPath, originPath) as WorkspaceRow | undefined;
  if (existing?.repo_uuid && existsSync(join(existing.path, '.git'))) {
    const projectionLayoutPolicy = await benchlingProjectionLayoutPolicy(
      existing.path,
      existing.repo_uuid
    );
    if (projectionLayoutPolicy === 'locked') {
      throw new Error(
        'Benchling migration project is locked and cannot be opened as a normal project.'
      );
    }
    let unconverted: Array<{ relPath: string; reason: string }> = [];
    if (projectionLayoutPolicy === 'ordinary') {
      await withManagedWorkspaceMutationLock(existing.path, async () => {
        let convertedCount = 0;
        let requiredGitFiles: string[] = [];
        let conversionCompleted = false;
        try {
          const conversion = await convertTreeToPlasmidPackages(existing.path);
          unconverted = unconvertedSequenceFiles(existing.path, conversion);
          convertedCount = conversion.converted;
          requiredGitFiles = conversion.requiredGitFiles;
          conversionCompleted = true;
        } catch (err) {
          console.warn(
            '[importWorkspace] reused a managed workspace but could not package it:',
            err
          );
        }
        await retainImportedPackages(
          deps,
          existing.path,
          sequenceRootsFromPackageFiles(requiredGitFiles)
        );
        if (conversionCompleted) {
          const commitOid = await commitManagedChanges(
            existing.path,
            'Convert sequences to plasmid packages',
            { forceInclude: requiredGitFiles }
          );
          if (convertedCount > 0 && !commitOid) {
            throw new Error(
              'Converted sequences to plasmid packages, but Git created no commit for the managed workspace.'
            );
          }
        }
      });
    }
    db.prepare(
      `UPDATE workspaces SET last_opened_at = ?, archived_at = NULL, trashed_at = NULL WHERE id = ?`
    ).run(Date.now(), existing.id);
    return {
      workspaceUuid: existing.repo_uuid,
      repoPath: existing.path,
      displayName: existing.name,
      originPath,
      createdAt: existing.created_at,
      reused: true,
      largeFilePolicy: deps.largeFilePolicy ?? 'copy',
      largeFiles: [],
      symlinkedLargeFiles: [],
      ...(unconverted.length > 0 ? { unconvertedSequenceFiles: unconverted } : {}),
    };
  }

  const scan = await scanImportTree(originPath, largeFileThresholdBytes, true);
  const largeFiles = scan.largeFiles;
  const largeFilePolicy = await selectLargeFilePolicy(largeFiles, deps, largeFileThresholdBytes);
  if (largeFilePolicy === 'cancel') {
    throw new Error('Project import canceled.');
  }

  const workspaceUuid = randomUUID();
  const repoPath = join(managedRootDir, workspaceUuid, 'repo');
  const displayName = deps.displayName || basename(originPath) || DEFAULT_PROJECT_DISPLAY_NAME;
  const createdAt = Date.now();

  const progress = { filesCopied: 0, bytesCopied: 0 };
  deps.onProgress?.({
    status: 'copying',
    filesCopied: 0,
    totalFiles: scan.totalFiles,
    bytesCopied: 0,
    totalBytes: scan.totalBytes,
  });

  await mkdir(repoPath, { recursive: true });
  const copyResult = await copyTree(originPath, repoPath, {
    rootPath: originPath,
    largeFileThresholdBytes,
    largeFilePolicy,
    onProgress: deps.onProgress,
    progress,
    totalFiles: scan.totalFiles,
    totalBytes: scan.totalBytes,
  });

  let requiredGitFiles: string[] = [];
  let unconvertedFiles: ReturnType<typeof unconvertedSequenceFiles> = [];
  try {
    const conversion = await convertTreeToPlasmidPackages(repoPath);
    requiredGitFiles = conversion.requiredGitFiles;
    unconvertedFiles = unconvertedSequenceFiles(repoPath, conversion);
    if (conversion.failures.length > 0) {
      console.warn(
        `[importWorkspace] ${conversion.failures.length} file(s) could not be packaged:`,
        conversion.failures
      );
    }
  } catch (err) {
    console.warn('[importWorkspace] copied the tree but could not package its sequences:', err);
  }

  deps.onProgress?.({
    status: 'finalizing',
    filesCopied: scan.totalFiles,
    totalFiles: scan.totalFiles,
    bytesCopied: scan.totalBytes,
    totalBytes: scan.totalBytes,
  });
  await writeFile(
    join(repoPath, MANAGED_WORKSPACE_MARKER),
    `${JSON.stringify({ schema: 1, workspaceUuid, originPath, importedAt: createdAt }, null, 2)}\n`,
    'utf8'
  );
  await initManagedRepo(repoPath);
  await commitManagedChanges(repoPath, 'Initial import', {
    forceInclude: requiredGitFiles,
  });

  db.prepare(
    `INSERT INTO workspaces (name, path, repo_uuid, origin_path, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       repo_uuid = excluded.repo_uuid,
       origin_path = excluded.origin_path,
       last_opened_at = excluded.last_opened_at`
  ).run(displayName, repoPath, workspaceUuid, originPath, createdAt, createdAt);

  await retainImportedPackages(deps, repoPath, sequenceRootsFromPackageFiles(requiredGitFiles));
  return {
    workspaceUuid,
    repoPath,
    displayName,
    originPath,
    createdAt,
    reused: false,
    largeFilePolicy,
    largeFiles,
    symlinkedLargeFiles: copyResult.symlinkedLargeFiles,
    ...(unconvertedFiles.length > 0 ? { unconvertedSequenceFiles: unconvertedFiles } : {}),
  };
}

function unconvertedSequenceFiles(
  repoPath: string,
  conversion: Pick<ConvertTreeResult, 'skippedDetails' | 'failures'>
): Array<{ relPath: string; reason: string }> {
  const relPath = (path: string) => relative(repoPath, path).split(sep).join('/');
  return [
    ...conversion.skippedDetails.map(({ path, reason }) => ({ relPath: relPath(path), reason })),
    ...conversion.failures.map(({ path, message }) => ({
      relPath: relPath(path),
      reason: message,
    })),
  ];
}

async function selectLargeFilePolicy(
  largeFiles: ManagedWorkspaceLargeFile[],
  deps: ImportManagedWorkspaceDeps,
  thresholdBytes: number
): Promise<ManagedWorkspaceLargeFilePolicy | 'cancel'> {
  if (largeFiles.length === 0) return 'copy';
  if (deps.largeFilePolicy) return deps.largeFilePolicy;
  if (deps.resolveLargeFilePolicy) return deps.resolveLargeFilePolicy(largeFiles, thresholdBytes);
  return 'copy';
}

async function importQuickLookPackageIntoWorkspaceRootInternal(
  snapshot: VerifiedQuickLookPackageSnapshot,
  targetRoot: string,
  deps: QuickLookPackageImportDeps,
  options: { readonly commit?: boolean; readonly recover?: boolean },
  lockManagedWorkspace: boolean
): Promise<ImportFileResult> {
  const realTarget = await realpath(targetRoot);
  if (!(await stat(realTarget)).isDirectory()) {
    throw new Error(`Import target is not a directory: ${targetRoot}`);
  }
  if (!(await isAdmittedWorkspaceDestination(deps.db, deps.managedRootDir, realTarget))) {
    throw new Error('Refusing to import into an unknown workspace root.');
  }

  const sourceRootMetadata = await lstat(snapshot.packageRoot);
  if (!sourceRootMetadata.isDirectory() || sourceRootMetadata.isSymbolicLink()) {
    throw new Error('Quick Look package root is not a physical directory.');
  }
  const sourceRoot = await realpath(snapshot.packageRoot);
  const expectedFiles = new Map(
    snapshot.files.map((file) => [file.relativePath, file.sha256] as const)
  );
  if (
    !expectedFiles.has('.forge/plasmid.json') ||
    !expectedFiles.has(snapshot.productRelativePath)
  ) {
    throw new Error('Quick Look package manifest is incomplete.');
  }

  const productName = basename(snapshot.productRelativePath);
  const productExtension = extname(productName);
  const rawStem = productExtension
    ? productName.slice(0, productName.length - productExtension.length)
    : productName;
  const packageStem =
    rawStem
      .trim()
      .replace(/[/\\:*?"<>|]+/gu, '-')
      .replace(/^[.\s]+|[.\s]+$/gu, '') || 'Imported sequence';

  const mutationRoot = findManagedRepoRoot(realTarget) ?? realTarget;
  const operation = async (): Promise<ImportFileResult> => {
    const recordKey = promotionRecordKey(snapshot, realTarget);
    const recordPath = join(deps.promotionJournalRoot, `${recordKey}.json`);
    if (options.recover !== false && (await lstat(recordPath).catch(() => null))) {
      await recoverPromotionRecord(recordPath, deps);
    }
    const priorRecord = await readPromotionRecord(recordPath);
    if (
      priorRecord?.state === 'completed' &&
      priorRecord.recordKey === recordKey &&
      promotionRecordMatchesSnapshot(priorRecord, snapshot, realTarget) &&
      isCanonicalPromotionCandidate(priorRecord) &&
      (await verifyPromotedPackage(
        priorRecord.candidateRoot,
        priorRecord.productRelativePath,
        priorRecord.files
      ))
    ) {
      const destPath = fromPackageRelative(
        priorRecord.productRelativePath,
        join(targetRoot, priorRecord.candidateName)
      );
      if (lockManagedWorkspace)
        await retainImportedPackages(deps, targetRoot, [priorRecord.candidateRoot]);
      return {
        destPath,
        relPath: relative(targetRoot, destPath),
        committed: priorRecord.committed,
        packageProductPaths: [destPath],
      };
    }

    const token = randomUUID();
    let destinationPackageRoot: string | null = null;
    let destinationPackageName: string | null = null;
    let promotionRecord: QuickLookPromotionRecord | null = null;
    let activeWriteLease: QuickLookPromotionWriteLease | null = null;
    let published = false;
    try {
      for (let suffix = 0; suffix <= 1000; suffix += 1) {
        const candidateName = suffix === 0 ? packageStem : `${packageStem} (${suffix})`;
        const candidate = join(realTarget, candidateName);
        const candidateWriteLease = await beginQuickLookPromotionWrite(candidate);
        try {
          await mkdir(candidate, { recursive: false, mode: 0o700 });
          destinationPackageRoot = candidate;
          destinationPackageName = candidateName;
          activeWriteLease = candidateWriteLease;
          break;
        } catch (error) {
          candidateWriteLease.release();
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST' && suffix < 1000) continue;
          throw error;
        }
      }
      if (!destinationPackageRoot || !destinationPackageName) {
        throw new Error(`Could not choose a collision-free package name for ${productName}.`);
      }
      const destinationIdentity = await physicalDirectoryIdentity(destinationPackageRoot);
      if (!destinationIdentity) {
        throw new Error('Quick Look promotion destination is not a physical directory.');
      }
      promotionRecord = {
        schema: QUICK_LOOK_PROMOTION_RECORD_SCHEMA,
        state: 'active',
        recordKey,
        token,
        realTarget,
        candidateRoot: destinationPackageRoot,
        candidateName: destinationPackageName,
        candidateDevice: destinationIdentity.device,
        candidateInode: destinationIdentity.inode,
        productRelativePath: snapshot.productRelativePath,
        files: snapshot.files,
        committed: false,
      };
      await writePromotionRecord(recordPath, promotionRecord);
      await writeFile(
        join(destinationPackageRoot, QUICK_LOOK_PROMOTION_OWNER_FILE),
        `${JSON.stringify({ token })}\n`,
        { flag: 'wx', mode: 0o600 }
      );

      const markerRelativePath = '.forge/plasmid.json';
      const filesInPublicationOrder = [
        ...snapshot.files.filter((file) => file.relativePath !== markerRelativePath),
        ...snapshot.files.filter((file) => file.relativePath === markerRelativePath),
      ];
      for (const file of filesInPublicationOrder) {
        const sourcePath = fromPackageRelative(file.relativePath, sourceRoot);
        const sourceMetadata = await lstat(sourcePath);
        if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
          throw new Error(`Quick Look package member is not a physical file: ${file.relativePath}`);
        }
        const destinationPath = fromPackageRelative(file.relativePath, destinationPackageRoot);
        await mkdir(dirname(destinationPath), { recursive: true });
        await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
        if ((await sha256Stream(destinationPath)) !== file.sha256) {
          throw new Error(`Quick Look package changed while copying: ${file.relativePath}`);
        }
      }

      if (
        !(await verifyPromotedPackage(
          destinationPackageRoot,
          snapshot.productRelativePath,
          snapshot.files
        ))
      ) {
        throw new Error('Copied Quick Look package does not match its verified snapshot.');
      }

      promotionRecord = { ...promotionRecord, state: 'completed' };
      await writePromotionRecord(recordPath, promotionRecord);
      await rm(join(destinationPackageRoot, QUICK_LOOK_PROMOTION_OWNER_FILE), { force: true });
      published = true;
      activeWriteLease?.allowGitPublication();

      const lexicalPackageRoot = join(targetRoot, destinationPackageName);
      const destPath = fromPackageRelative(snapshot.productRelativePath, lexicalPackageRoot);
      const relPath = relative(targetRoot, destPath);
      let committed = false;
      const repoRoot = findManagedRepoRoot(realTarget);
      if (repoRoot && options.commit !== false) {
        try {
          const oid = await commitAllIfDirty(repoRoot, `Import ${relPath}`, {
            forceInclude: snapshot.files.map((file) =>
              fromPackageRelative(file.relativePath, destinationPackageRoot!)
            ),
          });
          committed = oid !== null;
        } catch (error) {
          console.warn(
            `[importQuickLookPackage] copied ${relPath} but commit failed (will reconcile later):`,
            error
          );
        }
      }
      promotionRecord = { ...promotionRecord, committed };
      await writePromotionRecord(recordPath, promotionRecord).catch((error) =>
        console.warn(
          '[quick-look-promotion] Could not update the completed recovery receipt:',
          error
        )
      );
      if (lockManagedWorkspace)
        await retainImportedPackages(deps, targetRoot, [lexicalPackageRoot]);
      return {
        destPath,
        relPath,
        committed,
        packageProductPaths: [destPath],
      };
    } finally {
      try {
        if (!published && promotionRecord) {
          if (await removeExactOwnedPromotionCandidate(promotionRecord, deps)) {
            await rm(recordPath, { force: true });
          }
        }
      } finally {
        activeWriteLease?.release();
      }
    }
  };
  return lockManagedWorkspace
    ? withQuickLookWorkspacePublicationLock(deps.db, mutationRoot, operation)
    : operation();
}

export async function importQuickLookPackageIntoWorkspaceRoot(
  snapshot: VerifiedQuickLookPackageSnapshot,
  targetRoot: string,
  deps: QuickLookPackageImportDeps,
  options: { readonly commit?: boolean; readonly recover?: boolean } = {}
): Promise<ImportFileResult> {
  return importQuickLookPackageIntoWorkspaceRootInternal(snapshot, targetRoot, deps, options, true);
}

async function importQuickLookPackageIntoWorkspaceRootLocked(
  snapshot: VerifiedQuickLookPackageSnapshot,
  targetRoot: string,
  deps: QuickLookPackageImportDeps,
  options: { readonly commit?: boolean; readonly recover?: boolean }
): Promise<ImportFileResult> {
  return importQuickLookPackageIntoWorkspaceRootInternal(
    snapshot,
    targetRoot,
    deps,
    options,
    false
  );
}

const QUICK_LOOK_SET_PROMOTION_SCHEMA = 'dnaforge.quick-look-set-promotion.v1';

interface QuickLookSetPromotionRecord {
  readonly schema: typeof QUICK_LOOK_SET_PROMOTION_SCHEMA;
  readonly state: 'active' | 'completed';
  readonly recordKey: string;
  readonly token: string;
  readonly realTarget: string;
  readonly stagingRoot: string;
  readonly finalRoot: string;
  readonly device: string;
  readonly inode: string;
  readonly sourceFileName: string;
  readonly records: readonly {
    readonly recordId: string;
    readonly childName: string;
    readonly productRelativePath: string;
    readonly files: readonly VerifiedQuickLookPackageSnapshot['files'][number][];
  }[];
  readonly committed: boolean;
}

async function readQuickLookSetRecord(path: string): Promise<QuickLookSetPromotionRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.schema !== QUICK_LOOK_SET_PROMOTION_SCHEMA ||
      (record.state !== 'active' && record.state !== 'completed') ||
      typeof record.recordKey !== 'string' ||
      typeof record.token !== 'string' ||
      typeof record.realTarget !== 'string' ||
      typeof record.stagingRoot !== 'string' ||
      typeof record.finalRoot !== 'string' ||
      typeof record.device !== 'string' ||
      typeof record.inode !== 'string' ||
      typeof record.sourceFileName !== 'string' ||
      typeof record.committed !== 'boolean' ||
      !Array.isArray(record.records)
    ) {
      return null;
    }
    const records = record.records.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const candidate = value as Record<string, unknown>;
      if (
        typeof candidate.recordId !== 'string' ||
        typeof candidate.childName !== 'string' ||
        typeof candidate.productRelativePath !== 'string' ||
        !Array.isArray(candidate.files)
      ) {
        return [];
      }
      const files = candidate.files.flatMap((fileValue) => {
        if (!fileValue || typeof fileValue !== 'object' || Array.isArray(fileValue)) return [];
        const file = fileValue as Record<string, unknown>;
        return typeof file.relativePath === 'string' && typeof file.sha256 === 'string'
          ? [{ relativePath: file.relativePath, sha256: file.sha256 }]
          : [];
      });
      if (files.length !== candidate.files.length) return [];
      return [
        {
          recordId: candidate.recordId,
          childName: candidate.childName,
          productRelativePath: candidate.productRelativePath,
          files,
        },
      ];
    });
    if (
      records.length !== record.records.length ||
      (record.state === 'completed' && records.length === 0)
    ) {
      return null;
    }
    return {
      schema: QUICK_LOOK_SET_PROMOTION_SCHEMA,
      state: record.state,
      recordKey: record.recordKey,
      token: record.token,
      realTarget: record.realTarget,
      stagingRoot: record.stagingRoot,
      finalRoot: record.finalRoot,
      device: record.device,
      inode: record.inode,
      sourceFileName: record.sourceFileName,
      records,
      committed: record.committed,
    };
  } catch {
    return null;
  }
}

async function writeQuickLookSetRecord(
  path: string,
  record: QuickLookSetPromotionRecord
): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function quickLookSetRecordKey(
  snapshot: VerifiedQuickLookGenerationSnapshot,
  realTarget: string
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        realTarget,
        sourceFileName: snapshot.sourceFileName,
        records: snapshot.records.map((record) => ({
          recordId: record.recordId,
          productRelativePath: record.productRelativePath,
          files: record.files,
        })),
      })
    )
    .digest('hex');
}

function quickLookSetResult(
  record: QuickLookSetPromotionRecord,
  lexicalTargetRoot: string
): ImportFileResult & {
  records: Array<{ recordId: string; destPath: string; relPath: string }>;
} {
  const lexicalGroupRoot = join(lexicalTargetRoot, basename(record.finalRoot));
  const records = record.records.map((entry) => {
    const destPath = fromPackageRelative(
      entry.productRelativePath,
      join(lexicalGroupRoot, entry.childName)
    );
    return {
      recordId: entry.recordId,
      destPath,
      relPath: relative(lexicalTargetRoot, destPath),
    };
  });
  const first = records[0];
  if (!first) throw new Error('Quick Look promotion contains no records.');
  return {
    destPath: first.destPath,
    relPath: first.relPath,
    committed: record.committed,
    packageProductPaths: records.map((entry) => entry.destPath),
    records,
  };
}

async function verifyQuickLookSetAtRoot(
  record: QuickLookSetPromotionRecord,
  root: string
): Promise<boolean> {
  for (const entry of record.records) {
    if (
      !(await verifyPromotedPackage(
        join(root, entry.childName),
        entry.productRelativePath,
        entry.files
      ))
    ) {
      return false;
    }
  }
  return true;
}

async function exactOwnedSetRoot(
  record: QuickLookSetPromotionRecord,
  root: string
): Promise<boolean> {
  if (!(await exactSetRootIdentity(record, root))) return false;
  return (await ownerToken(root)) === record.token;
}

async function exactSetRootIdentity(
  record: QuickLookSetPromotionRecord,
  root: string
): Promise<boolean> {
  try {
    const identity = await physicalDirectoryIdentity(root);
    return Boolean(
      identity && identity.device === record.device && identity.inode === record.inode
    );
  } catch {
    return false;
  }
}

function isCanonicalQuickLookSetRecord(record: QuickLookSetPromotionRecord): boolean {
  if (
    !/^[0-9a-f]{64}$/u.test(record.recordKey) ||
    !isAbsolute(record.realTarget) ||
    !isAbsolute(record.stagingRoot) ||
    !isAbsolute(record.finalRoot) ||
    !/^\d+$/u.test(record.device) ||
    !/^\d+$/u.test(record.inode) ||
    basename(record.sourceFileName) !== record.sourceFileName ||
    dirname(record.stagingRoot) !== record.realTarget ||
    dirname(record.finalRoot) !== record.realTarget ||
    (record.stagingRoot !== record.finalRoot &&
      !basename(record.stagingRoot).startsWith('.dnaforge-quick-look-set-'))
  ) {
    return false;
  }
  const childNames = new Set<string>();
  const recordIds = new Set<string>();
  return record.records.every((entry) => {
    const filePaths = new Set<string>();
    let productPathIsSafe = false;
    try {
      productPathIsSafe = fromPackageRelative(
        entry.productRelativePath,
        record.realTarget
      ).startsWith(`${record.realTarget}${sep}`);
    } catch {
      productPathIsSafe = false;
    }
    if (
      !/^[0-9a-f]{64}$/u.test(entry.recordId) ||
      basename(entry.childName) !== entry.childName ||
      entry.childName === '.' ||
      entry.childName === '..' ||
      childNames.has(entry.childName) ||
      recordIds.has(entry.recordId) ||
      entry.files.length === 0 ||
      !productPathIsSafe ||
      !entry.files.some((file) => file.relativePath === '.forge/plasmid.json') ||
      !entry.files.some((file) => file.relativePath === entry.productRelativePath)
    ) {
      return false;
    }
    for (const file of entry.files) {
      let pathIsSafe = false;
      try {
        pathIsSafe = fromPackageRelative(file.relativePath, record.realTarget).startsWith(
          `${record.realTarget}${sep}`
        );
      } catch {
        pathIsSafe = false;
      }
      if (!/^[0-9a-f]{64}$/u.test(file.sha256) || !pathIsSafe || filePaths.has(file.relativePath)) {
        return false;
      }
      filePaths.add(file.relativePath);
    }
    childNames.add(entry.childName);
    recordIds.add(entry.recordId);
    return true;
  });
}

async function quickLookSetTargetIsCurrentlyAdmitted(
  record: QuickLookSetPromotionRecord,
  deps: ImportFileIntoWorkspaceDeps
): Promise<boolean> {
  try {
    const currentTarget = await realpath(record.realTarget);
    return (
      currentTarget === record.realTarget &&
      (await isAdmittedWorkspaceDestination(deps.db, deps.managedRootDir, currentTarget))
    );
  } catch {
    return false;
  }
}

async function recoverQuickLookSetPromotionRecord(
  journalPath: string,
  deps: ImportFileIntoWorkspaceDeps
): Promise<void> {
  const record = await readQuickLookSetRecord(journalPath);
  if (
    !record ||
    basename(journalPath) !== `set-${record.recordKey}.json` ||
    !isCanonicalQuickLookSetRecord(record)
  ) {
    console.warn(
      `[quick-look-set-promotion] Leaving unreadable recovery record untouched: ${journalPath}`
    );
    return;
  }
  if (!(await quickLookSetTargetIsCurrentlyAdmitted(record, deps))) {
    console.warn(
      `[quick-look-set-promotion] Retaining recovery state while its target is unavailable or untrusted: ${record.realTarget}`
    );
    return;
  }

  const releaseMutationBlock = await beginQuickLookRendererMutationBlock(record.realTarget);
  try {
    if (record.state === 'completed') {
      if (await verifyQuickLookSetAtRoot(record, record.finalRoot)) {
        if (await exactOwnedSetRoot(record, record.finalRoot)) {
          await rm(join(record.finalRoot, QUICK_LOOK_PROMOTION_OWNER_FILE), { force: true });
        }
        await retirePackagePromotionRecordsForWorkspace(record.stagingRoot, dirname(journalPath));
        return;
      }
      if (!(await lstat(record.finalRoot).catch(() => null))) {
        await rm(journalPath, { force: true });
        return;
      }
      console.warn(
        `[quick-look-set-promotion] Retaining a completed package set whose contents changed after publication: ${record.finalRoot}`
      );
      return;
    }

    if (
      record.records.length > 0 &&
      (await exactOwnedSetRoot(record, record.finalRoot)) &&
      (await verifyQuickLookSetAtRoot(record, record.finalRoot))
    ) {
      const recovered = { ...record, state: 'completed' as const };
      await writeQuickLookSetRecord(journalPath, recovered);
      await rm(join(record.finalRoot, QUICK_LOOK_PROMOTION_OWNER_FILE), { force: true });
      await retirePackagePromotionRecordsForWorkspace(record.stagingRoot, dirname(journalPath));
      return;
    }
    if (await exactOwnedSetRoot(record, record.stagingRoot)) {
      await rm(record.stagingRoot, { recursive: true, force: true });
      await rm(journalPath, { force: true });
      return;
    }
    if (
      (await exactSetRootIdentity(record, record.stagingRoot)) &&
      (await ownerToken(record.stagingRoot)) === null
    ) {
      try {
        await rmdir(record.stagingRoot);
        await rm(journalPath, { force: true });
        return;
      } catch (error) {
        if (!isMissingPathError(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
          throw error;
        }
      }
    }
    const [stagingCandidate, finalCandidate] = await Promise.all([
      lstat(record.stagingRoot).catch(() => null),
      lstat(record.finalRoot).catch(() => null),
    ]);
    if (!stagingCandidate && !finalCandidate) {
      await rm(journalPath, { force: true });
      return;
    }
    console.warn(
      `[quick-look-set-promotion] Refusing to remove an unowned or replaced package set: ${record.stagingRoot}`
    );
  } finally {
    releaseMutationBlock();
  }
}

export async function importQuickLookGenerationIntoWorkspaceRoot(
  snapshot: VerifiedQuickLookGenerationSnapshot,
  targetRoot: string,
  deps: QuickLookPackageImportDeps
): Promise<
  ImportFileResult & { records: Array<{ recordId: string; destPath: string; relPath: string }> }
> {
  const firstSnapshot = snapshot.records[0];
  if (!firstSnapshot) throw new Error('Quick Look generation contains no records.');
  if (snapshot.records.length === 1) {
    const promoted = await importQuickLookPackageIntoWorkspaceRoot(firstSnapshot, targetRoot, deps);
    return {
      ...promoted,
      records: [
        {
          recordId: firstSnapshot.recordId,
          destPath: promoted.destPath,
          relPath: promoted.relPath,
        },
      ],
    };
  }

  const realTarget = await realpath(targetRoot);
  if (!(await stat(realTarget)).isDirectory()) {
    throw new Error(`Import target is not a directory: ${targetRoot}`);
  }
  if (!(await isAdmittedWorkspaceDestination(deps.db, deps.managedRootDir, realTarget))) {
    throw new Error('Refusing to import into an unknown workspace root.');
  }

  const mutationRoot = findManagedRepoRoot(realTarget) ?? realTarget;
  return withQuickLookWorkspacePublicationLock(deps.db, mutationRoot, async () => {
    const recordKey = quickLookSetRecordKey(snapshot, realTarget);
    const recordPath = join(deps.promotionJournalRoot, `set-${recordKey}.json`);
    if (await lstat(recordPath).catch(() => null)) {
      await recoverQuickLookSetPromotionRecord(recordPath, deps);
    }
    const prior = await readQuickLookSetRecord(recordPath);
    if (prior?.recordKey === recordKey) {
      if (
        prior.state === 'completed' &&
        isCanonicalQuickLookSetRecord(prior) &&
        (await verifyQuickLookSetAtRoot(prior, prior.finalRoot))
      ) {
        await retainImportedPackages(
          deps,
          targetRoot,
          prior.records.map((record) => join(prior.finalRoot, record.childName))
        );
        return quickLookSetResult(prior, targetRoot);
      }
      throw new Error(
        'DNAForge retained unresolved Quick Look recovery state for this destination instead of risking user data.'
      );
    }

    const extension = extname(snapshot.sourceFileName);
    const sourceStem = snapshot.sourceFileName.slice(
      0,
      snapshot.sourceFileName.length - extension.length
    );
    const safeGroupStem =
      sourceStem
        .trim()
        .replace(/[/\\:*?"<>|]+/gu, '-')
        .replace(/^[.\s]+|[.\s]+$/gu, '') || 'Imported sequences';
    const token = randomUUID();
    let finalRoot: string | null = null;
    let journal: QuickLookSetPromotionRecord | null = null;
    for (let suffix = 0; suffix <= 1000; suffix += 1) {
      const candidate = join(
        realTarget,
        suffix === 0 ? safeGroupStem : `${safeGroupStem} (${suffix})`
      );
      try {
        await mkdir(candidate, { recursive: false, mode: 0o700 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' && suffix < 1000) continue;
        throw error;
      }
      try {
        const identity = await physicalDirectoryIdentity(candidate);
        if (!identity) throw new Error('Quick Look set destination is not a physical directory.');
        journal = {
          schema: QUICK_LOOK_SET_PROMOTION_SCHEMA,
          state: 'active',
          recordKey,
          token,
          realTarget,
          stagingRoot: candidate,
          finalRoot: candidate,
          device: identity.device,
          inode: identity.inode,
          sourceFileName: snapshot.sourceFileName,
          records: [],
          committed: false,
        };
        await writeQuickLookSetRecord(recordPath, journal);
        await writeFile(
          join(candidate, QUICK_LOOK_PROMOTION_OWNER_FILE),
          `${JSON.stringify({ token })}\n`,
          { flag: 'wx', mode: 0o600 }
        );
        finalRoot = candidate;
        break;
      } catch (error) {
        if ((await ownerToken(candidate)) === token) {
          await rm(candidate, { recursive: true, force: true });
          await rm(recordPath, { force: true });
        } else {
          await rmdir(candidate).catch(() => undefined);
          if (!(await lstat(candidate).catch(() => null))) {
            await rm(recordPath, { force: true });
          }
        }
        throw error;
      }
    }
    if (!finalRoot || !journal) {
      throw new Error('Could not choose a collision-free Quick Look group name.');
    }

    const stagingRoot = finalRoot;
    let published = false;
    try {
      const recordEntries: QuickLookSetPromotionRecord['records'][number][] = [];
      for (const record of snapshot.records) {
        const promoted = await importQuickLookPackageIntoWorkspaceRootLocked(
          record,
          stagingRoot,
          deps,
          {
            commit: false,
            recover: false,
          }
        );
        recordEntries.push({
          recordId: record.recordId,
          childName: basename(dirname(promoted.destPath)),
          productRelativePath: record.productRelativePath,
          files: record.files,
        });
      }
      journal = { ...journal, records: recordEntries };
      await writeQuickLookSetRecord(recordPath, journal);
      await retirePackagePromotionRecordsForWorkspace(stagingRoot, deps.promotionJournalRoot);
      if (!(await verifyQuickLookSetAtRoot(journal, finalRoot))) {
        throw new Error('Copied Quick Look package set does not match its verified snapshot.');
      }

      journal = { ...journal, state: 'completed', committed: false };
      await writeQuickLookSetRecord(recordPath, journal);
      await rm(join(finalRoot, QUICK_LOOK_PROMOTION_OWNER_FILE), { force: true });
      published = true;
      let committed = false;
      const repoRoot = findManagedRepoRoot(realTarget);
      if (repoRoot) {
        try {
          const forceInclude = journal.records.flatMap((entry) =>
            entry.files.map((file) =>
              fromPackageRelative(file.relativePath, join(finalRoot, entry.childName))
            )
          );
          committed =
            (await commitAllIfDirty(repoRoot, `Import ${relative(realTarget, finalRoot)}`, {
              forceInclude,
            })) !== null;
        } catch (error) {
          console.warn('[quick-look-set-promotion] packages published but commit failed:', error);
        }
      }
      journal = { ...journal, committed };
      await writeQuickLookSetRecord(recordPath, journal);
      const completedGroupRoot = journal.finalRoot;
      await retainImportedPackages(
        deps,
        targetRoot,
        journal.records.map((record) => join(completedGroupRoot, record.childName))
      );
      return quickLookSetResult(journal, targetRoot);
    } finally {
      if (!published && (await exactOwnedSetRoot(journal, stagingRoot))) {
        await retirePackagePromotionRecordsForWorkspace(stagingRoot, deps.promotionJournalRoot);
        await rm(stagingRoot, { recursive: true, force: true });
        await rm(recordPath, { force: true });
      } else if (
        !published &&
        (await exactSetRootIdentity(journal, stagingRoot)) &&
        (await ownerToken(stagingRoot)) === null
      ) {
        await rmdir(stagingRoot).catch(() => undefined);
        if (!(await lstat(stagingRoot).catch(() => null))) {
          await rm(recordPath, { force: true });
        }
      }
    }
  });
}

export async function importFileIntoWorkspaceRoot(
  request: ImportFileRequest,
  deps: ImportFileIntoWorkspaceDeps
): Promise<ImportFileResult> {
  const { db, managedRootDir } = deps;

  const realSource = await realpath(request.sourcePath);
  const sourceStat = await stat(realSource);
  if (!sourceStat.isFile()) {
    throw new Error(`Cannot import a non-file as a workspace file: ${request.sourcePath}`);
  }

  const realTarget = await realpath(request.targetRoot);
  const targetStat = await stat(realTarget);
  if (!targetStat.isDirectory()) {
    throw new Error(`Import target is not a directory: ${request.targetRoot}`);
  }

  await assertKnownImportDestination(request.targetRoot, { db, managedRootDir });

  const base = basename(realSource);
  const ext = extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const dedupMode = request.dedup?.mode;
  const expectedRelPath = validatedExpectedRelPath(
    request.targetRoot,
    request.dedup?.expectedRelPath
  );

  if (dedupMode === 'skip') {
    await assertExpectedSourceDigest(realSource, request.expectedSourceSha256);
    const rel = expectedRelPath ?? base;
    return {
      destPath: join(request.targetRoot, rel),
      relPath: rel,
      committed: false,
      skipped: true,
    };
  }

  if (isWorkImportCandidate(realSource))
    assertIndependentWorkImport(realSource, await readFile(realSource, 'utf8'));

  let relPath: string;
  let destPath: string;
  let replaced = false;
  let packageProductPaths: string[] | undefined;
  let materializedDuringReplace = false;

  if (dedupMode === 'replace') {
    relPath = expectedRelPath ?? base;
    destPath = join(request.targetRoot, relPath);
    await assertPhysicalWriteDestination(request.targetRoot, destPath);
    const overwritePackageRoot = await existingPlasmidPackageRootForProduct(destPath);
    if (overwritePackageRoot) {
      await retainImportedPackages(deps, request.targetRoot, [overwritePackageRoot]);
      const looseImport = join(request.targetRoot, `.${stem}.import-${randomUUID()}${ext}`);
      let looseImportIdentity: PhysicalFileIdentity | undefined;
      try {
        await copyFile(realSource, looseImport, fsConstants.COPYFILE_EXCL);
        looseImportIdentity = await physicalFileIdentity(looseImport);
        await assertExpectedSourceDigest(looseImport, request.expectedSourceSha256);
        const materialized = await materializeImportedSequencePackages(looseImport, undefined, {
          overwritePackageRoot,
          expectedSourceSha256: request.expectedSourceSha256,
          confirmedDnaSourceSha256: request.confirmedDnaSourceSha256,
          confirmedNucleicAcid: request.confirmedNucleicAcid,
        });
        const [first] = materialized.packages;
        if (!materialized.converted || !first) {
          throw new Error(
            materialized.skippedReason ??
              'The replacement could not be represented as one plasmid package product.'
          );
        }
        destPath = first.productPath;
        relPath = relative(request.targetRoot, first.productPath);
        packageProductPaths = materialized.packages.map((pkg) => pkg.productPath);
        materializedDuringReplace = true;
      } catch (err) {
        if (looseImportIdentity) {
          await unlinkIfIdentityMatches(looseImport, looseImportIdentity).catch(() => {});
        }
        throw err;
      }
    } else {
      const tmpDest = join(request.targetRoot, `.${stem}.import-${randomUUID()}${ext}.tmp`);
      let tmpDestIdentity: PhysicalFileIdentity | undefined;
      try {
        await copyFile(realSource, tmpDest, fsConstants.COPYFILE_EXCL);
        tmpDestIdentity = await physicalFileIdentity(tmpDest);
        await assertExpectedSourceDigest(tmpDest, request.expectedSourceSha256);
        await rename(tmpDest, destPath);
      } catch (err) {
        if (tmpDestIdentity) {
          await unlinkIfIdentityMatches(tmpDest, tmpDestIdentity).catch(() => {});
        }
        throw err;
      }
    }
    replaced = true;
  } else {
    relPath = base;
    destPath = join(request.targetRoot, relPath);
    for (let n = 1; ; n += 1) {
      let copiedIdentity: PhysicalFileIdentity | undefined;
      try {
        await copyFile(realSource, destPath, fsConstants.COPYFILE_EXCL);
        copiedIdentity = await physicalFileIdentity(destPath);
        await assertExpectedSourceDigest(destPath, request.expectedSourceSha256);
        break;
      } catch (err) {
        if (copiedIdentity) {
          try {
            await unlinkIfIdentityMatches(destPath, copiedIdentity);
          } catch (cleanupError) {
            throw new AggregateError(
              [err, cleanupError],
              `The changed sequence copy was rejected but could not be removed from "${destPath}".`
            );
          }
          throw err;
        }
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST' && n <= 1000) {
          relPath = `${stem} (${n})${ext}`;
          destPath = join(request.targetRoot, relPath);
          continue;
        }
        throw err;
      }
    }
  }

  if (!materializedDuringReplace) {
    const copiedIdentity = await physicalFileIdentity(destPath);
    try {
      const materialized = await materializeImportedSequencePackages(destPath, undefined, {
        expectedSourceSha256: request.expectedSourceSha256,
        confirmedDnaSourceSha256: request.confirmedDnaSourceSha256,
        confirmedNucleicAcid: request.confirmedNucleicAcid,
      });
      const [first] = materialized.packages;
      if (materialized.converted && first) {
        destPath = first.productPath;
        relPath = relative(request.targetRoot, first.productPath);
        packageProductPaths = materialized.packages.map((pkg) => pkg.productPath);
      } else if (request.expectedSourceSha256) {
        throw new Error(
          materialized.skippedReason ??
            'The confirmed DNA sequence could not be materialized as an authoritative package.'
        );
      }
    } catch (err) {
      if (request.expectedSourceSha256) {
        await unlinkIfIdentityMatches(destPath, copiedIdentity).catch(() => {});
        throw err;
      }
      console.warn(`[importFile] imported ${relPath} but could not package it:`, err);
    }
  }

  if (!replaced && !packageProductPaths && packagedCoordinateFormat(relPath)) {
    try {
      const copiedIdentity = await physicalFileIdentity(destPath);
      const packaged = await materializeCoordinatePackage(destPath, {
        removeSource: (path) => unlinkIfIdentityMatches(path, copiedIdentity),
      });
      if (packaged.converted) {
        destPath = packaged.productPath;
        relPath = relative(request.targetRoot, packaged.productPath);
      } else if (packaged.skippedReason) {
        console.warn(`[importFile] kept ${relPath} as a coordinate file:`, packaged.skippedReason);
      }
    } catch (err) {
      console.warn(`[importFile] imported ${relPath} but could not make a molecular view:`, err);
    }
  }

  let committed = false;
  const repoRoot = findManagedRepoRoot(request.targetRoot);
  if (repoRoot) {
    try {
      const oid = await commitAllIfDirty(repoRoot, `Import ${relPath}`, {
        forceInclude: requiredGitFilesForProducts(packageProductPaths),
      });
      committed = oid !== null;
    } catch (err) {
      console.warn(`[importFile] copied ${relPath} but commit failed (will reconcile later):`, err);
    }
  }

  await retainImportedPackages(
    deps,
    request.targetRoot,
    (packageProductPaths ?? []).map((path) => dirname(path))
  );
  return {
    destPath,
    relPath,
    committed,
    ...(replaced ? { replaced: true } : {}),
    ...(packageProductPaths ? { packageProductPaths } : {}),
  };
}

type NativeSequenceCollisionPolicy = ImportSequenceContentRequest['collisionPolicy'] | 'keep-both';
type NativeSequenceRefusalCode = Extract<ImportSequenceContentResult, { kind: 'refused' }>['code'];

class NativeSequenceImportRefusal extends Error {
  constructor(
    readonly code: NativeSequenceRefusalCode,
    message: string
  ) {
    super(message);
    this.name = 'NativeSequenceImportRefusal';
  }
}

type NativeSequenceImportPlan =
  | {
      kind: 'create';
      logicalPath: string;
      collisionPolicy: 'refuse' | 'keep-both';
      replaced: boolean;
    }
  | {
      kind: 'replace-package';
      logicalPath: string;
      packageRoot: string;
      reserveLogicalPath: boolean;
      expectedPackage?: ExpectedSequencePackageState;
    }
  | {
      kind: 'replace-loose';
      logicalPath: string;
      existingState: { identity: PhysicalFileIdentity; sha256: string } | null;
    };

interface NativeSequenceImportOptions {
  collisionPolicy: NativeSequenceCollisionPolicy;
  requireConverted: boolean;
  reportCommitFailure: boolean;
  replacementRelPath?: string;
}

let sequenceImportBeforeClaimForTest: ((logicalPath: string) => Promise<void>) | undefined;

export function setSequenceImportBeforeClaimForTest(
  observer: ((logicalPath: string) => Promise<void>) | undefined
): void {
  sequenceImportBeforeClaimForTest = observer;
}

function importSequenceRefused(
  code: NativeSequenceRefusalCode,
  error: string
): ImportSequenceContentResult {
  return {
    kind: 'refused',
    code,
    error,
    retriable: false,
    stateChanged: false,
    partialEffects: [],
  };
}

function importSequenceFailed(
  error: unknown,
  stateChanged: boolean | 'unknown',
  partialEffects: Extract<ImportSequenceContentResult, { kind: 'failed' }>['partialEffects'] = []
): ImportSequenceContentResult {
  return {
    kind: 'failed',
    code: 'IMPORT_FAILED',
    error:
      error instanceof Error
        ? error.message
        : 'The native sequence import failed with an unknown error.',
    retriable: false,
    stateChanged,
    partialEffects,
  };
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function captureSequenceFileState(
  path: string,
  initial: Pick<Stats, 'dev' | 'ino'>,
  changedMessage: string
): Promise<{ identity: PhysicalFileIdentity; sha256: string }> {
  try {
    const sha256 = await inspectSequenceFileSha256(path);
    const confirmed = await lstat(path);
    if (confirmed.dev !== initial.dev || confirmed.ino !== initial.ino) {
      throw new Error('sequence file identity changed during validation');
    }
    return { identity: { dev: initial.dev, ino: initial.ino }, sha256 };
  } catch {
    throw new NativeSequenceImportRefusal('IMPORT_TARGET_EXISTS', changedMessage);
  }
}

async function removeEmptyCreatedDirectories(
  leaf: string,
  firstCreated: string | undefined
): Promise<boolean> {
  if (!firstCreated) return true;
  const stopAfter = dirname(firstCreated);
  let current = leaf;
  for (;;) {
    try {
      await rmdir(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(code === 'ENOENT')) {
        if (code === 'ENOTEMPTY' || code === 'EEXIST') {
          return true;
        } else {
          throw error;
        }
      }
    }
    if (current === firstCreated) return true;
    const parent = dirname(current);
    if (parent === current || parent === stopAfter) return true;
    current = parent;
  }
}

async function restoreSequenceImportBackup(
  backupPath: string,
  targetPath: string,
  expected: PhysicalFileIdentity
): Promise<boolean> {
  const current = await lstatOrNull(backupPath);
  if (!current || current.dev !== expected.dev || current.ino !== expected.ino) return false;
  if (current.isSymbolicLink()) {
    await symlink(await readlink(backupPath), targetPath);
  } else if (current.isFile()) {
    await claimRegularFileNoClobber(backupPath, targetPath);
  } else {
    return false;
  }
  return unlinkIfIdentityMatches(backupPath, expected);
}

async function captureExpectedSequencePackageState(
  packageRoot: string,
  expectedStem: string,
  packageStat: Stats
): Promise<ExpectedSequencePackageState> {
  if (!packageStat.isDirectory()) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_INVALID_PACKAGE',
      `Cannot replace "${expectedStem}": its package destination is not a managed sequence package.`
    );
  }

  const markerPath =
    sequencePackageMetaPaths(packageRoot).find((path) => existsSync(path)) ??
    sequencePackagePaths(packageRoot).metaPath;
  let markerStat: Stats;
  let markerBytes: Buffer;
  let record: ReturnType<typeof parseSequencePackageDocument>;
  try {
    await assertPhysicalPackageMember(packageRoot, markerPath);
    markerStat = await lstat(markerPath);
    if (!markerStat.isFile()) throw new Error('the package marker is not a physical file');
    markerBytes = await readFile(markerPath);
    const confirmedMarkerStat = await lstat(markerPath);
    if (confirmedMarkerStat.dev !== markerStat.dev || confirmedMarkerStat.ino !== markerStat.ino) {
      throw new NativeSequenceImportRefusal(
        'IMPORT_TARGET_EXISTS',
        `Cannot replace "${expectedStem}": its package marker changed while replacement was starting.`
      );
    }
    record = parseSequencePackageDocument(markerBytes.toString('utf8'));
  } catch (error) {
    if (error instanceof NativeSequenceImportRefusal) throw error;
    throw new NativeSequenceImportRefusal(
      'IMPORT_INVALID_PACKAGE',
      `Cannot replace "${expectedStem}": the existing managed package record is invalid (${
        error instanceof Error ? error.message : 'unknown error'
      }).`
    );
  }

  const productFile = record.product.file;
  if (stripSequenceProductExtension(productFile) !== expectedStem) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_PRODUCT_MISMATCH',
      `Cannot replace "${expectedStem}": the existing package describes a different product ("${productFile}").`
    );
  }
  const productPath = sequencePackagePaths(packageRoot, { productFile }).productPath;
  try {
    await assertPhysicalWriteDestination(packageRoot, productPath);
  } catch (error) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_INVALID_PACKAGE',
      `Cannot replace "${expectedStem}": the existing package product is not safe to update (${
        error instanceof Error ? error.message : 'unknown error'
      }).`
    );
  }
  const productStat = await lstatOrNull(productPath);
  if (!productStat) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_PRODUCT_MISSING',
      `Cannot replace "${expectedStem}": the existing package product is missing ("${productFile}").`
    );
  }
  if (!productStat.isFile() && !productStat.isSymbolicLink()) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_INVALID_PACKAGE',
      `Cannot replace "${expectedStem}": the existing package product is not a file.`
    );
  }
  const productState = await captureSequenceFileState(
    productPath,
    productStat,
    `Cannot replace "${expectedStem}": its product changed while replacement was starting.`
  );
  const generatedMemberFiles = [
    ...record.members
      .filter((member) => member.role === 'primer-export')
      .map((member) => member.path),
    record.assembly?.primers?.csv,
    record.assembly?.primers?.fasta,
  ]
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .flatMap((path) => sequencePrimerArtifactLookupPaths(path))
    .map((path) => path.replace(/\\/g, '/'));
  const generatedMembers: ExpectedSequencePackageState['generatedMembers'] = [];
  for (const file of [...new Set(generatedMemberFiles)]) {
    let memberPath: string;
    try {
      memberPath = fromPackageRelative(file, packageRoot);
      await assertPhysicalPackageMember(packageRoot, memberPath);
    } catch (error) {
      throw new NativeSequenceImportRefusal(
        'IMPORT_INVALID_PACKAGE',
        `Cannot replace "${expectedStem}": a generated package member is not safe to update (${
          error instanceof Error ? error.message : 'unknown error'
        }).`
      );
    }
    const memberStat = await lstatOrNull(memberPath);
    if (!memberStat) {
      generatedMembers.push({ file, identity: null, sha256: null });
      continue;
    }
    if (!memberStat.isFile()) {
      throw new NativeSequenceImportRefusal(
        'IMPORT_INVALID_PACKAGE',
        `Cannot replace "${expectedStem}": a generated package member is not a file ("${file}").`
      );
    }
    const memberState = await captureSequenceFileState(
      memberPath,
      memberStat,
      `Cannot replace "${expectedStem}": a generated package member changed while replacement was starting.`
    );
    generatedMembers.push({
      file,
      identity: memberState.identity,
      sha256: memberState.sha256,
    });
  }
  const confirmedPackageStat = await lstatOrNull(packageRoot);
  if (
    !confirmedPackageStat ||
    confirmedPackageStat.dev !== packageStat.dev ||
    confirmedPackageStat.ino !== packageStat.ino
  ) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_TARGET_EXISTS',
      `Cannot replace "${expectedStem}": its package changed while replacement was starting.`
    );
  }

  return {
    rootIdentity: { dev: packageStat.dev, ino: packageStat.ino },
    markerFile: relative(packageRoot, markerPath).split(sep).join('/'),
    markerIdentity: { dev: markerStat.dev, ino: markerStat.ino },
    markerSha256: createHash('sha256').update(markerBytes).digest('hex'),
    productIdentity: productState.identity,
    productSha256: productState.sha256,
    generatedMembers,
    id: record.id,
    productFile,
  };
}

async function strictReplacementPlan(logicalPath: string): Promise<NativeSequenceImportPlan> {
  const extension = extname(logicalPath);
  const stem = basename(logicalPath).slice(0, -extension.length);
  const packageRoot = join(dirname(logicalPath), stem);
  const [looseStat, packageStat] = await Promise.all([
    lstatOrNull(logicalPath),
    lstatOrNull(packageRoot),
  ]);

  if (looseStat && packageStat) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_DUPLICATE_TARGET',
      `Cannot replace "${stem}": both a loose import artifact and its managed package exist.`
    );
  }
  if (packageStat) {
    return {
      kind: 'replace-package',
      logicalPath,
      packageRoot,
      reserveLogicalPath: true,
      expectedPackage: await captureExpectedSequencePackageState(packageRoot, stem, packageStat),
    };
  }
  if (looseStat) {
    if (!looseStat.isFile() && !looseStat.isSymbolicLink()) {
      throw new NativeSequenceImportRefusal(
        'IMPORT_INVALID_PACKAGE',
        `Cannot replace "${stem}": the existing destination is not a file.`
      );
    }
    return {
      kind: 'replace-loose',
      logicalPath,
      existingState: await captureSequenceFileState(
        logicalPath,
        looseStat,
        `Cannot replace "${stem}": the loose destination changed while replacement was starting.`
      ),
    };
  }
  return { kind: 'create', logicalPath, collisionPolicy: 'refuse', replaced: false };
}

async function uiReplacementPlan(
  targetRoot: string,
  replacementRelPath: string,
  logicalFileName: string
): Promise<NativeSequenceImportPlan> {
  const relPath = validatedExpectedRelPath(targetRoot, replacementRelPath);
  if (!relPath) throw new Error('A replacement path is required.');
  const replacementPath = join(targetRoot, relPath);
  const candidatePackageRoot = dirname(replacementPath);
  const recognizedPackageRoot = await existingPlasmidPackageRootForProduct(replacementPath);
  const packageRoot =
    recognizedPackageRoot ??
    (sequencePackageMetaPaths(candidatePackageRoot).some((path) => existsSync(path))
      ? candidatePackageRoot
      : null);
  if (packageRoot) {
    const packageStat = await lstat(packageRoot);
    const expectedStem = stripSequenceProductExtension(basename(replacementPath));
    return {
      kind: 'replace-package',
      logicalPath: join(dirname(packageRoot), logicalFileName),
      packageRoot,
      reserveLogicalPath: false,
      expectedPackage: await captureExpectedSequencePackageState(
        packageRoot,
        expectedStem,
        packageStat
      ),
    };
  }
  const existing = await lstatOrNull(replacementPath);
  return {
    kind: 'replace-loose',
    logicalPath: replacementPath,
    existingState: existing
      ? await captureSequenceFileState(
          replacementPath,
          existing,
          'The loose destination changed while replacement was starting.'
        )
      : null,
  };
}

type NativeSequenceImportRequest = Omit<ImportSequenceContentRequest, 'collisionPolicy'>;
type NativeSequenceMaterialization = Awaited<
  ReturnType<typeof materializeImportedSequencePackages>
>;

async function prepareNativeSequenceImportPlan(
  request: NativeSequenceImportRequest,
  deps: ImportFileIntoWorkspaceDeps,
  options: NativeSequenceImportOptions
): Promise<NativeSequenceImportPlan> {
  const target = await realpath(request.targetRoot);
  if (!(await stat(target)).isDirectory()) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_INVALID_DESTINATION',
      'Import target is not a directory.'
    );
  }
  await assertKnownImportDestination(request.targetRoot, deps);

  const requestedRelPath = validatedExpectedRelPath(request.targetRoot, request.relativePath);
  if (!requestedRelPath) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_INVALID_DESTINATION',
      'A sequence destination is required.'
    );
  }
  const requestedPath = join(request.targetRoot, requestedRelPath);
  const requestedFileName = basename(requestedPath);
  if (!isConstructSequenceFile(requestedFileName)) {
    throw new NativeSequenceImportRefusal(
      'IMPORT_CONVERSION_REQUIRED',
      'The native sequence importer accepts GenBank or nucleotide FASTA destinations.'
    );
  }
  if (options.collisionPolicy !== 'replace') {
    return {
      kind: 'create',
      logicalPath: requestedPath,
      collisionPolicy: options.collisionPolicy,
      replaced: false,
    };
  }
  return options.replacementRelPath
    ? uiReplacementPlan(request.targetRoot, options.replacementRelPath, requestedFileName)
    : strictReplacementPlan(requestedPath);
}

async function sequenceImportSetupFailure(
  error: unknown,
  destinationDirectory: string,
  firstCreatedDirectory: string | undefined,
  recoveryNote: string
): Promise<ImportSequenceContentResult> {
  const directoriesCleaned = await removeEmptyCreatedDirectories(
    destinationDirectory,
    firstCreatedDirectory
  ).catch(() => false);
  return importSequenceFailed(
    error,
    directoriesCleaned ? false : 'unknown',
    directoriesCleaned ? [] : [{ kind: 'sequence-import-recovery-retained', note: recoveryNote }]
  );
}

class NativeSequenceImportTransaction {
  private readonly stagePath: string;
  private readonly expectedSourceSha256: string;
  private stageIdentity: PhysicalFileIdentity | undefined;
  private reservationPath: string | undefined;
  private reservationIdentity: PhysicalFileIdentity | undefined;
  private reservationKind: 'directory' | 'file' = 'directory';
  private backupPath: string | undefined;
  private backupIdentity: PhysicalFileIdentity | undefined;
  private packageRoots: string[] = [];
  private productPaths: string[] = [];
  private keepLooseResult = false;
  private materializationAttempted = false;
  private committed = false;

  constructor(
    private readonly request: NativeSequenceImportRequest,
    private readonly deps: ImportFileIntoWorkspaceDeps,
    private readonly options: NativeSequenceImportOptions,
    private plan: NativeSequenceImportPlan,
    private readonly destinationDirectory: string,
    private readonly firstCreatedDirectory: string | undefined,
    private readonly stageRoot: string
  ) {
    this.stagePath = join(stageRoot, 'source');
    this.expectedSourceSha256 = createHash('sha256').update(request.content, 'utf8').digest('hex');
  }

  async run(): Promise<ImportSequenceContentResult> {
    try {
      await this.stageSource();
      await sequenceImportBeforeClaimForTest?.(this.plan.logicalPath);
      await this.claimDestination();
      if (this.plan.kind === 'replace-package')
        await retainImportedPackages(this.deps, this.request.targetRoot, [this.plan.packageRoot]);
      const materialized = await this.materializeSource();
      await this.acceptMaterialization(materialized);
      await retainImportedPackages(this.deps, this.request.targetRoot, this.packageRoots);
      const settlementFailure = await this.settleImport();
      return settlementFailure ?? (await this.commitAndBuildResult());
    } catch (error) {
      return this.handleFailure(error);
    }
  }

  private async stageSource(): Promise<void> {
    await writeFile(this.stagePath, this.request.content, { encoding: 'utf8', flag: 'wx' });
    this.stageIdentity = await physicalFileIdentity(this.stagePath);
  }

  private async claimDestination(): Promise<void> {
    await this.backUpLooseDestination();
    if (this.plan.kind === 'create' && this.plan.collisionPolicy === 'keep-both') {
      await this.reserveKeepBothDestination();
      return;
    }
    if (this.plan.kind !== 'replace-package' || this.plan.reserveLogicalPath) {
      await this.reserveExactDestination();
    }
  }

  private async backUpLooseDestination(): Promise<void> {
    if (this.plan.kind !== 'replace-loose' || !this.plan.existingState) return;

    const expected = this.plan.existingState;
    const beforeMove = await lstatOrNull(this.plan.logicalPath);
    if (!this.identitiesMatch(beforeMove, expected.identity)) {
      throw new NativeSequenceImportRefusal(
        'IMPORT_TARGET_EXISTS',
        'The loose destination changed while replacement was starting. Nothing was replaced.'
      );
    }
    if (beforeMove?.isSymbolicLink()) {
      let unchanged = false;
      try {
        unchanged = (await inspectSequenceFileSha256(this.plan.logicalPath)) === expected.sha256;
      } catch {
        unchanged = false;
      }
      if (!unchanged) {
        throw new NativeSequenceImportRefusal(
          'IMPORT_TARGET_EXISTS',
          'The loose destination changed while replacement was starting. Nothing was replaced.'
        );
      }
    }
    this.backupPath = join(this.stageRoot, 'previous');
    const renameFile = this.deps.sequenceImportFileOps?.rename ?? rename;
    await renameFile(this.plan.logicalPath, this.backupPath);
    const moved = await lstat(this.backupPath);
    this.backupIdentity = { dev: moved.dev, ino: moved.ino };
    let movedContentMatches = !moved.isFile();
    if (moved.isFile()) {
      try {
        movedContentMatches =
          (await inspectSequenceFileSha256(this.backupPath)) === expected.sha256;
      } catch {
        movedContentMatches = false;
      }
    }
    if (this.identitiesMatch(this.backupIdentity, expected.identity) && movedContentMatches) return;

    if (!(await this.restoreBackup())) {
      throw new Error('The destination changed during replacement and its recovery was retained.');
    }
    throw new NativeSequenceImportRefusal(
      'IMPORT_TARGET_EXISTS',
      'The destination changed while replacement was starting. Nothing was replaced.'
    );
  }

  private async reserveKeepBothDestination(): Promise<void> {
    const extension = extname(this.plan.logicalPath);
    const baseStem = basename(this.plan.logicalPath).slice(0, -extension.length);
    for (let suffix = 0; suffix <= 1000; suffix += 1) {
      const candidateName =
        suffix === 0 ? `${baseStem}${extension}` : `${baseStem} (${suffix})${extension}`;
      const candidatePath = join(dirname(this.plan.logicalPath), candidateName);
      try {
        const identity = await this.claimReservationDirectory(candidatePath);
        this.plan = { ...this.plan, logicalPath: candidatePath };
        this.recordDirectoryReservation(candidatePath, identity);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('No collision-free sequence destination is available.');
  }

  private async reserveExactDestination(): Promise<void> {
    try {
      const identity = await this.claimReservationDirectory(this.plan.logicalPath);
      this.recordDirectoryReservation(this.plan.logicalPath, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const replacingPackage = this.plan.kind === 'replace-package';
      throw new NativeSequenceImportRefusal(
        replacingPackage ? 'IMPORT_DUPLICATE_TARGET' : 'IMPORT_TARGET_EXISTS',
        replacingPackage
          ? 'A loose artifact appeared beside the package while replacement was starting.'
          : `A sequence destination named "${basename(
              this.plan.logicalPath,
              extname(this.plan.logicalPath)
            )}" already exists.`
      );
    }
  }

  private async claimReservationDirectory(path: string): Promise<PhysicalFileIdentity> {
    const createDirectory =
      this.deps.sequenceImportFileOps?.mkdir ??
      (async (directoryPath: string) => {
        await mkdir(directoryPath);
      });
    return claimEmptyDirectoryNoClobber(path, createDirectory);
  }

  private recordDirectoryReservation(path: string, identity: PhysicalFileIdentity): void {
    this.reservationPath = path;
    this.reservationIdentity = identity;
    this.reservationKind = 'directory';
  }

  private async materializeSource(): Promise<NativeSequenceMaterialization> {
    this.materializationAttempted = true;
    const materialize =
      this.deps.sequencePackageMaterializer ?? materializeImportedSequencePackages;
    try {
      return await materialize(this.stagePath, this.deps.sequencePackageFileOps, {
        expectedSourceSha256: this.expectedSourceSha256,
        ...(this.plan.kind === 'replace-package'
          ? {
              overwritePackageRoot: this.plan.packageRoot,
              ...(this.plan.expectedPackage
                ? { expectedOverwritePackage: this.plan.expectedPackage }
                : {}),
            }
          : {}),
        logicalFileName: basename(this.plan.logicalPath),
        destinationDirectory: dirname(this.plan.logicalPath),
        ...(this.plan.kind === 'create' || this.plan.kind === 'replace-loose'
          ? { packageCollisionPolicy: this.packageCollisionPolicy() }
          : {}),
      });
    } catch (error) {
      if (!(await this.canFallBackToLooseFile())) throw error;
      console.warn(
        `[importContent] could not package ${relative(
          this.request.targetRoot,
          this.plan.logicalPath
        )}; publishing the owned source bytes as a loose file instead:`,
        error
      );
      return {
        packages: [],
        converted: false,
        untouchedPath: this.stagePath,
        skippedReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private packageCollisionPolicy(): 'exact' | 'keep-both' {
    return this.plan.kind === 'create' && this.plan.collisionPolicy === 'keep-both'
      ? 'keep-both'
      : 'exact';
  }

  private async canFallBackToLooseFile(): Promise<boolean> {
    if (this.options.requireConverted || this.plan.kind === 'replace-package') return false;
    return this.stageMatchesRequest();
  }

  private async acceptMaterialization(materialized: NativeSequenceMaterialization): Promise<void> {
    this.packageRoots = materialized.packages.map((pkg) => pkg.packageRoot);
    this.productPaths = materialized.packages.map((pkg) => pkg.productPath);
    if (materialized.converted && this.productPaths.length > 0) return;

    if (this.options.requireConverted || this.plan.kind === 'replace-package') {
      throw new NativeSequenceImportRefusal(
        'IMPORT_CONVERSION_REQUIRED',
        materialized.skippedReason ?? 'The sequence could not be represented as a managed package.'
      );
    }
    await this.publishLooseFile();
  }

  private async publishLooseFile(): Promise<void> {
    if (!(await this.stageMatchesRequest())) {
      throw new Error('The staged sequence content changed before it could be published.');
    }
    await this.releaseDirectoryReservation();
    const linkFile = this.deps.sequenceImportFileOps?.link ?? link;
    const claim = await claimRegularFileNoClobber(this.stagePath, this.plan.logicalPath, {
      link: linkFile,
    });
    this.reservationPath = this.plan.logicalPath;
    this.reservationIdentity = claim.identity;
    this.reservationKind = 'file';
    if (!(await this.fileMatchesRequest(this.plan.logicalPath, claim.identity))) {
      throw new NativeSequenceImportRefusal(
        'IMPORT_TARGET_EXISTS',
        'The staged sequence content changed while the loose destination was being published.'
      );
    }
    this.keepLooseResult = true;
  }

  private async stageMatchesRequest(): Promise<boolean> {
    return this.fileMatchesRequest(this.stagePath, this.stageIdentity);
  }

  private async fileMatchesRequest(
    path: string,
    expectedIdentity: PhysicalFileIdentity | undefined
  ): Promise<boolean> {
    const identityBeforeRead = await lstatOrNull(path);
    if (!this.identitiesMatch(identityBeforeRead, expectedIdentity)) return false;
    const currentSha256 = await sha256File(path);
    const identityAfterRead = await lstatOrNull(path);
    return (
      this.identitiesMatch(identityAfterRead, expectedIdentity) &&
      currentSha256 === this.expectedSourceSha256
    );
  }

  private async releaseDirectoryReservation(): Promise<void> {
    if (
      !this.reservationPath ||
      !this.reservationIdentity ||
      this.reservationKind !== 'directory'
    ) {
      return;
    }
    const released = await rmdirIfIdentityMatches(this.reservationPath, this.reservationIdentity);
    if (!released) {
      throw new Error('The loose destination claim changed before it could be published.');
    }
    this.reservationPath = undefined;
    this.reservationIdentity = undefined;
  }

  private async settleImport(): Promise<ImportSequenceContentResult | undefined> {
    return this.keepLooseResult ? this.settleLooseImport() : this.settlePackageImport();
  }

  private async settlePackageImport(): Promise<ImportSequenceContentResult | undefined> {
    if (await this.cleanup(true)) return undefined;
    return {
      kind: 'failed',
      code: 'IMPORT_FAILED',
      error:
        'The package was created, but private import recovery files could not be fully retired.',
      retriable: false,
      stateChanged: true,
      partialEffects: [
        { kind: 'sequence-packages-created', count: this.packageRoots.length },
        {
          kind: 'sequence-import-recovery-retained',
          note: 'Private recovery data could not be retired without risking bytes owned by another writer.',
        },
      ],
      packageRoots: this.packageRoots,
      packageProductPaths: this.productPaths,
    };
  }

  private async settleLooseImport(): Promise<ImportSequenceContentResult | undefined> {
    await this.assertLooseReservationStillOwned();
    if (await this.cleanupPrivateLooseRecovery()) return undefined;
    return {
      kind: 'failed',
      code: 'IMPORT_FAILED',
      error:
        'The loose import was created, but private import recovery files could not be fully retired.',
      retriable: false,
      stateChanged: true,
      partialEffects: [
        {
          kind: 'sequence-import-recovery-retained',
          note: 'Private recovery data could not be retired without risking bytes owned by another writer.',
        },
      ],
    };
  }

  private async assertLooseReservationStillOwned(): Promise<void> {
    if (!this.reservationPath || !this.reservationIdentity) {
      throw new Error('The loose import reached settlement without an owned destination claim.');
    }
    const currentReservation = await lstatOrNull(this.reservationPath);
    if (!this.identitiesMatch(currentReservation, this.reservationIdentity)) {
      throw new Error('The claimed loose destination changed before import settlement.');
    }
  }

  private async cleanupPrivateLooseRecovery(): Promise<boolean> {
    let complete = true;
    if (this.stageIdentity) {
      complete =
        (await unlinkIfIdentityMatches(this.stagePath, this.stageIdentity).catch(() => false)) &&
        complete;
    }
    if (this.backupPath && this.backupIdentity) {
      complete =
        (await unlinkIfIdentityMatches(this.backupPath, this.backupIdentity).catch(() => false)) &&
        complete;
    }
    return (await this.removeStageRoot()) && complete;
  }

  private async commitAndBuildResult(): Promise<ImportSequenceContentResult> {
    const destPath = this.productPaths[0] ?? this.plan.logicalPath;
    const relPath = relative(this.request.targetRoot, destPath);
    const commitFailure = await this.commitManagedWorkspace(relPath);
    if (commitFailure) return commitFailure;

    return {
      kind: 'imported',
      destPath,
      relPath,
      packageRoots: this.packageRoots,
      packageProductPaths: this.productPaths,
      committed: this.committed,
      replaced: this.plan.kind !== 'create' || this.plan.replaced,
      stateChanged: true,
      partialEffects: [],
    };
  }

  private async commitManagedWorkspace(
    relPath: string
  ): Promise<ImportSequenceContentResult | undefined> {
    const repoRoot = findManagedRepoRoot(this.request.targetRoot);
    if (!repoRoot) return undefined;
    try {
      const commit = this.deps.commitAllIfDirty ?? commitAllIfDirty;
      const oid = await commit(repoRoot, `Import ${relPath}`, {
        forceInclude: requiredGitFilesForProducts(this.productPaths),
      });
      this.committed = oid !== null;
      return undefined;
    } catch (error) {
      if (!this.options.reportCommitFailure) {
        console.warn(
          `[importContent] wrote ${relPath} but commit failed (will reconcile later):`,
          error
        );
        return undefined;
      }
      return {
        kind: 'failed',
        code: 'IMPORT_COMMIT_FAILED',
        error: `The managed sequence package was created, but its repository commit failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retriable: false,
        stateChanged: true,
        partialEffects: [{ kind: 'sequence-packages-created', count: this.packageRoots.length }],
        packageRoots: this.packageRoots,
        packageProductPaths: this.productPaths,
      };
    }
  }

  private async handleFailure(error: unknown): Promise<ImportSequenceContentResult> {
    const materializedEffects = this.packageRoots.length > 0;
    const restored = await this.restoreForFailure();
    const cleaned = await this.cleanup(false);
    const directoriesCleaned = await this.cleanupCreatedDirectoriesAfterFailure(
      materializedEffects,
      restored,
      cleaned
    );

    if (this.canReportCleanRefusal(error, restored, cleaned, directoriesCleaned)) {
      return importSequenceRefused(error.code, error.message);
    }
    if (
      error instanceof SequencePackageTargetExistsError &&
      restored &&
      cleaned &&
      directoriesCleaned
    ) {
      return importSequenceRefused(
        'IMPORT_TARGET_EXISTS',
        `A managed sequence package named "${basename(error.packageRoot)}" already exists.`
      );
    }
    if (
      error instanceof SequencePackageTargetChangedError &&
      restored &&
      cleaned &&
      directoriesCleaned
    ) {
      return importSequenceRefused(
        'IMPORT_TARGET_EXISTS',
        'The managed sequence package changed while replacement was starting. Nothing was replaced.'
      );
    }
    return this.buildFailedResult(
      error,
      materializedEffects,
      restored,
      cleaned,
      directoriesCleaned
    );
  }

  private async restoreForFailure(): Promise<boolean> {
    if (!this.backupIdentity) return true;
    if (this.reservationPath && this.reservationIdentity) {
      const removed = await this.removeOwnedReservation();
      if (removed) this.reservationIdentity = undefined;
    }
    return this.restoreBackup();
  }

  private async cleanupCreatedDirectoriesAfterFailure(
    materializedEffects: boolean,
    restored: boolean,
    cleaned: boolean
  ): Promise<boolean> {
    if (materializedEffects || !restored || !cleaned) return true;
    return removeEmptyCreatedDirectories(
      this.destinationDirectory,
      this.firstCreatedDirectory
    ).catch(() => false);
  }

  private canReportCleanRefusal(
    error: unknown,
    restored: boolean,
    cleaned: boolean,
    directoriesCleaned: boolean
  ): error is NativeSequenceImportRefusal {
    return (
      error instanceof NativeSequenceImportRefusal &&
      restored &&
      cleaned &&
      directoriesCleaned &&
      this.packageRoots.length === 0
    );
  }

  private buildFailedResult(
    error: unknown,
    materializedEffects: boolean,
    restored: boolean,
    cleaned: boolean,
    directoriesCleaned: boolean
  ): ImportSequenceContentResult {
    const recoveryRetained = !restored || !cleaned || !directoriesCleaned;
    return {
      kind: 'failed',
      code: 'IMPORT_FAILED',
      error:
        error instanceof Error
          ? error.message
          : 'The native sequence import failed with an unknown error.',
      retriable: false,
      stateChanged: materializedEffects
        ? true
        : this.materializationAttempted
          ? 'unknown'
          : restored && cleaned && directoriesCleaned
            ? false
            : 'unknown',
      partialEffects: [
        ...(materializedEffects
          ? [{ kind: 'sequence-packages-created' as const, count: this.packageRoots.length }]
          : []),
        ...(recoveryRetained
          ? [
              {
                kind: 'sequence-import-recovery-retained' as const,
                note: 'Recovery data was retained because ownership could not be proven for cleanup.',
              },
            ]
          : []),
      ],
      ...(materializedEffects
        ? { packageRoots: this.packageRoots, packageProductPaths: this.productPaths }
        : {}),
    };
  }

  private async cleanup(removeBackup: boolean): Promise<boolean> {
    let complete = true;
    if (this.reservationPath && this.reservationIdentity) {
      complete = (await this.removeOwnedReservation()) && complete;
    }
    if (this.stageIdentity) {
      complete =
        (await unlinkIfIdentityMatches(this.stagePath, this.stageIdentity).catch(() => false)) &&
        complete;
    }
    if (removeBackup && this.backupPath && this.backupIdentity) {
      complete =
        (await unlinkIfIdentityMatches(this.backupPath, this.backupIdentity).catch(() => false)) &&
        complete;
    }
    return (await this.removeStageRoot()) && complete;
  }

  private async removeOwnedReservation(): Promise<boolean> {
    if (!this.reservationPath || !this.reservationIdentity) return true;
    return (
      this.reservationKind === 'directory'
        ? rmdirIfIdentityMatches(this.reservationPath, this.reservationIdentity)
        : unlinkIfIdentityMatches(this.reservationPath, this.reservationIdentity)
    ).catch(() => false);
  }

  private async removeStageRoot(): Promise<boolean> {
    try {
      await rmdir(this.stageRoot);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  private async restoreBackup(): Promise<boolean> {
    if (!this.backupPath || !this.backupIdentity) return true;
    try {
      const restored = await restoreSequenceImportBackup(
        this.backupPath,
        this.plan.logicalPath,
        this.backupIdentity
      );
      if (restored) this.backupIdentity = undefined;
      return restored;
    } catch {
      return false;
    }
  }

  private identitiesMatch(
    actual: Pick<Stats, 'dev' | 'ino'> | PhysicalFileIdentity | null | undefined,
    expected: PhysicalFileIdentity | undefined
  ): boolean {
    return Boolean(
      actual && expected && actual.dev === expected.dev && actual.ino === expected.ino
    );
  }
}

async function runNativeSequenceContentImport(
  request: NativeSequenceImportRequest,
  deps: ImportFileIntoWorkspaceDeps,
  options: NativeSequenceImportOptions
): Promise<ImportSequenceContentResult> {
  let plan: NativeSequenceImportPlan;
  try {
    plan = await prepareNativeSequenceImportPlan(request, deps, options);
  } catch (error) {
    return error instanceof NativeSequenceImportRefusal
      ? importSequenceRefused(error.code, error.message)
      : importSequenceRefused(
          'IMPORT_INVALID_DESTINATION',
          error instanceof SharedProjectViewOnlyError
            ? error.message
            : 'The sequence destination is not a valid path inside an open writable workspace.'
        );
  }

  const destinationDirectory = dirname(plan.logicalPath);
  let firstCreatedDirectory: string | undefined;
  try {
    await assertPhysicalWriteDestination(request.targetRoot, plan.logicalPath);
    firstCreatedDirectory = await mkdir(destinationDirectory, { recursive: true });
    await assertPhysicalWriteDestination(request.targetRoot, plan.logicalPath);
  } catch (error) {
    return sequenceImportSetupFailure(
      error,
      destinationDirectory,
      firstCreatedDirectory,
      'A destination directory could not be proven empty during setup cleanup.'
    );
  }

  let stageRoot: string;
  try {
    stageRoot = await mkdtemp(join(destinationDirectory, '.dnaforge-sequence-import-'));
  } catch (error) {
    return sequenceImportSetupFailure(
      error,
      destinationDirectory,
      firstCreatedDirectory,
      'A destination directory could not be proven empty after staging failed.'
    );
  }

  return new NativeSequenceImportTransaction(
    request,
    deps,
    options,
    plan,
    destinationDirectory,
    firstCreatedDirectory,
    stageRoot
  ).run();
}

export async function importSequenceContentIntoWorkspaceRoot(
  request: ImportSequenceContentRequest,
  deps: ImportFileIntoWorkspaceDeps
): Promise<ImportSequenceContentResult> {
  return runNativeSequenceContentImport(request, deps, {
    collisionPolicy: request.collisionPolicy,
    requireConverted: true,
    reportCommitFailure: true,
  });
}

export async function importContentIntoWorkspaceRoot(
  request: ImportContentRequest,
  deps: ImportFileIntoWorkspaceDeps
): Promise<ImportFileResult> {
  const { db, managedRootDir } = deps;
  if (request.contentBytes == null && request.content == null) {
    throw new Error(
      'importContentIntoWorkspaceRoot: neither content nor contentBytes was provided.'
    );
  }

  const realTarget = await realpath(request.targetRoot);
  const targetStat = await stat(realTarget);
  if (!targetStat.isDirectory()) {
    throw new Error(`Import target is not a directory: ${request.targetRoot}`);
  }

  await assertKnownImportDestination(request.targetRoot, { db, managedRootDir });

  const base = basename(request.fileName.replace(/\\/g, '/')).trim() || 'sequence.gb';
  const ext = extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const dedupMode = request.dedup?.mode;
  const expectedRelPath = validatedExpectedRelPath(
    request.targetRoot,
    request.dedup?.expectedRelPath
  );

  if (dedupMode === 'skip') {
    const rel = expectedRelPath ?? base;
    return {
      destPath: join(request.targetRoot, rel),
      relPath: rel,
      committed: false,
      skipped: true,
    };
  }

  if (isWorkImportCandidate(base)) {
    const text = request.contentBytes
      ? Buffer.from(request.contentBytes).toString('utf8')
      : request.content!;
    assertIndependentWorkImport(base, text);
  }

  if (request.content !== undefined && isConstructSequenceFile(base)) {
    const nativeResult = await runNativeSequenceContentImport(
      {
        targetRoot: request.targetRoot,
        relativePath: base,
        content: request.content,
      },
      deps,
      {
        collisionPolicy: dedupMode === 'replace' ? 'replace' : 'keep-both',
        requireConverted: false,
        reportCommitFailure: false,
        ...(dedupMode === 'replace' && expectedRelPath
          ? { replacementRelPath: expectedRelPath }
          : {}),
      }
    );
    if (nativeResult.kind !== 'imported') {
      throw new Error(`${nativeResult.code}: ${nativeResult.error}`);
    }
    return {
      destPath: nativeResult.destPath,
      relPath: nativeResult.relPath,
      committed: nativeResult.committed,
      ...(nativeResult.replaced ? { replaced: true } : {}),
      ...(nativeResult.packageProductPaths.length > 0
        ? { packageProductPaths: nativeResult.packageProductPaths }
        : {}),
    };
  }

  let relPath: string;
  let destPath: string;
  let replaced = false;
  let packageProductPaths: string[] | undefined;
  let materializedDuringReplace = false;

  if (dedupMode === 'replace') {
    relPath = expectedRelPath ?? base;
    destPath = join(request.targetRoot, relPath);
    await assertPhysicalWriteDestination(request.targetRoot, destPath);
    const overwritePackageRoot = await existingPlasmidPackageRootForProduct(destPath);
    if (overwritePackageRoot) {
      await retainImportedPackages(deps, request.targetRoot, [overwritePackageRoot]);
      const looseImport = join(request.targetRoot, `.${stem}.import-${randomUUID()}${ext}`);
      try {
        if (request.contentBytes) {
          await writeFile(looseImport, Buffer.from(request.contentBytes), { flag: 'wx' });
        } else {
          await writeFile(looseImport, request.content ?? '', { encoding: 'utf8', flag: 'wx' });
        }
        const materialized = await materializeImportedSequencePackages(looseImport, undefined, {
          overwritePackageRoot,
        });
        const [first] = materialized.packages;
        if (!materialized.converted || !first) {
          throw new Error(
            materialized.skippedReason ??
              'The replacement could not be represented as one plasmid package product.'
          );
        }
        destPath = first.productPath;
        relPath = relative(request.targetRoot, first.productPath);
        packageProductPaths = materialized.packages.map((pkg) => pkg.productPath);
        materializedDuringReplace = true;
      } catch (err) {
        await unlink(looseImport).catch(() => {});
        throw err;
      }
    } else {
      const tmpDest = join(request.targetRoot, `.${stem}.import-${randomUUID()}${ext}.tmp`);
      try {
        if (request.contentBytes) await writeFile(tmpDest, Buffer.from(request.contentBytes));
        else await writeFile(tmpDest, request.content ?? '', 'utf8');
        await rename(tmpDest, destPath);
      } catch (err) {
        await unlink(tmpDest).catch(() => {});
        throw err;
      }
    }
    replaced = true;
  } else {
    relPath = base;
    destPath = join(request.targetRoot, relPath);
    for (let n = 1; ; n += 1) {
      try {
        if (request.contentBytes)
          await writeFile(destPath, Buffer.from(request.contentBytes), { flag: 'wx' });
        else await writeFile(destPath, request.content ?? '', { encoding: 'utf8', flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST' && n <= 1000) {
          relPath = `${stem} (${n})${ext}`;
          destPath = join(request.targetRoot, relPath);
          continue;
        }
        throw err;
      }
    }
  }

  if (!materializedDuringReplace) {
    try {
      const materialized = await materializeImportedSequencePackages(destPath);
      const [first] = materialized.packages;
      if (materialized.converted && first) {
        destPath = first.productPath;
        relPath = relative(request.targetRoot, first.productPath);
        packageProductPaths = materialized.packages.map((pkg) => pkg.productPath);
      }
    } catch (err) {
      console.warn(`[importFile] imported ${relPath} but could not package it:`, err);
    }
  }

  let committed = false;
  const repoRoot = findManagedRepoRoot(request.targetRoot);
  if (repoRoot) {
    try {
      const oid = await commitAllIfDirty(repoRoot, `Import ${relPath}`, {
        forceInclude: requiredGitFilesForProducts(packageProductPaths),
      });
      committed = oid !== null;
    } catch (err) {
      console.warn(
        `[importContent] wrote ${relPath} but commit failed (will reconcile later):`,
        err
      );
    }
  }

  await retainImportedPackages(
    deps,
    request.targetRoot,
    (packageProductPaths ?? []).map((path) => dirname(path))
  );
  return {
    destPath,
    relPath,
    committed,
    ...(replaced ? { replaced: true } : {}),
    ...(packageProductPaths ? { packageProductPaths } : {}),
  };
}

export async function importFolderIntoWorkspaceRoot(
  request: { targetRoot: string; sourcePath: string },
  deps: ImportFileIntoWorkspaceDeps
): Promise<ImportFileResult> {
  const { db, managedRootDir } = deps;

  const realSource = await realpath(request.sourcePath);
  const sourceStat = await stat(realSource);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Cannot import a non-directory as a folder: ${request.sourcePath}`);
  }

  const realTarget = await realpath(request.targetRoot);
  const targetStat = await stat(realTarget);
  if (!targetStat.isDirectory()) {
    throw new Error(`Import target is not a directory: ${request.targetRoot}`);
  }

  await assertKnownImportDestination(request.targetRoot, { db, managedRootDir });

  await scanImportTree(realSource, LARGE_MANAGED_IMPORT_FILE_THRESHOLD_BYTES, true);

  const folderName = basename(realSource) || 'imported';
  let relPath = folderName;
  let destDir = join(request.targetRoot, relPath);
  for (let n = 1; existsSync(destDir); n += 1) {
    if (n > 1000) throw new Error('Too many folder-name collisions on import.');
    relPath = `${folderName} (${n})`;
    destDir = join(request.targetRoot, relPath);
  }

  await mkdir(destDir, { recursive: true });
  await copyTree(realSource, destDir, {
    rootPath: realSource,
    largeFileThresholdBytes: LARGE_MANAGED_IMPORT_FILE_THRESHOLD_BYTES,
    largeFilePolicy: 'copy',
  });

  let requiredGitFiles: string[] = [];
  try {
    const conversion = await convertTreeToPlasmidPackages(destDir);
    requiredGitFiles = conversion.requiredGitFiles;
    if (conversion.failures.length > 0) {
      console.warn(
        `[importFolder] ${conversion.failures.length} file(s) could not be packaged:`,
        conversion.failures
      );
    }
  } catch (err) {
    console.warn('[importFolder] copied the folder but could not package its sequences:', err);
  }

  let committed = false;
  const repoRoot = findManagedRepoRoot(request.targetRoot);
  if (repoRoot) {
    try {
      const oid = await commitAllIfDirty(repoRoot, `Import folder ${relPath}`, {
        forceInclude: requiredGitFiles,
      });
      committed = oid !== null;
    } catch (err) {
      console.warn(
        `[importFolder] copied ${relPath} but commit failed (will reconcile later):`,
        err
      );
    }
  }

  await retainImportedPackages(
    deps,
    request.targetRoot,
    sequenceRootsFromPackageFiles(requiredGitFiles)
  );
  return { destPath: destDir, relPath, committed };
}

export async function importFileAsNewManagedWorkspace(
  sourceFile: string,
  deps: ImportFileIntoWorkspaceDeps
): Promise<ImportManagedWorkspaceResult> {
  const { db, managedRootDir } = deps;
  const realSource = await realpath(sourceFile);
  const sourceStat = await stat(realSource);
  if (!sourceStat.isFile()) {
    throw new Error(`Cannot create a workspace from a non-file: ${sourceFile}`);
  }

  if (isWorkImportCandidate(realSource))
    assertIndependentWorkImport(realSource, await readFile(realSource, 'utf8'));

  const workspaceUuid = randomUUID();
  const repoPath = join(managedRootDir, workspaceUuid, 'repo');
  const base = basename(realSource);
  const ext = extname(base);
  const displayName = (ext ? base.slice(0, base.length - ext.length) : base) || 'workspace';
  const createdAt = Date.now();
  const destName = base === MANAGED_WORKSPACE_MARKER ? `imported-${base}` : base;

  await mkdir(repoPath, { recursive: true });
  await copyFile(realSource, join(repoPath, destName));
  let packageProductPaths: string[] | undefined;
  try {
    const materialized = await materializeImportedSequencePackages(join(repoPath, destName));
    packageProductPaths = materialized.packages.map((pkg) => pkg.productPath);
  } catch (err) {
    console.warn(`[importFileAsNewWorkspace] copied ${destName} but could not package it:`, err);
  }
  await writeFile(
    join(repoPath, MANAGED_WORKSPACE_MARKER),
    `${JSON.stringify({ schema: 1, workspaceUuid, originPath: realSource, importedAt: createdAt }, null, 2)}\n`,
    'utf8'
  );
  await initManagedRepo(repoPath);
  await commitAllIfDirty(repoPath, 'Initial import', {
    forceInclude: requiredGitFilesForProducts(packageProductPaths),
  });

  db.prepare(
    `INSERT INTO workspaces (name, path, repo_uuid, origin_path, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       repo_uuid = excluded.repo_uuid,
       origin_path = excluded.origin_path,
       last_opened_at = excluded.last_opened_at`
  ).run(displayName, repoPath, workspaceUuid, realSource, createdAt, createdAt);

  await retainImportedPackages(
    deps,
    repoPath,
    (packageProductPaths ?? []).map((path) => dirname(path))
  );
  return {
    workspaceUuid,
    repoPath,
    entryPath: packageProductPaths?.[0] ?? join(repoPath, destName),
    displayName,
    originPath: realSource,
    createdAt,
    reused: false,
    largeFilePolicy: 'copy',
    largeFiles: [],
    symlinkedLargeFiles: [],
  };
}

interface EmptyWorkspaceCreationOptions {
  originalDefaultProject?: true;
}

const originalProjectCreations = new WeakMap<
  Database.Database,
  Promise<ImportManagedWorkspaceResult>
>();

export async function createEmptyManagedWorkspace(
  displayName: string,
  deps: ImportFileIntoWorkspaceDeps & {
    recordCreatedInsideTx?: (identity: { workspaceUuid: string; repoPath: string }) => void;
  },
  options: EmptyWorkspaceCreationOptions = {}
): Promise<ImportManagedWorkspaceResult> {
  if (!options.originalDefaultProject)
    return createEmptyManagedWorkspaceOnce(displayName, deps, options);
  const pending = originalProjectCreations.get(deps.db);
  if (pending) return pending;
  const creation = createEmptyManagedWorkspaceOnce(displayName, deps, options);
  originalProjectCreations.set(deps.db, creation);
  try {
    return await creation;
  } finally {
    if (originalProjectCreations.get(deps.db) === creation)
      originalProjectCreations.delete(deps.db);
  }
}

async function createEmptyManagedWorkspaceOnce(
  displayName: string,
  deps: ImportFileIntoWorkspaceDeps & {
    recordCreatedInsideTx?: (identity: { workspaceUuid: string; repoPath: string }) => void;
  },
  options: EmptyWorkspaceCreationOptions
): Promise<ImportManagedWorkspaceResult> {
  const { db, managedRootDir } = deps;
  if (options.originalDefaultProject) {
    const original = resolveOriginalDefaultProject(db);
    if (original.status === 'ready') {
      rememberOriginalDefaultProject(db, original.project.workspaceId);
      return {
        workspaceUuid: original.project.repoUuid,
        repoPath: original.project.rootPath,
        displayName: original.project.displayName,
        originPath: original.project.rootPath,
        createdAt: original.project.createdAt,
        reused: true,
        largeFilePolicy: 'copy',
        largeFiles: [],
        symlinkedLargeFiles: [],
      };
    }
    if (original.reason !== 'identity-not-recorded') throw new Error(original.message);
    const existingManaged = db
      .prepare('SELECT origin_path FROM workspaces WHERE repo_uuid IS NOT NULL')
      .all() as Array<{ origin_path: string | null }>;
    const hasHistoricalUnassignedRecords = Boolean(
      db.prepare('SELECT 1 FROM lims_entity WHERE workspace_id IS NULL LIMIT 1').get() ||
      db.prepare('SELECT 1 FROM primers WHERE workspace_id IS NULL LIMIT 1').get()
    );
    if (
      hasHistoricalUnassignedRecords ||
      existingManaged.some((project) => !isBundledSampleWorkspaceOriginPath(project.origin_path))
    ) {
      throw new Error(
        'The original My Project has not been identified; a replacement will not be created.'
      );
    }
  }
  const name = options.originalDefaultProject
    ? DEFAULT_PROJECT_DISPLAY_NAME
    : displayName.trim() || DEFAULT_PROJECT_DISPLAY_NAME;
  const workspaceUuid = randomUUID();
  await mkdir(managedRootDir, { recursive: true });
  const realManagedRoot = await realpath(managedRootDir);
  const workspaceContainerPath = join(realManagedRoot, workspaceUuid);
  const repoPath = join(workspaceContainerPath, 'repo');
  const createdAt = Date.now();

  await mkdir(workspaceContainerPath, { recursive: false, mode: 0o700 });
  try {
    await initializeEmptyManagedWorkspaceRepo(repoPath, workspaceUuid, createdAt);

    db.transaction(() => {
      const inserted = db
        .prepare(
          `INSERT INTO workspaces (name, path, repo_uuid, origin_path, created_at, last_opened_at)
         VALUES (?, ?, ?, NULL, ?, ?)`
        )
        .run(name, repoPath, workspaceUuid, createdAt, createdAt);
      if (options.originalDefaultProject) {
        rememberOriginalDefaultProject(db, Number(inserted.lastInsertRowid));
      }
      deps.recordCreatedInsideTx?.({ workspaceUuid, repoPath });
    }).immediate();
  } catch (error) {
    try {
      await rm(workspaceContainerPath, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Workspace creation failed and its private partial directory could not be cleaned up.'
      );
    }
    throw error;
  }

  return {
    workspaceUuid,
    repoPath,
    displayName: name,
    originPath: repoPath,
    createdAt,
    reused: false,
    largeFilePolicy: 'copy',
    largeFiles: [],
    symlinkedLargeFiles: [],
  };
}

async function initializeEmptyManagedWorkspaceRepo(
  repoPath: string,
  workspaceUuid: string,
  createdAt: number
): Promise<void> {
  await mkdir(repoPath, { recursive: false, mode: 0o700 });
  await writeFile(
    join(repoPath, MANAGED_WORKSPACE_MARKER),
    `${JSON.stringify({ schema: 1, workspaceUuid, originPath: null, importedAt: createdAt }, null, 2)}\n`,
    'utf8'
  );
  await initManagedRepo(repoPath);
  await commitAllIfDirty(repoPath, 'Create workspace');
}

function preparedWorkspaceIdentityMatches(
  workspace: PreparedQuickLookWorkspace,
  identity: { device: string; inode: string } | null
): boolean {
  return (
    identity !== null &&
    identity.device === workspace.containerDevice &&
    identity.inode === workspace.containerInode
  );
}

async function readPreparedWorkspaceOwnerToken(
  workspace: PreparedQuickLookWorkspace
): Promise<string | null> {
  try {
    const value = JSON.parse(
      await readFile(
        join(workspace.workspaceContainerPath, QUICK_LOOK_WORKSPACE_OWNER_FILE),
        'utf8'
      )
    ) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const token = (value as Record<string, unknown>).token;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

async function retirePackagePromotionRecordsForWorkspace(
  workspaceRoot: string,
  packagePromotionJournalRoot: string
): Promise<void> {
  const entries = await readdir(packagePromotionJournalRoot, { withFileTypes: true }).catch(
    () => []
  );
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(packagePromotionJournalRoot, entry.name);
    const record = await readPromotionRecord(path);
    if (
      record &&
      entry.name === `${record.recordKey}.json` &&
      isSameOrDescendant(workspaceRoot, record.realTarget)
    ) {
      await rm(path, { force: true });
      continue;
    }
    const setRecord = await readQuickLookSetRecord(path);
    if (
      setRecord &&
      entry.name === `set-${setRecord.recordKey}.json` &&
      isCanonicalQuickLookSetRecord(setRecord) &&
      isSameOrDescendant(workspaceRoot, setRecord.realTarget)
    ) {
      await rm(path, { force: true });
    }
  }
}

export async function prepareQuickLookDestinationWorkspace(
  displayName: string,
  deps: QuickLookWorkspacePreparationDeps
): Promise<PreparedQuickLookWorkspace> {
  const { managedRootDir, preparationJournalRoot } = deps;
  const name = displayName.trim() || 'My Workspace';
  const workspaceUuid = randomUUID();
  const ownerToken = randomUUID();
  const createdAt = Date.now();
  await mkdir(managedRootDir, { recursive: true });
  const realManagedRoot = await realpath(managedRootDir);
  const workspaceContainerPath = join(realManagedRoot, workspaceUuid);
  const repoPath = join(workspaceContainerPath, 'repo');
  const recordKey = createHash('sha256').update(workspaceUuid).digest('hex');
  const journalPath = join(preparationJournalRoot, `${recordKey}.json`);
  let prepared: PreparedQuickLookWorkspace | null = null;
  let releaseMutationBlock: (() => void) | null = null;

  const reservedRecord: QuickLookWorkspacePreparationRecord = {
    schema: QUICK_LOOK_WORKSPACE_PREPARATION_SCHEMA,
    state: 'reserved',
    recordKey,
    workspaceUuid,
    displayName: name,
    ownerToken,
    workspaceContainerPath,
    repoPath,
    containerDevice: null,
    containerInode: null,
    createdAt,
  };
  await writeWorkspacePreparationRecord(journalPath, reservedRecord);
  try {
    await mkdir(workspaceContainerPath, { recursive: false, mode: 0o700 });
    releaseMutationBlock = await beginQuickLookRendererMutationBlock(workspaceContainerPath);
    const identity = await physicalDirectoryIdentity(workspaceContainerPath);
    if (!identity) {
      throw new Error('Quick Look destination project is not a physical directory.');
    }
    prepared = {
      workspaceUuid,
      repoPath,
      displayName: name,
      workspaceContainerPath,
      ownerToken,
      containerDevice: identity.device,
      containerInode: identity.inode,
      journalPath,
      releaseMutationBlock,
    };
    await writeWorkspacePreparationRecord(journalPath, {
      ...reservedRecord,
      state: 'prepared',
      containerDevice: identity.device,
      containerInode: identity.inode,
    });
    await writeFile(
      join(workspaceContainerPath, QUICK_LOOK_WORKSPACE_OWNER_FILE),
      `${JSON.stringify({ token: ownerToken })}\n`,
      { flag: 'wx', mode: 0o600 }
    );
    await initializeEmptyManagedWorkspaceRepo(repoPath, workspaceUuid, createdAt);
    return prepared;
  } catch (error) {
    try {
      if (prepared) {
        await discardPreparedQuickLookDestinationWorkspace(prepared, deps);
      } else {
        await rmdir(workspaceContainerPath).catch((cleanupError: unknown) => {
          if (!isMissingPathError(cleanupError)) throw cleanupError;
        });
        await rm(journalPath, { force: true });
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Quick Look workspace preparation failed and its partial workspace could not be cleaned up.'
      );
    } finally {
      releaseMutationBlock?.();
    }
    throw error;
  }
}

export async function activatePreparedQuickLookDestinationWorkspace(
  workspace: PreparedQuickLookWorkspace,
  deps: QuickLookWorkspacePreparationDeps
): Promise<void> {
  const identity = await physicalDirectoryIdentity(workspace.workspaceContainerPath).catch(
    () => null
  );
  if (!preparedWorkspaceIdentityMatches(workspace, identity)) {
    throw new Error('Prepared Quick Look destination was replaced before activation.');
  }
  if ((await readPreparedWorkspaceOwnerToken(workspace)) !== workspace.ownerToken) {
    throw new Error('Prepared Quick Look destination lost its owner marker before activation.');
  }
  const journal = workspacePreparationRecordFromUnknown(
    JSON.parse(await readFile(workspace.journalPath, 'utf8')) as unknown
  );
  if (
    !journal ||
    journal.state !== 'prepared' ||
    journal.recordKey !== basename(workspace.journalPath, '.json') ||
    journal.workspaceUuid !== workspace.workspaceUuid ||
    journal.repoPath !== workspace.repoPath ||
    journal.ownerToken !== workspace.ownerToken ||
    journal.containerDevice !== workspace.containerDevice ||
    journal.containerInode !== workspace.containerInode
  ) {
    throw new Error('Prepared Quick Look destination journal no longer matches its workspace.');
  }

  deps.db
    .prepare(
      `INSERT INTO workspaces
         (name, path, repo_uuid, origin_path, created_at, last_opened_at)
       VALUES (?, ?, ?, NULL, ?, ?)`
    )
    .run(
      workspace.displayName,
      workspace.repoPath,
      workspace.workspaceUuid,
      journal.createdAt,
      Date.now()
    );

  await Promise.all([
    rm(join(workspace.workspaceContainerPath, QUICK_LOOK_WORKSPACE_OWNER_FILE), { force: true }),
    rm(workspace.journalPath, { force: true }),
  ]).catch((error: unknown) =>
    console.warn(
      '[quick-look-promotion] Could not retire published workspace recovery state:',
      error
    )
  );
}

export async function discardPreparedQuickLookDestinationWorkspace(
  workspace: PreparedQuickLookWorkspace,
  deps: QuickLookWorkspacePreparationDeps
): Promise<void> {
  const releaseMutationBlock = await beginQuickLookRendererMutationBlock(
    workspace.workspaceContainerPath
  );
  try {
    const identity = await physicalDirectoryIdentity(workspace.workspaceContainerPath).catch(
      () => null
    );
    if (!preparedWorkspaceIdentityMatches(workspace, identity)) {
      throw new Error('Refusing to discard a replaced Quick Look destination project.');
    }
    if ((await readPreparedWorkspaceOwnerToken(workspace)) !== workspace.ownerToken) {
      throw new Error('Refusing to discard an unowned Quick Look destination project.');
    }
    const row = deps.db
      .prepare('SELECT id FROM workspaces WHERE repo_uuid = ? AND path = ?')
      .get(workspace.workspaceUuid, workspace.repoPath) as { id: number } | undefined;
    if (row) {
      throw new Error('Refusing to discard a published Quick Look destination project.');
    }

    await rm(workspace.workspaceContainerPath, { recursive: true, force: true });
    await retirePackagePromotionRecordsForWorkspace(
      workspace.repoPath,
      deps.packagePromotionJournalRoot
    );
    await rm(workspace.journalPath, { force: true });
  } finally {
    releaseMutationBlock();
  }
}

async function recoverQuickLookDestinationWorkspaceRecord(
  journalPath: string,
  deps: QuickLookWorkspacePreparationDeps
): Promise<void> {
  let record: QuickLookWorkspacePreparationRecord | null = null;
  try {
    record = workspacePreparationRecordFromUnknown(
      JSON.parse(await readFile(journalPath, 'utf8')) as unknown
    );
  } catch {}
  if (!record || basename(journalPath) !== `${record.recordKey}.json`) {
    console.warn(
      `[quick-look-promotion] Leaving unreadable workspace preparation record untouched: ${journalPath}`
    );
    return;
  }
  const realManagedRoot = await realpath(deps.managedRootDir).catch(() => null);
  if (
    !realManagedRoot ||
    dirname(record.workspaceContainerPath) !== realManagedRoot ||
    basename(record.workspaceContainerPath) !== record.workspaceUuid
  ) {
    console.warn(
      `[quick-look-promotion] Refusing workspace preparation recovery outside the managed root: ${record.workspaceContainerPath}`
    );
    return;
  }

  const published = deps.db
    .prepare('SELECT id FROM workspaces WHERE repo_uuid = ? AND path = ?')
    .get(record.workspaceUuid, record.repoPath) as { id: number } | undefined;
  if (published) {
    const identity = await physicalDirectoryIdentity(record.workspaceContainerPath).catch(
      () => null
    );
    if (
      record.state !== 'prepared' ||
      record.containerDevice === null ||
      record.containerInode === null ||
      identity?.device !== record.containerDevice ||
      identity.inode !== record.containerInode
    ) {
      console.warn(
        `[quick-look-promotion] Retaining published workspace recovery state after identity drift: ${record.workspaceContainerPath}`
      );
      return;
    }
    await rm(join(record.workspaceContainerPath, QUICK_LOOK_WORKSPACE_OWNER_FILE), {
      force: true,
    });
    await rm(journalPath, { force: true });
    return;
  }

  const candidate = await lstat(record.workspaceContainerPath).catch(() => null);
  if (!candidate) {
    await retirePackagePromotionRecordsForWorkspace(
      record.repoPath,
      deps.packagePromotionJournalRoot
    );
    await rm(journalPath, { force: true });
    return;
  }

  if (record.state === 'reserved') {
    try {
      await rmdir(record.workspaceContainerPath);
    } catch (error) {
      if (!isMissingPathError(error)) {
        console.warn(
          `[quick-look-promotion] Retaining a nonempty unbound workspace reservation: ${record.workspaceContainerPath}`
        );
        return;
      }
    }
    await rm(journalPath, { force: true });
    return;
  }

  if (record.containerDevice === null || record.containerInode === null) return;
  const releaseMutationBlock = await beginQuickLookRendererMutationBlock(
    record.workspaceContainerPath
  );
  const workspace: PreparedQuickLookWorkspace = {
    workspaceUuid: record.workspaceUuid,
    repoPath: record.repoPath,
    displayName: record.displayName,
    workspaceContainerPath: record.workspaceContainerPath,
    ownerToken: record.ownerToken,
    containerDevice: record.containerDevice,
    containerInode: record.containerInode,
    journalPath,
    releaseMutationBlock,
  };
  try {
    const token = await readPreparedWorkspaceOwnerToken(workspace);
    if (token === null) {
      try {
        await rmdir(record.workspaceContainerPath);
        await rm(journalPath, { force: true });
      } catch {
        console.warn(
          `[quick-look-promotion] Retaining an unowned nonempty prepared workspace: ${record.workspaceContainerPath}`
        );
      }
      return;
    }
    await discardPreparedQuickLookDestinationWorkspace(workspace, deps);
  } finally {
    releaseMutationBlock();
  }
}

export async function recoverQuickLookDestinationWorkspaces(
  deps: QuickLookWorkspacePreparationDeps
): Promise<void> {
  await mkdir(deps.preparationJournalRoot, { recursive: true });
  const entries = await readdir(deps.preparationJournalRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    await recoverQuickLookDestinationWorkspaceRecord(
      join(deps.preparationJournalRoot, entry.name),
      deps
    );
  }
}

interface ImportTreeScan {
  largeFiles: ManagedWorkspaceLargeFile[];
  totalFiles: number;
  totalBytes: number;
}

export async function findLargeWorkspaceFiles(
  sourceRoot: string,
  thresholdBytes = LARGE_MANAGED_IMPORT_FILE_THRESHOLD_BYTES
): Promise<ManagedWorkspaceLargeFile[]> {
  return (await scanImportTree(sourceRoot, thresholdBytes)).largeFiles;
}

async function scanImportTree(
  sourceRoot: string,
  thresholdBytes: number,
  independent = false
): Promise<ImportTreeScan> {
  const rootPath = await realpath(sourceRoot);
  const scan: ImportTreeScan = { largeFiles: [], totalFiles: 0, totalBytes: 0 };
  await collectImportTree(rootPath, rootPath, thresholdBytes, scan, independent);
  return scan;
}

async function collectImportTree(
  rootPath: string,
  currentPath: string,
  thresholdBytes: number,
  scan: ImportTreeScan,
  independent: boolean
): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (COPY_SKIP.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const sourcePath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await collectImportTree(rootPath, sourcePath, thresholdBytes, scan, independent);
      continue;
    }
    if (!entry.isFile()) continue;
    if (independent && isWorkImportCandidate(sourcePath))
      assertIndependentWorkImport(sourcePath, await readFile(sourcePath, 'utf8'));
    const sourceStat = await stat(sourcePath);
    scan.totalFiles += 1;
    scan.totalBytes += sourceStat.size;
    if (sourceStat.size > thresholdBytes) {
      scan.largeFiles.push({
        relPath: repoRelativePath(rootPath, sourcePath),
        sourcePath,
        sizeBytes: sourceStat.size,
      });
    }
  }
}

interface CopyTreeOptions {
  rootPath: string;
  largeFileThresholdBytes: number;
  largeFilePolicy: ManagedWorkspaceLargeFilePolicy;
  onProgress?: (update: ImportProgressUpdate) => void;
  progress?: { filesCopied: number; bytesCopied: number };
  totalFiles?: number;
  totalBytes?: number;
}

interface CopyTreeResult {
  symlinkedLargeFiles: ManagedWorkspaceSymlinkedFile[];
}

async function copyTree(
  src: string,
  dest: string,
  options: CopyTreeOptions
): Promise<CopyTreeResult> {
  const symlinkedLargeFiles: ManagedWorkspaceSymlinkedFile[] = [];
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (COPY_SKIP.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      const nested = await copyTree(from, to, options);
      symlinkedLargeFiles.push(...nested.symlinkedLargeFiles);
    } else if (entry.isFile()) {
      const sourceStat = await stat(from);
      if (
        sourceStat.size > options.largeFileThresholdBytes &&
        options.largeFilePolicy === 'symlink'
      ) {
        await symlink(from, to, 'file');
        symlinkedLargeFiles.push({
          relPath: repoRelativePath(options.rootPath, from),
          sourcePath: from,
          repoPath: to,
          sizeBytes: sourceStat.size,
        });
      } else {
        await copyIndependentFile(from, to);
      }
      if (options.progress) {
        options.progress.filesCopied += 1;
        options.progress.bytesCopied += sourceStat.size;
        options.onProgress?.({
          status: 'copying',
          filesCopied: options.progress.filesCopied,
          totalFiles: options.totalFiles ?? 0,
          bytesCopied: options.progress.bytesCopied,
          totalBytes: options.totalBytes ?? 0,
        });
      }
    }
  }
  return { symlinkedLargeFiles };
}

function repoRelativePath(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath).split(sep).join('/');
}
