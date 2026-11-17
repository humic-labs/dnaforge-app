import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { canonicalJson } from '../shared/canonical-json';
import { writeWorkspaceTextFileAtomicInMain } from './primer-artifact-files';
import { syncDirectory as syncDirectoryInMain } from './fs-durability';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import type Database from 'better-sqlite3';
import { registerAdmittedProjectRoot } from './admitted-project-roots';
import { dirname, join } from 'node:path';
import { isPathInsideBoundary } from '../shared/path-boundary';
import type { ResolveProjectRootRequest, ResolvedProjectRoot } from '../shared/workspace-git-types';
import {
  MANAGED_WORKSPACE_MARKER,
  BENCHLING_MIGRATION_WORKSPACE_MARKER,
} from '../shared/workspace-git-types';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import {
  admitProjectRootInMain,
  admitRegisteredProjectRootInMain,
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

async function readProjectResourceIdentityFile(
  path: string,
  schema: string | number,
  idField: string
): Promise<string | null> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024)
    invalidRoot('The project identity must be a bounded physical file.');
  const raw = await readFile(path, 'utf8');
  const after = await lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  )
    invalidRoot('The project identity changed while it was read.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalidRoot('The project identity is malformed.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.get(value, 'schema') !== schema
  )
    invalidRoot('The project identity format is unsupported.');
  const id: unknown = Reflect.get(value, idField);
  if (typeof id !== 'string' || !resourceProjectUuid.test(id))
    invalidRoot('The project identity UUID is invalid.');
  return id;
}

const withProjectResourceIdentity = createKeyedMutex();
const resourceProjectUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readProjectResourceIdentityInMain(
  request: { workspaceRoot: string },
  deps: { db: Database.Database; managedRootDir: string; protectedAppDataRoot?: string }
): Promise<{
  projectId: string;
  workspaceRoot: string;
  workspaceId: number;
  source: 'managed' | 'marker';
} | null> {
  if (!request || typeof request.workspaceRoot !== 'string')
    invalidRoot('A registered project root is required.');
  const initial = admitRegisteredProjectRootInMain(request.workspaceRoot, deps);
  const root = initial.rootPath;
  const markerDirectory = join(root, '.forge');
  const markerPath = join(markerDirectory, 'project.json');
  const assertCurrent = () => {
    const current = admitRegisteredProjectRootInMain(root, deps);
    if (current.row.id !== initial.row.id || current.row.repo_uuid !== initial.row.repo_uuid)
      invalidRoot('The project owner changed while its identity was read.');
    const directory = lstatSync(markerDirectory, { throwIfNoEntry: false });
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink()))
      invalidRoot('The project identity directory is not a physical directory.');
  };
  assertCurrent();
  const portable = await readProjectResourceIdentityFile(
    markerPath,
    'dnaforge.project-identity.v1',
    'id'
  );
  let id = portable;
  let source: 'managed' | 'marker' = 'marker';
  if (initial.row.repo_uuid) {
    id =
      (await readProjectResourceIdentityFile(
        join(root, MANAGED_WORKSPACE_MARKER),
        1,
        'workspaceUuid'
      )) ??
      (await readProjectResourceIdentityFile(
        join(root, BENCHLING_MIGRATION_WORKSPACE_MARKER),
        'dnaforge.benchling-migration-workspace.v1',
        'workspaceId'
      ));
    if (!id || id !== initial.row.repo_uuid || (portable && portable !== id))
      invalidRoot('The project has conflicting or missing persisted identities.');
    source = 'managed';
  }
  assertCurrent();
  return id ? { projectId: id, workspaceRoot: root, workspaceId: initial.row.id, source } : null;
}

