import type Database from 'better-sqlite3';
import { registerAdmittedProjectRoot } from './admitted-project-roots';
import { app } from 'electron';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isPathInsideBoundary } from '../shared/path-boundary';
import type { ResolveProjectRootRequest, ResolvedProjectRoot } from '../shared/workspace-git-types';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';

interface ProjectRow {
  id: number;
  path: string;
  name: string;
  repo_uuid: string | null;
  access_mode: 'writable' | 'reference';
  archived_at: number | null;
  trashed_at: number | null;
}

export function managedProjectStorageRoot(): string {
  return join(app.getPath('userData'), 'managed-workspaces');
}

export function projectProtectedPaths(repoRoot: string): string[] {
  return ['.git', MANAGED_WORKSPACE_MARKER, '.dnaforge', '.forge', '.waypoint'].map((name) =>
    join(repoRoot, name)
  );
}

function projectRows(db: Database.Database): ProjectRow[] {
  return db
    .prepare(
      'SELECT id,path,name,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE path IS NOT NULL'
    )
    .all() as ProjectRow[];
}

function invalidRoot(message: string): never {
  throw new Error(`PROJECT_ROOT_INVALID: ${message}`);
}

async function validateManagedProjectRoot(
  rootPath: string,
  row: ProjectRow | undefined,
  managedRoot: string
): Promise<void> {
  if (!row?.repo_uuid) invalidRoot('Use the app to create or import a project.');
  if (
    rootPath !== join(managedRoot, row.repo_uuid, 'repo') ||
    basename(dirname(rootPath)) !== row.repo_uuid
  )
    invalidRoot('The content directory does not match its project identity.');
  const markerPath = join(rootPath, MANAGED_WORKSPACE_MARKER);
  const markerStat = await lstat(markerPath).catch(() => null);
  const gitStat = await lstat(join(rootPath, '.git')).catch(() => null);
  if (!markerStat?.isFile() || !gitStat?.isDirectory())
    invalidRoot('The project identity or repository structure is missing.');
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    invalidRoot('The project identity cannot be read.');
  }
  if (
    !marker ||
    typeof marker !== 'object' ||
    !('schema' in marker) ||
    marker.schema !== 1 ||
    !('workspaceUuid' in marker) ||
    marker.workspaceUuid !== row.repo_uuid
  )
    invalidRoot('The project identity does not match its registered owner.');
}

export async function admitProjectRootInMain(
  path: string,
  deps: { db: Database.Database; managedRootDir: string; protectedAppDataRoot?: string }
): Promise<{ rootPath: string; row: ProjectRow | undefined }> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    invalidRoot('Project roots must be absolute directory paths.');
  const rootPath = await realpath(path);
  if (!(await stat(rootPath)).isDirectory()) invalidRoot('Project root must be a directory.');
  const rows = projectRows(deps.db);
  const matching = rows.filter((row) => workspaceMutationRootIdentity(row.path) === rootPath);
  if (matching.length > 1) invalidRoot('The project has more than one registered owner.');
  const row = matching[0];
  if (
    deps.protectedAppDataRoot &&
    !row &&
    isPathInsideBoundary(rootPath, workspaceMutationRootIdentity(deps.protectedAppDataRoot))
  )
    invalidRoot('App storage cannot be registered as project content.');
  for (const existing of rows) {
    const existingRoot = workspaceMutationRootIdentity(existing.path);
    if (
      existingRoot !== rootPath &&
      (isPathInsideBoundary(rootPath, existingRoot) ||
        (!row && isPathInsideBoundary(existingRoot, rootPath)))
    )
      invalidRoot('A project content directory cannot be opened as a separate project.');
  }
  const managedRoot = workspaceMutationRootIdentity(deps.managedRootDir);
  if (isPathInsideBoundary(managedRoot, rootPath))
    invalidRoot('App project storage cannot be opened as a project.');
  if (isPathInsideBoundary(rootPath, managedRoot))
    await validateManagedProjectRoot(rootPath, row, managedRoot);
  return { rootPath, row };
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
