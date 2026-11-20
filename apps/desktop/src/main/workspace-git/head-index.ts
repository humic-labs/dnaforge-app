import { SOURCE_DOCUMENT_MARKER_PATH } from '../../shared/source-document-package';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import git from 'isomorphic-git';
import {
  isManagedCatalogHeadCandidate,
  isVisibleManagedHeadFile,
} from '../../shared/catalog-file-kind';
import type {
  ManagedCatalogHeadIndex,
  ManagedHeadFile,
  ManagedHeadIndex,
  ManagedFileMigrationIssue,
} from '../../shared/workspace-git-types';
import {
  convertTreeToPlasmidPackages,
  declaredNativeMigrationPaths,
} from './convert-tree-to-packages';
import {
  convertTreeToMolecularPackages,
  renameExtensionNamedMolecularViews,
} from './coordinate-package-import';
import {
  commitAllIfDirty,
  commitOwnedPathsIfDirty,
  hasActiveQuickLookPromotion,
  resolveHeadCommit,
  readBlobBytesAtCommit,
  withManagedWorkspaceMutationLock,
} from './index';
import { benchlingProjectionLayoutPolicy } from './benchling-projection-layout';
import { STERILE_GIT_READ_RUNTIME } from '../ipc/git-read-executor';
import { GIT_READ_CONFIG_ARGS } from '../ipc/git-read-policy';
import type { MigrationPathOptions } from './migration-paths';
import { MOLECULAR_MIGRATION_DIRECTORY } from './molecular-migration-journal';
import { preflightLegacySequencePackages } from './sequence-package-preflight';
import {
  collectRetainedComputeSourcePaths,
  isRetainedComputeSourceCandidate,
} from './compute-retained-source-discovery';
import { isSequenceMigrationRecoveryPath } from '../../shared/sequence-migration-path';

export type {
  ManagedCatalogHeadIndex,
  ManagedHeadFile,
  ManagedHeadIndex,
} from '../../shared/workspace-git-types';

type ManagedHeadEntry = Readonly<{ relPath: string; oid: string }>;

interface HeadIndexOptions extends MigrationPathOptions {
  activeAcceptedPaths?: readonly string[];
  healWorkingTree?: boolean;
  packageIdForPath?: (path: string) => string | undefined;
  removeCoordinateSource?: (path: string) => Promise<unknown>;
  ownedMigrationCommit?: boolean;
}

