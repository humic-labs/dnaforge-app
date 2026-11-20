import type Database from 'better-sqlite3';
import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { tablePackagePaths, tablePackageRevisionPath } from '../shared/table-package';
import {
  readTablePackageInMain,
  readVerifiedTableRevision,
  type TablePackageLocation,
  type ReadTablePackageResult,
} from './table-package';
import { captureSavedFileMembers, type SavedFileSourceMember } from './saved-file-sources';
import { savedFileWorkspace } from './saved-file-publication';

async function retainHead(
  db: Database.Database,
  result: ReadTablePackageResult,
  assertCurrent?: () => void
) {
  const { workspaceRoot, packageRoot, head, headPath } = result;
  if (head.status !== 'active')
    throw new Error('Only an active table can be retained as a saved document.');
  assertCurrent?.();
  const workspace = savedFileWorkspace(db, workspaceRoot);
  if (!workspace) throw new Error('The saved table has no owning project.');
  const { revisionsDirectory } = tablePackagePaths(packageRoot);
  const stablePaths = new Map<string, BigIntStats>();
  const record = async (path: string) => {
    stablePaths.set(path, await lstat(path, { bigint: true }));
  };
  await record(headPath);
  await record(revisionsDirectory);
  const members: SavedFileSourceMember[] = [
    {
      relativePath: relative(packageRoot, headPath).split(sep).join('/'),
      sourcePath: headPath,
      expectedSha256: result.headContentHash,
    },
  ];
  const entries = await readdir(revisionsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const match = /^([a-f0-9]{64})\.json$/.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile()) throw new Error('A table revision must be a physical regular file.');
    const snapshotSha256 = match[1];
    const path = tablePackageRevisionPath(packageRoot, snapshotSha256);
    await record(path);
    if (snapshotSha256 !== head.snapshotSha256) {
      await readVerifiedTableRevision({ workspaceRoot, packageRoot }, head.id, snapshotSha256);
    }
    members.push({
      relativePath: relative(packageRoot, path).split(sep).join('/'),
      sourcePath: path,
      expectedSha256: snapshotSha256,
    });
  }
  if (!stablePaths.has(tablePackageRevisionPath(packageRoot, head.snapshotSha256)))
    throw new Error('The current table snapshot disappeared before retention.');
  await captureSavedFileMembers(
    db,
    { workspaceId: workspace.id, entityId: head.id, path: packageRoot, members },
    () => {
      assertCurrent?.();
      for (const [path, stat] of stablePaths) {
        const current = lstatSync(path, { bigint: true });
        if (
          realpathSync(path) !== path ||
          current.dev !== stat.dev ||
          current.ino !== stat.ino ||
          current.size !== stat.size ||
          current.ctimeNs !== stat.ctimeNs ||
          current.mtimeNs !== stat.mtimeNs
        ) {
          throw new Error('The table package changed while retaining its saved files.');
        }
      }
    }
  );
}

export async function retainTablePackage(
  db: Database.Database,
  input: TablePackageLocation,
  expectedId?: string,
  assertCurrent?: () => void
): Promise<string> {
  assertCurrent?.();
  const result = await readTablePackageInMain({ ...input, expectedDocumentId: expectedId });
  await retainHead(db, result, assertCurrent);
  return result.head.id;
}

export function retainTablePublication(db: Database.Database, assertCurrent: () => void) {
  return async (result: ReadTablePackageResult): Promise<void> => {
    if (result.head.status === 'active') await retainHead(db, result, assertCurrent);
  };
}
