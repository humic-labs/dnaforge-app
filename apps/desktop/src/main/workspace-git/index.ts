import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import git, { type TreeEntry } from 'isomorphic-git';
import { flushFileSync, syncDirectory } from '../fs-durability';
import { createKeyedMutex } from './keyed-mutex';
import {
  executeManagedGit,
  managedGitStatus,
  managedGitBlobOid,
  hashManagedGitBlob,
} from './native';
import { readLooseBlobContentIdentity, type GitBlobContentIdentity } from './blob-content-identity';
import { WORKSPACE_GIT_AUTHOR } from '../../shared/workspace-git-author';

const MANAGED_AUTHOR = WORKSPACE_GIT_AUTHOR;
export const QUICK_LOOK_PROMOTION_OWNER_FILE = '.dnaforge-quick-look-promotion.json';
const activeQuickLookPromotionRoots = new Map<string, number>();
const activeQuickLookMainMutationRoots = new Map<string, number>();
const activeRendererMutationClaims = new Map<string, number>();
const rendererMutationReleaseWaiters = new Set<() => void>();
const managedWorkspaceMutationMutex = createKeyedMutex();

function canonicalManagedWorkspacePath(path: string): string {
  let ancestor = resolve(path);
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const canonicalAncestor = fs.realpathSync.native(ancestor);
      const canonicalPath = resolve(canonicalAncestor, ...missingSegments).normalize('NFC');
      return process.platform === 'darwin' || process.platform === 'win32'
        ? canonicalPath.toLocaleLowerCase('en-US')
        : canonicalPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

      try {
        fs.lstatSync(ancestor);
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code === 'ENOENT') {
          const parent = dirname(ancestor);
          if (parent === ancestor) throw error;
          missingSegments.unshift(basename(ancestor));
          ancestor = parent;
          continue;
        }
        throw lstatError;
      }

      throw error;
    }
  }
}

function canonicalPendingWriteRoot(candidateRoot: string): string {
  return canonicalManagedWorkspacePath(candidateRoot);
}

function retainTrackedRoot(roots: Map<string, number>, canonicalRoot: string): () => void {
  roots.set(canonicalRoot, (roots.get(canonicalRoot) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (roots.get(canonicalRoot) ?? 1) - 1;
    if (remaining > 0) roots.set(canonicalRoot, remaining);
    else roots.delete(canonicalRoot);
  };
}

function pathOverlaps(left: string, right: string): boolean {
  const relativeLeft = relative(left, right);
  const relativeRight = relative(right, left);
  const isDirectOrDescendant = (path: string): boolean =>
    path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  return isDirectOrDescendant(relativeLeft) || isDirectOrDescendant(relativeRight);
}

function overlapsTrackedRoot(candidatePath: string, roots: Map<string, number>): boolean {
  for (const root of roots.keys()) {
    if (pathOverlaps(root, candidatePath)) return true;
  }
  return false;
}

function notifyRendererMutationRelease(): void {
  const waiters = [...rendererMutationReleaseWaiters];
  rendererMutationReleaseWaiters.clear();
  for (const notify of waiters) notify();
}

async function acquireQuickLookMainMutationRoot(candidateRoot: string): Promise<() => void> {
  const release = retainTrackedRoot(activeQuickLookMainMutationRoots, candidateRoot);
  try {
    while (overlapsTrackedRoot(candidateRoot, activeRendererMutationClaims)) {
      await new Promise<void>((resolve) => rendererMutationReleaseWaiters.add(resolve));
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export function acquireQuickLookRendererMutationLease(
  candidatePaths: readonly string[]
): () => void {
  const roots = [...new Set(candidatePaths.map(canonicalManagedWorkspacePath))];
  if (roots.length === 0) {
    throw new Error('Renderer mutation lease requires at least one physical path.');
  }
  for (const root of roots) {
    if (overlapsTrackedRoot(root, activeQuickLookMainMutationRoots)) {
      throw new Error(`Renderer mutation of an active Quick Look promotion is denied: ${root}`);
    }
  }
  const releases = roots.map((root) => retainTrackedRoot(activeRendererMutationClaims, root));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases) release();
    notifyRendererMutationRelease();
  };
}

export interface QuickLookPromotionWriteLease {
  readonly allowGitPublication: () => void;
  readonly release: () => void;
}

export async function beginQuickLookPromotionWrite(
  candidateRoot: string
): Promise<QuickLookPromotionWriteLease> {
  const canonicalRoot = canonicalPendingWriteRoot(candidateRoot);
  const releaseMutationBlock = await acquireQuickLookMainMutationRoot(canonicalRoot);
  const releasePublicationBlock = retainTrackedRoot(activeQuickLookPromotionRoots, canonicalRoot);
  return {
    allowGitPublication: releasePublicationBlock,
    release: () => {
      releasePublicationBlock();
      releaseMutationBlock();
    },
  };
}

export async function beginQuickLookRendererMutationBlock(
  candidateRoot: string
): Promise<() => void> {
  const canonicalRoot = canonicalPendingWriteRoot(candidateRoot);
  return acquireQuickLookMainMutationRoot(canonicalRoot);
}

export async function withQuickLookMainMutationLock<T>(
  repoRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const canonicalRoot = canonicalManagedWorkspacePath(repoRoot);
  const releaseMutationBlock = await acquireQuickLookMainMutationRoot(canonicalRoot);
  try {
    return await managedWorkspaceMutationMutex(canonicalRoot, operation);
  } finally {
    releaseMutationBlock();
  }
}

export function hasActiveQuickLookPromotion(repoRoot: string): boolean {
  const canonicalRepoRoot = canonicalManagedWorkspacePath(repoRoot);
  for (const root of activeQuickLookPromotionRoots.keys()) {
    const child = relative(canonicalRepoRoot, root);
    if (child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))) {
      return true;
    }
  }
  return false;
}