async function trashCoordinateSource(repoPath: string, path: string): Promise<void> {
  try {
    const { shell } = await import('electron');
    await shell.trashItem(path);
  } catch (error) {
    const filepath = path.slice(repoPath.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
    if (
      !filepath.split('/').includes(MOLECULAR_MIGRATION_DIRECTORY) &&
      (await git.status({ fs, dir: repoPath, filepath })) !== 'unmodified'
    )
      throw error;
    await fs.promises.unlink(path);
  }
}

export async function collectWorkspaceEntityMigrations(
  repoPath: string,
  options: HeadIndexOptions = {}
) {
  let healedFileCount = 0;
  let requiredGitFiles: string[] = [];
  const migrationIssues: ManagedFileMigrationIssue[] = [];
  const expectedContentSha256: Record<string, string | null> = {};
  const result = () => ({
    healedFileCount,
    requiredGitFiles,
    migrationIssues,
    expectedContentSha256,
  });
  if (options.healWorkingTree === false || hasActiveQuickLookPromotion(repoPath)) return result();
  const policy = await benchlingProjectionLayoutPolicy(repoPath);
  if (policy === 'locked') throw new Error('The project is locked for migration.');
  if (policy !== 'ordinary') return result();
  const migration = {
    protectedPaths: [
      ...(options.protectedPaths ?? []),
      ...(await declaredNativeMigrationPaths(repoPath)),
    ],
    protectedEntityIds: options.protectedEntityIds,
    assertCurrent: options.assertCurrent,
    withCleanPaths: options.withCleanPaths,
  };
  try {
    const upgraded = await preflightLegacySequencePackages(repoPath, options);
    healedFileCount += upgraded.upgraded;
    Object.assign(expectedContentSha256, upgraded.expectedContentSha256);
    migrationIssues.push(
      ...upgraded.failures.map(({ path, message }) => ({
        path,
        reason: message,
        kind: 'failed' as const,
      }))
    );
  } catch (error) {
    migrationIssues.push({
      path: repoPath,
      reason: error instanceof Error ? error.message : String(error),
      kind: 'failed',
    });
  }
  try {
    const conversion = await convertTreeToPlasmidPackages(repoPath, {
      ...migration,
      packageIdForPath: options.packageIdForPath,
    });
    requiredGitFiles = conversion.requiredGitFiles;
    healedFileCount += conversion.converted;
    Object.assign(expectedContentSha256, conversion.expectedContentSha256);
    migrationIssues.push(
      ...conversion.skippedDetails.map(({ path, reason }) => ({
        path,
        reason,
        kind: 'refused' as const,
      })),
      ...conversion.failures.map(({ path, message }) => ({
        path,
        reason: message,
        kind: 'failed' as const,
      }))
    );
  } catch (err) {
    migrationIssues.push({
      path: repoPath,
      reason: err instanceof Error ? err.message : String(err),
      kind: 'failed',
    });
  }
  try {
    const molecular = await convertTreeToMolecularPackages(repoPath, {
      ...migration,
      removeSource:
        options.removeCoordinateSource ?? ((path) => trashCoordinateSource(repoPath, path)),
    });
    healedFileCount += molecular.converted;
    Object.assign(expectedContentSha256, molecular.expectedContentSha256);
    migrationIssues.push(
      ...molecular.skipped.map(({ path, reason }) => ({ path, reason, kind: 'refused' as const }))
    );
  } catch (err) {
    migrationIssues.push({
      path: repoPath,
      reason: err instanceof Error ? err.message : String(err),
      kind: 'failed',
    });
  }
  try {
    const names = await renameExtensionNamedMolecularViews(repoPath, migration);
    healedFileCount += names.renamed;
    Object.assign(expectedContentSha256, names.expectedContentSha256);
    migrationIssues.push(
      ...names.skipped.map(({ path, reason }) => ({ path, reason, kind: 'refused' as const }))
    );
  } catch (err) {
    migrationIssues.push({
      path: repoPath,
      reason: err instanceof Error ? err.message : String(err),
      kind: 'failed',
    });
  }
  options.assertCurrent?.();
  return result();
}

async function collectManagedHeadEntries(
  repoPath: string,
  options: HeadIndexOptions = {}
): Promise<{
  headCommit: string | null;
  entries: ManagedHeadEntry[];
  healedFileCount: number;
  migrationIssues: ManagedFileMigrationIssue[];
}> {
  return withManagedWorkspaceMutationLock(repoPath, async () => {
    let healedFileCount = 0;
    const migrationIssues: ManagedFileMigrationIssue[] = [];
    const projectionLayoutPolicy = await benchlingProjectionLayoutPolicy(repoPath);
    if (projectionLayoutPolicy === 'locked') {
      throw new Error(
        'Benchling migration workspace is locked and cannot be indexed as a normal workspace.'
      );
    }
    if (options.healWorkingTree !== false && !hasActiveQuickLookPromotion(repoPath)) {
      let requiredGitFiles: string[] = [];
      const expectedHead = await resolveHeadCommit(repoPath);
      const expectedContentSha256: Record<string, string | null> = {};
      if (options.ownedMigrationCommit && !expectedHead)
        throw new Error(
          'The accepted project needs a Git history before its files can be migrated.'
        );
      const migration = await collectWorkspaceEntityMigrations(repoPath, options);
      requiredGitFiles = migration.requiredGitFiles;
      healedFileCount = migration.healedFileCount;
      migrationIssues.push(...migration.migrationIssues);
      Object.assign(expectedContentSha256, migration.expectedContentSha256);

      options.assertCurrent?.();
      if (options.ownedMigrationCommit) {
        const paths = Object.keys(expectedContentSha256);
        if (paths.length > 0) {
          await commitOwnedPathsIfDirty(repoPath, 'reconcile: migrate unowned entities', {
            paths,
            forceInclude: paths,
            expectedHead,
            expectedContentSha256,
          });
        }
      } else {
        await commitAllIfDirty(repoPath, 'reconcile: capture working changes', {
          forceInclude: requiredGitFiles,
        });
      }
    }

    const headCommit = await resolveHeadCommit(repoPath);
    if (!headCommit) return { headCommit: null, entries: [], healedFileCount, migrationIssues };

    const entries: ManagedHeadEntry[] = [];
    await git.walk({
      fs,
      dir: repoPath,
      trees: [git.TREE({ ref: 'HEAD' })],
      map: async (filepath, [entry]) => {
        if (!entry || filepath === '.') return undefined;
        if ((await entry.type()) !== 'blob') return undefined;
        entries.push({ relPath: filepath, oid: await entry.oid() });
        return undefined;
      },
    });
    return { headCommit, entries, healedFileCount, migrationIssues };
  });
}

async function hydrateManagedHeadFiles(
  repoPath: string,
  entries: readonly ManagedHeadEntry[]
): Promise<ManagedHeadFile[]> {
  const sizes = await committedBlobSizes(repoPath, entries);
  const files: ManagedHeadFile[] = [];
  for (const { relPath, oid } of entries) {
    let modifiedAt: number | null = null;
    try {
      const s = await stat(join(repoPath, relPath));
      modifiedAt = Math.round(s.mtimeMs);
    } catch {
      modifiedAt = null;
    }
    files.push({ relPath, oid, sizeBytes: sizes.get(oid)!, modifiedAt });
  }
  return files;
}

async function committedBlobSizes(
  repoPath: string,
  entries: readonly ManagedHeadEntry[]
): Promise<Map<string, number>> {
  const ids = [...new Set(entries.map((entry) => entry.oid))];
  if (ids.length === 0) return new Map();
  if (ids.some((oid) => !/^[0-9a-f]{40}$/u.test(oid)))
    throw new Error('The captured Git file identity is invalid.');
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      STERILE_GIT_READ_RUNTIME.executable,
      [
        ...GIT_READ_CONFIG_ARGS,
        'cat-file',
        '--batch-check=%(objectname) %(objecttype) %(objectsize)',
      ],
      {
        cwd: repoPath,
        env: { ...STERILE_GIT_READ_RUNTIME.environment },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: Math.max(1024, ids.length * 96),
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(ids.join('\n') + '\n');
  });
  const rows = output.trimEnd().split('\n');
  if (rows.length !== ids.length) throw new Error('The captured Git file sizes are unavailable.');
  return new Map(
    rows.map((row, index) => {
      const match = /^([0-9a-f]{40}) blob (0|[1-9][0-9]*)$/u.exec(row);
      const size = match ? Number(match[2]) : NaN;
      if (!match || match[1] !== ids[index] || !Number.isSafeInteger(size))
        throw new Error('The captured Git file size is invalid.');
      return [match[1], size];
    })
  );
}