export async function ensureProjectResourceIdentityInMain(
  request: { workspaceRoot: string },
  deps: {
    db: Database.Database;
    managedRootDir: string;
    protectedAppDataRoot?: string;
    writeAtomic?: typeof writeWorkspaceTextFileAtomicInMain;
    syncDirectory?: typeof syncDirectoryInMain;
  }
): Promise<{
  projectId: string;
  workspaceRoot: string;
  workspaceId: number;
  source: 'managed' | 'marker';
}> {
  if (!request || typeof request.workspaceRoot !== 'string')
    invalidRoot('A registered project root is required.');
  const initial = admitRegisteredProjectRootInMain(request.workspaceRoot, deps);
  const root = initial.rootPath;
  const original = initial.row;
  const markerDirectory = join(root, '.forge');
  const markerPath = join(markerDirectory, 'project.json');
  const assertCurrent = () => {
    const current = admitRegisteredProjectRootInMain(root, deps);
    if (
      current.row.id !== original.id ||
      current.row.repo_uuid !== original.repo_uuid ||
      current.row.access_mode !== 'writable'
    )
      invalidRoot('The project owner is not writable or changed during identity publication.');
    const directory = lstatSync(markerDirectory, { throwIfNoEntry: false });
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink()))
      invalidRoot('The project identity directory is not a physical directory.');
    const leaf = lstatSync(markerPath, { throwIfNoEntry: false });
    if (leaf && (!leaf.isFile() || leaf.isSymbolicLink()))
      invalidRoot('The project identity is not a physical file.');
  };
  const result = (projectId: string, source: 'managed' | 'marker') => ({
    projectId,
    workspaceRoot: root,
    workspaceId: original.id,
    source,
  });
  return withProjectResourceIdentity(markerPath, async () => {
    assertCurrent();
    if (original.repo_uuid) {
      const managed =
        (await readProjectResourceIdentityFile(
          join(root, MANAGED_WORKSPACE_MARKER),
          1,
          'workspaceUuid'
        )) ??
        (await readProjectResourceIdentityFile(
          join(root, BENCHLING_MIGRATION_WORKSPACE_MARKER),
          'dnaforge.benchling-migration-workspace.v1',
          'workspaceId'
        ));
      if (!managed || managed !== original.repo_uuid)
        invalidRoot('The managed project UUID does not match its persisted identity.');
      const portable = await readProjectResourceIdentityFile(
        markerPath,
        'dnaforge.project-identity.v1',
        'id'
      );
      if (portable && portable !== managed)
        invalidRoot('The project has conflicting persisted identities.');
      assertCurrent();
      return result(managed, 'managed');
    }
    const sync = deps.syncDirectory ?? syncDirectoryInMain;
    const acknowledge = async (id: string) => {
      assertCurrent();
      await sync(markerDirectory);
      await sync(root);
      assertCurrent();
      const verified = await readProjectResourceIdentityFile(
        markerPath,
        'dnaforge.project-identity.v1',
        'id'
      );
      if (verified !== id) invalidRoot('The project identity changed before acknowledgement.');
      return result(id, 'marker');
    };
    const existing = await readProjectResourceIdentityFile(
      markerPath,
      'dnaforge.project-identity.v1',
      'id'
    );
    if (existing) return acknowledge(existing);
    const id = randomUUID();
    const write = deps.writeAtomic ?? writeWorkspaceTextFileAtomicInMain;
    try {
      await write(
        {
          workspaceRoot: root,
          path: markerPath,
          content: `${canonicalJson({ schema: 'dnaforge.project-identity.v1', id })}\n`,
          mode: 'create',
          artifactNoun: 'project identity',
        },
        { durable: true, syncDirectory: sync, beforePublish: assertCurrent }
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' &&
        (!(error instanceof Error) ||
          error.message !== 'A project identity artifact already exists at that location.')
      )
        throw error;
      const winner = await readProjectResourceIdentityFile(
        markerPath,
        'dnaforge.project-identity.v1',
        'id'
      );
      if (!winner) throw error;
      return acknowledge(winner);
    }
    return acknowledge(id);
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