export function isQuickLookPromotionMutationBlocked(candidatePath: string): boolean {
  const canonicalCandidate = canonicalManagedWorkspacePath(candidatePath);
  return overlapsTrackedRoot(canonicalCandidate, activeQuickLookMainMutationRoots);
}

export function withManagedWorkspaceMutationLock<T>(
  repoRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  return managedWorkspaceMutationMutex(canonicalManagedWorkspacePath(repoRoot), operation);
}
const GIT_FILEPATH_BATCH_SIZE = 256;

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

export async function initManagedRepo(dir: string): Promise<void> {
  await git.init({ fs, dir, defaultBranch: 'main' });
  await ensurePrivateMigrationGitExclusion(dir);
}

export async function ensurePrivateMigrationGitExclusion(dir: string): Promise<void> {
  if (!existsSync(join(dir, '.git'))) return;
  const gitDir = resolveGitDir(dir);
  if (!gitDir) return;
  const path = join(gitDir, 'info', 'exclude');
  const rules = ['/.dnaforge/migration/actions/', '/.dnaforge/migration/undo/'];
  let before = '';
  try {
    const stat = await fs.promises.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error('Private migration Git exclusion file is not a bounded regular file.');
    before = await fs.promises.readFile(path, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const missing = rules.filter((rule) => !before.split(/\r?\n/u).includes(rule));
  if (!missing.length) return;
  await fs.promises.mkdir(dirname(path), { recursive: true });
  const handle = await fs.promises.open(
    path,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(
      `${before && !before.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function resolveHeadCommit(dir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, ref: 'HEAD' });
  } catch {
    return null;
  }
}

export function resolveHeadCommitSync(dir: string): string | null {
  try {
    const gitDir = resolveGitDir(dir);
    if (!gitDir) return null;

    let ref = 'HEAD';
    for (let depth = 0; depth < 8; depth += 1) {
      const loose = readLooseRef(gitDir, ref);
      if (loose && isCommitOid(loose)) return loose.toLowerCase();

      const symbolic = loose?.match(/^ref:\s+(.+)$/)?.[1]?.trim();
      if (symbolic) {
        if (!isSafeGitRef(symbolic)) return null;
        ref = symbolic;
        continue;
      }

      if (ref !== 'HEAD') return readPackedRef(gitDir, ref);
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveGitDir(dir: string): string | null {
  const dotGit = join(dir, '.git');
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;

  const target = fs
    .readFileSync(dotGit, 'utf8')
    .trim()
    .match(/^gitdir:\s+(.+)$/)?.[1]
    ?.trim();
  if (!target) return null;
  return isAbsolute(target) ? target : resolve(dir, target);
}

function readLooseRef(gitDir: string, ref: string): string | null {
  try {
    return fs.readFileSync(join(gitDir, ref), 'utf8').trim();
  } catch {
    return null;
  }
}

function readPackedRef(gitDir: string, ref: string): string | null {
  try {
    for (const line of fs.readFileSync(join(gitDir, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const space = line.indexOf(' ');
      if (space <= 0 || line.slice(space + 1) !== ref) continue;
      const oid = line.slice(0, space);
      return isCommitOid(oid) ? oid.toLowerCase() : null;
    }
  } catch {
    return null;
  }
  return null;
}

function isSafeGitRef(ref: string): boolean {
  return ref.startsWith('refs/') && !ref.includes('..') && !ref.includes('\\');
}

function isCommitOid(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

export async function hasWorkingChanges(dir: string): Promise<boolean> {
  return (await managedGitStatus(dir)).some((row) => !isPrivateImportSnapshot(row.path));
}

function isPrivateImportSnapshot(filepath: string): boolean {
  return (
    /^\.dnaforge\/migration\/actions\/[^/]+\//u.test(filepath) ||
    filepath === '.dnaforge/migration/undo' ||
    filepath.startsWith('.dnaforge/migration/undo/')
  );
}

async function assertNoPrivateImportSnapshotsStaged(dir: string): Promise<void> {
  if ((await git.listFiles({ fs, dir })).some(isPrivateImportSnapshot))
    throw new Error('MANAGED_GIT_PRIVATE_IMPORT_SNAPSHOT_STAGED');
}

export interface CommitAllIfDirtyOptions {
  author?: { name: string; email: string };
  forceInclude?: readonly string[];
}

export interface CommitPathsIfDirtyOptions extends CommitAllIfDirtyOptions {
  paths: readonly string[];
}

export interface CommitOwnedPathsIfDirtyOptions extends CommitPathsIfDirtyOptions {
  expectedHead: string | null;
  expectedContentSha256?: Readonly<Record<string, string | null>>;
}

export interface CommitOwnedPathsTestHooks {
  beforeHeadCompareAndSet?: () => void | Promise<void>;
}

function normalizeForceInclude(dir: string, paths: readonly string[] = []): string[] {
  const root = resolve(dir);
  const normalized = new Set<string>();
  for (const path of paths) {
    const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const filepath = relative(root, absolutePath);
    if (!filepath || isAbsolute(filepath) || filepath === '..' || filepath.startsWith(`..${sep}`)) {
      throw new Error(
        `MANAGED_GIT_FORCE_INCLUDE_OUTSIDE_REPO: "${path}" is not a file inside "${dir}".`
      );
    }
    const normalizedPath = filepath.split(sep).join('/');
    if (isPrivateImportSnapshot(normalizedPath) || normalizedPath === '.dnaforge/migration/actions')
      throw new Error('MANAGED_GIT_PRIVATE_IMPORT_SNAPSHOT_NOT_PUBLISHABLE');
    normalized.add(normalizedPath);
  }
  return [...normalized];
}

async function forcedFilesHaveChanges(dir: string, filepaths: readonly string[]): Promise<boolean> {
  for (let start = 0; start < filepaths.length; start += GIT_FILEPATH_BATCH_SIZE) {
    if (
      (await managedGitStatus(dir, filepaths.slice(start, start + GIT_FILEPATH_BATCH_SIZE), true))
        .length > 0
    )
      return true;
  }
  return false;
}

async function stageForceIncludedFiles(dir: string, filepaths: readonly string[]): Promise<void> {
  for (let start = 0; start < filepaths.length; start += GIT_FILEPATH_BATCH_SIZE) {
    await executeManagedGit(dir, [
      'add',
      '-f',
      '--',
      ...filepaths.slice(start, start + GIT_FILEPATH_BATCH_SIZE),
    ]);
  }
}

async function stageAllChanges(dir: string, forceInclude: readonly string[] = []): Promise<void> {
  const changed = (await managedGitStatus(dir)).filter(
    (row) => !isPrivateImportSnapshot(row.path) && !isInsideActiveQuickLookPromotion(dir, row.path)
  );
  const symlinks = new Set(
    changed
      .filter((row) => {
        try {
          return fs.lstatSync(join(dir, row.path)).isSymbolicLink();
        } catch {
          return false;
        }
      })
      .map((row) => row.path)
  );
  const paths = changed.filter(
    (row) =>
      !row.path
        .split('/')
        .slice(0, -1)
        .some((_, index, parts) => symlinks.has(parts.slice(0, index + 1).join('/')))
  );
  for (let start = 0; start < paths.length; start += GIT_FILEPATH_BATCH_SIZE) {
    await executeManagedGit(dir, [
      'add',
      '-A',
      '--',
      ...paths.slice(start, start + GIT_FILEPATH_BATCH_SIZE).map((row) => row.path),
    ]);
  }
  await stageForceIncludedFiles(
    dir,
    forceInclude.filter(
      (filepath) =>
        existsSync(join(dir, filepath)) && !isInsideActiveQuickLookPromotion(dir, filepath)
    )
  );
}

async function hasStagedChanges(dir: string): Promise<boolean> {
  return (await managedGitStatus(dir)).some((row) => row.staged);
}

function isInsideActiveQuickLookPromotion(repoRoot: string, filepath: string): boolean {
  const physicalPath = canonicalManagedWorkspacePath(join(repoRoot, filepath));
  for (const root of activeQuickLookPromotionRoots.keys()) {
    const child = relative(root, physicalPath);
    if (child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))) {
      return true;
    }
  }
  return false;
}

const commitAllIfDirtyMutex = createKeyedMutex();

export async function commitAllIfDirty(
  dir: string,
  message: string,
  options: CommitAllIfDirtyOptions = {}
): Promise<string | null> {
  return commitAllIfDirtyMutex(resolve(dir), async () => {
    const forceInclude = normalizeForceInclude(dir, options.forceInclude);
    let repairedCorruptIndex = await managedGitIndexNeedsRebuild(dir);
    try {
      if (
        !repairedCorruptIndex &&
        !(await hasWorkingChanges(dir)) &&
        !(await forcedFilesHaveChanges(dir, forceInclude))
      ) {
        return null;
      }
    } catch (error) {
      if (!isManagedGitIndexCorruption(error)) throw error;
      await quarantineCorruptManagedGitIndex(dir);
      repairedCorruptIndex = true;
    }
    if (repairedCorruptIndex) {
      if (hasActiveQuickLookPromotion(dir)) {
        throw new Error(
          'Managed Git index repair is blocked while a Quick Look package promotion is active.'
        );
      }
      await rebuildManagedGitIndexFromWorkingTree(dir, forceInclude);
      if (!(await hasWorkingChanges(dir))) return null;
      await assertNoPrivateImportSnapshotsStaged(dir);
      return git.commit({ fs, dir, message, author: { ...(options.author ?? MANAGED_AUTHOR) } });
    }
    await stageAllChanges(dir, forceInclude);
    if (!(await hasStagedChanges(dir))) return null;
    await assertNoPrivateImportSnapshotsStaged(dir);
    return git.commit({ fs, dir, message, author: { ...(options.author ?? MANAGED_AUTHOR) } });
  });
}

async function managedGitIndexNeedsRebuild(dir: string): Promise<boolean> {
  const gitDir = resolveGitDir(dir);
  if (!gitDir) return false;
  const indexPath = join(gitDir, 'index');
  const stat = await fs.promises.stat(indexPath).catch(() => null);
  if (stat?.size !== 32 || !(await resolveHeadCommit(dir))) return false;
  return (await git.listFiles({ fs, dir, ref: 'HEAD' })).length > 0;
}

async function rebuildManagedGitIndexFromWorkingTree(
  dir: string,
  forceInclude: readonly string[]
): Promise<void> {
  await stageAllChanges(dir, forceInclude);
  console.warn('[workspace-git] Rebuilt the managed-workspace Git index from the working tree.');
}

function isManagedGitIndexCorruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /index file (?:is empty|smaller than expected)|invalid index|invalid checksum.*gitindex|index checksum|index.*corrupt/iu.test(
    message
  );
}

async function quarantineCorruptManagedGitIndex(dir: string): Promise<void> {
  const gitDir = resolveGitDir(dir);
  if (!gitDir) throw new Error('Managed workspace Git directory is unavailable.');
  const indexPath = join(gitDir, 'index');
  const quarantinePath = join(gitDir, `index.corrupt-${Date.now()}`);
  // workspace-entity-move: quarantines Git metadata only.
  await fs.promises.rename(indexPath, quarantinePath);
  try {
    const header = Buffer.alloc(12);
    header.write('DIRC', 0, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(0, 8);
    const checksum = createHash('sha1').update(header).digest();
    await fs.promises.writeFile(indexPath, Buffer.concat([header, checksum]));
  } catch (error) {
    await fs.promises.rm(indexPath, { force: true });
    // workspace-entity-move: restores Git metadata only.
    await fs.promises.rename(quarantinePath, indexPath).catch(() => undefined);
    throw error;
  }
  await fs.promises.rm(quarantinePath, { force: true });
  console.warn('[workspace-git] Rebuilt a corrupt managed-workspace Git index.');
}

export async function commitPathsIfDirty(
  dir: string,
  message: string,
  options: CommitPathsIfDirtyOptions
): Promise<string | null> {
  return commitAllIfDirtyMutex(resolve(dir), async () => {
    const paths = normalizeForceInclude(dir, options.paths);
    const forceInclude = normalizeForceInclude(dir, options.forceInclude);
    const selectedPaths = new Set(paths);
    const unselectedForcedPath = forceInclude.find((filepath) => !selectedPaths.has(filepath));
    if (unselectedForcedPath) {
      throw new Error(
        `MANAGED_GIT_FORCE_INCLUDE_NOT_SELECTED: "${unselectedForcedPath}" is not owned by this operation.`
      );
    }
    const stagedOutsideSelection = (await managedGitStatus(dir)).find(
      (row) => row.staged && !selectedPaths.has(row.path)
    );
    if (stagedOutsideSelection)
      throw new Error(
        `MANAGED_GIT_STAGED_PATH_NOT_SELECTED: "${stagedOutsideSelection.path}" was staged outside this operation.`
      );
    const changed = (await managedGitStatus(dir, paths, true)).filter(
      (row) =>
        !isPrivateImportSnapshot(row.path) && (!row.ignored || forceInclude.includes(row.path))
    );
    if (changed.length === 0) return null;
    for (let start = 0; start < changed.length; start += GIT_FILEPATH_BATCH_SIZE) {
      await executeManagedGit(dir, [
        'add',
        '-A',
        '-f',
        '--',
        ...changed.slice(start, start + GIT_FILEPATH_BATCH_SIZE).map((row) => row.path),
      ]);
    }
    await assertNoPrivateImportSnapshotsStaged(dir);
    return git.commit({ fs, dir, message, author: { ...(options.author ?? MANAGED_AUTHOR) } });
  });
}

export async function commitOwnedPathsIfDirty(
  dir: string,
  message: string,
  options: CommitOwnedPathsIfDirtyOptions,
  testHooks: CommitOwnedPathsTestHooks = {}
): Promise<string | null> {
  return commitAllIfDirtyMutex(resolve(dir), async () => {
    if (!options.expectedHead || !isCommitOid(options.expectedHead)) {
      throw new Error('MANAGED_GIT_EXPECTED_HEAD_REQUIRED');
    }
    const expectedHead = options.expectedHead.toLowerCase();
    if ((await resolveHeadCommit(dir)) !== expectedHead) {
      throw new Error('MANAGED_GIT_HEAD_CHANGED: HEAD moved before owned commit preparation.');
    }
    const paths = normalizeForceInclude(dir, options.paths);
    if (paths.length === 0) throw new Error('MANAGED_GIT_OWNED_PATHS_REQUIRED');
    const forceInclude = normalizeForceInclude(dir, options.forceInclude);
    const selectedPaths = new Set(paths);
    const unselectedForcedPath = forceInclude.find((filepath) => !selectedPaths.has(filepath));
    if (unselectedForcedPath) {
      throw new Error(
        `MANAGED_GIT_FORCE_INCLUDE_NOT_SELECTED: "${unselectedForcedPath}" is not owned by this operation.`
      );
    }

    const gitDir = resolveGitDir(dir);
    if (!gitDir) throw new Error('MANAGED_GIT_DIRECTORY_NOT_FOUND');
    const indexPath = join(gitDir, 'index');
    const originalIndex = await fs.promises.readFile(indexPath);
    let candidateCommit: string | null = null;
    let candidateIndex: Buffer | null = null;
    try {
      const forced = new Set(forceInclude);
      const selected = new Set<string>();
      for (const path of paths) {
        if (isPrivateImportSnapshot(path)) continue;
        if (
          existsSync(join(dir, path)) &&
          !forced.has(path) &&
          (await git.isIgnored({ fs, dir, filepath: path }))
        )
          continue;
        selected.add(path);
      }
      const rows = (await managedGitStatus(dir, paths, true)).filter((row) =>
        selected.has(row.path)
      );
      for (let start = 0; start < rows.length; start += GIT_FILEPATH_BATCH_SIZE) {
        await executeManagedGit(dir, [
          'add',
          '-A',
          '-f',
          '--',
          ...rows.slice(start, start + GIT_FILEPATH_BATCH_SIZE).map((row) => row.path),
        ]);
      }
      const tree = await writeOwnedCommitTree(dir, expectedHead, selected);
      for (const [path, expected] of Object.entries(options.expectedContentSha256 ?? {})) {
        if (!selected.has(path) || (expected !== null && !/^[a-f0-9]{64}$/u.test(expected))) {
          throw new Error('MANAGED_GIT_OWNED_CONTENT_INVALID');
        }
        if (expected === null) {
          if (await executeManagedGit(dir, ['ls-tree', '--full-tree', '-z', tree, '--', path]))
            throw new Error('MANAGED_GIT_OWNED_CONTENT_CHANGED');
          continue;
        }
        const blob = await hashManagedGitBlob(dir, tree, path);
        if (blob.sha256 !== expected) {
          throw new Error('MANAGED_GIT_OWNED_CONTENT_CHANGED');
        }
      }
      const { commit: parent } = await git.readCommit({ fs, dir, oid: expectedHead });
      if (tree === parent.tree) return null;
      candidateIndex = await fs.promises.readFile(indexPath);
      candidateCommit = await git.commit({
        fs,
        dir,
        message,
        author: { ...(options.author ?? MANAGED_AUTHOR) },
        noUpdateBranch: true,
        parent: [expectedHead],
        tree,
      });
    } finally {
      await fs.promises.writeFile(indexPath, originalIndex);
    }
    if (!candidateCommit || !candidateIndex) return null;

    await testHooks.beforeHeadCompareAndSet?.();
    if (!(await fs.promises.readFile(indexPath)).equals(originalIndex)) {
      throw new Error('MANAGED_GIT_INDEX_CHANGED: index moved before owned commit publication.');
    }
    await updateManagedHeadCompareAndSet(dir, expectedHead, candidateCommit);
    try {
      await fs.promises.writeFile(indexPath, candidateIndex);
    } catch (error) {
      await fs.promises.writeFile(indexPath, originalIndex);
      await updateManagedHeadCompareAndSet(dir, candidateCommit, expectedHead).catch(
        () => undefined
      );
      throw error;
    }
    return candidateCommit;
  });
}

async function writeOwnedCommitTree(
  dir: string,
  head: string,
  selected: ReadonlySet<string>
): Promise<string> {
  const directories = new Map<string, TreeEntry[]>([['.', []]]);
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: head }), git.STAGE()],
    map: async (path, [committed, staged]) => {
      const entry = selected.has(path) ? staged : committed;
      const type = await entry?.type();
      if (entry && (type === 'blob' || type === 'commit')) {
        const parent = dirname(path);
        const child = {
          path: basename(path),
          type,
          mode: (await entry.mode()).toString(8),
          oid: await entry.oid(),
        } satisfies TreeEntry;
        const children = directories.get(parent) ?? [];
        children.push(child);
        directories.set(parent, children);
      }
      return path;
    },
  });
  for (const path of [...directories.keys()]) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      if (!directories.has(parent)) directories.set(parent, []);
    }
  }
  const depth = (path: string) => (path === '.' ? 0 : path.split('/').length);
  const deepestFirst = [...directories.keys()].sort((a, b) => depth(b) - depth(a));
  let root = '';
  for (const path of deepestFirst) {
    const tree = directories.get(path);
    if (!tree) throw new Error('MANAGED_GIT_TREE_DIRECTORY_MISSING');
    const oid = await git.writeTree({ fs, dir, tree });
    if (path === '.') root = oid;
    else
      directories
        .get(dirname(path))
        ?.push({ path: basename(path), type: 'tree', mode: '040000', oid });
  }
  return root;
}

async function updateManagedHeadCompareAndSet(
  dir: string,
  expectedHead: string,
  nextHead: string
): Promise<void> {
  const gitDir = resolveGitDir(dir);
  if (!gitDir) throw new Error('MANAGED_GIT_DIRECTORY_NOT_FOUND');
  const branch = await git.currentBranch({ fs, dir, fullname: true });
  if (!branch || !isSafeGitRef(branch)) {
    throw new Error('MANAGED_GIT_DETACHED_HEAD');
  }
  const refPath = join(gitDir, branch);
  const lockPath = `${refPath}.lock`;
  await fs.promises.mkdir(dirname(refPath), { recursive: true });
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('MANAGED_GIT_REF_LOCKED');
    }
    throw error;
  }
  try {
    if ((await resolveHeadCommit(dir)) !== expectedHead) {
      throw new Error('MANAGED_GIT_HEAD_CHANGED: HEAD moved before owned commit publication.');
    }
    await handle.writeFile(`${nextHead}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    // workspace-entity-move: publishes a Git ref lock only.
    await fs.promises.rename(lockPath, refPath);
    await syncDirectory(dirname(refPath));
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(lockPath, { force: true });
    throw error;
  }
}

export async function restoreManagedHeadAndIndex(
  dir: string,
  input: {
    restoreHead: string;
    expectedCurrentHead: string;
    paths: readonly string[];
  }
): Promise<void> {
  await commitAllIfDirtyMutex(resolve(dir), async () => {
    const currentHead = await resolveHeadCommit(dir);
    if (currentHead !== input.expectedCurrentHead) {
      throw new Error(
        'MANAGED_GIT_ROLLBACK_HEAD_CHANGED: managed HEAD changed before rollback could finish.'
      );
    }
    const paths = normalizeForceInclude(dir, input.paths);
    for (const filepath of paths) {
      await git.resetIndex({ fs, dir, filepath, ref: input.restoreHead });
    }
    if (currentHead !== input.restoreHead) {
      const branch = await git.currentBranch({ fs, dir, fullname: true });
      if (!branch) {
        throw new Error('MANAGED_GIT_ROLLBACK_DETACHED_HEAD: managed repo has no current branch.');
      }
      await git.writeRef({
        fs,
        dir,
        ref: branch,
        value: input.restoreHead,
        force: true,
      });
    }
  });
}

export async function listFilesAtHead(dir: string): Promise<string[]> {
  return git.listFiles({ fs, dir, ref: 'HEAD' });
}

export async function readBlobOidAtHead(dir: string, filepath: string): Promise<string> {
  const commitOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  return managedGitBlobOid(dir, commitOid, filepath);
}

export async function readFileAtHead(dir: string, filepath: string): Promise<Buffer> {
  const commitOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  const { blob } = await git.readBlob({ fs, dir, oid: commitOid, filepath });
  return Buffer.from(blob);
}

export async function readBlobBytesAtCommit(
  dir: string,
  commitOid: string,
  filepath: string
): Promise<Uint8Array> {
  if (!isCommitOid(commitOid)) {
    throw new Error(`MANAGED_GIT_INVALID_COMMIT_OID: ${commitOid}`);
  }
  const normalized = normalizeForceInclude(dir, [filepath]);
  const committedPath = normalized[0];
  if (!committedPath) throw new Error('MANAGED_GIT_COMMIT_PATH_REQUIRED');
  const { blob } = await git.readBlob({ fs, dir, oid: commitOid, filepath: committedPath });
  return blob;
}

export async function readBlobOidAtCommit(
  dir: string,
  commitOid: string,
  filepath: string
): Promise<string> {
  if (!isCommitOid(commitOid)) {
    throw new Error(`MANAGED_GIT_INVALID_COMMIT_OID: ${commitOid}`);
  }
  const committedPath = normalizeForceInclude(dir, [filepath])[0];
  if (!committedPath) throw new Error('MANAGED_GIT_COMMIT_PATH_REQUIRED');
  return managedGitBlobOid(dir, commitOid, committedPath);
}

export async function readBlobContentIdentityAtCommit(
  dir: string,
  commitOid: string,
  filepath: string,
  maxBytes: number,
  maxInlineBytes: number
): Promise<GitBlobContentIdentity> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !Number.isSafeInteger(maxInlineBytes) ||
    maxInlineBytes < 0
  ) {
    throw new Error('MANAGED_GIT_INVALID_BLOB_LIMIT');
  }
  const oid = await readBlobOidAtCommit(dir, commitOid, filepath);
  const gitDir = resolveGitDir(dir);
  if (!gitDir) throw new Error('MANAGED_GIT_DIRECTORY_NOT_FOUND');
  const objectPath = join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
  try {
    return await readLooseBlobContentIdentity(objectPath, oid, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const identity = await hashManagedGitBlob(dir, commitOid, filepath, maxBytes);
    return {
      sizeBytes: identity.sizeBytes,
      contentSha256: identity.sha256,
    };
  }
}

export async function flushManagedCommitDurably(
  dir: string,
  commitOid: string,
  paths: readonly string[],
  durability: ManagedGitDurabilityBarrier = DEFAULT_MANAGED_GIT_DURABILITY
): Promise<void> {
  if (!isCommitOid(commitOid)) {
    throw new Error(`MANAGED_GIT_INVALID_COMMIT_OID: ${commitOid}`);
  }
  const gitDir = resolveGitDir(dir);
  if (!gitDir) throw new Error('MANAGED_GIT_DIRECTORY_NOT_FOUND');
  const normalizedPaths = normalizeForceInclude(dir, paths);
  const commit = await git.readCommit({ fs, dir, oid: commitOid });
  const objectOids = new Set<string>([commitOid, commit.commit.tree]);

  for (const filepath of normalizedPaths) {
    const segments = filepath.split('/');
    let treeOid: string | null = commit.commit.tree;
    for (const segment of segments.slice(0, -1)) {
      if (!treeOid) break;
      const tree = await git.readTree({ fs, dir, oid: treeOid });
      const child = tree.tree.find((entry) => entry.type === 'tree' && entry.path === segment);
      treeOid = child?.oid ?? null;
      if (treeOid) objectOids.add(treeOid);
    }
    if (!existsSync(join(dir, filepath))) continue;
    objectOids.add(await managedGitBlobOid(dir, commitOid, filepath));
  }

  const filePaths = new Set<string>();
  for (const oid of objectOids) {
    const objectPath = join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
    if (existsSync(objectPath)) filePaths.add(objectPath);
  }
  for (const metadataPath of [join(gitDir, 'index'), join(gitDir, 'HEAD')]) {
    if (existsSync(metadataPath)) filePaths.add(metadataPath);
  }
  const head = fs.readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  const symbolicRef = /^ref:\s+(.+)$/.exec(head)?.[1];
  if (symbolicRef && isSafeGitRef(symbolicRef)) {
    const refPath = join(gitDir, symbolicRef);
    if (existsSync(refPath)) filePaths.add(refPath);
  }
  const packedRefs = join(gitDir, 'packed-refs');
  if (existsSync(packedRefs)) filePaths.add(packedRefs);

  const directoryPaths = new Set<string>();
  for (const filePath of filePaths) {
    durability.flushFile(filePath);
    collectManagedGitDirectoryChain(dirname(filePath), gitDir, directoryPaths);
  }
  const childDirectoriesFirst = [...directoryPaths].sort(
    (left, right) => directoryDepth(gitDir, right) - directoryDepth(gitDir, left)
  );
  for (const directoryPath of childDirectoriesFirst) {
    durability.flushDirectory(directoryPath);
  }
}

export interface ManagedGitDurabilityBarrier {
  flushFile(path: string): void;
  flushDirectory(path: string): void;
}

const DEFAULT_MANAGED_GIT_DURABILITY: ManagedGitDurabilityBarrier = {
  flushFile: flushManagedGitFileRequired,
  flushDirectory: flushManagedGitDirectoryRequired,
};

function flushManagedGitFileRequired(path: string): void {
  flushFileSync(path);
}

function collectManagedGitDirectoryChain(
  startPath: string,
  gitDir: string,
  directories: Set<string>
): void {
  const boundary = resolve(gitDir);
  let current = resolve(startPath);
  if (current !== boundary && !current.startsWith(`${boundary}${sep}`)) {
    throw new Error('MANAGED_GIT_DURABILITY_PATH_OUTSIDE_GIT_DIRECTORY');
  }
  directories.add(current);
  while (current !== boundary) {
    current = dirname(current);
    directories.add(current);
  }
}

function directoryDepth(gitDir: string, directoryPath: string): number {
  const nested = relative(gitDir, directoryPath);
  return nested === '' ? 0 : nested.split(sep).length;
}

function flushManagedGitDirectoryRequired(path: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export async function hashBlobAtCommit(
  dir: string,
  commitOid: string,
  filepath: string
): Promise<{ sha256: string; sizeBytes: number }> {
  const path = normalizeForceInclude(dir, [filepath])[0];
  if (!path) throw new Error('MANAGED_GIT_COMMIT_PATH_REQUIRED');
  return hashManagedGitBlob(dir, commitOid, path);
}