export async function collectManagedHeadIndex(
  repoPath: string,
  options: HeadIndexOptions = {}
): Promise<ManagedHeadIndex> {
  const { headCommit, entries, migrationIssues } = await collectManagedHeadEntries(
    repoPath,
    options
  );
  return { headCommit, files: await hydrateManagedHeadFiles(repoPath, entries), migrationIssues };
}

export async function collectManagedCatalogHeadIndex(
  repoPath: string,
  preserveRelPaths: readonly string[],
  options: HeadIndexOptions = {}
): Promise<ManagedCatalogHeadIndex> {
  const { headCommit, entries, healedFileCount, migrationIssues } = await collectManagedHeadEntries(
    repoPath,
    options
  );
  const preserved = new Set(preserveRelPaths.map((path) => path.replace(/\\/g, '/')));
  const retainedPaths = headCommit
    ? await collectRetainedComputeSourcePaths({
        workspaceRoot: repoPath,
        committedFiles: entries.map((entry) => entry.relPath),
        readText: async (path) =>
          Buffer.from(await readBlobBytesAtCommit(repoPath, headCommit, path)).toString('utf8'),
      })
    : new Set<string>();
  const originals = new Set(
    entries
      .filter(
        ({ relPath }) =>
          relPath === SOURCE_DOCUMENT_MARKER_PATH ||
          relPath.endsWith('/' + SOURCE_DOCUMENT_MARKER_PATH)
      )
      .map(({ relPath }) => relPath.slice(0, -SOURCE_DOCUMENT_MARKER_PATH.length) + 'original')
  );
  const selected: ManagedHeadEntry[] = [];
  let visibleFileCount = 0;
  let scannedFileCount = 0;

  for (const entry of entries) {
    const separator = entry.relPath.lastIndexOf('/');
    if (
      originals.has(entry.relPath.slice(0, separator)) ||
      isSequenceMigrationRecoveryPath(entry.relPath)
    )
      continue;
    scannedFileCount++;
    if (isVisibleManagedHeadFile(entry.relPath)) visibleFileCount++;
    if (
      isRetainedComputeSourceCandidate(
        repoPath,
        join(repoPath, entry.relPath),
        retainedPaths,
        options.activeAcceptedPaths
      )
    )
      continue;
    if (preserved.has(entry.relPath) || isManagedCatalogHeadCandidate(entry.relPath)) {
      selected.push(entry);
    }
  }

  options.assertCurrent?.();

  return {
    headCommit,
    files: await hydrateManagedHeadFiles(repoPath, selected),
    scannedFileCount,
    visibleFileCount,
    healedFileCount,
    migrationIssues,
  };
}
