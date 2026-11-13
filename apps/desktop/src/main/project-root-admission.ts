import type Database from 'better-sqlite3';
import { app } from 'electron';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isPathInsideBoundary } from '../shared/path-boundary';
import {
  BENCHLING_MIGRATION_WORKSPACE_MARKER,
  MANAGED_WORKSPACE_MARKER,
} from '../shared/workspace-git-types';
import { registerAdmittedProjectRoot } from './admitted-project-roots';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

export interface ProjectRow {
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

export function projectRows(db: Database.Database): ProjectRow[] {
  return db
    .prepare(
      'SELECT id,path,name,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE path IS NOT NULL'
    )
    .all() as ProjectRow[];
}

function invalidRoot(message: string): never {
  throw new Error(`PROJECT_ROOT_INVALID: ${message}`);
}

function validateManagedProjectRoot(
  rootPath: string,
  row: ProjectRow | undefined,
  managedRoot: string
): void {
  if (!row?.repo_uuid) invalidRoot('Use the app to create or import a project.');
  if (
    rootPath !== join(managedRoot, row.repo_uuid, 'repo') ||
    basename(dirname(rootPath)) !== row.repo_uuid
  )
    invalidRoot('The content directory does not match its project identity.');
  const gitStat = lstatSync(join(rootPath, '.git'), { throwIfNoEntry: false });
  const identity = gitStat?.isDirectory() ? managedProjectIdentity(rootPath) : null;
  if (!identity) invalidRoot('The project identity or repository structure is missing.');
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(identity.markerPath, 'utf8'));
  } catch {
    invalidRoot('The project identity cannot be read.');
  }
  if (
    !marker ||
    typeof marker !== 'object' ||
    Reflect.get(marker, 'schema') !== identity.schema ||
    Reflect.get(marker, identity.uuidField) !== row.repo_uuid
  )
    invalidRoot('The project identity does not match its registered owner.');
}

const MANAGED_PROJECT_IDENTITIES = [
  { relativePath: MANAGED_WORKSPACE_MARKER, schema: 1, uuidField: 'workspaceUuid' },
  {
    relativePath: BENCHLING_MIGRATION_WORKSPACE_MARKER,
    schema: 'dnaforge.benchling-migration-workspace.v1',
    uuidField: 'workspaceId',
  },
] as const;

function managedProjectIdentity(rootPath: string) {
  for (const identity of MANAGED_PROJECT_IDENTITIES) {
    const markerPath = join(rootPath, identity.relativePath);
    const markerStat = lstatSync(markerPath, { throwIfNoEntry: false });
    if (markerStat?.isFile() && realpathSync(markerPath) === markerPath)
      return { ...identity, markerPath };
  }
  return null;
}

function admitProjectRoot(
  path: string,
  deps: { db: Database.Database; managedRootDir: string; protectedAppDataRoot?: string }
): { rootPath: string; row: ProjectRow | undefined } {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    invalidRoot('Project roots must be absolute directory paths.');
  const rootPath = realpathSync(path);
  if (!statSync(rootPath).isDirectory()) invalidRoot('Project root must be a directory.');
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
    validateManagedProjectRoot(rootPath, row, managedRoot);
  return { rootPath, row };
}

export async function admitProjectRootInMain(
  path: string,
  deps: { db: Database.Database; managedRootDir: string; protectedAppDataRoot?: string }
): Promise<{ rootPath: string; row: ProjectRow | undefined }> {
  return admitProjectRoot(path, deps);
}

export function admitRegisteredProjectRootInMain(
  path: string,
  deps: { db: Database.Database; managedRootDir: string; protectedAppDataRoot?: string }
): { rootPath: string; row: ProjectRow } {
  const { rootPath, row } = admitProjectRoot(path, deps);
  if (!row || row.archived_at !== null || row.trashed_at !== null)
    invalidRoot('The registered project is unavailable.');
  registerAdmittedProjectRoot(rootPath);
  return { rootPath, row };
}
