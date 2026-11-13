import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentProjectScope, AuthorizedProjectFolder } from '../shared/agent-project-scope';
import { normalizePathForBoundary } from '../shared/path-boundary';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import {
  admitRegisteredProjectRootInMain,
  managedProjectStorageRoot,
} from './project-root-admission';
import { developerImportSourceRootsInDb } from './registry-source-eligibility';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import { readWorkspaceSyncAccessBinding } from './workspace-sync-access-record';

const requestScope = new AsyncLocalStorage<AgentProjectScope>();

export function withAgentProjectScope<T>(scope: AgentProjectScope, operation: () => T): T {
  return requestScope.run(scope, operation);
}

export interface RegisteredProject {
  id: number;
  projectId: string;
  name: string;
  path: string;
  accessMode: 'writable' | 'reference';
  pinned: boolean;
}

export function createRegisteredProjectAuthority(options: {
  db(): Database.Database;
  managedRootDir?(): string;
}) {
  const list = (
    scope: AgentProjectScope | undefined = requestScope.getStore()
  ): RegisteredProject[] => {
    const db = options.db();
    assertCommittedDatabaseReadAllowed(db);
    const rows = db
      .prepare(
        'SELECT id,path,name,repo_uuid,access_mode FROM workspaces WHERE path IS NOT NULL AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .all() as Array<{
      id: number;
      path: string;
      name: string;
      repo_uuid: string | null;
      access_mode: 'writable' | 'reference';
    }>;
    const developerRoots = developerImportSourceRootsInDb(db).map(workspaceMutationRootIdentity);
    const allowedRoots =
      scope?.kind === 'project-roots'
        ? new Set(scope.roots.map((root) => normalizePathForBoundary(root)))
        : null;
    const projects: RegisteredProject[] = [];
    for (const row of rows) {
      try {
        if (
          row.repo_uuid &&
          readWorkspaceSyncAccessBinding(db, row.repo_uuid)?.detached_reason === 'access_removed'
        )
          continue;
        if (lstatSync(row.path).isSymbolicLink()) continue;
        const { rootPath } = admitRegisteredProjectRootInMain(row.path, {
          db,
          managedRootDir: options.managedRootDir?.() ?? managedProjectStorageRoot(),
        });
        if (allowedRoots && !allowedRoots.has(normalizePathForBoundary(rootPath))) continue;
        if (row.repo_uuid && rows.filter((entry) => entry.repo_uuid === row.repo_uuid).length !== 1)
          continue;
        let pinned =
          row.access_mode !== 'writable' || isDeveloperImportSourcePath(rootPath, developerRoots);
        if (!pinned) {
          try {
            assertKnownWorkspaceContentWritable(db, row.path);
          } catch {
            pinned = true;
          }
        }
        projects.push({
          id: row.id,
          projectId: workspaceScopeKey(row.repo_uuid, row.id)!,
          name: row.name,
          path: rootPath,
          accessMode: row.access_mode,
          pinned,
        });
      } catch {
        continue;
      }
    }
    return projects;
  };
  const resolve = (
    reference: string,
    scope: AgentProjectScope | undefined = requestScope.getStore()
  ): RegisteredProject | null => {
    const projects = list(scope);
    const exactIdentity = projects.filter((project) => project.projectId === reference);
    if (exactIdentity.length) return exactIdentity.length === 1 ? exactIdentity[0] : null;
    const matches = isAbsolute(reference)
      ? projects.filter((project) => project.path === workspaceMutationRootIdentity(reference))
      : projects.filter((project) => project.name === reference);
    return matches.length === 1 ? matches[0] : null;
  };
  return {
    list,
    resolve,
    folders(scope?: AgentProjectScope): AuthorizedProjectFolder[] {
      return list(scope).map((project) => ({
        path: project.path,
        name: project.name,
        addedAt: 0,
        pinned: project.pinned,
      }));
    },
    capture(projectId: string, mutating = false): () => void {
      const scope = requestScope.getStore();
      const project = resolve(projectId, scope);
      if (!project || (mutating && project.pinned))
        throw new Error('PROJECT_ACCESS_DENIED: The registered project is unavailable.');
      return () => {
        const current = resolve(projectId, scope);
        if (
          !current ||
          current.id !== project.id ||
          current.path !== project.path ||
          (mutating && current.pinned)
        )
          throw new Error('PROJECT_ACCESS_CHANGED: The registered project authority changed.');
        if (mutating) assertKnownWorkspaceContentWritable(options.db(), current.path);
      };
    },
  };
}

export type RegisteredProjectAuthority = ReturnType<typeof createRegisteredProjectAuthority>;
