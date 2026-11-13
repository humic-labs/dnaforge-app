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
} from '../../shared/workspace-git-types';
import { convertTreeToPlasmidPackages } from './convert-tree-to-packages';
import {
  convertTreeToMolecularPackages,
  renameExtensionNamedMolecularViews,
} from './coordinate-package-import';
import {
  commitAllIfDirty,
  hasActiveQuickLookPromotion,
  resolveHeadCommit,
  withManagedWorkspaceMutationLock,
} from './index';
import { benchlingProjectionLayoutPolicy } from './benchling-projection-layout';
import { STERILE_GIT_READ_RUNTIME } from '../ipc/git-read-executor';
import { GIT_READ_CONFIG_ARGS } from '../ipc/git-read-policy';

export type {
  ManagedCatalogHeadIndex,
  ManagedHeadFile,
  ManagedHeadIndex,
} from '../../shared/workspace-git-types';

type ManagedHeadEntry = Readonly<{ relPath: string; oid: string }>;

interface HeadIndexOptions {
  healWorkingTree?: boolean;
  packageIdForPath?: (path: string) => string | undefined;
  removeCoordinateSource?: (path: string) => Promise<unknown>;
}

async function trashCoordinateSource(repoPath: string, path: string): Promise<void> {
  try {
    const { shell } = await import('electron');
    await shell.trashItem(path);
  } catch (error) {
    const filepath = path.slice(repoPath.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
    if ((await git.status({ fs, dir: repoPath, filepath })) !== 'unmodified') throw error;
    await fs.promises.unlink(path);
  }
}

async function collectManagedHeadEntries(
  repoPath: string,
  options: HeadIndexOptions = {}
): Promise<{ headCommit: string | null; entries: ManagedHeadEntry[]; healedFileCount: number }> {
  return withManagedWorkspaceMutationLock(repoPath, async () => {
    let healedFileCount = 0;
    const projectionLayoutPolicy = await benchlingProjectionLayoutPolicy(repoPath);
    if (projectionLayoutPolicy === 'locked') {
      throw new Error(
        'Benchling migration workspace is locked and cannot be indexed as a normal workspace.'
      );
    }
    if (options.healWorkingTree !== false && !hasActiveQuickLookPromotion(repoPath)) {
      let requiredGitFiles: string[] = [];
      if (projectionLayoutPolicy === 'ordinary') {
        try {
          const conversion = await convertTreeToPlasmidPackages(repoPath, {
            packageIdForPath: options.packageIdForPath,
          });
          requiredGitFiles = conversion.requiredGitFiles;
          healedFileCount = conversion.converted;
          const refused = [
            ...conversion.skippedDetails
              .filter(({ repeated }) => !repeated)
              .map(({ path, reason }) => ({ path, reason })),
            ...conversion.failures.map(({ path, message }) => ({ path, reason: message })),
          ];
          if (refused.length > 0) {
            console.warn(
              `[collectManagedHeadIndex] ${refused.length} sequence file(s) left outside the package format:`,
              refused
            );
          }
        } catch (err) {
          console.warn(
            '[collectManagedHeadIndex] sequence package heal failed; indexing the tree as-is:',
            err instanceof Error ? err.message : err
          );
        }
        try {
          const molecular = await convertTreeToMolecularPackages(repoPath, {
            removeSource:
              options.removeCoordinateSource ?? ((path) => trashCoordinateSource(repoPath, path)),
          });
          healedFileCount += molecular.converted;
          if (molecular.skipped.length > 0)
            console.warn(
              `[collectManagedHeadIndex] ${molecular.skipped.length} coordinate file(s) left outside the package format:`,
              molecular.skipped
            );
        } catch (err) {
          console.warn(
            '[collectManagedHeadIndex] coordinate package heal failed; indexing the tree as-is:',
            err instanceof Error ? err.message : err
          );
        }
        try {
          const names = await renameExtensionNamedMolecularViews(repoPath);
          healedFileCount += names.renamed;
          if (names.skipped.length > 0)
            console.warn(
              `[collectManagedHeadIndex] ${names.skipped.length} molecular view(s) kept their extension-bearing names:`,
              names.skipped
            );
        } catch (err) {
          console.warn(
            '[collectManagedHeadIndex] molecular view rename failed; indexing the tree as-is:',
            err instanceof Error ? err.message : err
          );
        }
      }

      await commitAllIfDirty(repoPath, 'reconcile: capture working changes', {
        forceInclude: requiredGitFiles,
      });
    }

    const headCommit = await resolveHeadCommit(repoPath);
    if (!headCommit) return { headCommit: null, entries: [], healedFileCount };

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
    return { headCommit, entries, healedFileCount };
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

export async function collectManagedHeadIndex(repoPath: string): Promise<ManagedHeadIndex> {
  const { headCommit, entries } = await collectManagedHeadEntries(repoPath);
  return { headCommit, files: await hydrateManagedHeadFiles(repoPath, entries) };
}

export async function collectManagedCatalogHeadIndex(
  repoPath: string,
  preserveRelPaths: readonly string[],
  options: HeadIndexOptions = {}
): Promise<ManagedCatalogHeadIndex> {
  const { headCommit, entries, healedFileCount } = await collectManagedHeadEntries(
    repoPath,
    options
  );
  const preserved = new Set(preserveRelPaths.map((path) => path.replace(/\\/g, '/')));
  const selected: ManagedHeadEntry[] = [];
  let visibleFileCount = 0;

  for (const entry of entries) {
    if (isVisibleManagedHeadFile(entry.relPath)) visibleFileCount++;
    if (preserved.has(entry.relPath) || isManagedCatalogHeadCandidate(entry.relPath)) {
      selected.push(entry);
    }
  }

  return {
    headCommit,
    files: await hydrateManagedHeadFiles(repoPath, selected),
    scannedFileCount: entries.length,
    visibleFileCount,
    healedFileCount,
  };
}
