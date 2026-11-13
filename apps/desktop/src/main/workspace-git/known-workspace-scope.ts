import { realpath } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import type Database from 'better-sqlite3';

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

export interface KnownWorkspaceScopeDeps {
  db: Pick<Database.Database, 'prepare'>;
  managedRootDir: string;
}

export async function findKnownWorkspaceRoot(
  filePath: string,
  deps: KnownWorkspaceScopeDeps
): Promise<string | null> {
  const realCandidate = await realpath(filePath).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    return realpath(dirname(filePath)).catch(() => null);
  });
  if (!realCandidate) return null;

  const rows = deps.db.prepare('SELECT path FROM workspaces').all() as Array<{ path: string }>;
  let deepestKnownRoots: Array<{ identity: string; realPath: string }> = [];
  for (const row of rows) {
    if (!row?.path) continue;
    const realRoot = await realpath(row.path).catch(() => null);
    if (
      realRoot &&
      isContained(realRoot, realCandidate) &&
      (deepestKnownRoots.length === 0 || realRoot.length >= deepestKnownRoots[0].realPath.length)
    ) {
      if (
        deepestKnownRoots.length === 0 ||
        realRoot.length > deepestKnownRoots[0].realPath.length
      ) {
        deepestKnownRoots = [];
      }
      deepestKnownRoots.push({ identity: row.path, realPath: realRoot });
    }
  }
  if (deepestKnownRoots.length === 1) return deepestKnownRoots[0].identity;
  if (deepestKnownRoots.length > 1) return null;

  const realManaged = await realpath(deps.managedRootDir).catch(() => deps.managedRootDir);
  if (isContained(realManaged, realCandidate)) return deps.managedRootDir;

  return null;
}

export async function assertInsideKnownWorkspace(
  filePath: string,
  deps: KnownWorkspaceScopeDeps
): Promise<string> {
  const root = await findKnownWorkspaceRoot(filePath, deps);
  if (!root) {
    throw new Error(
      `OUTSIDE_WORKSPACE: refusing to package "${filePath}" — it is not inside a known workspace.`
    );
  }
  return root;
}

export function assertSameKnownWorkspaceRoot(
  sourceWorkspaceRoot: string,
  overwriteWorkspaceRoot: string
): void {
  if (sourceWorkspaceRoot !== overwriteWorkspaceRoot) {
    throw new Error(
      `CROSS_WORKSPACE_PACKAGE_OVERWRITE: source workspace "${sourceWorkspaceRoot}" ` +
        `does not own package target workspace "${overwriteWorkspaceRoot}".`
    );
  }
}
