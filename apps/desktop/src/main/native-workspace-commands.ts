import {
  savedFileSourceAgentRequest,
  type SavedFileSourceRequest,
} from '../shared/saved-file-source-command';
import { runSavedFileSourceCommand } from './saved-file-source-command';
import type Database from 'better-sqlite3';
import { isAbsolute, join } from 'node:path';
import {
  searchWorkspace,
  workspaceSearchAgentResult,
  type WorkspaceSearchRequest,
} from '../shared/workspace-search-owner';
import { createMountedCatalogSearch } from '../shared/workspace-search-catalog';
import {
  projectHistoryAgentRequestSchema,
  projectHistoryRequestSchema,
  type ProjectHistoryAgentRequest,
  type ProjectHistoryRequest,
  type ProjectHistoryResult,
} from '../shared/project-history';
import { resolveExplicitProjectRoot } from '../shared/project-root-selection';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import { runProjectHistory } from './project-history-owner';
import {
  findKnownWorkspaceRoot,
  withKnownWorkspacePathMutation,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import { assertWorkspaceMigrationActionsSettled } from './workspace-migration-admission';

type Project = { id: number; name: string; path: string; access_mode: string; pinned: boolean };
type Lease = <T>(operation: () => Promise<T>) => Promise<T>;

export function createNativeWorkspaceCommands(options: {
  db(): Database.Database;
  readableRoots(): readonly string[];
  writableRoots(): readonly string[];
  captureWorkspace(root: string, mutating: boolean): () => void;
  assertFileSaved(path: string): Promise<void>;
  publishHistory?(root: string): void;
}) {
  const projects = (): Project[] => {
    const db = options.db();
    assertCommittedDatabaseReadAllowed(db);
    const rows = db
      .prepare(
        'SELECT id, name, path, access_mode FROM workspaces WHERE path IS NOT NULL AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .all() as Omit<Project, 'pinned'>[];
    const readable = new Set(options.readableRoots().map(workspaceMutationRootIdentity));
    const writable = new Set(options.writableRoots().map(workspaceMutationRootIdentity));
    return rows
      .filter((row) => {
        const root = workspaceMutationRootIdentity(row.path);
        return (
          readable.has(root) &&
          rows.filter((other) => workspaceMutationRootIdentity(other.path) === root).length === 1
        );
      })
      .map((row) => ({
        ...row,
        pinned:
          row.access_mode !== 'writable' || !writable.has(workspaceMutationRootIdentity(row.path)),
      }));
  };
  const catalog = createMountedCatalogSearch(async <T>(sql: string, params: SqliteIpcValue[]) => {
    assertCommittedDatabaseReadAllowed(options.db());
    return options
      .db()
      .prepare(sql)
      .all(...params) as T;
  });
  const resolveProject = (reference: string) => {
    const current = projects();
    return (
      (isAbsolute(reference)
        ? current.find(
            (project) =>
              workspaceMutationRootIdentity(project.path) ===
              workspaceMutationRootIdentity(reference)
          )
        : undefined) ?? resolveExplicitProjectRoot(current, reference)
    );
  };
  const runHistory = async (
    input: ProjectHistoryRequest,
    lease?: Lease
  ): Promise<ProjectHistoryResult> => {
    const request = projectHistoryRequestSchema.parse(input);
    const project = resolveProject(request.workspaceRoot);
    if (!project) throw new Error('PROJECT_NOT_FOUND: Choose an exact current admitted project.');
    const root = workspaceMutationRootIdentity(project.path);
    const mutating = request.operation.kind !== 'inspect';
    const assertEnrollment = options.captureWorkspace(root, mutating);
    const assertCurrent = () => {
      assertEnrollment();
      const current = projects().find(
        (entry) => entry.id === project.id && workspaceMutationRootIdentity(entry.path) === root
      );
      if (!current || findKnownWorkspaceRoot(options.db(), root) !== root)
        throw new Error('PROJECT_NOT_FOUND: The current admitted project changed.');
      if (mutating) {
        if (current.pinned)
          throw new Error('PROJECT_NOT_WRITABLE: The current project is readonly.');
        assertKnownWorkspaceContentWritable(options.db(), current.path);
      }
    };
    assertCurrent();
    const run = async () => {
      assertCurrent();
      if (mutating) await assertWorkspaceMigrationActionsSettled(root);
      const result = await runProjectHistory(
        { ...request, workspaceRoot: root },
        assertCurrent,
        async (base, paths) => {
          for (const path of paths) await options.assertFileSaved(join(base, path));
        }
      );
      if (result.stateChanged) {
        try {
          options.publishHistory?.(project.path);
        } catch {}
      }
      return result;
    };
    return lease ? lease(run) : withKnownWorkspacePathMutation(options.db(), [root], run);
  };
  const runFileSource = async (input: SavedFileSourceRequest, lease?: Lease) => {
    if (!input.workspaceRoot) throw new Error('Choose a project for this native file command.');
    const project = resolveProject(input.workspaceRoot);
    if (!project) throw new Error('Choose an exact admitted project.');
    const root = workspaceMutationRootIdentity(project.path);
    const mutate = input.operation.kind === 'restore';
    const enrollment = options.captureWorkspace(root, mutate);
    const assertCurrent = () => {
      enrollment();
      assertCommittedDatabaseReadAllowed(options.db());
      const current = resolveProject(root);
      if (!current || current.id !== project.id || (mutate && current.pinned))
        throw new Error('The project changed during source recovery.');
      if (mutate) assertKnownWorkspaceContentWritable(options.db(), root);
    };
    const run = () =>
      runSavedFileSourceCommand(options.db(), input, {
        workspaceId: project.id,
        root,
        assertCurrent,
      });
    return lease
      ? lease(run)
      : mutate
        ? withKnownWorkspacePathMutation(options.db(), [root], run)
        : run();
  };
  return {
    search(input: WorkspaceSearchRequest) {
      return searchWorkspace(
        input,
        () => ({ projects: projects() }),
        catalog.searchMountedCatalogEntityPage
      ).then(workspaceSearchAgentResult);
    },
    history(input: ProjectHistoryAgentRequest) {
      const request = projectHistoryAgentRequestSchema.parse(input);
      const project = resolveProject(request.project);
      if (!project)
        throw new Error(
          'PROJECT_NOT_FOUND: Choose an exact current admitted project name or root.'
        );
      return runHistory({ workspaceRoot: project.path, operation: request.operation });
    },
    runHistory,
    runFileSource,
    savedFileSource(input: import('zod').z.input<typeof savedFileSourceAgentRequest>) {
      const { project, operation } = savedFileSourceAgentRequest.parse(input);
      const selected = resolveProject(project);
      if (!selected) throw new Error('Choose an exact admitted project.');
      return runFileSource({ workspaceRoot: selected.path, operation });
    },
  };
}
