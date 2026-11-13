import type Database from 'better-sqlite3';
import { registerAdmittedProjectRoot } from './admitted-project-roots';
import { dirname, join } from 'node:path';
import { isPathInsideBoundary } from '../shared/path-boundary';
import type { ResolveProjectRootRequest, ResolvedProjectRoot } from '../shared/workspace-git-types';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import {
  admitProjectRootInMain,
  managedProjectStorageRoot,
  projectRows,
  type ProjectRow,
} from './project-root-admission';
export {
  admitProjectRootInMain,
  admitRegisteredProjectRootInMain,
  managedProjectStorageRoot,
} from './project-root-admission';

function invalidRoot(message: string): never {
  throw new Error(`PROJECT_ROOT_INVALID: ${message}`);
}

export function projectProtectedPaths(repoRoot: string): string[] {
  return ['.git', MANAGED_WORKSPACE_MARKER, '.dnaforge', '.forge', '.waypoint'].map((name) =>
    join(repoRoot, name)
  );
}

export async function resolveProjectRootInMain(
  request: ResolveProjectRootRequest,
  deps: {
    db: Database.Database;
    managedRootDir: string;
    protectedAppDataRoot?: string;
    runDatabase?: <T>(operation: () => T) => T | Promise<T>;
  }
): Promise<ResolvedProjectRoot> {
  if (!request || typeof request !== 'object') invalidRoot('A project root request is required.');
  const { rootPath, row } = await admitProjectRootInMain(request.path, deps);
  if (row && (row.archived_at !== null || row.trashed_at !== null))
    invalidRoot('Restore the owning project before opening it.');
  const runDatabase = <T>(operation: () => T): T | Promise<T> =>
    deps.runDatabase ? deps.runDatabase(operation) : operation();
  return runDatabase(() => {
    const currentRows = projectRows(deps.db);
    const currentMatches = currentRows.filter(
      (current) => workspaceMutationRootIdentity(current.path) === rootPath
    );
    if (currentMatches.length > 1) invalidRoot('The project has more than one registered owner.');
    const currentOwner = currentMatches[0];
    if (
      row &&
      (!currentOwner ||
        currentOwner.id !== row.id ||
        currentOwner.repo_uuid !== row.repo_uuid ||
        workspaceMutationRootIdentity(currentOwner.path) !== rootPath ||
        currentOwner.archived_at !== null ||
        currentOwner.trashed_at !== null)
    )
      invalidRoot('The owning project changed while opening it.');
    if (
      currentRows.some((current) => {
        const currentRoot = workspaceMutationRootIdentity(current.path);
        return currentRoot !== rootPath && isPathInsideBoundary(rootPath, currentRoot);
      })
    )
      invalidRoot('A project content directory cannot be opened as a separate project.');
    const workspaceId = ensureWorkspaceOwnerInDb(
      deps.db,
      currentOwner?.path ?? rootPath,
      request.access,
      {
        ...(request.name === undefined ? {} : { name: request.name }),
      }
    );
    const owner = deps.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(workspaceId) as ProjectRow;
    registerAdmittedProjectRoot(rootPath);
    return {
      workspaceId,
      rootPath,
      displayName: owner.name,
      repoUuid: owner.repo_uuid,
      access: owner.access_mode,
    };
  });
}

export async function assertProjectFilesystemMutationAllowed(
  db: Database.Database,
  paths: readonly string[],
  managedRootDir: string = managedProjectStorageRoot()
): Promise<void> {
  const managedRoot = workspaceMutationRootIdentity(managedRootDir);
  const appDataRoot = workspaceMutationRootIdentity(dirname(managedRootDir));
  const scratchRoots = ['cli-scratch', 'hosted-ai-scratch'].map((name) => join(appDataRoot, name));
  const rows = projectRows(db).map((row) => ({
    ...row,
    root: workspaceMutationRootIdentity(row.path),
  }));
  const deny = () => {
    throw new Error(
      'PROJECT_FILESYSTEM_AUTHORITY_REQUIRED: Use the app project commands to change project roots or identity.'
    );
  };
  for (const value of paths) {
    const path = workspaceMutationRootIdentity(value);
    const owners = rows.filter((row) => isPathInsideBoundary(path, row.root));
    if (
      isPathInsideBoundary(managedRoot, path) ||
      rows.some((row) => isPathInsideBoundary(row.root, path)) ||
      (isPathInsideBoundary(path, managedRoot) && owners.length !== 1) ||
      (isPathInsideBoundary(path, appDataRoot) &&
        owners.length === 0 &&
        !scratchRoots.some((root) => path !== root && isPathInsideBoundary(path, root)))
    )
      deny();
    for (const owner of owners) {
      for (const protectedPath of projectProtectedPaths(owner.root)) {
        const canonical = workspaceMutationRootIdentity(protectedPath);
        if (isPathInsideBoundary(path, canonical) || isPathInsideBoundary(canonical, path)) deny();
      }
    }
  }
  assertWorkspaceWriteAllowed(db, paths);
}
